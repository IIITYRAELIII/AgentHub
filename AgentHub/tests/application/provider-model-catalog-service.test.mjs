import assert from "node:assert/strict";
import test from "node:test";

import { ProviderModelCatalogService } from "../../src/application/provider-model-catalog-service.mjs";

function fixture(options = {}) {
  const codexModels = [{ value: "gpt-6-sol", label: "GPT-6 Sol" }];
  const claudeModels = ["sonnet", "opus", "haiku"];
  const agentPreferences = {
    codexModels: new Set(codexModels.map(({ value }) => value)),
    claudeModels: new Set(claudeModels),
  };
  const warnings = [];
  const service = new ProviderModelCatalogService({
    codexModels, claudeModels, agentPreferences, apiKey: "",
    claudeQueryFactory: () => ({
      supportedModels: async () => [], close() {},
    }),
    logger: { warn: (message) => warnings.push(message) },
    ...options,
  });
  return { service, codexModels, claudeModels, agentPreferences, warnings };
}

test("Codex startup catalog uses every visible model page and preserves the selected preference", async () => {
  const { service, codexModels, agentPreferences } = fixture();
  const calls = [];
  const sendRpc = async (_method, params) => {
    calls.push(params);
    return params.cursor
      ? { data: [{ model: "gpt-6-sol", displayName: "GPT-6 Sol" }], nextCursor: null }
      : { data: [
        { model: "gpt-6.1-sol", displayName: "GPT-6.1 Sol" },
        { model: "hidden", hidden: true },
      ], nextCursor: "page-2" };
  };
  assert.equal(await service.refreshCodex(sendRpc), true);
  assert.equal(service.revision, 1);
  assert.deepEqual(codexModels.map(({ value }) => value), ["gpt-6.1-sol", "gpt-6-sol"]);
  assert.equal(agentPreferences.codexModels.has("gpt-6.1-sol"), true);
  assert.deepEqual(calls.map(({ cursor }) => cursor ?? null), [null, "page-2"]);
  assert.equal(await service.refreshCodex(sendRpc), true);
  assert.equal(service.revision, 1, "unchanged catalog must not churn Desktop revisions");
});

test("failed or empty Codex discovery leaves the working catalog intact", async () => {
  const { service, codexModels } = fixture();
  assert.equal(await service.refreshCodex(async () => ({ data: [] })), false);
  assert.equal(await service.refreshCodex(async () => { throw new Error("offline"); }), false);
  assert.deepEqual(codexModels, [{ value: "gpt-6-sol", label: "GPT-6 Sol" }]);
});

test("Codex refresh removes unavailable choices but retains the saved selection", async () => {
  const { service, codexModels, agentPreferences } = fixture();
  agentPreferences.codexModel = "gpt-6-sol";
  agentPreferences.codexModels.add("gpt-retired");
  assert.equal(await service.refreshCodex(async () => ({
    data: [{ model: "gpt-6.1-sol", displayName: "GPT-6.1 Sol" }],
    nextCursor: null,
  })), true);
  assert.deepEqual(codexModels.map(({ value }) => value), ["gpt-6.1-sol"]);
  assert.equal(agentPreferences.codexModels.has("gpt-retired"), false);
  assert.equal(agentPreferences.codexModels.has("gpt-6-sol"), true);
});

test("Claude Code metadata replaces the picker with account-available models", async () => {
  let closed = false;
  const requests = [];
  const { service, claudeModels, agentPreferences } = fixture({
    apiKey: "test-key",
    claudeQueryFactory: ({ prompt }) => ({
      supportedModels: async () => {
        assert.equal(typeof prompt[Symbol.asyncIterator], "function");
        return [
          { value: "default" }, { value: "sonnet" },
          { value: "claude-sonnet-4-6", displayName: "Sonnet 4.6" },
        ];
      },
      close: () => { closed = true; },
    }),
    fetchImpl: async (url) => {
      requests.push(String(url));
      return { ok: true, json: async () => requests.length === 1
        ? { data: [{ id: "claude-opus-5" }], has_more: true, last_id: "first" }
        : { data: [{ id: "claude-haiku-4-5" }], has_more: false } };
    },
  });
  assert.equal(await service.refreshClaude(), true);
  assert.equal(closed, true);
  assert.deepEqual(claudeModels, ["default", "sonnet", "claude-sonnet-4-6"]);
  assert.equal(agentPreferences.claudeModels.has("opus"), false);
  assert.deepEqual(requests, []);
});

test("Anthropic API pages are used when Claude Code metadata is unavailable", async () => {
  const requests = [];
  const { service, claudeModels } = fixture({
    apiKey: "test-key",
    claudeQueryFactory: () => ({ supportedModels: async () => [], close() {} }),
    fetchImpl: async (url) => {
      requests.push(String(url));
      return { ok: true, json: async () => requests.length === 1
        ? { data: [{ id: "claude-opus-5" }], has_more: true, last_id: "first" }
        : { data: [{ id: "claude-haiku-4-5" }], has_more: false } };
    },
  });
  assert.equal(await service.refreshClaude(), true);
  assert.deepEqual(claudeModels, ["claude-opus-5", "claude-haiku-4-5"]);
  assert.match(requests[1], /after_id=first/u);
});

test("Claude discovery failure retains stable aliases", async () => {
  const { service, claudeModels } = fixture({
    claudeQueryFactory: () => ({
      supportedModels: async () => { throw new Error("offline"); },
      close() {},
    }),
  });
  assert.equal(await service.refreshClaude(), false);
  assert.deepEqual(claudeModels, ["sonnet", "opus", "haiku"]);
});
