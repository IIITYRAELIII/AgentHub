import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import { readMissingTestContourJournalRecords } from "../../../src/infrastructure/persistence/test-contour-journal-source.mjs";

function createJournal(file, records, { cloneAtMs = 0 } = {}) {
  const database = new DatabaseSync(file);
  database.exec(`
    CREATE TABLE journal_store_meta (key TEXT PRIMARY KEY, value TEXT) WITHOUT ROWID;
    CREATE TABLE journal_records (
      provider TEXT, thread_id TEXT, turn_id TEXT, project_root TEXT,
      task_thread_id TEXT, completed_at_ms INTEGER, record_json TEXT,
      PRIMARY KEY (provider, thread_id, turn_id)
    ) WITHOUT ROWID;
  `);
  if (cloneAtMs) {
    database.prepare("INSERT INTO journal_store_meta VALUES ('test_contour_clone_at_ms', ?)")
      .run(String(cloneAtMs));
  }
  const insert = database.prepare("INSERT INTO journal_records VALUES (?, ?, ?, ?, ?, ?, ?)");
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
    assert.equal(result.sourceRecords, 4);
    assert.equal(result.eligibleRecords, 3);
    assert.equal(result.cloneAtMs, cloneAtMs);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
