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

for (const blockedPort of ["projectTurn", "ensureTurnUsageFact", "flushTurnProjections"]) {
  test(`durable final becomes visible before stalled ${blockedPort}, without premature ACK`, async () => {
    const completion = {
      provider: "codex", threadId: "thread-visible", turnId: "turn-visible",
      status: "completed", finalAnswer: "Я здесь\n\nЧто случилось?",
      completedAt: "2026-09-28T13:49:31.950Z",
    };
    const item = { ...completion, terminalRevision: 1, state: "pending",
      payload: { completion, history: { ...completion } } };
    let release;
    let entered;
    const atBoundary = new Promise(resolve => { entered = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    let remembered = null;
    let historyAnswer = null;
    let indexed = false;
    let acknowledged = false;
    let projectFailure = false;
    const block = async () => { entered(); await gate; };
    const service = new TurnEndDeliveryService({
      notifications: {}, taskRuns: {},
      terminalCommits: {
        claim: async () => item, get: async () => ({ terminalRevision: 1 }),
        acknowledge: async () => { acknowledged = true; return true; },
        retry: async () => { projectFailure = true; },
      },
      persistHistory: async (_history, { answer }) => { historyAnswer = answer; },
      projectTurn: async () => { if (blockedPort === "projectTurn") await block(); return {}; },
      ensureTurnUsageFact: async () => { if (blockedPort === "ensureTurnUsageFact") await block(); },
      flushTurnProjections: async () => {
        if (blockedPort === "flushTurnProjections") await block();
        indexed = true;
        return { projected: true };
      },
      readTurnProjection: async () => indexed ? exactProjection(completion) : null,
      rememberLastMessage: (identity, body, revision) => { remembered = { ...identity, body, ...revision }; },
      rememberSeenTurn() {}, saveState: async () => {},
    });
    const pending = service.deliverOutbox(item, { projectionOnly: true });
    try {
      await atBoundary;
      assert.equal(historyAnswer, completion.finalAnswer);
      assert.equal(remembered?.body, completion.finalAnswer);
      assert.equal(remembered?.turnId, completion.turnId);
      assert.equal(remembered?.terminalRevision, 1);
      assert.equal(acknowledged, false);
    } finally { release(); await pending; }
    assert.equal(acknowledged, true);
    assert.equal(projectFailure, false);
  });
}

for (const scenario of ["failed-history", "superseded"]) {
  test(`early last-message publication excludes ${scenario}`, async () => {
    const completion = { provider: "codex", threadId: "thread", turnId: "turn", finalAnswer: "old" };
    const item = { ...completion, terminalRevision: 1, state: "pending", payload: { completion, history: {} } };
    let remembered = 0;
    let acknowledged = 0;
    const service = new TurnEndDeliveryService({
      notifications: {}, taskRuns: {},
      terminalCommits: { claim: async () => item, get: async () => ({ terminalRevision: 2 }),
        acknowledge: async () => { acknowledged++; }, retry: async () => {} },
      persistHistory: async () => scenario === "failed-history" ? { failed: true, error: "disk failure" } : {},
      projectTurn: async () => { throw new Error("must not project a superseded final"); },
      rememberLastMessage: () => { remembered++; }, rememberSeenTurn() {}, saveState: async () => {},
    });
    if (scenario === "failed-history") await assert.rejects(service.deliverOutbox(item), /disk failure/u);
    else assert.equal(await service.deliverOutbox(item), false);
    assert.equal(remembered, 0);
    assert.equal(acknowledged, 0);
  });
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
      pendingProjections: async () => [{ ...item, state, channels: { ...item.channels, projection: { state } } }],
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
  terminalCommits.pendingProjections = terminalCommits.pending;
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
  terminalCommits.pendingProjections = async () => { pendingReads += 1; await gate; return []; };
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

test("bounded projection pages rotate permanent failures so a later recoverable row progresses", async () => {
  let clock = 0;
  const rows = Array.from({ length: 101 }, (_, index) => {
    const completion = {
      provider: "codex", projectRoot: "C:/workspace", threadId: "thread-page",
      turnId: `turn-${String(index).padStart(3, "0")}`, status: "completed",
      finalAnswer: `answer-${index}`, usage: {}, usageReported: false,
      startedAt: "", completedAt: "", model: "", serviceTier: "",
    };
    return {
      completion, state: "pending", attempts: 0, updated: 0, terminalRevision: 1,
      payload: { completion, history: completion },
      channels: { projection: { state: "pending" } },
    };
  });
  const timers = [];
  const cleared = [];
  const view = (row) => ({
    ...row.completion, terminalRevision: row.terminalRevision, attempts: row.attempts, state: row.state,
    payload: row.payload, channels: { projection: { state: row.state } },
  });
  const terminalCommits = {
    pendingProjections: async ({ limit }) => rows.filter((row) => row.state === "pending")
      .sort((left, right) => left.updated - right.updated || left.completion.turnId.localeCompare(right.completion.turnId))
      .slice(0, limit).map(view),
    claim: async (item) => {
      const row = rows.find((candidate) => candidate.completion.turnId === item.turnId);
      if (row?.state !== "pending") return null;
      row.state = "projecting";
      row.attempts += 1;
      return view(row);
    },
    get: async () => ({ terminalRevision: 1 }),
    acknowledge: async (item) => {
      const row = rows.find((candidate) => candidate.completion.turnId === item.turnId);
      row.state = "delivered";
      row.updated = ++clock;
      return view(row);
    },
    retry: async (item) => {
      const row = rows.find((candidate) => candidate.completion.turnId === item.turnId);
      row.state = "pending";
      row.updated = ++clock;
      return view(row);
    },
  };
  let recovered = false;
  const service = new TurnEndDeliveryService({
    notifications: { values: () => [], markDelivered() {} }, terminalCommits,
    taskRuns: { forEvent: () => null }, persistHistory: async () => {},
    projectTurn: async (completion) => {
      if (completion.turnId !== "turn-100") throw new Error("permanent invalid projection");
      recovered = true;
      return {};
    },
    readTurnProjection: async (completion) => recovered && completion.turnId === "turn-100"
      ? exactProjection(completion) : { current: false, record: null },
    rememberLastMessage: () => {}, rememberSeenTurn: () => {}, saveState: async () => {},
    logger: { error() {} }, projectionRetryMaxMs: 30_000,
    setTimer: (callback, delay) => { const timer = { callback, delay }; timers.push(timer); return timer; },
    clearTimer: (timer) => cleared.push(timer),
  });

  service.startProjectionRecovery();
  const initial = timers.shift();
  assert.equal(initial.delay, 0);
  initial.callback();
  await service.retryPendingProjections();
  assert.equal(rows[100].state, "pending");
  const periodic = timers.shift();
  assert.equal(periodic.delay, 30_000);
  assert.ok(timers.every((timer) => timer.delay > 0));

  periodic.callback();
  await service.retryPendingProjections();
  assert.equal(rows[100].state, "delivered");
  assert.equal(rows[100].attempts, 1);
  service.stopProjectionRecovery();
  assert.equal(cleared.length, 1);
});

test("projection enumeration failure rearms only the low-frequency owner", async () => {
  const timers = [];
  const cleared = [];
  let enumerations = 0;
  const service = new TurnEndDeliveryService({
    notifications: { values: () => [], markDelivered() {} },
    terminalCommits: {
      pendingProjections: async () => {
        enumerations += 1;
        if (enumerations === 1) throw Object.assign(new Error("busy"), { errcode: 5 });
        return [];
      },
    },
    taskRuns: { forEvent: () => null }, projectTurn: async () => {},
    rememberLastMessage: () => {}, rememberSeenTurn: () => {}, saveState: async () => {},
    logger: { error() {} }, projectionRetryMaxMs: 30_000,
    setTimer: (callback, delay) => { const timer = { callback, delay }; timers.push(timer); return timer; },
    clearTimer: (timer) => cleared.push(timer),
  });
  service.startProjectionRecovery();
  const initial = timers.shift();
  initial.callback();
  await assert.rejects(service.retryPendingProjections(), /busy/u);
  const periodic = timers.shift();
  assert.equal(periodic.delay, 30_000);
  periodic.callback();
  await service.retryPendingProjections();
  assert.equal(enumerations, 2);
  service.stopProjectionRecovery();
  assert.equal(cleared.length, 1);
});

test("a lock beyond the fast retry budget remains eligible for the low-frequency owner", async () => {
  const completion = {
    provider: "codex", projectRoot: "C:/workspace", threadId: "thread-budget", turnId: "turn-budget",
    status: "completed", finalAnswer: "eventual", usage: {}, usageReported: false,
    startedAt: "", completedAt: "", model: "", serviceTier: "",
  };
  const timers = [];
  let state = "pending";
  let attempts = 6;
  let projections = 0;
  let telegram = 0;
  const item = () => ({
    ...completion, terminalRevision: 1, attempts, state,
    payload: { completion, history: completion }, channels: { projection: { state } },
  });
  const service = new TurnEndDeliveryService({
    notifications: { values: () => [], markDelivered() {} },
    terminalCommits: {
      pendingProjections: async () => state === "pending" ? [item()] : [],
      claim: async () => { state = "projecting"; attempts += 1; return item(); },
      retry: async () => { state = "pending"; return item(); },
      get: async () => ({ terminalRevision: 1 }),
      acknowledge: async () => { state = "delivered"; return item(); },
    },
    taskRuns: { forEvent: () => null }, persistHistory: async () => {},
    projectTurn: async () => {
      projections += 1;
      if (projections === 1) throw Object.assign(new Error("localized"), { errcode: 5 });
      return {};
    },
    readTurnProjection: async () => projections > 1 ? exactProjection(completion) : { current: false, record: null },
    finalizeRunDelivery: async () => { telegram += 1; },
    rememberLastMessage: () => {}, rememberSeenTurn: () => {}, saveState: async () => {},
    logger: { error() {} }, projectionRetryLimit: 3, projectionRetryMaxMs: 30_000,
    setTimer: (callback, delay) => { const timer = { callback, delay }; timers.push(timer); return timer; },
    clearTimer() {},
  });
  service.startProjectionRecovery();
  timers.shift().callback();
  await service.retryPendingProjections();
  assert.equal(state, "pending");
  const periodic = timers.shift();
  assert.equal(periodic.delay, 30_000);
  periodic.callback();
  await service.retryPendingProjections();
  assert.equal(state, "delivered");
  assert.equal(telegram, 0);
  service.stopProjectionRecovery();
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
