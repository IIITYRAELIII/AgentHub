import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { MaintenanceOperationStore } from "../../../src/infrastructure/persistence/maintenance-operation-store.mjs";
import { ContextCompactionTracker, isContextCompactionItem } from "../../../src/providers/codex/context-compaction-tracker.mjs";
import { CodexContextMaintenanceService } from "../../../src/providers/codex/codex-context-maintenance-service.mjs";
import { CodexEventService } from "../../../src/providers/codex/codex-event-service.mjs";

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hub-compaction-contention-"));
  const operationStore = new MaintenanceOperationStore({ dataDir: directory });
  operationStore.get("initialize-schema");
  const writer = new DatabaseSync(path.join(directory, "runtime.sqlite"));
  let locked = false;
  const timers = new Set();
  let nextId = 0;
  const tracker = new ContextCompactionTracker({
    operationStore, streamIdForThread: (threadId) => `stream-${threadId}`,
    idFactory: () => `operation-${++nextId}`,
    setTimer(callback) {
      const timer = { callback, unref() {} };
      timers.add(timer);
      return timer;
    },
    clearTimer: (timer) => timers.delete(timer),
  });
  const lock = () => { writer.exec("BEGIN IMMEDIATE"); locked = true; };
  const unlock = () => { if (locked) writer.exec("ROLLBACK"); locked = false; };
  t.after(async () => {
    tracker.dispose();
    unlock();
    writer.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { tracker, operationStore, timers, lock, unlock };
}

function events(tracker) {
  const noop = () => {};
  return new CodexEventService({
    mutateCompaction: (_threadId, operation) => operation(),
    invalidateThreadRead: noop, forEvent: () => null, reindexRun: noop,
    applyThreadSettings: noop, saveState: noop, trackTokenUsage: noop,
    taskKey: () => "task", isSelectedRun: () => false, setSelectedDiff: noop,
    appendActivity: noop, noteActivity: noop, scheduleProgress: noop, appendReasoning: noop,
    upsertReasoningBlock: noop, replaceActivityGroups: noop, turnActivityGroups: () => [],
    isCompactionItem: isContextCompactionItem, contextUsage: () => null,
    getCompaction: (threadId) => tracker.get(threadId),
    beginCompaction: (threadId, details) => tracker.mutate(threadId, () => tracker.begin(threadId, details)),
    beginCompactionCleanup: (threadId, details) => tracker.mutate(threadId, () => tracker.complete(threadId, {
      ...details, completedAt: details.compactedAt,
    })),
    settleCompactionTurn: (threadId, details) => tracker.mutate(threadId, () => tracker.settleProviderTurn(threadId, details)),
    rememberRawCompactionItem: noop, setStage: noop, describeItem: () => "stage",
    itemActivity: () => null, requestApproval: noop, formatCommandApproval: noop,
    formatFileApproval: noop, formatPermissionsApproval: noop, requestMcpElicitation: noop,
    observeMcpProgress: noop, observeHubMcpBridge: noop, requestUserInput: noop,
    reduceLiveItemEvent: () => null, startLiveItem: noop, completeLiveItem: noop,
    discardContextCompaction: () => false, consumeTracker: noop, finishObserved: noop,
    turnSnapshot: () => ({}), completeManaged: noop,
    turnTokenUsage: new Map(), speechButtons: new Map(), temporaryFiles: new Map(),
  });
}

for (const transition of ["fail", "complete"]) {
  test(`a contended ${transition} retains the watchdog and original operation`, async (t) => {
    const { tracker, operationStore, timers, lock, unlock } = await fixture(t);
    const initial = tracker.begin("thread-1", { turnId: "turn-1", itemId: "item-1" });
    const watchdog = [...timers][0];
    lock();
    assert.throws(() => transition === "fail"
      ? tracker.fail("thread-1", initial.id)
      : tracker.complete("thread-1", { turnId: "turn-1", itemId: "item-1" }), /database is locked|SQLITE_BUSY/u);
    assert.equal(tracker.get("thread-1").status, "running");
    assert.equal(operationStore.get(initial.id).revision, 1);
    assert.equal(timers.has(watchdog), true, "failed persistence must leave the operation watchdog armed");
    unlock();
    watchdog.callback();
    assert.equal(tracker.get("thread-1").status, "unknown");
    assert.equal(operationStore.get(initial.id).status, "reconciling");
  });
}

test("contention retries preserve identity without serializing unrelated thread work", async (t) => {
  const { tracker, operationStore, lock, unlock } = await fixture(t);
  const initial = tracker.begin("thread-a", { turnId: "turn-a", itemId: "item-a" });
  const other = tracker.begin("thread-b", { turnId: "turn-b", itemId: "item-b" });
  let firstAttempt;
  const attempted = new Promise((resolve) => { firstAttempt = resolve; });
  const identities = [];
  lock();
  const completion = tracker.mutate("thread-a", () => {
    identities.push(tracker.get("thread-a").id);
    firstAttempt();
    return tracker.complete("thread-a", { turnId: "turn-a", itemId: "item-a" });
  });
  await attempted;
  try {
    const independent = await tracker.mutate("thread-b", () => operationStore.get(other.id));
    assert.equal(independent.operationId, other.id);
    assert.equal(tracker.get("thread-a").status, "running");
  } finally {
    unlock();
  }
  const completed = await completion;
  assert.equal(completed.id, initial.id);
  assert.equal(completed.status, "completed");
  assert.ok(identities.length >= 2);
  assert.deepEqual([...new Set(identities)], [initial.id]);
  assert.equal(operationStore.get(initial.id).revision, 2);
});

test("successful empty terminal remains unknown until exact late item completion", async (t) => {
  const { tracker, operationStore } = await fixture(t);
  const initial = tracker.begin("thread-1", { turnId: "turn-1", itemId: "item-1" });
  const service = events(tracker);
  await service.handle({ method: "turn/completed", params: {
    threadId: "thread-1", turn: { id: "turn-1", status: "completed", items: [] },
  } });
  assert.equal(tracker.get("thread-1").status, "unknown");
  assert.equal(operationStore.get(initial.id).status, "reconciling");
  await service.handle({ method: "item/completed", params: {
    threadId: "thread-1", turnId: "unrelated-turn", item: { type: "contextCompaction", id: "unrelated-item" },
  } });
  assert.equal(tracker.get("thread-1").status, "unknown");
  await service.handle({ method: "item/completed", params: {
    threadId: "thread-1", turnId: "turn-1", item: { type: "contextCompaction", id: "item-1" },
  } });
  assert.equal(tracker.get("thread-1").status, "completed");
  assert.equal(operationStore.get(initial.id).status, "succeeded");
  assert.equal(operationStore.get(initial.id).revision, 3);
});

test("terminal snapshot recovers a missing compaction completion under its original identity", async (t) => {
  const { tracker, operationStore } = await fixture(t);
  const initial = tracker.begin("thread-1", { turnId: "turn-1", itemId: "item-1" });
  await events(tracker).handle({ method: "turn/completed", params: {
    threadId: "thread-1", turn: { id: "turn-1", status: "completed", items: [
      { type: "contextCompaction", id: "item-1" },
    ] },
  } });
  assert.equal(operationStore.get(initial.id).status, "succeeded");
  assert.equal(tracker.get("thread-1").id, initial.id);
});

test("late item start cannot replace an unknown dedicated operation or revive its running state", async (t) => {
  const { tracker, operationStore } = await fixture(t);
  const initial = tracker.begin("thread-1", { dedicatedProviderTurn: true });
  tracker.begin("thread-1", { turnId: "turn-1", itemId: "item-1" });
  tracker.settleProviderTurn("thread-1", { turnId: "turn-1", status: "completed" });
  const service = events(tracker);
  await service.handle({ method: "item/started", params: {
    threadId: "thread-1", turnId: "turn-1", item: { type: "contextCompaction", id: "item-1" },
  } });
  assert.equal(tracker.get("thread-1").id, initial.id);
  assert.equal(tracker.get("thread-1").status, "unknown");
  assert.equal(operationStore.get("item-1"), null, "replayed start must not allocate another operation");
  await service.handle({ method: "item/completed", params: {
    threadId: "thread-1", turnId: "turn-1", item: { type: "contextCompaction", id: "item-1" },
  } });
  assert.equal(operationStore.get(initial.id).status, "succeeded");
});

test("provider writer rejection survives transient SQLite contention and releases maintenance", async (t) => {
  const { tracker, operationStore, lock, unlock } = await fixture(t);
  const rejection = new Error("thread-store conflict: thread-1 already has an active writer");
  let releaseTimer;
  let compactCalls = 0;
  const service = new CodexContextMaintenanceService({
    compactions: tracker,
    resumeThread: async () => {
      lock();
      releaseTimer = setTimeout(unlock, 30);
      throw rejection;
    },
    startCompaction: async () => { compactCalls += 1; },
  });
  try {
    await assert.rejects(service.start({ provider: "codex", threadId: "thread-1" }), (error) => error === rejection);
    assert.equal(compactCalls, 0);
    assert.equal(tracker.isRunning("thread-1"), false);
    const record = tracker.get("thread-1");
    assert.equal(record.status, "failed");
    assert.equal(record.turnId, null);
    assert.equal(operationStore.get(record.id).status, "failed");
    assert.equal(operationStore.get(record.id).revision, 2);
  } finally {
    clearTimeout(releaseTimer);
    unlock();
  }
});
