import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

import { createTaskBoardMutationOwner } from "../../../src/application/sqlite-mutation-owner.mjs";
import { TaskBoardStore } from "../../../src/infrastructure/persistence/task-board-store.mjs";

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "hub-checklist-delivery-contention-"));
  const databaseFile = path.join(root, "runtime.sqlite");
  const raw = new TaskBoardStore({ databaseFile });
  const owner = createTaskBoardMutationOwner(raw);
  const task = await owner.create({
    text: "Checklist task", bucket: "workspace", workspaceId: "workspace-1", triageStatus: "disabled",
  });
  await owner.updateChecklist({
    id: task.id, operation: "add", text: "Exact event", expectedRevision: task.revision,
    requestId: "original-checklist-request",
  });
  const database = new DatabaseSync(databaseFile);
  database.exec("PRAGMA busy_timeout = 0");
  t.after(async () => {
    database.close();
    raw.close();
    await rm(root, { recursive: true, force: true });
  });
  const eventId = database.prepare("SELECT id FROM hub_task_checklist_event_outbox").get().id;
  return { raw, owner, database, eventId };
}

test("checklist delivery retries only the busy acknowledgement and shares one drain", async (t) => {
  const { raw, owner, database, eventId } = await fixture(t);
  const deliveredIds = [];
  const pending = owner.deliverChecklistEvents(async (event) => {
    deliveredIds.push(event.id);
    database.exec("BEGIN IMMEDIATE");
  });
  const joined = owner.deliverChecklistEvents(() => assert.fail("single drain owns delivery"));
  assert.equal(joined, pending);
  await delay(35);
  assert.deepEqual(deliveredIds, [eventId]);
  assert.equal(database.prepare("SELECT delivered_at_ms FROM hub_task_checklist_event_outbox WHERE id = ?").get(eventId).delivered_at_ms, null);
  database.exec("COMMIT");
  assert.equal((await pending).delivered, 1);
  assert.deepEqual(deliveredIds, [eventId]);
  assert.ok(raw.mutationDiagnostics().retries > 0);
  assert.ok(database.prepare("SELECT delivered_at_ms FROM hub_task_checklist_event_outbox WHERE id = ?").get(eventId).delivered_at_ms > 0);
  assert.equal((await owner.deliverChecklistEvents(() => assert.fail("delivered event cannot replay"))).delivered, 0);
});

test("checklist external delivery can await another Task mutation without a queue deadlock", { timeout: 1_000 }, async (t) => {
  const { owner, eventId } = await fixture(t);
  const seen = [];
  const result = await owner.deliverChecklistEvents(async (event) => {
    seen.push(event.id);
    await owner.setCaptureEnabled(777, true);
  });
  assert.equal(result.delivered, 1);
  assert.equal(owner.captureEnabled(777), true);
  assert.deepEqual(seen, [eventId]);
});

test("an external checklist effect throwing SQLite busy is not automatically replayed", async (t) => {
  const { owner, database, eventId } = await fixture(t);
  let calls = 0;
  await assert.rejects(owner.deliverChecklistEvents(async () => {
    calls += 1;
    throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
  }), /database is locked/u);
  assert.equal(calls, 1);
  assert.equal(database.prepare("SELECT delivered_at_ms FROM hub_task_checklist_event_outbox WHERE id = ?").get(eventId).delivered_at_ms, null);
});

test("quarantining an invalid checklist event retries its durable write without delivering it", async (t) => {
  const { owner, database, eventId } = await fixture(t);
  database.prepare("UPDATE hub_task_checklist_event_outbox SET payload_json = '{' WHERE id = ?").run(eventId);
  database.exec("BEGIN IMMEDIATE");
  const result = owner.deliverChecklistEvents(() => assert.fail("invalid event cannot reach delivery"));
  await delay(35);
  database.exec("COMMIT");
  const quarantined = await result;
  assert.equal(quarantined.delivered, 0);
  assert.equal(quarantined.quarantined, 1);
  assert.equal(quarantined.diagnostics[0].eventId, eventId);
  assert.ok(database.prepare("SELECT quarantined_at_ms FROM hub_task_checklist_event_outbox WHERE id = ?").get(eventId).quarantined_at_ms > 0);
});
