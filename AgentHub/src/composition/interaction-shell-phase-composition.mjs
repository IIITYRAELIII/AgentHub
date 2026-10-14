import { samePath } from "../infrastructure/filesystem/config.mjs";
import {
  resolveTaskGitRepoRoots,
  taskGitDiff,
} from "../infrastructure/filesystem/task-git-diff.mjs";
import { findRepositoryWriteConflict } from "../infrastructure/filesystem/repository-conflict.mjs";
import { sentryDiagnostics } from "../infrastructure/diagnostics/sentry-diagnostics.mjs";
import {
  appendMessageBindings,
  readMessageBindings,
  removeMessageBindings,
} from "../infrastructure/persistence/message-bindings.mjs";
import {
  formatProgressHeartbeat,
  retainProgressMessageAfterEditError,
} from "../runtime/progress-heartbeat.mjs";
import { taskRunIsActive, taskRunKey, updateTaskRunTitle } from "../domain/task-runs.mjs";
import { restartUiProjection } from "../domain/maintenance-operation.mjs";
import { taskViewCallbackData } from "../interfaces/telegram/task-view-callback.mjs";
import {
  mergeTaskCatalog,
  taskOrderingActivityAtMs,
} from "../application/task-catalog-projection.mjs";
import { catalogEntryIsSelected } from "../domain/task-catalog-identity.mjs";
import {
  TASK_EXECUTION_OWNERS,
  taskExecutionRuntimeLabel,
} from "../domain/task-execution-owner.mjs";
import * as telegramStatus from "../interfaces/telegram/status.mjs";
import { createDesktopShellComposition } from "./desktop-shell-composition.mjs";
import { createRunShellComposition } from "./run-shell-composition.mjs";
import { createServerControlComposition } from "./server-control-composition.mjs";

const {
  formatArchiveMessage,
  formatProgressHeading,
  formatTaskAlreadySelectedMessage,
  formatTaskSwitchMessage,
  showLastMessageReplyMarkup,
} = telegramStatus;

const DESKTOP_TASK_SYNC_STORE_METHODS = Object.freeze([
  "searchMessages",
  "messageSearchStatus",
  "markMessageSearchThread",
]);

export function requireDesktopTaskSyncStore(provider) {
  const taskSyncStore = provider?.taskSyncStore;
  for (const method of DESKTOP_TASK_SYNC_STORE_METHODS) {
    if (typeof taskSyncStore?.[method] !== "function") {
      throw new TypeError(`provider.taskSyncStore.${method} is required`);
    }
  }
  return taskSyncStore;
}

export function mcpTaskLaunchContext(context = {}) {
  const source = context && typeof context === "object" && !Array.isArray(context)
    ? context
    : {};
  return {
    ...source,
    source: "mcp",
    clientId: `mcp:${String(source.provider ?? "").trim()}:${String(source.auditThreadId ?? "").trim()}`,
  };
}

export function configureMcpTaskLauncher({ hubMcpService, taskBoardLauncher } = {}) {
  if (typeof hubMcpService?.setTaskLauncher !== "function") {
    throw new TypeError("hubMcpService.setTaskLauncher is required");
  }
  if (typeof taskBoardLauncher?.start !== "function") {
    throw new TypeError("taskBoardLauncher.start is required");
  }
  hubMcpService.setTaskLauncher((params, context) => (
    taskBoardLauncher.start(params, mcpTaskLaunchContext(context))
  ));
}

export function requireRuntimeStateStore(infrastructure) {
  const runtimeStateStore = infrastructure?.runtimeStateStore;
  if (typeof runtimeStateStore?.saveDeferredIntake !== "function") {
    throw new TypeError("infrastructure.runtimeStateStore.saveDeferredIntake is required");
  }
  return runtimeStateStore;
}

export function createInteractionShellPhase({
  config,
  root,
  server,
  settings,
  selection,
  infrastructure,
  provider,
  clients,
  deferred,
}) {
  const api = deferred.api;
  const ports = deferred.ports;
  const runtimeStateStore = requireRuntimeStateStore(infrastructure);
  const taskSyncStore = requireDesktopTaskSyncStore(provider);
  const serverControlController = createServerControlComposition({
    config,
    agentHubRoot: root,
    serverStartedAt: server.startedAt,
    serverInstanceId: server.instanceId,
    serverReleaseId: server.releaseId,
    shortcutPath: server.autostartShortcutPath,
    activeRunCount: () => provider.taskRuns.values().filter(taskRunIsActive).length,
    restartSnapshot: () => restartUiProjection(selection.hostState.restartRequest),
    desktopSnapshot: api.desktopSnapshot,
    spawnCapture: provider.spawnCapture,
    preTurnInstructions: infrastructure.preTurnInstructions,
    providerLogin: clients.providerLogin,
  });

  const desktopShell = createDesktopShellComposition({
    config,
    server,
    diagnostics: {
      reportClientError: (event, context) => sentryDiagnostics.captureClientEvent(event, context),
    },
    limits: {
      projects: settings.projects,
      maxSpeechJobs: settings.maxBackgroundSpeechJobs,
      maxDeferredInputs: settings.maxDeferredInputs,
      taskExecutionOwners: TASK_EXECUTION_OWNERS,
      globalWorkLogProjectRoots: settings.globalWorkLogProjectRoots,
    },
    models: {
      codexModels: settings.codexModels,
      modelCatalogRevision: settings.modelCatalogRevision,
      refreshCodexModels: settings.refreshCodexModels,
      codexModelLabel: settings.codexModelLabel,
      claudeModels: settings.claudeModels,
      claudeModelLabels: settings.claudeModelLabels,
      claudeModelLabel: settings.claudeModelLabel,
      reasoningEfforts: settings.codexReasoningEfforts,
      reasoningLabels: settings.codexReasoningLabels,
      claudeReasoningEfforts: settings.claudeReasoningEfforts,
      claudeReasoningLabels: settings.claudeReasoningLabels,
      collaborationModes: settings.codexCollaborationModes,
      collaborationModeLabels: settings.codexCollaborationModeLabels,
    },
    state: {
      hostState: selection.hostState,
      selectionStore: selection.selectionStore,
      agentPreferences: selection.agentPreferences,
      selectedProvider: selection.selectedProvider,
      selectedProjectRoot: selection.selectedProjectRoot,
      selectedTaskTitle: selection.selectedTaskTitle,
      selectedThreadId: selection.selectedThreadId,
      isCodex: selection.isCodex,
      selectedTask: api.selectedTask,
      selectedTurnTarget: api.selectedTurnTarget,
      activeProject: api.activeProject,
      selectedRun: api.selectedRun,
      saveState: api.saveState,
      savePinnedTaskTitles: api.savePinnedTaskTitles,
    },
    catalog: {
      getTaskCatalog: () => provider.taskCatalog,
      refreshTaskCatalog: api.refreshTaskCatalog,
      taskCatalogService: provider.taskCatalogService,
      invalidateTaskCatalog: api.invalidateTaskCatalog,
      mergeTaskCatalog,
      findProject: api.findProject,
      pinTaskTitle: api.pinTaskTitle,
      storedCodexThreadTitle: api.storedCodexThreadTitle,
      dismissedExternalTasks: provider.dismissedExternalTasks,
    },
    runtime: {
      taskRuns: provider.taskRuns,
      taskSyncStore,
      messagePins: provider.messagePins,
      taskRunIsActive,
      backgroundJobs: provider.backgroundJobs,
      rateLimitTelemetry: clients.rateLimitTelemetry,
      rateLimitHistoryStore: infrastructure.rateLimitHistoryStore,
      providerTurnTelemetryStore: infrastructure.providerTurnTelemetryStore,
      commandTraceService: infrastructure.commandTraceService,
      workLogUsageStore: infrastructure.workLogUsageStore,
      workLogUsageRemoteConfigStore: infrastructure.workLogUsageRemoteConfigStore,
      workspaceCatalogStore: infrastructure.workspaceCatalogStore,
      taskReleasePlanner: infrastructure.taskReleasePlanner,
      workspaceReleaseService: infrastructure.workspaceReleaseService,
      releaseOperationCommands: infrastructure.releaseOperationCommands,
      streamHandoff: infrastructure.streamHandoff,
      runtimeStateStore,
      taskBoard: infrastructure.taskBoard,
      taskLifecycle: infrastructure.taskLifecycle,
      taskGitWorkspaces: infrastructure.taskGitWorkspaces,
      taskVoiceTranscriber: infrastructure.taskVoiceTranscriber,
      attachmentDirectory: infrastructure.attachmentDirectory,
      taskReadStateStore: infrastructure.taskReadStateStore,
      usdRubRateStore: infrastructure.usdRubRateStore,
      pendingInputs: provider.pendingInputs,
      queuedInputs: provider.queuedInputs,
      contextCompactions: provider.contextCompactions,
      maintenanceOperations: provider.maintenanceOperations,
      approvalController: clients.approvalController,
      taskDiffs: provider.taskDiffs,
      managedRunLifecycle: provider.managedRunLifecycle,
      deferredInputs: provider.deferredInputs,
      composerTransfers: provider.composerTransfers,
      taskProgress: {
        setStage: (...args) => runShell.taskProgress.setStage(...args),
        finish: (...args) => runShell.taskProgress.finish(...args),
        noteActivity: (...args) => runShell.taskProgress.noteActivity(...args),
        schedule: (...args) => runShell.taskProgress.schedule(...args),
      },
      taskExternalActivity: api.taskExternalActivity,
      scheduleQueuedInput: api.scheduleQueuedInput,
      isDeferredInputProcessing: api.isDeferredInputProcessing,
      cancelDeferredInputSchedule: api.cancelDeferredInputSchedule,
      cleanupDeferredFiles: api.cleanupDeferredFiles,
      updateDeferredDesktopReceipt: api.updateDeferredDesktopReceipt,
      updateDeferredMessage: api.updateDeferredMessage,
      scheduleNextDeferredInput: api.scheduleNextDeferredInput,
      startTurn: api.startTurn,
      launchTurn: api.launchTurn,
      runTaskTitle: api.runTaskTitle,
      trustedDeviceStore: infrastructure.trustedDeviceStore,
      savedLastTaskMessageRecord: api.savedLastTaskMessageRecord,
      lastTaskMessageRevision: api.lastTaskMessageRevision,
      restartBlockingRuns: api.restartBlockingRuns,
      restartBlockingWorkCount: api.restartBlockingWorkCount,
      expectTaskTitleConfirmation: api.expectTaskTitleConfirmation,
      taskMetadata: selection.taskMetadata,
      refreshTaskDiff: api.refreshTaskDiff,
      codexContextMaintenance: provider.codexContextMaintenance,
      streamContextMaintenance: provider.streamContextMaintenance,
      streamMaintenance: provider.streamMaintenance,
      usageSyncAuto: provider.usageSyncAuto,
      usageSyncRemoteConfigStore: infrastructure.workLogUsageRemoteConfigStore,
    },
    provider: {
      agentProviders: provider.agentProviders,
      codexTransport: clients.codexTransport,
      startCodexAppServer: api.startCodexAppServer,
      initializeCodex: api.initializeCodex,
      attachCodexThread: api.attachCodexThread,
      listThreads: api.listThreads,
      threadTitle: api.threadTitle,
      restoreCodexTaskSettings: api.restoreCodexTaskSettings,
      switchCodexModel: api.switchCodexModel,
      switchModel: api.switchModel,
      updateActiveCodexThreadSettings: api.updateActiveCodexThreadSettings,
      rememberCodexTaskSettings: api.rememberCodexTaskSettings,
      createThread: api.createThread,
      sendRpc: api.sendRpc,
      latestThreadContextUsage: api.latestThreadContextUsage,
      importCodexDesktopAttachments: clients.importCodexDesktopAttachments,
    },
    clients: {
      miniAppLifecycle: clients.miniAppLifecycle,
      desktopMessageReceipts: provider.desktopMessageReceipts,
      desktopAttachmentDescriptors: clients.desktopAttachmentDescriptors,
      desktopAttachmentPaths: clients.desktopAttachmentPaths,
      desktopOpenAttachment: clients.desktopOpenAttachment,
      desktopUploadAttachment: clients.desktopUploadAttachment,
      desktopSubmitBugReport: clients.desktopSubmitBugReport,
      readCachedHistory: api.readCachedHistory,
      refreshHistory: api.refreshHistory,
      sendMessage: clients.sendMessage,
      sendMessageTo: clients.sendMessageTo,
      telegram: clients.telegram,
      announceDesktopRestart: api.announceDesktopRestart,
      performRestart: api.performRestart,
      sendTaskSwitchNotification: api.sendTaskSwitchNotification,
      sendTaskAlreadySelectedNotification: api.sendTaskAlreadySelectedNotification,
      bindRunMessage: api.bindRunMessage,
    },
    presentation: {
      formatArchiveMessage,
      showLastMessageReplyMarkup,
      taskExecutionRuntimeLabel,
      catalogEntryIsSelected,
      taskOrderingActivityAtMs,
      updateTaskRunTitle,
      taskRunKey,
      samePath,
    },
    repositories: {
      resolveTaskGitRepoRoots,
      findRepositoryWriteConflict,
    },
    serverControlController,
    desktopCommandsPort: ports.desktopCommands,
  });

  const runShell = createRunShellComposition({
    presentation: {
      telegramLimit: settings.telegramLimit,
      claudeModelLabels: settings.claudeModelLabels,
      codexReasoningLabels: settings.codexReasoningLabels,
      codexModelLabel: settings.codexModelLabel,
      taskExecutionRuntimeLabel,
      formatProgressHeading,
      formatProgressHeartbeat,
      showProject: () => config.showProjectButton,
      runTaskTitle: api.runTaskTitle,
      runProject: api.runProject,
      agentPreferences: selection.agentPreferences,
      taskExecutionOwners: TASK_EXECUTION_OWNERS,
      dataDir: config.dataDir,
      appendMessageBindings,
      readMessageBindings,
      removeMessageBindings,
      approvalController: clients.approvalController,
      samePath,
      taskRuns: provider.taskRuns,
      telegram: clients.telegram,
      sendMessageTo: clients.sendMessageTo,
      deliveryOutbox: clients.deliveryOutbox,
      scheduleDeliveryOutboxFlush: clients.scheduleDeliveryOutboxFlush,
      taskRunKey,
      mediaController: clients.mediaController,
      taskViewCallbackData,
      managedRunLifecycle: provider.managedRunLifecycle,
      runJournal: infrastructure.runJournal,
      rememberLastSeenTurn: (run, turnId) => (
        api.setBoundedMapValue(provider.lastSeenTaskTurnIds, taskRunKey(run), turnId, 500)
      ),
      selectedTask: api.selectedTask,
      activeTaskTitle: selection.selectedTaskTitle,
      activeProjectName: () => api.activeProject().name,
      taskSwitchSettings: api.taskSwitchSettings,
      showLastMessageReplyMarkup,
      formatTaskSwitchMessage,
      formatTaskAlreadySelectedMessage,
      saveState: api.saveState,
      retainProgressMessageAfterEditError,
    },
    admission: {
      config,
      runtimeStateStore: infrastructure.runtimeStateStore,
      samePath,
      sendRpc: api.sendRpc,
      contextCompactions: provider.contextCompactions,
      codexUsageTracker: provider.codexUsageTracker,
      turnSpeechButtons: provider.turnSpeechButtons,
      turnTemporaryFiles: provider.turnTemporaryFiles,
      managedRunLifecycle: provider.managedRunLifecycle,
      agentProviders: provider.agentProviders,
      taskRuns: provider.taskRuns,
      scheduleObservedRun: provider.scheduleObservedRun,
      runCoordinator: desktopShell.runCoordinator,
      runConflictPolicy: desktopShell.runConflictPolicy,
      pendingInputs: provider.pendingInputs,
      queuedInputs: provider.queuedInputs,
      getSelectedTask: api.selectedTask,
      getActiveThreadTitle: selection.selectedTaskTitle,
      getChatId: () => selection.hostState.chatId,
      taskExecutionOwners: TASK_EXECUTION_OWNERS,
      deferredInputPresentation: clients.deferredInputPresentation,
      sendMessageTo: clients.sendMessageTo,
      saveState: api.saveState,
      streamHandoff: infrastructure.streamHandoff,
      stageLaunchAdmission: (run) => provider.claudeRunAdmission.stageLaunch(run),
      abortLaunchAdmission: (run, ticket) => provider.claudeRunAdmission.abortLaunch(run, ticket),
      commandTrace: infrastructure.commandTraceService,
    },
    diff: {
      capture: taskGitDiff,
      dataDir: config.dataDir,
      persist: api.persistTaskDiff,
      taskKey: taskRunKey,
      isSelected: api.isSelectedRun,
      setSelected: (value) => selection.hostState.setLatestDiff(value),
    },
    ports: {
      runAdmission: ports.runAdmission,
      telegramDelivery: ports.telegramDelivery,
      deferredInput: ports.deferredInput,
      runShell: ports.runShell,
    },
  });

  return {
    serverControlController,
    ...desktopShell,
    ...runShell,
  };
}
