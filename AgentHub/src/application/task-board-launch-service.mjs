import { createHash } from "node:crypto";
import path from "node:path";
import process from "node:process";

import { taskDisplayText, taskDisplayTitle } from "../domain/task-board-task.mjs";
import { taskProjectRoot } from "../domain/task-project-root.mjs";

function requiredMethod(value, name) {
  if (typeof value?.[name] !== "function") throw new TypeError(`${name} is required`);
}

function plannedStreamId(taskId, requestId) {
  const fingerprint = createHash("sha256").update(`${taskId}\0${requestId}`).digest("hex").slice(0, 32);
  return `task-launch-${fingerprint}`;
}

function samePath(left, right) {
  const first = path.resolve(String(left ?? ""));
  const second = path.resolve(String(right ?? ""));
  return process.platform === "win32" ? first.toLowerCase() === second.toLowerCase() : first === second;
}

export class TaskBoardLaunchService {
  constructor({
    taskBoard, workspaceCatalog, dispatchCommand, sendMessage, taskGitWorkspaces = null,
    activeRuns = () => [], deferredInputs = () => [], recordEvent = null, logger = console,
  } = {}) {
    requiredMethod(taskBoard, "task");
    requiredMethod(taskBoard, "markStarted");
    requiredMethod(workspaceCatalog, "workspace");
    requiredMethod(workspaceCatalog, "stream");
    requiredMethod(workspaceCatalog, "activeThread");
    if (typeof dispatchCommand !== "function") throw new TypeError("dispatchCommand is required");
    if (typeof sendMessage !== "function") throw new TypeError("sendMessage is required");
    this.taskBoard = taskBoard;
    this.workspaceCatalog = workspaceCatalog;
    this.dispatchCommand = dispatchCommand;
    this.sendMessage = sendMessage;
    this.taskGitWorkspaces = taskGitWorkspaces;
    this.activeRuns = activeRuns;
    this.deferredInputs = deferredInputs;
    this.recordEvent = typeof recordEvent === "function" ? recordEvent : null;
    this.logger = logger;
  }

  async start(params, context = {}) {
    const task = this.taskBoard.task(params.id);
    const workspaceId = String(params.workspaceId ?? task.workspaceId ?? "").trim();
    const workspace = this.workspaceCatalog.workspace(workspaceId);
    if (!workspace || task.workspaceId !== workspace.id) {
      throw new Error("Сначала перенесите задачу в Workspace");
    }
    const requestedStreamId = String(params.streamId ?? "").trim();
    const requestedStreamName = String(params.streamName ?? "").trim();
    if (requestedStreamId && requestedStreamName) {
      throw new Error("Выберите существующий Stream или создайте новый, но не оба сразу");
    }
    const requestedStream = requestedStreamId ? this.workspaceCatalog.stream(requestedStreamId) : null;
    if (requestedStreamId && (!requestedStream || requestedStream.workspaceId !== workspace.id)) {
      throw new Error("Stream не найден в выбранном Workspace");
    }
    const reassign = params.reassign === true;
    if (reassign) {
      const currentStreamId = String(task.streamId ?? "").trim();
      if (task.status !== "started" || !currentStreamId) throw new Error("Переназначить можно только запущенную Task");
      if (requestedStreamId && requestedStreamId === currentStreamId) throw new Error("Task уже назначена этому Stream");
      const currentThreadKeys = new Set((this.workspaceCatalog.stream(currentStreamId)?.threads ?? []).map((thread) => (
        `${String(thread?.provider ?? "").trim()}\0${String(thread?.threadId ?? "").trim()}`
      )));
      const hasActiveRun = this.activeRuns().some((run) => String(run?.streamId ?? "").trim() === currentStreamId);
      const hasQueuedInput = this.deferredInputs().some((input) => (
        String(input?.streamId ?? "").trim() === currentStreamId
        || currentThreadKeys.has(`${String(input?.provider ?? "").trim()}\0${String(input?.threadId ?? "").trim()}`)
      ));
      if (hasActiveRun || hasQueuedInput) {
        throw new Error("Нельзя переназначить Task, пока у текущего Stream есть активный ход или очередь");
      }
    }
    const sourceRoot = taskProjectRoot({ workspace, stream: requestedStream });
    const gitWorkspace = this.taskGitWorkspaces && sourceRoot
      ? await this.taskGitWorkspaces.prepare({
          taskId: task.id, taskNumber: task.taskNumber, projectRoot: sourceRoot,
        })
      : null;
    const launchParams = {
      ...params,
      ...(gitWorkspace ? { workingDirectory: gitWorkspace.projectRoot } : {}),
    };
    const launchRequestId = String(params.launchRequestId ?? "").trim();
    if (launchRequestId) {
      return this.#resumeDurableLaunch({
        task, workspace, requestedStreamId, requestedStreamName, launchRequestId,
        params: launchParams, gitWorkspace, context, reassign,
      });
    }
    params = launchParams;
    let target;
    if (requestedStreamId) {
      const stream = this.workspaceCatalog.stream(requestedStreamId);
      if (!stream || stream.workspaceId !== workspace.id) {
        throw new Error("Stream не найден в выбранном Workspace");
      }
      const thread = this.workspaceCatalog.activeThread(stream.id);
      if (thread && (!params.workingDirectory || samePath(thread.projectRoot, params.workingDirectory))) {
        target = {
          streamId: stream.id,
          provider: thread.provider,
          threadId: thread.threadId,
          projectRoot: thread.projectRoot,
        };
        await this.dispatchCommand("task.select", { taskTitle: workspace.name }, context, { target });
      } else {
        const created = await this.dispatchCommand("task.create", {
          provider: params.provider,
          streamId: stream.id,
          taskId: task.id,
          taskNumber: task.taskNumber,
          ...(params.settings ? { settings: params.settings } : {}),
          ...(params.workingDirectory ? {
            workingDirectory: params.workingDirectory,
            handoffReason: "Task Git worktree",
          } : {}),
        }, context);
        target = created.createdTask;
      }
    } else {
      const streamName = (requestedStreamName || taskDisplayText(task)).slice(0, 80);
      const created = await this.dispatchCommand("task.create", {
        provider: params.provider,
        workspaceId: workspace.id,
        streamName,
        taskId: task.id,
        taskNumber: task.taskNumber,
        ...(params.settings ? { settings: params.settings } : {}),
        ...(params.workingDirectory ? { workingDirectory: params.workingDirectory } : {}),
      }, context);
      target = created.createdTask;
    }
    const delivery = await this.sendMessage({
      text: String(params.message ?? ""),
      displayText: `Task: ${taskDisplayTitle(task)}`,
      taskReferences: [{ taskId: task.id, intent: "start" }],
      streamId: target.streamId,
      provider: target.provider,
      threadId: target.threadId,
      projectRoot: target.projectRoot,
      clientUserMessageId: String(params.clientUserMessageId ?? context?.commandId ?? "").trim()
        || `board-task:${task.id}`,
      followUpMode: String(params.followUpMode ?? "").trim(),
    }, context);
    const started = this.taskBoard.markStarted({
      id: task.id,
      workspaceId: workspace.id,
      streamId: target.streamId,
    });
    if (delivery?.deferred && this.recordEvent) {
      try {
        this.recordEvent({
          workspaceId: workspace.id,
          streamId: target.streamId,
          type: "task.blocked",
          subjectId: task.id,
          payload: {
            taskId: task.id,
            reason: delivery.reason ?? "deferred",
            message: delivery.message ?? "",
          },
        });
      } catch (error) {
        this.logger.error(`Cannot record blocker event for Task ${task.id}:`, error.message);
      }
    }
    return {
      task: started,
      target,
      delivery,
      gitWorkspace,
      startedBoardTask: { id: task.id, streamId: target.streamId },
    };
  }

  async #resumeDurableLaunch({
    task, workspace, requestedStreamId, requestedStreamName, launchRequestId, params, gitWorkspace, context, reassign,
  }) {
    if (typeof this.taskBoard.prepareStart !== "function" || typeof this.taskBoard.cancelPreparedStart !== "function") {
      throw new Error("Task board does not support durable launch reconciliation");
    }
    if (requestedStreamId) {
      const requestedStream = this.workspaceCatalog.stream(requestedStreamId);
      if (!requestedStream || requestedStream.workspaceId !== workspace.id) {
        throw new Error("Stream не найден в выбранном Workspace");
      }
    }
    const streamId = requestedStreamId || plannedStreamId(task.id, launchRequestId);
    const streamName = requestedStreamId ? null : (requestedStreamName || taskDisplayText(task)).slice(0, 80);
    const prepared = this.taskBoard.prepareStart({
      id: task.id,
      workspaceId: workspace.id,
      streamId,
      streamName,
      requestId: launchRequestId,
      reassign,
      expectedRevision: task.revision,
    });
    let stream = this.workspaceCatalog.stream(streamId);
    if (!stream) {
      try {
        if (typeof this.workspaceCatalog.createStream !== "function") {
          throw new Error("Workspace catalog cannot create a planned Stream");
        }
        stream = this.workspaceCatalog.createStream({
          id: streamId,
          workspaceId: workspace.id,
          name: prepared.startStreamName || streamName,
          settings: params.settings ?? {},
        });
      } catch (error) {
        this.taskBoard.cancelPreparedStart({ id: task.id, requestId: launchRequestId, reassign });
        throw error;
      }
    }
    if (stream.workspaceId !== workspace.id) throw new Error("Stream не найден в выбранном Workspace");
    let target = this.workspaceCatalog.activeThread(stream.id);
    if (target && (!params.workingDirectory || samePath(target.projectRoot, params.workingDirectory))) {
      target = {
        streamId: stream.id,
        provider: target.provider,
        threadId: target.threadId,
        projectRoot: target.projectRoot,
      };
      await this.dispatchCommand("task.select", { taskTitle: workspace.name }, context, { target });
    } else {
      const created = await this.dispatchCommand("task.create", {
        provider: params.provider,
        streamId: stream.id,
        taskId: task.id,
        taskNumber: task.taskNumber,
        ...(params.settings ? { settings: params.settings } : {}),
        ...(params.workingDirectory ? {
          workingDirectory: params.workingDirectory,
          handoffReason: "Task Git worktree",
        } : {}),
      }, context);
      target = created.createdTask;
    }
    const delivery = await this.sendMessage({
      text: String(params.message ?? ""),
      displayText: `Task: ${taskDisplayTitle(prepared)}`,
      taskReferences: [{ taskId: prepared.id, intent: "start" }],
      streamId: target.streamId,
      provider: target.provider,
      threadId: target.threadId,
      projectRoot: target.projectRoot,
      clientUserMessageId: String(params.clientUserMessageId ?? context?.commandId ?? "").trim()
        || `board-task:${prepared.id}:${launchRequestId}`,
      followUpMode: String(params.followUpMode ?? "").trim(),
    }, context);
    const started = this.taskBoard.markStarted({
      id: prepared.id,
      workspaceId: workspace.id,
      streamId: target.streamId,
      requestId: launchRequestId,
    });
    return {
      task: started,
      target,
      delivery,
      gitWorkspace,
      startedBoardTask: { id: started.id, streamId: target.streamId },
    };
  }
}
