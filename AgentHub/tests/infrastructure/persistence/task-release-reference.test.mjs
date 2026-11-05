import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { TaskBoardStore } from "../../../src/infrastructure/persistence/task-board-store.mjs";

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hub-release-reference-"));
  const databaseFile = path.join(directory, "runtime.sqlite");
  const store = new TaskBoardStore({ databaseFile });
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  const create = (text, workspaceId = "workspace-one") => store.create({
    text, workspaceId, bucket: "workspace", taskPrefix: "HUB", triageStatus: "disabled",
  });
  const update = (task, operation, requestId, values = {}) => store.updateChecklist({
    id: task.id, operation, expectedRevision: task.revision, requestId, ...values,
  });
  const child = create("Accepted result");
  const refs = [{ projectRoot: path.resolve(directory, "source"), branch: child.taskNumber,
    resultCommit: "a".repeat(40) }];
  const db = new DatabaseSync(databaseFile);
  db.prepare("UPDATE hub_board_tasks SET workflow_status = 'awaiting_implementation' WHERE id = ?").run(child.id);
  db.prepare(`INSERT INTO hub_task_git_references
    (task_id, project_root, branch, result_commit, updated_at_ms) VALUES (?, ?, ?, ?, 1)`)
    .run(child.id, refs[0].projectRoot, refs[0].branch, refs[0].resultCommit);
  db.close();
  return { databaseFile, store, create, update, child: store.task(child.id), refs };
}

test("release references retain archived ownership and bind the exact accepted result across reopen", async (t) => {
  const f = await fixture(t);
  const old = await f.update(f.create("Old release"), "add", "old-add", { text: "Accepted task" });
  await f.update(old.task, "link", "old-link", { itemId: old.itemId, linkedTaskId: f.child.id });
  const db = new DatabaseSync(f.databaseFile);
  db.prepare("UPDATE hub_board_tasks SET status = 'done' WHERE id = ?").run(old.task.id);
  const archived = f.store.task(old.task.id);
  const raw = db.prepare("SELECT * FROM hub_task_checklist_items WHERE task_id = ?").all(old.task.id);
  const childBefore = f.store.task(f.child.id);
  const added = await f.update(f.create("Next release"), "add", "new-add", { text: "Same accepted result" });
  const binding = { taskRevision: f.child.revision, gitReferences: f.refs };
  const payload = { itemId: added.itemId, linkedTaskId: f.child.id, releaseReference: binding };
  const first = await f.update(added.task, "link", "new-reference", payload);
  assert.equal(first.task.checklist[0].linkedTaskId, f.child.id);
  assert.deepEqual(first.task.checklist[0].releaseReference, { ...binding, taskRevision: String(binding.taskRevision) });
  assert.deepEqual(f.store.task(old.task.id), archived);
  assert.deepEqual(f.store.task(f.child.id), childBefore);
  assert.deepEqual(db.prepare("SELECT * FROM hub_task_checklist_items WHERE task_id = ?").all(old.task.id), raw);
  db.close();
  f.store.close();
  const reopened = new TaskBoardStore({ databaseFile: f.databaseFile });
  try {
    const replay = await reopened.updateChecklist({ id: added.task.id, operation: "link",
      expectedRevision: added.task.revision, requestId: "new-reference", ...payload });
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.task.checklist, first.task.checklist);
    assert.equal(reopened.task(f.child.id).checklistParent.task.id, old.task.id);
    assert.throws(() => reopened.updateChecklist({ id: added.task.id, operation: "link",
      expectedRevision: added.task.revision, requestId: "new-reference", ...payload,
      releaseReference: { ...binding, gitReferences: [{ ...f.refs[0], resultCommit: "b".repeat(40) }] } }), /request id/u);
  } finally { reopened.close(); }
});

test("release references reject stale identities, nonaccepted results, ownership replacement and foreign Workspace", async (t) => {
  const f = await fixture(t);
  const parent = await f.update(f.create("Next release"), "add", "guard-add", { text: "Selected" });
  const binding = { taskRevision: f.child.revision, gitReferences: f.refs };
  const payload = { itemId: parent.itemId, linkedTaskId: f.child.id, releaseReference: binding };
  const before = f.store.task(parent.task.id);
  await assert.rejects(async () => f.update({ ...parent.task, revision: parent.task.revision - 1 },
    "link", "stale-parent", payload), /revision/u);
  await assert.rejects(async () => f.update(parent.task, "link", "stale-child", {
    ...payload, releaseReference: { ...binding, taskRevision: Number(f.child.revision) + 1 },
  }), /revision/u);
  await assert.rejects(async () => f.update(parent.task, "link", "wrong-result", {
    ...payload, releaseReference: { ...binding, gitReferences: [{ ...f.refs[0], resultCommit: "b".repeat(40) }] },
  }), /result/u);
  await assert.rejects(async () => f.update(parent.task, "toggle", "wrong-operation", { ...payload, completed: true }), /only valid for link/u);
  const foreign = f.create("Foreign", "workspace-two");
  await assert.rejects(async () => f.update(parent.task, "link", "foreign", { ...payload, linkedTaskId: foreign.id }), /Workspace/u);
  const db = new DatabaseSync(f.databaseFile);
  db.prepare("UPDATE hub_board_tasks SET workflow_status = 'testing' WHERE id = ?").run(f.child.id);
  await assert.rejects(async () => f.update(parent.task, "link", "unaccepted", payload), /revision/u);
  db.prepare("UPDATE hub_board_tasks SET workflow_status = 'awaiting_implementation' WHERE id = ?").run(f.child.id);
  assert.deepEqual(f.store.task(parent.task.id), before);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM hub_task_checklist_requests WHERE request_id LIKE 'stale-%'").get().n, 0);
  db.close();
  const ordinary = await f.update(parent.task, "link", "ordinary", { itemId: parent.itemId, linkedTaskId: f.child.id });
  await assert.rejects(async () => f.update(ordinary.task, "link", "replace-ownership", payload), /Unlink/u);
  const other = await f.update(f.create("Other parent"), "add", "other-add", { text: "Other" });
  await assert.rejects(async () => f.update(other.task, "link", "second-owner", { itemId: other.itemId, linkedTaskId: f.child.id }), /уже связана/u);
});

test("release references keep cycle and Workspace fences and cannot be extracted as ownership", async (t) => {
  const f = await fixture(t);
  const parent = await f.update(f.create("Release"), "add", "cycle-add", { text: "Selected" });
  const linked = await f.update(parent.task, "link", "reference", { itemId: parent.itemId,
    linkedTaskId: f.child.id, releaseReference: { taskRevision: f.child.revision, gitReferences: f.refs } });
  const back = await f.update(f.store.task(f.child.id), "add", "back-add", { text: "Cycle" });
  await assert.rejects(async () => f.update(back.task, "link", "cycle", { itemId: back.itemId, linkedTaskId: parent.task.id }), /цикл/u);
  await assert.rejects(async () => f.update(linked.task, "extract", "extract-ref", { itemId: parent.itemId }), /уже связан/u);
  const db = new DatabaseSync(f.databaseFile);
  assert.throws(() => db.prepare("UPDATE hub_board_tasks SET workspace_id = 'workspace-two' WHERE id = ?").run(f.child.id), /split Workspaces/u);
  assert.throws(() => db.prepare("DELETE FROM hub_board_tasks WHERE id = ?").run(f.child.id), /FOREIGN KEY/u);
  db.prepare("UPDATE hub_board_tasks SET status = 'done' WHERE id = ?").run(parent.task.id);
  await assert.rejects(async () => f.update(f.store.task(parent.task.id), "unlink", "archived-unlink", { itemId: parent.itemId }), /Archived/u);
  db.prepare("UPDATE hub_board_tasks SET status = 'open' WHERE id = ?").run(parent.task.id);
  db.close();
  assert.equal(f.store.task(f.child.id).checklistParent, null);
  const removed = await f.update(f.store.task(parent.task.id), "unlink", "unlink-reference", { itemId: parent.itemId });
  assert.equal(removed.task.checklist[0].linkedTaskId, null);
  assert.equal(removed.task.checklist[0].releaseReference, undefined);
});

test("legacy checklist migration preserves archived rows, ownership and original request hashes", async (t) => {
  const f = await fixture(t);
  const added = await f.update(f.create("Archived release"), "add", "legacy-add", { text: "Retained member" });
  const input = { id: added.task.id, operation: "link", itemId: added.itemId, linkedTaskId: f.child.id,
    expectedRevision: added.task.revision, requestId: "legacy-link" };
  await f.store.updateChecklist(input);
  const db = new DatabaseSync(f.databaseFile);
  db.prepare("UPDATE hub_board_tasks SET status = 'done' WHERE id = ?").run(added.task.id);
  const archived = f.store.task(added.task.id), child = f.store.task(f.child.id);
  const row = db.prepare(`SELECT id, task_id, text, manual_completed, linked_task_id, position,
    created_at_ms, updated_at_ms FROM hub_task_checklist_items WHERE id = ?`).get(added.itemId);
  f.store.close();
  // Recreate the pre-migration column shape in this tiny private SQLite fixture.
  db.exec(`DROP TRIGGER hub_task_checklist_release_workspace;
    DROP TRIGGER hub_task_checklist_release_shape_insert;
    DROP TRIGGER hub_task_checklist_release_shape_update;
    DROP INDEX hub_task_checklist_release_reference_idx;
    ALTER TABLE hub_task_checklist_items DROP COLUMN release_task_id;
    ALTER TABLE hub_task_checklist_items DROP COLUMN release_reference_json;`);
  assert.equal(db.prepare("PRAGMA table_info(hub_task_checklist_items)").all().length, 8);
  db.close();
  const reopened = new TaskBoardStore({ databaseFile: f.databaseFile });
  try {
    assert.deepEqual(reopened.task(added.task.id), archived);
    assert.deepEqual(reopened.task(f.child.id), child);
    assert.equal((await reopened.updateChecklist(input)).replayed, true);
    const migrated = new DatabaseSync(f.databaseFile);
    try {
      assert.deepEqual(migrated.prepare(`SELECT id, task_id, text, manual_completed, linked_task_id, position,
        created_at_ms, updated_at_ms FROM hub_task_checklist_items WHERE id = ?`).get(added.itemId), row);
      assert.equal(migrated.prepare("PRAGMA table_info(hub_task_checklist_items)").all().length, 10);
    } finally { migrated.close(); }
  } finally { reopened.close(); }
});
