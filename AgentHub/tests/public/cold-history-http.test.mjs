import assert from "node:assert/strict";
import { randomBytes, pbkdf2 } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { mergeActiveTaskHistory, mergeCompletedTaskHistory } from "../../src/application/task-history.mjs";
import { fitTaskHistoryPayload } from "../../src/domain/response-budget.mjs";
import { LocalTaskSyncStore } from "../../src/infrastructure/persistence/task-sync-store.mjs";
import { createDesktopControlRouter } from "../../src/interfaces/desktop/desktop-control-router.mjs";
import { createDesktopTaskHistoryFactory } from "../../src/interfaces/desktop/desktop-task-history.mjs";
import { MiniAppServer } from "../../src/interfaces/web/mini-app-server.mjs";
import { launchBrowser, snapshot } from "./composer-production.fixture.mjs";

const exercisePool = promisify(pbkdf2);
const completedAt = "2026-11-22T10:00:00.000Z";

function turn(id, historyBody = "", position = 0) {
  const prompt = "Request " + id;
  const answer = "Start " + id + "\n\n" + historyBody + "\n\nEnd " + id;
  return {
    id, status: "completed", completed: true, terminalRevision: 1, prompt, answer,
    startedAt: new Date(Date.parse(completedAt) + position * 1_000).toISOString(),
    completedAt: new Date(Date.parse(completedAt) + position * 1_000 + 1).toISOString(),
    messages: [
      { itemId: id + "-request", role: "user", text: prompt },
      { itemId: id + "-answer", role: "agent", text: answer, phase: "final_answer" },
    ],
  };
}

test("real HTTP cold history paints thirty turns before the background refresh",
  { timeout: 45_000 }, () => verifyColdHistory());
test("cold HTTP history includes the known final behind two newer requests in the first page",
  { timeout: 45_000 }, () => verifyColdHistory("short"));
test("cold HTTP paints the complete final when newer requests alone exceed the transport budget",
  { timeout: 45_000 }, () => verifyColdHistory("large"));
test("scrollback reaches the intervening annotated turn after a disjoint post-paint refresh",
  { timeout: 45_000 }, () => verifyColdHistory("annotated"));

async function verifyColdHistory(newerRequests = "none") {
  const latestOutsideTail = newerRequests !== "none";
  const oversizedRequests = newerRequests === "large" || newerRequests === "annotated";
  const root = await mkdtemp(path.join(os.tmpdir(), "hub-cold-http-history-"));
  const store = new LocalTaskSyncStore({ filePath: path.join(root, "history.json"), historyLimit: 50 });
  const state = snapshot();
  const newest = turn("latest-b", randomBytes(18_000).toString("base64"), 1000);
  Object.assign(state.tasks[1], {
    projectRoot: root, lastAnswerTurnId: newest.id, lastAnswerAt: newest.completedAt,
    latestFinal: { provider: "codex", threadId: "thread-b", turnId: newest.id, revision: 1 },
  });
  const [taskA, taskB] = state.tasks.map(task => ({ ...task, projectRoot: root }));
  const retainedThreads = Array.from({ length: 24 }, (_, index) => ({ ...taskB, threadId: "archive-" + index }));
  const studies = [];
  const traces = [];
  const refreshedThreads = [];
  const jobs = [];
  let browser;
  let server;
  let releaseFollowup;
  const followup = new Promise(resolve => { releaseFollowup = resolve; });
  let finishRefresh;
  const refreshed = new Promise(resolve => { finishRefresh = resolve; });
  let releaseSelect;
  const select = new Promise(resolve => { releaseSelect = resolve; });
  let widerFinished = false;
  try {
    await store.load();
    for (const [i, thread] of retainedThreads.entries()) {
      await store.recordHistory(thread, Array.from({ length: 50 },
        (_, index) => turn("archive-" + i + "-" + index, "", index)), {});
    }
    await store.recordHistory(taskA, [turn("retained-a")], {});
    const old = Array.from({ length: 19 }, (_, index) => turn("old-b-" + index,
      randomBytes(latestOutsideTail && index < 18 ? 25_000 : 4_000).toString("base64"), 900 + index));
    const userOnly = [1001, 1002].map(position => {
      const value = turn("user-only-" + position, "", position);
      if (!oversizedRequests) return { ...value, answer: "", messages: value.messages.slice(0, 1) };
      if (newerRequests === "annotated") {
        const middle = position === 1001;
        const messages = [{ ...value.messages[0], responseAnnotations: [
          { text: "X".repeat(middle ? 460_000 : 510_000), annotation: "kept quote" },
        ] }];
        if (!middle) messages.push(...Array.from({ length: 25 }, (_, i) => ({
          role: "user", itemId: value.id + "-extra-" + i, text: i + " " + "Y".repeat(11_990),
        })));
        return { ...value, answer: "", messages };
      }
      const messages = Array.from({ length: 55 }, (_, index) => ({
        itemId: value.id + "-request-" + index, role: "user",
        text: `${position}-${index} ` + "X".repeat(11_990),
      }));
      return { ...value, prompt: messages[0].text, answer: "", messages };
    });
    await store.recordHistory(taskB, [...old, newest, ...(latestOutsideTail ? userOnly : [])], {});
    const readHistory = createDesktopTaskHistoryFactory({
      selection: { activeProvider: () => "codex", threadId: () => "thread-a", chatId: () => 1 },
      catalog: { entries: () => [taskA, taskB],
        threadsForStream: id => id === "stream-b" ? [...retainedThreads, taskB] : [taskA] },
      historyReader: {
        readPage: (refs, options) => store.readHistoryPage(refs, options),
        read: task => ({ history: store.history(task) }),
        refresh: async task => { refreshedThreads.push(task.threadId); return {}; },
      },
      runs: { forTask: () => null },
      historyMerger: { mergeActive: mergeActiveTaskHistory, mergeCompleted: mergeCompletedTaskHistory },
      responseBudget: { fit: fitTaskHistoryPayload },
    });
    const router = createDesktopControlRouter({
      mutationActions: [],
      handlers: {
        snapshot: () => state,
        "runtime-health": () => ({ ok: true, ready: true }),
        "open-task": async (params, context) => ({ history: await readHistory(params, context), snapshot: state }),
        "select-task": async params => {
          if (params.streamId === taskB.streamId && params.deferSnapshot) await select;
          return params.deferSnapshot ? { selectionChanged: true, snapshotDeferred: true } : state;
        },
        "task-history": async (params, context) => {
          if (params.streamId !== taskB.streamId) return readHistory(params, context);
          const study = { id: params.clientTraceId, limit: params.limit, startedAt: performance.now() };
          studies.push(study);
          const beforePaint = studies.length === 1;
          if (!beforePaint) await followup;
          const result = await readHistory(params, context);
          if (studies.length === 1 && process.env.AGENT_HUB_TEST_HISTORY_POOL_LOAD === "1") {
            jobs.push(exercisePool("synthetic", "background", 4_000_000, 32, "sha256"));
          }
          Object.assign(study, { storageAndProjectionMs: performance.now() - study.startedAt,
            jsonBytes: Buffer.byteLength(JSON.stringify(result)), start: result.start, end: result.end,
            total: result.total, notModified: result.notModified === true });
          if (!beforePaint) {
            widerFinished = true;
            if (params.refreshSource) finishRefresh();
          }
          return result;
        },
      },
      commandTrace: { recordBestEffort: item => traces.push(item) },
    });
    const secret = "h".repeat(43);
    server = new MiniAppServer({ host: "127.0.0.1", port: 0, localAccessSecret: secret,
      journalDatabase: { subscribe: () => () => {} }, controlHandler: router.handleDesktopControl,
      recordCommandTrace: item => traces.push(item) });
    const { url } = await server.start();
    browser = await launchBrowser();
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const session = await context.request.post(url + "api/local-session", {
      headers: { Authorization: "local " + secret }, data: {},
    });
    assert.equal(session.status(), 200);
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.route("https://telegram.org/**", route => route.fulfill({ body: "" }));
    await page.goto(url, { waitUntil: "load" });
    const tab = id => page.locator('[data-stream-task-id="' + id + '"]:visible').first();
    await tab(taskB.streamId).waitFor();
    assert.equal(await page.title(), "Agent Hub");
    const request = page.waitForResponse(response => {
      if (!new URL(response.url()).pathname.endsWith("/api/control")) return false;
      const body = response.request().postDataJSON();
      return body?.action === "task-history" && body.params?.streamId === taskB.streamId;
    });
    const start = performance.now();
    await tab(taskB.streamId).click();
    const response = await request;
    const final = page.locator('[data-chat-pane] [data-role="agent"][data-turn-id="latest-b"]').first();
    await final.waitFor();
    const displayed = await final.textContent();
    assert.ok(displayed.includes("Start latest-b") && displayed.includes(newest.answer.split("\n\n")[1])
      && displayed.includes("End latest-b"));
    const lastUser = page.locator('[data-chat-pane] [data-role="user"][data-turn-id="latest-b"]').first();
    assert.match(await lastUser.textContent(), /Request latest-b/u);
    const firstPaint = performance.now() - start;
    if (oversizedRequests) {
      const reply = await response.json();
      assert.equal(reply.ok, true, reply.error);
      assert.deepEqual(reply.result.items.map(item => item.id), [newest.id]);
      assert.ok(studies[0].jsonBytes <= 850_000);
      assert.ok(reply.result.transportTruncated);
      assert.equal(reply.result.nextBefore, reply.result.total - 3);
      assert.equal(reply.result.end, reply.result.start + 1);
      assert.equal(reply.result.items[0].answer, newest.answer);
    }
    await page.evaluate(async () => {
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const trace = window.AgentHubCommandTrace;
      for (let attempt = 0; attempt < 12; attempt += 1) {
        if (!trace.diagnostics().pending && !trace.diagnostics().flushing) break;
        await trace.flush();
        if (trace.diagnostics().flushing) await new Promise(requestAnimationFrame);
      }
    });
    const paintTrace = traces.find(span => span.commandId === studies[0].id
      && span.metadata?.action === "history-page-paint" && span.outcome === "succeeded");
    assert.ok(paintTrace, "navigation trace must witness the visible canonical page: "
      + JSON.stringify(traces.filter(span => span.metadata?.action === "history-page-paint")
        .map(span => [span.commandId, span.outcome, span.metadata?.render, span.metadata?.trigger])));
    assert.equal(widerFinished, false);
    assert.equal(refreshedThreads.includes(taskB.threadId), false,
      "cold history must not start provider refresh ahead of the first paint");
    const responseTiming = response.request().timing();
    const phaseTrace = traces.filter(span => span.commandId === studies[0].id)
      .map(({ stage, outcome, observedAtMs, monotonicDurationMs, metadata }) =>
        ({ stage, outcome, observedAtMs, monotonicDurationMs, route: metadata?.route,
          action: metadata?.action, responseBytes: metadata?.responseBytes, jsonBytes: metadata?.jsonBytes,
          compression: metadata?.compression, threadCpuWindowMs: metadata?.threadCpuWindowMs,
          loopActiveWindowMs: metadata?.loopActiveWindowMs, browserBeforeRequestMs: metadata?.browserBeforeRequestMs,
          browserRequestToHeadersMs: metadata?.browserRequestToHeadersMs,
          browserBodyTransferMs: metadata?.browserBodyTransferMs, encodedBodyBytes: metadata?.encodedBodyBytes }));
    const parsedResponse = phaseTrace.find(span => span.action === "http-history-json-parse" && span.outcome === "succeeded");
    const resource = phaseTrace.find(span => span.action === "http-history-resource");
    assert.ok(parsedResponse);
    assert.equal(resource.encodedBodyBytes, Number((await response.allHeaders())["content-length"]));
    console.log("cold-history-measurements", JSON.stringify({
      first: studies[0], firstPaint, browserTiming: responseTiming,
      url, contentEncoding: (await response.allHeaders())["content-encoding"] ?? "identity",
      tracedPaintMs: paintTrace.monotonicDurationMs, stages: phaseTrace,
    }));
    if (!latestOutsideTail && process.env.AGENT_HUB_TEST_HISTORY_SCREENSHOT) {
      await page.screenshot({ path: process.env.AGENT_HUB_TEST_HISTORY_SCREENSHOT });
    }
    await tab(taskA.streamId).click();
    const firstA = page.locator('[data-chat-pane] [data-role="agent"][data-turn-id="retained-a"]').first();
    await firstA.waitFor();
    const repeat = performance.now();
    await tab(taskB.streamId).click();
    await final.waitFor();
    const retainedPaint = performance.now() - repeat;
    releaseSelect();
    releaseFollowup();
    if (oversizedRequests) {
      await page.locator('[data-chat-pane] [data-role="user"][data-turn-id="user-only-1002"]').first().waitFor();
    } else {
      await page.locator('[data-chat-pane] [data-role="agent"][data-turn-id="old-b-14"]').first().waitFor({ state: "attached" });
      assert.match(await final.textContent(), /End latest-b/u);
    }
    assert.deepEqual(errors, []);
    await refreshed;
    if (newerRequests === "annotated") {
      const latest = studies.find(study => study.start === studies[0].end + 1 && study.end === study.total);
      assert.ok(latest, "the refresh leaves exactly one intervening turn");
      const olderRequest = page.waitForResponse(response => {
        if (!new URL(response.url()).pathname.endsWith("/api/control")) return false;
        const body = response.request().postDataJSON();
        return body?.action === "task-history" && body.params?.before != null;
      });
      await page.locator("[data-history-load]").click();
      const loaded = await olderRequest;
      assert.equal(loaded.request().postDataJSON().params.before, latest.start);
      const reply = await loaded.json();
      assert.equal(reply.ok, true, reply.error);
      const previous = reply.result;
      const middle = previous.items.find(item => item.id === "user-only-1001");
      assert.equal(middle.messages.length, 1);
      assert.equal(middle.messages[0].responseAnnotations[0].text.length, 460_000);
      await page.locator('[data-chat-pane] [data-role="user"][data-turn-id="user-only-1001"]').first().waitFor();
    }
    if (oversizedRequests) {
      const older = await readHistory({ ...taskB, before: studies[0].start, limit: 30 });
      assert.equal(older.items.at(-1).id, old.at(-1).id);
    }
    assert.ok(refreshedThreads.includes(taskB.threadId));
    console.log("retained-history-measurements", JSON.stringify({ retainedPaint, requests: studies }));
    assert.equal(studies[0].limit, 30);
    assert.equal((await response.allHeaders())["content-encoding"], undefined);
    const visibleTurns = studies[0].total - studies[0].start;
    if (latestOutsideTail) assert.ok(visibleTurns >= 3 && visibleTurns < 30, "heavy page fits the transport budget");
    else assert.equal(visibleTurns, 30);
    assert.equal(studies.filter(study => study.id === studies[0].id).length, 1);
  } finally {
    releaseFollowup();
    releaseSelect();
    await Promise.allSettled(jobs);
    await browser?.close();
    await server?.close();
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
}
