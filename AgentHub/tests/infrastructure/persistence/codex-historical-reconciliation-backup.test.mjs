import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  backupCodexHistoricalReconciliation,
} from "../../../src/infrastructure/persistence/codex-historical-reconciliation-backup.mjs";

test("Codex historical reconciliation creates a readable SQLite backup", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-codex-reconciliation-"));
  try {
    const databaseFile = path.join(root, "journal.sqlite");
    const database = new DatabaseSync(databaseFile);
    database.exec("CREATE TABLE journal_records (id INTEGER PRIMARY KEY, value TEXT)");
    database.prepare("INSERT INTO journal_records (value) VALUES (?)").run("before-reconciliation");
    database.close();

    const result = await backupCodexHistoricalReconciliation({
      databaseFile,
      backupRoot: path.join(root, "migrations"),
      now: new Date("2026-08-25T01:00:00.000Z"),
    });

    assert.equal(result.applied, true);
    assert.equal((await stat(result.backupFile)).isFile(), true);
    const copy = new DatabaseSync(result.backupFile, { readOnly: true });
    assert.equal(
      copy.prepare("SELECT value FROM journal_records").get().value,
      "before-reconciliation",
    );
    copy.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
