import assert from "node:assert/strict";
import test from "node:test";

import {
  DeferredInputController,
  isRetryableDeferredLaunchError,
} from "./deferred-input-controller.mjs";

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
    start: async () => {},
    persist: async () => {},
    updateMessage: async (...args) => updates.push(args),
    pendingKeyboard: () => ({ inline_keyboard: [[{ text: "retry" }]] }),
    notifyReturned: async (item) => notifications.push(item.id),
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
  assert.equal(isRetryableDeferredLaunchError(new Error("invalid model")), false);
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
