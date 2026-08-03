export function isRetryableDeferredLaunchError(error) {
  const code = String(error?.code ?? "").trim().toUpperCase();
  if (["EPIPE", "ECONNRESET", "ECONNREFUSED", "ERR_STREAM_DESTROYED"].includes(code)) return true;
  const message = String(error?.message ?? error ?? "");
  return /(?:codex )?app-server (?:stopped|is not running)|write EPIPE|broken pipe/i.test(message);
}

export class DeferredInputController {
  constructor({
    pendingInputs,
    queuedInputs,
    isBlocked,
    findStarted = async () => null,
    start,
    persist,
    updateMessage,
    pendingKeyboard,
    notifyReturned,
    onStateChange = () => {},
    expire = async () => {},
    isRetryableLaunchError = isRetryableDeferredLaunchError,
    maxAgeMs = 7 * 24 * 60 * 60 * 1000,
    now = Date.now,
    retryDelayMs = 2_000,
    maxRetryDelayMs = 30_000,
    setTimeoutImpl = setTimeout,
    clearTimeoutImpl = clearTimeout,
  }) {
    this.pendingInputs = pendingInputs;
    this.queuedInputs = queuedInputs;
    this.isBlocked = isBlocked;
    this.findStarted = findStarted;
    this.start = start;
    this.persist = persist;
    this.updateMessage = updateMessage;
    this.pendingKeyboard = pendingKeyboard;
    this.notifyReturned = notifyReturned;
    this.onStateChange = onStateChange;
    this.expire = expire;
    this.isRetryableLaunchError = isRetryableLaunchError;
    this.maxAgeMs = maxAgeMs;
    this.now = now;
    this.retryDelayMs = retryDelayMs;
    this.maxRetryDelayMs = maxRetryDelayMs;
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

  cancelSchedule(id) {
    const timer = this.timers.get(id);
    if (timer == null) return false;
    this.clearTimeoutImpl(timer);
    this.timers.delete(id);
    return true;
  }

  isProcessing(id) {
    return this.processing.has(id);
  }

  async process(id) {
    const item = this.queuedInputs.get(id);
    if (!item || this.processing.has(id)) return;
    const oldest = this.oldestForTask(item, { includePending: true });
    if (oldest?.id !== id) {
      if (!this.pendingInputs.has(oldest?.id)) this.schedule(item);
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
      const recoveredRun = await this.findStarted(item);
      if (recoveredRun) {
        this.queuedInputs.delete(id);
        delete item.dispatchingAt;
        this.onStateChange(item, "started", recoveredRun);
        await this.persist();
        await this.updateMessage(item, `▶️ Сообщение из очереди уже выполняется в задаче «${item.taskTitle}».`);
        this.scheduleNextForTask(item);
        return;
      }
      if (item.dispatchingAt) {
        delete item.dispatchingAt;
        this.onStateChange(item, "queued");
        await this.persist();
      }
      if (await this.isBlocked(item)) {
        this.schedule(item);
        return;
      }
      // Keep the input durable while launch is in progress, but expose the
      // transition so clients no longer render it as waiting in the queue.
      item.dispatchingAt = new Date(this.now()).toISOString();
      this.onStateChange(item, "dispatching");
      await this.persist();
      let started;
      try {
        started = await this.start(item);
      } catch (error) {
        delete item.dispatchingAt;
        item.lastError = String(error.message ?? error);
        item.lastAttemptAt = new Date(this.now()).toISOString();
        item.attempts = Number(item.attempts ?? 0) + 1;
        if (this.isRetryableLaunchError(error, item)) {
          this.onStateChange(item, "retrying", error);
          await this.persist();
          const retryDelay = Math.min(
            this.maxRetryDelayMs,
            this.retryDelayMs * (2 ** Math.min(item.attempts - 1, 4)),
          );
          this.schedule(item, retryDelay);
          return;
        }
        this.queuedInputs.delete(id);
        this.pendingInputs.set(id, item);
        this.onStateChange(item, "pending", error);
        await this.persist();
        await this.updateMessage(
          item,
          `⚠️ Не удалось запустить сообщение из очереди: ${item.lastError}\n\nСообщение сохранено. Выберите дальнейшее действие:`,
          this.pendingKeyboard(item),
        );
        await this.notifyReturned(item);
        return;
      }
      this.queuedInputs.delete(id);
      delete item.dispatchingAt;
      delete item.lastError;
      delete item.lastAttemptAt;
      this.onStateChange(item, "started", started);
      await this.persist();
      await this.updateMessage(item, `▶️ Сообщение из очереди отправлено в задачу «${item.taskTitle}».`);
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

  oldestForTask(item, { includePending = false } = {}) {
    const key = this.taskKey(item);
    let oldest = null;
    let oldestAt = Number.POSITIVE_INFINITY;
    const candidates = includePending
      ? [...this.pendingInputs.values(), ...this.queuedInputs.values()]
      : this.queuedInputs.values();
    for (const candidate of candidates) {
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
