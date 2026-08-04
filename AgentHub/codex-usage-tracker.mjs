import {
  addTokenUsage,
  emptyTokenUsage,
  normalizeTokenUsage,
  tokenUsageDelta,
} from "./token-usage.mjs";

function setBoundedMapValue(map, key, value, limit) {
  map.delete(key);
  map.set(key, value);
  while (map.size > limit) map.delete(map.keys().next().value);
}

function contextKey(threadId, turnId) {
  return `${String(threadId ?? "").trim()}\0${String(turnId ?? "").trim()}`;
}

export class CodexUsageTracker {
  constructor({ totalLimit = 500, turnLimit = 200, contextLimit = 500, now = () => new Date() } = {}) {
    this.totalLimit = totalLimit;
    this.turnLimit = turnLimit;
    this.contextLimit = contextLimit;
    this.now = now;
    this.threadTotals = new Map();
    this.turns = new Map();
    this.contexts = new Map();
  }

  rememberContext(params) {
    const modelContextWindow = Math.max(0, Number(params?.tokenUsage?.modelContextWindow) || 0);
    const usedTokens = Math.max(0, Number(params?.tokenUsage?.last?.totalTokens) || 0);
    const threadId = String(params?.threadId ?? "").trim();
    const turnId = String(params?.turnId ?? "").trim();
    if (!threadId || !turnId || !modelContextWindow) return false;
    setBoundedMapValue(this.contexts, contextKey(threadId, turnId), {
      threadId,
      turnId,
      modelContextWindow,
      usedTokens,
      updatedAt: this.now().toISOString(),
    }, this.contextLimit);
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

  track(params) {
    const current = normalizeTokenUsage(params?.tokenUsage?.total);
    const threadId = String(params?.threadId ?? "").trim();
    const turnId = String(params?.turnId ?? "").trim();
    const previous = this.threadTotals.get(threadId);
    if (threadId) setBoundedMapValue(this.threadTotals, threadId, current, this.totalLimit);
    this.rememberContext(params);
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
    this.threadTotals.clear();
    this.turns.clear();
    this.contexts.clear();
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
