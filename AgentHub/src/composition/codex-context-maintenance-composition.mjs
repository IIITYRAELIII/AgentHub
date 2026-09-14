import { CodexContextMaintenanceService } from "../providers/codex/codex-context-maintenance-service.mjs";
import {
  CODEX_CONTEXT_PROBE_PROMPT,
  codexContextProbeClientId,
} from "../domain/codex-context-probe.mjs";
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
  normalizeCodexModel,
  preserveProbeTitle = async () => {},
  logger = console,
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
    preserveProbeTitle,
    logger,
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
    startContextProbe: async (threadId, target = null) => {
      try {
        await preserveProbeTitle({
          provider: "codex",
          threadId,
          titleSourceThreadId: target?.titleSourceThreadId,
        });
      }
      catch (error) { logger.warn?.(`Cannot preserve Thread title before context probe: ${error.message}`); }
      return sendRpc("turn/start", {
        threadId,
        input: [{ type: "text", text: CODEX_CONTEXT_PROBE_PROMPT }],
        clientUserMessageId: codexContextProbeClientId(),
      });
    },
    interruptContextProbe: (threadId, turnId) => sendRpc("turn/interrupt", {
      threadId,
      turnId,
    }),
    startThread: (params) => sendRpc("thread/start", {
      ...params,
      ...(params.model ? { model: normalizeCodexModel(params.model) } : {}),
    }),
    injectItems: (threadId, items) => sendRpc("thread/inject_items", { threadId, items }),
    deleteThread: (threadId) => sendRpc("thread/delete", { threadId }),
    sandboxSettings: () => codexThreadSandboxSettings(config.codexSandboxMode),
  });
}
