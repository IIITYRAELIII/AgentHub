import assert from "node:assert/strict";
import test from "node:test";
import { RuntimeLifecycleController } from "./runtime-lifecycle-controller.mjs";

test("runtime lifecycle stops once and settles every named component", async () => {
  let stopping = false;
  const events = [];
  const controller = new RuntimeLifecycleController({
    beginStopping: () => {
      if (stopping) return false;
      stopping = true;
      events.push("begin");
      return true;
    },
    stopTimers: () => events.push("timers"),
    stopManagedRuns: () => events.push("runs"),
    stopMedia: () => events.push("media"),
    operations: () => [
      { name: "one", run: async () => events.push("one") },
      { name: "two", run: async () => events.push("two") },
    ],
    afterClose: () => events.push("closed"),
    logger: { log: (message) => events.push(message), error: () => {} },
  });

  assert.equal(await controller.shutdown("SIGTERM"), true);
  assert.equal(await controller.shutdown("SIGTERM"), false);
  assert.deepEqual(events, [
    "begin",
    "Stopping on SIGTERM...",
    "timers",
    "runs",
    "media",
    "one",
    "two",
    "closed",
  ]);
});

test("runtime lifecycle reports one failing component and still closes the rest", async () => {
  const errors = [];
  let closed = false;
  const controller = new RuntimeLifecycleController({
    beginStopping: () => true,
    stopTimers: () => {},
    operations: () => [
      { name: "broken", run: async () => { throw new Error("boom"); } },
      { name: "healthy", run: async () => { closed = true; } },
    ],
    logger: { log() {}, error: (message, detail) => errors.push(`${message} ${detail}`) },
  });
  assert.equal(await controller.shutdown("test"), true);
  assert.equal(closed, true);
  assert.deepEqual(errors, ["Shutdown failed (broken): boom"]);
});
