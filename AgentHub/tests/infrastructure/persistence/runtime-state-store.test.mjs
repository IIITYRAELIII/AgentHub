import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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
  store.close();

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
  store.save({ sequence: 1, activeRuns: [{ turnId: "one" }] });
  store.save({ sequence: 2, activeRuns: [] });
  assert.deepEqual(await readRuntimeState(dataDir), { sequence: 2, activeRuns: [] });
  store.close();
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
  store.save({ sequence: 1 });
  assert.deepEqual(store.read(), { sequence: 1 });
  store.close();

  assert.ok((await readdir(dataDir)).some((name) => name.startsWith("runtime.sqlite.corrupt-")));
  assert.deepEqual(await readRuntimeState(dataDir), { sequence: 1 });
});

