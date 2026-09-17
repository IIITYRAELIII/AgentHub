import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { openTaskOperationReconciliationStores } from "../../../src/interfaces/cli/task-operation-reconciliation-runtime.mjs";
import { TaskOperationReconciliationService } from "../../../src/application/task-operation-reconciliation-service.mjs";

function argumentsHash(value) {
  const canonical = (item) => {
    if (Array.isArray(item)) return item.map(canonical);
    if (!item || typeof item !== "object") return item;
    return Object.fromEntries(Object.keys(item).sort().map((key) => [key, canonical(item[key])]));
  };
  return createHash("sha256").update(JSON.stringify(canonical(value)), "utf8").digest("hex");
}

test("operator reconciliation store composition waits for a live Hub writer", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-operation-reconcile-"));
  const databaseFile = path.join(directory, "journal.sqlite");
  const initial = await openTaskOperationReconciliationStores({ databaseFile });
  initial.taskBoardStore.close();
  initial.workspaceCatalogStore.close();

  const blocker = new DatabaseSync(databaseFile);
  blocker.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE");
  const release = setTimeout(() => blocker.exec("COMMIT"), 60);
  let opened;
  t.after(async () => {
    clearTimeout(release);
    opened?.taskBoardStore.close();
    opened?.workspaceCatalogStore.close();
    try { blocker.exec("ROLLBACK"); } catch {}
    blocker.close();
    await rm(directory, { recursive: true, force: true });
  });

  opened = await openTaskOperationReconciliationStores({ databaseFile, timeoutMs: 1_000 });
  assert.equal(opened.workspaceCatalogStore.hierarchy().length, 1);
});

test("operator reconciliation store composition closes partial stores and preserves non-contention failures", async () => {
  let catalogClosed = 0;
  const failure = new Error("schema mismatch");
  await assert.rejects(openTaskOperationReconciliationStores({
    databaseFile: "unused.sqlite",
    createWorkspaceCatalogStore: () => ({ load: async () => {}, close: () => { catalogClosed += 1; } }),
    createTaskBoardStore: () => { throw failure; },
  }), (error) => error === failure);
  assert.equal(catalogClosed, 1);
});

test("real SQLite failed Test CAS terminalizes only its original unknown receipt", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-operation-cas-reconcile-"));
  const projectRoot = path.join(directory, "repository");
  const databaseFile = path.join(directory, "journal.sqlite");
  const { workspaceCatalogStore, taskBoardStore } = await openTaskOperationReconciliationStores({ databaseFile });
  t.after(async () => {
    taskBoardStore.close();
    workspaceCatalogStore.close();
    await rm(directory, { recursive: true, force: true });
  });
  const workspace = await workspaceCatalogStore.runMutation(() => workspaceCatalogStore.createWorkspace({
    name: "CAS recovery",
    settings: { releaseWorkflowEnabled: true, workingDirectory: projectRoot },
  }));
  const stream = await workspaceCatalogStore.runMutation(() => workspaceCatalogStore.createStream({
    workspaceId: workspace.id,
    name: "Release Manager",
    settings: { releaseManager: true },
  }));
  await workspaceCatalogStore.runMutation(() => workspaceCatalogStore.bindThread({
    streamId: stream.id,
    provider: "codex",
    threadId: "thread-cas-recovery",
    projectRoot,
  }));
  const created = taskBoardStore.create({
    text: "Failed Test CAS",
    bucket: "workspace",
    workspaceId: workspace.id,
    taskPrefix: "HUB",
  });
  const task = taskBoardStore.claim(created.id, {
    workspaceId: workspace.id,
    streamId: stream.id,
    provider: "codex",
    threadId: "thread-cas-recovery",
    turnId: "turn-cas-recovery",
    operationId: "claim-cas-recovery",
  });
  const operationId = "original-test-with-cas";
  const originalArguments = {
    request_id: operationId,
    task_id: task.id,
    status: "testing",
    expected_task_revision: task.revision,
    expected_workflow_status: "in_progress",
  };
  await workspaceCatalogStore.runMutation(() => workspaceCatalogStore.beginMcpOperation({
    requestId: operationId,
    workspaceId: workspace.id,
    streamId: stream.id,
    provider: "codex",
    threadId: "thread-cas-recovery",
    toolName: "hub_task_status_update",
    argumentsHash: argumentsHash(originalArguments),
  }));
  await workspaceCatalogStore.runMutation(() => workspaceCatalogStore.markMcpOperationUnknown(
    operationId,
    new Error("Git integration exited 1"),
  ));
  taskBoardStore.beginLifecycleTransition(task.id, {
    operationId,
    kind: "workflow",
    targetWorkflowStatus: "testing",
    expectedRevision: task.revision,
  });
  taskBoardStore.failLifecycleTransition(operationId, new Error("Task Git integration exited 1"));
  let recoveryCalls = 0;
  const service = new TaskOperationReconciliationService({
    workspaceCatalog: workspaceCatalogStore,
    taskBoard: taskBoardStore,
    taskLifecycle: {
      withUnknownWorkflowReconciliationLock: async (_identity, operation) => operation({ async assertOwned() {} }),
      reconcileUnknownWorkflowStatusOwned: async () => {
        recoveryCalls += 1;
        throw new Error("terminal failed state must not replay Git");
      },
    },
  });

  const result = await service.reconcileUnknownWorkflow({
    workspaceId: workspace.id,
    taskId: task.id,
    operationRequestId: operationId,
    projectRoot,
    expectedTaskRevision: task.revision,
    expectedWorkflowStatus: "in_progress",
  });

  assert.equal(result.outcome, "failed");
  assert.equal(result.reconciliation.durableState, "failed_transition");
  assert.equal(recoveryCalls, 0);
  assert.equal(taskBoardStore.task(task.id).workflowStatus, "in_progress");
  assert.equal(taskBoardStore.task(task.id).revision, task.revision);
  const receipt = workspaceCatalogStore.mcpOperation(operationId);
  assert.equal(receipt.status, "failed");
  assert.equal(receipt.receiptState, "failed");
  assert.equal(receipt.argumentsHash, argumentsHash(originalArguments));
  assert.equal(taskBoardStore.lifecycleTransition(operationId).phase, "failed");
  assert.equal(taskBoardStore.lifecycleOutcome(operationId), null);
});
