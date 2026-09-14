import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { TaskBoardService } from "../../../src/application/task-board-service.mjs";
import { TaskBoardStore } from "../../../src/infrastructure/persistence/task-board-store.mjs";
import { WorkspaceCatalogStore } from "../../../src/infrastructure/persistence/workspace-catalog-store.mjs";

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-task-checklist-"));
  const databaseFile = path.join(directory, "runtime.sqlite");
  let timestamp = Date.parse("2026-09-04T10:00:00.000Z");
  const store = new TaskBoardStore({ databaseFile, now: () => ++timestamp });
  t.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const create = (text, workspaceId = "workspace-1") => store.create({
    text,
    bucket: "workspace",
    workspaceId,
    taskPrefix: "HUB",
    triageStatus: "disabled",
  });
  return { store, create, databaseFile };
}

function update(store, task, operation, requestId, values = {}) {
  return store.updateChecklist({
    id: task.id,
    operation,
    expectedRevision: task.revision,
    requestId,
    taskPrefix: "HUB",
    ...values,
  });
}

async function linkedChecklistFixture(store, create, suffix = "linked") {
  let parent = create(`Parent ${suffix}`);
  const linked = create(`Linked ${suffix}`);
  const added = await update(store, parent, "add", `${suffix}-add`, { text: "Linked item" });
  parent = (await update(store, added.task, "link", `${suffix}-link`, {
    itemId: added.itemId,
    linkedTaskId: linked.id,
  })).task;
  parent = (await update(store, parent, "toggle", `${suffix}-toggle`, {
    itemId: added.itemId,
    completed: true,
  })).task;
  return { parent, linked: store.task(linked.id), itemId: added.itemId };
}

function linkedActionPayload(parent, linked, itemId, action, requestId) {
  return {
    id: parent.id,
    itemId,
    linkedTaskId: linked.id,
    action,
    expectedTaskRevision: parent.revision,
    expectedLinkedTaskRevision: linked.revision,
    requestId,
  };
}

function legacyHashedChecklistEventId(requestId, kind) {
  const digest = createHash("sha256")
    .update(requestId, "utf8").update("\0", "utf8").update(kind, "utf8").digest("hex");
  return `task-checklist:${digest}:${kind}`;
}

function versionedHashedChecklistEventId(requestId, kind) {
  return legacyHashedChecklistEventId(requestId, kind).replace("task-checklist:", "task-checklist-v2:");
}

test("checklist mutations persist order and use exact CAS plus idempotency", async (t) => {
  const { store, create, databaseFile } = await fixture(t);
  let parent = create("Parent");
  const first = await update(store, parent, "add", "add-first", { text: "First" });
  parent = first.task;
  const replay = await store.updateChecklist({
    id: parent.id,
    operation: "add",
    expectedRevision: 1,
    requestId: "add-first",
    taskPrefix: "HUB",
    text: "First",
  });
  assert.equal(replay.replayed, true);
  assert.equal(replay.itemId, first.itemId);
  assert.equal(replay.task.checklist.length, 1);

  await assert.rejects(() => store.updateChecklist({
    id: parent.id,
    operation: "add",
    expectedRevision: 1,
    requestId: "stale-add",
    taskPrefix: "HUB",
    text: "Stale",
  }), /revision changed/u);

  const second = await update(store, parent, "add", "add-second", { text: "Second" });
  parent = second.task;
  parent = (await update(store, parent, "move", "move-second", {
    itemId: second.itemId,
    beforeItemId: first.itemId,
  })).task;
  assert.deepEqual(parent.checklist.map((item) => item.text), ["Second", "First"]);
  parent = (await update(store, parent, "edit", "edit-first", {
    itemId: first.itemId,
    text: "First edited",
  })).task;
  parent = (await update(store, parent, "toggle", "toggle-first", {
    itemId: first.itemId,
    completed: true,
  })).task;
  assert.equal(parent.checklist.find((item) => item.id === first.itemId).completed, true);

  store.close();
  const reopened = new TaskBoardStore({ databaseFile });
  const persistedChecklist = reopened.task(parent.id).checklist.map((item) => ({
    text: item.text,
    completed: item.completed,
  }));
  reopened.close();
  assert.deepEqual(persistedChecklist, [
    { text: "Second", completed: false },
    { text: "First edited", completed: true },
  ]);
});

test("checklist CAS serializes concurrent writers", async (t) => {
  const { store, create } = await fixture(t);
  const parent = create("Parent");
  const results = await Promise.allSettled([
    Promise.resolve().then(() => update(store, parent, "add", "race-a", { text: "A" })),
    Promise.resolve().then(() => update(store, parent, "add", "race-b", { text: "B" })),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  assert.equal(store.task(parent.id).checklist.length, 1);
});

test("linked Task actions persist exact no-op, status choice and idempotent replay", async (t) => {
  const { store, create, databaseFile } = await fixture(t);
  const noOp = await linkedChecklistFixture(store, create, "no-op");
  const beforeNoOp = store.task(noOp.linked.id);
  const noOpPayload = linkedActionPayload(noOp.parent, noOp.linked, noOp.itemId, "none", "linked-no-op");
  const firstNoOp = await store.applyChecklistLinkedTaskAction(noOpPayload);
  assert.equal(firstNoOp.replayed, false);
  assert.deepEqual(store.task(noOp.linked.id), beforeNoOp);
  assert.equal((await store.applyChecklistLinkedTaskAction(noOpPayload)).replayed, true);

  const awaiting = await linkedChecklistFixture(store, create, "awaiting");
  const other = create("Unrelated exact target");
  await assert.rejects(() => store.applyChecklistLinkedTaskAction({
    ...linkedActionPayload(awaiting.parent, other, awaiting.itemId, "awaiting_implementation", "wrong-target"),
  }), /Связь пункта с Task изменилась/u);
  assert.equal(store.task(other.id).workflowStatus, "new");
  await store.applyChecklistLinkedTaskAction(linkedActionPayload(
    awaiting.parent, awaiting.linked, awaiting.itemId, "awaiting_implementation", "linked-awaiting",
  ));
  assert.equal(store.task(awaiting.linked.id).workflowStatus, "awaiting_implementation");
  assert.equal(store.task(other.id).workflowStatus, "new");

  store.close();
  const reopened = new TaskBoardStore({ databaseFile });
  assert.equal((await reopened.applyChecklistLinkedTaskAction(noOpPayload)).replayed, true);
  reopened.close();
});

test("linked Task action rejects uncheck and release-enabled Workspace without mutation", async (t) => {
  const { store, create, databaseFile } = await fixture(t);
  const linked = await linkedChecklistFixture(store, create, "guarded");
  const unchecked = (await update(store, linked.parent, "toggle", "guarded-uncheck", {
    itemId: linked.itemId,
    completed: false,
  })).task;
  await assert.rejects(() => store.applyChecklistLinkedTaskAction(linkedActionPayload(
    unchecked, linked.linked, linked.itemId, "done", "guarded-after-uncheck",
  )), /больше не отмечен вручную/u);
  assert.equal(store.task(linked.linked.id).workflowStatus, "new");

  const releaseLinked = await linkedChecklistFixture(store, create, "release");
  const service = new TaskBoardService({
    store,
    workspaceCatalog: {
      hierarchy: () => [],
      workspace: (id) => id === releaseLinked.parent.workspaceId
        ? { id, settings: { releaseWorkflowEnabled: true } }
        : null,
    },
  });
  const payload = linkedActionPayload(
    releaseLinked.parent, releaseLinked.linked, releaseLinked.itemId, "done", "release-suppressed",
  );
  assert.deepEqual(await service.applyChecklistLinkedTaskAction(payload), {
    suppressed: true,
    reason: "release_workflow_enabled",
  });
  assert.equal(store.task(releaseLinked.linked.id).workflowStatus, "new");
  const database = new DatabaseSync(databaseFile);
  assert.equal(database.prepare(`
    SELECT COUNT(*) AS value FROM hub_task_checklist_linked_actions WHERE request_id = ?
  `).get(payload.requestId).value, 0);
  database.close();
});

test("Done and close persists partial failure then resumes the exact request", async (t) => {
  const { store, create, databaseFile } = await fixture(t);
  const linked = await linkedChecklistFixture(store, create, "done-close");
  const payload = linkedActionPayload(
    linked.parent, linked.linked, linked.itemId, "done_and_close", "done-close-action",
  );
  const blocker = new DatabaseSync(databaseFile);
  blocker.exec(`
    CREATE TRIGGER fail_linked_task_close
    BEFORE UPDATE OF status ON hub_board_tasks
    WHEN NEW.id = '${linked.linked.id}' AND NEW.status = 'done'
    BEGIN
      SELECT RAISE(ABORT, 'forced close failure');
    END;
  `);
  await assert.rejects(() => store.applyChecklistLinkedTaskAction(payload), /forced close failure/u);
  let current = store.task(linked.linked.id);
  assert.equal(current.workflowStatus, "done");
  assert.notEqual(current.status, "done");
  assert.equal(blocker.prepare(`
    SELECT phase FROM hub_task_checklist_linked_actions WHERE request_id = ?
  `).get(payload.requestId).phase, "status_applied");
  blocker.exec("DROP TRIGGER fail_linked_task_close");
  blocker.close();

  const resumed = await store.applyChecklistLinkedTaskAction(payload);
  assert.equal(resumed.replayed, true);
  current = store.task(linked.linked.id);
  assert.equal(current.workflowStatus, "done");
  assert.equal(current.status, "done");
  const revision = current.revision;
  assert.equal((await store.applyChecklistLinkedTaskAction(payload)).replayed, true);
  assert.equal(store.task(linked.linked.id).revision, revision);
});

test("linked Task completion flows one way and broken links preserve the item", async (t) => {
  const { store, create } = await fixture(t);
  let parent = create("Parent");
  let child = create("Child");
  const added = await update(store, parent, "add", "link-add", { text: "Deliver child" });
  parent = (await update(store, added.task, "link", "link-child", {
    itemId: added.itemId,
    linkedTaskId: child.id,
  })).task;
  assert.equal(parent.checklist[0].linkedTask.id, child.id);
  assert.equal(store.task(child.id).checklistParent.task.id, parent.id);

  const duplicate = await update(store, parent, "add", "duplicate-add", { text: "Duplicate child" });
  parent = duplicate.task;
  await assert.rejects(() => update(store, parent, "link", "duplicate-link", {
    itemId: duplicate.itemId,
    linkedTaskId: child.id,
  }), /уже связана/u);
  await assert.rejects(() => store.updateChecklist({
    id: parent.id,
    operation: "toggle",
    itemId: added.itemId,
    expectedRevision: parent.revision,
    requestId: "missing-completed",
    taskPrefix: "HUB",
  }), /completed/u);

  const childRevision = child.revision;
  parent = (await update(store, parent, "toggle", "manual-linked", {
    itemId: added.itemId,
    completed: true,
  })).task;
  assert.equal(store.task(child.id).revision, childRevision);
  parent = (await update(store, parent, "toggle", "manual-linked-off", {
    itemId: added.itemId,
    completed: false,
  })).task;
  assert.equal(parent.checklist[0].completed, false);

  child = store.setWorkflowStatus(child.id, "done");
  assert.equal(store.task(parent.id).checklist[0].completed, true);
  assert.equal(child.workflowStatus, "done");
  child = store.setWorkflowStatus(child.id, "testing");
  assert.equal(store.task(parent.id).checklist[0].completed, false);
  child = store.complete(child.id);
  assert.equal(store.task(parent.id).checklist[0].completed, true);

  const childItem = await update(store, child, "add", "child-add", { text: "Cycle" });
  await assert.rejects(() => update(store, childItem.task, "link", "cycle", {
    itemId: childItem.itemId,
    linkedTaskId: parent.id,
  }), /цикл/u);

  assert.equal(store.remove(child.id), true);
  const preserved = store.task(parent.id).checklist[0];
  assert.equal(preserved.text, "Deliver child");
  assert.equal(preserved.linkedTaskId, null);
});

test("extract creates one unassigned New Task in the parent Workspace", async (t) => {
  const { store, create } = await fixture(t);
  let parent = create("Parent", "workspace-2");
  const added = await update(store, parent, "add", "extract-add", { text: "Separate delivery" });
  parent = added.task;
  const extracted = await update(store, parent, "extract", "extract-once", { itemId: added.itemId });
  assert.equal(extracted.createdTask.workspaceId, "workspace-2");
  assert.equal(extracted.createdTask.workflowStatus, "new");
  assert.equal(extracted.createdTask.status, "open");
  assert.equal(extracted.createdTask.streamId, null);
  assert.equal(extracted.task.checklist[0].linkedTaskId, extracted.createdTask.id);
  assert.equal(extracted.createdTask.checklistParent.task.id, parent.id);
  assert.equal(extracted.createdTask.checklistParent.text, "Separate delivery");

  const replay = await store.updateChecklist({
    id: parent.id,
    operation: "extract",
    itemId: added.itemId,
    expectedRevision: parent.revision,
    requestId: "extract-once",
    taskPrefix: "HUB",
  });
  assert.equal(replay.replayed, true);
  assert.equal(replay.createdTask.id, extracted.createdTask.id);
  assert.equal(store.list().filter((task) => task.source === "hub-checklist").length, 1);

  parent = (await update(store, extracted.task, "unlink", "extract-unlink", { itemId: added.itemId })).task;
  const extractedAgain = await update(store, parent, "extract", "extract-again", { itemId: added.itemId });
  assert.notEqual(extractedAgain.createdTask.id, extracted.createdTask.id);
  assert.equal(extractedAgain.createdTask.workflowStatus, "new");
  assert.equal(store.list().filter((task) => task.source === "hub-checklist").length, 2);
});

test("Backlog and Notes extract fail before receipt, Task creation or link mutation", async (t) => {
  const { store, databaseFile } = await fixture(t);
  for (const bucket of ["backlog", "notes"]) {
    let parent = store.create({
      text: `${bucket} parent`, bucket, triageStatus: "disabled",
    });
    const added = await update(store, parent, "add", `${bucket}-extract-add`, {
      text: "Must stay local",
    });
    parent = added.task;
    await store.deliverChecklistEvents(() => {});
    const requestId = `${bucket}-extract-denied`;
    const taskIdsBefore = store.list().map((task) => task.id);

    await assert.rejects(() => update(store, parent, "extract", requestId, {
      itemId: added.itemId,
    }), /существующего Workspace/u);

    const unchanged = store.task(parent.id);
    assert.equal(unchanged.revision, parent.revision);
    assert.equal(unchanged.checklist[0].linkedTaskId, null);
    assert.deepEqual(store.list().map((task) => task.id), taskIdsBefore);
    assert.equal(store.list().filter((task) => task.source === "hub-checklist").length, 0);
    const database = new DatabaseSync(databaseFile);
    assert.equal(database.prepare(`
      SELECT COUNT(*) AS value FROM hub_task_checklist_requests WHERE request_id = ?
    `).get(requestId).value, 0);
    database.close();
    assert.equal((await store.deliverChecklistEvents(() => {})).delivered, 0);
  }
});

test("existing databases migrate old Tasks to an empty checklist", async (t) => {
  const { store, create, databaseFile } = await fixture(t);
  const legacy = create("Legacy Task");
  store.close();
  const database = new DatabaseSync(databaseFile);
  database.exec("DROP TABLE hub_task_checklist_requests; DROP TABLE hub_task_checklist_items;");
  database.close();
  const migrated = new TaskBoardStore({ databaseFile });
  const task = migrated.task(legacy.id);
  migrated.close();
  assert.deepEqual(task.checklist, []);
  assert.equal(task.checklistParent, null);
});

test("canonical Task mutation owner yields to HTTP and timers during real SQLite contention", async (t) => {
  const { store, create, databaseFile } = await fixture(t);
  const parent = create("Contended parent");
  const taskBoard = new TaskBoardService({
    store,
    workspaceCatalog: {
      hierarchy: () => [],
      workspace: () => ({ settings: { taskPrefix: "HUB" } }),
    },
  });
  const blocker = new DatabaseSync(databaseFile);
  blocker.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE;");
  const server = http.createServer((_request, response) => response.end("responsive"));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  let timerFired = false;
  setTimeout(() => { timerFired = true; }, 5);
  const pending = update(taskBoard, parent, "add", "contended-add", { text: "One effect" });
  const address = server.address();
  const response = await fetch(`http://127.0.0.1:${address.port}/health`);
  assert.equal(await response.text(), "responsive");
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(timerFired, true);
  blocker.exec("COMMIT");
  blocker.close();

  const result = await pending;
  assert.equal(result.task.checklist.length, 1);
  const replay = await update(taskBoard, parent, "add", "contended-add", { text: "One effect" });
  assert.equal(replay.replayed, true);
  assert.equal(store.task(parent.id).checklist.length, 1);
});

test("canonical Task mutation owner bounds SQLite busy retry", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-task-checklist-bounded-"));
  const databaseFile = path.join(directory, "runtime.sqlite");
  const store = new TaskBoardStore({ databaseFile });
  const taskBoard = new TaskBoardService({
    store,
    workspaceCatalog: {
      hierarchy: () => [],
      workspace: () => ({ settings: { taskPrefix: "HUB" } }),
    },
  });
  t.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const parent = store.create({
    text: "Bounded", bucket: "workspace", workspaceId: "workspace-1", taskPrefix: "HUB",
  });
  const blocker = new DatabaseSync(databaseFile);
  blocker.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE;");
  await assert.rejects(() => update(taskBoard, parent, "add", "bounded-add", { text: "Blocked" }), /locked/u);
  blocker.exec("ROLLBACK");
  blocker.close();
  assert.deepEqual(store.task(parent.id).checklist, []);
});

test("durable checklist outbox recovers one Workspace event after sink failure", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-task-checklist-outbox-"));
  const databaseFile = path.join(directory, "runtime.sqlite");
  t.after(() => rm(directory, { recursive: true, force: true }));
  let catalog = new WorkspaceCatalogStore({ databaseFile });
  await catalog.load();
  const workspace = catalog.createWorkspace({ name: "Agent HUB" });
  let store = new TaskBoardStore({ databaseFile });
  const parent = store.create({
    text: "Outbox parent", bucket: "workspace", workspaceId: workspace.id, taskPrefix: "HUB",
  });
  let failAfterCommit = true;
  let service = new TaskBoardService({
    store,
    workspaceCatalog: catalog,
    logger: { error() {} },
    recordEvent: (event) => {
      const recorded = catalog.recordWorkspaceEvent(event);
      if (failAfterCommit) {
        failAfterCommit = false;
        throw new Error("sink acknowledgement lost");
      }
      return recorded;
    },
  });
  const payload = {
    id: parent.id,
    operation: "add",
    text: "Recover me",
    expectedRevision: parent.revision,
    requestId: "outbox-add",
  };
  await assert.rejects(() => service.updateChecklist(payload), /acknowledgement lost/u);
  assert.equal(store.task(parent.id).checklist.length, 1);
  assert.equal(catalog.workspaceEvents(workspace.id).length, 1);
  service.close();
  catalog.close();

  catalog = new WorkspaceCatalogStore({ databaseFile });
  await catalog.load();
  store = new TaskBoardStore({ databaseFile });
  service = new TaskBoardService({
    store,
    workspaceCatalog: catalog,
    recordEvent: (event) => catalog.recordWorkspaceEvent(event),
  });
  const replay = await service.updateChecklist(payload);
  assert.equal(replay.replayed, true);
  assert.equal(store.task(parent.id).checklist.length, 1);
  assert.equal(catalog.workspaceEvents(workspace.id).length, 1);
  service.close();
  catalog.close();
});

test("checklist outbox preserves durable mutation order with a fixed clock", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-task-checklist-order-"));
  const databaseFile = path.join(directory, "runtime.sqlite");
  const ids = ["parent", "item-z", "item-a", "child"];
  const store = new TaskBoardStore({
    databaseFile,
    now: () => 100,
    idFactory: () => ids.shift(),
  });
  t.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  let parent = store.create({
    text: "Ordered parent", bucket: "workspace", workspaceId: "workspace-1", taskPrefix: "HUB",
  });
  parent = (await update(store, parent, "add", "z-request", { text: "First" })).task;
  const second = await update(store, parent, "add", "a-request", { text: "Second" });
  parent = second.task;
  await update(store, parent, "extract", "m-request", { itemId: second.itemId });
  const events = [];
  await store.deliverChecklistEvents((event) => events.push(event));
  assert.deepEqual(events.map((event) => [event.type, event.payload.operation ?? null]), [
    ["task.checklist.updated", "add"],
    ["task.checklist.updated", "add"],
    ["task.checklist.updated", "extract"],
    ["task.created", null],
  ]);
  assert.equal(new Set(events.map((event) => event.id)).size, 4);
  assert.ok(events.every((event) => event.id.length <= 200 && event.dedupeKey.length <= 200));
  assert.deepEqual(events.map((event) => event.sequence), [1, 2, 3, 4]);
  assert.deepEqual(events.map((event) => event.mutationOrdinal), [0, 0, 0, 1]);
});

test("multi-event extract keeps observable order across lost acknowledgement and reopen", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-task-checklist-extract-recovery-"));
  const databaseFile = path.join(directory, "runtime.sqlite");
  let catalog = new WorkspaceCatalogStore({ databaseFile, now: () => 100 });
  await catalog.load();
  const workspace = catalog.createWorkspace({ name: "Agent HUB" });
  const ids = ["parent", "item", "child"];
  let store = new TaskBoardStore({ databaseFile, now: () => 100, idFactory: () => ids.shift() });
  let service = null;
  t.after(async () => {
    service?.close();
    catalog?.close();
    await rm(directory, { recursive: true, force: true });
  });
  let parent = store.create({
    text: "Extract recovery", bucket: "workspace", workspaceId: workspace.id, taskPrefix: "HUB",
  });
  const added = await update(store, parent, "add", "z-add", { text: "Create child" });
  parent = added.task;
  await store.deliverChecklistEvents((event) => catalog.recordWorkspaceEvent(event));
  let loseAcknowledgement = true;
  service = new TaskBoardService({
    store,
    workspaceCatalog: catalog,
    logger: { error() {} },
    recordEvent: (event) => {
      const recorded = catalog.recordWorkspaceEvent(event);
      if (loseAcknowledgement) {
        loseAcknowledgement = false;
        throw new Error("extract event acknowledgement lost");
      }
      return recorded;
    },
  });
  await assert.rejects(() => service.updateChecklist({
    id: parent.id,
    operation: "extract",
    itemId: added.itemId,
    expectedRevision: parent.revision,
    requestId: "a-extract",
  }), /acknowledgement lost/u);
  service.close();
  service = null;
  catalog.close();

  catalog = new WorkspaceCatalogStore({ databaseFile, now: () => 100 });
  await catalog.load();
  store = new TaskBoardStore({ databaseFile, now: () => 100 });
  service = new TaskBoardService({
    store,
    workspaceCatalog: catalog,
    recordEvent: (event) => catalog.recordWorkspaceEvent(event),
  });
  await service.recoverChecklistEvents();
  const events = catalog.workspaceEvents(workspace.id);
  assert.deepEqual(events.map((event) => [event.type, event.payload.operation ?? null]), [
    ["task.checklist.updated", "add"],
    ["task.checklist.updated", "extract"],
    ["task.created", null],
  ]);
  assert.equal(store.list().filter((task) => task.source === "hub-checklist").length, 1);
});

test("checklist outbox migration restores extract causality and exactly-once delivery", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-task-checklist-order-migration-"));
  const databaseFile = path.join(directory, "runtime.sqlite");
  let catalog = new WorkspaceCatalogStore({ databaseFile, now: () => 100 });
  await catalog.load();
  const workspace = catalog.createWorkspace({ name: "Agent HUB" });
  catalog.close();
  let store = new TaskBoardStore({ databaseFile, now: () => 100 });
  store.close();
  const database = new DatabaseSync(databaseFile);
  database.exec(`
    DROP TABLE hub_task_checklist_event_outbox;
    CREATE TABLE hub_task_checklist_event_outbox (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      stream_id TEXT,
      event_type TEXT NOT NULL,
      subject_id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      delivered_at_ms INTEGER
    ) WITHOUT ROWID;
  `);
  const insertLegacy = database.prepare(`
    INSERT INTO hub_task_checklist_event_outbox
      (id, workspace_id, event_type, subject_id, payload_json, created_at_ms)
    VALUES (?, ?, ?, ?, ?, 100)
  `);
  insertLegacy.run(
    "task-checklist:reverse-request:created", workspace.id, "task.created", "child-task",
    JSON.stringify({ taskId: "child-task" }),
  );
  insertLegacy.run(
    "task-checklist:reverse-request:updated", workspace.id, "task.checklist.updated", "parent-task",
    JSON.stringify({ taskId: "parent-task", operation: "extract", itemId: "item-1" }),
  );
  database.close();
  catalog = new WorkspaceCatalogStore({ databaseFile, now: () => 100 });
  await catalog.load();
  store = new TaskBoardStore({ databaseFile, now: () => 100 });
  let service = new TaskBoardService({
    store,
    workspaceCatalog: catalog,
    recordEvent: (event) => catalog.recordWorkspaceEvent(event),
  });
  t.after(async () => {
    service?.close();
    catalog?.close();
    await rm(directory, { recursive: true, force: true });
  });
  await service.recoverChecklistEvents();
  let events = catalog.workspaceEvents(workspace.id);
  assert.deepEqual(events.map((event) => [event.type, event.payload.operation ?? null]), [
    ["task.checklist.updated", "extract"],
    ["task.created", null],
  ]);
  service.close();
  catalog.close();
  catalog = new WorkspaceCatalogStore({ databaseFile, now: () => 100 });
  await catalog.load();
  store = new TaskBoardStore({ databaseFile, now: () => 100 });
  service = new TaskBoardService({
    store,
    workspaceCatalog: catalog,
    recordEvent: (event) => catalog.recordWorkspaceEvent(event),
  });
  await service.recoverChecklistEvents();
  events = catalog.workspaceEvents(workspace.id);
  assert.deepEqual(events.map((event) => event.type), ["task.checklist.updated", "task.created"]);
});

test("checklist outbox migration preserves existing sequence while deriving legacy ordinals", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-task-checklist-ordinal-migration-"));
  const databaseFile = path.join(directory, "runtime.sqlite");
  let store = new TaskBoardStore({ databaseFile, now: () => 100 });
  store.close();
  const database = new DatabaseSync(databaseFile);
  database.exec(`
    DROP TABLE hub_task_checklist_event_outbox;
    CREATE TABLE hub_task_checklist_event_outbox (
      id TEXT PRIMARY KEY,
      sequence INTEGER NOT NULL,
      workspace_id TEXT NOT NULL,
      stream_id TEXT,
      event_type TEXT NOT NULL,
      subject_id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      delivered_at_ms INTEGER
    ) WITHOUT ROWID;
    INSERT INTO hub_task_checklist_event_outbox
      (id, sequence, workspace_id, event_type, subject_id, payload_json, created_at_ms)
    VALUES
      ('task-checklist:ordered:created', 20, 'workspace-1', 'task.created', 'child', '{"taskId":"child"}', 100),
      ('task-checklist:ordered:updated', 10, 'workspace-1', 'task.checklist.updated', 'parent', '{"taskId":"parent"}', 100);
  `);
  database.close();
  store = new TaskBoardStore({ databaseFile, now: () => 101 });
  t.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const delivered = [];
  await store.deliverChecklistEvents((event) => delivered.push(event));
  assert.deepEqual(delivered.map((event) => [event.sequence, event.mutationOrdinal, event.type]), [
    [10, 0, "task.checklist.updated"],
    [20, 1, "task.created"],
  ]);
});

test("versioned checklist event ids cannot collide with retained legacy hashed ids", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-task-checklist-event-domain-"));
  const databaseFile = path.join(directory, "runtime.sqlite");
  let store = new TaskBoardStore({ databaseFile, now: () => 100 });
  t.after(async () => {
    store?.close();
    await rm(directory, { recursive: true, force: true });
  });
  let parent = store.create({
    text: "Collision parent", bucket: "workspace", workspaceId: "workspace-1", taskPrefix: "HUB",
  });
  const added = await update(store, parent, "add", "collision-seed", { text: "Extract" });
  parent = added.task;
  await store.deliverChecklistEvents(() => {});

  const requestId = "legacy-hash-collision";
  const legacyUpdatedId = legacyHashedChecklistEventId(requestId, "updated");
  const legacyCreatedId = legacyHashedChecklistEventId(requestId, "created");
  const database = new DatabaseSync(databaseFile);
  const sequence = Number(database.prepare(
    "SELECT COALESCE(MAX(sequence), 0) AS value FROM hub_task_checklist_event_outbox",
  ).get().value);
  const insert = database.prepare(`
    INSERT INTO hub_task_checklist_event_outbox (
      id, sequence, mutation_ordinal, workspace_id, event_type, subject_id,
      payload_json, created_at_ms, delivered_at_ms
    ) VALUES (?, ?, ?, 'workspace-1', ?, ?, ?, 100, ?)
  `);
  insert.run(
    legacyUpdatedId, sequence + 1, 0, "task.checklist.updated", parent.id,
    JSON.stringify({ taskId: parent.id, operation: "legacy-updated" }), 100,
  );
  insert.run(
    legacyCreatedId, sequence + 2, 1, "task.created", "legacy-child",
    JSON.stringify({ taskId: "legacy-child" }), null,
  );
  database.close();

  const extracted = await update(store, parent, "extract", requestId, { itemId: added.itemId });
  const replay = await store.updateChecklist({
    id: parent.id,
    operation: "extract",
    itemId: added.itemId,
    expectedRevision: parent.revision,
    requestId,
    taskPrefix: "HUB",
  });
  assert.equal(replay.replayed, true);
  assert.equal(replay.createdTask.id, extracted.createdTask.id);
  store.close();
  store = new TaskBoardStore({ databaseFile, now: () => 101 });

  const delivered = [];
  await store.deliverChecklistEvents((event) => delivered.push(event));
  const audit = new DatabaseSync(databaseFile);
  const ids = audit.prepare(`
    SELECT id FROM hub_task_checklist_event_outbox
    WHERE id IN (?, ?) OR id LIKE 'task-checklist-v2:%'
    ORDER BY sequence
  `).all(legacyUpdatedId, legacyCreatedId).map((row) => row.id);
  audit.close();
  assert.ok(ids.includes(legacyUpdatedId));
  assert.ok(ids.includes(legacyCreatedId));
  assert.ok(ids.includes(versionedHashedChecklistEventId(requestId, "updated")));
  assert.ok(ids.includes(versionedHashedChecklistEventId(requestId, "created")));
  assert.deepEqual(delivered.map((event) => event.type), [
    "task.created", "task.checklist.updated", "task.created",
  ]);
  assert.equal(store.list().filter((task) => task.source === "hub-checklist").length, 1);
});

test("malformed legacy outbox rows are durably quarantined without blocking later events", async (t) => {
  const { store, create, databaseFile } = await fixture(t);
  let parent = create("Malformed outbox");
  const database = new DatabaseSync(databaseFile);
  database.prepare(`
    INSERT INTO hub_task_checklist_event_outbox (
      id, sequence, mutation_ordinal, workspace_id, event_type,
      subject_id, payload_json, created_at_ms
    ) VALUES ('legacy-malformed', 1, 0, 'workspace-1', 'task.checklist.updated', ?, '{', 100)
  `).run(parent.id);
  database.close();
  parent = (await update(store, parent, "add", "after-malformed", { text: "Still observable" })).task;

  const events = [];
  const recovered = await store.deliverChecklistEvents((event) => events.push(event));
  assert.equal(recovered.delivered, 1);
  assert.equal(recovered.quarantined, 1);
  assert.equal(recovered.diagnostics[0].eventId, "legacy-malformed");
  assert.deepEqual(events.map((event) => event.payload.operation), ["add"]);
  const audit = new DatabaseSync(databaseFile);
  const poison = audit.prepare(`
    SELECT quarantined_at_ms, quarantine_reason FROM hub_task_checklist_event_outbox WHERE id = 'legacy-malformed'
  `).get();
  audit.close();
  assert.ok(Number(poison.quarantined_at_ms) > 0);
  assert.match(poison.quarantine_reason, /invalid checklist outbox payload/u);
  assert.equal((await store.deliverChecklistEvents(() => {})).delivered, 0);
  assert.equal(store.task(parent.id).checklist.length, 1);
});

test("non-object legacy outbox payloads are quarantined without blocking later events", async (t) => {
  const { store, create, databaseFile } = await fixture(t);
  let parent = create("Primitive outbox");
  const database = new DatabaseSync(databaseFile);
  database.prepare(`
    INSERT INTO hub_task_checklist_event_outbox (
      id, sequence, mutation_ordinal, workspace_id, event_type,
      subject_id, payload_json, created_at_ms
    ) VALUES ('legacy-primitive', 1, 0, 'workspace-1', 'task.checklist.updated', ?, 'null', 100)
  `).run(parent.id);
  database.close();
  parent = (await update(store, parent, "add", "after-primitive", { text: "Still observable" })).task;

  const events = [];
  const recovered = await store.deliverChecklistEvents((event) => events.push(event));
  assert.equal(recovered.delivered, 1);
  assert.equal(recovered.quarantined, 1);
  assert.equal(recovered.diagnostics[0].eventId, "legacy-primitive");
  assert.deepEqual(events.map((event) => event.payload.operation), ["add"]);
  assert.equal(store.task(parent.id).checklist.length, 1);
});

test("legacy oversized checklist event identity cannot block later outbox delivery", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-task-checklist-poison-recovery-"));
  const databaseFile = path.join(directory, "runtime.sqlite");
  const catalog = new WorkspaceCatalogStore({ databaseFile, now: () => 100 });
  await catalog.load();
  const workspace = catalog.createWorkspace({ name: "Agent HUB" });
  const store = new TaskBoardStore({ databaseFile, now: () => 100 });
  const parent = store.create({
    text: "Poison recovery", bucket: "workspace", workspaceId: workspace.id, taskPrefix: "HUB",
  });
  const database = new DatabaseSync(databaseFile);
  database.prepare(`
    INSERT INTO hub_task_checklist_event_outbox (
      id, sequence, mutation_ordinal, workspace_id, event_type,
      subject_id, payload_json, created_at_ms
    ) VALUES (?, 1, 0, ?, 'task.checklist.updated', ?, ?, 100)
  `).run(
    `task-checklist:${"x".repeat(200)}:updated`, workspace.id, parent.id,
    JSON.stringify({ taskId: parent.id, operation: "legacy" }),
  );
  database.close();
  await update(store, parent, "add", "normal-after-poison", { text: "Still delivered" });
  const service = new TaskBoardService({
    store,
    workspaceCatalog: catalog,
    recordEvent: (event) => catalog.recordWorkspaceEvent(event),
  });
  t.after(async () => {
    service.close();
    catalog.close();
    await rm(directory, { recursive: true, force: true });
  });
  await service.recoverChecklistEvents();
  const events = catalog.workspaceEvents(workspace.id);
  assert.deepEqual(events.map((event) => event.payload.operation), ["legacy", "add"]);
  const audit = new DatabaseSync(databaseFile);
  const dedupeKeys = audit.prepare(
    "SELECT dedupe_key FROM hub_workspace_events WHERE workspace_id = ? ORDER BY sequence",
  ).all(workspace.id).map((row) => row.dedupe_key);
  audit.close();
  assert.equal(new Set(dedupeKeys).size, 2);
  assert.ok(dedupeKeys.every((dedupeKey) => dedupeKey.length <= 200));
  assert.equal((await store.deliverChecklistEvents(() => {})).delivered, 0);
});

test("cross-Workspace checklist links fail before revision or event mutation", async (t) => {
  const { store, create } = await fixture(t);
  let parent = create("Parent", "workspace-1");
  const foreign = create("Foreign", "workspace-2");
  const added = await update(store, parent, "add", "same-workspace-add", { text: "Local item" });
  parent = added.task;
  await store.deliverChecklistEvents(() => {});
  await assert.rejects(() => update(store, parent, "link", "cross-workspace-link", {
    itemId: added.itemId,
    linkedTaskId: foreign.id,
  }), /том же Workspace/u);
  const unchanged = store.task(parent.id);
  assert.equal(unchanged.revision, parent.revision);
  assert.equal(unchanged.checklist[0].linkedTaskId, null);
  assert.equal((await store.deliverChecklistEvents(() => {})).delivered, 0);
});

test("Backlog and Notes Tasks cannot establish checklist links without a Workspace", async (t) => {
  const { store } = await fixture(t);
  let parent = store.create({ text: "Backlog parent", bucket: "backlog", triageStatus: "disabled" });
  const child = store.create({ text: "Backlog child", bucket: "backlog", triageStatus: "disabled" });
  const added = await update(store, parent, "add", "backlog-add", { text: "No implicit Workspace" });
  parent = added.task;
  await store.deliverChecklistEvents(() => {});
  await assert.rejects(() => update(store, parent, "link", "backlog-link", {
    itemId: added.itemId,
    linkedTaskId: child.id,
  }), /том же Workspace/u);
  assert.equal(store.task(parent.id).revision, parent.revision);
  assert.equal(store.task(parent.id).checklist[0].linkedTaskId, null);
  assert.equal((await store.deliverChecklistEvents(() => {})).delivered, 0);
});

test("ordinary Task moves cannot break checklist Workspace ownership", async (t) => {
  const { store, create } = await fixture(t);
  let parent = create("Move parent", "workspace-1");
  const childA = create("Child A", "workspace-1");
  const childB = create("Child B", "workspace-1");
  const childC = create("Child C", "workspace-1");
  const first = await update(store, parent, "add", "move-add-a", { text: "A" });
  parent = (await update(store, first.task, "link", "move-link-a", {
    itemId: first.itemId, linkedTaskId: childA.id,
  })).task;
  const second = await update(store, parent, "add", "move-add-b", { text: "B" });
  parent = (await update(store, second.task, "link", "move-link-b", {
    itemId: second.itemId, linkedTaskId: childB.id,
  })).task;
  await store.deliverChecklistEvents(() => {});
  const baseline = new Map([parent, childA, childB].map((task) => [task.id, store.task(task.id)]));
  await assert.rejects(
    Promise.resolve().then(() => store.move(parent.id, { bucket: "workspace", workspaceId: "workspace-2" })),
    /сначала отвяжите/u,
  );
  await assert.rejects(
    Promise.resolve().then(() => store.move(childA.id, { bucket: "workspace", workspaceId: "workspace-2" })),
    /сначала отвяжите/u,
  );
  await assert.rejects(
    Promise.resolve().then(() => store.move(childB.id, { bucket: "backlog" })),
    /сначала отвяжите/u,
  );
  for (const [taskId, before] of baseline) {
    const after = store.task(taskId);
    assert.equal(after.workspaceId, before.workspaceId);
    assert.equal(after.bucket, before.bucket);
    assert.equal(after.revision, before.revision);
  }
  assert.equal((await store.deliverChecklistEvents(() => {})).delivered, 0);

  parent = (await update(store, store.task(parent.id), "unlink", "move-unlink-a", {
    itemId: first.itemId,
  })).task;
  await store.move(childA.id, { bucket: "workspace", workspaceId: "workspace-2" });
  assert.equal(store.task(childA.id).workspaceId, "workspace-2");
  parent = (await update(store, parent, "link", "move-replace-a", {
    itemId: first.itemId, linkedTaskId: childC.id,
  })).task;
  await store.deliverChecklistEvents(() => {});
  await assert.rejects(
    Promise.resolve().then(() => store.move(childC.id, { bucket: "workspace", workspaceId: "workspace-2" })),
    /сначала отвяжите/u,
  );
  assert.equal(store.task(childC.id).workspaceId, "workspace-1");
  assert.equal(store.task(parent.id).checklist.find((item) => item.id === first.itemId).linkedTaskId, childC.id);
  assert.equal((await store.deliverChecklistEvents(() => {})).delivered, 0);
});

test("prepare, start and rollback enforce one checklist Workspace transition invariant", async (t) => {
  const { store, create } = await fixture(t);
  let parent = create("Start parent", "workspace-1");
  const child = create("Start child", "workspace-1");
  const added = await update(store, parent, "add", "start-add", { text: "Linked child" });
  parent = (await update(store, added.task, "link", "start-link", {
    itemId: added.itemId, linkedTaskId: child.id,
  })).task;

  assert.throws(() => store.prepareStart(parent.id, {
    workspaceId: "workspace-2", streamId: "foreign", requestId: "foreign-parent", provider: "codex", threadId: "thread-foreign",
  }), /сначала отвяжите/u);
  assert.throws(() => store.prepareStart(child.id, {
    workspaceId: "workspace-2", streamId: "foreign", requestId: "foreign-child", provider: "codex", threadId: "thread-foreign",
  }), /сначала отвяжите/u);
  assert.equal(store.task(parent.id).status, "open");
  assert.equal(store.task(child.id).workspaceId, "workspace-1");

  const prepared = await store.prepareStart(child.id, {
    workspaceId: "workspace-1", streamId: "same", requestId: "same-workspace", provider: "codex", threadId: "thread-same",
  });
  assert.equal(prepared.status, "starting");
  const fenced = await store.fencePreparedStartCancellation(child.id, {
    requestId: "same-workspace", cancellationRequestId: "cancel-same-workspace",
    expectedRevision: prepared.revision,
  });
  const rolledBack = await store.completePreparedStartCancellation(child.id, {
    requestId: "same-workspace", expectedRevision: fenced.revision,
  });
  assert.equal(rolledBack.status, "open");
  assert.equal(rolledBack.workspaceId, "workspace-1");
  assert.equal(rolledBack.streamId, null);

  parent = (await update(store, parent, "unlink", "start-unlink", { itemId: added.itemId })).task;
  const unlinkedPrepared = await store.prepareStart(child.id, {
    workspaceId: "workspace-2", streamId: "foreign", requestId: "unlinked-start", provider: "codex", threadId: "thread-foreign",
  });
  const unlinkedAdmitted = await store.admitPreparedStart(child.id, {
    requestId: "unlinked-start", attemptId: "attempt-unlinked-start",
    expectedRevision: unlinkedPrepared.revision,
  });
  const started = await store.markStarted(child.id, {
    workspaceId: "workspace-2", streamId: "foreign", requestId: "unlinked-start",
    attemptId: "attempt-unlinked-start", expectedRevision: unlinkedAdmitted.revision,
  });
  assert.equal(started.status, "started");
  assert.equal(started.workspaceId, "workspace-2");
  assert.equal(store.task(parent.id).checklist[0].linkedTaskId, null);
});

test("concurrent checklist link and cross-Workspace start cannot create an invalid relation", async (t) => {
  const { store, create } = await fixture(t);
  let parent = create("Race parent", "workspace-1");
  const child = create("Race child", "workspace-1");
  const added = await update(store, parent, "add", "race-start-add", { text: "Race" });
  parent = added.task;
  const results = await Promise.allSettled([
    update(store, parent, "link", "race-link", { itemId: added.itemId, linkedTaskId: child.id }),
    Promise.resolve().then(() => store.prepareStart(child.id, {
      workspaceId: "workspace-2", streamId: "race-stream", requestId: "race-start", provider: "codex", threadId: "thread-race",
    })),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  const currentParent = store.task(parent.id);
  const currentChild = store.task(child.id);
  assert.ok(
    currentParent.checklist[0].linkedTaskId === child.id
      ? currentChild.workspaceId === "workspace-1"
      : currentChild.status === "starting" && currentChild.workspaceId === "workspace-2",
  );
});
