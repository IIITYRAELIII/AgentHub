import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createCommandTraceComposition } from "../../src/composition/command-trace-composition.mjs";
import { TaskReadStateStore, taskHasUnreadAnswer } from "../../src/infrastructure/persistence/task-read-state-store.mjs";
import { createDesktopControlRouter } from "../../src/interfaces/desktop/desktop-control-router.mjs";
import { DesktopReadModelService } from "../../src/interfaces/desktop/desktop-read-model-service.mjs";
import { MiniAppServer } from "../../src/interfaces/web/mini-app-server.mjs";
import { launchBrowser, snapshot } from "./composer-production.fixture.mjs";

test("a visible final is acknowledged while the previous chat's obsolete history is still held on the server", {
  timeout: 30_000,
}, async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "hub-read-marker-http-"));
  const trace = createCommandTraceComposition({ dataDir, instanceId: "read-lab", releaseId: "read-lab" });
  const store = new TaskReadStateStore({ dataDir });
  const initial = snapshot();
  const final = { provider: "codex", threadId: "thread-b", turnId: "exact-final", revision: 1,
    completedAt: new Date().toISOString() };
  initial.tasks[1].lastAnswerAt = final.completedAt;
  initial.server.process = { instanceId: "read-lab", releaseId: "read-lab" };
  const service = new DesktopReadModelService({
    snapshot: ({ projectTask }) => ({
      ...initial, apiVersion: 3, version: `read-${store.revision}`, tasks: initial.tasks.map(projectTask),
    }),
    resolveReadTask: ({ streamId, threadId }) => initial.tasks.find(task => (
      task.streamId === streamId && task.threadId === threadId
    )),
    readStateStore: store,
    trustedDeviceUserId: () => "read-owner",
    lastTaskMessage: task => task.threadId === final.threadId
      ? { turnId: final.turnId, updatedAt: final.completedAt, terminalRevision: final.revision } : null,
    hasUnread: taskHasUnreadAnswer,
    commandTrace: trace.service,
  });
  const previous = Promise.withResolvers();
  const historyStarted = Promise.withResolvers();
  const historyReleased = Promise.withResolvers();
  const optionalStarted = Promise.withResolvers();
  const optionalReleased = Promise.withResolvers();
  const optional = [];
  const reads = [];
  const browserErrors = [];
  const history = ({ threadId, streamId }) => {
    const items = threadId === final.threadId ? [{
      id: final.turnId, completed: true, status: "completed", terminalRevision: final.revision,
      answer: "Exact completed response", completedAt: final.completedAt,
    }] : [];
    return { provider: "codex", threadId, streamId, items, start: 0, end: items.length,
      total: items.length, messageTotal: items.length, nextBefore: null, version: `history-${threadId}` };
  };
  const router = createDesktopControlRouter({
    commandTrace: trace.service,
    mutationActions: ["mark-task-read"],
    concurrentMutationActions: ["mark-task-read"],
    handlers: {
      snapshot: (params, context) => service.snapshot(params, context),
      "runtime-health": () => ({ live: true, ready: true }),
      "rate-limit-history": () => ({ points: [] }),
      "open-task": async (params, context) => ({
        history: history(params), snapshot: await service.snapshot(params, context),
      }),
      "select-task": () => ({ snapshotDeferred: true }),
      "task-history": async (params) => {
        if (params.threadId === "thread-a" && params.includeActive && params.refreshSource) {
          previous.resolve();
          await optionalReleased.promise;
        }
        if (params.threadId === final.threadId && !params.includeActive) {
          historyStarted.resolve();
          await historyReleased.promise;
        }
        return history(params);
      },
      "test-held-read": async (params) => {
        optional.push(params.name);
        if (optional.length === 4) optionalStarted.resolve();
        await optionalReleased.promise;
        return {};
      },
      "mark-task-read": (params, context) => {
        reads.push({ id: params.clientTraceId, source: context.source, final: params.final });
        return service.markTaskRead(params, context);
      },
    },
  });
  const cookie = "b".repeat(43);
  const server = new MiniAppServer({
    port: 0, telegramRuntime: false,
    journalDatabase: { subscribe: () => () => {}, version: "test", html: () => "" },
    health: { snapshot: () => ({ live: true, ready: true, degraded: false, status: "ready", capabilities: [] }) },
    deviceStore: { resolveSession: async supplied => {
      assert.equal(supplied, cookie);
      return { id: "read-owner", deviceId: "device" };
    } },
    controlHandler: router.handleDesktopControl,
    recordCommandTrace: span => trace.service.recordBestEffort(span),
  });
  let browser;
  try {
    await trace.initialize();
    await store.initialize();
    const { url } = await server.start();
    browser = await launchBrowser();
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await context.addCookies([{ name: "agent_hub_device", value: cookie, url, httpOnly: true, sameSite: "Strict" }]);
    const page = await context.newPage();
    page.on("pageerror", error => browserErrors.push(error.message));
    let previousRequestCancelled = false;
    page.on("requestfailed", request => {
      if (new URL(request.url()).pathname !== "/api/control" || request.method() !== "POST") return;
      const body = request.postDataJSON();
      if (body.action === "task-history" && body.params.threadId === "thread-a" && body.params.refreshSource) {
        previousRequestCancelled = request.failure()?.errorText === "net::ERR_ABORTED";
      }
    });
    await page.goto(`${url}#/chat/stream/stream-a`, { waitUntil: "load" });
    const tab = page.locator('[data-stream-task-id="stream-b"][data-answer-ready]:visible').first();
    const card = page.locator('[data-activity-task-id="stream-b"][data-answer-ready]:visible').first();
    await tab.waitFor();
    await card.waitFor();
    await previous.promise;
    assert.equal(reads.length, 0, "the unread snapshot alone cannot admit a read");
    await tab.click();
    await historyStarted.promise;
    await page.evaluate(() => {
      // Fill the usual HTTP/1.1 socket pool if the obsolete request still owns its socket.
      window.heldReadTest = Array.from({ length: 5 }, (_, name) => fetch("/api/control", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "test-held-read", params: { name } }),
      }).then(response => response.json()));
      // A long-lived document with a full Resource Timing buffer still needs the trace.
      performance.setResourceTimingBufferSize(1);
    });
    await optionalStarted.promise;
    historyReleased.resolve();
    await page.locator('[data-role="agent"][data-turn-id="exact-final"]').first().waitFor({ timeout: 7_000 });
    await page.waitForFunction(() => {
      const tab = document.querySelector('[data-stream-task-id="stream-b"]');
      const card = document.querySelector('[data-activity-task-id="stream-b"]');
      return tab && card && !tab.hasAttribute("data-answer-ready") && !card.hasAttribute("data-answer-ready");
    }, null, { timeout: 7_000 });
    assert.equal(previousRequestCancelled, true);
    assert.equal(reads.length, 1);
    assert.equal(reads[0].source, "trusted-device");
    assert.deepEqual(reads[0].final, final);
    assert.equal(optional.length, 5);
    assert.equal(store.get({ accountId: "read-owner", provider: final.provider, threadId: final.threadId }).answerTurnId, final.turnId);
    assert.equal(await page.title(), "Agent Hub");
    assert.equal(new URL(page.url()).origin, new URL(url).origin);
    assert.deepEqual(browserErrors, []);
    optionalReleased.resolve();
    await page.evaluate(async () => {
      await Promise.all(window.heldReadTest);
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      for (let left = 24; left > 0 && window.AgentHubCommandTrace.diagnostics().pending; left--) {
        await window.AgentHubCommandTrace.flush();
      }
    });
    const spans = await trace.service.readCommandTimeline(reads[0].id);
    const passed = action => spans.find(span => span.metadata?.action === action && span.outcome === "succeeded");
    const viewed = passed("read-marker-view");
    const http = passed("read-marker-http");
    const clear = passed("read-marker-clear");
    assert.ok(viewed && http && clear);
    assert.equal(http.metadata.documentId, viewed.metadata.documentId);
    assert.equal(clear.metadata.documentId, viewed.metadata.documentId);
    assert.equal(http.metadata.fetchCount, 1);
    assert.equal(http.metadata.httpProtocol, "http/1.1");
    assert.ok(Number.isFinite(http.metadata.fetchToRequestMs));
    assert.ok(Number.isFinite(http.metadata.requestToHeadersMs));
    assert.ok(spans.some(span => span.stage === "read-cursor-projected" && span.metadata.unread === false));
    assert.equal(clear.metadata.tabPresent, true);
    assert.equal(clear.metadata.cardPresent, true);
    if (process.env.AGENT_HUB_UI_EVIDENCE_DIR) {
      await page.screenshot({ path: path.join(process.env.AGENT_HUB_UI_EVIDENCE_DIR, "read-marker-http-cleared.png") });
    }
  } finally {
    historyReleased.resolve();
    optionalReleased.resolve();
    await browser?.close();
    await server.close();
    await trace.close();
    await store.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
