import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import path from "node:path";

import { normalizedTaskGitReferences, normalizedInitialNativeTest } from "../domain/task-git-reference.mjs";
import { taskProjectRoot } from "../domain/task-project-root.mjs";
import { normalizedTaskSquashTransfer } from "../domain/task-squash-transfer.mjs";
import { normalizedTaskSquashCutover } from "../domain/task-squash-cutover.mjs";
import { normalizedTaskWorkflowStatus, TaskLifecycleNoEffectError, TaskOperationReconciliationRefusedError,
  workflowAdmissionNoEffectEvidence } from "../domain/task-board-task.mjs";

import { normalizePublishedResolution } from "../domain/published-resolution.mjs";
import { selectedAbsorptionHandoff } from "../domain/task-selected-composition.mjs";
import { sameTaskWorkflowState as sameTaskState, nativeTestMetadataDrift } from "../domain/native-test-terminal-recovery.mjs";
import { mcpArgumentsHash } from "../domain/mcp-arguments-hash.mjs";

function requiredMethod(value, name) {
  if (typeof value?.[name] !== "function") throw new TypeError(`${name} is required`);
}

function requiredText(value, name, maximumLength = 2_000) {
  const text = String(value ?? "").trim();
  if (!text || text.length > maximumLength || text.includes("\0")) throw new Error(`invalid ${name}`);
  return text;
}

function samePath(left, right) {
  const canonical = (value) => {
    const resolved = path.resolve(String(value ?? ""));
    try {
      return realpathSync.native(resolved);
    } catch {
      return resolved;
    }
  };
  const a = canonical(left);
  const b = canonical(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

const WORKFLOW_STATUSES = new Set(["new", "in_progress", "blocked", "testing", "awaiting_implementation", "done"]);

// Protocol-v1 ordinary status has no alternate effect family. Its malformed
// enum is rejected before lifecycle mutation; error text is not this proof.
function malformedWorkflowArguments(receipt) {
  const execution = receipt?.taskExecution, args = execution?.arguments;
  const keys = ["request_id", "task_id", "status", "expected_task_revision", "expected_workflow_status"];
  if (execution?.version !== 1 || execution.protocol !== "task-operation-interruption-v1"
      || Object.keys(execution).some(key => !["version", "protocol", "taskId", "taskWorkspaceId", "ownerId", "arguments"].includes(key))
      || typeof execution.ownerId !== "string" || !execution.ownerId || execution.cancellation
      || !args || Object.keys(args).length !== keys.length || Object.keys(args).some(key => !keys.includes(key))
      || args.request_id !== receipt.requestId || args.task_id !== execution.taskId
      || typeof args.status !== "string" || !args.status.trim() || args.status.length > 40 || args.status.includes("\0")
      || !Number.isSafeInteger(args.expected_task_revision) || args.expected_task_revision < 1
      || !WORKFLOW_STATUSES.has(args.expected_workflow_status)
      || mcpArgumentsHash(args) !== receipt.argumentsHash) return null;
  try {
    normalizedTaskWorkflowStatus(args.status);
    return null;
  } catch {
    return args;
  }
}

function validationReceiptIdentity(receipt) {
  return canonicalValue(Object.fromEntries(["requestId", "workspaceId", "streamId", "provider", "threadId",
    "toolName", "argumentsHash", "createdAtMs", "taskExecution"].map(key => [key, receipt[key]])));
}

function supplied(value) {
  return value != null && String(value).trim() !== "";
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
}

function cutoverArguments({
  expectedTaskRevision, expectedWorkflowStatus, cutoverSourceCommit, cutoverProjectorSha256,
  cutoverSourceTaskId, cutoverSourceTaskRevision,
} = {}) {
  const cutoverValues = [
    cutoverSourceCommit, cutoverProjectorSha256, cutoverSourceTaskId, cutoverSourceTaskRevision,
  ];
  if (cutoverValues.every((value) => !supplied(value))) return null;
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

function workflowCasArguments({ expectedTaskRevision, expectedWorkflowStatus } = {}) {
  const hasRevision = supplied(expectedTaskRevision);
  const hasStatus = supplied(expectedWorkflowStatus);
  if (!hasRevision && !hasStatus) return null;
  const revision = hasRevision ? Number(expectedTaskRevision) : null;
  const workflowStatus = hasStatus ? String(expectedWorkflowStatus).trim() : null;
  if ((hasRevision && (!Number.isInteger(revision) || revision < 1))
      || (hasStatus && !WORKFLOW_STATUSES.has(workflowStatus))) {
    throw new Error("invalid workflow CAS operation identity");
  }
  return {
    ...(hasRevision ? { expected_task_revision: revision } : {}),
    ...(hasStatus ? { expected_workflow_status: workflowStatus } : {}),
  };
}

function selectedCompositionArguments(options = {}) {
  if (supplied(options.selectedAbsorptionHandoff)) selectedAbsorptionHandoff(options.selectedAbsorptionHandoff);
  const values = [options.selectedBundlePath, options.selectedBundleSha256,
    options.selectedProofCommit, options.selectedPreviewRequestId,
    options.expectedSelectedPreviewHash, options.selectedPublishedResolution, options.selectedAbsorptionHandoff];
  if (values.every((value) => !supplied(value))) return null;
  if (values.slice(0, -1).every(value => !supplied(value))) {
    if (!Number.isSafeInteger(Number(options.expectedTaskRevision)) || Number(options.expectedTaskRevision) < 1
        || options.expectedWorkflowStatus !== "in_progress") throw new Error("Invalid native absorption original CAS");
    return { expected_task_revision: Number(options.expectedTaskRevision), expected_workflow_status: "in_progress",
      selected_absorption_handoff: options.selectedAbsorptionHandoff };
  }
  const revision = Number(options.expectedTaskRevision);
  const bundlePath = String(options.selectedBundlePath ?? "").trim();
  const bundleSha256 = String(options.selectedBundleSha256 ?? "").trim().toLowerCase();
  const proofCommit = String(options.selectedProofCommit ?? "").trim().toLowerCase();
  const previewRequestId = String(options.selectedPreviewRequestId ?? "").trim();
  const previewHash = String(options.expectedSelectedPreviewHash ?? "").trim().toLowerCase();
  if (!Number.isInteger(revision) || revision < 1
      || options.expectedWorkflowStatus !== "in_progress"
      || !bundlePath || !/^[0-9a-f]{64}$/u.test(bundleSha256)
      || !/^[0-9a-f]{40}$/u.test(proofCommit)
      || !previewRequestId || !/^[0-9a-f]{64}$/u.test(previewHash)) {
    throw new Error("invalid selected composition reconciliation identity");
  }
  return {
    expected_task_revision: revision,
    expected_workflow_status: "in_progress",
    selected_proof_bundle_path: bundlePath,
    selected_proof_bundle_sha256: bundleSha256,
    selected_proof_commit: proofCommit,
    selected_preview_request_id: previewRequestId,
    expected_selected_preview_hash: previewHash,
    ...(supplied(options.selectedPublishedResolution)
      ? { selected_published_resolution: options.selectedPublishedResolution } : {}),
    ...(supplied(options.selectedAbsorptionHandoff)
      ? { selected_absorption_handoff: options.selectedAbsorptionHandoff } : {}),
  };
}

function squashArguments(options = {}) {
  const values = [
    options.squashSourceTaskId, options.squashSourceTaskRevision,
    options.squashBaselineResultCommit, options.squashNewResultCommit,
    options.squashDevAfterTree, options.squashProofRequestId,
    options.expectedSquashTransferHash,
    options.squashCutoverSourceTree, options.squashCutoverExpectedMainCommit,
    options.squashCutoverExpectedDevCommit, options.squashCutoverExpectedPreservedTree,
    options.squashCutoverSourceZipSha256, options.squashCutoverBundleSha256,
    options.squashCutoverManifestSha256, options.squashCutoverFilesSha256,
    options.expectedSquashCutoverHash,
  ];
  if (values.every((value) => !supplied(value))) return null;
  const revision = Number(options.expectedTaskRevision);
  const sourceRevision = Number(options.squashSourceTaskRevision);
  const commit = (value) => String(value ?? "").trim().toLowerCase();
  const sourceTaskId = String(options.squashSourceTaskId ?? "").trim();
  const proofRequestId = String(options.squashProofRequestId ?? "").trim();
  const baseline = commit(options.squashBaselineResultCommit);
  const result = commit(options.squashNewResultCommit);
  const tree = commit(options.squashDevAfterTree);
  const hash = commit(options.expectedSquashTransferHash);
  const cutoverValues = [
    options.cutoverSourceCommit, options.cutoverProjectorSha256,
    options.squashCutoverSourceTree, options.squashCutoverExpectedMainCommit,
    options.squashCutoverExpectedDevCommit, options.squashCutoverExpectedPreservedTree,
    options.squashCutoverSourceZipSha256, options.squashCutoverBundleSha256,
    options.squashCutoverManifestSha256, options.squashCutoverFilesSha256,
    options.expectedSquashCutoverHash,
  ];
  const hasCutover = cutoverValues.some((value) => supplied(value));
  const cutoverCommit = (value) => String(value ?? "").trim().toLowerCase();
  const cutoverHash = cutoverCommit(options.expectedSquashCutoverHash);
  if (!Number.isInteger(revision) || revision < 1
      || !Number.isInteger(sourceRevision) || sourceRevision < 1 || !sourceTaskId
      || !proofRequestId || proofRequestId.length > 200 || /[\r\n\0]/u.test(proofRequestId)
      || (supplied(options.expectedWorkflowStatus)
        && String(options.expectedWorkflowStatus).trim() !== (hasCutover ? "in_progress" : "testing"))
      || ![baseline, result, tree].every((value) => /^[0-9a-f]{40}$/u.test(value))
      || !/^[0-9a-f]{64}$/u.test(hash)
      || (hasCutover && (
        String(options.expectedWorkflowStatus ?? "").trim() !== "in_progress"
        || ![options.cutoverSourceCommit, options.squashCutoverSourceTree,
          options.squashCutoverExpectedMainCommit, options.squashCutoverExpectedDevCommit,
          options.squashCutoverExpectedPreservedTree]
          .every((value) => /^[0-9a-f]{40}$/u.test(cutoverCommit(value)))
        || ![options.cutoverProjectorSha256, options.squashCutoverSourceZipSha256,
          options.squashCutoverBundleSha256, options.squashCutoverManifestSha256,
          options.squashCutoverFilesSha256, cutoverHash]
          .every((value) => /^[0-9a-f]{64}$/u.test(cutoverCommit(value)))
      ))) {
    throw new Error("invalid Task squash transfer reconciliation identity");
  }
  return {
    expected_task_revision: revision,
    ...(supplied(options.expectedWorkflowStatus) ? {
      expected_workflow_status: String(options.expectedWorkflowStatus).trim(),
    } : {}),
    squash_source_task_id: sourceTaskId,
    squash_source_task_revision: sourceRevision,
    squash_baseline_result_commit: baseline,
    squash_new_result_commit: result,
    squash_dev_after_tree: tree,
    squash_proof_request_id: proofRequestId,
    expected_squash_transfer_hash: hash,
    ...(hasCutover ? {
      cutover_source_commit: cutoverCommit(options.cutoverSourceCommit),
      cutover_projector_sha256: cutoverCommit(options.cutoverProjectorSha256),
      squash_cutover_source_tree: cutoverCommit(options.squashCutoverSourceTree),
      squash_cutover_expected_main_commit: cutoverCommit(options.squashCutoverExpectedMainCommit),
      squash_cutover_expected_dev_commit: cutoverCommit(options.squashCutoverExpectedDevCommit),
      squash_cutover_expected_preserved_tree: cutoverCommit(options.squashCutoverExpectedPreservedTree),
      squash_cutover_source_zip_sha256: cutoverCommit(options.squashCutoverSourceZipSha256),
      squash_cutover_bundle_sha256: cutoverCommit(options.squashCutoverBundleSha256),
      squash_cutover_manifest_sha256: cutoverCommit(options.squashCutoverManifestSha256),
      squash_cutover_files_sha256: cutoverCommit(options.squashCutoverFilesSha256),
      expected_squash_cutover_hash: cutoverHash,
    } : {}),
  };
}

function workflowArgumentsHash({ operationId, taskId, status, identityArguments = null }) {
  return createHash("sha256").update(JSON.stringify(canonicalValue({
    request_id: operationId,
    status,
    task_id: taskId,
    ...(identityArguments ?? {}),
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

function exactWorkflowCasEvidence({ workflowCas, task, transition, outcome }) {
  if (!workflowCas) return true;
  const priorTask = transition?.priorTask ?? outcome?.result?.priorTask ?? null;
  if (!priorTask || priorTask.id !== task.id || priorTask.workspaceId !== task.workspaceId) return false;
  if (workflowCas.expected_task_revision != null
      && (Number(priorTask.revision) !== workflowCas.expected_task_revision
        || (transition && Number(transition.expectedRevision) !== workflowCas.expected_task_revision))) {
    return false;
  }
  return workflowCas.expected_workflow_status == null
    || priorTask.workflowStatus === workflowCas.expected_workflow_status;
}

function exactCommittedEvidence(committed, evidence, projectRoot, targetWorkflowStatus, priorTask = null) {
  if (!committed || committed.workflowStatus !== targetWorkflowStatus) return false;
  const resultCommit = String(evidence?.resultCommit ?? "").trim().toLowerCase();
  const reference = normalizedTaskGitReferences(committed.gitReferences)
    .find((item) => samePath(item.projectRoot, projectRoot));
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(resultCommit)
      || reference?.resultCommit !== resultCommit) return false;
  if (evidence?.outcome === "withdrawn_result") {
    const withdrawal = evidence.withdrawal;
    const priorReferences = normalizedTaskGitReferences(priorTask?.gitReferences)
      .filter((item) => samePath(item.projectRoot, projectRoot));
    return ["new", "in_progress", "blocked"].includes(targetWorkflowStatus)
      && ["testing", "awaiting_implementation"].includes(priorTask?.workflowStatus)
      && priorReferences.length === 1
      && priorReferences[0].branch === reference.branch
      && priorReferences[0].resultCommit === resultCommit
      && withdrawal?.taskId === committed.id
      && withdrawal?.resultCommit === resultCommit
      && ["withdrawn", "already_published"].includes(withdrawal?.outcome)
      && [withdrawal?.beforeDevCommit, withdrawal?.afterDevCommit]
        .every((commit) => /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(String(commit ?? "")))
      && JSON.stringify(canonicalValue(evidence.response?.gitWithdrawal)) === JSON.stringify(canonicalValue(withdrawal));
  }
  if (evidence?.outcome === "accepted_existing_result") {
    const priorReferences = normalizedTaskGitReferences(priorTask?.gitReferences)
      .filter((item) => samePath(item.projectRoot, projectRoot));
    return priorReferences.length === 1
      && priorReferences[0].branch === reference.branch
      && priorReferences[0].resultCommit === reference.resultCommit;
  }
  return reference?.resultCommit === resultCommit
    && String(evidence?.response?.gitWorkspace?.headCommit ?? "").trim().toLowerCase() === resultCommit
    && evidence?.response?.gitIntegration?.integrated === true;
}

export class TaskOperationReconciliationService {
  constructor({ workspaceCatalog, taskBoard, taskLifecycle, taskExecution = null, record = () => {} } = {}) {
    for (const name of [
      "workspace", "stream", "mcpOperation", "completeUnknownMcpOperation", "failUnknownMcpOperation",
    ]) requiredMethod(workspaceCatalog, name);
    for (const name of ["task", "lifecycleTransition", "lifecycleOutcome"]) requiredMethod(taskBoard, name);
    requiredMethod(taskLifecycle, "withUnknownWorkflowReconciliationLock");
    requiredMethod(taskLifecycle, "reconcileUnknownWorkflowStatusOwned");
    this.workspaceCatalog = workspaceCatalog;
    this.taskBoard = taskBoard;
    this.taskLifecycle = taskLifecycle;
    this.taskExecution = taskExecution;
    this.record = record;
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
    const root = projectRoot == null ? null : path.resolve(requiredText(projectRoot, "project root"));
    const guardText = String(guardId ?? "").trim();
    const exactGuardId = guardText ? requiredText(guardText, "guard id", 200) : null;
    const targetWorkflowStatus = transition?.targetWorkflowStatus
      ?? outcome?.result?.noEffect?.targetWorkflowStatus
      ?? outcome?.result?.task?.workflowStatus
      ?? null;
    const squash = squashArguments(options);
    const selected = squash ? null : selectedCompositionArguments(options);
    const initial = options.initialNativeTest == null ? null : {
      ...workflowCasArguments(options), initial_native_test: normalizedInitialNativeTest(options.initialNativeTest),
    };
    if (initial && (squash || selected || cutoverArguments(options)
        || initial.expected_workflow_status !== "in_progress" || !initial.expected_task_revision)) {
      throw new Error("Initial native Test reconciliation requires its complete original family");
    }
    const cutover = squash || selected || initial ? null : cutoverArguments(options);
    const workflowCas = squash || selected || cutover || initial ? null : workflowCasArguments(options);
    const validTarget = WORKFLOW_STATUSES.has(targetWorkflowStatus);
    const taskRoot = taskProjectRoot({
      workspace,
      stream: task.streamId ? this.workspaceCatalog.stream(task.streamId) : null,
    });
    const malformed = malformedWorkflowArguments(receipt);
    if (malformed) {
      const stream = this.workspaceCatalog.stream(receipt.streamId);
      if (transition || outcome || receipt.result != null || receipt.preparationState || receipt.claimCustody
          || receipt.interstreamContentHash || receipt.workspaceId !== workspace.id
          || receipt.toolName !== "hub_task_status_update" || receipt.operationStatus !== "pending"
          || receipt.receiptState !== "unknown" || !Number.isSafeInteger(receipt.createdAtMs)
          || receipt.taskExecution.taskWorkspaceId !== workspace.id || malformed.task_id !== task.id
          || !stream || stream.workspaceId !== workspace.id || !["codex", "claude"].includes(receipt.provider)
          || typeof receipt.threadId !== "string" || !receipt.threadId || receipt.actorKind
          || options.expectedArgumentsHash !== receipt.argumentsHash
          || !root || !taskRoot || !samePath(root, taskRoot) || exactGuardId
          || squash || selected || initial || cutover || options.nativeResolutionReview != null
          || workflowCas?.expected_task_revision !== malformed.expected_task_revision
          || workflowCas?.expected_workflow_status !== malformed.expected_workflow_status
          || task.revision !== malformed.expected_task_revision || task.workflowStatus !== malformed.expected_workflow_status) {
        throw new Error("Malformed workflow original identity, effects or Task CAS differs");
      }
      return { workspace, task, receipt, transition, outcome, operationId, projectRoot: root,
        state: "invalid_input", malformed, validationIdentity: validationReceiptIdentity(receipt) };
    }
    if (outcome?.result?.noEffect) {
      const proof = !transition && workflowAdmissionNoEffectEvidence(outcome, receipt);
      if (!proof || proof.taskId !== task.id || proof.workspaceId !== workspace.id
          || receipt.operationStatus !== "pending" || receipt.receiptState !== "unknown"
          || (proof.projectRoot !== null && (!root || !samePath(root, proof.projectRoot))) || squash || cutover
          || (workflowCas?.expected_task_revision ?? null) !== proof.expectedRevision
          || (workflowCas?.expected_workflow_status ?? null) !== proof.expectedWorkflowStatus
          || receipt.argumentsHash !== workflowArgumentsHash({
            operationId, taskId: task.id, status: proof.targetWorkflowStatus, identityArguments: workflowCas,
          })) throw new Error("Workflow refusal identity does not match the original operation");
      return { workspace, task, receipt, transition, outcome, operationId, projectRoot: proof.projectRoot,
        guardId: exactGuardId, state: "no_effect", noEffect: proof };
    }
    if (!root) throw new Error("Unknown workflow operation identity requires a project root");

    const nativeResolutionReview = options.nativeResolutionReview ?? null;
    const originalReview = transition?.evidence?.nativeResolutionReview
      ?? outcome?.result?.evidence?.nativeResolutionReview ?? null;
    const reviewReceipt = originalReview ? this.workspaceCatalog.mcpOperation(originalReview.requestId) : null;
    const reviewMatches = JSON.stringify(canonicalValue(originalReview)) === JSON.stringify(canonicalValue(nativeResolutionReview))
      && (!originalReview || (reviewReceipt?.toolName === "hub_stream_message_send"
        && reviewReceipt.status === "succeeded" && reviewReceipt.receiptState === "succeeded"
        && reviewReceipt.workspaceId === receipt?.workspaceId && reviewReceipt.provider === receipt?.provider
        && reviewReceipt.result?.target?.streamId === receipt?.streamId));
    const metadataRecovery = !squash && !selected && !initial && !cutover && !exactGuardId
      && reviewMatches && nativeTestMetadataDrift(task, transition);
    const receiptSettled = !transition && (outcome?.result?.evidence?.nativeTerminalRecovery
      || outcome?.result?.evidence?.nativeAwaitRecovery)
      && receipt?.operationStatus === "succeeded" && receipt?.receiptState === "succeeded";
    const receiptMatches = receipt
      && receipt.workspaceId === workspace.id
      && receipt.toolName === "hub_task_status_update"
      && validTarget
      && receipt.argumentsHash === workflowArgumentsHash({
        operationId, taskId: task.id, status: targetWorkflowStatus,
        identityArguments: { ...(initial ?? squash ?? selected ?? cutover ?? workflowCas),
          ...(options.nativeResolutionReview != null ? { native_resolution_review: options.nativeResolutionReview } : {}) },
      })
      && ((receipt.operationStatus === "pending" && receipt.receiptState === "unknown") || receiptSettled);
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
    const workflowCasMatches = exactWorkflowCasEvidence({ workflowCas, task, transition, outcome });
    const initialEvidence = transition?.evidence?.initialNativeTest ?? outcome?.result?.evidence?.initialNativeTest;
    const initialPrior = transition?.priorTask ?? outcome?.result?.priorTask;
    const returnedCommit = initial?.initial_native_test.returnedResultCommit;
    const initialReferencesMatch = returnedCommit
      ? initialPrior?.gitReferences?.length === 1
        && initialPrior.gitReferences[0].resultCommit === returnedCommit
        && samePath(initialPrior.gitReferences[0].projectRoot, root)
        && initialEvidence?.priorResult?.taskId === task.id
        && initialEvidence.priorResult.resultCommit === returnedCommit
        && samePath(initialEvidence.priorResult.projectRoot, root)
      : !initialPrior?.gitReferences?.length && !initialEvidence?.priorResult;
    const initialMatches = !initial || (targetWorkflowStatus === "testing"
      && initialPrior?.workflowStatus === "in_progress" && initialReferencesMatch
      && initialPrior.revision === initial.expected_task_revision
      && initialEvidence?.taskId === task.id && initialEvidence.taskRevision === initial.expected_task_revision
      && initialEvidence.authority.workspaceId === receipt.workspaceId
      && initialEvidence.authority.streamId === receipt.streamId
      && initialEvidence.authority.provider === receipt.provider && initialEvidence.authority.threadId === receipt.threadId
      && samePath(initialEvidence.projectRoot, root)
      && JSON.stringify(initialEvidence.identity) === JSON.stringify(initial.initial_native_test)
      && (!outcome || outcome.result.evidence.resultCommit === initial.initial_native_test.sourceCommit));
    let squashMatches = true;
    let selectedMatches = true;
    if (selected) {
      if (!selected.selected_proof_commit) {
        const evidence = transition?.evidence ?? outcome?.result?.evidence;
        const input = evidence?.nativeAbsorptionInput;
        selectedMatches = targetWorkflowStatus === "testing"
          && (transition?.expectedRevision ?? outcome?.result?.priorTask?.revision) === selected.expected_task_revision
          && JSON.stringify(input ? { requestId: input.requestId, text: input.text } : null)
            === JSON.stringify(selected.selected_absorption_handoff);
      } else {
      const selectedProof = transition?.evidence?.selectedComposition
        ?? outcome?.result?.evidence?.selectedComposition;
      selectedMatches = targetWorkflowStatus === "testing"
        && selectedProof?.taskId === task.id
        && selectedProof?.expectedTaskRevision === selected.expected_task_revision
        && selectedProof?.authority?.proofRequestId === selected.selected_preview_request_id
        && selectedProof?.previewHash === selected.expected_selected_preview_hash
        && selectedProof?.proofCommit === selected.selected_proof_commit
        && selectedProof?.bundleSha256 === selected.selected_proof_bundle_sha256
        && selectedProof?.bundlePath === path.resolve(selected.selected_proof_bundle_path)
        && JSON.stringify(normalizePublishedResolution(selectedProof?.publishedResolutionInput))
          === JSON.stringify(normalizePublishedResolution(selected.selected_published_resolution))
        && JSON.stringify(selectedProof?.absorptionInput
          ? { requestId: selectedProof.absorptionInput.requestId, text: selectedProof.absorptionInput.text } : null)
          === JSON.stringify(selected.selected_absorption_handoff ?? null)
        && samePath(selectedProof?.repositoryRoot, root);
      }
    }
    let squashSourceTask = null;
    if (squash) {
      const proofValue = transition?.evidence?.squashTransfer
        ?? outcome?.result?.evidence?.squashTransfer;
      try {
        const proof = normalizedTaskSquashTransfer(proofValue);
        const cutoverValue = transition?.evidence?.squashCutover
          ?? outcome?.result?.evidence?.squashCutover ?? null;
        const expectedCutover = squash.expected_squash_cutover_hash ?? null;
        const cutoverProof = cutoverValue ? normalizedTaskSquashCutover(cutoverValue) : null;
        squashSourceTask = this.taskBoard.task(proof.source.taskId);
        squashMatches = targetWorkflowStatus === "testing"
          && proof.transferHash === squash.expected_squash_transfer_hash
          && proof.survivor.taskId === task.id
          && proof.survivor.revision === squash.expected_task_revision
          && proof.source.taskId === squash.squash_source_task_id
          && proof.source.revision === squash.squash_source_task_revision
          && proof.baselineResultCommit === squash.squash_baseline_result_commit
          && proof.survivor.resultCommit === squash.squash_new_result_commit
          && proof.devAfterTree === squash.squash_dev_after_tree
          && proof.authority.proofRequestId === squash.squash_proof_request_id
          && samePath(proof.projectRoot, root)
          && Boolean(squashSourceTask)
          && Boolean(cutoverProof) === Boolean(expectedCutover)
          && (!cutoverProof || (
            cutoverProof.cutoverHash === expectedCutover
            && cutoverProof.reviewedSourceCommit === squash.cutover_source_commit
            && cutoverProof.reviewedSourceTree === squash.squash_cutover_source_tree
            && cutoverProof.expectedMainCommit === squash.squash_cutover_expected_main_commit
            && cutoverProof.expectedDevCommit === squash.squash_cutover_expected_dev_commit
            && cutoverProof.expectedPreservedTree === squash.squash_cutover_expected_preserved_tree
            && cutoverProof.projectorSha256 === squash.cutover_projector_sha256
            && cutoverProof.artifacts.sourceZipSha256 === squash.squash_cutover_source_zip_sha256
            && cutoverProof.artifacts.bundleSha256 === squash.squash_cutover_bundle_sha256
            && cutoverProof.artifacts.manifestSha256 === squash.squash_cutover_manifest_sha256
            && cutoverProof.artifacts.filesSha256 === squash.squash_cutover_files_sha256
          ));
      } catch { squashMatches = false; }
    }
    if (!receiptMatches || !transitionMatches || !outcomeMatches || !cutoverMatches || !workflowCasMatches
        || !squashMatches || !selectedMatches || !initialMatches
        || !taskRoot || !samePath(taskRoot, root)) {
      throw new Error("Unknown workflow operation identity, lifecycle state, project root or Task CAS does not match");
    }
    let state = null;
    if (outcome && !transition) {
      if (squash) {
        if (sameTaskState(task, outcome.result?.task)
            && sameTaskState(squashSourceTask, outcome.result?.sourceTask)) state = "succeeded";
      } else
      if (outcome.result?.rollback?.completed === true) {
        if (
          sameTaskState(task, outcome.result?.restoredTask)
          && exactCommittedEvidence(
            outcome.result?.task, outcome.result?.evidence, root, targetWorkflowStatus,
            outcome.result?.priorTask,
          )
        ) state = "rolled_back";
      } else {
        const committed = outcome.result?.task;
        if (
          sameTaskState(task, committed, { allowMetadataRevision: Boolean(outcome.result?.evidence?.nativeTerminalRecovery) })
          && exactCommittedEvidence(
            committed, outcome.result?.evidence, root, targetWorkflowStatus, outcome.result?.priorTask,
          )
        ) state = "succeeded";
      }
    } else if (transition && !outcome) {
      const revisionUnchanged = transition.expectedRevision === task.revision;
      const pendingUnchanged = squash
        ? revisionUnchanged && sameTaskState(task, transition.priorTask)
          && sameTaskState(squashSourceTask, transition.priorSourceTask)
        : revisionUnchanged && task.workflowStatus !== targetWorkflowStatus;
      const failedUnchanged = (revisionUnchanged || (!squash && !cutover && !initial
          && Number(task.revision) > Number(transition.expectedRevision)))
        && sameTaskState(task, transition.priorTask, { allowMetadataRevision: !squash && !cutover && !initial })
        && (!squash || sameTaskState(squashSourceTask, transition.priorSourceTask));
      if (transition.phase === "pending_git" && (pendingUnchanged || metadataRecovery)) state = "pending";
      if (transition.phase === "failed" && failedUnchanged) state = "failed";
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
      metadataRecovery,
      nativeResolutionReview,
      receiptSettled,
      squash,
      selected,
      sourceTaskId: squash?.squash_source_task_id
        ?? selectedAbsorptionHandoff(selected?.selected_absorption_handoff)?.declaration.sourceTaskId ?? null,
      withdrawal: state === "succeeded" && outcome?.result?.evidence?.outcome === "withdrawn_result"
        || state === "pending" && ["new", "in_progress", "blocked"].includes(targetWorkflowStatus)
          && ["testing", "awaiting_implementation"].includes(task.workflowStatus)
          && sameTaskState(task, transition?.priorTask)
          && normalizedTaskGitReferences(task.gitReferences)
            .filter((reference) => samePath(reference.projectRoot, root)).length === 1,
    };
  }

  async #settle(identity, { recovery = null } = {}) {
    if (identity.state === "no_effect") {
      const reconciliation = { outcome: "NO_EFFECT", durableState: "workflow_admission_refusal", evidence: identity.noEffect };
      const receipt = await this.workspaceCatalog.failUnknownMcpOperation(identity.operationId, {
        workspaceId: identity.workspace.id, toolName: "hub_task_status_update",
        error: new TaskLifecycleNoEffectError(identity.noEffect), reconciliation,
      });
      return { resolved: true, outcome: "failed", receipt, reconciliation };
    }
    if (identity.state === "succeeded") {
      const originalResult = identity.squash ? {
        task: identity.outcome.result.task,
        sourceTask: identity.outcome.result.sourceTask,
        squashTransfer: identity.outcome.result.evidence.squashTransfer,
        ...(identity.outcome.result.evidence.squashCutover ? {
          squashCutover: identity.outcome.result.evidence.squashCutover,
        } : {}),
      } : {
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
      const receipt = identity.receiptSettled ? identity.receipt : await this.workspaceCatalog.completeUnknownMcpOperation(identity.operationId, {
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

  #validationTrace(operationId, stage, started, outcome) {
    try {
      const pending = this.record({ commandId: operationId, transport: "task-operation", stage, outcome,
        monotonicDurationMs: performance.now() - started, metadata: { malformed: 1 } });
      pending?.catch?.(() => {});
    } catch {}
  }

  async #settleMalformed(identity, options, lease, onSettle) {
    requiredMethod(this.taskLifecycle, "assertMalformedWorkflowIdleOwned");
    requiredMethod(this.taskExecution, "validationRetirement");
    requiredMethod(this.taskExecution, "assertValidationIdle");
    await this.taskLifecycle.assertMalformedWorkflowIdleOwned({ taskId: identity.task.id,
      operationId: identity.operationId, lease });
    const started = performance.now();
    let retirement;
    try {
      retirement = await this.taskExecution.validationRetirement(identity.receipt, { runtimeWitness: options.runtimeWitness });
      this.#validationTrace(identity.operationId, "task-workflow-invalid-retirement", started, "succeeded");
    } catch (error) {
      this.#validationTrace(identity.operationId, "task-workflow-invalid-retirement", started, "failed");
      throw error;
    }
    await lease.assertOwned();
    const expected = JSON.stringify(identity.validationIdentity);
    const check = receipt => {
      const fresh = this.#identity(options);
      if (fresh.state !== "invalid_input" || JSON.stringify(fresh.validationIdentity) !== expected
          || JSON.stringify(validationReceiptIdentity(receipt)) !== expected) {
        throw new Error("Malformed workflow original changed before receipt settlement");
      }
      this.taskExecution.assertValidationIdle(receipt);
    };
    check(this.workspaceCatalog.mcpOperation(identity.operationId));
    const reconciliation = { outcome: "failed", durableState: "workflow_input_validation",
      validation: { version: 1, kind: "ordinary-workflow-invalid-enum-v1", code: "TASK_WORKFLOW_STATUS_INVALID",
        taskId: identity.task.id, taskRevision: identity.task.revision, argumentsHash: identity.receipt.argumentsHash },
      executionRetirement: retirement,
      previousReceipt: { receiptState: identity.receipt.receiptState, completedAtMs: identity.receipt.completedAtMs,
        error: identity.receipt.error } };
    const settleStarted = performance.now();
    onSettle();
    try {
      const receipt = await this.workspaceCatalog.failUnknownMcpOperation(identity.operationId, {
        workspaceId: identity.workspace.id, toolName: "hub_task_status_update", error: new Error("Неизвестный статус Task"),
        reconciliation, beforeSettle: check });
      this.#validationTrace(identity.operationId, "task-workflow-invalid-settlement", settleStarted, "failed");
      return { resolved: true, outcome: "failed", receipt, reconciliation };
    } catch (error) {
      this.#validationTrace(identity.operationId, "task-workflow-invalid-settlement", settleStarted, "unknown");
      throw error;
    }
  }

  async reconcileUnknownWorkflow(options = {}) {
    let initial;
    const validationStarted = performance.now();
    try {
      initial = this.#identity(options);
      if (initial.state === "invalid_input") this.#validationTrace(initial.operationId,
        "task-workflow-invalid-validation", validationStarted, "succeeded");
      if (initial.state !== "no_effect" && initial.workspace.settings?.releaseWorkflowEnabled !== true) {
        throw new Error("Unknown workflow reconciliation requires an enabled release workflow");
      }
    } catch (error) {
      throw new TaskOperationReconciliationRefusedError(error);
    }
    // Immutable pre-admission refusal has no Git/process effects to recover.
    // The existing receipt owner's exact UNKNOWN CAS is the only mutation;
    // the terminal outcome already fences any later lifecycle admission.
    // Settlement errors remain ambiguous, not a new pre-effect certificate.
    if (initial.state === "no_effect") return this.#settle(initial);
    const lockStarted = performance.now();
    let lockEntered = false;
    try {
    return await this.taskLifecycle.withUnknownWorkflowReconciliationLock({
      taskId: requiredText(options.taskId, "task id", 200),
      sourceTaskId: options.squashSourceTaskId
        ? requiredText(options.squashSourceTaskId, "squash source task id", 200)
        : selectedAbsorptionHandoff(options.selectedAbsorptionHandoff)?.declaration.sourceTaskId ?? null,
      operationId: requiredText(options.operationRequestId, "operation request id", 300),
      projectRoot: path.resolve(requiredText(options.projectRoot, "project root")),
    }, async (lease) => {
      lockEntered = true;
      if (initial.state === "invalid_input") this.#validationTrace(initial.operationId,
        "task-workflow-invalid-lock-wait", lockStarted, "succeeded");
      let effectsStarted = false;
      try {
      let identity = this.#identity(options);
      if (identity.state === "invalid_input") {
        return await this.#settleMalformed(identity, options, lease, () => { effectsStarted = true; });
      }
      const needsRecovery = identity.state === "pending" || identity.withdrawal;
      if (identity.state === "pending" && !identity.guardId && !identity.withdrawal
          && !identity.squash && !identity.selected) {
        const native = typeof this.taskLifecycle.pendingNativeWorkflowOwned === "function"
          && await this.taskLifecycle.pendingNativeWorkflowOwned({ taskId: identity.task.id,
            operationId: identity.operationId, projectRoot: identity.projectRoot, lease,
            allowMetadataRecovery: identity.metadataRecovery });
        if (!native) throw new Error("Pending workflow reconciliation requires the exact process-tree guard id or original native Git intent");
      }
      const proof = needsRecovery && identity.guardId ? {
        kind: requiredText(options.proofKind, "proof kind", 100),
        confirmed: options.confirmed === true,
        summary: requiredText(options.proofSummary, "proof summary", 1_000),
      } : null;
      const settle = async (terminal, recovery = null) => {
        effectsStarted = true;
        if (terminal.state === "succeeded" && terminal.withdrawal) {
          try {
            const finalized = await this.taskLifecycle.reconcileUnknownWorkflowStatusOwned({
              taskId: terminal.task.id, operationId: terminal.operationId,
              projectRoot: terminal.projectRoot, guardId: terminal.guardId, proof, lease,
              finalizeCommittedWithdrawal: true,
            });
            recovery = finalized?.recovery ?? recovery;
            terminal = this.#identity(options);
            if (terminal.state !== "succeeded" || !terminal.withdrawal) {
              throw new Error("Withdrawal state changed before receipt settlement");
            }
          } catch (error) {
            return { resolved: false, outcome: "unknown", error: String(error?.message ?? error) };
          }
        }
        return this.#settle(terminal, { recovery });
      };
      if (identity.state !== "pending") return settle(identity);
      let recoveryResult = null;
      effectsStarted = true;
      try {
        recoveryResult = await this.taskLifecycle.reconcileUnknownWorkflowStatusOwned({
          taskId: identity.task.id,
          operationId: identity.operationId,
          projectRoot: identity.projectRoot,
          guardId: identity.guardId,
          proof,
          lease,
          verifyInitialNativeTest: options.verifyInitialNativeTest,
          allowMetadataRecovery: identity.metadataRecovery,
          nativeResolutionReview: identity.nativeResolutionReview,
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
        return settle(identity, recoveryResult?.recovery ?? null);
      }
      try {
        identity = this.#identity(options);
      } catch (error) {
        return { resolved: false, outcome: "unknown", error: String(error?.message ?? error) };
      }
      if (identity.state === "pending") {
        return { resolved: false, outcome: "unknown", error: "Workflow reconciliation did not reach a durable terminal state" };
      }
      return settle(identity, recoveryResult?.recovery ?? null);
      } catch (error) {
        if (!effectsStarted) throw new TaskOperationReconciliationRefusedError(error);
        throw error;
      }
    });
    } catch (error) {
      if (!lockEntered && initial.state === "invalid_input") this.#validationTrace(initial.operationId,
        "task-workflow-invalid-lock-wait", lockStarted, "failed");
      throw error;
    }
  }
}
