import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { TaskReadStateStore } from "../../../src/infrastructure/persistence/task-read-state-store.mjs";
import { openRuntimeDatabase } from "../../../src/infrastructure/persistence/runtime-state-store.mjs";
import { MaintenanceOperationStore } from "../../../src/infrastructure/persistence/maintenance-operation-store.mjs";
import { RestartRequestService } from "../../../src/application/restart-request-service.mjs";
import { recoverRestartOperation } from "../../../src/application/restart-operation-mutations.mjs";
import { TelegramDeliveryService } from "../../../src/interfaces/telegram/telegram-delivery-service.mjs";
import {
  appendMessageBindings, readMessageBindings, removeMessageBindings, migrateMessageBindings,
} from "../../../src/infrastructure/persistence/message-bindings.mjs";

async function fixture(t) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "hub-runtime-contention-"));
  const readState = new TaskReadStateStore({ dataDir });
  await readState.initialize();
  const operations = new MaintenanceOperationStore({ dataDir });
  operations.latestRestart({ streamId: "stream", threadId: "thread" });
  const blocker = new DatabaseSync(path.join(dataDir, "runtime.sqlite"));
  t.after(async () => {
    blocker.close();
    await readState.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  return { dataDir, readState, operations, blocker };
}

async function whileBusy(blocker, action, inspectPending = () => {}) {
  blocker.exec("BEGIN IMMEDIATE");
  let settled = false;
  const pending = Promise.resolve().then(action);
  pending.then(() => { settled = true; }, () => { settled = true; });
  try {
    // This timer must run while SQLite is still held by a different handle.
    await new Promise((resolve) => setTimeout(resolve, 35));
    assert.equal(settled, false, "write must await persistence without blocking runtime timers");
    await inspectPending();
  } finally {
    blocker.exec("ROLLBACK");
  }
  return pending;
}

function restartService(operationStore) {
  let request = null;
  const effects = [];
  const service = new RestartRequestService({
    operationStore,
    currentTarget: () => ({ streamId: "stream", threadId: "thread" }),
    getRequest: () => request,
    setRequest: (value) => { request = value; },
    blockingWorkCount: () => 1,
    currentChatId: () => 1,
    updateOffset: () => 1,
    processingUpdateId: () => null,
    saveState: async () => effects.push("save"),
    announceDesktop: async () => effects.push("announce"),
    sendTelegram: async () => { effects.push("telegram"); return { message_id: 1 }; },
    performRestart: async () => effects.push("restart"),
  });
  return { service, effects, request: () => request };
}

test("read acknowledgements retry real SQLITE_BUSY and remain monotonic after queued stale input", async (t) => {
  const { readState, blocker } = await fixture(t);
  const value = { accountId: "owner", provider: "codex", threadId: "thread", answerTurnId: "turn", answerAtMs: Date.now(), answerRevision: 2 };
  await whileBusy(blocker, () => Promise.all([
    readState.markRead(value), readState.markRead({ ...value, answerRevision: 1 }),
  ]), () => assert.equal(readState.get(value), null));
  assert.equal(readState.get(value).answerRevision, 2);
  assert.equal(readState.revision, 1);
});

test("read-state shutdown waits for an already queued write", async (t) => {
  const { readState, blocker } = await fixture(t);
  const value = { accountId: "owner", provider: "codex", threadId: "thread", answerTurnId: "turn", answerAtMs: Date.now(), answerRevision: 2 };
  await whileBusy(blocker, () => {
    const write = readState.markRead(value);
    const close = readState.close();
    return Promise.all([write, close]);
  });
  assert.equal(blocker.prepare("SELECT answer_revision FROM task_read_state WHERE thread_id = 'thread'").get().answer_revision, 2);
});

test("initial read-state schema waits asynchronously for the writer and subsequent reads perform no schema writes", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "hub-read-schema-contention-"));
  const blocker = openRuntimeDatabase(dataDir);
  const store = new TaskReadStateStore({ dataDir });
  t.after(async () => {
    await store.close();
    blocker.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const identity = { accountId: "owner", provider: "codex", threadId: "thread" };
  await whileBusy(blocker, () => Promise.all([store.initialize(), store.initialize()]), () => {
    assert.equal(blocker.prepare("SELECT name FROM sqlite_master WHERE name = 'task_read_state'").get(), undefined);
    assert.throws(() => store.get(identity), /not initialized/u);
  });
  blocker.exec("BEGIN IMMEDIATE");
  try {
    assert.equal(await store.initialize(), store, "repeated initialization must not request the writer");
    assert.equal(store.get(identity), null, "initialized reads must remain available while a writer is held");
  } finally {
    blocker.exec("ROLLBACK");
  }
});

test("restart acquisition and terminal writes wait for durability with one original operation", async (t) => {
  const { operations, blocker } = await fixture(t);
  const left = restartService(operations);
  const right = restartService(operations);
  const results = await whileBusy(blocker, () => Promise.all([
    left.service.fromDesktop(), right.service.fromDesktop(),
  ]), () => {
    assert.equal(left.request(), null);
    assert.deepEqual(left.effects, []);
  });
  assert.equal(results.filter((result) => result.accepted).length, 1);
  assert.equal(results[0].operationId, results[1].operationId);
  const id = results[0].operationId;
  await whileBusy(blocker, () => left.service.setWaiting(false), () => {
    assert.equal(operations.get(id).phase, "waiting-for-work");
  });
  assert.equal(operations.get(id).phase, "cutover");
  await whileBusy(blocker, () => left.service.fail(id, new Error("replacement rejected")), () => {
    assert.equal(left.request().operationId, id);
    assert.equal(operations.get(id).status, "running");
  });
  assert.equal(left.request(), null);
  assert.equal(operations.get(id).status, "failed");
  assert.equal(blocker.prepare("SELECT COUNT(*) AS n FROM maintenance_operations").get().n, 1);
});

test("startup legacy restart migration and recovery retain the exact identity under writer contention", async (t) => {
  const { operations, blocker } = await fixture(t);
  const operation = await whileBusy(blocker, () => recoverRestartOperation(operations, {
    requestedAt: new Date().toISOString(), waitingForRuns: true,
  }, { streamId: "stream", threadId: "thread" }));
  assert.equal(operation.status, "reconciling");
  const repeated = await recoverRestartOperation(operations, { operationId: operation.operationId }, {
    streamId: "stream", threadId: "thread",
  });
  assert.equal(repeated.operationId, operation.operationId);
  assert.equal(repeated.revision, operation.revision);
  assert.equal(blocker.prepare("SELECT COUNT(*) AS n FROM maintenance_operations").get().n, 1);
});

test("Telegram binding append and clear retain FIFO under SQLITE_BUSY without repeating Telegram effects", async (t) => {
  const { dataDir, blocker } = await fixture(t);
  await migrateMessageBindings(dataDir);
  const effects = [];
  const service = new TelegramDeliveryService({
    dataDir,
    appendBindings: appendMessageBindings,
    readBindings: readMessageBindings,
    removeBindings: removeMessageBindings,
    runTaskTitle: () => "Task",
    telegram: async (...args) => effects.push(args),
    logger: { warn: (...args) => assert.fail(args.join(" ")) },
  });
  await whileBusy(blocker, () => Promise.all([
    service.bindRunMessage({ chatId: 7, provider: "codex", threadId: "thread", projectRoot: "/repo" }, { message_id: 42 }),
    service.clearDeliveredProgressMessages(7, [42]),
  ]), async () => {
    assert.deepEqual(await readMessageBindings(dataDir), [], "ordinary reads must not wait in the writer queue");
  });
  await service.waitForBindingWrites();
  assert.deepEqual(await readMessageBindings(dataDir), []);
  assert.equal(effects.length, 1);
  assert.equal(effects[0][0], "deleteMessage");
});


test("replacement completion does not claim success before its exact durable settlement", async (t) => {
  const { operations, blocker } = await fixture(t);
  const { service } = restartService(operations);
  const { operationId } = await service.fromDesktop();
  await whileBusy(blocker, () => service.complete(operationId), () => {
    assert.equal(operations.get(operationId).status, "blocked");
  });
  assert.equal(operations.get(operationId).status, "succeeded");
  const revision = operations.get(operationId).revision;
  await service.complete(operationId);
  assert.equal(operations.get(operationId).revision, revision);
  assert.equal(await service.setWaiting(false), false);
});
