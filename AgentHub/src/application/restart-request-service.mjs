import {
  MAINTENANCE_OPERATION_KINDS,
  MAINTENANCE_OPERATION_STATUSES,
  maintenanceOperationIsTerminal,
  restartRequestProjection,
} from "../domain/maintenance-operation.mjs";

function normalizedTarget(value) {
  const streamId = String(value?.streamId ?? "").trim();
  const threadId = String(value?.threadId ?? "").trim();
  if (!streamId || !threadId) throw new Error("Restart requires an exact Stream and Thread");
  return { streamId, threadId };
}

export class RestartRequestService {
  constructor({
    operationStore,
    currentTarget,
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
    isStopping = () => false,
    scheduleRestart = (callback) => setTimeout(callback, 0).unref(),
    nowIso = () => new Date().toISOString(),
  }) {
    if (!operationStore) throw new TypeError("operationStore is required");
    if (typeof currentTarget !== "function") throw new TypeError("currentTarget is required");
    Object.assign(this, {
      operationStore,
      currentTarget,
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
      isStopping,
      scheduleRestart,
      nowIso,
    });
  }

  #target() {
    return normalizedTarget(this.currentTarget());
  }

  #notification({ messageId, minimumUpdateOffset, notifyTelegram, blockingCount }) {
    return {
      chatId: this.currentChatId(),
      messageId,
      minimumUpdateOffset,
      notifyTelegram: notifyTelegram === true,
      blockingCount: Math.max(0, Number(blockingCount) || 0),
    };
  }

  #project(operation, notification = operation?.metadata) {
    const request = restartRequestProjection(operation, notification);
    this.setRequest(request);
    return request;
  }

  #activeOperation(target = this.#target()) {
    const request = this.getRequest();
    let operation = request?.operationId
      ? this.operationStore.get(request.operationId)
      : null;
    if (!operation && request) operation = this.operationStore.migrateLegacyRestart(request, target);
    return operation ?? this.operationStore.activeFor({
      kind: MAINTENANCE_OPERATION_KINDS.RESTART,
      ...target,
    });
  }

  #transition(operationId, patch) {
    const current = this.operationStore.get(operationId);
    if (!current || maintenanceOperationIsTerminal(current)) return current;
    return this.operationStore.transition(operationId, patch, {
      expectedRevision: current.revision,
      updatedAt: this.nowIso(),
    }).operation;
  }

  #schedule(operation) {
    this.scheduleRestart(() => void this.#perform(operation.operationId));
  }

  canPerform(operationId = this.getRequest()?.operationId) {
    const operation = this.operationStore.get(operationId);
    return Boolean(operation)
      && !maintenanceOperationIsTerminal(operation)
      && operation.status !== MAINTENANCE_OPERATION_STATUSES.RECONCILING;
  }

  async #perform(operationId) {
    let result;
    try {
      result = await this.performRestart();
    } catch (error) {
      await this.fail(operationId, error);
      return { status: "aborted", error };
    }
    if (result?.status === "failed") {
      const operation = this.#transition(operationId, {
        status: MAINTENANCE_OPERATION_STATUSES.RECONCILING,
        phase: "reconciling",
        blockers: ["authoritative-state-unknown"],
        outcome: "unknown",
        metadata: { failurePhase: result.phase ?? null },
      });
      if (operation) this.#project(operation);
      await this.saveState();
    } else if (["aborted", "recovered"].includes(String(result?.status ?? ""))) {
      await this.fail(operationId, result?.error);
    }
    return result;
  }

  async setWaiting(waiting, blockingCount = this.blockingWorkCount()) {
    const request = this.getRequest();
    if (!request?.operationId) return false;
    const current = this.operationStore.get(request.operationId);
    if (!current || maintenanceOperationIsTerminal(current)
      || current.status === MAINTENANCE_OPERATION_STATUSES.RECONCILING) return false;
    const operation = this.#transition(request.operationId, {
      status: waiting
        ? current.status === MAINTENANCE_OPERATION_STATUSES.REQUESTED
          ? MAINTENANCE_OPERATION_STATUSES.BLOCKED
          : current.status
        : MAINTENANCE_OPERATION_STATUSES.RUNNING,
      phase: waiting ? "waiting-for-work" : "cutover",
      blockers: waiting ? ["active-work"] : [],
      metadata: { blockingCount: Math.max(0, Number(blockingCount) || 0) },
    });
    if (!operation) return false;
    this.#project(operation);
    void Promise.resolve(this.saveState()).catch(() => {});
    return true;
  }

  complete(operationId = this.getRequest()?.operationId) {
    if (!operationId) return null;
    return this.operationStore.settle(operationId, { succeeded: true, phase: "completed" });
  }

  async fail(operationId = this.getRequest()?.operationId, error = null) {
    if (!operationId) return null;
    const operation = this.operationStore.settle(operationId, {
      succeeded: false,
      phase: "failed",
      metadata: { error: String(error?.message ?? error ?? "").slice(0, 1_000) || null },
    });
    this.setRequest(null);
    await this.saveState();
    return operation;
  }

  async fromDesktop() {
    const target = this.#target();
    const existing = this.#activeOperation(target);
    if (existing) {
      const blockingCount = this.blockingWorkCount();
      const stopping = this.isStopping();
      this.#project(existing);
      const needsReconciliation = existing.status === MAINTENANCE_OPERATION_STATUSES.RECONCILING;
      if (!blockingCount && !stopping && !needsReconciliation) this.#schedule(existing);
      return {
        accepted: false,
        waiting: existing.blockers.includes("active-work"),
        operationId: existing.operationId,
        message: needsReconciliation
          ? "Исход перезапуска уточняется"
          : stopping
          ? "Перезапуск уже выполняется"
          : blockingCount > 0
            ? "Перезапуск уже ожидает завершения потоков"
            : "Перезапуск уже запрошен и запущен повторно",
      };
    }
    const blockingCount = this.blockingWorkCount();
    const notification = this.#notification({
      messageId: null,
      minimumUpdateOffset: this.updateOffset(),
      notifyTelegram: false,
      blockingCount,
    });
    const operation = this.operationStore.create({
      kind: MAINTENANCE_OPERATION_KINDS.RESTART,
      ...target,
      status: blockingCount > 0
        ? MAINTENANCE_OPERATION_STATUSES.BLOCKED
        : MAINTENANCE_OPERATION_STATUSES.REQUESTED,
      phase: blockingCount > 0 ? "waiting-for-work" : "requested",
      blockers: blockingCount > 0 ? ["active-work"] : [],
      metadata: notification,
      createdAt: this.nowIso(),
    });
    const request = this.#project(operation, notification);
    await this.saveState();
    void this.announceDesktop(request, blockingCount);
    if (!blockingCount) this.#schedule(operation);
    return {
      accepted: true,
      waiting: blockingCount > 0,
      operationId: operation.operationId,
      message: blockingCount > 0
        ? "Перезапуск ожидает завершения потоков"
        : "Agent Hub Server перезапускается",
    };
  }

  async fromTelegram() {
    const target = this.#target();
    const existing = this.#activeOperation(target);
    if (existing) {
      this.#project(existing);
      await this.sendTelegram(existing.blockers.includes("active-work")
        ? "Перезапуск уже ожидает завершения выполняющихся потоков."
        : "Бот уже перезапускается.");
      return { accepted: false, operationId: existing.operationId };
    }
    const blockingCount = this.blockingWorkCount();
    const processingUpdateId = this.processingUpdateId();
    const notification = this.#notification({
      messageId: null,
      minimumUpdateOffset: Number.isSafeInteger(processingUpdateId)
        ? processingUpdateId + 1
        : this.updateOffset(),
      notifyTelegram: true,
      blockingCount,
    });
    let operation = this.operationStore.create({
      kind: MAINTENANCE_OPERATION_KINDS.RESTART,
      ...target,
      status: blockingCount > 0
        ? MAINTENANCE_OPERATION_STATUSES.BLOCKED
        : MAINTENANCE_OPERATION_STATUSES.REQUESTED,
      phase: blockingCount > 0 ? "waiting-for-work" : "requested",
      blockers: blockingCount > 0 ? ["active-work"] : [],
      metadata: notification,
      createdAt: this.nowIso(),
    });
    this.#project(operation, notification);
    await this.saveState();
    try {
      const message = await this.sendTelegram(blockingCount
        ? `🔄 Перезапущу бота после завершения выполняющихся потоков: ${blockingCount}.`
        : "🔄 Перезапускаю Agent Hub…");
      if (!message?.message_id) throw new Error("Telegram не вернул ID сообщения перезапуска");
      operation = this.#transition(operation.operationId, {
        metadata: { messageId: message.message_id },
      });
      this.#project(operation);
      await this.saveState();
    } catch (error) {
      await this.fail(operation.operationId, error);
      throw error;
    }
    if (!blockingCount && processingUpdateId == null) await this.#perform(operation.operationId);
    return {
      accepted: true,
      waiting: blockingCount > 0,
      operationId: operation.operationId,
    };
  }
}
