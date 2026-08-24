import { TaskBoardLaunchService } from "../../application/task-board-launch-service.mjs";

export class DesktopTaskBoardController {
  constructor({ taskBoard, workspaceCatalog, dispatchCommand, sendMessage, taskLauncher = null, voiceTranscriber = null, snapshot, logger = console } = {}) {
    this.taskBoard = taskBoard;
    this.workspaceCatalog = workspaceCatalog;
    this.dispatchCommand = dispatchCommand;
    this.sendMessage = sendMessage;
    this.taskLauncher = taskLauncher ?? new TaskBoardLaunchService({
      taskBoard, workspaceCatalog, dispatchCommand, sendMessage,
    });
    this.voiceTranscriber = voiceTranscriber;
    this.snapshot = snapshot;
    this.logger = logger;
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
    const transcription = await this.#voiceTranscript(params, attachments);
    const sourceDetails = {
      ...(params.sourceDetails ?? {}),
      ...(attachments.length ? { attachments } : {}),
      ...(transcription.failures.length ? { voiceTranscriptionFailures: transcription.failures } : {}),
    };
    let task;
    if (Number.isSafeInteger(params.mergeMessageId)) {
      task = this.taskBoard.mergeSourceMessage({
        source: "telegram",
        chatId: params.sourceDetails?.chatId,
        userId: params.sourceDetails?.userId,
        messageId: params.mergeMessageId,
        text: transcription.text,
        sourceDetails,
      });
    } else if (Number.isSafeInteger(params.replyMessageId)) {
      const replyText = transcription.text;
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
        text: transcription.text,
        source: "telegram",
        sourceKey: params.sourceKey,
        sourceDetails,
      });
    }
    await this.snapshot({ refresh: true });
    return { taskId: task.id, rawText: task.rawText };
  }

  async #voiceTranscript(params, attachments) {
    const text = String(params.text ?? "").trim();
    if (!this.voiceTranscriber?.transcribe || !attachments.length) return { text, failures: [] };
    const kinds = Array.isArray(params.sourceDetails?.attachmentKinds)
      ? params.sourceDetails.attachmentKinds
      : [];
    const blocks = [];
    const failures = [];
    for (let index = 0; index < attachments.length; index += 1) {
      if (!["voice", "audio"].includes(String(kinds[index] ?? "").toLowerCase())) continue;
      try {
        const transcript = String(await this.voiceTranscriber.transcribe(attachments[index])).trim();
        if (transcript) blocks.push(`--- Расшифровка голосового сообщения ${index + 1} ---\n${transcript}`);
      } catch (error) {
        failures.push({ index, error: String(error?.message ?? error).slice(0, 500) });
        this.logger.warn(`Cannot transcribe Dashboard Task attachment ${index + 1}: ${error.message}`);
      }
    }
    const combined = [text, ...blocks].filter(Boolean).join("\n\n");
    return { text: combined.slice(0, 20_000), failures };
  }

  move(params) {
    return this.#mutate(() => this.taskBoard.move(params));
  }

  update(params) {
    return this.#mutate(() => this.taskBoard.update(params));
  }

  status(params) {
    return this.#mutate(() => this.taskBoard.setWorkflowStatus(params));
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
