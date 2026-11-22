import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import {
  readMissingTestContourJournalRecords, validateTestContourJournalCheckpoint,
  TEST_CONTOUR_RECORD_BYTES, TEST_CONTOUR_PAGE_BYTES,
} from "../../../src/infrastructure/persistence/test-contour-journal-source.mjs";

function createJournal(file, records, { cloneAtMs = 0 } = {}) {
  const database = new DatabaseSync(file);
  database.exec(`
    CREATE TABLE journal_store_meta (key TEXT PRIMARY KEY, value TEXT) WITHOUT ROWID;
    CREATE TABLE journal_records (
      provider TEXT, thread_id TEXT, turn_id TEXT, project_root TEXT,
      task_thread_id TEXT, completed_at_ms INTEGER, record_json TEXT,
      changed_revision INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (provider, thread_id, turn_id)
    ) WITHOUT ROWID;
    CREATE INDEX journal_records_changed_idx ON journal_records(changed_revision, provider, thread_id, turn_id);
    INSERT INTO journal_store_meta VALUES ('revision', '1');
  `);
  if (cloneAtMs) {
    database.prepare("INSERT INTO journal_store_meta VALUES ('test_contour_clone_at_ms', ?)")
      .run(String(cloneAtMs));
  }
  const insert = database.prepare("INSERT INTO journal_records(provider, thread_id, turn_id, project_root, task_thread_id, completed_at_ms, record_json) VALUES (?, ?, ?, ?, ?, ?, ?)");
  for (const record of records) {
    insert.run(
      record.provider,
      record.threadId,
      record.turnId,
      record.projectRoot ?? "D:/contour",
      record.taskThreadId ?? record.threadId,
      Date.parse(record.completedAt),
      JSON.stringify(record),
    );
  }
  database.close();
}

function record(turnId, {
  model = "gpt-5.6-terra",
  status = "completed",
  completedAt = "2026-08-25T10:00:01.000Z",
  provisional = false,
} = {}) {
  return {
    provider: "codex",
    threadId: `thread-${turnId}`,
    turnId,
    projectRoot: "D:/contour",
    model,
    status,
    provisional,
    completedAt,
  };
}

test("Test Contour journal source returns only new terminal Terra turns", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-hub-contour-journal-"));
  const sourceFile = path.join(root, "source.sqlite");
  const targetFile = path.join(root, "target.sqlite");
  const cloneAtMs = Date.parse("2026-08-25T10:00:00.000Z");
  createJournal(sourceFile, [
    record("cloned", { completedAt: "2026-08-25T09:59:59.000Z" }),
    record("terra-completed"),
    record("terra-aborted", { status: "aborted" }),
    record("terra-existing"),
    record("spark", { model: "gpt-5.3-codex-spark" }),
    record("provisional", { provisional: true }),
  ], { cloneAtMs });
  createJournal(targetFile, [record("terra-existing")]);
  try {
    const result = await readMissingTestContourJournalRecords({
      sourceDatabaseFile: sourceFile,
      targetDatabaseFile: targetFile,
    });
    assert.deepEqual(result.records.map(({ turnId }) => turnId), [
      "terra-aborted",
      "terra-completed",
    ]);
    assert.equal(result.sourceRecords, 6); // Inspected revision-page metadata, not a global eligible count.
    assert.equal(result.eligibleRecords, 3);
    assert.equal(result.cloneAtMs, cloneAtMs);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function pageFixture(run, values = []) {
  const root = await mkdtemp(path.join(process.env.AGENT_HUB_TEST_TEMP_ROOT || tmpdir(), "agent-hub-contour-regression-"));
  const sourceDatabaseFile = path.join(root, "source.sqlite");
  const targetDatabaseFile = path.join(root, "target.sqlite");
  createJournal(sourceDatabaseFile, values);
  createJournal(targetDatabaseFile, []);
  try { await run({ sourceDatabaseFile, targetDatabaseFile }); }
  finally { await rm(root, { recursive: true, force: true }); }
}

function update(file, value, { rollback = false } = {}) {
  const database = new DatabaseSync(file);
  try {
    database.exec("BEGIN IMMEDIATE");
    database.exec("UPDATE journal_store_meta SET value = CAST(value AS INTEGER) + 1 WHERE key = 'revision'");
    const revision = Number(database.prepare("SELECT value FROM journal_store_meta WHERE key = 'revision'").get().value);
    database.prepare(`INSERT INTO journal_records VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(provider, thread_id, turn_id) DO UPDATE SET
        completed_at_ms = excluded.completed_at_ms, record_json = excluded.record_json,
        changed_revision = excluded.changed_revision`).run(value.provider, value.threadId, value.turnId,
      value.projectRoot, value.threadId, Date.parse(value.completedAt), JSON.stringify(value), revision);
    database.exec(rollback ? "ROLLBACK" : "COMMIT");
  } finally { database.close(); }
}

test("contour revision windows catch late timestamps and eligibility updates without reimporting target identities", async () => {
  await pageFixture(async (options) => {
    let page = await readMissingTestContourJournalRecords(options);
    assert.equal(page.records.length, 0);
    update(options.sourceDatabaseFile, record("pending", { provisional: false, status: "failed" }));
    update(options.sourceDatabaseFile, record("late", { completedAt: "2020-01-01T00:00:00Z" }));
    update(options.sourceDatabaseFile, record("rolled-back"), { rollback: true });
    page = await readMissingTestContourJournalRecords({ ...options, checkpoint: page.nextCheckpoint });
    assert.deepEqual(page.records.map((value) => value.turnId), ["pending", "late"]);
    const target = new DatabaseSync(options.targetDatabaseFile);
    target.prepare("INSERT INTO journal_records VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run("codex", "thread-pending", "pending", "", "thread-pending", 1, JSON.stringify(record("pending")), 1);
    target.close();
    update(options.sourceDatabaseFile, { ...record("pending"), body: "richer source must not overwrite production" });
    const changed = await readMissingTestContourJournalRecords({ ...options, checkpoint: page.nextCheckpoint });
    assert.equal(changed.sourceRecords, 1);
    assert.deepEqual(changed.records, []);
    assert.equal(changed.targetLookups, 1);
  }, [record("pending", { provisional: true })]);
});

test("contour fixed upper window and tuple cursor survive same-revision paging and later updates", async () => {
  await pageFixture(async (options) => {
    const first = await readMissingTestContourJournalRecords({ ...options, pageSize: 1 });
    update(options.sourceDatabaseFile, record("000")); // earlier key, later revision
    update(options.sourceDatabaseFile, record("b", { status: "failed" })); // unread row moved above upper
    const seen = [...first.records];
    let page = first;
    while (page.hasMore) {
      page = await readMissingTestContourJournalRecords({ ...options, pageSize: 1, checkpoint: page.nextCheckpoint });
      seen.push(...page.records);
    }
    const later = await readMissingTestContourJournalRecords({ ...options, checkpoint: page.nextCheckpoint });
    seen.push(...later.records);
    assert.deepEqual(seen.map((value) => value.turnId), ["a", "c", "000", "b"]);
  }, [record("a"), record("b"), record("c")]);
});

test("contour eligibility retains SQL-era model/status/provisional filter semantics", async () => {
  await pageFixture(async (options) => {
    const result = await readMissingTestContourJournalRecords(options);
    assert.deepEqual(result.records.map((value) => value.turnId), ["valid"]);
  }, [record("valid"), record("string-false", { provisional: "false" }),
    record("numeric-one", { provisional: 1 }), record("model-space", { model: " gpt-5.6-terra" }),
    record("status-space", { status: "completed " })]);
});

test("contour initial cursor includes revision zero and subsequent empty window excludes that revision", async () => {
  await pageFixture(async (options) => {
    const source = new DatabaseSync(options.sourceDatabaseFile);
    source.exec("UPDATE journal_records SET changed_revision=0; UPDATE journal_store_meta SET value='0' WHERE key='revision'");
    source.close();
    const first = await readMissingTestContourJournalRecords(options);
    assert.equal(first.records.length, 1);
    const next = await readMissingTestContourJournalRecords({ ...options, checkpoint: first.nextCheckpoint });
    assert.equal(next.sourceRecords, 0);
    assert.equal(next.recordBytes, 0);
  }, [record("a")]);
});

test("contour clone generation, rollback and explicit target reset invalidate stale checkpoints", async () => {
  await pageFixture(async (options) => {
    const first = await readMissingTestContourJournalRecords(options);
    const source = new DatabaseSync(options.sourceDatabaseFile);
    source.prepare("INSERT INTO journal_store_meta VALUES ('test_contour_clone_at_ms', ?)").run("1");
    source.close();
    await assert.rejects(validateTestContourJournalCheckpoint({ ...options, nextCheckpoint: first.nextCheckpoint }), /generation changed/);
    const clone = await readMissingTestContourJournalRecords({ ...options, checkpoint: first.nextCheckpoint });
    assert.equal(clone.records.length, 1);
    update(options.sourceDatabaseFile, record("later"));
    const advanced = await readMissingTestContourJournalRecords({ ...options, checkpoint: clone.nextCheckpoint });
    const rollback = new DatabaseSync(options.sourceDatabaseFile);
    rollback.exec("DELETE FROM journal_records WHERE turn_id = 'later'; UPDATE journal_store_meta SET value = '1' WHERE key = 'revision'");
    rollback.close();
    assert.equal((await readMissingTestContourJournalRecords({ ...options, checkpoint: advanced.nextCheckpoint })).records.length, 1);
    const target = new DatabaseSync(options.targetDatabaseFile);
    target.exec("INSERT INTO journal_store_meta VALUES ('journal_ingest_reset_revision', '2')");
    target.close();
    assert.equal((await readMissingTestContourJournalRecords({ ...options, checkpoint: clone.nextCheckpoint })).records.length, 1);
  }, [record("a")]);
});

test("contour byte budget pages exactly, oversized records fail without advancing and legacy schema is explicit", async () => {
  const values = Array.from({ length: 6 }, (_, index) => ({ ...record(String(index)), body: "x".repeat(2 * 1024 * 1024 - 1024) }));
  await pageFixture(async (options) => {
    const first = await readMissingTestContourJournalRecords(options);
    assert.ok(first.recordBytes <= TEST_CONTOUR_PAGE_BYTES);
    assert.equal(first.records.length, 4);
    assert.equal(first.hasMore, true);
    const second = await readMissingTestContourJournalRecords({ ...options, checkpoint: first.nextCheckpoint });
    assert.equal(second.records.length, 2);
    update(options.sourceDatabaseFile, { ...record("oversized"), body: "x".repeat(TEST_CONTOUR_RECORD_BYTES) });
    await assert.rejects(readMissingTestContourJournalRecords({ ...options, checkpoint: second.nextCheckpoint }), { code: "TEST_CONTOUR_RECORD_TOO_LARGE" });
    const legacy = new DatabaseSync(options.sourceDatabaseFile);
    legacy.exec("DROP INDEX journal_records_changed_idx");
    legacy.close();
    await assert.rejects(readMissingTestContourJournalRecords(options), { code: "TEST_CONTOUR_REVISION_SCHEMA_REQUIRED" });
  }, values);
});

test("bounded contour pages finish an initial window and unchanged reads hydrate nothing", async () => {
  const root = await mkdtemp(path.join(process.env.AGENT_HUB_TEST_TEMP_ROOT || tmpdir(), "agent-hub-contour-page-"));
  const sourceDatabaseFile = path.join(root, "source.sqlite");
  const targetDatabaseFile = path.join(root, "target.sqlite");
  const values = Array.from({ length: 19 }, (_, index) => record(String(index).padStart(3, "0")));
  createJournal(sourceDatabaseFile, values);
  createJournal(targetDatabaseFile, []);
  try {
    let checkpoint = "";
    const imported = [];
    let result;
    do {
      result = await readMissingTestContourJournalRecords({ sourceDatabaseFile, targetDatabaseFile, checkpoint, pageSize: 4 });
      assert.ok(result.sourceRecords <= 4);
      assert.ok(result.targetLookups <= 4);
      imported.push(...result.records);
      checkpoint = result.nextCheckpoint;
    } while (result.hasMore);
    assert.deepEqual(imported, values);
    const idle = await readMissingTestContourJournalRecords({ sourceDatabaseFile, targetDatabaseFile, checkpoint });
    assert.equal(idle.sourceRecords, 0);
    assert.equal(idle.targetLookups, 0);
    assert.equal(idle.recordBytes, 0);
    assert.equal(idle.nextCheckpoint, checkpoint);
  } finally { await rm(root, { recursive: true, force: true }); }
});
