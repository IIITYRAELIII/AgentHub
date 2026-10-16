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

  async run(operation, { timeoutMs = 2_000, requestId = null, retryContention = true } = {}) {
    if (typeof operation !== "function") throw new TypeError("SQLite mutation operation is required");
    const entry = { enqueuedAt: performance.now() };
    this.#pending.add(entry);
    this.#diagnostics.queued += 1;
    this.#diagnostics.maxDepth = Math.max(this.#diagnostics.maxDepth, this.#diagnostics.queued);
    const execute = async () => {
      const startedAt = performance.now();
      this.#diagnostics.lastQueueWaitMs = startedAt - entry.enqueuedAt;
      this.#diagnostics.maxQueueWaitMs = Math.max(this.#diagnostics.maxQueueWaitMs, this.#diagnostics.lastQueueWaitMs);
      // timeoutMs bounds contention after dequeue. It never cancels a queued
      // accepted write or allows a subsequent operation to overtake it.
      const deadline = startedAt + Math.max(1, Number(timeoutMs) || 2_000);
      let delayMs = 10;
      try {
        for (;;) {
          try {
            return await operation();
          } catch (error) {
            if (!retryContention || !sqliteContention(error)) throw error;
            if (performance.now() >= deadline) {
              this.#diagnostics.exhausted += 1;
              this.#diagnostics.lastWaitMs = performance.now() - startedAt;
              this.#diagnostics.lastAt = new Date().toISOString();
              error.requestId = requestId;
              throw error;
            }
            this.#diagnostics.retries += 1;
            this.#diagnostics.lastWaitMs = performance.now() - startedAt;
            this.#diagnostics.lastAt = new Date().toISOString();
            await wait(Math.min(delayMs, Math.max(1, deadline - performance.now())));
            delayMs = Math.min(200, delayMs * 2);
          }
        }
      } finally {
        this.#diagnostics.lastExecutionMs = performance.now() - startedAt;
      }
    };
    const queued = this.#tail.catch(() => {}).then(execute);
    this.#tail = queued.catch(() => {});
    try {
      const result = await queued;
      this.#diagnostics.completed += 1;
      return result;
    } catch (error) {
      this.#diagnostics.failed += 1;
      throw error;
    } finally {
      this.#diagnostics.lastTotalMs = performance.now() - entry.enqueuedAt;
      this.#pending.delete(entry);
      this.#diagnostics.queued = Math.max(0, this.#diagnostics.queued - 1);
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
