import { CODEX_TASK_SOURCE_KINDS } from "./codex/codex-subagent-accounting.mjs";
import { codexThreadSandboxSettings } from "./codex/codex-sandbox.mjs";

function requiredFunction(value, name) {
  if (typeof value !== "function") throw new TypeError(`${name} is required`);
  return value;
}

export class CodexProviderTaskService {
  #transportRunning;
  #startTransport;
  #initialize;
  #sendRpc;
  #selection;
  #activeProjectRoot;
  #sandboxMode;
  #invalidateCatalog;
  #restoreSettings;
  #updateSettings;
  #clearLatestDiff;
  #saveState;
  #clock;

  constructor(options = {}) {
    this.#transportRunning = requiredFunction(options.transportRunning, "transportRunning");
    this.#startTransport = requiredFunction(options.startTransport, "startTransport");
    this.#initialize = requiredFunction(options.initialize, "initialize");
    this.#sendRpc = requiredFunction(options.sendRpc, "sendRpc");
    this.#selection = options.selection;
    if (!this.#selection?.setThread || !this.#selection?.setTitle) {
      throw new TypeError("selection store is required");
    }
    this.#activeProjectRoot = requiredFunction(options.activeProjectRoot, "activeProjectRoot");
    this.#sandboxMode = requiredFunction(options.sandboxMode, "sandboxMode");
    this.#invalidateCatalog = requiredFunction(options.invalidateCatalog, "invalidateCatalog");
    this.#restoreSettings = requiredFunction(options.restoreSettings, "restoreSettings");
    this.#updateSettings = requiredFunction(options.updateSettings, "updateSettings");
    this.#clearLatestDiff = requiredFunction(options.clearLatestDiff, "clearLatestDiff");
    this.#saveState = requiredFunction(options.saveState, "saveState");
    this.#clock = options.clock ?? (() => new Date());
  }

  async createTask() {
    const result = await this.#sendRpc("thread/start", {
      cwd: this.#activeProjectRoot(),
      ...codexThreadSandboxSettings(this.#sandboxMode()),
      serviceName: "telegram_codex_bridge",
    });
    const threadId = String(result?.thread?.id ?? "").trim();
    if (!threadId) throw new Error("Codex did not return a thread id");
    this.#selection.setThread(threadId, { provider: "codex" });
    this.#invalidateCatalog();
    this.#restoreSettings(threadId, { inheritCurrent: true });
    await this.#updateSettings();
    const title = await this.#nameTask(threadId);
    this.#selection.setTitle(title);
    this.#clearLatestDiff();
    await this.#saveState();
    return {
      provider: "codex",
      threadId,
      projectRoot: this.#activeProjectRoot(),
      title,
    };
  }

  async #nameTask(threadId) {
    const timestamp = this.#clock().toLocaleString("ru-RU", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
    const title = `Telegram · ${timestamp}`;
    await this.#sendRpc("thread/name/set", { threadId, name: title });
    return title;
  }

  async discoverTasks() {
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
  #clearLatestDiff;
  #saveState;

  constructor(options = {}) {
    this.#selection = options.selection;
    if (!this.#selection?.setThread) throw new TypeError("selection store is required");
    this.#clearLatestDiff = requiredFunction(options.clearLatestDiff, "clearLatestDiff");
    this.#saveState = requiredFunction(options.saveState, "saveState");
  }

  async createTask() {
    this.#selection.setThread(null, { provider: "claude", title: "Новая задача Claude" });
    this.#clearLatestDiff();
    await this.#saveState();
    return {
      provider: "claude",
      threadId: null,
      projectRoot: "",
      title: "Новая задача Claude",
    };
  }
}
