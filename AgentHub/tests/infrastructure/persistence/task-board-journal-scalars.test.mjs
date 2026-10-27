import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { JournalDatabase } from "../../../src/infrastructure/persistence/journal-database.mjs";
import { TaskBoardStore } from "../../../src/infrastructure/persistence/task-board-store.mjs";

test("Task board projects exact terminal scalars from large journal records without changing admission", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "task-board-journal-scalars-"));
  const databaseFile = path.join(directory, "journal.sqlite");
  const journal = new JournalDatabase(databaseFile);
  const store = new TaskBoardStore({ databaseFile });
  await journal.payload();
  const database = new DatabaseSync(databaseFile);
  t.after(async () => {
    database.close(); store.close(); await journal.close();
    await rm(directory, { recursive: true, force: true });
  });
  const task = store.move(store.create({ text: "Scalar projection" }).id, {
    bucket: "workspace", workspaceId: "workspace",
  });
  const insert = database.prepare(`INSERT INTO journal_records
    (provider, thread_id, turn_id, project_root, task_thread_id, completed_at_ms, record_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);
  const bind = (turnId, operationId = turnId) => store.claim(task.id, {
    workspaceId: "workspace", streamId: "stream", provider: "codex",
    threadId: "thread", turnId, operationId,
  });
  const add = (turnId, fields, { provider = "codex", completedAt = 1_700_000_000_000, raw } = {}) => {
    bind(turnId);
    insert.run(provider, "thread", turnId, directory, "task-thread", completedAt,
      raw ?? JSON.stringify({ title: turnId, status: "completed", ...fields }));
  };
  const longTitle = "🪐Т".repeat(1100);
  add("large", { title: longTitle, body: "private body ".repeat(100_000), status: "failed" });
  bind("large", "same-turn-second-claim");
  add("missing-flags", {});
  add("zero-flags", { provisional: 0, aggregateOnly: 0, status: "cancelled" });
  add("false-flags", { provisional: false, aggregateOnly: false, status: "interrupted" });
  add("null-flags", { provisional: null, aggregateOnly: null, title: 123 });
  add("provisional", { provisional: true });
  add("aggregate", { aggregateOnly: 1 });
  add("string-zero", { provisional: "0" });
  add("nonterminal", { status: "running" });
  add("no-terminal-time", {}, { completedAt: null });
  add("foreign-provider", {}, { provider: "claude" });
  add("malformed", {}, { raw: "{broken" });
  const expectedIds = ["false-flags", "large", "missing-flags", "null-flags", "zero-flags"];
  const project = () => store.task(task.id).workLog;
  const beforeRevision = store.snapshotRevision;
  let log = project();
  assert.deepEqual(log.map((entry) => entry.turnId), expectedIds);
  assert.equal(log.find((entry) => entry.turnId === "large").summary, [...longTitle].slice(0, 2000).join(""));
  assert.equal(log.find((entry) => entry.turnId === "null-flags").summary, "123");
  assert.ok(log.every((entry) => entry.taskThreadId === "task-thread" && entry.changedFiles.length === 0));
  assert.equal(JSON.stringify(log).includes("private body"), false);
  assert.deepEqual(store.list().find((entry) => entry.id === task.id).workLog, log);
  assert.equal(store.snapshotRevision, beforeRevision);
  database.prepare(`UPDATE journal_records SET record_json = ?
    WHERE provider = 'codex' AND thread_id = 'thread' AND turn_id = 'large'`)
    .run(JSON.stringify({ title: "Fresh title", status: "completed", provisional: false }));
  log = project();
  assert.equal(log.find((entry) => entry.turnId === "large").summary, "Fresh title");
  assert.equal(log.find((entry) => entry.turnId === "large").status, "completed");
  assert.deepEqual(store.list().find((entry) => entry.id === task.id).workLog, log);
});
