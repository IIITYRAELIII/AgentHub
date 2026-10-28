import { realpath, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { TaskBoardLaunchService } from "../../application/task-board-launch-service.mjs";
import { attachmentUploadLimits } from "../../domain/attachment-upload-policy.mjs";
import { pathInsideOrSame } from "../../infrastructure/filesystem/config.mjs";

export class DesktopTaskBoardController {
  constructor({ taskBoard, workspaceCatalog, dispatchCommand, sendMessage, taskLauncher = null, taskLifecycle = null, taskGitWorkspaces = null, voiceTranscriber = null, attachmentDirectory = null, snapshot, hubMcpService = null, logger = console } = {}) {
    this.taskBoard = taskBoard;
    this.hubMcpService = hubMcpService;
    this.workspaceCatalog = workspaceCatalog;
    this.dispatchCommand = dispatchCommand;
    this.sendMessage = sendMessage;
    this.taskLauncher = taskLauncher ?? new TaskBoardLaunchService({
      taskBoard, workspaceCatalog, dispatchCommand, sendMessage,
    });
    this.taskLifecycle = taskLifecycle;
    this.taskGitWorkspaces = taskGitWorkspaces;
    this.voiceTranscriber = voiceTranscriber;
    this.attachmentDirectory = attachmentDirectory ? path.resolve(attachmentDirectory) : null;
    this.snapshot = snapshot;
    this.logger = logger;
  }

  async #mutate(operation) {
    await operation();
    return this.snapshot({ refresh: true });
  }

  #boardMutationSnapshot(params) {
    // Opt-in response for the shared UI. Older clients retain the full snapshot.
    // The durable mutation has finished; unrelated conversation/server reads
    // must not delay acknowledgement of the new Dashboard state.
    if (params.responseView !== "task-board") return this.snapshot({ refresh: true });
    return {
      view: "task-board",
      boardTasks: this.taskBoard.snapshot(),
      workspaces: this.taskBoard.workspaces(),
      boardLayout: this.taskBoard.layout(),
    };
  }

  read({ id, operationRequestId, argumentsHash } = {}) {
    const operation = operationRequestId
      ? this.hubMcpService.readDesktopTaskOperation({ id }, operationRequestId, argumentsHash) : null;
    let task = null;
    try { if (id) task = this.taskBoard.card(id); }
    catch (error) { if (!operation?.taskOperation.terminal) throw error; }
    if (!operation && !task) task = this.taskBoard.card(id);
    return { task, taskOperations: id ? this.hubMcpService?.taskOperationInterruption?.list(id) ?? [] : [],
      ...(operation ? { operation } : {}) };
  }

  async diff({ id } = {}) {
    const task = this.taskBoard.task(id);
    if (!this.taskGitWorkspaces) throw new Error("Просмотр Git diff недоступен");
    return { taskId: task.id, ...await this.taskGitWorkspaces.reviewDiff({
      taskId: task.id, taskNumber: task.taskNumber,
    }) };
  }

  create(params, context = {}) {
    if (context.taskOperationReceipt && this.hubMcpService) {
      if (!this.workspaceCatalog.workspace(params.workspaceId)) throw new Error("Workspace не найден");
      return this.hubMcpService.runDesktopTaskOperation({ workspaceId: params.workspaceId }, context.commandId, null,
        () => this.taskBoard.create({ text: params.text, source: "hub", bucket: "workspace", workspaceId: params.workspaceId }),
        { receiptOnly: true, toolName: "hub_task_create", parameters: { workspace_id: params.workspaceId, text: params.text } });
    }
    return this.#mutate(() => {
      if (!this.workspaceCatalog.workspace(params.workspaceId)) throw new Error("Workspace не найден");
      return this.taskBoard.create({
        text: params.text, source: "hub", bucket: "workspace", workspaceId: params.workspaceId,
      });
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
    const mutate = () => {
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
      return task;
    };
    const task = await mutate();
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
    return { text: combined, failures };
  }

  async move(params) {
    await this.taskBoard.move(params);
    return this.#boardMutationSnapshot(params);
  }

  update(params, context = {}) {
    if (context.taskOperationReceipt && this.hubMcpService) return this.hubMcpService.runDesktopTaskOperation(
      this.taskBoard.task(params.id), context.commandId, null, () => this.taskBoard.update(params),
      { receiptOnly: true, toolName: "hub_task_update", parameters: { ...params } });
    return this.#mutate(() => this.taskBoard.update(params));
  }

  checklist(params) {
    return this.#mutate(() => this.taskBoard.updateChecklist(params));
  }

  checklistLinkedTaskAction(params) {
    return this.#mutate(() => this.taskBoard.applyChecklistLinkedTaskAction(params));
  }

  async addAttachments(params) {
    if (!this.attachmentDirectory) throw new Error("Хранилище вложений недоступно");
    const attachments = Array.isArray(params.attachments) ? [...new Set(params.attachments)] : [];
    if (!attachments.length || attachments.length > 8) throw new Error("Некорректный список вложений");
    const root = await realpath(this.attachmentDirectory);
    const files = [];
    for (const attachment of attachments) {
      const file = await realpath(path.resolve(String(attachment ?? "")));
      const details = await stat(file);
      if (!pathInsideOrSame(file, root) || !details.isFile() || details.size < 1 || details.size > attachmentUploadLimits().maxBytes) {
        throw new Error("Вложение недоступно");
      }
      files.push(file);
    }
    return this.#mutate(async () => {
      for (const file of files) await this.taskBoard.addAttachment({ id: params.id, attachment: file });
    });
  }

  async status(params, context = {}) {
    if (!this.taskLifecycle) throw new Error("Task lifecycle service is unavailable");
    const operationId = String(params.operationId ?? context.commandId ?? "").trim();
    const run = () => this.taskLifecycle.updateWorkflowStatus({ taskId: params.id, status: params.status, operationId });
    const result = this.hubMcpService
      ? await this.hubMcpService.runDesktopTaskOperation(this.taskBoard.task(params.id), operationId, params.status, run,
        { receiptOnly: context.taskOperationReceipt === true }) : await run();
    if (result?.taskOperation) return result;
    return { ...await this.#boardMutationSnapshot(params), lifecycleResult: result };
  }

  async cancelOperation(params) {
    const owner = this.hubMcpService?.taskOperationInterruption;
    if (!owner || params.confirmCancel !== true) throw new Error("Подтверди прерывание операции");
    const task = this.taskBoard.task(params.id);
    const cancellation = await owner.cancel({ actor: { user: true, workspaceId: task.workspaceId },
      taskId: task.id, operationRequestId: params.operationRequestId,
      cancellationRequestId: params.requestId, expectedArgumentsHash: params.argumentsHash,
      expectedTaskRevision: params.expectedRevision });
    return { ...this.read({ id: task.id }), cancellation };
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

  async complete(params, context = {}) {
    if (!this.taskLifecycle) throw new Error("Task lifecycle service is unavailable");
    const operationId = String(params.operationId ?? context.commandId ?? "").trim();
    const run = () => this.taskLifecycle.complete({
      taskId: params.id, operationId,
      confirmCleanup: params.confirmCleanup === true,
      expectedCleanupToken: params.expectedCleanupToken ?? null,
    });
    if (context.taskOperationReceipt && this.hubMcpService) return this.hubMcpService.runDesktopTaskOperation(
      this.taskBoard.task(params.id), operationId, null, run,
      { receiptOnly: true, toolName: "hub_task_complete", parameters: { confirm_cleanup: params.confirmCleanup === true,
        expected_cleanup_token: params.expectedCleanupToken ?? null } });
    const result = await run();
    return { ...await this.snapshot({ refresh: true }), lifecycleResult: result };
  }

  async remove(params, context = {}) {
    if (!this.taskLifecycle) throw new Error("Task lifecycle service is unavailable");
    const operationId = String(params.operationId ?? context.commandId ?? "").trim();
    const run = () => this.taskLifecycle.delete({
      taskId: params.id, operationId,
      confirmCleanup: params.confirmCleanup === true,
      expectedCleanupToken: params.expectedCleanupToken ?? null,
    });
    if (context.taskOperationReceipt && this.hubMcpService) return this.hubMcpService.runDesktopTaskOperation(
      this.taskBoard.task(params.id), operationId, null, run,
      { receiptOnly: true, toolName: "hub_task_delete", parameters: { confirm_cleanup: params.confirmCleanup === true,
        expected_cleanup_token: params.expectedCleanupToken ?? null } });
    const result = await run();
    return { ...await this.snapshot({ refresh: true }), lifecycleResult: result };
  }

  retryTriage(params) {
    return this.#mutate(() => this.taskBoard.retryTriage(params));
  }

  async start(params, context = {}) {
    const result = await this.taskLauncher.start({
      ...params,
      launchRequestId: String(params.launchRequestId ?? params.clientUserMessageId ?? "").trim() || randomUUID(),
    }, context);
    return {
      ...await this.snapshot({ refresh: true }),
      startedBoardTask: result.startedBoardTask,
    };
  }
}
