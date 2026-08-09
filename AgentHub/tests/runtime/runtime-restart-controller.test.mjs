import assert from "node:assert/strict";
import test from "node:test";
import { RuntimeRestartController } from "../../src/runtime/runtime-restart-controller.mjs";

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
      flush: async () => { events.push("flush"); return { ok: true }; },
      suspend: async () => { events.push("suspend"); return { ok: true }; },
      finalize: async () => { events.push("finalize"); return { ok: true }; },
    },
    beginStopping: () => { events.push("stopping"); return true; },
    stopTimers: () => events.push("timers"),
    stopMedia: () => events.push("media"),
    launchReplacement: async () => ({ lock: { pid: 42 }, attempt: 1, usedFallback: false }),
    recoverPrevious: async () => events.push("recover"),
    abortRestart: async () => events.push("abort"),
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
    "waiting:false", "stopping", "message", "save", "flush", "timers", "media",
    "suspend", "ready", "finalize", "exit",
  ]);
});

test("restart controller closes admission before asynchronous preparation", async () => {
  let releaseMessage;
  const messageGate = new Promise((resolve) => { releaseMessage = resolve; });
  let admissionClosed = false;
  let messageStarted = false;
  const { controller } = createController({
    beginStopping: () => { admissionClosed = true; return true; },
    updateMessage: async () => { messageStarted = true; await messageGate; },
  });
  const restart = controller.perform();
  while (!messageStarted) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(admissionClosed, true);
  releaseMessage();
  assert.equal((await restart).status, "replaced");
});

test("restart controller aborts safely when flush reports failures", async () => {
  const failure = new Error("disk full");
  const { controller, events } = createController({
    resources: {
      flush: async () => {
        events.push("flush");
        return { ok: false, failures: [{ name: "state", error: failure }] };
      },
      suspend: async () => { events.push("suspend"); return { ok: true }; },
      finalize: async () => { events.push("finalize"); return { ok: true }; },
    },
  });
  const result = await controller.perform();
  assert.equal(result.status, "aborted");
  assert.equal(result.phase, "flush");
  assert.deepEqual(result.error.failures, [{ name: "state", error: failure }]);
  assert.deepEqual(events, ["waiting:false", "stopping", "message", "save", "flush", "abort"]);
});

test("restart controller restores the old runtime when suspend reports failures", async () => {
  const failure = new Error("pipe close failed");
  const { controller, events } = createController({
    resources: {
      flush: async () => { events.push("flush"); return { ok: true }; },
      suspend: async () => {
        events.push("suspend");
        return { ok: false, failures: [{ name: "pipe", error: failure }] };
      },
      finalize: async () => { events.push("finalize"); return { ok: true }; },
    },
  });
  const result = await controller.perform();
  assert.equal(result.status, "recovered");
  assert.equal(result.phase, "suspend");
  assert.deepEqual(result.error.failures, [{ name: "pipe", error: failure }]);
  assert.deepEqual(events, [
    "waiting:false", "stopping", "message", "save", "flush", "timers", "media", "suspend", "recover",
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
    "waiting:false", "stopping", "message", "save", "flush", "timers", "media",
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
