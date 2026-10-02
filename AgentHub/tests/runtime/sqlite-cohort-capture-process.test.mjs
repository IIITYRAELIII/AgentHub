import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { COHORT_FILES } from "../../src/runtime/sqlite-cohort-snapshot.mjs";
import { captureSqliteCohortInProcess } from "../../src/runtime/sqlite-cohort-capture-process.mjs";

const blockedWorker = fileURLToPath(new URL("../fixtures/sqlite-capture-blocked-worker.mjs", import.meta.url));
async function fixture(t, suffix = "source") {
  const root = await mkdtemp(path.join(os.tmpdir(), "hub-capture-process-"));
  const sourceDataDirectory = path.join(root, suffix);
  const outputDirectory = path.join(root, "output");
  await mkdir(sourceDataDirectory);
  const writers = COHORT_FILES.map((name) => {
    const db = new DatabaseSync(path.join(sourceDataDirectory, name));
    db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=0; CREATE TABLE state(generation); INSERT INTO state VALUES(1)");
    return db;
  });
  t.after(async () => { writers.forEach((db) => db.close()); await rm(root, { recursive: true, force: true, maxRetries: 100, retryDelay: 50 }); });
  return { sourceDataDirectory, outputDirectory, writers };
}
function assertDead(pid) { assert.ok(pid > 0); assert.throws(() => process.kill(pid, 0), (error) => error.code === "ESRCH"); }
function checkpoint(db) { return db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get(); }

test("process-owned SQLite capture returns only after worker exit and completed hashes", { timeout: 5000 }, async (t) => {
  const fixtureData = await fixture(t);
  const queueDirectory = path.join(fixtureData.sourceDataDirectory, "delivery-outbox");
  await mkdir(queueDirectory);
  const queueBody = '{"deliveryId":"persistent-original","attempts":1}';
  await writeFile(path.join(queueDirectory, "delivery.json"), queueBody);
  const result = await captureSqliteCohortInProcess({ ...fixtureData, deadlineMs: 3000, includeQueueFiles: true });
  assert.equal(result.manifest.queueFiles.bytes, Buffer.byteLength(queueBody));
  assert.equal(await readFile(path.join(result.root, "queue-files", "delivery-outbox", "delivery.json"), "utf8"), queueBody);
  assert.equal(result.supervision.workerExitConfirmed, true);
  assert.equal(result.supervision.phase, "captured-raw");
  assertDead(result.supervision.workerPid);
  assert.equal(result.manifest.cohortConsistency, "simultaneously-pinned-read-transactions");
  assert.equal(result.manifest.bootable, false);
  assert.ok(result.manifest.databases.every((entry) => /^[a-f0-9]{64}$/.test(entry.sha256)));
  for (const name of COHORT_FILES) {
    const db = new DatabaseSync(path.join(result.dataDirectory, name), { readOnly: true });
    try { assert.equal(db.prepare("SELECT generation FROM state").get().generation, 1); } finally { db.close(); }
  }
});

test("hard deadline kills a blocked backup process and releases real WAL read pins before rejection", { timeout: 5000 }, async (t) => {
  const f = await fixture(t);
  let copyingObserved = false;
  let locked = null;
  let failureManifestFile;
  await assert.rejects(captureSqliteCohortInProcess({ ...f, deadlineMs: 500, terminationTimeoutMs: 1000,
    onProgress: (progress) => {
      if (progress.phase !== "copying") return;
      copyingObserved = true;
      for (const db of f.writers) db.exec("UPDATE state SET generation=2");
      locked = checkpoint(f.writers[0]).busy;
    },
  }, { workerEntry: blockedWorker }), (error) => {
    assert.equal(error.code, "CAPTURE_DEADLINE_EXCEEDED");
    assert.equal(error.supervision.workerExitConfirmed, true);
    assert.equal(error.supervision.phase, "failed");
    assert.equal(copyingObserved, true);
    assert.equal(locked, 1);
    assertDead(error.supervision.workerPid);
    for (const db of f.writers) assert.equal(checkpoint(db).busy, 0);
    failureManifestFile = error.manifestFile;
    return true;
  });
  const directory = path.join(path.dirname(failureManifestFile), "worker-output");
  const [captureRoot] = await readdir(directory);
  const manifest = JSON.parse(await readFile(path.join(directory, captureRoot, "snapshot-manifest.json"), "utf8"));
  assert.equal(manifest.phase, "failed");
  assert.equal(manifest.bootable, false);
  assert.equal(manifest.workerExitConfirmed, true);
});

test("large-file hashing remains inside the same hard process deadline", { timeout: 5000 }, async (t) => {
  const f = await fixture(t, "source-block-hash");
  let hashingObserved = false;
  await assert.rejects(captureSqliteCohortInProcess({ ...f, deadlineMs: 500, terminationTimeoutMs: 1000,
    onProgress: (progress) => { if (progress.phase === "hashing") hashingObserved = true; },
  }, { workerEntry: blockedWorker }), (error) => {
    assert.equal(hashingObserved, true);
    assert.equal(error.code, "CAPTURE_DEADLINE_EXCEEDED");
    assert.equal(error.supervision.workerExitConfirmed, true);
    assertDead(error.supervision.workerPid);
    return true;
  });
});

test("cancellation terminates a pinned worker without awaiting its event loop", { timeout: 5000 }, async (t) => {
  const f = await fixture(t);
  const abort = new AbortController();
  await assert.rejects(captureSqliteCohortInProcess({ ...f, deadlineMs: 3000, signal: abort.signal,
    onProgress: (progress) => { if (progress.phase === "copying") abort.abort(); },
  }, { workerEntry: blockedWorker }), (error) => {
    assert.equal(error.code, "CAPTURE_ABORTED");
    assert.equal(error.supervision.workerExitConfirmed, true);
    assertDead(error.supervision.workerPid);
    for (const db of f.writers) assert.equal(checkpoint(db).busy, 0);
    return true;
  });
});

test("worker failure is preserved and pre-cancelled capture starts no worker", { timeout: 5000 }, async (t) => {
  const f = await fixture(t);
  const abort = new AbortController(); abort.abort();
  await assert.rejects(captureSqliteCohortInProcess({ ...f, signal: abort.signal }), { code: "CAPTURE_ABORTED" });
  await assert.rejects(readdir(f.outputDirectory), { code: "ENOENT" });
  f.writers[0].exec("PRAGMA journal_mode=DELETE");
  await assert.rejects(captureSqliteCohortInProcess({ ...f, deadlineMs: 3000 }), (error) => {
    assert.equal(error.code, "CAPTURE_WORKER_FAILED");
    assert.match(error.message, /not WAL/);
    assert.equal(error.supervision.workerExitConfirmed, true);
    assertDead(error.supervision.workerPid);
    return true;
  });
});

test("reported failure cannot disarm the deadline while a worker still owns SQLite handles", { timeout: 5000 }, async (t) => {
  const f = await fixture(t, "source-reported-failure");
  await assert.rejects(captureSqliteCohortInProcess({ ...f, deadlineMs: 500, terminationTimeoutMs: 1000 }, { workerEntry: blockedWorker }), (error) => {
    assert.equal(error.code, "CAPTURE_WORKER_FAILED");
    assert.match(error.message, /reported failure/);
    assert.equal(error.supervision.workerExitConfirmed, true);
    assertDead(error.supervision.workerPid);
    for (const db of f.writers) assert.equal(checkpoint(db).busy, 0);
    return true;
  });
});
