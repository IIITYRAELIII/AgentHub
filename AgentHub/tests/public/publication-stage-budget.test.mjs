import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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
      stopTree: async (pid) => {
        killed.push(pid); child.emit("exit", 0, null); child.emit("close", 0, null); return true;
      },
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

test("full tests have no default overall or idle execution deadline", async () => {
  const h = harness();
  const step = publicationSteps()[0];
  const done = runStep(step, h.options);
  const outcome = done.then(() => null, (error) => error);
  assert.equal(FULL_TEST_BUDGET.timeoutMs, null);
  assert.equal(FULL_TEST_BUDGET.idleTimeoutMs, 0);
  for (let index = 0; index < 37; index += 1) {
    h.advance(5 * 60_000);
    h.child.stdout.emit("data", "");
  }
  assert.deepEqual(h.killed, []);
  h.child.emit("exit", 0, null); h.child.emit("close", 0, null);
  assert.equal(await outcome, null);
});

test("explicit idle budget stops its process tree and cannot report success from a termination race", async () => {
  const h = harness();
  const done = runStep({ ...publicationSteps()[0], idleTimeoutMs: 20 }, h.options);
  const failure = assert.rejects(done, /нет вывода/u);
  h.advance(20);
  await failure;
  assert.deepEqual(h.killed, [987]);
});

test("stage joins child close and complete late output before returning", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hub-stage-close-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const logFile = path.join(root, "stage.log");
  const h = harness();
  const phases = [];
  let settled = false;
  const done = runStep({ label: "late-output-fixture", command: "unused", args: [], logFile }, {
    ...h.options, observeProcess: event => phases.push(event.phase),
  });
  const outcome = done.then(() => { settled = true; }, error => { settled = true; throw error; });
  try {
    h.child.emit("exit", 0, null);
    await new Promise(setImmediate);
    assert.equal(settled, false, "exit is not child/output closure");
    h.child.stdout.emit("data", "synthetic final output after exit\n");
    h.child.stderr.emit("data", "synthetic final stderr after exit\n");
    h.child.emit("close", 0, null);
    await outcome;
    assert.equal(settled, true);
    assert.match(await readFile(logFile, "utf8"), /synthetic final output after exit\nsynthetic final stderr after exit/u);
    assert.deepEqual(phases, ["spawned", "exit", "closed", "log-draining", "joined"]);
  } finally {
    h.child.emit("close", 0, null);
    await outcome.catch(() => {});
  }
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
