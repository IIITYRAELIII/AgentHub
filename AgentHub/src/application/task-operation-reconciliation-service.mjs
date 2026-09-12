import { createHash } from "node:crypto";
import path from "node:path";

import { normalizedTaskGitReferences } from "../domain/task-git-reference.mjs";
import { taskProjectRoot } from "../domain/task-project-root.mjs";

function requiredMethod(value, name) {
  if (typeof value?.[name] !== "function") throw new TypeError(`${name} is required`);
}

function requiredText(value, name, maximumLength = 2_000) {
  const text = String(value ?? "").trim();
  if (!text || text.length > maximumLength || text.includes("\0")) throw new Error(`invalid ${name}`);
  return text;
}

function samePath(left, right) {
  const a = path.resolve(String(left ?? ""));
  const b = path.resolve(String(right ?? ""));
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

const WORKFLOW_STATUSES = new Set(["new", "in_progress", "testing", "awaiting_implementation", "done"]);

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
}

function cutoverArguments({
  expectedTaskRevision, expectedWorkflowStatus, cutoverSourceCommit, cutoverProjectorSha256,
  cutoverSourceTaskId, cutoverSourceTaskRevision,
} = {}) {
  const values = [
    expectedTaskRevision, expectedWorkflowStatus, cutoverSourceCommit, cutoverProjectorSha256,
    cutoverSourceTaskId, cutoverSourceTaskRevision,
  ];
  if (values.every((value) => value == null || String(value).trim() === "")) return null;
  const revision = Number(expectedTaskRevision);
  const workflowStatus = String(expectedWorkflowStatus ?? "").trim();
  const sourceCommit = String(cutoverSourceCommit ?? "").trim().toLowerCase();
  const projectorSha256 = String(cutoverProjectorSha256 ?? "").trim().toLowerCase();
  const sourceTaskId = String(cutoverSourceTaskId ?? "").trim();
  const sourceTaskRevision = cutoverSourceTaskRevision == null ? null : Number(cutoverSourceTaskRevision);
  const hasCrossTaskIdentity = Boolean(sourceTaskId) || sourceTaskRevision != null;
  if (!Number.isInteger(revision) || revision < 1
      || !WORKFLOW_STATUSES.has(workflowStatus)
      || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(sourceCommit)
      || !/^[0-9a-f]{64}$/u.test(projectorSha256)) {
    throw new Error("invalid cutover operation identity");
  }
  if (hasCrossTaskIdentity && (!sourceTaskId || !Number.isInteger(sourceTaskRevision) || sourceTaskRevision < 1)) {
    throw new Error("invalid cross-Task cutover operation identity");
  }
  return {
    expected_task_revision: revision,
    expected_workflow_status: workflowStatus,
    cutover_source_commit: sourceCommit,
    cutover_projector_sha256: projectorSha256,
    ...(hasCrossTaskIdentity ? {
      cutover_source_task_id: sourceTaskId,
      cutover_source_task_revision: sourceTaskRevision,
    } : {}),
  };
}

function workflowArgumentsHash({ operationId, taskId, status, cutover = null }) {
  return createHash("sha256").update(JSON.stringify(canonicalValue({
    request_id: operationId,
    status,
    task_id: taskId,
    ...(cutover ?? {}),
  })), "utf8").digest("hex");
}

function exactCutoverEvidence({ cutover, task, transition, outcome, projectRoot, targetWorkflowStatus }) {
  if (!cutover) return true;
  const priorTask = outcome?.result?.priorTask ?? (transition ? task : null);
  if (!priorTask
      || Number(priorTask.revision) !== cutover.expected_task_revision
      || priorTask.workflowStatus !== cutover.expected_workflow_status
      || targetWorkflowStatus !== "awaiting_implementation") return false;
  if (transition && transition.expectedRevision !== cutover.expected_task_revision) return false;
  if (cutover.cutover_source_task_id) {
    const evidence = outcome?.result?.evidence?.cutoverSource ?? transition?.evidence?.cutoverSource;
    return evidence?.taskId === cutover.cutover_source_task_id
      && Number(evidence?.revision) === cutover.cutover_source_task_revision
      && evidence?.workflowStatus === "testing"
      && String(evidence?.resultCommit ?? "").trim().toLowerCase() === cutover.cutover_source_commit
      && String(evidence?.projectorSha256 ?? "").trim().toLowerCase() === cutover.cutover_projector_sha256
      && samePath(evidence?.projectRoot, projectRoot);
  }
  const references = normalizedTaskGitReferences(priorTask.gitReferences)
    .filter((reference) => samePath(reference.projectRoot, projectRoot));
  if (references.length !== 1 || references[0].resultCommit !== cutover.cutover_source_commit) return false;
  const evidenceCommit = String(outcome?.result?.evidence?.resultCommit ?? "").trim().toLowerCase();
  return !outcome || evidenceCommit === cutover.cutover_source_commit;
}

function sameTaskState(current, expected) {
  const state = (task) => task ? {
    id: task.id,
    workspaceId: task.workspaceId ?? null,
    streamId: task.streamId ?? null,
    status: task.status ?? null,
    workflowStatus: task.workflowStatus,
    revision: Number(task.revision),
    gitReferences: normalizedTaskGitReferences(task.gitReferences).map((reference) => ({
      projectRoot: path.resolve(reference.projectRoot),
      branch: reference.branch,
      resultCommit: reference.resultCommit,
    })),
  } : null;
  return JSON.stringify(state(current)) === JSON.stringify(state(expected));
}

function exactCommittedEvidence(committed, evidence, projectRoot, targetWorkflowStatus) {
  if (!committed || committed.workflowStatus !== targetWorkflowStatus) return false;
  const resultCommit = String(evidence?.resultCommit ?? "").trim().toLowerCase();
  const reference = normalizedTaskGitReferences(committed.gitReferences)
    .find((item) => samePath(item.projectRoot, projectRoot));
  return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(resultCommit)
    && reference?.resultCommit === resultCommit
    && String(evidence?.response?.gitWorkspace?.headCommit ?? "").trim().toLowerCase() === resultCommit
    && evidence?.response?.gitIntegration?.integrated === true;
}

export class TaskOperationReconciliationService {
  constructor({ workspaceCatalog, taskBoard, taskLifecycle } = {}) {
    for (const name of [
      "workspace", "stream", "mcpOperation", "completeUnknownMcpOperation", "failUnknownMcpOperation",
    ]) requiredMethod(workspaceCatalog, name);
    for (const name of ["task", "lifecycleTransition", "lifecycleOutcome"]) requiredMethod(taskBoard, name);
    requiredMethod(taskLifecycle, "withUnknownWorkflowReconciliationLock");
    requiredMethod(taskLifecycle, "reconcileUnknownWorkflowStatusOwned");
    this.workspaceCatalog = workspaceCatalog;
    this.taskBoard = taskBoard;
    this.taskLifecycle = taskLifecycle;
  }

  #identity(options = {}) {
    const { workspaceId, taskId, operationRequestId, projectRoot, guardId } = options;
    const workspace = this.workspaceCatalog.workspace(requiredText(workspaceId, "workspace id", 200));
    if (!workspace) throw new Error("Unknown operation reconciliation Workspace was not found");
    const task = this.taskBoard.task(requiredText(taskId, "task id", 200));
    if (!task || task.workspaceId !== workspace.id) {
      throw new Error("Unknown operation reconciliation Task does not belong to the Workspace");
    }
    const operationId = requiredText(operationRequestId, "operation request id", 200);
    const receipt = this.workspaceCatalog.mcpOperation(operationId);
    const transition = this.taskBoard.lifecycleTransition(operationId);
    const outcome = this.taskBoard.lifecycleOutcome(operationId);
    const root = path.resolve(requiredText(projectRoot, "project root"));
    const guardText = String(guardId ?? "").trim();
    const exactGuardId = guardText ? requiredText(guardText, "guard id", 200) : null;
    const targetWorkflowStatus = transition?.targetWorkflowStatus
      ?? outcome?.result?.task?.workflowStatus
      ?? null;
    const cutover = cutoverArguments(options);
    const validTarget = WORKFLOW_STATUSES.has(targetWorkflowStatus);
    const taskRoot = taskProjectRoot({
      workspace,
      stream: task.streamId ? this.workspaceCatalog.stream(task.streamId) : null,
    });
    const receiptMatches = receipt
      && receipt.workspaceId === workspace.id
      && receipt.toolName === "hub_task_status_update"
      && validTarget
      && receipt.argumentsHash === workflowArgumentsHash({
        operationId, taskId: task.id, status: targetWorkflowStatus, cutover,
      })
      && receipt.operationStatus === "pending"
      && receipt.receiptState === "unknown";
    const transitionMatches = !transition || (
      transition.operationId === operationId
      && transition.taskId === task.id
      && transition.kind === "workflow"
      && transition.targetWorkflowStatus === targetWorkflowStatus
    );
    const outcomeMatches = !outcome || (
      outcome.operationId === operationId
      && outcome.taskId === task.id
      && outcome.kind === "workflow"
    );
    const cutoverMatches = exactCutoverEvidence({
      cutover, task, transition, outcome, projectRoot: root, targetWorkflowStatus,
    });
    if (!receiptMatches || !transitionMatches || !outcomeMatches || !cutoverMatches
        || !taskRoot || !samePath(taskRoot, root)) {
      throw new Error("Unknown workflow operation identity, lifecycle state, project root or Task CAS does not match");
    }
    let state = null;
    if (outcome && !transition) {
      if (outcome.result?.rollback?.completed === true) {
        if (
          sameTaskState(task, outcome.result?.restoredTask)
          && exactCommittedEvidence(
            outcome.result?.task, outcome.result?.evidence, root, targetWorkflowStatus,
          )
        ) state = "rolled_back";
      } else {
        const committed = outcome.result?.task;
        if (
          sameTaskState(task, committed)
          && exactCommittedEvidence(committed, outcome.result?.evidence, root, targetWorkflowStatus)
        ) state = "succeeded";
      }
    } else if (transition && !outcome) {
      const unchanged = transition.expectedRevision === task.revision
        && task.workflowStatus !== targetWorkflowStatus;
      if (transition.phase === "pending_git" && unchanged) state = "pending";
      if (transition.phase === "failed" && unchanged) state = "failed";
    }
    if (!state) {
      throw new Error("Unknown workflow operation has no exact recoverable or terminal durable state");
    }
    return {
      workspace,
      task,
      receipt,
      transition,
      outcome,
      state,
      targetWorkflowStatus,
      operationId,
      projectRoot: root,
      guardId: exactGuardId,
    };
  }

  async #settle(identity, { recovery = null } = {}) {
    if (identity.state === "succeeded") {
      const originalResult = {
        ...identity.outcome.result.task,
        ...(identity.outcome.result?.evidence?.response ?? {}),
      };
      const reconciliation = {
        outcome: "succeeded",
        durableState: "workflow_outcome",
        taskId: identity.task.id,
        projectRoot: identity.projectRoot,
        guardId: identity.guardId,
        proof: recovery?.proof ?? null,
        resultCommit: identity.outcome.result.evidence.resultCommit,
        taskRevision: identity.task.revision,
      };
      const receipt = await this.workspaceCatalog.completeUnknownMcpOperation(identity.operationId, {
        workspaceId: identity.workspace.id,
        toolName: "hub_task_status_update",
        result: originalResult,
        reconciliation,
      });
      return { resolved: true, outcome: "succeeded", receipt, reconciliation, result: originalResult };
    }
    const reason = identity.state === "rolled_back"
      ? identity.outcome.result.rollback.reason || "Task workflow transition was rolled back"
      : identity.transition.error || "Task workflow transition failed";
    const reconciliation = {
      outcome: "failed",
      durableState: identity.state === "rolled_back" ? "workflow_rollback" : "failed_transition",
      taskId: identity.task.id,
      projectRoot: identity.projectRoot,
      guardId: identity.guardId,
      proof: recovery?.proof ?? null,
    };
    const receipt = await this.workspaceCatalog.failUnknownMcpOperation(identity.operationId, {
      workspaceId: identity.workspace.id,
      toolName: "hub_task_status_update",
      error: new Error(reason),
      reconciliation,
    });
    return { resolved: true, outcome: "failed", receipt, reconciliation };
  }

  async reconcileUnknownWorkflow(options = {}) {
    return this.taskLifecycle.withUnknownWorkflowReconciliationLock({
      taskId: requiredText(options.taskId, "task id", 200),
      projectRoot: path.resolve(requiredText(options.projectRoot, "project root")),
    }, async (lease) => {
      let identity = this.#identity(options);
      if (identity.state !== "pending") return this.#settle(identity);
      if (!identity.guardId) {
        throw new Error("Pending workflow reconciliation requires the exact process-tree guard id");
      }
      const proof = {
        kind: requiredText(options.proofKind, "proof kind", 100),
        confirmed: options.confirmed === true,
        summary: requiredText(options.proofSummary, "proof summary", 1_000),
      };
      let recoveryResult = null;
      try {
        recoveryResult = await this.taskLifecycle.reconcileUnknownWorkflowStatusOwned({
          taskId: identity.task.id,
          operationId: identity.operationId,
          projectRoot: identity.projectRoot,
          guardId: identity.guardId,
          proof,
          lease,
        });
      } catch (error) {
        try {
          identity = this.#identity(options);
        } catch {
          return { resolved: false, outcome: "unknown", error: String(error?.message ?? error) };
        }
        if (identity.state === "pending") {
          return {
            resolved: false,
            outcome: "unknown",
            error: String(error?.message ?? error),
            transition: identity.transition,
          };
        }
        return this.#settle(identity, { recovery: recoveryResult?.recovery ?? null });
      }
      try {
        identity = this.#identity(options);
      } catch (error) {
        return { resolved: false, outcome: "unknown", error: String(error?.message ?? error) };
      }
      if (identity.state === "pending") {
        return { resolved: false, outcome: "unknown", error: "Workflow reconciliation did not reach a durable terminal state" };
      }
      return this.#settle(identity, { recovery: recoveryResult?.recovery ?? null });
    });
  }
}
