import { TaskBoardLaunchService } from "../../application/task-board-launch-service.mjs";

export class DesktopTaskBoardController {
  constructor({ taskBoard, workspaceCatalog, dispatchCommand, sendMessage, taskLauncher = null, snapshot } = {}) {
    this.taskBoard = taskBoard;
    this.workspaceCatalog = workspaceCatalog;
    this.dispatchCommand = dispatchCommand;
    this.sendMessage = sendMessage;
    this.taskLauncher = taskLauncher ?? new TaskBoardLaunchService({
      taskBoard, workspaceCatalog, dispatchCommand, sendMessage,
    });
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
    const attachments = Array.isArray(params.attachments) ? params.attachments : [];
    const sourceDetails = attachments.length
      ? { ...(params.sourceDetails ?? {}), attachments }
      : params.sourceDetails;
    let task;
    if (Number.isSafeInteger(params.mergeMessageId)) {
      task = this.taskBoard.mergeSourceMessage({
        source: "telegram",
        chatId: params.sourceDetails?.chatId,
        userId: params.sourceDetails?.userId,
        messageId: params.mergeMessageId,
        text: params.text,
        sourceDetails,
      });
    } else if (Number.isSafeInteger(params.replyMessageId)) {
      const replyText = String(params.text ?? "").trim();
      task = replyText
        ? this.taskBoard.appendSourceMessage({
          source: "telegram",
          chatId: params.sourceDetails?.chatId,
          userId: params.sourceDetails?.userId,
          messageId: params.replyMessageId,
          text: replyText,
          sourceDetails,
          attachments,
        })
        : this.taskBoard.attachToSourceMessage({
          source: "telegram",
          chatId: params.sourceDetails?.chatId,
          userId: params.sourceDetails?.userId,
          messageId: params.replyMessageId,
          attachments,
        });
    } else {
      task = this.taskBoard.create({
        text: params.text,
        source: "telegram",
        sourceKey: params.sourceKey,
        sourceDetails,
      });
    }
    await this.snapshot({ refresh: true });
    return { taskId: task.id, rawText: task.rawText };
  }

  move(params) {
    return this.#mutate(() => this.taskBoard.move(params));
  }

  update(params) {
    return this.#mutate(() => this.taskBoard.update(params));
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
    const result = await this.taskLauncher.start(params, context);
    return {
      ...await this.snapshot({ refresh: true }),
      startedBoardTask: result.startedBoardTask,
    };
  }
}
