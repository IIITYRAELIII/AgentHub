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
      quiesce: async () => { events.push("quiesce"); return { ok: true }; },
      drain: async () => { events.push("drain"); return { ok: true }; },
      close: async () => { events.push("close"); return { ok: true }; },
      releaseLock: async () => { events.push("lock"); return { ok: true }; },
      recover: async () => { events.push("poll"); return { ok: true }; },
      finalize: async () => { events.push("finalize"); return { ok: true }; },
    },
    beginStopping: () => { events.push("stopping"); return true; },
    stopTimers: () => events.push("timers"),
    stopMedia: () => events.push("media"),
    resumeAfterAbort: async () => events.push("resume"),
    launchReplacement: async () => ({ lock: { pid: 42 }, attempt: 1, usedFallback: false }),
    recoverPrevious: async (_error, options) => events.push(`restore:${options.lockReleased}`),
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
    "waiting:false", "stopping", "message", "quiesce", "timers", "media", "save", "drain",
    "close", "lock", "ready", "finalize", "exit",
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

test("restart controller aborts safely when drain reports failures", async () => {
  const failure = new Error("disk full");
  const { controller, events } = createController({
    resources: {
      quiesce: async () => { events.push("quiesce"); return { ok: true }; },
      drain: async () => {
        events.push("drain");
        return { ok: false, failures: [{ name: "state", error: failure }] };
      },
      close: async () => { events.push("close"); return { ok: true }; },
      releaseLock: async () => { events.push("lock"); return { ok: true }; },
      recover: async () => { events.push("poll"); return { ok: true }; },
      finalize: async () => { events.push("finalize"); return { ok: true }; },
    },
  });
  const result = await controller.perform();
  assert.equal(result.status, "aborted");
  assert.equal(result.phase, "drain");
  assert.deepEqual(result.error.failures, [{ name: "state", error: failure }]);
  assert.deepEqual(events, [
    "waiting:false", "stopping", "message", "quiesce", "timers", "media", "save", "drain",
    "abort", "resume", "poll",
  ]);
});

test("restart controller restores the old runtime when close reports failures", async () => {
  const failure = new Error("pipe close failed");
  const { controller, events } = createController({
    resources: {
      quiesce: async () => { events.push("quiesce"); return { ok: true }; },
      drain: async () => { events.push("drain"); return { ok: true }; },
      close: async () => {
        events.push("close");
        return { ok: false, failures: [{ name: "pipe", error: failure }] };
      },
      releaseLock: async () => { events.push("lock"); return { ok: true }; },
      recover: async () => { events.push("poll"); return { ok: true }; },
      finalize: async () => { events.push("finalize"); return { ok: true }; },
    },
  });
  const result = await controller.perform();
  assert.equal(result.status, "recovered");
  assert.equal(result.phase, "close");
  assert.deepEqual(result.error.failures, [{ name: "pipe", error: failure }]);
  assert.deepEqual(events, [
    "waiting:false", "stopping", "message", "quiesce", "timers", "media", "save", "drain", "close", "restore:false", "poll",
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
    "waiting:false", "stopping", "message", "quiesce", "timers", "media", "save", "drain",
    "close", "lock", "restore:true", "poll",
  ]);
});

test("restart controller does not restore the old runtime until replacement cleanup is confirmed", async () => {
  const failure = new Error("replacement lock is still held");
  failure.replacementCleanup = { confirmed: false, ownerPid: 84 };
  const { controller, events } = createController({
    launchReplacement: async () => { throw failure; },
  });
  const result = await controller.perform();
  assert.equal(result.status, "failed");
  assert.equal(result.phase, "launch cleanup");
  assert.equal(events.includes("restore:true"), false);
});

test("restart controller reports unrecoverable replacement failure", async () => {
  const exitCodes = [];
  const captured = [];
  const { controller } = createController({
    launchReplacement: async () => { throw new Error("launch failed"); },
    recoverPrevious: async () => { throw new Error("restore failed"); },
    finishSuccessfulReplacement: async () => exitCodes.push(0),
    captureException: (error, context) => captured.push([error.message, context.action]),
  });
  const result = await controller.perform();
  assert.equal(result.status, "failed");
  assert.equal(result.restoreError.message, "restore failed");
  assert.deepEqual(exitCodes, []);
  assert.deepEqual(captured, [["launch failed", "launch"], ["restore failed", "restore-previous"]]);
});

test("restart controller does not recover or release after a lifecycle timeout", async () => {
  const timeout = new Error("timed out");
  timeout.name = "LifecycleOperationTimeoutError";
  const { controller, events } = createController({
    resources: {
      quiesce: async () => {
        events.push("quiesce");
        return { ok: false, failures: [{ name: "poll", error: timeout }] };
      },
      drain: async () => { events.push("drain"); return { ok: true }; },
      close: async () => { events.push("close"); return { ok: true }; },
      releaseLock: async () => { events.push("lock"); return { ok: true }; },
      recover: async () => { events.push("poll"); return { ok: true }; },
      finalize: async () => { events.push("finalize"); return { ok: true }; },
    },
  });

  const result = await controller.perform();
  assert.equal(result.status, "failed");
  assert.equal(result.phase, "quiesce");
  assert.deepEqual(events, ["waiting:false", "stopping", "message", "quiesce"]);
});
