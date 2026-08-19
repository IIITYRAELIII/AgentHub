import { createDesktopReadSystemWiring } from "./desktop-read-system-wiring-composition.mjs";
import { createDesktopCommandWiring } from "./desktop-command-wiring-composition.mjs";
import { createDesktopRunRouterWiring } from "./desktop-run-router-wiring-composition.mjs";
import { WorkspaceCatalogService } from "../application/workspace-catalog-service.mjs";
import { ClientTaskSelectionService } from "../application/client-task-selection-service.mjs";

export function createDesktopShellComposition({
  config,
  diagnostics,
  limits,
  models,
  state,
  catalog,
  runtime,
  provider,
  clients,
  presentation,
  repositories,
  serverControlController,
  desktopCommandsPort,
}) {
  const {
    projects,
    maxSpeechJobs,
    maxDeferredInputs,
    taskExecutionOwners,
    globalWorkLogProjectRoots,
  } = limits;
  const {
    hostState,
    selectionStore,
    agentPreferences,
    selectedProvider,
    selectedProjectRoot,
    selectedTaskTitle,
    selectedThreadId,
    isCodex,
    selectedTask,
    selectedTurnTarget,
    activeProject,
    selectedRun,
    saveState,
    savePinnedTaskTitles,
  } = state;
  const {
    getTaskCatalog,
    refreshTaskCatalog,
    taskCatalogService,
    invalidateTaskCatalog,
    mergeTaskCatalog,
    findProject,
    pinTaskTitle,
    storedCodexThreadTitle,
    dismissedExternalTasks,
  } = catalog;
  const {
    taskRuns,
    taskSyncStore,
    taskRunIsActive,
    backgroundJobs,
    rateLimitTelemetry,
    rateLimitHistoryStore,
    workLogUsageStore,
    workspaceCatalogStore,
    taskReadStateStore,
    usdRubRateStore,
    pendingInputs,
    queuedInputs,
    contextCompactions,
    approvalController,
    taskDiffs,
    managedRunLifecycle,
    deferredInputs,
    taskProgress,
    taskExternalActivity,
    scheduleQueuedInput,
    isDeferredInputProcessing,
    cancelDeferredInputSchedule,
    cleanupDeferredFiles,
    updateDeferredDesktopReceipt,
    updateDeferredMessage,
    scheduleNextDeferredInput,
    startTurn,
    launchTurn,
    runTaskTitle,
    streamContextMaintenance,
    streamMaintenance,
    taskBoard,
  } = runtime;
  const {
    agentProviders,
    codexTransport,
    startCodexAppServer,
    initializeCodex,
    attachCodexThread,
    listThreads,
    threadTitle,
    restoreCodexTaskSettings,
    switchCodexModel,
    switchModel,
    updateActiveCodexThreadSettings,
    rememberCodexTaskSettings,
    createThread,
    sendRpc,
    latestThreadContextUsage,
    importCodexDesktopAttachments,
  } = provider;
  const {
    miniAppLifecycle,
    desktopMessageReceipts,
    desktopAttachmentDescriptors,
    desktopAttachmentPaths,
    desktopOpenAttachment,
    desktopSubmitBugReport,
    readCachedHistory,
    refreshHistory,
    sendMessage,
    sendMessageTo,
    telegram,
    announceDesktopRestart,
    performRestart,
    sendTaskSwitchNotification,
    sendTaskAlreadySelectedNotification,
    bindRunMessage,
  } = clients;
  const {
    formatArchiveMessage,
    showLastMessageReplyMarkup,
    taskExecutionRuntimeLabel,
    catalogEntryIsSelected,
    taskOrderingActivityAtMs,
    updateTaskRunTitle,
    taskRunKey,
    samePath,
  } = presentation;
  const {
    resolveTaskGitRepoRoots,
    findRepositoryWriteConflict,
  } = repositories;

  const desktopReadSystem = createDesktopReadSystemWiring({
    config,
    models,
    projects,
    maxSpeechJobs,
    state: {
      activeProvider: selectedProvider,
      activeProjectRoot: selectedProjectRoot,
      activeThreadTitle: selectedTaskTitle,
      autoApprove: () => hostState.autoApprove,
      chatId: () => hostState.chatId,
      threadId: selectedThreadId,
      isCodex,
      hasThread: () => Boolean(selectedThreadId()),
      selectedTask,
      selectedTurnTarget,
      activeProject,
      restartRequest: () => hostState.restartRequest,
    },
    services: {
      preferences: (targetProvider) => agentPreferences.current(targetProvider),
      preferencesSnapshot: () => agentPreferences.snapshot(),
      formattedRateLimits: (targetProvider) => rateLimitTelemetry.formatted(targetProvider),
      activeRunCount: () => taskRuns.values().filter(taskRunIsActive).length,
      backgroundJobCount: () => backgroundJobs.size,
      readRateLimitHistory: (params) => rateLimitTelemetry.history(params),
      readUsageHistory: (params) => workLogUsageStore.usageHistory(params),
      refreshCatalog: refreshTaskCatalog,
      threadsForStream: (streamId) => workspaceCatalogStore.threadsForStream(streamId),
      searchTurns: (...args) => workLogUsageStore.searchTurns(...args),
      searchMessages: (...args) => taskSyncStore.searchMessages(...args),
      messageSearchStatus: (...args) => taskSyncStore.messageSearchStatus(...args),
      markMessageSearchThread: (...args) => taskSyncStore.markMessageSearchThread(...args),
      refreshHistory,
      projectRoots: () => projects.map((project) => project.path),
      samePath,
      miniAppPublisher: () => miniAppLifecycle.publisher,
      trustedDeviceStore: runtime.trustedDeviceStore,
      resolveTask: desktopCommandsPort.api.messageTarget,
      lastTaskMessage: runtime.savedLastTaskMessageRecord,
      enqueueSpeech: (target, text) => backgroundJobs.enqueue(
        "speech",
        { chatId: hostState.chatId, text },
        hostState.chatId,
        { dedupeKey: `desktop:${target.provider}:${target.threadId}:speech` },
      ),
      latestContextUsage: latestThreadContextUsage,
      isCompacting: (contextThreadId) => contextCompactions.isRunning(contextThreadId),
      compactionFor: (contextThreadId) => contextCompactions.get(contextThreadId),
      maintenanceFor: (target) => streamMaintenance.entry(target),
      desktopSnapshotRevision: async () => {
        if (
          pendingInputs.size
          || queuedInputs.size
          || approvalController.pending.size
          || hostState.restartRequest
          || contextCompactions.runningCount()
        ) return null;
        const entries = taskCatalogService.entries;
        if (entries.some((entry) => streamMaintenance.entry(entry))) return null;
        return JSON.stringify({
          catalog: taskCatalogService.snapshotRevision,
          runs: taskRuns.revision,
          selection: selectionStore.revision,
          preferences: agentPreferences.snapshot(),
          autoApprove: hostState.autoApprove,
          board: taskBoard.snapshotRevision,
          messages: runtime.lastTaskMessageRevision(),
          readState: taskReadStateStore.revision,
          receipts: desktopMessageReceipts.revision,
          exchangeRates: usdRubRateStore.snapshot(),
          server: await serverControlController.snapshot({ activeCount: 0, restart: null }),
        });
      },
      runForTask: (task) => taskRuns.forTask(task),
      runTitle: runTaskTitle,
      findProject,
      catalogEntryIsSelected,
      executionRuntimeLabel: taskExecutionRuntimeLabel,
      orderingActivityAtMs: taskOrderingActivityAtMs,
      catalogEntries: getTaskCatalog,
      workspaceHierarchy: () => workspaceCatalogStore.hierarchy(),
      taskBoardSnapshot: () => taskBoard.snapshot(),
      taskBoardWorkspaces: () => taskBoard.workspaces(),
      taskBoardLayout: () => taskBoard.layout(),
      catalogStale: () => taskCatalogService.stale,
      mergeCatalog: mergeTaskCatalog,
      pendingValues: () => [...pendingInputs.values()],
      queuedValues: () => [...queuedInputs.values()],
      describeAttachments: desktopAttachmentDescriptors,
      receiptForMessage: (identity) => desktopMessageReceipts.get(identity),
      recentReceipts: () => desktopMessageReceipts.snapshot(),
      receiptForTurn: (identity) => desktopMessageReceipts.findByTurn(identity),
      approvalSnapshot: () => approvalController.snapshot(),
      restartBlockingRuns: runtime.restartBlockingRuns,
      compactionCount: () => contextCompactions.runningCount(),
      mediaJobCount: () => backgroundJobs.mediaSize,
      speechJobCount: () => backgroundJobs.speechSize,
      exchangeRates: usdRubRateStore,
      serverSnapshot: (...args) => serverControlController.snapshot(...args),
      readStateStore: taskReadStateStore,
      hasAllowedUsers: () => Boolean(config.allowedUserIds.size),
      androidEnabled: () => Boolean(config.components.androidApp),
      readCachedHistory,
      refreshHistory,
      attachmentImporter: importCodexDesktopAttachments,
      warn: (...args) => console.warn(...args),
    },
  });

  const workspaceCatalog = new WorkspaceCatalogService({ store: workspaceCatalogStore });
  const workspaceMutation = async (run, { resultKey = "" } = {}) => {
    const result = run();
    invalidateTaskCatalog();
    await saveState();
    const snapshot = await desktopReadSystem.desktopSnapshot({ refresh: true });
    return resultKey ? { ...snapshot, [resultKey]: result } : snapshot;
  };

  const prepareTaskCreation = async ({
    provider: targetProvider,
    project,
    workingDirectory,
    model,
    reasoning,
    mode,
    autoApprove: targetAutoApprove,
    streamId = null,
    title = "",
  } = {}) => {
    const normalizedProvider = targetProvider === "claude" ? "claude" : "codex";
    const requestedDirectory = [workingDirectory, project, selectedProjectRoot()]
      .map((value) => String(value ?? "").trim())
      .find(Boolean) ?? "";
    const selectedProject = findProject(requestedDirectory);
    if (!selectedProject) {
      throw new Error("Рабочая директория должна находиться внутри настроенного репозитория");
    }
    selectionStore.selectTask({
      activeProjectRoot: requestedDirectory || selectedProject.path,
      activeProvider: normalizedProvider,
      threadId: null,
      streamId,
      activeThreadTitle: String(title ?? "").trim(),
    });
    if (model) {
      if (normalizedProvider === "codex") agentPreferences.setCodexModel(model);
      else agentPreferences.setClaudeModel(model);
    }
    if (reasoning) {
      if (normalizedProvider === "codex") agentPreferences.setCodexReasoning(reasoning);
      else agentPreferences.setClaudeReasoning(reasoning);
    }
    if (mode) {
      if (normalizedProvider === "codex") agentPreferences.setCodexMode(mode);
      else agentPreferences.setClaudeMode(mode);
    }
    if (typeof targetAutoApprove === "boolean") hostState.setAutoApprove(targetAutoApprove);
    await saveState();
  };

  const telegramSelection = new ClientTaskSelectionService({
    sessionState: hostState,
    fallbackSelection: selectedTask,
    fallbackTitle: selectedTaskTitle,
    findProject,
    catalogEntries: getTaskCatalog,
    catalogEntryIsSelected,
    preferences: agentPreferences,
    samePath,
    save: saveState,
  });
  const telegramSelectedTask = (...args) => telegramSelection.selectedTask(...args);
  const telegramTaskTitle = (...args) => telegramSelection.title(...args);
  const telegramSelectedTurnTarget = (...args) => telegramSelection.turnTarget(...args);
  const telegramCurrentUiContextToken = (...args) => telegramSelection.currentUiContextToken(...args);
  const telegramUiCallback = (...args) => telegramSelection.uiCallback(...args);
  const selectTelegramTaskFromBinding = (...args) => telegramSelection.select(...args);
  const clearTelegramTaskSelection = (...args) => telegramSelection.clear(...args);
  const telegramSelectionNotificationOptions = (options = {}) => ({
    ...options,
    selectedTask: telegramSelectedTask(options.targetChatId),
    taskTitle: telegramTaskTitle(options.targetChatId),
    projectName: findProject(telegramSelectedTask(options.targetChatId).projectRoot)?.name ?? "",
  });

  const desktopCommands = createDesktopCommandWiring({
    models: {
      reasoningEfforts: models.reasoningEfforts,
      claudeReasoningEfforts: models.claudeReasoningEfforts,
      collaborationModes: models.collaborationModes,
    },
    projects,
    state: {
      activeProvider: selectedProvider,
      activeProjectRoot: selectedProjectRoot,
      activeTaskTitle: selectedTaskTitle,
      autoApprove: () => hostState.autoApprove,
      setAutoApprove: (value) => hostState.setAutoApprove(value),
      chatId: () => hostState.chatId,
      threadId: selectedThreadId,
      updateOffset: () => hostState.updateOffset,
      processingUpdateId: () => hostState.processingUpdateId,
      restartRequest: () => hostState.restartRequest,
      setRestartRequest: (value) => hostState.setRestartRequest(value),
      isStopping: () => hostState.stopping,
      latestDiff: () => hostState.latestDiff,
      setLatestDiff: (value) => hostState.setLatestDiff(value),
      isCodex,
      selectedTask,
      telegramSelectedTask,
    },
    services: {
      catalogEntries: getTaskCatalog,
      refreshCatalog: refreshTaskCatalog,
      markTaskRead: desktopReadSystem.markDesktopTaskRead,
      snapshot: desktopReadSystem.desktopSnapshot,
      taskHistory: desktopReadSystem.desktopTaskHistory,
      readTurn: (identity) => workLogUsageStore.getTurn(identity),
      searchMessage: (identity) => taskSyncStore.searchMessage(identity),
      threadsForStream: (streamId) => workspaceCatalogStore.threadsForStream(streamId),
      samePath,
      warn: (...args) => console.warn(...args),
      pinTitle: pinTaskTitle,
      sendRpc,
      expectTitleConfirmation: runtime.expectTaskTitleConfirmation,
      invalidateCatalog: invalidateTaskCatalog,
      runForTask: (target) => taskRuns.forTask(target),
      taskBoard,
      workspaceCatalog: workspaceCatalogStore,
      updateRunTitle: updateTaskRunTitle,
      catalogEntryIsSelected,
      selection: {
        current: selectedTask,
        setTitle: (title) => selectionStore.setTitle(title),
        clearCodex: () => selectionStore.setThread(null, { provider: "codex", title: "" }),
        selectCodex: (id, title) => selectionStore.setThread(id, { provider: "codex", title }),
      },
      saveTitles: savePinnedTaskTitles,
      saveState,
      deleteCodexSettings: (targetThreadId) => runtime.taskMetadata.deleteCodexSettings(targetThreadId),
      listCodexTasks: listThreads,
      codexTaskTitle: threadTitle,
      restoreCodexSettings: restoreCodexTaskSettings,
      diffs: {
        setLatest: (value) => hostState.setLatestDiff(value),
        forTask: (target) => taskDiffs.get(taskRunKey(target)) ?? "",
        refresh: runtime.refreshTaskDiff,
      },
      providerCancel: (run) => agentProviders.call(run.provider, "cancelRun", run),
      progress: {
        setStage: (...args) => taskProgress.setStage(...args),
        finish: (...args) => taskProgress.finish(...args),
      },
      dismissedExternalTasks,
      completeRun: (run) => managedRunLifecycle.complete(run),
      createTask: createThread,
      prepareTaskCreation,
      streamContextMaintenance,
      workspaceCatalog: workspaceCatalogStore,
      workspaceCatalogService: workspaceCatalog,
      workspaceMutation,
      blockingWorkCount: runtime.restartBlockingWorkCount,
      announceDesktopRestart,
      sendTelegram: sendMessage,
      performRestart,
      findProject,
      selectionStore,
      rememberCodexSettings: rememberCodexTaskSettings,
      captureCodexPreferences: () => agentPreferences.captureCodex(),
      restoreCodexPreferences: (value) => agentPreferences.restoreCodex(value),
      storedCodexThreadTitle,
      taskRunKey,
      storedTaskDiff: (key) => taskDiffs.get(key),
      codexTransportRunning: () => codexTransport.running,
      startCodex: startCodexAppServer,
      initializeCodex,
      attachCodexThread,
      isCompacting: (value) => contextCompactions.isRunning(value),
      switchCodexModel,
      switchClaudeModel: switchModel,
      updateCodexThreadSettings: updateActiveCodexThreadSettings,
      getCodexReasoning: () => agentPreferences.codexReasoningEffort,
      setCodexReasoning: (value) => agentPreferences.setCodexReasoning(value),
      getClaudeReasoning: () => agentPreferences.claudeReasoningEffort,
      setClaudeReasoning: (value) => agentPreferences.setClaudeReasoning(value),
      getCodexMode: () => agentPreferences.codexCollaborationMode,
      setCodexMode: (value) => agentPreferences.setCodexMode(value),
      getClaudeMode: () => agentPreferences.claudeCollaborationMode,
      setClaudeMode: (value) => agentPreferences.setClaudeMode(value),
      getIncludeClaudeUsage: () => agentPreferences.includeClaudeUsage,
      setIncludeClaudeUsage: (value) => {
        agentPreferences.setIncludeClaudeUsage(value);
        workLogUsageStore.setIncludeClaudeUsage(value);
      },
      getActivityRecentMinutes: () => agentPreferences.activityRecentMinutes,
      setActivityRecentMinutes: (value) => agentPreferences.setActivityRecentMinutes(value),
      projectUsage: () => workLogUsageStore.project(null, {
        projectRoot: config.projectRoot,
        projectionProjectRoots: globalWorkLogProjectRoots,
      }),
      approvalController,
      preferencesSnapshot: () => agentPreferences.snapshot(),
      selectedRun,
      sendTaskSwitchNotification: (options) => sendTaskSwitchNotification(
        telegramSelectionNotificationOptions(options),
      ),
      sendTaskAlreadySelectedNotification: (options) => sendTaskAlreadySelectedNotification(
        telegramSelectionNotificationOptions(options),
      ),
      formatArchiveMessage,
      sendMessage: sendMessageTo,
      showLastMessageReplyMarkup,
      bindRunMessage,
      telegram,
      telegramTaskTitle,
      telegramSelectedTurnTarget,
      telegramCurrentUiContextToken,
      telegramUiCallback,
      selectTelegramTaskFromBinding,
      clearTelegramTaskSelection,
    },
  });

  const desktopActions = desktopCommands.desktopSnapshotActions;
  const desktopRunRouter = createDesktopRunRouterWiring({
    config,
    constants: { maxDeferredInputs, taskExecutionOwners },
    state: {
      chatId: () => hostState.chatId,
      selectedTask,
      telegramSelectedTask,
      activeTaskTitle: selectedTaskTitle,
    },
    services: {
      startManualCompaction: (target) => streamContextMaintenance.compact(target),
      deferredInputs,
      saveState,
      executionRuntimeLabel: taskExecutionRuntimeLabel,
      sendMessageTo,
      resolveRepoRoots: resolveTaskGitRepoRoots,
      refreshCatalog: refreshTaskCatalog,
      activeRuns: () => taskRuns.values(),
      findConflict: findRepositoryWriteConflict,
      taskRuns,
      providers: agentProviders,
      externalActivity: taskExternalActivity,
      beginRun: (input, target) => managedRunLifecycle.begin(input, target),
      rollbackAdmission: (run) => managedRunLifecycle.releaseAdmission(run),
      launchTurn,
      describeAttachments: desktopAttachmentDescriptors,
      hasDeferredBacklog: (target) => deferredInputs.hasBacklog(target),
      isMaintenanceActive: (target) => streamContextMaintenance.isActive(target),
      scheduleDeferred: scheduleQueuedInput,
      setProgressStage: (...args) => taskProgress.setStage(...args),
      noteRunActivity: (...args) => taskProgress.noteActivity(...args),
      scheduleProgressUpdate: (...args) => taskProgress.schedule(...args),
      telegram,
      attachmentPaths: desktopAttachmentPaths,
      receipts: desktopMessageReceipts,
      pendingInputs,
      queuedInputs,
      findReceiptByResultId: (id) => desktopMessageReceipts.findByResultId(id),
      isDeferredInputProcessing,
      cancelDeferredInputSchedule,
      updateDeferredReceipt: updateDeferredDesktopReceipt,
      cleanupDeferredFiles,
      updateDeferredMessage,
      scheduleNextDeferredInput,
      scheduleQueuedInput,
      startTurn,
      runForTask: (target) => taskRuns.forTask(target),
      setAutostart: (params) => serverControlController.setAutostart(params),
      updateServerConfiguration: (params) => serverControlController.updateConfiguration(params),
      readPreTurnInstructions: () => serverControlController.readPreTurnInstructions(),
      updateGlobalPreTurnInstructions: (params) => serverControlController.updateGlobalPreTurnInstructions(params),
      readRootAgents: () => serverControlController.readRootAgents(),
      updateRootAgents: (params) => serverControlController.updateRootAgents(params),
      taskBoard,
      workspaceCatalog: workspaceCatalogStore,
    },
    desktop: {
      snapshot: desktopReadSystem.desktopSnapshot,
      taskHistory: desktopReadSystem.desktopTaskHistory,
      rateLimitHistory: desktopReadSystem.desktopRateLimitHistory,
      usageHistory: desktopReadSystem.desktopUsageHistory,
      search: desktopReadSystem.desktopSearch,
      workspaceMessageSearch: desktopReadSystem.desktopWorkspaceMessageSearch,
      openTask: desktopActions.openTask,
      openTurn: desktopActions.openTurn,
      taskDiff: desktopActions.taskDiff,
      statusDetails: desktopReadSystem.desktopStatusDetails,
      speakLastAnswer: desktopReadSystem.desktopSpeakLastAnswer,
      restartServer: desktopActions.restartServer,
      openAttachment: desktopOpenAttachment,
      submitBugReport: desktopSubmitBugReport,
      reportDiagnostic: diagnostics.reportClientError,
      trustedDevices: desktopReadSystem.desktopTrustedDevices,
      createDevicePairing: desktopReadSystem.desktopCreateDevicePairing,
      revokeDevice: desktopReadSystem.desktopRevokeDevice,
      messageTarget: desktopActions.messageTarget,
      selectTaskFromBinding: desktopCommands.selectTaskFromBinding,
      dispatchApplicationCommand: desktopCommands.dispatchApplicationCommand,
      settingCommandTarget: desktopCommands.settingCommandTarget,
      applicationCommands: desktopCommands.applicationCommands,
    },
  });

  desktopCommandsPort.bind({
    messageTarget: desktopActions.messageTarget,
    snapshot: desktopReadSystem.desktopSnapshot,
    trustedDeviceUserId: desktopReadSystem.trustedDeviceUserId,
    handleDesktopControl: desktopRunRouter.handleDesktopControl,
    reconcileRemoteDesktopControl: desktopRunRouter.reconcileRemoteDesktopControl,
    forgetDesktopControl: desktopRunRouter.forgetDesktopControl,
  });

  return {
    ...desktopCommands,
    ...desktopRunRouter,
  };
}
