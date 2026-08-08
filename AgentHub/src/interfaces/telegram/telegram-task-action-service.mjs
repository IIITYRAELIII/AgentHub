import { taskDisplayTitle } from "../../domain/task-display-title.mjs";

export class TelegramTaskActionService {
  constructor({
    selectedTask,
    selectedTurnTarget,
    currentUiContextToken,
    uiCallback,
    activeProvider,
    activeProjectRoot,
    activeTaskTitle,
    currentThreadId,
    preferencesSnapshot,
    selectedRun,
    selectTaskFromBinding,
    clearTaskSelection,
    sendTaskSwitchNotification,
    sendTaskAlreadySelectedNotification,
    dispatchCommand,
    commandTaskTarget,
    isCodex,
    threadTitle,
    formatArchiveMessage,
    sendMessage,
    showLastMessageReplyMarkup,
    bindRunMessage,
    telegram,
    logger = console,
  }) {
    Object.assign(this, {
      selectedTask,
      selectedTurnTarget,
      currentUiContextToken,
      uiCallback,
      activeProvider,
      activeProjectRoot,
      activeTaskTitle,
      currentThreadId,
      preferencesSnapshot,
      selectedRun,
      selectTaskFromBinding,
      clearTaskSelection,
      sendTaskSwitchNotification,
      sendTaskAlreadySelectedNotification,
      dispatchCommand,
      commandTaskTarget,
      isCodex,
      threadTitle,
      formatArchiveMessage,
      sendMessage,
      showLastMessageReplyMarkup,
      bindRunMessage,
      telegram,
      logger,
    });
  }

  async resume(selectedThreadId, { notify = true, context = {} } = {}) {
    const result = await this.selectTaskFromBinding({
      provider: this.activeProvider(),
      projectRoot: this.activeProjectRoot(),
      threadId: selectedThreadId,
    }, context);
    if (notify) {
      if (result.selectionChanged) await this.sendTaskSwitchNotification();
      else await this.sendTaskAlreadySelectedNotification();
    }
    return true;
  }

  async create(context = {}) {
    const result = await this.dispatchCommand(
      "task.create",
      { provider: this.activeProvider() },
      context,
    );
    if (!result?.createdTask || (!result.createdTask.threadId && result.createdTask.provider !== "claude")) {
      throw new Error("новая задача не содержит Thread ID");
    }
    await this.selectTaskFromBinding(result.createdTask, context);
    return result;
  }

  async rename(title, context = {}) {
    if (!this.currentThreadId()) throw new Error("текущая задача не выбрана");
    const result = await this.dispatchCommand(
      "task.rename",
      { title },
      context,
      { target: this.commandTaskTarget(this.selectedTask()) },
    );
    await this.selectTaskFromBinding({
      ...this.selectedTask(),
      taskTitle: result.renamedTitle,
    }, context);
    return result.renamedTitle;
  }

  archiveBlockedReason() {
    if (this.selectedRun()) return "active-turn";
    if (!this.isCodex()) return "unsupported";
    if (!this.currentThreadId()) return "no-current";
    return null;
  }

  async archive(context = {}) {
    const blockedReason = this.archiveBlockedReason();
    if (blockedReason) return { archived: false, reason: blockedReason };
    const archivedTaskTitle = this.activeTaskTitle();
    const result = await this.dispatchCommand(
      "task.archive",
      {},
      context,
      { target: this.commandTaskTarget(this.selectedTask()) },
    );
    const nextEntry = result.nextThread?.id
      ? (result.tasks ?? []).find((entry) => entry.threadId === result.nextThread.id)
      : null;
    const nextTaskTitle = result.nextThread
      ? taskDisplayTitle(nextEntry, this.threadTitle(result.nextThread))
      : null;
    if (result.nextThread?.id) {
      await this.selectTaskFromBinding({
        provider: "codex",
        projectRoot: this.activeProjectRoot(),
        threadId: result.nextThread.id,
        taskTitle: nextTaskTitle,
      }, context);
    } else {
      await this.clearTaskSelection(context);
    }
    return {
      archived: true,
      archivedThread: result.archivedThread,
      archivedTaskTitle,
      nextThread: result.nextThread ?? null,
      nextTaskTitle,
    };
  }

  async sendArchive(result, targetChatId) {
    const task = result.nextThread ? {
      ...this.selectedTask(),
      chatId: targetChatId,
      taskTitle: this.activeTaskTitle(),
    } : null;
    const message = await this.sendMessage(targetChatId, this.formatArchiveMessage({
      archivedTask: result.archivedTaskTitle || this.threadTitle(result.archivedThread),
      activeTask: result.nextTaskTitle,
    }), task ? { reply_markup: this.showLastMessageReplyMarkup(task) } : {});
    if (task) {
      await this.bindRunMessage(task, message).catch((error) => {
        this.logger.error("Cannot bind archive result message:", error.message);
      });
    }
    return message;
  }

  statusSnapshot(targetChatId) {
    return {
      chatId: targetChatId,
      provider: this.activeProvider(),
      projectRoot: this.activeProjectRoot(),
      threadId: this.currentThreadId(),
      taskTitle: this.activeTaskTitle(),
      ...this.preferencesSnapshot(),
    };
  }

  async dismissMenu(message) {
    if (!message?.chat?.id || !message?.message_id) return;
    await this.telegram("deleteMessage", {
      chat_id: message.chat.id,
      message_id: message.message_id,
    }).catch(() => this.telegram("editMessageReplyMarkup", {
      chat_id: message.chat.id,
      message_id: message.message_id,
      reply_markup: { inline_keyboard: [] },
    }).catch(() => {}));
  }
}
