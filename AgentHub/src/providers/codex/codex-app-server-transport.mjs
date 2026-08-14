import { createInterface } from "node:readline";

const DEFAULT_RPC_TIMEOUT_MS = 60_000;
const DEFAULT_THREAD_READ_CACHE_MS = 250;
const DEFAULT_THREAD_READ_CACHE_LIMIT = 200;
const DEFAULT_MAX_CONCURRENT_REQUESTS = 6;
const DEFAULT_MAX_BACKGROUND_REQUESTS = 2;
const DEFAULT_MAX_CRITICAL_REQUESTS = 2;
const DEFAULT_MAX_THREAD_RESUME_REQUESTS = 1;
const DEFAULT_THREAD_RESUME_TIMEOUT_MS = 5_000;
const DEFAULT_THREAD_TURN_LIMIT = 200;
const DEFAULT_THREAD_TURN_PAGE_SIZE = 50;
const REQUEST_PRIORITIES = Object.freeze(["critical", "interactive", "background"]);
const CRITICAL_METHODS = new Set([
  "initialize",
  "thread/start",
  "thread/resume",
  "turn/start",
  "turn/steer",
  "turn/interrupt",
]);
const BACKGROUND_METHODS = new Set([
  "thread/list",
  "thread/read",
  "thread/turns/list",
  "thread/loaded/list",
  "thread/unsubscribe",
  "thread/search",
  "thread/searchOccurrences",
  "skills/list",
  "account/read",
  "account/rateLimits/read",
  "account/usage/read",
]);

function requestPriority(method, requested = null) {
  const explicit = String(requested ?? "").trim();
  if (explicit) {
    if (!REQUEST_PRIORITIES.includes(explicit)) throw new Error(`Unknown Codex RPC priority: ${explicit}`);
    return explicit;
  }
  if (CRITICAL_METHODS.has(method)) return "critical";
  if (BACKGROUND_METHODS.has(method)) return "background";
  return "interactive";
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : fallback;
}

function hydrationMessageKey(message) {
  const params = message?.params ?? {};
  const turnId = String(params.turnId ?? params.turn?.id ?? "").trim();
  const itemId = String(params.itemId ?? params.item?.id ?? "").trim();
  return turnId && itemId ? `${turnId}\0${itemId}` : "";
}

function coalesceHydrationMessages(messages) {
  const completed = new Set();
  for (const message of messages) {
    if (message?.method === "item/completed") {
      const key = hydrationMessageKey(message);
      if (key) completed.add(key);
    }
    if (message?.method === "turn/completed") {
      const turnId = String(message.params?.turn?.id ?? message.params?.turnId ?? "").trim();
      for (const item of Array.isArray(message.params?.turn?.items) ? message.params.turn.items : []) {
        const itemId = String(item?.id ?? "").trim();
        if (turnId && itemId) completed.add(`${turnId}\0${itemId}`);
      }
    }
  }
  const deltas = new Map();
  const replay = [];
  for (const message of messages) {
    if (message?.method !== "item/agentMessage/delta") {
      replay.push(message);
      continue;
    }
    const key = hydrationMessageKey(message);
    if (key && completed.has(key)) continue;
    const existing = key ? deltas.get(key) : null;
    if (existing) {
      existing.params.delta += String(message.params?.delta ?? "");
      continue;
    }
    const buffered = {
      ...message,
      params: {
        ...message.params,
        delta: String(message.params?.delta ?? ""),
        agentHubHydrationReplay: true,
      },
    };
    replay.push(buffered);
    if (key) deltas.set(key, buffered);
  }
  return replay;
}

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
    maxConcurrentRequests = DEFAULT_MAX_CONCURRENT_REQUESTS,
    maxBackgroundRequests = DEFAULT_MAX_BACKGROUND_REQUESTS,
    maxCriticalRequests = DEFAULT_MAX_CRITICAL_REQUESTS,
    maxThreadResumeRequests = DEFAULT_MAX_THREAD_RESUME_REQUESTS,
    threadResumeTimeoutMs = Math.min(DEFAULT_THREAD_RESUME_TIMEOUT_MS, rpcTimeoutMs),
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
    this.maxConcurrentRequests = positiveInteger(maxConcurrentRequests, DEFAULT_MAX_CONCURRENT_REQUESTS);
    this.maxBackgroundRequests = positiveInteger(maxBackgroundRequests, DEFAULT_MAX_BACKGROUND_REQUESTS);
    this.maxCriticalRequests = positiveInteger(maxCriticalRequests, DEFAULT_MAX_CRITICAL_REQUESTS);
    this.maxThreadResumeRequests = positiveInteger(
      maxThreadResumeRequests,
      DEFAULT_MAX_THREAD_RESUME_REQUESTS,
    );
    this.threadResumeTimeoutMs = positiveInteger(
      threadResumeTimeoutMs,
      Math.min(DEFAULT_THREAD_RESUME_TIMEOUT_MS, rpcTimeoutMs),
    );
    this.createInterfaceImpl = createInterfaceImpl;
    this.child = null;
    this.startPromise = null;
    this.lines = null;
    this.requestSequence = 1;
    this.pending = new Map();
    this.requestQueues = Object.fromEntries(REQUEST_PRIORITIES.map((priority) => [priority, []]));
    this.activeRequests = Object.fromEntries(REQUEST_PRIORITIES.map((priority) => [priority, 0]));
    this.interactiveDispatchStreak = 0;
    this.threadReadCache = new Map();
    this.threadHydrations = new Map();
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

  request(method, params = {}, { timeoutMs = null, priority = null } = {}) {
    if (!this.child) return Promise.reject(new Error("Codex App Server is not running"));
    const id = this.requestSequence++;
    const normalizedPriority = requestPriority(method, priority);
    return new Promise((resolve, reject) => {
      const request = {
        id,
        method,
        params,
        priority: normalizedPriority,
        timeoutMs: timeoutMs == null
          ? method === "thread/resume" ? this.threadResumeTimeoutMs : this.rpcTimeoutMs
          : positiveInteger(timeoutMs, this.rpcTimeoutMs),
        resolve,
        reject,
        timer: null,
      };
      request.timer = setTimeout(() => this.#expireRequest(request), request.timeoutMs);
      this.requestQueues[normalizedPriority].push(request);
      this.#drainRequestQueue();
    });
  }

  #expireRequest(request) {
    const pending = this.pending.get(request.id);
    if (pending) {
      this.pending.delete(request.id);
      this.#releaseRequest(pending);
    } else {
      const queue = this.requestQueues[request.priority];
      const index = queue.findIndex((queued) => queued.id === request.id);
      if (index < 0) return;
      queue.splice(index, 1);
    }
    const error = new Error(`Codex RPC ${request.method} timed out after ${request.timeoutMs} ms`);
    request.reject(error);
    Promise.resolve(this.onTimeout?.({
      id: request.id,
      method: request.method,
      params: request.params,
      timeoutMs: request.timeoutMs,
      error,
    })).catch(this.onMessageError);
  }

  #drainRequestQueue() {
    if (!this.child) return;
    while (true) {
      const request = this.#nextQueuedRequest();
      if (!request) return;
      this.#dispatchRequest(request);
    }
  }

  #nextQueuedRequest() {
    const totalActive = REQUEST_PRIORITIES.reduce(
      (sum, priority) => sum + this.activeRequests[priority],
      0,
    );
    if (this.requestQueues.critical.length
      && this.activeRequests.critical < this.maxCriticalRequests) {
      const index = this.requestQueues.critical.findIndex((request) => (
        request.method !== "thread/resume"
        || this.#activeMethodCount("thread/resume") < this.maxThreadResumeRequests
      ));
      if (index >= 0) return this.requestQueues.critical.splice(index, 1)[0];
    }
    if (totalActive >= this.maxConcurrentRequests) return null;
    const backgroundAvailable = this.requestQueues.background.length
      && this.activeRequests.background < this.maxBackgroundRequests;
    if (this.requestQueues.interactive.length
      && (!backgroundAvailable || this.interactiveDispatchStreak < 4)) {
      this.interactiveDispatchStreak += 1;
      return this.requestQueues.interactive.shift();
    }
    if (backgroundAvailable) {
      this.interactiveDispatchStreak = 0;
      return this.requestQueues.background.shift();
    }
    if (this.requestQueues.interactive.length) {
      this.interactiveDispatchStreak += 1;
      return this.requestQueues.interactive.shift();
    }
    return null;
  }

  #activeMethodCount(method) {
    let count = 0;
    for (const request of this.pending.values()) {
      if (request.method === method) count += 1;
    }
    return count;
  }

  #dispatchRequest(request) {
    this.pending.set(request.id, request);
    this.activeRequests[request.priority] += 1;
    try {
      this.#write({ method: request.method, id: request.id, params: request.params });
    } catch (error) {
      this.pending.delete(request.id);
      this.#releaseRequest(request);
      request.reject(error);
    }
  }

  #releaseRequest(request) {
    clearTimeout(request.timer);
    this.activeRequests[request.priority] = Math.max(0, this.activeRequests[request.priority] - 1);
    this.#drainRequestQueue();
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
    for (const cachedKey of this.threadReadCache.keys()) {
      if (cachedKey.startsWith(`${key}\0`)) this.threadReadCache.delete(cachedKey);
    }
  }

  async readThread(threadId, {
    fresh = false,
    includeTurns = true,
    applySnapshot = null,
    priority = "background",
    turnLimit = DEFAULT_THREAD_TURN_LIMIT,
    turnPageSize = DEFAULT_THREAD_TURN_PAGE_SIZE,
    turnItemsView = "full",
  } = {}) {
    const threadKey = String(threadId ?? "").trim();
    if (!threadKey) throw new Error("Codex thread id is missing");
    if (applySnapshot !== null && typeof applySnapshot !== "function") {
      throw new TypeError("applySnapshot must be a function");
    }
    if (applySnapshot) return this.#readThreadHydrated(threadKey, {
      fresh, includeTurns, applySnapshot, priority, turnLimit, turnPageSize, turnItemsView,
    });
    const key = `${threadKey}\0${includeTurns
      ? `full:${turnLimit}:${turnPageSize}:${turnItemsView}`
      : "metadata"}`;
    const cached = this.threadReadCache.get(key);
    if (cached?.promise) return cached.promise;
    if (!fresh && cached?.value && cached.expiresAt > Date.now()) return cached.value;

    const entry = { value: null, expiresAt: 0, promise: null };
    entry.promise = this.#readThreadValue(threadKey, {
      includeTurns,
      priority,
      turnLimit,
      turnPageSize,
      turnItemsView,
    });
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

  async #readThreadValue(threadId, {
    includeTurns,
    priority,
    turnLimit,
    turnPageSize,
    turnItemsView,
  }) {
    const result = await this.request("thread/read", {
      threadId,
      includeTurns: false,
    }, { priority });
    if (!includeTurns) return result;
    const page = await this.readRecentThreadTurns(threadId, {
      limit: turnLimit,
      pageSize: turnPageSize,
      itemsView: turnItemsView,
      priority,
    });
    return {
      ...result,
      thread: {
        ...result.thread,
        turns: page.turns,
        turnsNextCursor: page.nextCursor,
      },
    };
  }

  async listThreadTurns(threadId, {
    cursor = null,
    limit = DEFAULT_THREAD_TURN_PAGE_SIZE,
    sortDirection = "desc",
    itemsView = "full",
    priority = "background",
  } = {}) {
    const threadKey = String(threadId ?? "").trim();
    if (!threadKey) throw new Error("Codex thread id is missing");
    return this.request("thread/turns/list", {
      threadId: threadKey,
      ...(cursor ? { cursor: String(cursor) } : {}),
      limit: positiveInteger(limit, DEFAULT_THREAD_TURN_PAGE_SIZE),
      sortDirection,
      itemsView,
    }, { priority });
  }

  async readRecentThreadTurns(threadId, {
    limit = DEFAULT_THREAD_TURN_LIMIT,
    pageSize = DEFAULT_THREAD_TURN_PAGE_SIZE,
    itemsView = "full",
    priority = "background",
  } = {}) {
    const maximum = positiveInteger(limit, DEFAULT_THREAD_TURN_LIMIT);
    const size = Math.min(maximum, positiveInteger(pageSize, DEFAULT_THREAD_TURN_PAGE_SIZE));
    const turns = [];
    const ids = new Set();
    const cursors = new Set();
    let cursor = null;
    let nextCursor = null;
    let backwardsCursor = null;
    while (turns.length < maximum) {
      const page = await this.listThreadTurns(threadId, {
        cursor,
        limit: Math.min(size, maximum - turns.length),
        sortDirection: "desc",
        itemsView,
        priority,
      });
      for (const turn of Array.isArray(page?.data) ? page.data : []) {
        const id = String(turn?.id ?? "").trim();
        if (!id || ids.has(id)) continue;
        ids.add(id);
        turns.push(turn);
      }
      nextCursor = String(page?.nextCursor ?? "").trim() || null;
      backwardsCursor ||= String(page?.backwardsCursor ?? "").trim() || null;
      if (!nextCursor || turns.length >= maximum) break;
      if (cursors.has(nextCursor)) {
        throw new Error(`Codex thread/turns/list repeated cursor ${nextCursor}`);
      }
      cursors.add(nextCursor);
      cursor = nextCursor;
    }
    return { turns: turns.reverse(), nextCursor, backwardsCursor };
  }

  async #readThreadHydrated(threadId, options) {
    const { applySnapshot, ...readOptions } = options;
    if (this.threadHydrations.has(threadId)) {
      throw new Error(`Codex thread ${threadId} is already being hydrated`);
    }
    const hydration = { messages: [] };
    this.threadHydrations.set(threadId, hydration);
    try {
      const result = await this.readThread(threadId, readOptions);
      await applySnapshot(result);
      return result;
    } finally {
      if (this.threadHydrations.get(threadId) === hydration) this.threadHydrations.delete(threadId);
      for (const message of coalesceHydrationMessages(hydration.messages)) this.#dispatchMessage(message);
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
      this.#releaseRequest(pending);
      if (message.error) {
        const error = new Error(message.error.message ?? JSON.stringify(message.error));
        if (message.error.code !== undefined) error.code = message.error.code;
        if (message.error.data !== undefined) error.data = message.error.data;
        error.rpcError = message.error;
        pending.reject(error);
      } else pending.resolve(message.result);
      return;
    }
    const threadId = String(message.params?.threadId ?? "").trim();
    const hydration = threadId ? this.threadHydrations.get(threadId) : null;
    if (hydration) {
      hydration.messages.push(message);
      return;
    }
    this.#dispatchMessage(message);
  }

  #dispatchMessage(message) {
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
    for (const priority of REQUEST_PRIORITIES) {
      for (const queued of this.requestQueues[priority]) {
        clearTimeout(queued.timer);
        queued.reject(error);
      }
      this.requestQueues[priority] = [];
      this.activeRequests[priority] = 0;
    }
    this.interactiveDispatchStreak = 0;
    this.threadReadCache.clear();
    this.threadHydrations.clear();
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
