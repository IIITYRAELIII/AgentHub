import { taskDisplayText } from "../domain/task-board-task.mjs";

function requiredMethod(value, name) {
  if (typeof value?.[name] !== "function") throw new TypeError(`${name} is required`);
}

export class TaskBoardLaunchService {
  constructor({ taskBoard, workspaceCatalog, dispatchCommand, sendMessage, recordEvent = null, logger = console } = {}) {
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
    let target;
    if (requestedStreamId) {
      const stream = this.workspaceCatalog.stream(requestedStreamId);
      if (!stream || stream.workspaceId !== workspace.id) {
        throw new Error("Stream не найден в выбранном Workspace");
      }
      const thread = this.workspaceCatalog.activeThread(stream.id);
      if (thread) {
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
        }, context);
        target = created.createdTask;
      }
    } else {
      const streamName = (requestedStreamName || taskDisplayText(task)).slice(0, 80);
      const created = await this.dispatchCommand("task.create", {
        provider: params.provider,
        workspaceId: workspace.id,
        streamName,
      }, context);
      target = created.createdTask;
    }
    const delivery = await this.sendMessage({
      text: taskDisplayText(task),
      attachments: Array.isArray(task.sourceDetails?.attachments) ? task.sourceDetails.attachments : [],
      streamId: target.streamId,
      provider: target.provider,
      threadId: target.threadId,
      projectRoot: target.projectRoot,
      clientUserMessageId: `board-task:${task.id}`,
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
      startedBoardTask: { id: task.id, streamId: target.streamId },
    };
  }
}
