import { TaskOperationInterruption, INTERRUPTIBLE_TASK_TOOLS, taskOperationInterrupted } from "./task-operation-interruption.mjs";
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { TaskCleanupConfirmationRejectedError, archivedArtifactCapsule, archivedArtifactPreview, cleanupConfirmationCapsule, cleanupConfirmationOriginal, taskCleanupIsConfirmed } from "../domain/task-cleanup-confirmation.mjs";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, realpath, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { MAX_ATTACHMENT_BYTES, attachmentContentType, attachmentMetadataFromId, taskAttachmentDescriptors, createAttachmentStorageName } from "../domain/attachment-files.mjs";
import { createInterstreamOrigin, createInterstreamMessage, interstreamAuditContentHash, interstreamDisplayText } from "../domain/interstream-message.mjs";
import { canonicalMcpValue, mcpArgumentsHash } from "../domain/mcp-arguments-hash.mjs";
import { claimCustodyHash, claimCustodyState, assertClaimCustodyOriginal, TaskClaimCustodyRejectedError, TaskClaimContinuationWithdrawnError } from "../domain/claim-forward-custody.mjs";
import { taskProjectRoot } from "../domain/task-project-root.mjs";
import { normalizedInitialNativeTest } from "../domain/task-git-reference.mjs";
import { normalizedReleaseReference } from "../domain/task-checklist.mjs";
import { normalizedTaskDescription, normalizedTaskText, normalizedTaskTitle, normalizedTaskWorkflowStatus, TASK_TITLE_MAX_LENGTH, TaskDependencyPendingError, TaskLifecycleBeginRejectedError, TaskLifecycleNoEffectError, TaskOperationReconciliationRefusedError, workflowAdmissionNoEffectEvidence, claimAdmissionNoEffectEvidence, claimAdmissionRefusalError, TaskClaimExecutorBusyError, ReleaseCandidateFrozenError, TaskAbsorptionCompositionError } from "../domain/task-board-task.mjs";
import { taskRunIsActive } from "../domain/task-runs.mjs";
import { displayUserPrompt } from "./task-history.mjs";
import { TaskLifecycleService, TaskLifecyclePersistenceError, TaskIntegrationConflictError, TaskAwaitIntegrationError, TaskWithdrawalDependencyError, TaskWithdrawalBusyError, TaskSquashTransferRejectedError } from "./task-lifecycle-service.mjs";
import { TaskOperationReconciliationService } from "./task-operation-reconciliation-service.mjs";
import { TaskIntegrationRejectedError } from "./task-lifecycle-service.mjs";
import { createWorkspaceCatalogMutationOwner } from "./sqlite-mutation-owner.mjs";
import { McpAdmissionContentionError } from "../domain/mcp-admission-contention.mjs";



const CONTEXT_TOKEN_VERSION = 1;
const MAX_REGISTERED_CONTEXT_CAPABILITIES = 1_000;
const STREAM_HISTORY_CURSOR_VERSION = 1;
const DEFAULT_HISTORY_ACTIVITY_LIMIT = 40;
const DEFERRED_INPUT_STALLED_AFTER_MS = 60_000;
const TASK_COMPLETE_BATCH = "hub_task_complete_batch";
const MAX_BATCH_COMPLETIONS = 50;
const MANUAL_DELIVERY_SCHEMA = { type: "object", additionalProperties: false, required: ["revision", "releaseId", "manifestSha256"], properties: {
  revision: { type: "string", pattern: "^[a-f0-9]{40}$" }, releaseId: { type: "string" },
  manifestSha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
} };
const MUTATING_TOOLS = new Set([
  "hub_task_create", "hub_task_update", "hub_task_checklist_update", "hub_task_move", "hub_task_start", "hub_task_reassign", "hub_task_launch_cancel", "hub_task_claim", "hub_task_status_update", "hub_task_operation_cancel", "hub_task_legacy_git_adopt", "hub_task_complete", "hub_task_delete",
  "hub_task_attachment_add", "hub_workspace_rules_update", "hub_stream_rules_update",
  "hub_stream_message_send",
  "hub_task_operation_reconcile",
  TASK_COMPLETE_BATCH,
]);

// Only the synchronous input boundary below can produce this proof of no effects.
class TaskInputValidationError extends Error {}

function completionError(error) {
  return { name: String(error?.name ?? "Error").slice(0, 100),
    code: /^[A-Z0-9_]{1,64}$/u.test(error?.code ?? "") ? error.code : null,
    message: String(error?.message ?? error ?? "Unknown failure").slice(0, 4000) };
}

function definiteMcpMutationFailure(error) {
  return error instanceof TaskClaimCustodyRejectedError || error instanceof TaskInputValidationError
    || error instanceof TaskIntegrationConflictError || error instanceof TaskAwaitIntegrationError
    || error instanceof TaskDependencyPendingError || error instanceof TaskWithdrawalDependencyError
    || error instanceof TaskLifecycleBeginRejectedError || error instanceof TaskWithdrawalBusyError
    || error instanceof ReleaseCandidateFrozenError || error instanceof TaskAbsorptionCompositionError
    || error instanceof TaskSquashTransferRejectedError || error instanceof TaskIntegrationRejectedError;
}

function validatedTaskInput(title, description, { combined = false } = {}) {
  try {
    const normalizedTitle = normalizedTaskTitle(title);
    const normalizedDescription = normalizedTaskDescription(description);
    requiredText(normalizedTitle, "task title", TASK_TITLE_MAX_LENGTH);
    const text = combined
      ? normalizedTaskText(normalizedDescription ? `${normalizedTitle}\n\n${normalizedDescription}` : normalizedTitle)
      : undefined;
    return { title: normalizedTitle, description: normalizedDescription, text };
  } catch (cause) {
    throw new TaskInputValidationError(cause.message, { cause });
  }
}

export function hubMcpToolMutates(name) {
  return MUTATING_TOOLS.has(String(name ?? "").trim());
}
const TEXT_ATTACHMENT_TYPES = new Set([
  "text/plain", "text/markdown", "text/csv", "application/json", "application/xml",
]);

function interstreamOriginFromContext(context, sourceRun, requestId) {
  return createInterstreamOrigin({
    workspaceId: context.workspaceId,
    workspaceName: context.workspaceName,
    streamId: context.streamId,
    streamName: context.streamName,
    provider: context.provider,
    model: String(sourceRun?.model ?? sourceRun?.modelId ?? "").trim(),
    sourceThreadId: context.threadId ?? context.auditThreadId,
    requestId,
  });
}

function requiredMethod(value, name) {
  if (typeof value?.[name] !== "function") throw new TypeError(`${name} is required`);
}

function requiredText(value, name, maximumLength = 10_000) {
  const text = String(value ?? "").trim();
  if (!text || text.length > maximumLength || text.includes("\0")) throw new Error(`invalid ${name}`);
  return text;
}

function optionalText(value, maximumLength = 10_000) {
  if (value == null) return null;
  const text = String(value);
  if (text.length > maximumLength || text.includes("\0")) throw new Error("text is too long");
  return text;
}

const canonicalValue = canonicalMcpValue;
const argumentsHash = mcpArgumentsHash;

function inside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return !relative || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameFileVersion(left, right) {
  return sameFileIdentity(left, right)
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

async function rejectLinkTraversal(root, source) {
  const relative = path.relative(path.resolve(root), source);
  let current = path.resolve(root);
  const segments = relative.split(path.sep).filter(Boolean);
  if (!segments.length) throw new Error("attachment source must be a regular file");
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    const details = await lstat(current);
    if (details.isSymbolicLink()) {
      throw new Error("attachment source cannot traverse a symlink or reparse point");
    }
    const final = index === segments.length - 1;
    if ((final && !details.isFile()) || (!final && !details.isDirectory())) {
      throw new Error("attachment source must be a regular file");
    }
  }
}

async function openAttachmentSource(source, roots) {
  const root = roots.find((candidate) => inside(candidate, source));
  if (!root) throw new Error("attachment source is outside the current project");
  const canonicalRoot = await realpath(root);
  const canonicalSource = await realpath(source);
  if (!inside(canonicalRoot, canonicalSource)) {
    throw new Error("attachment source is outside the current project");
  }
  await rejectLinkTraversal(root, source);
  let handle;
  try {
    handle = await open(source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    if (process.platform !== "win32" || !constants.O_NOFOLLOW || !["EINVAL", "ENOTSUP"].includes(error.code)) {
      throw error;
    }
    handle = await open(source, constants.O_RDONLY);
  }
  try {
    const opened = await handle.stat({ bigint: true });
    const current = await stat(source, { bigint: true });
    if (!opened.isFile() || !current.isFile() || !sameFileIdentity(opened, current)) {
      throw new Error("attachment source is not a stable regular file");
    }
    if (opened.size < 1n || opened.size > BigInt(MAX_ATTACHMENT_BYTES)) {
      throw new Error("attachment size is not supported");
    }
    if (await realpath(source) !== canonicalSource) {
      throw new Error("attachment source changed while it was being opened");
    }
    await rejectLinkTraversal(root, source);
    return { handle, opened, canonicalSource, root };
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

async function readStableAttachmentSource(source, roots) {
  const { handle, opened, canonicalSource, root } = await openAttachmentSource(source, roots);
  try {
    const chunks = [];
    let offset = 0;
    while (offset <= MAX_ATTACHMENT_BYTES) {
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, MAX_ATTACHMENT_BYTES + 1 - offset));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
      if (!bytesRead) break;
      chunks.push(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
    if (offset < 1 || offset > MAX_ATTACHMENT_BYTES) throw new Error("attachment size is not supported");
    await rejectLinkTraversal(root, source);
    const after = await handle.stat({ bigint: true });
    const current = await stat(source, { bigint: true });
    if (
      !sameFileVersion(opened, after)
      || !sameFileIdentity(after, current)
      || after.size !== BigInt(offset)
      || await realpath(source) !== canonicalSource
    ) {
      throw new Error("attachment source changed while it was being copied");
    }
    return Buffer.concat(chunks, offset);
  } finally {
    await handle.close().catch(() => {});
  }
}

function compactText(value, maximumLength) {
  const text = typeof value === "string"
    ? value
    : JSON.stringify(value ?? "");
  return text.length <= maximumLength ? text : `${text.slice(0, maximumLength)}\n…[truncated]`;
}

function activeRun(value) {
  return ["running", "finishing"].includes(String(value?.status ?? "running").trim().toLowerCase());
}

function turnIdentityKey({ provider, threadId, turnId, runId = null } = {}) {
  const normalizedProvider = String(provider ?? "").trim().toLowerCase();
  const normalizedThreadId = String(threadId ?? "").trim();
  const normalizedTurnId = String(turnId ?? "").trim();
  if (normalizedProvider && normalizedThreadId && normalizedTurnId) {
    return `${normalizedProvider}\0${normalizedThreadId}\0${normalizedTurnId}`;
  }
  return runId ? `run\0${String(runId)}` : "";
}

function turnIdentityAliases(value = {}) {
  const aliases = [];
  const providerTurn = turnIdentityKey(value);
  if (providerTurn) aliases.push(providerTurn);
  const runId = String(value?.runId ?? value?.id ?? "").trim();
  if (runId) aliases.push(`run\0${runId}`);
  return [...new Set(aliases)];
}

function streamHistoryTurnTime(turn) {
  const timestamp = Date.parse(String(turn?.active ? turn?.startedAt : turn?.completedAt ?? turn?.startedAt ?? ""));
  return Number.isFinite(timestamp) ? timestamp : Number.NEGATIVE_INFINITY;
}

function compareStreamHistoryTurns(left, right) {
  const byTime = streamHistoryTurnTime(right) - streamHistoryTurnTime(left);
  if (Number.isFinite(byTime) && byTime) return byTime;
  const leftKey = turnIdentityAliases(left).join("\0") || JSON.stringify(canonicalValue(left));
  const rightKey = turnIdentityAliases(right).join("\0") || JSON.stringify(canonicalValue(right));
  return leftKey.localeCompare(rightKey);
}

function streamHistoryCursor({ workspaceId, streamId, run } = {}) {
  return Buffer.from(JSON.stringify({
    v: STREAM_HISTORY_CURSOR_VERSION,
    workspaceId: String(workspaceId),
    streamId: String(streamId),
    runId: String(run?.id ?? ""),
    provider: String(run?.provider ?? "").trim().toLowerCase(),
    threadId: String(run?.threadId ?? "").trim(),
    turnId: String(run?.turnId ?? "").trim() || null,
  }), "utf8").toString("base64url");
}

function parsedStreamHistoryCursor(value) {
  const source = String(value ?? "").trim();
  if (!source) return null;
  if (source.length > 2_000) throw new Error("invalid Stream history cursor");
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(source, "base64url").toString("utf8"));
  } catch {
    throw new Error("invalid Stream history cursor");
  }
  if (
    parsed?.v !== STREAM_HISTORY_CURSOR_VERSION
    || !String(parsed.workspaceId ?? "").trim()
    || !String(parsed.streamId ?? "").trim()
    || !String(parsed.runId ?? "").trim()
    || !String(parsed.provider ?? "").trim()
    || !String(parsed.threadId ?? "").trim()
  ) throw new Error("invalid Stream history cursor");
  return {
    source,
    workspaceId: String(parsed.workspaceId),
    streamId: String(parsed.streamId),
    runId: String(parsed.runId),
    provider: String(parsed.provider).trim().toLowerCase(),
    threadId: String(parsed.threadId).trim(),
    turnId: String(parsed.turnId ?? "").trim() || null,
  };
}

function boundedActivity(value, maximumDetailLength = 2_000) {
  return {
    id: String(value?.id ?? ""),
    type: String(value?.type ?? "stage"),
    label: compactText(value?.label ?? "Действие", 500),
    detail: compactText(value?.detail ?? "", maximumDetailLength),
    status: String(value?.status ?? "running"),
    time: value?.time ?? null,
  };
}

function boundedActiveTurn(run, { includeBody, maximumActivities }) {
  let remainingActivities = maximumActivities;
  const activityGroups = [];
  for (const group of Array.isArray(run?.activityGroups) ? run.activityGroups : []) {
    if (remainingActivities <= 0) break;
    const activities = (Array.isArray(group?.activities) ? group.activities : [])
      .slice(0, remainingActivities)
      .map((activity) => boundedActivity(activity));
    remainingActivities -= activities.length;
    activityGroups.push({
      id: String(group?.id ?? ""),
      reasoning: compactText(group?.reasoning ?? "", 4_000),
      activities,
    });
  }
  const activities = activityGroups.length
    ? []
    : (Array.isArray(run?.activities) ? run.activities : [])
      .slice(0, maximumActivities)
      .map((activity) => boundedActivity(activity));
  return {
    provider: String(run?.provider ?? "").trim().toLowerCase(),
    threadId: String(run?.threadId ?? "").trim(),
    turnId: String(run?.turnId ?? "").trim() || null,
    runId: String(run?.id ?? ""),
    title: compactText(run?.taskTitle ?? "", 500),
    prompt: compactText(displayUserPrompt(interstreamDisplayText(run?.promptPreview, {
      origin: run?.messageOrigin,
      clientUserMessageId: run?.clientUserMessageId,
    })), 2_000),
    startedAt: run?.startedAt ?? null,
    completedAt: null,
    status: run?.activityUnknown === true ? "unknown" : "active",
    active: run?.activityUnknown !== true,
    activityUnknown: run?.activityUnknown === true,
    canStop: true,
    stage: compactText(run?.progressStage ?? "Выполняется…", 500),
    ...(includeBody ? {
      body: compactText(run?.responseText ?? "", 6_000),
      progress: compactText(run?.progressReasoning ?? "", 4_000),
      activities,
      ...(activityGroups.length ? { activityGroups } : {}),
    } : {}),
  };
}

function boundedCompletedTurn(record, includeBody) {
  return {
    provider: record.provider,
    threadId: record.threadId,
    turnId: record.turnId,
    runId: String(record.runId ?? "").trim() || null,
    title: compactText(record.title, 500),
    prompt: compactText(record.prompt, 2_000),
    ...(includeBody ? { body: compactText(record.body, 6_000) } : {}),
    startedAt: record.startedAt,
    completedAt: record.completedAt,
    status: record.status ?? "completed",
    active: false,
  };
}

function streamHistoryRevision(value) {
  return createHash("sha256")
    .update(JSON.stringify(canonicalValue(value)), "utf8")
    .digest("hex");
}

function compactTask(task) {
  return {
    id: task.id,
    taskNumber: task.taskNumber,
    title: task.title,
    description: task.description,
    text: task.text,
    bucket: task.bucket,
    status: task.status,
    workflowStatus: task.workflowStatus,
    ...(task.blockedBy ? { blockedBy: task.blockedBy } : {}),
    workspaceId: task.workspaceId,
    streamId: task.streamId,
    boardOrder: task.boardOrder,
    source: task.source,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    startedAt: task.startedAt,
    completedAt: task.completedAt,
    revision: task.revision,
    checklist: task.checklist ?? [],
    checklistParent: task.checklistParent ?? null,
    workLog: task.workLog ?? [],
    gitReferences: task.gitReferences ?? [],
    gitAdoptions: task.gitAdoptions ?? [],
    attachments: taskAttachmentDescriptors(task),
  };
}

function withArchiveCleanupInstruction(result) {
  if (["CONFIRMATION_REQUIRED", "COMPLETED"].includes(result?.outcome) && result.result) {
    return { ...result, result: withArchiveCleanupInstruction(result.result) };
  }
  const remaining = result?.archive?.remainingArtifacts ?? result?.preview?.remainingArtifacts;
  return remaining?.length || result?.archiveArtifactsRemain
    ? { ...result, agentInstruction: "УДАЛИ ФАЙЛЫ САМ, ОБЯЗАТЕЛЬНО И ПРЯМО СЕЙЧАС" } : result;
}

function compactCompleteResult(result) {
  if (result?.confirmationRequired) return { ...result, task: compactTask(result.task) };
  return result?.archive ? { ...compactTask(result), archive: result.archive, cleanupToken: result.cleanupToken } : compactTask(result);
}

function completedLifecycleResult(outcome) {
  const { result, evidence } = outcome.result;
  return evidence?.archive && !result.confirmationRequired
    ? { ...result, archive: { remainingArtifacts: evidence.remainingArtifacts }, cleanupToken: evidence.originalArguments.expected_cleanup_token } : result;
}

function cleanupConfirmation(task, action, preview) {
  const token = createHash("sha256").update(JSON.stringify({
    action,
    taskId: task.id,
    revision: task.revision,
    workspaces: (preview.workspaces ?? []).map((item) => ({
      projectRoot: item.projectRoot, branch: item.branch, headCommit: item.headCommit,
      dirty: item.dirty, changedPaths: item.changedPaths, untrackedPaths: item.untrackedPaths,
    })),
    gitReferences: preview.gitReferences ?? [],
    deleting: preview.deleting ?? [],
  })).digest("hex");
  return {
    confirmationRequired: true,
    action,
    cleanupToken: token,
    warning: action === "delete"
      ? "Delete permanently destroys the listed Task Git artifacts, including unpublished work."
      : "Complete closes the Task and removes only exact results already contained in published main.",
    task: compactTask(task),
    preview,
  };
}

function tool(name, description, properties = {}, required = []) {
  const mutating = MUTATING_TOOLS.has(name);
  return {
    name,
    description: mutating && name.startsWith("hub_task_")
      ? `${description}\nMCP returns a durable taskOperation receipt after admission. Read hub_task_operation_get with its original requestId/argumentsHash until terminal; only then use result or claim completion. Never submit a new ID because work is still pending.`
      : description,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        context_token: {
          type: "string",
          description: "Copy the exact non-empty context_token value from the current <agent_hub_context> developer block. It is not an environment variable.",
        },
        ...(mutating ? {
          request_id: {
            type: "string",
            description: "Unique idempotency key for this mutation. Reuse it only to retry the exact same operation.",
          },
        } : {}),
        ...properties,
      },
      required: ["context_token", ...(mutating && name !== "hub_task_operation_reconcile" ? ["request_id"] : []), ...required],
    },
  };
}

export class HubMcpService {
  static nativeTaskStatusVersion = 1;
  #activeRuns = () => [];
  #deferredInputs = () => [];
  #taskLauncher = async () => { throw new Error("Agent Hub task launcher is not ready"); };
  #streamMessenger = async () => { throw new Error("Agent Hub Stream messenger is not ready"); };
  #pendingMutations = new Map();
  #contextCapabilities = new Map();
  #startupReconciliation = Promise.resolve();

  constructor({
    workspaceCatalog, taskBoard, workLog, attachmentDirectory, secret, releasePreflight,
    taskGitWorkspaces = null, taskLifecycle = null,
    taskOperationReconciliation = null, claimCustodyRuntime = null,
    measureOperation = async (_stage, operation) => operation(),
    reconcilePendingOnStartup = true,
    recordCommandTrace = () => {},
  } = {}) {
    for (const name of [
      "resolveThread", "workspace", "hierarchy", "developerRulesForStream",
      "updateWorkspaceDeveloperRules", "updateStreamDeveloperRules",
      "beginMcpOperation", "bindMcpOperationInterstreamContentHash",
      "completeMcpOperation", "failMcpOperation", "mcpOperations",
      "stream", "activeThread", "workspaceEvents",
    ]) requiredMethod(workspaceCatalog, name);
    for (const name of [
      "snapshot", "task", "create", "move", "update", "updateChecklist", "markStarted", "complete", "addAttachment",
      "checklistRequestResult", "claim", "requestWorkflowStatus", "releaseTasks",
      "adoptLegacyGitReference",
    ]) {
      requiredMethod(taskBoard, name);
    }
    requiredMethod(workLog, "threadTurns");
    this.workspaceCatalog = typeof workspaceCatalog.runMutation === "function"
      ? createWorkspaceCatalogMutationOwner(workspaceCatalog)
      : workspaceCatalog;
    this.taskBoard = taskBoard;
    if (typeof measureOperation !== "function") throw new TypeError("MCP operation timing port is required");
    this.measureOperation = measureOperation;
    this.workLog = workLog;
    this.attachmentDirectory = path.resolve(requiredText(attachmentDirectory, "attachment directory", 2_000));
    this.secret = requiredText(secret, "MCP secret", 512);
    this.releasePreflight = releasePreflight;
    this.recordCommandTrace = recordCommandTrace;
    this.taskGitWorkspaces = taskGitWorkspaces;
    this.claimCustodyRuntime = claimCustodyRuntime;
    this.taskLifecycle = taskLifecycle ?? new TaskLifecycleService({
      taskBoard, workspaceCatalog: this.workspaceCatalog, taskGitWorkspaces, releasePreflight,
    });
    this.taskOperationInterruption = typeof this.workspaceCatalog.bindTaskOperationExecution === "function"
      ? new TaskOperationInterruption({ catalog: this.workspaceCatalog, tasks: this.taskBoard,
        taskGit: this.taskGitWorkspaces, runtime: this.claimCustodyRuntime, record: this.recordCommandTrace }) : null;
    this.taskOperationReconciliation = taskOperationReconciliation
      ?? (["mcpOperation", "completeUnknownMcpOperation", "failUnknownMcpOperation"]
        .every((name) => typeof this.workspaceCatalog?.[name] === "function")
        && ["task", "lifecycleTransition", "lifecycleOutcome"]
          .every((name) => typeof taskBoard?.[name] === "function")
        && typeof this.taskLifecycle?.reconcileUnknownWorkflowStatus === "function"
        ? new TaskOperationReconciliationService({
          workspaceCatalog: this.workspaceCatalog,
          taskBoard,
          taskLifecycle: this.taskLifecycle,
          taskExecution: this.taskOperationInterruption,
          record: span => this.recordCommandTrace(span),
        })
        : null);
    this.#startupReconciliation = reconcilePendingOnStartup === false
      ? Promise.resolve({ reconciled: 0, skipped: true })
      : this.reconcilePendingMcpOperations();
  }

  async reconcilePendingMcpOperations() {
    if (typeof this.workspaceCatalog.pendingMcpOperations !== "function") return { reconciled: 0 };
    const lifecycleKinds = new Map([
      ["hub_task_status_update", "workflow"],
      ["hub_task_complete", "complete"],
      ["hub_task_delete", "delete"],
    ]);
    let reconciled = 0;
    for (const receipt of this.workspaceCatalog.pendingMcpOperations()) {
      if (receipt.taskExecution?.cancellation) continue;
      if (this.workspaceCatalog.claimCustodyForOriginal?.(receipt.requestId)) continue;
      await this.workspaceCatalog.beginMcpOperationReconciliation?.(receipt.requestId);
      const claimRefusal = receipt.toolName === "hub_task_claim" ? this.#claimAdmissionRefusal(receipt) : null;
      if (claimRefusal) {
        await this.workspaceCatalog.failMcpOperation(receipt.requestId, claimAdmissionRefusalError(claimRefusal), {
          outcome: "NO_EFFECT", evidence: claimRefusal,
        });
        reconciled += 1;
        continue;
      }
      const expectedKind = lifecycleKinds.get(receipt.toolName);
      const transition = expectedKind ? this.taskBoard.lifecycleTransition?.(receipt.requestId) : null;
      const outcome = expectedKind ? this.taskBoard.lifecycleOutcome?.(receipt.requestId) : null;
      const exactOutcome = outcome?.operationId === receipt.requestId && outcome?.kind === expectedKind;
      if (outcome?.result?.noEffect) {
        const proof = !transition && workflowAdmissionNoEffectEvidence(outcome, receipt);
        if (proof) {
          await this.workspaceCatalog.failMcpOperation(receipt.requestId, new TaskLifecycleNoEffectError(proof), {
            outcome: "NO_EFFECT", evidence: proof,
          });
        } else {
          await this.workspaceCatalog.markMcpOperationUnknown(receipt.requestId, new Error("Workflow refusal identity is not authoritative"));
        }
        reconciled += 1;
        continue;
      }
      if (exactOutcome) {
        if (expectedKind === "workflow" && outcome.result?.rollback?.completed === true) {
          await this.workspaceCatalog.failMcpOperation(
            receipt.requestId,
            new Error(outcome.result.rollback.reason || "Task workflow transition was rolled back"),
          );
          reconciled += 1;
          continue;
        }
        let result;
        if (expectedKind === "workflow") {
          result = {
            ...compactTask(outcome.result?.task),
            ...(outcome.result?.evidence?.response ?? {}),
          };
        } else if (expectedKind === "delete") {
          result = {
            ...outcome.result?.result,
            task: compactTask(outcome.result?.result?.task),
            ...(outcome.result?.evidence ?? {}),
          };
        } else {
          result = compactCompleteResult(completedLifecycleResult(outcome));
        }
        await this.workspaceCatalog.completeMcpOperation(receipt.requestId, result);
        reconciled += 1;
        continue;
      }
      const exactLifecycle = transition?.operationId === receipt.requestId && transition?.kind === expectedKind;
      const exactLaunch = ["hub_task_start", "hub_task_reassign"].includes(receipt.toolName)
        && this.taskBoard.snapshot().some((task) => task.startRequestId === receipt.requestId);
      const reason = exactLifecycle || exactLaunch
        ? "startup found an incomplete durable transition; external replay is forbidden"
        : "startup reconciliation found no exact durable lifecycle outcome";
      await this.workspaceCatalog.markMcpOperationUnknown?.(receipt.requestId, new Error(reason));
      reconciled += 1;
    }
    return { reconciled };
  }

  setActiveRuns(value) {
    if (typeof value !== "function") throw new TypeError("active runs provider is required");
    // Registry retention is not activity: terminal runs can remain present
    // while their final projection is being delivered.
    this.#activeRuns = () => value().filter(taskRunIsActive);
  }

  setDeferredInputs(value) {
    if (typeof value !== "function") throw new TypeError("deferred inputs provider is required");
    this.#deferredInputs = value;
  }

  setTaskLauncher(value) {
    if (typeof value !== "function") throw new TypeError("task launcher is required");
    this.#taskLauncher = value;
  }

  setStreamMessenger(value) {
    if (typeof value !== "function") throw new TypeError("Stream messenger is required");
    this.#streamMessenger = value;

  }

  tools() {
    return [
      tool("hub_context_get", "Return the current Agent Hub Workspace, Stream and Thread context."),
      tool("hub_workspace_get", "Return any existing Workspace and all of its Streams and Threads.", {
        workspace_id: { type: "string", description: "Defaults to the caller Workspace." },
      }),
      tool("hub_parallel_streams_list", "List Streams, live runs and payload-free deferred-input occupancy for any existing Workspace.", {
        workspace_id: { type: "string", description: "Defaults to the caller Workspace." },
      }),
      tool("hub_active_runs_list", "List compact live-run status plus separate payload-free deferred-input diagnostics for any existing Workspace.", {
        workspace_id: { type: "string", description: "Defaults to the caller Workspace." },
      }),
      tool("hub_stream_history", "Read a bounded snapshot of completed and active turns for any Hub Stream. This never long-polls.", {
        workspace_id: { type: "string", description: "Optional consistency check for stream_id; defaults to the Stream Workspace." },
        stream_id: { type: "string", description: "Globally unique target Stream ID. Defaults to the caller Stream." },
        limit: {
          type: "integer", minimum: 1, maximum: 50, default: 20,
          description: "Applied after newest-first merge sorting: completedAt for terminal turns, startedAt for active turns, then exact identity.",
        },
        include_body: { type: "boolean", default: true },
        cursor: { type: "string", description: "Opaque cursor returned by an earlier active snapshot, used to report replaced or terminal state." },
        max_activity_items: { type: "integer", minimum: 1, maximum: 100, default: 40 },
      }),
      tool("hub_stream_message_send", "Send a visible message from the caller Stream to any existing target Stream through the normal Hub admission queue.", {
        stream_id: { type: "string", description: "Globally unique target Stream ID." },
        text: { type: "string" },
        mode: {
          type: "string",
          enum: ["queue", "steer"],
          default: "queue",
          description: "Queue explicitly after the active turn, or deliver an ordinary steer to the Stream's current managed turn; if none is available, retain the same message in its normal queue. A definitively ended target is re-resolved automatically; unknown provider acceptance is reconciled before another attempt.",
        },
        confirm_send: { type: "boolean", description: "Legacy confirmation field." },
      }, ["stream_id", "text"]),
      tool("hub_rules_get", "Read effective Workspace and Stream developer rules for any Stream.", {
        stream_id: { type: "string", description: "Defaults to the caller Stream." },
      }),
      tool("hub_workspace_rules_update", "Replace developer rules for any existing Workspace.", {
        workspace_id: { type: "string", description: "Defaults to the caller Workspace." },
        content: { type: "string" },
      }, ["content"]),
      tool("hub_stream_rules_update", "Replace developer rules for any existing Stream.", {
        stream_id: { type: "string", description: "Defaults to the caller Stream." },
        content: { type: "string" },
      }, ["content"]),
      tool("hub_tasks_list", "List Dashboard tasks across all Workspaces and Backlog.", {
        include_completed: { type: "boolean", default: false },
        limit: { type: "integer", minimum: 1, maximum: 100, default: 50 },
      }),
      tool("hub_task_get", "Read one Dashboard task by id, including a Task attached from Backlog or another Workspace.", {
        task_id: { type: "string" },
      }, ["task_id"]),
      tool("hub_task_create", "Create a Dashboard task in any existing Workspace with workflow status New and without automatic triage.", {
        workspace_id: { type: "string", description: "Defaults to the caller Workspace." },
        title: { type: "string", maxLength: TASK_TITLE_MAX_LENGTH },
        description: {
          type: "string", default: "",
        },
      }, ["title"]),
      tool("hub_task_update", "Update the number, title or description of any Dashboard task by id.", {
        task_id: { type: "string" },
        task_number: { type: "string" },
        title: { type: "string", maxLength: TASK_TITLE_MAX_LENGTH },
        description: { type: "string" },
      }, ["task_id"]),
      tool("hub_task_checklist_update", "Atomically change one checklist item with Task revision CAS. Extract creates an unassigned New Task in the same Workspace.", {
        task_id: { type: "string" },
        expected_task_revision: { type: "integer", minimum: 1 },
        operation: {
          type: "string",
          enum: ["add", "edit", "remove", "toggle", "move", "link", "unlink", "extract"],
        },
        item_id: { type: "string" },
        text: { type: "string" },
        completed: { type: "boolean" },
        before_item_id: { type: "string" },
        linked_task_id: { type: "string" },
        release_reference: { type: "object", description: "Membership reference; preserves decomposition ownership.",
          additionalProperties: false, required: ["taskRevision"],
          oneOf: [{ required: ["gitReferences"] }, { required: ["manualDelivery"] }], properties: {
            taskRevision: { type: "integer", minimum: 1 },
            manualDelivery: { type: "object", additionalProperties: false, required: ["requestId", "argumentsHash"], properties: {
              requestId: { type: "string", minLength: 1, maxLength: 200 }, argumentsHash: { type: "string", pattern: "^[a-f0-9]{64}$" },
            } },
            gitReferences: { type: "array", minItems: 1, items: { type: "object", additionalProperties: false,
              required: ["projectRoot", "branch", "resultCommit"], properties: {
                projectRoot: { type: "string" }, branch: { type: "string" }, resultCommit: { type: "string" },
              } } },
          } },
      }, ["task_id", "expected_task_revision", "operation"]),
      tool("hub_task_move", "Move or reorder any Dashboard task, optionally into any existing Workspace.", {
        task_id: { type: "string" },
        destination: { type: "string", enum: ["workspace", "backlog", "notes"] },
        workspace_id: { type: "string", description: "Destination Workspace when destination=workspace; defaults to the caller Workspace." },
        before_task_id: { type: "string" },
      }, ["task_id", "destination"]),
      tool("hub_task_start", "Send a Dashboard task into an existing or new Stream through the normal Hub queue, then mark it started.", {
        task_id: { type: "string" },
        workspace_id: { type: "string", description: "Workspace for new_stream_name, or consistency check for stream_id." },
        stream_id: { type: "string", description: "Globally unique existing Stream ID. Defaults to the caller Stream." },
        new_stream_name: { type: "string", description: "Create a new Stream instead of using stream_id." },
        provider: { type: "string", enum: ["codex", "claude"] },
        message: { type: "string", description: "Optional assignment message delivered together with the Task reference." },
        confirm_launch: { type: "boolean", description: "Legacy confirmation field." },
      }, ["task_id"]),
      tool("hub_task_reassign", "Reassign a started Dashboard task to an existing or new Stream. The current executor must have no active turn or queued input.", {
        task_id: { type: "string" },
        workspace_id: { type: "string", description: "Workspace for new_stream_name, or consistency check for stream_id." },
        stream_id: { type: "string", description: "Globally unique existing target Stream ID." },
        new_stream_name: { type: "string", description: "Create a new target Stream instead of using stream_id." },
        provider: { type: "string", enum: ["codex", "claude"] },
        message: { type: "string", description: "Optional assignment message delivered together with the Task reference." },
        confirm_launch: { type: "boolean", description: "Legacy confirmation field." },
      }, ["task_id"]),
      tool("hub_task_launch_cancel", "Cancel an exact unlaunched new-Stream Task start before another assignment.", {
        task_id: { type: "string" },
        launch_request_id: { type: "string", description: "Original hub_task_start request_id retained by the prepared Task." },
        expected_task_revision: { type: "integer", minimum: 1 },
        confirm_cancel: { type: "boolean", description: "Legacy confirmation field." },
      }, ["task_id", "launch_request_id", "expected_task_revision"]),
      tool("hub_task_claim", "Bind a Dashboard Task to the exact current provider turn, assign its dedicated Git branch/worktree, and make the current Stream its executor. Continue repository work only in the returned gitWorkspace.projectRoot.", {
        task_id: { type: "string" },
        dependency_mode: { type: "string", enum: ["skip", "ensure", "verify"], description: "Default skip: prepare only Git. Before running dependency-dependent tests/builds use ensure; use verify for suspected dependency damage. Existing matching dependencies are reused." },
        forward_custody_request_id: { type: "string", description: "Exact durable forward fence; uses preserved workspace without prepare/dependency replay. Historical original stays UNKNOWN." },
        dependency_override_reason: { type: "string", maxLength: 2000, description: "Only for an explicit user instruction to bypass a prerequisite release wait, e.g. Task consolidation. Persist that instruction here; ordinary start is not an override." },
      }, ["task_id"]),
      tool("hub_task_status_update", "Change workflow status only after exact Git result evidence is integrated. Test/Await/Done fail closed when no result or integration fails. Await also composes the accepted result into PreRelease before it commits: a composition conflict leaves the Task in Test with the last good candidate.", {
        task_id: { type: "string" },
        manual_delivery: { type: "object", additionalProperties: false, required: ["revision", "releaseId", "manifestSha256"], description: "Actual manual-delivery proof for Done with exact Task/status CAS; does not create a Test reference.", properties: {
          revision: { type: "string", pattern: "^[a-f0-9]{40}$" }, releaseId: { type: "string" }, manifestSha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
        } },
        status: { type: "string", enum: ["new", "in_progress", "blocked", "testing", "awaiting_implementation", "done"] },
        expected_task_revision: { type: "integer", minimum: 1, description: "Optional exact current Task revision CAS." },
        expected_workflow_status: { type: "string", enum: ["new", "in_progress", "blocked", "testing", "awaiting_implementation", "done"], description: "Optional exact current workflow status CAS." },
        cutover_source_commit: { type: "string", description: "Optional clean checkout commit recorded by a local cutover." },
        cutover_projector_sha256: { type: "string", description: "Optional verified release-projector hash recorded by a local cutover." },
        squash_source_task_id: { type: "string", description: "Source Task whose exact result is transferred into this survivor." },
        squash_source_task_revision: { type: "integer", minimum: 1 },
        squash_baseline_result_commit: { type: "string", pattern: "^[0-9a-f]{40}$" },
        squash_new_result_commit: { type: "string", pattern: "^[0-9a-f]{40}$" },
        squash_dev_after_tree: { type: "string", pattern: "^[0-9a-f]{40}$" },
        squash_proof_request_id: { type: "string", description: "On confirmation, the exact request_id of the read-only squash preview." },
        expected_squash_transfer_hash: { type: "string", pattern: "^[0-9a-f]{64}$", description: "Omit for an exact preview; confirm a later request with the returned hash." },
        selected_proof_bundle_path: { type: "string", description: "Immutable selected-composition proof bundle; preview has no live Git or lifecycle effect." },
        selected_proof_bundle_sha256: { type: "string", pattern: "^[0-9a-f]{64}$" },
        selected_published_resolution: { type: "object", description: "Historical original reconciliation envelope; new selected materialization admission is closed." },
        selected_absorption_handoff: { type: "object", description: "Authenticated saved/stopped handoff for ordinary native Test, bound to exact Task CAS and the original receipt." },
        selected_proof_commit: { type: "string", pattern: "^[0-9a-f]{40}$" },
        selected_preview_request_id: { type: "string", description: "Exact original preview request_id on confirmation." },
        expected_selected_preview_hash: { type: "string", pattern: "^[0-9a-f]{64}$", description: "Omit for preview; exact returned hash is required for confirmation." },
      }, ["task_id", "status"]),
      tool("hub_task_operation_get", "Read the exact original Task operation and its durable terminal result without replay. Pending with active=true is accepted live work, not UNKNOWN. Keep the original request ID; verify expected_arguments_hash or original_arguments after a lost reply.", {
        operation_request_id: { type: "string" },
        expected_arguments_hash: { type: "string" },
        original_arguments: { type: "object", additionalProperties: true },
        task_id: { type: "string" },
        archive_preview_page: { type: "object", additionalProperties: false,
          required: ["cleanupToken", "previewSha256", "offset"], properties: {
            cleanupToken: { type: "string", pattern: "^[a-f0-9]{64}$" },
            previewSha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
            offset: { type: "integer", minimum: 0 },
          }, description: "Read one bounded page of an omitted archive preview. Include the exact operation arguments hash and Task id." },
      }, ["operation_request_id"]),
      tool("hub_task_operation_cancel", "Stop one exact claim/Test/Await worker, preserving its original receipt and prior unknown effects. Historical workers require verified retirement; a requested cancellation is not yet stopped.", {
        task_id: { type: "string" }, operation_request_id: { type: "string" },
        request_id: { type: "string" }, expected_arguments_hash: { type: "string" },
        expected_task_revision: { type: "integer" }, confirm_cancel: { type: "boolean" },
        original_arguments: { type: "object", description: "Exact original argument family for a legacy receipt without execution binding; never context_token." },
        runtime_witness: { type: "object", description: "Existing trusted retained native runtime witness for a historical worker." },
      }, ["task_id", "operation_request_id", "request_id", "expected_arguments_hash", "expected_task_revision"]),
      tool("hub_task_operation_reconcile", "Reconcile an original Task operation by its request ID. Hub reads the original receipt and its durable evidence, including any existing cancellation. Supply historical evidence only when it cannot be recovered from Hub records.", {
        task_id: { type: "string" },
        manual_preview_arguments: { type: "object", description: "Exact original business arguments for a read-only manual Complete preview; hash-bound classification, never a confirmed closure." },
        operation_request_id: { type: "string" },
        expected_arguments_hash: { type: "string", pattern: "^[a-f0-9]{64}$", description: "Optional legacy pin for the exact original arguments hash." },
        runtime_witness: { type: "object", description: "Existing trusted exact native retirement witness for a malformed original owned by a previous runtime." },
        claim_custody: { type: "object", description: "Explicit forward ownership recovery. The default requires proof of legacy retirement. Isolated-source-v1 stages an independent full-object source/ref authority and fences legacy SQL writers. Two distinct exact request IDs.",
          properties: { action: { type: "string", enum: ["prepare", "fence"] },
            admission: { type: "string", enum: ["isolated-source-v1"] },
            authorization_id: { type: "string" }, handoff_id: { type: "string" },
            expected_original: { type: "object" }, original_arguments: { type: "object" },
            expected_task_revision: { type: "integer", minimum: 1 }, expected_owner_stream_id: { type: ["string", "null"] },
            successor_claim_request_id: { type: "string" }, source: { type: "object" }, runtime_witness: { type: "object", description: "Exact independently retained read-only native witness artifact: sourcePath/rawSha256. No caller-supplied retirement boolean." },
            plan_request_id: { type: "string" }, expected_plan_hash: { type: "string", pattern: "^[a-f0-9]{64}$" } },
          required: ["action"], additionalProperties: false },
        project_root: { type: "string", description: "Optional legacy locator. Must match the original repository evidence when supplied." },
        guard_id: { type: "string", description: "Required for an actually guarded pending operation. Exact persisted Task withdrawal or squash state without a process guard can reconcile without it." },
        proof_kind: { type: "string", enum: ["system-restart-after-guard"], description: "For a historical process-tree guard without Windows Job proof." },
        proof_summary: { type: "string", description: "For a historical process-tree guard without Windows Job proof." },
        expected_task_revision: { type: "integer", minimum: 1, description: "Supply exactly when the original workflow request used this CAS field; required for cutover receipts." },
        expected_workflow_status: { type: "string", enum: ["new", "in_progress", "blocked", "testing", "awaiting_implementation", "done"], description: "Supply exactly when the original workflow request used this CAS field; required for cutover receipts." },
        cutover_source_commit: { type: "string", description: "Required only to reproduce an original local cutover receipt." },
        cutover_projector_sha256: { type: "string", description: "Required only to reproduce an original local cutover receipt." },
        cutover_source_task_id: { type: "string", description: "Required only when the original local cutover used a separate source Task." },
        cutover_source_task_revision: { type: "integer", minimum: 1, description: "Required only when the original local cutover used a separate source Task." },
        initial_native_test: { type: "object", description: "Complete original local initial native Test identity, for terminal reconciliation only. Pending source recovery uses the existing local cutover entry." },
        native_resolution_review: { type: "object", description: "Supply exactly the reviewed resolution argument of the original status request." },
        squash_source_task_id: { type: "string" },
        squash_source_task_revision: { type: "integer", minimum: 1 },
        squash_baseline_result_commit: { type: "string", pattern: "^[0-9a-f]{40}$" },
        squash_new_result_commit: { type: "string", pattern: "^[0-9a-f]{40}$" },
        squash_dev_after_tree: { type: "string", pattern: "^[0-9a-f]{40}$" },
        squash_proof_request_id: { type: "string" },
        expected_squash_transfer_hash: { type: "string", pattern: "^[0-9a-f]{64}$" },
        squash_cutover_source_tree: { type: "string", pattern: "^[0-9a-f]{40}$" },
        squash_cutover_expected_main_commit: { type: "string", pattern: "^[0-9a-f]{40}$" },
        squash_cutover_expected_dev_commit: { type: "string", pattern: "^[0-9a-f]{40}$" },
        squash_cutover_expected_preserved_tree: { type: "string", pattern: "^[0-9a-f]{40}$" },
        squash_cutover_source_zip_sha256: { type: "string", pattern: "^[0-9a-f]{64}$" },
        squash_cutover_bundle_sha256: { type: "string", pattern: "^[0-9a-f]{64}$" },
        squash_cutover_manifest_sha256: { type: "string", pattern: "^[0-9a-f]{64}$" },
        squash_cutover_files_sha256: { type: "string", pattern: "^[0-9a-f]{64}$" },
        expected_squash_cutover_hash: { type: "string", pattern: "^[0-9a-f]{64}$" },
        selected_proof_bundle_path: { type: "string" },
        selected_proof_bundle_sha256: { type: "string", pattern: "^[0-9a-f]{64}$" },
        selected_published_resolution: { type: "object", description: "Historical original reconciliation envelope; new selected materialization admission is closed." },
        selected_absorption_handoff: { type: "object", description: "Exact original saved/stopped handoff for native or admitted historical Test reconciliation." },
        selected_proof_commit: { type: "string", pattern: "^[0-9a-f]{40}$" },
        selected_preview_request_id: { type: "string" },
        expected_selected_preview_hash: { type: "string", pattern: "^[0-9a-f]{64}$" },
        confirm_reconcile: { type: "boolean", description: "Legacy confirmation field. Calling this command already requests reconciliation." },
        cleanup_preview_request_id: { type: "string", description: "Exact successful original Delete preview for an already admitted cleanup continuation." },
        cleanup_preserved_files: { type: "array", items: { type: "object", properties: {
          projectRoot: { type: "string" }, relativePath: { type: "string" }, retainedPath: { type: "string" }, sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
        }, required: ["projectRoot", "relativePath", "retainedPath", "sha256"], additionalProperties: false } },
      }, ["operation_request_id"]),
      tool("hub_task_legacy_git_adopt", "Adopt Git evidence for a legacy Await Task after verifying terminal Stream evidence and exact non-changelog patch equivalence to a named commit already in local main.", {
        task_id: { type: "string" },
        expected_task_revision: { type: "integer", minimum: 1 },
        evidence_turn_id: { type: "string" },
        reported_result_commit: { type: "string" },
        main_result_commit: { type: "string" },
        confirm_adoption: { type: "boolean", description: "Legacy confirmation field." },
      }, ["task_id", "expected_task_revision", "evidence_turn_id", "reported_result_commit", "main_result_commit"]),
      tool("hub_task_complete", "Preview, then confirm closing a Task. Use absorbed_into_task_id after agent-led consolidation. Published duplicate and release service closure verify durable publication evidence.", {
        task_id: { type: "string" },
        confirm_cleanup: { type: "boolean", description: "Optional legacy selector. Supplying the preview token selects confirmation." },
        expected_cleanup_token: { type: "string" },
        absorbed_into_task_id: { type: "string", description: "Surviving tested Task that contains the source work. The source must already be returned from Test/Await." },
        absorption_mode: { type: "string", enum: ["published_duplicate"], description: "An open zero-own-delta source whose survivor is already Done and exactly published." },
        completion_mode: { type: "string", enum: ["published_release_service", "published_delivery", "operational", "manual_delivery", "archive", "abandoned_release_service"], description: "Archive retains history and workflow status. Manual delivery verifies actual delivery. Abandoned release service preserves exact failed release history." },
        retain_artifacts: { type: "boolean", description: "For archive only. On confirmation use the exact retainArtifacts value returned in its preview." },
        abandoned_release: { type: "object", properties: {
          operationId: { type: "string" }, expectedRevision: { type: "integer", minimum: 1 }, expectedGeneration: { type: "integer", minimum: 1 },
        }, required: ["operationId", "expectedRevision", "expectedGeneration"], additionalProperties: false },
        retained_repositories: { type: "array", description: "Manual mode only: exact managed worktree/head pins for historical repositories no longer represented by the canonical Task result. Retained, not certified delivered or deleted.", items: { type: "object", additionalProperties: false, required: ["project_root", "head_commit"], properties: {
          project_root: { type: "string" }, head_commit: { type: "string", pattern: "^[a-f0-9]{40}$" },
        } } },
        manual_delivery: MANUAL_DELIVERY_SCHEMA,
        completed_operation_request_id: { type: "string", description: "Original canonical closure for historical cleanup: published-service proof in operational mode, or exact original manually delivered source in manual_delivery mode. The old closure is not replayed." },
        published_delivery: { type: "object", properties: {
          runtimeRoot: { type: "string" }, publicationRunSha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
          publicationJournalPath: { type: "string", description: "Explicit retained original journal; its raw hash and original runtime identity remain required." },
          preparedSha256: { type: "string", pattern: "^[a-f0-9]{64}$" }, sourceBaseCommit: { type: "string", pattern: "^[a-f0-9]{40}$" },
          sourceCommit: { type: "string", pattern: "^[a-f0-9]{40}$" }, publicationBaseCommit: { type: "string", pattern: "^[a-f0-9]{40}$" },
        }, required: ["runtimeRoot", "publicationRunSha256", "preparedSha256", "sourceBaseCommit", "sourceCommit", "publicationBaseCommit"], additionalProperties: false },
      }, ["task_id"]),
      tool(TASK_COMPLETE_BATCH, "Archive the listed Tasks in one operation, preserving their history and local Git artifacts. Returns each Task's outcome and child receipt. Optional manual_delivery uses the existing verified Done transition before archive.", {
        task_ids: { type: "array", minItems: 1, maxItems: MAX_BATCH_COMPLETIONS, items: { type: "string" },
          description: "Task IDs in processing order. Each unique ID is processed once." },
        manual_delivery: MANUAL_DELIVERY_SCHEMA,
      }, ["task_ids"]),
      tool("hub_task_delete", "Preview, then explicitly confirm permanent destructive deletion of a Task and its managed Git artifacts.", {
        task_id: { type: "string" },
        confirm_cleanup: { type: "boolean", description: "Optional legacy selector. Supplying the preview token selects confirmation." },
        expected_cleanup_token: { type: "string" },
      }, ["task_id"]),
      tool("hub_task_attachment_read", "Read metadata and bounded text for one attachment of a Dashboard task referenced by id.", {
        task_id: { type: "string" },
        attachment_id: { type: "string" },
        max_text_bytes: { type: "integer", minimum: 1, maximum: 131072, default: 65536 },
      }, ["task_id", "attachment_id"]),
      tool("hub_task_attachment_add", "Copy a local project file into any Dashboard task by id.", {
        task_id: { type: "string" },
        local_path: { type: "string" },
      }, ["task_id", "local_path"]),
      tool("hub_events_list", "Read bounded persistent Workspace events after a cursor; this never holds a long poll.", {
        workspace_id: { type: "string", description: "Defaults to the caller Workspace." },
        after_sequence: { type: "integer", minimum: 0, default: 0 },
        limit: { type: "integer", minimum: 1, maximum: 100, default: 50 },
      }),
      tool("hub_mcp_operations_list", "List recent audited MCP mutations for any existing Workspace.", {
        workspace_id: { type: "string", description: "Defaults to the caller Workspace." },
        limit: { type: "integer", minimum: 1, maximum: 100, default: 50 },
      }),
    ];
  }

  contextToken({ provider, threadId = null, streamId = null } = {}) {
    const normalizedThreadId = String(threadId ?? "").trim();
    const normalizedStreamId = String(streamId ?? "").trim();
    if (!normalizedThreadId && !normalizedStreamId) throw new Error("Thread or Stream context is required");
    const identity = {
      v: CONTEXT_TOKEN_VERSION,
      provider: requiredText(provider, "provider", 100),
      ...(normalizedThreadId ? { threadId: requiredText(normalizedThreadId, "thread id", 300) } : {}),
      ...(normalizedStreamId ? { streamId: requiredText(normalizedStreamId, "stream id", 300) } : {}),
    };
    const payload = Buffer.from(JSON.stringify(identity), "utf8").toString("base64url");
    const signature = this.#signature(payload);
    this.#rememberContextCapability(signature, identity);
    return `${payload}.${signature}`;
  }

  developerContext({ provider, threadId = null, streamId = null } = {}) {
    const resolved = this.#resolveContext({ provider, threadId, streamId });
    if (!resolved) return "";
    const capability = this.contextToken({ provider, threadId, streamId: resolved.streamId });
    return [
      "<agent_hub_context>",
      `MCP server: agent_hub`,
      `Workspace: ${resolved.workspaceName} (${resolved.workspaceId})`,
      `Stream: ${resolved.streamDisplayName} (${resolved.streamId})`,
      `Provider Thread: ${threadId ? `${provider}/${threadId}` : "pending first Thread"}`,
      `Required MCP arguments: ${JSON.stringify({ context_token: capability })}`,
      "Copy that exact context_token into every agent_hub MCP call. Do not search environment variables and never pass an empty value.",
      "The token identifies the caller for authorization and audit. Standard tools may target any existing Workspace or Stream by explicit ID.",
      "</agent_hub_context>",
    ].join("\n");
  }

  async runDesktopTaskOperation(task, operationId, status, operation, { receiptOnly = false, toolName = "hub_task_status_update", parameters = {} } = {}) {
    // The trusted desktop is a user actor, never an impersonated provider turn.
    if (!this.taskOperationInterruption) return operation();
    const context = { workspaceId: task.workspaceId, streamId: null,
      provider: null, auditThreadId: null, actorKind: "authenticated-user" };
    const args = { request_id: operationId, ...(task.id ? { task_id: task.id } : {}),
      ...(status ? { status } : {}), ...parameters };
    return receiptOnly
      ? this.#submitTaskOperation(context, toolName, args,
        onAdmission => this.#mutate(context, toolName, args, operation, { onAdmission }))
      : this.#mutate(context, toolName, args, operation);
  }

  taskOperationCanSubmit(name) {
    return String(name).startsWith("hub_task_") && MUTATING_TOOLS.has(name);
  }

  #taskOperationReadback(_actor, { operation_request_id: operationId, expected_arguments_hash: expectedHash,
    original_arguments: originalArguments, task_id: taskId } = {}) {
    const id = requiredText(operationId, "original operation id", 200);
    const row = this.workspaceCatalog.mcpOperation(id);
    if (!row) {
      // A fresh authenticated point-read is not historical admission/effect
      // authority. Never fabricate FAILED, UNKNOWN, NO_EFFECT or replay rights.
      if (originalArguments != null && originalArguments.request_id !== id) {
        throw new Error("Task operation original arguments differ");
      }
      return { taskOperation: null, result: null,
        lookup: { version: 1, requestId: id, status: "not_found", canonicalOutcome: null } };
    }
    if (!this.taskOperationCanSubmit(row.toolName)) throw new Error("Original receipt is not a Task operation");
    if ((expectedHash != null && expectedHash !== row.argumentsHash)
      || (originalArguments != null && (originalArguments.request_id !== id || argumentsHash(originalArguments) !== row.argumentsHash))) {
      throw new Error("Task operation original arguments differ");
    }
    const boundTask = row.taskExecution?.taskId ?? row.result?.task?.id ?? row.result?.id;
    if (taskId != null && boundTask !== taskId) throw new Error("Task operation Task identity differs");
    const cancellation = row.taskExecution?.cancellation;
    const lifecycle = this.taskBoard.lifecycleTransition?.(id);
    const active = this.#pendingMutations.has(id);
    const terminal = ["succeeded", "failed"].includes(row.status);
    const execution = { state: terminal ? "terminal" : active ? "active" : row.status === "unknown" ? "unknown" : "unresolved",
      authority: active ? "local-invocation" : terminal || row.status === "unknown" ? "durable-receipt" : "not-observed-here" };
    const progress = this.taskGitWorkspaces?.readOperationProgress?.({ operationId: id, taskId: boundTask }) ?? null;
    return { taskOperation: {
      version: 1, requestId: id, toolName: row.toolName, argumentsHash: row.argumentsHash,
      workspaceId: row.workspaceId, streamId: row.streamId, provider: row.provider, threadId: row.threadId,
      ...(row.actorKind ? { actorKind: row.actorKind } : {}),
      taskId: boundTask ?? null, status: row.status, terminal, active, execution,
      ...(progress ? { progress } : {}),
      ...(row.taskExecution?.completionFailure ? { completionFailure: row.taskExecution.completionFailure } : {}),
      canCancel: INTERRUPTIBLE_TASK_TOOLS.has(row.toolName) && !terminal && cancellation?.phase !== "stopped",
      phase: cancellation?.phase ?? lifecycle?.phase ?? (terminal ? row.status : active ? "executing" : "not-observed-here"),
      createdAtMs: row.createdAtMs, completedAtMs: row.completedAtMs,
      elapsedMs: Math.max(0, (row.completedAtMs ?? Date.now()) - row.createdAtMs), error: row.error,
      ...(cancellation ? { cancellation: { phase: cancellation.phase, effects: cancellation.effects } } : {}),
    }, result: row.status === "succeeded" ? row.result : null };
  }

  #archivePreviewPage(actor, identity, { cleanupToken, previewSha256, offset } = {}) {
    const { taskOperation: operation, result } = this.#taskOperationReadback(actor, identity);
    const capsule = result?.archivePreview ? result : cleanupConfirmationCapsule(result) ?? archivedArtifactCapsule(result);
    if (operation?.toolName !== "hub_task_complete" || identity.task_id !== operation.taskId || !identity.expected_arguments_hash
        || operation.status !== "succeeded" || !capsule?.archivePreview
        || capsule.cleanupToken !== cleanupToken || capsule.previewIdentity?.sha256 !== previewSha256
        || !Number.isSafeInteger(offset) || offset < 0) throw new Error("Archive preview reference differs");
    const outcome = this.taskBoard.lifecycleOutcome(operation.requestId);
    const original = outcome?.result?.evidence?.originalArguments;
    if (outcome?.taskId !== operation.taskId || outcome.kind !== "complete" || !outcome.result.evidence.archive
        || !original || argumentsHash(original) !== operation.argumentsHash) throw new Error("Original archive preview unavailable");
    const originalResult = completedLifecycleResult(outcome);
    const preview = originalResult.confirmationRequired ? originalResult.preview : archivedArtifactPreview(originalResult);
    if (originalResult.cleanupToken !== cleanupToken || !preview?.archive) throw new Error("Original archive preview unavailable");
    const raw = JSON.stringify(preview);
    const sha256 = createHash("sha256").update(raw).digest("hex");
    if (sha256 !== previewSha256 || Buffer.byteLength(raw) !== capsule.previewIdentity.bytes || offset >= raw.length) {
      throw new Error("Archive preview content differs");
    }
    const chunk = raw.slice(offset, offset + 8192);
    return { offset, chunk, nextOffset: offset + chunk.length < raw.length ? offset + chunk.length : null };
  }

  readDesktopArchivePreviewPage(task, operationId, expectedHash, page) {
    return this.#archivePreviewPage({ actorKind: "authenticated-user" }, {
      operation_request_id: operationId, expected_arguments_hash: expectedHash, task_id: task.id,
    }, page);
  }

  readDesktopTaskOperation(task, operationId, expectedHash) {
    return this.#taskOperationReadback({ actorKind: "authenticated-user" }, {
      operation_request_id: operationId, expected_arguments_hash: expectedHash, task_id: task.id,
    });
  }

  listTaskOperations(taskId) {
    return (this.taskOperationInterruption?.list(taskId) ?? []).map(operation => {
      const progress = this.taskGitWorkspaces?.readOperationProgress?.({ operationId: operation.requestId, taskId }) ?? null;
      return progress ? { ...operation, progress } : operation;
    });
  }

  #reconciliationContinuation(toolName, args, receipt) {
    return toolName === "hub_task_operation_reconcile" && receipt?.status === "unknown"
      && args.request_id !== args.operation_request_id;
  }

  async #submitTaskOperation(context, toolName, args, invoke) {
    const requestId = requiredText(args.request_id, "request id", 200);
    const existing = this.workspaceCatalog.mcpOperation(requestId);
    let recoveringCleanup = false;
    if (existing) {
      if (existing.workspaceId !== context.workspaceId || existing.streamId !== context.streamId
        || existing.provider !== context.provider || existing.threadId !== context.auditThreadId
        || (existing.actorKind ?? "provider") !== (context.actorKind ?? "provider")
        || existing.toolName !== toolName || existing.argumentsHash !== argumentsHash(args)) {
        throw new Error("MCP request_id was already used for another operation");
      }
      // Only the existing addressed owners can continue their exact UNKNOWN.
      // A fenced claim still passes the genuine run, lease and SQL guards.
      const custodyContinuation = toolName === "hub_task_claim" && Boolean(args.forward_custody_request_id)
        && existing.status === "unknown" && !this.#pendingMutations.has(requestId);
      if (custodyContinuation) this.#claimCustodySuccessor(context, args);
      // Keep cleanup recovery and the addressed reconciliation/interruption owners.
      const cleanupRecovery = !this.#pendingMutations.has(requestId)
        && ((existing.status === "succeeded" && cleanupConfirmationOriginal(existing, false)
          && existing.result?.receiptCompacted === true && !existing.result.cleanupToken)
          || (existing.status === "unknown" && cleanupConfirmationOriginal(existing, true)));
      recoveringCleanup = Boolean(cleanupRecovery);
      const continuation = toolName === "hub_task_operation_cancel" && this.taskOperationInterruption
        || toolName === TASK_COMPLETE_BATCH
        || this.#reconciliationContinuation(toolName, args, existing) || custodyContinuation;
      if (!cleanupRecovery && (!continuation || existing.status !== "unknown" || this.#pendingMutations.has(requestId))) {
        return this.#taskOperationReadback(context, { operation_request_id: requestId, expected_arguments_hash: argumentsHash(args) });
      }
    }
    let admitted;
    const admission = new Promise(resolve => { admitted = resolve; });
    const startedAt = performance.now();
    const record = (stage, receipt) => {
      try { this.recordCommandTrace({ commandId: requestId, transport: "task-operation", stage,
        outcome: receipt.taskOperation.terminal ? receipt.taskOperation.status : receipt.taskOperation.execution.state,
        monotonicDurationMs: performance.now() - startedAt,
        metadata: { toolName, phase: receipt.taskOperation.phase, active: receipt.taskOperation.active } }); }
      catch { /* Diagnostics never change the original operation or its reply. */ }
      return receipt;
    };
    const read = () => this.#taskOperationReadback(context, {
      operation_request_id: requestId, expected_arguments_hash: argumentsHash(args),
    });
    const onAdmission = () => admitted(record("task-operation-admitted", read()));
    // The same #mutate Promise owns all work and persistence. Detaching the
    // transport waiter neither starts another worker nor replays an existing ID.
    const completion = invoke(onAdmission).then(() => record("task-operation-result", read()), error => {
      if (recoveringCleanup && JSON.stringify(this.workspaceCatalog.mcpOperation(requestId)) === JSON.stringify(existing)) throw error;
      // The durable receipt, including a real UNKNOWN or cancellation, is the
      // result. A pre-admission failure has no receipt and still rejects.
      if (!this.workspaceCatalog.mcpOperation(requestId)) {
        const identity = error instanceof McpAdmissionContentionError ? error.admissionIdentity : null;
        if (!identity || identity.requestId !== requestId || identity.toolName !== toolName
            || identity.argumentsHash !== argumentsHash(args) || identity.workspaceId !== context.workspaceId
            || identity.streamId !== context.streamId || identity.provider !== context.provider
            || identity.threadId !== context.auditThreadId
            || identity.actorKind !== (context.actorKind ?? "provider")) throw error;
        // Only this invocation's actual failed BEGIN is classified. Other
        // queued submissions of this ID and all historical effects stay unknown.
        const response = { taskOperation: null, result: null, admission: { version: 1,
          ...identity, status: "not_admitted", scope: "this_invocation",
          reason: "sqlite_begin_contention", canonicalOutcome: null } };
        try { this.recordCommandTrace({ commandId: requestId, transport: "task-operation",
          stage: "task-operation-not-admitted", outcome: "rejected",
          monotonicDurationMs: performance.now() - startedAt,
          metadata: { toolName, reason: "sqlite_begin_contention" } }); }
        catch { /* Diagnostics never change the response. */ }
        return response;
      }
      return record("task-operation-result", read());
    });
    return Promise.race([admission, completion]);
  }

  #recordFailureTiming(requestId, stage, startedAt, outcome, error = null, metadata = {}) {
    try {
      const durationMs = Math.max(0, performance.now() - startedAt);
      const identity = error ? completionError(error) : null;
      const pending = this.recordCommandTrace({ commandId: requestId, transport: "task-operation", stage,
        outcome, monotonicDurationMs: durationMs, metadata: { ...metadata,
          ...(identity ? { errorCode: identity.code,
            errorSha256: createHash("sha256").update(JSON.stringify(identity)).digest("hex") } : {}) } });
      pending?.catch?.(() => {});
    } catch { /* Failure-path measurements cannot replace the original errors or receipt. */ }
  }

  async #preserveCompletionFailure(started, ownerId, failure) {
    let saved = false;
    const diagnostic = { version: 1, kind: "mcp-completion-failure-v1", effects: "retained_unknown",
      originalError: completionError(failure.originalError), persistenceError: completionError(failure.persistenceError),
      effectCompleted: failure.effectCompleted === true };
    const diagnosticStartedAt = performance.now();
    let diagnosticOutcome = "unavailable", diagnosticError = null;
    try {
      if (typeof this.workspaceCatalog.recordMcpOperationCompletionFailure === "function") {
        diagnosticOutcome = "failed";
        const receipt = await this.workspaceCatalog.recordMcpOperationCompletionFailure(started.requestId, {
          identity: { ...Object.fromEntries(["workspaceId", "streamId", "provider", "threadId", "toolName", "argumentsHash", "createdAtMs"]
            .map(key => [key, started[key]])), actorKind: started.actorKind ?? "provider" }, ownerId, diagnostic,
        });
        if (["succeeded", "failed"].includes(receipt?.status)) { diagnosticOutcome = "terminal-winner"; return; }
        saved = Boolean(receipt?.taskExecution?.completionFailure);
        diagnosticOutcome = saved ? "succeeded" : "not-saved";
      }
    } catch (error) { diagnosticError = error; }
    finally {
      this.#recordFailureTiming(started.requestId, "task-operation-failure-diagnostic", diagnosticStartedAt,
        diagnosticOutcome, diagnosticError, { diagnosticSaved: saved });
    }
    try {
      const errorHash = error => createHash("sha256").update(JSON.stringify(error)).digest("hex");
      const pending = this.recordCommandTrace({ commandId: started.requestId, transport: "task-operation",
        stage: "task-operation-completion-failure", outcome: "unresolved", metadata: {
          originalErrorCode: diagnostic.originalError.code, persistenceErrorCode: diagnostic.persistenceError.code,
          originalErrorSha256: errorHash(diagnostic.originalError), persistenceErrorSha256: errorHash(diagnostic.persistenceError),
          diagnosticSaved: saved, effectCompleted: diagnostic.effectCompleted,
        } });
      pending?.catch?.(() => {});
    } catch { /* Telemetry failure never grants terminal state or replay. */ }
  }

  async submitTaskOperation(name, args = {}) {
    if (!this.taskOperationCanSubmit(name)) return this.call(name, args);
    const context = this.#authorize(args.context_token);
    if (name === "hub_task_operation_reconcile" && args.request_id == null) args = { ...args, request_id: randomUUID() };
    return this.#submitTaskOperation(context, name, args, onAdmission => this.call(name, args, { onAdmission }));
  }

  async joinSubmittedTaskOperation(originalArguments) {
    // Local API lifetime only: join an already admitted exact worker. This
    // neither invokes #mutate nor starts/resumes/reconciles any operation.
    const context = this.#authorize(originalArguments.context_token);
    const read = () => this.#taskOperationReadback(context, {
      operation_request_id: originalArguments.request_id,
      original_arguments: originalArguments,
    });
    const pending = this.#pendingMutations.get(originalArguments.request_id);
    let readError;
    try { read(); } catch (error) {
      if (!pending) throw error;
      readError = error;
    }
    let workerError;
    if (pending) { try { await pending; } catch (error) { workerError = error; } }
    let receipt;
    try { receipt = read(); }
    catch (error) {
      if (workerError || readError) throw new AggregateError([workerError, readError, error].filter(Boolean), "Original worker and receipt read failed");
      throw error;
    }
    if (workerError || readError) throw new AggregateError([workerError, readError].filter(Boolean), "Original API work failed; its receipt remains unchanged");
    return receipt;
  }

  async call(name, args = {}, { onAdmission = null } = {}) {
    if (name === "hub_task_operation_get") {
      const actor = this.#authorize(args.context_token);
      if (args.archive_preview_page) return { archivePreviewPage: this.#archivePreviewPage(actor, args, args.archive_preview_page) };
      const receipt = this.#taskOperationReadback(actor, args);
      return { ...receipt, result: withArchiveCleanupInstruction(receipt.result) };
    }
    await this.#startupReconciliation;
    const context = this.#authorize(args.context_token);
    const toolName = String(name ?? "");
    if (toolName === "hub_task_operation_reconcile" && args.request_id == null) args = { ...args, request_id: randomUUID() };
    if (MUTATING_TOOLS.has(toolName)) {
      // Check the durable successor envelope before occupying its request ID.
      if (toolName === "hub_task_claim" && args.forward_custody_request_id && !this.workspaceCatalog.mcpOperation(args.request_id)) {
        this.#claimCustodySuccessor(context, args);
      }
      const operation = (admissionReceipt) => this.#dispatch({ ...context, admissionReceipt }, toolName, args);

      const result = await this.#mutate(context, toolName, args, operation, { onAdmission });
      return ["hub_task_complete", "hub_task_operation_reconcile"].includes(toolName)
        ? withArchiveCleanupInstruction(result) : result;
    }
    return this.#dispatch(context, toolName, args);
  }

  // Local frozen-source consumer, like callTaskStatusCutover. Serialized MCP
  // arguments cannot manufacture the observer or silently upgrade old resume.
  // The existing default factory/store/preflight/Git owners remain unchanged.
  async callTaskStatusCutover(args = {}, { verifySource, inspectInstalledNativeOwner } = {}) {
    await this.#startupReconciliation;
    const context = this.#authorize(args.context_token);
    if (args.initial_native_test != null) {
      const identity = normalizedInitialNativeTest(args.initial_native_test);
      if (argumentsHash({ initial_native_test: identity }) !== argumentsHash({ initial_native_test: args.initial_native_test })) {
        throw new Error("Initial native Test requires canonical exact source arguments");
      }
      if (args.status !== "testing" || args.expected_workflow_status !== "in_progress"
          || !Number.isInteger(args.expected_task_revision) || args.expected_task_revision < 1
          || Object.keys(args).some(key => !["context_token", "request_id", "task_id", "status",
            "expected_task_revision", "expected_workflow_status", "initial_native_test", "native_resolution_review"].includes(key))) {
        throw new Error("Initial native Test requires exact ordinary Progress CAS and no other cutover family");
      }
      if (typeof verifySource !== "function" || typeof inspectInstalledNativeOwner !== "function") {
        throw new Error("Initial native Test requires the existing local source inspection entrypoint");
      }
      const original = this.workspaceCatalog.mcpOperation?.(args.request_id);
      if (original && (original.workspaceId !== context.workspaceId || original.streamId !== context.streamId
          || original.provider !== context.provider || original.threadId !== context.auditThreadId
          || original.toolName !== "hub_task_status_update" || original.argumentsHash !== argumentsHash(args))) {
        throw new Error("Initial native Test original caller or arguments changed");
      }
      const source = { kind: "initial-native-test", identity, verifySource, inspectInstalledNativeOwner,
        authority: { workspaceId: context.workspaceId, streamId: context.streamId,
          provider: context.provider, threadId: context.threadId } };
      if (original?.status === "unknown") {
        const recovered = await this.taskOperationReconciliation.reconcileUnknownWorkflow({
          workspaceId: context.workspaceId, taskId: args.task_id, operationRequestId: args.request_id,
          projectRoot: this.#taskProjectRoot(context), expectedTaskRevision: args.expected_task_revision,
          expectedWorkflowStatus: args.expected_workflow_status, initialNativeTest: identity,
          verifyInitialNativeTest: source,
        });
        if (!recovered.resolved) throw new Error(`Initial native Test original remains UNKNOWN: ${recovered.error ?? "readback incomplete"}`);
      }
      return this.#mutate(context, "hub_task_status_update", args, () => this.#updateTaskWorkflowStatus(context, args, { source }));
    }
    const squashBootstrap = args.squash_source_task_id != null;
    const sourceTaskId = requiredText(
      squashBootstrap ? args.squash_source_task_id : args.cutover_source_task_id,
      "cutover source Task id", 200,
    );
    const targetTaskId = requiredText(args.task_id, "cutover target Task id", 200);
    const sourceTaskRevision = Number(
      squashBootstrap ? args.squash_source_task_revision : args.cutover_source_task_revision,
    );
    if (!Number.isInteger(sourceTaskRevision) || sourceTaskRevision < 1) {
      throw new Error("cutover source Task revision must be a positive integer");
    }
    const expectedStatus = squashBootstrap ? "testing" : "awaiting_implementation";
    if (sourceTaskId === targetTaskId || args.status !== expectedStatus) {
      throw new Error(`Cross-Task cutover requires distinct source and target Tasks and a ${expectedStatus} target`);
    }
    const sourceCommit = requiredText(args.cutover_source_commit, "cutover source commit", 128).toLowerCase();
    const projectorSha256 = requiredText(args.cutover_projector_sha256, "cutover projector SHA-256", 128).toLowerCase();
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(sourceCommit)
        || !/^[0-9a-f]{64}$/u.test(projectorSha256)) {
      throw new Error("Cross-Task cutover source commit or projector hash is invalid");
    }
    if (typeof verifySource !== "function") throw new TypeError("cutover source verifier is required");
    let squashCutover = null;
    if (squashBootstrap) {
      const commit = (name) => requiredText(args[name], name.replaceAll("_", " "), 64).toLowerCase();
      const sha256 = (name) => requiredText(args[name], name.replaceAll("_", " "), 64).toLowerCase();
      squashCutover = {
        reviewedSourceTree: commit("squash_cutover_source_tree"),
        expectedMainCommit: commit("squash_cutover_expected_main_commit"),
        expectedDevCommit: commit("squash_cutover_expected_dev_commit"),
        expectedPreservedTree: commit("squash_cutover_expected_preserved_tree"),
        projectorSha256,
        artifacts: {
          sourceZipSha256: sha256("squash_cutover_source_zip_sha256"),
          bundleSha256: sha256("squash_cutover_bundle_sha256"),
          manifestSha256: sha256("squash_cutover_manifest_sha256"),
          filesSha256: sha256("squash_cutover_files_sha256"),
        },
        expectedCutoverHash: args.expected_squash_cutover_hash,
      };
      if (![squashCutover.reviewedSourceTree, squashCutover.expectedMainCommit,
        squashCutover.expectedDevCommit, squashCutover.expectedPreservedTree]
        .every((value) => /^[0-9a-f]{40}$/u.test(value))
          || !Object.values(squashCutover.artifacts).every((value) => /^[0-9a-f]{64}$/u.test(value))
          || sourceCommit !== String(args.squash_new_result_commit ?? "").trim().toLowerCase()) {
        throw new Error("Task squash cutover exact source, repository or artifact identity is invalid");
      }
    }
    return this.#mutate(context, "hub_task_status_update", args, () => (
      this.#updateTaskWorkflowStatus(context, args, {
        source: {
          kind: squashBootstrap ? "squash-cutover" : "await-cutover",
          taskId: sourceTaskId,
          expectedRevision: sourceTaskRevision,
          expectedCommit: sourceCommit,
          expectedProjectorSha256: projectorSha256,
          verifySource,
          ...(squashCutover ?? {}),
        },
      })
    ));
  }

  async #dispatch(context, name, args) {
    switch (name) {
      case "hub_context_get":
        return context;
      case "hub_workspace_get":
        return this.#workspace(context, args.workspace_id);
      case "hub_parallel_streams_list":
        return this.#parallelStreams(context, args);
      case "hub_active_runs_list":
        return this.#activeRunsForWorkspace(context, args);
      case "hub_stream_history":
        return this.#streamHistory(context, args);
      case "hub_stream_message_send":
        return this.#sendStreamMessage(context, args);
      case "hub_rules_get":
        return this.workspaceCatalog.developerRulesForStream(
          this.#streamTarget(context, args).stream.id,
        );
      case "hub_workspace_rules_update":
        return this.workspaceCatalog.updateWorkspaceDeveloperRules(
          this.#workspace(context, args.workspace_id).id,
          optionalText(args.content, 32 * 1024) ?? "",
        );
      case "hub_stream_rules_update":
        return this.workspaceCatalog.updateStreamDeveloperRules(
          this.#streamTarget(context, args).stream.id,
          optionalText(args.content, 32 * 1024) ?? "",
        );
      case "hub_tasks_list":
        return this.#tasks(context, args);
      case "hub_task_get":
        return { ...compactTask(this.#taskById(args.task_id)),
          taskOperations: this.listTaskOperations(args.task_id) };
      case "hub_task_create":
        return this.#createTask(context, args);
      case "hub_task_update":
        return this.#updateTask(context, args);
      case "hub_task_checklist_update":
        return this.#updateTaskChecklist(context, args);
      case "hub_task_move":
        return this.#moveTask(context, args);
      case "hub_task_start":
        return this.#startTask(context, args);
      case "hub_task_reassign":
        return this.#startTask(context, args, { reassign: true });
      case "hub_task_launch_cancel":
        return this.#cancelTaskLaunch(context, args);
      case "hub_task_claim":
        return this.#claimTask(context, args);
      case "hub_task_status_update":
        return this.#updateTaskWorkflowStatus(context, args);
      case "hub_task_operation_cancel": {
        if (!this.taskOperationInterruption) throw new Error("Task cancellation is unavailable");
        return this.taskOperationInterruption.cancel({ actor: { workspaceId: context.workspaceId,
          streamId: context.streamId, provider: context.provider, threadId: context.auditThreadId },
          taskId: args.task_id, operationRequestId: args.operation_request_id,
          cancellationRequestId: requiredText(args.request_id, "request id", 200),
          expectedArgumentsHash: args.expected_arguments_hash, expectedTaskRevision: args.expected_task_revision,
          originalArguments: args.original_arguments, runtimeWitness: args.runtime_witness });
      }
      case "hub_task_operation_reconcile": {
        const useSavedEvidence = args.task_id == null;
        try { return await this.#reconcileTaskOperation(context, args); }
        catch (error) {
          if (useSavedEvidence) {
            return { resolved: false, outcome: "unknown", operationId: args.operation_request_id,
              error: String(error?.message ?? error) };
          }
          throw error;
        }
      }
      case "hub_task_legacy_git_adopt":
        return this.#adoptLegacyTaskGit(context, args);
      case "hub_task_complete":
        return this.#completeTask(context, args);
      case TASK_COMPLETE_BATCH:
        return this.#completeTaskBatch(context, args);
      case "hub_task_delete": {
        return this.#deleteTask(context, args);
      }
      case "hub_task_attachment_read":
        return this.#readAttachment(context, args);
      case "hub_task_attachment_add":
        return this.#addAttachment(context, args);
      case "hub_events_list":
        return this.#events(context, args);
      case "hub_mcp_operations_list":
      {
        const workspaceId = this.#workspace(context, args.workspace_id).id;
        return {
          workspaceId,
          operations: this.workspaceCatalog.mcpOperations(workspaceId, { limit: args.limit })
            .map((operation) => ({
              requestId: operation.requestId,
              streamId: operation.streamId,
              provider: operation.provider,
              threadId: operation.threadId,
              toolName: operation.toolName,
              status: operation.status,
              argumentsHash: operation.argumentsHash,
              error: operation.error,
              createdAtMs: operation.createdAtMs,
              completedAtMs: operation.completedAtMs,
            })),
        };
      }
      default:
        throw new Error(`unknown Agent Hub MCP tool: ${name}`);
    }
  }

  #signature(payload) {
    return createHmac("sha256", this.secret).update(payload).digest("base64url");
  }

  #rememberContextCapability(signature, identity) {
    this.#contextCapabilities.delete(signature);
    this.#contextCapabilities.set(signature, identity);
    while (this.#contextCapabilities.size > MAX_REGISTERED_CONTEXT_CAPABILITIES) {
      this.#contextCapabilities.delete(this.#contextCapabilities.keys().next().value);
    }
  }

  #authorize(value) {
    if (!String(value ?? "").trim()) {
      throw new Error("missing Agent Hub context_token: copy the exact value from the current <agent_hub_context> developer block; do not search environment variables");
    }
    const token = requiredText(value, "context token", 2_000);
    const separator = token.lastIndexOf(".");
    if (separator <= 0) throw new Error("invalid Agent Hub context capability");
    const payload = token.slice(0, separator);
    const signature = token.slice(separator + 1);
    const supplied = Buffer.from(signature, "base64url");
    const expected = Buffer.from(this.#signature(payload), "base64url");
    const exactPayload = supplied.length === expected.length && timingSafeEqual(supplied, expected);
    let identity = null;
    if (exactPayload) {
      try {
        identity = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
      } catch {
        throw new Error("invalid Agent Hub context capability");
      }
    } else {
      // The signature is itself an unforgeable bearer capability. Resolve it
      // to the canonical identity registered when the current instructions
      // were built, so a model copy error in the visible payload cannot alter
      // scope or strand an otherwise valid capability.
      identity = this.#contextCapabilities.get(signature) ?? null;
    }
    if (!identity) throw new Error("invalid Agent Hub context capability");
    if (identity?.v !== CONTEXT_TOKEN_VERSION) throw new Error("unsupported Agent Hub context capability");
    const provider = requiredText(identity.provider, "provider", 100);
    const threadId = String(identity.threadId ?? "").trim() || null;
    const streamId = String(identity.streamId ?? "").trim() || null;
    const resolved = this.#resolveContext({ provider, threadId, streamId });
    if (!resolved) throw new Error("Agent Hub context is no longer bound to a Workspace");
    return {
      provider,
      threadId,
      auditThreadId: threadId ?? `stream:${resolved.streamId}`,
      workspaceId: resolved.workspaceId,
      workspaceName: resolved.workspaceName,
      streamId: resolved.streamId,
      streamName: resolved.streamDisplayName,
      projectRoot: resolved.thread.projectRoot,
    };
  }

  #resolveContext({ provider, threadId = null, streamId = null } = {}) {
    const normalizedProvider = requiredText(provider, "provider", 100);
    const normalizedThreadId = String(threadId ?? "").trim();
    if (normalizedThreadId) {
      const resolvedThread = this.workspaceCatalog.resolveThread({
        provider: normalizedProvider,
        threadId: normalizedThreadId,
      });
      const normalizedStreamId = String(streamId ?? "").trim();
      if (resolvedThread && (!normalizedStreamId || resolvedThread.streamId === normalizedStreamId)) {
        return resolvedThread;
      }
    }
    const normalizedStreamId = String(streamId ?? "").trim();
    if (!normalizedStreamId) return null;
    const stream = this.workspaceCatalog.stream(requiredText(normalizedStreamId, "stream id", 300));
    const workspace = stream ? this.workspaceCatalog.workspace(stream.workspaceId) : null;
    if (!stream || !workspace) return null;
    const thread = this.workspaceCatalog.activeThread(stream.id);
    return {
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      streamId: stream.id,
      streamDisplayName: stream.displayName,
      thread: {
        projectRoot: thread?.projectRoot || String(stream.settings?.project ?? "").trim(),
      },
    };
  }

  #workspace(context, workspaceId = null) {
    const targetWorkspaceId = String(workspaceId ?? "").trim() || context.workspaceId;
    const workspace = this.workspaceCatalog.hierarchy()
      .find((candidate) => candidate.id === targetWorkspaceId);
    if (!workspace) throw new Error("Agent Hub Workspace not found");
    return {
      ...workspace,
      currentStreamId: workspace.id === context.workspaceId ? context.streamId : null,
      callerStreamId: context.streamId,
    };
  }

  #streamTarget(context, { stream_id: streamId = null, workspace_id: workspaceId = null } = {}) {
    const targetStreamId = String(streamId ?? "").trim() || context.streamId;
    const catalogStream = this.workspaceCatalog.stream(requiredText(targetStreamId, "stream id", 300));
    if (!catalogStream) throw new Error("Agent Hub Stream not found");
    const requestedWorkspaceId = String(workspaceId ?? "").trim();
    if (requestedWorkspaceId && requestedWorkspaceId !== catalogStream.workspaceId) {
      throw new Error("Stream is outside the selected Workspace");
    }
    const workspace = this.#workspace(context, catalogStream.workspaceId);
    const stream = workspace.streams.find((candidate) => candidate.id === targetStreamId);
    if (!stream) throw new Error("Agent Hub Stream not found");
    return { workspace, stream, catalogStream };
  }

  #taskProjectRoot(context, streamId = context.streamId, workspaceId = null) {
    const target = this.#streamTarget(context, { stream_id: streamId, workspace_id: workspaceId });
    const { workspace, stream } = target;
    return taskProjectRoot({ workspace, stream });
  }

  #parallelStreams(context, { workspace_id: workspaceId = null } = {}) {
    const workspace = this.#workspace(context, workspaceId);
    const activeRunSummaries = this.#activeRunSummaries(workspace.id);
    const deferredInputs = this.#deferredInputSummaries(workspace.id);
    return {
      workspaceId: workspace.id,
      currentStreamId: workspace.currentStreamId,
      streams: workspace.streams.map((stream) => {
        const activeRuns = activeRunSummaries
          .filter((run) => run.streamId === stream.id);
        const queuedInputs = deferredInputs.filter((input) => input.streamId === stream.id);
        return {
          ...stream,
          current: stream.id === context.streamId,
          activeRuns,
          deferredInputs: queuedInputs,
          queuedInputCount: queuedInputs.length,
          stalledDeferredInputCount: queuedInputs.filter((input) => input.stalled).length,
          available: activeRuns.length === 0 && queuedInputs.length === 0,
        };
      }),
    };
  }

  #tasks(context, { include_completed: includeCompleted = false, limit = 50 } = {}) {
    const boundedLimit = Math.max(1, Math.min(100, Number(limit) || 50));
    return {
      workspaceId: context.workspaceId,
      tasks: this.taskBoard.snapshot({ includeDetails: true })
        .filter((task) => includeCompleted || task.status !== "done")
        .slice(0, boundedLimit)
        .map(compactTask),
    };
  }

  #task(_context, taskId) {
    return this.#taskById(taskId);
  }

  #taskById(taskId) {
    const id = requiredText(taskId, "task id", 300);
    const task = this.taskBoard.task(id);
    if (!task) throw new Error("task not found");
    return task;
  }

  async #createTask(context, { workspace_id: workspaceId = null, title, description = "" } = {}) {
    const targetWorkspace = this.#workspace(context, workspaceId);
    const { text } = validatedTaskInput(title, description, { combined: true });
    const created = await this.taskBoard.create({
      text,
      source: "hub-mcp",
      sourceDetails: {
        mcpWorkspaceId: targetWorkspace.id,
        mcpCallerWorkspaceId: context.workspaceId,
        mcpCallerStreamId: context.streamId,
      },
      bucket: "workspace",
      workspaceId: targetWorkspace.id,
    });
    return compactTask(created);
  }

  async #updateTask(context, { task_id: taskId, task_number: taskNumber, title, description } = {}) {
    const current = this.#task(context, taskId);
    const next = validatedTaskInput(title ?? current.title, description ?? current.description);
    return compactTask(await this.taskBoard.update({
      id: current.id,
      taskNumber: taskNumber == null ? undefined : requiredText(taskNumber, "task number", 80),
      title: next.title,
      description: next.description,
    }));
  }

  async #updateTaskChecklist(context, {
    task_id: taskId,
    expected_task_revision: expectedRevision,
    operation,
    item_id: itemId = null,
    text = null,
    completed = null,
    before_item_id: beforeItemId = null,
    linked_task_id: linkedTaskId = null,
    release_reference: releaseReference = null,
    request_id: requestId,
  } = {}) {
    const payload = this.#taskChecklistPayload(context, {
      taskId, expectedRevision, operation, itemId, text, completed, beforeItemId, linkedTaskId, releaseReference, requestId,
    });
    const mutate = async () => this.#taskChecklistResult(await this.taskBoard.updateChecklist(payload));
    if (payload.releaseReference?.manualDelivery) {
      if (typeof this.taskLifecycle.withManualDeliveryReleaseReference !== "function") throw Error("Manual release reference owner is unavailable");
      return this.taskLifecycle.withManualDeliveryReleaseReference({ taskId: payload.linkedTaskId,
        reference: payload.releaseReference, operationId: requestId }, mutate);
    }
    return mutate();
  }

  #taskChecklistPayload(context, {
    taskId, expectedRevision, operation, itemId, text, completed, beforeItemId, linkedTaskId, releaseReference, requestId,
  }) {
    const current = this.#task(context, taskId);
    const normalizedOperation = requiredText(operation, "checklist operation", 30);
    if (releaseReference != null && normalizedOperation !== "link") throw new Error("Release reference is only valid for link");
    if (normalizedOperation === "toggle" && typeof completed !== "boolean") {
      throw new Error("toggle checklist operation requires explicit boolean completed");
    }
    return {
      id: current.id,
      operation: normalizedOperation,
      itemId: optionalText(itemId, 300),
      text: optionalText(text, 1_000),
      completed: typeof completed === "boolean" ? completed : null,
      beforeItemId: optionalText(beforeItemId, 300),
      linkedTaskId: optionalText(linkedTaskId, 300),
      ...(releaseReference == null ? {} : { releaseReference: normalizedReleaseReference(releaseReference) }),
      expectedRevision,
      requestId,
    };
  }

  #taskChecklistResult(result) {
    return {
      task: compactTask(result.task),
      itemId: result.itemId,
      createdTask: result.createdTask ? compactTask(result.createdTask) : null,
      replayed: result.replayed,
    };
  }

  async #reconcileTaskChecklist(context, args) {
    const payload = this.#taskChecklistPayload(context, {
      taskId: args.task_id,
      expectedRevision: args.expected_task_revision,
      operation: args.operation,
      itemId: args.item_id ?? null,
      text: args.text ?? null,
      completed: args.completed,
      beforeItemId: args.before_item_id ?? null,
      linkedTaskId: args.linked_task_id ?? null,
      releaseReference: args.release_reference ?? null,
      requestId: args.request_id,
    });
    const result = this.taskBoard.checklistRequestResult(payload);
    if (!result) return null;
    await this.taskBoard.recoverChecklistEvents?.();
    return this.#taskChecklistResult(result);
  }

  async #moveTask(context, {
    task_id: taskId, destination, workspace_id: workspaceId = null, before_task_id: beforeTaskId = null,
  } = {}) {
    const current = this.#task(context, taskId);
    const target = requiredText(destination, "task destination", 30);
    if (!["workspace", "backlog", "notes"].includes(target)) throw new Error("invalid task destination");
    const targetWorkspaceId = target === "workspace" ? this.#workspace(context, workspaceId).id : null;
    if (beforeTaskId) {
      const before = this.#task(context, requiredText(beforeTaskId, "before task id", 300));
      if (before.bucket !== target || before.workspaceId !== targetWorkspaceId) {
        throw new Error("before task is outside the destination column");
      }
    }
    return compactTask(await this.taskBoard.move({
      id: current.id,
      bucket: target,
      workspaceId: targetWorkspaceId,
      beforeId: beforeTaskId,
    }));
  }

  #assertClaimContinuation(taskId, operationId, fenceId = null) {
    if (this.workspaceCatalog.claimCustodyForOriginal?.(operationId)) throw new TaskClaimContinuationWithdrawnError();
    const reserved = fenceId ? this.workspaceCatalog.claimCustodyForTask?.(taskId) : null;
    if (reserved && (reserved.requestId !== fenceId || reserved.successorClaimRequestId !== operationId)) {
      throw new TaskClaimCustodyRejectedError("Task has an unconsumed forward custody fence");
    }
  }

  #claimLease(lease, taskId, operationId, fenceId = null) {
    return new Proxy(lease, { get: (target, key) => {
      if (key === "assertOwned") return async () => {
        await target.assertOwned();
        this.#assertClaimContinuation(taskId, operationId, fenceId);
      };
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    } });
  }

  #custodyTask(context, taskId, envelope) {
    const task = this.#task(context, taskId);
    if (task.revision !== envelope.expected_task_revision || task.streamId !== envelope.expected_owner_stream_id
        || ["done", "starting"].includes(task.status)) throw new TaskClaimCustodyRejectedError("Pinned Task owner or revision changed");
    if (task.streamId === null && (task.status !== "open" || task.workflowStatus !== "new" || task.gitReferences?.length)) {
      throw new TaskClaimCustodyRejectedError("Unassigned custody requires an exact new Task without accepted results");
    }
    return task;
  }

  #custodyBusy(task, claimant = null) {
    if (task.streamId === null) return false;
    return this.#activeRuns().some(run => run.streamId === task.streamId && run !== claimant)
      || this.#deferredInputs().some(input => input.streamId === task.streamId
        || (input.provider && input.threadId && this.workspaceCatalog.resolveThread({ provider: input.provider, threadId: input.threadId })?.streamId === task.streamId));
  }

  async #claimCustody(context, args) {
    if (Object.keys(args).some(k => !["context_token", "request_id", "task_id", "operation_request_id", "confirm_reconcile", "claim_custody"].includes(k))) {
      throw new TaskClaimCustodyRejectedError("Unexpected custody command argument");
    }
    const input = args.claim_custody;
    if (!input || !["prepare", "fence"].includes(input.action)) throw new TaskClaimCustodyRejectedError("Invalid custody action");
    if (!this.taskGitWorkspaces?.reuseClaimWorkspaceOwned || !this.taskGitWorkspaces?.withTaskLock) {
      throw new TaskClaimCustodyRejectedError("Canonical custody capabilities are unavailable");
    }
    if (this.#pendingMutations.has(args.operation_request_id)) throw new TaskClaimCustodyRejectedError("Original claim worker is still live");
    let plan = null;
    if (input.action === "fence") {
      if (Object.keys(input).some(k => !["action", "plan_request_id", "expected_plan_hash"].includes(k))) throw new TaskClaimCustodyRejectedError("Unexpected fence argument");
      plan = claimCustodyState(this.workspaceCatalog.mcpOperation(input.plan_request_id));
      if (!plan || plan.phase !== "planned" || plan.planHash !== input.expected_plan_hash
          || plan.taskId !== args.task_id || plan.original.requestId !== args.operation_request_id
          || plan.workspaceId !== context.workspaceId) throw new TaskClaimCustodyRejectedError("Exact durable custody plan differs");
    }
    const envelope = plan?.envelope ?? input;
    const isolated = envelope.admission === "isolated-source-v1";
    if ((!isolated && (!this.claimCustodyRuntime?.capture || !this.claimCustodyRuntime?.assertRetired))
        || (isolated && (!this.taskGitWorkspaces.planIndependentClaimNamespace || !this.taskGitWorkspaces.stageIndependentClaimNamespaceOwned))) {
      throw new TaskClaimCustodyRejectedError("Canonical admission guarantee is unavailable");
    }
    const original = this.workspaceCatalog.mcpOperation(args.operation_request_id);
    assertClaimCustodyOriginal(original, envelope, args.task_id, args.operation_request_id);
    if (original.workspaceId !== context.workspaceId) throw new TaskClaimCustodyRejectedError("Original belongs to another Workspace");
    return this.taskGitWorkspaces.withTaskLock(args.task_id, async lease => {
      const task = this.#custodyTask(context, args.task_id, envelope);
      if (this.workspaceCatalog.claimCustodyForOriginal?.(original.requestId)
          || this.workspaceCatalog.claimCustodyNamespaceForTask?.(task.id)) throw new TaskClaimCustodyRejectedError("Another custody disposition already owns this Task");
      if (this.#pendingMutations.has(original.requestId)) throw new TaskClaimCustodyRejectedError("Original claim is still live");
      const reuse = source => this.taskGitWorkspaces.reuseClaimWorkspaceOwned({ taskId: task.id, taskNumber: task.taskNumber,
        source, lease, unassigned: task.streamId === null,
        registeredProjectRoot: task.streamId === null ? this.#taskProjectRoot(context, original.streamId, task.workspaceId) : null });
      const workspace = await reuse(plan?.source ?? envelope.source);
      const source = { ...envelope.source, ...workspace };
      if (plan && (claimCustodyHash(source) !== claimCustodyHash(plan.source)
          || claimCustodyHash(original) !== plan.originalHash)) throw new TaskClaimCustodyRejectedError("Pinned custody source or original changed");
      const cohort = isolated ? null : plan?.cohort ?? await this.claimCustodyRuntime.capture({ original, witness: envelope.runtime_witness ?? null });
      const retirement = !isolated && plan ? await this.claimCustodyRuntime.assertRetired(cohort) : null;
      if (!isolated && plan && retirement?.retired !== true) throw new TaskClaimCustodyRejectedError("Legacy cohort retirement is not proved");
      const namespace = isolated ? plan
        ? await this.taskGitWorkspaces.stageIndependentClaimNamespaceOwned({ state: plan, lease })
        : this.taskGitWorkspaces.planIndependentClaimNamespace({ taskId: task.id, source,
          requestId: args.request_id, originalHash: claimCustodyHash(original) }) : null;
      if (isolated && plan) await reuse(source);
      await lease.assertOwned();
      // Re-read after the native/runtime wait, without refreshing expected pins.
      this.#custodyTask(context, task.id, envelope);
      const state = { version: 1, kind: "claim-forward-custody-v1", phase: plan ? "fenced" : "planned",
        requestId: args.request_id, argumentsHash: context.admissionReceipt.argumentsHash,
        workspaceId: context.workspaceId, actorStreamId: context.streamId, actorThreadId: context.auditThreadId, actorProvider: context.provider,
        taskId: task.id, taskRevision: task.revision, original, originalHash: claimCustodyHash(original),
        envelope, source, cohort, successorClaimRequestId: envelope.successor_claim_request_id,
        ...(isolated ? { namespace, taskState: plan?.taskState ?? this.workspaceCatalog.claimCustodyTaskSnapshot(task.id) } : {}),
        ...(plan ? { planRequestId: plan.requestId, planHash: plan.planHash, retirement } : {}) };
      if (plan) state.successorArgumentsHash = mcpArgumentsHash({ request_id: state.successorClaimRequestId,
        task_id: state.taskId, forward_custody_request_id: state.requestId,
        ...(Object.hasOwn(envelope.original_arguments,"dependency_mode") ? { dependency_mode: envelope.original_arguments.dependency_mode } : {}) });
      if (!plan) state.planHash = claimCustodyHash(state);
      state.result = { kind: plan ? "claim-custody-fence" : "claim-custody-plan", requestId: state.requestId,
        originalRequestId: original.requestId, taskId: task.id, taskRevision: task.revision, planHash: state.planHash,
        successorClaimRequestId: state.successorClaimRequestId, historicalOutcome: "UNKNOWN_UNCHANGED" };
      return (await this.workspaceCatalog.checkpointClaimCustody(state)).result;
    });
  }

  #claimCustodySuccessor(context, args) {
    const fence = claimCustodyState(this.workspaceCatalog.mcpOperation(args.forward_custody_request_id));
    if (!fence || fence.phase !== "fenced" || fence.taskId !== args.task_id || fence.workspaceId !== context.workspaceId
        || fence.successorClaimRequestId !== args.request_id || args.dependency_override_reason != null
        || argumentsHash(args) !== fence.successorArgumentsHash
        || args.dependency_mode !== fence.envelope.original_arguments.dependency_mode
        || Object.keys(args).some(k => !["context_token", "request_id", "task_id", "dependency_mode", "forward_custody_request_id"].includes(k))) {
      throw new TaskClaimCustodyRejectedError("Successor claim differs from the explicit forward disposition");
    }
    return fence;
  }

  async #consumeClaimCustody(context, args, { committedReadbackOnly = false } = {}) {
    const fence = this.#claimCustodySuccessor(context, args);
    return this.taskGitWorkspaces.withTaskLock(args.task_id, async lease => {
      const guarded = this.#claimLease(lease, args.task_id, args.request_id, fence.requestId);
      await guarded.assertOwned();
      if (claimCustodyHash(this.workspaceCatalog.mcpOperation(fence.original.requestId)) !== fence.originalHash) throw new TaskClaimCustodyRejectedError("Historical original changed");
      // Whole-cohort retirement was positively proved by the native port and
      // committed with this immutable fence. It is monotonic: closing the own
      // read-only collector after commit cannot revive the retired invocation.
      const isolated = fence.envelope.admission === "isolated-source-v1";
      if (!isolated && fence.retirement?.retired !== true) throw new TaskClaimCustodyRejectedError("Durable retirement certificate differs");
      const task = this.#task(context, args.task_id);
      const workspace = isolated
        ? await this.taskGitWorkspaces.readIndependentClaimNamespaceOwned({ state: fence, lease: guarded, exactInitial: true })
        : await this.taskGitWorkspaces.reuseClaimWorkspaceOwned({ taskId: task.id, taskNumber: task.taskNumber, source: fence.source, lease: guarded });
      if (!isolated && claimCustodyHash({ ...fence.source, ...workspace }) !== claimCustodyHash(fence.source)) throw new TaskClaimCustodyRejectedError("Custody source or registered baseline differs");
      const bound = this.taskBoard.claimBindingForOperation(args.request_id);
      if (bound) {
        if (bound.taskId !== task.id || bound.workspaceId !== context.workspaceId || bound.provider !== context.provider
            || bound.threadId !== context.threadId || task.streamId !== context.streamId || task.revision !== fence.taskRevision + 1) {
          throw new TaskClaimCustodyRejectedError("Committed custody binding or Task changed");
        }
        return { ...compactTask(task), claimedTurnId: bound.turnId,
          claimCustody: { fenceRequestId: fence.requestId, sourceReuse: "readonly", dependencyPreparation: "not-replayed" },
          gitWorkspace: Object.fromEntries(["branch", "projectRoot", "baseCommit", "headCommit"].map(k => [k, workspace[k]])) };
      }
      if (committedReadbackOnly) throw new TaskClaimCustodyRejectedError("Committed custody binding is missing");
      this.#custodyTask(context, task.id, fence.envelope);
      const active = this.#currentRun(context);
      const assertCurrentRun = this.#claimRunValidator(context, active);
      const validateAdmission = (beforeCommit = false) => {
        assertCurrentRun();
        const own = task.streamId === context.streamId;
        if (own && (!String(active.id ?? "").trim() || active.workspaceId !== context.workspaceId
            || active.streamId !== context.streamId || active.provider !== context.provider
            || active.threadId !== context.threadId || !String(active.turnId ?? "").trim())) {
          throw new Error("Current custody claimant requires a complete exact run identity");
        }
        // Only the exact current run is the claimant. Other runs and queued
        // inputs of the same Stream still belong to the existing busy guard.
        if (this.#custodyBusy(task, own ? active : null)) throw new Error(beforeCommit
          ? "Previous executor became active before custody assignment commit"
          : "Previous executor became active; exact custody claim may be reopened after its normal terminal");
      };
      validateAdmission();
      await guarded.assertOwned();
      return this.#writeClaim(context, task, active, args.request_id, workspace, fence.requestId, validateAdmission);
    });
  }

  #claimExecutorBusyReason(task, claimantStreamId) {
    if (!task.streamId || task.streamId === claimantStreamId) return null;
    if (this.#activeRuns().some(run => run.streamId === task.streamId)) return "active";
    const queued = this.#deferredInputs().some(input => input.streamId === task.streamId
      || (input.provider && input.threadId && this.workspaceCatalog.resolveThread({
        provider: input.provider, threadId: input.threadId,
      })?.streamId === task.streamId));
    return queued ? "queued" : null;
  }

  async #requireClaimExecutorIdle(context, args, task) {
    const busyReason = this.#claimExecutorBusyReason(task, context.streamId);
    if (!busyReason) return;
    requiredMethod(this.workspaceCatalog, "recordClaimAdmissionRefusal");
    await this.workspaceCatalog.recordClaimAdmissionRefusal({ receipt: context.admissionReceipt, task, busyReason,
      claimArguments: Object.fromEntries(Object.entries(args).filter(([key]) => key !== "context_token")) });
    throw new TaskClaimExecutorBusyError();
  }

  async #claimTask(context, args = {}, { committedReadbackOnly = false } = {}) {
    const { task_id: taskId, request_id: operationId, dependency_mode: dependencyMode = "skip", dependency_override_reason: dependencyOverrideReason = null } = args;
    const task = this.#task(context, taskId);
    const namespace = this.workspaceCatalog.claimCustodyNamespaceForTask?.(taskId);
    const active = this.#currentRun(context);
    const assertCurrentRun = namespace ? this.#claimRunValidator(context, active) : null;
    if (task.status === "done") throw new Error("Closed Tasks are an archive; claim an open Task");
    if (args.forward_custody_request_id) return this.#consumeClaimCustody(context, args, { committedReadbackOnly });
    if (!namespace) await this.#requireClaimExecutorIdle(context, args, task);
    if (namespace && task.workspaceId !== context.workspaceId) throw new Error("Task is outside the current Workspace");
    const projectRoot = namespace?.namespace.workspace.projectRoot ?? this.#taskProjectRoot(context);
    if (this.taskGitWorkspaces?.withTaskLock && projectRoot) {
      return this.taskGitWorkspaces.withTaskLock(task.id, async lease => {
        const guarded = this.#claimLease(lease, task.id, operationId);
        await guarded.assertOwned();
        // An ordinary claim may have become the executor while this one waited.
        if (namespace) await this.#requireClaimExecutorIdle(context, args, this.#task(context, taskId));
        let workspace;
        try {
          workspace = await this.taskGitWorkspaces.prepareOwned({ taskId: task.id, taskNumber: task.taskNumber,
            projectRoot, dependencyMode, dependencyOverrideReason, lease: guarded, claimOperationId: operationId });
        } catch (error) {
          const lockAdmission = await this.taskGitWorkspaces.claimAdmissionNoEffectEvidence?.({
            taskId: task.id, projectRoot, operationId, error,
          });
          if (["task-git-dev-lock-admission-v1", "task-git-source-admission-v1"].includes(lockAdmission?.kind)) {
            await guarded.assertOwned();
            await this.workspaceCatalog.recordClaimAdmissionRefusal({ receipt: context.admissionReceipt, task,
              ...(lockAdmission.kind === "task-git-source-admission-v1" ? { sourceAdmission: lockAdmission } : { lockAdmission }),
              claimArguments: Object.fromEntries(Object.entries(args).filter(([key]) => key !== "context_token")) });
          }
          throw error;
        }
        await guarded.assertOwned();
        const validateAdmission = assertCurrentRun ? () => {
          assertCurrentRun();
          if (this.#claimExecutorBusyReason(this.#task(context, taskId), context.streamId)) throw new TaskClaimExecutorBusyError();
        } : null;
        return this.#writeClaim(context, task, active, operationId, workspace, null, validateAdmission);
      });
    }
    const gitWorkspace = this.taskGitWorkspaces && projectRoot
      ? await this.taskGitWorkspaces.prepare({ taskId: task.id, taskNumber: task.taskNumber, projectRoot, dependencyMode, dependencyOverrideReason })
      : null;
    return this.#writeClaim(context, task, active, operationId, gitWorkspace);
  }

  async #writeClaim(context, task, active, operationId, gitWorkspace, forwardCustodyRequestId = null, validateClaimAdmission = null) {
    this.#assertClaimContinuation(task.id, operationId, forwardCustodyRequestId);
    const turnId = active.turnId;
    const gitBaseline = (gitWorkspace ? gitWorkspace.gitBaseline : active.gitBaseline) ?? null;
    const claimed = await this.measureOperation("task-binding", () => this.taskBoard.claim({
      id: task.id,
      workspaceId: context.workspaceId,
      streamId: context.streamId,
      provider: context.provider,
      threadId: context.threadId,
      turnId,
      operationId,
      operationKind: "claim",
      gitBaseline, forwardCustodyRequestId,
      validateClaimAdmission: validateClaimAdmission ? () => {
        validateClaimAdmission(true);
        this.#assertClaimContinuation(task.id, operationId, forwardCustodyRequestId);
      } : null,
    }));
    if (gitWorkspace) active.gitBaseline = gitWorkspace.gitBaseline;
    return {
      ...compactTask(claimed),
      claimedTurnId: turnId,
      ...(forwardCustodyRequestId ? { claimCustody: { fenceRequestId: forwardCustodyRequestId,
        sourceReuse: "readonly", dependencyPreparation: "not-replayed" } } : {}),
      gitWorkspace: gitWorkspace ? {
        branch: gitWorkspace.branch,
        projectRoot: gitWorkspace.projectRoot,
        baseCommit: gitWorkspace.baseCommit,
        headCommit: gitWorkspace.headCommit,
      } : null,
    };
  }

  #claimRunValidator(context, active) {
    const identity = Object.fromEntries(["id", "workspaceId", "streamId", "provider", "threadId", "turnId"].map(key => [key, active[key]]));
    return () => {
      const current = this.#currentRun(context);
      if (current !== active || Object.entries(identity).some(([key, value]) => current[key] !== value)) {
        throw new Error("Current claimant run changed before Task binding");
      }
    };
  }

  #currentRun(context) {
    if (!context.threadId) throw new Error("operation requires a bound provider Thread");
    const active = this.#activeRuns().filter((run) => (
      String(run?.provider ?? "").trim().toLowerCase() === context.provider
      && String(run?.threadId ?? "").trim() === context.threadId
      && String(run?.turnId ?? "").trim()
      && run?.observer !== true
    ));
    if (active.length !== 1) {
      throw new Error(active.length ? "current provider Thread has ambiguous active runs" : "current provider Thread has no exact active run");
    }
    return active[0];
  }

  async #updateTaskWorkflowStatus(context, {
    task_id: taskId, status, request_id: operationId,
    expected_task_revision: expectedRevision = null,
    expected_workflow_status: expectedWorkflowStatus = null,
    cutover_source_task_id: sourceTaskId = null,
    cutover_source_task_revision: sourceTaskRevision = null,
    squash_source_task_id: squashSourceTaskId = null,
    squash_source_task_revision: squashSourceTaskRevision = null,
    squash_baseline_result_commit: squashBaselineResultCommit = null,
    squash_new_result_commit: squashNewResultCommit = null,
    squash_dev_after_tree: squashDevAfterTree = null,
    squash_proof_request_id: squashProofRequestId = null,
    expected_squash_transfer_hash: expectedSquashTransferHash = null,
    expected_squash_cutover_hash: expectedSquashCutoverHash = null,
    selected_proof_bundle_path: selectedBundlePath = null,
    selected_proof_bundle_sha256: selectedBundleSha256 = null,
    selected_proof_commit: selectedProofCommit = null,
    selected_published_resolution: selectedPublishedResolution = null,
    selected_absorption_handoff: selectedAbsorptionHandoff = null,
    selected_preview_request_id: selectedPreviewRequestId = null,
    expected_selected_preview_hash: expectedSelectedPreviewHash = null,
    initial_native_test: initialNativeTest = null,
    manual_delivery: manualDelivery = null,
  } = {}, { source = null } = {}) {
    const validationStarted = performance.now();
    let workflowStatus;
    try {
      workflowStatus = normalizedTaskWorkflowStatus(requiredText(status, "task workflow status", 40));
    } catch (error) {
      try { const pending = this.recordCommandTrace({ commandId: operationId, transport: "task-operation",
        stage: "task-workflow-input-validation", outcome: "failed", monotonicDurationMs: performance.now() - validationStarted,
        metadata: { valid: 0 } }); pending?.catch?.(() => {}); } catch {}
      throw new TaskInputValidationError(error.message);
    }
    try { const pending = this.recordCommandTrace({ commandId: operationId, transport: "task-operation",
      stage: "task-workflow-input-validation", outcome: "succeeded", monotonicDurationMs: performance.now() - validationStarted,
      metadata: { valid: 1 } }); pending?.catch?.(() => {}); } catch {}
    if (initialNativeTest != null && source?.kind !== "initial-native-test") {
      throw new TaskInputValidationError("Initial native Test requires the supported local cutover entrypoint");
    }
    if ((sourceTaskId != null || sourceTaskRevision != null) && !source) {
      throw new Error("Cross-Task cutover requires the supported local cutover entrypoint");
    }
    const task = this.#task(context, taskId);
    if (manualDelivery && (workflowStatus !== "done" || source
        || expectedRevision == null || expectedWorkflowStatus == null)) {
      throw new TaskInputValidationError("Manual delivery Done requires exact Task/status CAS");
    }
    const squashValues = [
      squashSourceTaskId, squashSourceTaskRevision, squashBaselineResultCommit,
      squashNewResultCommit, squashDevAfterTree,
    ];
    const squashRequested = [...squashValues, squashProofRequestId, expectedSquashTransferHash,
      expectedSquashCutoverHash]
      .some((value) => value != null);
    const selectedRequested = [selectedBundlePath, selectedBundleSha256, selectedProofCommit, selectedPublishedResolution,
      selectedPreviewRequestId, expectedSelectedPreviewHash].some((value) => value != null);
    if (manualDelivery && (squashRequested || selectedRequested || selectedAbsorptionHandoff || initialNativeTest)) {
      throw new TaskInputValidationError("Manual delivery Done cannot combine another integration input");
    }
    if (selectedRequested) {
      throw Object.assign(new TaskInputValidationError("New selected materialization is closed; use ordinary native Git Test and isolated conflict resolution"),
        { code: "TASK_NATIVE_GIT_REQUIRED" });
    }
    if (selectedAbsorptionHandoff != null && (workflowStatus !== "testing" || squashRequested || source
        || expectedRevision == null || expectedWorkflowStatus !== "in_progress")) {
      throw new TaskInputValidationError("Native absorption requires exact ordinary Test CAS from Progress");
    }
    if (squashRequested) {
      if (squashValues.some((value) => value == null)) {
        throw new Error("Task squash transfer requires the complete exact source/result/tree identity");
      }
      const squashBootstrap = source?.kind === "squash-cutover";
      if ((!squashBootstrap && source) || sourceTaskId != null || sourceTaskRevision != null
          || workflowStatus !== "testing") {
        throw new Error("Task squash transfer is a distinct Test-to-Test operation");
      }
      if (expectedRevision == null) {
        throw new Error("Task squash transfer requires the exact survivor Task revision");
      }
      const expectedCurrentStatus = squashBootstrap ? "in_progress" : "testing";
      if (expectedWorkflowStatus != null && expectedWorkflowStatus !== expectedCurrentStatus) {
        throw new Error(`Task squash transfer expected workflow status must be ${expectedCurrentStatus}`);
      }
      if (!squashBootstrap && expectedSquashCutoverHash != null) {
        throw new Error("Task squash cutover hash is accepted only by the one-shot cutover entrypoint");
      }
      const confirmationRequested = Boolean(expectedSquashTransferHash || expectedSquashCutoverHash);
      if (squashBootstrap && Boolean(expectedSquashTransferHash) !== Boolean(expectedSquashCutoverHash)) {
        throw new Error("Task squash cutover confirmation requires both exact hashes");
      }
      if (confirmationRequested && !squashProofRequestId) {
        throw new Error("Task squash transfer confirmation requires the exact preview request id");
      }
      if (!confirmationRequested && squashProofRequestId) {
        throw new Error("Task squash transfer preview identity is returned by the preview request");
      }
      const proofRequestId = confirmationRequested
        ? requiredText(squashProofRequestId, "squash proof request id", 200)
        : operationId;
      const operation = {
        taskId: task.id,
        sourceTaskId: squashSourceTaskId,
        operationId,
        expectedTaskRevision: expectedRevision,
        expectedSourceTaskRevision: squashSourceTaskRevision,
        baselineResultCommit: squashBaselineResultCommit,
        newResultCommit: squashNewResultCommit,
        devAfterTree: squashDevAfterTree,
        expectedTransferHash: expectedSquashTransferHash,
        projectRoot: this.#taskProjectRoot(
          context,
          String(task.streamId ?? "").trim() || context.streamId,
          task.workspaceId,
        ),
        authority: {
          workspaceId: context.workspaceId,
          streamId: context.streamId,
          provider: context.provider,
          threadId: context.threadId,
          proofRequestId,
        },
      };
      const result = squashBootstrap
        ? await this.taskLifecycle.squashTransferCutover({
          ...operation,
          expectedCutoverHash: expectedSquashCutoverHash,
          reviewedSourceTree: source.reviewedSourceTree,
          expectedMainCommit: source.expectedMainCommit,
          expectedDevCommit: source.expectedDevCommit,
          expectedPreservedTree: source.expectedPreservedTree,
          projectorSha256: source.expectedProjectorSha256,
          artifacts: source.artifacts,
          verifySource: source.verifySource,
        })
        : await this.taskLifecycle.squashTransfer(operation);
      return {
        ...result,
        ...(result.task ? { task: compactTask(result.task) } : {}),
        ...(result.sourceTask ? { sourceTask: compactTask(result.sourceTask) } : {}),
      };
    }
    let binding = {};
    try {
      const run = this.#currentRun(context);
      const claimed = this.taskBoard.claimedTaskForTurn?.({
        provider: context.provider, threadId: context.threadId, turnId: run.turnId,
      });
      if (claimed?.id === task.id && claimed.operationId) {
        binding = {
          provider: context.provider, threadId: context.threadId, turnId: run.turnId,
          bindingOperationId: claimed.operationId,
        };
      }
    } catch {}
    const options = {
      taskId: task.id,
      manualDelivery,
      status: workflowStatus,
      operationId,
      binding,
      projectRoot: this.#taskProjectRoot(
        context,
        String(task.streamId ?? "").trim() || context.streamId,
        task.workspaceId,
      ),
      expectedRevision,
      expectedWorkflowStatus,
      admissionReceipt: context.admissionReceipt ?? null,

      selectedAbsorptionHandoff,
    };
    const result = source?.kind === "initial-native-test"
      ? await this.taskLifecycle.updateWorkflowStatusFromInitialSource(options, source)
      : source ? await this.taskLifecycle.updateWorkflowStatusFromSource(options, source)
      : await this.taskLifecycle.updateWorkflowStatus(options);
    if (!result?.task) return compactTask(result);
    const { task: updated, ...evidence } = result;
    return { ...compactTask(updated), ...evidence };
  }

  databaseContentionDiagnostics() {
    const receipts = this.workspaceCatalog.mutationDiagnostics?.() ?? {};
    const tasks = this.taskBoard.mutationDiagnostics?.() ?? {};
    const fallback = {};
    return {
      retries: Number(receipts.retries ?? 0) + Number(tasks.retries ?? 0) + Number(fallback.retries ?? 0),
      exhausted: Number(receipts.exhausted ?? 0) + Number(tasks.exhausted ?? 0) + Number(fallback.exhausted ?? 0),
      lastWaitMs: Math.max(
        Number(receipts.lastWaitMs ?? 0), Number(tasks.lastWaitMs ?? 0), Number(fallback.lastWaitMs ?? 0),
      ),
      receipts,
      tasks,
    };
  }

  async #cleanupPreview(task, action) {
    const preview = this.taskGitWorkspaces?.cleanupPreview
      ? await this.taskGitWorkspaces.cleanupPreview(task.id, {
        gitReferences: task.gitReferences,
        squashAbsorbedBy: task.squashAbsorbedBy,
      })
      : { taskId: task.id, workspaces: [], gitReferences: task.gitReferences ?? [], dirty: false, unpublished: [], deleting: [] };
    return cleanupConfirmation(task, action, preview);
  }

  #validateCleanupToken(task, args, action) {
    if (taskCleanupIsConfirmed(args) && !String(args.expected_cleanup_token ?? "").trim()
        && !this.taskBoard.lifecycleTransition?.(args.request_id) && !this.taskBoard.lifecycleOutcome?.(args.request_id)) {
      throw new TaskCleanupConfirmationRejectedError(task.id, action);
    }
  }

  async #completeTask(context, args = {}) {
    const {
    task_id: taskId, request_id: operationId,
    expected_cleanup_token: expectedCleanupToken = null,
    absorbed_into_task_id: absorbedIntoTaskId = null,
    absorption_mode: absorptionMode = null,
    completion_mode: completionMode = null,
    retain_artifacts: retainArtifacts = false,
    published_delivery: publishedDelivery = null,
    manual_delivery: manualDelivery = null,
    retained_repositories: retainedRepositories = [],
    completed_operation_request_id: completedOperationRequestId = null,
    abandoned_release: abandonedRelease = null,
    } = args;
    const task = this.#task(context, taskId);
    this.#validateCleanupToken(task, args, "complete");
    const result = await this.taskLifecycle.complete({
      taskId: task.id, operationId, confirmCleanup: taskCleanupIsConfirmed(args), expectedCleanupToken, absorbedIntoTaskId,
      absorptionMode, completionMode, publishedDelivery, manualDelivery, retainedRepositories, completedOperationRequestId, retainArtifacts,
      abandonedRelease,
      originalArguments: ["published_delivery", "operational", "manual_delivery", "archive", "abandoned_release_service"].includes(completionMode)
        ? Object.fromEntries(Object.entries(args).filter(([key]) => key !== "context_token")) : null,
    });
    return compactCompleteResult(result);
  }

  async #completeTaskBatch(context, args) {
    let taskIds;
    try {
      if (!Array.isArray(args.task_ids) || args.task_ids.length < 1 || args.task_ids.length > MAX_BATCH_COMPLETIONS) {
        throw new Error(`Expected between 1 and ${MAX_BATCH_COMPLETIONS} Task IDs`);
      }
      taskIds = [...new Set(args.task_ids.map(id => {
        if (typeof id !== "string") throw new Error("Task ID must be a string");
        return requiredText(id, "task id", 300);
      }))];
      // The catalog has a 64 KiB receipt cap. Do not let long input IDs consume
      // the space needed for each outcome and its exact child receipt.
      if (Buffer.byteLength(JSON.stringify(taskIds)) > 12 * 1024) throw new Error("Batch Task IDs exceed the receipt budget");
    } catch (error) {
      throw new TaskInputValidationError(error.message, { cause: error });
    }
    const results = [];
    for (const taskId of taskIds) {
      results.push(await this.#completeBatchTask(context, { batchId: args.request_id, taskId, manualDelivery: args.manual_delivery }));
    }
    return { results };
  }

  async #completeBatchTask(context, { batchId, taskId, manualDelivery }) {
    const id = stage => `batch-${stage}-${createHash("sha256").update(JSON.stringify([batchId, taskId])).digest("hex")}`;
    const previewId = id("preview"), archiveId = id("archive"), doneId = id("done");
    const archiveOriginal = this.workspaceCatalog.mcpOperation(archiveId);
    const task = this.taskBoard.task(taskId, { required: false });
    if (!archiveOriginal && task?.status === "done") {
      return { taskId, outcome: "already_closed", workflowStatus: task.workflowStatus, taskRevision: task.revision };
    }
    if (!task) return { taskId, outcome: "not_found" };

    const archiveArgs = { task_id: taskId, completion_mode: "archive", retain_artifacts: true };
    const run = (toolName, input) => this.#completeBatchChild(context, toolName, input);
    let doneReceipt = null;
    if (manualDelivery) {
      const priorDone = this.workspaceCatalog.mcpOperation(doneId);
      if (priorDone || (!archiveOriginal && task.workflowStatus !== "done")) {
        const captured = priorDone?.taskExecution?.arguments;
        const done = await run("hub_task_status_update", { task_id: taskId, request_id: doneId, status: "done",
          expected_task_revision: captured?.expected_task_revision ?? task.revision,
          expected_workflow_status: captured?.expected_workflow_status ?? task.workflowStatus,
          manual_delivery: manualDelivery });
        if (done.outcome !== "succeeded" || done.result?.workflowStatus !== "done") {
          return { taskId, stage: "done", ...done.summary, ...(done.outcome === "succeeded" ? { outcome: "unknown" } : {}) };
        }
        doneReceipt = done.summary.receipt;
      }
    }
    const completedWorkflow = doneReceipt ? { workflowStatus: "done", doneReceipt }
      : task.workflowStatus === "done" ? { workflowStatus: task.workflowStatus } : {};
    const preview = await run("hub_task_complete", { ...archiveArgs, request_id: previewId });
    if (preview.outcome !== "succeeded" || !preview.result?.cleanupToken) {
      return { taskId, stage: "preview", ...preview.summary, ...completedWorkflow,
        ...(preview.outcome === "succeeded" ? { outcome: "unknown" } : {}) };
    }
    const archive = await run("hub_task_complete", { ...archiveArgs, request_id: archiveId,
      confirm_cleanup: true, expected_cleanup_token: preview.result.cleanupToken });
    const result = archive.result;
    const summary = { taskId, stage: "archive", ...archive.summary, ...completedWorkflow };
    if (archive.outcome !== "succeeded") return summary;
    if (result?.confirmationRequired) return { ...summary, outcome: "confirmation_required" };
    if (result?.id !== taskId || result.status !== "done") return { ...summary, outcome: "unknown" };
    return { ...summary, outcome: "archived", workflowStatus: result.workflowStatus };
  }

  async #completeBatchChild(context, toolName, args) {
    const requestId = args.request_id, childHash = argumentsHash(args);
    let operation = this.workspaceCatalog.mcpOperation(requestId);
    const matches = row => row.workspaceId === context.workspaceId && row.streamId === context.streamId
      && row.provider === context.provider && row.threadId === context.auditThreadId
      && (row.actorKind ?? "provider") === (context.actorKind ?? "provider")
      && row.toolName === toolName && row.argumentsHash === childHash;
    let error;
    if (!operation) {
      try {
        await this.#mutate(context, toolName, args,
          admissionReceipt => this.#dispatch({ ...context, admissionReceipt }, toolName, args));
      } catch (failure) {
        error = failure;
      }
      operation = this.workspaceCatalog.mcpOperation(requestId);
    }
    if (operation && !matches(operation)) return { outcome: "failed", summary: { outcome: "failed", error: "Child receipt identity differs" } };
    if (operation?.status === "unknown" && args.completion_mode === "archive" && args.confirm_cleanup === true
        && !this.#pendingMutations.has(requestId)) {
      // Only the single Complete reconciler may settle a previously admitted
      // archive. It verifies its original hash and never repeats cleanup.
      try {
        await this.#reconcilePublishedDeliveryComplete(context, { operation_request_id: requestId,
          task_id: args.task_id, expected_arguments_hash: childHash });
      } catch (failure) {
        error = failure;
      }
      operation = this.workspaceCatalog.mcpOperation(requestId);
    }
    const outcome = operation?.status ?? "unknown";
    const message = String(operation?.error || error?.message || "").slice(0, 80);
    return { outcome, result: operation?.result, summary: { outcome,
      receipt: { requestId, argumentsHash: childHash, status: operation?.status ?? "not_found" },
      ...(message ? { error: message } : {}) } };
  }

  async #deleteTask(context, args = {}) {
    const {
    task_id: taskId, request_id: operationId,
    expected_cleanup_token: expectedCleanupToken = null,
    } = args;
    const task = this.#task(context, taskId);
    this.#validateCleanupToken(task, args, "delete");
    const result = await this.taskLifecycle.delete({
      taskId: task.id, operationId, confirmCleanup: taskCleanupIsConfirmed(args), expectedCleanupToken,
    });
    return result?.confirmationRequired
      ? { ...result, task: compactTask(result.task) }
      : { ...result, task: compactTask(result.task) };
  }

  async #adoptLegacyTaskGit(context, {
    task_id: taskId,
    expected_task_revision: expectedTaskRevision,
    evidence_turn_id: evidenceTurnId,
    reported_result_commit: reportedResultCommit,
    main_result_commit: mainResultCommit,
    request_id: requestId,
  } = {}) {
    if (!this.taskGitWorkspaces) throw new Error("Task Git workspace service is unavailable");
    const task = this.#task(context, taskId);
    if (task.status === "done" || task.workflowStatus !== "awaiting_implementation") {
      throw new Error("Legacy Git adoption requires an open Await Task");
    }
    if ((task.gitReferences ?? []).length) throw new Error("Task already has Git evidence");
    if (Number(task.revision) !== Number(expectedTaskRevision)) {
      throw new Error("Task revision changed before legacy Git adoption");
    }
    const target = this.#streamTarget(context, {
      stream_id: requiredText(task.streamId, "Task Stream id", 300),
      workspace_id: task.workspaceId,
    });
    const turns = await this.workLog.threadTurns(target.stream.threads, { limit: 50 });
    const expectedTurnId = requiredText(evidenceTurnId, "evidence turn id", 300);
    const evidence = turns.find((turn) => (
      String(turn?.turnId ?? "").trim() === expectedTurnId && String(turn?.status ?? "") === "completed"
    ));
    if (!evidence) throw new Error("Completed evidence turn was not found in the Task Stream");
    const sourceCommit = requiredText(reportedResultCommit, "reported result commit", 100).toLowerCase();
    const evidenceText = [evidence.title, JSON.stringify(evidence.prompt ?? ""), evidence.body]
      .map((value) => String(value ?? ""))
      .join("\n");
    const taskIdentityPresent = evidenceText.includes(task.id)
      || (String(task.taskNumber ?? "").trim() && evidenceText.includes(task.taskNumber));
    if (!taskIdentityPresent || !evidenceText.toLowerCase().includes(sourceCommit)) {
      throw new Error("Evidence turn does not bind this Task to the reported result commit");
    }
    const projectRoot = this.#taskProjectRoot(context, task.streamId, task.workspaceId);
    if (!projectRoot) throw new Error("Task project root is unavailable");
    const gitEvidence = await this.taskGitWorkspaces.adoptLegacyResult({
      taskId: task.id,
      taskNumber: task.taskNumber,
      projectRoot,
      reportedResultCommit: sourceCommit,
      mainResultCommit: requiredText(mainResultCommit, "main result commit", 100).toLowerCase(),
    });
    const adopted = await this.taskBoard.adoptLegacyGitReference({
      taskId: task.id,
      expectedRevision: expectedTaskRevision,
      projectRoot: gitEvidence.projectRoot,
      branch: gitEvidence.branch,
      reportedResultCommit: gitEvidence.reportedResultCommit,
      mainResultCommit: gitEvidence.resultCommit,
      patchId: gitEvidence.patchId,
      evidenceStreamId: target.stream.id,
      evidenceProvider: evidence.provider,
      evidenceThreadId: evidence.threadId,
      evidenceTurnId: evidence.turnId,
      actorStreamId: context.streamId,
      actorProvider: context.provider,
      actorThreadId: context.threadId,
      requestId,
    });
    return {
      ...compactTask(adopted),
      gitAdoption: {
        projectRoot: gitEvidence.projectRoot,
        branch: gitEvidence.branch,
        baseCommit: gitEvidence.baseCommit,
        reportedResultCommit: gitEvidence.reportedResultCommit,
        resultCommit: gitEvidence.resultCommit,
        mainCommit: gitEvidence.mainCommit,
        patchId: gitEvidence.patchId,
        changedFiles: gitEvidence.changedFiles,
      },
    };
  }

  async #startTask(context, {
    task_id: taskId, stream_id: streamId = null, new_stream_name: newStreamName = null,
    workspace_id: workspaceId = null, provider = null, message = "",
    request_id: requestId,
  } = {}, { reassign = false } = {}) {
    const task = this.#task(context, taskId);
    const requestedStreamId = String(streamId ?? "").trim();
    const requestedStreamName = String(newStreamName ?? "").trim();
    if (requestedStreamId && requestedStreamName) {
      throw new Error("stream_id and new_stream_name are mutually exclusive");
    }
    const requestedWorkspaceId = String(workspaceId ?? "").trim();
    let targetWorkspace;
    let targetStreamId;
    if (requestedStreamName) {
      targetWorkspace = this.#workspace(context, requestedWorkspaceId || context.workspaceId);
      targetStreamId = null;
    } else {
      const target = this.#streamTarget(context, {
        stream_id: requestedStreamId || context.streamId,
        workspace_id: requestedWorkspaceId || null,
      });
      targetWorkspace = target.workspace;
      targetStreamId = target.stream.id;
    }
    const previousStreamId = String(task.streamId ?? "").trim();
    if (reassign) {
      if (task.status !== "started" || !previousStreamId) throw new Error("only a started Task can be reassigned");
      if (targetStreamId && targetStreamId === previousStreamId) throw new Error("Task is already assigned to this Stream");
      const previousStream = this.#streamTarget(context, { stream_id: previousStreamId });
      const activeRuns = this.#activeRunSummaries(previousStream.workspace.id)
        .filter((run) => run.streamId === previousStreamId);
      const queuedInputs = this.#deferredInputSummaries(previousStream.workspace.id)
        .filter((input) => input.streamId === previousStreamId);
      if (activeRuns.length || queuedInputs.length) {
        throw new Error("Task cannot be reassigned while its current Stream has an active turn or queued input");
      }
    }
    const targetProvider = String(provider ?? "").trim() || context.provider;
    const sourceRun = this.#activeRuns().find((run) => (
      String(run?.provider ?? "").trim().toLowerCase() === context.provider
      && String(run?.threadId ?? "").trim() === String(context.threadId ?? "").trim()
    ));
    const normalizedRequestId = requiredText(requestId, "request id", 200);
    const messageOrigin = interstreamOriginFromContext(context, sourceRun, normalizedRequestId);
    const inheritedSettings = requestedStreamName && targetProvider === context.provider ? {
      provider: targetProvider,
      ...(String(sourceRun?.modelId ?? "").trim() ? { model: sourceRun.modelId } : {}),
      ...(String(sourceRun?.reasoningId ?? "").trim() ? { reasoning: sourceRun.reasoningId } : {}),
    } : null;
    const bindInterstreamAuditContent = (rawMessage) => (
      this.workspaceCatalog.bindMcpOperationInterstreamContentHash(
        normalizedRequestId,
        interstreamAuditContentHash(rawMessage),
      )
    );
    const result = await this.#taskLauncher({
      id: task.id,
      workspaceId: targetWorkspace.id,
      streamId: targetStreamId,
      streamName: requestedStreamName || null,
      provider: targetProvider,
      ...(inheritedSettings ? { settings: inheritedSettings } : {}),
      reassign,
      message: optionalText(message, 100_000) ?? "",
      followUpMode: "queue",
      launchRequestId: normalizedRequestId,
      clientUserMessageId: `mcp:${normalizedRequestId}`,
    }, { ...context, messageOrigin, bindInterstreamAuditContent });
    const gitWorkspace = result.gitWorkspace ?? null;
    return {
      task: compactTask(result.task),
      ...(reassign ? { previousStreamId } : {}),
      target: {
        streamId: result.target.streamId,
        provider: result.target.provider,
        threadId: result.target.threadId ?? null,
      },
      delivery: result.delivery ?? null,
      gitWorkspace: gitWorkspace ? {
        branch: gitWorkspace.branch,
        projectRoot: gitWorkspace.projectRoot,
        baseCommit: gitWorkspace.baseCommit,
      } : null,
    };
  }

  async #cancelTaskLaunch(context, {
    task_id: taskId,
    launch_request_id: launchRequestId,
    expected_task_revision: expectedTaskRevision,
    request_id: cancellationRequestId,
  } = {}) {
    const task = this.#task(context, taskId);
    const normalizedLaunchRequestId = requiredText(launchRequestId, "launch request id", 200);
    const normalizedCancellationRequestId = requiredText(cancellationRequestId, "request id", 200);
    const revision = Number(expectedTaskRevision);
    if (!Number.isSafeInteger(revision) || revision < 1 || revision !== Number(task.revision)) {
      throw new Error("Task revision changed before launch cancellation");
    }
    if (
      task.status !== "starting"
      || task.startRequestId !== normalizedLaunchRequestId
    ) throw new Error("Task does not retain the exact prepared launch owner");
    const destinationStreamId = requiredText(task.startDestinationStreamId, "planned destination Stream id", 300);
    if (this.workspaceCatalog.stream(destinationStreamId)) {
      throw new Error("launch cancellation cannot prove that no destination Stream effect exists");
    }
    const original = this.workspaceCatalog.mcpOperation?.(normalizedLaunchRequestId);
    if (!original || original.toolName !== "hub_task_start") {
      throw new Error("original Task launch receipt was not found");
    }
    if (original.taskExecution?.taskId && original.taskExecution.taskId !== task.id) {
      throw new Error("Original launch receipt targets a different Task");
    }
    if (original.interstreamContentHash) {
      throw new Error("launch cancellation cannot disprove an admitted delivery effect");
    }
    const alreadyCancelled = original.status === "failed"
      && original.result?.cancelled === true
      && original.result?.taskId === task.id;
    if (!["pending", "reconciling", "unknown"].includes(original.status) && !alreadyCancelled) {
      throw new Error("original Task launch receipt is not cancellable");
    }
    requiredMethod(this.workspaceCatalog, "cancelMcpOperation");
    requiredMethod(this.taskBoard, "fencePreparedStartCancellation");
    requiredMethod(this.taskBoard, "completePreparedStartCancellation");
    const fenced = await this.taskBoard.fencePreparedStartCancellation({
      id: task.id,
      requestId: normalizedLaunchRequestId,
      cancellationRequestId: normalizedCancellationRequestId,
      expectedRevision: revision,
    });
    if (this.workspaceCatalog.stream(destinationStreamId)) {
      throw new Error("launch cancellation fence found a destination Stream effect");
    }
    const fencedReceipt = this.workspaceCatalog.mcpOperation(normalizedLaunchRequestId);
    if (fencedReceipt?.interstreamContentHash) {
      throw new Error("launch cancellation fence found an admitted delivery effect");
    }
    const terminalReceipt = await this.workspaceCatalog.cancelMcpOperation(normalizedLaunchRequestId, {
      taskId: task.id,
      cancellationRequestId: normalizedCancellationRequestId,
    });
    const cancelled = await this.taskBoard.completePreparedStartCancellation({
      id: task.id,
      requestId: normalizedLaunchRequestId,
      expectedRevision: fenced.revision,
    });
    return {
      task: compactTask(cancelled),
      cancelledLaunch: {
        requestId: normalizedLaunchRequestId,
        receiptStatus: terminalReceipt.status,
        argumentsHash: original.argumentsHash,
        destinationStreamId,
        destinationAbsent: true,
        admittedContentAbsent: true,
      },
    };
  }

  async #sendStreamMessage(context, {
    stream_id: streamId,
    text,
    mode = "queue",
    request_id: requestId,
  } = {}) {
    const targetStreamId = requiredText(streamId, "stream id", 300);
    const target = this.#streamTarget(context, { stream_id: targetStreamId });
    const targetStream = target.stream;
    const followUpMode = requiredText(mode, "message mode", 20).toLowerCase();
    if (!new Set(["queue", "steer"]).has(followUpMode)) throw new Error("invalid message mode");
    const normalizedRequestId = requiredText(requestId, "request id", 200);
    const sourceRun = this.#activeRuns().find((run) => (
      String(run?.provider ?? "").trim().toLowerCase() === context.provider
      && String(run?.threadId ?? "").trim() === String(context.threadId ?? "").trim()
    ));
    const messageOrigin = interstreamOriginFromContext(context, sourceRun, normalizedRequestId);
    const message = createInterstreamMessage({
      ...messageOrigin,
      text: requiredText(text, "message text", 100_000),
    });
    await this.workspaceCatalog.bindMcpOperationInterstreamContentHash(
      normalizedRequestId,
      interstreamAuditContentHash(message),
    );
    const delivery = await this.#streamMessenger({
      streamId: targetStreamId,
      text: message,
      clientUserMessageId: `mcp:${normalizedRequestId}`,
      followUpMode,
    }, {
      source: "mcp",
      clientId: `mcp:${context.provider}:${context.auditThreadId}`,
      messageOrigin,
      bindInterstreamAuditContent: (rawMessage) => (
        this.workspaceCatalog.bindMcpOperationInterstreamContentHash(
          normalizedRequestId,
          interstreamAuditContentHash(rawMessage),
        )
      ),
    });
    return {
      source: {
        workspaceId: context.workspaceId,
        workspaceName: context.workspaceName,
        streamId: context.streamId,
        streamName: context.streamName,
        provider: context.provider,
        ...(messageOrigin?.model ? { model: messageOrigin.model } : {}),
        ...(messageOrigin?.sourceThreadId ? { threadId: messageOrigin.sourceThreadId } : {}),
      },
      target: {
        workspaceId: target.workspace.id,
        workspaceName: target.workspace.name,
        streamId: targetStreamId,
        streamName: targetStream.displayName ?? targetStream.name ?? "",
      },
      delivery,
    };
  }

  #events(context, {
    workspace_id: workspaceId = null, after_sequence: afterSequence = 0, limit = 50,
  } = {}) {
    const targetWorkspaceId = this.#workspace(context, workspaceId).id;
    const events = this.workspaceCatalog.workspaceEvents(targetWorkspaceId, { afterSequence, limit });
    return {
      workspaceId: targetWorkspaceId,
      events,
      nextSequence: events.at(-1)?.sequence ?? Math.max(0, Number(afterSequence) || 0),
    };
  }

  #activeRunSummaries(workspaceId) {
    return this.#activeRuns().flatMap((run) => {
      const resolved = this.workspaceCatalog.resolveThread({ provider: run.provider, threadId: run.threadId });
      if (!resolved || resolved.workspaceId !== workspaceId) return [];
      return [{
        id: run.id,
        provider: run.provider,
        threadId: run.threadId,
        turnId: run.turnId ?? null,
        streamId: resolved.streamId,
        streamName: resolved.streamDisplayName,
        status: run.activityUnknown === true ? "unknown" : run.status,
        ...(run.activityUnknown === true ? { activityUnknown: true } : {}),
        stage: compactText(run.progressStage, 500),
        startedAt: run.startedAt,
        lastMeaningfulProgressAt: run.lastMeaningfulProgressAt,
        observer: run.observer === true,
      }];
    });
  }

  #deferredInputSummaries(workspaceId) {
    return this.#deferredInputs().flatMap((input) => {
      let streamId = String(input?.streamId ?? "").trim();
      if (!streamId) {
        streamId = this.workspaceCatalog.resolveThread({
          provider: input?.provider,
          threadId: input?.threadId,
        })?.streamId ?? "";
      }
      const stream = streamId ? this.workspaceCatalog.stream(streamId) : null;
      if (!stream || stream.workspaceId !== workspaceId) return [];
      const state = String(input?.state ?? "queued").trim() || "queued";
      const stateSince = String(
        input?.dispatchingAt || input?.lastAttemptAt || input?.createdAt || "",
      ).trim();
      const stateSinceMs = Date.parse(stateSince);
      const ageMs = Number.isFinite(stateSinceMs) ? Math.max(0, Date.now() - stateSinceMs) : null;
      return [{
        id: String(input?.id ?? ""),
        streamId,
        provider: String(input?.provider ?? ""),
        threadId: String(input?.threadId ?? ""),
        clientUserMessageId: String(input?.clientUserMessageId ?? ""),
        state,
        conflictKind: String(input?.conflictKind ?? ""),
        waitReason: String(input?.waitReason ?? ""),
        createdAt: String(input?.createdAt ?? ""),
        stateSince: stateSince || null,
        ageMs,
        attempts: Math.max(0, Number(input?.attempts) || 0),
        stalled: ["dispatching", "reconciling"].includes(state)
          && ageMs != null
          && ageMs >= DEFERRED_INPUT_STALLED_AFTER_MS,
      }];
    });
  }

  #activeRunsForWorkspace(context, { workspace_id: workspaceId = null } = {}) {
    const targetWorkspaceId = this.#workspace(context, workspaceId).id;
    return {
      workspaceId: targetWorkspaceId,
      runs: this.#activeRunSummaries(targetWorkspaceId),
      deferredInputs: this.#deferredInputSummaries(targetWorkspaceId),
    };
  }

  async #streamHistory(context, {
    workspace_id: workspaceId = null,
    stream_id: streamId = null,
    limit = 20,
    include_body: includeBody = true,
    cursor = null,
    max_activity_items: maxActivityItems = DEFAULT_HISTORY_ACTIVITY_LIMIT,
  } = {}) {
    const targetStreamId = String(streamId ?? "").trim() || context.streamId;
    const parsedCursor = parsedStreamHistoryCursor(cursor);
    const target = this.#streamTarget(context, {
      stream_id: targetStreamId,
      workspace_id: workspaceId,
    });
    const boundedLimit = Math.max(1, Math.min(50, Number(limit) || 20));
    const maximumActivities = Math.max(
      1,
      Math.min(100, Number(maxActivityItems) || DEFAULT_HISTORY_ACTIVITY_LIMIT),
    );
    if (parsedCursor && (
      parsedCursor.workspaceId !== target.workspace.id
      || parsedCursor.streamId !== target.stream.id
    )) {
      const result = {
        workspaceId: target.workspace.id,
        streamId: target.stream.id,
        state: "not_found",
        cursor: parsedCursor.source,
        activeRunCount: 0,
        turns: [],
      };
      return { ...result, revision: streamHistoryRevision(result) };
    }
    const records = await this.workLog.threadTurns(target.stream.threads, { limit: 50 });
    const completedTurns = records
      .map((record) => boundedCompletedTurn(record, includeBody === true));
    const completedIdentities = new Set(completedTurns.flatMap(turnIdentityAliases));
    const activeRuns = this.#activeRuns()
      .filter((run) => {
        if (!activeRun(run)) return false;
        if (String(run?.streamId ?? "").trim() === target.stream.id) return true;
        return this.workspaceCatalog.resolveThread({
          provider: run?.provider,
          threadId: run?.threadId,
        })?.streamId === target.stream.id;
      })
      .filter((run) => !turnIdentityAliases(run).some((identity) => completedIdentities.has(identity)))
      .sort((left, right) => compareStreamHistoryTurns(
        { ...left, runId: left?.id, active: true },
        { ...right, runId: right?.id, active: true },
      ));
    const activeTurns = activeRuns.map((run) => boundedActiveTurn(run, {
      includeBody: includeBody === true,
      maximumActivities,
    }));
    const turns = [...activeTurns, ...completedTurns]
      .sort(compareStreamHistoryTurns)
      .slice(0, boundedLimit);
    const cursorRun = parsedCursor
      ? activeRuns.find((run) => String(run?.id ?? "") === parsedCursor.runId) ?? null
      : null;
    const selectedRun = cursorRun ?? activeRuns[0] ?? null;
    let state = "idle";
    if (selectedRun) state = !parsedCursor || cursorRun
      ? selectedRun.activityUnknown === true ? "unknown" : "active" : "replaced";
    else if (parsedCursor) {
      const cursorIdentities = turnIdentityAliases(parsedCursor);
      state = completedTurns.some((turn) => (
        turnIdentityAliases(turn).some((identity) => cursorIdentities.includes(identity))
      )) ? "terminal" : "not_found";
    }
    const result = {
      workspaceId: target.workspace.id,
      streamId: target.stream.id,
      state,
      cursor: selectedRun
        ? streamHistoryCursor({ workspaceId: target.workspace.id, streamId: target.stream.id, run: selectedRun })
        : parsedCursor?.source ?? null,
      activeRunCount: activeRuns.length,
      truncated: activeTurns.length + completedTurns.length > boundedLimit,
      turns,
    };
    return { ...result, revision: streamHistoryRevision(result) };
  }

  #taskAttachment(taskId, attachmentId) {
    const task = compactTask(this.#taskById(taskId));
    const id = requiredText(attachmentId, "attachment id", 300);
    const attachment = task.attachments.find((candidate) => candidate.id === id);
    if (!attachment) throw new Error("attachment is outside the selected task");
    const metadata = attachmentMetadataFromId(id);
    if (!metadata) throw new Error("invalid attachment id");
    return { task, attachment: metadata, file: path.join(this.attachmentDirectory, metadata.id) };
  }

  async #readAttachment(_context, {
    task_id: taskId, attachment_id: attachmentId, max_text_bytes: maxTextBytes = 65_536,
  } = {}) {
    const { attachment, file } = this.#taskAttachment(taskId, attachmentId);
    const details = await stat(file);
    if (!details.isFile() || details.size > MAX_ATTACHMENT_BYTES) throw new Error("attachment is unavailable");
    const result = { ...attachment, size: details.size, localPath: file };
    if (!TEXT_ATTACHMENT_TYPES.has(attachment.type)) return result;
    const boundedBytes = Math.max(1, Math.min(131_072, Number(maxTextBytes) || 65_536));
    const body = await readFile(file);
    result.text = body.subarray(0, boundedBytes).toString("utf8");
    result.truncated = body.length > boundedBytes;
    return result;
  }

  async #addAttachment(context, { task_id: taskId, local_path: localPath } = {}) {
    const task = this.#task(context, taskId);
    const source = path.resolve(requiredText(localPath, "local path", 2_000));
    const projectRoot = requiredText(context.projectRoot, "current project root", 2_000);
    await mkdir(this.attachmentDirectory, { recursive: true });
    const body = await readStableAttachmentSource(source, [projectRoot, this.attachmentDirectory]);
    const id = createAttachmentStorageName(path.basename(source));
    const target = path.join(this.attachmentDirectory, id);
    await writeFile(target, body, { flag: "wx" });
    try {
      await this.taskBoard.addAttachment({ id: task.id, attachment: target });
    } catch (error) {
      // A write may have committed before its readback failed. Delete the copy
      // only when authoritative Task readback proves it was not attached.
      try {
        const current = compactTask(this.#task(context, task.id));
        if (!current.attachments.some((attachment) => attachment.id === id)) await unlink(target);
      } catch { /* Unknown membership retains the copy for the original operation. */ }
      throw error;
    }
    const updated = compactTask(this.#task(context, task.id));
    if (!updated.attachments.some((attachment) => attachment.id === id)) {
      throw new Error("Task attachment persistence was not confirmed");
    }
    return {
      task: updated,
      attachment: {
        ...attachmentMetadataFromId(id),
        type: attachmentContentType(path.basename(source)),
        size: body.length,
      },
    };
  }

  async #mutate(context, toolName, args, operation, { onAdmission = null } = {}) {
    const requestId = requiredText(args.request_id, "request id", 200);
    if (this.workspaceCatalog.mcpOperation(requestId)?.taskExecution?.cancellation) throw taskOperationInterrupted();
    if (toolName === "hub_task_claim") this.#assertClaimContinuation(args.task_id, requestId, args.forward_custody_request_id);
    const checklistMutation = toolName === "hub_task_checklist_update";
    if (checklistMutation) {
      this.#taskChecklistPayload(context, {
        taskId: args.task_id,
        expectedRevision: args.expected_task_revision,
        operation: args.operation,
        itemId: args.item_id ?? null,
        text: args.text ?? null,
        completed: args.completed,
        beforeItemId: args.before_item_id ?? null,
        linkedTaskId: args.linked_task_id ?? null,
        releaseReference: args.release_reference ?? null,
        requestId: args.request_id,
      });
    }
    let admittedExecution;
    const started = await this.measureOperation("mcp:admission", () => {
      admittedExecution = this.taskOperationInterruption && (context.actorKind === "authenticated-user"
        || (this.taskOperationCanSubmit(toolName) && !["hub_task_operation_cancel", "hub_task_operation_reconcile"].includes(toolName)))
        ? this.taskOperationInterruption.binding(args) : null;
      return this.workspaceCatalog.beginMcpOperation({
      requestId,
      workspaceId: context.workspaceId,
      streamId: context.streamId,
      provider: context.provider,
      threadId: context.auditThreadId,
      ...(context.actorKind ? { actorKind: context.actorKind } : {}),
      toolName,
      argumentsHash: argumentsHash(args),
      ...(this.taskOperationCanSubmit(toolName) ? { recordAdmissionTiming: metadata => {
        try { this.recordCommandTrace({ commandId: requestId, transport: "task-operation",
          stage: "task-operation-admission-sqlite", outcome: metadata.outcome === "ok" ? "succeeded" : "rejected",
          metadata: { toolName, ...metadata } }); }
        catch { /* Diagnostics cannot alter the SQL transaction. */ }
      } } : {}),
      ...(admittedExecution ? { taskExecution: admittedExecution } : {}),
    }); });
    if (started.taskExecution?.cancellation) throw taskOperationInterrupted();
    if (started.status === "succeeded") {
      if (cleanupConfirmationOriginal(started, false) && started.result?.receiptCompacted === true
          && !started.result.cleanupToken && started.result.taskId === args.task_id) {
        this.#task(context, args.task_id);
        return this.taskLifecycle.recoverCleanupConfirmation({ taskId: args.task_id, operationId: requestId,
          action: toolName === "hub_task_complete" ? "complete" : "delete", preview: true,
          absorbedIntoTaskId: args.absorbed_into_task_id ?? null,
          readback: async ({ preview, validate }) => {
            const result = cleanupConfirmationCapsule({ ...preview, previewRecovery: {
              kind: "fresh-cleanup-preview-from-compacted-original-v1", refreshedAtMs: Date.now(),
              previousReceipt: { status: started.status, result: started.result, error: started.error,
                createdAtMs: started.createdAtMs, completedAtMs: started.completedAtMs },
            } });
            const saved = await this.workspaceCatalog.recoverCompactedCleanupPreview(requestId, {
              argumentsHash: started.argumentsHash, expectedResult: started.result, result, validate });
            return saved.result;
          } });
      }
      return claimCustodyState(started)?.result ?? started.result;
    }
    if (started.status === "failed") {
      const proof = toolName === "hub_task_claim" ? this.#claimAdmissionRefusal(started, args.task_id) : null;
      if (proof) {
        throw claimAdmissionRefusalError(proof);
      }
      throw new Error(started.error || "previous MCP operation failed");
    }
    if (started.status === "unknown" && cleanupConfirmationOriginal(started, true)
        && !this.#pendingMutations.has(requestId)) {
      this.#task(context, args.task_id);
      const error = new TaskCleanupConfirmationRejectedError(args.task_id, toolName === "hub_task_complete" ? "complete" : "delete");
      await this.taskLifecycle.recoverCleanupConfirmation({ taskId: args.task_id, operationId: requestId,
        readback: async ({ task, validate }) => {
          const identity = JSON.stringify({ ...started, replayed: undefined });
          const check = row => {
            validate();
            if (JSON.stringify({ ...row, replayed: undefined }) !== identity || !cleanupConfirmationOriginal(row, true)
                || row.taskExecution.taskWorkspaceId !== task.workspaceId) throw new Error("Missing confirmation original changed");
          };
          check(this.workspaceCatalog.mcpOperation(requestId));
          return this.workspaceCatalog.failUnknownMcpOperation(requestId, { workspaceId: context.workspaceId, toolName,
            error, beforeSettle: check, reconciliation: { kind: "cleanup-missing-token-validation-v1",
              outcome: "failed", taskId: task.id, taskRevision: task.revision, argumentsHash: started.argumentsHash,
              previousReceipt: { status: started.status, result: started.result, error: started.error,
                createdAtMs: started.createdAtMs, completedAtMs: started.completedAtMs } } });
        } });
      throw error;
    }
    const custodyConsume = toolName === "hub_task_claim" && Boolean(args.forward_custody_request_id);
    const custodyStage = toolName === "hub_task_operation_reconcile" && Boolean(args.claim_custody);
    // Re-enter only the addressed ordinary Await reconciliation owner. This
    // control never dispatches the old workflow; its leases and outcome fence
    // decide whether to settle or read the already settled original.
    const workflowReconciliationContinuation = started.replayed
      && this.#reconciliationContinuation(toolName, args, started);
    const interruption = toolName === "hub_task_operation_cancel";
    const batchContinuation = toolName === TASK_COMPLETE_BATCH;
    if (started.status === "unknown" && toolName === "hub_task_claim" && !custodyConsume) {
      const reconciled = await this.#reconcileClaimAdmissionNoEffect(context, args, started).catch(() => null);
      if (reconciled) {
        const terminal = reconciled.evidence?.evidence
          ? claimAdmissionRefusalError(reconciled.evidence.evidence) : new Error(reconciled.error);
        await this.workspaceCatalog.failUnknownMcpOperation(requestId, {
          workspaceId: context.workspaceId,
          toolName,
          error: terminal,
          reconciliation: reconciled.evidence,
        });
        throw terminal;
      }
    }
    if (started.status === "unknown" && !custodyConsume && !custodyStage && !interruption && !workflowReconciliationContinuation && !batchContinuation) {
      throw new Error(`MCP operation outcome is unknown; reconcile authoritatively before retrying request_id ${requestId}`);
    }
    const inFlight = this.#pendingMutations.get(requestId);
    if (inFlight) return inFlight;

    const resumable = new Set([
      "hub_task_start", "hub_task_reassign", "hub_task_status_update", "hub_task_complete", "hub_task_delete",
      "hub_task_checklist_update",
      "hub_task_operation_cancel",
      TASK_COMPLETE_BATCH,
    ]);
    if (started.replayed && !resumable.has(toolName) && !custodyConsume && !custodyStage && !workflowReconciliationContinuation) {
      const reason = new Error("MCP operation outcome requires authoritative reconciliation; blind replay is forbidden");
      await this.workspaceCatalog.markMcpOperationUnknown?.(requestId, reason);
      throw reason;
    }
    const execute = async () => {
      let effectCompleted = false;
      let completionFailure = null;
      const executionStartedAt = performance.now();
      try {
        if (started.replayed && checklistMutation) {
          const reconciled = await this.#reconcileTaskChecklist(context, args);
          if (reconciled) {
            effectCompleted = true;
            await this.workspaceCatalog.completeMcpOperation(requestId, reconciled);
            return reconciled;
          }
        }
        const existingRefusal = toolName === "hub_task_status_update" ? this.#workflowAdmissionRefusal(started) : null;
        if (existingRefusal) throw new TaskLifecycleNoEffectError(existingRefusal);
        const committedClaimReadback = custodyConsume && started.replayed
          && Boolean(this.taskBoard.claimBindingForOperation(requestId));
        const result = this.taskOperationInterruption && INTERRUPTIBLE_TASK_TOOLS.has(toolName)
          ? await this.taskOperationInterruption.run(started, args,
            () => committedClaimReadback ? this.#claimTask(context, args, { committedReadbackOnly: true }) : operation(started),
            { committedClaimReadback })
          : await operation(started);
        effectCompleted = true;

        if (args.claim_custody && toolName === "hub_task_operation_reconcile") {
          const durable = claimCustodyState(this.workspaceCatalog.mcpOperation(requestId));
          if (!durable) throw new Error("Custody stage is not durable");
          return durable.result;
        }
        if (workflowReconciliationContinuation) {
          const completed = await this.workspaceCatalog.completeUnknownMcpOperation(requestId, {
            workspaceId: context.workspaceId, toolName, result,
            reconciliation: { kind: "task-operation-reconciliation-control-v1",
              originalRequestId: args.operation_request_id,
              originalArgumentsHash: this.workspaceCatalog.mcpOperation(args.operation_request_id)?.argumentsHash ?? null,
              previousReceipt: started },
          });
          return completed.result;
        } else if (batchContinuation && started.status === "unknown") {
          const completed = await this.workspaceCatalog.completeUnknownMcpOperation(requestId, {
            workspaceId: context.workspaceId, toolName, result,
            reconciliation: { kind: "task-complete-batch-child-receipts-v1" },
          });
          return completed.result;
        } else if (interruption && started.status === "unknown") {
          await this.workspaceCatalog.completeUnknownMcpOperation(requestId, { workspaceId: context.workspaceId, toolName,
            result, reconciliation: { kind: "task-operation-interruption-v1", originalRequestId: args.operation_request_id } });
        } else if (custodyConsume && started.status === "unknown") {
          await this.workspaceCatalog.completeUnknownMcpOperation(requestId, { workspaceId: context.workspaceId, toolName,
            result, reconciliation: { kind: "forward-claim-binding-reuse-v1", fenceRequestId: args.forward_custody_request_id } });
        } else await this.measureOperation("mcp:receipt", () => this.workspaceCatalog.completeMcpOperation(requestId, result));
        return result;
      } catch (error) {
        this.#recordFailureTiming(requestId, "task-operation-before-error", executionStartedAt,
          "failed", error, { effectCompleted });
        const completionPersistenceFailure = persistenceError => {
          completionFailure ??= { originalError: error, persistenceError, effectCompleted };
          return Object.assign(new AggregateError([error, persistenceError],
            "MCP completion persistence failed; original outcome requires authoritative readback", { cause: error }),
          { code: "MCP_COMPLETION_PERSISTENCE_FAILED" });
        };
        const observe = action => {
          try { return action(); }
          catch (persistenceError) { throw completionPersistenceFailure(persistenceError); }
        };
        const persist = async action => {
          const settlementStartedAt = performance.now();
          let settlementError = null;
          try { return await action(); }
          catch (persistenceError) { settlementError = persistenceError; throw completionPersistenceFailure(persistenceError); }
          finally {
            this.#recordFailureTiming(requestId, "task-operation-failure-settlement", settlementStartedAt,
              settlementError ? "failed" : "succeeded", settlementError);
          }
        };
        if (error instanceof TaskLifecyclePersistenceError) {
          completionFailure = { originalError: error.cause, persistenceError: error.errors[1], effectCompleted };
        }
        // An own stage may have committed before a reply/storage exception. Its
        // dedicated ledger column survives compaction and is the exact readback.
        if (observe(() => this.workspaceCatalog.mcpOperation(requestId))?.taskExecution?.cancellation) throw taskOperationInterrupted();
        const completed = observe(() => this.workspaceCatalog.mcpOperation(requestId));
        if (completed?.status === "succeeded" && completed.argumentsHash === argumentsHash(args)) {
          return claimCustodyState(completed)?.result ?? completed.result;
        }
        // A failed continuation does not erase the previous control UNKNOWN:
        // effects of that older invocation may already be in the target owner.
        if (workflowReconciliationContinuation || (batchContinuation && started.status === "unknown")) throw error;
        if (args.claim_custody && toolName === "hub_task_operation_reconcile") {
          const durable = claimCustodyState(observe(() => this.workspaceCatalog.mcpOperation(requestId)));
          if (durable) return durable.result;
        }
        if (observe(() => this.workspaceCatalog.claimCustodyForOriginal?.(requestId))) throw new TaskClaimContinuationWithdrawnError();
        if (!effectCompleted && custodyConsume && observe(() => this.taskBoard.claimBindingForOperation(requestId))) {
          await persist(() => this.workspaceCatalog.markMcpOperationUnknown(requestId,new Error(`Custody assignment committed before outer completion: ${error.message}`)));
          throw error;
        }

        if (!effectCompleted && checklistMutation) {
          const reconciled = await this.#reconcileTaskChecklist(context, args).catch(() => null);
          if (reconciled) {
            effectCompleted = true;
            await this.workspaceCatalog.completeMcpOperation(requestId, reconciled);
            return reconciled;
          }
        }
        if (effectCompleted && checklistMutation) {
          const reconciled = await this.#reconcileTaskChecklist(context, args).catch(() => null);
          if (reconciled) throw error;
        }
        if (effectCompleted) {
          const terminal = observe(() => this.workspaceCatalog.mcpOperation(requestId));
          if (terminal?.status === "succeeded" && terminal.argumentsHash === argumentsHash(args)) return terminal.result;
          await persist(() => this.workspaceCatalog.markMcpOperationUnknown?.(
            requestId,
            new Error(`effect completed but durable receipt failed: ${error.message}`),
          ));
          throw new Error(`MCP effect completed but receipt reconciliation is required for request_id ${requestId}`, { cause: error });
        }
        const claimRefusal = toolName === "hub_task_claim"
          ? observe(() => this.#claimAdmissionRefusal(this.workspaceCatalog.mcpOperation(requestId), args.task_id)) : null;
        if (claimRefusal) {
          const refusal = claimAdmissionRefusalError(claimRefusal);
          try {
            await persist(() => this.workspaceCatalog.failMcpOperation(requestId, refusal, { outcome: "NO_EFFECT", evidence: claimRefusal }));
          } catch (settlementError) {
            throw settlementError;
          }
          throw refusal;
        }
        const workflowRefusal = toolName === "hub_task_status_update" ? observe(() => this.#workflowAdmissionRefusal(started)) : null;
        const reconciliationRefusal = toolName === "hub_task_operation_reconcile"
          && !workflowReconciliationContinuation && error instanceof TaskOperationReconciliationRefusedError;
        if (workflowRefusal || reconciliationRefusal) {
          try {
            await persist(() => this.workspaceCatalog.failMcpOperation(requestId, error, {
              outcome: "NO_EFFECT",
              ...(workflowRefusal ? { evidence: workflowRefusal } : { code: error.code }),
            }));
          } catch (settlementError) {
            throw settlementError;
          }
          throw error;
        }
        if (error instanceof TaskCleanupConfirmationRejectedError) {
          await persist(() => this.workspaceCatalog.failMcpOperation(requestId, error, { validation: error.evidence }));
          throw error;
        }
        if (definiteMcpMutationFailure(error)) {
          await persist(() => this.workspaceCatalog.failMcpOperation(requestId, error));
          throw error;
        }
        const durableLifecycle = ["hub_task_start", "hub_task_reassign"].includes(toolName)
          && observe(() => this.#hasPreparedTaskStart(context, args, requestId));
        const claimAdmissionNoEffect = toolName === "hub_task_claim"
          ? await Promise.resolve(this.taskGitWorkspaces?.claimAdmissionNoEffectEvidence?.({
              taskId: args.task_id,
              projectRoot: this.#taskProjectRoot(context),
              error,
            })).catch(() => null)
          : null;
        if (claimAdmissionNoEffect) {
          await persist(() => this.workspaceCatalog.failMcpOperation(requestId, error));
        } else if (!durableLifecycle) {
          await persist(() => this.workspaceCatalog.markMcpOperationUnknown?.(
            requestId,
            new Error(`mutation effect is not authoritatively disproved: ${error.message}`),
          ));
        }
        throw error;
      } finally {
        try {
          if (completionFailure && this.taskOperationCanSubmit(toolName)) {
            await this.#preserveCompletionFailure(started, admittedExecution?.ownerId, completionFailure);
          }
        } finally { this.#pendingMutations.delete(requestId); }
      }
    };
    const pending = toolName === "hub_task_claim" && this.taskGitWorkspaces?.withOperationTrace
      ? this.taskGitWorkspaces.withOperationTrace({ operationId: requestId, taskId: args.task_id }, execute)
      : execute();
    this.#pendingMutations.set(requestId, pending);
    onAdmission?.(started);
    return pending;
  }

  #workflowAdmissionRefusal(receipt) {
    if (this.taskBoard.lifecycleTransition?.(receipt.requestId)) return null;
    return workflowAdmissionNoEffectEvidence(this.taskBoard.lifecycleOutcome?.(receipt.requestId), receipt);
  }

  async #reconcileClaimAdmissionNoEffect(context, args, receipt) {
    const proof = this.#claimAdmissionRefusal(receipt, args.task_id);
    if (proof) return { error: claimAdmissionRefusalError(proof).message,
      evidence: { outcome: "NO_EFFECT", evidence: proof } };
    if (typeof this.taskBoard.claimBindingForOperation !== "function"
      || typeof this.taskGitWorkspaces?.claimAdmissionNoEffectEvidence !== "function"
      || typeof this.workspaceCatalog.failUnknownMcpOperation !== "function") return null;
    const task = this.#task(context, args.task_id);
    if (await Promise.resolve(this.taskBoard.claimBindingForOperation(args.request_id))) return null;
    const evidence = await this.taskGitWorkspaces.claimAdmissionNoEffectEvidence({
      taskId: task.id,
      projectRoot: this.#taskProjectRoot(context),
      error: receipt.error,
    });
    if (!evidence) return null;
    return {
      error: String(receipt.error),
      evidence: {
        kind: "task-claim-admission-failed-before-effects",
        version: 1,
        operationId: String(args.request_id),
        ...evidence,
      },
    };
  }

  #claimAdmissionRefusal(receipt, taskId = null) {
    const proof = claimAdmissionNoEffectEvidence(receipt, taskId);
    if (!proof || typeof this.taskBoard.claimBindingForOperation !== "function"
        || this.taskBoard.claimBindingForOperation(receipt.requestId)
        || this.taskBoard.lifecycleTransition?.(receipt.requestId)
        || this.taskBoard.lifecycleOutcome?.(receipt.requestId)) return null;
    return proof;
  }

  async #reconcileTaskOperation(caller, supplied) {
    const refuse = (message) => { throw new TaskOperationReconciliationRefusedError(new Error(message)); };
    const operationId = requiredText(supplied.operation_request_id, "original operation id", 200);
    const original = this.workspaceCatalog.mcpOperation(operationId);
    if (!original) refuse("Original operation receipt was not found");
    const transition = this.taskBoard.lifecycleTransition?.(operationId);
    const outcome = this.taskBoard.lifecycleOutcome?.(operationId);
    const execution = original.taskExecution;
    const prior = transition?.priorTask ?? outcome?.result?.priorTask;
    const evidence = transition?.evidence ?? outcome?.result?.evidence;
    const noEffect = outcome?.result?.noEffect;
    const recordedTaskId = execution?.taskId ?? transition?.taskId ?? outcome?.taskId
      ?? original.result?.task?.id ?? original.result?.taskId ?? original.result?.id;
    const taskId = supplied.task_id ?? recordedTaskId;
    if (!taskId) refuse("Original receipt has no saved Task identity");
    if (recordedTaskId && recordedTaskId !== taskId) refuse("Original operation Task identity differs");
    if (supplied.expected_arguments_hash != null && supplied.expected_arguments_hash !== original.argumentsHash) {
      refuse("Original operation arguments differ");
    }
    if (this.#pendingMutations.has(operationId)) refuse("Original workflow worker is still active");
    if (supplied.claim_custody != null) return this.#claimCustody(caller, { ...supplied, task_id: taskId });
    if (!this.taskOperationCanSubmit(original.toolName)) refuse("Original receipt is not a Task operation");
    if (supplied.task_id == null && ["succeeded", "failed"].includes(original.status)) {
      return { resolved: true, outcome: original.status, operationId,
        reconciliation: original.result?.operatorReconciliation ?? null,
        result: original.status === "succeeded" ? original.result : null };
    }
    const context = { ...caller, workspaceId: original.workspaceId };
    const captured = execution?.arguments;
    const verifiedArgs = captured && argumentsHash(captured) === original.argumentsHash ? captured : null;
    const args = { ...supplied, task_id: taskId };
    if (supplied.task_id == null && original.status === "unknown" && !transition && verifiedArgs
        && verifiedArgs.request_id === operationId && verifiedArgs.task_id === taskId
        && execution.taskWorkspaceId === original.workspaceId && outcome?.operationId === operationId
        && outcome.taskId === taskId && !execution.cancellation) {
      const settled = await this.#reconcileCommittedCleanup(original, outcome, verifiedArgs);
      if (settled) return settled;
    }
    if (original.toolName === "hub_task_status_update" || execution?.cancellation?.phase === "requested") {
      const task = this.taskBoard.task(taskId);
      if (!task) refuse("Original workflow Task no longer exists");
      const executor = task.streamId ? this.workspaceCatalog.stream(task.streamId) : null;
      const recordedRoots = new Set((prior?.gitReferences ?? task.gitReferences ?? []).map(reference => reference.projectRoot));
      const root = evidence?.projectRoot ?? evidence?.squashTransfer?.projectRoot
        ?? evidence?.selectedComposition?.repositoryRoot
        ?? (recordedRoots.size === 1 ? [...recordedRoots][0]
          : taskProjectRoot({ workspace: this.workspaceCatalog.workspace(original.workspaceId), stream: executor }));
      for (const [key, value] of Object.entries(verifiedArgs ?? {})) {
        if (["initial_native_test", "native_resolution_review", "selected_absorption_handoff"].includes(key)
            || /^(?:cutover_|squash_|selected_|expected_(?:task|workflow|squash|selected)_)/u.test(key)) {
          args[key] ??= value;
        }
      }
      if (execution?.cancellation) {
        args.expected_task_revision ??= task?.revision;
      }
      args.expected_arguments_hash ??= original.argumentsHash;
      if (!verifiedArgs && prior && (transition?.targetWorkflowStatus || outcome?.result?.task?.workflowStatus)) {
        const legacy = { request_id: operationId, task_id: taskId,
          status: transition?.targetWorkflowStatus ?? outcome.result.task.workflowStatus };
        const revision = { expected_task_revision: prior.revision };
        const status = { expected_workflow_status: prior.workflowStatus };
        const exact = [legacy, { ...legacy, ...revision }, { ...legacy, ...status }, { ...legacy, ...revision, ...status }]
          .find(candidate => argumentsHash(candidate) === original.argumentsHash);
        if (exact) {
          args.expected_task_revision ??= exact.expected_task_revision;
          args.expected_workflow_status ??= exact.expected_workflow_status;
        }
      }
      const guard = !noEffect && await this.taskGitWorkspaces?.operationProcessGuard?.(taskId, operationId);
      args.guard_id ??= guard?.guardId;
      args.project_root ??= guard?.repositoryRoot ?? (noEffect ? noEffect.projectRoot : root);
    } else if (original.toolName === "hub_task_claim") {
      const proof = this.#claimAdmissionRefusal(original, taskId);
      args.project_root ??= proof?.lockAdmission?.repositoryRoot ?? proof?.sourceAdmission?.projectRoot;
      if (args.project_root == null) delete args.project_root;
    } else if (original.toolName === "hub_task_complete") {
      if (verifiedArgs?.completion_mode === "manual_delivery" && !taskCleanupIsConfirmed(verifiedArgs)) {
        args.manual_preview_arguments ??= verifiedArgs;
        args.expected_arguments_hash ??= original.argumentsHash;
      } else if (verifiedArgs?.completion_mode === "abandoned_release_service" && !taskCleanupIsConfirmed(verifiedArgs)) {
        args.expected_arguments_hash ??= original.argumentsHash;
      }
    } else if (original.toolName === "hub_task_delete") {
      const cleanup = evidence?.cleanupForward?.authority;
      const previewId = cleanup?.previewRequestId ?? this.workspaceCatalog.findDeletePreviewForOriginal?.(original, taskId);
      if (previewId) args.cleanup_preview_request_id ??= previewId;
      if (cleanup?.preservedFiles) args.cleanup_preserved_files ??= cleanup.preservedFiles;
    }
    const requestedCancellation = original.taskExecution?.cancellation;
    if (requestedCancellation?.phase === "requested" && this.taskOperationInterruption) {
      if (args.guard_id && !args.project_root) {
        throw new TaskOperationReconciliationRefusedError(new Error("The exact guarded repository root is required"));
      }
      const cancellation = await this.taskOperationInterruption.reconcileRequested({
        actor: { workspaceId: caller.workspaceId, streamId: caller.streamId, provider: caller.provider,
          threadId: caller.auditThreadId },
        taskId: args.task_id, operationRequestId: args.operation_request_id,
        expectedArgumentsHash: args.expected_arguments_hash, expectedTaskRevision: args.expected_task_revision,
        cancellationRequestId: requestedCancellation.cancellationRequestId, runtimeWitness: args.runtime_witness,
        guardRecovery: args.guard_id ? { repositoryRoot: args.project_root, guardId: args.guard_id,
          proof: args.proof_kind ? { kind: args.proof_kind, summary: args.proof_summary, confirmed: true } : null } : null,
      });
      return { resolved: cancellation.phase === "stopped", outcome: cancellation.phase, cancellation };
    }
    if (original?.toolName === "hub_task_claim") {
      return this.#reconcileSealedClaimRefusal(context, args);
    }
    if (original.toolName === "hub_task_complete") {
      return this.#reconcilePublishedDeliveryComplete(context, args);
    }
    if (original.toolName === "hub_task_delete") {
      return this.#reconcileConfirmedDelete(context, args);
    }
    if (!this.taskOperationReconciliation) throw new TaskOperationReconciliationRefusedError(new Error("Task operation reconciliation is unavailable"));
    return this.taskOperationReconciliation.reconcileUnknownWorkflow({
      workspaceId: context.workspaceId,
      taskId: args.task_id,
      operationRequestId: args.operation_request_id,
      expectedArgumentsHash: args.expected_arguments_hash,
      runtimeWitness: args.runtime_witness,
      projectRoot: args.project_root,
      guardId: args.guard_id,
      proofKind: args.proof_kind,
      proofSummary: args.proof_summary,
      expectedTaskRevision: args.expected_task_revision,
      expectedWorkflowStatus: args.expected_workflow_status,
      cutoverSourceCommit: args.cutover_source_commit,
      cutoverProjectorSha256: args.cutover_projector_sha256,
      cutoverSourceTaskId: args.cutover_source_task_id,
      cutoverSourceTaskRevision: args.cutover_source_task_revision,
      initialNativeTest: args.initial_native_test,
      nativeResolutionReview: args.native_resolution_review,
      ...(args.squash_source_task_id != null ? {
        squashSourceTaskId: args.squash_source_task_id,
        squashSourceTaskRevision: args.squash_source_task_revision,
        squashBaselineResultCommit: args.squash_baseline_result_commit,
        squashNewResultCommit: args.squash_new_result_commit,
        squashDevAfterTree: args.squash_dev_after_tree,
        squashProofRequestId: args.squash_proof_request_id,
        expectedSquashTransferHash: args.expected_squash_transfer_hash,
        squashCutoverSourceTree: args.squash_cutover_source_tree,
        squashCutoverExpectedMainCommit: args.squash_cutover_expected_main_commit,
        squashCutoverExpectedDevCommit: args.squash_cutover_expected_dev_commit,
        squashCutoverExpectedPreservedTree: args.squash_cutover_expected_preserved_tree,
        squashCutoverSourceZipSha256: args.squash_cutover_source_zip_sha256,
        squashCutoverBundleSha256: args.squash_cutover_bundle_sha256,
        squashCutoverManifestSha256: args.squash_cutover_manifest_sha256,
        squashCutoverFilesSha256: args.squash_cutover_files_sha256,
        expectedSquashCutoverHash: args.expected_squash_cutover_hash,
      } : {}),
      selectedBundlePath: args.selected_proof_bundle_path,
      selectedBundleSha256: args.selected_proof_bundle_sha256,
      selectedPublishedResolution: args.selected_published_resolution,
      selectedAbsorptionHandoff: args.selected_absorption_handoff,
      selectedProofCommit: args.selected_proof_commit,
      selectedPreviewRequestId: args.selected_preview_request_id,
      expectedSelectedPreviewHash: args.expected_selected_preview_hash,
      confirmed: true,
    });
  }

  async #reconcileCommittedCleanup(original, outcome, captured) {
    if (!taskCleanupIsConfirmed(captured)) return null;
    const completed = outcome.result?.result;
    let result;
    if (original.toolName === "hub_task_complete" && outcome.kind === "complete"
        && completed?.id === outcome.taskId && completed.workspaceId === original.workspaceId && completed.status === "done") {
      result = compactCompleteResult(completedLifecycleResult(outcome));
    } else if (original.toolName === "hub_task_delete" && outcome.kind === "delete" && completed?.deleted === true
        && completed.task?.id === outcome.taskId && completed.task.workspaceId === original.workspaceId) {
      result = { ...completed, task: compactTask(completed.task), ...outcome.result.evidence };
    } else return null;
    const reconciliation = { kind: "committed-task-cleanup-v1", lifecycleOperationId: original.requestId };
    await this.workspaceCatalog.completeUnknownMcpOperation(original.requestId, {
      workspaceId: original.workspaceId, toolName: original.toolName, result, reconciliation,
    });
    return { resolved: true, outcome: "succeeded", operationId: original.requestId, result, reconciliation };
  }

  async #reconcileConfirmedDelete(context, args) {
    const refuse = message => { throw new TaskOperationReconciliationRefusedError(new Error(message)); };
    if (Object.keys(args).some(k => !["context_token", "request_id", "task_id", "operation_request_id", "confirm_reconcile",
      "cleanup_preview_request_id", "cleanup_preserved_files", "project_root"].includes(k))) refuse("Delete reconciliation accepts only the exact cleanup family");
    const original = this.workspaceCatalog.mcpOperation(args.operation_request_id);
    const preview = this.workspaceCatalog.mcpOperation(args.cleanup_preview_request_id);
    const prior = preview?.result;
    const tokenArguments = { request_id: args.operation_request_id, task_id: args.task_id, expected_cleanup_token: prior?.cleanupToken };
    const captured = original?.taskExecution?.arguments ?? (argumentsHash(tokenArguments) === original?.argumentsHash
      ? tokenArguments : { request_id: args.operation_request_id, task_id: args.task_id, confirm_cleanup: true,
        expected_cleanup_token: prior?.cleanupToken });
    if (!original || original.toolName !== "hub_task_delete" || original.workspaceId !== context.workspaceId
        || !["pending", "unknown", "reconciling", "succeeded"].includes(original.status)
        || !preview || preview.toolName !== "hub_task_delete" || preview.status !== "succeeded"
        || preview.workspaceId !== original.workspaceId
        || prior?.task?.id !== args.task_id || prior.action !== "delete" || prior.confirmationRequired !== true
        || !prior.preview || !taskCleanupIsConfirmed(captured) || captured.expected_cleanup_token !== prior.cleanupToken
        || captured.request_id !== args.operation_request_id || captured.task_id !== args.task_id
        || argumentsHash(captured) !== original.argumentsHash) refuse("Delete requires its exact original successful preview and confirmed argument hash");
    const outcome = this.taskBoard.lifecycleOutcome(original.requestId);
    const files = args.cleanup_preserved_files ?? [];
    const expectedAuthority = { previewRequestId: preview.requestId, originalArguments: captured, preservedFiles: files, preview: prior.preview };
    let result;
    if (outcome) {
      if (outcome.taskId !== args.task_id || outcome.kind !== "delete"
          || JSON.stringify(outcome.result?.evidence?.cleanupForward?.authority) !== JSON.stringify(expectedAuthority)) refuse("Original Delete terminal authority differs");
      result = { deleted: true, task: outcome.result.result.task, cleanup: outcome.result.evidence.cleanup };
    } else result = await this.taskLifecycle.resumeConfirmedDelete({ taskId: args.task_id, operationId: original.requestId,
      priorPreview: prior, originalArguments: captured, preservedFiles: files, previewRequestId: preview.requestId });
    if (!result?.deleted || result.task?.id !== args.task_id) throw Error("Original Delete has no canonical completion");
    result = { ...result, task: compactTask(result.task) };
    if (original.status === "unknown") await this.workspaceCatalog.completeUnknownMcpOperation(original.requestId, {
      workspaceId: context.workspaceId, toolName: "hub_task_delete", result,
      reconciliation: { kind: "confirmed-delete-forward-v1", lifecycleOperationId: original.requestId },
    });
    else if (original.status !== "succeeded") await this.workspaceCatalog.completeMcpOperation(original.requestId, result);
    return { taskId: args.task_id, operationId: original.requestId, outcome: "COMPLETED", result };
  }

  async #reconcilePublishedDeliveryComplete(context, args) {
    const refuse = message => { throw new TaskOperationReconciliationRefusedError(new Error(message)); };
    const previewOriginal = this.workspaceCatalog.mcpOperation(args.operation_request_id);
    if (previewOriginal?.taskExecution?.arguments?.completion_mode === "abandoned_release_service"
        && !taskCleanupIsConfirmed(previewOriginal.taskExecution.arguments)) {
      return this.#reconcileAbandonedReleasePreview(context, args, previewOriginal);
    }
    const originalArchive = this.workspaceCatalog.mcpOperation(args.operation_request_id);
    const archiveTransition = this.taskBoard.lifecycleTransition?.(args.operation_request_id);
    const archiveOutcome = this.taskBoard.lifecycleOutcome?.(args.operation_request_id);
    const archiveEvidence = archiveOutcome?.result?.evidence ?? archiveTransition?.evidence;
    if (archiveEvidence?.archive === true) {
      const captured = archiveEvidence.originalArguments;
      if (Object.keys(args).some(key => !["context_token", "request_id", "task_id", "operation_request_id",
        "confirm_reconcile", "expected_arguments_hash"].includes(key))
        || !originalArchive || originalArchive.workspaceId !== context.workspaceId
        || originalArchive.toolName !== "hub_task_complete" || captured?.completion_mode !== "archive"
        || captured.task_id !== args.task_id || captured.request_id !== originalArchive.requestId
        || !taskCleanupIsConfirmed(captured) || argumentsHash(captured) !== originalArchive.argumentsHash
        || (args.expected_arguments_hash && args.expected_arguments_hash !== originalArchive.argumentsHash)
        || (archiveTransition && (archiveTransition.taskId !== args.task_id || archiveTransition.kind !== "complete"
          || archiveTransition.phase !== "cleanup"))
        || (archiveOutcome && (archiveOutcome.taskId !== args.task_id || archiveOutcome.kind !== "complete"))
        || !["pending", "reconciling", "unknown", "succeeded"].includes(originalArchive.status)) {
        refuse("Archive requires its exact admitted original");
      }
      const result = archiveOutcome ? compactCompleteResult(completedLifecycleResult(archiveOutcome))
        : await this.#completeTask(context, captured);
      if (originalArchive.status === "unknown") await this.workspaceCatalog.completeUnknownMcpOperation(originalArchive.requestId, {
        workspaceId: context.workspaceId, toolName: "hub_task_complete", result,
        reconciliation: { kind: "task-archive-original-v1", lifecycleOperationId: originalArchive.requestId },
      });
      else if (originalArchive.status !== "succeeded") await this.workspaceCatalog.completeMcpOperation(originalArchive.requestId, result);
      return { taskId: args.task_id, operationId: originalArchive.requestId,
        originalArgumentsHash: originalArchive.argumentsHash,
        outcome: result.confirmationRequired ? "CONFIRMATION_REQUIRED" : "COMPLETED",
        result };
    }
    if (args.manual_preview_arguments) {
      const captured = args.manual_preview_arguments;
      const original = this.workspaceCatalog.mcpOperation(args.operation_request_id);
      if (Object.keys(args).some(k => !["context_token", "request_id", "task_id", "operation_request_id", "confirm_reconcile", "expected_arguments_hash", "manual_preview_arguments"].includes(k))
          || Object.keys(captured).some(k => !["request_id", "task_id", "completion_mode", "manual_delivery", "confirm_cleanup"].includes(k))
          || captured.confirm_cleanup != null && captured.confirm_cleanup !== false
          || captured.completion_mode !== "manual_delivery" || captured.task_id !== args.task_id
          || captured.request_id !== args.operation_request_id || !captured.manual_delivery
          || !original || original.workspaceId !== context.workspaceId || original.toolName !== "hub_task_complete"
          || original.status !== "unknown" || original.argumentsHash !== args.expected_arguments_hash
          || argumentsHash(captured) !== original.argumentsHash
          || this.taskBoard.lifecycleTransition?.(original.requestId) || this.taskBoard.lifecycleOutcome?.(original.requestId)) {
        refuse("Only the exact hash-bound read-only manual Complete preview can be classified");
      }
      // The positive proof is the immutable original argument form: this
      // preview cannot enter the lifecycle mutation branch. Absence alone is
      // never sufficient, and confirmed originals cannot use this path.
      await this.workspaceCatalog.failUnknownMcpOperation(original.requestId, {
        workspaceId: context.workspaceId, toolName: original.toolName,
        error: original.error || "Read-only manual Complete preview failed",
        reconciliation: { kind: "manual-complete-read-only-preview-v1", outcome: "NO_EFFECT", originalArguments: captured },
      });
      return { taskId: args.task_id, operationId: original.requestId, outcome: "NO_EFFECT", readOnlyPreview: true };
    }
    if (Object.keys(args).some(k => !["context_token", "request_id", "task_id", "operation_request_id", "confirm_reconcile", "project_root"].includes(k))) refuse("Complete reconciliation accepts only its original identity");
    const original = this.workspaceCatalog.mcpOperation(args.operation_request_id);
    const transition = this.taskBoard.lifecycleTransition?.(args.operation_request_id);
    const outcome = this.taskBoard.lifecycleOutcome?.(args.operation_request_id);
    const evidence = outcome?.result?.evidence ?? transition?.evidence;
    const captured = evidence?.originalArguments;
    const abandoned = captured?.completion_mode === "abandoned_release_service"
      && evidence?.releaseService?.mode === "abandoned_release_service";
    const deliveredTaskId = abandoned ? evidence.releaseService.source?.taskId
      : captured?.completion_mode === "manual_delivery" ? evidence?.manualDelivery?.taskId : evidence?.publishedDelivery?.taskId;
    if (!original || original.workspaceId !== context.workspaceId || original.toolName !== "hub_task_complete"
        || deliveredTaskId !== args.task_id || !captured
        || captured.task_id !== args.task_id || captured.request_id !== original.requestId
        || !["published_delivery", "operational", "manual_delivery", "abandoned_release_service"].includes(captured.completion_mode) || !taskCleanupIsConfirmed(captured)
        || argumentsHash(captured) !== original.argumentsHash
        || (transition && (transition.taskId !== args.task_id || transition.kind !== "complete" || transition.phase !== "cleanup"))
        || (outcome && (outcome.taskId !== args.task_id || outcome.kind !== "complete"))) {
      refuse("Complete requires its exact admitted direct-publication cleanup or terminal outcome; unsealed originals remain unknown");
    }
    if (!["pending", "reconciling", "unknown", "succeeded"].includes(original.status)) refuse("Original Complete has a different terminal outcome");
    const result = outcome ? compactTask(outcome.result.result) : await this.#completeTask(context, captured);
    if (result?.id !== args.task_id || result?.status !== "done") throw Error("Original direct cleanup did not finish");
    if (original.status === "unknown") await this.workspaceCatalog.completeUnknownMcpOperation(original.requestId, {
      workspaceId: context.workspaceId, toolName: "hub_task_complete", result,
      reconciliation: { kind: abandoned ? "abandoned-release-service-original-v1"
        : captured.completion_mode === "manual_delivery" ? "manual-delivery-completion-original-v1"
        : "direct-published-cleanup-original-v1", lifecycleOperationId: original.requestId },
    });
    else if (original.status !== "succeeded") await this.workspaceCatalog.completeMcpOperation(original.requestId, result);
    return { taskId: args.task_id, operationId: original.requestId, outcome: "COMPLETED", result };
  }

  async #reconcileAbandonedReleasePreview(context, args, original) {
    const refuse = message => { throw new TaskOperationReconciliationRefusedError(new Error(message)); };
    const execution = original.taskExecution, captured = execution?.arguments, input = captured?.abandoned_release;
    if (Object.keys(args).some(key => !["context_token", "request_id", "task_id", "operation_request_id",
      "expected_arguments_hash", "confirm_reconcile"].includes(key))
        || original.toolName !== "hub_task_complete" || original.workspaceId !== context.workspaceId
        || args.expected_arguments_hash !== original.argumentsHash || execution?.protocol !== "task-operation-interruption-v1"
        || !execution.ownerId || execution.cancellation || execution.taskId !== args.task_id
        || execution.taskWorkspaceId !== context.workspaceId || !captured || captured.task_id !== args.task_id
        || captured.request_id !== original.requestId || argumentsHash(captured) !== original.argumentsHash
        || captured.completion_mode !== "abandoned_release_service"
        || (captured.confirm_cleanup !== undefined && captured.confirm_cleanup !== false)
        || Object.keys(captured).some(key => !["request_id", "task_id", "completion_mode", "abandoned_release", "confirm_cleanup"].includes(key))
        || !input || Array.isArray(input) || Object.keys(input).some(key => !["operationId", "expectedRevision", "expectedGeneration"].includes(key))
        || this.taskBoard.lifecycleTransition?.(original.requestId) || this.taskBoard.lifecycleOutcome?.(original.requestId)
        || !["unknown", "succeeded"].includes(original.status)) {
      refuse("Abandoned preview original identity or arguments differ");
    }
    if (original.status === "succeeded") {
      if (original.result?.confirmationRequired !== true || !original.result.cleanupToken) refuse("Abandoned preview has no exact stored readback");
      return { taskId: args.task_id, operationId: original.requestId, outcome: "PREVIEW_RECOVERED", result: original.result };
    }
    // This exact argument family can only read a preview. Never dispatch a
    // confirmed Complete, create an archive intent or adopt operational UNKNOWN.
    const result = await this.#completeTask(context, captured);
    if (result?.confirmationRequired !== true || !result.cleanupToken || result.preview?.deleting?.length !== 0
        || result.preview?.releaseService?.mode !== "abandoned_release_service"
        || this.taskBoard.lifecycleTransition?.(original.requestId) || this.taskBoard.lifecycleOutcome?.(original.requestId)
        || JSON.stringify(this.workspaceCatalog.mcpOperation(original.requestId)) !== JSON.stringify(original)) {
      refuse("Abandoned preview original changed during readback");
    }
    const completed = await this.workspaceCatalog.completeUnknownMcpOperation(original.requestId, {
      workspaceId: context.workspaceId, toolName: original.toolName, result,
      reconciliation: { kind: "abandoned-release-preview-readback-v1", originalArguments: captured,
        priorReceipt: { status: original.status, error: original.error, result: original.result,
          createdAtMs: original.createdAtMs, completedAtMs: original.completedAtMs } },
    });
    return { taskId: args.task_id, operationId: original.requestId, outcome: "PREVIEW_RECOVERED", result: completed.result };
  }

  async #reconcileSealedClaimRefusal(context, args) {
    const refuse = message => { throw new TaskOperationReconciliationRefusedError(new Error(message)); };
    if (Object.keys(args).some(key => !["context_token", "request_id", "task_id", "operation_request_id",
      "project_root", "confirm_reconcile"].includes(key))) refuse("Claim refusal readback accepts no workflow or operator proof fields");
    const receipt = this.workspaceCatalog.mcpOperation(args.operation_request_id);
    const proof = this.#claimAdmissionRefusal(receipt, args.task_id);
    if (!receipt || receipt.workspaceId !== context.workspaceId || !proof
        || this.workspaceCatalog.claimCustodyForOriginal?.(receipt.requestId)) {
      refuse("Claim requires exact durable pre-admission owner evidence; unsealed or admitted originals remain unknown");
    }
    const root = proof.lockAdmission?.repositoryRoot ?? proof.sourceAdmission?.projectRoot;
    const locator = value => process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
    if (root && (typeof args.project_root !== "string" || locator(args.project_root) !== locator(root))) {
      refuse("Claim refusal repository locator does not match the sealed owner");
    }
    if (receipt.status === "unknown") {
      await this.workspaceCatalog.failUnknownMcpOperation(receipt.requestId, {
        workspaceId: context.workspaceId, toolName: "hub_task_claim", error: claimAdmissionRefusalError(proof),
        reconciliation: { outcome: "NO_EFFECT", evidence: proof },
      });
    } else if (receipt.status === "pending" || receipt.status === "reconciling") {
      await this.workspaceCatalog.beginMcpOperationReconciliation(receipt.requestId);
      await this.workspaceCatalog.failMcpOperation(receipt.requestId, claimAdmissionRefusalError(proof), {
        outcome: "NO_EFFECT", evidence: proof,
      });
    } else if (receipt.status !== "failed") refuse("Claim receipt is not a refused original");
    return { taskId: proof.taskId, operationId: receipt.requestId, outcome: "NO_EFFECT", evidence: proof };
  }

  #hasPreparedTaskStart(context, args, requestId) {
    try {
      const task = this.#task(context, args.task_id);
      return task.startRequestId === requestId && ["starting", "started"].includes(task.status);
    } catch {
      return false;
    }
  }

}
