import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile, open } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { captureSqliteCohort, COHORT_FILES } from "../../src/runtime/sqlite-cohort-snapshot.mjs";

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "hub-cohort-test-"));
  const sourceDataDirectory = path.join(root, "source");
  const outputDirectory = path.join(root, "output");
  await mkdir(sourceDataDirectory);
  const writers = COHORT_FILES.map((name) => {
    const db = new DatabaseSync(path.join(sourceDataDirectory, name));
    db.exec("PRAGMA journal_mode=WAL; CREATE TABLE state (generation INTEGER); INSERT INTO state VALUES (1)");
    return db;
  });
  t.after(async () => { writers.forEach((db) => db.close()); await rm(root, { recursive: true, force: true }); });
  return { writers, sourceDataDirectory, outputDirectory };
}

function generation(file) { const db = new DatabaseSync(file, { readOnly: true }); try { return db.prepare("SELECT generation FROM state").get().generation; } finally { db.close(); } }

test("three pinned SQLite backups retain one committed cohort while WAL writers continue", async (t) => {
  const f = await fixture(t);
  const captured = await captureSqliteCohort({ ...f,
    onCohortPinned: () => { f.writers.forEach((db) => db.exec("UPDATE state SET generation=2")); },
  });
  for (const name of COHORT_FILES) {
    assert.equal(generation(path.join(captured.dataDirectory, name)), 1);
    assert.equal(generation(path.join(f.sourceDataDirectory, name)), 2);
  }
  assert.equal(captured.manifest.phase, "captured-raw");
  assert.equal(captured.manifest.bootable, false);
  assert.equal(captured.manifest.runtimeRecoveryParity, false);
  assert.equal(captured.manifest.databases.length, 3);
  assert.ok(captured.manifest.databases.every((db) => /^[a-f0-9]{64}$/.test(db.sha256)));
});

test("commit between read pins rejects mixed generations and repins the entire cohort", async (t) => {
  const f = await fixture(t);
  const captured = await captureSqliteCohort({ ...f,
    onPinnedDatabase: ({ index, attempt }) => { if (index === 0 && attempt === 1) f.writers.forEach((db) => db.exec("UPDATE state SET generation=2")); },
  });
  assert.equal(captured.manifest.pin.attempt, 2);
  for (const name of COHORT_FILES) assert.equal(generation(path.join(captured.dataDirectory, name)), 2);
});

test("persistent source churn exhausts bounded pin attempts without publishing a bootable bundle", async (t) => {
  const f = await fixture(t);
  let error;
  try { await captureSqliteCohort({ ...f, onPinnedDatabase: ({ index }) => { if (index === 0) f.writers[0].exec("UPDATE state SET generation=generation+1"); } }); }
  catch (caught) { error = caught; }
  assert.match(error.message, /No coherent SQLite/);
  const manifest = JSON.parse(await readFile(error.manifestFile, "utf8"));
  assert.equal(manifest.phase, "failed");
  assert.equal(manifest.bootable, false);
  assert.deepEqual(manifest.databases, []);
});

test("snapshot rejects output overlap with production data before creating capture", async (t) => {
  const f = await fixture(t);
  await assert.rejects(captureSqliteCohort({ ...f, outputDirectory: path.join(f.sourceDataDirectory, "snapshots") }), /cannot overlap/);
});

test("queue records retain exact bytes and identities across the pinned SQLite window", async (t) => {
  const f = await fixture(t);
  const body = Buffer.from('{"deliveryId":"original-delivery","attempts":2,"text":"Привет"}\n');
  const directory = path.join(f.sourceDataDirectory, "delivery-outbox");
  await mkdir(directory);
  await writeFile(path.join(directory, "original-delivery.json"), body);
  const captured = await captureSqliteCohort({ ...f, includeQueueFiles: true });
  const evidence = captured.manifest.queueFiles;
  assert.equal(evidence.consistency, "unchanged-across-sqlite-cohort-window");
  assert.equal(evidence.bytes, body.length);
  const record = evidence.directories.find((entry) => entry.name === "delivery-outbox").files[0];
  assert.equal(record.sha256, createHash("sha256").update(body).digest("hex"));
  assert.deepEqual(await readFile(path.join(captured.root, "queue-files", "delivery-outbox", record.name)), body);
  assert.deepEqual(await readFile(path.join(directory, record.name)), body);
  assert.equal(evidence.directories.find((entry) => entry.name === "background-jobs").absent, true);
  assert.equal(captured.manifest.bootable, false);
});

for (const change of ["update", "delete", "create-directory"]) {
  test(`queue ${change} during SQLite capture rejects the whole cohort and releases pins`, async (t) => {
    const f = await fixture(t);
    const directory = path.join(f.sourceDataDirectory, "delivery-outbox");
    const file = path.join(directory, "delivery.json");
    if (change !== "create-directory") {
      await mkdir(directory);
      await writeFile(file, '{"attempts":1}');
    }
    let failure;
    await assert.rejects(captureSqliteCohort({ ...f, includeQueueFiles: true, onCohortPinned: async () => {
      if (change === "delete") await rm(file);
      else {
        if (change === "create-directory") await mkdir(directory);
        await writeFile(file, '{"attempts":2}');
      }
    } }), (error) => { failure = error; return error.code === "COHORT_SIDECARS_CHANGED"; });
    const manifest = JSON.parse(await readFile(failure.manifestFile, "utf8"));
    assert.equal(manifest.phase, "failed");
    assert.equal(manifest.bootable, false);
    assert.equal(manifest.queueFiles, undefined);
    for (const db of f.writers) assert.equal(db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get().busy, 0);
  });
}

test("oversized queue evidence fails before allocation or publication", async (t) => {
  const f = await fixture(t);
  const directory = path.join(f.sourceDataDirectory, "background-jobs");
  await mkdir(directory);
  const handle = await open(path.join(directory, "oversized.json"), "w");
  try { await handle.truncate(32 * 1024 * 1024 + 1); } finally { await handle.close(); }
  await assert.rejects(captureSqliteCohort({ ...f, includeQueueFiles: true }), /byte budget exceeded/);
});
