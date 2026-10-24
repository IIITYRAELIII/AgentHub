import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { claimCustodyFixture } from "../fixtures/claim-custody-public-fixture.mjs";

async function fixture(t) {
  const f = await claimCustodyFixture(t, { unassigned: true });
  f.prepare.claim_custody.admission = "isolated-source-v1";
  return f;
}

const foreignTask = "00000000-0000-4000-8000-000000000001";
for (const variant of ["foreign changed Task without forward", "genuine changed Task without forward", "genuine different mutating tool"]) {
  test(`declared successor ID survives ${variant} intake and still admits exactly once`, { timeout: 90000 }, async t => {
    const f = await fixture(t);
    const plan = await f.hub.call("hub_task_operation_reconcile", f.prepare);
    await f.hub.call("hub_task_operation_reconcile", f.fence(plan));
    const otherTool = variant.endsWith("mutating tool");
    const args = { context_token: variant.startsWith("genuine") ? f.successorToken : f.managerToken,
      request_id: f.consume.request_id,
      ...(otherTool ? { title: "must not create a Task", workspace_id: f.prior.workspaceId }
        : { task_id: foreignTask, dependency_mode: "ensure" }) };
    await assert.rejects(f.hub.call(otherTool ? "hub_task_create" : "hub_task_claim", args));
    assert.equal(f.catalog.mcpOperation(f.consume.request_id), null, "untrusted Task/tool cannot occupy a declared successor ID");
    assert.deepEqual(f.tasks.task(f.prior.id), f.prior);
    if (otherTool) {
      const created = await f.hub.call("hub_task_create", { ...args, request_id: "unrelated-valid-create" });
      assert.notEqual(created.id, f.prior.id);
      assert.equal(created.workflowStatus, "new");
    }
    const claimed = await f.hub.call("hub_task_claim", f.consume);
    assert.equal(claimed.streamId, f.successor.id);
    assert.equal(claimed.revision, f.prior.revision + 1);
    assert.deepEqual(await f.hub.call("hub_task_claim", f.consume), JSON.parse(JSON.stringify(claimed)));
    assert.deepEqual(f.catalog.mcpOperation(f.original.requestId), f.original);
    assert.equal(f.prepares(), 0);
  });
}

test("a cached old MCP INSERT cannot occupy the declared ID after the fence and reopen", { timeout: 90000 }, async t => {
  let old;
  t.after(() => old?.close());
  const f = await fixture(t);
  old = new DatabaseSync(path.join(f.root, "hub.sqlite"));
  const insert = old.prepare(`INSERT OR IGNORE INTO hub_mcp_operations
    (request_id, workspace_id, stream_id, provider, provider_thread_id, tool_name, arguments_hash, status, receipt_state, created_at_ms)
    VALUES (?, ?, ?, 'codex', ?, 'hub_task_create', 'foreign-hash', 'pending', 'pending', 1)`);
  const replace = old.prepare(`INSERT OR REPLACE INTO hub_mcp_operations
    (request_id, workspace_id, stream_id, provider, provider_thread_id, tool_name, arguments_hash, status, receipt_state, created_at_ms)
    VALUES (?, ?, ?, 'codex', ?, 'hub_task_create', 'foreign-hash', 'pending', 'pending', 1)`);
  await f.catalog.beginMcpOperation({ requestId: "unrelated-existing", workspaceId: f.original.workspaceId,
    streamId: f.manager.id, provider: "codex", threadId: `${f.manager.id}-thread`, toolName: "hub_task_create", argumentsHash: "unrelated-hash" });
  const rekey = old.prepare("UPDATE hub_mcp_operations SET request_id=? WHERE request_id='unrelated-existing'");
  const plan = await f.hub.call("hub_task_operation_reconcile", f.prepare);
  await f.hub.call("hub_task_operation_reconcile", f.fence(plan));
  assert.throws(() => insert.run(f.consume.request_id, f.prior.workspaceId, f.manager.id, `${f.manager.id}-thread`), /successor|another operation/i);
  assert.throws(() => rekey.run(f.consume.request_id), /successor|another operation/i);
  assert.equal(f.catalog.mcpOperation("unrelated-existing").argumentsHash, "unrelated-hash");
  assert.equal(f.catalog.mcpOperation(f.consume.request_id), null);
  const stores = await f.open();
  const hub = f.service(stores);
  const claimed = await hub.call("hub_task_claim", { ...f.consume,
    context_token: hub.contextToken({ provider: "codex", threadId: f.original.threadId }) });
  assert.equal(claimed.streamId, f.successor.id);
  assert.equal(claimed.revision, f.prior.revision + 1);
  assert.throws(() => insert.run(f.consume.request_id, f.prior.workspaceId, f.manager.id, `${f.manager.id}-thread`), /successor|another operation/i);
  assert.throws(() => replace.run(f.consume.request_id, f.prior.workspaceId, f.manager.id, `${f.manager.id}-thread`), /successor|another operation/i);
  assert.deepEqual(stores.catalog.mcpOperation(f.original.requestId), f.original);
  assert.equal(f.prepares(), 0);
});

test("a planned successor stays unoccupied until its matching fence and genuine claim", { timeout: 90000 }, async t => {
  const f = await fixture(t);
  const plan = await f.hub.call("hub_task_operation_reconcile", f.prepare);
  await assert.rejects(f.hub.call("hub_task_claim", { context_token: f.successorToken,
    request_id: f.consume.request_id, task_id: f.prior.id, dependency_mode: "ensure" }), /declared successor/i);
  assert.equal(f.catalog.mcpOperation(f.consume.request_id), null);
  await f.hub.call("hub_task_operation_reconcile", f.fence(plan));
  const claim = await f.hub.call("hub_task_claim", f.consume);
  assert.equal(claim.revision, f.prior.revision + 1);
  assert.equal(f.prepares(), 0);
});

test("an already occupied successor ID refuses preparation without replacing its receipt", { timeout: 90000 }, async t => {
  const f = await fixture(t);
  await f.catalog.beginMcpOperation({ requestId: f.consume.request_id, workspaceId: f.original.workspaceId,
    streamId: f.manager.id, provider: "codex", threadId: `${f.manager.id}-thread`, toolName: "hub_task_create", argumentsHash: "occupied" });
  const occupied = f.catalog.mcpOperation(f.consume.request_id);
  await assert.rejects(f.hub.call("hub_task_operation_reconcile", f.prepare), /successor ID is already occupied/);
  assert.deepEqual(f.catalog.mcpOperation(f.consume.request_id), occupied);
  assert.deepEqual(f.catalog.mcpOperation(f.original.requestId), f.original);
  assert.deepEqual(f.tasks.task(f.prior.id), f.prior);
  assert.equal(f.prepares(), 0);
});
