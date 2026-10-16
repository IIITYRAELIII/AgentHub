import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WorkspaceCatalogStore } from "../../src/infrastructure/persistence/workspace-catalog-store.mjs";
import { TaskBoardStore } from "../../src/infrastructure/persistence/task-board-store.mjs";
import { TaskBoardService } from "../../src/application/task-board-service.mjs";
import { TaskLifecycleService } from "../../src/application/task-lifecycle-service.mjs";
import { TaskOperationReconciliationService } from "../../src/application/task-operation-reconciliation-service.mjs";
import { mcpArgumentsHash } from "../../src/domain/mcp-arguments-hash.mjs";

test("a new ordinary Await retains the failed predecessor and resumes only its own pending receipt", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "await-successor-"));
  const catalog = new WorkspaceCatalogStore({ databaseFile: path.join(root, "tasks.sqlite") }); await catalog.load();
  const store = new TaskBoardStore({ databaseFile: path.join(root, "tasks.sqlite") });
  t.after(async () => { store.close(); catalog.close(); assert.equal(path.dirname(root), os.tmpdir()); await rm(root, { recursive: true, force: true }); });
  const workspace = await catalog.runMutation(() => catalog.createWorkspace({ name: "Fixture",
    settings: { workingDirectory: root, releaseWorkflowEnabled: true } }));
  const stream = await catalog.runMutation(() => catalog.createStream({ workspaceId: workspace.id, name: "Executor" }));
  const board = new TaskBoardService({ store, workspaceCatalog: catalog });
  const created = store.create({ text: "Fix", bucket: "workspace", workspaceId: workspace.id });
  await board.claim({ id: created.id, workspaceId: workspace.id, streamId: stream.id,
    provider: "codex", threadId: "fixture", turnId: "turn", operationId: "claim" });
  const source = "a".repeat(40), reference = { projectRoot: root, branch: "HUB-1", resultCommit: source };
  await board.beginLifecycleTransition({ id: created.id, operationId: "test", kind: "workflow",
    targetWorkflowStatus: "testing", expectedRevision: board.task(created.id).revision });
  await board.commitWorkflowTransition({ operationId: "test", gitReferences: [reference], evidence: { resultCommit: source } });
  const task = structuredClone(board.task(created.id));
  const admit = async operationId => catalog.runMutation(() => catalog.beginMcpOperation({ requestId: operationId,
    workspaceId: workspace.id, streamId: stream.id, provider: "codex", threadId: "fixture", toolName: "hub_task_status_update",
    argumentsHash: mcpArgumentsHash({ request_id: operationId, task_id: task.id, status: "awaiting_implementation",
      expected_task_revision: task.revision, expected_workflow_status: "testing" }) }));
  await admit("failed-original");
  await board.beginLifecycleTransition({ id: task.id, operationId: "failed-original", kind: "workflow",
    targetWorkflowStatus: "awaiting_implementation", expectedRevision: task.revision });
  await board.failLifecycleTransition("failed-original", new Error("clone protection refusal"));
  await catalog.runMutation(() => catalog.failMcpOperation("failed-original", new Error("clone protection refusal")));
  const retained = structuredClone(catalog.mcpOperation("failed-original"));
  const original = { operationId: "failed-original", taskId: task.id, workspaceId: workspace.id,
    taskRevision: task.revision, resultCommit: source, argumentsHash: retained.argumentsHash, originMainCommit: "d".repeat(40) };
  const lease = { async assertOwned() {} };
  let guard = false, failFinal = false, effects = 0, archive = original;
  const git = {
    withTaskLock: (_id, op) => op(lease), withTaskRecoveryLock: (_id, op) => op(lease),
    withTaskRepositoryRecoveryLock: (_id, _root, _lease, op) => op(lease),
    prepareOwned: async () => assert.fail("Task preparation replay"),
    snapshotAndMergeOwned: async () => assert.fail("Test replay"),
    cleanupOwned: async () => assert.fail("cleanup"), cleanupPreview: async () => ({}),
    assertNoProcessTreeGuardOwned: async () => { if (guard) throw new Error("real process guard"); },
  };
  const preflight = {
    withAwaitTransition: (_id, op) => op(), archivedNativeAwaitOriginal: async () => archive,
    pendingNativeAwaitRecovery: async ({ original: current }) => ({ original: current }),
    prepareAwaitAcceptance: async ({ operationId, nativeAwaitRecovery, commitPrepared }) => {
      effects++;
      assert.equal(nativeAwaitRecovery.operationId, operationId);
      assert.deepEqual(nativeAwaitRecovery.predecessor, original);
      return commitPrepared({ planRevision: "plan", task: { taskId: task.id, resultCommit: source },
        verifyNativeAwaitAuthority: async () => { if (failFinal) throw Object.assign(new Error("current origin drift"), { code: "AWAIT_PREPARATION_UNKNOWN" }); } });
    },
  };
  const lifecycle = new TaskLifecycleService({ taskBoard: board, workspaceCatalog: catalog, taskGitWorkspaces: git, releasePreflight: preflight });
  const request = async operationId => {
    await admit(operationId);
    return lifecycle.updateWorkflowStatus({ taskId: task.id, operationId, status: "awaiting_implementation",
      projectRoot: root, expectedRevision: task.revision, expectedWorkflowStatus: "testing" });
  };
  const readReceipt = catalog.mcpOperation.bind(catalog), readTransition = board.lifecycleTransition.bind(board);
  catalog.mcpOperation = id => id === original.operationId ? { ...readReceipt(id), receiptState: "unknown" } : readReceipt(id);
  await assert.rejects(request("unknown-predecessor"), /not an exact terminal failed/u);
  catalog.mcpOperation = readReceipt;
  board.lifecycleTransition = id => id === original.operationId ? { ...readTransition(id), phase: "pending_git" } : readTransition(id);
  await assert.rejects(request("pending-predecessor"), /not an exact terminal failed/u);
  board.lifecycleTransition = readTransition;
  for (const [name, delta] of [["executor", { streamId: "foreign" }], ["workflow", { workflowStatus: "blocked" }],
    ["revision", { revision: task.revision + 1 }]]) {
    board.lifecycleTransition = id => id === original.operationId
      ? { ...readTransition(id), priorTask: { ...readTransition(id).priorTask, ...delta } } : readTransition(id);
    await assert.rejects(request("changed-" + name), /not an exact terminal failed/u);
  }
  board.lifecycleTransition = readTransition;
  archive = { ...original, argumentsHash: "f".repeat(64) };
  await assert.rejects(request("changed-original-hash"), /not an exact terminal failed/u); archive = original;
  archive = { ...original, resultCommit: "c".repeat(40) };
  await assert.rejects(request("changed-source"), /not an exact terminal failed/u); archive = original;
  guard = true; await assert.rejects(request("guarded-successor"), /process guard/u); guard = false;
  assert.equal(effects, 0);
  failFinal = true;
  await assert.rejects(request("new-await"), { code: "AWAIT_PREPARATION_UNKNOWN" });
  await catalog.runMutation(() => catalog.markMcpOperationUnknown("new-await", new Error("lost terminal boundary")));
  assert.equal(board.task(task.id).revision, task.revision);
  failFinal = false;
  const reconciliation = new TaskOperationReconciliationService({ workspaceCatalog: catalog, taskBoard: board, taskLifecycle: lifecycle });
  const recover = () => reconciliation.reconcileUnknownWorkflow({ workspaceId: workspace.id, taskId: task.id,
    operationRequestId: "new-await", projectRoot: root, expectedTaskRevision: task.revision, expectedWorkflowStatus: "testing" });
  assert.equal((await recover()).outcome, "succeeded");
  assert.equal(board.task(task.id).workflowStatus, "awaiting_implementation");
  const count = effects;
  assert.equal((await recover()).outcome, "succeeded"); assert.equal(effects, count);
  assert.deepEqual(catalog.mcpOperation("failed-original"), retained);
});

test("original Await uses existing SQLite lifecycle/CAS/receipt and terminal retry has no candidate effects", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "await-original-"));
  const catalog = new WorkspaceCatalogStore({ databaseFile: path.join(root, "tasks.sqlite") }); await catalog.load();
  const store = new TaskBoardStore({ databaseFile: path.join(root, "tasks.sqlite") });
  t.after(async () => { store.close(); catalog.close(); await rm(root, { recursive: true, force: true }); });
  const workspace = await catalog.runMutation(() => catalog.createWorkspace({ name: "Fixture",
    settings: { workingDirectory: root, releaseWorkflowEnabled: true } }));
  const stream = await catalog.runMutation(() => catalog.createStream({ workspaceId: workspace.id, name: "Executor" }));
  const board = new TaskBoardService({ store, workspaceCatalog: catalog });
  const created = store.create({ text: "Fix", bucket: "workspace", workspaceId: workspace.id });
  await board.claim({ id: created.id, workspaceId: workspace.id, streamId: stream.id,
    provider: "codex", threadId: "fixture", turnId: "turn", operationId: "claim" });
  const source = "a".repeat(40), reference = { projectRoot: root, branch: "HUB-1", resultCommit: source };
  const before = board.task(created.id);
  await board.beginLifecycleTransition({ id: created.id, operationId: "test", kind: "workflow",
    targetWorkflowStatus: "testing", expectedRevision: before.revision });
  await board.commitWorkflowTransition({ operationId: "test", gitReferences: [reference],
    evidence: { resultCommit: source, devHeadCommit: "b".repeat(40) } });
  const originalTask = structuredClone(board.task(created.id)), operationId = "original-await";
  const args = { expected_task_revision: originalTask.revision, expected_workflow_status: "testing",
    request_id: operationId, status: "awaiting_implementation", task_id: created.id };
  await catalog.runMutation(() => catalog.beginMcpOperation({ requestId: operationId, workspaceId: workspace.id,
    streamId: stream.id, provider: "codex", threadId: "fixture", toolName: "hub_task_status_update",
    argumentsHash: createHash("sha256").update(JSON.stringify(args)).digest("hex") }));
  await board.beginLifecycleTransition({ id: created.id, operationId, kind: "workflow",
    targetWorkflowStatus: "awaiting_implementation", expectedRevision: originalTask.revision, evidence: {} });
  await catalog.runMutation(() => catalog.markMcpOperationUnknown(operationId, new Error("foreign published notes")));
  const lease = { async assertOwned() {} };
  let guard = false, inspections = 0, effects = 0, failCAS = false;
  const git = {
    withTaskLock: (_id, op) => op(lease),
    withTaskRecoveryLock: (_id, op) => op(lease),
    withTaskRepositoryRecoveryLock: (_id, _root, _lease, op) => op(lease),
    prepareOwned: async () => assert.fail("Task preparation replay"),
    snapshotAndMergeOwned: async () => assert.fail("Test replay"),
    cleanupOwned: async () => assert.fail("cleanup"),
    cleanupPreview: async () => ({}),
    assertNoProcessTreeGuardOwned: async () => { if (guard) throw new Error("real guard retained"); },
  };
  const preflight = {
    withAwaitTransition: (_id, op) => op(),
    pendingNativeAwaitRecovery: async ({ original }) => {
      inspections++;
      assert.equal(original.operationId, operationId);
      assert.equal(original.resultCommit, source);
      return { original: { ...original, originMainCommit: "d".repeat(40) } };
    },
    prepareAwaitAcceptance: async ({ operationId: actual, nativeAwaitRecovery, commitPrepared }) => {
      effects++;
      assert.equal(actual, operationId); assert.equal(nativeAwaitRecovery.operationId, operationId);
      return commitPrepared({ planRevision: "plan", task: { taskId: created.id, resultCommit: source },
        verifyNativeAwaitAuthority: async () => {
          inspections++;
          if (failCAS) throw Object.assign(new Error("terminal origin pin changed"), { code: "AWAIT_PREPARATION_UNKNOWN" });
        } });
    },
  };
  const lifecycle = new TaskLifecycleService({ taskBoard: board, workspaceCatalog: catalog,
    taskGitWorkspaces: git, releasePreflight: preflight });
  const reconciliation = new TaskOperationReconciliationService({ workspaceCatalog: catalog, taskBoard: board, taskLifecycle: lifecycle });
  const recover = () => reconciliation.reconcileUnknownWorkflow({ workspaceId: workspace.id, taskId: created.id,
    operationRequestId: operationId, projectRoot: root, expectedTaskRevision: originalTask.revision,
    expectedWorkflowStatus: "testing" });
  const task = board.task.bind(board);
  for (const delta of [{ streamId: "foreign" }, { workflowStatus: "blocked" }, { revision: originalTask.revision + 1 },
    { gitReferences: [{ ...reference, resultCommit: "c".repeat(40) }] }]) {
    board.task = id => ({ ...task(id), ...delta });
    await assert.rejects(recover()); board.task = task;
  }
  guard = true; await assert.rejects(recover(), /guard/u); guard = false;
  assert.equal(effects, 0);
  failCAS = true; assert.equal((await recover()).resolved, false); failCAS = false;
  assert.equal(board.task(created.id).revision, originalTask.revision);
  assert.equal(catalog.mcpOperation(operationId).receiptState, "unknown");
  const result = await recover();
  assert.equal(result.outcome, "succeeded"); assert.equal(result.resolved, true);
  assert.equal(board.task(created.id).workflowStatus, "awaiting_implementation");
  assert.equal(catalog.mcpOperation(operationId).receiptState, "succeeded");
  const counts = { inspections, effects }, revision = board.task(created.id).revision;
  assert.equal((await recover()).outcome, "succeeded");
  assert.deepEqual({ inspections, effects }, counts);
  assert.equal(board.task(created.id).revision, revision);
});
