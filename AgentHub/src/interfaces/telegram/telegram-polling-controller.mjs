import { shouldLogPollingFailure, telegramPollingRetryDelay } from "../../infrastructure/telegram/poll-retry.mjs";

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
    now = Date.now,
    slowUpdateThresholdMs = 2_000,
    retryDelay = telegramPollingRetryDelay,
    delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
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
    this.now = now;
    this.slowUpdateThresholdMs = slowUpdateThresholdMs;
    this.retryDelay = retryDelay;
    this.delay = delay;
  }

  allowedCallback(callback) {
    const chat = callback.message?.chat;
    return this.config.allowedUserIds.has(callback.from?.id)
      && (!this.config.privateChatsOnly || chat?.type === "private")
      && (!this.config.allowedChatIds || this.config.allowedChatIds.has(chat?.id));
  }

  async process(update) {
    const startedAt = this.now();
    let handledAt = startedAt;
    this.setProcessingUpdateId(update.update_id);
    try {
      if (update.callback_query && this.allowedCallback(update.callback_query)) {
        await this.handleCallback(update.callback_query);
      } else if (update.message) {
        await this.handleMessage(update.message);
      }
      handledAt = this.now();
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
    await this.afterUpdate(update);
    const completedAt = this.now();
    const totalMs = completedAt - startedAt;
    if (totalMs >= this.slowUpdateThresholdMs) {
      const telegramDate = update.message?.date ?? update.callback_query?.message?.date;
      const transportMs = Number.isFinite(telegramDate)
        ? Math.max(0, startedAt - telegramDate * 1000)
        : null;
      this.logger.warn?.(
        `Slow Telegram update ${update.update_id}: handler=${handledAt - startedAt} ms, `
        + `state=${completedAt - handledAt} ms`
        + (transportMs === null ? "" : `, transport<=${transportMs} ms`),
      );
    }
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
        const retryDelayMs = this.retryDelay(consecutiveFailures);
        if (shouldLogPollingFailure(consecutiveFailures)) {
          this.logger.error(
            `Telegram polling error (${consecutiveFailures}; retry in ${retryDelayMs} ms):`,
            error.message,
          );
        }
        await this.delay(retryDelayMs);
      }
    }
  }
}
