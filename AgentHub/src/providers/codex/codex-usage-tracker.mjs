import {
  addTokenUsage,
  emptyTokenUsage,
  normalizeTokenUsage,
  tokenUsageDelta,
} from "../../domain/token-usage.mjs";

function setBoundedMapValue(map, key, value, limit) {
  map.delete(key);
  map.set(key, value);
  while (map.size > limit) map.delete(map.keys().next().value);
}

function contextKey(threadId, turnId) {
  return `${String(threadId ?? "").trim()}\0${String(turnId ?? "").trim()}`;
}

export class CodexUsageTracker {
  constructor({
    totalLimit = 500,
    turnLimit = 200,
    contextLimit = 500,
    now = () => new Date(),
    onContext = () => {},
  } = {}) {
    this.totalLimit = totalLimit;
    this.turnLimit = turnLimit;
    this.contextLimit = contextLimit;
    this.now = now;
    this.onContext = onContext;
    this.threadTotals = new Map();
    this.turns = new Map();
    this.contexts = new Map();
    this.contextWaiters = new Map();
    this.completedTurns = new Map();
    this.turnCompletionWaiters = new Map();
  }

  rememberContext(params, { provisional = false } = {}) {
    const modelContextWindow = Math.max(0, Number(params?.tokenUsage?.modelContextWindow) || 0);
    const usedTokens = Math.max(0, Number(params?.tokenUsage?.last?.totalTokens) || 0);
    const threadId = String(params?.threadId ?? "").trim();
    const turnId = String(params?.turnId ?? "").trim();
    if (!threadId || !turnId || !modelContextWindow) return false;
    const context = {
      threadId,
      turnId,
      modelContextWindow,
      usedTokens,
      provisional: provisional === true,
      updatedAt: this.now().toISOString(),
    };
    setBoundedMapValue(this.contexts, contextKey(threadId, turnId), context, this.contextLimit);
    try {
      this.onContext(context);
    } catch {
      // Context accounting must not fail because an optional observer did.
    }
    const waiters = this.contextWaiters.get(threadId) ?? [];
    if (waiters.length) {
      const remaining = [];
      for (const waiter of waiters) {
        if (
          (Date.parse(context.updatedAt) || 0) > waiter.afterMs
          && (!waiter.turnId || waiter.turnId === context.turnId)
        ) {
          clearTimeout(waiter.timer);
          waiter.resolve(context);
        } else remaining.push(waiter);
      }
      if (remaining.length) this.contextWaiters.set(threadId, remaining);
      else this.contextWaiters.delete(threadId);
    }
    return true;
  }

  latestContext(threadId, turnId = "") {
    const normalizedThreadId = String(threadId ?? "").trim();
    const normalizedTurnId = String(turnId ?? "").trim();
    const exact = normalizedTurnId
      ? this.contexts.get(contextKey(normalizedThreadId, normalizedTurnId))
      : null;
    const latest = [...this.contexts.values()]
      .filter((entry) => entry.threadId === normalizedThreadId)
      .sort((left, right) => (
        (Date.parse(right.updatedAt) || 0) - (Date.parse(left.updatedAt) || 0)
      ))[0] ?? null;
    if (!exact || !latest) return exact ?? latest;
    return (Date.parse(exact.updatedAt) || 0) >= (Date.parse(latest.updatedAt) || 0)
      ? exact
      : latest;
  }

  latestExactContext(threadId) {
    const normalizedThreadId = String(threadId ?? "").trim();
    return [...this.contexts.values()]
      .filter((entry) => (
        entry.threadId === normalizedThreadId
        && entry.provisional !== true
      ))
      .sort((left, right) => (
        (Date.parse(right.updatedAt) || 0) - (Date.parse(left.updatedAt) || 0)
      ))[0] ?? null;
  }

  waitForContextUpdate(threadId, { after = 0, turnId = "", timeoutMs = 5_000 } = {}) {
    const key = String(threadId ?? "").trim();
    if (!key) return Promise.resolve(null);
    const expectedTurnId = String(turnId ?? "").trim();
    const afterMs = Number.isFinite(Number(after))
      ? Number(after)
      : Date.parse(String(after ?? "")) || 0;
    const current = expectedTurnId
      ? this.contexts.get(contextKey(key, expectedTurnId)) ?? null
      : this.latestContext(key);
    if (current && (Date.parse(current.updatedAt) || 0) > afterMs) return Promise.resolve(current);
    return new Promise((resolve) => {
      const waiter = { afterMs, turnId: expectedTurnId, resolve, timer: null };
      waiter.timer = setTimeout(() => {
        const currentWaiters = this.contextWaiters.get(key) ?? [];
        const remaining = currentWaiters.filter((candidate) => candidate !== waiter);
        if (remaining.length) this.contextWaiters.set(key, remaining);
        else this.contextWaiters.delete(key);
        resolve(null);
      }, Math.max(1, Number(timeoutMs) || 5_000));
      waiter.timer.unref?.();
      const waiters = this.contextWaiters.get(key) ?? [];
      waiters.push(waiter);
      this.contextWaiters.set(key, waiters);
    });
  }

  markTurnCompleted(turnId, status = "completed") {
    const key = String(turnId ?? "").trim();
    if (!key) return null;
    const completion = { turnId: key, status: String(status ?? "").trim() || "completed" };
    setBoundedMapValue(this.completedTurns, key, completion, this.turnLimit);
    const waiters = this.turnCompletionWaiters.get(key) ?? [];
    this.turnCompletionWaiters.delete(key);
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.resolve(completion);
    }
    return completion;
  }

  waitForTurnCompletion(turnId, { timeoutMs = 60_000 } = {}) {
    const key = String(turnId ?? "").trim();
    if (!key) return Promise.resolve(null);
    const completed = this.completedTurns.get(key);
    if (completed) return Promise.resolve(completed);
    return new Promise((resolve) => {
      const waiter = { resolve, timer: null };
      waiter.timer = setTimeout(() => {
        const current = this.turnCompletionWaiters.get(key) ?? [];
        const remaining = current.filter((candidate) => candidate !== waiter);
        if (remaining.length) this.turnCompletionWaiters.set(key, remaining);
        else this.turnCompletionWaiters.delete(key);
        resolve(null);
      }, Math.max(1, Number(timeoutMs) || 60_000));
      waiter.timer.unref?.();
      const waiters = this.turnCompletionWaiters.get(key) ?? [];
      waiters.push(waiter);
      this.turnCompletionWaiters.set(key, waiters);
    });
  }

  track(params, { provisionalContext = false } = {}) {
    const current = normalizeTokenUsage(params?.tokenUsage?.total);
    const threadId = String(params?.threadId ?? "").trim();
    const turnId = String(params?.turnId ?? "").trim();
    const previous = this.threadTotals.get(threadId);
    if (threadId) setBoundedMapValue(this.threadTotals, threadId, current, this.totalLimit);
    this.rememberContext(params, { provisional: provisionalContext });
    const tracker = this.turns.get(turnId);
    if (!tracker) return null;
    const delta = tokenUsageDelta(current, previous, params?.tokenUsage?.last);
    tracker.usage = addTokenUsage(tracker.usage, delta);
    tracker.reported = true;
    return tracker;
  }

  consume(turnId) {
    const key = String(turnId ?? "").trim();
    const tracker = this.turns.get(key);
    this.turns.delete(key);
    return tracker
      ? { usage: normalizeTokenUsage(tracker.usage), reported: tracker.reported === true }
      : { usage: emptyTokenUsage(), reported: false };
  }

  deleteTurn(turnId) {
    return this.turns.delete(String(turnId ?? "").trim());
  }

  restore(snapshot = {}) {
    for (const waiters of this.contextWaiters.values()) {
      for (const waiter of waiters) {
        clearTimeout(waiter.timer);
        waiter.resolve(null);
      }
    }
    this.threadTotals.clear();
    this.turns.clear();
    this.contexts.clear();
    this.contextWaiters.clear();
    for (const entry of Array.isArray(snapshot.threadTokenTotals)
      ? snapshot.threadTokenTotals.slice(-this.totalLimit)
      : []) {
      if (!Array.isArray(entry) || typeof entry[0] !== "string" || !entry[1]) continue;
      this.threadTotals.set(entry[0], normalizeTokenUsage(entry[1]));
    }
    for (const entry of Array.isArray(snapshot.turnTokenUsage)
      ? snapshot.turnTokenUsage.slice(-this.turnLimit)
      : []) {
      if (!Array.isArray(entry) || typeof entry[0] !== "string" || !entry[1]) continue;
      this.turns.set(entry[0], {
        usage: normalizeTokenUsage(entry[1].usage),
        reported: entry[1].reported === true,
      });
    }
    for (const entry of Array.isArray(snapshot.threadContextUsage)
      ? snapshot.threadContextUsage.slice(-this.contextLimit)
      : []) {
      if (!Array.isArray(entry) || typeof entry[0] !== "string" || !entry[1]) continue;
      const modelContextWindow = Math.max(0, Number(entry[1].modelContextWindow) || 0);
      const usedTokens = Math.max(0, Number(entry[1].usedTokens) || 0);
      if (!modelContextWindow) continue;
      this.contexts.set(entry[0], {
        threadId: String(entry[1].threadId ?? ""),
        turnId: String(entry[1].turnId ?? ""),
        modelContextWindow,
        usedTokens,
        provisional: entry[1].provisional === true,
        updatedAt: String(entry[1].updatedAt ?? ""),
      });
    }
  }

  snapshot() {
    return {
      threadTokenTotals: [...this.threadTotals.entries()].slice(-this.totalLimit),
      turnTokenUsage: [...this.turns.entries()].slice(-this.turnLimit),
      threadContextUsage: [...this.contexts.entries()].slice(-this.contextLimit),
    };
  }
}
