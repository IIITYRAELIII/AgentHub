import assert from "node:assert/strict";
import test from "node:test";
import { importCompositionWithPorts } from "../helpers/composition-ports.fixture.mjs";

test("actual infrastructure forwards the lazy MCP recorder into the existing trace sink", async () => {
  const noop = () => {};
  class Inert {
    instanceToken = "fixture"; deviceId = "fixture"; label = ""; legacyDeviceIds = [];
    async acquire() {} async release() {} async prepare() { return {}; } async load() {} async loadGuide() {}
    hierarchy() { return []; } runMutation(fn) { return fn(); } runtimeHomeId() { return "fixture"; }
    async setLabel() {} async adoptDeviceIds() { return { migrated: 0 }; }
    diagnostics() { return {}; } async recoverPendingTriage() {} task() { return null; }
    updateWorkflowStatus() {} recover() {}
  }
  // Execute the real infrastructure factory; direct startup ports stay inert.
  // No source parsing, actual Hub startup, process, provider, listener or SQLite.
  const modules = {
    "node:fs/promises": { access: async () => {}, mkdir: async () => {},
      readFile: async () => "[utilities]\nparticipantlogin = fixture-owner\n" },
    "../infrastructure/filesystem/test-contour-external-effects.mjs": { createContourExternalEffects: noop },
    "../application/contour-effect-operations.mjs": { reconcileContourAwareStartupGit: async () => ({
      releaseReconciliation: { repositories: [] }, taskGitReconciliation: { repositories: [] },
    }), refreshContourAwareExchangeRate: noop },
    "../application/run-journal-service.mjs": { RunJournalService: Inert },
    "../infrastructure/process/claim-custody-runtime.mjs": { createClaimCustodyRuntime: () => ({}) },
    "../infrastructure/process/task-operation-timing.mjs": { measureTaskOperation: async (_stage, fn) => fn() },
    "../application/task-lifecycle-service.mjs": { TaskLifecycleService: Inert },
    "../application/native-merge-review.mjs": { createNativeMergeReviewVerifier: () => noop },
    "../application/work-log-usage-store.mjs": { createWorkLogUsageStore: async () => new Inert() },
    "../application/task-board-service.mjs": { TaskBoardService: Inert },
    "../application/task-release-plan-service.mjs": { TaskReleasePlanService: Inert },
    "../application/workspace-release-preflight-service.mjs": { WorkspaceReleasePreflightService: Inert },
    "./release-operation-composition.mjs": { createReleaseOperationServices: () => ({ operations: new Inert(), commands: {} }) },
    "../infrastructure/persistence/release-operation-legacy-import.mjs": { importLegacyReleaseOperations: async () => {} },
    "../application/stream-handoff-service.mjs": { StreamHandoffService: Inert },
    "../infrastructure/filesystem/agent-hub-package.mjs": { AGENT_HUB_VERSION: "2.0.2" },
    "../infrastructure/filesystem/config.mjs": { samePath: (a, b) => a === b },
    "../infrastructure/filesystem/task-git-workspace.mjs": { TaskGitWorkspaceService: Inert },
    "../infrastructure/filesystem/release-git-workspace.mjs": { ReleaseGitWorkspaceService: Inert },
    "../infrastructure/media/attachment-thumbnail-service.mjs": { AttachmentThumbnailService: Inert },
    "../infrastructure/persistence/pre-turn-instruction-store.mjs": { PreTurnInstructionStore: Inert },
    "../infrastructure/persistence/rotating-log.mjs": { installRotatingConsole: noop },
    "../infrastructure/persistence/task-operation-timing-log.mjs": { createTaskOperationTimingLogRecorder: () => noop },
    "../infrastructure/persistence/shared-sqlite-recovery.mjs": { SharedSqliteRecoveryCoordinator: Inert },
    "../infrastructure/persistence/trusted-device-store.mjs": { TrustedDeviceStore: Inert },
    "../infrastructure/persistence/workspace-catalog-store.mjs": { WorkspaceCatalogStore: Inert },
    "../infrastructure/persistence/task-board-store.mjs": { TaskBoardStore: Inert },
    "../runtime/work-log-usage-sync-worker-client.mjs": { WorkLogUsageSyncWorkerStore: Inert },
    "../infrastructure/persistence/usage-sync-identity-store.mjs": { UsageSyncIdentityStore: Inert },
    "../infrastructure/persistence/usage-sync-remote-config-store.mjs": { UsageSyncRemoteConfigStore: Inert },
    "../infrastructure/process/instance-lock.mjs": { SingleInstanceGuard: Inert },
    "../infrastructure/process/repository-production-validation.mjs": { createRepositoryProductionValidationAdapter: () => ({}) },
    "../application/runtime-health.mjs": { agentHubRuntimeHealth: { setDiagnosticSource: noop } },
    "../interfaces/web/local-web-auth.mjs": { ensureLocalWebSecret: async () => "synthetic" },
    "../interfaces/web/trusted-device-access.mjs": { TrustedDeviceRegistry: Inert },
    "../providers/codex/codex-rollout-context.mjs": { CodexRolloutContextSanitizer: Inert },
    "../providers/codex/codex-spark-task-classifier.mjs": { CodexSparkTaskClassifier: Inert, ensureDashBotStream: () => ({ id: "fixture" }) },
    "../providers/codex/codex-terra-voice-transcriber.mjs": { CodexTerraVoiceTranscriber: Inert, ensureDashBotTerraStream: () => ({ id: "fixture" }) },
    "../infrastructure/diagnostics/sentry-diagnostics.mjs": { sentryDiagnostics: { configure: noop, captureException: noop } },
    "./persistence-mutation-composition.mjs": { createPersistenceMutationCapabilities: ({ rawWorkspaceCatalogStore, rawTaskBoardStore }) => ({
      workspaceCatalogStore: rawWorkspaceCatalogStore, taskBoardStore: rawTaskBoardStore,
    }) },
    "../interfaces/mcp/hub-mcp-server.mjs": { HubMcpServer: Inert },
  };
  let mcpOptions, miniAppOptions, releaseOptions;
  const spans = [];
  const reached = new Error("owned trace initialization boundary");
  const trace = {
    recordBestEffort(span) { assert.equal(this, trace); spans.push(span); return true; },
  };
  let closed = 0;
  const mcpSpan = { commandId: "release:original:7:operation.progress", stage: "release-event-intake", outcome: "started" };
  const miniAppSpan = { commandId: "existing-mini-app", stage: "intake", outcome: "started" };
  const releaseSpan = { commandId: "original-release", stage: "release-persistence", outcome: "failed" };
  modules["./release-operation-composition.mjs"] = { createReleaseOperationServices: options => {
    releaseOptions = options;
    assert.equal(typeof options.recordCommandTrace, "function");
    assert.equal(options.recordCommandTrace(releaseSpan), false);
    return { operations: new Inert(), commands: {} };
  } };
  modules["../application/hub-mcp-service.mjs"] = { HubMcpService: class {
    constructor(options) {
      mcpOptions = options;
      assert.equal(typeof options.recordCommandTrace, "function");
      assert.equal(options.recordCommandTrace(mcpSpan), false, "the existing sink is not initialized yet");
    }
  } };
  modules["../interfaces/web/mini-app-server.mjs"] = { MiniAppServer: class {
    constructor(options) { miniAppOptions = options; }
  } };
  modules["./command-trace-composition.mjs"] = {
    measureStartupBeforeTrace: async (_stage, fn) => ({ value: await fn(), record: noop }),
    createCommandTraceComposition: () => ({ service: trace,
      initialize: async () => {
        assert.equal(mcpOptions.recordCommandTrace(mcpSpan), true);
        assert.equal(miniAppOptions.recordCommandTrace(miniAppSpan), true, "the existing MiniApp recorder still works");
        assert.equal(spans[0], mcpSpan, "forward the original span unchanged to the existing sink");
        assert.equal(spans[1], miniAppSpan);
        assert.equal(releaseOptions.recordCommandTrace(releaseSpan), true);
        assert.equal(spans[2], releaseSpan);
        throw reached;
      }, close: async () => { closed += 1; },
    }),
  };
  const { createHubInfrastructure } = await importCompositionWithPorts(
    new URL("../../src/composition/infrastructure-composition.mjs", import.meta.url), modules);
  const root = "D:/unused-synthetic-root";
  await assert.rejects(createHubInfrastructure({
    config: { dataDir: root + "/data", projectRoot: root, diagnostics: { sentry: {} },
      taskBoard: { triageEnabled: false }, miniApp: { enabled: true, quickTunnel: { enabled: false }, fileTransfer: { enabled: false } },
      projects: [], components: {},
    }, agentHubRoot: root, runtimeCommandRoot: root, journalDatabaseFile: root + "/journal.sqlite",
    instanceLockFile: root + "/instance.lock", stateFile: root + "/state.json", globalWorkLogProjectRoots: [],
  }), error => error === reached);
  assert.deepEqual(spans, [mcpSpan, miniAppSpan, releaseSpan]);
  assert.equal(closed, 1, "the owned trace fixture is drained at the sentinel boundary");
});
