import assert from "node:assert/strict";
import test from "node:test";

import { TaskObserverController } from "./src/application/task-observer-controller.mjs";

function fixture({ snapshot = { active: true }, readSnapshot, canObserve } = {}) {
  const events = [];
  const timers = [];
  let current = true;
  const controller = new TaskObserverController({
    canObserve: canObserve ?? (() => current),
    readSnapshot: readSnapshot ?? (async () => snapshot),
    pollDelay: (run) => run.observer ? 10 : 20,
    onUnknown: async () => events.push("unknown"),
    onMissing: async () => events.push("missing"),
    onTurnChanged: async (run, turnId) => { run.turnId = turnId; events.push("turn"); },
    onCompleted: async () => events.push("completed"),
    onActive: async () => events.push("active"),
    onError: async () => events.push("error"),
    setTimeoutImpl: (callback, delay) => {
      timers.push({ callback, delay });
      return timers.length;
    },
    clearTimeoutImpl: () => {},
  });
  return { controller, events, setCurrent: (value) => { current = value; }, timers };
}

test("TaskObserverController follows active and completed transitions", async () => {
  const run = { observer: true, observerTimer: null, turnId: "old" };
  const active = fixture({ snapshot: { active: true, turnId: "new" } });
  await active.controller.poll(run);
  assert.deepEqual(active.events, ["turn", "active"]);
  assert.equal(run.turnId, "new");
  assert.equal(active.timers.at(-1).delay, 10);

  const completed = fixture({ snapshot: { completed: true, turnId: "new" } });
  run.observerTimer = null;
  await completed.controller.poll(run);
  assert.deepEqual(completed.events, ["completed"]);
  assert.equal(completed.timers.length, 0);
});

test("TaskObserverController retries missing snapshots and errors", async () => {
  const run = { observer: false, provider: "codex", observerTimer: null };
  const missing = fixture({ snapshot: null });
  await missing.controller.poll(run);
  assert.deepEqual(missing.events, ["missing"]);
  assert.equal(missing.timers.at(-1).delay, 20);

  const failed = fixture({ readSnapshot: async () => { throw new Error("offline"); } });
  await failed.controller.poll(run);
  assert.deepEqual(failed.events, ["error"]);
});

test("TaskObserverController discards a snapshot when the run ended during read", async () => {
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const state = fixture({ readSnapshot: () => pending });
  const run = { observer: true, observerTimer: null };
  const polling = state.controller.poll(run);
  state.setCurrent(false);
  release({ completed: true });
  await polling;
  assert.deepEqual(state.events, []);
  assert.equal(state.timers.length, 0);
});

test("TaskObserverController pauses its owned timer", () => {
  const state = fixture();
  const run = { observer: true, observerTimer: null };
  state.controller.schedule(run);
  assert.equal(state.timers.length, 1);
  state.controller.pause(run);
  assert.equal(run.observerTimer, null);
});
