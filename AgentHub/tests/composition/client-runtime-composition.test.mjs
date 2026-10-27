import assert from "node:assert/strict";
import test from "node:test";
import { importCompositionWithPorts, boundPort } from "../helpers/composition-ports.fixture.mjs";

test("client runtime restores receipts through bound presentation and shares persistence with lifecycle", async () => {
  const events = [];
  const ports = Object.fromEntries(["deferredInputPresentation", "taskState", "runtimeFacades", "statePersistence",
    "codexLifecycle", "codexTaskSettings", "runtimeCommand"].map((key) => [key, boundPort()]));
  ports.telegramDelivery = { api: { sendTaskSelectionNotification() {} } };
  const context = { threadId: "restored-thread", tokens: 42 };
  const saved = [];
  let lifecycle;
  let client;
  const { createClientRuntimeComposition } = await importCompositionWithPorts(
    new URL("../../src/composition/client-runtime-composition.mjs", import.meta.url), {
      "./client-interface-composition.mjs": { createClientInterfaceComposition: async (options) => {
        client = options;
        return { deferredInputPresentation: {
          updateTelegramMessage: (...args) => events.push(["telegram", ...args]),
          updateDesktopReceipt: (...args) => events.push(["desktop", ...args]),
        }, providerLogin: { observeCodexMessage: (message) => events.push(["login", message]) } };
      } },
      "./delivery-outbox-composition.mjs": { createDeliveryOutboxComposition: async () => ({}) },
      "./task-state-wiring-composition.mjs": { createTaskStateWiring: () => ({}) },
      "./runtime-facades-composition.mjs": { createRuntimeFacadesComposition: () => ({}) },
      "./runtime-state-bootstrap-wiring-composition.mjs": { createRuntimeStateBootstrapWiring: async () => {
        ports.deferredInputPresentation.value.updateDeferredDesktopReceipt("client-original", "accepted");
        ports.deferredInputPresentation.value.updateDeferredMessage("chat", "original");
        return { runtimeStateCoordinator: { save: () => saved.push("durable") } };
      } },
      "./state-persistence-composition.mjs": { createStatePersistenceComposition: (options) => ({
        saveState: () => options.runtimeStateCoordinator.save(),
      }) },
      "./codex-lifecycle-composition.mjs": { createCodexLifecycleComposition: (options) => {
        lifecycle = options; return { runtime: {}, transport: {}, controller: {} };
      } },
      "./codex-task-settings-composition.mjs": { createCodexTaskSettingsComposition: () => ({}) },
      "./runtime-command-routing-composition.mjs": { createRuntimeCommandRoutingComposition: () => ({}) },
    });
  const state = { hostState: { chatId: "chat", stopping: false }, agentPreferences: { includeClaudeUsage: true },
    selectedProvider: () => "codex", selectedThreadId: () => "restored-thread", isCodex: () => true };
  const api = { saveState: () => ports.statePersistence.value.saveState(),
    handleCodexMessage: (message) => events.push(["provider", message]) };
  await createClientRuntimeComposition({ config: { deliveryRetryIntervalSeconds: 1 }, constants: {}, state,
    infrastructure: { workLogUsageStore: { setIncludeClaudeUsage: (value) => events.push(["usage", value]) } },
    provider: { taskRuns: { values: () => [{ id: "run-exact" }] },
      codexUsageTracker: { contexts: new Map([["restored-thread", context]]) },
      contextCompactions: { observeContext: (value) => events.push(["context", value]) },
      hubThreadNaming: { recoverThreadNaming() {} } }, tasks: {}, api, late: {}, ports });
  assert.deepEqual(events.slice(0, 4), [["desktop", "client-original", "accepted"], ["telegram", "chat", "original"],
    ["context", context], ["usage", true]]);
  assert.equal(client.runExists("run-exact"), true);
  assert.equal(client.runExists("foreign-run"), false);
  await lifecycle.controllerDependencies.saveState();
  assert.deepEqual(saved, ["durable"]);
  lifecycle.runtimeDependencies.handleMessage({ turnId: "turn-exact" });
  assert.deepEqual(events.slice(-2), [["login", { turnId: "turn-exact" }], ["provider", { turnId: "turn-exact" }]]);
  state.hostState.stopping = true;
  assert.equal(lifecycle.runtimeDependencies.isStopping(), true);
});
