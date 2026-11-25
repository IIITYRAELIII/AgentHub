import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { HubMcpService } from "../../src/application/hub-mcp-service.mjs";
import { TaskBoardService } from "../../src/application/task-board-service.mjs";
import { createPersistenceMutationCapabilities } from "../../src/composition/persistence-mutation-composition.mjs";
import { TaskBoardStore } from "../../src/infrastructure/persistence/task-board-store.mjs";
import { WorkspaceCatalogStore } from "../../src/infrastructure/persistence/workspace-catalog-store.mjs";
import { mcpArgumentsHash } from "../../src/domain/mcp-arguments-hash.mjs";
import { TaskIntegrationGitService } from "../../src/infrastructure/filesystem/task-integration-git.mjs";
import { withInterprocessLocks } from "../../src/infrastructure/process/interprocess-lock.mjs";




function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function completionFailure(message) {
  return error => {
    assert.equal(error.code, "MCP_COMPLETION_PERSISTENCE_FAILED");
    assert.equal(error.errors[1].message, message);
    assert.equal(error.cause.code, "TASK_WORKFLOW_NO_EFFECT");
    return true;
  };
}

async function retainUnknownFixture(f, input) {
  const pending = f.catalog.mcpOperation(input.request_id);
  assert.equal(pending.status, "pending");
  assert.equal(pending.taskExecution.completionFailure.originalError.code, "TASK_WORKFLOW_NO_EFFECT");
  // This test's reconciler addresses an explicit UNKNOWN. A failed completion
  // write alone leaves pending; this separate fixture writer establishes UNKNOWN.
  await f.catalog.markMcpOperationUnknown(input.request_id, new Error("fixture resumed original classification"));
}

async function fixture(context, { releaseWorkflowEnabled = true, configuredRoot = true } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "hub-workflow-refusal-"));
  const databaseFile = path.join(root, "hub.sqlite");
  const opened = [];
  const open = async () => {
    const rawCatalog = new WorkspaceCatalogStore({ databaseFile });
    await rawCatalog.load();
    const rawTasks = new TaskBoardStore({ databaseFile });
    opened.push({ rawCatalog, rawTasks });
    const { workspaceCatalogStore: catalog, taskBoardStore } = createPersistenceMutationCapabilities({
      rawWorkspaceCatalogStore: rawCatalog, rawTaskBoardStore: rawTasks,
    });
    const tasks = new TaskBoardService({ store: taskBoardStore, workspaceCatalog: catalog });
    return { rawCatalog, rawTasks, catalog, tasks };
  };
  context.after(async () => {
    for (const item of opened) { item.rawTasks.close(); item.rawCatalog.close(); }
    await rm(root, { recursive: true, force: true });
  });
  const current = await open();
  const workspace = await current.catalog.createWorkspace({
    name: "Fixture", settings: { releaseWorkflowEnabled, ...(configuredRoot ? { workingDirectory: root } : {}) },
  });
  const stream = await current.catalog.createStream({ workspaceId: workspace.id, name: "RM", settings: { releaseManager: true } });
  await current.catalog.bindThread({ streamId: stream.id, provider: "codex", threadId: "fixture-thread", projectRoot: root });
  const task = await current.tasks.create({ text: "Fixture Task", bucket: "workspace", workspaceId: workspace.id });
  await current.tasks.setWorkflowStatus({ id: task.id, status: "testing" });
  while (current.tasks.task(task.id).revision < 17) {
    await current.tasks.update({ id: task.id, title: task.title, description: `fixture ${current.tasks.task(task.id).revision}` });
  }
  const entered = deferred();
  const release = deferred();
  context.after(() => release.resolve());
  let pause = false;
  let pauseOwnership = false;
  let leaseLost = false;
  let partialLeaseLoss = false;
  let effects = 0;
  let recoveryLocks = 0;
  let awaitFailure = null;
  let processGuard = false;
  let admissionOwner = null;
  const lease = () => ({ async assertOwned() {
    if (pauseOwnership) { pauseOwnership = false; entered.resolve(); await release.promise; }
    if (leaseLost) throw new Error("lease lost");
  }, signal: null });
  const git = {
    async assertNoProcessTreeGuardOwned() { if (processGuard) throw new Error("unresolved process-tree guard"); },
    async withTaskRecoveryLock(_id, operation) { recoveryLocks += 1; return operation({ async assertOwned() {}, signal: null }); },
    async withTaskRepositoryRecoveryLock(_id, _root, lease, operation) { return operation(lease); },
    async withTaskLock(_id, operation) {
      if (pause) { pause = false; entered.resolve(); await release.promise; }
      return operation(lease());
    },
    async prepareOwned() { effects += 1; if (partialLeaseLoss) leaseLost = true; throw new Error("unexpected prepare effect"); },
    async snapshotAndMergeOwned() { effects += 1; if (partialLeaseLoss) leaseLost = true; throw new Error("partial snapshot effect"); },
    async withdrawResultOwned() { effects += 1; throw new Error("unexpected withdrawal effect"); },
    async cleanupOwned() { effects += 1; },
    async cleanupPreview() { return {}; },
  };
  const service = (stores = current, startup = false) => new HubMcpService({
    workspaceCatalog: stores.catalog, taskBoard: stores.tasks,
    taskGitWorkspaces: git, workLog: { threadTurns: async () => [] },
    secret: "fixture-secret", attachmentDirectory: root, reconcilePendingOnStartup: startup,
    releasePlanner: { async plan() { return { ready: [] }; } },
    releaseCompleter: { async completeRelease() { return {}; } },
    releasePreflight: { async preflight() { return {}; }, async prepareAwaitSet() { return {}; },
      async withAwaitTransition(_id, operation) { if (awaitFailure) throw awaitFailure; return operation(); },
      awaitTransitionAdmissionNoEffect(workspaceId, error) { return admissionOwner?.awaitTransitionAdmissionNoEffect(workspaceId, error); } },
  });
  const hub = service();
  const token = hub.contextToken({ provider: "codex", threadId: "fixture-thread" });
  const input = { context_token: token, request_id: "workflow-original", task_id: task.id,
    status: "in_progress", expected_task_revision: 17, expected_workflow_status: "testing" };
  return { ...current, root, open, hub, service, token, input, task, workspace, stream,
    entered, release, pause() { pause = true; }, pauseOwnership() { pauseOwnership = true; },
    loseLease() { leaseLost = true; }, partialLeaseLoss() { partialLeaseLoss = true; },
    effects() { return effects; }, recoveryLocks() { return recoveryLocks; },
    failAwait(error) { awaitFailure = error; }, processGuard(value) { processGuard = value; },
    admissionOwner(owner) { admissionOwner = owner; } };
}

async function actualLockAdmissionError(f, workspaceId = f.workspace.id) {
  const key = createHash("sha256").update(workspaceId).digest("hex").slice(0, 24);
  const target = path.join(f.root, "locks", `release-await-${key}`), lock = `${target}.lock`;
  await mkdir(lock, { recursive: true });
  await writeFile(path.join(lock, "owner.json"), JSON.stringify({ token: "controlled-live-owner", pid: process.pid,
    processInstanceId: "controlled-other-lock-owner", createdAt: Date.now() }));
  let entered = 0;
  try {
    await withInterprocessLocks([target], () => { entered += 1; }, { timeoutMs: 10, retryDelayMs: 1,
      isProcessAlive: () => true, processIdentityState: () => "alive" });
    assert.fail("controlled lock must remain held");
  } catch (error) {
    assert.equal(entered, 0);
    assert.equal(error.code, "INTERPROCESS_LOCK_ADMISSION_TIMEOUT");
    return error;
  } finally { await rm(lock, { recursive: true, force: true }); }
}

test("a genuine Await lock admission refusal is durably failed without entering lifecycle", async context => {
  const f = await fixture(context);
  f.admissionOwner(new TaskIntegrationGitService({ dataDir: f.root }));
  f.failAwait(await actualLockAdmissionError(f));
  const input = { ...f.input, status: "awaiting_implementation" };
  await assert.rejects(f.hub.call("hub_task_status_update", input), error => error.code === "TASK_WORKFLOW_NO_EFFECT");
  assert.equal(f.catalog.mcpOperation(input.request_id).status, "failed");
  assert.equal(f.tasks.lifecycleTransition(input.request_id), null);
  assert.equal(f.tasks.lifecycleOutcome(input.request_id).result.noEffect.admissionFence.origin, "lock-acquire-refusal");
  assert.equal(f.effects(), 0);
});

for (const kind of ["forged", "foreign-lock"]) {
  test(`${kind} lock error cannot gain live Await admission refusal authority`, async context => {
    const f = await fixture(context);
    f.admissionOwner(new TaskIntegrationGitService({ dataDir: f.root }));
    const genuine = await actualLockAdmissionError(f, kind === "foreign-lock" ? "foreign-workspace" : f.workspace.id);
    const error = kind === "forged" ? Object.assign(new Error(genuine.message), { code: genuine.code }) : genuine;
    f.failAwait(error);
    const input = { ...f.input, status: "awaiting_implementation" };
    await assert.rejects(f.hub.call("hub_task_status_update", input), candidate => candidate === error);
    assert.equal(f.catalog.mcpOperation(input.request_id).status, "unknown");
    assert.equal(f.tasks.lifecycleTransition(input.request_id), null);
    assert.equal(f.tasks.lifecycleOutcome(input.request_id), null);
    assert.equal(f.effects(), 0);
  });
}

async function unadmittedAwait(f) {
  const input = { ...f.input, status: "awaiting_implementation" };
  const error = new Error("controlled failure before Await boundary entry");
  f.failAwait(error);
  await assert.rejects(f.hub.call("hub_task_status_update", input), candidate => candidate === error);
  f.failAwait(null);
  assert.equal(f.catalog.mcpOperation(input.request_id).status, "unknown");
  assert.equal(f.tasks.lifecycleTransition(input.request_id), null);
  assert.equal(f.tasks.lifecycleOutcome(input.request_id), null);
  return input;
}

function unadmittedReconciliation(f, input, extra = {}) {
  return { context_token: f.token, request_id: "unadmitted-await-reconcile", task_id: f.task.id,
    operation_request_id: input.request_id, expected_arguments_hash: mcpArgumentsHash(input),
    project_root: f.root, confirm_reconcile: true, expected_task_revision: 17,
    expected_workflow_status: "testing", ...extra };
}

async function historicalUnknownControl(f, args) {
  // Reconstruct the old control's canonical persisted admission/classification,
  // not a source-host retirement certificate or an invented lifecycle outcome.
  await f.catalog.beginMcpOperation({ requestId: args.request_id, workspaceId: f.workspace.id,
    streamId: f.stream.id, provider: "codex", threadId: "fixture-thread",
    toolName: "hub_task_operation_reconcile", argumentsHash: mcpArgumentsHash(args) });
  await f.catalog.markMcpOperationUnknown(args.request_id, new Error("historical pre-recovery lock timeout"));
  return f.catalog.mcpOperation(args.request_id);
}

test("a fresh reconciliation control refusing before its recovery callback is failed without touching the Await", async context => {
  const f = await fixture(context), input = await unadmittedAwait(f);
  const original = f.catalog.mcpOperation(input.request_id);
  f.failAwait(await actualLockAdmissionError(f));
  await assert.rejects(f.hub.call("hub_task_operation_reconcile", unadmittedReconciliation(f, input)), /lock/i);
  assert.equal(f.catalog.mcpOperation("unadmitted-await-reconcile").status, "failed");
  assert.deepEqual(f.catalog.mcpOperation(input.request_id), original);
  assert.equal(f.tasks.lifecycleOutcome(input.request_id), null);
  assert.equal(f.effects(), 0);
});

test("a saved UNKNOWN reconciliation control resumes its SAME owner and retains both original histories", async context => {
  const f = await fixture(context), input = await unadmittedAwait(f);
  const args = unadmittedReconciliation(f, input), before = f.tasks.task(f.task.id);
  const original = f.catalog.mcpOperation(input.request_id), control = await historicalUnknownControl(f, args);
  const second = await f.open(), hub = f.service(second);
  await assert.rejects(hub.call("hub_task_operation_reconcile", { ...args, expected_arguments_hash: "f".repeat(64) }));
  assert.deepEqual(second.catalog.mcpOperation(args.request_id), control);
  const result = await hub.call("hub_task_operation_reconcile", args);
  assert.equal(result.resolved, true);
  assert.equal(second.catalog.mcpOperation(args.request_id).status, "succeeded");
  assert.equal(second.catalog.mcpOperation(args.request_id).createdAtMs, control.createdAtMs);
  assert.deepEqual(second.catalog.mcpOperation(args.request_id).result.operatorReconciliation.previousReceipt, { ...control, replayed: true });
  assert.equal(second.catalog.mcpOperation(input.request_id).status, "failed");
  assert.deepEqual(second.tasks.lifecycleOutcome(input.request_id).result.noEffect.previousReceipt, original);
  assert.deepEqual(second.tasks.task(f.task.id), before);
  const repeat = await hub.call("hub_task_operation_reconcile", args);
  assert.deepEqual(repeat, second.catalog.mcpOperation(args.request_id).result);
  assert.equal(f.effects(), 0);
});

test("a resumed UNKNOWN reconciliation control refusing again preserves its prior ambiguous effects", async context => {
  const f = await fixture(context), input = await unadmittedAwait(f), args = unadmittedReconciliation(f, input);
  const original = f.catalog.mcpOperation(input.request_id);
  const control = await historicalUnknownControl(f, args);
  f.processGuard(true);
  await assert.rejects(f.hub.call("hub_task_operation_reconcile", args), /process-tree guard/);
  const after = f.catalog.mcpOperation(args.request_id);
  assert.deepEqual(after, control);
  assert.deepEqual(f.catalog.mcpOperation(input.request_id), original);
  assert.equal(f.tasks.lifecycleOutcome(input.request_id), null);
  assert.equal(f.effects(), 0);
});

test("lost reconciliation control completion reads the already settled admission refusal without another outcome write", async context => {
  const f = await fixture(context), input = await unadmittedAwait(f), args = unadmittedReconciliation(f, input);
  const complete = f.rawCatalog.completeMcpOperation.bind(f.rawCatalog);
  f.rawCatalog.completeMcpOperation = (id, value) => {
    if (id === args.request_id) throw new Error("controlled lost control completion");
    return complete(id, value);
  };
  await assert.rejects(f.hub.call("hub_task_operation_reconcile", args), /receipt reconciliation/);
  const original = f.catalog.mcpOperation(input.request_id), outcome = f.tasks.lifecycleOutcome(input.request_id);
  assert.equal(original.status, "failed");
  assert.equal(f.catalog.mcpOperation(args.request_id).status, "unknown");
  const second = await f.open();
  const result = await f.service(second).call("hub_task_operation_reconcile", args);
  assert.equal(result.resolved, true);
  assert.equal(second.catalog.mcpOperation(args.request_id).status, "succeeded");
  assert.deepEqual(second.catalog.mcpOperation(input.request_id), original);
  assert.deepEqual(second.tasks.lifecycleOutcome(input.request_id), outcome);
  assert.equal(f.effects(), 0);
});



test("ordinary Await with no lifecycle intent is fenced by its canonical outcome before SAME-original settlement", async context => {
  const f = await fixture(context);
  const input = await unadmittedAwait(f);
  const original = f.catalog.mcpOperation(input.request_id);
  const before = f.tasks.task(f.task.id);
  const second = await f.open();
  const hub = f.service(second);
  const args = unadmittedReconciliation(f, input);
  const result = await hub.call("hub_task_operation_reconcile", args);
  assert.equal(result.resolved, true);
  assert.equal(result.outcome, "failed");
  assert.equal(second.catalog.mcpOperation(input.request_id).status, "failed");
  assert.equal(second.catalog.mcpOperation(input.request_id).createdAtMs, original.createdAtMs);
  const outcome = second.tasks.lifecycleOutcome(input.request_id);
  assert.equal(outcome.result.noEffect.code, "WORKFLOW_AWAIT_NOT_ADMITTED");
  assert.deepEqual(outcome.result.noEffect.previousReceipt, original);
  assert.deepEqual(second.tasks.task(f.task.id), before);
  assert.equal(second.tasks.lifecycleTransition(input.request_id), null);
  assert.deepEqual(await hub.call("hub_task_operation_reconcile", args), result);
  // This connection existed before reconciliation. The existing SQL BEGIN
  // owner sees the new terminal outcome and cannot start the late original.
  await assert.rejects(f.tasks.beginLifecycleTransition({ id: f.task.id, operationId: input.request_id,
    expectedRevision: 17, targetWorkflowStatus: "awaiting_implementation" }), /terminal outcome/);
  await assert.rejects(f.hub.call("hub_task_status_update", input), /not admitted|NO_EFFECT|workflow/i);
  assert.deepEqual(second.tasks.lifecycleOutcome(input.request_id), outcome);
  assert.equal(f.effects(), 0);
});

test("ordinary MCP reconciles a foreign original Await using only the request id", async context => {
  const f = await fixture(context);
  const input = await unadmittedAwait(f);
  const original = f.catalog.mcpOperation(input.request_id);
  const callerWorkspace = await f.catalog.createWorkspace({ name: "Caller" });
  const caller = await f.catalog.createStream({ workspaceId: callerWorkspace.id, name: "Ordinary" });
  await f.catalog.bindThread({ streamId: caller.id, provider: "claude", threadId: "foreign-caller", projectRoot: f.root });
  const token = f.hub.contextToken({ provider: "claude", threadId: "foreign-caller" });
  const args = { context_token: token, operation_request_id: input.request_id };
  const reply = await f.hub.call("hub_task_operation_reconcile", args);
  assert.equal(reply.resolved, true);
  assert.equal(reply.reconciliation.outcome, "NO_EFFECT");
  const control = f.catalog.mcpOperations(callerWorkspace.id).find(row => row.toolName === "hub_task_operation_reconcile");
  assert.equal(control.workspaceId, callerWorkspace.id);
  assert.equal(control.threadId, "foreign-caller");
  assert.equal(f.catalog.mcpOperation(input.request_id).streamId, original.streamId);
  assert.deepEqual(f.tasks.lifecycleOutcome(input.request_id).result.noEffect.previousReceipt, original);
  assert.equal(f.effects(), 0);
});

test("ID-only reconciliation reads an authoritative database-only outcome without Git", async context => {
  const f = await fixture(context, { releaseWorkflowEnabled: false, configuredRoot: false });
  const complete = f.rawCatalog.completeMcpOperation.bind(f.rawCatalog);
  f.rawCatalog.completeMcpOperation = (id, value) => {
    if (id === f.input.request_id) throw new Error("lost workflow receipt completion");
    return complete(id, value);
  };
  await assert.rejects(f.hub.call("hub_task_status_update", f.input), /receipt reconciliation/);
  const before = f.catalog.mcpOperation(f.input.request_id);
  assert.equal(before.status, "unknown");
  const hub = f.service(await f.open());
  const reply = await hub.call("hub_task_operation_reconcile", { context_token: f.token, operation_request_id: f.input.request_id });
  assert.equal(reply.resolved, true);
  assert.equal(reply.result.workflowStatus, "in_progress");
  assert.equal(f.catalog.mcpOperation(f.input.request_id).status, "succeeded");
  assert.equal(f.effects(), 0);
  assert.equal(f.recoveryLocks(), 0);
});

test("an Await lifecycle BEGIN winning first preserves UNKNOWN instead of creating an unadmitted outcome", async context => {
  const f = await fixture(context);
  const input = await unadmittedAwait(f);
  await f.tasks.beginLifecycleTransition({ id: f.task.id, operationId: input.request_id,
    expectedRevision: 17, targetWorkflowStatus: "awaiting_implementation" });
  const original = f.catalog.mcpOperation(input.request_id);
  const second = await f.open();
  await assert.rejects(f.service(second).call("hub_task_operation_reconcile", unadmittedReconciliation(f, input)), /guard|intent/);
  assert.deepEqual(second.catalog.mcpOperation(input.request_id), original);
  assert.equal(second.tasks.lifecycleOutcome(input.request_id), null);
  assert.equal(f.effects(), 0);
});

test("a concurrent Task append at the refusal transaction cannot certify the stale original CAS", async context => {
  const f = await fixture(context), input = await unadmittedAwait(f);
  const original = f.catalog.mcpOperation(input.request_id), second = await f.open();
  const record = second.rawTasks.recordUnadmittedAwaitRefusal.bind(second.rawTasks);
  second.rawTasks.recordUnadmittedAwaitRefusal = payload => {
    // Deliberate two-connection negative: the older canonical store commits
    // metadata immediately before the new refusal transaction starts.
    f.rawTasks.updatePresentation(f.task.id, { title: f.task.title, description: "concurrent append" });
    return record(payload);
  };
  await assert.rejects(f.service(second).call("hub_task_operation_reconcile", unadmittedReconciliation(f, input)), /CAS changed/);
  assert.equal(second.tasks.task(f.task.id).revision, 18);
  assert.deepEqual(second.catalog.mcpOperation(input.request_id), original);
  assert.equal(second.tasks.lifecycleOutcome(input.request_id), null);
  assert.equal(f.effects(), 0);
});

test("a failed unadmitted-outcome write preserves the UNKNOWN original and cannot report successful reconciliation", async context => {
  const f = await fixture(context), input = await unadmittedAwait(f);
  const original = f.catalog.mcpOperation(input.request_id), second = await f.open();
  second.rawTasks.recordUnadmittedAwaitRefusal = () => { throw new Error("controlled outcome persistence failure"); };
  await assert.rejects(f.service(second).call("hub_task_operation_reconcile", unadmittedReconciliation(f, input)), /outcome persistence failure/);
  assert.deepEqual(second.catalog.mcpOperation(input.request_id), original);
  assert.equal(second.tasks.lifecycleOutcome(input.request_id), null);
  assert.equal(second.catalog.mcpOperation("unadmitted-await-reconcile").status, "unknown");
  assert.equal(f.effects(), 0);
});

for (const changed of ["hash", "cas", "root", "guard", "task-state", "process-guard"]) {
  test(`unadmitted Await refuses changed ${changed} without reclassifying its original`, async context => {
    const f = await fixture(context);
    const input = await unadmittedAwait(f);
    const original = f.catalog.mcpOperation(input.request_id);
    const extra = changed === "hash" ? { expected_arguments_hash: "0".repeat(64) }
      : changed === "cas" ? { expected_task_revision: 18 }
      : changed === "root" ? { project_root: path.join(f.root, "foreign") }
      : changed === "guard" ? { guard_id: "supplied-guard" } : {};
    if (changed === "task-state") await f.tasks.update({ id: f.task.id, title: f.task.title, description: "changed" });
    if (changed === "process-guard") f.processGuard(true);
    const second = await f.open();
    await assert.rejects(f.service(second).call("hub_task_operation_reconcile", unadmittedReconciliation(f, input, extra)));
    assert.equal(second.catalog.mcpOperation("unadmitted-await-reconcile").status, "failed");
    assert.deepEqual(second.catalog.mcpOperation(input.request_id), original);
    assert.equal(second.tasks.lifecycleOutcome(input.request_id), null);
    assert.equal(f.effects(), 0);
  });
}

for (const [configuredRoot, suppliedRoot] of [[false, true], [false, false], [true, true]]) {
  test(`database-only ${configuredRoot ? "configured-root" : "null-root"} ${suppliedRoot ? "locator" : "no locator"} owner refusal settles original after lost receipt write`, async (context) => {
    const f = await fixture(context, { releaseWorkflowEnabled: false, configuredRoot });
    const second = await f.open();
    await f.service(second).call("hub_task_update", { context_token: f.token, request_id: "database-only-append",
      task_id: f.task.id, description: "rev18" });
    f.rawCatalog.failMcpOperation = () => { throw new Error("lost receipt write"); };
    await assert.rejects(f.hub.call("hub_task_status_update", f.input), completionFailure("lost receipt write"));
    await retainUnknownFixture(f, f.input);
    const original = f.catalog.mcpOperation(f.input.request_id);
    const outcome = f.tasks.lifecycleOutcome(f.input.request_id);
    assert.equal(original.status, "unknown");
    assert.equal(original.taskExecution.completionFailure.persistenceError.message, "lost receipt write");
    assert.equal(outcome.result.noEffect.projectRoot, configuredRoot ? f.root : null);
    const reopened = await f.open();
    const hub = f.service(reopened, true);
    assert.deepEqual(reopened.catalog.mcpOperation(f.input.request_id), original);
    const args = { context_token: f.token, request_id: "database-only-reconcile", task_id: f.task.id,
      operation_request_id: f.input.request_id, ...(suppliedRoot ? { project_root: f.root } : {}), confirm_reconcile: true,
      expected_task_revision: 17, expected_workflow_status: "testing" };
    const schema = hub.tools().find((tool) => tool.name === "hub_task_operation_reconcile").inputSchema;
    assert.equal(schema.required.includes("project_root"), false);
    for (const required of schema.required) assert.notEqual(args[required], undefined);
    if (configuredRoot) {
      const wrongRoot = { ...args, request_id: "database-only-wrong-root", project_root: path.join(f.root, "other") };
      await assert.rejects(hub.call("hub_task_operation_reconcile", wrongRoot), /identity/);
      assert.equal(reopened.catalog.mcpOperation(wrongRoot.request_id).status, "failed");
      assert.deepEqual(reopened.catalog.mcpOperation(f.input.request_id), original);
    }
    const result = await hub.call("hub_task_operation_reconcile", args);
    assert.equal(result.resolved, true);
    assert.equal(result.reconciliation.outcome, "NO_EFFECT");
    assert.equal(reopened.catalog.mcpOperation(f.input.request_id).status, "failed");
    assert.equal(reopened.catalog.mcpOperation(args.request_id).status, "succeeded");
    assert.deepEqual(await hub.call("hub_task_operation_reconcile", args), result);
    await assert.rejects(hub.call("hub_task_status_update", f.input), /revision changed/);
    assert.deepEqual(reopened.tasks.lifecycleOutcome(f.input.request_id), outcome);
    assert.equal(reopened.tasks.task(f.task.id).revision, 18);
    assert.equal(reopened.tasks.task(f.task.id).workflowStatus, "testing");
    assert.equal(f.effects(), 0);
    assert.equal(f.recoveryLocks(), 0);
  });
}

for (const state of ["legacy", "admitted", "foreign", "corrupt"]) {
  test(`database-only ${state} evidence cannot gain rootless NO_EFFECT authority`, async (context) => {
    const f = await fixture(context, { releaseWorkflowEnabled: false, configuredRoot: false });
    if (state === "foreign" || state === "corrupt") {
      await f.tasks.update({ id: f.task.id, title: f.task.title, description: "rev18" });
      f.rawCatalog.failMcpOperation = () => { throw new Error("lost receipt write"); };
      await assert.rejects(f.hub.call("hub_task_status_update", f.input), completionFailure("lost receipt write"));
      await retainUnknownFixture(f, f.input);
      if (state === "corrupt") {
        // Fault injection affects only this disposable fixture's durable proof.
        const db = new DatabaseSync(path.join(f.root, "hub.sqlite"));
        try {
          const proof = f.tasks.lifecycleOutcome(f.input.request_id).result;
          proof.noEffect.argumentsHash = "0".repeat(64);
          db.prepare("UPDATE hub_task_lifecycle_outcomes SET result_json = ? WHERE operation_id = ?")
            .run(JSON.stringify(proof), f.input.request_id);
        } finally { db.close(); }
      }
    } else {
      await f.catalog.beginMcpOperation({ requestId: f.input.request_id, workspaceId: f.workspace.id, streamId: f.stream.id,
        provider: "codex", threadId: "fixture-thread", toolName: "hub_task_status_update", argumentsHash: mcpArgumentsHash(f.input) });
      if (state === "admitted") await f.tasks.beginLifecycleTransition({ id: f.task.id, operationId: f.input.request_id,
        expectedRevision: 17, targetWorkflowStatus: "in_progress" });
      await f.catalog.markMcpOperationUnknown(f.input.request_id, new Error("revision changed"));
    }
    const original = f.catalog.mcpOperation(f.input.request_id);
    const reopened = await f.open();
    const hub = f.service(reopened, true);
    const args = { context_token: f.token, request_id: `database-only-${state}-reconcile`, task_id: f.task.id,
      operation_request_id: f.input.request_id, confirm_reconcile: true, expected_task_revision: state === "foreign" ? 18 : 17,
      expected_workflow_status: "testing" };
    await assert.rejects(hub.call("hub_task_operation_reconcile", args), /identity/);
    assert.equal(reopened.catalog.mcpOperation(args.request_id).status, "failed");
    assert.equal(reopened.catalog.mcpOperation(args.request_id).result.outcome, "NO_EFFECT");
    assert.deepEqual(reopened.catalog.mcpOperation(f.input.request_id), original);
    assert.equal(f.effects(), 0);
    assert.equal(f.recoveryLocks(), 0);
  });
}

test("database-only ordinary admitted state cannot bypass release owner through the refusal branch", async (context) => {
  const f = await fixture(context, { releaseWorkflowEnabled: false });
  await f.catalog.beginMcpOperation({ requestId: f.input.request_id, workspaceId: f.workspace.id, streamId: f.stream.id,
    provider: "codex", threadId: "fixture-thread", toolName: "hub_task_status_update", argumentsHash: mcpArgumentsHash(f.input) });
  await f.tasks.beginLifecycleTransition({ id: f.task.id, operationId: f.input.request_id,
    expectedRevision: 17, targetWorkflowStatus: "in_progress" });
  await f.catalog.markMcpOperationUnknown(f.input.request_id, new Error("ambiguous worker"));
  const original = f.catalog.mcpOperation(f.input.request_id);
  const args = { context_token: f.token, request_id: "disabled-workflow-reconcile", task_id: f.task.id,
    operation_request_id: f.input.request_id, project_root: f.root, confirm_reconcile: true,
    expected_task_revision: 17, expected_workflow_status: "testing" };
  await assert.rejects(f.hub.call("hub_task_operation_reconcile", args), /guard id or original native Git intent/);
  assert.equal(f.catalog.mcpOperation(args.request_id).status, "failed");
  assert.equal(f.catalog.mcpOperation(args.request_id).result.outcome, "NO_EFFECT");
  assert.deepEqual(f.catalog.mcpOperation(f.input.request_id), original);
  assert.equal(f.tasks.lifecycleOutcome(f.input.request_id), null);
  assert.equal(f.effects(), 0);
  assert.equal(f.recoveryLocks(), 1);
});

test("SQL refusal settlement failure cannot certify the reconciler's own receipt as NO_EFFECT", async (context) => {
  const f = await fixture(context, { releaseWorkflowEnabled: false, configuredRoot: false });
  await f.tasks.update({ id: f.task.id, title: f.task.title, description: "rev18" });
  f.rawCatalog.failMcpOperation = () => { throw new Error("lost receipt write"); };
  await assert.rejects(f.hub.call("hub_task_status_update", f.input), completionFailure("lost receipt write"));
  await retainUnknownFixture(f, f.input);
  const original = f.catalog.mcpOperation(f.input.request_id);
  const reopened = await f.open();
  reopened.rawCatalog.failUnknownMcpOperation = () => { throw new Error("ambiguous settlement write"); };
  const args = { context_token: f.token, request_id: "lost-sql-settlement", task_id: f.task.id,
    operation_request_id: f.input.request_id, confirm_reconcile: true,
    expected_task_revision: 17, expected_workflow_status: "testing" };
  await assert.rejects(f.service(reopened).call("hub_task_operation_reconcile", args), /ambiguous settlement write/);
  assert.equal(reopened.catalog.mcpOperation(args.request_id).status, "unknown");
  assert.deepEqual(reopened.catalog.mcpOperation(f.input.request_id), original);
  assert.equal(f.effects(), 0);
  assert.equal(f.recoveryLocks(), 0);
});

test("public CAS refusal is durable NO_EFFECT after concurrent append 17 to 18 and same-ID reopen", async (context) => {
  const f = await fixture(context);
  f.pause();
  const original = f.hub.call("hub_task_status_update", f.input);
  const rejection = assert.rejects(original, /revision changed/);
  await f.entered.promise;
  const second = await f.open();
  const other = f.service(second);
  const appended = await other.call("hub_task_update", {
    context_token: f.token, request_id: "concurrent-description-append", task_id: f.task.id, description: "rev18 append",
  });
  assert.equal(appended.revision, 18);
  f.release.resolve();
  await rejection;
  const receipt = f.catalog.mcpOperation(f.input.request_id);
  assert.equal(receipt.status, "failed");
  assert.equal(receipt.result.outcome, "NO_EFFECT");
  const outcome = f.tasks.lifecycleOutcome(f.input.request_id);
  assert.equal(outcome.result.noEffect.code, "WORKFLOW_REVISION_CHANGED");
  assert.equal(f.tasks.lifecycleTransition(f.input.request_id), null);
  assert.equal(f.tasks.task(f.task.id).revision, 18);
  assert.equal(f.tasks.task(f.task.id).workflowStatus, "testing");
  const reopened = await f.open();
  await assert.rejects(f.service(reopened, true).call("hub_task_status_update", f.input), /revision changed/);
  assert.deepEqual(reopened.catalog.mcpOperation(f.input.request_id), receipt);
  assert.deepEqual(reopened.tasks.lifecycleOutcome(f.input.request_id), outcome);
  assert.equal(f.effects(), 0);
});

test("public reconciler pre-effect refusal fails its own receipt but leaves ambiguous original UNKNOWN", async (context) => {
  const f = await fixture(context);
  await f.catalog.beginMcpOperation({ requestId: "legacy", workspaceId: f.workspace.id, streamId: f.stream.id,
    provider: "codex", threadId: "fixture-thread", toolName: "hub_task_status_update", argumentsHash: "legacy-hash" });
  await f.catalog.markMcpOperationUnknown("legacy", new Error("Task workflow cutover revision changed"));
  const original = f.catalog.mcpOperation("legacy");
  const args = { context_token: f.token, request_id: "refused-reconcile", task_id: f.task.id,
    operation_request_id: "legacy", project_root: f.root, confirm_reconcile: true };
  await assert.rejects(f.hub.call("hub_task_operation_reconcile", args), /identity/);
  const receipt = f.catalog.mcpOperation(args.request_id);
  assert.equal(receipt.status, "failed");
  assert.equal(receipt.result.outcome, "NO_EFFECT");
  assert.deepEqual(f.catalog.mcpOperation("legacy"), original);
  const reopened = await f.open();
  await assert.rejects(f.service(reopened, true).call("hub_task_operation_reconcile", args), /identity/);
  assert.deepEqual(reopened.catalog.mcpOperation("legacy"), original);
  assert.equal(f.effects(), 0);
});

for (const boundary of ["unknown", "pending"]) {
  test(`outcome survives failed receipt write and ${boundary === "unknown" ? "canonical original-ID reconciliation" : "startup"} settles without effects`, async (context) => {
    const f = await fixture(context);
    await f.tasks.update({ id: f.task.id, title: f.task.title, description: "rev18" });
    const fail = f.rawCatalog.failMcpOperation.bind(f.rawCatalog);
    f.rawCatalog.failMcpOperation = () => { throw new Error("receipt settlement unavailable"); };
    if (boundary === "pending") f.rawCatalog.markMcpOperationUnknown = () => null;
    await assert.rejects(f.hub.call("hub_task_status_update", f.input), completionFailure("receipt settlement unavailable"));
    assert.equal(f.catalog.mcpOperation(f.input.request_id).status, "pending");
    if (boundary === "unknown") {
      // Exercise the already-supported explicit UNKNOWN recovery state as well
      // as the pending receipt left by a failed completion writer.
      await f.catalog.markMcpOperationUnknown(f.input.request_id, new Error("fixture explicit UNKNOWN readback"));
    }
    assert.equal(f.catalog.mcpOperation(f.input.request_id).status, boundary);
    const outcome = f.tasks.lifecycleOutcome(f.input.request_id);
    assert.equal(outcome.result.noEffect.code, "WORKFLOW_REVISION_CHANGED");
    f.rawCatalog.failMcpOperation = fail;
    const reopened = await f.open();
    const hub = f.service(reopened, boundary === "pending");
    if (boundary === "unknown") {
      const args = { context_token: f.token, request_id: "settle-original-refusal", task_id: f.task.id,
        operation_request_id: f.input.request_id, project_root: f.root, confirm_reconcile: true,
        expected_task_revision: 17, expected_workflow_status: "testing" };
      const result = await hub.call("hub_task_operation_reconcile", args);
      assert.equal(result.resolved, true);
      assert.equal(result.reconciliation.outcome, "NO_EFFECT");
      assert.deepEqual(await hub.call("hub_task_operation_reconcile", args), result);
    }
    await assert.rejects(hub.call("hub_task_status_update", f.input), /revision changed/);
    assert.equal(reopened.catalog.mcpOperation(f.input.request_id).status, "failed");
    assert.deepEqual(reopened.tasks.lifecycleOutcome(f.input.request_id), outcome);
    assert.equal(reopened.tasks.task(f.task.id).revision, 18);
    assert.equal(f.effects(), 0);
    await assert.rejects(reopened.tasks.beginLifecycleTransition({ id: f.task.id, operationId: f.input.request_id,
      expectedRevision: 18, targetWorkflowStatus: "in_progress" }), /terminal outcome/);
    assert.equal(reopened.tasks.lifecycleTransition(f.input.request_id), null);
  });
}

test("status-only refusal retains exact argument shape and wrong selection cannot settle it", async (context) => {
  const f = await fixture(context);
  const input = { ...f.input, expected_workflow_status: "in_progress" };
  delete input.expected_task_revision;
  f.rawCatalog.failMcpOperation = () => { throw new Error("lost receipt write"); };
  await assert.rejects(f.hub.call("hub_task_status_update", input), completionFailure("lost receipt write"));
  await retainUnknownFixture(f, input);
  assert.equal(f.tasks.lifecycleOutcome(input.request_id).result.noEffect.code, "WORKFLOW_STATUS_CHANGED");
  const reopened = await f.open();
  const hub = f.service(reopened);
  const args = { context_token: f.token, request_id: "wrong-refusal-selection", task_id: f.task.id,
    operation_request_id: input.request_id, project_root: f.root, confirm_reconcile: true,
    expected_task_revision: 17, expected_workflow_status: "in_progress" };
  await assert.rejects(hub.call("hub_task_operation_reconcile", args), /identity/);
  assert.equal(reopened.catalog.mcpOperation(input.request_id).status, "unknown");
  assert.equal(reopened.catalog.mcpOperation(args.request_id).status, "failed");
  const exact = { ...args, request_id: "exact-refusal-selection" };
  delete exact.expected_task_revision;
  assert.equal((await hub.call("hub_task_operation_reconcile", exact)).resolved, true);
  assert.equal(f.effects(), 0);
});

for (const state of ["admitted", "legacy", "foreign"]) {
  test(`${state} receipt cannot acquire a retroactive admission refusal certificate`, async (context) => {
    const f = await fixture(context);
    await f.catalog.beginMcpOperation({ requestId: f.input.request_id, workspaceId: f.workspace.id, streamId: f.stream.id,
      provider: "codex", threadId: "fixture-thread", toolName: "hub_task_status_update", argumentsHash: mcpArgumentsHash(f.input) });
    if (state === "admitted") await f.tasks.beginLifecycleTransition({ id: f.task.id, operationId: f.input.request_id,
      expectedRevision: 17, targetWorkflowStatus: "in_progress" });
    await f.tasks.update({ id: f.task.id, title: f.task.title, description: "rev18" });
    if (state !== "admitted") await f.catalog.markMcpOperationUnknown(f.input.request_id, new Error("revision changed"));
    const input = state === "foreign" ? { ...f.input, expected_task_revision: 18 } : f.input;
    await assert.rejects(f.hub.call("hub_task_status_update", input));
    assert.equal(f.tasks.lifecycleOutcome(f.input.request_id), null);
    assert.equal(f.catalog.mcpOperation(f.input.request_id).status, "unknown");
    assert.equal(f.effects(), 0);
  });
}

test("an active original worker cannot be settled by a parallel reconciler", async (context) => {
  const f = await fixture(context);
  f.pause();
  const original = f.hub.call("hub_task_status_update", f.input);
  const rejected = assert.rejects(original);
  await f.entered.promise;
  await assert.rejects(f.hub.call("hub_task_operation_reconcile", { context_token: f.token,
    request_id: "active-reconcile", task_id: f.task.id, operation_request_id: f.input.request_id,
    project_root: f.root, confirm_reconcile: true }), /active/);
  assert.equal(f.catalog.mcpOperation(f.input.request_id).status, "pending");
  assert.equal(f.catalog.mcpOperation("active-reconcile").status, "failed");
  assert.equal(f.tasks.lifecycleOutcome(f.input.request_id), null);
  f.release.resolve();
  await rejected;
  assert.equal(f.catalog.mcpOperation(f.input.request_id).status, "unknown");
});

test("partial Git effect stays UNKNOWN through restart and refuses reconciliation without proof", async (context) => {
  const f = await fixture(context);
  f.partialLeaseLoss();
  const input = { ...f.input, status: "testing" };
  await assert.rejects(f.hub.call("hub_task_status_update", input), /unexpected prepare effect|partial snapshot effect/);
  assert.equal(f.effects(), 1);
  assert.equal(f.tasks.lifecycleOutcome(input.request_id), null);
  const original = f.catalog.mcpOperation(input.request_id);
  assert.equal(original.status, "unknown");
  const reopened = await f.open();
  const hub = f.service(reopened, true);
  await assert.rejects(hub.call("hub_task_status_update", input), /unknown/);
  await assert.rejects(hub.call("hub_task_operation_reconcile", { context_token: f.token,
    request_id: "partial-reconcile", task_id: f.task.id, operation_request_id: input.request_id,
    project_root: f.root, confirm_reconcile: true, expected_task_revision: 17,
    expected_workflow_status: "testing" }), /recoverable|guard/);
  assert.equal(reopened.catalog.mcpOperation("partial-reconcile").status, "failed");
  assert.deepEqual(reopened.catalog.mcpOperation(input.request_id), original);
  assert.equal(f.effects(), 1);
});

test("concurrent append between initial CAS and BEGIN seals the rolled-back admission refusal", async (context) => {
  const f = await fixture(context);
  f.pauseOwnership();
  const original = f.hub.call("hub_task_status_update", f.input);
  const rejected = assert.rejects(original, /revision changed/);
  await f.entered.promise;
  const second = await f.open();
  await f.service(second).call("hub_task_update", { context_token: f.token, request_id: "late-append",
    task_id: f.task.id, description: "append after initial CAS" });
  f.release.resolve();
  await rejected;
  assert.equal(f.tasks.task(f.task.id).revision, 18);
  assert.equal(f.catalog.mcpOperation(f.input.request_id).status, "failed");
  assert.equal(f.catalog.mcpOperation(f.input.request_id).result.outcome, "NO_EFFECT");
  assert.equal(f.tasks.lifecycleTransition(f.input.request_id), null);
  assert.equal(f.tasks.lifecycleOutcome(f.input.request_id).result.noEffect.observedRevision, 18);
  assert.equal(f.effects(), 0);
});

test("lost lease cannot issue an admission refusal certificate", async (context) => {
  const f = await fixture(context);
  await f.tasks.update({ id: f.task.id, title: f.task.title, description: "rev18" });
  f.loseLease();
  await assert.rejects(f.hub.call("hub_task_status_update", f.input), /lease lost/);
  assert.equal(f.catalog.mcpOperation(f.input.request_id).status, "unknown");
  assert.equal(f.tasks.lifecycleOutcome(f.input.request_id), null);
  assert.equal(f.effects(), 0);
});
