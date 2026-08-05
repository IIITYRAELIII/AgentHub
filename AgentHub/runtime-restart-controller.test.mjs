import assert from "node:assert/strict";
import test from "node:test";
import { RuntimeRestartController } from "./src/runtime/runtime-restart-controller.mjs";

function createController(overrides = {}) {
  const events = [];
  const request = { minimumUpdateOffset: 2, waitingForRuns: false };
  const controller = new RuntimeRestartController({
    getRequest: () => request,
    updateOffset: () => 2,
    hasBlockingWork: () => false,
    setWaiting: (value) => { request.waitingForRuns = value; events.push(`waiting:${value}`); },
    updateMessage: async () => events.push("message"),
    saveState: async () => events.push("save"),
    resources: {
      flush: async () => events.push("flush"),
      suspend: async () => events.push("suspend"),
      finalize: async () => events.push("finalize"),
    },
    beginStopping: () => { events.push("stopping"); return true; },
    stopTimers: () => events.push("timers"),
    stopMedia: () => events.push("media"),
    launchReplacement: async () => ({ lock: { pid: 42 }, attempt: 1, usedFallback: false }),
    recoverPrevious: async () => events.push("recover"),
    finishSuccessfulReplacement: async () => events.push("exit"),
    logger: { log: () => events.push("ready"), error: () => {} },
    ...overrides,
  });
  return { controller, request, events };
}

test("restart controller executes the explicit lifecycle phases in order", async () => {
  const { controller, events } = createController();
  assert.deepEqual(await controller.perform(), { status: "replaced" });
  assert.deepEqual(events, [
    "waiting:false", "message", "save", "flush", "stopping", "timers", "media",
    "suspend", "ready", "finalize", "exit",
  ]);
});

test("restart controller waits without suspending resources", async () => {
  const { controller, request, events } = createController({ hasBlockingWork: () => true });
  assert.deepEqual(await controller.perform(), { status: "waiting-for-work" });
  assert.equal(request.waitingForRuns, true);
  assert.deepEqual(events, ["waiting:true"]);
});

test("restart controller restores the old runtime and never finalizes after launch failure", async () => {
  const failure = new Error("launch failed");
  const { controller, events } = createController({
    launchReplacement: async () => { throw failure; },
  });
  const result = await controller.perform();
  assert.equal(result.status, "recovered");
  assert.equal(result.error, failure);
  assert.deepEqual(events, [
    "waiting:false", "message", "save", "flush", "stopping", "timers", "media",
    "suspend", "recover",
  ]);
});

test("restart controller reports unrecoverable replacement failure", async () => {
  const exitCodes = [];
  const { controller } = createController({
    launchReplacement: async () => { throw new Error("launch failed"); },
    recoverPrevious: async () => { throw new Error("restore failed"); },
    finishSuccessfulReplacement: async () => exitCodes.push(0),
  });
  const result = await controller.perform();
  assert.equal(result.status, "failed");
  assert.equal(result.restoreError.message, "restore failed");
  assert.deepEqual(exitCodes, []);
});
