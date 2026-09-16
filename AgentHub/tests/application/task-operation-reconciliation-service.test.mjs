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
    priorTask: { ...task, gitReferences: task.gitReferences.map((reference) => ({ ...reference })) },
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
    crashAfterSuccess({ includePriorTask = false } = {}) {
      const priorTask = { ...task, gitReferences: [...task.gitReferences] };
      task.workflowStatus = "awaiting_implementation";
      task.revision = 16;
      outcome = {
        operationId: receipt.requestId, taskId: task.id, kind: "workflow",
        result: {
          task: { ...task, gitReferences: [...task.gitReferences] },
          ...(includePriorTask ? { priorTask } : {}),
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
      task.workflowStatus = currentStatus;
      transition = {
        ...transition,
        targetWorkflowStatus: status,
        priorTask: { ...task, gitReferences: task.gitReferences.map((reference) => ({ ...reference })) },
      };
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
    useOrdinaryCasReceipt({
      expectedTaskRevision = transition?.expectedRevision ?? task.revision,
      expectedWorkflowStatus = transition?.priorTask?.workflowStatus ?? task.workflowStatus,
    } = {}) {
      const identity = {};
      const originalArguments = {
        request_id: receipt.requestId,
        status: transition.targetWorkflowStatus,
        task_id: task.id,
      };
      if (expectedTaskRevision != null) {
        identity.expectedTaskRevision = expectedTaskRevision;
        originalArguments.expected_task_revision = expectedTaskRevision;
      }
      if (expectedWorkflowStatus != null) {
        identity.expectedWorkflowStatus = expectedWorkflowStatus;
        originalArguments.expected_workflow_status = expectedWorkflowStatus;
      }
      receipt.argumentsHash = hashArguments(originalArguments);
      return identity;
    },
    corruptOutcome(mutator) {
      mutator(outcome);
    },
    omitTransitionPriorTask() {
      transition = { ...transition, priorTask: null };
    },
    withdrawal({ committed = false, failFinalization = false, crashAfterCommit = false } = {}) {
      const priorTask = structuredClone(task);
      transition.targetWorkflowStatus = "in_progress";
      receipt.argumentsHash = hashArguments({
        request_id: receipt.requestId, status: "in_progress", task_id: task.id,
      });
      const commitWithdrawal = () => {
        task.workflowStatus = "in_progress";
        task.revision = priorTask.revision + 1;
        const withdrawal = {
          outcome: "withdrawn", taskId: task.id, resultCommit: task.gitReferences[0].resultCommit,
          beforeDevCommit: "b".repeat(40), afterDevCommit: "c".repeat(40),
          removedIntegrations: ["b".repeat(40)], retainedIntegrations: [],
        };
        outcome = {
          operationId: receipt.requestId, taskId: task.id, kind: "workflow",
          result: { task: structuredClone(task), priorTask, evidence: {
            outcome: "withdrawn_result", resultCommit: withdrawal.resultCommit, withdrawal,
            response: { gitWithdrawal: structuredClone(withdrawal), releaseCandidate: { status: "pending" } },
          } },
        };
        transition = null;
      };
      if (committed) commitWithdrawal();
      taskLifecycle.reconcileUnknownWorkflowStatusOwned = async ({ lease: ownedLease, finalizeCommittedWithdrawal, guardId, proof }) => {
        assert.equal(lockDepth, 1);
        assert.equal(ownedLease, lease);
        assert.equal(settlements.length, 0, "withdrawal intent must be reconciled before receipt settlement");
        assert.equal(guardId, null);
        assert.equal(proof, null);
        lifecycleCalls += 1;
        if (finalizeCommittedWithdrawal) {
          assert.ok(outcome);
          if (failFinalization) throw new Error("withdrawal Git intent could not be cleared");
          return { result: outcome.result.task, recovery: null };
        }
        assert.ok(transition);
        commitWithdrawal();
        if (crashAfterCommit) throw new Error("crash after withdrawal status CAS");
        return { result: task, recovery: null };
      };
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

test("operator reconciliation settles an exact failed ordinary Test CAS without Git replay", async () => {
  const value = fixture();
  value.targetWorkflow("testing", "in_progress");
  const workflowCas = value.useOrdinaryCasReceipt();
  value.crashAfterFailedTransition();
  const terminalInput = { ...input(value), ...workflowCas };
  delete terminalInput.guardId;
  delete terminalInput.proofKind;
  delete terminalInput.proofSummary;
  terminalInput.confirmed = false;

  const result = await value.service.reconcileUnknownWorkflow(terminalInput);

  assert.equal(result.outcome, "failed");
  assert.equal(result.reconciliation.durableState, "failed_transition");
  assert.equal(value.task.workflowStatus, "in_progress");
  assert.equal(value.receipt.receiptState, "failed");
  assert.equal(value.lifecycleCalls(), 0);
  assert.equal(value.settlements.length, 1);
});

test("operator reconciliation preserves revision-only and status-only ordinary CAS shapes", async () => {
  for (const requestedCas of [
    { expectedTaskRevision: 15, expectedWorkflowStatus: null },
    { expectedTaskRevision: null, expectedWorkflowStatus: "in_progress" },
  ]) {
    const value = fixture();
    value.targetWorkflow("testing", "in_progress");
    const workflowCas = value.useOrdinaryCasReceipt(requestedCas);
    value.crashAfterFailedTransition();
    const terminalInput = { ...input(value), ...workflowCas };
    delete terminalInput.guardId;
    delete terminalInput.proofKind;
    delete terminalInput.proofSummary;

    const result = await value.service.reconcileUnknownWorkflow(terminalInput);

    assert.equal(result.outcome, "failed");
    assert.equal(value.lifecycleCalls(), 0);
    assert.equal(value.receipt.receiptState, "failed");
  }
});

test("operator reconciliation rejects wrong ordinary workflow CAS identity and durable evidence", async () => {
  const wrongCaller = fixture();
  wrongCaller.targetWorkflow("testing", "in_progress");
  const exactCas = wrongCaller.useOrdinaryCasReceipt();
  wrongCaller.crashAfterFailedTransition();
  await assert.rejects(
    wrongCaller.service.reconcileUnknownWorkflow({
      ...input(wrongCaller), ...exactCas, expectedTaskRevision: exactCas.expectedTaskRevision + 1,
    }),
    /identity.*CAS does not match/u,
  );
  assert.equal(wrongCaller.receipt.receiptState, "unknown");
  assert.deepEqual(wrongCaller.settlements, []);

  const wrongDurable = fixture();
  wrongDurable.targetWorkflow("testing", "in_progress");
  const mismatchedCas = wrongDurable.useOrdinaryCasReceipt({
    expectedTaskRevision: wrongDurable.task.revision + 1,
    expectedWorkflowStatus: "testing",
  });
  wrongDurable.crashAfterFailedTransition();
  await assert.rejects(
    wrongDurable.service.reconcileUnknownWorkflow({ ...input(wrongDurable), ...mismatchedCas }),
    /identity.*CAS does not match/u,
  );
  assert.equal(wrongDurable.receipt.receiptState, "unknown");
  assert.deepEqual(wrongDurable.settlements, []);
});

test("operator reconciliation settles post-effect unknown only from matching ordinary CAS outcome", async () => {
  const value = fixture();
  const workflowCas = value.useOrdinaryCasReceipt();
  value.crashAfterSuccess({ includePriorTask: true });

  const result = await value.service.reconcileUnknownWorkflow({ ...input(value), ...workflowCas });

  assert.equal(result.outcome, "succeeded");
  assert.equal(value.receipt.receiptState, "succeeded");
  assert.equal(value.lifecycleCalls(), 0);
  assert.equal(value.settlements.length, 1);

  const missingEvidence = fixture();
  const missingCas = missingEvidence.useOrdinaryCasReceipt();
  missingEvidence.crashAfterSuccess();
  await assert.rejects(
    missingEvidence.service.reconcileUnknownWorkflow({ ...input(missingEvidence), ...missingCas }),
    /identity.*CAS does not match/u,
  );
  assert.equal(missingEvidence.receipt.receiptState, "unknown");
  assert.deepEqual(missingEvidence.settlements, []);

  const wrongPriorIdentity = fixture();
  const wrongPriorCas = wrongPriorIdentity.useOrdinaryCasReceipt();
  wrongPriorIdentity.crashAfterSuccess({ includePriorTask: true });
  wrongPriorIdentity.corruptOutcome((outcome) => { outcome.result.priorTask.id = "task-other"; });
  await assert.rejects(
    wrongPriorIdentity.service.reconcileUnknownWorkflow({ ...input(wrongPriorIdentity), ...wrongPriorCas }),
    /identity.*CAS does not match/u,
  );
  assert.equal(wrongPriorIdentity.receipt.receiptState, "unknown");
  assert.deepEqual(wrongPriorIdentity.settlements, []);
});

test("operator reconciliation settles an exact failed same-status Test refresh without replay", async () => {
  const value = fixture();
  value.targetWorkflow("testing", "testing");
  value.crashAfterFailedTransition();
  const terminalInput = input(value);
  delete terminalInput.guardId;
  delete terminalInput.proofKind;
  delete terminalInput.proofSummary;
  terminalInput.confirmed = false;
  const result = await value.service.reconcileUnknownWorkflow(terminalInput);
  assert.equal(result.outcome, "failed");
  assert.equal(result.reconciliation.durableState, "failed_transition");
  assert.equal(value.task.workflowStatus, "testing");
  assert.equal(value.task.revision, 15);
  assert.equal(value.receipt.receiptState, "failed");
  assert.equal(value.lifecycleCalls(), 0);
});

test("operator reconciliation rejects failed same-status refresh after Task drift", async () => {
  const value = fixture();
  value.targetWorkflow("testing", "testing");
  value.crashAfterFailedTransition();
  value.task.gitReferences[0].resultCommit = "b".repeat(40);
  await assert.rejects(
    value.service.reconcileUnknownWorkflow(input(value)),
    /no exact recoverable or terminal durable state/u,
  );
  assert.equal(value.receipt.receiptState, "unknown");
  assert.equal(value.lifecycleCalls(), 0);
  assert.deepEqual(value.settlements, []);
});

test("operator reconciliation rejects failed same-status refresh without immutable prior Task", async () => {
  const value = fixture();
  value.targetWorkflow("testing", "testing");
  value.crashAfterFailedTransition();
  value.omitTransitionPriorTask();
  await assert.rejects(
    value.service.reconcileUnknownWorkflow(input(value)),
    /no exact recoverable or terminal durable state/u,
  );
  assert.equal(value.receipt.receiptState, "unknown");
  assert.equal(value.lifecycleCalls(), 0);
  assert.deepEqual(value.settlements, []);
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

function withoutGuard(value) {
  const { guardId, proofKind, proofSummary, ...request } = input(value);
  return request;
}

test("pending withdrawal resumes without a process guard and settles only after Git intent cleanup", async () => {
  const value = fixture();
  value.withdrawal();
  const result = await value.service.reconcileUnknownWorkflow(withoutGuard(value));
  assert.equal(result.outcome, "succeeded");
  assert.equal(result.result.workflowStatus, "in_progress");
  assert.equal(result.result.gitWithdrawal.outcome, "withdrawn");
  assert.equal(result.result.releaseCandidate.status, "pending");
  assert.equal(value.lifecycleCalls(), 2);
  assert.equal(value.settlements.length, 1);
  assert.equal(value.settlements[0].id, "original-request");
});

test("committed withdrawal cleans its Git intent before settling the original unknown receipt", async () => {
  const value = fixture();
  value.withdrawal({ committed: true });
  const result = await value.service.reconcileUnknownWorkflow(withoutGuard(value));
  assert.equal(result.outcome, "succeeded");
  assert.equal(value.lifecycleCalls(), 1);
  assert.equal(value.task.revision, 16);
  assert.equal(value.settlements[0].id, "original-request");
});

test("withdrawal crash after status CAS still reconciles Git intent before success", async () => {
  const value = fixture();
  value.withdrawal({ crashAfterCommit: true });
  const result = await value.service.reconcileUnknownWorkflow(withoutGuard(value));
  assert.equal(result.outcome, "succeeded");
  assert.equal(value.lifecycleCalls(), 2);
  assert.equal(value.settlements.length, 1);
});

test("committed withdrawal remains unknown when its Git intent cannot be cleared", async () => {
  const value = fixture();
  value.withdrawal({ committed: true, failFinalization: true });
  const result = await value.service.reconcileUnknownWorkflow(withoutGuard(value));
  assert.equal(result.outcome, "unknown");
  assert.match(result.error, /Git intent/u);
  assert.equal(value.task.workflowStatus, "in_progress");
  assert.equal(value.receipt.receiptState, "unknown");
  assert.deepEqual(value.settlements, []);
});

test("withdrawal reconciliation rejects mismatched result or before-after evidence", async () => {
  for (const corrupt of [
    (outcome) => { outcome.result.evidence.withdrawal.resultCommit = "d".repeat(40); },
    (outcome) => { outcome.result.evidence.withdrawal.afterDevCommit = "unknown"; },
    (outcome) => { outcome.result.evidence.response.gitWithdrawal.taskId = "another-task"; },
    (outcome) => { outcome.result.priorTask.workflowStatus = "new"; },
  ]) {
    const value = fixture();
    value.withdrawal({ committed: true });
    value.corruptOutcome(corrupt);
    await assert.rejects(value.service.reconcileUnknownWorkflow(withoutGuard(value)), /no exact recoverable or terminal durable state/u);
    assert.equal(value.lifecycleCalls(), 0);
    assert.deepEqual(value.settlements, []);
  }
});

test("pending withdrawal without immutable prior Task does not bypass process-guard admission", async () => {
  const value = fixture();
  value.withdrawal();
  value.omitTransitionPriorTask();
  await assert.rejects(value.service.reconcileUnknownWorkflow(withoutGuard(value)), /exact process-tree guard/u);
  assert.equal(value.lifecycleCalls(), 0);
  assert.deepEqual(value.settlements, []);
});
