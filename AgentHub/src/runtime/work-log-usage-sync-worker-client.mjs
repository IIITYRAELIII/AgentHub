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
  #lastJournalProjection = null;

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
    this.#worker.on("error", (error) => {
      this.#closed = true;
      this.#fail(error);
    });
    this.#worker.once("exit", (code) => {
      if (!this.#closed && !this.#closing) {
        this.#closed = true;
        this.#fail(new Error(`usage sync worker exited with code ${code}`));
      }
    });
  }

  events() {
    return this.#request("events");
  }

  facts() {
    return this.#request("facts");
  }

  importSnapshot(snapshot) {
    return this.#request("import-snapshot", { snapshot });
  }

  reconcileSnapshot(snapshot) {
    return this.#request("reconcile-snapshot", { snapshot });
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

  projectJournal(payload = {}, { workspaceResolver = null } = {}) {
    return this.#request("project-journal", {
      ...payload,
      resolveWorkspaces: typeof workspaceResolver === "function",
    }, { workspaceResolver }).then((result) => {
      this.#lastJournalProjection = result;
      return result;
    });
  }

  synchronizeTaskTitles(payload, { mutationLock = null } = {}) {
    return this.#request("synchronize-task-titles", {
      ...payload, serializeMutation: typeof mutationLock === "function",
    }, { mutationLock });
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

  usageSyncState() {
    return this.#request("usage-sync-state");
  }

  diagnostics() {
    return {
      pendingRequests: this.#pending.size,
      closed: this.#closed,
      lastProjection: this.#lastProjection,
      lastSnapshot: this.#lastSnapshot,
      lastJournalProjection: this.#lastJournalProjection,
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

  #request(type, payload = {}, { allowClosing = false, workspaceResolver = null, mutationLock = null } = {}) {
    if (this.#closed || (this.#closing && !allowClosing) || !this.#worker) {
      return Promise.reject(new Error("usage sync worker is unavailable"));
    }
    if (this.#pending.size >= this.maxPendingRequests) {
      return Promise.reject(new Error("usage sync worker request queue is full"));
    }
    const id = ++this.#sequence;
    this.#worker.ref?.();
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject, workspaceResolver, mutationLock });
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
    if (message.type === "journal-mutation") {
      let granted = false;
      void Promise.resolve().then(() => request.mutationLock(() => new Promise((resolve, reject) => {
        request.mutationResult = { resolve, reject };
        granted = true;
        this.#worker.postMessage({ id: message.id, type: "journal-mutation-granted" });
      }))).then((value) => this.#settle({ id: message.id, value }), (error) => {
        if (!granted) this.#worker?.postMessage({
          id: message.id, type: "journal-mutation-granted", error: { message: String(error?.message ?? error) },
        });
        this.#settle({ id: message.id, error });
      });
      return;
    }
    if (message.type === "journal-workspaces") {
      void Promise.resolve().then(() => Promise.all(
        message.references.map((reference) => request.workspaceResolver(reference)),
      ))
        .then((bindings) => this.#worker?.postMessage({
          id: message.id, type: "journal-workspaces-result", bindings,
        }))
        .catch((error) => this.#worker?.postMessage({
          id: message.id, type: "journal-workspaces-result",
          error: { message: String(error?.message ?? error) },
        }));
      return;
    }
    if (request.mutationResult) {
      const result = request.mutationResult;
      request.mutationResult = null;
      if (message.error) result.reject(workerError(message.error));
      else result.resolve(message.value);
      return;
    }
    this.#pending.delete(message.id);
    if (message.error) request.reject(workerError(message.error));
    else request.resolve(message.value);
    if (!this.#pending.size) this.#worker?.unref?.();
  }

  #fail(error) {
    for (const request of this.#pending.values()) {
      request.mutationResult?.reject(error);
      request.reject(error);
    }
    this.#pending.clear();
  }
}
