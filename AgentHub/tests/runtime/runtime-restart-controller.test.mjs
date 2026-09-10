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
    setWaiting: async (value) => { request.waitingForRuns = value; events.push(`waiting:${value}`); return true; },
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
    "stopping", "waiting:false", "message", "quiesce", "timers", "media", "save", "drain",
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

test("restart controller waits for durable cutover with admission closed and one replacement owner", async () => {
  let releaseWrite;
  const writeGate = new Promise((resolve) => { releaseWrite = resolve; });
  const { controller, events } = createController({
    setWaiting: async () => {
      events.push("persist-start");
      await writeGate;
      events.push("persist-finish");
      return true;
    },
  });
  const restart = controller.perform();
  const duplicate = controller.perform();
  assert.equal(duplicate, restart);
  assert.deepEqual(events, ["stopping", "persist-start"]);
  releaseWrite();
  assert.equal((await restart).status, "replaced");
  assert.deepEqual(events.slice(0, 5), ["stopping", "persist-start", "persist-finish", "message", "quiesce"]);
  assert.equal(events.filter((event) => event === "exit").length, 1);
});

test("restart controller waits for blocked persistence without closing admission or resources", async () => {
  let releaseWrite;
  const writeGate = new Promise((resolve) => { releaseWrite = resolve; });
  let settled = false;
  const { controller, events } = createController({
    hasBlockingWork: () => true,
    setWaiting: async (value) => { events.push(`waiting:${value}`); await writeGate; return true; },
  });
  const waiting = controller.perform().then((result) => { settled = true; return result; });
  await Promise.resolve();
  assert.equal(settled, false);
  assert.deepEqual(events, ["waiting:true"]);
  releaseWrite();
  assert.equal((await waiting).status, "waiting-for-work");
});

for (const blocked of [false, true]) {
  test(`restart controller contains rejected ${blocked ? "waiting" : "cutover"} persistence before closing resources`, async () => {
    const failure = new Error("database is locked");
    const captured = [];
    const { controller, events } = createController({
      hasBlockingWork: () => blocked,
      setWaiting: async () => { await Promise.resolve(); throw failure; },
      captureException: (error, context) => captured.push([error, context.action]),
    });
    const result = await controller.perform();
    assert.equal(result.status, "aborted");
    assert.equal(result.error, failure);
    assert.equal(result.phase, blocked ? "waiting" : "cutover-state");
    assert.deepEqual(events, [...(blocked ? [] : ["stopping"]), "abort", "poll"]);
    assert.deepEqual(captured, [[failure, result.phase]]);
  });
}

test("restart controller does not cut over when the durable transition was refused", async () => {
  const { controller, events } = createController({ setWaiting: async () => false });
  const result = await controller.perform();
  assert.equal(result.status, "aborted");
  assert.equal(result.phase, "cutover-state");
  assert.deepEqual(events, ["stopping", "abort", "poll"]);
});

test("restart controller retains a failed abort receipt without reporting replacement success", async () => {
  const failure = new Error("database is locked");
  const abortFailure = new Error("abort write is locked");
  const { controller, request, events } = createController({
    setWaiting: async () => { throw failure; },
    abortRestart: async () => { throw abortFailure; },
  });
  const result = await controller.perform();
  assert.equal(result.status, "aborted");
  assert.equal(result.abortError, abortFailure);
  assert.equal(controller.getRequest(), request);
  assert.deepEqual(events, ["stopping", "poll"]);
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
    "stopping", "waiting:false", "message", "quiesce", "timers", "media", "save", "drain",
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
    "stopping", "waiting:false", "message", "quiesce", "timers", "media", "save", "drain", "close", "restore:false", "poll",
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
    "stopping", "waiting:false", "message", "quiesce", "timers", "media", "save", "drain",
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
  assert.deepEqual(events, ["stopping", "waiting:false", "message", "quiesce"]);
});
