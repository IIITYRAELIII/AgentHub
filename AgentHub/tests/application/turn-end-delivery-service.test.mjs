import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { CommandTraceService } from "../../src/application/command-trace-service.mjs";

import {
  TurnEndDeliveryService,
  fallbackTurnEndMessage,
  transientTurnProjectionFailure,
} from "../../src/application/turn-end-delivery-service.mjs";

function fixture({ completions = [], activeRun = null, projectResult = null } = {}) {
  const events = [];
  const delivered = new Set();
  const byKey = new Map(completions.map((value) => [value.turnId, value]));
  const notifications = {
    hasDelivered: (key) => delivered.has(key),
    markDelivered: (key) => { delivered.add(key); events.push(["delivered", key]); },
    values: () => completions,
    get: (identity) => byKey.get(identity.turnId) ?? null,
  };
  const service = new TurnEndDeliveryService({
    notifications,
    taskRuns: { forEvent: () => activeRun },
    projectTurn: async (...args) => { events.push(["project", ...args]); return projectResult; },
    rememberLastMessage: (...args) => events.push(["message", ...args]),
    rememberSeenTurn: (...args) => events.push(["seen", ...args]),
    saveState: async () => events.push(["save"]),
    logger: { error: (...args) => events.push(["error", ...args]) },
    now: () => 1_000,
    sleep: async () => {},
  });
  return { service, events, delivered };
}

function exactProjection(completion) {
  return {
    current: true,
    indexed: true,
    usageFact: true,
    record: {
      ...completion,
      body: completion.finalAnswer,
      usage: completion.usage ?? {},
      usageReported: completion.usageReported === true,
      model: completion.model ?? "",
      serviceTier: completion.serviceTier ?? "",
      startedAt: completion.startedAt ?? "",
      completedAt: completion.completedAt ?? "",
      status: completion.status,
    },
  };
}

test("fallbackTurnEndMessage uses canonical terminal wording", () => {
  assert.equal(fallbackTurnEndMessage("completed"), "Ход завершён.");
  assert.equal(fallbackTurnEndMessage("failed"), "Ход завершился с ошибкой.");
  assert.equal(fallbackTurnEndMessage("custom"), "Ход завершён со статусом custom.");
});

test("TurnEndDeliveryService projects and marks one exact completion", async () => {
  const completion = {
    streamId: "stream-1",
    provider: "codex",
    projectRoot: "C:/workspace",
    threadId: "thread-1",
    turnId: "turn-1",
    status: "completed",
    startedAt: "2026-08-04T10:08:00.000Z",
    completedAt: "2026-08-04T10:09:00.000Z",
    finalAnswer: "Final answer",
  };
  const state = fixture();
  assert.equal(await state.service.deliver(completion), true);
  assert.deepEqual(state.events.map(([name]) => name), ["project", "message", "seen", "delivered", "save"]);
  assert.equal(state.events[1][1].streamId, "stream-1");
  assert.equal(state.events[1][1].startedAt, "2026-08-04T10:08:00.000Z");
  assert.deepEqual(state.events[1][3], { updatedAt: "2026-08-04T10:09:00.000Z" });
  assert.equal(await state.service.deliver(completion), false);
});

test("TurnEndDeliveryService does not project one completion concurrently twice", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const completion = {
    provider: "codex",
    projectRoot: "C:/workspace",
    threadId: "thread-1",
    turnId: "turn-1",
    status: "completed",
  };
  const state = fixture();
  state.service.projectTurn = () => gate;
  const first = state.service.deliver(completion);
  assert.equal(await state.service.deliver(completion), false);
  release(null);
  assert.equal(await first, true);
});

test("TurnEndDeliveryService keeps aggregate-only subagent turns out of task messages", async () => {
  const completion = {
    provider: "codex",
    projectRoot: "C:/workspace",
    threadId: "subagent",
    turnId: "turn-1",
    status: "completed",
    aggregateOnly: true,
  };
  const state = fixture();
  await state.service.deliver(completion);
  assert.equal(state.events.some(([name]) => name === "message"), false);
  assert.equal(state.events.some(([name]) => name === "seen"), false);
});

test("TurnEndDeliveryService retries only completions without an active run", async () => {
  const completion = {
    provider: "codex",
    projectRoot: "C:/workspace",
    threadId: "thread-1",
    turnId: "turn-1",
    status: "completed",
  };
  const blocked = fixture({ completions: [completion], activeRun: { status: "running" } });
  await blocked.service.retryPending();
  assert.equal(blocked.events.length, 0);

  const ready = fixture({ completions: [completion] });
  await ready.service.retryPending();
  assert.equal(ready.events.some(([name]) => name === "delivered"), true);
});

test("TurnEndDeliveryService returns an already accounted completion immediately", async () => {
  const completion = { turnId: "turn-1", usageReported: true };
  const state = fixture({ completions: [completion] });
  assert.equal(await state.service.waitForCompletion({ turnId: "turn-1" }), completion);
});

test("TurnEndDeliveryService reports a failed retry transition without hiding projection failure", async () => {
  const errors = [];
  const claimed = {
    provider: "codex",
    threadId: "thread-1",
    turnId: "turn-1",
    terminalRevision: 7,
    channels: { projection: { state: "projecting" } },
    payload: {
      completion: { provider: "codex", threadId: "thread-1", turnId: "turn-1" },
      history: {},
    },
  };
  const service = new TurnEndDeliveryService({
    notifications: null,
    terminalCommits: {
      claim: async () => claimed,
      retry: async () => { throw new Error("retry write failed"); },
    },
    taskRuns: { forEvent: () => null },
    persistHistory: async () => { throw new Error("history write failed"); },
    projectTurn: async () => null,
    rememberLastMessage: () => {},
    rememberSeenTurn: () => {},
    saveState: async () => {},
    logger: { error: (...args) => errors.push(args) },
  });

  await assert.rejects(
    service.deliverOutbox({
      ...claimed,
      channels: { projection: { state: "pending" } },
    }),
    /history write failed/u,
  );
  assert.equal(errors.length, 1);
  assert.match(errors[0][0], /Cannot return terminal revision 7/u);
  assert.equal(errors[0][1].message, "retry write failed");
});

test("projection-only recovery ACKs complete readback without rewriting enriched display or delivering Telegram", async () => {
  const completion = {
    provider: "codex", projectRoot: "C:/workspace", threadId: "thread-1", turnId: "turn-1",
    status: "completed", finalAnswer: "Exact final", usage: { inputTokens: 9, outputTokens: 3 },
    usageReported: true, model: "gpt-6-astra", serviceTier: "priority",
    startedAt: "2026-09-17T09:00:00.000Z", completedAt: "2026-09-17T09:01:00.000Z",
  };
  const enriched = { ...exactProjection(completion), record: {
    ...exactProjection(completion).record,
    taskTitle: "Enriched durable title", prompt: "Enriched durable prompt",
    accountKey: "chatgpt:durable", accountAttribution: "exact",
  } };
  const calls = [];
  let commandTraces = 0;
  let state = "pending";
  const item = {
    ...completion, terminalRevision: 1, attempts: 1, state,
    channels: { projection: { state }, telegram: { state: "intent", intent: { run: completion } } },
    payload: { completion, history: completion },
  };
  const service = new TurnEndDeliveryService({
    notifications: { values: () => [], markDelivered: () => calls.push("legacy") },
    terminalCommits: {
      pending: async () => [{ ...item, state, channels: { ...item.channels, projection: { state } } }],
      claim: async () => { state = "projecting"; return { ...item, attempts: 2, state }; },
      get: async () => ({ terminalRevision: 1 }),
      acknowledge: async () => { state = "delivered"; calls.push("ack"); return true; },
      retry: async () => { state = "pending"; },
    },
    taskRuns: { forEvent: () => null },
    persistHistory: async () => calls.push("history"),
    projectTurn: async () => calls.push("project"),
    flushTurnProjections: async () => { calls.push("flush"); return { projected: true }; },
    ensureTurnUsageFact: async () => calls.push("usage"),
    readTurnProjection: async () => enriched,
    finalizeRunDelivery: async () => calls.push("telegram"),
    commandTrace: { recordBestEffort: () => { commandTraces += 1; } },
    rememberLastMessage: () => {}, rememberSeenTurn: () => {}, saveState: async () => {},
  });

  await service.retryPendingProjections();
  assert.equal(state, "delivered");
  assert.deepEqual(calls.filter((value) => ["history", "project", "flush", "usage", "telegram"].includes(value)), []);
  assert.equal(commandTraces, 0);
  assert.equal(enriched.record.taskTitle, "Enriched durable title");
  assert.equal(enriched.record.prompt, "Enriched durable prompt");
  assert.equal(enriched.record.accountKey, "chatgpt:durable");
});

test("projection retry classification uses typed SQLite and journal evidence only", () => {
  assert.equal(transientTurnProjectionFailure(Object.assign(new Error("localized"), { errcode: 5 })), true);
  assert.equal(transientTurnProjectionFailure(Object.assign(new Error("localized"), { code: "SQLITE_LOCKED_SHAREDCACHE" })), true);
  assert.equal(transientTurnProjectionFailure(Object.assign(new Error("localized"), { code: "JOURNAL_REVISION_CONFLICT" })), true);
  assert.equal(transientTurnProjectionFailure(new Error("database is locked")), false);
  assert.equal(transientTurnProjectionFailure(new Error("journal revision conflict")), false);
});

test("transient projection failure retries in the same runtime with bounded backoff and one owner", async () => {
  const completion = {
    provider: "codex", projectRoot: "C:/workspace", threadId: "thread-1", turnId: "turn-1",
    status: "completed", finalAnswer: "Recovered", usage: {}, usageReported: false,
    startedAt: "", completedAt: "", model: "", serviceTier: "",
  };
  let state = "pending";
  let attempts = 0;
  let projected = false;
  let telegram = 0;
  let pendingReads = 0;
  const timers = [];
  const cleared = [];
  const item = {
    ...completion, terminalRevision: 1,
    channels: { projection: { state: "pending" }, telegram: { state: "intent", intent: { run: completion } } },
    payload: { completion, history: completion },
  };
  const terminalCommits = {
    pending: async () => {
      pendingReads += 1;
      return state === "pending" ? [{ ...item, attempts, state, channels: { ...item.channels, projection: { state } } }] : [];
    },
    claim: async () => {
      if (state !== "pending") return null;
      state = "projecting";
      attempts += 1;
      return { ...item, attempts, state, channels: { ...item.channels, projection: { state } } };
    },
    get: async () => ({ terminalRevision: 1 }),
    acknowledge: async () => { state = "delivered"; return true; },
    retry: async () => { state = "pending"; },
  };
  const service = new TurnEndDeliveryService({
    notifications: { values: () => [], markDelivered() {} }, terminalCommits,
    taskRuns: { forEvent: () => null }, persistHistory: async () => {},
    projectTurn: async (value) => {
      assert.equal(value.resolveAccount, attempts > 1 ? false : undefined);
      if (attempts === 1) {
        const error = new Error("database is locked");
        error.code = "SQLITE_BUSY";
        throw error;
      }
      projected = true;
      return {};
    },
    readTurnProjection: async () => projected ? exactProjection(completion) : { current: false, record: null },
    finalizeRunDelivery: async () => { telegram += 1; },
    rememberLastMessage: () => {}, rememberSeenTurn: () => {}, saveState: async () => {},
    logger: { error() {} },
    setTimer: (callback, delay) => { const timer = { callback, delay }; timers.push(timer); return timer; },
    clearTimer: (timer) => cleared.push(timer),
    projectionRetryBaseMs: 25, projectionRetryMaxMs: 100, projectionRetryLimit: 3,
  });

  service.startProjectionRecovery();
  const initial = timers.shift();
  assert.equal(initial.delay, 0);
  initial.callback();
  await setImmediate();
  const retry = timers.shift();
  assert.equal(retry.delay, 25);
  retry.callback();
  await setImmediate();
  assert.equal(state, "delivered");
  assert.equal(attempts, 2);
  assert.equal(telegram, 0);

  state = "pending";
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  terminalCommits.pending = async () => { pendingReads += 1; await gate; return []; };
  const first = service.retryPendingProjections();
  const second = service.retryPendingProjections();
  release();
  await Promise.all([first, second]);
  assert.equal(pendingReads, 3, "concurrent drains share one pending read");
  service.startProjectionRecovery();
  const disposalTimer = timers.shift();
  service.stopProjectionRecovery();
  assert.deepEqual(cleared, [disposalTimer]);
});


for (const [blockedPort, blockedStage] of [
  ["persistHistory", "terminal-history-persist"], ["projectTurn", "terminal-journal-project"],
  ["saveState", "terminal-state-save"], ["acknowledge", "terminal-outbox-ack"],
]) {
  test(`outbox trace exposes pending ${blockedPort} under exact terminal identity`, async () => {
    const records = [];
    let release;
    let entered;
    const atBoundary = new Promise((resolve) => { entered = resolve; });
    const port = () => { entered(); return new Promise((resolve) => { release = resolve; }); };
    const item = {
      id: "outbox-1", provider: "codex", threadId: "thread-1", turnId: "turn-1",
      terminalRevision: 7, state: "pending", payload: {
        completion: { provider: "codex", threadId: "thread-1", turnId: "turn-1",
          status: "completed", clientUserMessageId: "command-1" },
      },
    };
    const service = new TurnEndDeliveryService({
      notifications: {}, taskRuns: {},
      terminalCommits: {
        claim: async () => item, acknowledge: blockedPort === "acknowledge" ? port : async () => true,
      },
      persistHistory: blockedPort === "persistHistory" ? port : async () => ({}),
      projectTurn: blockedPort === "projectTurn" ? port : async () => ({}),
      saveState: blockedPort === "saveState" ? port : async () => {},
      rememberLastMessage() {}, rememberSeenTurn() {},
      commandTrace: new CommandTraceService({ store: {
        appendBestEffort: (span) => { records.push(span); return true; },
      } }),
    });
    const pending = service.deliverOutbox(item);
    await atBoundary;
    const started = records.filter((record) => record.stage === blockedStage);
    assert.deepEqual(started.map((record) => record.outcome), ["started"]);
    assert.equal(started[0].commandId, "command-1");
    assert.equal(started[0].metadata.turnId, "turn-1");
    assert.equal(started[0].metadata.terminalRevision, 7);
    release(true);
    await pending;
    assert.deepEqual(records.filter((record) => record.stage === blockedStage).map((record) => record.outcome), ["started", "succeeded"]);
  });
}
