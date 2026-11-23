import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MiniAppServer } from "../../src/interfaces/web/mini-app-server.mjs";
import { createDesktopControlRouter } from "../../src/interfaces/desktop/desktop-control-router.mjs";
import { createDesktopTaskHistoryFactory } from "../../src/interfaces/desktop/desktop-task-history.mjs";
import { LocalTaskSyncStore } from "../../src/infrastructure/persistence/task-sync-store.mjs";
import { readCodexVisualizationInWorker } from "../../src/providers/codex/codex-rollout-activity-worker-client.mjs";
import { mergeActiveTaskHistory, mergeCompletedTaskHistory } from "../../src/application/task-history.mjs";
import { createRuntimeHealth } from "../../src/application/runtime-health.mjs";
import { launchBrowser, snapshot } from "./composer-production.fixture.mjs";

const identity = { provider: "codex", streamId: "stream-a", threadId: "88888888-2222-4555-9555-aaaaaaaaaaaa" };
const turnId = "turn-visualization";
const itemId = "final-visualization";
const marker = (file, other) => "\uE200visualize\uE202" + JSON.stringify({ path: file, ...other }) + "\uE201";

test("chat renders a Codex visualization in place and reopens it from SQLite history", { timeout: 45_000 }, async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hub-visualization-chat-"));
  const filePath = path.join(directory, "tasks.json");
  let store = new LocalTaskSyncStore({ filePath });
  const attachmentDirectory = path.join(directory, "attachments");
  const artifactDirectory = path.join(attachmentDirectory, "visualizations", identity.threadId);
  const readyFile = path.join(artifactDirectory, "chart.html");
  const missingFile = path.join(artifactDirectory, "missing.html");
  const transcript = path.join(directory, "rollout.jsonl");
  const fence = "\x60\x60\x60";
  const answer = [
    "Before the chart", marker(readyFile, { title: "Interactive chart", mode: "wide" }), "After the chart",
    "", marker(missingFile), "", "\uE200visualize\uE202invalid\uE201",
    "", fence, marker(readyFile), fence, "", '<button id="raw-markup">Literal HTML</button>',
  ].join("\n");
  const start = "2026-11-22T19:13:00.000Z";
  const end = "2026-11-22T19:14:00.000Z";
  const rows = [
    { type: "session_meta", payload: { id: identity.threadId }, timestamp: start },
    { type: "event_msg", payload: { type: "task_started", turn_id: turnId }, timestamp: start },
    { type: "event_msg", payload: { type: "item_completed", thread_id: identity.threadId, turn_id: turnId,
      item: { type: "AgentMessage", id: itemId, phase: "final_answer", content: [{ text: answer }] } }, timestamp: end },
    { type: "event_msg", payload: { type: "task_complete", turn_id: turnId, last_agent_message: answer }, timestamp: end },
  ];
  const initial = snapshot();
  initial.tasks[0].threadId = identity.threadId;
  initial.selected.threadId = identity.threadId;
  initial.workspaces[0].streams[0].threads[0].id = identity.threadId;
  const binding = { ...identity, projectRoot: directory, title: "Fixture chat" };
  const requested = [];
  const backend = createDesktopTaskHistoryFactory({
    selection: { activeProvider: () => "codex", threadId: () => identity.threadId, chatId: () => 1 },
    catalog: { entries: () => [binding], threadsForStream: (id) => id === identity.streamId ? [binding] : [] },
    historyReader: {
      readPage: (threads, options) => store.readHistoryPage(threads, options),
      readTurn: (target) => store.historyTurn(target),
      readVisualization: (address) => {
        requested.push(address);
        return readCodexVisualizationInWorker(transcript, { ...address, attachmentDirectory });
      },
    },
    runs: { forTask: () => null },
    historyMerger: { mergeActive: mergeActiveTaskHistory, mergeCompleted: mergeCompletedTaskHistory },
    responseBudget: { fit: (payload) => payload },
  });
  const router = createDesktopControlRouter({
    mutationActions: [],
    handlers: {
      snapshot: () => initial,
      "open-task": async (params) => ({ snapshot: initial, history: await backend(params) }),
      "select-task": () => initial,
      "task-history": backend,
      "mark-task-read": () => ({}),
      "report-diagnostic": () => ({}),
    },
  });
  const health = createRuntimeHealth();
  health.begin();
  health.complete();
  const server = new MiniAppServer({
    port: 0, telegramRuntime: false,
    health,
    attachmentDirectory,
    journalDatabaseFile: path.join(directory, "mini-app-journal.sqlite"),
    controlHandler: (request) => router.handleDesktopControl(request),
  });
  let browser;
  t.after(async () => {
    await browser?.close();
    await server.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  await mkdir(artifactDirectory, { recursive: true });
  await writeFile(transcript, rows.map(row => JSON.stringify(row)).join("\n") + "\n");
  await store.load();
  await store.recordHistory(binding, [{ id: turnId, startedAt: start, completedAt: end, completed: true,
    messages: [{ itemId, role: "agent", phase: "final_answer", text: answer }] }]);
  const { url } = await server.start();
  await writeFile(readyFile, [
    '<button id="choice">Toggle</button> <output id="series">A</output> <output id="boundary"></output>',
    '<button type="button" id="navigate">Probe navigation</button>',
    '<script>const series=document.getElementById("series");',
    'document.getElementById("choice").onclick=()=>{series.textContent=series.textContent==="A"?"B":"A";};',
    'let canReadParent=false;try{canReadParent=!!parent.document.body;}catch{}',
    'parent.postMessage({type:"agenthub:runtime-published"},"*");',
    'const boundary=document.getElementById("boundary");',
    'document.getElementById("navigate").onclick=()=>{location.href='
      + JSON.stringify(new URL("visualization-boundary-probe", url).href) + ';};',
    'fetch(' + JSON.stringify(new URL("visualization-boundary-probe", url).href) + ').then(()=>{boundary.textContent="unexpected";},',
    '()=>{boundary.textContent=canReadParent?"unexpected":"isolated";});</script>',
  ].join("\n"));
  browser = await launchBrowser();
  for (const width of [1280, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 900 }, hasTouch: width < 600 });
    const errors = [];
    const consoleMessages = [];
    const unexpectedRequests = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("console", message => consoleMessages.push(message.text()));
    page.on("request", request => {
      if (request.url().includes("/visualization-boundary-probe")) unexpectedRequests.push(request.url());
    });
    try {
      if (width < 600) {
        store.close();
        store = new LocalTaskSyncStore({ filePath });
        await store.load();
      }
      const response = await page.goto(url, { waitUntil: "load" });
      assert.match(response.headers()["content-security-policy"], /frame-src 'self'/u);
      assert.match(await page.title(), /Agent Hub/u);
      await page.evaluate(() => window.AgentHub.showSelectedTask());
      await page.locator(".hub-startup-screen").waitFor({ state: "hidden", timeout: 8_000 });
      const body = page.locator(".msg-body").filter({ hasText: "Before the chart" }).last();
      const chart = body.locator("hub-message-visualization.is-wide");
      await chart.scrollIntoViewIfNeeded();
      const frame = chart.frameLocator("iframe").frameLocator("iframe");
      await frame.getByRole("button", { name: "Toggle" }).click({ timeout: 8_000 });
      assert.equal(await frame.locator("#series").textContent(), "B", JSON.stringify(consoleMessages));
      assert.equal(await frame.locator("#boundary").textContent(), "isolated");
      assert.equal(await chart.locator("iframe").getAttribute("sandbox"), "allow-scripts");
      assert.equal(await chart.locator("iframe").getAttribute("title"), "Interactive chart");
      assert.deepEqual(await body.locator(":scope > p, :scope > hub-message-visualization").allTextContents()
        .then(values => values.slice(0, 3)), ["Before the chart", "", "After the chart"]);
      const unavailable = body.locator("hub-message-visualization:not(.is-wide)");
      await unavailable.first().scrollIntoViewIfNeeded();
      await unavailable.first().getByText("Визуализация недоступна").waitFor();
      assert.equal(await unavailable.count(), 2, "invalid and missing only; code is literal");
      assert.equal(await body.locator("#raw-markup").count(), 0);
      assert.equal(await body.locator("pre").count(), 1);
      assert.equal(await body.locator("iframe").count(), 1);
      assert.deepEqual(unexpectedRequests, []);
      assert.deepEqual(errors, []);
      if (process.env.HUB520_SCREENSHOTS) {
        await chart.scrollIntoViewIfNeeded();
        await page.screenshot({ path: path.join(process.env.HUB520_SCREENSHOTS, "chart-" + width + ".png") });
      }
      const blockedNavigation = page.waitForEvent("console", {
        predicate: (message) => /frame-src/u.test(message.text()),
        timeout: 5_000,
      });
      await frame.getByRole("button", { name: "Probe navigation" }).click();
      await blockedNavigation.catch((error) => {
        throw new Error(JSON.stringify({ unexpectedRequests, consoleMessages }), { cause: error });
      });
      assert.deepEqual(unexpectedRequests, [], "the child cannot navigate to an API on the Hub origin");
    } finally {
      await page.close();
    }
  }
  assert.ok(requested.length >= 4);
  assert.ok(requested.every(request => request.threadId === identity.threadId
    && request.turnId === turnId && request.itemId === itemId));
  assert.equal(store.historyTurn({ ...identity, turnId }).messages.at(-1).text, answer);
  const foreign = await backend({ ...identity, threadId: "88888888-2222-4555-9555-bbbbbbbbbbbb",
    visualization: { turnId, itemId, markerHash: requested[0].markerHash } });
  assert.equal(foreign.html, null);
});
