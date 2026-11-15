import assert from "node:assert/strict";
import test from "node:test";
import { claimCustodyFixture } from "../../fixtures/claim-custody-public-fixture.mjs";
import { HubMcpServer } from "../../../src/interfaces/mcp/hub-mcp-server.mjs";
import { TaskLifecycleService } from "../../../src/application/task-lifecycle-service.mjs";
import { readReleaseToolPackage } from "../../../src/infrastructure/process/release-tool-package.mjs";
import { openReleaseApiHost } from "../../../src/interfaces/mcp/release-api-host.mjs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { ReleaseOperationStore } from "../../../src/infrastructure/persistence/release-operation-store.mjs";
import { ReleaseOperationService } from "../../../src/application/release-operation-service.mjs";
import { mcpArgumentsHash } from "../../../src/domain/mcp-arguments-hash.mjs";
const tool = await readReleaseToolPackage();
const { HubClient, executeRelease } = await tool.module("src/hub-client.mjs");
const { main } = await tool.module("bin/release.mjs");

test("external client uses real Hub HTTP, SQLite admission and original receipt without owning stores", async t => {
  const f = await claimCustodyFixture(t);
  f.hub.taskLifecycle = new TaskLifecycleService({ taskBoard: f.tasks, workspaceCatalog: f.catalog });
  const server = new HubMcpServer({ service: f.hub, secret: "external-release-test", logger: { log() {}, error() {} } });
  await server.start(); t.after(() => server.close());
  const client = new HubClient({ url: server.url, contextToken: f.managerToken });
  const original = { task_id: f.prior.id, request_id: "external-accept-original", status: "awaiting_implementation",
    expected_task_revision: f.prior.revision, expected_workflow_status: f.prior.workflowStatus };
  let acknowledged;
  const result = await executeRelease(client, "accept", original, { pollMs: 1, onAccepted: value => { acknowledged = value; } });
  assert.equal(acknowledged.taskOperation.requestId, original.request_id);
  assert.equal(result.taskOperation.status, "succeeded");
  assert.equal(result.taskOperation.terminal, true);
  assert.equal(f.tasks.task(f.prior.id).workflowStatus, "awaiting_implementation");
  const row = f.catalog.mcpOperation(original.request_id);
  assert.equal(row.status, "succeeded"); assert.equal(row.streamId, f.manager.id);
  const read = await client.readTaskOriginal(original);
  assert.equal(read.taskOperation.argumentsHash, row.argumentsHash);
  assert.deepEqual(f.catalog.mcpOperation(original.request_id), row);
  assert.equal(f.catalog.mcpOperations(f.prior.workspaceId).filter(x => x.requestId === original.request_id).length, 1);
  const foreign = new HubClient({ url: server.url, contextToken: f.successorToken });
  await assert.rejects(foreign.readTaskOriginal(original), /identity or authority differs/);
});

test("actual external command emits a tool pin and the same durable Hub result", async t => {
  const f = await claimCustodyFixture(t);
  f.hub.taskLifecycle = new TaskLifecycleService({ taskBoard: f.tasks, workspaceCatalog: f.catalog });
  const server = new HubMcpServer({ service: f.hub, secret: "external-command", logger: { log() {}, error() {} } });
  await server.start(); t.after(() => server.close());
  const connection = path.join(f.root, "connection.json"), requestFile = path.join(f.root, "business.json");
  await writeFile(connection, JSON.stringify({ url: server.url, contextToken: f.managerToken }), { mode: 0o600 });
  await writeFile(requestFile, JSON.stringify({ task_id: f.prior.id, request_id: "external-command-original",
    status: "awaiting_implementation", expected_task_revision: f.prior.revision,
    expected_workflow_status: f.prior.workflowStatus }));
  const output = [];
  const result = await main(["accept", "--connection-file", connection, "--request-file", requestFile], {
    output: row => output.push(row),
  });
  assert.equal(result.taskOperation.status, "succeeded");
  assert.equal(output[0].accepted.taskOperation.requestId, "external-command-original");
  assert.equal(output.at(-1).result.taskOperation.argumentsHash, f.catalog.mcpOperation("external-command-original").argumentsHash);
  assert.deepEqual(output[0].tool, output.at(-1).tool);
  assert.equal(output[0].tool.version, "0.1.0"); assert.match(output[0].tool.sha256, /^[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify(output).includes(f.managerToken));
});

test("Hub API close joins its admitted Task before closing stores, without replay", async t => {
  const f = await claimCustodyFixture(t);
  const lifecycle = new TaskLifecycleService({ taskBoard: f.tasks, workspaceCatalog: f.catalog });
  let release, entered;
  const held = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  let effects = 0, closed = false;
  f.hub.taskLifecycle = { async updateWorkflowStatus(options) {
    effects++; entered(); await held; return lifecycle.updateWorkflowStatus(options);
  } };
  const host = await openReleaseApiHost({ provider: "codex", threadId: `${f.manager.id}-thread` }, {
    openRuntime: async () => ({ service: f.hub, operations: { async drainAddressed() {} }, close() { closed = true; } }),
  });
  t.after(() => host.close());
  const client = new HubClient(host.connection);
  const original = { task_id: f.prior.id, request_id: "api-held-original", status: "awaiting_implementation",
    expected_task_revision: f.prior.revision, expected_workflow_status: f.prior.workflowStatus };
  const receipt = await executeRelease(client, "accept", original, { wait: false });
  assert.equal(receipt.taskOperation.active, true); await started;
  const closing = host.close();
  await new Promise(resolve => setImmediate(resolve)); assert.equal(closed, false);
  release(); await closing;
  assert.equal(closed, true); assert.equal(effects, 1);
  assert.equal(f.catalog.mcpOperation(original.request_id).status, "succeeded");
  assert.equal(f.tasks.task(f.prior.id).workflowStatus, "awaiting_implementation");
});

test("original release readback resolves its real indexed owner while preserving the UNKNOWN MCP receipt", async t => {
  const f = await claimCustodyFixture(t);
  await mkdir(path.join(f.root, "release-state"));
  const store = new ReleaseOperationStore({ dataDir: path.join(f.root, "release-state") });
  const forbidden = () => assert.fail("original readback must not schedule or perform a release effect");
  f.hub.releaseOperations = new ReleaseOperationService({ store, compose: forbidden, validate: forbidden,
    publishTarget: forbidden, readTarget: forbidden, finalize: forbidden, schedule: forbidden, processAlive: () => false });
  const original = { request_id: "lost-release-ack", validation_mode: "full",
    approved_targets: [{ targetId: "publication", kind: "agent-hub-publication" }] };
  const before = store.create({ operationId: "original-release", requestId: original.request_id,
    workspaceId: f.prior.workspaceId, streamId: f.manager.id, threadId: `${f.manager.id}-thread`,
    authorization: { taskIds: [f.prior.id], approvedTargets: original.approved_targets, validationMode: "full" },
    runnerVersion: "fixture-owner" }).operation;
  await f.catalog.beginMcpOperation({ requestId: original.request_id, workspaceId: f.prior.workspaceId,
    streamId: f.manager.id, provider: "codex", threadId: `${f.manager.id}-thread`,
    toolName: "hub_release_run", argumentsHash: mcpArgumentsHash(original) });
  await f.catalog.markMcpOperationUnknown(original.request_id, new Error("lost original admission reply"));
  const row = f.catalog.mcpOperation(original.request_id);
  const server = new HubMcpServer({ service: f.hub, secret: "release-readback-fixture", logger: { log() {}, error() {} } });
  await server.start(); t.after(() => server.close());
  const client = new HubClient({ url: server.url, contextToken: f.managerToken });
  const result = await client.readReleaseOriginal(original);
  assert.equal(result.operation.operationId, before.operationId);
  assert.equal(result.originalCommand.status, "unknown");
  assert.equal(result.originalCommand.argumentsHash, row.argumentsHash);
  assert.deepEqual(store.get(before.operationId), before);
  assert.deepEqual(f.catalog.mcpOperation(original.request_id), row);
  await assert.rejects(client.readReleaseOriginal({ ...original, validation_mode: "focused" }), /arguments differ/);
  const foreign = new HubClient({ url: server.url, contextToken: f.successorToken });
  await assert.rejects(foreign.readReleaseOriginal(original), /authority differs/);
  await assert.rejects(client.readReleaseOriginal({ ...original, request_id: "missing-original" }), /receipt is unavailable/);
  assert.deepEqual(f.catalog.mcpOperation(original.request_id), row);
});
