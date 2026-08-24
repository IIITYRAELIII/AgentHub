import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  readRuntimeState,
  runtimeDatabasePath,
  RuntimeStateStore,
} from "../../../src/infrastructure/persistence/runtime-state-store.mjs";

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

test("deferred message intake survives before the next full runtime snapshot", async (context) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "agent-hub-runtime-intake-"));
  context.after(() => rm(dataDir, { recursive: true, force: true }));
  const item = {
    id: "deferred-1",
    provider: "codex",
    threadId: "thread-1",
    clientUserMessageId: "client-message-1",
    conflictKind: "message-intake",
    createdAt: "2026-08-24T06:00:00.000Z",
  };
  const receipt = {
    provider: "codex",
    threadId: "thread-1",
    clientUserMessageId: "client-message-1",
    fingerprint: "fingerprint-1",
    result: { deferred: true, id: "deferred-1" },
    createdAt: "2026-08-24T06:00:00.000Z",
  };
  const store = new RuntimeStateStore({ dataDir });
  await store.save({ pendingInputs: [], queuedInputs: [], desktopMessageReceipts: [] });
  await store.saveDeferredIntake({ item, destination: "queued", receipt });
  await store.close();

  const restored = new RuntimeStateStore({ dataDir });
  const loaded = await restored.load();
  assert.deepEqual(loaded.value.queuedInputs, [item]);
  assert.deepEqual(loaded.value.desktopMessageReceipts, [receipt]);
  await restored.save({ pendingInputs: [], queuedInputs: [], desktopMessageReceipts: [] });
  await restored.close();

  assert.deepEqual(await readRuntimeState(dataDir), {
    pendingInputs: [],
    queuedInputs: [],
    desktopMessageReceipts: [],
  });
});

