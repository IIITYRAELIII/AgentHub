import assert from "node:assert/strict";
import test from "node:test";

import { RuntimeTimerCoordinator } from "../../src/runtime/runtime-timer-coordinator.mjs";

function fixture() {
  const scheduled = [];
  const cleared = [];
  let now = 1_000;
  const timers = new RuntimeTimerCoordinator({
    now: () => now,
    setTimeoutImpl: (callback, delay) => {
      const timer = { callback, delay, unrefCalled: false, unref() { this.unrefCalled = true; } };
      scheduled.push(timer);
      return timer;
    },
    clearTimeoutImpl: (timer) => cleared.push(timer),
  });
  return { timers, scheduled, cleared, setNow: (value) => { now = value; } };
}

test("RuntimeTimerCoordinator deduplicates named timers and replaces only with an earlier deadline", () => {
  const state = fixture();
  assert.equal(state.timers.schedule("delivery", () => {}, 1_000), true);
  assert.equal(state.timers.schedule("delivery", () => {}, 2_000, { replaceIfEarlier: true }), false);
  state.setNow(1_100);
  assert.equal(state.timers.schedule("delivery", () => {}, 100, { replaceIfEarlier: true }), true);
  assert.equal(state.cleared.length, 1);
  assert.equal(state.scheduled.length, 2);
});

test("RuntimeTimerCoordinator clears ownership before invoking a callback", () => {
  const state = fixture();
  let fired = 0;
  state.timers.schedule("poll", () => {
    fired += 1;
    state.timers.schedule("poll", () => {}, 50);
  }, 10);
  state.scheduled[0].callback();
  assert.equal(fired, 1);
  assert.equal(state.timers.has("poll"), true);
  assert.equal(state.scheduled.length, 2);
});

test("RuntimeTimerCoordinator owns keyed timer groups and unrefs background timers", () => {
  const state = fixture();
  assert.equal(state.timers.scheduleInGroup("cleanup", "thread-1", () => {}, 10, { unref: true }), true);
  assert.equal(state.timers.scheduleInGroup("cleanup", "thread-1", () => {}, 10), false);
  assert.equal(state.timers.scheduleInGroup("cleanup", "thread-2", () => {}, 20), true);
  assert.equal(state.scheduled[0].unrefCalled, true);
  assert.equal(state.timers.clearGroup("cleanup"), 2);
  assert.equal(state.timers.has("cleanup:thread-1"), false);
});

test("RuntimeTimerCoordinator clears every timer during shutdown", () => {
  const state = fixture();
  state.timers.schedule("one", () => {}, 1);
  state.timers.scheduleInGroup("group", "two", () => {}, 2);
  state.timers.clearAll();
  assert.equal(state.cleared.length, 2);
  assert.equal(state.timers.has("one"), false);
  assert.equal(state.timers.clearGroup("group"), 0);
});
