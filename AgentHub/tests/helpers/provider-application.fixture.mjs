import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { importCompositionWithPorts } from "./composition-ports.fixture.mjs";

export async function providerApplicationFixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hub345-provider-phase-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const inputs = {};
  const events = [];
  const runs = [];
  const deferred = [];
  const runRegistry = { values: () => [...runs], forTask: () => runs[0] ?? null, get size() { return runs.length; } };
  const deferredRegistry = { diagnostics: () => [...deferred], get size() { return deferred.length; } };
  const context = { provider: "codex", tokens: 23 };
  const returns = {
    createProviderProcessComposition: { resolveClaudeInvocation: () => ({ command: "fixture-claude" }) },
    createRunAccountingComposition: {},
    createRuntimeDataComposition: { taskRuns: runRegistry, deferredInputs: deferredRegistry,
      streamMaintenance: { begin() {}, end() {} }, lastSeenTaskTurnIds: new Map() },
    createStorageRetentionComposition: {},
    createCodexObservabilityComposition: { usageTracker: {
      latestExactContext: () => context, waitForContextUpdate() {},
    }, compactions: { begin() {}, complete() {} } },
    createRunCompletionComposition: { managedRunLifecycle: { begin() {}, complete() {} }, turnEndDelivery: {
      correctFromExactProviderTerminal: (...args) => { events.push(["correct", ...args]); return "corrected"; },
    } },
    createCodexContextMaintenanceComposition: { start() {}, rotate() {}, rotateCompacted() {} },
    createBackgroundWorkComposition: {}, createJournalBackfillComposition: {}, createClaudeTranscriptAuditComposition: {},
    createTaskCatalogFinalizationComposition: {}, createProviderSnapshotComposition: {},
    createProviderOperationComposition: { codexProviderTasks: {} },
    createProviderCatalogComposition: { taskCatalog: [{ provider: "codex", threadId: "thread-exact" }], agentProviders: {} },
    createProviderStartupComposition: { discover: () => events.push(["discover"]) },
  };
  const names = {
    "provider-process": "createProviderProcessComposition", "run-accounting": "createRunAccountingComposition",
    "runtime-data": "createRuntimeDataComposition", "storage-retention": "createStorageRetentionComposition",
    "codex-observability": "createCodexObservabilityComposition", "run-completion": "createRunCompletionComposition",
    "codex-context-maintenance": "createCodexContextMaintenanceComposition", "background-work": "createBackgroundWorkComposition",
    "journal-backfill": "createJournalBackfillComposition", "claude-transcript-audit": "createClaudeTranscriptAuditComposition",
    "task-catalog-finalization": "createTaskCatalogFinalizationComposition", "provider-snapshot": "createProviderSnapshotComposition",
    "provider-operation": "createProviderOperationComposition", "provider-catalog": "createProviderCatalogComposition",
    "provider-startup": "createProviderStartupComposition",
  };
  const modules = Object.fromEntries(Object.entries(names).map(([file, factory]) => [
    `./${file}-composition.mjs`, { [factory]: (options) => { inputs[factory] = options; return returns[factory]; } },
  ]));
  modules["../application/runtime-health.mjs"] = { agentHubRuntimeHealth: {
    setDiagnosticSource() {}, snapshot: () => ({ ready: false }),
  } };
  const { createProviderApplicationComposition } = await importCompositionWithPorts(
    new URL("../../src/composition/provider-application-composition.mjs", import.meta.url), modules);
  const mcp = {};
  const state = { hostState: { stopping: false }, agentPreferences: {},
    selectedProvider: () => "codex", selectedProjectRoot: () => directory,
    selectedThreadId: () => "thread-exact", selectedTaskTitle: () => "Exact task", isCodex: () => true };
  const result = await createProviderApplicationComposition({
    config: { dataDir: directory, projectRoot: directory, contextAutomation: {} },
    constants: { projects: [], providerModelCatalog: { refreshCodex: (...args) => events.push(["models", ...args]) } }, state,
    infrastructure: {
      workLogUsageStore: { usageSyncSnapshot() {} }, workLogUsageIdentityStore: { deviceId: "fixture-device" },
      workLogUsageRemoteConfigStore: { load() {} }, workspaceCatalogStore: {},
      hubMcpService: { setActiveRuns: (read) => { mcp.activeRuns = read; }, setDeferredInputs: (read) => { mcp.deferredInputs = read; } },
    }, taskServices: {},
    api: { saveState: async () => events.push(["save"]), launchTurn() {}, startCodexAppServer() {}, initializeCodex() {} },
    late: {}, ports: { providerStartup: { bind: (value) => value } },
  });
  return { result, inputs, mcp, runs, deferred, events, state, runRegistry, deferredRegistry };
}
