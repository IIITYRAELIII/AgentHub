import path from "node:path";
import process from "node:process";
import { RestartNotificationService } from "../interfaces/telegram/restart-notification-service.mjs";
import { RuntimeResourceRegistry } from "../runtime/runtime-resource-registry.mjs";
import { RuntimeRestartController } from "../runtime/runtime-restart-controller.mjs";
import {
  botReplacementInvocation,
  directWindowsLauncherInvocation,
  launchReplacementAndWait,
} from "../runtime/runtime-restart.mjs";
import {
  finalizeSuccessfulReplacement,
  restorePreviousBotAfterFailedReplacement,
} from "../runtime/restart-recovery.mjs";

export function createRuntimeRestartComposition({
  getRestartRequest,
  setRestartRequest,
  isStopping,
  setStopping,
  beginStopping,
  sendMessage,
  telegram,
  saveState,
  formatRestartCompleteMessage,
  completeMessageState,
  botMenu,
  journalStartupReady,
  runtimeStateCoordinator,
  telegramDeliveryService,
  mediaController,
  taskSyncStore,
  deliveryOutbox,
  backgroundJobStore,
  failedUpdateStore,
  stopCodexAppServerTree,
  miniAppLifecycle,
  desktopControlServer,
  runtimeCommandServer,
  instanceGuard,
  workLogUsageStore,
  rateLimitHistoryStore,
  taskReadStateStore,
  runtimeStateStore,
  updateOffset,
  hasBlockingWork,
  setWaiting,
  stopRuntimeTimers,
  agentHubRoot,
  instanceLockFile,
  isCodex,
  taskRuns,
  startCodexAppServer,
  initializeCodex,
  runRecovery,
  updateRestartMessage,
  startRuntimeTimers,
  delay,
}) {
  const restartNotifications = new RestartNotificationService({
    getRequest: getRestartRequest,
    setRequest: setRestartRequest,
    isStopping,
    sendMessage,
    telegram,
    saveState,
    formatCompleteMessage: formatRestartCompleteMessage,
    completeMessageState,
    menu: botMenu,
    finalizeReplacement: finalizeSuccessfulReplacement,
  });

  const runtimeResources = new RuntimeResourceRegistry({
    flush: [
      { name: "journal startup", run: () => journalStartupReady },
      { name: "state writes", run: () => runtimeStateCoordinator.flush() },
      { name: "message binding writes", run: () => telegramDeliveryService.waitForBindingWrites() },
      { name: "media writes", run: () => mediaController.waitForWrites() },
      { name: "task sync", run: () => taskSyncStore.save() },
      { name: "delivery outbox", run: () => deliveryOutbox.waitForWrites() },
      { name: "background jobs", run: () => backgroundJobStore.waitForWrites() },
      { name: "failed updates", run: () => failedUpdateStore.waitForWrites() },
    ],
    suspend: [
      { name: "Codex App Server", run: stopCodexAppServerTree },
      { name: "Mini App publisher", run: () => miniAppLifecycle.closePublisher() },
      { name: "direct gateway", run: () => miniAppLifecycle.closeDirectGateway() },
      { name: "quick tunnel", run: () => miniAppLifecycle.closeQuickTunnel() },
      { name: "public Mini App", run: () => miniAppLifecycle.closePublicServer() },
      { name: "local Mini App", run: () => miniAppLifecycle.closeLocalServer() },
      { name: "Desktop control", run: () => desktopControlServer()?.close() },
      { name: "runtime command", run: () => runtimeCommandServer.close() },
      { name: "instance lock", run: () => instanceGuard.release() },
    ],
    finalize: [
      { name: "work log usage", run: () => workLogUsageStore.close() },
      { name: "rate limit history", run: () => rateLimitHistoryStore.close() },
      { name: "task sync store", run: () => taskSyncStore.close() },
      { name: "task read-state store", run: () => taskReadStateStore.close() },
      { name: "runtime state store", run: () => runtimeStateStore.close() },
    ],
  });

  const runtimeRestart = new RuntimeRestartController({
    getRequest: getRestartRequest,
    updateOffset,
    hasBlockingWork,
    setWaiting,
    updateMessage: updateRestartMessage,
    saveState,
    resources: runtimeResources,
    isStopping,
    beginStopping,
    stopTimers: stopRuntimeTimers,
    stopMedia: () => mediaController.stop(),
    launchReplacement: async () => {
      const invocation = botReplacementInvocation({
        botFile: path.join(agentHubRoot, "agent-hub-main.mjs"),
        agentHubRoot,
      });
      const launcher = String(process.env.AGENT_HUB_LAUNCHER ?? "").trim();
      const fallbackInvocation = process.platform === "win32" && launcher
        ? directWindowsLauncherInvocation({ launcher })
        : null;
      return launchReplacementAndWait({ invocation, fallbackInvocation, lockFile: instanceLockFile });
    },
    recoverPrevious: (error) => restorePreviousBotAfterFailedReplacement({
      replacementError: error,
      acquireLock: () => instanceGuard.acquire(),
      startCommandServer: async () => {
        await runtimeCommandServer.start();
        await desktopControlServer()?.start();
        await miniAppLifecycle.start();
      },
      setStopping,
      restoreProvider: async () => {
        if (isCodex() || taskRuns.values().some((run) => run.provider === "codex")) {
          await startCodexAppServer();
          await initializeCodex({ attachSelectedThread: isCodex() });
        }
      },
      recoverRuns: (...args) => runRecovery.recoverAll(...args),
      updateMessage: (message) => updateRestartMessage(message).catch(() => {}),
      clearRestartRequest: () => setRestartRequest(null),
      saveState,
      startTimers: startRuntimeTimers,
      markReady: () => instanceGuard.markReady(),
    }),
    finishSuccessfulReplacement: async () => {
      await delay(500);
      process.exit(0);
    },
  });

  return { restartNotifications, runtimeResources, runtimeRestart };
}
