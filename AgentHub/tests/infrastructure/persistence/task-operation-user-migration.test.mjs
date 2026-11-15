import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { WorkspaceCatalogStore } from "../../../src/infrastructure/persistence/workspace-catalog-store.mjs";

test("existing MCP provider receipts, indexes, triggers and foreign keys survive nullable user-identity migration and reopen", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "task-user-migration-")), databaseFile = path.join(root, "hub.sqlite");
  const stores = []; t.after(async () => { for (const store of stores) store.close(); await rm(root, { recursive: true, force: true }); });
  const first = new WorkspaceCatalogStore({ databaseFile }); await first.load();
  const workspace = first.createWorkspace({ name: "Legacy" }), stream = first.createStream({ workspaceId: workspace.id, name: "Provider" });
  first.beginMcpOperation({ requestId: "legacy-provider", workspaceId: workspace.id, streamId: stream.id,
    provider: "codex", threadId: "real-provider-thread", toolName: "hub_task_claim", argumentsHash: "old-hash" });
  first.markMcpOperationUnknown("legacy-provider", new Error("retained original error"));
  const original = first.mcpOperation("legacy-provider"); first.close();
  // Build the prior NOT NULL identity shape using actual SQLite schema metadata.
  // This does not inspect production source text or alter an installed database.
  const db = new DatabaseSync(databaseFile);
  const definition = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='hub_mcp_operations'").get().sql;
  const objects = db.prepare("SELECT name,sql FROM sqlite_master WHERE tbl_name='hub_mcp_operations' AND type IN ('index','trigger') AND sql IS NOT NULL ORDER BY name").all();
  const rows = db.prepare("SELECT * FROM hub_mcp_operations").all();
  db.exec("PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE; CREATE TEMP TABLE saved AS SELECT * FROM hub_mcp_operations; DROP TABLE hub_mcp_operations;");
  db.exec(definition.replace(/(workspace_id|stream_id|provider|provider_thread_id) TEXT(?! NOT NULL)/g, "$1 TEXT NOT NULL"));
  db.exec("INSERT INTO hub_mcp_operations SELECT * FROM saved; DROP TABLE saved;");
  for (const object of objects) db.exec(object.sql);
  db.exec("COMMIT");
  assert.equal(db.prepare("PRAGMA table_info(hub_mcp_operations)").all().find(v => v.name === "stream_id").notnull, 1);
  db.close();
  const after = new WorkspaceCatalogStore({ databaseFile }); stores.push(after); await after.load();
  assert.deepEqual(after.mcpOperation("legacy-provider"), original);
  const check = new DatabaseSync(databaseFile);
  assert.deepEqual(check.prepare("SELECT * FROM hub_mcp_operations").all(), rows);
  assert.deepEqual(check.prepare("SELECT name,sql FROM sqlite_master WHERE tbl_name='hub_mcp_operations' AND type IN ('index','trigger') AND sql IS NOT NULL ORDER BY name").all(), objects);
  assert.deepEqual(check.prepare("PRAGMA foreign_key_check").all(), []);
  assert.equal(check.prepare("PRAGMA table_info(hub_mcp_operations)").all().find(v => v.name === "stream_id").notnull, 0);
  check.close();
  const binding = { version: 1, protocol: "task-operation-interruption-v1", taskId: "user-task", taskWorkspaceId: workspace.id,
    ownerId: "user-execution", arguments: { request_id: "real-user", task_id: "user-task", status: "testing" } };
  assert.throws(() => after.beginMcpOperation({ requestId: "fake-provider", workspaceId: workspace.id,
    streamId: null, provider: null, threadId: null, toolName: "hub_task_status_update", argumentsHash: "hash", taskExecution: binding }), /stream id/);
  assert.throws(() => after.beginMcpOperation({ requestId: "fake-user-claim", workspaceId: workspace.id,
    streamId: null, provider: null, threadId: null, actorKind: "authenticated-user", toolName: "hub_task_claim", argumentsHash: "hash", taskExecution: binding }), /user operation identity/);
  const receipt = after.beginMcpOperation({ requestId: "real-user", workspaceId: workspace.id, streamId: null,
    provider: null, threadId: null, actorKind: "authenticated-user", toolName: "hub_task_status_update", argumentsHash: "hash", taskExecution: binding });
  assert.equal(receipt.actorKind, "authenticated-user"); assert.equal(receipt.provider, null);
  const reopened = new WorkspaceCatalogStore({ databaseFile }); stores.push(reopened); await reopened.load();
  assert.deepEqual(reopened.mcpOperation("legacy-provider"), original);
  assert.deepEqual(reopened.mcpOperation("real-user"), after.mcpOperation("real-user"));
});
