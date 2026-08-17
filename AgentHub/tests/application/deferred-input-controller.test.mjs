import assert from "node:assert/strict";
import test from "node:test";

import {
  deferredLaunchWaitReason,
  DeferredInputController,
  isRetryableDeferredLaunchError,
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
  assert.equal(isRetryableDeferredLaunchError(
    new Error("thread thread-1 already has an active writer"),
  ), true);
  assert.equal(isRetryableDeferredLaunchError(new Error("invalid model")), false);
  const maintenance = Object.assign(new Error("maintenance race"), {
    code: "ERR_CONTEXT_MAINTENANCE_ACTIVE",
  });
  assert.equal(isRetryableDeferredLaunchError(maintenance), true);
  assert.equal(deferredLaunchWaitReason(maintenance), "context-maintenance");
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

test("DeferredInputController returns legacy automatic intake to manual choice", async () => {
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
  assert.equal(state.queuedInputs.has("one"), false);
  assert.equal(state.pendingInputs.has("one"), true);
  assert.equal(state.pendingInputs.get("one").conflictKind, "task-running");
  assert.deepEqual(state.transitions.map((entry) => entry.state), ["pending"]);
  assert.match(state.updates[0][1], /ручного действия/u);
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
  const state = fixture({ start: async () => { throw new Error("launch failed"); } });
  const item = { id: "one", taskTitle: "Task", input: "important", allowForce: true };
  state.queuedInputs.set(item.id, item);
  await state.controller.process(item.id);
  assert.equal(state.queuedInputs.has(item.id), false);
  assert.equal(state.pendingInputs.get(item.id).input, "important");
  assert.equal(item.attempts, 1);
  assert.deepEqual(state.notifications, ["one"]);
  assert.match(state.updates[0][1], /сохранено/);
});

test("DeferredInputController skips paused messages and honors queue order", async () => {
  const started = [];
  const state = fixture({ start: async (item) => started.push(item.id) });
  state.queuedInputs.set("paused", { id: "paused", taskTitle: "Task", paused: true, queueOrder: 0 });
  state.queuedInputs.set("next", { id: "next", taskTitle: "Task", queueOrder: 1 });
  await state.controller.process("paused");
  await state.controller.process("next");
  assert.deepEqual(started, ["next"]);
  assert.equal(state.queuedInputs.has("paused"), true);
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
  assert.equal(state.timers.length, 0);
  assert.deepEqual(state.transitions.map((entry) => entry.state), ["dispatching", "paused"]);
});

test("DeferredInputController pauses a restored active-writer item before another provider call", async () => {
  let starts = 0;
  const state = fixture({ start: async () => { starts += 1; } });
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
  assert.deepEqual(state.transitions.map((entry) => entry.state), ["paused"]);
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

test("DeferredInputController preserves FIFO by Stream across Thread rotation", async () => {
  const started = [];
  const state = fixture({ start: async (item) => started.push(item.id) });
  state.queuedInputs.set("old", {
    id: "old", streamId: "stream-1", threadId: "thread-old",
    createdAt: "2026-07-30T08:00:00.000Z",
  });
  state.queuedInputs.set("new", {
    id: "new", streamId: "stream-1", threadId: "thread-new",
    createdAt: "2026-07-30T08:01:00.000Z",
  });

  await state.controller.process("new");
  assert.deepEqual(started, []);
  await state.controller.process("old");
  await state.controller.process("new");
  assert.deepEqual(started, ["old", "new"]);
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

test("DeferredInputController does not serialize unrelated tasks", async () => {
  const started = [];
  const state = fixture({ start: async (item) => started.push(item.id) });
  state.queuedInputs.set("a", {
    id: "a",
    provider: "codex",
    projectRoot: "D:\\Work",
    threadId: "thread-a",
    taskTitle: "A",
  });
  state.queuedInputs.set("b", {
    id: "b",
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
