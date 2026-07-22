import { shouldLogPollingFailure, telegramPollingRetryDelay } from "./poll-retry.mjs";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class TelegramPollingController {
  constructor({
    telegram,
    config,
    getOffset,
    setOffset,
    setProcessingUpdateId,
    handleMessage,
    handleCallback,
    sendMessage,
    saveState,
    preserveFailedUpdate = null,
    afterUpdate,
    stopping,
    logger = console,
  }) {
    this.telegram = telegram;
    this.config = config;
    this.getOffset = getOffset;
    this.setOffset = setOffset;
    this.setProcessingUpdateId = setProcessingUpdateId;
    this.handleMessage = handleMessage;
    this.handleCallback = handleCallback;
    this.sendMessage = sendMessage;
    this.saveState = saveState;
    this.preserveFailedUpdate = preserveFailedUpdate;
    this.afterUpdate = afterUpdate;
    this.stopping = stopping;
    this.logger = logger;
  }

  allowedCallback(callback) {
    const chat = callback.message?.chat;
    return this.config.allowedUserIds.has(callback.from?.id)
      && (!this.config.privateChatsOnly || chat?.type === "private")
      && (!this.config.allowedChatIds || this.config.allowedChatIds.has(chat?.id));
  }

  async process(update) {
    this.setProcessingUpdateId(update.update_id);
    try {
      if (update.callback_query && this.allowedCallback(update.callback_query)) {
        await this.handleCallback(update.callback_query);
      } else if (update.message) {
        await this.handleMessage(update.message);
      }
    } catch (error) {
      this.logger.error(`Telegram update ${update.update_id} failed:`, error.message);
      if (!this.preserveFailedUpdate) throw error;
      // Never acknowledge a failed update until its complete payload and error
      // are durable. This avoids the previous silent offset advance/data loss.
      await this.preserveFailedUpdate(update, error);
      const targetChatId = update.message?.chat?.id ?? update.callback_query?.message?.chat?.id;
      if (Number.isSafeInteger(targetChatId)) {
        await this.sendMessage(
          targetChatId,
          `Не удалось обработать сообщение: ${error.message}\n\nОбновление сохранено для диагностики и не потеряно.`,
        ).catch(() => {});
      }
    }
    const previousOffset = this.getOffset();
    this.setOffset(update.update_id + 1);
    try {
      await this.saveState();
    } catch (error) {
      this.setOffset(previousOffset);
      this.setProcessingUpdateId(null);
      throw error;
    }
    this.setProcessingUpdateId(null);
    await this.afterUpdate();
  }

  async run() {
    let consecutiveFailures = 0;
    while (!this.stopping()) {
      try {
        const updates = await this.telegram("getUpdates", {
          offset: this.getOffset(),
          timeout: 30,
          allowed_updates: ["message", "callback_query"],
        });
        consecutiveFailures = 0;
        for (const update of updates) {
          await this.process(update);
          if (this.stopping()) break;
        }
      } catch (error) {
        consecutiveFailures += 1;
        const retryDelayMs = telegramPollingRetryDelay(consecutiveFailures);
        if (shouldLogPollingFailure(consecutiveFailures)) {
          this.logger.error(
            `Telegram polling error (${consecutiveFailures}; retry in ${retryDelayMs} ms):`,
            error.message,
          );
        }
        await delay(retryDelayMs);
      }
    }
  }
}
