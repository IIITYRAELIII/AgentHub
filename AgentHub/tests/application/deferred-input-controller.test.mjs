import assert from "node:assert/strict";
import test from "node:test";

import {
  deferredLaunchWaitReason,
  DeferredInputController,
  isRetryableDeferredLaunchError,
  isUnconfirmedDeferredLaunchError,
} from "../../src/application/deferred-input-controller.mjs";

function fixture(overrides = {}) {
  const pendingInputs = new Map();
  const queuedInputs = new Map();
  const updates = [];
  const notifications = [];
  const transitions = [];
  const timers = [];
  const controller = new DeferredInputController({
    pendingInputs,
    queuedInputs,
    isBlocked: async () => false,
    steer: async () => null,
    start: async () => {},
    persist: async () => {},
    updateMessage: async (...args) => updates.push(args),
    pendingKeyboard: () => ({ inline_keyboard: [[{ text: "retry" }]] }),
    notifyReturned: async (item) => notifications.push(item.id),
    now: () => Date.parse("2026-07-30T09:00:00.000Z"),
    onStateChange: (item, state, detail) => transitions.push({
      id: item.id,
      state,
      detail: detail?.id ?? String(detail?.message ?? detail ?? ""),
    }),
    setTimeoutImpl: (callback, delay) => { timers.push({ callback, delay }); return timers.length; },
    clearTimeoutImpl: () => {},
    random: () => 0.5,
    ...overrides,
  });
  return {
    controller,
    notifications,
    pendingInputs,
    queuedInputs,
    timers,
    transitions,
    updates,
  };
}

test("retryable deferred launch errors are limited to transport failures", () => {
  assert.equal(isRetryableDeferredLaunchError(new Error("Codex app-server stopped (write EPIPE)")), true);
  assert.equal(isRetryableDeferredLaunchError(Object.assign(new Error("socket closed"), { code: "ECONNRESET" })), true);
  assert.equal(isRetryableDeferredLaunchError(Object.assign(new Error("phantom turn"), {
    code: "ERR_CODEX_TURN_NOT_MATERIALIZED",
  })), false);
  assert.equal(isRetryableDeferredLaunchError(Object.assign(new Error("unknown receipt"), {
    code: "ERR_CODEX_TURN_START_UNCONFIRMED",
  })), false);
  assert.equal(isUnconfirmedDeferredLaunchError(Object.assign(new Error("unknown receipt"), {
    code: "ERR_CODEX_TURN_START_UNCONFIRMED",
  })), true);
  assert.equal(isRetryableDeferredLaunchError(
    new Error("thread thread-1 already has an active writer"),
  ), true);
  assert.equal(isRetryableDeferredLaunchError(new Error("invalid model")), false);
  const maintenance = Object.assign(new Error("maintenance race"), {
    code: "ERR_CONTEXT_MAINTENANCE_ACTIVE",
  });
  assert.equal(isRetryableDeferredLaunchError(maintenance), true);
  assert.equal(deferredLaunchWaitReason(maintenance), "context-maintenance");
  const restart = Object.assign(new Error("restart pending"), {
    code: "ERR_RUNTIME_RESTART_PENDING",
  });
  assert.equal(isRetryableDeferredLaunchError(restart), true);
  assert.equal(deferredLaunchWaitReason(restart), "runtime-restart");
});

test("DeferredInputController starts a free queued item exactly once", async () => {
  const started = [];
  const state = fixture({ start: async (item) => started.push(item.id) });
  state.queuedInputs.set("one", { id: "one", taskTitle: "Task" });
  await state.controller.process("one");
  assert.deepEqual(started, ["one"]);
  assert.equal(state.queuedInputs.has("one"), false);
  assert.deepEqual(state.transitions.map((entry) => entry.state), ["dispatching", "started"]);
  assert.match(state.updates[0][1], /отправлено/);
});

test("DeferredInputController keeps the observed 13.429 second provider steer behind durable dispatch", async () => {
  const providerDelayMs = 13_429;
  let releaseProvider;
  const provider = new Promise((resolve) => { releaseProvider = resolve; });
  const state = fixture({
    occupancy: async () => ({
      occupied: true,
      waitReason: "provider-thread-active",
      run: { id: "run-1", turnId: "turn-1" },
    }),
    steer: async () => {
      await provider;
      return { accepted: true, steered: true, runId: "run-1", turnId: "turn-1" };
    },
  });
  state.queuedInputs.set("steer", {
    id: "steer",
    clientUserMessageId: "client-steer",
    clientSource: "local-vscode-webview",
    conflictKind: "message-steer",
    steerTargetRunId: "run-1",
    steerTargetTurnId: "turn-1",
    taskTitle: "Task",
  });

  const processing = state.controller.process("steer");
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(providerDelayMs, 13_429);
  assert.equal(state.queuedInputs.get("steer").dispatchingAt != null, true);
  assert.deepEqual(state.transitions.map((entry) => entry.state), ["dispatching"]);
  releaseProvider();
  await processing;
  assert.equal(state.queuedInputs.has("steer"), false);
  assert.deepEqual(state.transitions.map((entry) => entry.state), ["dispatching", "steered"]);
});

test("DeferredInputController retains exact steer until internal compaction settles", async () => {
  let compactionRunning = true;
  let providerEffects = 0;
  const state = fixture({
    occupancy: async () => ({
      occupied: true,
      run: { id: "run-1", turnId: "turn-1" },
    }),
    isSteerDispatchBlocked: async () => compactionRunning,
    steer: async () => {
      providerEffects += 1;
      return { accepted: true, steered: true, runId: "run-1", turnId: "turn-1" };
    },
  });
  const item = {
    id: "steer-after-compaction",
    clientUserMessageId: "client-steer-after-compaction",
    conflictKind: "message-steer",
    steerTargetRunId: "run-1",
    steerTargetTurnId: "turn-1",
    taskTitle: "Task",
  };
  state.queuedInputs.set(item.id, item);

  await state.controller.process(item.id);
  assert.equal(providerEffects, 0);
  assert.equal(state.queuedInputs.get(item.id), item);
  assert.equal(item.conflictKind, "message-steer");
  assert.equal(item.steerTargetRunId, "run-1");
  assert.equal(item.steerTargetTurnId, "turn-1");
  assert.equal(item.dispatchingAt, undefined);
  assert.equal(state.timers.at(-1).delay, 2_000);

  compactionRunning = false;
  await state.controller.process(item.id);
  assert.equal(providerEffects, 1);
  assert.equal(state.queuedInputs.has(item.id), false);
  assert.deepEqual(state.transitions.map((entry) => entry.state), ["dispatching", "steered"]);
});

test("DeferredInputController never starts a later turn when a barrier clears after the steer target exits", async () => {
  let barrierActive = true;
  let targetActive = true;
  let providerEffects = 0;
  let laterTurnStarts = 0;
  const state = fixture({
    occupancy: async () => targetActive ? ({
      occupied: true,
      run: { id: "run-old", turnId: "turn-old" },
    }) : ({ occupied: false, waitReason: null }),
    isSteerDispatchBlocked: async () => barrierActive,
    steer: async () => { providerEffects += 1; return null; },
    start: async () => { laterTurnStarts += 1; },
  });
  const item = {
    id: "steer-behind-managed-barrier",
    clientUserMessageId: "mcp:steer-behind-managed-barrier",
    conflictKind: "message-steer",
    steerTargetRunId: "run-old",
    steerTargetTurnId: "turn-old",
    streamId: "stream-1",
    provider: "codex",
    threadId: "thread-1",
    taskTitle: "Task",
  };
  state.queuedInputs.set(item.id, item);

  await state.controller.process(item.id);
  assert.equal(state.queuedInputs.get(item.id), item);
  assert.equal(providerEffects, 0);
  assert.equal(laterTurnStarts, 0);

  barrierActive = false;
  targetActive = false;
  await state.controller.process(item.id);

  assert.equal(state.queuedInputs.has(item.id), false);
  assert.equal(state.pendingInputs.get(item.id), item);
  assert.equal(item.conflictKind, "message-steer");
  assert.equal(item.steerTargetRunId, "run-old");
  assert.equal(item.steerTargetTurnId, "turn-old");
  assert.equal(item.lastErrorCode, "ERR_PROVIDER_STEER_NOT_DELIVERED");
  assert.equal(providerEffects, 0);
  assert.equal(laterTurnStarts, 0);
});

test("DeferredInputController recovers a dispatched steer without a second provider effect", async () => {
  let providerEffects = 0;
  const state = fixture({
    findSteered: async () => ({
      accepted: true,
      steered: true,
      runId: "run-1",
      turnId: "turn-recovered",
    }),
    steer: async () => {
      providerEffects += 1;
      return null;
    },
  });
  state.queuedInputs.set("steer", {
    id: "steer",
    clientUserMessageId: "client-steer",
    conflictKind: "message-steer",
    dispatchingAt: "2026-07-30T08:59:59.000Z",
    taskTitle: "Task",
  });

  await state.controller.process("steer");

  assert.equal(providerEffects, 0);
  assert.equal(state.queuedInputs.has("steer"), false);
  assert.deepEqual(state.transitions.map((entry) => entry.state), ["steered"]);
  assert.match(state.updates[0][1], /Уточнение добавлено/u);
});

test("DeferredInputController expires an abandoned queued item", async () => {
  const expired = [];
  const { controller, queuedInputs } = fixture({
    now: () => 10_000,
    maxAgeMs: 1_000,
    expire: async (item) => expired.push(item.id),
  });
  queuedInputs.set("old", { id: "old", createdAt: new Date(1_000).toISOString() });
  await controller.process("old");
  assert.deepEqual(expired, ["old"]);
  assert.equal(queuedInputs.has("old"), false);
});

test("DeferredInputController reschedules while the task is blocked", async () => {
  const state = fixture({ isBlocked: async () => true });
  state.queuedInputs.set("one", { id: "one" });
  await state.controller.process("one");
  assert.equal(state.queuedInputs.has("one"), true);
  assert.equal(state.timers[0].delay, 2_000);
});

test("DeferredInputController keeps durable automatic intake queued while blocked", async () => {
  const started = [];
  const state = fixture({
    isBlocked: async () => true,
    steer: async () => ({ accepted: true, steered: true, turnId: "turn-active" }),
    start: async (item) => started.push(item.id),
  });
  state.queuedInputs.set("one", {
    id: "one",
    taskTitle: "Task",
    conflictKind: "message-intake",
  });

  await state.controller.process("one");

  assert.deepEqual(started, []);
  assert.equal(state.queuedInputs.has("one"), true);
  assert.equal(state.pendingInputs.has("one"), false);
  assert.equal(state.queuedInputs.get("one").conflictKind, "message-intake");
  assert.deepEqual(state.transitions, []);
  assert.equal(state.timers[0].delay, 2_000);
});

test("DeferredInputController starts durable intake when the task is free", async () => {
  const started = [];
  let blockedChecks = 0;
  const state = fixture({
    isBlocked: async () => { blockedChecks += 1; return false; },
    start: async (item) => started.push(item.id),
  });
  state.queuedInputs.set("one", {
    id: "one",
    taskTitle: "Task",
    conflictKind: "message-intake",
  });

  await state.controller.process("one");

  assert.deepEqual(started, ["one"]);
  assert.equal(state.queuedInputs.has("one"), false);
  assert.equal(state.pendingInputs.has("one"), false);
  assert.equal(blockedChecks, 1);
  assert.deepEqual(state.transitions.map((entry) => entry.state), ["dispatching", "started"]);
});

test("DeferredInputController keeps an explicitly queued follow-up behind the active turn", async () => {
  let steers = 0;
  const state = fixture({
    isBlocked: async () => true,
    steer: async () => { steers += 1; return { steered: true }; },
  });
  state.queuedInputs.set("one", { id: "one", conflictKind: "task-running" });

  await state.controller.process("one");

  assert.equal(steers, 0);
  assert.equal(state.queuedInputs.has("one"), true);
});

test("DeferredInputController releases one queued message after a context probe finishes", async () => {
  let probeRunning = true;
  const started = [];
  const state = fixture({
    isBlocked: async () => probeRunning,
    start: async (item) => started.push(item.id),
  });
  state.queuedInputs.set("after-probe", {
    id: "after-probe",
    streamId: "stream-1",
    taskTitle: "Task",
    input: "Пользовательское сообщение после замера",
  });

  await state.controller.process("after-probe");
  assert.deepEqual(started, []);
  assert.equal(state.queuedInputs.has("after-probe"), true);

  probeRunning = false;
  await state.controller.process("after-probe");
  await state.controller.process("after-probe");
  assert.deepEqual(started, ["after-probe"]);
  assert.equal(state.queuedInputs.has("after-probe"), false);
});

test("DeferredInputController keeps input queued when maintenance wins the launch race", async () => {
  const state = fixture({
    isBlocked: async () => false,
    start: async () => {
      throw Object.assign(new Error("maintenance race"), {
        code: "ERR_CONTEXT_MAINTENANCE_ACTIVE",
      });
    },
  });
  const item = { id: "raced", streamId: "stream-1", taskTitle: "Task" };
  state.queuedInputs.set(item.id, item);

  await state.controller.process(item.id);

  assert.equal(state.queuedInputs.get(item.id), item);
  assert.equal(state.pendingInputs.has(item.id), false);
  assert.equal(item.waitReason, "context-maintenance");
  assert.equal(item.dispatchingAt, undefined);
  assert.equal(state.timers.at(-1).delay, 2_000);
  assert.deepEqual(state.transitions.map((entry) => entry.state), ["dispatching", "retrying"]);
});

test("DeferredInputController returns a failed launch to pending without losing input", async () => {
  const started = [];
  const state = fixture({
    start: async (item) => {
      if (item.id === "one") throw new Error("launch failed");
      started.push(item.id);
    },
  });
  const lane = { provider: "codex", projectRoot: "D:\\Work", threadId: "thread" };
  const item = {
    ...lane,
    id: "one",
    taskTitle: "Task",
    input: "important",
    allowForce: true,
    queueOrder: 1,
  };
  state.queuedInputs.set(item.id, item);
  state.queuedInputs.set("two", { ...lane, id: "two", taskTitle: "Task", queueOrder: 2 });
  await state.controller.process(item.id);
  assert.equal(state.queuedInputs.has(item.id), false);
  assert.equal(state.pendingInputs.get(item.id).input, "important");
  assert.equal(state.pendingInputs.get(item.id).laneReleased, true);
  assert.equal(item.attempts, 1);
  assert.deepEqual(state.notifications, ["one"]);
  assert.match(state.updates[0][1], /сохранено/);
  assert.equal(state.timers.at(-1).delay, 0);

  await state.controller.process("two");
  assert.deepEqual(started, ["two"]);
});

test("DeferredInputController keeps a paused head in FIFO until occupancy clears", async () => {
  const started = [];
  let occupied = true;
  const state = fixture({
    occupancy: async () => ({ occupied, waitReason: occupied ? "provider-thread-active" : null }),
    start: async (item) => started.push(item.id),
  });
  const lane = { streamId: "stream-1", provider: "codex", threadId: "thread-1" };
  state.queuedInputs.set("paused", {
    ...lane, id: "paused", taskTitle: "Task", paused: true,
    waitReason: "provider-thread-active", queueOrder: 0,
  });
  state.queuedInputs.set("next", { ...lane, id: "next", taskTitle: "Task", queueOrder: 1 });
  await state.controller.process("paused");
  await state.controller.process("next");
  assert.deepEqual(started, []);
  assert.equal(state.queuedInputs.has("paused"), true);
  occupied = false;
  await state.controller.process("paused");
  await state.controller.process("next");
  assert.deepEqual(started, ["paused", "next"]);
});

test("DeferredInputController lets runnable intake pass an intentionally paused lane item", async () => {
  const started = [];
  const state = fixture({ start: async (item) => started.push(item.id) });
  const lane = { streamId: "stream-1", provider: "codex", threadId: "thread-1" };
  state.queuedInputs.set("paused", {
    ...lane,
    id: "paused",
    paused: true,
    queueOrder: 0,
    conflictKind: "message-intake",
  });
  state.queuedInputs.set("accepted-after-hang", {
    ...lane,
    id: "accepted-after-hang",
    taskTitle: "Dashboard",
    queueOrder: 1,
    conflictKind: "message-intake",
  });

  await state.controller.process("accepted-after-hang");

  assert.deepEqual(started, ["accepted-after-hang"]);
  assert.equal(state.queuedInputs.has("paused"), true);
  assert.equal(state.queuedInputs.has("accepted-after-hang"), false);
});

test("DeferredInputController retries a transient app-server failure without losing FIFO", async () => {
  let attempts = 0;
  const state = fixture({
    start: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("Codex app-server stopped (write EPIPE)");
      return { id: "run-old" };
    },
  });
  const task = { provider: "codex", projectRoot: "D:\\Work", threadId: "thread", taskTitle: "Task" };
  state.queuedInputs.set("old", {
    ...task,
    id: "old",
    createdAt: "2026-07-30T08:00:00.000Z",
  });
  state.queuedInputs.set("new", {
    ...task,
    id: "new",
    createdAt: "2026-07-30T08:01:00.000Z",
  });

  await state.controller.process("old");
  assert.equal(state.queuedInputs.has("old"), true);
  assert.equal(state.pendingInputs.has("old"), false);
  assert.equal(state.timers.at(-1).delay, 2_000);
  await state.controller.process("new");
  assert.equal(attempts, 1);

  await state.controller.process("old");
  assert.equal(state.queuedInputs.has("old"), false);
  assert.equal(state.queuedInputs.has("new"), true);
  assert.deepEqual(
    state.transitions.map((entry) => entry.state),
    ["dispatching", "retrying", "dispatching", "started"],
  );
});

test("DeferredInputController pauses an active writer instead of retrying forever", async () => {
  const state = fixture({
    start: async () => { throw new Error("thread thread-1 already has an active writer"); },
  });
  const item = { id: "occupied", provider: "codex", threadId: "thread-1", taskTitle: "Task" };
  state.queuedInputs.set(item.id, item);

  await state.controller.process(item.id);

  assert.equal(item.waitReason, "provider-thread-active");
  assert.equal(item.lastError, undefined);
  assert.equal(item.paused, true);
  assert.equal(state.timers.at(-1).delay, 2_000);
  assert.deepEqual(state.transitions.map((entry) => entry.state), ["dispatching", "paused"]);
});

test("DeferredInputController pauses a restored active-writer item before another provider call", async () => {
  let starts = 0;
  const state = fixture({
    occupancy: async () => ({ occupied: true, waitReason: "provider-thread-active" }),
    start: async () => { starts += 1; },
  });
  const item = {
    id: "restored",
    provider: "codex",
    threadId: "thread-1",
    waitReason: "provider-thread-active",
  };
  state.queuedInputs.set(item.id, item);

  await state.controller.process(item.id);

  assert.equal(starts, 0);
  assert.equal(item.paused, true);
  assert.equal(state.timers.at(-1).delay, 2_000);
  assert.deepEqual(state.transitions.map((entry) => entry.state), ["paused"]);
});

test("DeferredInputController self-heals stale provider-thread-active state", async () => {
  const started = [];
  const state = fixture({
    occupancy: async () => ({ occupied: false, state: "inactive", waitReason: null }),
    start: async (item) => started.push(item.id),
  });
  const item = {
    id: "stale-paused",
    streamId: "stream-1",
    provider: "codex",
    threadId: "thread-1",
    paused: true,
    waitReason: "provider-thread-active",
  };
  state.queuedInputs.set(item.id, item);

  await state.controller.process(item.id);

  assert.deepEqual(started, [item.id]);
  assert.equal(state.queuedInputs.has(item.id), false);
  assert.deepEqual(state.transitions.map((entry) => entry.state), ["queued", "dispatching", "started"]);
});

test("DeferredInputController restores active-writer pause when durable save fails", async () => {
  const state = fixture({ persist: async () => { throw new Error("disk full"); } });
  const item = {
    id: "restored",
    provider: "codex",
    threadId: "thread-1",
    waitReason: "provider-thread-active",
  };
  state.queuedInputs.set(item.id, item);

  await assert.rejects(state.controller.process(item.id), /disk full/u);

  assert.deepEqual(item, {
    id: "restored",
    provider: "codex",
    threadId: "thread-1",
    waitReason: "provider-thread-active",
  });
  assert.deepEqual(state.transitions, []);
  assert.equal(state.timers.at(-1).delay, 2_000);
});

test("DeferredInputController never automatically repeats an ambiguous acknowledged turn", async () => {
  const error = Object.assign(new Error("turn was not materialized"), {
    code: "ERR_CODEX_TURN_NOT_MATERIALIZED",
  });
  const state = fixture({ start: async () => { throw error; } });
  const item = {
    id: "queued-user-message",
    provider: "codex",
    threadId: "thread-1",
    taskTitle: "Task",
    input: "This message must reach the model",
  };
  state.queuedInputs.set(item.id, item);

  await state.controller.process(item.id);

  assert.equal(state.queuedInputs.has(item.id), false);
  assert.equal(state.pendingInputs.get(item.id), item);
  assert.equal(item.attempts, 1);
  assert.equal(state.timers.length, 0);
  assert.deepEqual(state.transitions.map((entry) => entry.state), ["dispatching", "pending"]);
});

test("DeferredInputController preserves FIFO order inside one task", async () => {
  const started = [];
  const state = fixture({ start: async (item) => started.push(item.id) });
  const task = { provider: "codex", projectRoot: "D:\\Work", threadId: "thread" };
  state.queuedInputs.set("old", {
    ...task,
    id: "old",
    taskTitle: "Task",
    createdAt: "2026-07-30T08:00:00.000Z",
  });
  state.queuedInputs.set("new", {
    ...task,
    id: "new",
    taskTitle: "Task",
    createdAt: "2026-07-30T08:01:00.000Z",
  });

  await state.controller.process("new");
  assert.deepEqual(started, []);
  assert.equal(state.queuedInputs.has("new"), true);

  await state.controller.process("old");
  assert.deepEqual(started, ["old"]);
  assert.equal(state.queuedInputs.has("old"), false);

  await state.controller.process("new");
  assert.deepEqual(started, ["old", "new"]);
});

test("DeferredInputController keeps different Threads in one Stream independent", async () => {
  const started = [];
  const state = fixture({ start: async (item) => started.push(item.id) });
  state.queuedInputs.set("old", {
    id: "old", streamId: "stream-1", provider: "codex", threadId: "thread-old",
    createdAt: "2026-07-30T08:00:00.000Z",
  });
  state.queuedInputs.set("new", {
    id: "new", streamId: "stream-1", provider: "codex", threadId: "thread-new",
    createdAt: "2026-07-30T08:01:00.000Z",
  });

  await state.controller.process("new");
  assert.deepEqual(started, ["new"]);
  await state.controller.process("old");
  assert.deepEqual(started, ["new", "old"]);
});

test("DeferredInputController preserves exact-lane reorder after restart", async () => {
  const started = [];
  const lane = { streamId: "stream-1", provider: "codex", threadId: "thread-1" };
  const restored = [
    { ...lane, id: "second", queueOrder: 20, createdAt: "2026-07-30T08:00:00.000Z" },
    { ...lane, id: "first", queueOrder: 10, createdAt: "2026-07-30T08:01:00.000Z" },
  ];
  const state = fixture({ start: async (item) => started.push(item.id) });
  for (const item of restored) state.queuedInputs.set(item.id, structuredClone(item));

  await state.controller.process("second");
  assert.deepEqual(started, []);
  await state.controller.process("first");
  await state.controller.process("second");

  assert.deepEqual(started, ["first", "second"]);
});

test("DeferredInputController preempts polling backoff in every lane after terminal release", () => {
  const cleared = [];
  const state = fixture({ clearTimeoutImpl: (timer) => cleared.push(timer) });
  const releaseManager = {
    id: "releaseManager", streamId: "stream-release-manager", provider: "codex",
    threadId: "thread-release-manager", queueOrder: 1,
  };
  const themes = {
    id: "themes", streamId: "stream-themes", provider: "codex",
    threadId: "thread-themes", queueOrder: 1,
  };
  state.queuedInputs.set(releaseManager.id, releaseManager);
  state.queuedInputs.set(themes.id, themes);
  state.controller.schedule(releaseManager, 30_000);
  state.controller.schedule(themes, 30_000);

  assert.equal(state.controller.wakeAll(), 2);

  assert.deepEqual(cleared, [1, 2]);
  assert.equal(state.timers.at(-1).delay, 0);
  assert.equal(state.controller.timers.size, 2);
  assert.equal(state.controller.timers.has(releaseManager.id), true);
  assert.equal(state.controller.timers.has(themes.id), true);
});

test("DeferredInputController preserves exact steer intent when its target turn has changed", async () => {
  const started = [];
  let steers = 0;
  const state = fixture({
    occupancy: async () => ({ occupied: false, waitReason: null }),
    start: async (item) => started.push(item.id),
    steer: async () => { steers += 1; return null; },
  });
  const lane = { streamId: "stream-1", provider: "codex", threadId: "thread-1" };
  const origin = { kind: "interstream", requestId: "request-1", sourceThreadId: "thread-source" };
  state.queuedInputs.set("themes", {
    ...lane,
    id: "themes",
    queueOrder: 1,
    conflictKind: "message-steer",
    clientUserMessageId: "mcp:request-1",
    steerTargetRunId: "run-old",
    steerTargetTurnId: "turn-old",
    messageOrigin: origin,
    temporaryFiles: ["stored.png"],
  });
  state.queuedInputs.set("later", {
    ...lane,
    id: "later",
    queueOrder: 2,
    conflictKind: "message-intake",
  });

  await state.controller.process("themes");

  assert.equal(steers, 0);
  assert.equal(state.queuedInputs.has("themes"), false);
  const retained = state.pendingInputs.get("themes");
  assert.equal(retained.conflictKind, "message-steer");
  assert.equal(retained.clientUserMessageId, "mcp:request-1");
  assert.equal(retained.steerTargetRunId, "run-old");
  assert.equal(retained.steerTargetTurnId, "turn-old");
  assert.deepEqual(retained.messageOrigin, origin);
  assert.deepEqual(retained.temporaryFiles, ["stored.png"]);
  assert.equal(retained.laneReleased, true);
  assert.equal(retained.lastErrorCode, "ERR_PROVIDER_STEER_NOT_DELIVERED");
  assert.equal(state.transitions.at(-1).state, "pending");
  assert.match(state.updates.at(-1)[1], /не доставлено в исходный ход/iu);
  assert.deepEqual(state.notifications, ["themes"]);
  assert.equal(state.controller.timers.has("later"), true);

  await state.controller.process("themes");
  await state.controller.process("later");
  assert.equal(steers, 0);
  assert.deepEqual(started, ["later"]);
});

test("DeferredInputController returns one provider-rejected steer for an explicit decision", async () => {
  let steerCalls = 0;
  const state = fixture({
    occupancy: async () => ({
      occupied: true,
      waitReason: "task-running",
      run: { id: "run-1", turnId: "turn-1" },
    }),
    steer: async () => { steerCalls += 1; return null; },
  });
  const item = {
    id: "provider-rejected",
    streamId: "stream-1",
    provider: "codex",
    threadId: "thread-1",
    clientUserMessageId: "message-provider-rejected",
    conflictKind: "message-steer",
    steerTargetRunId: "run-1",
    steerTargetTurnId: "turn-1",
    messageOrigin: { kind: "interstream", requestId: "request-provider-rejected" },
  };
  state.queuedInputs.set(item.id, item);

  await state.controller.process(item.id);

  assert.equal(steerCalls, 1);
  assert.equal(state.queuedInputs.size, 0);
  assert.equal(state.pendingInputs.get(item.id), item);
  assert.equal(item.conflictKind, "message-steer");
  assert.equal(item.steerTargetRunId, "run-1");
  assert.equal(item.steerTargetTurnId, "turn-1");
  assert.deepEqual(item.messageOrigin, { kind: "interstream", requestId: "request-provider-rejected" });
  assert.equal(item.laneReleased, true);
  assert.equal(item.lastErrorCode, "ERR_PROVIDER_STEER_NOT_DELIVERED");
  assert.equal(item.dispatchingAt, undefined);
  await state.controller.process(item.id);
  assert.equal(steerCalls, 1);
});

test("DeferredInputController restores exact steer when its attention state cannot persist", async () => {
  let persistCalls = 0;
  const state = fixture({
    occupancy: async () => ({ occupied: false, waitReason: null }),
    persist: async () => {
      persistCalls += 1;
      if (persistCalls === 1) throw new Error("disk busy");
    },
  });
  const item = {
    id: "steer-persist-failure",
    streamId: "stream-1",
    provider: "codex",
    threadId: "thread-1",
    conflictKind: "message-steer",
    clientUserMessageId: "mcp:request-persist-failure",
    steerTargetRunId: "run-original",
    steerTargetTurnId: "turn-original",
  };
  const original = structuredClone(item);
  state.queuedInputs.set(item.id, item);

  await assert.rejects(state.controller.process(item.id), /disk busy/u);

  assert.equal(state.queuedInputs.get(item.id), item);
  assert.equal(state.pendingInputs.has(item.id), false);
  assert.deepEqual(item, original);

  await state.controller.process(item.id);
  assert.equal(state.queuedInputs.has(item.id), false);
  assert.equal(state.pendingInputs.get(item.id), item);
  assert.equal(item.conflictKind, "message-steer");
});

test("DeferredInputController steers the exact active turn ahead of later-turn FIFO", async () => {
  const steered = [];
  const state = fixture({
    occupancy: async () => ({
      occupied: true,
      run: { id: "run-active", turnId: "turn-active" },
    }),
    steer: async (item) => {
      steered.push(item.id);
      return { accepted: true, steered: true, runId: "run-active", turnId: "turn-active" };
    },
  });
  const lane = { streamId: "stream-1", provider: "codex", threadId: "thread-1" };
  state.queuedInputs.set("user", {
    ...lane,
    id: "user",
    queueOrder: 1,
    conflictKind: "message-intake",
  });
  state.queuedInputs.set("steer", {
    ...lane,
    id: "steer",
    queueOrder: 2,
    conflictKind: "message-steer",
    steerTargetRunId: "run-active",
    steerTargetTurnId: "turn-active",
  });

  await state.controller.process("steer");

  assert.deepEqual(steered, ["steer"]);
  assert.equal(state.queuedInputs.has("steer"), false);
  assert.equal(state.queuedInputs.has("user"), true);
});

test("DeferredInputController wakes an exact steer even behind older queued intake", () => {
  const state = fixture();
  const lane = { streamId: "stream-1", provider: "codex", threadId: "thread-1" };
  state.queuedInputs.set("user", {
    ...lane,
    id: "user",
    queueOrder: 1,
    conflictKind: "message-intake",
  });
  state.queuedInputs.set("steer", {
    ...lane,
    id: "steer",
    queueOrder: 2,
    conflictKind: "message-steer",
    steerTargetRunId: "run-active",
    steerTargetTurnId: "turn-active",
  });

  assert.equal(state.controller.wakeLane(lane), true);
  assert.deepEqual(state.timers.map(({ delay }) => delay), [0, 0]);
});

test("DeferredInputController does not pass an older pending input in the same task", async () => {
  const started = [];
  const state = fixture({ start: async (item) => started.push(item.id) });
  const task = { provider: "codex", projectRoot: "D:\\Work", threadId: "thread" };
  state.pendingInputs.set("pending", {
    ...task,
    id: "pending",
    createdAt: "2026-07-30T08:00:00.000Z",
  });
  state.queuedInputs.set("queued", {
    ...task,
    id: "queued",
    createdAt: "2026-07-30T08:01:00.000Z",
  });

  await state.controller.process("queued");
  assert.deepEqual(started, []);
  assert.equal(state.queuedInputs.has("queued"), true);
  assert.equal(state.timers.length, 0);
});

test("DeferredInputController releases a stale task-running decision before later queued input", async () => {
  let blocked = true;
  const started = [];
  const state = fixture({
    isBlocked: async () => blocked,
    start: async (item) => started.push(item.id),
  });
  const task = { provider: "codex", projectRoot: "D:\\Work", threadId: "thread", taskTitle: "Task" };
  state.pendingInputs.set("pending", {
    ...task,
    id: "pending",
    conflictKind: "task-running",
    allowForce: false,
    createdAt: "2026-07-30T08:00:00.000Z",
  });
  state.queuedInputs.set("queued", {
    ...task,
    id: "queued",
    createdAt: "2026-07-30T08:01:00.000Z",
  });

  await state.controller.process("queued");
  assert.equal(state.pendingInputs.has("pending"), true);
  assert.equal(state.timers.at(-1).delay, 2_000);

  blocked = false;
  await state.controller.process("queued");
  assert.equal(state.pendingInputs.has("pending"), false);
  assert.equal(state.queuedInputs.get("pending").conflictKind, null);
  assert.equal(state.timers.at(-1).delay, 0);
  assert.match(state.updates.at(-1)[1], /Предыдущий ход завершён/u);

  await state.controller.process("pending");
  await state.controller.process("queued");
  assert.deepEqual(started, ["pending", "queued"]);
});

test("DeferredInputController releases a durable activity-unknown lane after its external owner disappears", async () => {
  let blocked = true;
  const started = [];
  const state = fixture({
    isBlocked: async () => blocked,
    start: async (item) => started.push(item.id),
  });
  const lane = {
    streamId: "stream-1", provider: "claude", projectRoot: "D:\\Work",
    threadId: "external-thread", taskTitle: "Task",
  };
  state.pendingInputs.set("external", {
    ...lane,
    id: "external",
    conflictKind: "activity-unknown",
    allowForce: true,
    createdAt: "2026-07-30T08:00:00.000Z",
  });
  state.queuedInputs.set("next", {
    ...lane,
    id: "next",
    conflictKind: "message-intake",
    createdAt: "2026-07-30T08:01:00.000Z",
  });

  assert.equal(state.controller.wakeAll(), 1);
  assert.equal(state.timers[0].delay, 0);
  state.controller.cancelSchedule("external");
  await state.controller.process("external");
  assert.equal(state.pendingInputs.has("external"), true);

  state.controller.cancelSchedule("external");
  blocked = false;
  await state.controller.process("external");
  assert.equal(state.pendingInputs.has("external"), false);
  assert.equal(state.queuedInputs.get("external").conflictKind, null);
  assert.equal(state.queuedInputs.get("external").allowForce, false);

  state.controller.cancelSchedule("external");
  await state.controller.process("external");
  await state.controller.process("next");
  assert.deepEqual(started, ["external", "next"]);
  assert.equal(state.updates.some(([, message]) => /Предыдущий ход завершён/u.test(message)), true);
});

test("DeferredInputController claims dispatch before awaits so concurrent wake cannot duplicate or falsely cancel", async () => {
  let releaseOccupancy;
  const occupancyGate = new Promise((resolve) => { releaseOccupancy = resolve; });
  const started = [];
  const state = fixture({
    isBlocked: async () => { await occupancyGate; return false; },
    start: async (item) => started.push(item.id),
  });
  const item = {
    id: "single-flight",
    streamId: "stream-1",
    provider: "codex",
    threadId: "thread-1",
    projectRoot: "D:\\Work",
    conflictKind: "message-intake",
    createdAt: "2026-07-30T08:00:00.000Z",
    temporaryFiles: ["screen.png"],
  };
  state.queuedInputs.set(item.id, item);

  const first = state.controller.process(item.id);
  assert.equal(state.controller.isProcessing(item.id), true);
  assert.equal(!item.dispatchingAt && !state.controller.isProcessing(item.id), false,
    "the production cancel guard must not acknowledge cancellation after eligibility is claimed");
  state.controller.wakeLane(item);
  const duplicate = state.controller.process(item.id);
  releaseOccupancy({ occupied: false, waitReason: null });
  await Promise.all([first, duplicate]);

  assert.deepEqual(started, [item.id]);
  assert.deepEqual(item.temporaryFiles, ["screen.png"]);
  assert.equal(state.controller.isProcessing(item.id), false);
});

test("DeferredInputController consumes transient scheduled persist failure and durably retries pending owner", async () => {
  let persistCalls = 0;
  const started = [];
  const state = fixture({
    persist: async () => {
      persistCalls += 1;
      if (persistCalls === 1) throw new Error("transient disk busy");
    },
    start: async (item) => started.push(item.id),
  });
  const item = {
    id: "persist-retry",
    streamId: "stream-1",
    provider: "claude",
    threadId: "thread-1",
    projectRoot: "D:\\Work",
    taskTitle: "Task",
    conflictKind: "activity-unknown",
    createdAt: "2026-07-30T08:00:00.000Z",
  };
  state.pendingInputs.set(item.id, item);
  state.controller.schedule(item, 0);

  await assert.doesNotReject(() => state.timers[0].callback());
  assert.equal(state.pendingInputs.get(item.id), item);
  assert.equal(item.lastErrorCode, "ERR_DEFERRED_INPUT_PROCESSING");
  assert.equal(item.lastError, "Не удалось обработать сохранённое сообщение.");
  assert.equal(JSON.stringify({ item, transitions: state.transitions }).includes("transient disk busy"), false);
  assert.equal(persistCalls, 2, "the restored pending owner and observable error must be persisted");
  assert.equal(state.timers[1].delay, 2_000);

  await state.timers[1].callback();
  assert.equal(state.queuedInputs.get(item.id), item);
  assert.equal(item.processRecoveryChecks, undefined);
  await state.timers[2].callback();
  assert.deepEqual(started, [item.id]);
});

test("DeferredInputController removes legacy dependency text from restored durable errors", () => {
  const pendingInputs = new Map([["legacy", {
    id: "legacy",
    lastError: "C:\\secret\\claude.exe --resume private-session",
  }]]);
  fixture({ pendingInputs });
  assert.deepEqual({
    lastErrorCode: pendingInputs.get("legacy").lastErrorCode,
    lastError: pendingInputs.get("legacy").lastError,
  }, {
    lastErrorCode: "ERR_DEFERRED_INPUT_PROCESSING",
    lastError: "Не удалось обработать сохранённое сообщение.",
  });
});

test("DeferredInputController grows and caps blocked retry backoff while wake preempts it", async () => {
  const state = fixture({
    isBlocked: async () => true,
    retryDelayMs: 1_000,
    maxRetryDelayMs: 4_000,
  });
  const item = {
    id: "blocked",
    streamId: "stream-1",
    provider: "claude",
    threadId: "thread-1",
    projectRoot: "D:\\Work",
    taskTitle: "Task",
    conflictKind: "activity-unknown",
    createdAt: "2026-07-30T08:00:00.000Z",
  };
  state.pendingInputs.set(item.id, item);

  await state.controller.process(item.id);
  assert.equal(state.timers.at(-1).delay, 1_000);
  await state.timers.at(-1).callback();
  assert.equal(state.timers.at(-1).delay, 2_000);
  await state.timers.at(-1).callback();
  assert.equal(state.timers.at(-1).delay, 4_000);
  await state.timers.at(-1).callback();
  assert.equal(state.timers.at(-1).delay, 4_000);

  assert.equal(state.controller.wakeLane(item), true);
  assert.equal(state.timers.at(-1).delay, 0);
});

test("DeferredInputController adopts a run started before restart instead of duplicating it", async () => {
  const started = [];
  const state = fixture({
    findStarted: async () => ({ id: "run-existing", turnId: "turn-existing" }),
    start: async (item) => started.push(item.id),
  });
  state.queuedInputs.set("one", {
    id: "one",
    taskTitle: "Task",
    dispatchingAt: "2026-07-30T08:00:00.000Z",
  });

  await state.controller.process("one");
  assert.deepEqual(started, []);
  assert.equal(state.queuedInputs.has("one"), false);
  assert.deepEqual(state.transitions, [{
    id: "one",
    state: "started",
    detail: "run-existing",
  }]);
  assert.match(state.updates[0][1], /уже выполняется/);
});

test("DeferredInputController reconciles an uncertain provider start without launching twice", async () => {
  let exactRun = null;
  let starts = 0;
  const unknown = Object.assign(new Error("provider response lost"), {
    code: "ERR_CODEX_TURN_START_UNCONFIRMED",
    deliveryOutcome: "unknown",
  });
  const state = fixture({
    findStarted: async () => exactRun,
    start: async () => { starts += 1; throw unknown; },
  });
  state.queuedInputs.set("one", {
    id: "one",
    provider: "codex",
    threadId: "thread-1",
    clientUserMessageId: "client-1",
    taskTitle: "Task",
  });

  await state.controller.process("one");
  assert.equal(starts, 1);
  assert.equal(state.queuedInputs.get("one").waitReason, "provider-start-unconfirmed");
  assert.equal(state.pendingInputs.has("one"), false);
  assert.deepEqual(state.transitions.map((entry) => entry.state), ["dispatching", "reconciling"]);

  await state.controller.process("one");
  assert.equal(starts, 1);
  assert.equal(state.queuedInputs.has("one"), true);

  exactRun = { id: "run-existing", turnId: "turn-existing" };
  await state.controller.process("one");
  assert.equal(starts, 1);
  assert.equal(state.queuedInputs.has("one"), false);
  assert.equal(state.transitions.at(-1).state, "started");
});

test("DeferredInputController requests a decision only after exact-start reconciliation expires", async () => {
  let now = Date.parse("2026-07-30T09:00:00.000Z");
  const unknown = Object.assign(new Error("provider response lost"), {
    code: "ERR_CODEX_TURN_START_UNCONFIRMED",
  });
  const state = fixture({
    now: () => now,
    providerReconciliationMaxAgeMs: 5_000,
    start: async () => { throw unknown; },
  });
  state.queuedInputs.set("one", {
    id: "one",
    provider: "codex",
    threadId: "thread-1",
    clientUserMessageId: "client-1",
    taskTitle: "Task",
    queueOrder: 1,
  });
  state.queuedInputs.set("two", {
    id: "two",
    provider: "codex",
    threadId: "thread-1",
    clientUserMessageId: "client-2",
    taskTitle: "Task",
    queueOrder: 2,
  });

  await state.controller.process("one");
  now += 6_000;
  await state.controller.process("one");

  assert.equal(state.queuedInputs.has("one"), false);
  assert.equal(state.pendingInputs.has("one"), true);
  assert.equal(state.pendingInputs.get("one").laneReleased, undefined);
  assert.equal(state.transitions.at(-1).state, "pending");
  assert.match(state.updates.at(-1)[1], /автоматический повтор не выполнялся/u);

  await state.controller.process("two");
  assert.equal(state.queuedInputs.has("two"), true);
  assert.equal(state.transitions.filter((entry) => entry.id === "two").length, 0);
});

test("DeferredInputController does not serialize unrelated tasks", async () => {
  const started = [];
  const state = fixture({ start: async (item) => started.push(item.id) });
  state.queuedInputs.set("a", {
    id: "a",
    streamId: "stream-1",
    provider: "codex",
    projectRoot: "D:\\Work",
    threadId: "thread-a",
    taskTitle: "A",
  });
  state.queuedInputs.set("b", {
    id: "b",
    streamId: "stream-1",
    provider: "codex",
    projectRoot: "D:\\Work",
    threadId: "thread-b",
    taskTitle: "B",
  });

  await Promise.all([
    state.controller.process("b"),
    state.controller.process("a"),
  ]);

  assert.deepEqual(started.sort(), ["a", "b"]);
});
