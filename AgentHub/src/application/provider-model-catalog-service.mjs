import { validClaudeModel } from "../domain/agent-runtime-settings.mjs";

const MODEL_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/i;
const PAGE_LIMIT = 100;
const MAX_PAGES = 5;
const DISCOVERY_TIMEOUT_MS = 3_000;

function codexOptions(data) {
  if (!Array.isArray(data)) return [];
  const seen = new Set();
  return data.flatMap((item) => {
    const value = String(item?.model ?? item?.id ?? "").trim();
    if (item?.hidden || !MODEL_ID.test(value) || seen.has(value)) return [];
    seen.add(value);
    return [{ value, label: String(item?.displayName ?? value).trim() || value }];
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
  }

  async refreshCodex(sendRpc) {
    const data = [];
    const cursors = new Set();
    let cursor = null;
    let more = false;
    try {
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const response = await sendRpc("model/list", {
          limit: PAGE_LIMIT,
          includeHidden: false,
          ...(cursor ? { cursor } : {}),
        }, { timeoutMs: DISCOVERY_TIMEOUT_MS, priority: "background" });
        if (!Array.isArray(response?.data)) throw new Error("invalid model/list response");
        data.push(...response.data);
        const next = String(response.nextCursor ?? "").trim();
        more = Boolean(next);
        if (!next) break;
        if (cursors.has(next)) throw new Error("repeated model/list cursor");
        cursors.add(next);
        cursor = next;
      }
      if (more) throw new Error("model/list exceeded page limit");
      const models = codexOptions(data);
      if (!models.length) return false;
      const selected = this.agentPreferences.codexModel;
      const changed = JSON.stringify(this.codexModels) !== JSON.stringify(models);
      this.codexModels.splice(0, this.codexModels.length, ...models);
      this.agentPreferences.codexModels.clear();
      for (const value of ["gpt-5.5", "gpt-5.4", "gpt-5.4-mini", selected]) {
        if (value) this.agentPreferences.codexModels.add(value);
      }
      for (const model of models) this.agentPreferences.codexModels.add(model.value);
      if (changed) this.revision += 1;
      return true;
    } catch (error) {
      this.logger.warn?.(`Cannot refresh Codex models: ${error.message}`);
      return false;
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
