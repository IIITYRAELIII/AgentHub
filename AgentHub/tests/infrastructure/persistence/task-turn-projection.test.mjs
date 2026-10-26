import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { TaskBoardStore } from "../../../src/infrastructure/persistence/task-board-store.mjs";
import { JournalDatabase } from "../../../src/infrastructure/persistence/journal-database.mjs";

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "task-turn-projection-"));
  const databaseFile = path.join(directory, "journal.sqlite");
  let store = new TaskBoardStore({ databaseFile });
  const journal = new JournalDatabase(databaseFile);
  await journal.payload();
  const database = new DatabaseSync(databaseFile);
  const task = store.move(store.create({ text: "Task history" }).id,
    { bucket: "workspace", workspaceId: "workspace" });
  t.after(async () => {
    database.close(); store.close(); await journal.close();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    get store() { return store; }, database, task,
    reopen() { store.close(); store = new TaskBoardStore({ databaseFile }); },
    bind(turnId, operationId = turnId) {
      return store.claim(task.id, { workspaceId: "workspace", streamId: "stream",
        provider: "codex", threadId: "thread", turnId, operationId });
    },
    record(turnId, fields = {}, provider = "codex") {
      database.prepare("INSERT INTO journal_records "
        + "(provider,thread_id,turn_id,task_thread_id,project_root,completed_at_ms,changed_revision,record_json)"
        + " VALUES (?,?,?,?,?,?,?,?)").run(provider, "thread", turnId, "display-thread",
        directory, 1700000000000, 1, JSON.stringify({ title: "Summary", status: "completed", ...fields }));
    },
  };
}

test("Task history projection follows exact source and binding writes without board history reads", async t => {
  const f = await fixture(t);
  f.bind("turn");
  f.record("turn", { body: "private synthetic body ".repeat(100000) });
  f.bind("turn", "second-operation");
  f.record("foreign");
  assert.equal(f.store.task(f.task.id).workLog.length, 1);
  const before = f.store.list({ includeDetails: false }).find(x => x.id === f.task.id);
  assert.equal(before.detailsDeferred, true);
  assert.equal(Object.hasOwn(before, "workLog"), false);
  f.database.prepare("UPDATE journal_records SET record_json=?,changed_revision=2 WHERE turn_id='turn'")
    .run(JSON.stringify({ title: "Updated", status: "failed" }));
  assert.notEqual(f.store.task(f.task.id).detailsRevision, before.detailsRevision);
  assert.equal(f.store.task(f.task.id).workLog[0].summary, "Updated");
  assert.equal(f.store.task(f.task.id).workLog[0].status, "failed");
  // The retained projection remains usable even when the raw source is unavailable.
  f.database.exec("DROP TABLE journal_records");
  assert.equal(f.store.task(f.task.id).workLog[0].summary, "Updated");
  assert.equal(Object.hasOwn(f.store.list({ includeDetails: false })[0], "workLog"), false);
});

test("provisional corrections and exact binding removal retract projected membership", async t => {
  const f = await fixture(t);
  f.bind("turn");
  f.record("turn");
  assert.equal(f.store.task(f.task.id).workLog.length, 1);
  f.database.prepare("UPDATE journal_records SET record_json=?,changed_revision=2 WHERE turn_id='turn'")
    .run(JSON.stringify({ title: "Provisional", status: "completed", provisional: true }));
  assert.deepEqual(f.store.task(f.task.id).workLog, []);
  f.database.prepare("UPDATE journal_records SET record_json=?,changed_revision=3 WHERE turn_id='turn'")
    .run(JSON.stringify({ title: "Final", status: "cancelled" }));
  f.database.exec("DELETE FROM journal_records");
  assert.equal(f.store.task(f.task.id).workLog[0].status, "cancelled");
  f.database.exec("DELETE FROM hub_task_turn_bindings");
  assert.deepEqual(f.store.task(f.task.id).workLog, []);
});

test("legacy exact terminal rows migrate once when a writable Task store opens", async t => {
  const f = await fixture(t);
  const triggers = f.database.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'hub_task_turn_projection_%'").all();
  for (const { name } of triggers) f.database.exec('DROP TRIGGER "' + name + '"');
  f.database.exec("DROP TABLE hub_task_turn_projection; DROP TABLE hub_task_turn_projection_versions");
  f.bind("old");
  f.record("old", { title: "Retained old history" });
  f.reopen();
  assert.equal(f.store.task(f.task.id).workLog[0].summary, "Retained old history");
  assert.equal(f.database.prepare("SELECT count(*) AS n FROM hub_task_turn_projection").get().n, 1);
  f.reopen();
  assert.equal(f.database.prepare("SELECT count(*) AS n FROM hub_task_turn_projection").get().n, 1);
});
