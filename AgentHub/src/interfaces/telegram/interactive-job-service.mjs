export class InteractiveJobService {
  constructor({ queue, stopping, sendMessage, logger = console }) {
    this.queue = queue;
    this.stopping = stopping;
    this.sendMessage = sendMessage;
    this.logger = logger;
  }

  schedule(label, targetChatId, operation) {
    try {
      const job = this.queue.enqueue(async () => {
        if (!this.stopping()) await operation();
      });
      void job.catch(async (error) => {
        this.logger.error(`Interactive Telegram job ${label} failed:`, error.message);
        if (!this.stopping() && Number.isSafeInteger(targetChatId)) {
          await this.sendMessage(targetChatId, `Не удалось выполнить «${label}»: ${error.message}`).catch(() => {});
        }
      });
      return true;
    } catch (error) {
      this.logger.warn(`Interactive Telegram queue rejected ${label}:`, error.message);
      if (Number.isSafeInteger(targetChatId)) {
        void this.sendMessage(
          targetChatId,
          `Слишком много команд просмотра. Повторите «${label}» немного позже.`,
        ).catch(() => {});
      }
      return false;
    }
  }
}
