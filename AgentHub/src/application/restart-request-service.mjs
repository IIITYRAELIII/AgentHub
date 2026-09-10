import { mutateRestartOperation, restartOperationId, retainedRestartRequest } from "./restart-operation-mutations.mjs";
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
    logger = console,
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
      logger,
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

  #acquire(target, notification) {
    const legacy = retainedRestartRequest(this.operationStore, this.getRequest());
    const operationId = restartOperationId(this.operationStore);
    const createdAt = this.nowIso();
    return mutateRestartOperation(this.operationStore, () => {
      const existing = (legacy?.operationId ? this.operationStore.get(legacy.operationId) : null)
        ?? (legacy ? this.operationStore.migrateLegacyRestart(legacy, target) : null)
        ?? this.operationStore.activeFor({ kind: MAINTENANCE_OPERATION_KINDS.RESTART, ...target });
      if (existing) return { operation: existing, created: false };
      const blockingCount = notification.blockingCount;
      const operation = this.operationStore.create({
        operationId,
        kind: MAINTENANCE_OPERATION_KINDS.RESTART,
        ...target,
        status: blockingCount > 0
          ? MAINTENANCE_OPERATION_STATUSES.BLOCKED : MAINTENANCE_OPERATION_STATUSES.REQUESTED,
        phase: blockingCount > 0 ? "waiting-for-work" : "requested",
        blockers: blockingCount > 0 ? ["active-work"] : [],
        metadata: notification,
        createdAt,
      });
      return { operation, created: true };
    }, operationId);
  }

  #transition(operationId, patch) {
    return mutateRestartOperation(this.operationStore, () => {
      const current = this.operationStore.get(operationId);
      if (!current || maintenanceOperationIsTerminal(current)) return null;
      const resolvedPatch = typeof patch === "function" ? patch(current) : patch;
      if (!resolvedPatch) return null;
      return this.operationStore.transition(operationId, resolvedPatch, {
        expectedRevision: current.revision,
        updatedAt: this.nowIso(),
      }).operation;
    }, operationId);
  }

  #schedule(operation) {
    this.scheduleRestart(() => void this.performScheduled(operation.operationId));
  }

  async performScheduled(operationId = this.getRequest()?.operationId) {
    try {
      if (operationId !== this.getRequest()?.operationId || !this.canPerform(operationId)) {
        return { status: "reconciling" };
      }
      return await this.#perform(operationId);
    } catch (error) {
      // The durable operation remains authoritative when settlement itself fails.
      this.logger.error("Scheduled restart remains pending after a state-store failure:", operationId, error);
      return { status: "settlement-pending", operationId, error };
    }
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
      const operation = await this.#transition(operationId, {
        status: MAINTENANCE_OPERATION_STATUSES.RECONCILING,
        phase: "reconciling",
        blockers: ["authoritative-state-unknown"],
        outcome: "unknown",
        metadata: { failurePhase: result.phase ?? null },
      });
      if (operation) this.#project(operation);
      await this.saveState();
    } else if (["aborted", "recovered"].includes(String(result?.status ?? ""))
      && typeof result.restartStateSettled !== "boolean") {
      await this.fail(operationId, result?.error);
    }
    return result;
  }

  async setWaiting(waiting, blockingCount = this.blockingWorkCount()) {
    const request = this.getRequest();
    if (!request?.operationId) return false;
    const operation = await this.#transition(request.operationId, (current) => {
      if (current.status === MAINTENANCE_OPERATION_STATUSES.RECONCILING) return null;
      return {
        status: waiting
          ? current.status === MAINTENANCE_OPERATION_STATUSES.REQUESTED
            ? MAINTENANCE_OPERATION_STATUSES.BLOCKED
            : current.status
          : MAINTENANCE_OPERATION_STATUSES.RUNNING,
        phase: waiting ? "waiting-for-work" : "cutover",
        blockers: waiting ? ["active-work"] : [],
        metadata: { blockingCount: Math.max(0, Number(blockingCount) || 0) },
      };
    });
    if (!operation) return false;
    this.#project(operation);
    void Promise.resolve(this.saveState()).catch(() => {});
    return true;
  }

  complete(operationId = this.getRequest()?.operationId) {
    if (!operationId) return null;
    return mutateRestartOperation(this.operationStore, () => this.operationStore.settle(
      operationId, { succeeded: true, phase: "completed" },
    ), operationId);
  }

  async fail(operationId = this.getRequest()?.operationId, error = null) {
    if (!operationId) return null;
    const operation = await mutateRestartOperation(this.operationStore, () => this.operationStore.settle(operationId, {
      succeeded: false,
      phase: "failed",
      metadata: { error: String(error?.message ?? error ?? "").slice(0, 1_000) || null },
    }), operationId);
    this.setRequest(null);
    await this.saveState();
    return operation;
  }

  async fromDesktop() {
    const target = this.#target();
    const blockingCount = this.blockingWorkCount();
    const notification = this.#notification({
      messageId: null,
      minimumUpdateOffset: this.updateOffset(),
      notifyTelegram: false,
      blockingCount,
    });
    const acquired = await this.#acquire(target, notification);
    const operation = acquired.operation;
    const existing = acquired.created ? null : operation;
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
    const acquired = await this.#acquire(target, notification);
    let operation = acquired.operation;
    const existing = acquired.created ? null : operation;
    if (existing) {
      this.#project(existing);
      await this.sendTelegram(existing.blockers.includes("active-work")
        ? "Перезапуск уже ожидает завершения выполняющихся потоков."
        : "Бот уже перезапускается.");
      return { accepted: false, operationId: existing.operationId };
    }

    this.#project(operation, notification);
    await this.saveState();
    try {
      const message = await this.sendTelegram(blockingCount
        ? `🔄 Перезапущу бота после завершения выполняющихся потоков: ${blockingCount}.`
        : "🔄 Перезапускаю Agent Hub…");
      if (!message?.message_id) throw new Error("Telegram не вернул ID сообщения перезапуска");
      operation = await this.#transition(operation.operationId, {
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
