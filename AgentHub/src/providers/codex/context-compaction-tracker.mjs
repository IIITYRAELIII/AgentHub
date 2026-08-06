import { randomUUID } from "node:crypto";

const DEFAULT_TIMEOUT_MS = 2 * 60 * 1_000;
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
    cleanupTimeoutMs = timeoutMs,
    maxEntries = DEFAULT_MAX_ENTRIES,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    onSettled = () => {},
  } = {}) {
    this.clock = clock;
    this.idFactory = idFactory;
    this.timeoutMs = timeoutMs;
    this.cleanupTimeoutMs = cleanupTimeoutMs;
    this.maxEntries = maxEntries;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.onSettled = onSettled;
    this.entries = new Map();
    this.timers = new Map();
    this.waiters = new Map();
    this.rawItemWaiters = new Map();
  }

  get(threadId) {
    return this.entries.get(normalizedThreadId(threadId)) ?? null;
  }

  isRunning(threadId) {
    return this.get(threadId)?.status === "running";
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
    turnId = null,
    itemId = null,
    startedAt = null,
    captureRawItem = false,
  } = {}) {
    const key = normalizedThreadId(threadId);
    if (!key) return null;
    const now = new Date(this.clock()).toISOString();
    const existing = this.entries.get(key);
    const record = existing?.status === "running"
      ? {
        ...existing,
        turnId: String(turnId ?? existing.turnId ?? "").trim() || null,
        itemId: String(itemId ?? existing.itemId ?? "").trim() || null,
        captureRawItem: Boolean(existing.captureRawItem || captureRawItem),
      }
      : {
        id: String(itemId ?? "").trim() || this.idFactory(),
        origin: origin === "manual" ? "manual" : "automatic",
        status: "running",
        stage: "compacting",
        turnId: String(turnId ?? "").trim() || null,
        itemId: String(itemId ?? "").trim() || null,
        captureRawItem: Boolean(captureRawItem),
        startedAt: normalizedTimestamp(startedAt, now),
        completedAt: null,
      };
    this.store(key, record);
    this.scheduleTimeout(key, record.id);
    return record;
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
    const record = {
      ...existing,
      status: "running",
      stage: "cleaning-images",
      turnId: String(turnId ?? existing?.turnId ?? "").trim() || null,
      itemId: String(itemId ?? existing?.itemId ?? "").trim() || null,
      compactedAt: normalizedTimestamp(compactedAt, now),
      completedAt: null,
    };
    this.store(key, record);
    this.scheduleTimeout(key, record.id, this.cleanupTimeoutMs);
    return record;
  }

  complete(threadId, {
    turnId = null,
    itemId = null,
    completedAt = null,
  } = {}) {
    const key = normalizedThreadId(threadId);
    if (!key) return null;
    const now = new Date(this.clock()).toISOString();
    const existing = this.entries.get(key);
    const record = {
      ...(existing ?? {
        id: String(itemId ?? "").trim() || this.idFactory(),
        origin: "automatic",
        startedAt: now,
      }),
      status: "completed",
      stage: "completed",
      turnId: String(turnId ?? existing?.turnId ?? "").trim() || null,
      itemId: String(itemId ?? existing?.itemId ?? "").trim() || null,
      completedAt: normalizedTimestamp(completedAt, now),
    };
    this.cancelTimeout(key);
    this.store(key, record);
    this.notifySettled(key, record);
    return record;
  }

  fail(threadId, expectedId = null) {
    const key = normalizedThreadId(threadId);
    const existing = this.entries.get(key);
    if (!existing || (expectedId && existing.id !== expectedId)) return false;
    this.cancelTimeout(key);
    this.entries.delete(key);
    this.notifySettled(key, null);
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
  }

  scheduleTimeout(key, expectedId, timeoutMs = this.timeoutMs) {
    this.cancelTimeout(key);
    const timer = this.setTimer(() => {
      this.timers.delete(key);
      const current = this.entries.get(key);
      if (!current || current.id !== expectedId || current.status !== "running") return;
      this.store(key, {
        ...current,
        status: "timeout",
        completedAt: new Date(this.clock()).toISOString(),
      });
      this.notifySettled(key, this.entries.get(key));
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
