import { Worker } from "node:worker_threads";

const DEFAULT_MAX_PENDING_REQUESTS = 32;
const DEFAULT_CLOSE_TIMEOUT_MS = 2_000;

function workerError(value) {
  const error = new Error(String(value?.message ?? "usage sync worker failed"));
  error.code = value?.code;
  if (value?.stack) error.stack = value.stack;
  return error;
}
export class WorkLogUsageSyncWorkerStore {
  #worker = null;
  #sequence = 0;
  #pending = new Map();
  #closing = false;
  #closed = false;
  #lastProjection = null;
  #lastSnapshot = null;

  constructor({
    databaseFile,
    legacyFile = "",
    deviceId = "",
    defaultRuntimeHomeIds = {},
    maxPendingRequests = DEFAULT_MAX_PENDING_REQUESTS,
    closeTimeoutMs = DEFAULT_CLOSE_TIMEOUT_MS,
    workerUrl = new URL("./work-log-usage-sync-worker.mjs", import.meta.url),
    WorkerImpl = Worker,
  } = {}) {
    if (!databaseFile) throw new TypeError("WorkLogUsageSyncWorkerStore requires a databaseFile");
    this.databaseFile = databaseFile;
    this.file = databaseFile;
    this.maxPendingRequests = maxPendingRequests;
    this.closeTimeoutMs = closeTimeoutMs;
    this.#worker = new WorkerImpl(workerUrl, {
      workerData: { databaseFile, legacyFile, deviceId, defaultRuntimeHomeIds },
    });
    this.#worker.unref?.();
    this.#worker.on("message", (message) => this.#settle(message));
    this.#worker.on("error", (error) => this.#fail(error));
    this.#worker.once("exit", (code) => {
      if (!this.#closed && !this.#closing) {
        this.#fail(new Error(`usage sync worker exited with code ${code}`));
      }
    });
  }

  events() {
    return this.#request("events");
  }

  importSnapshot(snapshot) {
    return this.#request("import-snapshot", { snapshot });
  }

  replaceEvents(events) {
    return this.#request("replace-events", { events });
  }

  adoptDeviceIds(deviceIds) {
    return this.#request("adopt-device-ids", { deviceIds });
  }

  projectAccountUsage(payload) {
    return this.#request("project-account-usage", payload).then((result) => {
      this.#lastProjection = {
        durationMs: result.durationMs,
        eventCount: result.eventCount,
        completedAtMs: Date.now(),
      };
      return result;
    });
  }

  usageSyncSnapshot(payload) {
    return this.#request("usage-sync-snapshot", payload).then((result) => {
      this.#lastSnapshot = {
        durationMs: result.durationMs,
        eventCount: result.events?.length ?? 0,
        completedAtMs: Date.now(),
      };
      return result;
    });
  }

  diagnostics() {
    return {
      pendingRequests: this.#pending.size,
      closed: this.#closed,
      lastProjection: this.#lastProjection,
      lastSnapshot: this.#lastSnapshot,
    };
  }

  async close() {
    if (this.#closed || this.#closing) return;
    this.#closing = true;
    const worker = this.#worker;
    if (!worker) {
      this.#closed = true;
      return;
    }
    let timer = null;
    try {
      await Promise.race([
        this.#request("close", {}, { allowClosing: true }),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("usage sync worker close timed out")),
            this.closeTimeoutMs,
          );
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      this.#closed = true;
      this.#worker = null;
      this.#fail(new Error("usage sync worker is closed"));
      await worker.terminate().catch(() => {});
    }
  }

  #request(type, payload = {}, { allowClosing = false } = {}) {
    if (this.#closed || (this.#closing && !allowClosing) || !this.#worker) {
      return Promise.reject(new Error("usage sync worker is unavailable"));
    }
    if (this.#pending.size >= this.maxPendingRequests) {
      return Promise.reject(new Error("usage sync worker request queue is full"));
    }
    const id = ++this.#sequence;
    this.#worker.ref?.();
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      try {
        this.#worker.postMessage({ id, type, payload });
      } catch (error) {
        this.#pending.delete(id);
        reject(error);
      }
    });
  }

  #settle(message) {
    const request = this.#pending.get(message?.id);
    if (!request) return;
    this.#pending.delete(message.id);
    if (message.error) request.reject(workerError(message.error));
    else request.resolve(message.value);
    if (!this.#pending.size) this.#worker?.unref?.();
  }

  #fail(error) {
    for (const request of this.#pending.values()) request.reject(error);
    this.#pending.clear();
  }
}
