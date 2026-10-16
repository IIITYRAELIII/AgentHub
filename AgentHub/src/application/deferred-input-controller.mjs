import {
  CONTEXT_MAINTENANCE_ACTIVE_ERROR_CODE,
  RUNTIME_RESTART_PENDING_ERROR_CODE,
} from "../domain/deferred-input.mjs";
import { taskRunKey } from "../domain/task-runs.mjs";

export function isRetryableDeferredLaunchError(error) {
  const code = String(error?.code ?? "").trim().toUpperCase();
  if ([
    CONTEXT_MAINTENANCE_ACTIVE_ERROR_CODE,
    RUNTIME_RESTART_PENDING_ERROR_CODE,
    "ERR_CLAUDE_EXTERNAL_OWNER_ACTIVE",
    "ERR_CLAUDE_EXTERNAL_OWNER_UNKNOWN",
    "EPIPE",
    "ECONNRESET",
    "ECONNREFUSED",
    "ERR_STREAM_DESTROYED",
  ].includes(code)) return true;
  const message = String(error?.message ?? error ?? "");
  return /(?:codex )?app-server (?:stopped|is not running)|write EPIPE|broken pipe|thread\s+\S+\s+already has an active writer/i.test(message);
}

export function isUnconfirmedDeferredLaunchError(error) {
  const code = String(error?.code ?? "").trim().toUpperCase();
  return code === "ERR_CODEX_TURN_START_UNCONFIRMED"
    || error?.deliveryOutcome === "unknown"
    || error?.uncertain === true;
}

export function deferredLaunchWaitReason(error) {
  if (String(error?.code ?? "").trim().toUpperCase() === "ERR_CLAUDE_EXTERNAL_OWNER_ACTIVE") {
    return "provider-thread-active";
  }
  if (String(error?.code ?? "").trim().toUpperCase() === "ERR_CLAUDE_EXTERNAL_OWNER_UNKNOWN") {
    return "provider-temporarily-unavailable";
  }
  if (String(error?.code ?? "").trim().toUpperCase() === RUNTIME_RESTART_PENDING_ERROR_CODE) {
    return "runtime-restart";
  }
  if (String(error?.code ?? "").trim().toUpperCase() === CONTEXT_MAINTENANCE_ACTIVE_ERROR_CODE) {
    return "context-maintenance";
  }
  const message = String(error?.message ?? error ?? "");
  if (/thread\s+\S+\s+already has an active writer/i.test(message)) {
    return "provider-thread-active";
  }
  return isRetryableDeferredLaunchError(error) ? "provider-temporarily-unavailable" : null;
}

function steerTargetsOccupancy(item, occupancy) {
  if (!occupancy?.occupied || !occupancy.run) return false;
  const expectedRunId = String(item?.steerTargetRunId ?? "").trim();
  const expectedTurnId = String(item?.steerTargetTurnId ?? "").trim();
  if (!expectedRunId && !expectedTurnId) return false;
  return (!expectedRunId || expectedRunId === String(occupancy.run.id ?? "").trim())
    && (!expectedTurnId || expectedTurnId === String(occupancy.run.turnId ?? "").trim());
}

function intentionallyPaused(item) {
  return item?.paused === true && ![
    "provider-thread-active", "provider-temporarily-unavailable",
  ].includes(String(item?.waitReason ?? ""));
}

const AUTO_RELEASABLE_PENDING_CONFLICTS = new Set([
  "task-running",
  "activity-unknown",
]);

function autoReleasablePendingConflict(item) {
  return AUTO_RELEASABLE_PENDING_CONFLICTS.has(String(item?.conflictKind ?? ""));
}

const DEFERRED_ERROR_MESSAGES = Object.freeze({
  ERR_CLAUDE_EXTERNAL_OWNER_ACTIVE: "Внешний процесс Claude всё ещё выполняет этот поток.",
  ERR_CLAUDE_EXTERNAL_OWNER_UNKNOWN: "Не удалось надёжно проверить внешний процесс Claude.",
  ERR_CODEX_TURN_START_UNCONFIRMED: "Codex не подтвердил запуск; автоматический повтор не выполнялся.",
  ERR_DEFERRED_INPUT_PROCESSING: "Не удалось обработать сохранённое сообщение.",
  ERR_DEFERRED_INPUT_START: "Не удалось запустить сохранённое сообщение.",
  ERR_PROVIDER_STEER_NOT_DELIVERED: "Уточнение не доставлено в исходный ход; выберите дальнейшее действие.",
  ERR_PROVIDER_STEER_UNCONFIRMED: "Провайдер не подтвердил уточнение; автоматический повтор не выполнялся.",
});

function safeDeferredError(error, fallbackCode = "ERR_DEFERRED_INPUT_PROCESSING") {
  const candidate = String(error?.code ?? "").trim().toUpperCase();
  const code = Object.hasOwn(DEFERRED_ERROR_MESSAGES, candidate) ? candidate : fallbackCode;
  return { code, message: DEFERRED_ERROR_MESSAGES[code] };
}

export class DeferredInputController {
  constructor({
    pendingInputs,
    queuedInputs,
    isBlocked,
    occupancy = async () => ({ occupied: false, waitReason: null }),
    laneKey = taskRunKey,
    findStarted = async () => null,
    findSteered = async () => null,
    isSteerDispatchBlocked = async () => false,
    steer = async () => null,
    start,
    persist,
    updateMessage,
    pendingKeyboard,
    notifyReturned,
    onStateChange = () => {},
    expire = async () => {},
    expireCommands = null,
    onExpiryError = (error) => console.warn("Cannot maintain message command expiry:", error.message),
    isRetryableLaunchError = isRetryableDeferredLaunchError,
    maxAgeMs = 7 * 24 * 60 * 60 * 1000,
    providerReconciliationMaxAgeMs = 5 * 60 * 1000,
    now = Date.now,
    retryDelayMs = 2_000,
    maxRetryDelayMs = 30_000,
    retryJitterRatio = 0.2,
    random = Math.random,
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
    this.findSteered = findSteered;
    this.isSteerDispatchBlocked = isSteerDispatchBlocked;
    this.steer = steer;
    this.start = start;
    this.persist = persist;
    this.updateMessage = updateMessage;
    this.pendingKeyboard = pendingKeyboard;
    this.notifyReturned = notifyReturned;
    this.onStateChange = onStateChange;
    this.expire = expire;
    this.expireCommands = expireCommands;
    this.expiryTimer = null;
    this.onExpiryError = onExpiryError;
    this.isRetryableLaunchError = isRetryableLaunchError;
    this.maxAgeMs = maxAgeMs;
    this.providerReconciliationMaxAgeMs = Math.max(
      Number(retryDelayMs) || 2_000,
      Number(providerReconciliationMaxAgeMs) || 5 * 60 * 1000,
    );
    this.now = now;
    this.retryDelayMs = retryDelayMs;
    this.maxRetryDelayMs = maxRetryDelayMs;
    this.retryJitterRatio = Math.max(0, Math.min(0.5, Number(retryJitterRatio) || 0));
    this.random = random;
    this.setTimeoutImpl = setTimeoutImpl;
    this.clearTimeoutImpl = clearTimeoutImpl;
    this.commandTrace = commandTrace;
    this.timers = new Map();
    this.processing = new Set();
    for (const item of [...this.pendingInputs.values(), ...this.queuedInputs.values()]) {
      if (item?.lastError == null && item?.lastErrorCode == null) continue;
      const detail = safeDeferredError({ code: item.lastErrorCode });
      item.lastErrorCode = detail.code;
      item.lastError = detail.message;
    }
  }

  schedule(item, delayMs = this.retryDelayMs) {
    if (!item) return;
    const normalizedDelayMs = Math.max(0, Number(delayMs) || 0);
    if (this.timers.has(item.id)) {
      if (normalizedDelayMs > 0) return;
      this.cancelSchedule(item.id);
    }
    const timer = this.setTimeoutImpl(() => {
      this.timers.delete(item.id);
      return this.process(item.id)
        .catch((error) => this.recoverScheduledProcessFailure(item, error))
        .catch(() => {});
    }, normalizedDelayMs);
    this.timers.set(item.id, timer);
  }

  retryDelay(attempt) {
    const exponential = Math.min(
      this.maxRetryDelayMs,
      this.retryDelayMs * (2 ** Math.min(Math.max(0, Number(attempt) - 1), 8)),
    );
    const jitter = exponential * this.retryJitterRatio * ((this.random() * 2) - 1);
    return Math.max(0, Math.min(this.maxRetryDelayMs, Math.round(exponential + jitter)));
  }

  async recoverScheduledProcessFailure(expected, error) {
    const current = this.queuedInputs.get(expected?.id) ?? this.pendingInputs.get(expected?.id);
    if (!current || current !== expected) return;
    current.processRecoveryChecks = Number(current.processRecoveryChecks ?? 0) + 1;
    const detail = safeDeferredError(error);
    current.lastErrorCode = detail.code;
    current.lastError = detail.message;
    this.onStateChange(
      current,
      this.queuedInputs.has(current.id) ? "queued" : "pending",
      detail,
    );
    try {
      await this.persist();
    } catch {
      // The in-memory owner remains exact and the bounded retry below gives a
      // transient persistence failure another chance without leaking a rejected
      // timer promise into the process.
    }
    const retained = this.queuedInputs.get(current.id) ?? this.pendingInputs.get(current.id);
    if (retained !== current) return;
    if (!this.queuedInputs.has(current.id) && !autoReleasablePendingConflict(current)) return;
    this.schedule(current, this.retryDelay(current.processRecoveryChecks));
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
    this.expireCommands?.();
    const queuedItem = this.queuedInputs.get(id);
    const pendingItem = this.pendingInputs.get(id);
    const item = queuedItem ?? (autoReleasablePendingConflict(pendingItem) ? pendingItem : null);
    if (!item || this.processing.has(id)) return;
    this.processing.add(id);
    try {
      if (!queuedItem) {
        const released = await this.releaseResolvedTaskConflict(item);
        if (released) this.schedule(item, 0);
        else if (this.pendingInputs.has(id)) {
          item.blockedChecks = Number(item.blockedChecks ?? 0) + 1;
          this.schedule(item, this.retryDelay(item.blockedChecks));
        }
        return;
      }
      if (item.paused === true && ![
        "provider-thread-active", "provider-temporarily-unavailable",
      ].includes(item.waitReason)) return;
      if (item.paused === true || item.waitReason === "provider-thread-active") {
        const occupied = await this.refreshActiveWriterWait(item);
        if (occupied) return;
      }
      let activeSteer = item.conflictKind === "message-steer" && Boolean(item.dispatchingAt);
      if (item.conflictKind === "message-steer" && !item.dispatchingAt) {
        const occupancy = await this.occupancy(item);
        activeSteer = steerTargetsOccupancy(item, occupancy);
        if (!activeSteer) {
          await this.requireSteerDecision(item);
          return;
        }
      }
      if (!activeSteer) {
        const oldest = this.oldestForTask(item, { includePending: true, runnableOnly: true });
        if (oldest?.id !== id) {
          if (this.pendingInputs.has(oldest?.id)) {
            const released = await this.releaseResolvedTaskConflict(oldest);
            if (released) this.schedule(oldest, 0);
            else if (autoReleasablePendingConflict(oldest)) this.schedule(item);
          } else {
            this.schedule(oldest, 0);
          }
          return;
        }
      }
      delete item.recheckRequested;
      const createdAt = Date.parse(String(item.createdAt ?? ""));
      if (!(this.expireCommands && item.clientUserMessageId)
        && Number.isFinite(createdAt) && this.now() - createdAt >= this.maxAgeMs) {
        this.queuedInputs.delete(id);
        await this.expire(item);
        await this.persist();
        this.scheduleNextForTask(item);
        return;
      }
      if (item.conflictKind === "message-steer") {
        await this.processSteer(item);
        return;
      }
      const recoveredRun = await this.findStarted(item);
      if (recoveredRun) {
        this.queuedInputs.delete(id);
        delete item.dispatchingAt;
        delete item.lastError;
        delete item.lastErrorCode;
        delete item.lastAttemptAt;
        delete item.waitReason;
        delete item.providerReconciliationStartedAt;
        delete item.providerReconciliationChecks;
        this.onStateChange(item, "started", recoveredRun);
        await this.persist();
        await this.updateMessage(item, `▶️ Сообщение из очереди уже выполняется в потоке «${item.taskTitle}».`);
        this.scheduleNextForTask(item);
        return;
      }
      if (item.waitReason === "provider-start-unconfirmed") {
        const reconciliationStartedAt = Date.parse(String(item.providerReconciliationStartedAt ?? ""));
        const reconciliationAgeMs = Number.isFinite(reconciliationStartedAt)
          ? this.now() - reconciliationStartedAt
          : 0;
        if (reconciliationAgeMs < this.providerReconciliationMaxAgeMs) {
          item.providerReconciliationChecks = Number(item.providerReconciliationChecks ?? 0) + 1;
          this.onStateChange(item, "reconciling");
          await this.persist();
          this.schedule(item, this.retryDelay(item.providerReconciliationChecks));
          return;
        }
        delete item.dispatchingAt;
        delete item.waitReason;
        delete item.providerReconciliationStartedAt;
        delete item.providerReconciliationChecks;
        item.lastError = "Codex не подтвердил запуск; автоматический повтор не выполнялся.";
        item.lastErrorCode = "ERR_CODEX_TURN_START_UNCONFIRMED";
        this.queuedInputs.delete(id);
        this.pendingInputs.set(id, item);
        this.onStateChange(item, "pending");
        await this.persist();
        await this.updateMessage(
          item,
          `⚠️ ${item.lastError}\n\nСообщение сохранено. Выберите дальнейшее действие:`,
          this.pendingKeyboard(item),
        );
        await this.notifyReturned(item);
        return;
      }
      if (item.dispatchingAt) {
        delete item.dispatchingAt;
        this.onStateChange(item, "queued");
        await this.persist();
      }
      if (await this.traceAdmissionStep(item, "deferred-eligibility", () => this.isBlocked(item))) {
        if (item.waitReason === "provider-thread-active") {
          await this.pauseForActiveWriter(item);
          return;
        }
        item.blockedChecks = Number(item.blockedChecks ?? 0) + 1;
        this.schedule(item, this.retryDelay(item.blockedChecks));
        return;
      }
      delete item.blockedChecks;
      // Keep the input durable while launch is in progress, but expose the
      // transition so clients no longer render it as waiting in the queue.
      delete item.laneReleased;
      item.dispatchingAt = new Date(this.now()).toISOString();
      this.onStateChange(item, "dispatching");
      await this.traceAdmissionStep(item, "deferred-dispatch-persist", () => this.persist());
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
        const unconfirmed = isUnconfirmedDeferredLaunchError(error);
        const retryable = !unconfirmed && this.isRetryableLaunchError(error, item);
        dispatchSpan?.finish({
          outcome: unconfirmed ? "unknown" : retryable ? "queued" : "failed",
          queueDepth: this.queuedInputs.size,
          metadata: { errorCode: safeDeferredError(error).code },
        });
        const waitReason = retryable
          ? deferredLaunchWaitReason(error) ?? "provider-temporarily-unavailable"
          : null;
        if (retryable) {
          if (waitReason === "provider-thread-active") {
            await this.pauseForActiveWriter(item, { error, waitReason, attempted: true });
            return;
          }
        }
        item.lastAttemptAt = new Date(this.now()).toISOString();
        item.attempts = Number(item.attempts ?? 0) + 1;
        if (unconfirmed) {
          item.waitReason = "provider-start-unconfirmed";
          item.providerReconciliationStartedAt ||= item.lastAttemptAt;
          item.providerReconciliationChecks = 0;
          const detail = safeDeferredError(error, "ERR_CODEX_TURN_START_UNCONFIRMED");
          item.lastErrorCode = detail.code;
          item.lastError = detail.message;
          this.onStateChange(item, "reconciling", detail);
          await this.persist();
          this.schedule(item, this.retryDelayMs);
          return;
        }
        delete item.dispatchingAt;
        if (retryable) {
          delete item.lastError;
          delete item.lastErrorCode;
          item.waitReason = waitReason;
          const detail = safeDeferredError(error);
          this.onStateChange(item, "retrying", detail);
          await this.persist();
          this.schedule(item, this.retryDelay(item.attempts));
          return;
        }
        delete item.waitReason;
        const detail = safeDeferredError(error, "ERR_DEFERRED_INPUT_START");
        item.lastErrorCode = detail.code;
        item.lastError = detail.message;
        item.laneReleased = true;
        this.queuedInputs.delete(id);
        this.pendingInputs.set(id, item);
        this.onStateChange(item, "pending", detail);
        await this.persist();
        await this.updateMessage(
          item,
          `⚠️ Не удалось запустить сообщение из очереди: ${item.lastError}\n\nСообщение сохранено. Выберите дальнейшее действие:`,
          this.pendingKeyboard(item),
        );
        await this.notifyReturned(item);
        this.scheduleNextForTask(item);
        return;
      }
      this.queuedInputs.delete(id);
      delete item.dispatchingAt;
      delete item.lastError;
      delete item.lastErrorCode;
      delete item.lastAttemptAt;
      delete item.waitReason;
      delete item.blockedChecks;
      this.onStateChange(item, "started", started);
      await this.persist();
      await this.updateMessage(item, `▶️ Сообщение из очереди отправлено в поток «${item.taskTitle}».`);
      this.scheduleNextForTask(item);
    } finally {
      this.processing.delete(id);
      if (item.recheckRequested === true
        && (this.queuedInputs.has(id) || this.pendingInputs.has(id))) {
        delete item.recheckRequested;
        this.cancelSchedule(id);
        this.schedule(item, 0);
      }
    }
  }

  async traceAdmissionStep(item, stage, operation) {
    let span;
    try {
      span = this.commandTrace?.startBestEffortSpan?.({
        commandId: String(item.clientUserMessageId ?? ""),
        transport: String(item.clientSource ?? "desktop-control").trim().toLowerCase() || "desktop-control",
        stage, recordStarted: true,
      });
    } catch { /* Diagnostics cannot affect eligibility. */ }
    const finish = (outcome, error) => {
      try { span?.finish({ outcome, metadata: error
        ? { errorCode: /^[A-Z][A-Z0-9_]{0,63}$/u.test(String(error.code))
          ? error.code : "ERR_DEFERRED_ADMISSION" } : {} }); }
      catch { /* Preserve the owning operation's outcome. */ }
    };
    try {
      const result = await operation();
      finish("succeeded");
      return result;
    } catch (error) {
      finish("failed", error);
      throw error;
    }
  }

  async processSteer(item) {
    const id = item.id;
    if (item.dispatchingAt) {
      const recovered = await this.findSteered(item);
      if (recovered) {
        await this.finishSteer(item, recovered);
        return;
      }
      const reconciliationStartedAt = Date.parse(String(
        item.providerReconciliationStartedAt ?? item.dispatchingAt ?? "",
      ));
      const reconciliationAgeMs = Number.isFinite(reconciliationStartedAt)
        ? this.now() - reconciliationStartedAt
        : 0;
      if (reconciliationAgeMs < this.providerReconciliationMaxAgeMs) {
        item.waitReason = "provider-steer-unconfirmed";
        item.providerReconciliationStartedAt ||= item.dispatchingAt;
        item.providerReconciliationChecks = Number(item.providerReconciliationChecks ?? 0) + 1;
        this.onStateChange(item, "reconciling");
        await this.persist();
        this.schedule(item, this.retryDelay(item.providerReconciliationChecks));
        return;
      }
      delete item.dispatchingAt;
      delete item.waitReason;
      delete item.providerReconciliationStartedAt;
      delete item.providerReconciliationChecks;
      item.lastError = "Провайдер не подтвердил уточнение; автоматический повтор не выполнялся.";
      item.lastErrorCode = "ERR_PROVIDER_STEER_UNCONFIRMED";
      this.queuedInputs.delete(id);
      this.pendingInputs.set(id, item);
      this.onStateChange(item, "pending");
      await this.persist();
      await this.updateMessage(
        item,
        `⚠️ ${item.lastError}\n\nСообщение сохранено. Выберите дальнейшее действие:`,
        this.pendingKeyboard(item),
      );
      await this.notifyReturned(item);
      return;
    }

    if (await this.traceAdmissionStep(item, "deferred-eligibility", () => this.isSteerDispatchBlocked(item))) {
      item.blockedChecks = Number(item.blockedChecks ?? 0) + 1;
      this.schedule(item, this.retryDelay(item.blockedChecks));
      return;
    }
    delete item.blockedChecks;
    item.dispatchingAt = new Date(this.now()).toISOString();
    this.onStateChange(item, "dispatching");
    await this.traceAdmissionStep(item, "deferred-dispatch-persist", () => this.persist());
    const dispatchSpan = this.commandTrace?.startBestEffortSpan?.({
      commandId: String(item.clientUserMessageId ?? ""),
      stage: "dispatch",
      transport: String(item.clientSource ?? "desktop-control").trim().toLowerCase() || "desktop-control",
      metadata: { itemId: item.id, operation: "steer" },
    });
    try {
      const steered = await this.steer(item);
      if (!steered) {
        dispatchSpan?.finish({
          outcome: "failed",
          queueDepth: this.queuedInputs.size,
          metadata: { errorCode: "ERR_PROVIDER_STEER_NOT_DELIVERED" },
        });
        await this.requireSteerDecision(item);
        return;
      }
      dispatchSpan?.finish({
        outcome: "succeeded",
        queueDepth: this.queuedInputs.size,
        metadata: { runId: steered.runId ?? null, turnId: steered.turnId ?? null },
      });
      await this.finishSteer(item, steered);
    } catch (error) {
      dispatchSpan?.finish({
        outcome: "unknown",
        queueDepth: this.queuedInputs.size,
        metadata: { errorCode: safeDeferredError(error, "ERR_PROVIDER_STEER_UNCONFIRMED").code },
      });
      const detail = safeDeferredError(error, "ERR_PROVIDER_STEER_UNCONFIRMED");
      item.lastErrorCode = detail.code;
      item.lastError = detail.message;
      item.waitReason = "provider-steer-unconfirmed";
      item.providerReconciliationStartedAt = item.dispatchingAt;
      item.providerReconciliationChecks = 0;
      this.onStateChange(item, "reconciling", detail);
      await this.persist();
      this.schedule(item, this.retryDelayMs);
    }
  }

  async requireSteerDecision(item) {
    const detail = safeDeferredError({ code: "ERR_PROVIDER_STEER_NOT_DELIVERED" });
    const previous = Object.getOwnPropertyDescriptors(item);
    delete item.dispatchingAt;
    delete item.waitReason;
    delete item.blockedChecks;
    delete item.recheckRequested;
    delete item.providerReconciliationStartedAt;
    delete item.providerReconciliationChecks;
    item.lastErrorCode = detail.code;
    item.lastError = detail.message;
    item.laneReleased = true;
    this.queuedInputs.delete(item.id);
    this.pendingInputs.set(item.id, item);
    this.onStateChange(item, "pending", detail);
    try {
      await this.persist();
    } catch (error) {
      this.pendingInputs.delete(item.id);
      for (const key of Reflect.ownKeys(item)) delete item[key];
      Object.defineProperties(item, previous);
      this.queuedInputs.set(item.id, item);
      this.onStateChange(item, "queued", safeDeferredError(error));
      throw error;
    }
    await this.updateMessage(
      item,
      `⚠️ ${item.lastError}\n\nСообщение сохранено. Выберите дальнейшее действие:`,
      this.pendingKeyboard(item),
    );
    await this.notifyReturned(item);
    this.wakeLane(item);
  }

  async finishSteer(item, steered) {
    this.queuedInputs.delete(item.id);
    delete item.dispatchingAt;
    delete item.lastError;
    delete item.lastErrorCode;
    delete item.lastAttemptAt;
    delete item.waitReason;
    delete item.blockedChecks;
    delete item.providerReconciliationStartedAt;
    delete item.providerReconciliationChecks;
    this.onStateChange(item, "steered", steered);
    await this.persist();
    await this.updateMessage(item, `▶️ Уточнение добавлено в текущий ход потока «${item.taskTitle}».`);
    this.scheduleNextForTask(item);
  }

  async releaseResolvedTaskConflict(item) {
    if (!item || !autoReleasablePendingConflict(item) || !this.pendingInputs.has(item.id)) {
      return false;
    }
    if (await this.isBlocked(item)) return false;
    if (!this.pendingInputs.has(item.id)) return false;
    const previous = Object.getOwnPropertyDescriptors(item);
    this.pendingInputs.delete(item.id);
    item.conflictKind = null;
    item.allowForce = false;
    delete item.lastError;
    delete item.lastErrorCode;
    delete item.waitReason;
    delete item.paused;
    delete item.recheckRequested;
    delete item.laneReleased;
    delete item.processRecoveryChecks;
    this.queuedInputs.set(item.id, item);
    this.onStateChange(item, "queued");
    try {
      await this.persist();
    } catch (error) {
      this.queuedInputs.delete(item.id);
      for (const key of Reflect.ownKeys(item)) delete item[key];
      Object.defineProperties(item, previous);
      this.pendingInputs.set(item.id, item);
      this.onStateChange(item, "pending", safeDeferredError(error));
      throw error;
    }
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
    if (options.waitReason) item.waitReason = options.waitReason;
    if (options.attempted) {
      item.lastAttemptAt = new Date(this.now()).toISOString();
      item.attempts = Number(item.attempts ?? 0) + 1;
      delete item.lastError;
      delete item.lastErrorCode;
    }
    try {
      await this.persist();
    } catch (error) {
      for (const key of Reflect.ownKeys(item)) delete item[key];
      Object.defineProperties(item, previous);
      this.schedule(item, this.retryDelay(Number(item.blockedChecks ?? 0) + 1));
      throw error;
    }
    item.blockedChecks = Number(item.blockedChecks ?? 0) + 1;
    this.onStateChange(item, "paused", options.error ? safeDeferredError(options.error) : null);
    this.schedule(item, this.retryDelay(item.blockedChecks));
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
    delete item.blockedChecks;
    try {
      await this.persist();
    } catch (error) {
      for (const key of Reflect.ownKeys(item)) delete item[key];
      Object.defineProperties(item, previous);
      this.schedule(item, this.retryDelay(Number(item.blockedChecks ?? 0) + 1));
      throw error;
    }
    this.onStateChange(item, "queued");
    return false;
  }

  taskKey(item) {
    return this.laneKey(item);
  }

  oldestForTask(item, { includePending = false, runnableOnly = false } = {}) {
    const key = this.taskKey(item);
    let oldest = null;
    let oldestAt = Number.POSITIVE_INFINITY;
    const candidates = includePending
      ? [...this.pendingInputs.values(), ...this.queuedInputs.values()]
      : this.queuedInputs.values();
    for (const candidate of candidates) {
      if (this.pendingInputs.has(candidate.id) && candidate.laneReleased === true) continue;
      if (this.taskKey(candidate) !== key) continue;
      if (runnableOnly && this.queuedInputs.has(candidate.id) && intentionallyPaused(candidate)) continue;
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
    const next = this.oldestForTask(item, { runnableOnly: true });
    if (next) this.schedule(next, 0);
  }

  wakeLane(target) {
    const key = this.taskKey(target);
    const queued = [...this.queuedInputs.values()]
      .filter((candidate) => this.taskKey(candidate) === key);
    const releasablePending = [...this.pendingInputs.values()]
      .filter((candidate) => (
        this.taskKey(candidate) === key && autoReleasablePendingConflict(candidate)
      ));
    if (!queued.length && !releasablePending.length) return false;
    for (const candidate of queued) this.cancelSchedule(candidate.id);
    for (const candidate of releasablePending) this.cancelSchedule(candidate.id);
    let scheduled = false;
    for (const candidate of queued.filter((item) => item.conflictKind === "message-steer")) {
      if (this.processing.has(candidate.id)) candidate.recheckRequested = true;
      else this.schedule(candidate, 0);
      scheduled = true;
    }
    const oldest = this.oldestForTask(target, { includePending: true, runnableOnly: true });
    const trigger = this.pendingInputs.has(oldest?.id)
      ? autoReleasablePendingConflict(oldest)
        ? oldest
        : this.oldestForTask(target, { runnableOnly: true })
      : oldest;
    if (!trigger) return scheduled;
    if (this.processing.has(trigger.id)) trigger.recheckRequested = true;
    else this.schedule(trigger, 0);
    return true;
  }

  wakeAll() {
    this.maintainCommandExpiry();
    const lanes = new Map();
    for (const item of [
      ...this.queuedInputs.values(),
      ...[...this.pendingInputs.values()].filter(autoReleasablePendingConflict),
    ]) {
      const key = this.taskKey(item);
      if (!lanes.has(key)) lanes.set(key, item);
    }
    let woken = 0;
    for (const target of lanes.values()) {
      if (this.wakeLane(target)) woken += 1;
    }
    return woken;
  }

  stop() {
    if (this.expiryTimer != null) this.clearTimeoutImpl(this.expiryTimer);
    this.expiryTimer = null;
    for (const timer of this.timers.values()) this.clearTimeoutImpl(timer);
    this.timers.clear();
  }

  removeExpiredCommand(record) {
    for (const collection of [this.pendingInputs, this.queuedInputs]) {
      for (const item of collection.values()) {
        if (item.clientUserMessageId !== record.clientUserMessageId) continue;
        collection.delete(item.id);
        this.cancelSchedule(item.id);
      }
    }
    if (record.item) {
      try { this.onStateChange(record.item, "expired", record.result); }
      catch (error) { this.reportExpiryError(error); }
    }
  }

  reportExpiryError(error) {
    // Diagnostics cannot prevent cleanup or stop unrelated runtime services.
    try { this.onExpiryError(error); } catch { /* best-effort diagnostic */ }
  }

  maintainCommandExpiry() {
    try { this.expireCommands?.(); }
    catch (error) { this.reportExpiryError(error); }
  }

  startExpiryMaintenance() {
    if (!this.expireCommands || this.expiryTimer != null) return;
    const tick = () => {
      this.expiryTimer = null;
      try { this.maintainCommandExpiry(); }
      finally {
        this.expiryTimer = this.setTimeoutImpl(tick, 60_000);
        this.expiryTimer?.unref?.();
      }
    };
    tick();
  }
}
