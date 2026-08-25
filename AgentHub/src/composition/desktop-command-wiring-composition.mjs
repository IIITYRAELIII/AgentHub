import { createDesktopCommandComposition } from "./desktop-command-composition.mjs";

export function createWorkspaceActions(services) {
  return {
    renameWorkspace: (params) => services.workspaceMutation(
      () => services.workspaceCatalogService.renameWorkspace(params),
    ),
    updateWorkspaceSettings: (params) => services.workspaceMutation(
      () => services.workspaceCatalogService.updateWorkspaceSettings(params),
    ),
    updateWorkspaceDeveloperRules: (params) => services.workspaceMutation(
      () => services.workspaceCatalogService.updateWorkspaceDeveloperRules(params),
    ),
    readWorkspaceReleaseRegistry: (params) => services.workspaceCatalogService.releaseRegistry(params),
    readWorkspaceReleasePlan: (params) => services.workspaceCatalogService.releasePlan(params),
    updateReleaseChangeStatus: (params) => {
      const updated = services.workspaceCatalogService.updateReleaseChangeStatus(params);
      return services.workspaceCatalogService.releaseRegistry({ workspaceId: updated.workspaceId });
    },
    completeWorkspaceRelease: (params) => services.workspaceCatalogService.completeRelease(params),
    createWorkspace: (params) => services.workspaceMutation(
      () => services.workspaceCatalogService.createWorkspace(params),
      { resultKey: "createdWorkspace" },
    ),
    createWorkspaceFromStream: (params) => services.workspaceMutation(
      () => {
        const sourceWorkspaceId = services.workspaceCatalog.stream(params?.streamId)?.workspaceId;
        const result = services.workspaceCatalogService.createWorkspaceFromStream(params);
        if (sourceWorkspaceId && !services.workspaceCatalog.workspace(sourceWorkspaceId)) {
          services.taskBoard.reassignWorkspace(sourceWorkspaceId, result.workspace.id);
        }
        return result;
      },
    ),
    mergeWorkspaces: (params) => services.workspaceMutation(
      () => {
        const result = services.workspaceCatalogService.mergeWorkspaces(params);
        services.taskBoard.reassignWorkspace(
          params?.sourceWorkspaceId,
          params?.targetWorkspaceId,
        );
        return result;
      },
    ),
    createStream: (params) => services.workspaceMutation(
      () => services.workspaceCatalogService.createStream(params),
      { resultKey: "createdStream" },
    ),
    renameStream: (params) => services.workspaceMutation(
      () => services.workspaceCatalogService.renameStream(params),
    ),
    archiveStream: (params) => services.workspaceMutation(
      () => {
        const streamId = String(params?.streamId ?? "").trim();
        const running = services.catalogEntries().find((entry) => (
          entry.streamId === streamId && services.runForTask(entry)
        ));
        if (running) throw new Error("Сначала завершите активный ход в этом Stream");
        return services.workspaceCatalogService.archiveStream({ streamId });
      },
    ),
    updateStreamSettings: (params) => services.workspaceMutation(
      () => services.workspaceCatalogService.updateStreamSettings(params),
    ),
    updateStreamDeveloperRules: (params) => services.workspaceMutation(
      () => services.workspaceCatalogService.updateStreamDeveloperRules(params),
    ),
    moveStream: (params) => services.workspaceMutation(
      () => {
        const sourceWorkspaceId = services.workspaceCatalog.stream(params?.streamId)?.workspaceId;
        const result = services.workspaceCatalogService.moveStream(params);
        if (sourceWorkspaceId && !services.workspaceCatalog.workspace(sourceWorkspaceId)) {
          services.taskBoard.reassignWorkspace(sourceWorkspaceId, params?.workspaceId);
        }
        return result;
      },
    ),
  };
}

export function createDesktopCommandWiring({
  models,
  projects,
  state,
  services,
}) {
  let commands;
  const switchProvider = (...args) => commands.taskNavigationService.switchProvider(...args);
  const switchProject = (...args) => commands.taskNavigationService.switchProject(...args);
  const activateBinding = (...args) => commands.taskNavigationService.activate(...args);
  const resolveDesktopApproval = (params) => services.approvalController.resolveFromDesktop(
    String(params.key ?? ""),
    String(params.decision ?? ""),
    params,
  );

  commands = createDesktopCommandComposition({
    taskService: {
      catalog: services.catalogEntries,
      refreshCatalog: services.refreshCatalog,
      activateBinding,
      markRead: services.markTaskRead,
      snapshot: services.snapshot,
      taskHistory: services.taskHistory,
      readTurn: services.readTurn,
      searchMessage: services.searchMessage,
      threadsForStream: services.threadsForStream,
      currentThread: services.currentThread,
      samePath: services.samePath,
      chatId: state.chatId,
      warn: services.warn,
    },
    taskCommands: {
      pinTitle: services.pinTitle,
      renameCodexTask: (targetThreadId, title) => services.sendRpc("thread/name/set", {
        threadId: targetThreadId,
        name: title,
      }),
      expectTitleConfirmation: services.expectTitleConfirmation,
      invalidateCatalog: services.invalidateCatalog,
      runForTask: services.runForTask,
      updateRunTitle: services.updateRunTitle,
      catalogEntries: services.catalogEntries,
      catalogEntryIsSelected: services.catalogEntryIsSelected,
      selection: services.selection,
      saveTitles: services.saveTitles,
      saveState: services.saveState,
      snapshot: services.snapshot,
      readCodexTask: async (targetThreadId) => (await services.sendRpc("thread/read", {
        threadId: targetThreadId,
        includeTurns: false,
      })).thread,
      archiveCodexTask: (targetThreadId) => services.sendRpc("thread/archive", {
        threadId: targetThreadId,
      }),
      deleteCodexSettings: services.deleteCodexSettings,
      listCodexTasks: services.listCodexTasks,
      codexTaskTitle: services.codexTaskTitle,
      restoreCodexSettings: services.restoreCodexSettings,
      diffs: services.diffs,
      providerCancel: services.providerCancel,
      progress: services.progress,
      dismissedExternalTasks: services.dismissedExternalTasks,
      completeRun: services.completeRun,
      createTask: services.createTask,
      rotateStream: (target) => services.streamContextMaintenance.rotate(target),
      workspaceCatalog: services.workspaceCatalog,
      streamHandoff: services.streamHandoff,
      selectionStore: services.selectionStore,
      activeProvider: state.activeProvider,
      switchProvider,
      prepareTaskCreation: services.prepareTaskCreation,
    },
    restart: {
      getRequest: state.restartRequest,
      setRequest: state.setRestartRequest,
      blockingWorkCount: services.blockingWorkCount,
      currentChatId: state.chatId,
      updateOffset: state.updateOffset,
      processingUpdateId: state.processingUpdateId,
      saveState: services.saveState,
      announceDesktop: services.announceDesktopRestart,
      sendTelegram: services.sendTelegram,
      performRestart: services.performRestart,
      isStopping: state.isStopping,
    },
    navigation: {
      projects,
      samePath: services.samePath,
      findProject: services.findProject,
      selectionStore: services.selectionStore,
      activeProjectRoot: state.activeProjectRoot,
      activeProvider: state.activeProvider,
      threadId: state.threadId,
      activeTaskTitle: state.activeTaskTitle,
      isCodex: state.isCodex,
      rememberCodexSettings: services.rememberCodexSettings,
      captureCodexPreferences: services.captureCodexPreferences,
      restoreCodexPreferences: services.restoreCodexPreferences,
      restoreCodexThreadSettings: services.restoreCodexSettings,
      storedCodexThreadTitle: services.storedCodexThreadTitle,
      selectedTask: state.selectedTask,
      taskRunKey: services.taskRunKey,
      storedTaskDiff: services.storedTaskDiff,
      latestDiff: state.latestDiff,
      setLatestDiff: state.setLatestDiff,
      createThread: services.createTask,
      codexTransportRunning: services.codexTransportRunning,
      startCodex: services.startCodex,
      initializeCodex: services.initializeCodex,
      attachCodexThread: services.attachCodexThread,
      saveState: services.saveState,
    },
    settings: {
      isSelected: services.catalogEntryIsSelected,
      selectedTask: state.selectedTask,
      switchProvider,
      isCodex: state.isCodex,
      threadId: state.threadId,
      isCompacting: services.isCompacting,
      switchCodexModel: services.switchCodexModel,
      switchClaudeModel: services.switchClaudeModel,
      updateCodexThreadSettings: services.updateCodexThreadSettings,
      saveState: services.saveState,
      getCodexReasoning: services.getCodexReasoning,
      setCodexReasoning: services.setCodexReasoning,
      getClaudeReasoning: services.getClaudeReasoning,
      setClaudeReasoning: services.setClaudeReasoning,
      getCodexMode: services.getCodexMode,
      setCodexMode: services.setCodexMode,
      getClaudeMode: services.getClaudeMode,
      setClaudeMode: services.setClaudeMode,
      getAutoApprove: state.autoApprove,
      setAutoApprove: state.setAutoApprove,
      getIncludeClaudeUsage: services.getIncludeClaudeUsage,
      setIncludeClaudeUsage: services.setIncludeClaudeUsage,
      getActivityRecentMinutes: services.getActivityRecentMinutes,
      setActivityRecentMinutes: services.setActivityRecentMinutes,
      getStreamOrderMode: services.getStreamOrderMode,
      setStreamOrderMode: services.setStreamOrderMode,
      getStreamCardWidthMode: services.getStreamCardWidthMode,
      setStreamCardWidthMode: services.setStreamCardWidthMode,
      getStreamCardFixedWidth: services.getStreamCardFixedWidth,
      setStreamCardFixedWidth: services.setStreamCardFixedWidth,
      getStreamCardGapEnabled: services.getStreamCardGapEnabled,
      setStreamCardGapEnabled: services.setStreamCardGapEnabled,
      getPinnedWorkspaceStreams: services.getPinnedWorkspaceStreams,
      setPinnedWorkspaceStreams: services.setPinnedWorkspaceStreams,
      projectUsage: services.projectUsage,
      findProjectIndex: (value) => projects.findIndex((project) => (
        services.samePath(project.path, value)
      )),
      switchProject,
      snapshot: services.snapshot,
      reasoningEfforts: models.reasoningEfforts,
      claudeReasoningEfforts: models.claudeReasoningEfforts,
      collaborationModes: models.collaborationModes,
    },
    application: {
      selectedTask: state.selectedTask,
      resolveApproval: (payload) => payload.callback
        ? services.approvalController.handleCallback(payload.callback)
        : resolveDesktopApproval(payload),
    },
    workspaceActions: createWorkspaceActions(services),
    telegramActions: {
      selectedTask: state.telegramSelectedTask ?? state.selectedTask,
      activeProvider: () => (state.telegramSelectedTask ?? state.selectedTask)().provider,
      activeProjectRoot: () => (state.telegramSelectedTask ?? state.selectedTask)().projectRoot,
      activeTaskTitle: services.telegramTaskTitle ?? state.activeTaskTitle,
      currentThreadId: () => (state.telegramSelectedTask ?? state.selectedTask)().threadId,
      selectedTurnTarget: services.telegramSelectedTurnTarget,
      currentUiContextToken: services.telegramCurrentUiContextToken,
      uiCallback: services.telegramUiCallback,
      selectTaskFromBinding: services.selectTelegramTaskFromBinding,
      clearTaskSelection: services.clearTelegramTaskSelection,
      preferencesSnapshot: services.preferencesSnapshot,
      selectedRun: () => services.runForTask((state.telegramSelectedTask ?? state.selectedTask)()),
      sendTaskSwitchNotification: services.sendTaskSwitchNotification,
      sendTaskAlreadySelectedNotification: services.sendTaskAlreadySelectedNotification,
      isCodex: () => (state.telegramSelectedTask ?? state.selectedTask)().provider === "codex",
      threadTitle: services.codexTaskTitle,
      formatArchiveMessage: services.formatArchiveMessage,
      sendMessage: services.sendMessage,
      showLastMessageReplyMarkup: services.showLastMessageReplyMarkup,
      bindRunMessage: services.bindRunMessage,
      telegram: services.telegram,
    },
  });

  return {
    ...commands,
    switchProvider,
    switchProject,
    activateBinding,
  };
}
