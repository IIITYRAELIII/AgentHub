import assert from "node:assert/strict";
import test from "node:test";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { claimCustodyFixture } from "../../fixtures/claim-custody-public-fixture.mjs";
import { HubMcpServer } from "../../../src/interfaces/mcp/hub-mcp-server.mjs";
import { mcpArgumentsHash } from "../../../src/domain/mcp-arguments-hash.mjs";

function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
async function endpoint(t, hub) {
  const server = new HubMcpServer({ service: hub, secret: "fixture-mcp-secret", requestTimeoutMs: 100,
    logger: { log() {}, error() {} } });
  await server.start(); t.after(() => server.close()); let id = 0;
  return async (name, args) => {
    const response = await fetch(server.url, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args } }) });
    return response.json();
  };
}

test("real MCP admits one held claim, reads live state and its terminal result without transport UNKNOWN or replay", async t => {
  const f = await claimCustodyFixture(t), entered = deferred(), release = deferred();
  const prepare = f.workspaces.prepareOwned.bind(f.workspaces); let effects = 0;
  f.workspaces.prepareOwned = async (...args) => { effects++; entered.resolve(); await release.promise; return prepare(...args); };
  const call = await endpoint(t, f.hub);
  const args = { context_token: f.successorToken, request_id: "held-submission", task_id: f.prior.id, dependency_mode: "skip" };
  let original;
  try {
    const start = performance.now();
    const reply = await call("hub_task_claim", args);
    t.diagnostic(JSON.stringify({ boundary: "public-mcp-durable-admission", elapsedMs: performance.now() - start,
      transportDeadlineMs: 100, workerHeldUntilAfterReply: true }));
    assert.equal(reply.error, undefined, "an admitted live Task is not a transport UNKNOWN");
    assert.equal(reply.result.isError, false);
    const receipt = reply.result.structuredContent.taskOperation;
    assert.equal(receipt.requestId, args.request_id); assert.equal(receipt.argumentsHash, mcpArgumentsHash(args));
    assert.equal(receipt.status, "pending"); assert.equal(receipt.active, true); assert.equal(receipt.terminal, false);
    await entered.promise;
    original = f.catalog.mcpOperation(args.request_id);
    const replay = await call("hub_task_claim", args);
    assert.equal(replay.result.structuredContent.taskOperation.requestId, args.request_id);
    assert.equal(effects, 1);
    const get = { context_token: f.successorToken, operation_request_id: args.request_id, original_arguments: args };
    const live = await call("hub_task_operation_get", get);
    assert.equal(live.result.structuredContent.taskOperation.active, true);
    const changed = await call("hub_task_claim", { ...args, dependency_mode: "ensure" });
    assert.equal(changed.result.isError, true); assert.equal(effects, 1);
    const foreign = await call("hub_task_operation_get", { ...get,
      context_token: f.hub.contextToken({ provider: "codex", threadId: `${f.prior.streamId}-thread` }) });
    assert.equal(foreign.result.isError, true);
  } finally { release.resolve(); await f.hub.call("hub_task_claim", args); }
  // Existing in-process terminal consumer joins the SAME running request.
  const completed = await f.hub.call("hub_task_claim", args);
  assert.equal(completed.id, f.prior.id); assert.equal(effects, 1);
  const terminal = await call("hub_task_operation_get", { context_token: f.managerToken,
    operation_request_id: args.request_id, expected_arguments_hash: original.argumentsHash });
  const value = terminal.result.structuredContent;
  assert.equal(value.taskOperation.status, "succeeded"); assert.equal(value.taskOperation.terminal, true);
  assert.equal(value.result.id, f.prior.id); assert.equal(value.result.gitWorkspace.projectRoot, completed.gitWorkspace.projectRoot);
  const after = f.catalog.mcpOperation(args.request_id);
  assert.equal(after.argumentsHash, original.argumentsHash); assert.equal(after.streamId, original.streamId);
  assert.equal(f.catalog.mcpOperations(f.prior.workspaceId).filter(row => row.requestId === args.request_id).length, 1);
});

test("lost admission reply uses original argument readback and a separate Task update remains independent", async t => {
  const f = await claimCustodyFixture(t), entered = deferred(), release = deferred();
  const prepare = f.workspaces.prepareOwned.bind(f.workspaces);
  f.workspaces.prepareOwned = async (...args) => { entered.resolve(); await release.promise; return prepare(...args); };
  const args = { context_token: f.successorToken, request_id: "lost-first-ack", task_id: f.prior.id, dependency_mode: "skip" };
  try {
    await f.hub.submitTaskOperation("hub_task_claim", args); // Drop the actual admission reply.
    await entered.promise;
    const result = await f.hub.call("hub_task_operation_get", { context_token: f.successorToken,
      operation_request_id: args.request_id, original_arguments: args });
    assert.equal(result.taskOperation.status, "pending"); assert.equal(result.taskOperation.active, true);
    await assert.rejects(f.hub.call("hub_task_operation_get", { context_token: f.successorToken,
      operation_request_id: args.request_id, original_arguments: { ...args, dependency_mode: "ensure" } }), /arguments differ/);
    const other = await f.tasks.create({ text: "Independent update", bucket: "workspace", workspaceId: f.prior.workspaceId });
    const update = { context_token: f.managerToken, request_id: "independent-update", task_id: other.id, description: "Updated once" };
    const admission = await f.hub.submitTaskOperation("hub_task_update", update);
    assert.equal(admission.taskOperation.requestId, update.request_id);
    const completed = await f.hub.call("hub_task_update", update);
    assert.equal(completed.description, "Updated once");
    assert.equal(f.catalog.mcpOperation(args.request_id).status, "pending");
  } finally { release.resolve(); await f.hub.call("hub_task_claim", args); }
});

test("ensure preparation keeps one worker and original-root admission/result diagnostics without recording arguments", async t => {
  const f = await claimCustodyFixture(t), spans = [];
  await writeFile(path.join(f.source.projectRoot, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages: {} }));
  await f.git(f.source.projectRoot, "add", "package-lock.json");
  await f.git(f.source.projectRoot, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "dependency fixture");
  f.hub.recordCommandTrace = span => { spans.push(span); };
  let preparations = 0;
  f.workspaces.prepareDependencies = async () => { preparations++; return { prepared: true }; };
  const args = { context_token: f.successorToken, request_id: "ensure-original", task_id: f.prior.id, dependency_mode: "ensure" };
  const submitted = await f.hub.submitTaskOperation("hub_task_claim", args);
  const result = await f.hub.call("hub_task_claim", args);
  assert.equal(result.id, f.prior.id);
  assert.equal(submitted.taskOperation.requestId, args.request_id);
  assert.equal(f.catalog.mcpOperation(args.request_id).status, "succeeded");
  assert.equal(preparations, 1);
  const stages = spans.filter(s => s.commandId === args.request_id);
  assert.deepEqual(stages.map(s => s.stage), ["task-operation-admitted", "task-operation-result"]);
  assert.ok(stages.every(s => !JSON.stringify(s).includes(f.successorToken) && !Object.hasOwn(s.metadata, "arguments")));
});

test("original failure and lost terminal receipt remain readable and never restart their mutation", async t => {
  const f = await claimCustodyFixture(t); let effects = 0;
  f.workspaces.prepareOwned = async () => { effects++; throw new Error("controlled original Git failure"); };
  const args = { context_token: f.successorToken, request_id: "real-unknown", task_id: f.prior.id, dependency_mode: "skip" };
  await f.hub.submitTaskOperation("hub_task_claim", args);
  await assert.rejects(f.hub.call("hub_task_claim", args), /controlled original Git failure/);
  const before = f.catalog.mcpOperation(args.request_id);
  assert.equal(before.status, "unknown");
  const read = await f.hub.submitTaskOperation("hub_task_claim", args);
  assert.equal(read.taskOperation.status, "unknown"); assert.equal(read.taskOperation.active, false);
  assert.match(read.taskOperation.error, /controlled original Git failure/);
  assert.equal(effects, 1); assert.deepEqual(f.catalog.mcpOperation(args.request_id), before);
});
