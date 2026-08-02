import { createInterface } from "node:readline";

const DEFAULT_RPC_TIMEOUT_MS = 60_000;
const DEFAULT_THREAD_READ_CACHE_MS = 250;
const DEFAULT_THREAD_READ_CACHE_LIMIT = 200;

export class CodexAppServerTransport {
  constructor({
    spawnProcess,
    stopProcessTree,
    onMessage,
    onExit,
    onStderr = (text) => console.error(`[codex] ${text}`),
    onInvalidMessage = (error) => console.error("Invalid app-server message:", error.message),
    onMessageError = (error) => console.error("Codex event handling error:", error.message),
    onTimeout = null,
    rpcTimeoutMs = DEFAULT_RPC_TIMEOUT_MS,
    threadReadCacheMs = DEFAULT_THREAD_READ_CACHE_MS,
    threadReadCacheLimit = DEFAULT_THREAD_READ_CACHE_LIMIT,
    createInterfaceImpl = createInterface,
  }) {
    if (typeof spawnProcess !== "function") throw new TypeError("spawnProcess is required");
    this.spawnProcess = spawnProcess;
    this.stopProcessTree = stopProcessTree;
    this.onMessage = onMessage;
    this.onExit = onExit;
    this.onStderr = onStderr;
    this.onInvalidMessage = onInvalidMessage;
    this.onMessageError = onMessageError;
    this.onTimeout = onTimeout;
    this.rpcTimeoutMs = rpcTimeoutMs;
    this.threadReadCacheMs = threadReadCacheMs;
    this.threadReadCacheLimit = threadReadCacheLimit;
    this.createInterfaceImpl = createInterfaceImpl;
    this.child = null;
    this.startPromise = null;
    this.lines = null;
    this.requestSequence = 1;
    this.pending = new Map();
    this.threadReadCache = new Map();
    this.initialization = null;
  }

  get running() {
    return Boolean(this.child);
  }

  get pid() {
    return this.child?.pid ?? null;
  }

  async start() {
    if (this.child) return this.child;
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.#start();
    try {
      return await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  async #start() {
    let child;
    try {
      child = await this.spawnProcess(["app-server", "--stdio"]);
      if (!child.pid) {
        await new Promise((resolve, reject) => {
          child.once("spawn", resolve);
          child.once("error", reject);
        });
      }
    } catch (error) {
      child?.kill();
      throw new Error(`Codex app-server failed to start: ${error.message}`, { cause: error });
    }

    this.child = child;
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (data) => this.onStderr(String(data).trimEnd()));
    child.on("error", (error) => void this.#handleExit(child, null, null, error));
    child.stdin.on("error", (error) => void this.#handleExit(child, null, null, error));
    child.on("exit", (code, signal) => void this.#handleExit(child, code, signal));

    this.lines = this.createInterfaceImpl({ input: child.stdout });
    this.lines.on("line", (line) => this.#handleLine(line));
    return child;
  }

  async stop() {
    const child = this.child;
    if (!child) return;
    if (!child.pid || typeof this.stopProcessTree !== "function") {
      child.kill();
      return;
    }
    await this.stopProcessTree(child.pid).catch(() => child.kill());
  }

  request(method, params = {}, { timeoutMs = this.rpcTimeoutMs } = {}) {
    if (!this.child) return Promise.reject(new Error("Codex App Server is not running"));
    const id = this.requestSequence++;
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        const error = new Error(`Codex RPC ${method} timed out after ${timeoutMs} ms`);
        reject(error);
        Promise.resolve(this.onTimeout?.({ id, method, params, timeoutMs, error }))
          .catch(this.onMessageError);
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
    });
    try {
      this.#write({ method, id, params });
    } catch (error) {
      clearTimeout(this.pending.get(id)?.timer);
      this.pending.delete(id);
      return Promise.reject(error);
    }
    return promise;
  }

  notify(method, params = {}) {
    this.#write({ method, params });
  }

  async initialize(params = {}) {
    const child = this.child;
    if (!child) throw new Error("Codex App Server is not running");
    let newlyInitialized = false;
    if (this.initialization?.child !== child) {
      newlyInitialized = true;
      const entry = {
        child,
        promise: this.request("initialize", params),
      };
      this.initialization = entry;
      entry.promise.catch(() => {
        if (this.initialization === entry) this.initialization = null;
      });
    }
    return {
      result: await this.initialization.promise,
      newlyInitialized,
    };
  }

  respond(id, result) {
    this.#write({ id, result });
  }

  invalidateThreadRead(threadId) {
    const key = String(threadId ?? "").trim();
    if (!key) return;
    this.threadReadCache.delete(`${key}\0full`);
    this.threadReadCache.delete(`${key}\0metadata`);
  }

  async readThread(threadId, { fresh = false, includeTurns = true } = {}) {
    const threadKey = String(threadId ?? "").trim();
    if (!threadKey) throw new Error("Codex thread id is missing");
    const key = `${threadKey}\0${includeTurns ? "full" : "metadata"}`;
    const cached = this.threadReadCache.get(key);
    if (cached?.promise) return cached.promise;
    if (!fresh && cached?.value && cached.expiresAt > Date.now()) return cached.value;

    const entry = { value: null, expiresAt: 0, promise: null };
    entry.promise = this.request("thread/read", { threadId: threadKey, includeTurns });
    this.threadReadCache.set(key, entry);
    try {
      entry.value = await entry.promise;
      entry.expiresAt = Date.now() + this.threadReadCacheMs;
      entry.promise = null;
      while (this.threadReadCache.size > this.threadReadCacheLimit) {
        this.threadReadCache.delete(this.threadReadCache.keys().next().value);
      }
      return entry.value;
    } catch (error) {
      if (this.threadReadCache.get(key) === entry) this.threadReadCache.delete(key);
      throw error;
    }
  }

  #write(message) {
    if (!this.child) throw new Error("Codex App Server is not running");
    if (typeof this.child.send === "function") {
      this.child.send(message);
      return;
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      this.onInvalidMessage(error);
      return;
    }
    if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        const error = new Error(message.error.message ?? JSON.stringify(message.error));
        if (message.error.code !== undefined) error.code = message.error.code;
        if (message.error.data !== undefined) error.data = message.error.data;
        error.rpcError = message.error;
        pending.reject(error);
      } else pending.resolve(message.result);
      return;
    }
    Promise.resolve()
      .then(() => this.onMessage?.(message))
      .catch(this.onMessageError);
  }

  async #handleExit(instance, code, signal, cause = null) {
    if (this.child !== instance) return;
    const detail = cause?.message ?? `code=${code}, signal=${signal}`;
    const error = new Error(`Codex app-server stopped (${detail})`);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.threadReadCache.clear();
    this.initialization = null;
    this.lines?.close?.();
    this.lines = null;
    this.child = null;
    try {
      await this.onExit?.({ code, signal, cause, detail });
    } catch (error) {
      this.onMessageError(error);
    }
  }
}
