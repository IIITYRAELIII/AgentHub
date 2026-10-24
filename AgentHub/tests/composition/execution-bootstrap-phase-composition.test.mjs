import assert from "node:assert/strict";
import test from "node:test";
import { importCompositionWithPorts, boundPort } from "../helpers/composition-ports.fixture.mjs";

test("execution phase shares recovery and Telegram with bootstrap and keeps optional backfill abortable", async () => {
  const events = [];
  let bootstrapInput;
  let runtimeInput;
  let telegramInput;
  const resources = { id: "one-resource-registry" };
  const runs = new Map();
  const bootstrap = boundPort();
  const { createExecutionBootstrapPhase } = await importCompositionWithPorts(
    new URL("../../src/composition/execution-bootstrap-phase-composition.mjs", import.meta.url), {
      "./runtime-orchestration-composition.mjs": { createRuntimeOrchestrationComposition: (input) => {
        runtimeInput = input;
        return { runtimeResources: resources, runRecovery: {
          recoverAll: (...args) => events.push(["recover", ...args]),
        }, stopRuntimeTimers() {}, startRuntimeTimers() {} };
      } },
      "./telegram-runtime-composition.mjs": { createTelegramRuntimeComposition: (input) => {
        telegramInput = input;
        return { pollTelegram: () => events.push(["poll"]) };
      } },
      "./agent-hub-bootstrap-composition.mjs": { createAgentHubBootstrapComposition: (input) => {
        bootstrapInput = input; return { start: () => "ready" };
      } },
    });
  const input = {
    config: { dataDir: import.meta.dirname, components: { telegram: true } }, root: import.meta.dirname,
    runtimeCommandRoot: import.meta.dirname, settings: {},
    selection: { hostState: { stopping: false }, providerTitle: () => "Codex", selectedProjectRoot: () => "project" },
    infrastructure: {},
    provider: { taskRuns: runs, taskCatalog: [],
      codexProviderTasks: { discoverTasks: async () => { events.push(["discover"]); return ["thread-exact"]; } },
      backgroundJobs: { restore: () => events.push(["restore"]) } },
    clients: { codexTransport: { running: false } },
    interaction: { dispatchApplicationCommand: async () => ({}), telegramTaskActions: {}, runCoordinator: {
      startDeferred: (item) => events.push(["deferred", item]),
    } },
    deferred: { ports: { bootstrap }, api: {
      backfillWorkLogPricingMetadata: (threads, options) => events.push(["pricing", threads, options.propagateErrors]),
    } },
  };
  const result = createExecutionBootstrapPhase(input);
  assert.equal(result.start(), "ready");
  assert.equal(bootstrap.value.start(), "ready");
  assert.equal(bootstrapInput.runtimeResources, resources);
  assert.equal(bootstrapInput.taskRuns, runs);
  assert.equal(runtimeInput.runtime.taskRuns, runs);
  assert.equal(telegramInput.controller.taskRuns, runs);
  await bootstrapInput.recoverRuns({ provider: "codex" });
  bootstrapInput.pollTelegram();
  bootstrapInput.restoreBackgroundJobs();
  telegramInput.controller.startDeferred({ id: "original-input" });
  assert.deepEqual(events, [["recover", { provider: "codex" }], ["poll"], ["restore"], ["deferred", { id: "original-input" }]]);
  assert.equal(bootstrapInput.providerIsRunning(), false);
  input.clients.codexTransport.running = true;
  assert.equal(bootstrapInput.providerIsRunning(), true);
  const abort = new AbortController(); abort.abort();
  await assert.rejects(bootstrapInput.backfillProviderMetadata({ signal: abort.signal }), { name: "AbortError" });
  assert.equal(events.length, 4, "cancelled optional backfill cannot enter provider discovery");
  await bootstrapInput.backfillProviderMetadata();
  assert.deepEqual(events.slice(-2), [["discover"], ["pricing", ["thread-exact"], true]]);
});
