import assert from "node:assert/strict";
import test from "node:test";
import { Readable } from "node:stream";

import { CodexContextMaintenanceService } from "../../../src/providers/codex/codex-context-maintenance-service.mjs";
import { CodexCompactionBoundaryError, readCodexTurnItemsAfterCompaction } from "../../../src/providers/codex/codex-compaction-rollout.mjs";

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
    ["begin-manual", "thread-1", { origin: "manual", dedicatedProviderTurn: true, beforePercent: 80 }],
    ["resume", "thread-1", { sandbox: "workspace-write" }],
    ["compact", "thread-1"],
  ]);
});

test("manual compaction starts after provider terminal while delivery is finishing", async () => {
  const finishingRun = { status: "finishing", turnId: "turn-terminal" };
  const { service, calls } = harness({
    runForTask: () => finishingRun,
    runIsActive: () => true,
    ensureTransport: async () => calls.push(["transport"]),
    resumeThread: async (...args) => calls.push(["resume", ...args]),
    startCompaction: async (...args) => calls.push(["compact", ...args]),
  });

  const result = await service.startManual({ provider: "codex", threadId: "thread-1" });

  assert.equal(result.accepted, true);
  assert.equal(calls.some(([name]) => name === "compact"), true);
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

test("rollout fallback annotates only the exact completed compaction estimate", async () => {
  const reads = [];
  const { service, entries } = harness({
    knownRolloutPath: async (threadId, startedAt) => {
      reads.push(["path", threadId, startedAt]);
      return "bounded-rollout.jsonl";
    },
    readCompactionEstimate: async (path, options) => {
      reads.push(["estimate", path, options]);
      return { usedTokens: 73312, modelContextWindow: 258400 };
    },
  });
  entries.set("thread", { id: "compact-current", status: "completed", turnId: "turn-current",
    startedAt: "2026-10-01T12:30:37Z" });
  service.compactions.annotate = (threadId, id, details) => {
    const record = entries.get(threadId);
    if (record?.id !== id) return null;
    Object.assign(record, details);
    return record;
  };
  assert.equal(await service.restoreCompactionEstimate("thread", "compact-foreign"), null);
  assert.deepEqual(reads, []);
  const result = await service.restoreCompactionEstimate("thread", "compact-current");
  assert.equal(result.afterPercent, 73312 / 258400 * 100);
  assert.equal(result.measurementKind, "estimated");
  assert.equal(result.measurementStatus, "completed");
  assert.deepEqual(reads, [
    ["path", "thread", "2026-10-01T12:30:37Z"],
    ["estimate", "bounded-rollout.jsonl", {
      turnId: "turn-current", notBefore: "2026-10-01T12:30:37Z",
    }],
  ]);
  assert.equal(await service.restoreCompactionEstimate("thread", "compact-current"), result);
  assert.equal(reads.length, 2, "duplicate recovery must not reread the rollout");
});

test("turn settlement waits for stable managed and rollout inactivity", async () => {
  let now = 0;
  let run = { turnId: "settling-turn" };
  let rolloutReads = 0;
  const { service, calls } = harness({
    runForTask: () => run,
    knownRolloutPath: async () => "rollout.jsonl",
    readTurnIdle: async () => rolloutReads++ >= 2,
    now: () => now,
    sleep: async (milliseconds) => {
      calls.push(["sleep", milliseconds]);
      now += milliseconds;
      run = null;
    },
  });

  assert.equal(await service.waitForTurnIdle(
    { provider: "codex", threadId: "thread-compacted" },
    "settling-turn",
    { pollMs: 25, quietMs: 50 },
  ), true);
  assert.deepEqual(calls, [
    ["sleep", 25],
    ["sleep", 25],
    ["sleep", 25],
    ["sleep", 25],
  ]);
});

for (const stage of ["rollout-path", "rollout-activity"]) {
  test(`context idle deadline bounds a hung ${stage} and ignores late completion`, async () => {
    let finishRead;
    let reads = 0;
    const blocked = new Promise((resolve) => { finishRead = resolve; });
    const { service } = harness({
      knownRolloutPath: () => stage === "rollout-path" ? blocked : "rollout.jsonl",
      readTurnIdle: () => { reads += 1; return blocked; },
    });
    await assert.rejects(service.waitForTurnIdle(
      { provider: "codex", threadId: "thread-1" }, "turn-1", { timeoutMs: 20 },
    ), { code: "CODEX_CONTEXT_IDLE_TIMEOUT", stage });
    const readsAtTimeout = reads;
    finishRead(stage === "rollout-path" ? "rollout.jsonl" : true);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(reads, readsAtTimeout, "timed-out polling must not resume on a late read");
  });
}

test("context idle deadline is shared across observations instead of renewed per read", async () => {
  let now = 0;
  let reads = 0;
  const { service } = harness({
    knownRolloutPath: async () => { now += 6; return "rollout.jsonl"; },
    readTurnIdle: async () => { reads += 1; now += 6; return true; },
    now: () => now,
    sleep: async (milliseconds) => { now += milliseconds; },
  });
  assert.equal(await service.waitForTurnIdle(
    { provider: "codex", threadId: "thread-1" }, "turn-1",
    { timeoutMs: 20, pollMs: 1, quietMs: 1 },
  ), false);
  assert.equal(reads, 2);
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
      return { thread: { id: args[0], cwd: "D:\\repo", modelProvider: "openai", status: { type: "idle" } } };
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
    ["begin-manual", "thread-1", { origin: "manual", dedicatedProviderTurn: true, captureRawItem: true }],
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
    ["read", "thread-2", { fresh: true, includeTurns: false }],
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
    readThread: async (threadId) => ({
      thread: {
        id: threadId,
        status: { type: "idle" },
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

for (const readiness of ["read-failed", "wrong-thread", "busy", "missing-status"]) {
  test(`rotation ${readiness} refuses the target without changing the source`, async () => {
    const source = { thread: { id: "source", cwd: "D:/repo" } };
    const calls = [];
    const { service } = harness({
      startThread: async () => { calls.push(["create", "target"]); return { thread: { id: "target" } }; },
      injectItems: async (threadId, items) => calls.push(["inject", threadId, items]),
      readThread: async (threadId, options) => {
        calls.push(["read", threadId, options]);
        if (readiness === "read-failed") throw new Error("read unavailable");
        return { thread: { id: readiness === "wrong-thread" ? "other" : "target",
          ...(readiness === "missing-status" ? {} : { status: { type: readiness === "busy" ? "active" : "idle" } }),
        } };
      },
      deleteThread: async (threadId) => calls.push(["delete", threadId]),
    });
    await assert.rejects(service.rotateCompacted({ provider: "codex", threadId: "source" }, {
      compactionId: "compact-source", source, settlement: { status: "completed" },
    }), /Не удалось передать свёрнутый контекст/u);
    assert.deepEqual(calls.map(([name, threadId]) => [name, threadId]), [
      ["create", "target"], ["inject", "target"], ["read", "target"], ["delete", "target"],
    ]);
    assert.deepEqual(calls[2][2], { fresh: true, includeTurns: false });
    assert.deepEqual(source, { thread: { id: "source", cwd: "D:/repo" } });
  });
}

test("deferred rotation injects the compaction, the turn suffix after it, and the requested working directory", async () => {
  const compactionItem = { type: "compaction", encrypted_content: "summary" };
  const turnItems = [
    { type: "message", role: "user", content: [{ type: "input_text", text: "Запрос" }] },
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "Ответ" }] },
  ];
  const { service, calls, entries } = harness({
    ensureTransport: async () => calls.push(["transport"]),
    readThread: async (threadId) => ({
      thread: {
        id: threadId,
        status: { type: "idle" },
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
  // Читатель получает переносимую свёртку: граница хода — именно она.
  assert.deepEqual(calls.find(([name]) => name === "read-turn"), [
    "read-turn",
    "rollout.jsonl",
    "turn-1",
    compactionItem,
  ]);
  assert.deepEqual(calls.find(([name]) => name === "inject"), [
    "inject",
    "thread-2",
    [compactionItem, ...turnItems],
  ]);
});

function deferredRotationHarness({ readTurnResponseItems }) {
  const compactionItem = { type: "compaction", encrypted_content: "summary" };
  const { service, calls, entries } = harness({
    ensureTransport: async () => calls.push(["transport"]),
    readThread: async (threadId) => ({
      thread: { id: threadId, status: { type: "idle" }, path: "rollout.jsonl", cwd: "D:\\repo", modelProvider: "openai" },
    }),
    readTurnResponseItems,
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
  const rotate = () => service.rotateCompacted({ provider: "codex", threadId: "thread-1" }, {
    compactionId: "compact-1",
    settlement: entries.get("thread-1"),
    includeTurnId: "turn-1",
  });
  return { calls, compactionItem, rotate };
}

test("a compaction at the end of the turn is transferred alone with an empty suffix", async () => {
  const { calls, compactionItem, rotate } = deferredRotationHarness({
    readTurnResponseItems: async () => [],
  });

  const result = await rotate();

  assert.equal(result.transferredTurnId, "turn-1");
  assert.equal(result.transferredItemCount, 0);
  assert.deepEqual(calls.find(([name]) => name === "inject"), ["inject", "thread-2", [compactionItem]]);
});

test("an unproven compaction boundary aborts rotation before a new Thread is created", async () => {
  const { calls, rotate } = deferredRotationHarness({
    readTurnResponseItems: async () => {
      throw new CodexCompactionBoundaryError("Граница переносимой свёртки неоднозначна", {
        reason: "boundary-ambiguous",
        matches: 2,
      });
    },
  });

  await assert.rejects(rotate, (error) => error instanceof CodexCompactionBoundaryError);

  assert.equal(calls.some(([name]) => name === "start-thread"), false, "новый Thread создан без доказанной границы");
  assert.equal(calls.some(([name]) => name === "inject"), false);
  assert.deepEqual(calls.find(([name]) => name === "clear-raw"), ["clear-raw", "thread-1", "compact-1"]);
});

test("rotation refuses a split-tail duplicate boundary before creating a Thread", async () => {
  const record = (payload) => JSON.stringify({ type: "compacted", payload: {
    replacement_history: [payload],
  } });
  const response = JSON.stringify({ type: "response_item", payload: { type: "message",
    role: "assistant", content: [], internal_chat_message_metadata_passthrough: { turn_id: "turn-1" } } });
  const boundary = { type: "compaction", encrypted_content: "summary" };
  const tail = [record(boundary), response].join("\n");
  const full = [record(boundary), tail].join("\n");
  const { calls, rotate } = deferredRotationHarness({
    readTurnResponseItems: (path, turnId, item) => readCodexTurnItemsAfterCompaction(path, turnId, item, {
      maxBytes: 20, statImpl: async () => ({ size: Buffer.byteLength(`${full}\n`) }),
      readAnchor: async () => ({ head: "h", suffix: "s", complete: true }),
      indexCache: new Map(),
      readTail: async () => tail,
      createReadStreamImpl: () => Readable.from([`${full}\n`]),
    }),
  });
  await assert.rejects(rotate, (error) => error instanceof CodexCompactionBoundaryError
    && error.reason === "boundary-ambiguous");
  assert.equal(calls.some(([name]) => name === "start-thread" || name === "inject"), false);
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
