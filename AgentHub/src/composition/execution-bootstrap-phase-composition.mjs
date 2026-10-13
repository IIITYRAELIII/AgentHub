import path from "node:path";

import { DurableApplicationCommandDispatcher } from "../application/durable-application-command-dispatcher.mjs";
import { findMessageBinding } from "../infrastructure/persistence/message-bindings.mjs";
import { DurableCommandReceipts } from "../infrastructure/persistence/durable-command-receipts.mjs";
import { formatRestartCompleteMessage } from "../interfaces/telegram/status.mjs";
import { telegramPrompt } from "../interfaces/telegram/telegram-message.mjs";
import { commandTaskTarget } from "../application/application-command-service.mjs";
import { catalogEntryIsSelected } from "../domain/task-catalog-identity.mjs";
import { taskRunKey } from "../domain/task-runs.mjs";
import { readCodexRolloutActivity } from "../providers/codex/codex-rollout-activity.mjs";
import { markProgressHeartbeat, PROGRESS_STALLED_AFTER_MS } from "../runtime/progress-heartbeat.mjs";
import { publicationAwareReadiness } from "../runtime/runtime-publication-completion.mjs";
import { delay } from "./runtime-timers-composition.mjs";
import { createAgentHubBootstrapComposition } from "./agent-hub-bootstrap-composition.mjs";
import { createRuntimeOrchestrationComposition } from "./runtime-orchestration-composition.mjs";
import { createTelegramRuntimeComposition } from "./telegram-runtime-composition.mjs";

export function createExecutionBootstrapPhase({
  config,
  root,
  runtimeCommandRoot,
  settings,
  selection,
  infrastructure,
  provider,
  clients,
  interaction,
  deferred,
}) {
  const api = deferred.api;
  const ports = deferred.ports;
  const runtime = createRuntimeOrchestrationComposition({
    config,
    constants: {
      selectedTaskWatchIntervalMs: 2_000,
      terminalAuditIntervalMs: 30_000,
      externalPollIntervalMs: 1_500,
      managedPollIntervalMs: 5_000,
      claudeOutputPollIntervalMs: 250,
      progressStalledAfterMs: PROGRESS_STALLED_AFTER_MS,
      agentHubRoot: root,
      instanceLockFile: settings.instanceLockFile,
      botMenu: settings.botMenu,
      globalWorkLogProjectRoots: settings.globalWorkLogProjectRoots,
      journalDatabaseFile: settings.journalDatabaseFile,
      testContourJournalDatabaseFile: settings.testContourJournalDatabaseFile,
    },
    state: {
      hostState: selection.hostState,
      selectedTask: api.selectedTask,
      selectedTaskTitle: selection.selectedTaskTitle,
      selectedProjectRoot: selection.selectedProjectRoot,
      selectedThreadId: selection.selectedThreadId,
      isCodex: selection.isCodex,
      providerTitle: selection.providerTitle,
      activeProvider: selection.selectedProvider,
      activeProjectRoot: selection.selectedProjectRoot,
      saveState: api.saveState,
    },
    runtime: {
      runtimeTimers: provider.runtimeTimers,
      taskRuns: provider.taskRuns,
      backgroundJobs: provider.backgroundJobs,
      taskProgress: interaction.taskProgress,
      managedRunLifecycle: provider.managedRunLifecycle,
      runCoordinator: interaction.runCoordinator,
      contextCompactions: provider.contextCompactions,
      streamMaintenance: provider.streamMaintenance,
      deferredInputController: interaction.deferredInputController,
      queuedInputs: provider.queuedInputs,
      scheduleQueuedInput: api.scheduleQueuedInput,
      scheduleDeliveryOutboxFlush: clients.scheduleDeliveryOutboxFlush,
      scheduleCodexTerminalAudit: api.scheduleCodexTerminalAudit,
      rateLimitTelemetry: clients.rateLimitTelemetry,
      providerLogin: clients.providerLogin,
      usageSyncAuto: provider.usageSyncAuto,
      taskSyncStore: provider.taskSyncStore,
      messagePins: provider.messagePins,
      workspaceCatalogStore: provider.workspaceCatalogStore,
      dismissedExternalTasks: provider.dismissedExternalTasks,
      lastSeenTaskTurnIds: provider.lastSeenTaskTurnIds,
      turnTemporaryFiles: provider.turnTemporaryFiles,
      claudeTaskSnapshots: provider.claudeTaskSnapshots,
      codexTaskSnapshots: provider.codexTaskSnapshots,
      managedRunHistory: provider.managedRunHistory,
      preTurnInstructions: infrastructure.preTurnInstructions,
      markProgressHeartbeat,
      approvalController: clients.approvalController,
      isSelectedRun: api.isSelectedRun,
      delay,
    },
    provider: {
      hubThreadNaming: provider.hubThreadNaming,
      agentProviders: provider.agentProviders,
      claudeEventService: provider.claudeEventService,
      codexEventService: provider.codexEventService,
      codexTerminalAudit: provider.codexTerminalAudit,
      codexTransport: clients.codexTransport,
      codexContextMaintenance: provider.codexContextMaintenance,
      discardContextCompactionRun: api.discardContextCompactionRun,
      resolveClaudeInvocation: provider.resolveClaudeInvocation,
      hubMcpServer: infrastructure.hubMcpServer,
      hubMcpService: infrastructure.hubMcpService,
      readCodexTaskSnapshot: api.readCodexTaskSnapshot,
      readCodexThread: api.readCodexThread,
      readCodexRolloutActivity,
      knownCodexRolloutPath: provider.knownCodexRolloutPath,
      startCodexAppServer: api.startCodexAppServer,
      initializeCodex: api.initializeCodex,
      stopCodexAppServerTree: api.stopCodexAppServerTree,
      importCodexDesktopAttachments: clients.importCodexDesktopAttachments,
    },
    tasks: {
      runTaskTitle: api.runTaskTitle,
      findProject: api.findProject,
      invalidateTaskCatalog: api.invalidateTaskCatalog,
      syncTaskRun: api.syncTaskRun,
      codexModelLabel: settings.codexModelLabel,
      reasoningLabels: settings.codexReasoningLabels,
      savedLastTaskMessage: api.savedLastTaskMessage,
      savedLastTaskMessageRecord: api.savedLastTaskMessageRecord,
      rememberLastTaskMessage: api.rememberLastTaskMessage,
      setBoundedMapValue: api.setBoundedMapValue,
      taskRunKey,
      taskCatalogEntries: () => provider.taskCatalog,
      catalogEntryIsSelected,
      refreshTaskCatalog: api.refreshTaskCatalog,
    },
    clients: {
      startTyping: clients.startTyping,
      stopTyping: clients.stopTyping,
      safelyDeliverRunMessage: api.safelyDeliverRunMessage,
      sendRunMessage: api.sendRunMessage,
      sendRunMessageText: api.sendRunMessage,
      deleteTaskMessages: api.deleteTaskMessages,
      sendTaskViewText: api.sendTaskViewText,
      findMessageBinding: (targetChatId, messageId) => (
        findMessageBinding(config.dataDir, targetChatId, messageId)
      ),
      sendMessageTo: clients.sendMessageTo,
      telegram: clients.telegram,
      formatRestartCompleteMessage,
      scheduleBugReportScan: clients.scheduleBugReportScan,
      uiCallback: api.uiCallback,
    },
    persistence: {
      runtimeStateCoordinator: clients.runtimeStateCoordinator,
      telegramDeliveryService: interaction.telegramDeliveryService,
      mediaController: clients.mediaController,
      deliveryOutbox: clients.deliveryOutbox,
      backgroundJobStore: provider.backgroundJobStore,
      failedUpdateStore: provider.failedUpdateStore,
      instanceGuard: infrastructure.instanceGuard,
      workLogUsageStore: infrastructure.workLogUsageStore,
      rateLimitHistoryStore: infrastructure.rateLimitHistoryStore,
      providerTurnTelemetryStore: infrastructure.providerTurnTelemetryStore,
      taskReadStateStore: infrastructure.taskReadStateStore,
      runtimeStateStore: infrastructure.runtimeStateStore,
      commandTrace: infrastructure.commandTrace,
    },
    lifecycle: {
      restartRequestService: interaction.restartRequestService,
      miniAppLifecycle: clients.miniAppLifecycle,
      desktopAttachments: clients.desktopAttachments,
      desktopControlServer: api.desktopControlServer,
      runtimeCommandServer: infrastructure.runtimeCommandServer,
      hubMcpServer: infrastructure.hubMcpServer,
      journalStartupReady: clients.journalStartupReady,
      announceDesktopRestart: api.announceDesktopRestart,
      taskObserverLogger: console,
    },
    ports: {
      providerRuntime: ports.providerRuntime,
      taskInteraction: ports.taskInteraction,
      runtimeRestart: ports.runtimeRestart,
    },
  });

  const dismissCallbackMenu = (...args) => interaction.telegramTaskActions.dismissMenu(...args);
  const telegramTasks = interaction.telegramTaskActions;
  const telegramActiveProject = () => (
    api.findProject(telegramTasks.activeProjectRoot()) ?? api.activeProject()
  );
  const telegramProviderTitle = () => (telegramTasks.isCodex() ? "Codex" : "Claude Code");
  const telegramApplicationCommands = new DurableApplicationCommandDispatcher({
    receipts: new DurableCommandReceipts({
      file: path.join(config.dataDir, "telegram-application-command-receipts.json"),
    }),
    dispatch: interaction.dispatchApplicationCommand,
  });
  const telegramSelectionNotification = (alreadySelected, options = {}) => api.sendTaskSelectionNotification({
    ...options,
    alreadySelected,
    selectedTask: telegramTasks.selectedTask(),
    taskTitle: telegramTasks.activeTaskTitle(),
    projectName: telegramActiveProject().name,
  });
  const telegramRuntime = createTelegramRuntimeComposition({
    shell: {
      taskPicker: {
        refreshCatalog: api.refreshTaskCatalog,
        selectedTask: telegramTasks.selectedTask,
        pageSize: settings.taskPickerPageSize,
        showProject: () => config.showProjectButton && config.showTaskProject,
        providerTitle: telegramProviderTitle,
        projectName: () => telegramActiveProject().name,
        newTaskCallback: () => telegramTasks.uiCallback("thread:new"),
        archiveCallback: () => (
          telegramTasks.isCodex() && telegramTasks.currentThreadId()
            ? telegramTasks.uiCallback("thread:archive")
            : null
        ),
        editMessage: (message, view) => clients.telegram("editMessageText", {
          chat_id: message.chat.id,
          message_id: message.message_id,
          text: view.text,
          reply_markup: view.replyMarkup,
        }),
        sendMessage: (view) => clients.sendMessage(view.text, { reply_markup: view.replyMarkup }),
      },
      settingsMenu: clients.telegramSettingsMenu,
      taskActions: interaction.telegramTaskActions,
      statusController: clients.telegramStatusController,
      activeProjectRoot: telegramTasks.activeProjectRoot,
      activeProvider: telegramTasks.activeProvider,
      agentPreferences: selection.agentPreferences,
      codexModelLabel: settings.codexModelLabel,
      currentChatId: () => selection.hostState.chatId,
    },
    controller: {
      telegram: clients.telegram,
      config,
      menuCommands: settings.menuCommands,
      botMenu: settings.botMenu,
      projects: settings.projects,
      codexModels: settings.codexModels,
      claudeModels: settings.claudeModels,
      reasoningLabels: settings.codexReasoningLabels,
      collaborationModeLabels: settings.codexCollaborationModeLabels,
      claudeModelLabels: settings.claudeModelLabels,
      parseApprovalCallback: settings.parseApprovalCallback,
      dispatchTelegramSetting: interaction.dispatchTelegramSetting,
      dispatchApplicationCommand: (...args) => telegramApplicationCommands.dispatch(...args),
      acknowledgeApplicationCommands: (update) => telegramApplicationCommands.acknowledgeUpdate(update),
      telegramCallbackCommandContext: interaction.telegramCallbackCommandContext,
      telegramMessageCommandContext: interaction.telegramMessageCommandContext,
      commandTaskTarget,
      activeProject: telegramActiveProject,
      activeProvider: telegramTasks.activeProvider,
      autoApprove: () => selection.hostState.autoApprove,
      agentPreferences: selection.agentPreferences,
      codexModelLabel: settings.codexModelLabel,
      providerTitle: telegramProviderTitle,
      resolveTaskViewBinding: api.resolveTaskViewBinding,
      taskRuns: provider.taskRuns,
      refreshTaskDiff: api.refreshTaskDiff,
      taskDiffs: provider.taskDiffs,
      taskRunKey,
      selectTaskFromBinding: telegramTasks.selectTaskFromBinding,
      showLastTaskMessage: api.showLastTaskMessage,
      showTaskMessage: api.showTaskMessage,
      sendMessage: clients.sendMessage,
      sendMessageTo: clients.sendMessageTo,
      sendLongMessage: clients.sendLongMessage,
      sendTaskSwitchNotification: (options) => telegramSelectionNotification(false, options),
      sendTaskAlreadySelectedNotification: (options) => telegramSelectionNotification(true, options),
      sendThreadPicker: api.sendThreadPicker,
      refreshTaskCatalog: api.refreshTaskCatalog,
      taskCatalog: () => provider.taskCatalog,
      archiveBlockedReason: () => telegramTasks.archiveBlockedReason(),
      archiveCurrentThread: (context) => telegramTasks.archive(context),
      createCurrentTask: (context) => telegramTasks.create(context),
      sendArchiveMessage: (...args) => telegramTasks.sendArchive(...args),
      dismissCallbackMenu,
      updateDeferredDesktopReceipt: api.updateDeferredDesktopReceipt,
      cleanupDeferredFiles: api.cleanupDeferredFiles,
      saveState: api.saveState,
      updateDeferredMessage: api.updateDeferredMessage,
      deferredInputController: interaction.deferredInputController,
      scheduleQueuedInput: api.scheduleQueuedInput,
      startTurn: api.startTurn,
      startDeferred: (item) => interaction.runCoordinator.startDeferred(item),
      desktopAttachmentDescriptors: clients.desktopAttachmentDescriptors,
      activeThreadTitle: telegramTasks.activeTaskTitle,
      selectedTask: telegramTasks.selectedTask,
      mediaController: clients.mediaController,
      pendingInputs: provider.pendingInputs,
      queuedInputs: provider.queuedInputs,
      backgroundJobs: provider.backgroundJobs,
      maxSpeechJobs: settings.maxBackgroundSpeechJobs,
      currentUiContextToken: (callbackData = "") => (
        /^(?:approval-mode:|p:\d+|engine:|codex-model:|codex-reasoning:|codex-mode:|claude-reasoning:|claude-mode:|model:)/
          .test(String(callbackData))
          ? api.currentUiContextToken()
          : telegramTasks.currentUiContextToken()
      ),
      interactiveJobs: provider.interactiveJobs,
      isStopping: () => selection.hostState.stopping,
      sendAgentPicker: api.sendAgentPicker,
      sendModelPicker: api.sendModelPicker,
      sendReasoningPicker: api.sendReasoningPicker,
      sendCollaborationModePicker: api.sendCollaborationModePicker,
      sendProjectPicker: api.sendProjectPicker,
      currentStatusSnapshot: (targetChatId) => telegramTasks.statusSnapshot(
        targetChatId ?? selection.hostState.chatId,
      ),
      formatApprovalMode: api.formatApprovalMode,
      approvalModeKeyboard: api.approvalModeKeyboard,
      restartBot: api.restartBot,
      resumeThread: (...args) => telegramTasks.resume(...args),
      renameCurrentTask: (...args) => telegramTasks.rename(...args),
      sendRunMessage: api.sendRunMessage,
      bindIncomingTaskMessage: api.bindIncomingTaskMessage,
      telegramPrompt,
      forwardBundles: provider.forwardBundles,
      selectedTurnTarget: telegramTasks.selectedTurnTarget,
      setChatId: (value) => selection.hostState.setChatId(value),
      findReplyBinding: (targetChatId, messageId) => (
        findMessageBinding(config.dataDir, targetChatId, messageId)
      ),
      activateMessageBinding: (binding) => telegramTasks.selectTaskFromBinding(binding, {
        source: "telegram",
        clientId: `telegram:${binding?.chatId ?? selection.hostState.chatId ?? "unknown"}`,
      }),
      setUpdateOffset: (value) => selection.hostState.setUpdateOffset(value),
      updateOffset: () => selection.hostState.updateOffset,
      setProcessingUpdateId: (value) => selection.hostState.setProcessingUpdateId(value),
      failedUpdateStore: provider.failedUpdateStore,
      restartReady: () => Boolean(
        selection.hostState.restartRequest
        && !selection.hostState.restartRequest.waitingForRuns
        && !selection.hostState.stopping
      ),
      performRestart: api.performRestart,
      taskBoard: infrastructure.taskBoard,
    },
    ports: { telegramShell: ports.telegramShell },
  });

  const bootstrap = createAgentHubBootstrapComposition({
    config,
    runtimeCommandRoot,
    handleDesktopControl: api.handleDesktopControl,
    forgetDesktopControl: api.forgetDesktopControl,
    runtimeCommandServer: infrastructure.runtimeCommandServer,
    hubMcpServer: infrastructure.hubMcpServer,
    stopRuntimeTimers: runtime.stopRuntimeTimers,
    taskRuns: provider.taskRuns,
    agentProviders: provider.agentProviders,
    mediaController: clients.mediaController,
    runtimeResources: runtime.runtimeResources,
    miniAppLifecycle: clients.miniAppLifecycle,
    sanitizeRollouts: () => provider.codexContextMaintenance.runPeriodic({ reschedule: false }),
    initializeProvider: api.initializeProvider,
    providerIsRunning: () => clients.codexTransport.running,
    backfillProviderMetadata: async ({ signal } = {}) => {
      signal?.throwIfAborted();
      const trace = infrastructure.commandTraceService;
      const measure = (stage, operation) => trace?.measureBestEffort ? trace.measureBestEffort({
        commandId: "startup-provider-metadata", stage, transport: "server-runtime",
      }, operation) : operation();
      const threads = await measure("startup-codex-catalog", () => provider.codexProviderTasks.discoverTasks());
      signal?.throwIfAborted();
      return measure("startup-pricing-backfill", () => api.backfillWorkLogPricingMetadata(threads, { signal, propagateErrors: true }));
    },
    recoverRuns: (...args) => runtime.runRecovery.recoverAll(...args),
    retryTerminalProjections: () => api.retryPendingTurnEndProjections({ recoverProjecting: true }),
    retryNotifications: api.retryPendingTurnEndNotifications,
    restoreBackgroundJobs: () => provider.backgroundJobs.restore(),
    startRuntimeTimers: runtime.startRuntimeTimers,
    registerTelegramCommands: () => clients.telegram("setMyCommands", {
      commands: settings.botCommands,
    }),
    hasPendingRestart: () => Boolean(selection.hostState.restartRequest),
    finalizeRestart: api.finalizeRestartMessage,
    markReady: publicationAwareReadiness({
      markReady: () => infrastructure.instanceGuard.markReady(),
      runtimeRoot: runtimeCommandRoot,
    }),
    readyMessage: () => (
      `Agent Hub ready; components: ${Object.entries(config.components).filter(([, enabled]) => enabled).map(([name]) => name).join(", ") || "core"}; provider: ${selection.providerTitle()}; project: ${selection.selectedProjectRoot()}`
    ),
    pollTelegram: telegramRuntime.pollTelegram,
    warnUser: (message) => clients.sendMessage(message).catch(() => {}),
    beginStopping: () => selection.hostState.beginStopping(),
    sqliteRecovery: infrastructure.sqliteRecovery,
    acknowledgeSqliteRecovery: infrastructure.acknowledgeSqliteRecovery,
    commandTrace: infrastructure.commandTraceService,
  });
  ports.bootstrap.bind(bootstrap);

  return {
    ...runtime,
    ...telegramRuntime,
    ...bootstrap,
  };
}
