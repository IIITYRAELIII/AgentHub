import process from "node:process";

import { createProviderRuntimeWiring } from "./provider-runtime-wiring-composition.mjs";
import { createRuntimeTimersComposition } from "./runtime-timers-composition.mjs";
import { createTaskInteractionWiring } from "./task-interaction-wiring-composition.mjs";
import { createRuntimeRestartWiring } from "./runtime-restart-wiring-composition.mjs";
import { taskDisplayTitle } from "../domain/task-display-title.mjs";
import { TestContourJournalSyncService } from "../application/test-contour-journal-sync-service.mjs";
import { testContourRuntimeAlive } from "../runtime/test-contour-manager.mjs";
import { readMissingTestContourJournalRecords } from "../infrastructure/persistence/test-contour-journal-source.mjs";

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
    terminalAuditIntervalMs,
    externalPollIntervalMs,
    managedPollIntervalMs,
    claudeOutputPollIntervalMs,
    progressStalledAfterMs,
    agentHubRoot,
    instanceLockFile,
    botMenu,
    globalWorkLogProjectRoots,
    journalDatabaseFile,
    testContourJournalDatabaseFile,
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
    turnEndDelivery,
    scheduleCodexTerminalAudit,
    rateLimitTelemetry,
    providerLogin,
    usageSyncAuto,
    taskSyncStore,
    messagePins,
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
    importCodexDesktopAttachments,
  } = provider;
  const {
    runTaskTitle,
    findProject,
    invalidateTaskCatalog,
    syncTaskRun,
    codexModelLabel,
    reasoningLabels,
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
    providerTurnTelemetryStore,
    taskReadStateStore,
    runtimeStateStore,
    commandTrace,
  } = persistence;
  const {
    restartRequestService,
    miniAppLifecycle,
    desktopAttachments,
    desktopControlServer,
    runtimeCommandServer,
    hubMcpServer,
    journalStartupReady,
    announceDesktopRestart,
    taskObserverLogger,
  } = lifecycle;

  const testContourJournalSync = new TestContourJournalSyncService({
    timers: runtimeTimers,
    workLogUsageStore,
    sourceDatabaseFile: testContourJournalDatabaseFile,
    targetDatabaseFile: journalDatabaseFile,
    projectionProjectRoots: globalWorkLogProjectRoots,
    readRecords: readMissingTestContourJournalRecords,
    sourceRuntimeAlive: () => testContourRuntimeAlive(),
    enabled: config.components?.testContour === true
      && process.env.AGENT_HUB_TEST_CONTOUR !== "1",
  });

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
      ensureThreadNamed: provider.hubThreadNaming.recoverThreadNaming,
      dataDir: config.dataDir,
      recordingContourRoot: config.testContourRecording?.root ?? null,
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
    attachmentImporter: importCodexDesktopAttachments,
    terminalAuditIntervalMs,
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
    turnEndDelivery,
    selectedTaskWatch,
    scheduleCodexTerminalAudit,
    scheduleBugReportScan,
    rateLimitTelemetry,
    usageSyncAuto,
    testContourJournalSync,
    providerLogin,
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
      messagePins,
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
      completeRestartOperation: (operationId) => restartRequestService.complete(operationId),
      failRestartOperation: (error) => restartRequestService.fail(undefined, error),
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
      desktopAttachments,
      desktopControlServer,
      runtimeCommandServer,
      hubMcpServer,
      instanceGuard,
      workLogUsageStore,
      rateLimitHistoryStore,
      providerTurnTelemetryStore,
      taskReadStateStore,
      runtimeStateStore,
      commandTrace,
      updateOffset: () => hostState.updateOffset,
      setWaiting: (value) => restartRequestService.setWaiting(value),
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
