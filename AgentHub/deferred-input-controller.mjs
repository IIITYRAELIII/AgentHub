export class DeferredInputController {
  constructor({
    pendingInputs,
    queuedInputs,
    isBlocked,
    start,
    persist,
    updateMessage,
    pendingKeyboard,
    notifyReturned,
    expire = async () => {},
    maxAgeMs = 7 * 24 * 60 * 60 * 1000,
    now = Date.now,
    retryDelayMs = 2_000,
    setTimeoutImpl = setTimeout,
    clearTimeoutImpl = clearTimeout,
  }) {
    this.pendingInputs = pendingInputs;
    this.queuedInputs = queuedInputs;
    this.isBlocked = isBlocked;
    this.start = start;
    this.persist = persist;
    this.updateMessage = updateMessage;
    this.pendingKeyboard = pendingKeyboard;
    this.notifyReturned = notifyReturned;
    this.expire = expire;
    this.maxAgeMs = maxAgeMs;
    this.now = now;
    this.retryDelayMs = retryDelayMs;
    this.setTimeoutImpl = setTimeoutImpl;
    this.clearTimeoutImpl = clearTimeoutImpl;
    this.timers = new Map();
  }

  schedule(item, delayMs = this.retryDelayMs) {
    if (!item || this.timers.has(item.id)) return;
    const timer = this.setTimeoutImpl(() => {
      this.timers.delete(item.id);
      void this.process(item.id);
    }, delayMs);
    this.timers.set(item.id, timer);
  }

  async process(id) {
    const item = this.queuedInputs.get(id);
    if (!item) return;
    const createdAt = Date.parse(String(item.createdAt ?? ""));
    if (Number.isFinite(createdAt) && this.now() - createdAt >= this.maxAgeMs) {
      this.queuedInputs.delete(id);
      await this.expire(item);
      await this.persist();
      return;
    }
    if (await this.isBlocked(item)) {
      this.schedule(item);
      return;
    }
    try {
      await this.start(item);
      this.queuedInputs.delete(id);
      await this.persist();
      await this.updateMessage(item, `▶️ Сообщение из очереди отправлено в задачу «${item.taskTitle}».`);
    } catch (error) {
      this.queuedInputs.delete(id);
      item.lastError = String(error.message ?? error);
      item.lastAttemptAt = new Date().toISOString();
      item.attempts = Number(item.attempts ?? 0) + 1;
      this.pendingInputs.set(id, item);
      await this.persist();
      await this.updateMessage(
        item,
        `⚠️ Не удалось запустить сообщение из очереди: ${item.lastError}\n\nСообщение сохранено. Выберите дальнейшее действие:`,
        this.pendingKeyboard(item),
      );
      await this.notifyReturned(item);
    }
  }

  stop() {
    for (const timer of this.timers.values()) this.clearTimeoutImpl(timer);
    this.timers.clear();
  }
}
