import assert from "node:assert/strict";
import test from "node:test";

import { RestartRequestService } from "../../src/application/restart-request-service.mjs";
import {
  createMaintenanceOperation,
  transitionMaintenanceOperation,
} from "../../src/domain/maintenance-operation.mjs";

class MemoryOperationStore {
  constructor(events) {
    this.events = events;
    this.items = new Map();
    this.nextId = 0;
  }

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
