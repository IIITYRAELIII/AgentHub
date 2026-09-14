import { Worker } from "node:worker_threads";

const DEFAULT_MAX_PENDING_WRITES = 2_048;
const DEFAULT_MAX_PENDING_REQUESTS = 128;
const DEFAULT_RESTART_DELAY_MS = 100;
const DEFAULT_CLOSE_TIMEOUT_MS = 2_000;

function positiveInteger(value, name) {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 1) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return normalized;
}

function workerError(value) {
  const error = new Error(String(value?.message ?? "command trace worker failed"));
  error.code = value?.code;
  if (value?.stack) error.stack = value.stack;
  return error;
}

export class CommandTraceWorkerStore {
  #worker = null;
  #sequence = 0;
  #pending = new Map();
  #pendingBestEffort = new Set();
  #restartTimer = null;
  #closing = false;
  #closed = false;
  #droppedSpans = 0;
  #workerRestarts = 0;

  constructor({
    databaseFile,
    retentionMs,
    maxSpans,
    fixedClockMs = null,
    maxPendingWrites = DEFAULT_MAX_PENDING_WRITES,
    maxPendingRequests = DEFAULT_MAX_PENDING_REQUESTS,
    restartDelayMs = DEFAULT_RESTART_DELAY_MS,
    closeTimeoutMs = DEFAULT_CLOSE_TIMEOUT_MS,
    workerUrl = new URL("./command-trace-store-worker.mjs", import.meta.url),
    workerData = {},
    logger = console,
  }) {
    if (!databaseFile) throw new TypeError("databaseFile is required");
    this.databaseFile = databaseFile;
    this.retentionMs = retentionMs;
    this.maxSpans = maxSpans;
    this.fixedClockMs = fixedClockMs;
    this.maxPendingWrites = positiveInteger(maxPendingWrites, "maxPendingWrites");
    this.maxPendingRequests = positiveInteger(maxPendingRequests, "maxPendingRequests");
    this.restartDelayMs = positiveInteger(restartDelayMs, "restartDelayMs");
    this.closeTimeoutMs = positiveInteger(closeTimeoutMs, "closeTimeoutMs");
    this.workerUrl = workerUrl;
    this.workerData = workerData;
    this.logger = logger;
    this.#spawn();
  }

  initialize() {
    return this.#request("initialize");
  }

  append(span) {
    return this.#request("append", { span });
  }

  appendMany(spans) {
    return this.#request("append-many", { spans });
  }

  appendBestEffort(span) {
    if (this.#closing || this.#closed || !this.#worker
      || this.#pendingBestEffort.size >= this.maxPendingWrites) {
      this.#droppedSpans += 1;
      return false;
    }
    const id = ++this.#sequence;
    try {
      this.#worker.postMessage({ id, type: "append-best-effort", payload: { span }, bestEffort: true });
      this.#pendingBestEffort.add(id);
      return true;
    } catch (error) {
      this.#droppedSpans += 1;
      this.#report(`Command trace span dropped: ${error?.message ?? error}`);
      return false;
    }
  }

  readCommandTimeline(commandId, options = {}) {
    return this.#request("timeline", { commandId, options });
  }

  readStagePercentiles(query = {}) {
    return this.#request("percentiles", { query });
  }

  prune() {
    return this.#request("prune");
  }

  stats() {
    return Object.freeze({
      queuedWrites: this.#pendingBestEffort.size,
      droppedSpans: this.#droppedSpans,
      pendingRequests: this.#pending.size,
      workerRestarts: this.#workerRestarts,
      workerRunning: Boolean(this.#worker),
    });
  }

  async close() {
    if (this.#closed) return;
    this.#closing = true;
    if (this.#restartTimer) clearTimeout(this.#restartTimer);
    this.#restartTimer = null;
    const worker = this.#worker;
    if (!worker) {
      this.#closed = true;
      return;
    }
    let timer;
    try {
      await Promise.race([
        this.#request("close", {}, { allowClosing: true, bypassLimit: true }),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("command trace worker close timed out")), this.closeTimeoutMs);
          timer.unref?.();
        }),
      ]);
    } catch (error) {
      this.#report(error?.message ?? error);
    } finally {
      if (timer) clearTimeout(timer);
      this.#closed = true;
      this.#worker = null;
      this.#rejectPending(new Error("command trace worker is closed"));
      this.#droppedSpans += this.#pendingBestEffort.size;
      this.#pendingBestEffort.clear();
      await worker.terminate().catch(() => {});
    }
  }

  #request(type, payload = {}, { allowClosing = false, bypassLimit = false } = {}) {
    if (this.#closed || (this.#closing && !allowClosing) || !this.#worker) {
      return Promise.reject(new Error("command trace worker is unavailable"));
    }
    if (!bypassLimit && this.#pending.size >= this.maxPendingRequests) {
      return Promise.reject(new Error("command trace worker request queue is full"));
    }
    const id = ++this.#sequence;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      try {
        this.#worker.postMessage({ id, type, payload, bestEffort: false });
      } catch (error) {
        this.#pending.delete(id);
        reject(error);
      }
    });
  }

  #spawn() {
    if (this.#closing || this.#closed || this.#worker) return;
    let worker;
    try {
      worker = new Worker(this.workerUrl, {
        workerData: {
          databaseFile: this.databaseFile,
          retentionMs: this.retentionMs,
          maxSpans: this.maxSpans,
          fixedClockMs: this.fixedClockMs,
          ...this.workerData,
        },
      });
    } catch (error) {
      this.#report(`Cannot start command trace worker: ${error?.message ?? error}`);
      this.#scheduleRestart();
      return;
    }
    this.#worker = worker;
    worker.on("message", (message) => this.#onMessage(message));
    worker.on("error", (error) => this.#report(`Command trace worker error: ${error.message}`));
    worker.once("exit", (code) => this.#onExit(worker, code));
  }

  #onMessage(message) {
    if (message?.maintenanceError) {
      this.#report(`Command trace retention deferred: ${message.maintenanceError.message}`);
      return;
    }
    if (message?.bestEffort === true) {
      this.#pendingBestEffort.delete(message.id);
      if (message.error) {
        this.#droppedSpans += 1;
        this.#report(`Command trace span dropped: ${message.error.message}`);
      }
      return;
    }
    const request = this.#pending.get(message?.id);
    if (!request) return;
    this.#pending.delete(message.id);
    if (message.error) request.reject(workerError(message.error));
    else request.resolve(message.value);
  }

  #onExit(worker, code) {
    if (this.#worker !== worker) return;
    this.#worker = null;
    this.#droppedSpans += this.#pendingBestEffort.size;
    this.#pendingBestEffort.clear();
    this.#rejectPending(new Error(`command trace worker exited with code ${code}`));
    if (this.#closing || this.#closed) return;
    this.#workerRestarts += 1;
    this.#scheduleRestart();
  }

  #scheduleRestart() {
    if (this.#closing || this.#closed || this.#restartTimer) return;
    this.#restartTimer = setTimeout(() => {
      this.#restartTimer = null;
      this.#spawn();
    }, this.restartDelayMs);
    this.#restartTimer.unref?.();
  }

  #rejectPending(error) {
    for (const request of this.#pending.values()) request.reject(error);
    this.#pending.clear();
  }

  #report(message) {
    try {
      this.logger?.warn?.(String(message));
    } catch {
      // Diagnostics must never alter runtime behavior.
    }
  }
}

export const COMMAND_TRACE_WORKER_DEFAULTS = Object.freeze({
  maxPendingWrites: DEFAULT_MAX_PENDING_WRITES,
  maxPendingRequests: DEFAULT_MAX_PENDING_REQUESTS,
  restartDelayMs: DEFAULT_RESTART_DELAY_MS,
  closeTimeoutMs: DEFAULT_CLOSE_TIMEOUT_MS,
});
