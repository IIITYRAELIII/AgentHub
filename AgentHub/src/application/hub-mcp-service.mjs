import { TaskOperationInterruption, INTERRUPTIBLE_TASK_TOOLS, taskOperationInterrupted } from "./task-operation-interruption.mjs";
import { createHash, createHmac, timingSafeEqual, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, realpath, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  MAX_ATTACHMENT_BYTES,
  attachmentContentType,
  attachmentMetadataFromId,
  taskAttachmentDescriptors,
  createAttachmentStorageName,
} from "../domain/attachment-files.mjs";
import {
  createInterstreamOrigin,
  createInterstreamMessage,
  interstreamAuditContentHash,
  interstreamDisplayText,
} from "../domain/interstream-message.mjs";
import { canonicalMcpValue, mcpArgumentsHash } from "../domain/mcp-arguments-hash.mjs";
import { claimCustodyHash, claimCustodyState, assertClaimCustodyOriginal, TaskClaimCustodyRejectedError, TaskClaimContinuationWithdrawnError } from "../domain/claim-forward-custody.mjs";
import { taskProjectRoot } from "../domain/task-project-root.mjs";
import { normalizedInitialNativeTest } from "../domain/task-git-reference.mjs";
import {
  normalizedTaskDescription,
  normalizedTaskText,
  normalizedTaskTitle,
  TASK_TITLE_MAX_LENGTH,
  TaskDependencyPendingError,
  TaskLifecycleBeginRejectedError,
  TaskLifecycleNoEffectError,
  TaskOperationReconciliationRefusedError,
  workflowAdmissionNoEffectEvidence, claimAdmissionNoEffectEvidence, claimAdmissionRefusalError, TaskClaimExecutorBusyError,
  ReleaseCandidateFrozenError,
  TaskAbsorptionCompositionError,
} from "../domain/task-board-task.mjs";
import { taskRunIsActive } from "../domain/task-runs.mjs";
import { displayUserPrompt } from "./task-history.mjs";
import { TaskLifecycleService, TaskIntegrationConflictError, TaskAwaitIntegrationError, TaskWithdrawalDependencyError, TaskWithdrawalBusyError, TaskSquashTransferRejectedError } from "./task-lifecycle-service.mjs";
import { TaskOperationReconciliationService } from "./task-operation-reconciliation-service.mjs";
import { TaskIntegrationRejectedError } from "./task-lifecycle-service.mjs";
import { createWorkspaceCatalogMutationOwner } from "./sqlite-mutation-owner.mjs";

import { assertPreparationRows, readPreparationSourceClosure, ReleasePreparationRejectedError,
  validatePreparationEnvelope, preparationSourceRoot } from "./release-preparation-admission.mjs";
import { FORWARD_PREPARATION, preparationLegacyIdentity, preparationLegacyHash,
  validatePreparationForward, inspectPreparationForwardCustody } from "./release-preparation-forward.mjs";

import { normalizedNativeResolution } from "../domain/native-resolution-input.mjs";

const CONTEXT_TOKEN_VERSION = 1;
const MAX_REGISTERED_CONTEXT_CAPABILITIES = 1_000;
const STREAM_HISTORY_CURSOR_VERSION = 1;
const DEFAULT_HISTORY_ACTIVITY_LIMIT = 40;
const DEFERRED_INPUT_STALLED_AFTER_MS = 60_000;
const MUTATING_TOOLS = new Set([
  "hub_task_create", "hub_task_update", "hub_task_checklist_update", "hub_task_move", "hub_task_start", "hub_task_reassign", "hub_task_launch_cancel", "hub_task_claim", "hub_task_status_update", "hub_task_operation_cancel", "hub_task_legacy_git_adopt", "hub_task_complete", "hub_task_delete",
  "hub_task_attachment_add", "hub_workspace_rules_update", "hub_stream_rules_update",
  "hub_stream_message_send",
  "hub_task_operation_reconcile",
  "hub_release_run", "hub_release_continue", "hub_release_prepare", "hub_release_prepare_resume",
]);

// Only the synchronous input boundary below can produce this proof of no effects.
class TaskInputValidationError extends Error {}

function definiteMcpMutationFailure(error) {
  return error instanceof TaskClaimCustodyRejectedError || error instanceof ReleasePreparationRejectedError || error instanceof TaskInputValidationError
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
      required: ["context_token", ...(mutating ? ["request_id"] : []), ...required],
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
    workspaceCatalog, taskBoard, workLog, attachmentDirectory, secret, releasePlanner, releasePreflight, releaseCompleter,
    releaseOperations = null,
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
    requiredMethod(releasePreflight, "preflight");
    requiredMethod(releaseCompleter, "completeRelease");
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
    this.releaseCompleter = releaseCompleter;
    this.releasePlanner = releasePlanner;
    this.releaseOperations = releaseOperations;
    this.recordCommandTrace = recordCommandTrace;
    this.taskGitWorkspaces = taskGitWorkspaces;
    this.claimCustodyRuntime = claimCustodyRuntime;
    this.taskLifecycle = taskLifecycle ?? new TaskLifecycleService({
      taskBoard, workspaceCatalog: this.workspaceCatalog, taskGitWorkspaces, releasePreflight,
    });
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
        })
        : null);
    this.taskOperationInterruption = typeof this.workspaceCatalog.bindTaskOperationExecution === "function"
      ? new TaskOperationInterruption({ catalog: this.workspaceCatalog, tasks: this.taskBoard,
        taskGit: this.taskGitWorkspaces, runtime: this.claimCustodyRuntime, record: this.recordCommandTrace }) : null;
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
          result = compactTask(outcome.result?.result);
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
    this.releaseOperations?.setEventDelivery?.(async (event) => {
      const commandId = `release:${event.operationId}:${event.revision}:${event.eventKind}`;
      const operationSpanId = randomUUID();
      const metadata = { operationSpanId, operationId: event.operationId,
        revision: event.revision, eventKind: event.eventKind };
      const record = (span) => {
        try { this.recordCommandTrace({ commandId, transport: "release-operation", ...span }); }
        catch { /* Diagnostics cannot change event delivery or its original outcome. */ }
      };
      const createdAtMs = Date.parse(String(event.createdAt ?? ""));
      if (Number.isSafeInteger(createdAtMs) && createdAtMs > 0) record({
        stage: "release-event-created", outcome: "succeeded", observedAtMs: createdAtMs, metadata,
      });
      const started = performance.now();
      record({ stage: "release-event-intake", outcome: "started", metadata });
      try {
        const result = await value({
          streamId: event.streamId,
          text: `<agent-hub-release-event>\n${JSON.stringify({
            operationId: event.operationId,
            revision: event.revision,
            eventKind: event.eventKind,
            ...event.payload,
          })}\n</agent-hub-release-event>`,
          clientUserMessageId: commandId,
          followUpMode: "steer",
        }, {
          source: "release-operation",
          clientId: `release:${event.operationId}`,
          messageOrigin: { kind: "release-operation", sourceThreadId: event.threadId },
        });
        record({ stage: "release-event-intake", outcome: "succeeded",
          monotonicDurationMs: performance.now() - started,
          metadata: { ...metadata, intakeAccepted: result?.accepted === true,
            providerAccepted: result?.providerAccepted === true || result?.steered === true,
            steerPending: result?.steerPending === true, queued: result?.queued === true } });
        return result;
      } catch (error) {
        const code = String(error?.code ?? "");
        record({ stage: "release-event-intake", outcome: "unknown",
          monotonicDurationMs: performance.now() - started,
          metadata: { ...metadata, errorCode: /^[A-Z0-9_]{1,100}$/u.test(code) ? code : null } });
        throw error;
      }
    });
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
          description: "Queue after the active turn, or request exact steering of the current managed run. An undeliverable exact steer requires an explicit retry or queue decision.",
        },
        confirm_send: { type: "boolean", description: "Must be true because this starts, queues or steers another agent turn." },
      }, ["stream_id", "text", "confirm_send"]),
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
        confirm_launch: { type: "boolean", description: "Must be true because this starts or queues another agent turn." },
      }, ["task_id", "confirm_launch"]),
      tool("hub_task_reassign", "Reassign a started Dashboard task to an existing or new Stream. The current executor must have no active turn or queued input.", {
        task_id: { type: "string" },
        workspace_id: { type: "string", description: "Workspace for new_stream_name, or consistency check for stream_id." },
        stream_id: { type: "string", description: "Globally unique existing target Stream ID." },
        new_stream_name: { type: "string", description: "Create a new target Stream instead of using stream_id." },
        provider: { type: "string", enum: ["codex", "claude"] },
        message: { type: "string", description: "Optional assignment message delivered together with the Task reference." },
        confirm_launch: { type: "boolean", description: "Must be true because this starts or queues another agent turn." },
      }, ["task_id", "confirm_launch"]),
      tool("hub_task_launch_cancel", "Release Manager-only exact reconciliation that cancels an unlaunched new-Stream Task start before another assignment.", {
        task_id: { type: "string" },
        launch_request_id: { type: "string", description: "Original hub_task_start request_id retained by the prepared Task." },
        expected_task_revision: { type: "integer", minimum: 1 },
        confirm_cancel: { type: "boolean", description: "Must be true because this terminalizes the original launch receipt." },
      }, ["task_id", "launch_request_id", "expected_task_revision", "confirm_cancel"]),
      tool("hub_task_claim", "Bind a Dashboard Task to the exact current provider turn, assign its dedicated Git branch/worktree, and make the current Stream its executor. Continue repository work only in the returned gitWorkspace.projectRoot.", {
        task_id: { type: "string" },
        dependency_mode: { type: "string", enum: ["skip", "ensure", "verify"], description: "Default skip: prepare only Git. Before running dependency-dependent tests/builds use ensure; use verify for suspected dependency damage. Existing matching dependencies are reused." },
        forward_custody_request_id: { type: "string", description: "Exact durable forward fence; uses preserved workspace without prepare/dependency replay. Historical original stays UNKNOWN." },
        dependency_override_reason: { type: "string", maxLength: 2000, description: "Only for an explicit user instruction to bypass a prerequisite release wait, e.g. Task consolidation. Persist that instruction here; ordinary start is not an override." },
      }, ["task_id"]),
      tool("hub_task_status_update", "Change workflow status only after exact Git result evidence is integrated. Test/Await/Done fail closed when no result or integration fails. Await also composes the accepted result into PreRelease before it commits: a composition conflict leaves the Task in Test with the last good candidate.", {
        task_id: { type: "string" },
        status: { type: "string", enum: ["new", "in_progress", "blocked", "testing", "awaiting_implementation", "done"] },
        expected_task_revision: { type: "integer", minimum: 1, description: "Optional exact current Task revision CAS." },
        expected_workflow_status: { type: "string", enum: ["new", "in_progress", "blocked", "testing", "awaiting_implementation", "done"], description: "Optional exact current workflow status CAS." },
        cutover_source_commit: { type: "string", description: "Optional clean checkout commit recorded by a local cutover." },
        cutover_projector_sha256: { type: "string", description: "Optional verified release-projector hash recorded by a local cutover." },
        squash_source_task_id: { type: "string", description: "Release Manager-only source Task whose exact result is transferred into this survivor." },
        squash_source_task_revision: { type: "integer", minimum: 1 },
        squash_baseline_result_commit: { type: "string", pattern: "^[0-9a-f]{40}$" },
        squash_new_result_commit: { type: "string", pattern: "^[0-9a-f]{40}$" },
        squash_dev_after_tree: { type: "string", pattern: "^[0-9a-f]{40}$" },
        squash_proof_request_id: { type: "string", description: "On confirmation, the exact request_id of the read-only squash preview." },
        expected_squash_transfer_hash: { type: "string", pattern: "^[0-9a-f]{64}$", description: "Omit for an exact preview; confirm a later request with the returned hash." },
        selected_proof_bundle_path: { type: "string", description: "Release Manager-only immutable selected-composition proof bundle; preview has no live Git or lifecycle effect." },
        selected_proof_bundle_sha256: { type: "string", pattern: "^[0-9a-f]{64}$" },
        selected_published_resolution: { type: "object", description: "Historical original reconciliation envelope; new selected materialization admission is closed." },
        selected_absorption_handoff: { type: "object", description: "Authenticated saved/stopped handoff for ordinary native Test, bound to exact Task CAS and the original receipt." },
        native_resolution_review: { type: "object", description: "Exact independent inter-Stream verdict, or {bundlePath,bundleSha256,reviews} for reviewed Await prefixes. The existing sequencer authenticates every exact binding." },
        selected_proof_commit: { type: "string", pattern: "^[0-9a-f]{40}$" },
        selected_preview_request_id: { type: "string", description: "Exact original preview request_id on confirmation." },
        expected_selected_preview_hash: { type: "string", pattern: "^[0-9a-f]{64}$", description: "Omit for preview; exact returned hash is required for confirmation." },
      }, ["task_id", "status"]),
      tool("hub_task_operation_get", "Read the exact original Task operation and its durable terminal result without replay. Pending with active=true is accepted live work, not UNKNOWN. Keep the original request ID; verify expected_arguments_hash or original_arguments after a lost reply.", {
        operation_request_id: { type: "string" },
        expected_arguments_hash: { type: "string" },
        original_arguments: { type: "object", additionalProperties: true },
        task_id: { type: "string" },
      }, ["operation_request_id"]),
      tool("hub_task_operation_cancel", "Explicitly stop one exact claim/Test/Await worker, preserving its original receipt and prior unknown effects. Own Stream or RM only. Historical workers require verified retirement; a requested cancellation is not yet stopped.", {
        task_id: { type: "string" }, operation_request_id: { type: "string" },
        request_id: { type: "string" }, expected_arguments_hash: { type: "string" },
        expected_task_revision: { type: "integer" }, confirm_cancel: { type: "boolean" },
        original_arguments: { type: "object", description: "Exact original argument family for a legacy receipt without execution binding; never context_token." },
        runtime_witness: { type: "object", description: "Existing trusted retained native runtime witness for a historical worker." },
      }, ["task_id", "operation_request_id", "request_id", "expected_arguments_hash", "expected_task_revision", "confirm_cancel"]),
      tool("hub_task_operation_reconcile", "Release Manager-only reconciliation of one exact unknown Task workflow operation. A real unresolved process guard requires trusted proof; exact pending withdrawal or squash state can reconcile without inventing one. An already terminal lifecycle settles its original receipt without Git replay.", {
        task_id: { type: "string" },
        operation_request_id: { type: "string" },
        claim_custody: { type: "object", description: "Explicit RM forward ownership recovery, not historical NO_EFFECT. The default requires exact positive legacy retirement. Separately authorized isolated-source-v1 instead stages an independent full-object source/ref authority and fences legacy SQL writers. Two distinct exact request IDs.",
          properties: { action: { type: "string", enum: ["prepare", "fence"] },
            admission: { type: "string", enum: ["isolated-source-v1"] },
            authorization_id: { type: "string" }, handoff_id: { type: "string" },
            expected_original: { type: "object" }, original_arguments: { type: "object" },
            expected_task_revision: { type: "integer", minimum: 1 }, expected_owner_stream_id: { type: ["string", "null"] },
            successor_claim_request_id: { type: "string" }, source: { type: "object" }, runtime_witness: { type: "object", description: "Exact independently retained read-only native witness artifact: sourcePath/rawSha256. No caller-supplied retirement boolean." },
            plan_request_id: { type: "string" }, expected_plan_hash: { type: "string", pattern: "^[a-f0-9]{64}$" } },
          required: ["action"], additionalProperties: false },
        project_root: { type: "string", description: "Required for Git reconciliation or an owner refusal with a recorded root. May be omitted only for an exact durable pre-admission refusal whose recorded root is null; a supplied locator grants no Git authority in that case." },
        guard_id: { type: "string", description: "Required for an actually guarded pending operation. Exact persisted Task withdrawal or squash state without a process guard can reconcile without it." },
        proof_kind: { type: "string", enum: ["system-restart-after-guard"], description: "Required when recovering a process-tree guard." },
        proof_summary: { type: "string", description: "Required when recovering a process-tree guard." },
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
        confirm_reconcile: { type: "boolean", description: "Must be true because this settles the original unknown receipt and may recover a guarded process boundary." },
      }, ["task_id", "operation_request_id", "confirm_reconcile"]),
      tool("hub_task_legacy_git_adopt", "Release Manager-only migration for a legacy Await Task with no Git reference. It verifies terminal Stream evidence and exact non-changelog patch equivalence to a named commit already in local main before recording immutable Task evidence.", {
        task_id: { type: "string" },
        expected_task_revision: { type: "integer", minimum: 1 },
        evidence_turn_id: { type: "string" },
        reported_result_commit: { type: "string" },
        main_result_commit: { type: "string" },
        confirm_adoption: { type: "boolean", description: "Must be true because this creates release-authority Git references for legacy work." },
      }, ["task_id", "expected_task_revision", "evidence_turn_id", "reported_result_commit", "main_result_commit", "confirm_adoption"]),
      tool("hub_task_complete", "Preview, then confirm closing a Task. Use absorbed_into_task_id after agent-led consolidation. Release Managers may close a verified published zero-delta duplicate or published release service Task without fabricating a result or deleting its worktree.", {
        task_id: { type: "string" },
        confirm_cleanup: { type: "boolean" },
        expected_cleanup_token: { type: "string" },
        absorbed_into_task_id: { type: "string", description: "Surviving tested Task that contains the source work. The source must already be returned from Test/Await." },
        absorption_mode: { type: "string", enum: ["published_duplicate"], description: "Release Manager-only mode for an open zero-own-delta source whose survivor is already Done and exactly published." },
        completion_mode: { type: "string", enum: ["published_release_service"], description: "Release Manager-only closure for a published service release Task with exact manifest/checklist linkage; preserves its managed worktree." },
      }, ["task_id"]),
      tool("hub_task_delete", "Preview, then explicitly confirm permanent destructive deletion of a Task and its managed Git artifacts.", {
        task_id: { type: "string" },
        confirm_cleanup: { type: "boolean" },
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
      tool("hub_release_plan_get", "Read the complete release plan and exact integrated dev heads for any existing Workspace.", {
        workspace_id: { type: "string", description: "Defaults to the caller Workspace." },
      }),
      tool("hub_release_prepare", "Release Manager-only preparation of the exact current accepted set. Binds fresh CAS, publication, source closure and reviewed tree; preserves Task transitions and original Await receipts. Does not validate, publish or install a release.", {
        preparation: { type: "object", description: "Exact schemaVersion=1 preparation envelope defined by REL-001; unknown or missing fields fail closed." },
      }, ["preparation"]),
      tool("hub_release_prepare_get", "Read the exact original preparation receipt. Unknown remains unknown; current candidate state never settles an original.", {
        preparation_request_id: { type: "string" },
        expected_arguments_hash: { type: "string", pattern: "^[a-f0-9]{64}$" },
      }, ["preparation_request_id", "expected_arguments_hash"]),
      tool("hub_release_prepare_resume", "Continue the SAME preparation from its saved owner stage, or its already established isolated forward custody. The owner checks fresh leases, source, selection and actual Git; an untransferred legacy UNKNOWN cannot resume.", {
        expected_arguments_hash: { type: "string", pattern: "^[a-f0-9]{64}$" },
        expected_preparation_revision: { type: "integer", minimum: 0 },
        native_resolution_review: { type: "object", description: "Optional exact reviewed resolution bundle for an already isolated legacy forward original; does not replace original arguments." },
      }, ["expected_arguments_hash", "expected_preparation_revision"]),
      tool("hub_release_run", "Persist one authorized release operation and return its operation id immediately. The durable owner continues compose, validation, publication and finalization without holding this MCP request open.", {
        workspace_id: { type: "string", description: "Defaults to the caller Workspace." },
        release_version: { type: "string", pattern: "^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$", description: "Optional complete public X.Y.Z version for this new release intent. Omit for automatic patch selection. A frozen retry retains its original version." },
        task_ids: { type: "array", minItems: 1, items: { type: "string" } },
        validation_mode: { type: "string", enum: ["focused", "full"] },
        test_selection: { type: "object", additionalProperties: false, required: ["mode", "ids"], properties: {
          mode: { type: "string", enum: ["all", "include", "exclude", "none"] }, ids: { type: "array", items: { type: "string" }, uniqueItems: true },
        } },
        release_metadata: {
          type: "object",
          description: "Exact prepared CHANGELOG artifact identity; the existing release owner verifies its bytes before composition.",
          additionalProperties: false,
          properties: {
            sourcePath: { type: "string", minLength: 1 },
            byteLength: { type: "integer", minimum: 1 },
            rawSha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
            canonicalSha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
          },
          required: ["sourcePath", "byteLength", "rawSha256", "canonicalSha256"],
        },
        approved_targets: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              targetId: { type: "string" },
              kind: { type: "string" },
              repositoryRoot: { type: "string" },
              environment: { type: "string" },
              approvedLocalMainCommit: { type: "string" },
              approvedOriginMainCommit: { type: "string" },
              nativeResolutionReview: { type: "object", description: "Exact authenticated review, or {bundlePath,bundleSha256,reviews} for already reviewed native resolutions. The sequencer verifies each binding before checkout." },
            },
            required: ["targetId", "kind"],
          },
        },
      }, ["task_ids", "validation_mode", "approved_targets"]),
      tool("hub_release_get", "Read one durable release operation, immutable candidate generations, step receipts and delivery events.", {
        operation_id: { type: "string" },
      }, ["operation_id"]),
      tool("hub_release_continue", "Wake an existing waiting release operation without changing its original authorization or creating a new operation.", {
        operation_id: { type: "string" },
        test_selection: { type: "object", additionalProperties: false, required: ["mode", "ids"], properties: {
          mode: { type: "string", enum: ["all", "include", "exclude", "none"] }, ids: { type: "array", items: { type: "string" }, uniqueItems: true },
        } },
        release_metadata: {
          type: "object",
          description: "Exact prepared CHANGELOG artifact identity; the existing release owner verifies its bytes before composition.",
          additionalProperties: false,
          properties: {
            sourcePath: { type: "string", minLength: 1 },
            byteLength: { type: "integer", minimum: 1 },
            rawSha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
            canonicalSha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
          },
          required: ["sourcePath", "byteLength", "rawSha256", "canonicalSha256"],
        },
        task_ids: { type: "array", minItems: 1, uniqueItems: true, items: { type: "string" } },
        expected_revision: { type: "integer", minimum: 1 },
        expected_generation: { type: "integer", minimum: 1 },
        reviewed_main: { type: "object", additionalProperties: false, required: ["expectedRevision", "approvedRepositories"], properties: {
          expectedRevision: { type: "integer", minimum: 1 },
          approvedRepositories: { type: "array", minItems: 1, maxItems: 32, items: { type: "object", additionalProperties: false,
            required: ["projectRoot", "approvedLocalMainCommit", "approvedOriginMainCommit"], properties: {
              projectRoot: { type: "string" }, approvedLocalMainCommit: { type: "string" }, approvedOriginMainCommit: { type: "string" },
            } } },
        } },
      }, ["operation_id"]),
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

  #taskOperationReadback(actor, { operation_request_id: operationId, expected_arguments_hash: expectedHash,
    original_arguments: originalArguments, task_id: taskId } = {}) {
    const id = requiredText(operationId, "original operation id", 200);
    const row = this.workspaceCatalog.mcpOperation(id);
    if (!row || !this.taskOperationCanSubmit(row.toolName)
      || (actor.actorKind !== "authenticated-user" && (actor.workspaceId !== row.workspaceId
        || (!this.#isReleaseManager(actor) && (actor.streamId !== row.streamId || actor.provider !== row.provider))))) {
      throw new Error("Task operation readback identity or authority differs");
    }
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
    return { taskOperation: {
      version: 1, requestId: id, toolName: row.toolName, argumentsHash: row.argumentsHash,
      workspaceId: row.workspaceId, streamId: row.streamId, provider: row.provider, threadId: row.threadId,
      ...(row.actorKind ? { actorKind: row.actorKind } : {}),
      taskId: boundTask ?? null, status: row.status, terminal, active,
      canCancel: INTERRUPTIBLE_TASK_TOOLS.has(row.toolName) && !terminal && cancellation?.phase !== "stopped",
      phase: cancellation?.phase ?? lifecycle?.phase ?? (terminal ? row.status : active ? "executing" : "not-observed-here"),
      createdAtMs: row.createdAtMs, completedAtMs: row.completedAtMs,
      elapsedMs: Math.max(0, (row.completedAtMs ?? Date.now()) - row.createdAtMs), error: row.error,
      ...(cancellation ? { cancellation: { phase: cancellation.phase, effects: cancellation.effects } } : {}),
    }, result: row.status === "succeeded" ? row.result : null };
  }

  readDesktopTaskOperation(task, operationId, expectedHash) {
    return this.#taskOperationReadback({ actorKind: "authenticated-user" }, {
      operation_request_id: operationId, expected_arguments_hash: expectedHash, task_id: task.id,
    });
  }

  async #submitTaskOperation(context, toolName, args, invoke) {
    const requestId = requiredText(args.request_id, "request id", 200);
    const existing = this.workspaceCatalog.mcpOperation(requestId);
    if (existing) {
      if (existing.workspaceId !== context.workspaceId || existing.streamId !== context.streamId
        || existing.provider !== context.provider || existing.threadId !== context.auditThreadId
        || (existing.actorKind ?? "provider") !== (context.actorKind ?? "provider")
        || existing.toolName !== toolName || existing.argumentsHash !== argumentsHash(args)) {
        throw new Error("MCP request_id was already used for another operation");
      }
      return this.#taskOperationReadback(context, { operation_request_id: requestId, expected_arguments_hash: argumentsHash(args) });
    }
    let admitted;
    const admission = new Promise(resolve => { admitted = resolve; });
    const startedAt = performance.now();
    const record = (stage, receipt) => {
      try { this.recordCommandTrace({ commandId: requestId, transport: "task-operation", stage,
        outcome: receipt.taskOperation.terminal ? receipt.taskOperation.status : "queued",
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
      // The durable receipt, including a real UNKNOWN or cancellation, is the
      // result. A pre-admission failure has no receipt and still rejects.
      if (!this.workspaceCatalog.mcpOperation(requestId)) throw error;
      return record("task-operation-result", read());
    });
    return Promise.race([admission, completion]);
  }

  async submitTaskOperation(name, args = {}) {
    if (!this.taskOperationCanSubmit(name)) return this.call(name, args);
    const context = this.#authorize(args.context_token);
    return this.#submitTaskOperation(context, name, args, onAdmission => this.call(name, args, { onAdmission }));
  }

  async call(name, args = {}, { onAdmission = null } = {}) {
    if (name === "hub_task_operation_get") return this.#taskOperationReadback(this.#authorize(args.context_token), args);
    await this.#startupReconciliation;
    const context = this.#authorize(args.context_token);
    const toolName = String(name ?? "");
    if (["hub_release_prepare", "hub_release_prepare_get", "hub_release_prepare_resume"].includes(toolName)
        && !this.#isReleaseManager(context)) {
      throw new ReleasePreparationRejectedError("Candidate preparation requires a Release Manager Stream");
    }
    if (toolName === "hub_release_prepare") {
      validatePreparationEnvelope(args.preparation);
      if (Object.keys(args).some((key) => !["context_token", "request_id", "preparation"].includes(key))) {
        throw new ReleasePreparationRejectedError("Unexpected preparation command argument");
      }
      const operation = () => this.#mutate(context, toolName, args, () => this.#prepareRelease(context, args));
      return this.taskGitWorkspaces?.withOperationTrace
        ? this.taskGitWorkspaces.withOperationTrace({ operationId: args.request_id }, operation)
        : operation();
    }
    if (toolName === "hub_release_prepare_get") {
      const operation = () => this.measureOperation("preparation:original-readback",
        () => this.#preparationReadback(context, args));
      return this.taskGitWorkspaces?.withOperationTrace
        ? this.taskGitWorkspaces.withOperationTrace({ operationId: args.preparation_request_id }, operation)
        : operation();
    }
    if (toolName === "hub_release_prepare_resume") {
      const operation = () => this.#resumePreparation(context, args);
      return this.taskGitWorkspaces?.withOperationTrace
        ? this.taskGitWorkspaces.withOperationTrace({ operationId: args.request_id }, operation)
        : operation();
    }
    if (MUTATING_TOOLS.has(toolName)) {
      // A declared successor ID already belongs to its exact actor/envelope.
      // Reject a foreign intake before it can occupy that ID in the MCP ledger.
      if (toolName === "hub_task_claim" && args.forward_custody_request_id && !this.workspaceCatalog.mcpOperation(args.request_id)) {
        this.#claimCustodySuccessor(context, args);
      }
      const operation = (admissionReceipt) => this.#dispatch({ ...context, admissionReceipt }, toolName, args);
      return this.#mutate(context, toolName, args, operation, { onAdmission });
    }
    return this.#dispatch(context, toolName, args);
  }

  // Local frozen-source consumer, like callTaskStatusCutover. Serialized MCP
  // arguments cannot manufacture the observer or silently upgrade old resume.
  // The existing default factory/store/preflight/Git owners remain unchanged.
  async callPreparationForward(args, { inspectOriginalExecution } = {}) {
    await this.#startupReconciliation;
    const context = this.#authorize(args.context_token);
    if (!this.#isReleaseManager(context)) throw new ReleasePreparationRejectedError("Forward preparation requires Release Manager authority");
    if (Object.keys(args).some(key => !["context_token", "request_id", "expected_arguments_hash",
      "expected_preparation_revision", "original_preparation", "preparation"].includes(key))
        || !Number.isSafeInteger(args.expected_preparation_revision) || args.expected_preparation_revision < 0) {
      throw new ReleasePreparationRejectedError("Invalid exact forward preparation command");
    }
    const originalRead = this.#preparationReadback(context, { preparation_request_id: args.request_id,
      expected_arguments_hash: args.expected_arguments_hash });
    const record = this.workspaceCatalog.mcpOperation(originalRead.requestId);
    if (record.streamId !== context.streamId || record.provider !== context.provider || record.threadId !== context.auditThreadId) {
      throw new ReleasePreparationRejectedError("Forward preparation original caller differs");
    }
    const { original, current: envelope } = validatePreparationForward({ record, requestId: args.request_id,
      originalPreparation: args.original_preparation, preparation: args.preparation });
    if (record.preparationState?.phase === "completed") return record.preparationState.result;
    if ((record.preparationState?.revision ?? 0) !== args.expected_preparation_revision) {
      throw new ReleasePreparationRejectedError("Forward preparation revision changed");
    }
    const identity = { workspaceId: context.workspaceId, streamId: context.streamId, provider: context.provider,
      threadId: context.auditThreadId, argumentsHash: record.argumentsHash };
    const legacyHash = preparationLegacyHash(record), legacy = preparationLegacyIdentity(record);
    const ownerId = randomUUID(), sourceRoot = record.preparationState?.sourceRoot ?? preparationSourceRoot();
    let state = record.preparationState ?? null, owned = false;
    const checkRows = () => {
      const row = this.workspaceCatalog.mcpOperation(args.request_id);
      if (!this.#isReleaseManager(context) || preparationLegacyHash(row) !== legacyHash
          || row.receiptState !== "unknown" || owned && (row.preparationState?.ownerId !== ownerId
            || row.preparationState?.revision !== state.revision)) {
        throw new ReleasePreparationRejectedError("Forward preparation original/current owner changed");
      }
      assertPreparationRows(envelope, this.taskBoard, context.workspaceId);
    };
    const validate = async () => {
      checkRows();
      const root = await lstat(sourceRoot);
      if (!root.isDirectory() || root.isSymbolicLink()
          || state?.sourceRootIdentity && state.sourceRootIdentity !== `${root.dev}:${root.ino}`
          || (await readPreparationSourceClosure(sourceRoot)).hash !== envelope.sourceClosureHash) {
        throw new ReleasePreparationRejectedError("Forward preparation source closure/custody changed");
      }
    };
    const checkpoint = async (phase, details = {}, transfer = false) => {
      const next = { ...state, schemaVersion: 2, kind: FORWARD_PREPARATION, legacy, originalPreparation: original,
        envelope, sourceRoot, ownerId, revision: (state?.revision ?? 0) + 1,
        epoch: transfer ? (state?.epoch ?? 0) + 1 : state.epoch, phase,
        ...details, events: [...(state?.events ?? []), { phase, ownerId, at: new Date().toISOString(),
          ...(transfer ? { envelope } : {}), ...details }] };
      const row = await this.workspaceCatalog.checkpointMcpPreparationForward(args.request_id, {
        identity, expectedRevision: state?.revision ?? 0, legacyHash, state: next, transfer,
        ...(transfer || phase === "completed" ? { validate: checkRows } : {}) });
      state = row.preparationState;
    };
    const run = async () => {
      await validate();
      try { return await this.releasePreflight.prepareCurrentAwaitSet({
        workspaceId: context.workspaceId, envelope, requestId: args.request_id,
        argumentsHash: record.argumentsHash, validate,
        ownPreparation: async ({ devInventory }) => {
          for (const repository of envelope.repositories) {
            if (repository.localSourceBaseline?.historicalChangelog) {
              await this.releasePreflight.releaseGitWorkspaces.validateLocalSourceBaseline({
                projectRoot: repository.projectRoot, provenance: repository.localSourceBaseline,
                planRevision: envelope.planRevision, tasks: envelope.tasks,
                originalAuthority: { requestId: args.request_id, argumentsHash: record.argumentsHash, originalPreparation: original },
              });
            }
          }
          const isolationPlan = await this.releasePreflight.releaseGitWorkspaces.planPreparationIsolation({
            requestId: args.request_id, argumentsHash: record.argumentsHash, originalPreparation: original,
            preparation: envelope, devInventory, previousIsolation: state?.isolation ?? null });
          const custody = await inspectPreparationForwardCustody(inspectOriginalExecution, {
            requestId: args.request_id, argumentsHash: record.argumentsHash, originalPreparation: original,
            isolationPlan,
            previousForward: state ? { ownerId: state.ownerId, epoch: state.epoch, phase: state.phase } : null });
          const root = await lstat(sourceRoot);
          await validate();
          const isolation = custody.kind === "preparation-effects-isolated-v1" ? isolationPlan : null;
          if (isolation && !state?.isolation && isolation.legacyOriginalEffect) {
            throw new ReleasePreparationRejectedError(`Preserve same-original legacy candidate/promotion at ${isolation.targets.legacyCandidate.root}; exact owned import is required before isolation`);
          }
          if (isolation && !state?.isolation && isolation.legacyCheckpointHash !== envelope.repositories[0].checkpointHash) {
            throw new ReleasePreparationRejectedError("Legacy checkpoint changed before isolated custody transfer");
          }
          if (state?.isolation && JSON.stringify(state.isolation) !== JSON.stringify(isolation)) {
            throw new ReleasePreparationRejectedError("Forward isolation authority cannot be replaced");
          }
          await checkpoint("checking", { custody, devInventory, ...(isolation ? { isolation } : {}),
            sourceRootIdentity: `${root.dev}:${root.ino}` }, true);
          owned = true;
        },
        beforeCompose: async () => { await validate(); await checkpoint("composing"); },
        forwardPreparation: { originalEnvelope: original, readIsolation: () => state?.isolation ?? null,
          observeEffects: async inventory => { await validate(); await checkpoint("composing", { inventory }); } },
        commitPrepared: async prepared => {
          await validate();
          const result = { schemaVersion: 1, kind: "forward-preparation-completed", requestId: args.request_id,
            argumentsHash: record.argumentsHash, retainedLegacyOutcome: "unknown", workspaceId: context.workspaceId,
            planRevision: prepared.planRevision, taskIds: prepared.taskIds,
            sourceCommit: envelope.sourceCommit, sourceTree: envelope.sourceTree, sourceClosureHash: envelope.sourceClosureHash,
            publicationHash: envelope.publicationHash, candidates: prepared.releaseCandidates.map(candidate => ({
              repositoryRoot: candidate.repositoryRoot, releaseRoot: candidate.releaseRoot,
              preReleaseHead: candidate.preReleaseHead, tree: candidate.tree,
              baseCommit: candidate.baseCommit, manifestHash: candidate.manifestHash,
              preflightRequestId: candidate.manifest?.preflightRequestId })) };
          try { await checkpoint("completed", { result }); }
          catch (cause) {
            const after = this.workspaceCatalog.mcpOperation(args.request_id);
            if (after?.preparationState?.ownerId === ownerId && after.preparationState.phase === "completed"
                && JSON.stringify(after.preparationState.result) === JSON.stringify(result)) return after.preparationState.result;
            throw Object.assign(new Error("Forward terminal persistence outcome is unknown", { cause }), { code: "AWAIT_ACCEPTANCE_UNKNOWN" });
          }
          return result;
        },
      }); } catch (error) {
        const after = this.workspaceCatalog.mcpOperation(args.request_id);
        if (after?.preparationState?.ownerId === ownerId && after.preparationState.phase === "completed") return after.preparationState.result;
        if (owned && after?.preparationState?.ownerId === ownerId && after.preparationState.revision === state.revision) {
          await checkpoint("blocked", { error: String(error.message).slice(0, 2000) }).catch(() => {});
        }
        throw error;
      }
    };
    return this.taskGitWorkspaces.withOperationTrace
      ? this.taskGitWorkspaces.withOperationTrace({ operationId: args.request_id }, run) : run();
  }

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
          taskOperations: this.taskOperationInterruption?.list(args.task_id) ?? [] };
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
        if (args.confirm_cancel !== true || !this.taskOperationInterruption) throw new Error("Explicit Task cancellation confirmation is required");
        return this.taskOperationInterruption.cancel({ actor: { workspaceId: context.workspaceId,
          streamId: context.streamId, provider: context.provider, threadId: context.auditThreadId,
          releaseManager: this.#isReleaseManager(context) },
          taskId: args.task_id, operationRequestId: args.operation_request_id,
          cancellationRequestId: requiredText(args.request_id, "request id", 200),
          expectedArgumentsHash: args.expected_arguments_hash, expectedTaskRevision: args.expected_task_revision,
          originalArguments: args.original_arguments, runtimeWitness: args.runtime_witness });
      }
      case "hub_task_operation_reconcile":
        if (!this.#isReleaseManager(context)) throw new TaskOperationReconciliationRefusedError(new Error("Task operation reconciliation requires a Release Manager Stream"));
        if (args.confirm_reconcile !== true) throw new TaskOperationReconciliationRefusedError(new Error("Task operation reconciliation requires explicit confirmation"));
        if (args.claim_custody != null) return this.#claimCustody(context, args);
        if (this.#pendingMutations.has(args.operation_request_id)) {
          throw new TaskOperationReconciliationRefusedError(new Error("Original workflow worker is still active"));
        }
        if (this.workspaceCatalog.mcpOperation(args.operation_request_id)?.toolName === "hub_task_claim") {
          return this.#reconcileSealedClaimRefusal(context, args);
        }
        if (!this.taskOperationReconciliation) throw new TaskOperationReconciliationRefusedError(new Error("Task operation reconciliation is unavailable"));
        return this.taskOperationReconciliation.reconcileUnknownWorkflow({
          workspaceId: context.workspaceId,
          taskId: args.task_id,
          operationRequestId: args.operation_request_id,
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
          confirmed: args.confirm_reconcile,
        });
      case "hub_task_legacy_git_adopt":
        if (!this.#isReleaseManager(context)) throw new Error("legacy Git adoption requires a Release Manager Stream");
        return this.#adoptLegacyTaskGit(context, args);
      case "hub_task_complete":
        if (args.absorption_mode === "published_duplicate" && !this.#isReleaseManager(context)) {
          throw new Error("published duplicate closure requires a Release Manager Stream");
        }
        if (args.completion_mode === "published_release_service" && !this.#isReleaseManager(context)) {
          throw new Error("published release service closure requires a Release Manager Stream");
        }
        return this.#completeTask(context, args);
      case "hub_task_delete": {
        return this.#deleteTask(context, args);
      }
      case "hub_task_attachment_read":
        return this.#readAttachment(context, args);
      case "hub_task_attachment_add":
        return this.#addAttachment(context, args);
      case "hub_release_plan_get":
        return this.#releasePlan(context, args);
      case "hub_release_run":
        if (!this.#isReleaseManager(context)) throw new Error("release execution requires a Release Manager Stream");
        return this.#runReleaseOperation(context, args);
      case "hub_release_get":
        return this.#getReleaseOperation(context, args);
      case "hub_release_continue":
        if (!this.#isReleaseManager(context)) throw new Error("release continuation requires a Release Manager Stream");
        return this.#continueReleaseOperation(context, args);
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
    request_id: requestId,
  } = {}) {
    const payload = this.#taskChecklistPayload(context, {
      taskId, expectedRevision, operation, itemId, text, completed, beforeItemId, linkedTaskId, requestId,
    });
    return this.#taskChecklistResult(await this.taskBoard.updateChecklist(payload));
  }

  #taskChecklistPayload(context, {
    taskId, expectedRevision, operation, itemId, text, completed, beforeItemId, linkedTaskId, requestId,
  }) {
    const current = this.#task(context, taskId);
    const normalizedOperation = requiredText(operation, "checklist operation", 30);
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
    const reserved = this.workspaceCatalog.claimCustodyForTask?.(taskId);
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

  #custodyBusy(task) {
    if (task.streamId === null) return false;
    return this.#activeRuns().some(run => run.streamId === task.streamId)
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
          || plan.workspaceId !== context.workspaceId || plan.actorStreamId !== context.streamId
          || plan.actorThreadId !== context.auditThreadId || plan.actorProvider !== context.provider) throw new TaskClaimCustodyRejectedError("Exact durable custody plan differs");
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
        || fence.successorClaimRequestId !== args.request_id || fence.original.provider !== context.provider
        || fence.original.streamId !== context.streamId || fence.original.threadId !== context.auditThreadId
        || fence.original.threadId !== context.threadId || args.dependency_override_reason != null
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
      if (this.#custodyBusy(task)) throw new Error("Previous executor became active; exact custody claim may be reopened after its normal terminal");
      await guarded.assertOwned();
      return this.#writeClaim(context, task, this.#currentRun(context), args.request_id, workspace, fence.requestId);
    });
  }

  async #claimTask(context, args = {}, { committedReadbackOnly = false } = {}) {
    const { task_id: taskId, request_id: operationId, dependency_mode: dependencyMode = "skip", dependency_override_reason: dependencyOverrideReason = null } = args;
    const task = this.#task(context, taskId);
    const namespace = this.workspaceCatalog.claimCustodyNamespaceForTask?.(taskId);
    if (namespace && context.streamId !== namespace.original.streamId) {
      throw new TaskClaimCustodyRejectedError("Foreign claim cannot prepare the successor source namespace");
    }
    const active = this.#currentRun(context);
    if (task.status === "done") throw new Error("Closed Tasks are an archive; claim an open Task");
    if (args.forward_custody_request_id) return this.#consumeClaimCustody(context, args, { committedReadbackOnly });
    if (task.streamId && task.streamId !== context.streamId) {
      const busyReason = this.#activeRuns().some(run => run.streamId === task.streamId) ? "active"
        : this.#deferredInputs().some(input => input.streamId === task.streamId
          || (input.provider && input.threadId && this.workspaceCatalog.resolveThread({
            provider: input.provider, threadId: input.threadId,
          })?.streamId === task.streamId)) ? "queued" : null;
      if (busyReason) {
        requiredMethod(this.workspaceCatalog, "recordClaimAdmissionRefusal");
        await this.workspaceCatalog.recordClaimAdmissionRefusal({ receipt: context.admissionReceipt, task, busyReason,
          claimArguments: Object.fromEntries(Object.entries(args).filter(([key]) => key !== "context_token")) });
        throw new TaskClaimExecutorBusyError();
      }
    }
    const projectRoot = this.#taskProjectRoot(context);
    if (this.taskGitWorkspaces?.withTaskLock && projectRoot) {
      return this.taskGitWorkspaces.withTaskLock(task.id, async lease => {
        const guarded = this.#claimLease(lease, task.id, operationId);
        await guarded.assertOwned();
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
        return this.#writeClaim(context, task, active, operationId, workspace);
      });
    }
    const gitWorkspace = this.taskGitWorkspaces && projectRoot
      ? await this.taskGitWorkspaces.prepare({ taskId: task.id, taskNumber: task.taskNumber, projectRoot, dependencyMode, dependencyOverrideReason })
      : null;
    return this.#writeClaim(context, task, active, operationId, gitWorkspace);
  }

  async #writeClaim(context, task, active, operationId, gitWorkspace, forwardCustodyRequestId = null) {
    this.#assertClaimContinuation(task.id, operationId, forwardCustodyRequestId);
    if (gitWorkspace) active.gitBaseline = gitWorkspace.gitBaseline;
    const claimed = await this.taskBoard.claim({
      id: task.id,
      workspaceId: context.workspaceId,
      streamId: context.streamId,
      provider: context.provider,
      threadId: context.threadId,
      turnId: active.turnId,
      operationId,
      operationKind: "claim",
      gitBaseline: active.gitBaseline ?? null, forwardCustodyRequestId,
      validateClaimAdmission: forwardCustodyRequestId ? () => {
        if (this.#custodyBusy(task)) throw new Error("Previous executor became active before custody assignment commit");
        this.#assertClaimContinuation(task.id, operationId, forwardCustodyRequestId);
      } : null,
    });
    return {
      ...compactTask(claimed),
      claimedTurnId: active.turnId,
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
    native_resolution_review: nativeResolutionReview = null,
  } = {}, { source = null } = {}) {
    if (initialNativeTest != null && source?.kind !== "initial-native-test") {
      throw new TaskInputValidationError("Initial native Test requires the supported local cutover entrypoint");
    }
    if ((sourceTaskId != null || sourceTaskRevision != null) && !source) {
      throw new Error("Cross-Task cutover requires the supported local cutover entrypoint");
    }
    const task = this.#task(context, taskId);
    if (nativeResolutionReview != null) {
      if (!this.#isReleaseManager(context)
          || !["testing", "awaiting_implementation"].includes(status)
          || expectedRevision == null || expectedWorkflowStatus == null) {
        throw new TaskInputValidationError("Native resolution review requires exact RM Test/Await CAS and authenticated verdict");
      }
      try {
        const review = normalizedNativeResolution(nativeResolutionReview);
        if (review.reviews && status !== "awaiting_implementation") {
          throw new TypeError("Native resolution bundles require Await");
        }
      } catch (error) { throw new TaskInputValidationError(error.message); }
    }
    const workflowStatus = requiredText(status, "task workflow status", 40);
    const squashValues = [
      squashSourceTaskId, squashSourceTaskRevision, squashBaselineResultCommit,
      squashNewResultCommit, squashDevAfterTree,
    ];
    const squashRequested = [...squashValues, squashProofRequestId, expectedSquashTransferHash,
      expectedSquashCutoverHash]
      .some((value) => value != null);
    const selectedRequested = [selectedBundlePath, selectedBundleSha256, selectedProofCommit, selectedPublishedResolution,
      selectedPreviewRequestId, expectedSelectedPreviewHash].some((value) => value != null);
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
      if (!this.#isReleaseManager(context)) {
        throw new Error("Task squash transfer requires a Release Manager Stream");
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
      operationEvidence: nativeResolutionReview ? { nativeResolutionReview } : null,
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

  async #completeTask(context, {
    task_id: taskId, request_id: operationId, confirm_cleanup: confirmCleanup = false,
    expected_cleanup_token: expectedCleanupToken = null,
    absorbed_into_task_id: absorbedIntoTaskId = null,
    absorption_mode: absorptionMode = null,
    completion_mode: completionMode = null,
  } = {}) {
    const task = this.#task(context, taskId);
    const result = await this.taskLifecycle.complete({
      taskId: task.id, operationId, confirmCleanup, expectedCleanupToken, absorbedIntoTaskId,
      absorptionMode, completionMode,
    });
    return result?.confirmationRequired
      ? { ...result, task: compactTask(result.task) }
      : compactTask(result);
  }

  async #deleteTask(context, {
    task_id: taskId, request_id: operationId, confirm_cleanup: confirmCleanup = false,
    expected_cleanup_token: expectedCleanupToken = null,
  } = {}) {
    const task = this.#task(context, taskId);
    const result = await this.taskLifecycle.delete({
      taskId: task.id, operationId, confirmCleanup, expectedCleanupToken,
    });
    return result?.confirmationRequired
      ? { ...result, task: compactTask(result.task) }
      : { ...result, task: compactTask(result.task) };
  }

  #isReleaseManager(context) {
    return this.#workspace(context).streams.some((stream) => (
      stream.id === context.streamId && stream.settings?.releaseManager === true
    ));
  }

  #preparationReadback(context, args) {
    const requestId = requiredText(args.preparation_request_id, "original preparation request id", 200);
    const operation = this.workspaceCatalog.mcpOperation(requestId);
    if (!/^[a-f0-9]{64}$/u.test(String(args.expected_arguments_hash ?? ""))
        || !operation || operation.workspaceId !== context.workspaceId
        || operation.toolName !== "hub_release_prepare"
        || operation.argumentsHash !== args.expected_arguments_hash) {
      throw new ReleasePreparationRejectedError("Original preparation receipt identity does not match");
    }
    return { requestId, argumentsHash: operation.argumentsHash,
      caller: { workspaceId: operation.workspaceId, streamId: operation.streamId,
        provider: operation.provider, threadId: operation.threadId },
      status: operation.status, receiptState: operation.receiptState,
      createdAtMs: operation.createdAtMs, completedAtMs: operation.completedAtMs,
      result: operation.status === "succeeded" ? operation.result : null, error: operation.error,
      recovery: operation.preparationState ? {
        revision: operation.preparationState.revision, phase: operation.preparationState.phase,
        originalError: operation.preparationState.originalError ?? null,
        ...(operation.preparationState.kind === FORWARD_PREPARATION ? {
          kind: FORWARD_PREPARATION, retainedLegacyOutcome: "unknown", epoch: operation.preparationState.epoch,
          ...(operation.preparationState.phase === "completed" ? { result: operation.preparationState.result } : {}),
        } : {}),
        ...(["composing", "terminal-intent"].includes(operation.preparationState.phase)
          ? { missingEvidence: "original committed candidate or rollback outcome is not proved by this stage" } : {}),
      } : { revision: 0, phase: null, missingEvidence: "original owner stage checkpoint was not persisted" } };
  }

  async #resumePreparation(context, args) {
    if (Object.keys(args).some(key => !["context_token", "request_id", "expected_arguments_hash",
      "expected_preparation_revision", "native_resolution_review"].includes(key))
        || !Number.isSafeInteger(args.expected_preparation_revision) || args.expected_preparation_revision < 0) {
      throw new ReleasePreparationRejectedError("Unexpected preparation recovery argument");
    }
    const original = this.#preparationReadback(context, { preparation_request_id: args.request_id,
      expected_arguments_hash: args.expected_arguments_hash });
    const record = this.workspaceCatalog.mcpOperation(original.requestId);
    if (record.streamId !== context.streamId || record.provider !== context.provider
        || record.threadId !== context.auditThreadId) {
      throw new ReleasePreparationRejectedError("Preparation recovery original caller differs");
    }
    if (record.status === "succeeded") return record.result;
    const forward = record.preparationState;
    if (forward?.kind === FORWARD_PREPARATION) {
      if (forward.phase === "completed") return forward.result;
      if (forward.revision !== args.expected_preparation_revision
          || !["checking", "blocked", "composing"].includes(forward.phase)
          || !forward.isolation || forward.custody?.kind !== "preparation-effects-isolated-v1") {
        throw new ReleasePreparationRejectedError("Original preparation has no established resumable isolated custody");
      }
      const preparation = structuredClone(forward.envelope);
      if (args.native_resolution_review != null) {
        if (preparation.repositories.length !== 1) throw new ReleasePreparationRejectedError("Native review requires one exact forward repository");
        preparation.repositories[0].nativeResolutionReview = args.native_resolution_review;
      }
      // The one-time observer already transferred future-effect custody. Reuse
      // that proof only after the normal leased owner regenerates the SAME
      // isolation plan. No new serialized proof, force flag or historical
      // descendant certificate is accepted by this ordinary continuation.
      return this.callPreparationForward({ context_token: args.context_token, request_id: args.request_id,
        expected_arguments_hash: args.expected_arguments_hash,
        expected_preparation_revision: args.expected_preparation_revision,
        original_preparation: forward.originalPreparation, preparation }, {
        inspectOriginalExecution: async request => {
          if (JSON.stringify(request.isolationPlan) !== JSON.stringify(forward.isolation)
              || request.previousForward?.ownerId !== forward.ownerId
              || request.previousForward?.epoch !== forward.epoch
              || request.previousForward?.phase !== forward.phase) {
            throw new ReleasePreparationRejectedError("Established isolated preparation custody changed");
          }
          return structuredClone(forward.custody);
        },
      });
    }
    if (args.native_resolution_review != null) throw new ReleasePreparationRejectedError("Native forward review cannot change an ordinary original envelope");
    if (!["pending", "unknown"].includes(record.status) || !record.preparationState
        || !Number.isSafeInteger(args.expected_preparation_revision)
        || args.expected_preparation_revision !== record.preparationState.revision
        || !["checking", "paused"].includes(record.preparationState.phase)) {
      throw new ReleasePreparationRejectedError("Preparation recovery lacks original resumable owner stage evidence; UNKNOWN is preserved");
    }
    const recovered = { context_token: args.context_token, request_id: original.requestId,
      preparation: record.preparationState.envelope };
    if (argumentsHash(recovered) !== original.argumentsHash) {
      throw new ReleasePreparationRejectedError("Preparation recovery original envelope differs");
    }
    return this.#prepareRelease(context, recovered, { record });
  }

  async #prepareRelease(context, args, recovery = null) {
    const envelope = validatePreparationEnvelope(args.preparation);
    const hash = argumentsHash(args);
    const identity = { workspaceId: context.workspaceId, streamId: context.streamId, provider: context.provider,
      threadId: context.auditThreadId, argumentsHash: hash };
    const ownerId = randomUUID();
    let state = recovery?.record.preparationState ?? null;
    let owned = false;
    const sourceRoot = state?.sourceRoot ?? preparationSourceRoot();
    const checkpoint = async (phase, extra = {}, { resume = false } = {}) => {
      requiredMethod(this.workspaceCatalog, "checkpointMcpPreparation");
      const next = { ...state, schemaVersion: 1, revision: (state?.revision ?? 0) + 1,
        envelope, sourceRoot, ownerId, phase, ...extra };
      const written = await this.workspaceCatalog.checkpointMcpPreparation(args.request_id,
        { identity, expectedRevision: state?.revision ?? 0, state: next, resume });
      state = written.preparationState;
    };
    const checkRows = () => {
      if (!this.#isReleaseManager(context)) throw new ReleasePreparationRejectedError("Release Manager authority changed");
      assertPreparationRows(envelope, this.taskBoard, context.workspaceId);
      const original = this.workspaceCatalog.mcpOperation(args.request_id);
      if (original?.argumentsHash !== hash || original?.toolName !== "hub_release_prepare"
          || original?.workspaceId !== context.workspaceId
          || !(recovery ? ["unknown", "pending", "reconciling"] : ["pending"]).includes(original?.status)) {
        throw new ReleasePreparationRejectedError("Preparation intake identity changed");
      }
    };
    const validate = async () => {
      checkRows();
      const root = await lstat(sourceRoot);
      if (!root.isDirectory() || root.isSymbolicLink()
          || state?.sourceRootIdentity && (state.sourceRootIdentity !== `${root.dev}:${root.ino}`)
          || (await readPreparationSourceClosure(sourceRoot)).hash !== envelope.sourceClosureHash) {
        throw new ReleasePreparationRejectedError("Preparation source closure changed");
      }
    };
    await this.measureOperation("preparation:pins", validate);
    if (typeof this.releasePreflight?.prepareCurrentAwaitSet !== "function") {
      throw new ReleasePreparationRejectedError("Preparation owner is unavailable");
    }
    try { return await this.releasePreflight.prepareCurrentAwaitSet({
      workspaceId: context.workspaceId, envelope, requestId: args.request_id, argumentsHash: hash, validate,
      ownPreparation: async () => {
        const root = await lstat(sourceRoot);
        await checkpoint("checking", {
          sourceRootIdentity: `${root.dev}:${root.ino}`,
          originalError: state?.originalError ?? recovery?.record.error ?? null,
        }, { resume: !!recovery });
        owned = true;
      },
      beforeCompose: async () => { if (state.phase !== "composing") await checkpoint("composing"); },
      commitPrepared: async (prepared) => {
        if (!owned || state.phase !== "composing") throw new Error("Preparation commit has no owned compose boundary");
        await validate();
        const result = { schemaVersion: 1, kind: "preparation-only", requestId: args.request_id,
          argumentsHash: hash, workspaceId: context.workspaceId, planRevision: prepared.planRevision,
          sourceCommit: envelope.sourceCommit, sourceTree: envelope.sourceTree,
          sourceClosureHash: envelope.sourceClosureHash, publicationHash: envelope.publicationHash,
          taskIds: prepared.taskIds, candidates: prepared.releaseCandidates.map((candidate) => ({
            repositoryRoot: candidate.repositoryRoot, preReleaseHead: candidate.preReleaseHead,
            tree: candidate.tree, baseCommit: candidate.baseCommit, manifestHash: candidate.manifestHash,
            preflightRequestId: candidate.manifest?.preflightRequestId,
          })) };
        try {
          // This is provisional while candidate rollback is still live, not terminal authority.
          await checkpoint("terminal-intent", { result });
          await this.measureOperation("preparation:terminal-receipt", () => this.workspaceCatalog
            .completeMcpOperation(args.request_id, result, { validate: checkRows }));
        } catch (cause) {
          const terminal = this.workspaceCatalog.mcpOperation(args.request_id);
          if (terminal?.status === "succeeded" && terminal.argumentsHash === hash
              && JSON.stringify(terminal.result) === JSON.stringify(result)) return terminal.result;
          if (cause instanceof ReleasePreparationRejectedError) throw cause;
          const unknown = new Error("Preparation terminal persistence outcome is unknown", { cause });
          unknown.code = "AWAIT_ACCEPTANCE_UNKNOWN";
          throw unknown;
        }
        return result;
      },
    }); } catch (error) {
      let pauseFailed = false;
      if (owned && state.phase === "checking") {
        try {
          await checkpoint("paused", { originalError: state.originalError ?? String(error.message).slice(0, 2000) });
        } catch { pauseFailed = true; }
      }
      // A checkpoint can commit before its reply is lost. Read back this
      // invocation's nonce, then settle only through the store's revision CAS.
      // A caller refused before owner transfer has no receipt to mutate.
      const current = this.workspaceCatalog.mcpOperation(args.request_id);
      if (current?.preparationState?.ownerId === ownerId) {
        await Promise.resolve(this.workspaceCatalog.settleMcpPreparationFailure(args.request_id, {
          identity, ownerId, expectedRevision: current.preparationState.revision, error,
          definite: !recovery && !pauseFailed && definiteMcpMutationFailure(error),
        })).catch(() => {});
      }
      throw error;
    }
  }

  async #adoptLegacyTaskGit(context, {
    task_id: taskId,
    expected_task_revision: expectedTaskRevision,
    evidence_turn_id: evidenceTurnId,
    reported_result_commit: reportedResultCommit,
    main_result_commit: mainResultCommit,
    confirm_adoption: confirmAdoption = false,
    request_id: requestId,
  } = {}) {
    if (confirmAdoption !== true) throw new Error("confirm_adoption must be true");
    if (!this.taskGitWorkspaces) throw new Error("Task Git workspace service is unavailable");
    const task = this.#task(context, taskId);
    if (task.workspaceId !== context.workspaceId) throw new Error("Task is outside the Release Manager Workspace");
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

  async #releasePlan(context, { workspace_id: workspaceId = null } = {}) {
    const targetWorkspaceId = this.#workspace(context, workspaceId).id;
    const plan = await this.releasePlanner.plan(targetWorkspaceId);
    if (!this.taskGitWorkspaces) return plan;
    const roots = [...new Set(plan.ready.map((entry) => String(entry.projectRoot ?? "").trim()).filter(Boolean))];
    const repositories = [];
    for (const projectRoot of roots) {
      try {
        const dev = await this.taskGitWorkspaces.readDev(projectRoot);
        repositories.push({
          projectRoot: dev.repositoryRoot,
          branch: dev.branch,
          headCommit: dev.headCommit,
          worktreeRoot: dev.projectRoot,
        });
      } catch (error) {
        repositories.push({ projectRoot, branch: "dev", headCommit: null, error: error.message });
      }
    }
    return { ...plan, devIntegration: { branch: "dev", repositories } };
  }

  #releaseOperation() {
    if (!this.releaseOperations) throw new Error("durable release operation owner is unavailable");
    return this.releaseOperations;
  }

  #runReleaseOperation(context, args) {
    const workspaceId = this.#workspace(context, args.workspace_id).id;
    // This validation is before ReleaseOperation.start and cannot have a
    // release effect. Do not turn a malformed review input into UNKNOWN.
    for (const target of Array.isArray(args.approved_targets) ? args.approved_targets : []) {
      if (target?.nativeResolutionReview != null) {
        try { normalizedNativeResolution(target.nativeResolutionReview); }
        catch (cause) { throw new ReleasePreparationRejectedError(cause.message); }
      }
    }
    return this.#releaseOperation().start({
      requestId: requiredText(args.request_id, "request id", 200),
      workspaceId,
      streamId: context.streamId,
      threadId: context.auditThreadId,
      authorization: {
        taskIds: Array.isArray(args.task_ids) ? args.task_ids : [],
        validationMode: requiredText(args.validation_mode, "validation mode", 32),
        approvedTargets: Array.isArray(args.approved_targets) ? args.approved_targets : [],
        ...(args.test_selection !== undefined ? { testSelection: args.test_selection } : {}),
        ...(args.release_metadata !== undefined ? { releaseMetadata: args.release_metadata } : {}),
        ...(args.release_version !== undefined ? { releaseVersion: args.release_version } : {}),
      },
    });
  }

  #getReleaseOperation(context, args) {
    const snapshot = this.#releaseOperation().get(requiredText(args.operation_id, "operation id", 200));
    this.#workspace(context, snapshot.operation.workspaceId);
    return snapshot;
  }

  #continueReleaseOperation(context, args) {
    const operationId = requiredText(args.operation_id, "operation id", 200);
    const snapshot = this.#releaseOperation().get(operationId);
    this.#workspace(context, snapshot.operation.workspaceId);
    return this.#releaseOperation().continue(operationId, {
      requestId: args.request_id, reviewedMain: args.reviewed_main,
      testSelection: args.test_selection, taskIds: args.task_ids, releaseMetadata: args.release_metadata, expectedRevision: args.expected_revision, expectedGeneration: args.expected_generation,
    });
  }


  async #startTask(context, {
    task_id: taskId, stream_id: streamId = null, new_stream_name: newStreamName = null,
    workspace_id: workspaceId = null, provider = null, message = "",
    confirm_launch: confirmLaunch = false, request_id: requestId,
  } = {}, { reassign = false } = {}) {
    if (confirmLaunch !== true) throw new Error("confirm_launch must be true");
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
    confirm_cancel: confirmCancel = false,
    request_id: cancellationRequestId,
  } = {}) {
    if (!this.#isReleaseManager(context)) throw new Error("only a Release Manager Stream can cancel a prepared Task launch");
    if (confirmCancel !== true) throw new Error("confirm_cancel must be true");
    const task = this.#task(context, taskId);
    const normalizedLaunchRequestId = requiredText(launchRequestId, "launch request id", 200);
    const normalizedCancellationRequestId = requiredText(cancellationRequestId, "request id", 200);
    const revision = Number(expectedTaskRevision);
    if (!Number.isSafeInteger(revision) || revision < 1 || revision !== Number(task.revision)) {
      throw new Error("Task revision changed before launch cancellation");
    }
    if (
      task.workspaceId !== context.workspaceId
      || task.status !== "starting"
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
    const exactCaller = original.workspaceId === context.workspaceId
      && original.streamId === context.streamId
      && original.provider === context.provider
      && original.threadId === context.auditThreadId;
    if (!exactCaller) throw new Error("original Task launch receipt belongs to another caller");
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
    confirm_send: confirmSend = false,
    request_id: requestId,
  } = {}) {
    if (confirmSend !== true) throw new Error("confirm_send must be true");
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
        input?.dispatchingAt ?? input?.lastAttemptAt ?? input?.createdAt ?? "",
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
        requestId: args.request_id,
      });
    }
    const started = await this.measureOperation("mcp:admission", () => this.workspaceCatalog.beginMcpOperation({
      requestId,
      workspaceId: context.workspaceId,
      streamId: context.streamId,
      provider: context.provider,
      threadId: context.auditThreadId,
      ...(context.actorKind ? { actorKind: context.actorKind } : {}),
      toolName,
      argumentsHash: argumentsHash(args),
      ...(this.taskOperationInterruption && (context.actorKind === "authenticated-user"
          || (this.taskOperationCanSubmit(toolName) && !["hub_task_operation_cancel", "hub_task_operation_reconcile"].includes(toolName)))
        ? { taskExecution: this.taskOperationInterruption.binding(args) } : {}),
    }));
    if (started.taskExecution?.cancellation) throw taskOperationInterrupted();
    if (started.status === "succeeded") return claimCustodyState(started)?.result ?? started.result;
    if (started.status === "failed") {
      const proof = toolName === "hub_task_claim" ? this.#claimAdmissionRefusal(started, args.task_id) : null;
      if (proof) {
        throw claimAdmissionRefusalError(proof);
      }
      throw new Error(started.error || "previous MCP operation failed");
    }
    const custodyConsume = toolName === "hub_task_claim" && Boolean(args.forward_custody_request_id);
    const custodyStage = toolName === "hub_task_operation_reconcile" && Boolean(args.claim_custody);
    const interruption = toolName === "hub_task_operation_cancel";
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
    if (started.status === "unknown" && !custodyConsume && !custodyStage && !interruption) {
      throw new Error(`MCP operation outcome is unknown; reconcile authoritatively before retrying request_id ${requestId}`);
    }
    const inFlight = this.#pendingMutations.get(requestId);
    if (inFlight) return inFlight;
    const resumable = new Set([
      "hub_task_start", "hub_task_reassign", "hub_task_status_update", "hub_task_complete", "hub_task_delete",
      "hub_task_checklist_update",
      "hub_task_operation_cancel",
    ]);
    if (started.replayed && !resumable.has(toolName) && !custodyConsume && !custodyStage) {
      const reason = new Error("MCP operation outcome requires authoritative reconciliation; blind replay is forbidden");
      if (toolName !== "hub_release_prepare" || !started.preparationState) {
        await this.workspaceCatalog.markMcpOperationUnknown?.(requestId, reason);
      }
      throw reason;
    }
    const pending = (async () => {
      let effectCompleted = false;
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
        if (toolName === "hub_release_prepare") {
          const terminal = this.workspaceCatalog.mcpOperation(requestId);
          if (terminal?.status !== "succeeded" || terminal.argumentsHash !== argumentsHash(args)) {
            throw new Error("Preparation owner did not persist its exact terminal receipt");
          }
          return terminal.result;
        }
        if (args.claim_custody && toolName === "hub_task_operation_reconcile") {
          const durable = claimCustodyState(this.workspaceCatalog.mcpOperation(requestId));
          if (!durable) throw new Error("Custody stage is not durable");
          return durable.result;
        }
        if (interruption && started.status === "unknown") {
          await this.workspaceCatalog.completeUnknownMcpOperation(requestId, { workspaceId: context.workspaceId, toolName,
            result, reconciliation: { kind: "task-operation-interruption-v1", originalRequestId: args.operation_request_id } });
        } else if (custodyConsume && started.status === "unknown") {
          await this.workspaceCatalog.completeUnknownMcpOperation(requestId, { workspaceId: context.workspaceId, toolName,
            result, reconciliation: { kind: "forward-claim-binding-reuse-v1", fenceRequestId: args.forward_custody_request_id } });
        } else await this.workspaceCatalog.completeMcpOperation(requestId, result);
        return result;
      } catch (error) {
        // An own stage may have committed before a reply/storage exception. Its
        // dedicated ledger column survives compaction and is the exact readback.
        if (this.workspaceCatalog.mcpOperation(requestId)?.taskExecution?.cancellation) throw taskOperationInterrupted();
        if (args.claim_custody && toolName === "hub_task_operation_reconcile") {
          const durable = claimCustodyState(this.workspaceCatalog.mcpOperation(requestId));
          if (durable) return durable.result;
        }
        if (this.workspaceCatalog.claimCustodyForOriginal?.(requestId)) throw new TaskClaimContinuationWithdrawnError();
        if (!effectCompleted && custodyConsume && this.taskBoard.claimBindingForOperation(requestId)) {
          await this.workspaceCatalog.markMcpOperationUnknown(requestId,new Error(`Custody assignment committed before outer completion: ${error.message}`));
          throw error;
        }
        if (toolName === "hub_release_prepare") {
          const terminal = this.workspaceCatalog.mcpOperation(requestId);
          if (terminal?.status === "succeeded" && terminal.argumentsHash === argumentsHash(args)) return terminal.result;
          // Stage-backed failures belong exclusively to the invocation owner.
          // This outer intake may resume after a newer owner has acquired it.
          if (terminal?.preparationState) throw error;
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
          await Promise.resolve(this.workspaceCatalog.markMcpOperationUnknown?.(
            requestId,
            new Error(`effect completed but durable receipt failed: ${error.message}`),
          )).catch(() => {});
          throw new Error(`MCP effect completed but receipt reconciliation is required for request_id ${requestId}`);
        }
        const claimRefusal = toolName === "hub_task_claim"
          ? this.#claimAdmissionRefusal(this.workspaceCatalog.mcpOperation(requestId), args.task_id) : null;
        if (claimRefusal) {
          const refusal = claimAdmissionRefusalError(claimRefusal);
          try {
            await this.workspaceCatalog.failMcpOperation(requestId, refusal, { outcome: "NO_EFFECT", evidence: claimRefusal });
          } catch (settlementError) {
            await Promise.resolve(this.workspaceCatalog.markMcpOperationUnknown?.(requestId, settlementError)).catch(() => {});
            throw settlementError;
          }
          throw refusal;
        }
        const workflowRefusal = toolName === "hub_task_status_update" ? this.#workflowAdmissionRefusal(started) : null;
        const reconciliationRefusal = toolName === "hub_task_operation_reconcile"
          && error instanceof TaskOperationReconciliationRefusedError;
        if (workflowRefusal || reconciliationRefusal) {
          try {
            await this.workspaceCatalog.failMcpOperation(requestId, error, {
              outcome: "NO_EFFECT",
              ...(workflowRefusal ? { evidence: workflowRefusal } : { code: error.code }),
            });
          } catch (settlementError) {
            await Promise.resolve(this.workspaceCatalog.markMcpOperationUnknown?.(requestId, settlementError)).catch(() => {});
            throw settlementError;
          }
          throw error;
        }
        if (definiteMcpMutationFailure(error)) {
          await this.workspaceCatalog.failMcpOperation(requestId, error);
          throw error;
        }
        const durableLifecycle = ["hub_task_start", "hub_task_reassign"].includes(toolName)
          && this.#hasPreparedTaskStart(context, args, requestId);
        const claimAdmissionNoEffect = toolName === "hub_task_claim"
          ? await Promise.resolve(this.taskGitWorkspaces?.claimAdmissionNoEffectEvidence?.({
              taskId: args.task_id,
              projectRoot: this.#taskProjectRoot(context),
              error,
            })).catch(() => null)
          : null;
        if (claimAdmissionNoEffect) {
          await this.workspaceCatalog.failMcpOperation(requestId, error);
        } else if (!durableLifecycle) {
          await Promise.resolve(this.workspaceCatalog.markMcpOperationUnknown?.(
            requestId,
            new Error(`mutation effect is not authoritatively disproved: ${error.message}`),
          )).catch(() => {});
        }
        throw error;
      } finally {
        this.#pendingMutations.delete(requestId);
      }
    })();
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
