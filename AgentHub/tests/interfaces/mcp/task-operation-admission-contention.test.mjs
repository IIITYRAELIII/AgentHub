import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { HubMcpService } from "../../../src/application/hub-mcp-service.mjs";
import { HubMcpServer } from "../../../src/interfaces/mcp/hub-mcp-server.mjs";
import { TaskBoardService } from "../../../src/application/task-board-service.mjs";
import { WorkspaceCatalogStore } from "../../../src/infrastructure/persistence/workspace-catalog-store.mjs";
import { TaskBoardStore } from "../../../src/infrastructure/persistence/task-board-store.mjs";
import { createPersistenceMutationCapabilities } from "../../../src/composition/persistence-mutation-composition.mjs";
import { mcpArgumentsHash } from "../../../src/domain/mcp-arguments-hash.mjs";
import { DesktopTaskBoardController } from "../../../src/interfaces/desktop/desktop-task-board-controller.mjs";
import { AsyncSqliteMutationQueue } from "../../../src/infrastructure/persistence/async-sqlite-mutation-queue.mjs";
import { CommandTraceService } from "../../../src/application/command-trace-service.mjs";
import { CommandTraceWorkerStore } from "../../../src/infrastructure/persistence/command-trace-worker-store.mjs";
import { CommandTraceSpanStore } from "../../../src/infrastructure/persistence/command-trace-span-store.mjs";

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "hub-admission-contention-"));
  const databaseFile = path.join(root, "hub.sqlite");
  const catalog = new WorkspaceCatalogStore({ databaseFile });
  await catalog.load();
  const rawTasks = new TaskBoardStore({ databaseFile });
  let server;
  const cleanup = [];
  t.after(async () => { for (const close of cleanup.reverse()) await close();
    await server?.close(); rawTasks.close(); catalog.close(); await rm(root, { recursive: true, force: true }); });
  const caps = createPersistenceMutationCapabilities({ rawWorkspaceCatalogStore: catalog, rawTaskBoardStore: rawTasks });
  const tasks = new TaskBoardService({ store: caps.taskBoardStore, workspaceCatalog: caps.workspaceCatalogStore });
  const workspace = await caps.workspaceCatalogStore.createWorkspace({ name: "Admission fixture" });
  const streams = [];
  for (const name of ["Owner", "Foreign", "Manager"]) {
    const stream = await caps.workspaceCatalogStore.createStream({ workspaceId: workspace.id, name,
      settings: { releaseManager: name === "Manager" } });
    await caps.workspaceCatalogStore.bindThread({ streamId: stream.id, provider: "codex", threadId: name, projectRoot: root });
    streams.push(stream);
  }
  const task = await tasks.create({ text: "Admission fixture Task", bucket: "workspace", workspaceId: workspace.id });
  const spans = [];
  const service = new HubMcpService({ workspaceCatalog: caps.workspaceCatalogStore, taskBoard: tasks,
    workLog: { threadTurns: () => [] }, attachmentDirectory: path.join(root, "attachments"), secret: "isolated-admission-secret",
    releasePreflight: {
      preflight() { assert.fail("metadata admission cannot prepare release"); },
      withAwaitTransition() { assert.fail("metadata admission cannot enter Await"); },
    },
    releaseCompleter: { completeRelease() { assert.fail("metadata admission cannot publish"); } },
    reconcilePendingOnStartup: false, recordCommandTrace: span => { spans.push(span); } });
  server = new HubMcpServer({ service, secret: "isolated-http-secret", logger: { log() {}, error() {} } });
  await server.start();
  let rpc = 0;
  const call = async (name, args) => {
    const response = await fetch(server.url, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++rpc, method: "tools/call", params: { name, arguments: args } }) });
    assert.equal(response.status, 200);
    const reply = await response.json(); assert.equal(reply.error, undefined); return reply.result;
  };
  const token = service.contextToken({ provider: "codex", threadId: "Owner" });
  const input = id => ({ context_token: token, request_id: id, task_id: task.id, description: "one exact effect" });
  return { root, databaseFile, catalog, tasks, task, service, spans, call, token, input, streams,
    onCleanup: close => cleanup.push(close) };
}

test("exhausted real SQLite BEGIN reports this invocation unadmitted, then same original admits one effect", async t => {
  const f = await fixture(t), args = f.input("same-original-after-contention"), prior = f.tasks.task(f.task.id);
  const traceFile = path.join(f.root, "trace.sqlite"), store = new CommandTraceWorkerStore({ databaseFile: traceFile });
  f.onCleanup(() => store.close()); await store.initialize();
  const trace = new CommandTraceService({ store });
  const record = f.service.recordCommandTrace;
  f.service.recordCommandTrace = span => { record(span); return trace.recordBestEffort(span); };
  const blocker = new DatabaseSync(f.databaseFile);
  blocker.exec("PRAGMA busy_timeout=0; BEGIN IMMEDIATE");
  let reply;
  const started = performance.now();
  try {
    reply = await f.call("hub_task_update", args);
    assert.equal(f.catalog.mcpOperation(args.request_id), null);
    assert.deepEqual(f.tasks.task(f.task.id), prior);
  } finally { blocker.exec("ROLLBACK"); blocker.close(); }
  assert.equal(reply.isError, false, "owning admission exhaustion must have an explicit structured result");
  const refused = reply.structuredContent;
  assert.equal(refused.taskOperation, null); assert.equal(refused.result, null);
  assert.equal(refused.admission.status, "not_admitted");
  assert.equal(refused.admission.scope, "this_invocation");
  assert.equal(refused.admission.canonicalOutcome, null);
  assert.equal(refused.admission.requestId, args.request_id);
  assert.equal(refused.admission.argumentsHash, mcpArgumentsHash(args));
  assert.equal(refused.admission.toolName, "hub_task_update");
  assert.equal(refused.admission.reason, "sqlite_begin_contention");
  t.diagnostic(JSON.stringify({ boundary: "pre-receipt-BEGIN", elapsedMs: performance.now() - started, original: args.request_id }));
  // No automatic retry after refusal. Explicitly resubmit exact original only
  // after this fixture's actual conflicting transaction has been released.
  await f.call("hub_task_update", args);
  await f.service.call("hub_task_update", args);
  const first = f.tasks.task(f.task.id);
  await f.call("hub_task_update", args);
  assert.equal(first.revision, prior.revision + 1);
  assert.deepEqual(f.tasks.task(f.task.id), first);
  assert.equal(f.catalog.mcpOperation(args.request_id).status, "succeeded");
  assert.equal(f.catalog.mcpOperations(f.task.workspaceId).filter(r => r.requestId === args.request_id).length, 1);
  const timing = f.spans.filter(s => s.commandId === args.request_id && s.stage === "task-operation-admission-sqlite");
  assert.ok(timing.some(s => s.metadata.outcome === "error" && s.metadata.attempts > 1 && s.metadata.contentionWaitMs > 0));
  assert.ok(timing.some(s => s.metadata.outcome === "ok"));
  assert.ok(f.spans.every(s => !JSON.stringify(s).includes(f.token) && !JSON.stringify(s).includes(args.description)));
  await store.close();
  const reopened = new CommandTraceSpanStore({ databaseFile: traceFile });
  f.onCleanup(() => reopened.close());
  const saved = await reopened.readCommandTimeline(args.request_id);
  const refusal = saved.find(s => s.stage === "task-operation-not-admitted");
  const persistence = saved.find(s => s.stage === "task-operation-admission-sqlite" && s.metadata.outcome === "error");
  assert.equal(refusal.commandId, args.request_id);
  assert.ok(persistence.metadata.queueWaitMs >= 0 && persistence.metadata.persistenceMs >= 0);
  assert.ok(persistence.metadata.contentionWaitMs > 0 && persistence.metadata.attempts > 1);
  assert.ok(saved.every(s => !JSON.stringify(s).includes(f.token) && !JSON.stringify(s).includes(args.description)));
});

test("missing receipt lookup is an observation, never a fabricated admission or terminal outcome", async t => {
  const f = await fixture(t), args = f.input("absent-original");
  const reply = await f.call("hub_task_operation_get", { context_token: f.token,
    operation_request_id: args.request_id, original_arguments: args, task_id: f.task.id });
  assert.equal(reply.isError, false);
  assert.deepEqual(reply.structuredContent, { taskOperation: null, result: null,
    lookup: { version: 1, requestId: args.request_id, status: "not_found", canonicalOutcome: null } });
  assert.equal(f.catalog.mcpOperation(args.request_id), null);
  assert.equal(f.catalog.mcpOperations(f.task.workspaceId).length, 0);
});

test("short contention keeps existing queue progress and authenticated exact receipts without duplicate updates", async t => {
  const f = await fixture(t), args = f.input("short-contention"), prior = f.tasks.task(f.task.id);
  const blocker = new DatabaseSync(f.databaseFile); blocker.exec("PRAGMA busy_timeout=0; BEGIN IMMEDIATE");
  const release = setTimeout(() => blocker.exec("COMMIT"), 80);
  try { await Promise.all([f.call("hub_task_update", args), f.call("hub_task_update", args)]); }
  finally { clearTimeout(release); if (blocker.isTransaction) blocker.exec("ROLLBACK"); blocker.close(); }
  await f.service.call("hub_task_update", args);
  assert.equal(f.tasks.task(f.task.id).revision, prior.revision + 1);
  const foreign = f.service.contextToken({ provider: "codex", threadId: "Foreign" });
  const get = { context_token: f.token, operation_request_id: args.request_id, original_arguments: args };
  assert.equal((await f.call("hub_task_operation_get", { ...get, context_token: foreign })).isError, true);
  assert.equal((await f.call("hub_task_update", { ...args, context_token: foreign })).isError, true);
  assert.equal((await f.call("hub_task_update", { ...args, description: "changed business input" })).isError, true);
  assert.equal((await f.call("hub_task_operation_get", { ...get, expected_arguments_hash: "0".repeat(64) })).isError, true);
  assert.equal((await f.call("hub_task_operation_get", { ...get, task_id: "foreign-task" })).isError, true);
  assert.equal(f.tasks.task(f.task.id).revision, prior.revision + 1);
});

test("UNKNOWN and non-contention failure do not acquire pre-admission refusal authority", async t => {
  const f = await fixture(t), args = f.input("existing-unknown");
  await f.service.workspaceCatalog.beginMcpOperation({ requestId: args.request_id, workspaceId: f.task.workspaceId,
    streamId: f.streams[0].id, provider: "codex", threadId: "Owner", toolName: "hub_task_update", argumentsHash: mcpArgumentsHash(args) });
  await f.service.workspaceCatalog.markMcpOperationUnknown(args.request_id, new Error("ambiguous prior work"));
  const before = f.catalog.mcpOperation(args.request_id), prior = f.tasks.task(f.task.id);
  const result = await f.call("hub_task_update", args);
  assert.equal(result.structuredContent.taskOperation.status, "unknown");
  assert.equal(result.structuredContent.admission, undefined);
  assert.deepEqual(f.catalog.mcpOperation(args.request_id), before);
  const invalid = await f.call("hub_task_update", { ...f.input("invalid-title"), title: "" });
  assert.equal(invalid.structuredContent?.admission, undefined);
  assert.deepEqual(f.tasks.task(f.task.id), prior);
});

test("Task CAS is rechecked after real admission contention; a prior card read grants no write", async t => {
  const f = await fixture(t), prior = f.tasks.task(f.task.id);
  const args = { context_token: f.token, task_id: f.task.id, request_id: "stale-after-admission-wait",
    operation: "add", text: "Must not be appended", expected_task_revision: prior.revision };
  const blocker = new DatabaseSync(f.databaseFile); blocker.exec("PRAGMA busy_timeout=0; BEGIN IMMEDIATE");
  let update;
  const release = setTimeout(() => {
    blocker.exec("COMMIT");
    update = f.tasks.update({ id: f.task.id, title: prior.title, description: "A different lawful mutation won the CAS" });
    // Observe rejection immediately as well as joining below; the timer itself
    // does not leave a detached rejection if fixture initialization changes.
    update.catch(() => {});
  }, 80);
  try {
    await f.call("hub_task_checklist_update", args);
    await update;
    await assert.rejects(f.service.call("hub_task_checklist_update", args), /revision|unknown/i);
    const after = f.tasks.task(f.task.id);
    assert.equal(after.description, "A different lawful mutation won the CAS");
    assert.equal(after.revision, prior.revision + 1);
    assert.equal(after.checklist.length, 0);
    assert.notEqual(f.catalog.mcpOperation(args.request_id), null);
  } finally { clearTimeout(release); if (blocker.isTransaction) blocker.exec("ROLLBACK"); blocker.close(); }
});

test("Desktop Task owner preserves the same unadmitted response instead of manufacturing a successful snapshot", async t => {
  const f = await fixture(t), prior = f.tasks.task(f.task.id);
  const controller = new DesktopTaskBoardController({ taskBoard: f.tasks, workspaceCatalog: f.service.workspaceCatalog,
    taskLifecycle: f.service.taskLifecycle, hubMcpService: f.service, taskLauncher: {},
    snapshot() { assert.fail("an unadmitted Task cannot return a completed board snapshot"); } });
  const blocker = new DatabaseSync(f.databaseFile); blocker.exec("PRAGMA busy_timeout=0; BEGIN IMMEDIATE");
  let response;
  try { response = await controller.status({ id: f.task.id, status: "testing", operationId: "desktop-unadmitted" },
    { taskOperationReceipt: true }); }
  finally { blocker.exec("ROLLBACK"); blocker.close(); }
  assert.equal(response.taskOperation, null); assert.equal(response.admission.status, "not_admitted");
  assert.equal(response.admission.actorKind, "authenticated-user");
  assert.equal(response.admission.requestId, "desktop-unadmitted");
  assert.equal(f.catalog.mcpOperation("desktop-unadmitted"), null);
  assert.deepEqual(f.tasks.task(f.task.id), prior);
  const read = controller.read({ id: f.task.id, operationRequestId: "desktop-unadmitted" });
  assert.equal(read.operation.lookup.status, "not_found"); assert.equal(read.operation.taskOperation, null);
});

test("advisory queue timing failures preserve the exact operation result/error and leave no detached rejection", async () => {
  const queue = new AsyncSqliteMutationQueue(), result = { exact: "protected" }, failure = new Error("business failure");
  assert.equal(await queue.run(() => result, { onTiming() { throw new Error("diagnostic only"); } }), result);
  await assert.rejects(queue.run(() => { throw failure; }, { onTiming: async () => { throw new Error("async diagnostic only"); } }),
    error => error === failure);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(await queue.run(() => result), result);
});
