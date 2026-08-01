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

export class ContextCompactionTracker {
  constructor({
    clock = () => Date.now(),
    idFactory = randomUUID,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxEntries = DEFAULT_MAX_ENTRIES,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    onSettled = () => {},
  } = {}) {
    this.clock = clock;
    this.idFactory = idFactory;
    this.timeoutMs = timeoutMs;
    this.maxEntries = maxEntries;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.onSettled = onSettled;
    this.entries = new Map();
    this.timers = new Map();
  }

  get(threadId) {
    return this.entries.get(normalizedThreadId(threadId)) ?? null;
  }

  isRunning(threadId) {
    return this.get(threadId)?.status === "running";
  }

  runningCount() {
    return [...this.entries.values()].filter((entry) => entry.status === "running").length;
  }

  begin(threadId, {
    origin = "automatic",
    turnId = null,
    itemId = null,
    startedAt = null,
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
      }
      : {
        id: String(itemId ?? "").trim() || this.idFactory(),
        origin: origin === "manual" ? "manual" : "automatic",
        status: "running",
        turnId: String(turnId ?? "").trim() || null,
        itemId: String(itemId ?? "").trim() || null,
        startedAt: normalizedTimestamp(startedAt, now),
        completedAt: null,
      };
    this.store(key, record);
    this.scheduleTimeout(key, record.id);
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

  scheduleTimeout(key, expectedId) {
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
    }, this.timeoutMs);
    timer?.unref?.();
    this.timers.set(key, timer);
  }

  cancelTimeout(key) {
    const timer = this.timers.get(key);
    if (timer !== undefined) this.clearTimer(timer);
    this.timers.delete(key);
  }

  notifySettled(threadId, record) {
    try {
      this.onSettled({ threadId, record });
    } catch {
      // Compaction tracking must not fail because an optional observer did.
    }
  }
}
