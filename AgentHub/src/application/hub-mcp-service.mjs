import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { copyFile, mkdir, readFile, stat, unlink } from "node:fs/promises";
import path from "node:path";

import {
  MAX_ATTACHMENT_BYTES,
  attachmentContentType,
  attachmentMetadataFromId,
  createAttachmentStorageName,
} from "../domain/attachment-files.mjs";
import { createInterstreamMessage } from "../domain/interstream-message.mjs";

const CONTEXT_TOKEN_VERSION = 1;
const RELEASE_STATUSES = new Set(["draft", "ready", "blocked", "discarded"]);
const MUTATING_TOOLS = new Set([
  "hub_task_create", "hub_task_update", "hub_task_move", "hub_task_start", "hub_task_complete", "hub_task_delete",
  "hub_task_attachment_add", "hub_workspace_rules_update", "hub_stream_rules_update",
  "hub_stream_message_send",
  "hub_release_change_status", "hub_release_complete",
]);
const TEXT_ATTACHMENT_TYPES = new Set([
  "text/plain", "text/markdown", "text/csv", "application/json", "application/xml",
]);

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

function compactText(value, maximumLength) {
  const text = typeof value === "string"
    ? value
    : JSON.stringify(value ?? "");
  return text.length <= maximumLength ? text : `${text.slice(0, maximumLength)}\n…[truncated]`;
}

function compactTask(task) {
  return {
    id: task.id,
    title: task.title,
    description: task.description,
    text: task.text,
    bucket: task.bucket,
    status: task.status,
    workspaceId: task.workspaceId,
    streamId: task.streamId,
    boardOrder: task.boardOrder,
    source: task.source,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    startedAt: task.startedAt,
    completedAt: task.completedAt,
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
  #taskLauncher = async () => { throw new Error("Agent Hub task launcher is not ready"); };
  #streamMessenger = async () => { throw new Error("Agent Hub Stream messenger is not ready"); };

  constructor({ workspaceCatalog, taskBoard, workLog, attachmentDirectory, secret, releaseCompleter } = {}) {
    for (const name of [
      "resolveThread", "workspace", "hierarchy", "releaseRegistry", "releasePlan",
      "updateReleaseChangeStatus", "releaseChanges", "developerRulesForStream",
      "updateWorkspaceDeveloperRules", "updateStreamDeveloperRules",
      "beginMcpOperation", "completeMcpOperation", "failMcpOperation", "mcpOperations",
      "stream", "activeThread", "workspaceEvents",
    ]) requiredMethod(workspaceCatalog, name);
    for (const name of [
      "snapshot", "task", "create", "move", "update", "markStarted", "complete", "addAttachment",
    ]) {
      requiredMethod(taskBoard, name);
    }
    requiredMethod(workLog, "threadTurns");
    requiredMethod(releaseCompleter, "completeRelease");
    this.workspaceCatalog = workspaceCatalog;
    this.taskBoard = taskBoard;
    this.workLog = workLog;
    this.attachmentDirectory = path.resolve(requiredText(attachmentDirectory, "attachment directory", 2_000));
    this.secret = requiredText(secret, "MCP secret", 512);
    this.releaseCompleter = releaseCompleter;
  }

  setActiveRuns(value) {
    if (typeof value !== "function") throw new TypeError("active runs provider is required");
    this.#activeRuns = value;
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
      tool("hub_workspace_get", "Return the current Workspace and all of its Streams and Threads."),
      tool("hub_parallel_streams_list", "List Streams running in parallel inside the current Workspace."),
      tool("hub_active_runs_list", "List compact live-run status for the current Workspace."),
      tool("hub_stream_history", "Read bounded recent turn summaries for one Stream in the current Workspace.", {
        stream_id: { type: "string", description: "Defaults to the current Stream." },
        limit: { type: "integer", minimum: 1, maximum: 50, default: 20 },
        include_body: { type: "boolean", default: true },
      }),
      tool("hub_stream_message_send", "Send a visible message from the current Stream to another Stream in the current Workspace through the normal Hub admission queue.", {
        stream_id: { type: "string", description: "Target Stream in the current Workspace." },
        text: { type: "string" },
        mode: {
          type: "string",
          enum: ["queue", "steer"],
          default: "queue",
          description: "Queue after the active turn, or steer the active turn and queue if steering is no longer possible.",
        },
        confirm_send: { type: "boolean", description: "Must be true because this starts, queues or steers another agent turn." },
      }, ["stream_id", "text", "confirm_send"]),
      tool("hub_rules_get", "Read effective Workspace and current Stream developer rules."),
      tool("hub_workspace_rules_update", "Replace developer rules for the current Workspace.", {
        content: { type: "string" },
      }, ["content"]),
      tool("hub_stream_rules_update", "Replace developer rules for the current Stream.", {
        content: { type: "string" },
      }, ["content"]),
      tool("hub_tasks_list", "List Dashboard tasks assigned to the current Workspace.", {
        include_completed: { type: "boolean", default: false },
        limit: { type: "integer", minimum: 1, maximum: 100, default: 50 },
      }),
      tool("hub_task_get", "Read one Dashboard task from the current Workspace.", {
        task_id: { type: "string" },
      }, ["task_id"]),
      tool("hub_task_create", "Create a Dashboard task in the current Workspace without automatic triage.", {
        title: { type: "string" },
        description: { type: "string", default: "" },
      }, ["title"]),
      tool("hub_task_update", "Update the title or description of a Dashboard task in the current Workspace.", {
        task_id: { type: "string" },
        title: { type: "string" },
        description: { type: "string" },
      }, ["task_id"]),
      tool("hub_task_move", "Move or reorder a current-Workspace task on the Dashboard.", {
        task_id: { type: "string" },
        destination: { type: "string", enum: ["workspace", "backlog", "notes"] },
        before_task_id: { type: "string" },
      }, ["task_id", "destination"]),
      tool("hub_task_start", "Send a Dashboard task into an existing or new Stream through the normal Hub queue, then mark it started.", {
        task_id: { type: "string" },
        stream_id: { type: "string", description: "Existing Stream in this Workspace. Defaults to the current Stream." },
        new_stream_name: { type: "string", description: "Create a new Stream instead of using stream_id." },
        provider: { type: "string", enum: ["codex", "claude"] },
        confirm_launch: { type: "boolean", description: "Must be true because this starts or queues another agent turn." },
      }, ["task_id", "confirm_launch"]),
      tool("hub_task_complete", "Mark a Dashboard task from the current Workspace as completed.", {
        task_id: { type: "string" },
      }, ["task_id"]),
      tool("hub_task_delete", "Permanently delete a Dashboard task owned by the current Workspace.", {
        task_id: { type: "string" },
      }, ["task_id"]),
      tool("hub_task_attachment_read", "Read metadata and bounded text for one task attachment.", {
        task_id: { type: "string" },
        attachment_id: { type: "string" },
        max_text_bytes: { type: "integer", minimum: 1, maximum: 131072, default: 65536 },
      }, ["task_id", "attachment_id"]),
      tool("hub_task_attachment_add", "Copy a local project file into a current-Workspace task.", {
        task_id: { type: "string" },
        local_path: { type: "string" },
      }, ["task_id", "local_path"]),
      tool("hub_release_plan_get", "Read the complete release plan for the current Workspace."),
      tool("hub_release_change_status", "Set readiness of a current-Workspace release entry.", {
        change_id: { type: "string" },
        status: { type: "string", enum: [...RELEASE_STATUSES] },
      }, ["change_id", "status"]),
      tool("hub_release_complete", "Complete a release only after clean main revisions and explicit deployment verification.", {
        expected_revision: { type: "string" },
        deployment_verified: { type: "boolean" },
        verification_summary: { type: "string" },
      }, ["deployment_verified", "verification_summary"]),
      tool("hub_events_list", "Read bounded persistent Workspace events after a cursor; this never holds a long poll.", {
        after_sequence: { type: "integer", minimum: 0, default: 0 },
        limit: { type: "integer", minimum: 1, maximum: 100, default: 50 },
      }),
      tool("hub_mcp_operations_list", "List recent audited MCP mutations for the current Workspace.", {
        limit: { type: "integer", minimum: 1, maximum: 100, default: 50 },
      }),
    ];
  }

  contextToken({ provider, threadId = null, streamId = null } = {}) {
    const normalizedThreadId = String(threadId ?? "").trim();
    const normalizedStreamId = String(streamId ?? "").trim();
    if (!normalizedThreadId && !normalizedStreamId) throw new Error("Thread or Stream context is required");
    const payload = Buffer.from(JSON.stringify({
      v: CONTEXT_TOKEN_VERSION,
      provider: requiredText(provider, "provider", 100),
      ...(normalizedThreadId ? { threadId: requiredText(normalizedThreadId, "thread id", 300) } : {}),
      ...(normalizedStreamId ? { streamId: requiredText(normalizedStreamId, "stream id", 300) } : {}),
    }), "utf8").toString("base64url");
    return `${payload}.${this.#signature(payload)}`;
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
      "The server restricts this capability to the current Workspace.",
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
        return this.#workspace(context);
      case "hub_parallel_streams_list":
        return this.#parallelStreams(context);
      case "hub_active_runs_list":
        return this.#activeRunsForWorkspace(context);
      case "hub_stream_history":
        return this.#streamHistory(context, args);
      case "hub_stream_message_send":
        return this.#sendStreamMessage(context, args);
      case "hub_rules_get":
        return this.workspaceCatalog.developerRulesForStream(context.streamId);
      case "hub_workspace_rules_update":
        return this.workspaceCatalog.updateWorkspaceDeveloperRules(
          context.workspaceId,
          optionalText(args.content, 32 * 1024) ?? "",
        );
      case "hub_stream_rules_update":
        return this.workspaceCatalog.updateStreamDeveloperRules(
          context.streamId,
          optionalText(args.content, 32 * 1024) ?? "",
        );
      case "hub_tasks_list":
        return this.#tasks(context, args);
      case "hub_task_get":
        return compactTask(this.#task(context, args.task_id));
      case "hub_task_create":
        return this.#createTask(context, args);
      case "hub_task_update":
        return this.#updateTask(context, args);
      case "hub_task_move":
        return this.#moveTask(context, args);
      case "hub_task_start":
        return this.#startTask(context, args);
      case "hub_task_complete":
        return compactTask(this.taskBoard.complete({ id: this.#task(context, args.task_id).id }));
      case "hub_task_delete": {
        const task = this.#task(context, args.task_id);
        this.taskBoard.remove({ id: task.id });
        return { deleted: true, task: compactTask(task) };
      }
      case "hub_task_attachment_read":
        return this.#readAttachment(context, args);
      case "hub_task_attachment_add":
        return this.#addAttachment(context, args);
      case "hub_release_plan_get":
        return this.workspaceCatalog.releasePlan(context.workspaceId);
      case "hub_release_change_status":
        return this.#setReleaseStatus(context, args);
      case "hub_release_complete":
        return this.releaseCompleter.completeRelease({
          workspaceId: context.workspaceId,
          expectedRevision: optionalText(args.expected_revision, 128),
          deploymentVerified: args.deployment_verified === true,
          verificationSummary: optionalText(args.verification_summary, 2_000) ?? "",
        });
      case "hub_events_list":
        return this.#events(context, args);
      case "hub_mcp_operations_list":
        return {
          workspaceId: context.workspaceId,
          operations: this.workspaceCatalog.mcpOperations(context.workspaceId, { limit: args.limit })
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
      default:
        throw new Error(`unknown Agent Hub MCP tool: ${name}`);
    }
  }

  #signature(payload) {
    return createHmac("sha256", this.secret).update(payload).digest("base64url");
  }

  #authorize(value) {
    if (!String(value ?? "").trim()) {
      throw new Error("missing Agent Hub context_token: copy the exact value from the current <agent_hub_context> developer block; do not search environment variables");
    }
    const token = requiredText(value, "context token", 2_000);
    const separator = token.lastIndexOf(".");
    if (separator <= 0) throw new Error("invalid Agent Hub context capability");
    const payload = token.slice(0, separator);
    const supplied = Buffer.from(token.slice(separator + 1), "base64url");
    const expected = Buffer.from(this.#signature(payload), "base64url");
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      throw new Error("invalid Agent Hub context capability");
    }
    let identity;
    try {
      identity = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    } catch {
      throw new Error("invalid Agent Hub context capability");
    }
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

  #workspace(context) {
    const workspace = this.workspaceCatalog.hierarchy()
      .find((candidate) => candidate.id === context.workspaceId);
    if (!workspace) throw new Error("Agent Hub Workspace not found");
    return { ...workspace, currentStreamId: context.streamId };
  }

  #parallelStreams(context) {
    const workspace = this.#workspace(context);
    return {
      workspaceId: context.workspaceId,
      currentStreamId: context.streamId,
      streams: workspace.streams.map((stream) => ({
        ...stream,
        current: stream.id === context.streamId,
        activeRuns: this.#activeRunSummaries(context.workspaceId)
          .filter((run) => run.streamId === stream.id),
      })),
    };
  }

  #tasks(context, { include_completed: includeCompleted = false, limit = 50 } = {}) {
    const boundedLimit = Math.max(1, Math.min(100, Number(limit) || 50));
    return {
      workspaceId: context.workspaceId,
      tasks: this.taskBoard.snapshot()
        .filter((task) => this.#taskBelongsToWorkspace(task, context.workspaceId))
        .filter((task) => includeCompleted || task.status !== "done")
        .slice(0, boundedLimit)
        .map(compactTask),
    };
  }

  #task(context, taskId) {
    const id = requiredText(taskId, "task id", 300);
    const task = this.taskBoard.snapshot().find((candidate) => candidate.id === id);
    if (!task) throw new Error("task not found");
    if (!this.#taskBelongsToWorkspace(task, context.workspaceId)) {
      throw new Error("task is outside the current Workspace");
    }
    return task;
  }

  #taskBelongsToWorkspace(task, workspaceId) {
    return task?.workspaceId === workspaceId
      || task?.sourceDetails?.mcpWorkspaceId === workspaceId;
  }

  #createTask(context, { title, description = "" } = {}) {
    const normalizedTitle = requiredText(title, "task title", 10_000);
    const normalizedDescription = optionalText(description, 50_000) ?? "";
    const text = normalizedDescription ? `${normalizedTitle}\n\n${normalizedDescription}` : normalizedTitle;
    const created = this.taskBoard.create({
      text,
      source: "hub-mcp",
      sourceDetails: { mcpWorkspaceId: context.workspaceId },
    });
    return compactTask(this.taskBoard.move({
      id: created.id,
      bucket: "workspace",
      workspaceId: context.workspaceId,
    }));
  }

  #updateTask(context, { task_id: taskId, title, description } = {}) {
    const current = this.#task(context, taskId);
    const nextTitle = title == null ? current.title : requiredText(title, "task title", 10_000);
    const nextDescription = description == null
      ? current.description
      : (optionalText(description, 50_000) ?? "");
    return compactTask(this.taskBoard.update({
      id: current.id,
      title: nextTitle,
      description: nextDescription,
    }));
  }

  #moveTask(context, { task_id: taskId, destination, before_task_id: beforeTaskId = null } = {}) {
    const current = this.#task(context, taskId);
    const target = requiredText(destination, "task destination", 30);
    if (!["workspace", "backlog", "notes"].includes(target)) throw new Error("invalid task destination");
    if (beforeTaskId) {
      const before = this.#task(context, requiredText(beforeTaskId, "before task id", 300));
      const targetWorkspaceId = target === "workspace" ? context.workspaceId : null;
      if (before.bucket !== target || before.workspaceId !== targetWorkspaceId) {
        throw new Error("before task is outside the destination column");
      }
    }
    return compactTask(this.taskBoard.move({
      id: current.id,
      bucket: target,
      workspaceId: target === "workspace" ? context.workspaceId : null,
      beforeId: beforeTaskId,
    }));
  }

  #setReleaseStatus(context, { change_id: changeId, status } = {}) {
    const normalizedChangeId = requiredText(changeId, "release change id", 300);
    const normalizedStatus = requiredText(status, "release status", 30);
    if (!RELEASE_STATUSES.has(normalizedStatus)) throw new Error("invalid release status");
    const changes = this.workspaceCatalog.releaseChanges(context.workspaceId);
    if (!changes.some((change) => change.id === normalizedChangeId)) {
      throw new Error("release change is outside the current Workspace");
    }
    return this.workspaceCatalog.updateReleaseChangeStatus(normalizedChangeId, normalizedStatus);
  }

  async #startTask(context, {
    task_id: taskId, stream_id: streamId = null, new_stream_name: newStreamName = null,
    provider = null, confirm_launch: confirmLaunch = false,
  } = {}) {
    if (confirmLaunch !== true) throw new Error("confirm_launch must be true");
    const task = this.#task(context, taskId);
    const requestedStreamId = String(streamId ?? "").trim();
    const requestedStreamName = String(newStreamName ?? "").trim();
    if (requestedStreamId && requestedStreamName) {
      throw new Error("stream_id and new_stream_name are mutually exclusive");
    }
    const result = await this.#taskLauncher({
      id: task.id,
      workspaceId: context.workspaceId,
      streamId: requestedStreamName ? null : (requestedStreamId || context.streamId),
      streamName: requestedStreamName || null,
      provider: String(provider ?? "").trim() || context.provider,
      followUpMode: "queue",
    }, context);
    return {
      task: compactTask(result.task),
      target: {
        streamId: result.target.streamId,
        provider: result.target.provider,
        threadId: result.target.threadId ?? null,
      },
      delivery: result.delivery ?? null,
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
    const targetStream = this.#workspace(context).streams
      .find((candidate) => candidate.id === targetStreamId);
    if (!targetStream) throw new Error("Stream is outside the current Workspace");
    const followUpMode = requiredText(mode, "message mode", 20).toLowerCase();
    if (!new Set(["queue", "steer"]).has(followUpMode)) throw new Error("invalid message mode");
    const message = createInterstreamMessage({
      workspaceId: context.workspaceId,
      workspaceName: context.workspaceName,
      streamId: context.streamId,
      streamName: context.streamName,
      provider: context.provider,
      text: requiredText(text, "message text", 100_000),
    });
    const delivery = await this.#streamMessenger({
      streamId: targetStreamId,
      text: message,
      clientUserMessageId: `mcp:${requestId}`,
      followUpMode,
    }, {
      source: "mcp",
      clientId: `mcp:${context.provider}:${context.auditThreadId}`,
    });
    return {
      source: {
        workspaceId: context.workspaceId,
        workspaceName: context.workspaceName,
        streamId: context.streamId,
        streamName: context.streamName,
        provider: context.provider,
      },
      target: {
        workspaceId: context.workspaceId,
        streamId: targetStreamId,
        streamName: targetStream.displayName ?? targetStream.name ?? "",
      },
      delivery,
    };
  }

  #events(context, { after_sequence: afterSequence = 0, limit = 50 } = {}) {
    const events = this.workspaceCatalog.workspaceEvents(context.workspaceId, { afterSequence, limit });
    return {
      workspaceId: context.workspaceId,
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

  #activeRunsForWorkspace(context) {
    return { workspaceId: context.workspaceId, runs: this.#activeRunSummaries(context.workspaceId) };
  }

  async #streamHistory(context, { stream_id: streamId = null, limit = 20, include_body: includeBody = true } = {}) {
    const targetStreamId = String(streamId ?? "").trim() || context.streamId;
    const workspace = this.#workspace(context);
    const stream = workspace.streams.find((candidate) => candidate.id === targetStreamId);
    if (!stream) throw new Error("Stream is outside the current Workspace");
    const records = await this.workLog.threadTurns(stream.threads, { limit });
    return {
      workspaceId: context.workspaceId,
      streamId: targetStreamId,
      turns: records.map((record) => ({
        provider: record.provider,
        threadId: record.threadId,
        turnId: record.turnId,
        title: compactText(record.title, 500),
        prompt: compactText(record.prompt, 2_000),
        ...(includeBody ? { body: compactText(record.body, 6_000) } : {}),
        startedAt: record.startedAt,
        completedAt: record.completedAt,
        status: record.status ?? null,
      })),
    };
  }

  #taskAttachment(context, taskId, attachmentId) {
    const task = compactTask(this.#task(context, taskId));
    const id = requiredText(attachmentId, "attachment id", 300);
    const attachment = task.attachments.find((candidate) => candidate.id === id);
    if (!attachment) throw new Error("attachment is outside the selected task");
    const metadata = attachmentMetadataFromId(id);
    if (!metadata) throw new Error("invalid attachment id");
    return { task, attachment: metadata, file: path.join(this.attachmentDirectory, metadata.id) };
  }

  async #readAttachment(context, {
    task_id: taskId, attachment_id: attachmentId, max_text_bytes: maxTextBytes = 65_536,
  } = {}) {
    const { attachment, file } = this.#taskAttachment(context, taskId, attachmentId);
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
    if (!inside(projectRoot, source) && !inside(this.attachmentDirectory, source)) {
      throw new Error("attachment source is outside the current project");
    }
    const details = await stat(source);
    if (!details.isFile() || details.size < 1 || details.size > MAX_ATTACHMENT_BYTES) {
      throw new Error("attachment size is not supported");
    }
    await mkdir(this.attachmentDirectory, { recursive: true });
    const id = createAttachmentStorageName(path.basename(source));
    const target = path.join(this.attachmentDirectory, id);
    await copyFile(source, target, 1);
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
        size: details.size,
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
    if (started.replayed) throw new Error("MCP operation with this request_id is still pending");
    try {
      const result = await operation();
      this.workspaceCatalog.completeMcpOperation(requestId, result);
      return result;
    } catch (error) {
      this.workspaceCatalog.failMcpOperation(requestId, error);
      throw error;
    }
  }
}
