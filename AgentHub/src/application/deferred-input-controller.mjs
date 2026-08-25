import { CONTEXT_MAINTENANCE_ACTIVE_ERROR_CODE } from "../domain/deferred-input.mjs";
import { taskRunKey } from "../domain/task-runs.mjs";

export function isRetryableDeferredLaunchError(error) {
  const code = String(error?.code ?? "").trim().toUpperCase();
  if ([
    CONTEXT_MAINTENANCE_ACTIVE_ERROR_CODE,
    "EPIPE",
    "ECONNRESET",
    "ECONNREFUSED",
    "ERR_STREAM_DESTROYED",
  ].includes(code)) return true;
  const message = String(error?.message ?? error ?? "");
  return /(?:codex )?app-server (?:stopped|is not running)|write EPIPE|broken pipe|thread\s+\S+\s+already has an active writer/i.test(message);
}

export function deferredLaunchWaitReason(error) {
  if (String(error?.code ?? "").trim().toUpperCase() === CONTEXT_MAINTENANCE_ACTIVE_ERROR_CODE) {
    return "context-maintenance";
  }
  const message = String(error?.message ?? error ?? "");
  if (/thread\s+\S+\s+already has an active writer/i.test(message)) {
    return "provider-thread-active";
  }
  return isRetryableDeferredLaunchError(error) ? "provider-temporarily-unavailable" : null;
}

export class DeferredInputController {
  constructor({
    pendingInputs,
    queuedInputs,
    isBlocked,
    occupancy = async () => ({ occupied: false, waitReason: null }),
    laneKey = taskRunKey,
    findStarted = async () => null,
    steer = async () => null,
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
    commandTrace = null,
  }) {
    this.pendingInputs = pendingInputs;
    this.queuedInputs = queuedInputs;
    this.isBlocked = isBlocked;
    this.occupancy = occupancy;
    this.laneKey = laneKey;
    this.findStarted = findStarted;
    this.steer = steer;
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
    this.commandTrace = commandTrace;
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
    if (item.paused === true && ![
      "provider-thread-active", "provider-temporarily-unavailable",
    ].includes(item.waitReason)) return;
    if (item.paused === true || item.waitReason === "provider-thread-active") {
      const occupied = await this.refreshActiveWriterWait(item);
      if (occupied) return;
    }
    const oldest = this.oldestForTask(item, { includePending: true });
    if (oldest?.id !== id) {
      if (this.pendingInputs.has(oldest?.id)) {
        const released = await this.releaseResolvedTaskConflict(oldest);
        if (released) this.schedule(oldest, 0);
        else if (oldest?.conflictKind === "task-running") this.schedule(item);
      } else {
        this.schedule(oldest, 0);
      }
      return;
    }
    delete item.recheckRequested;
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
        await this.updateMessage(item, `▶️ Сообщение из очереди уже выполняется в потоке «${item.taskTitle}».`);
        this.scheduleNextForTask(item);
        return;
      }
      if (item.dispatchingAt) {
        delete item.dispatchingAt;
        this.onStateChange(item, "queued");
        await this.persist();
      }
      const intakeBlocked = item.conflictKind === "message-intake"
        ? await this.isBlocked(item)
        : null;
      if (intakeBlocked === true) {
        this.queuedInputs.delete(id);
        delete item.dispatchingAt;
        delete item.blockedChecks;
        item.conflictKind = "task-running";
        this.pendingInputs.set(id, item);
        this.onStateChange(item, "pending");
        await this.persist();
        await this.updateMessage(
          item,
          `⏸ Сообщение сохранено для ручного действия в потоке «${item.taskTitle}».`,
          this.pendingKeyboard(item),
        );
        return;
      }
      if (intakeBlocked ?? await this.isBlocked(item)) {
        if (item.waitReason === "provider-thread-active") {
          await this.pauseForActiveWriter(item);
          return;
        }
        item.blockedChecks = Number(item.blockedChecks ?? 0) + 1;
        this.schedule(item, Math.min(
          this.maxRetryDelayMs,
          this.retryDelayMs * (2 ** Math.min(item.blockedChecks - 1, 4)),
        ));
        return;
      }
      delete item.blockedChecks;
      // Keep the input durable while launch is in progress, but expose the
      // transition so clients no longer render it as waiting in the queue.
      item.dispatchingAt = new Date(this.now()).toISOString();
      this.onStateChange(item, "dispatching");
      await this.persist();
      let started;
      const dispatchSpan = this.commandTrace?.startBestEffortSpan?.({
        commandId: String(item.clientUserMessageId ?? ""),
        stage: "dispatch",
        transport: String(item.clientSource ?? "desktop-control").trim().toLowerCase() || "desktop-control",
        metadata: { itemId: item.id, retryCount: Number(item.attempts ?? 0) },
      });
      try {
        started = await this.start(item);
        dispatchSpan?.finish({
          outcome: "succeeded",
          queueDepth: this.queuedInputs.size,
          metadata: { runId: started?.id ?? started?.run?.id ?? null },
        });
      } catch (error) {
        dispatchSpan?.finish({
          outcome: this.isRetryableLaunchError(error, item) ? "queued" : "failed",
          queueDepth: this.queuedInputs.size,
          metadata: { errorCode: error?.code ?? null },
        });
        const retryable = this.isRetryableLaunchError(error, item);
        const waitReason = retryable
          ? deferredLaunchWaitReason(error) ?? "provider-temporarily-unavailable"
          : null;
        if (retryable) {
          if (waitReason === "provider-thread-active") {
            await this.pauseForActiveWriter(item, { error, waitReason, attempted: true });
            return;
          }
        }
        delete item.dispatchingAt;
        item.lastAttemptAt = new Date(this.now()).toISOString();
        item.attempts = Number(item.attempts ?? 0) + 1;
        if (retryable) {
          delete item.lastError;
          item.waitReason = waitReason;
          this.onStateChange(item, "retrying", error);
          await this.persist();
          const retryDelay = Math.min(
            this.maxRetryDelayMs,
            this.retryDelayMs * (2 ** Math.min(item.attempts - 1, 4)),
          );
          this.schedule(item, retryDelay);
          return;
        }
        delete item.waitReason;
        item.lastError = String(error.message ?? error);
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
      delete item.waitReason;
      delete item.blockedChecks;
      this.onStateChange(item, "started", started);
      await this.persist();
      await this.updateMessage(item, `▶️ Сообщение из очереди отправлено в поток «${item.taskTitle}».`);
      this.scheduleNextForTask(item);
    } finally {
      this.processing.delete(id);
    }
  }

  async releaseResolvedTaskConflict(item) {
    if (!item || item.conflictKind !== "task-running" || !this.pendingInputs.has(item.id)) {
      return false;
    }
    if (await this.isBlocked(item)) return false;
    this.pendingInputs.delete(item.id);
    item.conflictKind = null;
    item.allowForce = false;
    delete item.lastError;
    this.queuedInputs.set(item.id, item);
    this.onStateChange(item, "queued");
    await this.persist();
    await this.updateMessage(
      item,
      `▶️ Предыдущий ход завершён. Сообщение поставлено в очередь потока «${item.taskTitle}».`,
    );
    return true;
  }

  async pauseForActiveWriter(item, options = {}) {
    const previous = Object.getOwnPropertyDescriptors(item);
    item.paused = true;
    delete item.dispatchingAt;
    delete item.recheckRequested;
    delete item.blockedChecks;
    if (options.waitReason) item.waitReason = options.waitReason;
    if (options.attempted) {
      item.lastAttemptAt = new Date(this.now()).toISOString();
      item.attempts = Number(item.attempts ?? 0) + 1;
      delete item.lastError;
    }
    try {
      await this.persist();
    } catch (error) {
      for (const key of Reflect.ownKeys(item)) delete item[key];
      Object.defineProperties(item, previous);
      this.schedule(item, this.retryDelayMs);
      throw error;
    }
    this.onStateChange(item, "paused", options.error);
    this.schedule(item, this.retryDelayMs);
  }

  async refreshActiveWriterWait(item) {
    const current = await this.occupancy(item);
    if (current?.occupied) {
      await this.pauseForActiveWriter(item, {
        waitReason: current.waitReason ?? "provider-thread-active",
      });
      return true;
    }
    const previous = Object.getOwnPropertyDescriptors(item);
    delete item.paused;
    delete item.waitReason;
    delete item.recheckRequested;
    try {
      await this.persist();
    } catch (error) {
      for (const key of Reflect.ownKeys(item)) delete item[key];
      Object.defineProperties(item, previous);
      this.schedule(item, this.retryDelayMs);
      throw error;
    }
    this.onStateChange(item, "queued");
    return false;
  }

  taskKey(item) {
    return this.laneKey(item);
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
      const order = Number(candidate.queueOrder);
      const parsed = Date.parse(String(candidate.createdAt ?? ""));
      const candidateAt = Number.isFinite(order)
        ? order
        : Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
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
