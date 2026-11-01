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
// Diagnostic identities only: fixed classes and a bounded, non-authoritative
// window for attributing replies after a timeout. Evicted replies stay unknown.
const TIMEOUT_DIAGNOSTIC_LIMIT = 64;
const RPC_DIAGNOSTIC_CLASSES = [
  "thread/read", "thread/turns/list", "thread/list", "thread/resume",
  "turn/start", "turn/steer", "turn/interrupt", "other", "unknown",
];

const RPC_DIAGNOSTIC_METHODS = new Set(RPC_DIAGNOSTIC_CLASSES.slice(0, -2));

function rpcDiagnosticClass(method) {
  return RPC_DIAGNOSTIC_METHODS.has(method) ? method : "other";
}

function memoryDiagnostics() {
  return {
    byteBasis: "decoded-utf8-json-line-without-delimiter",
    wireBytes: 0, wireMessages: 0, invalidWireBytes: 0,
    ignoredResponses: 0, lateResponses: 0, unclassifiedResponses: 0,
    timeoutIdentityEvictions: 0,
    fullRead: { active: 0, currentPageWireBytes: 0, peakPageWireBytes: 0,
      currentUnknownPages: 0, unknownPages: 0, completed: 0, failed: 0, last: null },
    hydration: { currentWireBytes: 0, peakWireBytes: 0, currentMessages: 0,
      peakMessages: 0, receivedMessages: 0, replayedMessages: 0, coalescedMessages: 0 },
    rpc: Object.fromEntries(RPC_DIAGNOSTIC_CLASSES.map((key) => [key, {
      responses: 0, wireBytes: 0, maxWireBytes: 0, timeouts: 0,
      queuedTimeouts: 0, lateResponses: 0, last: null, lastTimeout: null,
    }])),
  };
}

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
    this.messageQueue = [];
    this.messageDrainScheduled = false;
    this.initialization = null;
    this.generation = 0;
    this.memoryDiagnostics = memoryDiagnostics();
    this.recentTimeoutDiagnostics = Array(TIMEOUT_DIAGNOSTIC_LIMIT).fill(null);
    this.timeoutDiagnosticCursor = 0;
  }

  get running() {
    return Boolean(this.child);
  }

  get pid() {
    return this.child?.pid ?? null;
  }

  diagnostics() {
    return {
      running: this.running,
      pid: this.pid,
      generation: this.generation,
      pendingRequests: this.pending.size,
      queuedRequests: REQUEST_PRIORITIES.reduce(
        (total, priority) => total + this.requestQueues[priority].length,
        0,
      ),
      inFlightThreadReads: this.threadReadCache.size,
      activeHydrations: this.threadHydrations.size,
      // Only small fixed-shape numeric/identity records are copied here.
      memory: structuredClone(this.memoryDiagnostics),
    };
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
      throw Object.assign(new Error(`Codex app-server failed to start: ${error.message}`, { cause: error }),
        { ...(error?.code ? { code: error.code } : {}) });
    }

    this.child = child;
    this.generation += 1;
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
    } else {
      await this.stopProcessTree(child.pid).catch(() => child.kill());
    }
    await this.#handleExit(child, null, "owner-stop", new Error("stopped by Hub owner"));
  }

  request(method, params = {}, options = {}) {
    return this.#request(method, params, options);
  }

  #request(method, params, { timeoutMs = null, priority = null } = {}, wireObservation = null) {
    if (!this.child) return Promise.reject(new Error("Codex App Server is not running"));
    const id = this.requestSequence++;
    const normalizedPriority = requestPriority(method, priority);
    return new Promise((resolve, reject) => {
      const request = {
        id,
        generation: this.generation,
        method,
        params,
        priority: normalizedPriority,
        timeoutMs: timeoutMs == null
          ? method === "thread/resume" ? this.threadResumeTimeoutMs : this.rpcTimeoutMs
          : positiveInteger(timeoutMs, this.rpcTimeoutMs),
        resolve,
        reject,
        timer: null,
        wireObservation,
      };
      request.timer = setTimeout(() => this.#expireRequest(request), request.timeoutMs);
      this.requestQueues[normalizedPriority].push(request);
      this.#drainRequestQueue();
    });
  }

  #expireRequest(request) {
    const pending = this.pending.get(request.id);
    const dispatched = Boolean(pending);
    if (pending) {
      this.pending.delete(request.id);
      this.#releaseRequest(pending);
    } else {
      const queue = this.requestQueues[request.priority];
      const index = queue.findIndex((queued) => queued.id === request.id);
      if (index < 0) return;
      queue.splice(index, 1);
    }
    const stats = this.memoryDiagnostics.rpc[rpcDiagnosticClass(request.method)];
    stats[dispatched ? "timeouts" : "queuedTimeouts"] += 1;
    stats.lastTimeout = { requestId: request.id, generation: request.generation, dispatched };
    if (dispatched) {
      const slot = this.timeoutDiagnosticCursor;
      if (this.recentTimeoutDiagnostics[slot]) this.memoryDiagnostics.timeoutIdentityEvictions += 1;
      this.recentTimeoutDiagnostics[slot] = {
        id: request.id, generation: request.generation, rpcClass: rpcDiagnosticClass(request.method),
      };
      this.timeoutDiagnosticCursor = (slot + 1) % TIMEOUT_DIAGNOSTIC_LIMIT;
    }
    const error = new Error(`Codex RPC ${request.method} timed out after ${request.timeoutMs} ms`);
    error.deliveryOutcome = dispatched ? "unknown" : "not-sent";
    error.uncertain = dispatched;
    request.reject(error);
    Promise.resolve(this.onTimeout?.({
      id: request.id,
      method: request.method,
      params: request.params,
      timeoutMs: request.timeoutMs,
      generation: request.generation,
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
      error.deliveryOutcome = "not-sent";
      error.uncertain = false;
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

  respond(id, result, { expectedGeneration = null } = {}) {
    const child = this.child;
    if (!child) return Promise.reject(new Error("Codex App Server is not running"));
    if (Number.isSafeInteger(expectedGeneration) && expectedGeneration !== this.generation) {
      const error = new Error(
        `Codex App Server generation changed (expected=${expectedGeneration}, current=${this.generation})`,
      );
      error.code = "CODEX_APP_SERVER_GENERATION_CHANGED";
      error.deliveryOutcome = "not-sent";
      return Promise.reject(error);
    }
    const message = { id, result };
    if (typeof child.send === "function") {
      return new Promise((resolve, reject) => {
        if (child.send.length < 2) {
          try {
            child.send(message);
            resolve();
          } catch (error) {
            reject(error);
          }
          return;
        }
        child.send(message, (error) => error ? reject(error) : resolve());
      });
    }
    return new Promise((resolve, reject) => {
      child.stdin.write(`${JSON.stringify(message)}\n`, (error) => error ? reject(error) : resolve());
    });
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
    const inFlight = this.threadReadCache.get(key);
    if (inFlight) return inFlight;

    const operation = this.#readThreadValue(threadKey, {
      includeTurns,
      priority,
      turnLimit,
      turnPageSize,
      turnItemsView,
    });
    this.threadReadCache.set(key, operation);
    try {
      return await operation;
    } finally {
      if (this.threadReadCache.get(key) === operation) this.threadReadCache.delete(key);
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

  async listThreadTurns(threadId, options = {}) {
    return this.#listThreadTurns(threadId, options);
  }

  #listThreadTurns(threadId, {
    cursor = null,
    limit = DEFAULT_THREAD_TURN_PAGE_SIZE,
    sortDirection = "desc",
    itemsView = "full",
    priority = "background",
  } = {}, wireObservation = null) {
    const threadKey = String(threadId ?? "").trim();
    if (!threadKey) throw new Error("Codex thread id is missing");
    return this.#request("thread/turns/list", {
      threadId: threadKey,
      ...(cursor ? { cursor: String(cursor) } : {}),
      limit: positiveInteger(limit, DEFAULT_THREAD_TURN_PAGE_SIZE),
      sortDirection,
      itemsView,
    }, { priority }, wireObservation);
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
    const stats = this.memoryDiagnostics.fullRead;
    const read = { generation: this.generation, firstRequestId: null, lastRequestId: null, lastRequestGeneration: null,
      pageWireBytes: 0, pages: 0, unknownPages: 0, outcome: "failed" };
    stats.active += 1;
    try {
      while (turns.length < maximum) {
        const wire = { bytes: null, requestId: null, generation: null };
        const page = await this.#listThreadTurns(threadId, {
          cursor,
          limit: Math.min(size, maximum - turns.length),
          sortDirection: "desc",
          itemsView,
          priority,
        }, wire);
        read.pages += 1;
        read.firstRequestId ??= wire.requestId;
        read.lastRequestId = wire.requestId;
        read.lastRequestGeneration = wire.generation;
        if (wire.bytes === null) {
          read.unknownPages += 1;
          stats.unknownPages += 1;
          stats.currentUnknownPages += 1;
        } else {
          read.pageWireBytes += wire.bytes;
          stats.currentPageWireBytes += wire.bytes;
          stats.peakPageWireBytes = Math.max(stats.peakPageWireBytes, stats.currentPageWireBytes);
        }
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
      read.outcome = "succeeded";
      return { turns: turns.reverse(), nextCursor, backwardsCursor };
    } finally {
      stats.active -= 1;
      stats.currentPageWireBytes -= read.pageWireBytes;
      stats.currentUnknownPages -= read.unknownPages;
      stats[read.outcome === "succeeded" ? "completed" : "failed"] += 1;
      stats.last = read;
    }
  }

  async #readThreadHydrated(threadId, options) {
    const { applySnapshot, ...readOptions } = options;
    if (this.threadHydrations.has(threadId)) {
      throw new Error(`Codex thread ${threadId} is already being hydrated`);
    }
    const hydration = { messages: [], wireBytes: 0 };
    this.threadHydrations.set(threadId, hydration);
    try {
      const result = await this.readThread(threadId, readOptions);
      await applySnapshot(result);
      return result;
    } finally {
      if (this.threadHydrations.get(threadId) === hydration) this.threadHydrations.delete(threadId);
      const stats = this.memoryDiagnostics.hydration;
      try {
        const replay = coalesceHydrationMessages(hydration.messages);
        stats.replayedMessages += replay.length;
        stats.coalescedMessages += hydration.messages.length - replay.length;
        for (const message of replay) this.#dispatchMessage(message);
      } finally {
        stats.currentWireBytes -= hydration.wireBytes;
        stats.currentMessages -= hydration.messages.length;
      }
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
    // Count UTF-8 bytes of the existing line, excluding its framing delimiter;
    // never serialize or clone a provider payload for diagnostics.
    const wireBytes = Buffer.byteLength(line, "utf8");
    this.memoryDiagnostics.wireBytes += wireBytes;
    this.memoryDiagnostics.wireMessages += 1;
    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      this.memoryDiagnostics.invalidWireBytes += wireBytes;
      this.onInvalidMessage(error);
      return;
    }
    if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
      const pending = this.pending.get(message.id);
      const expired = pending ? null : this.recentTimeoutDiagnostics.find((entry) => entry?.id === message.id);
      const rpcClass = pending ? rpcDiagnosticClass(pending.method) : expired?.rpcClass ?? "unknown";
      const stats = this.memoryDiagnostics.rpc[rpcClass];
      stats.responses += 1;
      stats.wireBytes += wireBytes;
      stats.maxWireBytes = Math.max(stats.maxWireBytes, wireBytes);
      stats.last = {
        requestId: pending?.id ?? expired?.id ?? null,
        generation: pending?.generation ?? expired?.generation ?? null,
        observedGeneration: this.generation, wireBytes,
        disposition: pending ? (message.error ? "rejected" : "succeeded") : expired ? "late" : "unclassified",
      };
      if (!pending) {
        this.memoryDiagnostics.ignoredResponses += 1;
        this.memoryDiagnostics[expired ? "lateResponses" : "unclassifiedResponses"] += 1;
        if (expired) stats.lateResponses += 1;
        return;
      }
      if (pending.wireObservation) Object.assign(pending.wireObservation, {
        bytes: wireBytes, requestId: pending.id, generation: pending.generation,
      });
      this.pending.delete(message.id);
      this.#releaseRequest(pending);
      if (message.error) {
        const error = new Error(message.error.message ?? JSON.stringify(message.error));
        if (message.error.code !== undefined) error.code = message.error.code;
        if (message.error.data !== undefined) error.data = message.error.data;
        error.rpcError = message.error;
        error.deliveryOutcome = "rejected";
        error.uncertain = false;
        pending.reject(error);
      } else pending.resolve(message.result);
      return;
    }
    const threadId = String(message.params?.threadId ?? "").trim();
    const hydration = threadId ? this.threadHydrations.get(threadId) : null;
    if (hydration) {
      hydration.messages.push(message);
      hydration.wireBytes += wireBytes;
      const stats = this.memoryDiagnostics.hydration;
      stats.currentWireBytes += wireBytes;
      stats.currentMessages += 1;
      stats.receivedMessages += 1;
      stats.peakWireBytes = Math.max(stats.peakWireBytes, stats.currentWireBytes);
      stats.peakMessages = Math.max(stats.peakMessages, stats.currentMessages);
      return;
    }
    this.#dispatchMessage(message);
  }

  #dispatchMessage(message) {
    this.messageQueue.push(message);
    this.#scheduleMessageDrain();
  }

  #scheduleMessageDrain() {
    if (this.messageDrainScheduled) return;
    this.messageDrainScheduled = true;
    setImmediate(() => {
      this.messageDrainScheduled = false;
      const messages = coalesceHydrationMessages(this.messageQueue.splice(0));
      for (const queued of messages) {
        Promise.resolve()
          .then(() => this.onMessage?.(queued))
          .catch(this.onMessageError);
      }
      if (this.messageQueue.length) this.#scheduleMessageDrain();
    });
  }

  async #handleExit(instance, code, signal, cause = null) {
    if (this.child !== instance) return;
    const detail = cause?.message ?? `code=${code}, signal=${signal}`;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      const error = new Error(`Codex app-server stopped (${detail})`);
      error.deliveryOutcome = "unknown";
      error.uncertain = true;
      pending.reject(error);
    }
    this.pending.clear();
    for (const priority of REQUEST_PRIORITIES) {
      for (const queued of this.requestQueues[priority]) {
        clearTimeout(queued.timer);
        const error = new Error(`Codex app-server stopped (${detail})`);
        error.deliveryOutcome = "not-sent";
        error.uncertain = false;
        queued.reject(error);
      }
      this.requestQueues[priority] = [];
      this.activeRequests[priority] = 0;
    }
    this.interactiveDispatchStreak = 0;
    this.threadReadCache.clear();
    this.threadHydrations.clear();
    this.messageQueue.length = 0;
    this.messageDrainScheduled = false;
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
