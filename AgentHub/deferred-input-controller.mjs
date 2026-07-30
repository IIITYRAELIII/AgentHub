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
    this.processing = new Set();
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
    if (!item || this.processing.has(id)) return;
    const oldest = this.oldestForTask(item);
    if (oldest?.id !== id) {
      this.schedule(item);
      return;
    }
    this.processing.add(id);
    try {
      const createdAt = Date.parse(String(item.createdAt ?? ""));
      if (Number.isFinite(createdAt) && this.now() - createdAt >= this.maxAgeMs) {
        this.queuedInputs.delete(id);
        await this.expire(item);
        await this.persist();
        this.scheduleNextForTask(item);
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
      this.scheduleNextForTask(item);
    } finally {
      this.processing.delete(id);
    }
  }

  taskKey(item) {
    return [
      String(item?.provider ?? "").toLowerCase(),
      String(item?.projectRoot ?? "").toLowerCase(),
      String(item?.threadId ?? "").toLowerCase(),
    ].join("\0");
  }

  oldestForTask(item) {
    const key = this.taskKey(item);
    let oldest = null;
    let oldestAt = Number.POSITIVE_INFINITY;
    for (const candidate of this.queuedInputs.values()) {
      if (this.taskKey(candidate) !== key) continue;
      const parsed = Date.parse(String(candidate.createdAt ?? ""));
      const candidateAt = Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
      if (!oldest || candidateAt < oldestAt) {
        oldest = candidate;
        oldestAt = candidateAt;
      }
    }
    return oldest;
  }

  scheduleNextForTask(item) {
    const next = this.oldestForTask(item);
    if (next) this.schedule(next, 0);
  }

  stop() {
    for (const timer of this.timers.values()) this.clearTimeoutImpl(timer);
    this.timers.clear();
  }
}
