import assert from "node:assert/strict";
import test from "node:test";

import { CodexContextMaintenanceService } from "./codex-context-maintenance-service.mjs";

function harness(overrides = {}) {
  const calls = [];
  const entries = new Map();
  const scheduled = [];
  const service = new CodexContextMaintenanceService({
    timers: {
      schedule: (name, callback, delay, options) => {
        scheduled.push({ name, callback, delay, options });
        return true;
      },
      scheduleInGroup: (group, key, callback, delay, options) => {
        scheduled.push({ group, key, callback, delay, options });
        return true;
      },
    },
    compactions: {
      get: (threadId) => entries.get(threadId) ?? null,
      complete: (threadId, details) => calls.push(["complete", threadId, details]),
      beginCleanup: (threadId, details) => calls.push(["begin", threadId, details]),
      isManualTurn: (threadId, turnId) => (
        entries.get(threadId)?.origin === "manual"
        && entries.get(threadId)?.turnId === turnId
      ),
    },
    sanitizer: {
      runForRollout: async (rolloutPath) => {
        calls.push(["sanitize-rollout", rolloutPath]);
        return { applied: true };
      },
      runOnce: async () => ({ scanned: 1, skipped: 0 }),
    },
    contextCleanupEnabled: () => true,
    periodicCleanupEnabled: () => true,
    scanIntervalMs: () => 30_000,
    logger: {
      log: (...args) => calls.push(["log", ...args]),
      warn: (...args) => calls.push(["warn", ...args]),
      error: (...args) => calls.push(["error", ...args]),
    },
    ...overrides,
  });
  return { service, calls, entries, scheduled };
}

test("compaction-triggered cleanup stays disabled until the unstable feature is re-enabled", () => {
  const { service, calls, scheduled } = harness();
  service.beginCompactionCleanup("thread-1", {
    turnId: "turn-1",
    itemId: "item-1",
    compactedAt: "2026-08-04T12:00:00.000Z",
  });
  assert.deepEqual(calls, [["complete", "thread-1", {
    turnId: "turn-1",
    itemId: "item-1",
    completedAt: "2026-08-04T12:00:00.000Z",
  }]]);
  assert.deepEqual(scheduled, []);
});

test("enabled compaction cleanup resolves a rollout and completes the exact provider thread", async () => {
  const remembered = [];
  const { service, calls, scheduled } = harness({
    compactionTriggeredCleanupEnabled: true,
    transportRunning: () => true,
    knownRolloutPath: async () => "",
    readThread: async () => ({ thread: { path: "rollout.jsonl" } }),
    rememberRolloutPath: (...args) => remembered.push(args),
    now: () => 42,
  });
  service.beginCompactionCleanup("thread-1", { turnId: "turn-1", itemId: "item-1" });
  assert.equal(scheduled.length, 1);
  await scheduled[0].callback();
  assert.deepEqual(remembered, [["thread-1", "rollout.jsonl"]]);
  assert.deepEqual(calls, [
    ["begin", "thread-1", { turnId: "turn-1", itemId: "item-1" }],
    ["sanitize-rollout", "rollout.jsonl"],
    ["complete", "thread-1", { turnId: "turn-1", itemId: "item-1" }],
  ]);
});

test("manual rollout-open cleanup recycles the transport only when other Codex work is idle", async () => {
  const restarting = [];
  const { service, calls, entries } = harness({
    activeRuns: () => [],
    refreshTaskCatalog: async () => [],
    setTransportRestarting: (value) => restarting.push(value),
    stopTransport: async () => calls.push(["stop"]),
    startTransport: async () => calls.push(["start"]),
    initializeTransport: async (options) => calls.push(["initialize", options]),
    providerIsSelected: () => true,
    invalidateTaskCatalog: () => calls.push(["invalidate"]),
    recycleTransport: async ({ stop, sanitize, start, initialize }) => {
      await stop();
      const result = await sanitize();
      await start();
      await initialize();
      return { result, error: null };
    },
  });
  entries.set("thread-1", { origin: "manual", turnId: "turn-1" });
  const result = await service.recycleForManualCompaction(
    "thread-1",
    "rollout.jsonl",
    { applied: false, reason: "rollout-open" },
  );
  assert.deepEqual(result, { applied: true });
  assert.deepEqual(restarting, [true, false]);
  assert.deepEqual(calls, [
    ["stop"],
    ["sanitize-rollout", "rollout.jsonl"],
    ["start"],
    ["initialize", { attachSelectedThread: true }],
    ["invalidate"],
  ]);
  assert.equal(service.recycleInFlight, null);
});

test("failed manual recycle reports a stable result and schedules transport recovery", async () => {
  const deferred = [];
  const { service, calls, entries } = harness({
    refreshTaskCatalog: async () => [],
    recycleTransport: async () => ({ result: null, error: new Error("failed") }),
    defer: (callback) => deferred.push(callback),
    restartTransportAfterCrash: async () => calls.push(["recover"]),
  });
  entries.set("thread-1", { origin: "manual" });
  const result = await service.recycleForManualCompaction(
    "thread-1",
    "rollout.jsonl",
    { applied: false, reason: "rollout-open" },
  );
  assert.deepEqual(result, { applied: false, reason: "transport-recycle-failed" });
  assert.equal(deferred.length, 1);
  await deferred[0]();
  assert.equal(calls.some(([name]) => name === "recover"), true);
});

test("periodic sanitation reschedules itself and reports deferred open rollouts", async () => {
  const { service, calls, scheduled } = harness({
    sanitizer: {
      runOnce: async () => ({ scanned: 4, skipped: 2 }),
      runForRollout: async () => ({ applied: true }),
    },
  });
  const result = await service.runPeriodic();
  assert.deepEqual(result, { scanned: 4, skipped: 2 });
  assert.equal(calls.some(([name, message]) => (
    name === "log" && message.includes("deferred for 2")
  )), true);
  assert.deepEqual(scheduled.map(({ name, delay }) => [name, delay]), [
    ["codex-rollout-context", 30_000],
  ]);
});

test("compaction cleanup retries unresolved rollouts inside the configured window", async () => {
  const { service, scheduled } = harness({
    compactionTriggeredCleanupEnabled: true,
    knownRolloutPath: async () => "",
    now: () => 60_000,
    cleanupRetryMs: 12_345,
  });
  await service.runCompactionCleanup("thread-1", {
    turnId: "turn-1",
    itemId: "item-1",
    startedAtMs: 0,
  });
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].group, "codex-compaction-cleanup");
  assert.equal(scheduled[0].delay, 12_345);
});
