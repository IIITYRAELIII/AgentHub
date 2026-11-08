import { performance } from "node:perf_hooks";

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export function sqliteContention(error) {
  const primaryCode = Number(error?.errcode) & 0xff;
  return primaryCode === 5 || primaryCode === 6
    || /^SQLITE_(?:BUSY|LOCKED)(?:_|$)/u.test(String(error?.code ?? ""))
    || /database is (?:locked|busy)|database table is locked|SQLITE_BUSY/iu.test(String(error?.message ?? ""));
}

export class AsyncSqliteMutationQueue {
  #tail = Promise.resolve();
  #pending = new Set();
  #diagnostics = {
    queued: 0, retries: 0, exhausted: 0, lastWaitMs: 0, lastAt: null,
    completed: 0, failed: 0, maxDepth: 0,
    lastQueueWaitMs: 0, maxQueueWaitMs: 0, lastExecutionMs: 0, lastTotalMs: 0,
  };

  async run(operation, { timeoutMs = 2_000, requestId = null, onTiming = null, recordMutationTiming = null } = {}) {
    if (typeof operation !== "function") throw new TypeError("SQLite mutation operation is required");
    const entry = { enqueuedAt: performance.now(), queueWaitMs: 0, executionMs: 0, retries: 0, exhausted: false };
    let failure = null;
    this.#pending.add(entry);
    this.#diagnostics.queued += 1;
    this.#diagnostics.maxDepth = Math.max(this.#diagnostics.maxDepth, this.#diagnostics.queued);
    const execute = async () => {
      const startedAt = performance.now();
      let attempts = 0, persistenceMs = 0, contentionWaitMs = 0, outcome = "ok";
      entry.queueWaitMs = startedAt - entry.enqueuedAt;
      this.#diagnostics.lastQueueWaitMs = startedAt - entry.enqueuedAt;
      this.#diagnostics.maxQueueWaitMs = Math.max(this.#diagnostics.maxQueueWaitMs, this.#diagnostics.lastQueueWaitMs);
      // timeoutMs bounds contention after dequeue. It never cancels a queued
      // accepted write or allows a subsequent operation to overtake it.
      const deadline = startedAt + Math.max(1, Number(timeoutMs) || 2_000);
      let delayMs = 10;
      try {
        for (;;) {
          try {
            const attemptAt = performance.now();
            attempts += 1;
            try { return await operation(); }
            finally { persistenceMs += performance.now() - attemptAt; }
          } catch (error) {
            if (!sqliteContention(error)) throw error;
            if (performance.now() >= deadline) {
              entry.exhausted = true;
              this.#diagnostics.exhausted += 1;
              this.#diagnostics.lastWaitMs = performance.now() - startedAt;
              this.#diagnostics.lastAt = new Date().toISOString();
              error.requestId = requestId;
              throw error;
            }
            this.#diagnostics.retries += 1;
            entry.retries += 1;
            this.#diagnostics.lastWaitMs = performance.now() - startedAt;
            this.#diagnostics.lastAt = new Date().toISOString();
            const waitAt = performance.now();
            await wait(Math.min(delayMs, Math.max(1, deadline - performance.now())));
            contentionWaitMs += performance.now() - waitAt;
            delayMs = Math.min(200, delayMs * 2);
          }
        }
      } catch (error) { outcome = "error"; throw error; }
      finally {
        entry.executionMs = performance.now() - startedAt;
        this.#diagnostics.lastExecutionMs = performance.now() - startedAt;
        try {
          const recorded = onTiming?.({ queueWaitMs: startedAt - entry.enqueuedAt,
            executionMs: performance.now() - startedAt, persistenceMs, contentionWaitMs, attempts, outcome });
          recorded?.catch?.(() => {});
        } catch { /* Timing never owns persistence or its outcome. */ }
      }
    };
    const queued = this.#tail.catch(() => {}).then(execute);
    this.#tail = queued.catch(() => {});
    try {
      const result = await queued;
      this.#diagnostics.completed += 1;
      return result;
    } catch (error) {
      failure = error;
      this.#diagnostics.failed += 1;
      throw error;
    } finally {
      this.#diagnostics.lastTotalMs = performance.now() - entry.enqueuedAt;
      this.#pending.delete(entry);
      this.#diagnostics.queued = Math.max(0, this.#diagnostics.queued - 1);
      if (typeof recordMutationTiming === "function") {
        try {
          recordMutationTiming({ queueWaitMs: entry.queueWaitMs, executionMs: entry.executionMs,
            totalMs: performance.now() - entry.enqueuedAt, retries: entry.retries, exhausted: entry.exhausted,
            outcome: failure ? "failed" : "succeeded", processId: process.pid,
            errorCode: !failure ? null : ["ERR_SQLITE_ERROR", "SQLITE_BUSY", "SQLITE_LOCKED"].includes(failure.code)
              ? failure.code : "other",
            ...(Number.isSafeInteger(failure?.errcode) ? { errcode: failure.errcode } : {}) });
        } catch { /* Diagnostics cannot replace the queued mutation outcome. */ }
      }
    }
  }

  diagnostics() {
    const oldest = this.#pending.values().next().value;
    return { ...this.#diagnostics, oldestAgeMs: oldest ? performance.now() - oldest.enqueuedAt : 0 };
  }

  // A shutdown/snapshot fence only. Every writer must still await its own run()
  // result: this fence does not turn a failed mutation into a durable success.
  idle() {
    return this.#tail;
  }
}
