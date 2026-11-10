import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubMcpService } from "../../src/application/hub-mcp-service.mjs";
import { HubMcpServer } from "../../src/interfaces/mcp/hub-mcp-server.mjs";
import { TaskBoardService } from "../../src/application/task-board-service.mjs";
import { WorkspaceCatalogStore } from "../../src/infrastructure/persistence/workspace-catalog-store.mjs";
import { TaskBoardStore } from "../../src/infrastructure/persistence/task-board-store.mjs";
import { createPersistenceMutationCapabilities } from "../../src/composition/persistence-mutation-composition.mjs";
import { mcpArgumentsHash } from "../../src/domain/mcp-arguments-hash.mjs";

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "h434-"));
  const sessions = [], servers = [];
  t.after(async () => {
    for (const server of servers) await server.close();
    for (const s of sessions) { s.rawTasks.close(); s.rawCatalog.close(); }
    assert.equal(path.dirname(root), os.tmpdir());
    await rm(root, { recursive: true, force: true });
  });
  const open = async () => {
    const rawCatalog = new WorkspaceCatalogStore({ databaseFile: path.join(root, "fixture.sqlite") });
    await rawCatalog.load();
    const rawTasks = new TaskBoardStore({ databaseFile: path.join(root, "fixture.sqlite") });
    const caps = createPersistenceMutationCapabilities({ rawWorkspaceCatalogStore: rawCatalog, rawTaskBoardStore: rawTasks });
    const catalog = caps.workspaceCatalogStore;
    const tasks = new TaskBoardService({ store: caps.taskBoardStore, workspaceCatalog: catalog });
    const hub = new HubMcpService({ workspaceCatalog: catalog, taskBoard: tasks, secret: "fixture-secret",
      workLog: { threadTurns: async () => [] }, attachmentDirectory: root, reconcilePendingOnStartup: false,
      releasePreflight: { async preflight() { return {}; }, async withAwaitTransition(_id, operation) { return operation(); } },
      releasePlanner: { async plan() { return { ready: [] }; } },
      releaseCompleter: { async completeRelease() { return {}; } } });
    const s = { rawCatalog, rawTasks, catalog, tasks, hub }; sessions.push(s); return s;
  };
  const s = await open();
  const workspace = await s.catalog.createWorkspace({ name: "Confirmation fixture", settings: { workingDirectory: root } });
  const stream = await s.catalog.createStream({ workspaceId: workspace.id, name: "Owner" });
  await s.catalog.bindThread({ streamId: stream.id, provider: "codex", threadId: "fixture-thread", projectRoot: root });
  const task = await s.tasks.create({ text: "Preserve this card", bucket: "workspace", workspaceId: workspace.id });
  await s.tasks.update({ id: task.id, title: task.title, description: "Большое описание. ".repeat(6000) });
  const token = hub => hub.contextToken({ provider: "codex", threadId: "fixture-thread" });
  const args = { request_id: "preview", task_id: task.id };
  const endpoint = async hub => {
    const server = new HubMcpServer({ service: hub, secret: "fixture-http-secret", logger: { log() {}, error() {} } });
    servers.push(server); await server.start(); let id = 0;
    return async (name, payload) => {
      const response = await fetch(server.url, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: payload } }) });
      return (await response.json()).result;
    };
  };
  const read = (hub = s.hub, input = args) => hub.call("hub_task_operation_get", {
    context_token: token(hub), operation_request_id: input.request_id, task_id: task.id,
    expected_arguments_hash: mcpArgumentsHash(input),
  });
  const seed = async (name, input, result = null) => {
    await s.catalog.beginMcpOperation({ requestId: input.request_id, toolName: name, workspaceId: workspace.id,
      streamId: stream.id, provider: "codex", threadId: "fixture-thread", argumentsHash: mcpArgumentsHash(input),
      taskExecution: s.hub.taskOperationInterruption.binding(input) });
    if (result) await s.catalog.completeMcpOperation(input.request_id, result);
    else await s.catalog.markMcpOperationUnknown(input.request_id, new Error("Retained old validation diagnostic"));
    return s.catalog.mcpOperation(input.request_id);
  };
  return { ...s, root, workspace, stream, task, token, args, open, read, endpoint, seed };
}

for (const toolName of ["hub_task_complete", "hub_task_delete"]) test(`${toolName}: oversized preview survives pending ACK, first read, repeated read and restart`, async t => {
  const f = await fixture(t), call = await f.endpoint(f.hub);
  const reply = await call(toolName, { ...f.args, context_token: f.token(f.hub) });
  assert.equal(reply.isError, false);
  assert.equal(reply.structuredContent.taskOperation.status, "pending");
  // Join the existing admitted invocation; HTTP reply above intentionally contained no token.
  await f.hub.call(toolName, { ...f.args, context_token: f.token(f.hub) });
  const first = await f.read();
  assert.match(first.result.cleanupToken, /^[a-f0-9]{64}$/);
  assert.equal(first.result.action, toolName === "hub_task_complete" ? "complete" : "delete");
  assert.equal(first.result.task.id, f.task.id);
  assert.ok(Buffer.byteLength(JSON.stringify(first.result)) <= 65536);
  assert.deepEqual(await f.read(), first);
  const reopened = await f.open();
  assert.deepEqual(await f.read(reopened.hub), first);
  const confirmed = await reopened.hub.call(toolName, { task_id: f.task.id, request_id: "confirm",
    confirm_cleanup: true, expected_cleanup_token: first.result.cleanupToken, context_token: f.token(reopened.hub) });
  assert.equal(toolName === "hub_task_complete" ? confirmed.status : confirmed.deleted, toolName === "hub_task_complete" ? "done" : true);
});

test("missing and stale confirmations are definite pre-admission failures; lawful later closure still works", async t => {
  const f = await fixture(t), before = f.tasks.task(f.task.id);
  const preview = await f.hub.call("hub_task_complete", { ...f.args, context_token: f.token(f.hub) });
  for (const [request_id, extra] of [["missing", {}], ["stale", { expected_cleanup_token: "0".repeat(64) }]]) {
    const args = { task_id: f.task.id, request_id, confirm_cleanup: true, ...extra, context_token: f.token(f.hub) };
    await assert.rejects(f.hub.call("hub_task_complete", args), /confirmation/);
    assert.equal(f.catalog.mcpOperation(request_id).status, "failed");
    await assert.rejects(f.hub.call("hub_task_complete", args), /confirmation/);
    assert.equal(f.tasks.lifecycleTransition(request_id), null);
    assert.equal(f.tasks.lifecycleOutcome(request_id), null);
    assert.deepEqual(f.tasks.task(f.task.id), before);
  }
  const result = await f.hub.call("hub_task_complete", { task_id: f.task.id, request_id: "lawful",
    confirm_cleanup: true, expected_cleanup_token: preview.cleanupToken, context_token: f.token(f.hub) });
  assert.equal(result.status, "done");
});

test("legacy compacted preview gets an explicit fresh same-original capsule; legacy missing-token UNKNOWN settles without cleanup", async t => {
  const f = await fixture(t), before = f.tasks.task(f.task.id);
  const call = await f.endpoint(f.hub);
  const oldPreview = await f.seed("hub_task_complete", f.args, {
    receiptCompacted: true, outcome: "succeeded", taskId: f.task.id, resultType: "object",
  });
  const missing = { task_id: f.task.id, request_id: "old-confirm", confirm_cleanup: true };
  const oldConfirm = await f.seed("hub_task_complete", missing);
  const refused = await call("hub_task_complete", { ...missing, context_token: f.token(f.hub) });
  assert.equal(refused.structuredContent.taskOperation.status, "failed");
  const settled = f.catalog.mcpOperation(missing.request_id);
  assert.equal(settled.status, "failed");
  assert.deepEqual(settled.result.operatorReconciliation.previousReceipt, {
    status: oldConfirm.status, result: oldConfirm.result, error: oldConfirm.error,
    createdAtMs: oldConfirm.createdAtMs, completedAtMs: oldConfirm.completedAtMs,
  });
  assert.deepEqual(settled.taskExecution, oldConfirm.taskExecution);
  assert.deepEqual(f.tasks.task(f.task.id), before);
  assert.equal(f.tasks.lifecycleTransition(missing.request_id), null);
  const recoveredReply = await call("hub_task_complete", { ...f.args, context_token: f.token(f.hub) });
  const recovered = recoveredReply.structuredContent.result;
  assert.match(recovered.cleanupToken, /^[a-f0-9]{64}$/);
  assert.equal(recovered.previewRecovery.kind, "fresh-cleanup-preview-from-compacted-original-v1");
  assert.deepEqual(recovered.previewRecovery.previousReceipt.result, oldPreview.result);
  assert.equal(f.catalog.mcpOperation(f.args.request_id).completedAtMs, oldPreview.completedAtMs);
  const reopened = await f.open();
  assert.deepEqual((await f.read(reopened.hub)).result, recovered);
  assert.deepEqual(f.tasks.task(f.task.id), before);
});

test("legacy recovery refuses changed arguments, foreign callers and already admitted lifecycle work", async t => {
  const f = await fixture(t), args = { task_id: f.task.id, request_id: "legacy-missing", confirm_cleanup: true };
  const original = await f.seed("hub_task_complete", args);
  await assert.rejects(f.hub.call("hub_task_complete", { ...args, expected_cleanup_token: "a".repeat(64),
    context_token: f.token(f.hub) }), /already used/);
  const foreign = await f.catalog.createStream({ workspaceId: f.workspace.id, name: "Foreign" });
  await f.catalog.bindThread({ streamId: foreign.id, provider: "codex", threadId: "foreign", projectRoot: f.root });
  await assert.rejects(f.hub.call("hub_task_complete", { ...args,
    context_token: f.hub.contextToken({ provider: "codex", threadId: "foreign" }) }), /already used/);
  assert.deepEqual(f.catalog.mcpOperation(args.request_id), original);
  await f.tasks.beginLifecycleTransition({ id: f.task.id, operationId: args.request_id,
    kind: "complete", expectedRevision: f.tasks.task(f.task.id).revision });
  const admitted = f.tasks.lifecycleTransition(args.request_id);
  await assert.rejects(f.hub.call("hub_task_complete", { ...args, context_token: f.token(f.hub) }), /lifecycle admission/);
  assert.deepEqual(f.catalog.mcpOperation(args.request_id), original);
  assert.deepEqual(f.tasks.lifecycleTransition(args.request_id), admitted);
});

test("a validation-looking downstream failure after an effect stays UNKNOWN", async t => {
  const f = await fixture(t), args = { task_id: f.task.id, request_id: "partial-effect", confirm_cleanup: true,
    expected_cleanup_token: "a".repeat(64), context_token: f.token(f.hub) };
  f.hub.taskLifecycle.complete = async () => {
    await f.tasks.update({ id: f.task.id, title: f.task.title, description: "real synthetic mutation" });
    throw Object.assign(new Error("Task complete confirmation is stale or missing"), { code: "TASK_CLEANUP_CONFIRMATION_REJECTED" });
  };
  await assert.rejects(f.hub.call("hub_task_complete", args), /confirmation/);
  const unknown = f.catalog.mcpOperation(args.request_id);
  assert.equal(unknown.status, "unknown");
  await assert.rejects(f.hub.call("hub_task_complete", args), /unknown/);
  assert.deepEqual(f.catalog.mcpOperation(args.request_id), unknown);
  assert.equal(f.tasks.task(f.task.id).description, "real synthetic mutation");
});

test("concurrent same-original public preview recovery returns one durable capsule", async t => {
  const f = await fixture(t), call = await f.endpoint(f.hub);
  await f.seed("hub_task_complete", f.args, {
    receiptCompacted: true, outcome: "succeeded", taskId: f.task.id, resultType: "object",
  });
  const replies = await Promise.all([0, 1].map(() => call("hub_task_complete", { ...f.args, context_token: f.token(f.hub) })));
  assert.deepEqual(replies[0].structuredContent.result, replies[1].structuredContent.result);
  assert.match(replies[0].structuredContent.result.cleanupToken, /^[a-f0-9]{64}$/);
  assert.equal(f.catalog.mcpOperations(f.workspace.id).filter(x => x.requestId === f.args.request_id).length, 1);
});

test("missing token is rejected before even a downstream lifecycle callback can run", async t => {
  const f = await fixture(t); let calls = 0;
  f.hub.taskLifecycle.complete = async () => { calls++; throw new Error("downstream must not run"); };
  const args = { task_id: f.task.id, request_id: "invalid-before-callback", confirm_cleanup: true, context_token: f.token(f.hub) };
  await assert.rejects(f.hub.call("hub_task_complete", args), { code: "TASK_CLEANUP_CONFIRMATION_REJECTED" });
  assert.equal(calls, 0);
  assert.equal(f.catalog.mcpOperation(args.request_id).status, "failed");
});
