import assert from "node:assert/strict";
import test from "node:test";
import { RuntimeLifecycleController } from "./src/runtime/runtime-lifecycle-controller.mjs";

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
    resources: {
      flush: async () => events.push("flush"),
      suspend: async () => events.push("suspend"),
      finalize: async () => events.push("finalize"),
    },
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
    "flush",
    "suspend",
    "finalize",
  ]);
});

test("runtime lifecycle delegates all phases to the shared resource registry", async () => {
  const phases = [];
  const controller = new RuntimeLifecycleController({
    beginStopping: () => true,
    stopTimers: () => {},
    resources: {
      flush: async (options) => phases.push(["flush", options.label]),
      suspend: async (options) => phases.push(["suspend", options.label]),
      finalize: async (options) => phases.push(["finalize", options.label]),
    },
    logger: { log() {}, error() {} },
  });
  assert.equal(await controller.shutdown("test"), true);
  assert.deepEqual(phases, [
    ["flush", "Shutdown flush failed"],
    ["suspend", "Shutdown close failed"],
    ["finalize", "Shutdown finalize failed"],
  ]);
});
