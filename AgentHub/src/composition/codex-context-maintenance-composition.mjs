import { CodexContextMaintenanceService } from "../providers/codex/codex-context-maintenance-service.mjs";
import { codexThreadSandboxSettings } from "../providers/codex/codex-sandbox.mjs";

export function createCodexContextMaintenanceComposition({
  config,
  runtimeTimers,
  contextCompactions,
  sanitizer,
  isStopping,
  transportRunning,
  activeRuns,
  runIsActive,
  refreshTaskCatalog,
  knownRolloutPath,
  readThread,
  rememberRolloutPath,
  stopTransport,
  startTransport,
  initializeTransport,
  providerIsSelected,
  setTransportRestarting,
  invalidateTaskCatalog,
  restartTransportAfterCrash,
  runForTask,
  sendRpc,
}) {
  return new CodexContextMaintenanceService({
    timers: runtimeTimers,
    compactions: contextCompactions,
    sanitizer,
    contextCleanupEnabled: () => config.components.codexContextCleanup,
    periodicCleanupEnabled: () => config.codexRolloutContext.enabled,
    // Temporarily disabled: recycling an App Server immediately after compaction
    // can leave the compaction UI waiting. Periodic sanitation remains enabled.
    compactionTriggeredCleanupEnabled: false,
    scanIntervalMs: () => config.codexRolloutContext.scanIntervalSeconds * 1_000,
    isStopping,
    transportRunning,
    activeRuns,
    runIsActive,
    refreshTaskCatalog,
    knownRolloutPath,
    readThread,
    rememberRolloutPath,
    stopTransport,
    startTransport,
    initializeTransport,
    providerIsSelected,
    setTransportRestarting,
    invalidateTaskCatalog,
    restartTransportAfterCrash,
    runForTask,
    ensureTransport: async () => {
      if (transportRunning()) return;
      await startTransport();
      await initializeTransport({ attachSelectedThread: false });
    },
    resumeThread: (threadId, sandbox) => sendRpc("thread/resume", {
      threadId,
      ...sandbox,
    }),
    startCompaction: (threadId) => sendRpc("thread/compact/start", { threadId }),
    sandboxSettings: () => codexThreadSandboxSettings(config.codexSandboxMode),
  });
}
