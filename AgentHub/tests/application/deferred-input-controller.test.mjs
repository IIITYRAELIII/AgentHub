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
  const architect = {
    id: "architect", streamId: "stream-architect", provider: "codex",
    threadId: "thread-architect", queueOrder: 1,
  };
  const themes = {
    id: "themes", streamId: "stream-themes", provider: "codex",
    threadId: "thread-themes", queueOrder: 1,
  };
  state.queuedInputs.set(architect.id, architect);
  state.queuedInputs.set(themes.id, themes);
  state.controller.schedule(architect, 30_000);
  state.controller.schedule(themes, 30_000);

  assert.equal(state.controller.wakeAll(), 2);

  assert.deepEqual(cleared, [1, 2]);
  assert.equal(state.timers.at(-1).delay, 0);
  assert.equal(state.controller.timers.size, 2);
  assert.equal(state.controller.timers.has(architect.id), true);
  assert.equal(state.controller.timers.has(themes.id), true);
});

test("DeferredInputController restores ordinary FIFO when a steer misses its turn", async () => {
  const started = [];
  let steers = 0;
  const state = fixture({
    occupancy: async () => ({ occupied: false, waitReason: null }),
    start: async (item) => started.push(item.id),
    steer: async () => { steers += 1; return null; },
  });
  const lane = { streamId: "stream-1", provider: "codex", threadId: "thread-1" };
  state.pendingInputs.set("user", {
    ...lane,
    id: "user",
    queueOrder: 1,
    conflictKind: "task-running",
  });
  state.queuedInputs.set("themes", {
    ...lane,
    id: "themes",
    queueOrder: 2,
    conflictKind: "message-steer",
    steerTargetRunId: "run-old",
    steerTargetTurnId: "turn-old",
  });

  await state.controller.process("themes");
  assert.equal(steers, 0);
  assert.equal(state.queuedInputs.get("themes").conflictKind, "message-intake");
  assert.equal(state.pendingInputs.has("user"), false);

  await state.controller.process("user");
  await state.controller.process("themes");
  assert.deepEqual(started, ["user", "themes"]);
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
