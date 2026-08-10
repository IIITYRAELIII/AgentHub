export class RestartRequestService {
  constructor({
    getRequest,
    setRequest,
    blockingWorkCount,
    currentChatId,
    updateOffset,
    processingUpdateId,
    saveState,
    announceDesktop,
    sendTelegram,
    performRestart,
    scheduleRestart = (callback) => setTimeout(callback, 0).unref(),
    nowIso = () => new Date().toISOString(),
  }) {
    Object.assign(this, {
      getRequest,
      setRequest,
      blockingWorkCount,
      currentChatId,
      updateOffset,
      processingUpdateId,
      saveState,
      announceDesktop,
      sendTelegram,
      performRestart,
      scheduleRestart,
      nowIso,
    });
  }

  #request({ messageId, minimumUpdateOffset, blockingCount, notifyTelegram }) {
    return {
      chatId: this.currentChatId(),
      messageId,
      requestedAt: this.nowIso(),
      waitingForRuns: blockingCount > 0,
      minimumUpdateOffset,
      notifyTelegram: notifyTelegram === true,
    };
  }

  async fromDesktop() {
    if (this.getRequest()) return { accepted: false, message: "Перезапуск уже запрошен" };
    const blockingCount = this.blockingWorkCount();
    const request = this.#request({
      messageId: null,
      minimumUpdateOffset: this.updateOffset(),
      blockingCount,
      notifyTelegram: false,
    });
    this.setRequest(request);
    await this.saveState();
    void this.announceDesktop(request, blockingCount);
    if (!blockingCount) this.scheduleRestart(() => void this.performRestart());
    return {
      accepted: true,
      waiting: blockingCount > 0,
      message: blockingCount > 0
        ? "Перезапуск ожидает завершения задач"
        : "Agent Hub Server перезапускается",
    };
  }

  async fromTelegram() {
    const existing = this.getRequest();
    if (existing) {
      await this.sendTelegram(existing.waitingForRuns
        ? "Перезапуск уже ожидает завершения выполняющихся задач."
        : "Бот уже перезапускается.");
      return { accepted: false };
    }
    const blockingCount = this.blockingWorkCount();
    const message = await this.sendTelegram(blockingCount
      ? `🔄 Перезапущу бота после завершения выполняющихся задач: ${blockingCount}.`
      : "🔄 Перезапускаю Agent Hub…");
    if (!message?.message_id) throw new Error("Telegram не вернул ID сообщения перезапуска");
    const processingUpdateId = this.processingUpdateId();
    this.setRequest(this.#request({
      messageId: message.message_id,
      minimumUpdateOffset: Number.isSafeInteger(processingUpdateId)
        ? processingUpdateId + 1
        : this.updateOffset(),
      blockingCount,
      notifyTelegram: true,
    }));
    await this.saveState();
    if (!blockingCount && processingUpdateId == null) await this.performRestart();
    return { accepted: true, waiting: blockingCount > 0 };
  }
}
