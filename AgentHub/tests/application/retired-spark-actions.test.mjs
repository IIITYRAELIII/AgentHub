import assert from "node:assert/strict";
import test from "node:test";
import { CodexTurnService } from "../../src/providers/provider-turn-services.mjs";
import { CodexSparkTaskClassifier, ensureDashBotStream } from "../../src/providers/codex/codex-spark-task-classifier.mjs";
import { orderCodexModels } from "../../src/domain/codex-model-order.mjs";
import { ProviderModelCatalogService } from "../../src/application/provider-model-catalog-service.mjs";

test("Spark is excluded from configured and freshly discovered choices while historical preference remains", async () => {
  const source = [{ value: "gpt-5.3-codex-spark", label: "Spark" }, { value: "gpt-6-sol", label: "Sol" }];
  const captured = structuredClone(source);
  assert.deepEqual(orderCodexModels(source).map(x => x.value), ["gpt-6-sol"]);
  assert.deepEqual(source, captured);
  const models = [], preferences = { codexModels: new Set(), selectedModel: "gpt-5.3-codex-spark",
    recordCodexCatalog() { return []; } };
  const catalog = new ProviderModelCatalogService({ codexModels: models, claudeModels: [], agentPreferences: preferences,
    logger: { info() {}, warn() {} } });
  assert.equal(await catalog.refreshCodex(async () => ({ data: source.map(x => ({ model: x.value })), nextCursor: null })), true);
  assert.deepEqual(models.map(x => x.value), ["gpt-6-sol"]);
  assert.equal(preferences.selectedModel, "gpt-5.3-codex-spark");
  assert.deepEqual([...preferences.codexModels], ["gpt-6-sol"]);
});

function turnService() {
  const rpc = [], completed = [];
  const service = new CodexTurnService({ sendRpc: async (name, args) => { rpc.push({ name, args }); return { turnId: "turn" }; },
    sandboxMode: () => "workspace-write", compactionRecycle: () => null, resolvedSkillNames: async () => [],
    reindexRun() {}, saveState: async () => {}, startTyping() {}, scheduleObservedRun() {},
    finishProgress: async () => {}, completeRun: async run => completed.push(run), readThread: async () => ({}),
    developerInstructions: async () => "Fixture" });
  return { service, rpc, completed };
}

test("new and retry launch or steer cannot dispatch Spark; other model steer remains available", async () => {
  const f = turnService(), run = { modelId: "gpt-5.3-codex-spark", threadId: "history", turnId: "turn" };
  await assert.rejects(f.service.launch(run, "request"), { code: "CODEX_MODEL_RETIRED" });
  await assert.rejects(f.service.steer({ run, target: { threadId: "history" }, input: "retry" }), { code: "CODEX_MODEL_RETIRED" });
  assert.equal(f.rpc.length, 0);
  assert.equal(f.completed.length, 1);
  assert.equal(run.modelId, "gpt-5.3-codex-spark");
  const result = await f.service.steer({ run: { modelId: "gpt-6-sol", turnId: "turn" },
    target: { threadId: "available" }, input: "ordinary steer", clientUserMessageId: "same-id" });
  assert.equal(result.turnId, "turn");
  assert.equal(f.rpc.length, 1); assert.equal(f.rpc[0].name, "turn/steer");
});

test("retired Task classifier cannot create a Spark Stream or resolve/launch its process", async () => {
  let effects = 0;
  assert.throws(() => ensureDashBotStream({ ensureExperiments() { effects++; } }), { code: "CODEX_MODEL_RETIRED" });
  const classifier = new CodexSparkTaskClassifier({ resolveExecutable: async () => { effects++; },
    runProcess: async () => { effects++; } });
  await assert.rejects(classifier.classify({ text: "retained task" }), { code: "CODEX_MODEL_RETIRED" });
  assert.equal(effects, 0);
});
