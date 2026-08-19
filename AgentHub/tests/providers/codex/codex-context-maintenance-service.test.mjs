import assert from "node:assert/strict";
import test from "node:test";

import { CodexContextMaintenanceService } from "../../../src/providers/codex/codex-context-maintenance-service.mjs";
import { CODEX_CONTEXT_PROBE_CLIENT_ID_PREFIX } from "../../../src/domain/codex-context-probe.mjs";

const PROBE_CLIENT_ID = `${CODEX_CONTEXT_PROBE_CLIENT_ID_PREFIX}test`;

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
      isRunning: (threadId) => entries.has(threadId),
      begin: (threadId, details) => {
        const value = { id: `compact-${threadId}`, ...details };
        entries.set(threadId, value);
        calls.push(["begin-manual", threadId, details]);
        return value;
      },
      fail: (threadId, id) => calls.push(["fail", threadId, id]),
      complete: (threadId, details) => calls.push(["complete", threadId, details]),
      beginCleanup: (threadId, details) => calls.push(["begin", threadId, details]),
      waitForSettlement: async (threadId, id) => {
        calls.push(["wait", threadId, id]);
        return { id, status: "completed" };
      },
      waitForRawItem: async (threadId, id) => {
        calls.push(["wait-raw", threadId, id]);
        return { type: "compaction", encrypted_content: "opaque" };
      },
      clearRawItem: (threadId, id) => calls.push(["clear-raw", threadId, id]),
      annotate: (threadId, id, details) => calls.push(["annotate", threadId, id, details]),
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

test("manual compaction resumes a discovered thread before starting", async () => {
  const { service, calls } = harness({
    runForTask: () => null,
    runIsActive: () => false,
    ensureTransport: async () => calls.push(["transport"]),
    resumeThread: async (...args) => calls.push(["resume", ...args]),
    startCompaction: async (...args) => calls.push(["compact", ...args]),
    sandboxSettings: () => ({ sandbox: "workspace-write" }),
  });
  const result = await service.startManual(
    { provider: "codex", threadId: "thread-1" },
    { beforePercent: 80 },
  );
  assert.equal(result.accepted, true);
  assert.deepEqual(calls, [
    ["transport"],
    ["begin-manual", "thread-1", { origin: "manual", beforePercent: 80 }],
    ["resume", "thread-1", { sandbox: "workspace-write" }],
    ["compact", "thread-1"],
  ]);
});

test("compaction start accepts an RPC timeout after the provider turn was observed", async () => {
  const { service, calls, entries } = harness({
    ensureTransport: async () => calls.push(["transport"]),
    resumeThread: async (...args) => calls.push(["resume", ...args]),
    startCompaction: async (threadId) => {
      calls.push(["compact", threadId]);
      Object.assign(entries.get(threadId), {
        status: "running",
        turnId: "compaction-turn",
      });
      throw new Error("Codex App Server thread/compact/start timed out after 30000 ms");
    },
  });

  const result = await service.startManual({ provider: "codex", threadId: "thread-1" });

  assert.deepEqual(result, {
    accepted: true,
    compactionId: "compact-thread-1",
    message: "Свёртка контекста запущена",
  });
  assert.equal(calls.some(([name]) => name === "fail"), false);
  assert.equal(calls.some(([name, message]) => (
    name === "warn"
    && message.includes("after provider start compaction-turn")
  )), true);
});

test("compaction start reconciles an uncertain RPC timeout from the rollout", async () => {
  const { service, calls } = harness({
    knownRolloutPath: async (...args) => {
      calls.push(["rollout-path", ...args]);
      return "rollout.jsonl";
    },
    readRolloutActivity: async (...args) => {
      calls.push(["rollout-activity", ...args]);
      return { activeTurnIds: ["compaction-turn"] };
    },
    startCompaction: async () => {
      const error = new Error("Codex RPC thread/compact/start timed out after 30000 ms");
      error.uncertain = true;
      throw error;
    },
  });

  const result = await service.startManual({ provider: "codex", threadId: "thread-1" });

  assert.deepEqual(result, {
    accepted: true,
    compactionId: "compact-thread-1",
    message: "Свёртка контекста запущена",
  });
  assert.equal(calls.some(([name]) => name === "fail"), false);
  assert.deepEqual(calls.find(([name]) => name === "rollout-activity"), [
    "rollout-activity",
    "rollout.jsonl",
  ]);
  assert.equal(calls.some(([name, message]) => (
    name === "warn"
    && message.includes("after provider start compaction-turn")
  )), true);
});

test("compaction start still fails when the provider turn was not observed", async () => {
  const { service, calls } = harness({
    startCompaction: async () => {
      throw new Error("transport failed");
    },
  });

  await assert.rejects(
    service.startManual({ provider: "codex", threadId: "thread-1" }),
    /transport failed/u,
  );
  assert.deepEqual(calls.find(([name]) => name === "fail"), [
    "fail",
    "thread-1",
    "compact-thread-1",
  ]);
});

test("context probe returns only after its prompt materializes", async () => {
  const { service, calls } = harness({
    ensureTransport: async () => calls.push(["transport"]),
    startContextProbe: async (...args) => {
      calls.push(["probe", ...args]);
      return { turn: { id: "probe-turn" } };
    },
    readThread: async (...args) => {
      calls.push(["read", ...args]);
      return {
        thread: {
          turns: [{ id: "probe-turn", status: "inProgress", clientUserMessageId: PROBE_CLIENT_ID }],
        },
      };
    },
  });

  const result = await service.probeContext(
    { provider: "codex", threadId: "thread-compacted" },
    { compactionId: "compaction-id" },
  );

  assert.deepEqual(result, {
    threadId: "thread-compacted",
    turnId: "probe-turn",
    status: "started",
  });
  assert.deepEqual(calls[1], ["probe", "thread-compacted"]);
  assert.deepEqual(calls.find(([name]) => name === "annotate"), [
    "annotate",
    "thread-compacted",
    "compaction-id",
    { probeTurnId: "probe-turn" },
  ]);
  assert.deepEqual(calls.find(([name]) => name === "read"), [
    "read",
    "thread-compacted",
    { fresh: true, includeTurns: true },
  ]);
});

test("context probe interrupts one empty start and retries once", async () => {
  let attempt = 0;
  const { service, calls } = harness({
    ensureTransport: async () => calls.push(["transport"]),
    startContextProbe: async (...args) => {
      attempt += 1;
      calls.push(["probe", ...args, attempt]);
      return { turn: { id: `probe-${attempt}` } };
    },
    readThread: async (...args) => {
      calls.push(["read", ...args, attempt]);
      return {
        thread: {
          turns: attempt === 1
            ? [{ id: "probe-1", status: "completed" }]
            : [{ id: "probe-2", status: "inProgress", clientUserMessageId: PROBE_CLIENT_ID }],
        },
      };
    },
    interruptContextProbe: async (...args) => calls.push(["interrupt", ...args]),
    sleep: async (...args) => calls.push(["sleep", ...args]),
  });

  const result = await service.probeContext({ provider: "codex", threadId: "thread-compacted" });

  assert.equal(result.turnId, "probe-2");
  assert.equal(calls.filter(([name]) => name === "probe").length, 2);
  assert.deepEqual(calls.find(([name]) => name === "interrupt"), [
    "interrupt",
    "thread-compacted",
    "probe-1",
  ]);
  assert.deepEqual(calls.find(([name]) => name === "sleep"), ["sleep", 250]);
});

test("context probe fails after two empty starts without an unbounded loop", async () => {
  let attempt = 0;
  const { service, calls } = harness({
    startContextProbe: async () => ({ turn: { id: `probe-${++attempt}` } }),
    readThread: async () => ({
      thread: { turns: [{ id: `probe-${attempt}`, status: "completed" }] },
    }),
    interruptContextProbe: async (...args) => calls.push(["interrupt", ...args]),
    sleep: async () => {},
  });

  await assert.rejects(
    service.probeContext({ provider: "codex", threadId: "thread-compacted" }),
    /дважды принял скрытый замер без фактического запуска/u,
  );
  assert.equal(attempt, 2);
  assert.equal(calls.filter(([name]) => name === "interrupt").length, 2);
});

test("context probe cleanup waits for stable managed and rollout inactivity", async () => {
  let now = 0;
  let run = { turnId: "probe-turn" };
  let rolloutReads = 0;
  const { service, calls } = harness({
    runForTask: () => run,
    knownRolloutPath: async () => "rollout.jsonl",
    readRolloutActivity: async () => ({ running: rolloutReads++ < 2 }),
    now: () => now,
    sleep: async (milliseconds) => {
      calls.push(["sleep", milliseconds]);
      now += milliseconds;
      run = null;
    },
  });

  assert.equal(await service.waitForContextProbeIdle(
    { provider: "codex", threadId: "thread-compacted" },
    "probe-turn",
    { pollMs: 25, quietMs: 50 },
  ), true);
  assert.deepEqual(calls, [
    ["sleep", 25],
    ["sleep", 25],
    ["sleep", 25],
    ["sleep", 25],
  ]);
});

test("rotation compacts into a clean Thread and injects only the raw compaction item", async () => {
  const rawItem = { type: "compaction", encrypted_content: "opaque" };
  const { service, calls } = harness({
    runForTask: () => null,
    runIsActive: () => false,
    ensureTransport: async () => calls.push(["transport"]),
    resumeThread: async (...args) => calls.push(["resume", ...args]),
    startCompaction: async (...args) => calls.push(["compact", ...args]),
    readThread: async (...args) => {
      calls.push(["read", ...args]);
      return { thread: { id: "thread-1", cwd: "D:\\repo", modelProvider: "openai" } };
    },
    startThread: async (params) => {
      calls.push(["start-thread", params]);
      return { thread: { id: "thread-2" } };
    },
    injectItems: async (...args) => calls.push(["inject", ...args]),
    sandboxSettings: () => ({ sandbox: "danger-full-access" }),
  });
  service.compactions.waitForRawItem = async (...args) => {
    calls.push(["wait-raw", ...args]);
    return rawItem;
  };
  const result = await service.rotate({
    provider: "codex",
    threadId: "thread-1",
    model: "gpt-5.6-sol",
  });
  assert.equal(result.sourceThreadId, "thread-1");
  assert.equal(result.thread.id, "thread-2");
  assert.deepEqual(calls, [
    ["transport"],
    ["read", "thread-1", { fresh: true, includeTurns: false }],
    ["transport"],
    ["begin-manual", "thread-1", { origin: "manual", captureRawItem: true }],
    ["resume", "thread-1", { sandbox: "danger-full-access" }],
    ["compact", "thread-1"],
    ["wait", "thread-1", "compact-thread-1"],
    ["wait-raw", "thread-1", "compact-thread-1", 1_000],
    ["transport"],
    ["start-thread", {
      cwd: "D:\\repo",
      model: "gpt-5.6-sol",
      modelProvider: "openai",
      allowProviderModelFallback: true,
      ephemeral: false,
      sandbox: "danger-full-access",
    }],
    ["inject", "thread-2", [rawItem]],
    ["clear-raw", "thread-1", "compact-thread-1"],
  ]);
});

test("rotation falls back to the exact rollout compaction when the raw event is absent", async () => {
  const rawItem = { type: "compaction", encrypted_content: "rollout-summary" };
  const { service, calls } = harness({
    runForTask: () => null,
    runIsActive: () => false,
    ensureTransport: async () => calls.push(["transport"]),
    resumeThread: async (...args) => calls.push(["resume", ...args]),
    startCompaction: async (...args) => calls.push(["compact", ...args]),
    readThread: async () => ({
      thread: {
        id: "thread-1",
        path: "rollout.jsonl",
        cwd: "D:\\repo",
        modelProvider: "openai",
      },
    }),
    readCompactionItem: async (...args) => {
      calls.push(["read-compaction", ...args]);
      return rawItem;
    },
    startThread: async () => ({ thread: { id: "thread-2" } }),
    injectItems: async (...args) => calls.push(["inject", ...args]),
  });
  service.compactions.waitForRawItem = async (...args) => {
    calls.push(["wait-raw", ...args]);
    return null;
  };

  const result = await service.rotate({ provider: "codex", threadId: "thread-1" });

  assert.equal(result.thread.id, "thread-2");
  assert.deepEqual(calls.find(([name]) => name === "read-compaction"), [
    "read-compaction",
    "rollout.jsonl",
    { notBefore: undefined },
  ]);
  assert.deepEqual(calls.find(([name]) => name === "inject"), [
    "inject",
    "thread-2",
    [rawItem],
  ]);
});

test("deferred rotation injects the compaction, finished turn, and requested working directory", async () => {
  const compactionItem = { type: "compaction", encrypted_content: "summary" };
  const turnItems = [
    { type: "message", role: "user", content: [{ type: "input_text", text: "Запрос" }] },
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "Ответ" }] },
  ];
  const { service, calls, entries } = harness({
    ensureTransport: async () => calls.push(["transport"]),
    readThread: async () => ({
      thread: {
        id: "thread-1",
        path: "rollout.jsonl",
        cwd: "D:\\repo",
        modelProvider: "openai",
      },
    }),
    readTurnResponseItems: async (...args) => {
      calls.push(["read-turn", ...args]);
      return turnItems;
    },
    startThread: async (params) => {
      calls.push(["start-thread", params]);
      return { thread: { id: "thread-2" } };
    },
    injectItems: async (...args) => calls.push(["inject", ...args]),
  });
  service.compactions.waitForRawItem = async () => compactionItem;
  entries.set("thread-1", {
    id: "compact-1",
    origin: "automatic",
    status: "completed",
    startedAt: "2026-08-08T10:00:00.000Z",
  });

  const result = await service.rotateCompacted({
    provider: "codex",
    threadId: "thread-1",
    workingDirectory: "D:\\repo\\AgentHub",
  }, {
    compactionId: "compact-1",
    settlement: entries.get("thread-1"),
    includeTurnId: "turn-1",
  });

  assert.equal(result.transferredTurnId, "turn-1");
  assert.equal(result.transferredItemCount, 2);
  assert.equal(calls.find(([name]) => name === "start-thread")[1].cwd, "D:\\repo\\AgentHub");
  assert.deepEqual(calls.find(([name]) => name === "read-turn"), [
    "read-turn",
    "rollout.jsonl",
    "turn-1",
  ]);
  assert.deepEqual(calls.find(([name]) => name === "inject"), [
    "inject",
    "thread-2",
    [compactionItem, ...turnItems],
  ]);
});

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
