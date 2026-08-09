import { taskDisplayText } from "../../domain/task-board-task.mjs";

export class DesktopTaskBoardController {
  constructor({ taskBoard, workspaceCatalog, dispatchCommand, sendMessage, snapshot } = {}) {
    this.taskBoard = taskBoard;
    this.workspaceCatalog = workspaceCatalog;
    this.dispatchCommand = dispatchCommand;
    this.sendMessage = sendMessage;
    this.snapshot = snapshot;
  }

  async #mutate(operation) {
    operation();
    return this.snapshot({ refresh: true });
  }

  create(params) {
    return this.#mutate(() => {
      if (!this.workspaceCatalog.workspace(params.workspaceId)) throw new Error("Workspace не найден");
      const task = this.taskBoard.create({ text: params.text, source: "hub" });
      this.taskBoard.move({ id: task.id, bucket: "workspace", workspaceId: params.workspaceId });
    });
  }

  async ingest(params) {
    const task = this.taskBoard.create({
      text: params.text,
      source: "telegram",
      sourceKey: params.sourceKey,
      sourceDetails: params.sourceDetails,
    });
    await this.snapshot({ refresh: true });
    return { taskId: task.id, rawText: task.rawText };
  }

  move(params) {
    return this.#mutate(() => this.taskBoard.move(params));
  }

  moveColumn(params) {
    return this.#mutate(() => this.taskBoard.moveColumn(params));
  }

  moveWorkspace(params) {
    const workspaceId = String(params.workspaceId ?? "").trim();
    const beforeWorkspaceId = String(params.beforeWorkspaceId ?? "").trim();
    return this.moveColumn({
      columnId: `workspace:${workspaceId}`,
      beforeColumnId: beforeWorkspaceId ? `workspace:${beforeWorkspaceId}` : null,
    });
  }

  updateColumnComment(params) {
    return this.#mutate(() => {
      const columnId = String(params.columnId ?? "").trim();
      if (columnId === "notes") return this.taskBoard.setNotesComment(params);
      if (!columnId.startsWith("workspace:")) throw new Error("Колонка не найдена");
      return this.workspaceCatalog.updateWorkspaceComment(columnId.slice(10), params.comment);
    });
  }

  complete(params) {
    return this.#mutate(() => this.taskBoard.complete(params));
  }

  remove(params) {
    return this.#mutate(() => this.taskBoard.remove(params));
  }

  retryTriage(params) {
    return this.#mutate(() => this.taskBoard.retryTriage(params));
  }

  async start(params, context = {}) {
    const task = this.taskBoard.task(params.id);
    const workspaceId = String(params.workspaceId ?? task.workspaceId ?? "").trim();
    const workspace = this.workspaceCatalog.workspace(workspaceId);
    if (!workspace) throw new Error("Сначала перенесите задачу в Workspace");
    const requestedStreamId = String(params.streamId ?? "").trim();
    let target;
    if (requestedStreamId) {
      const stream = this.workspaceCatalog.stream(requestedStreamId);
      if (!stream || stream.workspaceId !== workspace.id) throw new Error("Stream не найден в выбранном Workspace");
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
      const streamName = String(params.streamName ?? taskDisplayText(task)).trim().slice(0, 80);
      const created = await this.dispatchCommand("task.create", {
        provider: params.provider,
        workspaceId: workspace.id,
        streamName,
      }, context);
      target = created.createdTask;
    }
    await this.sendMessage({
      text: taskDisplayText(task),
      streamId: target.streamId,
      provider: target.provider,
      threadId: target.threadId,
      projectRoot: target.projectRoot,
      clientUserMessageId: `board-task:${task.id}`,
    }, context);
    this.taskBoard.markStarted({ id: task.id, workspaceId: workspace.id, streamId: target.streamId });
    return {
      ...await this.snapshot({ refresh: true }),
      startedBoardTask: { id: task.id, streamId: target.streamId },
    };
  }
}
