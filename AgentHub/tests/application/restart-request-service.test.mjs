import assert from "node:assert/strict";
import test from "node:test";

import { RestartRequestService } from "../../src/application/restart-request-service.mjs";
import { AsyncSqliteMutationQueue } from "../../src/infrastructure/persistence/async-sqlite-mutation-queue.mjs";
import {
  createMaintenanceOperation,
  transitionMaintenanceOperation,
} from "../../src/domain/maintenance-operation.mjs";

class MemoryOperationStore {
  #restartMutations = new AsyncSqliteMutationQueue();

  runRestartMutation(operation, options) { return this.#restartMutations.run(operation, options); }

  constructor(events) {
    this.events = events;
    this.items = new Map();
    this.nextId = 0;
  }

  idFactory() { return "restart-" + (++this.nextId); }

  create(value) {
    const operation = createMaintenanceOperation({
      ...value,
      operationId: value.operationId ?? ("restart-" + (++this.nextId)),
    });
    this.items.set(operation.operationId, operation);
    this.events.push("persist-operation");
    return operation;
  }

  get(id) { return this.items.get(id) ?? null; }

  activeFor({ kind, streamId, threadId }) {
    return [...this.items.values()].find((item) => (
      item.kind === kind && item.streamId === streamId && item.threadId === threadId
      && !["succeeded", "failed"].includes(item.status)
    )) ?? null;
  }

  transition(id, patch, options) {
    const result = transitionMaintenanceOperation(this.get(id), patch, options);
    if (result.applied) this.items.set(id, result.operation);
    return result;
  }

  settle(id, { succeeded, phase, metadata }) {
    return this.transition(id, {
      status: succeeded ? "succeeded" : "failed",
      phase,
      blockers: [],
      outcome: succeeded ? "succeeded" : "failed",
      metadata,
    }, { expectedRevision: this.get(id).revision }).operation;
  }

  migrateLegacyRestart() { return null; }
}

function fixture({ blockingCount = 0, processingId = null, stopping = false } = {}) {
  let request = null;
  const events = [];
  const operationStore = new MemoryOperationStore(events);
  const service = new RestartRequestService({
    operationStore,
    currentTarget: () => ({ streamId: "stream-1", threadId: "thread-1" }),
    getRequest: () => request,
    setRequest: (value) => { request = value; },
    blockingWorkCount: () => blockingCount,
    currentChatId: () => 101,
    updateOffset: () => 20,
    processingUpdateId: () => processingId,
    saveState: async () => events.push("save"),
    announceDesktop: async () => events.push("announce"),
    sendTelegram: async (text) => {
      events.push(text);
      return { message_id: 30 };
    },
    performRestart: async () => {
      events.push("restart");
      return { status: "replaced" };
    },
    isStopping: () => stopping,
    scheduleRestart: (callback) => {
      events.push("schedule");
      callback();
    },
    nowIso: () => "2026-08-05T00:00:00.000Z",
  });
  return { service, events, request: () => request, operationStore };
}

test("desktop restart persists before scheduling replacement", async () => {
  const state = fixture();
  const result = await state.service.fromDesktop();
  assert.equal(result.accepted, true);
  assert.equal(state.request().minimumUpdateOffset, 20);
  assert.equal(state.request().notifyTelegram, false);
  assert.equal(state.request().operationId, "restart-1");
  assert.equal(state.request().streamId, "stream-1");
  assert.equal(state.request().threadId, "thread-1");
  assert.equal(state.request().userTurn, false);
  assert.deepEqual(state.events.slice(0, 3), ["persist-operation", "save", "announce"]);
  assert.equal(state.events.includes("schedule"), true);
});

test("repeated desktop restart re-arms a pending request after work becomes idle", async () => {
  const state = fixture();
  await state.service.fromDesktop();
  state.events.length = 0;

  const result = await state.service.fromDesktop();

  assert.equal(result.accepted, false);
  assert.equal(result.waiting, false);
  assert.deepEqual(state.events, ["schedule", "restart"]);
  assert.equal(state.operationStore.items.size, 1);
});

test("repeated desktop restart does not schedule a second cutover while stopping", async () => {
  const state = fixture({ stopping: true });
  await state.service.fromDesktop();
  state.events.length = 0;

  const result = await state.service.fromDesktop();

  assert.equal(result.accepted, false);
  assert.equal(result.message, "Перезапуск уже выполняется");
  assert.deepEqual(state.events, []);
});

test("Telegram restart waits for the current update and active work", async () => {
  const state = fixture({ blockingCount: 2, processingId: 40 });
  const result = await state.service.fromTelegram();
  assert.equal(result.waiting, true);
  assert.equal(state.request().minimumUpdateOffset, 41);
  assert.equal(state.request().notifyTelegram, true);
  assert.equal(state.events.includes("restart"), false);
});

test("a restart timeout remains unknown until authoritative reconciliation", async () => {
  const state = fixture();
  state.service.performRestart = async () => ({ status: "failed", phase: "launch" });

  await state.service.fromDesktop();
  await new Promise((resolve) => setImmediate(resolve));

  const operation = state.operationStore.get(state.request().operationId);
  assert.equal(operation.status, "reconciling");
  assert.equal(operation.outcome, "unknown");
  assert.deepEqual(operation.blockers, ["authoritative-state-unknown"]);
  assert.equal(state.request().waitingForRuns, false);
});

test("an unknown restart is not replayed before authoritative reconciliation", async () => {
  const state = fixture();
  state.service.performRestart = async () => ({ status: "failed", phase: "launch" });
  await state.service.fromDesktop();
  await new Promise((resolve) => setImmediate(resolve));
  state.events.length = 0;

  const result = await state.service.fromDesktop();

  assert.equal(result.accepted, false);
  assert.equal(result.message, "Исход перезапуска уточняется");
  assert.deepEqual(state.events, []);
});

test("Desktop and Telegram restart retain their own exact selected Stream and Thread", async () => {
  for (const source of ["Desktop", "Telegram"]) {
    const state = fixture({ blockingCount: 1 });
    state.service.desktopTarget = () => ({ streamId: "desktop-stream", threadId: "desktop-thread" });
    state.service.currentTarget = () => ({ streamId: "telegram-stream", threadId: "telegram-thread" });
    await state.service[`from${source}`]();
    const owner = source.toLowerCase();
    assert.equal(state.request().streamId, `${owner}-stream`);
    assert.equal(state.request().threadId, `${owner}-thread`);
  }
});

test("scheduled restart contains a rejected outcome write and retains the exact durable operation", async () => {
  const state = fixture({ blockingCount: 1 });
  await state.service.fromDesktop();
  const request = state.request();
  const failure = new Error("database is locked");
  const diagnostics = [];
  state.service.logger = { error: (...values) => diagnostics.push(values) };
  state.service.performRestart = async () => ({ status: "failed", phase: "launch" });
  state.operationStore.transition = () => { throw failure; };

  const result = await state.service.performScheduled(request.operationId);
  assert.equal(result.status, "settlement-pending");
  assert.equal(result.error, failure);
  assert.equal(result.operationId, request.operationId);
  assert.equal(state.request(), request);
  assert.equal(state.operationStore.get(request.operationId).status, "blocked");
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0][1], request.operationId);
});

test("scheduled restart does not repeat the controller's attempted canonical abort", async () => {
  const state = fixture({ blockingCount: 1 });
  await state.service.fromDesktop();
  const request = state.request();
  let failCalls = 0;
  state.service.fail = async () => { failCalls += 1; throw new Error("second settlement"); };
  for (const restartStateSettled of [true, false]) {
    state.service.performRestart = async () => ({ status: "aborted", restartStateSettled });
    assert.equal((await state.service.performScheduled(request.operationId)).status, "aborted");
  }
  assert.equal(failCalls, 0);
  assert.equal(state.request(), request);
});

test("scheduled restart ignores a stale operation instead of running its replacement", async () => {
  const state = fixture({ blockingCount: 1 });
  await state.service.fromDesktop();
  assert.equal((await state.service.performScheduled("old-operation")).status, "reconciling");
  assert.equal(state.events.includes("restart"), false);
});

test("scheduled restart contains failure to read its durable admission state", async () => {
  const state = fixture({ blockingCount: 1 });
  await state.service.fromDesktop();
  const request = state.request();
  const failure = new Error("database unavailable");
  const diagnostics = [];
  state.service.logger = { error: (...values) => diagnostics.push(values) };
  state.operationStore.get = () => { throw failure; };
  const result = await state.service.performScheduled(request.operationId);
  assert.equal(result.status, "settlement-pending");
  assert.equal(result.error, failure);
  assert.equal(state.request(), request);
  assert.equal(state.events.includes("restart"), false);
  assert.equal(diagnostics.length, 1);
});

test("a desktop restart without any selected Stream and Thread uses the runtime scope", async () => {
  const state = fixture({ blockingCount: 1 });
  state.service.desktopTarget = () => ({ provider: "codex", projectRoot: "D:/Work", streamId: null, threadId: null });
  await state.service.fromDesktop();
  assert.equal(state.request().streamId, "agent-hub-runtime");
  assert.equal(state.request().threadId, "agent-hub-runtime");

  const halfSelected = fixture({ blockingCount: 1 });
  halfSelected.service.desktopTarget = () => ({ streamId: "stream-only", threadId: null });
  await assert.rejects(halfSelected.service.fromDesktop(), /exact Stream and Thread/);
});

test("restart settlement binds the persisted intended release and keeps terminal replay read-only", async () => {
  const setup = fixture();
  const admitted = await setup.service.fromDesktop();
  await setup.service.checkpoint(admitted.operationId, "launching", { expectedReleaseId: "required-fixture-release" });
  await assert.rejects(setup.service.complete(admitted.operationId), /does not match/);
  await setup.service.fail(admitted.operationId, new Error("owned launch failed"));
  const terminal = await setup.service.complete(admitted.operationId);
  assert.equal(terminal.status, "failed");
});
