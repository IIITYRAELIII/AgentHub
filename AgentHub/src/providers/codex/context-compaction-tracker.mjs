import { randomUUID } from "node:crypto";
import { AsyncSqliteMutationQueue } from "../../infrastructure/persistence/async-sqlite-mutation-queue.mjs";

import {
  MAINTENANCE_OPERATION_KINDS,
  MAINTENANCE_OPERATION_STATUSES,
} from "../../domain/maintenance-operation.mjs";

const DEFAULT_TIMEOUT_MS = 2 * 60 * 1_000;
const DEFAULT_PROVIDER_TURN_TIMEOUT_MS = 10 * 60 * 1_000;
const DEFAULT_MAX_ENTRIES = 100;

function normalizedThreadId(value) {
  return String(value ?? "").trim();
}

function normalizedTimestamp(value, fallback) {
  if (value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value))) {
    return new Date(Number(value)).toISOString();
  }
  const parsed = Date.parse(String(value ?? ""));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : fallback;
}

function boundedPercent(value) {
  if (value === null || value === undefined || value === "") return null;
  const percent = Number(value);
  return Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : null;
}

function persistedCompaction(record) {
  if (!record || typeof record !== "object") return null;
  const operationId = normalizedThreadId(record.operationId ?? record.id);
  if (!operationId) return null;
  const legacyStatus = String(record.status) === "timeout" ? "unknown" : String(record.status);
  const status = ["running", "completed", "failed", "unknown"].includes(legacyStatus)
    ? legacyStatus
    : "completed";
  const value = {
    operationId,
    // Migration guard: keep `id` until one production release has rewritten all
    // runtime snapshots with operationId; maintenance_operations is authoritative.
    id: operationId,
    streamId: normalizedThreadId(record.streamId) || null,
    revision: Number.isSafeInteger(record.revision) ? record.revision : 1,
    origin: record.origin === "manual" ? "manual" : "automatic",
    status,
    stage: normalizedThreadId(record.stage) || status,
    turnId: normalizedThreadId(record.turnId) || null,
    itemId: normalizedThreadId(record.itemId) || null,
    captureRawItem: record.captureRawItem === true,
    ...(record.dedicatedProviderTurn === true ? { dedicatedProviderTurn: true } : {}),
    startedAt: normalizedThreadId(record.startedAt) || null,
    compactedAt: normalizedThreadId(record.compactedAt) || null,
    completedAt: normalizedThreadId(record.completedAt) || null,
  };
  for (const name of ["beforePercent", "afterPercent"]) {
    const percent = boundedPercent(record[name]);
    if (percent !== null) value[name] = percent;
  }
  if (["running", "completed", "failed"].includes(String(record.measurementStatus))) {
    value.measurementStatus = String(record.measurementStatus);
  }
  if (record.measurementKind === "estimated") value.measurementKind = "estimated";
  if (record.rotated !== undefined) value.rotated = record.rotated === true;
  const rotationThreadId = normalizedThreadId(record.rotationThreadId);
  const rotationCompletedAt = normalizedTimestamp(record.rotationCompletedAt, null);
  if (rotationThreadId) value.rotationThreadId = rotationThreadId;
  if (rotationCompletedAt) value.rotationCompletedAt = rotationCompletedAt;
  if (["failed", "unknown"].includes(String(record.rotationStatus))) {
    value.rotationStatus = String(record.rotationStatus);
    if (record.rotationMessage) value.rotationMessage = String(record.rotationMessage);
  }
  return value;
}

export function isContextCompactionItem(item) {
  return ["contextCompaction", "context_compaction"].includes(String(item?.type ?? ""));
}

export function isRawCompactionItem(item) {
  return ["compaction", "context_compaction"].includes(String(item?.type ?? ""));
}

export class ContextCompactionTracker {
  constructor({
    clock = () => Date.now(),
    idFactory = randomUUID,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    providerTurnTimeoutMs = DEFAULT_PROVIDER_TURN_TIMEOUT_MS,
    cleanupTimeoutMs = timeoutMs,
    maxEntries = DEFAULT_MAX_ENTRIES,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    onSettled = () => {},
    onChanged = () => {},
    operationStore = null,
    streamIdForThread = () => null,
  } = {}) {
    this.clock = clock;
    this.idFactory = idFactory;
    this.timeoutMs = timeoutMs;
    this.providerTurnTimeoutMs = providerTurnTimeoutMs;
    this.cleanupTimeoutMs = cleanupTimeoutMs;
    this.maxEntries = maxEntries;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.onSettled = onSettled;
    this.onChanged = onChanged;
    this.operationStore = operationStore;
    this.streamIdForThread = streamIdForThread;
    this.entries = new Map();
    this.timers = new Map();
    this.waiters = new Map();
    this.rawItemWaiters = new Map();
    this.mutations = new Map();
  }

  async mutate(threadId, operation) {
    const key = normalizedThreadId(threadId);
    let queue = this.mutations.get(key);
    if (!queue) {
      queue = new AsyncSqliteMutationQueue();
      this.mutations.set(key, queue);
    }
    try {
      return await queue.run(operation, { requestId: this.get(key)?.operationId ?? key });
    } finally {
      if (!queue.diagnostics().queued && this.mutations.get(key) === queue) this.mutations.delete(key);
    }
  }

  get(threadId) {
    return this.entries.get(normalizedThreadId(threadId)) ?? null;
  }

  isRunning(threadId) {
    return this.get(threadId)?.status === "running";
  }

  annotate(threadId, expectedId, details = {}) {
    const key = normalizedThreadId(threadId);
    const existing = this.entries.get(key);
    if (!existing || (expectedId && existing.id !== expectedId)) return null;
    const record = { ...existing };
    for (const name of ["beforePercent", "afterPercent"]) {
      const value = boundedPercent(details[name]);
      if (value !== null) record[name] = value;
    }
    const measurementStatus = String(details.measurementStatus ?? "").trim();
    if (["running", "completed", "failed"].includes(measurementStatus)) {
      const currentMeasurementStatus = String(record.measurementStatus ?? "").trim();
      if (
        currentMeasurementStatus !== "completed"
        && !(currentMeasurementStatus === "failed" && measurementStatus === "running")
      ) {
        record.measurementStatus = measurementStatus;
      }
    }
    if (details.measurementKind === "estimated") record.measurementKind = "estimated";
    if (details.rotated !== undefined) record.rotated = details.rotated === true;
    const rotationThreadId = normalizedThreadId(details.rotationThreadId);
    const rotationCompletedAt = normalizedTimestamp(details.rotationCompletedAt, null);
    if (rotationThreadId) record.rotationThreadId = rotationThreadId;
    if (rotationCompletedAt) record.rotationCompletedAt = rotationCompletedAt;
    const rotationStatus = String(details.rotationStatus ?? "").trim();
    if (["failed", "unknown"].includes(rotationStatus)) {
      record.rotationStatus = rotationStatus;
      if (details.rotationMessage) record.rotationMessage = String(details.rotationMessage);
    }
    this.store(key, record);
    return record;
  }

  isManualTurn(threadId, turnId) {
    const record = this.get(threadId);
    return record?.origin === "manual"
      && Boolean(String(turnId ?? "").trim())
      && String(record.turnId ?? "").trim() === String(turnId).trim();
  }

  runningCount() {
    return [...this.entries.values()].filter((entry) => entry.status === "running").length;
  }

  snapshot() {
    return [...this.entries.entries()].flatMap(([threadId, record]) => {
      const persisted = persistedCompaction(record);
      return persisted ? [[threadId, persisted]] : [];
    }).slice(-this.maxEntries);
  }

  restore(snapshot = []) {
    for (const timer of this.timers.values()) this.clearTimer(timer);
    this.timers.clear();
    this.entries.clear();
    const restoredAt = new Date(this.clock()).toISOString();
    for (const entry of (Array.isArray(snapshot) ? snapshot : []).slice(-this.maxEntries)) {
      if (!Array.isArray(entry)) continue;
      const threadId = normalizedThreadId(entry[0]);
      const persisted = persistedCompaction(entry[1]);
      if (!threadId || !persisted) continue;
      let record = persisted;
      if (this.operationStore) {
        record = this.#persistOperation(threadId, record, {
          status: record.status === "completed"
            ? MAINTENANCE_OPERATION_STATUSES.SUCCEEDED
            : record.status === "failed"
              ? MAINTENANCE_OPERATION_STATUSES.FAILED
              : record.status === "unknown"
                ? MAINTENANCE_OPERATION_STATUSES.RECONCILING
                : MAINTENANCE_OPERATION_STATUSES.RUNNING,
          phase: record.stage || "compacting",
          outcome: record.status === "unknown" ? "unknown" : null,
          blockers: record.status === "unknown" ? ["authoritative-state-unknown"] : [],
        });
        if (persisted.status === "running") {
          this.operationStore.recoverInterrupted({ operationIds: [record.operationId] });
          record = this.#recordFromOperation(record, this.operationStore.get(record.operationId));
        }
      } else if (persisted.status === "running") {
        record = {
          ...persisted,
          status: "unknown",
          stage: "reconciling",
          completedAt: restoredAt,
        };
      }
      this.entries.set(threadId, record);
    }
  }

  observeContext(context) {
    const threadId = normalizedThreadId(context?.threadId);
    const turnId = normalizedThreadId(context?.turnId);
    const record = this.get(threadId);
    // Codex emits its estimate with zero billable usage at the compaction boundary.
    // Keep that first estimate: a later model request includes additional context.
    if (!record || context?.provisional !== true || record.measurementKind === "estimated") return null;
    const usedTokens = Number(context?.usedTokens);
    const modelContextWindow = Number(context?.modelContextWindow);
    if (context.usedTokens === null || context.usedTokens === undefined
      || !Number.isFinite(usedTokens) || usedTokens < 0
      || !Number.isFinite(modelContextWindow) || !(modelContextWindow > 0)) return null;
    const compactedAt = Date.parse(String(record.compactedAt ?? record.completedAt ?? ""));
    const contextUpdatedAt = Date.parse(String(context?.updatedAt ?? ""));
    if (!["running", "completed"].includes(record.status)
      || !turnId || turnId !== normalizedThreadId(record.turnId)
      || !Number.isFinite(compactedAt) || !Number.isFinite(contextUpdatedAt)
      || contextUpdatedAt < compactedAt) return null;
    return this.annotate(threadId, record.id, {
      afterPercent: Math.round((usedTokens / modelContextWindow) * 100_000_000) / 1_000_000,
      measurementStatus: "completed",
      measurementKind: "estimated",
    });
  }

  waitForSettlement(threadId, expectedId = null) {
    const key = normalizedThreadId(threadId);
    if (!key) return Promise.resolve(null);
    const current = this.entries.get(key) ?? null;
    if (!current || (expectedId && current.id !== expectedId)) return Promise.resolve(null);
    if (current.status !== "running") return Promise.resolve(current);
    return new Promise((resolve) => {
      const waiters = this.waiters.get(key) ?? [];
      waiters.push({ expectedId, resolve });
      this.waiters.set(key, waiters);
    });
  }

  waitForRawItem(threadId, expectedId = null, timeoutMs = this.timeoutMs) {
    const key = normalizedThreadId(threadId);
    if (!key) return Promise.resolve(null);
    const current = this.entries.get(key) ?? null;
    if (!current || (expectedId && current.id !== expectedId)) return Promise.resolve(null);
    if (current.rawItem) return Promise.resolve(current.rawItem);
    return new Promise((resolve) => {
      const waiters = this.rawItemWaiters.get(key) ?? [];
      const waiter = { expectedId, resolve, timer: null };
      waiter.timer = this.setTimer(() => {
        const currentWaiters = this.rawItemWaiters.get(key) ?? [];
        const remaining = currentWaiters.filter((candidate) => candidate !== waiter);
        if (remaining.length) this.rawItemWaiters.set(key, remaining);
        else this.rawItemWaiters.delete(key);
        resolve(null);
      }, Math.max(1, Number(timeoutMs) || this.timeoutMs));
      waiter.timer?.unref?.();
      waiters.push(waiter);
      this.rawItemWaiters.set(key, waiters);
    });
  }

  rememberRawItem(threadId, { turnId = null, item = null } = {}) {
    const key = normalizedThreadId(threadId);
    if (!key || !isRawCompactionItem(item)) return null;
    const existing = this.entries.get(key) ?? null;
    if (!existing?.captureRawItem) return null;
    const record = {
      ...existing,
      turnId: String(turnId ?? existing?.turnId ?? "").trim() || null,
      rawItem: item,
    };
    this.store(key, record);
    this.notifyRawItem(key, record);
    return record;
  }

  clearRawItem(threadId, expectedId = null) {
    const key = normalizedThreadId(threadId);
    const existing = this.entries.get(key);
    if (!existing || (expectedId && existing.id !== expectedId)) return false;
    const {
      rawItem: _rawItem,
      captureRawItem: _captureRawItem,
      ...record
    } = existing;
    this.store(key, record);
    return true;
  }

  begin(threadId, {
    origin = "automatic",
    streamId = null,
    turnId = null,
    itemId = null,
    startedAt = null,
    captureRawItem = false,
    dedicatedProviderTurn = false,
    beforePercent = null,
  } = {}) {
    const key = normalizedThreadId(threadId);
    if (!key) return null;
    const now = new Date(this.clock()).toISOString();
    const existing = this.entries.get(key);
    const initialBeforePercent = boundedPercent(beforePercent);
    const sameObservedOperation = existing && normalizedThreadId(turnId)
      && normalizedThreadId(existing.turnId) === normalizedThreadId(turnId)
      && (!itemId || !existing.itemId || existing.itemId === itemId);
    if (sameObservedOperation && ["completed", "unknown"].includes(existing.status)) return existing;
    const existingBeforePercent = boundedPercent(existing?.beforePercent);
    const record = existing?.status === "running"
      ? {
        ...existing,
        turnId: String(turnId ?? existing.turnId ?? "").trim() || null,
        itemId: String(itemId ?? existing.itemId ?? "").trim() || null,
        captureRawItem: Boolean(existing.captureRawItem || captureRawItem),
        ...(existingBeforePercent === null && initialBeforePercent !== null
          ? { beforePercent: initialBeforePercent }
          : {}),
      }
      : {
        operationId: String(itemId ?? "").trim() || this.idFactory(),
        id: String(itemId ?? "").trim() || null,
        streamId: normalizedThreadId(streamId) || normalizedThreadId(this.streamIdForThread(key)) || null,
        origin: origin === "manual" ? "manual" : "automatic",
        status: "running",
        stage: "compacting",
        turnId: String(turnId ?? "").trim() || null,
        itemId: String(itemId ?? "").trim() || null,
        captureRawItem: Boolean(captureRawItem),
        ...(dedicatedProviderTurn ? { dedicatedProviderTurn: true } : {}),
        ...(initialBeforePercent !== null
          ? { beforePercent: initialBeforePercent }
          : {}),
        startedAt: normalizedTimestamp(startedAt, now),
        completedAt: null,
      };
    record.operationId = normalizedThreadId(record.operationId ?? record.id) || this.idFactory();
    record.id = record.operationId;
    record.streamId ||= normalizedThreadId(streamId) || normalizedThreadId(this.streamIdForThread(key)) || null;
    const persistedRecord = this.#persistOperation(key, record, {
      status: MAINTENANCE_OPERATION_STATUSES.RUNNING,
      phase: "compacting",
      providerTurnId: record.turnId,
      blockers: [],
    });
    this.store(key, persistedRecord);
    this.scheduleTimeout(
      key,
      persistedRecord.operationId,
      persistedRecord.turnId ? this.providerTurnTimeoutMs : this.timeoutMs,
    );
    return persistedRecord;
  }

  settleProviderTurn(threadId, { turnId = null, status = null } = {}) {
    const key = normalizedThreadId(threadId);
    const expectedTurnId = normalizedThreadId(turnId);
    const existing = this.entries.get(key);
    if (
      !existing
      || existing.status !== "running"
      || existing.stage !== "compacting"
      || !expectedTurnId
      || normalizedThreadId(existing.turnId) !== expectedTurnId
    ) return false;
    const providerStatus = String(status ?? "").trim().toLowerCase();
    if (!providerStatus || ["inprogress", "in_progress", "running"].includes(providerStatus)) return false;
    if (["failed", "interrupted", "cancelled", "canceled"].includes(providerStatus)) {
      return this.fail(key, existing.id);
    }
    return this.markUnknown(key, existing.id);
  }

  markUnknown(threadId, expectedId) {
    const key = normalizedThreadId(threadId);
    const current = this.entries.get(key);
    if (!current || current.operationId !== expectedId || current.status !== "running") return false;
    const record = this.#persistOperation(key, {
      ...current, status: "unknown", stage: "reconciling",
      completedAt: new Date(this.clock()).toISOString(),
    }, {
      status: MAINTENANCE_OPERATION_STATUSES.RECONCILING,
      phase: "reconciling", providerTurnId: current.turnId,
      outcome: "unknown", blockers: ["authoritative-state-unknown"],
    });
    this.cancelTimeout(key);
    this.store(key, record);
    this.notifySettled(key, record);
    return true;
  }

  beginCleanup(threadId, {
    turnId = null,
    itemId = null,
    compactedAt = null,
  } = {}) {
    const key = normalizedThreadId(threadId);
    if (!key) return null;
    const now = new Date(this.clock()).toISOString();
    const existing = this.entries.get(key) ?? this.begin(key, {
      origin: "automatic",
      turnId,
      itemId,
    });
    if (turnId && existing?.turnId && turnId !== existing.turnId) return null;
    if (itemId && existing?.itemId && itemId !== existing.itemId) return null;
    const record = {
      ...existing,
      status: "running",
      stage: "cleaning-images",
      turnId: String(turnId ?? existing?.turnId ?? "").trim() || null,
      itemId: String(itemId ?? existing?.itemId ?? "").trim() || null,
      compactedAt: normalizedTimestamp(compactedAt, now),
      completedAt: null,
    };
    const persistedRecord = this.#persistOperation(key, record, {
      status: MAINTENANCE_OPERATION_STATUSES.RUNNING,
      phase: "cleaning-images",
      providerTurnId: record.turnId,
      blockers: [],
    });
    this.store(key, persistedRecord);
    this.scheduleTimeout(key, persistedRecord.operationId, this.cleanupTimeoutMs);
    return persistedRecord;
  }

  complete(threadId, {
    operationId = null,
    turnId = null,
    itemId = null,
    completedAt = null,
  } = {}) {
    const key = normalizedThreadId(threadId);
    if (!key) return null;
    const now = new Date(this.clock()).toISOString();
    const existing = this.entries.get(key);
    if (operationId && existing?.operationId !== operationId) return null;
    if (turnId && existing?.turnId && turnId !== existing.turnId) return null;
    if (itemId && existing?.itemId && itemId !== existing.itemId) return null;
    const record = {
      ...(existing ?? {
        operationId: String(itemId ?? "").trim() || this.idFactory(),
        id: String(itemId ?? "").trim() || null,
        streamId: normalizedThreadId(this.streamIdForThread(key)) || null,
        origin: "automatic",
        startedAt: now,
      }),
      status: "completed",
      stage: "completed",
      turnId: String(turnId ?? existing?.turnId ?? "").trim() || null,
      itemId: String(itemId ?? existing?.itemId ?? "").trim() || null,
      completedAt: normalizedTimestamp(completedAt, now),
    };
    record.operationId = normalizedThreadId(record.operationId ?? record.id) || this.idFactory();
    record.id = record.operationId;
    const persistedRecord = this.#persistOperation(key, record, {
      status: MAINTENANCE_OPERATION_STATUSES.SUCCEEDED,
      phase: "completed",
      providerTurnId: record.turnId,
      outcome: "succeeded",
      blockers: [],
    });
    this.cancelTimeout(key);
    this.store(key, persistedRecord);
    this.notifySettled(key, persistedRecord);
    return persistedRecord;
  }

  fail(threadId, expectedId = null) {
    const key = normalizedThreadId(threadId);
    const existing = this.entries.get(key);
    if (!existing || (expectedId && existing.id !== expectedId)) return false;
    const record = {
      ...existing,
      status: "failed",
      stage: "failed",
      completedAt: new Date(this.clock()).toISOString(),
    };
    const persistedRecord = this.#persistOperation(key, record, {
      status: MAINTENANCE_OPERATION_STATUSES.FAILED,
      phase: "failed",
      providerTurnId: record.turnId,
      outcome: "failed",
      blockers: [],
    });
    this.cancelTimeout(key);
    this.store(key, persistedRecord);
    this.notifySettled(key, persistedRecord);
    return true;
  }

  dispose() {
    for (const timer of this.timers.values()) this.clearTimer(timer);
    this.timers.clear();
    for (const waiters of this.waiters.values()) {
      for (const waiter of waiters) waiter.resolve(null);
    }
    this.waiters.clear();
    for (const waiters of this.rawItemWaiters.values()) {
      for (const waiter of waiters) {
        if (waiter.timer !== null) this.clearTimer(waiter.timer);
        waiter.resolve(null);
      }
    }
    this.rawItemWaiters.clear();
  }

  store(key, value) {
    if (this.entries.has(key)) this.entries.delete(key);
    this.entries.set(key, value);
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      this.cancelTimeout(oldest);
      this.entries.delete(oldest);
    }
    try {
      this.onChanged({ threadId: key, record: value });
    } catch {
      // Runtime persistence must not break context maintenance.
    }
  }

  #recordFromOperation(record, operation) {
    if (!operation) return record;
    const status = operation.status === MAINTENANCE_OPERATION_STATUSES.SUCCEEDED
      ? "completed"
      : operation.status === MAINTENANCE_OPERATION_STATUSES.FAILED
        ? "failed"
        : operation.status === MAINTENANCE_OPERATION_STATUSES.RECONCILING
          ? "unknown"
          : "running";
    return {
      ...record,
      operationId: operation.operationId,
      id: operation.operationId,
      streamId: operation.streamId,
      turnId: operation.providerTurnId ?? record.turnId ?? null,
      revision: operation.revision,
      status,
      stage: status === "unknown" ? "reconciling" : operation.phase,
      completedAt: operation.completedAt ?? (status === "unknown" ? operation.updatedAt : record.completedAt),
    };
  }

  #persistOperation(threadId, record, patch) {
    if (!this.operationStore) return record;
    const streamId = normalizedThreadId(record.streamId) || normalizedThreadId(this.streamIdForThread(threadId));
    if (!streamId) throw new Error(`Context compaction requires an exact Stream: ${threadId}`);
    const operationId = normalizedThreadId(record.operationId ?? record.id) || this.idFactory();
    let operation = this.operationStore.get(operationId);
    if (!operation) {
      operation = this.operationStore.create({
        operationId,
        kind: MAINTENANCE_OPERATION_KINDS.CONTEXT_COMPACTION,
        streamId,
        threadId,
        providerTurnId: patch.providerTurnId ?? record.turnId,
        status: patch.status,
        phase: patch.phase,
        blockers: patch.blockers,
        outcome: patch.outcome,
        metadata: { origin: record.origin, itemId: record.itemId, dedicatedProviderTurn: record.dedicatedProviderTurn === true },
        createdAt: record.startedAt,
      });
    } else if (![MAINTENANCE_OPERATION_STATUSES.SUCCEEDED, MAINTENANCE_OPERATION_STATUSES.FAILED]
      .includes(operation.status)) {
      operation = this.operationStore.transition(operationId, {
        ...patch,
        metadata: { origin: record.origin, itemId: record.itemId, dedicatedProviderTurn: record.dedicatedProviderTurn === true },
      }, { expectedRevision: operation.revision }).operation;
    }
    return this.#recordFromOperation({ ...record, operationId, id: operationId, streamId }, operation);
  }

  scheduleTimeout(key, expectedId, timeoutMs = this.timeoutMs) {
    this.cancelTimeout(key);
    const timer = this.setTimer(() => {
      this.timers.delete(key);
      const current = this.entries.get(key);
      if (!current || current.operationId !== expectedId || current.status !== "running") return;
      try {
        this.markUnknown(key, expectedId);
      } catch {
        void this.mutate(key, () => this.markUnknown(key, expectedId)).catch((error) => {
          console.warn(`Cannot persist compaction timeout ${expectedId}: ${error.message}`);
          if (this.get(key)?.operationId === expectedId && this.isRunning(key)) {
            this.scheduleTimeout(key, expectedId, this.timeoutMs);
          }
        });
      }
    }, timeoutMs);
    timer?.unref?.();
    this.timers.set(key, timer);
  }

  cancelTimeout(key) {
    const timer = this.timers.get(key);
    if (timer !== undefined) this.clearTimer(timer);
    this.timers.delete(key);
  }

  notifySettled(threadId, record) {
    const waiters = this.waiters.get(threadId) ?? [];
    if (waiters.length) {
      const remaining = [];
      for (const waiter of waiters) {
        if (!waiter.expectedId || !record || waiter.expectedId === record.id) waiter.resolve(record);
        else remaining.push(waiter);
      }
      if (remaining.length) this.waiters.set(threadId, remaining);
      else this.waiters.delete(threadId);
    }
    try {
      this.onSettled({ threadId, record });
    } catch {
      // Compaction tracking must not fail because an optional observer did.
    }
  }

  notifyRawItem(threadId, record) {
    const waiters = this.rawItemWaiters.get(threadId) ?? [];
    if (!waiters.length || !record?.rawItem) return;
    const remaining = [];
    for (const waiter of waiters) {
      if (!waiter.expectedId || waiter.expectedId === record.id) {
        if (waiter.timer !== null) this.clearTimer(waiter.timer);
        waiter.resolve(record.rawItem);
      } else remaining.push(waiter);
    }
    if (remaining.length) this.rawItemWaiters.set(threadId, remaining);
    else this.rawItemWaiters.delete(threadId);
  }
}
