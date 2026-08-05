export class TelegramTaskActionService {
  constructor({
    selectedTask,
    activeProvider,
    activeProjectRoot,
    activeTaskTitle,
    currentThreadId,
    preferencesSnapshot,
    selectedRun,
    selectTaskFromBinding,
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
      activeProvider,
      activeProjectRoot,
      activeTaskTitle,
      currentThreadId,
      preferencesSnapshot,
      selectedRun,
      selectTaskFromBinding,
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

  async rename(title, context = {}) {
    if (!this.currentThreadId()) throw new Error("текущая задача не выбрана");
    const result = await this.dispatchCommand(
      "task.rename",
      { title },
      context,
      { target: this.commandTaskTarget(this.selectedTask()) },
    );
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
    const result = await this.dispatchCommand(
      "task.archive",
      {},
      context,
      { target: this.commandTaskTarget(this.selectedTask()) },
    );
    return {
      archived: true,
      archivedThread: result.archivedThread,
      nextThread: result.nextThread ?? null,
    };
  }

  async sendArchive(result, targetChatId) {
    const task = result.nextThread ? {
      ...this.selectedTask(),
      chatId: targetChatId,
      taskTitle: this.activeTaskTitle(),
    } : null;
    const message = await this.sendMessage(targetChatId, this.formatArchiveMessage({
      archivedTask: this.threadTitle(result.archivedThread),
      activeTask: result.nextThread ? this.threadTitle(result.nextThread) : null,
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
