import { canonicalizeProjectRoots, findContainingProject, samePath } from "../infrastructure/filesystem/config.mjs";
import { taskGitDiff } from "../infrastructure/filesystem/task-git-diff.mjs";
import { contextualCallback } from "../interfaces/telegram/callback-context.mjs";
import {
  formatClaudeRateLimits,
  formatCodexRateLimits,
} from "../interfaces/telegram/status.mjs";
import { parseClaudeLimits } from "../providers/claude/claude.mjs";
import { readCodexRolloutActivity } from "../providers/codex/codex-rollout-activity.mjs";
import { readCodexTurnUsage } from "../providers/codex/codex-turn-usage.mjs";
import { catalogEntryIsSelected } from "../domain/task-catalog-identity.mjs";
import { restartRequestProjection } from "../domain/maintenance-operation.mjs";
import { readCodexThreadTitleHistory } from "../../send-message.mjs";
import { createClientInterfaceComposition } from "./client-interface-composition.mjs";
import { createCodexLifecycleComposition } from "./codex-lifecycle-composition.mjs";
import { createCodexTaskSettingsComposition } from "./codex-task-settings-composition.mjs";
import { createDeliveryOutboxComposition } from "./delivery-outbox-composition.mjs";
import { createRuntimeCommandRoutingComposition } from "./runtime-command-routing-composition.mjs";
import { createRuntimeFacadesComposition } from "./runtime-facades-composition.mjs";
import { createRuntimeStateBootstrapWiring } from "./runtime-state-bootstrap-wiring-composition.mjs";
import { createStatePersistenceComposition } from "./state-persistence-composition.mjs";
import { createTaskStateWiring } from "./task-state-wiring-composition.mjs";

export async function createClientRuntimeComposition({
  config,
  constants,
  state,
  infrastructure,
  provider,
  tasks,
  api,
  late,
  ports,
}) {
  const {
    token,
    botMenu,
    statusHeaderDirectory,
    telegramLimit,
    deliveryOutboxDirectory,
    maximumDeferredInputs,
    pinnedTaskTitlesFile,
    projects,
    codexModels,
    claudeModels,
    claudeModelLabels,
    reasoningEfforts,
    reasoningLabels,
    claudeReasoningEfforts,
    claudeReasoningLabels,
    collaborationModes,
    collaborationModeLabels,
    agentHubRoot,
    runtimeCommandRoot,
    journalDatabaseFile,
    codexRpcTimeoutMs,
  } = constants;
  const {
    hostState,
    selectionStore,
    taskMetadata,
    agentPreferences,
    selectedProvider,
    selectedProjectRoot,
    selectedThreadId,
    selectedTaskTitle,
    isCodex,
  } = state;
  const {
    miniAppServer,
    publicMiniAppServer,
    attachmentThumbnails,
    trustedDeviceStore,
    rateLimitHistoryStore,
    workLogUsageStore,
    taskBoard,
    hubMcpServer,
    mcpAdmissionCoordinator,
    runtimeStateStore,
    turnEndNotifications,
    runJournal,
    runtimeNotificationController,
  } = infrastructure;
  const {
    runtimeTimers,
    resolveClaudeInvocation,
    spawnCapture,
    taskRuns,
    statusMediaFileIds,
    desktopMessageReceipts,
    taskSyncStore,
    workspaceCatalogStore,
    taskDiffs,
    deferredInputs,
    pendingInputs,
    queuedInputs,
    forwardBundles,
    dismissedExternalTasks,
    cancelledManagedClaudeTasks,
    lastSeenTaskTurnIds,
    codexUsageTracker,
    contextCompactions,
    maintenanceOperations,
    codexTurnStarts,
    codexTerminalAudit,
    codexHookReceipts,
    replaceCodexHookReceipts,
    changedFilesForRun,
    projectTurnUsageToWorkLog,
    codexRunFinalizer,
    turnEndDelivery,
    terminalCommits,
    journalBackfill,
    claudeTranscriptAudit,
    taskCatalogFinalization,
    taskCatalogService,
    taskCatalog,
  } = provider;
  const {
    findProject,
    uiCallback,
    runTaskTitle,
    pinnedTaskTitle,
    threadTitle,
  } = tasks;

  const clients = await createClientInterfaceComposition({
    config,
    token,
    botMenu,
    statusHeaderDirectory,
    statusMediaFileIds,
    saveState: api.saveState,
    currentChatId: () => hostState.chatId,
    currentProvider: selectedProvider,
    telegramLimit,
    miniAppServer,
    publicMiniAppServer,
    attachmentThumbnails,
    runtimeCommandRoot,
    journalDatabaseFile,
    taskBoard,
    handleDesktopControl: api.deferredHandleDesktopControl,
    reconcileRemoteDesktopControl: api.deferredReconcileRemoteDesktopControl,
    forgetDesktopControl: api.deferredForgetDesktopControl,
    trustedDeviceUserId: api.deferredDesktopTrustedDeviceUserId,
    trustedDeviceStore,
    desktopMessageReceipts,
    projects,
    codexModels,
    claudeModels,
    claudeModelLabels,
    reasoningEfforts,
    reasoningLabels,
    claudeReasoningEfforts,
    claudeReasoningLabels,
    collaborationModes,
    collaborationModeLabels,
    uiCallback,
    resolveClaudeInvocation,
    parseClaudeLimits,
    formatClaudeRateLimits,
    formatCodexRateLimits,
    spawnCapture,
    sendRpc: api.sendRpc,
    codexTransportRunning: () => late.codexTransport().running,
    rateLimitHistoryStore,
    workLogUsageStore,
    runtimeTimers,
    isStopping: () => hostState.stopping,
    findProject,
    refreshTaskCatalog: api.refreshTaskCatalog,
    currentTaskCatalog: () => taskCatalog,
    currentTaskRuns: () => taskRuns.values(),
    codexModelLabel: late.codexModelLabel,
    agentHubRoot,
    stopProcessTree: late.stopProcessTree,
    startTurn: api.startTurn,
    activeProjectRoot: selectedProjectRoot,
    approvalProtocol: late.approvalProtocol,
    autoApprove: () => hostState.autoApprove,
    respondRpc: api.respondRpc,
    codexTransportGeneration: api.codexTransportGeneration,
    sendRunMessage: api.sendRunMessage,
    runExists: (id) => taskRuns.values().some((run) => run.id === id),
    taskProgress: late.taskProgress,
    mcpAdmissionCoordinator,
  });
  ports.deferredInputPresentation.bind({
    updateDeferredMessage: (...args) => clients.deferredInputPresentation.updateTelegramMessage(...args),
    updateDeferredDesktopReceipt: (...args) => clients.deferredInputPresentation.updateDesktopReceipt(...args),
  });

  const delivery = await createDeliveryOutboxComposition({
    directoryPath: deliveryOutboxDirectory,
    retryIntervalMs: config.deliveryRetryIntervalSeconds * 1000,
    runtimeTimers,
    isStopping: () => hostState.stopping,
    deliver: (method, body) => {
      if (method !== "sendPhotoFile") return clients.telegram(method, body);
      const { photo_path: photoPath, ...telegramBody } = body;
      return clients.telegramMultipart("sendPhoto", telegramBody, "photo", photoPath);
    },
    onUncertain: async (item) => {
      if (!item.intent?.terminalRevision) return;
      await terminalCommits?.markChannelUncertain(item.intent, { deliveryId: item.id });
    },
    onDelivered: async (item, result) => {
      await late.telegramDeliveryService().recordDeliveredOutbox(item, result);
      if (item.intent?.final === true) {
        await terminalCommits?.acknowledgeChannel(item.intent, { deliveryId: item.id });
      }
    },
    onPermanentFailure: async (item, error) => {
      if (item.intent?.terminalRevision) {
        await terminalCommits?.failChannel(item.intent, {
          deliveryId: item.id,
          error: String(error?.message ?? error),
        });
      }
      console.error(`Quarantined permanent Telegram delivery ${item.id}:`, error.message);
    },
  });

  ports.taskState.bind(createTaskStateWiring({
    taskCatalogService,
    taskSyncStore,
    selectionStore,
    projects,
    findContainingProject,
    taskCatalog,
    catalogEntryIsSelected,
    taskRuns,
    taskMetadata,
    agentPreferences,
    currentChatId: () => hostState.chatId,
    contextualCallback,
    samePath,
    taskDiffs,
    logger: console,
  }));
  ports.runtimeFacades.bind(createRuntimeFacadesComposition({
    sendTaskSelection: ports.telegramDelivery.api.sendTaskSelectionNotification,
    currentChatId: () => hostState.chatId,
    runJournal,
    deferredInputs,
    codexUsageTracker,
    codexRunFinalizer,
    turnEndDelivery,
    agentPreferences,
    journalBackfill,
    claudeTranscriptAudit,
    taskCatalogFinalization,
    taskCatalogService,
  }));

  const stateBootstrap = await createRuntimeStateBootstrapWiring({
    restoration: {
      config,
      projects,
      maximumDeferredInputs,
      runtimeStateStore,
      canonicalizeProjectRoots,
      restoreContext: {
        selectionStore,
        findProject,
        taskMetadata,
        preferences: agentPreferences,
        statusMediaFileIds,
        runJournal,
        lastSeenTaskTurnIds,
        codexUsageTracker,
        contextCompactions,
        codexTurnStarts,
        codexTerminalAudit,
        turnEndNotifications,
        dismissedExternalTasks,
        cancelledManagedClaudeTasks,
        pendingInputs,
        queuedInputs,
        isLegacyDesktopAttachmentFile: clients.isLegacyDesktopAttachmentFile,
        desktopMessageReceipts,
        updateDeferredDesktopReceipt: api.updateDeferredDesktopReceipt,
        forwardBundles,
        taskRuns,
      },
      snapshotContext: {
        getChatId: () => hostState.chatId,
        getClientTaskSelections: () => hostState.clientTaskSelectionsSnapshot(),
        getUpdateOffset: () => hostState.updateOffset,
        getRestartRequest: () => hostState.restartRequest,
        getCodexHookReceipts: () => codexHookReceipts,
        selectionStore,
        taskMetadata,
        preferences: agentPreferences,
        taskRuns,
        dismissedExternalTasks,
        cancelledManagedClaudeTasks,
        pendingInputs,
        queuedInputs,
        desktopMessageReceipts,
        forwardBundles,
        runJournal,
        lastSeenTaskTurnIds,
        codexUsageTracker,
        contextCompactions,
        codexTurnStarts,
        codexTerminalAudit,
        turnEndNotifications,
        statusMediaFileIds,
      },
    },
    applyRestoredState: (restoredState) => {
      hostState.restore(restoredState);
      const restartTarget = {
        streamId: selectionStore.snapshot().streamId,
        threadId: selectedThreadId(),
      };
      const restoredOperationId = String(restoredState.restartRequest?.operationId ?? "").trim();
      const interruptedRestart = restoredOperationId
        ? maintenanceOperations.get(restoredOperationId)
        : maintenanceOperations.migrateLegacyRestart(restoredState.restartRequest, restartTarget)
          ?? maintenanceOperations.latestRestart(restartTarget);
      if (interruptedRestart) {
        maintenanceOperations.recoverInterrupted({
          operationIds: [interruptedRestart.operationId],
        });
        hostState.setRestartRequest(restartRequestProjection(
          maintenanceOperations.get(interruptedRestart.operationId),
        ));
      } else {
        hostState.setRestartRequest(null);
      }
      replaceCodexHookReceipts(restoredState.codexHookReceipts);
      const restoredThreadId = selectedThreadId();
      if (isCodex() && restoredThreadId) {
        if (taskMetadata.codexSettings(restoredThreadId)) api.restoreCodexTaskSettings(restoredThreadId);
        else api.rememberCodexTaskSettings(restoredThreadId);
      }
      return restoredState.restoredTurnEndSnapshot;
    },
    initializeJournal: (restoredTurnEndSnapshot) => runJournal.initialize(restoredTurnEndSnapshot),
    startupMaintenance: {
      config,
      taskRuns,
      pinnedTaskTitlesFile,
      taskMetadata,
    },
    logger: console,
  });
  ports.statePersistence.bind(createStatePersistenceComposition({
    rememberProviderSettings: api.rememberCodexTaskSettings,
    selectionStore,
    runtimeStateCoordinator: stateBootstrap.runtimeStateCoordinator,
    pinnedTaskTitlesFile,
    taskMetadata,
  }));
  for (const context of codexUsageTracker.contexts.values()) {
    contextCompactions.observeContext(context);
  }
  workLogUsageStore.setIncludeClaudeUsage(agentPreferences.includeClaudeUsage);

  const codexLifecycle = createCodexLifecycleComposition({
    config,
    hubMcpServer,
    rpcTimeoutMs: codexRpcTimeoutMs,
    runtimeDependencies: {
      getActiveProjectRoot: selectedProjectRoot,
      stopProcessTree: late.stopProcessTree,
      handleMessage: api.handleCodexMessage,
      isStopping: () => hostState.stopping,
      providerSelected: isCodex,
      activeRuns: () => taskRuns.values(),
      setStage: (run, stage) => late.taskProgress().setStage(run, stage),
      recoverRuns: () => late.runRecovery().recoverAll({ provider: "codex" }),
      startTyping: clients.startTyping,
      attachSelectedThread: api.attachCodexThread,
    },
    controllerDependencies: {
      readCodexRolloutActivity,
      readCodexTurnUsage,
      findProject,
      codexTurnStarts,
      setBoundedMapValue: api.setBoundedMapValue,
      setHookReceipt: (kind, receipt) => { codexHookReceipts[kind] = receipt; },
      taskRuns,
      saveState: api.saveState,
      taskTitle: api.runtimeCommandTaskTitle,
      taskGitDiff,
      changedFilesForRun,
      turnEndNotifications,
      defaultNotificationChatId: provider.defaultNotificationChatId,
      projectTurnUsageToWorkLog,
      rememberLastTaskMessage: api.rememberLastTaskMessage,
      lastSeenTaskTurnIds,
      deliverTurnEndNotification: api.deliverTurnEndNotification,
    },
  });
  ports.codexLifecycle.bind(codexLifecycle);
  const { runtime: codexRuntime, transport: codexTransport, controller: codexLifecycleController } = codexLifecycle;
  ports.codexTaskSettings.bind(createCodexTaskSettingsComposition({
    pinnedTaskTitle,
    readCodexThreadTitleHistory,
    sendRpc: api.sendRpc,
    isCodex,
    getThreadId: selectedThreadId,
    contextCompactions: provider.contextCompactions,
    agentPreferences,
    saveState: api.saveState,
    codexModelLabel: late.codexModelLabel,
    reasoningLabels,
  }));
  ports.runtimeCommand.bind(createRuntimeCommandRoutingComposition({
    pinnedTaskTitle,
    codexThreadResponseTitle: api.codexThreadResponseTitle,
    runTaskTitle,
    getTaskCatalog: () => taskCatalog,
    getActiveProvider: selectedProvider,
    getThreadId: selectedThreadId,
    getActiveThreadTitle: selectedTaskTitle,
    threadTitle,
    storedCodexThreadTitle: api.storedCodexThreadTitle,
    runtimeNotificationController,
    codexLifecycleController,
  }));

  return {
    ...clients,
    ...delivery,
    ...stateBootstrap,
    codexLifecycle,
    codexRuntime,
    codexTransport,
    codexLifecycleController,
  };
}
