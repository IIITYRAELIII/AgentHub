import { randomUUID } from "node:crypto";

import { CODEX_TASK_SOURCE_KINDS } from "./codex/codex-subagent-accounting.mjs";
import { codexThreadSandboxSettings } from "./codex/codex-sandbox.mjs";

function requiredFunction(value, name) {
  if (typeof value !== "function") throw new TypeError(`${name} is required`);
  return value;
}

function normalizedPath(value) {
  return String(value ?? "").trim().replaceAll("\\", "/").replace(/\/+$/u, "").toLowerCase();
}

function belongsToProject(candidate, projectRoot) {
  const candidatePath = normalizedPath(candidate);
  const rootPath = normalizedPath(projectRoot);
  return Boolean(candidatePath && rootPath)
    && (candidatePath === rootPath || candidatePath.startsWith(`${rootPath}/`));
}

export class CodexProviderTaskService {
  #transportRunning;
  #startTransport;
  #initialize;
  #sendRpc;
  #selection;
  #bindCreatedThread;
  #activeProjectRoot;
  #sandboxMode;
  #model;
  #invalidateCatalog;
  #restoreSettings;
  #updateSettings;
  #clearLatestDiff;
  #saveState;
  #nameCreatedThread;
  #discoverLocalTasks;
  #logWarn;

  constructor(options = {}) {
    this.#transportRunning = requiredFunction(options.transportRunning, "transportRunning");
    this.#startTransport = requiredFunction(options.startTransport, "startTransport");
    this.#initialize = requiredFunction(options.initialize, "initialize");
    this.#sendRpc = requiredFunction(options.sendRpc, "sendRpc");
    this.#selection = options.selection;
    if (!this.#selection?.setThread || !this.#selection?.setTitle) {
      throw new TypeError("selection store is required");
    }
    this.#bindCreatedThread = requiredFunction(options.bindCreatedThread, "bindCreatedThread");
    this.#activeProjectRoot = requiredFunction(options.activeProjectRoot, "activeProjectRoot");
    this.#sandboxMode = requiredFunction(options.sandboxMode, "sandboxMode");
    this.#model = typeof options.model === "function" ? options.model : () => undefined;
    this.#invalidateCatalog = requiredFunction(options.invalidateCatalog, "invalidateCatalog");
    this.#restoreSettings = requiredFunction(options.restoreSettings, "restoreSettings");
    this.#updateSettings = requiredFunction(options.updateSettings, "updateSettings");
    this.#clearLatestDiff = requiredFunction(options.clearLatestDiff, "clearLatestDiff");
    this.#saveState = requiredFunction(options.saveState, "saveState");
    this.#nameCreatedThread = options.nameCreatedThread;
    this.#discoverLocalTasks = options.discoverLocalTasks ?? null;
    if (this.#discoverLocalTasks !== null && typeof this.#discoverLocalTasks !== "function") {
      throw new TypeError("discoverLocalTasks must be a function");
    }
    this.#logWarn = typeof options.logWarn === "function" ? options.logWarn : () => {};
  }

  async createTask() {
    const projectRoot = this.#activeProjectRoot();
    const streamId = this.#selection.streamId;
    const result = await this.#sendRpc("thread/start", {
      cwd: projectRoot,
      model: this.#model() || undefined,
      ...codexThreadSandboxSettings(this.#sandboxMode()),
      serviceName: "telegram_codex_bridge",
    });
    const threadId = String(result?.thread?.id ?? "").trim();
    if (!threadId) throw new Error("Codex did not return a thread id");
    await this.#bindCreatedThread({
      provider: "codex",
      threadId,
      streamId,
      projectRoot,
    });
    this.#selection.setThread(threadId, {
      provider: "codex",
      streamId,
    });
    this.#clearLatestDiff();
    await this.#saveState();
    this.#invalidateCatalog();
    this.#restoreSettings(threadId, { inheritCurrent: true });
    await this.#updateSettings();
    if (typeof this.#nameCreatedThread !== "function") throw new Error("Hub Thread naming is not configured");
    const title = await this.#nameCreatedThread({ provider: "codex", threadId, streamId, projectRoot });
    this.#selection.setTitle(title);
    await this.#saveState();
    return {
      provider: "codex",
      threadId,
      projectRoot,
      title,
    };
  }

  async discoverTasks() {
    if (this.#discoverLocalTasks) {
      try {
        const localTasks = (await this.#discoverLocalTasks())
          .filter((thread) => !String(thread?.parentThreadId ?? "").trim())
          .map((thread) => {
            const timestamp = Date.parse(String(thread.updatedAt ?? thread.createdAt ?? ""));
            return {
              ...thread,
              id: String(thread.id ?? thread.threadId ?? "").trim(),
              discoverySource: "local-rollout",
              updatedAt: Number.isFinite(timestamp) ? timestamp / 1_000 : 0,
            };
          })
          .filter((thread) => thread.id);
        if (localTasks.some((thread) => belongsToProject(thread.cwd, this.#activeProjectRoot()))) {
          return localTasks;
        }
        this.#logWarn("Local Codex rollout index does not cover the active project; using thread/list");
      } catch (error) {
        this.#logWarn(`Cannot discover local Codex rollouts; using thread/list: ${error.message}`);
      }
    }
    if (!this.#transportRunning()) {
      await this.#startTransport();
      await this.#initialize({ attachSelectedThread: false });
    }
    const threads = [];
    let cursor = null;
    const seenCursors = new Set();
    do {
      if (cursor && seenCursors.has(cursor)) break;
      if (cursor) seenCursors.add(cursor);
      const result = await this.#sendRpc("thread/list", {
        cursor,
        limit: 100,
        sortKey: "updated_at",
        sortDirection: "desc",
        sourceKinds: CODEX_TASK_SOURCE_KINDS,
      });
      threads.push(...(result?.data ?? []));
      cursor = result?.nextCursor ?? null;
    } while (cursor);
    return threads;
  }
}

export class ClaudeProviderTaskService {
  #selection;
  #activeProjectRoot;
  #clearLatestDiff;
  #saveState;

  constructor(options = {}) {
    this.#selection = options.selection;
    if (!this.#selection?.setThread) throw new TypeError("selection store is required");
    this.#activeProjectRoot = requiredFunction(options.activeProjectRoot, "activeProjectRoot");
    this.#clearLatestDiff = requiredFunction(options.clearLatestDiff, "clearLatestDiff");
    this.#saveState = requiredFunction(options.saveState, "saveState");
  }

  async createTask() {
    const threadId = randomUUID();
    this.#selection.setThread(threadId, {
      provider: "claude",
      streamId: this.#selection.streamId,
      title: "Новый поток Claude",
    });
    this.#clearLatestDiff();
    await this.#saveState();
    return {
      provider: "claude",
      threadId,
      projectRoot: this.#activeProjectRoot(),
      title: "Новый поток Claude",
    };
  }
}
