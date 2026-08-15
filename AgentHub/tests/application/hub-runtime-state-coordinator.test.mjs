import assert from "node:assert/strict";
import test from "node:test";

import {
  createHubRuntimeSnapshot,
  HubRuntimeStateCoordinator,
  restoreHubRuntimeSnapshot,
} from "../../src/application/hub-runtime-state-coordinator.mjs";
import { TaskSelectionStore } from "../../src/application/task-selection-store.mjs";

function restorationFixture() {
  const selectionStore = new TaskSelectionStore({
    activeProvider: "claude",
    activeProjectRoot: "D:/Default",
  });
  const restored = {};
  const context = {
    selectionStore,
    findProject: (root) => root === "D:/Work" ? { path: root } : null,
    taskMetadata: { restore: (value) => { restored.metadata = value; } },
    preferences: { restore: (value) => { restored.preferences = value; } },
    statusMediaFileIds: new Map(),
    runJournal: { restoreLastMessages: (value) => { restored.messages = value; } },
    lastSeenTaskTurnIds: new Map(),
    codexUsageTracker: { restore: (value) => { restored.usage = value; } },
    contextCompactions: { restore: (value) => { restored.compactions = value; } },
    codexTurnStarts: new Map(),
    codexTerminalAudit: { restore: (value) => { restored.audit = value; } },
    turnEndNotifications: { restore: () => ({ droppedLegacyPending: 0, droppedStalePending: 0 }) },
    dismissedExternalTasks: { restore: (value) => { restored.dismissed = value; } },
    cancelledManagedClaudeTasks: new Map(),
    pendingInputs: new Map(),
    queuedInputs: new Map(),
    restoreDeferredInput: (item) => ({ destination: item.destination, item }),
    deferredInputOptions: {},
    isRetryableDeferredLaunchError: () => false,
    desktopMessageReceipts: { restore: (value) => { restored.receipts = value; } },
    updateDeferredDesktopReceipt: () => {},
    forwardBundles: new Map(),
    restoreForwardBundle: (value) => value,
    forwardBundleAttachmentPaths: () => [],
    removeFiles: async () => {},
    deferredInputTtlMs: 60_000,
    maximumDeferredInputs: 10,
    taskRuns: { values: [], add(value) { this.values.push(value); } },
    restoreTaskRun: (value) => value.status === "running" ? value : null,
  };
  return { context, restored };
}

test("runtime state restoration applies one canonical snapshot to all owners", async () => {
  const { context, restored } = restorationFixture();
  const result = await restoreHubRuntimeSnapshot({
    activeProvider: "codex",
    activeProjectRoot: "D:/Work",
    threadIds: { codex: "thread-1", claude: "session-1" },
    activeThreadTitle: "Task",
    chatId: 42,
    updateOffset: 17,
    restartRequest: {
      chatId: 42,
      messageId: 9,
      requestedAt: "2026-08-10T00:00:00.000Z",
      waitingForRuns: false,
      notifyTelegram: true,
      minimumUpdateOffset: 18,
    },
    codexModel: "sol",
    pendingInputs: [{ id: "pending-1", destination: "pending", createdAt: new Date().toISOString() }],
    queuedInputs: [{ id: "queued-1", destination: "queued", createdAt: new Date().toISOString() }],
    activeRuns: [{ id: "run-1", status: "running" }],
    codexHookReceipts: { start: { id: 1 } },
    turnEndNotifications: {},
    contextCompactions: [["thread-1", { id: "compaction-1", status: "completed" }]],
  }, context);
  assert.equal(context.selectionStore.activeProvider, "codex");
  assert.equal(context.selectionStore.threadId, "thread-1");
  assert.equal(context.pendingInputs.has("pending-1"), true);
  assert.equal(context.queuedInputs.has("queued-1"), true);
  assert.equal(context.taskRuns.values.length, 1);
  assert.deepEqual(restored.compactions, [[
    "thread-1",
    { id: "compaction-1", status: "completed" },
  ]]);
  assert.deepEqual(result, {
    chatId: 42,
    updateOffset: 17,
    restartRequest: {
      chatId: 42,
      messageId: 9,
      requestedAt: "2026-08-10T00:00:00.000Z",
      waitingForRuns: false,
      notifyTelegram: true,
      minimumUpdateOffset: 18,
    },
    clientTaskSelections: [],
    codexHookReceipts: { start: { id: 1 }, stop: null },
    restoredTurnEndSnapshot: {},
  });
});

test("runtime state restoration removes rapid duplicate queued chat retries", async () => {
  const { context } = restorationFixture();
  const transitions = [];
  context.updateDeferredDesktopReceipt = (item, state) => transitions.push([item.id, state]);
  const createdAt = new Date().toISOString();
  const common = {
    destination: "queued",
    streamId: "stream-1",
    provider: "codex",
    threadId: "thread-1",
    input: "это был не субагент",
    temporaryFiles: [],
    conflictKind: "message-intake",
    createdAt,
  };

  await restoreHubRuntimeSnapshot({
    queuedInputs: [
      { ...common, id: "first", clientUserMessageId: "client-1" },
      { ...common, id: "duplicate", clientUserMessageId: "client-2" },
    ],
    desktopMessageReceipts: [],
  }, context);

  assert.deepEqual([...context.queuedInputs.keys()], ["first"]);
  assert.deepEqual(transitions, [["duplicate", "cancelled"], ["first", "queued"]]);
});

test("state coordinator coalesces queued snapshots and isolates a missing initial state", async () => {
  const saved = [];
  let releaseFirst;
  const firstBlocked = new Promise((resolve) => { releaseFirst = resolve; });
  let revision = 0;
  const coordinator = new HubRuntimeStateCoordinator({
    store: {
      load: async () => ({ value: null }),
      save: async (value) => {
        saved.push(value);
        if (saved.length === 1) await firstBlocked;
      },
    },
    canonicalize: (value) => value,
    restoreSnapshot: async (value) => value,
    createSnapshot: () => ({ revision: ++revision }),
    log: { log() {}, warn() {}, error() {} },
  });
  assert.deepEqual(await coordinator.restore(), { failed: false, value: null });
  const first = coordinator.save();
  await new Promise((resolve) => setImmediate(resolve));
  const second = coordinator.save();
  const third = coordinator.save();
  releaseFirst();
  await Promise.all([first, second, third]);
  await coordinator.flush();
  assert.deepEqual(saved, [{ revision: 1 }, { revision: 3 }]);
});

test("runtime snapshot keeps task identity and provider preferences separate", () => {
  const selectionStore = new TaskSelectionStore({
    activeProvider: "codex",
    activeProjectRoot: "D:/Work",
    threadId: "thread-1",
    activeThreadTitle: "Task",
  });
  const snapshot = createHubRuntimeSnapshot({
    chatId: 42,
    getClientTaskSelections: () => [["telegram:42", { provider: "codex", threadId: "thread-telegram" }]],
    selectionStore,
    taskMetadata: { snapshot: () => ({ pinnedTaskTitles: {} }) },
    preferences: { snapshot: () => ({ codexModel: "sol" }) },
    updateOffset: 3,
    taskRuns: { values: () => [] },
    serializableTaskRun: (value) => value,
    dismissedExternalTasks: { values: () => [] },
    cancelledManagedClaudeTasks: new Map(),
    pendingInputs: new Map(),
    queuedInputs: new Map(),
    desktopMessageReceipts: { snapshot: () => [] },
    forwardBundles: new Map(),
    runJournal: { lastMessageSnapshot: () => [] },
    lastSeenTaskTurnIds: new Map(),
    contextCompactions: { snapshot: () => [["thread-1", { id: "compaction-1" }]] },
    codexUsageTracker: { snapshot: () => ({ turnTokenUsage: [] }) },
    codexTurnStarts: new Map(),
    codexHookReceipts: {},
    codexTerminalAudit: { snapshot: () => ({}) },
    turnEndNotifications: { snapshot: () => ({}) },
    statusMediaFileIds: new Map(),
    restartRequest: null,
  });
  assert.equal(snapshot.activeProvider, "codex");
  assert.equal(snapshot.threadIds.codex, "thread-1");
  assert.equal(snapshot.codexModel, "sol");
  assert.deepEqual(snapshot.contextCompactions, [["thread-1", { id: "compaction-1" }]]);
  assert.deepEqual(snapshot.clientTaskSelections, [[
    "telegram:42",
    { provider: "codex", threadId: "thread-telegram" },
  ]]);
});
