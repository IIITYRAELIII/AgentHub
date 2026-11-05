import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { once } from "node:events";
import test from "node:test";
import { SharedSqliteRecoveryCoordinator, SQLITE_RECOVERY_RESTART_REQUIRED } from "../../../src/infrastructure/persistence/shared-sqlite-recovery.mjs";
import { inspectSqliteFileInWorker } from "../../../src/infrastructure/persistence/shared-sqlite-inspection.mjs";

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hub-sqlite-inspection-"));
  const databaseFile = path.join(root, "journal.sqlite");
  const handles = [];
  t.after(async () => {
    for (const handle of handles) handle.close();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  const database = new DatabaseSync(databaseFile);
  database.exec("CREATE TABLE sample (id INTEGER PRIMARY KEY, value TEXT); INSERT INTO sample VALUES (1, 'original')");
  database.close();
  return { root, databaseFile, handles };
}

test("production inspection runs the full check in a worker while the caller remains responsive", async (t) => {
  const { root, databaseFile } = await fixture(t);
  const original = await fs.readFile(databaseFile);
  const phases = [];
  let heartbeat = false;
  const result = await new SharedSqliteRecoveryCoordinator({ databaseFile }).prepare({
    recordPhase: (phase) => {
      phases.push(phase);
      if (phase.phase === "inspection-query" && phase.outcome === "started") {
        setImmediate(() => { heartbeat = true; });
      }
    },
  });
  assert.deepEqual(result, { degraded: false });
  const check = phases.find(p => p.phase === "inspection-query" && p.outcome === "succeeded");
  assert.ok(check?.workerThreadId > 0, "the complete check must run outside the caller thread");
  assert.equal(heartbeat, true);
  assert.ok(check.checkMs >= 0);
  assert.ok(phases.some(p => p.phase === "database-lock"));
  const copy = phases.find(p => p.phase === "copy-database" && p.outcome === "succeeded");
  assert.equal(copy.bytes, original.length);
  assert.ok(phases.some(p => p.phase === "inspection-cleanup" && p.outcome === "succeeded"));
  assert.deepEqual(await fs.readFile(databaseFile), original);
  assert.deepEqual(await fs.readdir(root), ["journal.sqlite"]);
});

test("no prior healthy result skips a later corruption check", async (t) => {
  const { databaseFile } = await fixture(t);
  const recovery = new SharedSqliteRecoveryCoordinator({ databaseFile });
  await recovery.prepare();
  const previous = await fs.stat(databaseFile);
  await fs.writeFile(databaseFile, Buffer.alloc(previous.size, 0));
  await fs.utimes(databaseFile, previous.atime, previous.mtime);
  await assert.rejects(recovery.prepare(), (error) => error.code === SQLITE_RECOVERY_RESTART_REQUIRED);
});

test("worker checks committed WAL without reading or changing the mapped live SHM", async (t) => {
  const { root, databaseFile, handles } = await fixture(t);
  const database = new DatabaseSync(databaseFile);
  handles.push(database);
  database.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; INSERT INTO sample VALUES(2,'in WAL')");
  const files = [databaseFile, `${databaseFile}-wal`, `${databaseFile}-shm`];
  const before = await Promise.all(files.map((file) => fs.readFile(file)));
  let measurements;
  await new SharedSqliteRecoveryCoordinator({ databaseFile,
    fileSystem: { ...fs, copyFile: (source, destination) => {
      assert.notEqual(source, `${databaseFile}-shm`);
      return fs.copyFile(source, destination);
    } },
    inspectFile: async (file) => {
      assert.notEqual(path.dirname(file), root);
      const result = await inspectSqliteFileInWorker(file);
      measurements = result.measurements;
      const copy = new DatabaseSync(file, { readOnly: true });
      try { assert.equal(copy.prepare("SELECT value FROM sample WHERE id=2").get().value, "in WAL"); }
      finally { copy.close(); }
      return result;
    },
  }).prepare();
  assert.ok(measurements.workerThreadId > 0);
  assert.deepEqual(await Promise.all(files.map((file) => fs.readFile(file))), before);
});

test("malformed schema committed only in WAL is quarantined with the original cohort", async (t) => {
  const { databaseFile } = await fixture(t);
  const db = new DatabaseSync(databaseFile);
  let validMain;
  let corruptWal;
  try {
    db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; PRAGMA wal_checkpoint(TRUNCATE)");
    validMain = await fs.readFile(databaseFile);
    // Corruption injection is confined to this disposable fixture.
    db.enableDefensive(false);
    db.exec("PRAGMA writable_schema=ON; UPDATE sqlite_master SET sql='NOT VALID SQL' WHERE name='sample'");
    corruptWal = await fs.readFile(`${databaseFile}-wal`);
  } finally { db.close(); }
  await fs.writeFile(databaseFile, validMain);
  await fs.writeFile(`${databaseFile}-wal`, corruptWal);
  await assert.rejects(new SharedSqliteRecoveryCoordinator({ databaseFile }).prepare(),
    (error) => error.code === SQLITE_RECOVERY_RESTART_REQUIRED);
  const marker = JSON.parse(await fs.readFile(`${databaseFile}.recovery-marker.json`, "utf8"));
  assert.deepEqual(await fs.readFile(path.join(marker.quarantineDirectory, "journal.sqlite")), validMain);
  assert.deepEqual(await fs.readFile(path.join(marker.quarantineDirectory, "journal.sqlite-wal")), corruptWal);
});

for (const fault of ["copy", "check", "cleanup"]) test(`${fault} failure never becomes a corruption or ready result`, async (t) => {
  const { databaseFile } = await fixture(t);
  const original = await fs.readFile(databaseFile);
  const failure = new Error(`${fault} unavailable`);
  const fileSystem = { ...fs,
    copyFile: (...args) => fault === "copy" ? Promise.reject(failure) : fs.copyFile(...args),
    rm: (...args) => fault === "cleanup" ? Promise.reject(failure) : fs.rm(...args),
  };
  await assert.rejects(new SharedSqliteRecoveryCoordinator({ databaseFile, fileSystem,
    ...(fault === "check" ? { inspectFile: () => Promise.reject(failure) } : {}),
  }).prepare(), (error) => error === failure);
  assert.deepEqual(await fs.readFile(databaseFile), original);
  await assert.rejects(fs.stat(`${databaseFile}.recovery-marker.json`), { code: "ENOENT" });
  await assert.rejects(fs.stat(`${databaseFile}.recovery-intent.json`), { code: "ENOENT" });
});

for (const reply of [null, { result: { healthy: "yes" } }, { error: { message: "worker I/O error", code: "EIO" } }]) {
  test("a missing, malformed or failed worker reply cannot certify health", async () => {
    class FakeWorker extends EventEmitter {
      constructor() {
        super();
        setImmediate(() => { if (reply) this.emit("message", reply); this.emit("exit", 0); });
      }
    }
    await assert.rejects(inspectSqliteFileInWorker("detached.sqlite", { WorkerImpl: FakeWorker }),
      /without a result|invalid result|worker I\/O error/);
  });
}

test("a healthy reply cannot settle before worker exit and handle release", async () => {
  let worker;
  class FakeWorker extends EventEmitter { constructor() { super(); worker = this; } }
  let settled = false;
  const check = inspectSqliteFileInWorker("detached.sqlite", { WorkerImpl: FakeWorker }).then(() => { settled = true; });
  worker.emit("message", { result: { healthy: true } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  worker.emit("exit", 0);
  await check;
});

test("concurrent startup keeps the database lock until the checker has finished", async (t) => {
  const { databaseFile } = await fixture(t);
  let release;
  let started;
  const gate = new Promise((resolve) => { release = resolve; });
  const entered = new Promise((resolve) => { started = resolve; });
  let firstDone = false;
  let secondEntered = false;
  const first = new SharedSqliteRecoveryCoordinator({ databaseFile, inspectFile: async (file) => {
    started(); await gate; return inspectSqliteFileInWorker(file);
  } }).prepare().then((result) => { firstDone = true; return result; });
  await entered;
  const second = new SharedSqliteRecoveryCoordinator({ databaseFile, inspectFile: (file) => {
    secondEntered = true; assert.equal(firstDone, true); return inspectSqliteFileInWorker(file);
  } }).prepare();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(firstDone, false);
  assert.equal(secondEntered, false);
  release();
  assert.deepEqual(await first, { degraded: false });
  assert.deepEqual(await second, { degraded: false });
});

test("crash after the first quarantine move recovers the exact abandoned intent before restart", async (t) => {
  const { databaseFile } = await fixture(t);
  await fs.writeFile(databaseFile, "not a sqlite database", "utf8");
  await fs.writeFile(`${databaseFile}-wal`, "wal", "utf8");
  const moduleUrl = new URL("../../../src/infrastructure/persistence/shared-sqlite-recovery.mjs", import.meta.url).href;
  const source = `import * as fs from 'node:fs/promises'; import {SharedSqliteRecoveryCoordinator} from ${JSON.stringify(moduleUrl)};
    const file=${JSON.stringify(databaseFile)};
    await new SharedSqliteRecoveryCoordinator({databaseFile:file,fileSystem:{...fs,rename:async(a,b)=>{
      await fs.rename(a,b);if(a===file && b.includes('.quarantine-'))process.exit(77);
    }}}).prepare();`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", source], { stdio: "ignore", windowsHide: true });
  const [code] = await once(child, "exit");
  assert.equal(code, 77);
  const intent = JSON.parse(await fs.readFile(`${databaseFile}.recovery-intent.json`, "utf8"));
  assert.equal(intent.files[0].source, databaseFile);
  await assert.rejects(new SharedSqliteRecoveryCoordinator({ databaseFile, instanceId: "restart-b" }).prepare(),
    (error) => error.code === SQLITE_RECOVERY_RESTART_REQUIRED);
  await assert.rejects(fs.stat(`${databaseFile}.recovery-intent.json`), { code: "ENOENT" });
  const replacement = new SharedSqliteRecoveryCoordinator({ databaseFile, instanceId: "restart-c" });
  const recovered = await replacement.prepare();
  assert.equal(recovered.degraded, true);
  assert.equal(await replacement.acknowledge(recovered), true);
  const db = new DatabaseSync(databaseFile, { readOnly: true });
  try { assert.equal(db.prepare("PRAGMA quick_check").get().quick_check, "ok"); } finally { db.close(); }
});
