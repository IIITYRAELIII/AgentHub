import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, realpath, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  MAX_ATTACHMENT_BYTES,
  attachmentContentType,
  attachmentMetadataFromId,
  createAttachmentStorageName,
} from "../domain/attachment-files.mjs";
import {
  createInterstreamOrigin,
  createInterstreamMessage,
} from "../domain/interstream-message.mjs";
import { taskProjectRoot } from "../domain/task-project-root.mjs";
import { displayUserPrompt } from "./task-history.mjs";

const CONTEXT_TOKEN_VERSION = 1;
const MAX_REGISTERED_CONTEXT_CAPABILITIES = 1_000;
const STREAM_HISTORY_CURSOR_VERSION = 1;
const DEFAULT_HISTORY_ACTIVITY_LIMIT = 40;
const MUTATING_TOOLS = new Set([
  "hub_task_create", "hub_task_update", "hub_task_move", "hub_task_start", "hub_task_reassign", "hub_task_claim", "hub_task_status_update", "hub_task_legacy_git_adopt", "hub_task_complete", "hub_task_delete",
  "hub_task_attachment_add", "hub_workspace_rules_update", "hub_stream_rules_update",
  "hub_stream_message_send",
  "hub_release_preflight", "hub_release_complete",
]);

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

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
}

function argumentsHash(args) {
  const value = { ...args };
  delete value.context_token;
  return createHash("sha256").update(JSON.stringify(canonicalValue(value)), "utf8").digest("hex");
}

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
    prompt: compactText(displayUserPrompt(run?.promptPreview), 2_000),
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
    workspaceId: task.workspaceId,
    streamId: task.streamId,
    boardOrder: task.boardOrder,
    source: task.source,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    startedAt: task.startedAt,
    completedAt: task.completedAt,
    revision: task.revision,
    workLog: task.workLog ?? [],
    gitReferences: task.gitReferences ?? [],
    gitAdoptions: task.gitAdoptions ?? [],
    attachments: task.attachments ?? [],
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

  constructor({
    workspaceCatalog, taskBoard, workLog, attachmentDirectory, secret, releasePlanner, releasePreflight, releaseCompleter,
    taskGitWorkspaces = null,
  } = {}) {
    for (const name of [
      "resolveThread", "workspace", "hierarchy", "developerRulesForStream",
      "updateWorkspaceDeveloperRules", "updateStreamDeveloperRules",
      "beginMcpOperation", "completeMcpOperation", "failMcpOperation", "mcpOperations",
      "stream", "activeThread", "workspaceEvents",
    ]) requiredMethod(workspaceCatalog, name);
    for (const name of [
      "snapshot", "task", "create", "move", "update", "markStarted", "complete", "addAttachment",
      "claim", "requestWorkflowStatus", "releaseTasks",
      "adoptLegacyGitReference",
    ]) {
      requiredMethod(taskBoard, name);
    }
    requiredMethod(workLog, "threadTurns");
    requiredMethod(releasePreflight, "preflight");
    requiredMethod(releaseCompleter, "completeRelease");
    this.workspaceCatalog = workspaceCatalog;
    this.taskBoard = taskBoard;
    this.workLog = workLog;
    this.attachmentDirectory = path.resolve(requiredText(attachmentDirectory, "attachment directory", 2_000));
    this.secret = requiredText(secret, "MCP secret", 512);
    this.releasePreflight = releasePreflight;
    this.releaseCompleter = releaseCompleter;
    this.releasePlanner = releasePlanner;
    this.taskGitWorkspaces = taskGitWorkspaces;
  }

  setActiveRuns(value) {
    if (typeof value !== "function") throw new TypeError("active runs provider is required");
    this.#activeRuns = value;
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
      tool("hub_parallel_streams_list", "List Streams and occupancy for any existing Workspace.", {
        workspace_id: { type: "string", description: "Defaults to the caller Workspace." },
      }),
      tool("hub_active_runs_list", "List compact live-run status for any existing Workspace.", {
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
          description: "Queue after the active turn, or steer the active turn and queue if steering is no longer possible.",
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
        title: { type: "string" },
        description: { type: "string", default: "" },
      }, ["title"]),
      tool("hub_task_update", "Update the number, title or description of any Dashboard task by id.", {
        task_id: { type: "string" },
        task_number: { type: "string" },
        title: { type: "string" },
        description: { type: "string" },
      }, ["task_id"]),
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
      tool("hub_task_claim", "Bind a Dashboard Task to the exact current provider turn, assign its dedicated Git branch/worktree, and make the current Stream its executor. Continue repository work only in the returned gitWorkspace.projectRoot.", {
        task_id: { type: "string" },
      }, ["task_id"]),
      tool("hub_task_status_update", "Always change a Dashboard Task to any valid workflow status. Await snapshots its Task branch and merges it into dev; Git conflicts are reported but never block the status transition. Done remains visible and does not close the Task.", {
        task_id: { type: "string" },
        status: { type: "string", enum: ["new", "in_progress", "testing", "awaiting_implementation", "done"] },
      }, ["task_id", "status"]),
      tool("hub_task_legacy_git_adopt", "Architect-only migration for a legacy Await Task with no Git reference. It verifies terminal Stream evidence and exact non-changelog patch equivalence to a named commit already in local main before recording immutable Task evidence.", {
        task_id: { type: "string" },
        expected_task_revision: { type: "integer", minimum: 1 },
        evidence_turn_id: { type: "string" },
        reported_result_commit: { type: "string" },
        main_result_commit: { type: "string" },
        confirm_adoption: { type: "boolean", description: "Must be true because this creates release-authority Git references for legacy work." },
      }, ["task_id", "expected_task_revision", "evidence_turn_id", "reported_result_commit", "main_result_commit", "confirm_adoption"]),
      tool("hub_task_complete", "Close and hide a Dashboard task after customer acceptance or when delivery is not required.", {
        task_id: { type: "string" },
      }, ["task_id"]),
      tool("hub_task_delete", "Permanently delete any Dashboard task by id.", {
        task_id: { type: "string" },
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
      tool("hub_release_preflight", "Refresh Test Contour from dev and verify the exact selected Task results are integrated before release.", {
        workspace_id: { type: "string", description: "Defaults to the caller Workspace." },
        expected_plan_revision: { type: "string", description: "Exact revision returned by hub_release_plan_get." },
        conflicts_resolved: { type: "boolean", description: "True only after the Architect explicitly resolves every reported overlap." },
      }, ["expected_plan_revision"]),
      tool("hub_release_complete", "Complete a release only after clean main revisions and explicit deployment verification.", {
        workspace_id: { type: "string", description: "Defaults to the caller Workspace." },
        expected_revision: { type: "string" },
        expected_plan_revision: { type: "string", description: "Exact revision returned by hub_release_plan_get." },
        deployment_verified: { type: "boolean" },
        verification_summary: { type: "string" },
        conflicts_resolved: { type: "boolean", description: "True only after the Architect explicitly resolves every reported overlap." },
      }, ["expected_plan_revision", "deployment_verified", "verification_summary"]),
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
    const context = this.#authorize(args.context_token);
    const toolName = String(name ?? "");
    if (MUTATING_TOOLS.has(toolName)) {
      return this.#mutate(context, toolName, args, () => this.#dispatch(context, toolName, args));
    }
    return this.#dispatch(context, toolName, args);
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
      case "hub_task_move":
        return this.#moveTask(context, args);
      case "hub_task_start":
        return this.#startTask(context, args);
      case "hub_task_reassign":
        return this.#startTask(context, args, { reassign: true });
      case "hub_task_claim":
        return this.#claimTask(context, args);
      case "hub_task_status_update":
        return this.#updateTaskWorkflowStatus(context, args);
      case "hub_task_legacy_git_adopt":
        if (!this.#isArchitect(context)) throw new Error("legacy Git adoption requires an Architect Stream");
        return this.#adoptLegacyTaskGit(context, args);
      case "hub_task_complete":
        return this.#completeTask(context, args);
      case "hub_task_delete": {
        const task = this.#task(context, args.task_id);
        this.taskBoard.remove({ id: task.id });
        await this.taskGitWorkspaces?.cleanup?.(task.id);
        return { deleted: true, task: compactTask(task) };
      }
      case "hub_task_attachment_read":
        return this.#readAttachment(context, args);
      case "hub_task_attachment_add":
        return this.#addAttachment(context, args);
      case "hub_release_plan_get":
        return this.#releasePlan(context, args);
      case "hub_release_preflight":
        if (!this.#isArchitect(context)) throw new Error("release preflight requires an Architect Stream");
        return this.#preflightRelease(context, args);
      case "hub_release_complete":
        if (!this.#isArchitect(context)) throw new Error("release completion requires an Architect Stream");
        return this.#completeRelease(context, args);
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
          queuedInputCount: queuedInputs.length,
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
    const task = this.taskBoard.snapshot().find((candidate) => candidate.id === id);
    if (!task) throw new Error("task not found");
    return task;
  }

  #createTask(context, { workspace_id: workspaceId = null, title, description = "" } = {}) {
    const targetWorkspace = this.#workspace(context, workspaceId);
    const normalizedTitle = requiredText(title, "task title", 10_000);
    const normalizedDescription = optionalText(description, 50_000) ?? "";
    const text = normalizedDescription ? `${normalizedTitle}\n\n${normalizedDescription}` : normalizedTitle;
    const created = this.taskBoard.create({
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

  #updateTask(context, { task_id: taskId, task_number: taskNumber, title, description } = {}) {
    const current = this.#task(context, taskId);
    const nextTitle = title == null ? current.title : requiredText(title, "task title", 10_000);
    const nextDescription = description == null
      ? current.description
      : (optionalText(description, 50_000) ?? "");
    return compactTask(this.taskBoard.update({
      id: current.id,
      taskNumber: taskNumber == null ? undefined : requiredText(taskNumber, "task number", 80),
      title: nextTitle,
      description: nextDescription,
    }));
  }

  #moveTask(context, {
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
    return compactTask(this.taskBoard.move({
      id: current.id,
      bucket: target,
      workspaceId: targetWorkspaceId,
      beforeId: beforeTaskId,
    }));
  }

  async #claimTask(context, { task_id: taskId, request_id: operationId } = {}) {
    const task = this.#task(context, taskId);
    const active = this.#currentRun(context);
    const projectRoot = this.#taskProjectRoot(context);
    const gitWorkspace = this.taskGitWorkspaces && projectRoot
      ? await this.taskGitWorkspaces.prepare({ taskId: task.id, taskNumber: task.taskNumber, projectRoot })
      : null;
    if (gitWorkspace) active.gitBaseline = gitWorkspace.gitBaseline;
    return {
      ...compactTask(this.taskBoard.claim({
        id: task.id,
        workspaceId: context.workspaceId,
        streamId: context.streamId,
        provider: context.provider,
        threadId: context.threadId,
        turnId: active.turnId,
        operationId,
        operationKind: "claim",
        gitBaseline: active.gitBaseline ?? null,
      })),
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

  async #updateTaskWorkflowStatus(context, { task_id: taskId, status } = {}) {
    const task = this.#task(context, taskId);
    const workflowStatus = requiredText(status, "task workflow status", 40);
    let gitWorkspace = null;
    let preparationError = null;
    const snapshotsResult = ["testing", "awaiting_implementation", "done"].includes(workflowStatus);
    const targetStreamId = String(task.streamId ?? "").trim() || context.streamId;
    const projectRoot = snapshotsResult && targetStreamId
      ? this.#taskProjectRoot(context, targetStreamId, task.workspaceId)
      : null;
    if (snapshotsResult && projectRoot && this.taskGitWorkspaces) {
      try {
        gitWorkspace = await this.taskGitWorkspaces.prepare({
          taskId: task.id, taskNumber: task.taskNumber, projectRoot,
        });
      } catch (error) {
        preparationError = error;
      }
    }
    const updated = this.taskBoard.requestWorkflowStatus({
      id: task.id,
      status: workflowStatus,
      provider: context.provider,
      threadId: context.threadId,
      turnId: null,
    });
    if (!snapshotsResult) return compactTask(updated);
    if (!gitWorkspace) {
      return {
        ...compactTask(updated),
        gitIntegration: {
          integrated: false,
          error: preparationError?.message ?? "Task Git workspace is unavailable for this turn",
        },
      };
    }
    try {
      const { snapshot, integration } = await this.taskGitWorkspaces.snapshotAndMerge({
        taskId: task.id,
        taskNumber: task.taskNumber,
        projectRoot: gitWorkspace.projectRoot,
        turnId: null,
        summary: task.title,
      });
      if (integration.integrated && snapshot.changedFiles.length) {
        this.taskBoard.recordTaskGitReference({
          taskId: task.id,
          projectRoot: snapshot.repositoryRoot,
          resultSnapshot: snapshot.resultSnapshot,
          branch: snapshot.branch,
        });
      }
      const current = this.#task(context, task.id);
      return {
        ...compactTask(current),
        gitWorkspace: {
          branch: snapshot.branch,
          projectRoot: snapshot.projectRoot,
          baseCommit: snapshot.baseCommit,
          headCommit: snapshot.headCommit,
        },
        gitIntegration: {
          integrated: integration.integrated,
          alreadyIntegrated: integration.alreadyIntegrated === true,
          devBranch: integration.dev?.branch ?? "dev",
          devHeadCommit: integration.dev?.headCommit ?? null,
          conflicts: integration.conflicts ?? [],
          error: integration.error ?? null,
        },
      };
    } catch (error) {
      return {
        ...compactTask(this.#task(context, task.id)),
        gitIntegration: { integrated: false, error: error.message },
      };
    }
  }

  async #completeTask(context, { task_id: taskId } = {}) {
    const task = this.#task(context, taskId);
    const completed = this.taskBoard.complete({ id: task.id });
    await this.taskGitWorkspaces?.cleanup?.(task.id);
    return compactTask(completed);
  }

  #isArchitect(context) {
    return this.#workspace(context).streams.some((stream) => (
      stream.id === context.streamId && stream.settings?.architect === true
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
    if (task.workspaceId !== context.workspaceId) throw new Error("Task is outside the Architect Workspace");
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
    const adopted = this.taskBoard.adoptLegacyGitReference({
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
        const dev = await this.taskGitWorkspaces.prepareDev(projectRoot);
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

  async #completeRelease(context, args) {
    const workspaceId = this.#workspace(context, args.workspace_id).id;
    const result = await this.releaseCompleter.completeRelease({
      workspaceId,
      expectedRevision: optionalText(args.expected_revision, 128),
      expectedPlanRevision: optionalText(args.expected_plan_revision, 128),
      deploymentVerified: args.deployment_verified === true,
      verificationSummary: optionalText(args.verification_summary, 2_000) ?? "",
      conflictsResolved: args.conflicts_resolved === true,
    });
    const cleanupErrors = [];
    for (const task of result.released ?? []) {
      try {
        await this.taskGitWorkspaces?.cleanup?.(task.id);
      } catch (error) {
        cleanupErrors.push({ taskId: task.id, error: error.message });
      }
    }
    return { ...result, cleanupErrors };
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
    }, { ...context, messageOrigin });
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
    const delivery = await this.#streamMessenger({
      streamId: targetStreamId,
      text: message,
      clientUserMessageId: `mcp:${normalizedRequestId}`,
      followUpMode,
    }, {
      source: "mcp",
      clientId: `mcp:${context.provider}:${context.auditThreadId}`,
      messageOrigin,
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
      return [{ id: String(input?.id ?? ""), streamId }];
    });
  }

  #activeRunsForWorkspace(context, { workspace_id: workspaceId = null } = {}) {
    const targetWorkspaceId = this.#workspace(context, workspaceId).id;
    return { workspaceId: targetWorkspaceId, runs: this.#activeRunSummaries(targetWorkspaceId) };
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
      this.taskBoard.addAttachment({ id: task.id, attachment: target });
    } catch (error) {
      await unlink(target).catch(() => {});
      throw error;
    }
    const updated = this.#task(context, task.id);
    return {
      task: compactTask(updated),
      attachment: {
        ...attachmentMetadataFromId(id),
        type: attachmentContentType(path.basename(source)),
        size: body.length,
      },
    };
  }

  async #mutate(context, toolName, args, operation) {
    const requestId = requiredText(args.request_id, "request id", 200);
    const started = this.workspaceCatalog.beginMcpOperation({
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
    const inFlight = this.#pendingMutations.get(requestId);
    if (inFlight) return inFlight;
    if (started.replayed && !["hub_task_start", "hub_task_reassign"].includes(toolName)) {
      throw new Error("MCP operation with this request_id is still pending");
    }
    const pending = (async () => {
      try {
        const result = await operation();
        this.workspaceCatalog.completeMcpOperation(requestId, result);
        return result;
      } catch (error) {
        if (["hub_task_start", "hub_task_reassign"].includes(toolName)
          && this.#hasPreparedTaskStart(context, args, requestId)) {
          throw error;
        }
        this.workspaceCatalog.failMcpOperation(requestId, error);
        throw error;
      } finally {
        this.#pendingMutations.delete(requestId);
      }
    })();
    this.#pendingMutations.set(requestId, pending);
    return pending;
  }

  #hasPreparedTaskStart(context, args, requestId) {
    try {
      const task = this.#task(context, args.task_id);
      return task.startRequestId === requestId && ["starting", "started"].includes(task.status);
    } catch {
      return false;
    }
  }

  async #preflightRelease(context, args) {
    const workspaceId = this.#workspace(context, args.workspace_id).id;
    return this.releasePreflight.preflight({
      workspaceId,
      expectedPlanRevision: optionalText(args.expected_plan_revision, 128),
      conflictsResolved: args.conflicts_resolved === true,
    });
  }
}
