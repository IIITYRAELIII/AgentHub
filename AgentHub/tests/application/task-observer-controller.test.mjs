import assert from "node:assert/strict";
import test from "node:test";

import { TaskObserverController } from "../../src/application/task-observer-controller.mjs";

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

test("unknown Codex snapshot cannot terminate observation; the later exact terminal completes once", async () => {
  let snapshot = { activityUnknown: true, active: false, completed: false, turnId: "turn-1" };
  const state = fixture({ readSnapshot: async () => snapshot });
  const run = { observer: true, observerTimer: null, turnId: "turn-1" };
  await state.controller.poll(run);
  assert.deepEqual(state.events, ["unknown"]);
  assert.equal(state.timers.length, 1);
  run.observerTimer = null;
  snapshot = { completed: true, active: false, turnId: "turn-1", terminalStatus: "completed" };
  await state.controller.poll(run);
  assert.deepEqual(state.events, ["unknown", "completed"]);
  assert.equal(state.timers.length, 1);
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

test("observer preserves uncertain ownership and clears its display only from exact active evidence", async () => {
  const run = { turnId: "exact", observer: false, activityUnknown: true };
  const pending = fixture({ snapshot: { turnId: "exact", activityUnknown: true } });
  await pending.controller.poll(run);
  assert.equal(run.activityUnknown, true);
  const active = fixture({ snapshot: { turnId: "exact", active: true } });
  await active.controller.poll(run);
  assert.equal(run.activityUnknown, false);
  const missing = fixture({ snapshot: null });
  await missing.controller.poll(run);
  assert.equal(run.activityUnknown, true);
});

test("unconfirmed Codex snapshots cannot clear current uncertainty", async () => {
  for (const snapshot of [
    { turnId: "original", active: true, activityUnknown: true, completed: false },
    { turnId: "original", active: false, completed: false },
  ]) {
    const run = { provider: "codex", observer: false, turnId: "original", activityUnknown: true };
    const f = fixture({ snapshot });
    await f.controller.poll(run);
    assert.deepEqual(f.events, ["unknown"]);
    assert.equal(run.activityUnknown, true);
    assert.equal(f.timers.length, 1);
  }
});

test("observation preserves terminal, exact active, ordinary and external observations", async () => {
  for (const [runInput, snapshot, expected] of [
    [{}, { turnId: "original", completed: true }, "completed"],
    [{}, { turnId: "original", active: true }, "active"],
    [{ activityUnknown: false }, { turnId: "original", active: true }, "active"],
    [{ observer: true }, { turnId: "original", active: true }, "active"],
    [{ provider: "claude" }, { turnId: "original", active: true }, "active"],
  ]) {
    const run = { provider: "codex", observer: false, turnId: "original", activityUnknown: true, ...runInput };
    const f = fixture({ snapshot });
    await f.controller.poll(run);
    assert.deepEqual(f.events, [expected]);
    if (snapshot.active) assert.equal(run.activityUnknown, false);
  }
});

test("a managed snapshot cannot transfer the current run to a foreign turn", async () => {
  const run = { provider: "codex", observer: false, turnId: "current", activityUnknown: true };
  const f = fixture({ snapshot: { turnId: "foreign", active: true } });
  await f.controller.poll(run);
  assert.equal(run.turnId, "current");
  assert.equal(run.activityUnknown, true);
  assert.deepEqual(f.events, []);
});

test("an in-flight observation cannot publish after its exact identity changes", async () => {
  for (const change of [
    run => { run.turnId = "replacement"; },
    run => { run.threadId = "other-thread"; },
  ]) {
    let release;
    const pending = new Promise(resolve => { release = resolve; });
    const run = { provider: "codex", observer: false, threadId: "thread", turnId: "current",
      activityUnknown: true, providerStart: { lastEventAtMs: 1 } };
    const f = fixture({ readSnapshot: () => pending });
    const polling = f.controller.poll(run);
    change(run);
    release({ turnId: "current", active: true });
    await polling;
    assert.equal(run.activityUnknown, true);
    assert.deepEqual(f.events, []);
    assert.equal(f.timers.length, 1);
  }
});
