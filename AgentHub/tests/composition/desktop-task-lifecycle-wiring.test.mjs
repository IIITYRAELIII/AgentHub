import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { WorkspaceCatalogService } from "../../src/application/workspace-catalog-service.mjs";
import { createWorkspaceActions } from "../../src/composition/desktop-command-wiring-composition.mjs";
import { TaskBoardService } from "../../src/application/task-board-service.mjs";
import { TaskBoardStore } from "../../src/infrastructure/persistence/task-board-store.mjs";
import { WorkspaceCatalogStore } from "../../src/infrastructure/persistence/workspace-catalog-store.mjs";
import { MessageReceiptRegistry } from "../../src/infrastructure/persistence/message-receipts.mjs";
import { RuntimeStateStore } from "../../src/infrastructure/persistence/runtime-state-store.mjs";
import { JournalDatabase } from "../../src/infrastructure/persistence/journal-database.mjs";

async function loadComposition(filename, overrides = {}) {
  const url = new URL(`../../src/composition/${filename}`, import.meta.url);
  const source = await readFile(url, "utf8");
  const imports = /^import\s+([\s\S]*?)\s+from\s+["']([^"']+)["'];/gm;
  const scope = {};
  for (const [, bindings, specifier] of source.matchAll(imports)) {
    const namespace = await import(new URL(specifier, url).href);
    if (bindings.startsWith("* as ")) {
      scope[bindings.slice(5).trim()] = namespace;
    } else if (bindings.startsWith("{")) {
      for (const binding of bindings.slice(1, -1).split(",").map((value) => value.trim()).filter(Boolean)) {
        const [name, alias = name] = binding.split(/\s+as\s+/u);
        scope[alias] = namespace[name];
      }
    } else {
      scope[bindings.trim()] = namespace.default;
    }
  }
  Object.assign(scope, overrides);
  vm.runInNewContext(source.replace(imports, "").replace(/^export /gm, ""), scope, { filename: url.pathname });
  return scope;
}

async function fixture(taskLifecycle, releaseServices = {}) {
  const snapshot = { boardTasks: [{ id: "task-test", status: "done" }] };
  const runRouter = await loadComposition("desktop-run-router-wiring-composition.mjs", {
    createDesktopRunInputComposition: () => ({ desktopMessageController: { sendMessage() {} } }),
    TaskBoardLaunchService: class {},
    createDesktopRouterComposition: ({ handlers }) => ({
      handleDesktopControl: ({ action, params, context }) => {
        assert.equal(action, "board-task-complete");
        return handlers.boardTaskComplete(params, context);
      },
    }),
  });
  const desktop = await loadComposition("desktop-shell-composition.mjs", {
    createDesktopReadSystemWiring: () => ({ desktopSnapshot: async () => snapshot }),
    createDesktopCommandWiring: ({ services }) => ({ desktopSnapshotActions: {}, ...createWorkspaceActions(services) }),
    createDesktopRunRouterWiring: runRouter.createDesktopRunRouterWiring,
    createDesktopTaskCreationPreparation: () => () => {},
    WorkspaceCatalogService,
    ClientTaskSelectionService: class {},
    StreamMessagePinService: class {},
  });
  const interaction = await loadComposition("interaction-shell-phase-composition.mjs", {
    createDesktopShellComposition: desktop.createDesktopShellComposition,
    createRunShellComposition: () => ({}),
    createServerControlComposition: () => ({}),
  });
  let boundCommands;
  const composition = interaction.createInteractionShellPhase({
    config: { dataDir: "." },
    root: ".",
    server: {},
    settings: {},
    selection: { hostState: {} },
    infrastructure: {
      taskLifecycle,
      ...releaseServices,
      workspaceCatalogStore: { hierarchy: () => [] },
      runtimeStateStore: { saveDeferredIntake() {} },
    },
    provider: {
      taskSyncStore: { searchMessages() {}, messageSearchStatus() {}, markMessageSearchThread() {} },
    },
    clients: { approvalController: {} },
    deferred: {
      api: {},
      ports: {
        desktopCommands: { api: {}, bind(commands) { boundCommands = commands; } },
      },
    },
  });
  return { composition, boundCommands, snapshot };
}

async function composedBoardFixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "hub-board-wiring-"));
  const databaseFile = path.join(root, "journal.sqlite");
  const catalog = new WorkspaceCatalogStore({ databaseFile });
  await catalog.load();
  const store = new TaskBoardStore({ databaseFile });
  const externalStore = new TaskBoardStore({ databaseFile });
  const journal = new JournalDatabase(databaseFile);
  const runtimeStateStore = new RuntimeStateStore({ dataDir: root });
  t.after(async () => {
    await runtimeStateStore.close();
    journal.close(); externalStore.close(); store.close(); catalog.close();
    await rm(root, { recursive: true, force: true });
  });
  const workspace = catalog.createWorkspace({ name: "Fixture" });
  const board = new TaskBoardService({ store, workspaceCatalog: catalog });
  let boardReads = 0;
  let afterBoardRead = null;
  const readBoard = board.snapshot.bind(board);
  board.snapshot = () => {
    boardReads += 1;
    const result = readBoard();
    afterBoardRead?.();
    return result;
  };
  // Execute both production wiring layers and the real snapshot/cache/SQLite
  // owners. Only unrelated command, launch and selection services are replaced.
  const desktop = await loadComposition("desktop-shell-composition.mjs", {
    createDesktopCommandWiring: () => ({ desktopSnapshotActions: {} }),
    createDesktopRunRouterWiring: () => ({}),
    createDesktopTaskCreationPreparation: () => () => {},
    WorkspaceCatalogService: class {}, ClientTaskSelectionService: class {},
    StreamMessagePinService: class { snapshot() { return []; } },
  });
  const taskRuns = { revision: 0, values: () => [], forTask: () => null };
  const preferences = { snapshot: () => ({}), current: () => ({}) };
  const receipts = new MessageReceiptRegistry();
  const project = { path: root, name: "Fixture" };
  const models = { codexModels: [], codexModelLabel: () => "Test", claudeModels: [],
    claudeModelLabels: {}, reasoningEfforts: [], claudeReasoningEfforts: [],
    reasoningLabels: {}, collaborationModes: [], collaborationModeLabels: {} };
  let bound;
  desktop.createDesktopShellComposition({
    config: { dataDir: root, allowedUserIds: new Set(), components: {} },
    diagnostics: {}, limits: { projects: [project] }, models,
    state: { hostState: {}, agentPreferences: preferences, selectionStore: { revision: 0 },
      selectedProvider: () => "codex", selectedProjectRoot: () => root,
      selectedTaskTitle: () => "Fixture", selectedThreadId: () => "", isCodex: () => true,
      selectedTask: () => ({}), selectedTurnTarget: () => ({}), activeProject: () => project },
    catalog: { getTaskCatalog: () => [], findProject: () => project,
      taskCatalogService: { entries: [], snapshotRevision: 0, stale: false } },
    runtime: { taskBoard: board, workspaceCatalogStore: catalog, taskRuns, runtimeStateStore,
      taskSyncStore: { revision: 0 }, messagePins: { revision: 0, snapshot: () => [] },
      pendingInputs: new Map(), queuedInputs: new Map(), approvalController: { pending: new Map(), snapshot: () => [] },
      contextCompactions: { runningCount: () => 0 }, streamMaintenance: { entry: () => null },
      taskReadStateStore: { revision: 0, get: () => null, markRead() {} }, usdRubRateStore: { snapshot: () => ({}) },
      lastTaskMessageRevision: () => 0, savedLastTaskMessageRecord: () => null, restartBlockingRuns: () => [],
      backgroundJobs: { size: 0, mediaSize: 0, speechSize: 0 } },
    provider: {}, clients: { desktopMessageReceipts: receipts },
    presentation: { samePath: (a, b) => a === b }, repositories: {},
    serverControlController: { snapshot: async () => ({}) },
    desktopCommandsPort: { api: {}, bind(value) { bound = value; } },
  });
  return { snapshot: (options) => bound.snapshot(options), boardReads: () => boardReads,
    onBoardRead: (callback) => { afterBoardRead = callback; }, taskRuns, board, store, externalStore,
    journal, workspace, root, receipts, runtimeStateStore };
}


test("addressed snapshot retains an accepted steer from runtime receipts during and beyond the recent window", async t => {
  const f = await composedBoardFixture(t);
  const identity = { provider: "codex", threadId: "thread-a", clientUserMessageId: "android-original" };
  f.receipts.reserve(identity, "original-fingerprint", {
    id: "intake-original", streamId: "stream-a", accepted: true, providerAccepted: false, queued: true, deferred: true,
    displayText: "One original submission",
  });
  const receipt = value => value.messageReceipts.find(row => row.clientUserMessageId === identity.clientUserMessageId);
  // Runtime receipt-only compatibility is real: a registry receipt can exist
  // without a corresponding row in the durable message-command ledger.
  assert.equal(f.runtimeStateStore.messageCommand(identity.clientUserMessageId) ?? null, null);
  const queued = await f.snapshot();
  assert.equal(receipt(queued)?.queued, true);
  const addressed = params => f.snapshot({ messageReceiptIds: [identity.clientUserMessageId, "missing"], ...params });
  assert.deepEqual(receipt(await addressed()), receipt(queued));
  f.receipts.updateResult(identity, { ...f.receipts.get(identity).result,
    turnId: "active-turn", providerAccepted: true, steered: true, queued: false, deferred: false });
  const accepted = await addressed({ knownVersion: queued.version });
  assert.deepEqual(receipt(accepted), receipt(await f.snapshot()));
  assert.equal(receipt(accepted)?.turnId, "active-turn");
  assert.equal(receipt(accepted)?.providerAccepted, true);
  assert.equal(receipt(accepted)?.steered, true);
  assert.equal(accepted.messageReceipts.some(row => row.clientUserMessageId === "missing"), false);
  for (let i = 0; i < 101; i += 1) {
    f.receipts.reserve({ ...identity, clientUserMessageId: `later-${i}` }, `fingerprint-${i}`, { accepted: true });
  }
  assert.equal(receipt(await f.snapshot()), undefined);
  assert.deepEqual(receipt(await addressed()), receipt(accepted));
  const repeated = await addressed();
  assert.equal((await addressed({ knownVersion: repeated.version })).notModified, true);
});


test("Android bridge HTTP reconnect removes the exact delivered steer card", { timeout: 45_000 }, async t => {
  const { launchBrowser, openFixture, snapshot, submit } = await import("../public/composer-production.fixture.mjs");
  const f = await composedBoardFixture(t);
  const browser = await launchBrowser();
  t.after(() => browser.close());
  const viewport = { width: 390, height: 844 };
  const page = await browser.newPage({ viewport, hasTouch: true, isMobile: true });
  await page.addInitScript(() => { window.AgentHubAndroid = {}; });
  const identity = { provider: "codex", threadId: "thread-a", streamId: "stream-a" };
  const text = "One message sent using the Android bridge";
  const controls = ["queued", "unknown", "paused"].map(state => ({
    ...identity, id: `control-${state}`, clientUserMessageId: `client-${state}`, state, text,
    accepted: true, providerAccepted: false, deferred: true,
  }));
  const view = receipts => ({ ...snapshot(receipts), deferredInputs: controls });
  const trace = [];
  page.on("request", request => {
    if (request.url().endsWith("/api/command-trace/client-events")) trace.push(...(request.postDataJSON()?.events ?? []));
  });
  const errors = await openFixture(page, { surface: "web", fixtureSnapshot: view([]) });
  await page.evaluate(() => window.AgentHub.showSelectedTask());
  assert.equal(new URL(page.url()).hostname, "agent-hub.test");
  assert.ok((await page.title()).includes("Agent Hub"));
  const calls = [];
  let id = null, reads = 0, notModified = 0;
  const read = async ({ messageReceiptIds, knownVersion }) => {
    const wire = await f.snapshot({ messageReceiptIds, knownVersion });
    if (messageReceiptIds?.includes(id)) reads += 1;
    if (wire.notModified) { notModified += 1; return wire; }
    return { ...view(wire.messageReceipts), version: wire.version };
  };
  const sendJSON = (route, value) => route.fulfill({ contentType: "application/json", body: JSON.stringify(value) });
  await page.route("**/api/snapshot*", route => read({
    knownVersion: new URL(route.request().url()).searchParams.get("knownVersion") ?? "",
  }).then(value => sendJSON(route, value)));
  await page.route("**/api/control", async route => {
    const { action, params } = route.request().postDataJSON();
    if (action === "snapshot") return sendJSON(route, { ok: true, result: await read(params) });
    if (action !== "send-message") return route.fallback();
    calls.push(params.clientUserMessageId);
    id = params.clientUserMessageId;
    const queued = { id: "intake-item", ...identity, accepted: true, providerAccepted: false,
      queued: true, deferred: true, displayText: text, clientProjectionIntent: "queue" };
    f.receipts.reserve({ ...identity, clientUserMessageId: id }, "exact-intake", queued);
    return sendJSON(route, { ok: true, result: queued });
  });
  const intake = page.waitForResponse(response => response.url().endsWith("/api/control")
    && response.request().postDataJSON()?.action === "send-message");
  await submit(page, { text });
  await (await intake).finished();
  await page.waitForFunction(() => document.querySelectorAll(".queue-item").length === 4);
  assert.ok(id);
  const originalCard = page.locator(`.queue-item[data-queue-id="local:${id}"]`);
  await originalCard.waitFor({ state: "visible" });
  const command = { ...identity, clientUserMessageId: id };
  f.receipts.updateResult(command, { ...f.receipts.get(command).result, providerAccepted: true,
    steered: true, queued: false, deferred: false, turnId: "active-turn" });
  const committedAt = Date.now();
  await page.locator("[data-provider-connection-retry]").evaluate(button => button.click());
  await originalCard.waitFor({ state: "detached", timeout: 5_000 });
  await page.locator(".msg[data-delivery-state='running']").filter({ hasText: text }).waitFor({ state: "visible" });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const paintedAt = Date.now();
  assert.ok(reads > 0, "Android used its addressed HTTP snapshot path");
  assert.equal(await page.locator(".queue-item").count(), 3);
  for (const { id: controlId } of controls) assert.equal(await page.locator(`.queue-item[data-queue-id="${controlId}"]`).count(), 1);
  const isPaint = event => event.commandId === id && event.outcome === "succeeded"
    && event.metadata?.surface === "android" && event.metadata.action === "message-receipt-queue-paint"
    && event.metadata.retained === false;
  if (!trace.some(isPaint)) {
    await page.waitForRequest(request => request.url().endsWith("/api/command-trace/client-events")
      && (request.postDataJSON()?.events ?? []).some(isPaint), { timeout: 6000 }).catch(error => {
      const seen = trace.filter(event => event.commandId === id).map(({ stage, outcome, metadata }) =>
        ({ stage, outcome, action: metadata?.action, view: metadata?.view, retained: metadata?.retained }));
      assert.fail(`${error.message}
Observed original trace: ${JSON.stringify(seen)}`);
    });
  }
  const priorCache = notModified;
  const repeated = page.waitForResponse(response => notModified > priorCache
    && response.url().includes("/api/snapshot"));
  await page.locator("[data-provider-connection-retry]").evaluate(button => button.click());
  await (await repeated).finished();
  await page.reload();
  await page.evaluate(() => window.AgentHub.showSelectedTask());
  await page.locator(".msg[data-delivery-state='running']").filter({ hasText: text }).waitFor({ state: "visible" });
  assert.equal(await originalCard.count(), 0);
  assert.equal(await page.locator(".queue-item").count(), 3);
  assert.deepEqual(calls, [id]);
  assert.deepEqual(errors, []);
  if (process.env.AGENT_HUB_TEST_ARTIFACT_DIR) {
    await page.screenshot({ path: path.join(process.env.AGENT_HUB_TEST_ARTIFACT_DIR, "android-receipt-after.png") });
  }
  console.log(JSON.stringify({ surface: "android-bridge-fixture", viewport, commandId: id,
    receiptToPaintUpperBoundMs: paintedAt - committedAt, addressedReads: reads, notModified }));
});

test("composed board snapshot reuses the board across conversation-only revisions", async (t) => {
  const f = await composedBoardFixture(t);
  const first = await f.snapshot();
  f.taskRuns.revision += 1;
  const second = await f.snapshot({ knownVersion: first.version });
  assert.equal(second.snapshotTiming.cacheHit, false, "the conversation revision must rebuild the outer snapshot");
  assert.equal(f.boardReads(), 1, "the real shell must forward the live board revision");
  assert.equal(second.version, first.version, "unchanged content retains its canonical version");
});

test("composed board snapshot invalidates for board and journal-only commits", async (t) => {
  const f = await composedBoardFixture(t);
  await f.snapshot();
  const task = f.externalStore.create({ text: "External", bucket: "workspace", workspaceId: f.workspace.id });
  const changed = await f.snapshot();
  assert.equal(f.boardReads(), 2);
  assert.ok(changed.boardTasks.some((item) => item.id === task.id));
  f.store.claim(task.id, { workspaceId: f.workspace.id, streamId: "stream", provider: "codex",
    threadId: "journal-thread", turnId: "journal-turn", operationId: "claim" });
  const claimed = await f.snapshot();
  const beforeDetails = claimed.boardTasks.find((item) => item.id === task.id).detailsRevision;
  const beforeJournal = f.boardReads();
  await f.journal.upsertRecords([{ provider: "codex", threadId: "journal-thread", taskThreadId: "journal-thread",
    turnId: "journal-turn", projectRoot: f.root, title: "Completed", body: "private body",
    completedAt: "2026-10-15T00:00:00Z", status: "completed" }]);
  const completed = await f.snapshot();
  assert.equal(f.boardReads(), beforeJournal + 1);
  const summary = completed.boardTasks.find((item) => item.id === task.id);
  assert.notEqual(summary.detailsRevision, beforeDetails);
  assert.equal(summary.detailsDeferred, true);
  assert.equal(Object.hasOwn(summary, "workLog"), false);
  const details = await f.board.card(task.id);
  assert.equal(details.detailsRevision, summary.detailsRevision);
  assert.equal(details.workLog[0].summary, "Completed");
  assert.equal(details.workLog[0].turnId, "journal-turn");
  assert.equal(JSON.stringify(details).includes("private body"), false);
  assert.equal(JSON.stringify(completed.boardTasks).includes("private body"), false);
  f.taskRuns.revision += 1;
  await f.snapshot();
  assert.equal(f.boardReads(), beforeJournal + 1, "the journal invalidation is consumed once");
});

test("composed board snapshot does not cache a revision that changes during its read", async (t) => {
  const f = await composedBoardFixture(t);
  let task;
  f.onBoardRead(() => {
    f.onBoardRead(null);
    task = f.externalStore.create({ text: "Raced", bucket: "workspace", workspaceId: f.workspace.id });
  });
  const raced = await f.snapshot();
  assert.equal(raced.boardTasks.some((item) => item.id === task.id), false);
  const current = await f.snapshot();
  assert.equal(f.boardReads(), 2, "a changed revision cannot admit the pre-write board into the cache");
  assert.ok(current.boardTasks.some((item) => item.id === task.id));
  f.taskRuns.revision += 1;
  await f.snapshot();
  assert.equal(f.boardReads(), 2, "the stable follow-up read can be cached");
});

test("Task completion crosses interaction and Desktop composition using the shared lifecycle owner", async () => {
  const calls = [];
  const lifecycleResult = { taskId: "task-test", status: "completed" };
  const taskLifecycle = {
    async complete(params) {
      assert.equal(this, taskLifecycle);
      calls.push(params);
      return lifecycleResult;
    },
  };
  const { composition, boundCommands, snapshot } = await fixture(taskLifecycle);
  assert.equal(boundCommands.handleDesktopControl, composition.handleDesktopControl);
  const result = await boundCommands.handleDesktopControl({
    action: "board-task-complete",
    params: { id: "task-test", confirmCleanup: true, expectedCleanupToken: "cleanup-test" },
    context: { commandId: "complete-test" },
  });
  assert.deepEqual(calls, [{
    taskId: "task-test",
    operationId: "complete-test",
    confirmCleanup: true,
    expectedCleanupToken: "cleanup-test",
  }]);
  assert.deepEqual(result, { ...snapshot, lifecycleResult });
});

test("Task lifecycle rejection propagates through the composed completion route", async () => {
  const rejection = new Error("Task cleanup confirmation is stale");
  const { boundCommands } = await fixture({ complete: async () => { throw rejection; } });
  await assert.rejects(boundCommands.handleDesktopControl({
    action: "board-task-complete",
    params: { id: "task-test" },
    context: { commandId: "complete-test" },
  }), (error) => error === rejection);
});

test("Workspace release actions cross interaction and Desktop composition with the canonical owners", async () => {
  const calls = [];
  const plan = { revision: "exact-plan", ready: [{ taskId: "task" }] };
  const completion = { finalization: { status: "completed" } };
  const taskReleasePlanner = { async plan(workspaceId) { assert.equal(this, taskReleasePlanner); calls.push(["plan", workspaceId]); return plan; } };
  const workspaceReleaseService = { async completeRelease(params) { assert.equal(this, workspaceReleaseService); calls.push(["complete", params]); return completion; } };
  const { composition } = await fixture({}, { taskReleasePlanner, workspaceReleaseService });
  assert.equal(await composition.readWorkspaceReleasePlan({ workspaceId: "workspace" }), plan);
  const params = { workspaceId: "workspace", expectedPlanRevision: "exact-plan", deploymentVerified: true };
  assert.equal(await composition.completeWorkspaceRelease(params), completion);
  assert.deepEqual(calls, [["plan", "workspace"], ["complete", params]]);
});
