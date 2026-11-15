import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { TaskBoardStore } from "../../../src/infrastructure/persistence/task-board-store.mjs";
import { JournalDatabase } from "../../../src/infrastructure/persistence/journal-database.mjs";
import { TaskBoardService } from "../../../src/application/task-board-service.mjs";
import { DesktopTaskBoardController } from "../../../src/interfaces/desktop/desktop-task-board-controller.mjs";
import { configureClaimCustodyNamespaceFences, claimCustodyTaskSnapshot } from "../../../src/infrastructure/persistence/claim-custody-fence.mjs";

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

test("canonical journal corrections maintain derived history without releasing Task custody", async t => {
  const f = await fixture(t);
  f.bind("turn");
  f.record("turn");
  f.database.exec(`CREATE TABLE hub_mcp_operations(request_id TEXT PRIMARY KEY, claim_custody_json TEXT,
    claim_custody_write_json TEXT, result_json TEXT, receipt_state TEXT, tool_name TEXT,
    workspace_id TEXT, stream_id TEXT, provider TEXT, provider_thread_id TEXT, arguments_hash TEXT);
    INSERT INTO hub_mcp_operations(request_id,receipt_state) VALUES('original','unknown');`);
  const state = { version: 1, kind: "claim-forward-custody-v1", phase: "fenced", requestId: "fence",
    argumentsHash: "hash", workspaceId: "workspace", actorStreamId: "rm", actorThreadId: "rm-thread",
    actorProvider: "codex", original: { requestId: "original", toolName: "hub_task_claim" },
    taskId: f.task.id, taskRevision: 1, successorClaimRequestId: "successor",
    successorArgumentsHash: "a".repeat(64), source: {}, envelope: {}, namespace: { epoch: "epoch" } };
  configureClaimCustodyNamespaceFences(f.database);
  f.database.prepare(`INSERT INTO hub_mcp_operations(request_id,claim_custody_json,tool_name,
    workspace_id,stream_id,provider,provider_thread_id,arguments_hash) VALUES(?,?,?,?,?,?,?,?)`)
    .run("fence", JSON.stringify(state), "hub_task_operation_reconcile", "workspace", "rm", "codex", "rm-thread", "hash");
  const before = f.database.prepare("SELECT * FROM hub_board_tasks WHERE id=?").get(f.task.id);
  const binding = f.database.prepare("SELECT * FROM hub_task_turn_bindings").all();
  const snapshot = claimCustodyTaskSnapshot(f.database, f.task.id);
  const original = f.database.prepare("SELECT * FROM hub_mcp_operations WHERE request_id='original'").get();
  const journal = new JournalDatabase(f.database.location());
  try {
  await journal.upsertRecords([{ provider: "codex", threadId: "thread", turnId: "turn",
    taskThreadId: "display-thread", projectRoot: "synthetic", completedAt: "2026-10-30T12:00:00Z",
    title: "Canonical correction", status: "completed" }]);
  assert.equal(f.store.task(f.task.id).workLog[0].summary, "Canonical correction");
  assert.deepEqual(f.database.prepare("SELECT * FROM hub_board_tasks WHERE id=?").get(f.task.id), before);
  assert.deepEqual(f.database.prepare("SELECT * FROM hub_task_turn_bindings").all(), binding);
  assert.notEqual(claimCustodyTaskSnapshot(f.database, f.task.id).hash, snapshot.hash);
  assert.deepEqual(f.database.prepare("SELECT * FROM hub_mcp_operations WHERE request_id='original'").get(), original);
  assert.equal(f.database.prepare("SELECT claim_custody_write_json AS permit FROM hub_mcp_operations WHERE request_id='fence'").get().permit, null);
  assert.throws(() => f.database.prepare("UPDATE hub_board_tasks SET updated_at_ms=updated_at_ms+1 WHERE id=?").run(f.task.id), /namespace authority/);
  assert.throws(() => f.database.prepare("DELETE FROM hub_task_turn_projection WHERE task_id=?").run(f.task.id), /namespace authority/);
  assert.throws(() => f.database.prepare("UPDATE journal_records SET changed_revision=99 WHERE turn_id='turn'").run(), /namespace authority/);
  for (const sql of [
    "UPDATE hub_task_turn_projection SET source_revision=source_revision+1 WHERE task_id=?",
    "INSERT OR REPLACE INTO hub_task_turn_projection SELECT * FROM hub_task_turn_projection WHERE task_id=?",
    "UPDATE hub_task_turn_projection_versions SET revision=revision+1 WHERE task_id=?",
    "DELETE FROM hub_task_turn_projection_versions WHERE task_id=?",
    "INSERT OR REPLACE INTO hub_task_turn_projection_versions SELECT * FROM hub_task_turn_projection_versions WHERE task_id=?",
  ]) assert.throws(() => f.database.prepare(sql).run(f.task.id), /namespace authority/);
  const record = await journal.getRecord({ provider: "codex", threadId: "thread", turnId: "turn" });
  const revision = await journal.currentRevision();
  await assert.rejects(journal.upsertRecords([{ ...record, title: "Stale correction" }],
    { expectedRevision: revision + 1 }), { code: "JOURNAL_REVISION_CONFLICT" });
  f.database.exec(`CREATE TRIGGER injected_journal_failure AFTER UPDATE ON journal_records
    BEGIN SELECT RAISE(ABORT, 'injected journal failure'); END`);
  await assert.rejects(journal.upsertRecords([{ ...record, title: "Uncommitted correction" }]), /injected journal failure/);
  assert.equal(await journal.currentRevision(), revision);
  assert.deepEqual(await journal.getRecord({ provider: "codex", threadId: "thread", turnId: "turn" }), record);
  assert.equal(f.database.prepare("SELECT claim_custody_write_json AS permit FROM hub_mcp_operations WHERE request_id='fence'").get().permit, null);
  f.database.exec("DROP TRIGGER injected_journal_failure");
  await journal.close();
  const reopened = new JournalDatabase(f.database.location());
  try {
    await reopened.upsertRecords([{ ...record, title: "Reopened correction" }]);
    assert.equal(f.store.task(f.task.id).workLog[0].summary, "Reopened correction");
    await reopened.deleteRecords({ provider: "codex", threadId: "thread", turnId: "turn" });
    assert.equal(f.store.task(f.task.id).workLog[0].summary, "Reopened correction");
  } finally { await reopened.close(); }
  } finally { await journal.close(); }
});

test("lazy Task read preserves canonical attachment descriptors without exposing source paths", async t => {
  const f = await fixture(t);
  const raw = f.store.create({ text: "Attachment card",
    sourceDetails: { attachments: [path.join(os.tmpdir(), "synthetic", "screenshot.jpg")] } });
  const workspaceCatalog = { hierarchy: () => [] };
  const taskBoard = new TaskBoardService({ store: f.store, workspaceCatalog });
  const card = taskBoard.snapshot().find(value => value.id === raw.id);
  assert.deepEqual(card.attachments, [{ id: "screenshot.jpg", name: "screenshot.jpg",
    type: "image/jpeg", isImage: true }]);
  const controller = new DesktopTaskBoardController({ taskBoard, workspaceCatalog, taskLauncher: {} });
  const { task } = await controller.read({ id: raw.id });
  assert.equal(task.id, card.id);
  assert.equal(task.detailsRevision, card.detailsRevision);
  assert.deepEqual(task.attachments, card.attachments);
  assert.equal(Object.hasOwn(task.sourceDetails, "attachments"), false);
  assert.equal(Object.hasOwn(task, "workLog"), true);
  assert.equal(Object.hasOwn(card, "workLog"), false);
});

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
