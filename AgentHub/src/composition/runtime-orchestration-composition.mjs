import { createProviderRuntimeWiring } from "./provider-runtime-wiring-composition.mjs";
import { createRuntimeTimersComposition } from "./runtime-timers-composition.mjs";
import { createTaskInteractionWiring } from "./task-interaction-wiring-composition.mjs";
import { createRuntimeRestartWiring } from "./runtime-restart-wiring-composition.mjs";
import { taskDisplayTitle } from "../domain/task-display-title.mjs";

export function createRuntimeOrchestrationComposition({
  config,
  constants,
  state,
  runtime,
  provider,
  tasks,
  clients,
  persistence,
  lifecycle,
  ports,
}) {
  const {
    selectedTaskWatchIntervalMs,
    externalPollIntervalMs,
    managedPollIntervalMs,
    claudeOutputPollIntervalMs,
    progressStalledAfterMs,
    agentHubRoot,
    instanceLockFile,
    botMenu,
  } = constants;
  const {
    hostState,
    selectedTask,
    selectedTaskTitle,
    selectedProjectRoot,
    selectedThreadId,
    isCodex,
    providerTitle,
    activeProvider,
    activeProjectRoot,
    saveState,
  } = state;
  const {
    runtimeTimers,
    taskRuns,
    backgroundJobs,
    taskProgress,
    managedRunLifecycle,
    runCoordinator,
    contextCompactions,
    streamMaintenance,
    deferredInputController,
    queuedInputs,
    scheduleQueuedInput,
    scheduleDeliveryOutboxFlush,
    scheduleCodexTerminalAudit,
    rateLimitTelemetry,
    taskSyncStore,
    workspaceCatalogStore,
    preTurnInstructions,
    dismissedExternalTasks,
    lastSeenTaskTurnIds,
    turnTemporaryFiles,
    claudeTaskSnapshots,
    codexTaskSnapshots,
  } = runtime;
  const {
    agentProviders,
    claudeEventService,
    codexEventService,
    codexTerminalAudit,
    codexTransport,
    codexContextMaintenance,
    discardContextCompactionRun,
    resolveClaudeInvocation,
    hubMcpServer: providerHubMcpServer,
    hubMcpService,
    readCodexTaskSnapshot,
    readCodexThread,
    knownCodexRolloutPath,
    startCodexAppServer,
    initializeCodex,
    stopCodexAppServerTree,
  } = provider;
  const {
    runTaskTitle,
    findProject,
    invalidateTaskCatalog,
    syncTaskRun,
    codexModelLabel,
    reasoningLabels,
    captureTaskGitBaseline,
    savedLastTaskMessage,
    savedLastTaskMessageRecord,
    rememberLastTaskMessage,
    setBoundedMapValue,
    taskRunKey,
    taskCatalogEntries,
    catalogEntryIsSelected,
    refreshTaskCatalog,
  } = tasks;
  const {
    startTyping,
    stopTyping,
    safelyDeliverRunMessage,
    sendRunMessage,
    sendRunMessageText,
    deleteTaskMessages,
    sendTaskViewText,
    findMessageBinding,
    sendMessageTo,
    telegram,
    formatRestartCompleteMessage,
    scheduleBugReportScan,
    uiCallback,
  } = clients;
  const {
    runtimeStateCoordinator,
    telegramDeliveryService,
    mediaController,
    deliveryOutbox,
    backgroundJobStore,
    failedUpdateStore,
    instanceGuard,
    workLogUsageStore,
    rateLimitHistoryStore,
    taskReadStateStore,
    runtimeStateStore,
  } = persistence;
  const {
    restartRequestService,
    miniAppLifecycle,
    desktopControlServer,
    runtimeCommandServer,
    hubMcpServer,
    journalStartupReady,
    announceDesktopRestart,
    taskObserverLogger,
  } = lifecycle;

  const selectedTaskCandidates = () => {
    const candidates = hostState.clientTaskSelectionsSnapshot().map(([clientId, binding]) => {
      const telegramMatch = /^telegram:(-?\d+)$/.exec(String(clientId));
      const { taskTitle, ...task } = binding;
      return {
        clientId,
        task,
        taskTitle,
        chatId: telegramMatch ? Number(telegramMatch[1]) : hostState.chatId,
      };
    });
    candidates.push({
      clientId: "global",
      task: selectedTask(),
      taskTitle: selectedTaskTitle(),
      chatId: hostState.chatId,
    });
    return candidates;
  };

  const providerRuntimeWiring = ports.providerRuntime.bind(createProviderRuntimeWiring({
    observation: {
      dataDir: config.dataDir,
      claudeOutputPollIntervalMs,
      taskRuns,
      isStopping: () => hostState.stopping,
      saveState,
      startTyping,
      taskProgress,
      agentProviders,
      runCoordinator,
      findProject,
      invalidateTaskCatalog,
      syncTaskRun,
      codexModelLabel,
      reasoningLabels,
      markProgressHeartbeat: runtime.markProgressHeartbeat,
      progressStalledAfterMs,
      managedRunLifecycle,
      discardContextCompactionRun,
      savedLastTaskMessage,
      savedLastTaskMessageRecord,
      externalPollIntervalMs,
      managedPollIntervalMs,
      captureTaskGitBaseline,
      turnTemporaryFiles,
      claudeTaskSnapshots,
      claudePermissionMode: config.claudePermissionMode,
      autoApprove: () => hostState.autoApprove,
      resolveClaudeInvocation,
      hubMcpServer: providerHubMcpServer,
      hubMcpService,
      workspaceCatalogStore,
      preTurnInstructions,
      logWarning: (...args) => console.warn(...args),
      safelyDeliverRunMessage,
      sendRunMessage,
      dismissedExternalTasks,
      lastSeenTaskTurnIds,
      runtimeTimers,
      selectedTaskWatchIntervalMs,
      selectedTask,
      selectedTasks: selectedTaskCandidates,
      chatId: () => hostState.chatId,
      activeTaskTitle: selectedTaskTitle,
      rememberLastTaskMessage,
      logError: (...args) => console.error(...args.map((value) => value?.message ?? value)),
    },
    managedRunHistory: runtime.managedRunHistory,
    claudeEventService,
    runCoordinator,
    codexEventService,
    codexTaskSnapshots,
    codexTerminalAudit,
    codexTransport,
    saveState,
    isStopping: () => hostState.stopping,
    runtimeTimers,
    selectedTaskWatchIntervalMs,
    logger: taskObserverLogger,
  }));
  const {
    claudeRunController,
    taskObserver,
    runRecovery,
    selectedTaskWatch,
  } = providerRuntimeWiring;

  const timers = createRuntimeTimersComposition({
    telegramEnabled: config.telegramEnabled,
    runtimeTimers,
    stopTyping,
    contextCompactions,
    deferredInputController,
    taskRuns,
    taskProgress,
    taskObserver,
    claudeRunController,
    codexContextMaintenance,
    queuedInputs,
    scheduleQueuedInput,
    scheduleDeliveryOutboxFlush,
    selectedTaskWatch,
    scheduleCodexTerminalAudit,
    scheduleBugReportScan,
    rateLimitTelemetry,
  });

  ports.taskInteraction.bind(createTaskInteractionWiring({
    taskView: {
      ensureCodex: async () => {
        if (codexTransport.running) return;
        await startCodexAppServer();
        await initializeCodex({ attachSelectedThread: false });
      },
      findCodexRolloutPath: knownCodexRolloutPath,
      readCodexThread,
      readCodexRolloutActivity: provider.readCodexRolloutActivity,
      readCodexSnapshot: readCodexTaskSnapshot,
      readClaudeSnapshot: (...args) => claudeTaskSnapshots.read(...args),
      attachmentImporter: provider.importCodexDesktopAttachments,
      taskSyncStore,
      workspaceCatalogStore,
      taskRuns,
      deleteTaskMessages,
      sendRunMessage: sendRunMessageText,
      sendTaskViewText,
      runTaskTitle,
      savedLastTaskMessage,
      dismissedExternalTasks,
      saveState,
      resolveRunningTitle: (running, binding) => {
        const entry = taskCatalogEntries()
          .find((candidate) => catalogEntryIsSelected(candidate, running));
        const catalogTitle = entry ? taskDisplayTitle(entry) : null;
        const selectedTitle = runtime.isSelectedRun(running)
          ? taskDisplayTitle(entry, selectedTaskTitle())
          : null;
        return selectedTitle || catalogTitle || binding.taskTitle;
      },
      taskProgress,
      taskObserver,
      findMessageBinding,
      taskCatalog: taskCatalogEntries,
      refreshTaskCatalog,
      selectedTask,
      activeThreadTitle: selectedTaskTitle,
      logger: taskObserverLogger,
    },
    approvalController: runtime.approvalController,
    activeProvider,
    autoApprove: () => hostState.autoApprove,
    autoApproveOnStart: config.autoApproveOnStart,
    claudePermissionMode: config.claudePermissionMode,
    activeProjectRoot,
    uiCallback,
  }));

  const restartWiring = ports.runtimeRestart.bind(createRuntimeRestartWiring({
    taskRuns,
    agentProviders,
    backgroundJobs,
    streamMaintenance,
    getRestartRequest: () => hostState.restartRequest,
    isStopping: () => hostState.stopping,
    restartRequestService,
    runtimeRestart: {
      getRestartRequest: () => hostState.restartRequest,
      setRestartRequest: (value) => hostState.setRestartRequest(value),
      isStopping: () => hostState.stopping,
      setStopping: (value) => hostState.setStopping(value),
      beginStopping: () => hostState.beginStopping(),
      sendMessage: sendMessageTo,
      telegram,
      saveState,
      formatRestartCompleteMessage,
      completeMessageState: () => {
        const selected = selectedTask();
        const current = taskCatalogEntries()
          .find((entry) => catalogEntryIsSelected(entry, selected));
        const workspaceBinding = current ?? workspaceCatalogStore.resolveThread?.(selected);
        return {
          provider: providerTitle(),
          task: taskDisplayTitle(
            workspaceBinding,
            selectedTaskTitle()
              || (selectedThreadId() ? `${providerTitle()} · ${selectedThreadId().slice(0, 8)}` : "Не выбрана"),
          ),
          runningTasks: taskRuns.size,
        };
      },
      botMenu,
      journalStartupReady,
      runtimeStateCoordinator,
      telegramDeliveryService,
      mediaController,
      taskSyncStore,
      workspaceCatalogStore,
      deliveryOutbox,
      backgroundJobStore,
      failedUpdateStore,
      stopCodexAppServerTree,
      miniAppLifecycle,
      desktopControlServer,
      runtimeCommandServer,
      hubMcpServer,
      instanceGuard,
      workLogUsageStore,
      rateLimitHistoryStore,
      taskReadStateStore,
      runtimeStateStore,
      updateOffset: () => hostState.updateOffset,
      setWaiting: (value) => hostState.setRestartWaiting(value),
      stopRuntimeTimers: timers.stopRuntimeTimers,
      agentHubRoot,
      instanceLockFile,
      isCodex,
      taskRuns,
      startCodexAppServer,
      initializeCodex,
      runRecovery,
      updateRestartMessage: (message) => restartWiring.updateRestartMessage(message),
      startRuntimeTimers: timers.startRuntimeTimers,
      delay: runtime.delay,
    },
  }));

  return {
    ...timers,
    claudeRunController,
    taskObserver,
    runRecovery,
    runtimeResources: restartWiring.runtimeResources,
  };
}
