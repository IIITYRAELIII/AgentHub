import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { configureClaimCustodyNamespaceFences, withClaimCustodySqlPermit,
  claimCustodySqlConnection, claimCustodyTaskSnapshot } from "../../../src/infrastructure/persistence/claim-custody-fence.mjs";

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "claim-namespace-sql-"));
  const file = path.join(root, "fixture.sqlite");
  const owner = new DatabaseSync(file);
  owner.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE hub_mcp_operations(request_id TEXT PRIMARY KEY, claim_custody_json TEXT,
      claim_custody_write_json TEXT, result_json TEXT, receipt_state TEXT,
      tool_name TEXT, workspace_id TEXT, stream_id TEXT, provider TEXT, provider_thread_id TEXT, arguments_hash TEXT);
    CREATE TABLE hub_board_tasks(id TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE hub_task_turn_bindings(task_id TEXT, operation_id TEXT PRIMARY KEY, baseline_json TEXT);
    CREATE TABLE hub_task_lifecycle_transitions(task_id TEXT, operation_id TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE hub_task_git_references(task_id TEXT PRIMARY KEY, value TEXT);
    INSERT INTO hub_board_tasks VALUES('target','accepted'),('other','unrelated');
    INSERT INTO hub_task_turn_bindings VALUES('target','old-binding','{}');
    INSERT INTO hub_task_git_references VALUES('target','accepted-ref');
    INSERT INTO hub_mcp_operations(request_id,result_json,receipt_state) VALUES('old',NULL,'unknown');`);
  // Open before fence, cache the actual shapes used by old owner continuations.
  const legacy = new DatabaseSync(file);
  const cached = {
    assignment: legacy.prepare("UPDATE hub_board_tasks SET value = ? WHERE id = ?"),
    baseline: legacy.prepare("UPDATE hub_task_turn_bindings SET baseline_json = ? WHERE operation_id = ?"),
    reference: legacy.prepare("INSERT INTO hub_task_git_references VALUES(?,?) ON CONFLICT(task_id) DO UPDATE SET value=excluded.value"),
    lifecycle: legacy.prepare("INSERT INTO hub_task_lifecycle_transitions VALUES(?,?,?)"),
    remove: legacy.prepare("DELETE FROM hub_board_tasks WHERE id = ?"),
    replace: legacy.prepare("INSERT OR REPLACE INTO hub_board_tasks VALUES(?,?)"),
  };
  t.after(async () => { legacy.close(); owner.close(); await rm(root, { recursive: true, force: true }); });
  const authority = { taskId: "target", epoch: "epoch-1", fenceRequestId: "fence", operationId: "successor" };
  const fence = () => {
    configureClaimCustodyNamespaceFences(owner);
    owner.prepare("INSERT INTO hub_mcp_operations(request_id,claim_custody_json) VALUES(?,?)")
      .run("fence", JSON.stringify({ phase: "fenced", taskId: "target", namespace: { epoch: "epoch-1" }, original: { requestId: "old" } }));
  };
  return { owner, legacy, cached, authority, fence };
}

test("legacy cached assignment/baseline/lifecycle/result/delete/upsert cannot cross the persistent fence", async t => {
  const f = await fixture(t);
  f.fence();
  for (const write of [
    () => f.cached.assignment.run("late", "target"),
    () => f.cached.baseline.run('{"late":true}', "old-binding"),
    () => f.cached.reference.run("target", "late-ref"),
    () => f.cached.lifecycle.run("target", "late-operation", "late"),
    () => f.cached.remove.run("target"),
    () => f.cached.replace.run("target", "replacement"),
  ]) assert.throws(write, /namespace authority/);
  assert.equal(f.owner.prepare("SELECT value FROM hub_board_tasks WHERE id='target'").get().value, "accepted");
  f.cached.assignment.run("still allowed", "other");
  assert.equal(f.owner.prepare("SELECT value FROM hub_board_tasks WHERE id='other'").get().value, "still allowed");
});

test("a pre-fence read transaction cannot upgrade its stale view into a write", async t => {
  const f = await fixture(t);
  f.legacy.exec("BEGIN");
  f.legacy.prepare("SELECT * FROM hub_board_tasks").all();
  f.fence();
  assert.throws(() => f.cached.assignment.run("stale", "target"), /locked|busy|namespace authority/i);
  f.legacy.exec("ROLLBACK");
  assert.throws(() => f.cached.assignment.run("late", "target"), /namespace authority/);
});

test("legacy REPLACE through a unique key cannot evict another protected Task id", async t => {
  const f = await fixture(t);
  f.owner.exec("CREATE UNIQUE INDEX task_value_identity ON hub_board_tasks(value)");
  const insert = f.legacy.prepare("INSERT OR REPLACE INTO hub_board_tasks VALUES('foreign','accepted')");
  const update = f.legacy.prepare("UPDATE OR REPLACE hub_board_tasks SET value='accepted' WHERE id='other'");
  f.fence();
  assert.equal(f.legacy.prepare("PRAGMA recursive_triggers").get().recursive_triggers, 0);
  assert.throws(() => insert.run(), /namespace authority/);
  assert.throws(() => update.run(), /namespace authority/);
  assert.equal(f.owner.prepare("SELECT value FROM hub_board_tasks WHERE id='target'").get().value, "accepted");
  assert.equal(f.owner.prepare("SELECT value FROM hub_board_tasks WHERE id='other'").get().value, "unrelated");
});

test("secondary historical and squash identities are pinned before fence and protected afterwards", async t => {
  const f = await fixture(t);
  f.owner.exec(`CREATE TABLE hub_release_registry_history(source_id TEXT PRIMARY KEY, migrated_task_id TEXT, payload_json TEXT);
    CREATE TABLE hub_task_lifecycle_outcomes(task_id TEXT, operation_id TEXT PRIMARY KEY, result_json TEXT);
    INSERT INTO hub_release_registry_history VALUES('old-history','target','{}');`);
  const body = JSON.stringify({ evidence: { squashTransfer: { source: { taskId: "target" } } } });
  f.owner.prepare("INSERT INTO hub_task_lifecycle_outcomes VALUES('other','old-squash',?)").run(body);
  const lateHistory = f.legacy.prepare("UPDATE hub_release_registry_history SET payload_json=? WHERE source_id='old-history'");
  const lateOutcome = f.legacy.prepare("UPDATE hub_task_lifecycle_outcomes SET result_json='{}' WHERE operation_id='old-squash'");
  const before = claimCustodyTaskSnapshot(f.owner, "target");
  lateHistory.run('{"committed":"before fence"}');
  assert.notEqual(claimCustodyTaskSnapshot(f.owner, "target").hash, before.hash);
  f.fence();
  assert.throws(() => lateHistory.run('{"late":true}'), /namespace authority/);
  assert.throws(() => lateOutcome.run(), /namespace authority/);
  assert.throws(() => f.legacy.prepare("INSERT INTO hub_task_lifecycle_outcomes VALUES('other','late-squash',?)").run(body), /namespace authority/);
});

test("new SQL permit is transactional, epoch pinned, absent after commit, and rolled back on error", async t => {
  const f = await fixture(t);
  f.fence();
  assert.throws(() => withClaimCustodySqlPermit(f.owner, { ...f.authority, epoch: "foreign" }, () => {}), /authority differs/);
  withClaimCustodySqlPermit(f.owner, f.authority, () => {
    f.owner.prepare("UPDATE hub_board_tasks SET value='successor' WHERE id='target'").run();
    assert.throws(() => f.cached.assignment.run("legacy while granted", "target"), /locked|busy/i);
  });
  assert.equal(f.owner.prepare("SELECT claim_custody_write_json FROM hub_mcp_operations WHERE request_id='fence'").get().claim_custody_write_json, null);
  assert.throws(() => withClaimCustodySqlPermit(f.owner, f.authority, () => {
    f.owner.prepare("UPDATE hub_board_tasks SET value='rollback' WHERE id='target'").run();
    throw Error("crash before commit");
  }), /crash before commit/);
  assert.equal(f.owner.prepare("SELECT value FROM hub_board_tasks WHERE id='target'").get().value, "successor");
  assert.throws(() => f.cached.assignment.run("late after grant", "target"), /namespace authority/);
});

test("old receipt and custody ledger cannot be deleted/replaced; new adapter never commits a permit", async t => {
  const f = await fixture(t);
  f.fence();
  for (const id of ["old", "fence"]) {
    assert.throws(() => f.legacy.prepare("DELETE FROM hub_mcp_operations WHERE request_id=?").run(id), /cannot be replaced/);
    assert.throws(() => f.legacy.prepare("INSERT OR REPLACE INTO hub_mcp_operations(request_id,receipt_state) VALUES(?,'failed')").run(id), /cannot be upserted/);
  }
  const body = f.owner.prepare("SELECT claim_custody_json FROM hub_mcp_operations WHERE request_id='fence'").get().claim_custody_json;
  assert.throws(() => f.legacy.prepare("INSERT OR REPLACE INTO hub_mcp_operations(request_id,claim_custody_json) VALUES('different',?)").run(body), /cannot be upserted/);
  f.legacy.prepare("INSERT INTO hub_mcp_operations(request_id) VALUES('other')").run();
  assert.throws(() => f.legacy.prepare("UPDATE OR REPLACE hub_mcp_operations SET request_id='fence' WHERE request_id='other'").run(), /another row/);
  let authorities = [];
  const db = claimCustodySqlConnection(f.owner, () => authorities);
  assert.throws(() => db.prepare("UPDATE hub_board_tasks SET value=? WHERE id=?").run("no intake epoch", "target"), /namespace authority/);
  authorities = [f.authority];
  db.exec("BEGIN IMMEDIATE");
  db.prepare("UPDATE hub_board_tasks SET value=? WHERE id=?").run("new", "target");
  assert.equal(db.prepare("SELECT claim_custody_write_json FROM hub_mcp_operations WHERE request_id='fence'").get().claim_custody_write_json, null);
  db.exec("COMMIT");
  assert.throws(() => f.legacy.prepare("UPDATE hub_mcp_operations SET receipt_state='failed' WHERE request_id='old'").run(), /cannot be replaced/);
  assert.equal(f.owner.prepare("SELECT receipt_state FROM hub_mcp_operations WHERE request_id='old'").get().receipt_state, "unknown");
});
