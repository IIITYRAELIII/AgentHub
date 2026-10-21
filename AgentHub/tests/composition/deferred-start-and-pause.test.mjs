import assert from "node:assert/strict";
import test from "node:test";
import { createDesktopRunInputComposition } from "../../src/composition/desktop-run-input-composition.mjs";
import { DeferredInputController } from "../../src/application/deferred-input-controller.mjs";
import { DesktopDeferredInputService } from "../../src/interfaces/desktop/desktop-deferred-input-service.mjs";
import { DeferredComposerTransferRegistry } from "../../src/application/deferred-composer-transfer-registry.mjs";

const noop = async () => {};
function gate() {
  let release;
  const promise = new Promise((resolve) => { release = resolve; });
  return { promise, release };
}

function desktopDependencies(item, overrides = {}) {
  return {
    pendingInputs: new Map(), queuedInputs: new Map([[item.id, item]]),
    findReceiptByResultId: () => null, isProcessing: () => false,
    cancelSchedule: () => false, saveState: noop, updateReceipt: () => {},
    cleanupFiles: noop, updateMessage: noop, scheduleNext: () => {}, scheduleQueued: () => {},
    selectTask: noop, clientContext: () => ({}), startTurn: noop,
    runForTask: () => null, describeAttachments: () => [],
    selectedTask: () => item, dispatchCommand: async () => ({ createdTask: { ...item, threadId: "new" } }),
    activeTitle: () => "New", snapshot: async () => ({}),
    ...overrides,
  };
}

test("deferred new-thread action uses its composed coordinator and original command identity", async () => {
  const item = { id: "one", input: "deliver", provider: "codex", streamId: "stream",
    threadId: "old", clientUserMessageId: "original", temporaryFiles: [] };
  const calls = [];
  const outerServices = {};
  const d = desktopDependencies(item, {
    startDeferred: (value) => outerServices.runCoordinator.startDeferred(value),
  });
  const composition = createDesktopRunInputComposition({
    composerTransfers: new DeferredComposerTransferRegistry(),
    deferredInput: { store: { put() {} }, persist: noop, removeFiles: noop, notify: noop },
    conflictPolicy: { enabled: () => false, resolveRepoRoots: noop,
      taskCatalog: noop, activeRuns: () => [], findConflict: () => null },
    coordinator: {
      taskRuns: { forTask: () => null }, providers: { call: noop },
      externalActivity: async () => ({ state: "inactive" }),
      beginRun: async (input, target) => { calls.push([input, target]); return { id: "run", ...target }; },
      rollbackAdmission: noop, launchTurn: async (run) => { calls.push(run.id); },
    },
    messageController: {}, desktopDeferredInput: d,
  });
  const result = await composition.desktopDeferredInput({ id: item.id, action: "new" });
  assert.equal(result.accepted, true);
  assert.equal(d.queuedInputs.has(item.id), false);
  assert.equal(calls.length, 2);
  assert.equal(calls[0][0], item.input);
  assert.equal(calls[0][1].threadId, "new");
  assert.equal(calls[0][1].streamId, "stream");
  assert.equal(calls[0][1].clientUserMessageId, "original");
  assert.equal(calls[0][1].telegramDeliveryRequested, false);
  assert.equal(calls[1], "run");
});

function queueFixture(overrides = {}) {
  const item = { id: "one", provider: "codex", streamId: "stream", threadId: "old",
    taskTitle: "Task", clientUserMessageId: "original", queueOrder: 0,
    paused: true, waitReason: "provider-thread-active" };
  const d = desktopDependencies(item);
  const starts = [];
  const timers = new Map();
  let timerId = 0;
  let saved;
  const persist = async () => { saved = JSON.parse(JSON.stringify([...d.queuedInputs.values()])); };
  const controller = new DeferredInputController({
    pendingInputs: d.pendingInputs, queuedInputs: d.queuedInputs,
    isBlocked: async () => false, occupancy: async () => ({ occupied: false }),
    start: async (value) => { starts.push(value.clientUserMessageId); return { id: "run" }; },
    persist, updateMessage: noop, pendingKeyboard: () => ({}), notifyReturned: noop,
    setTimeoutImpl: (callback) => { timers.set(++timerId, callback); return timerId; },
    clearTimeoutImpl: (id) => timers.delete(id),
    ...overrides,
  });
  const service = new DesktopDeferredInputService({
    ...d, composerTransfers: new DeferredComposerTransferRegistry(),
    startDeferred: noop, isProcessing: (id) => controller.isProcessing(id),
    cancelSchedule: (id) => controller.cancelSchedule(id), saveState: persist,
    scheduleQueued: (value, delay) => controller.schedule(value, delay),
  });
  return { item, d, controller, service, starts, timers, saved: () => saved };
}

test("manual pause survives occupancy refresh, wake and durable reload until explicit resume", async () => {
  const state = queueFixture();
  await state.service.handle({ id: "one", action: "pause" });
  state.controller.wakeAll();
  await state.controller.process("one");
  assert.deepEqual(state.starts, []);
  assert.equal(state.timers.size, 0);
  const restored = structuredClone(state.saved()[0]);
  state.d.queuedInputs.set("one", restored);
  await state.controller.process("one");
  assert.deepEqual(state.starts, []);
  await state.service.handle({ id: "one", action: "resume" });
  await state.controller.process("one");
  assert.deepEqual(state.starts, ["original"]);
});

for (const boundary of ["occupancy", "isBlocked", "persist"]) {
  test(`manual pause during ${boundary} prevents the provider effect and permits cancel after drain`, async () => {
    const entered = gate();
    const waiting = gate();
    const state = queueFixture({ [boundary]: async (item) => {
      if (boundary !== "persist" || state.item.dispatchingAt) {
        entered.release(); await waiting.promise;
      }
      return boundary === "occupancy" ? { occupied: false } : false;
    } });
    if (boundary !== "occupancy") delete state.item.paused;
    if (boundary !== "occupancy") delete state.item.waitReason;
    const processing = state.controller.process("one");
    await entered.promise;
    await state.service.handle({ id: "one", action: "pause" });
    await assert.rejects(state.service.handle({ id: "one", action: "cancel" }), /отмена не подтверждена/u);
    waiting.release();
    await processing;
    state.controller.wakeAll();
    await state.controller.process("one");
    assert.deepEqual(state.starts, []);
    assert.equal(state.item.manualPaused, true);
    assert.equal(state.item.dispatchingAt, undefined);
    assert.equal(state.timers.size, 0);
    assert.equal((await state.service.handle({ id: "one", action: "cancel" })).accepted, true);
    assert.equal(state.d.queuedInputs.size, 0);
  });
}

for (const unknown of [false, true]) {
  test(`pause during a provider call preserves ${unknown ? "unknown admission and FIFO" : "definite rejection without retries"}`, async () => {
    const entered = gate();
    const waiting = gate();
    let starts = 0;
    const state = queueFixture({ start: async () => {
      starts += 1; entered.release(); await waiting.promise;
      if (unknown) throw Object.assign(new Error("unconfirmed"), { code: "ERR_CODEX_TURN_START_UNCONFIRMED" });
      throw new Error("thread old already has an active writer");
    } });
    delete state.item.paused;
    delete state.item.waitReason;
    const processing = state.controller.process("one");
    await entered.promise;
    await state.service.handle({ id: "one", action: "pause" });
    assert.ok(state.item.dispatchingAt);
    waiting.release();
    await processing;
    await state.controller.process("one");
    assert.equal(starts, 1);
    if (unknown) {
      assert.equal(state.item.waitReason, "provider-start-unconfirmed");
      assert.ok(state.item.dispatchingAt);
      state.d.queuedInputs.set("next", { ...state.item, id: "next", clientUserMessageId: "next",
        queueOrder: 1, paused: false, manualPaused: false, dispatchingAt: undefined, waitReason: undefined });
      await state.controller.process("next");
      assert.equal(starts, 1);
      await assert.rejects(state.service.handle({ id: "one", action: "cancel" }), /отмена не подтверждена/u);
    } else {
      assert.equal(state.item.manualPaused, true);
      assert.equal(state.item.dispatchingAt, undefined);
      assert.equal(state.timers.size, 0);
      assert.equal((await state.service.handle({ id: "one", action: "cancel" })).accepted, true);
    }
  });
}

test("failed occupancy save cannot roll back a concurrent durable manual pause", async () => {
  const entered = gate();
  const waiting = gate();
  const state = queueFixture({ persist: async () => {
    entered.release(); await waiting.promise; throw new Error("save failed");
  } });
  const processing = state.controller.process("one");
  await entered.promise;
  await state.service.handle({ id: "one", action: "pause" });
  waiting.release();
  await assert.rejects(processing, /save failed/u);
  assert.equal(state.item.manualPaused, true);
  assert.equal(state.item.paused, true);
  assert.equal(state.timers.size, 0);
  assert.deepEqual(state.starts, []);
  assert.equal((await state.service.handle({ id: "one", action: "cancel" })).accepted, true);
});
