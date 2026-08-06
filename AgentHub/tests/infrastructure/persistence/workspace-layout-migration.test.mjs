import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  applyWorkspaceLayout,
  planWorkspaceLayout,
} from "../../../src/infrastructure/persistence/workspace-layout-migration.mjs";

async function legacyDatabase(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-layout-"));
  const databaseFile = path.join(directory, "journal.sqlite");
  const database = new DatabaseSync(databaseFile);
  database.exec(`
    CREATE TABLE task_read_model_tasks (
      provider TEXT NOT NULL, thread_id TEXT NOT NULL, project_root TEXT NOT NULL,
      title TEXT NOT NULL, PRIMARY KEY(provider, thread_id)
    ) WITHOUT ROWID;
    CREATE TABLE journal_records (
      provider TEXT NOT NULL, thread_id TEXT NOT NULL, turn_id TEXT NOT NULL,
      project_root TEXT NOT NULL, task_thread_id TEXT NOT NULL,
      completed_at_ms INTEGER, record_json TEXT NOT NULL,
      PRIMARY KEY(provider, thread_id, turn_id)
    ) WITHOUT ROWID;
  `);
  database.prepare("INSERT INTO task_read_model_tasks VALUES (?, ?, ?, ?)")
    .run("codex", "known", "D:/repo", "Known");
  const insertRecord = database.prepare("INSERT INTO journal_records VALUES (?, ?, ?, ?, ?, ?, ?)");
  insertRecord.run("codex", "known", "turn-1", "D:/repo", "known", 1, "{}");
  insertRecord.run("codex", "child", "turn-2", "D:/repo", "known", 2, "{}");
  insertRecord.run("claude", "historic", "turn-3", "D:/repo", "historic", 3, "{}");
  database.close();
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, databaseFile };
}

const manifest = {
  version: 1,
  key: "test-layout",
  workspaces: [{
    name: "Agent HUB",
    streams: [{ name: null, threads: [{ provider: "codex", threadId: "known" }] }],
  }],
};

test("dry-run includes historical root Threads and excludes child execution Threads", async (t) => {
  const { databaseFile } = await legacyDatabase(t);
  const plan = planWorkspaceLayout({ databaseFile, manifest });
  assert.equal(plan.rootThreadCount, 2);
  assert.equal(plan.executingThreadCount, 3);
  assert.equal(plan.explicit.length, 1);
  assert.deepEqual(plan.automatic.map((item) => item.threadId), ["historic"]);
  assert.equal(plan.valid, true);
});

test("apply is atomic, backed up and idempotent", async (t) => {
  const { directory, databaseFile } = await legacyDatabase(t);
  const backupDirectory = path.join(directory, "backup");
  const first = await applyWorkspaceLayout({ databaseFile, manifest, backupDirectory });
  assert.equal(first.applied, true);
  assert.equal(first.audit.explicitCount, 1);
  assert.equal(first.audit.automaticExperimentsCount, 1);
  const second = await applyWorkspaceLayout({ databaseFile, manifest, backupDirectory });
  assert.equal(second.applied, false);
  assert.equal(second.reason, "unchanged");
  const database = new DatabaseSync(databaseFile, { readOnly: true });
  const rows = database.prepare(`
    SELECT w.name AS workspace_name, t.provider_thread_id
    FROM hub_threads t
    JOIN hub_streams s ON s.id = t.stream_id
    JOIN hub_workspaces w ON w.id = s.workspace_id
    ORDER BY t.provider_thread_id
  `).all().map((row) => ({ ...row }));
  database.close();
  assert.deepEqual(rows, [
    { workspace_name: "Experiments", provider_thread_id: "historic" },
    { workspace_name: "Agent HUB", provider_thread_id: "known" },
  ]);
});

test("changed manifest under the same migration key is rejected", async (t) => {
  const { directory, databaseFile } = await legacyDatabase(t);
  await applyWorkspaceLayout({ databaseFile, manifest, backupDirectory: path.join(directory, "one") });
  await assert.rejects(
    applyWorkspaceLayout({
      databaseFile,
      manifest: {
        ...manifest,
        workspaces: [{ ...manifest.workspaces[0], name: "Changed" }],
      },
      backupDirectory: path.join(directory, "two"),
    }),
    /another manifest/u,
  );
});
