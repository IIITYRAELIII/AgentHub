import process from "node:process";
import { DesktopControlServer } from "../../desktop-control.mjs";
import { createRuntimeLifecycleComposition } from "./runtime-lifecycle-composition.mjs";

export function createAgentHubBootstrapComposition({
  config,
  runtimeCommandRoot,
  handleDesktopControl,
  runtimeCommandServer,
  stopRuntimeTimers,
  taskRuns,
  agentProviders,
  mediaController,
  runtimeResources,
  miniAppLifecycle,
  sanitizeRollouts,
  initializeProvider,
  providerIsRunning,
  backfillProviderMetadata,
  recoverRuns,
  retryNotifications,
  restoreBackgroundJobs,
  startRuntimeTimers,
  registerTelegramCommands,
  hasPendingRestart,
  finalizeRestart,
  markReady,
  readyMessage,
  pollTelegram,
  warnUser,
  beginStopping,
  createDesktopControlServer = (options) => new DesktopControlServer(options),
}) {
  let desktopControlServer = null;
  const lifecycle = createRuntimeLifecycleComposition({
    telegramEnabled: config.telegramEnabled,
    beginStopping,
    stopRuntimeTimers,
    stopManagedRuns: () => {
      for (const run of taskRuns.values()) {
        agentProviders.call(run.provider, "stopManagedRunForShutdown", run);
      }
    },
    stopMedia: () => mediaController.stop(),
    runtimeResources,
    // The control endpoint is intentionally available before provider recovery,
    // so clients can show cached state while providers are still reconnecting.
    startControlPlane: async () => {
      desktopControlServer = createDesktopControlServer({
        runtimeRoot: runtimeCommandRoot,
        handler: handleDesktopControl,
        protectSecret: process.env.AGENT_HUB_DISABLE_SECRET_ACL === "1"
          ? async () => {}
          : undefined,
      });
      await desktopControlServer.start();
      await runtimeCommandServer.start();
    },
    startMiniApp: () => miniAppLifecycle.start(),
    sanitizeRollouts,
    initializeProvider,
    providerIsRunning,
    backfillProviderMetadata,
    recoverRuns,
    retryNotifications,
    restoreBackgroundJobs,
    startTimers: startRuntimeTimers,
    registerTelegramCommands,
    hasPendingRestart,
    finalizeRestart,
    markReady,
    readyMessage,
    pollTelegram,
    warnUser,
  });

  return {
    ...lifecycle,
    desktopControlServer: () => desktopControlServer,
  };
}
