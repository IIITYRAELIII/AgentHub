import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { TaskOperationReconciliationService } from "../../src/application/task-operation-reconciliation-service.mjs";

function hashArguments(value) {
  const canonical = (item) => {
    if (Array.isArray(item)) return item.map(canonical);
    if (!item || typeof item !== "object") return item;
    return Object.fromEntries(Object.keys(item).sort().map((key) => [key, canonical(item[key])]));
  };
  return createHash("sha256").update(JSON.stringify(canonical(value)), "utf8").digest("hex");
}

function fixture() {
  const projectRoot = process.platform === "win32" ? "C:\\repo" : "/repo";
  const workspace = { id: "workspace-1", settings: { releaseWorkflowEnabled: true, workingDirectory: projectRoot } };
  const task = {
    id: "task-1", workspaceId: workspace.id, streamId: "stream-1", status: "started",
    workflowStatus: "testing", revision: 15,
    gitReferences: [{ projectRoot, resultCommit: "a".repeat(40), branch: "HUB-215" }],
  };
  const receipt = {
    requestId: "original-request", workspaceId: workspace.id, toolName: "hub_task_status_update",
    argumentsHash: hashArguments({
      request_id: "original-request", status: "awaiting_implementation", task_id: "task-1",
    }),
    status: "unknown", operationStatus: "pending", receiptState: "unknown",
  };
  let transition = {
    operationId: receipt.requestId, taskId: task.id, kind: "workflow", phase: "pending_git",
    targetWorkflowStatus: "awaiting_implementation", expectedRevision: 15,
  };
  let outcome = null;
  const settlements = [];
  const workspaceCatalog = {
    workspace: (id) => id === workspace.id ? workspace : null,
    stream: () => ({ id: "stream-1", workspaceId: workspace.id, settings: {} }),
    mcpOperation: (id) => id === receipt.requestId ? receipt : null,
    completeUnknownMcpOperation: (id, value) => {
      settlements.push({ kind: "succeeded", id, value });
      Object.assign(receipt, { status: "succeeded", operationStatus: "succeeded", receiptState: "succeeded" });
      return receipt;
    },
    failUnknownMcpOperation: (id, value) => {
      settlements.push({ kind: "failed", id, value });
      Object.assign(receipt, { status: "failed", operationStatus: "failed", receiptState: "failed" });
      return receipt;
    },
  };
  const taskBoard = {
    task: (id) => id === task.id ? task : null,
    lifecycleTransition: (id) => id === receipt.requestId ? transition : null,
    lifecycleOutcome: (id) => id === receipt.requestId ? outcome : null,
  };
  let lifecycleCalls = 0;
  let lockDepth = 0;
  const lease = { async assertOwned() {} };
  const taskLifecycle = {
    withUnknownWorkflowReconciliationLock: async (options, operation) => {
      assert.equal(options.projectRoot, projectRoot);
      lockDepth += 1;
      try { return await operation(lease); } finally { lockDepth -= 1; }
    },
    reconcileUnknownWorkflowStatusOwned: async ({ lease: ownedLease }) => {
      assert.equal(lockDepth, 1);
      assert.equal(ownedLease, lease);
      lifecycleCalls += 1;
      task.workflowStatus = "awaiting_implementation";
      task.revision = 16;
      outcome = {
        operationId: receipt.requestId, taskId: task.id, kind: "workflow",
        result: {
          task: { ...task, gitReferences: [...task.gitReferences] },
          evidence: {
            resultCommit: "a".repeat(40),
            response: {
              gitWorkspace: { headCommit: "a".repeat(40) },
              gitIntegration: { integrated: true },
            },
          },
        },
      };
      transition = null;
      return {
        result: { ...task, preReleaseIntegration: { headCommit: "b".repeat(40) } },
        recovery: { proof: { kind: "system-restart-after-guard", systemBootTime: "2026-01-02T00:00:00.000Z" } },
      };
    },
  };
  return {
    service: new TaskOperationReconciliationService({ workspaceCatalog, taskBoard, taskLifecycle }),
    projectRoot,
    task,
    receipt,
    settlements,
    lifecycleCalls: () => lifecycleCalls,
    failLifecycle(error, { terminal = false } = {}) {
      taskLifecycle.reconcileUnknownWorkflowStatusOwned = async ({ lease: ownedLease }) => {
        assert.equal(lockDepth, 1);
        assert.equal(ownedLease, lease);
        lifecycleCalls += 1;
        if (terminal) transition = { ...transition, phase: "failed", error: error.message };
        throw error;
      };
    },
    crashAfterSuccess() {
      task.workflowStatus = "awaiting_implementation";
      task.revision = 16;
      outcome = {
        operationId: receipt.requestId, taskId: task.id, kind: "workflow",
        result: {
          task: { ...task, gitReferences: [...task.gitReferences] },
          evidence: {
            resultCommit: "a".repeat(40),
            response: {
              gitWorkspace: { headCommit: "a".repeat(40) },
              gitIntegration: { integrated: true },
            },
          },
        },
      };
      transition = null;
    },
    crashAfterRollback() {
      const priorTask = { ...task, gitReferences: [...task.gitReferences] };
      const committed = { ...task, workflowStatus: "awaiting_implementation", revision: 16 };
      task.workflowStatus = "testing";
      task.revision = 17;
      outcome = {
        operationId: receipt.requestId, taskId: task.id, kind: "workflow",
        result: {
          task: committed,
          priorTask,
          restoredTask: { ...task, gitReferences: [...task.gitReferences] },
          evidence: {
            resultCommit: "a".repeat(40),
            response: {
              gitWorkspace: { headCommit: "a".repeat(40) },
              gitIntegration: { integrated: true },
            },
          },
          rollback: { completed: true, reason: "PreRelease rebuild failed" },
        },
      };
      transition = null;
    },
    crashAfterFailedTransition() {
      transition = { ...transition, phase: "failed", error: "Task snapshot failed" };
    },
    targetWorkflow(status, currentStatus) {
      transition = { ...transition, targetWorkflowStatus: status };
      task.workflowStatus = currentStatus;
      receipt.argumentsHash = hashArguments({
        request_id: receipt.requestId, status, task_id: task.id,
      });
    },
    useCutoverReceipt() {
      const identity = {
        expectedTaskRevision: task.revision,
        expectedWorkflowStatus: task.workflowStatus,
        cutoverSourceCommit: task.gitReferences[0].resultCommit,
        cutoverProjectorSha256: "d".repeat(64),
      };
      receipt.argumentsHash = hashArguments({
        request_id: receipt.requestId,
        status: "awaiting_implementation",
        task_id: task.id,
        expected_task_revision: identity.expectedTaskRevision,
        expected_workflow_status: identity.expectedWorkflowStatus,
        cutover_source_commit: identity.cutoverSourceCommit,
        cutover_projector_sha256: identity.cutoverProjectorSha256,
      });
      return identity;
    },
    corruptOutcome(mutator) {
      mutator(outcome);
    },
  };
}

function input(value) {
  return {
    workspaceId: "workspace-1",
    taskId: "task-1",
    operationRequestId: "original-request",
    projectRoot: value.projectRoot,
    guardId: "guard-1",
    proofKind: "system-restart-after-guard",
    proofSummary: "trusted OS boot boundary",
    confirmed: true,
  };
}

test("operator reconciliation resumes the exact lifecycle and terminalizes the original receipt", async () => {
  const value = fixture();
  const result = await value.service.reconcileUnknownWorkflow(input(value));
  assert.equal(result.resolved, true);
  assert.equal(result.outcome, "succeeded");
  assert.equal(value.task.workflowStatus, "awaiting_implementation");
  assert.equal(value.task.revision, 16);
  assert.equal(value.lifecycleCalls(), 1);
  assert.equal(value.settlements.length, 1);
  assert.equal(value.settlements[0].kind, "succeeded");
  assert.equal(value.settlements[0].id, "original-request");
});

test("operator reconciliation rejects stale identity before lifecycle or receipt effects", async () => {
  const value = fixture();
  value.task.revision = 16;
  await assert.rejects(value.service.reconcileUnknownWorkflow(input(value)), /no exact recoverable or terminal durable state/u);
  assert.equal(value.lifecycleCalls(), 0);
  assert.deepEqual(value.settlements, []);
  assert.equal(value.receipt.receiptState, "unknown");
});

test("operator reconciliation rejects an original receipt with different arguments", async () => {
  const value = fixture();
  value.receipt.argumentsHash = "0".repeat(64);
  await assert.rejects(value.service.reconcileUnknownWorkflow(input(value)), /identity.*CAS does not match/u);
  assert.equal(value.lifecycleCalls(), 0);
  assert.deepEqual(value.settlements, []);
});

test("operator reconciliation preserves unknown when recovery cannot prove an outcome", async () => {
  const value = fixture();
  value.failLifecycle(new Error("system boot does not postdate the guarded process tree"));
  const result = await value.service.reconcileUnknownWorkflow(input(value));
  assert.equal(result.resolved, false);
  assert.equal(result.outcome, "unknown");
  assert.equal(value.receipt.receiptState, "unknown");
  assert.deepEqual(value.settlements, []);
});

test("operator reconciliation terminalizes a proved failed lifecycle without replay", async () => {
  const value = fixture();
  value.failLifecycle(new Error("Task snapshot failed"), { terminal: true });
  const result = await value.service.reconcileUnknownWorkflow(input(value));
  assert.equal(result.resolved, true);
  assert.equal(result.outcome, "failed");
  assert.equal(value.receipt.receiptState, "failed");
  assert.equal(value.lifecycleCalls(), 1);
  assert.equal(value.settlements[0].kind, "failed");
});

test("operator reconciliation settles an exact success after a crash before receipt CAS", async () => {
  const value = fixture();
  value.crashAfterSuccess();
  const result = await value.service.reconcileUnknownWorkflow(input(value));
  assert.equal(result.outcome, "succeeded");
  assert.equal(value.receipt.receiptState, "succeeded");
  assert.equal(value.lifecycleCalls(), 0);
  assert.equal(value.settlements[0].value.result.gitIntegration.integrated, true);
});

test("operator reconciliation settles an exact rollback after a crash before receipt CAS", async () => {
  const value = fixture();
  value.crashAfterRollback();
  const result = await value.service.reconcileUnknownWorkflow(input(value));
  assert.equal(result.outcome, "failed");
  assert.equal(value.receipt.receiptState, "failed");
  assert.equal(value.lifecycleCalls(), 0);
  assert.match(value.settlements[0].value.error.message, /PreRelease rebuild failed/u);
});

test("operator reconciliation settles an exact extended cutover rollback without replay", async () => {
  const value = fixture();
  const cutover = value.useCutoverReceipt();
  value.crashAfterRollback();
  const result = await value.service.reconcileUnknownWorkflow({ ...input(value), ...cutover });
  assert.equal(result.outcome, "failed");
  assert.equal(result.reconciliation.durableState, "workflow_rollback");
  assert.equal(value.receipt.receiptState, "failed");
  assert.equal(value.lifecycleCalls(), 0);
  assert.equal(value.settlements.length, 1);
});

test("operator reconciliation rejects missing, tampered or mixed cutover receipt evidence", async () => {
  const variants = [
    (cutover) => { delete cutover.cutoverProjectorSha256; },
    (cutover) => { cutover.expectedTaskRevision += 1; },
    (cutover) => { cutover.expectedWorkflowStatus = "in_progress"; },
    (cutover) => { cutover.cutoverSourceCommit = "b".repeat(40); },
    (cutover) => { cutover.cutoverProjectorSha256 = "e".repeat(64); },
  ];
  for (const mutate of variants) {
    const value = fixture();
    const cutover = value.useCutoverReceipt();
    value.crashAfterRollback();
    mutate(cutover);
    await assert.rejects(
      value.service.reconcileUnknownWorkflow({ ...input(value), ...cutover }),
      /(invalid cutover operation identity|identity.*CAS does not match)/u,
    );
    assert.equal(value.receipt.receiptState, "unknown");
    assert.equal(value.lifecycleCalls(), 0);
    assert.deepEqual(value.settlements, []);
  }

  const mixed = fixture();
  const cutover = mixed.useCutoverReceipt();
  mixed.crashAfterRollback();
  mixed.corruptOutcome((outcome) => {
    outcome.result.priorTask.gitReferences[0].resultCommit = "b".repeat(40);
  });
  await assert.rejects(
    mixed.service.reconcileUnknownWorkflow({ ...input(mixed), ...cutover }),
    /identity.*CAS does not match/u,
  );
  assert.equal(mixed.receipt.receiptState, "unknown");
  assert.equal(mixed.lifecycleCalls(), 0);
  assert.deepEqual(mixed.settlements, []);
});

test("operator reconciliation settles an exact failed transition after a crash before receipt CAS", async () => {
  const value = fixture();
  value.crashAfterFailedTransition();
  const result = await value.service.reconcileUnknownWorkflow(input(value));
  assert.equal(result.outcome, "failed");
  assert.equal(value.receipt.receiptState, "failed");
  assert.equal(value.lifecycleCalls(), 0);
  assert.match(value.settlements[0].value.error.message, /Task snapshot failed/u);
});

test("operator reconciliation settles an exact failed transition without a process guard", async () => {
  const value = fixture();
  value.crashAfterFailedTransition();
  const terminalInput = input(value);
  delete terminalInput.guardId;
  delete terminalInput.proofKind;
  delete terminalInput.proofSummary;
  terminalInput.confirmed = false;
  const result = await value.service.reconcileUnknownWorkflow(terminalInput);
  assert.equal(result.outcome, "failed");
  assert.equal(result.reconciliation.guardId, null);
  assert.equal(result.reconciliation.proof, null);
  assert.equal(value.receipt.receiptState, "failed");
  assert.equal(value.lifecycleCalls(), 0);
});

test("operator reconciliation settles an exact failed transition into Test without a process guard", async () => {
  const value = fixture();
  value.targetWorkflow("testing", "in_progress");
  value.crashAfterFailedTransition();
  const terminalInput = input(value);
  delete terminalInput.guardId;
  delete terminalInput.proofKind;
  delete terminalInput.proofSummary;
  terminalInput.confirmed = false;
  const result = await value.service.reconcileUnknownWorkflow(terminalInput);
  assert.equal(result.outcome, "failed");
  assert.equal(result.reconciliation.guardId, null);
  assert.equal(value.task.workflowStatus, "in_progress");
  assert.equal(value.task.revision, 15);
  assert.equal(value.receipt.receiptState, "failed");
  assert.equal(value.lifecycleCalls(), 0);
});

test("operator reconciliation keeps a pending lifecycle blocked without the exact process guard", async () => {
  const value = fixture();
  const pendingInput = input(value);
  delete pendingInput.guardId;
  await assert.rejects(
    value.service.reconcileUnknownWorkflow(pendingInput),
    /requires the exact process-tree guard id/u,
  );
  assert.equal(value.receipt.receiptState, "unknown");
  assert.equal(value.lifecycleCalls(), 0);
  assert.deepEqual(value.settlements, []);
});

test("operator reconciliation preserves unknown for mixed Task, Git reference or evidence state", async () => {
  for (const corrupt of [
    (outcome) => { outcome.result.task.workspaceId = "workspace-2"; },
    (outcome) => { outcome.result.task.gitReferences[0].resultCommit = "b".repeat(40); },
    (outcome) => { outcome.result.evidence.response.gitWorkspace.headCommit = "b".repeat(40); },
  ]) {
    const value = fixture();
    value.crashAfterSuccess();
    value.corruptOutcome(corrupt);
    await assert.rejects(
      value.service.reconcileUnknownWorkflow(input(value)),
      /no exact recoverable or terminal durable state/u,
    );
    assert.equal(value.lifecycleCalls(), 0);
    assert.deepEqual(value.settlements, []);
    assert.equal(value.receipt.receiptState, "unknown");
  }
});
