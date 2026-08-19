import { AgentHubStartupCoordinator } from "../application/agent-hub-startup-coordinator.mjs";
import { RuntimeLifecycleController } from "../runtime/runtime-lifecycle-controller.mjs";
import { sentryDiagnostics } from "../infrastructure/diagnostics/sentry-diagnostics.mjs";

export function createRuntimeLifecycleComposition({
  telegramEnabled,
  beginStopping,
  stopRuntimeTimers,
  stopManagedRuns,
  stopMedia,
  runtimeResources,
  startDesktopControl,
  startRuntimeCommand,
  startHubMcp,
  startMiniApp,
  sanitizeRollouts,
  initializeProvider,
  providerIsRunning,
  backfillProviderMetadata,
  recoverRuns,
  retryNotifications,
  restoreBackgroundJobs,
  startTimers,
  registerTelegramCommands,
  hasPendingRestart,
  finalizeRestart,
  markReady,
  readyMessage,
  pollTelegram,
  warnUser,
  sqliteRecovery,
  acknowledgeSqliteRecovery,
}) {
  if (telegramEnabled) {
    runtimeResources.register("quiesce", {
      name: "Telegram polling",
      run: () => pollTelegram.quiesce?.(),
      timeoutMs: 60_000,
    });
    runtimeResources.register("recover", {
      name: "Telegram polling",
      run: () => pollTelegram.resume?.(),
    });
  }
  const runtimeLifecycle = new RuntimeLifecycleController({
    captureException: (error, context) => sentryDiagnostics.captureException(error, context),
    beginStopping,
    stopTimers: stopRuntimeTimers,
    stopManagedRuns,
    stopMedia,
    resources: runtimeResources,
  });
  const startupCoordinator = new AgentHubStartupCoordinator({
    captureException: (error, context) => sentryDiagnostics.captureException(error, context),
    telegramEnabled,
    startDesktopControl,
    startRuntimeCommand,
    startHubMcp,
    startMiniApp,
    sanitizeRollouts,
    initializeProvider,
    providerIsRunning,
    backfillProviderMetadata,
    recoverRuns,
    retryNotifications,
    restoreBackgroundJobs,
    startTimers,
    registerTelegramCommands,
    hasPendingRestart,
    finalizeRestart,
    markReady,
    readyMessage,
    pollTelegram,
    warnUser,
    sqliteRecovery,
    acknowledgeSqliteRecovery,
  });
  let startPromise = null;
  return {
    startAgentHub() {
      startPromise ??= startupCoordinator.start();
      return startPromise;
    },
    shutdownAgentHub(signal = "shutdown") {
      return runtimeLifecycle.shutdown(signal);
    },
  };
}
