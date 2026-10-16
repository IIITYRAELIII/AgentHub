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
    },
    prepareAwaitAcceptance: async ({ operationId: actual, nativeAwaitRecovery, commitPrepared }) => {
      effects++;
      assert.equal(actual, operationId); assert.equal(nativeAwaitRecovery.operationId, operationId);
      if (failCAS) throw Object.assign(new Error("candidate outcome unknown"), { code: "AWAIT_PREPARATION_UNKNOWN" });
      return commitPrepared({ planRevision: "plan", task: { taskId: created.id, resultCommit: source } });
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
