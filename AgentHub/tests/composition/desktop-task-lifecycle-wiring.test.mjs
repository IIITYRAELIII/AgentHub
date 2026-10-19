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
  t.after(async () => {
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
  const receipts = { revision: 0, snapshot: () => [], get: () => null, findAllByTurn: () => [] };
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
    runtime: { taskBoard: board, workspaceCatalogStore: catalog, taskRuns,
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
    journal, workspace, root };
}

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
  await f.snapshot();
  const beforeJournal = f.boardReads();
  await f.journal.upsertRecords([{ provider: "codex", threadId: "journal-thread", taskThreadId: "journal-thread",
    turnId: "journal-turn", projectRoot: f.root, title: "Completed", body: "private body",
    completedAt: "2026-10-15T00:00:00Z", status: "completed" }]);
  const completed = await f.snapshot();
  assert.equal(f.boardReads(), beforeJournal + 1);
  assert.equal(completed.boardTasks.find((item) => item.id === task.id).workLog[0].summary, "Completed");
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
