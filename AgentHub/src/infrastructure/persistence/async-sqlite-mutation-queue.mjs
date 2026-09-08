const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export function sqliteContention(error) {
  return error?.code === "SQLITE_BUSY" || /database is locked|SQLITE_BUSY/iu.test(String(error?.message ?? ""));
}

export class AsyncSqliteMutationQueue {
  #tail = Promise.resolve();
  #diagnostics = { queued: 0, retries: 0, exhausted: 0, lastWaitMs: 0, lastAt: null };

  async run(operation, { timeoutMs = 2_000, requestId = null } = {}) {
    if (typeof operation !== "function") throw new TypeError("SQLite mutation operation is required");
    this.#diagnostics.queued += 1;
    const execute = async () => {
      const startedAt = Date.now();
      const deadline = startedAt + Math.max(1, Number(timeoutMs) || 2_000);
      let delayMs = 10;
      for (;;) {
        try {
          return await operation();
        } catch (error) {
          if (!sqliteContention(error)) throw error;
          if (Date.now() >= deadline) {
            this.#diagnostics.exhausted += 1;
            this.#diagnostics.lastWaitMs = Date.now() - startedAt;
            this.#diagnostics.lastAt = new Date().toISOString();
            error.requestId = requestId;
            throw error;
          }
          this.#diagnostics.retries += 1;
          this.#diagnostics.lastWaitMs = Date.now() - startedAt;
          this.#diagnostics.lastAt = new Date().toISOString();
          await wait(delayMs);
          delayMs = Math.min(200, delayMs * 2);
        }
      }
    };
    const queued = this.#tail.catch(() => {}).then(execute);
    this.#tail = queued.catch(() => {});
    try {
      return await queued;
    } finally {
      this.#diagnostics.queued = Math.max(0, this.#diagnostics.queued - 1);
    }
  }

  diagnostics() {
    return { ...this.#diagnostics };
  }
}
