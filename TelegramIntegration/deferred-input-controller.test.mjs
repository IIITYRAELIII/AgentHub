import assert from "node:assert/strict";
import test from "node:test";

import { DeferredInputController } from "./deferred-input-controller.mjs";

function fixture(overrides = {}) {
  const pendingInputs = new Map();
  const queuedInputs = new Map();
  const updates = [];
  const notifications = [];
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
    setTimeoutImpl: (callback, delay) => { timers.push({ callback, delay }); return timers.length; },
    clearTimeoutImpl: () => {},
    ...overrides,
  });
  return { controller, notifications, pendingInputs, queuedInputs, timers, updates };
}

test("DeferredInputController starts a free queued item exactly once", async () => {
  const started = [];
  const state = fixture({ start: async (item) => started.push(item.id) });
  state.queuedInputs.set("one", { id: "one", taskTitle: "Task" });
  await state.controller.process("one");
  assert.deepEqual(started, ["one"]);
  assert.equal(state.queuedInputs.has("one"), false);
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
