export class RestartNotificationService {
  constructor({
    getRequest,
    setRequest,
    isStopping,
    sendMessage,
    telegram,
    saveState,
    formatCompleteMessage,
    completeMessageState,
    menu,
    finalizeReplacement,
    logger = console,
  }) {
    Object.assign(this, {
      getRequest,
      setRequest,
      isStopping,
      sendMessage,
      telegram,
      saveState,
      formatCompleteMessage,
      completeMessageState,
      menu,
      finalizeReplacement,
      logger,
    });
  }

  editable(request = this.getRequest()) {
    return request?.notifyTelegram === true
      && Number.isSafeInteger(request.chatId)
      && Number.isSafeInteger(request.messageId);
  }

  async announceDesktop(request, blockingWorkCount) {
    if (request?.notifyTelegram !== true || !Number.isSafeInteger(request.chatId)) return false;
    try {
      const message = await this.sendMessage(request.chatId, blockingWorkCount
        ? `🔄 Agent Hub Server перезапустится после завершения выполняющихся задач: ${blockingWorkCount}.`
        : "🔄 Перезапускаю Agent Hub Server…");
      if (!Number.isSafeInteger(message?.message_id)
        || this.getRequest() !== request
        || this.isStopping()) return false;
      request.messageId = message.message_id;
      await this.saveState();
      return true;
    } catch (error) {
      this.logger.warn(`Cannot announce Desktop restart: ${error.message}`);
      return false;
    }
  }

  async update(text, extra = {}) {
    const request = this.getRequest();
    if (!this.editable(request)) return false;
    await this.telegram("editMessageText", {
      chat_id: request.chatId,
      message_id: request.messageId,
      text,
      ...extra,
    });
    return true;
  }

  async finalize() {
    const request = this.getRequest();
    if (!request) return false;
    if (request.notifyTelegram !== true) {
      this.setRequest(null);
      await this.saveState();
      return true;
    }
    const text = this.formatCompleteMessage(this.completeMessageState());
    if (!this.editable(request)) {
      try {
        if (Number.isSafeInteger(request.chatId)) {
          await this.sendMessage(request.chatId, text, { parse_mode: "HTML", reply_markup: this.menu });
        }
      } catch (error) {
        this.logger.error("Cannot send restart completion message:", error.message);
      }
      this.setRequest(null);
      await this.saveState();
      return true;
    }
    return this.finalizeReplacement({
      updateMessage: () => this.update(text, { parse_mode: "HTML" }),
      sendFallback: () => this.sendMessage(request.chatId, text, {
        parse_mode: "HTML",
        reply_markup: this.menu,
      }),
      clearRestartRequest: () => this.setRequest(null),
      saveState: this.saveState,
      logError: (message, error) => this.logger.error(`${message}:`, error.message),
    });
  }
}
