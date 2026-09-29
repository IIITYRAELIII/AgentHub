import { createHash, createHmac, timingSafeEqual } from "node:crypto";
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
import { taskProjectRoot } from "../domain/task-project-root.mjs";
import {
  normalizedTaskDescription,
  normalizedTaskText,
  normalizedTaskTitle,
  TASK_TITLE_MAX_LENGTH,
  TaskDependencyPendingError,
  TaskLifecycleBeginRejectedError,
  ReleaseCandidateFrozenError,
  TaskAbsorptionCompositionError,
} from "../domain/task-board-task.mjs";
import { taskRunIsActive } from "../domain/task-runs.mjs";
import { displayUserPrompt } from "./task-history.mjs";
import { TaskLifecycleService, TaskIntegrationConflictError, TaskAwaitIntegrationError, TaskWithdrawalDependencyError, TaskWithdrawalBusyError, TaskSquashTransferRejectedError } from "./task-lifecycle-service.mjs";
import { TaskOperationReconciliationService } from "./task-operation-reconciliation-service.mjs";
import { createWorkspaceCatalogMutationOwner } from "./sqlite-mutation-owner.mjs";

const CONTEXT_TOKEN_VERSION = 1;
const MAX_REGISTERED_CONTEXT_CAPABILITIES = 1_000;
const STREAM_HISTORY_CURSOR_VERSION = 1;
const DEFAULT_HISTORY_ACTIVITY_LIMIT = 40;
const DEFERRED_INPUT_STALLED_AFTER_MS = 60_000;
const MUTATING_TOOLS = new Set([
  "hub_task_create", "hub_task_update", "hub_task_checklist_update", "hub_task_move", "hub_task_start", "hub_task_reassign", "hub_task_launch_cancel", "hub_task_claim", "hub_task_status_update", "hub_task_legacy_git_adopt", "hub_task_complete", "hub_task_delete",
  "hub_task_attachment_add", "hub_workspace_rules_update", "hub_stream_rules_update",
  "hub_stream_message_send",
  "hub_task_operation_reconcile",
  "hub_release_run", "hub_release_continue",
]);

// Only the synchronous input boundary below can produce this proof of no effects.
class TaskInputValidationError extends Error {}

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
    status: "active",
    active: true,
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
    description,
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
    taskOperationReconciliation = null,
    reconcilePendingOnStartup = true,
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
    this.workLog = workLog;
    this.attachmentDirectory = path.resolve(requiredText(attachmentDirectory, "attachment directory", 2_000));
    this.secret = requiredText(secret, "MCP secret", 512);
    this.releasePreflight = releasePreflight;
    this.releaseCompleter = releaseCompleter;
    this.releasePlanner = releasePlanner;
    this.releaseOperations = releaseOperations;
    this.taskGitWorkspaces = taskGitWorkspaces;
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
      await this.workspaceCatalog.beginMcpOperationReconciliation?.(receipt.requestId);
      const expectedKind = lifecycleKinds.get(receipt.toolName);
      const transition = expectedKind ? this.taskBoard.lifecycleTransition?.(receipt.requestId) : null;
      const outcome = expectedKind ? this.taskBoard.lifecycleOutcome?.(receipt.requestId) : null;
      const exactOutcome = outcome?.operationId === receipt.requestId && outcome?.kind === expectedKind;
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
    this.releaseOperations?.setEventDelivery?.((event) => value({
      streamId: event.streamId,
      text: `<agent-hub-release-event>\n${JSON.stringify({
        operationId: event.operationId,
        revision: event.revision,
        eventKind: event.eventKind,
        ...event.payload,
      })}\n</agent-hub-release-event>`,
      clientUserMessageId: `release:${event.operationId}:${event.revision}:${event.eventKind}`,
      followUpMode: "queue",
    }, {
      source: "release-operation",
      clientId: `release:${event.operationId}`,
      messageOrigin: { kind: "release-operation", sourceThreadId: event.threadId },
    }));
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
      }, ["task_id", "status"]),
      tool("hub_task_operation_reconcile", "Release Manager-only reconciliation of one exact unknown Task workflow operation. A real unresolved process guard requires trusted proof; exact pending withdrawal or squash state can reconcile without inventing one. An already terminal lifecycle settles its original receipt without Git replay.", {
        task_id: { type: "string" },
        operation_request_id: { type: "string" },
        project_root: { type: "string" },
        guard_id: { type: "string", description: "Required for an actually guarded pending operation. Exact persisted Task withdrawal or squash state without a process guard can reconcile without it." },
        proof_kind: { type: "string", enum: ["system-restart-after-guard"], description: "Required when recovering a process-tree guard." },
        proof_summary: { type: "string", description: "Required when recovering a process-tree guard." },
        expected_task_revision: { type: "integer", minimum: 1, description: "Supply exactly when the original workflow request used this CAS field; required for cutover receipts." },
        expected_workflow_status: { type: "string", enum: ["new", "in_progress", "blocked", "testing", "awaiting_implementation", "done"], description: "Supply exactly when the original workflow request used this CAS field; required for cutover receipts." },
        cutover_source_commit: { type: "string", description: "Required only to reproduce an original local cutover receipt." },
        cutover_projector_sha256: { type: "string", description: "Required only to reproduce an original local cutover receipt." },
        cutover_source_task_id: { type: "string", description: "Required only when the original local cutover used a separate source Task." },
        cutover_source_task_revision: { type: "integer", minimum: 1, description: "Required only when the original local cutover used a separate source Task." },
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
        confirm_reconcile: { type: "boolean", description: "Must be true because this settles the original unknown receipt and may recover a guarded process boundary." },
      }, ["task_id", "operation_request_id", "project_root", "confirm_reconcile"]),
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
      tool("hub_release_run", "Persist one authorized release operation and return its operation id immediately. The durable owner continues compose, validation, publication and finalization without holding this MCP request open.", {
        workspace_id: { type: "string", description: "Defaults to the caller Workspace." },
        task_ids: { type: "array", minItems: 1, items: { type: "string" } },
        validation_mode: { type: "string", enum: ["focused", "full"] },
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

  async call(name, args = {}) {
    await this.#startupReconciliation;
    const context = this.#authorize(args.context_token);
    const toolName = String(name ?? "");
    if (MUTATING_TOOLS.has(toolName)) {
      const operation = () => this.#dispatch(context, toolName, args);
      return this.#mutate(context, toolName, args, operation);
    }
    return this.#dispatch(context, toolName, args);
  }

  async callTaskStatusCutover(args = {}, { verifySource } = {}) {
    await this.#startupReconciliation;
    const context = this.#authorize(args.context_token);
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
        return compactTask(this.#taskById(args.task_id));
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
      case "hub_task_operation_reconcile":
        if (!this.#isReleaseManager(context)) throw new Error("Task operation reconciliation requires a Release Manager Stream");
        if (args.confirm_reconcile !== true) throw new Error("Task operation reconciliation requires explicit confirmation");
        if (!this.taskOperationReconciliation) throw new Error("Task operation reconciliation is unavailable");
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
      tasks: this.taskBoard.snapshot()
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

  async #claimTask(context, { task_id: taskId, request_id: operationId, dependency_mode: dependencyMode = "skip", dependency_override_reason: dependencyOverrideReason = null } = {}) {
    const task = this.#task(context, taskId);
    const active = this.#currentRun(context);
    if (task.status === "done") throw new Error("Closed Tasks are an archive; claim an open Task");
    if (task.streamId && task.streamId !== context.streamId) {
      const threads = new Set((this.workspaceCatalog.stream(task.streamId)?.threads ?? []).map((thread) => (
        `${thread.provider}\0${thread.threadId}`
      )));
      if (this.#activeRuns().some((run) => run.streamId === task.streamId)
          || this.#deferredInputs().some((input) => input.streamId === task.streamId
            || threads.has(`${input.provider}\0${input.threadId}`))) {
        throw new Error("The other executor must finish its active and queued work before Task handoff");
      }
    }
    const projectRoot = this.#taskProjectRoot(context);
    const gitWorkspace = this.taskGitWorkspaces && projectRoot
      ? await this.taskGitWorkspaces.prepare({ taskId: task.id, taskNumber: task.taskNumber, projectRoot, dependencyMode, dependencyOverrideReason })
      : null;
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
      gitBaseline: active.gitBaseline ?? null,
    });
    return {
      ...compactTask(claimed),
      claimedTurnId: active.turnId,
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
  } = {}, { source = null } = {}) {
    if ((sourceTaskId != null || sourceTaskRevision != null) && !source) {
      throw new Error("Cross-Task cutover requires the supported local cutover entrypoint");
    }
    const task = this.#task(context, taskId);
    const workflowStatus = requiredText(status, "task workflow status", 40);
    const squashValues = [
      squashSourceTaskId, squashSourceTaskRevision, squashBaselineResultCommit,
      squashNewResultCommit, squashDevAfterTree,
    ];
    const squashRequested = [...squashValues, squashProofRequestId, expectedSquashTransferHash,
      expectedSquashCutoverHash]
      .some((value) => value != null);
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
    };
    const result = source
      ? await this.taskLifecycle.updateWorkflowStatusFromSource(options, source)
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
    return this.#releaseOperation().start({
      requestId: requiredText(args.request_id, "request id", 200),
      workspaceId,
      streamId: context.streamId,
      threadId: context.auditThreadId,
      authorization: {
        taskIds: Array.isArray(args.task_ids) ? args.task_ids : [],
        validationMode: requiredText(args.validation_mode, "validation mode", 32),
        approvedTargets: Array.isArray(args.approved_targets) ? args.approved_targets : [],
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
    return this.#releaseOperation().continue(operationId);
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
        status: run.status,
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
    if (selectedRun) state = !parsedCursor || cursorRun ? "active" : "replaced";
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

  async #mutate(context, toolName, args, operation) {
    const requestId = requiredText(args.request_id, "request id", 200);
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
    const started = await this.workspaceCatalog.beginMcpOperation({
      requestId,
      workspaceId: context.workspaceId,
      streamId: context.streamId,
      provider: context.provider,
      threadId: context.auditThreadId,
      toolName,
      argumentsHash: argumentsHash(args),
    });
    if (started.status === "succeeded") return started.result;
    if (started.status === "failed") throw new Error(started.error || "previous MCP operation failed");
    if (started.status === "unknown" && toolName === "hub_task_claim") {
      const reconciled = await this.#reconcileClaimAdmissionNoEffect(context, args, started).catch(() => null);
      if (reconciled) {
        const terminal = new Error(reconciled.error);
        await this.workspaceCatalog.failUnknownMcpOperation(requestId, {
          workspaceId: context.workspaceId,
          toolName,
          error: terminal,
          reconciliation: reconciled.evidence,
        });
        throw terminal;
      }
    }
    if (started.status === "unknown") {
      throw new Error(`MCP operation outcome is unknown; reconcile authoritatively before retrying request_id ${requestId}`);
    }
    const inFlight = this.#pendingMutations.get(requestId);
    if (inFlight) return inFlight;
    const resumable = new Set([
      "hub_task_start", "hub_task_reassign", "hub_task_status_update", "hub_task_complete", "hub_task_delete",
      "hub_task_checklist_update",
    ]);
    if (started.replayed && !resumable.has(toolName)) {
      const reason = new Error("MCP operation outcome requires authoritative reconciliation; blind replay is forbidden");
      await this.workspaceCatalog.markMcpOperationUnknown?.(requestId, reason);
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
        const result = await operation();
        effectCompleted = true;
        await this.workspaceCatalog.completeMcpOperation(requestId, result);
        return result;
      } catch (error) {
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
        if (error instanceof TaskInputValidationError || error instanceof TaskIntegrationConflictError || error instanceof TaskAwaitIntegrationError
            || error instanceof TaskDependencyPendingError || error instanceof TaskWithdrawalDependencyError
            || error instanceof TaskLifecycleBeginRejectedError || error instanceof TaskWithdrawalBusyError
            || error instanceof ReleaseCandidateFrozenError || error instanceof TaskAbsorptionCompositionError
            || error instanceof TaskSquashTransferRejectedError) {
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
    return pending;
  }

  async #reconcileClaimAdmissionNoEffect(context, args, receipt) {
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

  #hasPreparedTaskStart(context, args, requestId) {
    try {
      const task = this.#task(context, args.task_id);
      return task.startRequestId === requestId && ["starting", "started"].includes(task.status);
    } catch {
      return false;
    }
  }

}
