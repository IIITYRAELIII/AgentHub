const DEFAULT_RETRY_DELAYS_MS = Object.freeze([0, 10, 25, 50, 100, 200]);
const mutationLeases = new WeakMap();

function sqliteBusy(error) {
  return /SQLITE_BUSY|database (?:table )?is locked|database is busy/iu
    .test(String(error?.message ?? error));
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function assertTaskMutationLease(lease, requestId) {
  const owned = mutationLeases.get(lease);
  if (!owned || owned.requestId !== String(requestId ?? "").trim()) {
    throw new Error("Task mutation requires its branded owner and exact request identity");
  }
}

export class TaskMutationOwner {
  #tail = Promise.resolve();

  constructor({ retryDelaysMs = DEFAULT_RETRY_DELAYS_MS, sleep = delay } = {}) {
    const delays = Array.isArray(retryDelaysMs) ? retryDelaysMs : DEFAULT_RETRY_DELAYS_MS;
    this.retryDelaysMs = Object.freeze(delays.map((value) => Math.max(0, Number(value) || 0)));
    if (!this.retryDelaysMs.length) throw new Error("Task mutation owner requires a bounded retry schedule");
    this.sleep = sleep;
  }

  run({ requestId, operation } = {}) {
    const identity = String(requestId ?? "").trim();
    if (!identity || typeof operation !== "function") {
      return Promise.reject(new Error("Task mutation requires request identity and operation"));
    }
    const execute = async () => {
      for (let attempt = 0; attempt < this.retryDelaysMs.length; attempt += 1) {
        const waitMs = this.retryDelaysMs[attempt];
        if (waitMs) await this.sleep(waitMs);
        const lease = {};
        mutationLeases.set(lease, { requestId: identity, attempt });
        try {
          return await operation(lease);
        } catch (error) {
          if (!sqliteBusy(error) || attempt + 1 >= this.retryDelaysMs.length) throw error;
        } finally {
          mutationLeases.delete(lease);
        }
      }
      throw new Error("Task mutation retry schedule exhausted");
    };
    const pending = this.#tail.catch(() => {}).then(execute);
    this.#tail = pending.catch(() => {});
    return pending;
  }
}
