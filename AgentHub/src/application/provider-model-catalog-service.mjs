import { validClaudeModel } from "../domain/agent-runtime-settings.mjs";
import { orderCodexModels } from "../domain/codex-model-order.mjs";

const MODEL_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/i;
const PAGE_LIMIT = 100;
const MAX_PAGES = 5;
// Background metadata discovery must not inherit the interactive RPC deadline.
const CODEX_PAGE_TIMEOUT_MS = 20_000;
const CODEX_DISCOVERY_BUDGET_MS = 60_000;
const DISCOVERY_TIMEOUT_MS = 3_000;

function codexOptions(data) {
  if (!Array.isArray(data)) return [];
  const seen = new Set();
  return data.flatMap((item) => {
    const value = String(item?.model ?? item?.slug ?? item?.id ?? "").trim();
    if (item?.hidden || item?.visibility === "hide" || item?.visibility === "hidden"
      || !MODEL_ID.test(value) || seen.has(value)) return [];
    seen.add(value);
    return [{ value, label: String(item?.displayName ?? item?.display_name ?? value).trim() || value }];
  });
}

function claudeOptions(data) {
  if (!Array.isArray(data)) return [];
  return [...new Set(data.map((item) => String(item?.id ?? item?.value ?? "").trim())
    .filter(validClaudeModel))];
}

async function claudeCodeModels({ queryFactory, timeoutMs = 10_000 }) {
  const { query } = queryFactory ? { query: queryFactory }
    : await import("@anthropic-ai/claude-agent-sdk");
  const abortController = new AbortController();
  // The input stream intentionally emits no user message: this is metadata
  // discovery, not a model turn. Keep it open until the control request ends.
  const session = query({
    prompt: (async function* noPrompt() { await new Promise(() => {}); })(),
    options: { abortController, settingSources: ["user"], tools: [] },
  });
  let timer;
  try {
    return await Promise.race([
      session.supportedModels(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("Claude Code model discovery timed out")), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    session.close();
    abortController.abort();
  }
}

export class ProviderModelCatalogService {
  constructor({ codexModels, claudeModels, agentPreferences, fetchImpl = fetch,
    apiKey = process.env.ANTHROPIC_API_KEY, claudeQueryFactory = null, logger = console }) {
    this.codexModels = codexModels;
    this.claudeModels = claudeModels;
    this.agentPreferences = agentPreferences;
    this.fetch = fetchImpl;
    this.apiKey = apiKey;
    this.claudeQueryFactory = claudeQueryFactory;
    this.logger = logger;
    this.revision = 0;
    this.codexRefresh = null;
  }

  async refreshCodex(sendRpc, saveState = async () => {}, { source = "background" } = {}) {
    if (this.codexRefresh) return this.codexRefresh;
    const refresh = this.#refreshCodex(sendRpc, saveState, source);
    this.codexRefresh = refresh;
    try {
      return await refresh;
    } finally {
      if (this.codexRefresh === refresh) this.codexRefresh = null;
    }
  }

  async #refreshCodex(sendRpc, saveState, source) {
    const data = [];
    const cursors = new Set();
    let cursor = null;
    let more = false;
    let complete = false;
    let attemptedPages = 0;
    let completedPages = 0;
    let rpcMs = 0;
    const pageRpcAndQueueMs = [];
    let persistenceMs = 0;
    const started = performance.now();
    let outcome = "failed";
    let failureKind = null;
    try {
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const remainingMs = CODEX_DISCOVERY_BUDGET_MS - (performance.now() - started);
        if (remainingMs <= 0) throw new Error("Codex model discovery budget exhausted");
        const rpcStarted = performance.now();
        attemptedPages += 1;
        let response;
        try {
          response = await sendRpc("model/list", {
            limit: PAGE_LIMIT,
            includeHidden: false,
            ...(cursor ? { cursor } : {}),
          }, { timeoutMs: Math.ceil(Math.min(CODEX_PAGE_TIMEOUT_MS, remainingMs)), priority: "background" });
        } finally {
          const elapsedMs = performance.now() - rpcStarted;
          rpcMs += elapsedMs;
          pageRpcAndQueueMs.push(Math.round(elapsedMs));
        }
        completedPages += 1;
        if (!Array.isArray(response?.data)) throw new Error("invalid model/list response");
        data.push(...response.data);
        const next = String(response.nextCursor ?? "").trim();
        if (response.hasMore === true && !next) throw new Error("incomplete model/list response");
        more = Boolean(next);
        if (!next) {
          complete = Object.hasOwn(response, "nextCursor") || response.hasMore === false;
          break;
        }
        if (cursors.has(next)) throw new Error("repeated model/list cursor");
        cursors.add(next);
        cursor = next;
      }
      if (more || !complete) throw new Error("incomplete model/list response");
      const available = codexOptions(data);
      const novel = this.agentPreferences.recordCodexCatalog(available);
      const models = orderCodexModels(available, novel);
      const changed = JSON.stringify(this.codexModels) !== JSON.stringify(models);
      this.codexModels.splice(0, this.codexModels.length, ...models);
      this.agentPreferences.codexModels.clear();
      for (const model of models) this.agentPreferences.codexModels.add(model.value);
      if (changed) this.revision += 1;
      const persistenceStarted = performance.now();
      await Promise.resolve().then(saveState).catch((error) => {
        this.logger.warn?.(`Cannot save Codex model catalog: ${error.message}`);
      });
      persistenceMs = performance.now() - persistenceStarted;
      outcome = "complete";
      return true;
    } catch (error) {
      failureKind = /timed? out|deadline|budget/iu.test(String(error?.message ?? ""))
        ? "timeout" : "invalid-or-unavailable";
      this.logger.warn?.(`Cannot refresh Codex models: ${error.message}`);
      return false;
    } finally {
      // RPC time includes provider queue/readiness and transport; it is not CPU time.
      try {
        this.logger.info?.("Codex model catalog discovery", {
          source, outcome, failureKind, attemptedPages, completedPages,
          durationMs: Math.round(performance.now() - started),
          rpcAndQueueMs: Math.round(rpcMs), pageRpcAndQueueMs,
          persistenceMs: Math.round(persistenceMs),
        });
      } catch {
        // Diagnostics cannot change the catalog result.
      }
    }
  }

  async refreshClaude() {
    const sdk = await claudeCodeModels({ queryFactory: this.claudeQueryFactory })
      .catch((error) => {
        this.logger.warn?.(`Cannot refresh Claude Code models: ${error.message}`);
        return [];
      });
    // SDK discovery reflects the Claude Code account actually used by Hub.
    // The API catalog is a fallback only when CLI metadata is unavailable.
    const exact = claudeOptions(Array.isArray(sdk) && sdk.length ? sdk
      : this.apiKey ? await this.#claudeApiModels() : []);
    if (!exact.length) return false;
    const changed = JSON.stringify(this.claudeModels) !== JSON.stringify(exact);
    this.claudeModels.splice(0, this.claudeModels.length, ...exact);
    this.agentPreferences.claudeModels.clear();
    for (const value of exact) this.agentPreferences.claudeModels.add(value);
    if (changed) this.revision += 1;
    return true;
  }

  async #claudeApiModels() {
    const models = [];
    const cursors = new Set();
    let cursor = null;
    let more = false;
    try {
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const url = new URL("https://api.anthropic.com/v1/models");
        url.searchParams.set("limit", String(PAGE_LIMIT));
        if (cursor) url.searchParams.set("after_id", cursor);
        const response = await this.fetch(url, {
          headers: {
            "x-api-key": this.apiKey,
            "anthropic-version": "2023-06-01",
          },
          signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
        });
        if (!response.ok) throw new Error(`Claude models HTTP ${response.status}`);
        const payload = await response.json();
        if (!Array.isArray(payload?.data)) throw new Error("invalid Claude models response");
        models.push(...payload.data);
        const next = payload.has_more ? String(payload.last_id ?? "").trim() : "";
        more = Boolean(next);
        if (!next) break;
        if (cursors.has(next)) throw new Error("repeated Claude models cursor");
        cursors.add(next);
        cursor = next;
      }
      if (more) throw new Error("Claude models exceeded page limit");
      return models;
    } catch (error) {
      this.logger.warn?.(`Cannot refresh Claude models: ${error.message}`);
      return [];
    }
  }
}
