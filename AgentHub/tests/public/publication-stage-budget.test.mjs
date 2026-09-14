import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { FULL_TEST_BUDGET, publicationSteps, runStep } from "../../publish-all.mjs";

function harness() {
  let time = 0;
  const timers = new Set();
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.pid = 987;
  const killed = [];
  return {
    child, killed,
    options: {
      spawnImpl: () => child,
      stopTree: async (pid) => { killed.push(pid); child.emit("exit", 0); return true; },
      schedule: (callback, delay) => {
        const timer = { callback, at: time + delay, unref() {} };
        timers.add(timer);
        return timer;
      },
      unschedule: (timer) => timers.delete(timer),
    },
    advance(milliseconds) {
      time += milliseconds;
      for (const timer of [...timers]) {
        if (timer.at <= time && timers.delete(timer)) timer.callback();
      }
    },
  };
}

test("full tests continue past the former 15 minute deadline while reporting progress", async () => {
  const h = harness();
  const step = publicationSteps()[0];
  const done = runStep(step, h.options);
  for (let index = 0; index < 4; index += 1) {
    h.advance(5 * 60_000);
    h.child.stdout.emit("data", "");
  }
  assert.deepEqual(h.killed, []);
  h.child.emit("exit", 0);
  await done;
});

test("idle full test stops its process tree and cannot report success from a termination race", async () => {
  const h = harness();
  const done = runStep(publicationSteps()[0], h.options);
  const failure = assert.rejects(done, /нет вывода/u);
  h.advance(FULL_TEST_BUDGET.idleTimeoutMs);
  await failure;
  assert.deepEqual(h.killed, [987]);
});

test("continuous output does not remove the finite overall budget", async () => {
  const h = harness();
  const done = runStep({ label: "bounded", command: "unused", args: [], timeoutMs: 30, idleTimeoutMs: 20 }, h.options);
  const failure = assert.rejects(done, /превышен таймаут 30/u);
  h.advance(15);
  h.child.stdout.emit("data", "");
  h.advance(15);
  await failure;
  assert.deepEqual(h.killed, [987]);
});
