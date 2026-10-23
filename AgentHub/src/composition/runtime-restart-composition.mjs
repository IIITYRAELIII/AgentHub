import path from "node:path";
import process from "node:process";
import { RestartNotificationService } from "../interfaces/telegram/restart-notification-service.mjs";
import { RuntimeResourceRegistry } from "../runtime/runtime-resource-registry.mjs";
import { RuntimeRestartController } from "../runtime/runtime-restart-controller.mjs";
import {
  botReplacementInvocation,
  launchReplacementAndWait,
} from "../runtime/runtime-restart.mjs";
import {
  finalizeSuccessfulReplacement,
  restorePreviousBotAfterFailedReplacement,
} from "../runtime/restart-recovery.mjs";
import { readFile } from "node:fs/promises";
import { sentryDiagnostics } from "../infrastructure/diagnostics/sentry-diagnostics.mjs";

export function createRuntimeRestartComposition({
  getRestartRequest,
  setRestartRequest,
  completeRestartOperation = () => {},
  checkpointRestartOperation = async () => {},
  failRestartOperation = () => {},
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
  storageRetention = null,
  telegramDeliveryService,
  mediaController,
  taskSyncStore,
  taskDiffs,
  messagePins,
  workspaceCatalogStore,
  deliveryOutbox,
  backgroundJobStore,
  failedUpdateStore,
  stopCodexAppServerTree,
  miniAppLifecycle,
  desktopAttachments,
  desktopControlServer,
  runtimeCommandServer,
  hubMcpServer,
  instanceGuard,
  workLogUsageStore,
  rateLimitHistoryStore,
  providerTurnTelemetryStore,
  fileTransferService,
  taskReadStateStore,
  runtimeStateStore,
  commandTrace,
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
    completeOperation: completeRestartOperation,
  });

  const runtimeResources = new RuntimeResourceRegistry({
    captureException: (error, context) => sentryDiagnostics.captureException(error, context),
    quiesce: [
      { name: "file transfer", run: () => fileTransferService?.quiesce() },
    ],
    drain: [
      { name: "storage retention", run: () => storageRetention?.close?.() },
      { name: "journal startup", run: () => journalStartupReady },
      { name: "state writes", run: () => runtimeStateCoordinator.flush() },
      { name: "message binding writes", run: () => telegramDeliveryService.waitForBindingWrites() },
      { name: "media writes", run: () => mediaController.waitForWrites() },
      { name: "task sync", run: () => taskSyncStore.save() },
      ...(taskDiffs ? [{ name: "task diffs", run: () => taskDiffs.flush() }] : []),
      { name: "delivery outbox", run: () => deliveryOutbox.waitForIdle({ flush: true }) },
      { name: "background jobs", run: () => backgroundJobStore.waitForWrites() },
      { name: "failed updates", run: () => failedUpdateStore.waitForWrites() },
    ],
    close: [
      { name: "Codex App Server", run: stopCodexAppServerTree },
      { name: "Shared Dashboard bot", run: () => miniAppLifecycle.closeSharedDashboardBot?.() },
      { name: "Mini App publisher", run: () => miniAppLifecycle.closePublisher() },
      {
        name: "direct gateway",
        run: () => miniAppLifecycle.closeDirectGateway(),
        preserveOnRestart: true,
      },
      { name: "quick tunnel", run: () => miniAppLifecycle.closeQuickTunnel() },
      { name: "public Mini App", run: () => miniAppLifecycle.closePublicServer() },
      { name: "local Mini App", run: () => miniAppLifecycle.closeLocalServer() },
      { name: "Desktop control", run: () => desktopControlServer()?.close() },
      { name: "Desktop attachments", run: () => desktopAttachments?.close() },
      { name: "runtime command", run: () => runtimeCommandServer.close() },
      { name: "Agent Hub MCP", run: () => hubMcpServer.close() },
    ],
    releaseLock: [
      { name: "instance lock", run: () => instanceGuard.release() },
    ],
    recover: [
      { name: "file transfer", run: () => fileTransferService?.resume() },
    ],
    finalize: [
      { name: "work log usage", run: () => workLogUsageStore.close() },
      { name: "rate limit history", run: () => rateLimitHistoryStore.close() },
      { name: "provider turn telemetry", run: () => providerTurnTelemetryStore?.close?.() },
      { name: "file transfer", run: () => fileTransferService?.close?.() },
      { name: "task sync store", run: () => taskSyncStore.close() },
      { name: "message pin store", run: () => messagePins?.close?.() },
      { name: "workspace catalog store", run: () => workspaceCatalogStore.close() },
      { name: "task read-state store", run: () => taskReadStateStore.close() },
      { name: "command trace", run: () => commandTrace?.close?.() },
      { name: "runtime state store", run: () => runtimeStateStore.close() },
    ],
  });

  const runtimeRestart = new RuntimeRestartController({
    captureException: (error, context) => sentryDiagnostics.captureException(error, context),
    measure: (id, stage, action) => commandTrace?.measureBestEffort
      ? commandTrace.measureBestEffort({ commandId: id, stage: `restart-${stage}`, transport: "runtime" }, action)
      : action(),
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
    resumeAfterAbort: () => startRuntimeTimers(),
    launchReplacement: async () => {
      const operationId = getRestartRequest()?.operationId;
      const pointer = JSON.parse(await readFile(path.join(agentHubRoot, "..", "..", "current.json"), "utf8").catch(() => "{}"));
      const expectedReleaseId = pointer.current ?? process.env.AGENT_HUB_RELEASE_ID ?? "";
      if (process.env.AGENT_HUB_LAUNCHER && !pointer.current) throw new Error("Restart has no exact current release");
      await checkpointRestartOperation(operationId, "launching", { expectedReleaseId, oldPid: process.pid });
      const invocation = botReplacementInvocation({
        botFile: path.join(agentHubRoot, "agent-hub-main.mjs"),
        agentHubRoot,
        environment: { ...process.env, AGENT_HUB_RESTART_OPERATION_ID: operationId ?? "" },
      });
      return launchReplacementAndWait({ invocation, lockFile: instanceLockFile,
        expectedReleaseId, expectedOperationId: operationId ?? "",
        measure: (stage, action) => commandTrace?.measureBestEffort
          ? commandTrace.measureBestEffort({ commandId: operationId, stage: `restart-${stage}`,
            transport: "runtime", metadata: { expectedReleaseId, oldPid: process.pid } }, action)
          : action(),
      });
    },
    recoverPrevious: (error, { lockReleased }) => restorePreviousBotAfterFailedReplacement({
      replacementError: error,
      acquireLock: () => (lockReleased ? instanceGuard.acquire() : undefined),
      startCommandServer: async () => {
        await runtimeCommandServer.start();
        await hubMcpServer.start();
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
      failRestartOperation,
      clearRestartRequest: () => setRestartRequest(null),
      saveState,
      startTimers: startRuntimeTimers,
      markReady: () => instanceGuard.markReady(),
    }),
    abortRestart: async (error) => {
      setStopping(false);
      await failRestartOperation(error);
      setRestartRequest(null);
      let saveError = null;
      try {
        await saveState();
      } catch (stateError) {
        saveError = stateError;
      }
      await updateRestartMessage(
        `⚠️ Перезапуск отменён: ${error.message}\n\nAgent Hub продолжает работу.`,
      ).catch(() => {});
      if (saveError) throw saveError;
    },
    finishSuccessfulReplacement: async () => {
      await delay(500);
      process.exit(0);
    },
  });

  return { restartNotifications, runtimeResources, runtimeRestart };
}
