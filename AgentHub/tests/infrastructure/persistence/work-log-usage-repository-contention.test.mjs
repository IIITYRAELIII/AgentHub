import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { normalizePersistedWorkLog } from "../../../src/application/work-log-usage-projection.mjs";
import { JournalDatabase } from "../../../src/infrastructure/persistence/journal-database.mjs";
import { WorkLogUsageRepository } from "../../../src/infrastructure/persistence/work-log-usage-repository.mjs";

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-repository-contention-"));
  const databaseFile = path.join(root, "journal.sqlite");
  const journal = new JournalDatabase(databaseFile);
  const repository = new WorkLogUsageRepository({
    ledgerFile: path.join(root, "retired.json"), journalDatabase: journal,
    normalizePersisted: (persisted) => normalizePersistedWorkLog(persisted, { defaultProjectRoot: root }),
  });
  const changes = [];
  journal.onChange((change) => changes.push(change.type));
  let closed = false;
  t.after(async () => {
    if (!closed) await repository.close().catch(() => {});
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  const record = (turnId) => ({
    provider: "codex", threadId: "thread", taskThreadId: "thread", turnId, projectRoot: root,
    startedAt: "2026-09-12T09:59:00.000Z", completedAt: "2026-09-12T10:00:00.000Z",
    status: "completed", body: `Answer ${turnId}`,
  });
  // A second connection owning the SQLite write lock, as any other Hub store may.
  const lock = () => {
    const barrier = new DatabaseSync(databaseFile);
    barrier.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE");
    return () => { barrier.exec("COMMIT"); barrier.close(); };
  };
  return {
    root, databaseFile, journal, repository, changes, record, lock,
    key: (turnId) => `codex\0thread\0${turnId}`,
    has: async (turnId) => Boolean(await journal.getRecord({ provider: "codex", threadId: "thread", turnId })),
    locked: () => Object.assign(new Error("database is locked"), { code: "ERR_SQLITE_ERROR", errcode: 5 }),
    markClosed: () => { closed = true; },
  };
}

test("a record write waits out a foreign BEGIN IMMEDIATE and commits exactly once", async (t) => {
  const f = await fixture(t);
  const before = await f.journal.currentRevision();
  const release = f.lock();
  const saving = f.repository.saveRecord(f.key("turn-1"), f.record("turn-1"));
  saving.catch(() => {});
  await delay(300);
  release();
  const result = await saving;
  assert.equal(result.revision, before + 1);
  assert.equal(await f.journal.currentRevision(), before + 1);
  assert.deepEqual(f.changes, ["ledger"]);
  assert.ok(await f.has("turn-1"));
});

test("only contention that left no transaction is retried, and other failures are not", async (t) => {
  const f = await fixture(t);
  const before = await f.journal.currentRevision();
  const upsert = f.journal.upsertRecords.bind(f.journal);
  let calls = 0;
  f.journal.upsertRecords = (...args) => (++calls <= 2 ? Promise.reject(f.locked()) : upsert(...args));
  await f.repository.saveRecord(f.key("turn-1"), f.record("turn-1"));
  assert.equal(calls, 3);
  assert.equal(await f.journal.currentRevision(), before + 1);
  assert.deepEqual(f.changes, ["ledger"]);

  calls = 0;
  f.journal.upsertRecords = () => {
    calls += 1;
    return Promise.reject(Object.assign(new Error("Journal records changed before the metadata update"), {
      code: "JOURNAL_REVISION_CONFLICT",
    }));
  };
  await assert.rejects(f.repository.saveRecord(f.key("turn-2"), f.record("turn-2")), { code: "JOURNAL_REVISION_CONFLICT" });
  assert.equal(calls, 1);
  assert.equal(await f.journal.currentRevision(), before + 1);
  assert.deepEqual(f.changes, ["ledger"]);
});

test("an exhausted contention window advances neither revision nor record fingerprint", async (t) => {
  const f = await fixture(t);
  await f.journal.currentRevision();
  const before = f.repository.diagnostics().loadedRevision;
  const release = f.lock();
  try {
    await assert.rejects(f.repository.saveRecord(f.key("turn-1"), f.record("turn-1")), /database is locked/u);
  } finally {
    release();
  }
  assert.equal(f.repository.diagnostics().loadedRevision, before);
  assert.equal(await f.has("turn-1"), false);
  assert.deepEqual(f.changes, []);
  // An unadvanced fingerprint means the same record is written now, not skipped.
  const result = await f.repository.saveRecord(f.key("turn-1"), f.record("turn-1"));
  assert.equal(result.upserted, 1);
  assert.deepEqual(f.changes, ["ledger"]);
});

test("close waits for an accepted journal write before closing the database", async (t) => {
  const f = await fixture(t);
  await f.journal.currentRevision();
  const release = f.lock();
  const saving = f.repository.saveRecord(f.key("turn-1"), f.record("turn-1"));
  saving.catch(() => {});
  const closing = f.repository.close();
  f.markClosed();
  await delay(200);
  release();
  await saving;
  await closing;
  const reader = new DatabaseSync(f.databaseFile, { readOnly: true });
  try {
    assert.equal(reader.prepare("SELECT COUNT(*) AS count FROM journal_records").get().count, 1);
  } finally {
    reader.close();
  }
});

test("a ledger delta failing between its two transactions converges on retry with exact revisions", async (t) => {
  const f = await fixture(t);
  const apply = (mutate) => f.repository.enqueue(async () => {
    mutate(f.repository.ledger.turns);
    await f.repository.save();
  });
  await apply((turns) => { turns[f.key("old")] = f.record("old"); });
  const base = await f.journal.currentRevision();
  f.changes.length = 0;
  const remove = f.journal.deleteRecords.bind(f.journal);
  let failDelete = true;
  f.journal.deleteRecords = (...args) => {
    if (!failDelete) return remove(...args);
    failDelete = false;
    return Promise.reject(new Error("injected failure between the upsert and delete transactions"));
  };

  await assert.rejects(apply((turns) => {
    delete turns[f.key("old")];
    turns[f.key("new")] = f.record("new");
  }), /injected failure/u);
  // save() is two source transactions: the upsert committed, the delete did not.
  assert.equal(await f.has("new"), true);
  assert.equal(await f.has("old"), true);
  assert.equal(await f.journal.currentRevision(), base + 1);

  await f.repository.enqueue(() => f.repository.save());
  assert.equal(await f.has("new"), true);
  assert.equal(await f.has("old"), false);
  assert.equal(await f.journal.currentRevision(), base + 3);
  assert.deepEqual(f.changes, ["ledger", "ledger", "ledger"]);
});
