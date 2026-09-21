const BROWSER_PLUGIN_ID = "unified-computer-use@openai-bundled";
const BROWSER_SERVER_NAME = "cua_repl";
const REQUIRED_TOOLS = Object.freeze(["js", "js_reset", "turn_ended"]);
const FAILED_RUNTIME_STATES = new Set([
  "authenticationRequired",
  "cancelled",
  "disabled",
  "failed",
]);
const INVENTORY_PAGE_LIMIT = 100;
const INVENTORY_MAXIMUM_PAGES = 4;
const INVENTORY_TIMEOUT_MS = 10_000;

export function codexBrowserToolArgs() {
  return [
    "-c",
    `plugins.${JSON.stringify(BROWSER_PLUGIN_ID)}.enabled=true`,
  ];
}

function toolNames(server) {
  const tools = server?.tools;
  if (!tools || typeof tools !== "object" || Array.isArray(tools)) return [];
  return Object.keys(tools).sort();
}

function unavailable(reason, detail = {}) {
  return {
    status: "unavailable",
    provider: "codex",
    pluginId: BROWSER_PLUGIN_ID,
    server: BROWSER_SERVER_NAME,
    reason,
    ...detail,
  };
}

export class CodexBrowserToolMonitor {
  #revision = 0;
  #state = {
    status: "pending",
    provider: "codex",
    pluginId: BROWSER_PLUGIN_ID,
    server: BROWSER_SERVER_NAME,
  };

  constructor({ fallback = null, logger = console } = {}) {
    this.fallback = fallback;
    this.logger = logger;
  }

  diagnostics() {
    return structuredClone(this.#state);
  }

  observe(message) {
    if (message?.method === "turn/completed") {
      const threadId = String(message.params?.threadId ?? "").trim();
      if (threadId) {
        void this.fallback?.closeForThread?.(threadId).catch((error) => {
          this.logger.warn?.("Cannot close terminal Codex browser fallback session:", error.message);
        });
      }
      return;
    }
    if (message?.method !== "mcpServer/startupStatus/updated") return;
    const params = message.params ?? {};
    if (String(params.name ?? "") !== BROWSER_SERVER_NAME) return;
    const status = String(params.status ?? "");
    if (status === "ready") {
      this.#state = {
        ...this.#state,
        status: REQUIRED_TOOLS.every((name) => this.#state.tools?.includes(name))
          ? "ready"
          : "checking",
        runtimeStatus: "connected",
        reason: undefined,
      };
    } else if (["failed", "cancelled"].includes(status)) {
      this.#revision += 1;
      this.#state = unavailable(
        status === "failed" ? "startup-failed" : "startup-cancelled",
        params.failureReason ? { failureReason: String(params.failureReason) } : {},
      );
    } else if (status === "starting") {
      this.#state = { ...this.#state, status: "checking", runtimeStatus: "starting" };
    }
  }

  async disconnected() {
    this.#revision += 1;
    this.#state = unavailable("app-server-disconnected");
    await this.fallback?.reset?.();
  }

  async refresh(request) {
    if (typeof request !== "function") throw new TypeError("Codex browser inventory request is required");
    const revision = ++this.#revision;
    this.#state = {
      status: "checking",
      provider: "codex",
      pluginId: BROWSER_PLUGIN_ID,
      server: BROWSER_SERVER_NAME,
    };
    try {
      let cursor = null;
      let browser = null;
      for (let page = 0; page < INVENTORY_MAXIMUM_PAGES; page += 1) {
        const response = await request("mcpServerStatus/list", {
          ...(cursor ? { cursor } : {}),
          limit: INVENTORY_PAGE_LIMIT,
          detail: "toolsAndAuthOnly",
        }, {
          timeoutMs: INVENTORY_TIMEOUT_MS,
          priority: "background",
        });
        browser = (Array.isArray(response?.data) ? response.data : [])
          .find((entry) => String(entry?.name ?? "") === BROWSER_SERVER_NAME) ?? null;
        if (browser) break;
        cursor = String(response?.nextCursor ?? "").trim() || null;
        if (!cursor) break;
      }
      if (revision !== this.#revision) return this.diagnostics();
      if (!browser) {
        this.#state = unavailable("server-not-found");
        return this.diagnostics();
      }
      const pluginId = String(browser.pluginId ?? "").trim();
      if (pluginId && pluginId !== BROWSER_PLUGIN_ID) {
        this.#state = unavailable("unexpected-plugin-owner");
        return this.diagnostics();
      }
      const runtimeStatus = String(browser.runtimeStatus ?? "").trim() || null;
      if (FAILED_RUNTIME_STATES.has(runtimeStatus)) {
        this.#state = unavailable("runtime-unavailable", { runtimeStatus });
        return this.diagnostics();
      }
      const availableTools = toolNames(browser);
      const missingTools = REQUIRED_TOOLS.filter((name) => !availableTools.includes(name));
      if (missingTools.length) {
        this.#state = unavailable("required-tools-missing", { missingTools });
        return this.diagnostics();
      }
      this.#state = {
        status: runtimeStatus === "starting" ? "checking" : "ready",
        provider: "codex",
        pluginId: pluginId || BROWSER_PLUGIN_ID,
        server: BROWSER_SERVER_NAME,
        runtimeStatus: runtimeStatus || "catalogued",
        tools: [...REQUIRED_TOOLS],
      };
      return this.diagnostics();
    } catch {
      if (revision === this.#revision) this.#state = unavailable("inventory-request-failed");
      return this.diagnostics();
    }
  }
}

export const CODEX_BROWSER_TOOL_CONTRACT = Object.freeze({
  pluginId: BROWSER_PLUGIN_ID,
  server: BROWSER_SERVER_NAME,
  tools: Object.freeze([...REQUIRED_TOOLS]),
});
