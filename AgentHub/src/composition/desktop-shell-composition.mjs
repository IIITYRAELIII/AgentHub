import { createDesktopReadSystemWiring } from "./desktop-read-system-wiring-composition.mjs";
import { createContourCommandMapping } from "../infrastructure/filesystem/test-contour-command-mapping.mjs";
import { createDesktopCommandWiring } from "./desktop-command-wiring-composition.mjs";
import { createDesktopRunRouterWiring } from "./desktop-run-router-wiring-composition.mjs";
import { createDesktopTaskCreationPreparation } from "./desktop-task-creation-composition.mjs";
import { WorkspaceCatalogService } from "../application/workspace-catalog-service.mjs";
import { ClientTaskSelectionService } from "../application/client-task-selection-service.mjs";
import { agentHubRuntimeHealth } from "../application/runtime-health.mjs";
import { retryAgentHubStartup } from "../application/agent-hub-startup-coordinator.mjs";
import { StreamMessagePinService } from "../application/stream-message-pin-service.mjs";

export function createDesktopShellComposition({
  config, server = {}, diagnostics, limits, models, state, catalog,
  runtime, provider, clients, presentation, repositories,
  serverControlController, desktopCommandsPort,
}) {
  const { projects, maxSpeechJobs, maxDeferredInputs, taskExecutionOwners,
    globalWorkLogProjectRoots } = limits;
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
    messagePins,
    taskRunIsActive,
    backgroundJobs,
    rateLimitTelemetry,
    rateLimitHistoryStore,
    providerTurnTelemetryStore,
    workLogUsageStore,
    workLogUsageRemoteConfigStore,
    workspaceCatalogStore,
    taskReleasePlanner,
    workspaceReleaseService,
    streamHandoff,
    runtimeStateStore,
    commandTraceService,
    taskReadStateStore,
    usdRubRateStore,
    pendingInputs,
    queuedInputs,
    contextCompactions,
    maintenanceOperations,
    approvalController,
    taskDiffs,
    managedRunLifecycle,
    deferredInputs, composerTransfers,
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
    taskLifecycle,
    taskGitWorkspaces,
    taskVoiceTranscriber,
    attachmentDirectory,
    usageSyncAuto,
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
  const { resolveTaskGitRepoRoots, findRepositoryWriteConflict } = repositories;

  const streamMessagePins = new StreamMessagePinService({
    store: messagePins,
    workspaceCatalog: workspaceCatalogStore,
    resolveMessage: (identity) => taskSyncStore.durableMessageCandidate(identity),
  });

  const contourCommandMapping = config.testContourRecording
    ? createContourCommandMapping({ root: config.testContourRecording.root,
      readCommand: (id) => runtimeStateStore.messageCommand(id) })
    : null;

  const desktopReadSystem = createDesktopReadSystemWiring({
    contourCommandMapping,
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
      readProviderTurnTelemetry: (params) => providerTurnTelemetryStore?.recent?.(params) ?? [],
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
          messagePins: messagePins.revision, taskHistory: taskSyncStore.revision,
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
      archivedWorkspaces: () => workspaceCatalogStore.archivedWorkspaces(),
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
      messagePinsSnapshot: () => streamMessagePins.snapshot(),
      receiptsForTurn: (identity) => desktopMessageReceipts.findAllByTurn(identity),
      interstreamOriginForClientMessage: (clientUserMessageId) => (
        workspaceCatalogStore.interstreamOriginForClientMessage(clientUserMessageId)
      ),
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
      readHistoryPage: (...args) => taskSyncStore.readHistoryPage(...args),
      refreshHistory,
      attachmentImporter: importCodexDesktopAttachments,
      warn: (...args) => console.warn(...args),
    },
  });

  let desktopRunCoordinator = null;
  const blockingRunForWorkspace = (workspaceId) => {
    const activeRun = taskRuns.values().find((run) => (
      taskRunIsActive(run)
      && workspaceCatalogStore.stream(run.streamId)?.workspaceId === workspaceId
    ));
    if (activeRun) return activeRun;
    return desktopRunCoordinator?.hasPendingAdmission((target) => (
      workspaceCatalogStore.stream(target.streamId)?.workspaceId === workspaceId
    )) ? { status: "admitting" } : null;
  };
  const workspaceCatalog = new WorkspaceCatalogService({
    store: workspaceCatalogStore,
    taskBoard,
    releasePlanner: taskReleasePlanner,
    releaseCompleter: workspaceReleaseService,
    blockingRunForWorkspace,
  });
  const workspaceMutation = async (run, { resultKey = "" } = {}) => {
    const result = await run();
    invalidateTaskCatalog();
    await saveState();
    const snapshot = await desktopReadSystem.desktopSnapshot({ refresh: true });
    return resultKey ? { ...snapshot, [resultKey]: result } : snapshot;
  };

  const prepareTaskCreation = createDesktopTaskCreationPreparation({
    selectedProjectRoot,
    findProject,
    taskGitWorkspaces,
    selectionStore,
    agentPreferences,
    hostState,
    saveState,
  });

  const canonicalSelection = (value) => contourCommandMapping ? contourCommandMapping.target(value) : value;
  const telegramSelection = new ClientTaskSelectionService({
    sessionState: hostState,
    fallbackSelection: () => canonicalSelection(selectedTask()),
    fallbackTitle: selectedTaskTitle,
    findProject,
    catalogEntries: () => contourCommandMapping ? getTaskCatalog().map((entry) => contourCommandMapping.readReference(entry)) : getTaskCatalog(),
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
  const selectTelegramTaskFromBinding = (binding, ...args) => telegramSelection.select(canonicalSelection(binding), ...args);
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
      snapshot: desktopReadSystem.desktopSnapshot,
      taskHistory: desktopReadSystem.desktopTaskHistory,
      readTurn: (identity) => workLogUsageStore.getTurn(identity),
      searchMessage: (identity) => taskSyncStore.searchMessage(identity),
      threadsForStream: (streamId) => workspaceCatalogStore.threadsForStream(streamId),
      currentThread: (streamId) => workspaceCatalogStore.activeThread(streamId),
      samePath,
      warn: (...args) => console.warn(...args),
      pinTitle: pinTaskTitle,
      sendRpc,
      expectTitleConfirmation: runtime.expectTaskTitleConfirmation,
      invalidateCatalog: invalidateTaskCatalog,
      runForTask: (target) => taskRuns.forTask(target),
      taskBoard,
      workspaceCatalog: workspaceCatalogStore,
      streamMessagePins,
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
      streamHandoff,
      workspaceCatalog: workspaceCatalogStore,
      workspaceCatalogService: workspaceCatalog,
      workspaceMutation,
      blockingWorkCount: runtime.restartBlockingWorkCount,
      maintenanceOperations,
      announceDesktopRestart,
      sendTelegram: sendMessage,
      performRestart,
      findProject,
      selectionStore,
      rememberCodexSettings: rememberCodexTaskSettings,
      captureCodexPreferences: () => agentPreferences.captureCodex(),
      restoreCodexPreferences: (value) => agentPreferences.restoreCodex(value),
      agentPreferences,
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
      getStreamOrderMode: () => agentPreferences.streamOrderMode,
      setStreamOrderMode: (value) => agentPreferences.setStreamOrderMode(value),
      getStreamCardWidthMode: () => agentPreferences.streamCardWidthMode,
      setStreamCardWidthMode: (value) => agentPreferences.setStreamCardWidthMode(value),
      getStreamCardFixedWidth: () => agentPreferences.streamCardFixedWidth,
      setStreamCardFixedWidth: (value) => agentPreferences.setStreamCardFixedWidth(value),
      getStreamCardGapEnabled: () => agentPreferences.streamCardGapEnabled,
      setStreamCardGapEnabled: (value) => agentPreferences.setStreamCardGapEnabled(value),
      getPinnedWorkspaceStreams: () => agentPreferences.pinnedWorkspaceStreams,
      setPinnedWorkspaceStreams: (value) => agentPreferences.setPinnedWorkspaceStreams(value),
      getQuickMessages: () => agentPreferences.quickMessages,
      setQuickMessages: (value) => agentPreferences.setQuickMessages(value),
      getQuickMessageActionMode: () => agentPreferences.quickMessageActionMode,
      setQuickMessageActionMode: (value) => agentPreferences.setQuickMessageActionMode(value),
      projectUsage: (includeClaudeUsage) => workLogUsageStore.project(null, {
        includeClaudeUsage,
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
      contourCommandMapping,
      deferredInputs, composerTransfers,
      saveState,
      persistDeferredIntake: (item, destination, fallbackReceipt = null) => runtimeStateStore.saveDeferredIntake({
        item,
        destination,
        receipt: desktopMessageReceipts.get({
          provider: item.provider,
          threadId: item.threadId,
          clientUserMessageId: item.clientUserMessageId,
        }) ?? fallbackReceipt,
      }),
      commandTrace: commandTraceService,
      usageSyncAuto,
      usageSyncRemoteConfigStore: workLogUsageRemoteConfigStore,
      executionRuntimeLabel: taskExecutionRuntimeLabel,
      sendMessageTo,
      resolveRepoRoots: resolveTaskGitRepoRoots,
      refreshCatalog: refreshTaskCatalog,
      activeRuns: () => taskRuns.values().filter(taskRunIsActive),
      findConflict: findRepositoryWriteConflict,
      taskRuns,
      providers: agentProviders,
      externalActivity: taskExternalActivity,
      beginRun: (input, target) => {
        const targetStreamId = String(target?.streamId ?? "").trim();
        const targetStream = targetStreamId ? workspaceCatalogStore.stream(targetStreamId) : null;
        if (targetStreamId && (
          !targetStream || workspaceCatalog.permanentDeletionPending(targetStream.workspaceId)
        )) {
          const error = new Error("Run target Workspace or Stream no longer exists");
          error.code = "RUN_TARGET_NOT_FOUND";
          throw error;
        }
        return managedRunLifecycle.begin(input, target);
      },
      rollbackAdmission: (run) => managedRunLifecycle.releaseAdmission(run),
      launchTurn,
      describeAttachments: desktopAttachmentDescriptors,
      hasDeferredBacklog: (target) => deferredInputs.hasBacklog(target),
      isMaintenanceActive: (target) => streamContextMaintenance.isActive(target),
      isRestartPending: () => Boolean(hostState.restartRequest),
      scheduleDeferred: scheduleQueuedInput,
      setProgressStage: (...args) => taskProgress.setStage(...args),
      noteRunActivity: (...args) => taskProgress.noteActivity(...args),
      scheduleProgressUpdate: (...args) => taskProgress.schedule(...args),
      rekeyDeferredOccupancy: (binding) => runtimeStateStore.rekeyMessageCommandOccupancy(binding),
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
      taskVoiceTranscriber,
      taskLifecycle,
      attachmentDirectory,
      workspaceCatalog: workspaceCatalogStore,
      streamMessagePins,
    },
    desktop: {
      snapshot: desktopReadSystem.desktopSnapshot,
      runtimeHealth: () => ({
        ...agentHubRuntimeHealth.snapshot(),
        process: {
          pid: process.pid,
          instanceId: String(server.instanceId ?? ""),
          releaseId: String(server.releaseId ?? ""),
        },
      }),
      retryStartup: retryAgentHubStartup,
      taskHistory: desktopReadSystem.desktopTaskHistory,
      rateLimitHistory: desktopReadSystem.desktopRateLimitHistory,
      usageHistory: desktopReadSystem.desktopUsageHistory,
      search: desktopReadSystem.desktopSearch,
      workspaceMessageSearch: desktopReadSystem.desktopWorkspaceMessageSearch,
      markTaskRead: desktopReadSystem.markDesktopTaskRead,
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
  desktopRunCoordinator = desktopRunRouter.runCoordinator;
  approvalController.asyncQuestions?.setSender(async (params) => {
    const current = await desktopActions.messageTarget({ streamId: params.streamId });
    if (current.provider !== params.provider || current.threadId !== params.threadId) {
      throw new Error("После отправки вопроса сменился Thread. Автоматический перенос ответа запрещён; уточните исход отправки в истории.");
    }
    // Resolve an exact provider Thread rather than a moving Stream head. The
    // frozen destination cannot silently change the message-ledger identity.
    const { streamId: _streamId, ...exact } = params;
    return desktopRunRouter.desktopMessageController.sendMessage(exact, {
      source: "desktop-control", clientId: "agent-question-form",
      commandId: params.clientUserMessageId,
    });
  }, async (streamId) => {
    const target = await desktopActions.messageTarget({ streamId });
    return { streamId: target.streamId, provider: target.provider, threadId: target.threadId };
  });

  desktopCommandsPort.bind({
    messageTarget: desktopActions.messageTarget,
    snapshot: desktopReadSystem.desktopSnapshot,
    trustedDeviceUserId: desktopReadSystem.trustedDeviceUserId,
    handleDesktopControl: desktopRunRouter.handleDesktopControl,
    reconcileRemoteDesktopControl: desktopRunRouter.reconcileRemoteDesktopControl,
    forgetDesktopControl: desktopRunRouter.forgetDesktopControl,
  });

  return { ...desktopCommands, ...desktopRunRouter };
}
