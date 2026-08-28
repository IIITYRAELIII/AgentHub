import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  configureRuntimeDatabase,
  readRuntimeState,
  runtimeDatabasePath,
  RuntimeStateStore,
} from "../../../src/infrastructure/persistence/runtime-state-store.mjs";
import {
  holdRuntimeWriteLock,
  messageCommandFixture,
} from "../../fixtures/message-command-ledger.mjs";

function readRawRuntimeState(dataDir) {
  const database = new DatabaseSync(runtimeDatabasePath(dataDir), { readOnly: true });
  try {
    const row = database.prepare("SELECT value_json FROM runtime_state WHERE key = 'main'").get();
    return row?.value_json ? JSON.parse(row.value_json) : null;
  } finally {
    database.close();
  }
}

test("runtime state migrates from JSON to SQLite and archives both legacy copies", async (context) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "agent-hub-runtime-state-"));
  context.after(() => rm(dataDir, { recursive: true, force: true }));
  const stateFile = path.join(dataDir, "state.json");
  const backupFile = `${stateFile}.bak`;
  const expected = { activeRuns: [], updateOffset: 42, threadIds: { codex: "thread-1" } };
  await writeFile(stateFile, JSON.stringify(expected), "utf8");
  await writeFile(backupFile, JSON.stringify({ stale: true }), "utf8");

  const store = new RuntimeStateStore({ dataDir, legacyFile: stateFile, legacyBackupFile: backupFile });
  const loaded = await store.load();
  assert.deepEqual(loaded.value, expected);
  assert.equal(loaded.migrated, true);
  assert.deepEqual(store.read(), expected);
  await store.close();

  assert.equal(await stat(runtimeDatabasePath(dataDir)).then(() => true), true);
  await assert.rejects(readFile(stateFile, "utf8"), /ENOENT/u);
  await assert.rejects(readFile(backupFile, "utf8"), /ENOENT/u);
  assert.deepEqual(await readRuntimeState(dataDir), expected);
});

test("runtime state updates one durable SQLite row", async (context) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "agent-hub-runtime-save-"));
  context.after(() => rm(dataDir, { recursive: true, force: true }));
  const store = new RuntimeStateStore({ dataDir });
  assert.equal((await store.load()).value, null);
  await store.save({ sequence: 1, activeRuns: [{ turnId: "one" }] });
  await store.save({ sequence: 2, activeRuns: [] });
  assert.deepEqual(await readRuntimeState(dataDir), { sequence: 2, activeRuns: [] });
  await store.close();
});

test("corrupt runtime SQLite is preserved and replaced with a writable store", async (context) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "agent-hub-runtime-corrupt-"));
  context.after(() => rm(dataDir, { recursive: true, force: true }));
  const databaseFile = runtimeDatabasePath(dataDir);
  await writeFile(databaseFile, "not a sqlite database", "utf8");

  const store = new RuntimeStateStore({ dataDir });
  const loaded = await store.load();
  assert.equal(loaded.value, null);
  assert.equal(loaded.recovered, true);
  await store.save({ sequence: 1 });
  assert.deepEqual(store.read(), { sequence: 1 });
  await store.close();

  assert.ok((await readdir(dataDir)).some((name) => name.startsWith("runtime.sqlite.corrupt-")));
  assert.deepEqual(await readRuntimeState(dataDir), { sequence: 1 });
});

test("runtime state writer retries SQLite contention without blocking the main event loop", async (context) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "agent-hub-runtime-contention-"));
  context.after(() => rm(dataDir, { recursive: true, force: true }));
  const store = new RuntimeStateStore({ dataDir });
  const blocker = new DatabaseSync(runtimeDatabasePath(dataDir));
  blocker.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE;");
  let timerFired = false;
  const releaseLock = new Promise((resolve) => setTimeout(() => {
    timerFired = true;
    blocker.exec("COMMIT;");
    blocker.close();
    resolve();
  }, 50));

  await Promise.all([
    store.save({ sequence: 1, payload: "x".repeat(1_000_000) }),
    releaseLock,
  ]);

  assert.equal(timerFired, true);
  assert.equal(store.read().sequence, 1);
  await store.close();
});

test("runtime state worker preserves JSON semantics for non-cloneable transient values", async (context) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "agent-hub-runtime-json-semantics-"));
  context.after(() => rm(dataDir, { recursive: true, force: true }));
  const store = new RuntimeStateStore({ dataDir });

  await store.save({ sequence: 1, transient: Promise.resolve("completed") });

  assert.deepEqual(store.read(), { sequence: 1, transient: {} });
  await store.close();
});

test("runtime state omits only exact ledger-owned message projections", async (context) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "agent-hub-runtime-ledger-projection-"));
  context.after(() => rm(dataDir, { recursive: true, force: true }));
  const queued = messageCommandFixture({
    clientUserMessageId: "ledger-queued",
    itemId: "queued-item",
  });
  const pending = messageCommandFixture({
    clientUserMessageId: "ledger-pending",
    itemId: "pending-item",
  });
  const externalQueued = { id: "external-queued", clientUserMessageId: "external-queued" };
  const externalPending = { id: "external-pending", clientUserMessageId: "external-pending" };
  const externalReceipt = {
    clientUserMessageId: "external-receipt",
    fingerprint: "external-fingerprint",
    result: { accepted: true },
  };
  const store = new RuntimeStateStore({ dataDir });
  await store.saveDeferredIntake({ ...queued, destination: "queued" });
  await store.saveDeferredIntake({ ...pending, destination: "pending" });

  await store.save({
    marker: "preserved",
    pendingInputs: [pending.item, externalPending],
    queuedInputs: [queued.item, externalQueued],
    desktopMessageReceipts: [queued.receipt, pending.receipt, externalReceipt],
  });

  assert.deepEqual(readRawRuntimeState(dataDir), {
    marker: "preserved",
    pendingInputs: [externalPending],
    queuedInputs: [externalQueued],
    desktopMessageReceipts: [externalReceipt],
  });
  const restored = await readRuntimeState(dataDir);
  assert.deepEqual(new Set(restored.pendingInputs.map((item) => item.clientUserMessageId)), new Set([
    "external-pending",
    "ledger-pending",
  ]));
  assert.deepEqual(new Set(restored.queuedInputs.map((item) => item.clientUserMessageId)), new Set([
    "external-queued",
    "ledger-queued",
  ]));
  assert.deepEqual(new Set(restored.desktopMessageReceipts.map((receipt) => receipt.clientUserMessageId)), new Set([
    "external-receipt",
    "ledger-pending",
    "ledger-queued",
  ]));
  await store.close();
});

test("durable message intake survives full snapshots and same-id retries", async (context) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "agent-hub-runtime-intake-"));
  context.after(() => rm(dataDir, { recursive: true, force: true }));
  const { item, receipt } = messageCommandFixture();
  const store = new RuntimeStateStore({ dataDir });
  await store.save({ pendingInputs: [], queuedInputs: [], desktopMessageReceipts: [] });
  const first = await store.saveDeferredIntake({ item, destination: "queued", receipt });
  const retry = await store.saveDeferredIntake({ item, destination: "queued", receipt });
  assert.equal(first.duplicate, false);
  assert.equal(retry.duplicate, true);
  assert.equal(store.messageCommands().length, 1);
  assert.throws(() => store.saveDeferredIntake({
    item,
    destination: "queued",
    receipt: { ...receipt, fingerprint: "changed-fingerprint" },
  }), (error) => error.code === "MESSAGE_RECEIPT_FINGERPRINT_MISMATCH");
  await store.save({ pendingInputs: [], queuedInputs: [], desktopMessageReceipts: [] });
  await store.close();

  const restored = new RuntimeStateStore({ dataDir });
  const loaded = await restored.load();
  const [restoredQueuedItem] = loaded.value.queuedInputs;
  const {
    occupancyKey: restoredOccupancyKey,
    occupancyBinding: restoredOccupancyBinding,
    queueOrder: restoredQueueOrder,
    ...restoredLegacyFields
  } = restoredQueuedItem;
  assert.deepEqual(restoredLegacyFields, item);
  assert.equal(restoredOccupancyBinding, "exact");
  assert.match(restoredOccupancyKey, /\0thread-1$/u);
  assert.equal(Number.isFinite(restoredQueueOrder), true);
  assert.equal(loaded.value.desktopMessageReceipts[0].clientUserMessageId, item.clientUserMessageId);
  assert.equal(loaded.value.desktopMessageReceipts[0].result.queued, true);
  await restored.save({
    activeRuns: [],
    pendingInputs: [],
    queuedInputs: [{ ...item, dispatchingAt: "2026-08-24T06:00:01.000Z" }],
    desktopMessageReceipts: [receipt],
  });
  assert.equal(restored.messageCommands()[0].state, "dispatching");
  await restored.save({
    activeRuns: [{
      id: "run-1",
      turnId: "turn-1",
      clientUserMessageId: item.clientUserMessageId,
    }],
    pendingInputs: [],
    queuedInputs: [],
    desktopMessageReceipts: [{
      ...receipt,
      result: { accepted: true, runId: "run-1", turnId: "turn-1" },
    }],
  });
  assert.equal(restored.messageCommands()[0].state, "started");
  await restored.save({
    activeRuns: [],
    pendingInputs: [],
    queuedInputs: [],
    desktopMessageReceipts: [{
      ...receipt,
      result: { accepted: false, cancelled: true },
    }],
  });
  assert.deepEqual(readRawRuntimeState(dataDir), {
    activeRuns: [],
    pendingInputs: [],
    queuedInputs: [],
    desktopMessageReceipts: [],
  });
  await restored.close();

  const terminal = await readRuntimeState(dataDir);
  assert.deepEqual(terminal.pendingInputs, []);
  assert.deepEqual(terminal.queuedInputs, []);
  assert.equal(terminal.desktopMessageReceipts[0].result.cancelled, true);
});

test("message intake commits while a full runtime snapshot is blocked", async (context) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "agent-hub-runtime-intake-load-"));
  context.after(() => rm(dataDir, { recursive: true, force: true }));
  const store = new RuntimeStateStore({ dataDir });
  const releaseRuntimeLock = holdRuntimeWriteLock(dataDir);
  const fullSave = store.save({ sequence: 1, payload: "x".repeat(1_000_000) });
  const { item, receipt } = messageCommandFixture({ clientUserMessageId: "load-message" });

  let intakeOutcome;
  try {
    intakeOutcome = await Promise.race([
      store.saveDeferredIntake({ item, destination: "queued", receipt }).then(() => "committed"),
      new Promise((resolve) => setTimeout(() => resolve("blocked"), 250)),
    ]);
  } finally {
    releaseRuntimeLock();
  }

  assert.equal(intakeOutcome, "committed");
  await fullSave;
  await store.close();
});

test("legacy deferred intake is dual-read and migrated into the command ledger", async (context) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "agent-hub-runtime-intake-legacy-"));
  context.after(() => rm(dataDir, { recursive: true, force: true }));
  const { item, receipt } = messageCommandFixture({ clientUserMessageId: "legacy-message" });
  const database = new DatabaseSync(runtimeDatabasePath(dataDir));
  configureRuntimeDatabase(database);
  database.prepare(`
    INSERT INTO runtime_deferred_intake (
      id, destination, item_json, receipt_json, created_at, updated_at
    ) VALUES (?, 'queued', ?, ?, ?, ?)
  `).run(item.id, JSON.stringify(item), JSON.stringify(receipt), item.createdAt, item.createdAt);
  database.close();

  const store = new RuntimeStateStore({ dataDir });
  const loaded = await store.load();
  const [migratedItem] = loaded.value.queuedInputs;
  const { occupancyKey, occupancyBinding, queueOrder, ...legacyFields } = migratedItem;
  assert.deepEqual(legacyFields, item);
  assert.equal(occupancyBinding, "exact");
  assert.match(occupancyKey, /\0thread-1$/u);
  assert.equal(queueOrder, Date.parse(item.createdAt));
  assert.equal(store.messageCommands()[0].clientUserMessageId, "legacy-message");
  await store.save({ pendingInputs: [], queuedInputs: [], desktopMessageReceipts: [] });
  await store.close();

  const [restoredItem] = (await readRuntimeState(dataDir)).queuedInputs;
  assert.deepEqual(restoredItem, migratedItem);
});

