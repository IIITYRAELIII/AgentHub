import { taskRunIsActive } from "../domain/task-runs.mjs";
import { retargetTelegramClientSelections } from "../application/client-task-selection-service.mjs";
import { StreamContextMaintenanceService } from "../application/stream-context-maintenance-service.mjs";
import { UsageSyncAutoService } from "../application/usage-sync-auto-service.mjs";
import { UsageSyncRemoteClient } from "../infrastructure/http/usage-sync-remote-client.mjs";
import { applyWorkLogAccountBackfill } from "../infrastructure/persistence/work-log-account-backfill.mjs";
import { MaintenanceOperationStore } from "../infrastructure/persistence/maintenance-operation-store.mjs";
import { readClaudeAccount } from "../providers/claude/claude-account.mjs";
import { ClaudeContextMaintenanceService } from "../providers/claude/claude-context-maintenance-service.mjs";
import { processIsAlive } from "../providers/claude/claude-run-io.mjs";
import { readClaudeSessionSnapshot } from "../providers/claude/claude-session-reader.mjs";
import { readCodexTurnUsage } from "../providers/codex/codex-turn-usage.mjs";
import {
  codexObservedRuntimeActive,
  resolveCodexObservedExecutionOwner,
  resolveCodexTaskActivity,
} from "../providers/codex/codex-runtime-owner.mjs";
import { readCodexThreadTitleHistories } from "../../send-message.mjs";
import { createBackgroundWorkComposition } from "./background-work-composition.mjs";
import { createClaudeTranscriptAuditComposition } from "./claude-transcript-audit-composition.mjs";
import { createCodexContextMaintenanceComposition } from "./codex-context-maintenance-composition.mjs";
import { createCodexObservabilityComposition } from "./codex-observability-composition.mjs";
import { createJournalBackfillComposition } from "./journal-backfill-composition.mjs";
import { createProviderCatalogComposition } from "./provider-catalog-composition.mjs";
import { createProviderOperationComposition } from "./provider-operation-composition.mjs";
import { createProviderProcessComposition } from "./provider-process-composition.mjs";
import { createProviderSnapshotComposition } from "./provider-snapshot-composition.mjs";
import { createProviderStartupComposition } from "./provider-startup-composition.mjs";
import { createRunAccountingComposition } from "./run-accounting-composition.mjs";
import { createRunCompletionComposition } from "./run-completion-composition.mjs";
import { createRuntimeDataComposition } from "./runtime-data-composition.mjs";
import { RuntimeTimerCoordinator } from "../runtime/runtime-timer-coordinator.mjs";
import { createTaskCatalogFinalizationComposition } from "./task-catalog-finalization-composition.mjs";
import { delay } from "./runtime-timers-composition.mjs";

export async function createProviderApplicationComposition({
  config,
  constants,
  state,
  infrastructure,
  taskServices,
  api,
  late,
  ports,
}) {
  const {
    projects,
    taskDiffsFile,
    taskSyncFile,
    backgroundJobsDirectory,
    failedUpdatesDirectory,
    maximumMediaJobs,
    maximumSpeechJobs,
    maximumInteractiveJobs,
    taskCatalogCacheMs,
    taskTitleReconcileIntervalMs,
    threadListLimit,
    claudeModelLabels,
    normalizeCodexModel,
    codexReasoningLabels,
    globalWorkLogProjectRoots,
    journalDatabaseFile,
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
    runJournal,
    turnEndNotifications,
    workLogUsageStore,
    workLogUsageIdentityStore,
    suggestUsageSyncDeviceLabel,
    workLogUsageRemoteConfigStore,
    workspaceCatalogStore,
    preTurnInstructions,
    hubMcpService,
    codexRolloutContextSanitizer,
    providerTurnTelemetryStore,
    runtimeStateStore,
    commandTraceService,
  } = infrastructure;
  const {
    findProject,
    canonicalizeProjectRoots,
    runTaskTitle,
    isSelectedRun,
    persistTaskDiff,
    syncTaskRun,
    invalidateTaskCatalog,
    selectedTask,
    pinnedTaskTitle,
    pendingTaskTitle,
  } = taskServices;
  const runtimeTimers = new RuntimeTimerCoordinator();
  const usageSyncAuto = new UsageSyncAutoService({
    timers: runtimeTimers,
    remoteConfigStore: workLogUsageRemoteConfigStore,
    identityStore: workLogUsageIdentityStore,
    workLogUsageStore,
    clientFactory: (options) => new UsageSyncRemoteClient(options),
    projectRoot: config.projectRoot,
    projectionProjectRoots: globalWorkLogProjectRoots,
    suggestedDeviceLabel: suggestUsageSyncDeviceLabel,
    accountBackfill: async () => {
      const claudeAccount = await readClaudeAccount();
      return applyWorkLogAccountBackfill({
        databaseFile: journalDatabaseFile,
        providerAccounts: claudeAccount ? [{ provider: "claude", ...claudeAccount }] : [],
      });
    },
    isStopping: () => hostState.stopping,
  });

  function defaultNotificationChatId() {
    return config.telegramEnabled ? late.resolveNotificationChatId(config, null) : null;
  }

  const providerProcess = createProviderProcessComposition({
    config,
    getProjectRoot: selectedProjectRoot,
    stopProcessTree: late.stopProcessTree,
  });
  const accounting = createRunAccountingComposition({
    runJournal,
    refreshTaskDiff: api.refreshTaskDiff,
    runTaskTitle,
  });
  const runtimeData = await createRuntimeDataComposition({
    config,
    projects,
    taskDiffsFile,
    taskSyncFile,
    findProject,
    canonicalizeProjectRoots,
  });
  const maintenanceOperations = new MaintenanceOperationStore({ dataDir: config.dataDir });
  hubMcpService.setActiveRuns(() => runtimeData.taskRuns.values());

  const codexObservability = createCodexObservabilityComposition({
    config,
    sendRpc: api.sendRpc,
    scheduleDeferredRestartIfReady: api.scheduleDeferredRestartIfReady,
    taskRuns: runtimeData.taskRuns,
    turnEndNotifications,
    workLogUsageStore,
    changedFilesForRun: accounting.changedFilesForRun,
    projectTurnUsageToWorkLog: accounting.projectTurnUsageToWorkLog,
    runtimeCommandTaskTitle: api.runtimeCommandTaskTitle,
    rememberLastTaskMessage: api.rememberLastTaskMessage,
    lastSeenTaskTurnIds: runtimeData.lastSeenTaskTurnIds,
    saveState: api.saveState,
    deliverTurnEndNotification: api.deliverTurnEndNotification,
    defaultNotificationChatId,
    findProject,
    resolveTaskByProviderRef: ({ provider, providerTaskId }) => providerCatalog.taskCatalog.find((entry) => (
      entry.provider === provider && String(entry.threadId) === String(providerTaskId)
    )),
    globalWorkLogProjectRoots,
    isHistoricalBackfillIdle: () => false,
    operationStore: maintenanceOperations,
    streamIdForThread: (threadId) => workspaceCatalogStore.thread({
      provider: "codex",
      threadId,
    })?.streamId ?? null,
  });

  const completion = createRunCompletionComposition({
    config,
    taskRuns: runtimeData.taskRuns,
    currentTarget: () => ({
      provider: selectedProvider(),
      projectRoot: selectedProjectRoot(),
      threadId: selectedThreadId(),
      taskTitle: selectedTaskTitle(),
      chatId: hostState.chatId,
    }),
    findProject,
    taskMetadata,
    agentPreferences,
    normalizeCodexModel,
    codexModelLabel: late.codexModelLabel,
    claudeModelLabels,
    reasoningLabels: codexReasoningLabels,
    cancelledManagedClaudeTasks: runtimeData.cancelledManagedClaudeTasks,
    persistTaskDiff,
    syncTaskRun,
    invalidateTaskCatalog,
    saveState: api.saveState,
    scheduleProgressStart: (run) => late.taskProgress().scheduleStart(run, config.progressStartDelayMs),
    clearSelectedDiff: (run) => { if (isSelectedRun(run)) hostState.setLatestDiff(""); },
    clearApprovals: (run) => {
      for (const [key, approval] of late.approvalController().pending) {
        if (approval.runId === run.id) late.approvalController().pending.delete(key);
      }
    },
    pauseObservation: (run) => late.taskObserver().pause(run),
    pauseClaude: (run) => late.claudeRunController().pause(run),
    stopTyping: () => late.stopTyping(),
    beforeCompletion: async (run) => {
      streamContextMaintenance.reserveAfterTurn(run);
    },
    afterCompletion: async (run) => {
      const maintenance = streamContextMaintenance.maintainAfterTurn(run);
      if (hostState.restartRequest && !hostState.stopping) {
        void maintenance.finally(() => api.scheduleDeferredRestartIfReady());
      }
    },
    turnEndNotifications,
    runJournal,
    lastSeenTaskTurnIds: runtimeData.lastSeenTaskTurnIds,
    codexTurnStarts: codexObservability.turnStarts,
    discardContextCompactionRun: api.discardContextCompactionRun,
    finalizeRunDelivery: api.finalizeRunDelivery,
    refreshTaskDiff: api.refreshTaskDiff,
    runTaskTitle,
    currentChatId: () => hostState.chatId,
    defaultNotificationChatId,
    changedFilesForRun: accounting.changedFilesForRun,
    persistManagedRunHistory: api.persistManagedRunHistory,
    runtimeStateStore,
    commandTrace: commandTraceService,
  });

  const codexContextMaintenance = createCodexContextMaintenanceComposition({
    config,
    runtimeTimers,
    contextCompactions: codexObservability.compactions,
    sanitizer: codexRolloutContextSanitizer,
    isStopping: () => hostState.stopping,
    transportRunning: () => late.codexTransport().running,
    activeRuns: () => runtimeData.taskRuns.values(),
    runIsActive: taskRunIsActive,
    refreshTaskCatalog: api.refreshTaskCatalog,
    knownRolloutPath: codexObservability.knownRolloutPath,
    readThread: api.readCodexThread,
    rememberRolloutPath: codexObservability.rememberRolloutPath,
    stopTransport: api.stopCodexAppServerTree,
    startTransport: api.startCodexAppServer,
    initializeTransport: api.initializeCodex,
    providerIsSelected: isCodex,
    setTransportRestarting: (value) => late.codexRuntime().setRestarting(value),
    invalidateTaskCatalog,
    restartTransportAfterCrash: api.restartCodexAfterCrash,
    runForTask: (target) => runtimeData.taskRuns.forTask(target),
    sendRpc: api.sendRpc,
  });
  const claudeContextMaintenance = new ClaudeContextMaintenanceService({
    compactions: codexObservability.compactions,
    beginRun: (input, target) => completion.managedRunLifecycle.begin(input, target),
    launchTurn: (run, input, temporaryFiles) => api.launchTurn(run, input, temporaryFiles),
    activeRun: (target) => {
      const run = runtimeData.taskRuns.forTask(target);
      return taskRunIsActive(run) ? run : null;
    },
    completeRun: (run) => completion.managedRunLifecycle.complete(run),
    saveState: api.saveState,
  });
  const streamContextMaintenance = new StreamContextMaintenanceService({
    registry: runtimeData.streamMaintenance,
    provider: codexContextMaintenance,
    providers: { claude: claudeContextMaintenance },
    latestContextUsage: (threadId, provider = "codex") => {
      const usage = codexObservability.usageTracker.latestExactContext(threadId);
      if (!usage) return null;
      const usageProvider = String(usage.provider ?? "codex").trim().toLowerCase();
      return usageProvider === String(provider ?? "codex").trim().toLowerCase() ? usage : null;
    },
    waitForContextUpdate: (threadId, options) => (
      codexObservability.usageTracker.waitForContextUpdate(threadId, options)
    ),
    waitForTurnCompletion: (turnId, options) => (
      codexObservability.usageTracker.waitForTurnCompletion(turnId, options)
    ),
    workspaceCatalog: workspaceCatalogStore,
    selectionStore,
    deferredInputs: runtimeData.deferredInputs,
    invalidateCatalog: invalidateTaskCatalog,
    retargetClientSelections: (binding) => retargetTelegramClientSelections(hostState, binding),
    saveState: api.saveState,
    scheduleDeferred: (item, delayMs) => late.runCoordinator().scheduleDeferred(item, delayMs),
    autoCompactEnabled: () => config.contextAutomation.autoCompactAfterTurn,
    autoCompactThreshold: () => config.contextAutomation.autoCompactThresholdPercent,
    autoRotateEnabled: () => config.contextAutomation.autoRotateAfterCompaction,
    autoRotateThreshold: () => config.contextAutomation.autoRotateThresholdPercent,
  });

  const backgroundWork = await createBackgroundWorkComposition({
    backgroundDirectory: backgroundJobsDirectory,
    failedUpdatesDirectory,
    maxMediaJobs: maximumMediaJobs,
    maxSpeechJobs: maximumSpeechJobs,
    maxInteractiveJobs: maximumInteractiveJobs,
    isStopping: () => hostState.stopping,
    onIdle: api.scheduleDeferredRestartIfReady,
    sendMessage: (...args) => late.sendMessageTo(...args),
    media: {
      captureImage: (...args) => late.mediaController().captureImage(...args),
      analyzeImage: (...args) => late.mediaController().analyzeImage(...args),
      transcribeVoice: (...args) => late.mediaController().transcribeVoice(...args),
      processSpeechRequest: (...args) => late.mediaController().processSpeechRequest(...args),
    },
    forwardBundles: {
      imageDescriptor: (...args) => late.forwardBundleController().imageDescriptor(...args),
      completeImage: (...args) => late.forwardBundleController().completeImage(...args),
      failImage: (...args) => late.forwardBundleController().failImage(...args),
      pendingImageJobs: () => late.forwardBundleController().pendingImageJobs(),
    },
  });
  const journalBackfill = createJournalBackfillComposition({
    projects,
    workLogUsageStore,
    projectionProjectRoots: globalWorkLogProjectRoots,
  });
  const claudeTranscriptAudit = createClaudeTranscriptAuditComposition({
    projectRoot: config.projectRoot,
    projectionProjectRoots: globalWorkLogProjectRoots,
    findProject,
    workLogUsageStore,
  });
  const taskCatalogFinalization = createTaskCatalogFinalizationComposition({
    projects,
    titleReconcileIntervalMs: taskTitleReconcileIntervalMs,
    journalDatabaseFile,
    projectionProjectRoots: globalWorkLogProjectRoots,
    workLogUsageStore,
    taskRuns: runtimeData.taskRuns,
    savedLastTaskMessageRecord: api.savedLastTaskMessageRecord,
    deferredTaskMessageAtMs: api.deferredTaskMessageAtMs,
    selectedTask,
    getActiveThreadTitle: selectedTaskTitle,
    selectionStore,
    taskSyncStore: runtimeData.taskSyncStore,
    saveState: api.saveState,
  });
  const providerSnapshots = createProviderSnapshotComposition({
    readClaudeSessionSnapshot,
    findProject,
    saveState: api.saveState,
    cancelledManagedClaudeTasks: runtimeData.cancelledManagedClaudeTasks,
    isSelectedRun,
    taskRuns: runtimeData.taskRuns,
    hostState,
    selectionStore,
    workspaceCatalogStore,
    runTaskTitle,
    bindRunMessage: api.bindRunMessage,
    taskProgress: late.taskProgress,
    knownCodexRolloutPath: codexObservability.knownRolloutPath,
    capturedCodexExecutionOwner: codexObservability.capturedExecutionOwner,
    readCodexThread: api.readCodexThread,
    codexTransportPid: () => late.codexTransport().pid,
    codexModelLabel: late.codexModelLabel,
    reasoningLabels: codexReasoningLabels,
    trackClaudeContextUsage: (run, usage) => codexObservability.usageTracker.rememberContext({
      provider: "claude",
      threadId: run.threadId,
      turnId: run.turnId,
      tokenUsage: {
        modelContextWindow: usage.modelContextWindow,
        last: { totalTokens: usage.usedTokens },
      },
    }),
    observeClaudeCompaction: (run, event) => claudeContextMaintenance.observe(run, event),
    invalidateTaskCatalog,
    delay,
  });
  const providerOperations = createProviderOperationComposition({
    claudeContextMaintenance,
    taskRuns: runtimeData.taskRuns,
    selectionStore,
    workspaceCatalogStore,
    preTurnInstructions,
    hubMcpService,
    saveState: api.saveState,
    taskProgress: late.taskProgress,
    taskObserver: late.taskObserver,
    managedRunLifecycle: completion.managedRunLifecycle,
    runRecovery: late.runRecovery,
    runCoordinator: late.runCoordinator,
    turnTemporaryFiles: runtimeData.turnTemporaryFiles,
    commandTrace: commandTraceService,
    turnSpeechButtons: runtimeData.turnSpeechButtons,
    turnTokenUsage: codexObservability.turnTokenUsage,
    cancelledManagedClaudeTasks: runtimeData.cancelledManagedClaudeTasks,
    taskDiffs: runtimeData.taskDiffs,
    isSelectedRun,
    codexTransportRunning: () => late.codexTransport().running,
    startCodexTransport: api.startCodexAppServer,
    initializeCodex: api.initializeCodex,
    sendRpc: api.sendRpc,
    activeProjectRoot: selectedProjectRoot,
    codexSandboxMode: () => config.codexSandboxMode,
    codexModel: () => agentPreferences.codexModel,
    invalidateTaskCatalog,
    restoreCodexTaskSettings: api.restoreCodexTaskSettings,
    updateActiveCodexThreadSettings: api.updateActiveCodexThreadSettings,
    clearLatestDiff: () => hostState.setLatestDiff(""),
    consumeTurnTokenTracker: api.consumeTurnTokenTracker,
    waitForTurnEndCompletion: api.waitForTurnEndCompletion,
    rememberCodexSeenTurn: codexObservability.rememberSeenTurn,
    rememberLastTaskMessage: api.rememberLastTaskMessage,
    readCodexThread: api.readCodexThread,
    readCodexTurnUsage,
    applyCodexRolloutContext: accounting.applyCodexRolloutContext,
    finalizeCodexRunDelivery: api.finalizeCodexRunDelivery,
    completedCodexAnswer: api.completedCodexAnswer,
    persistClaudeRunHistory: api.persistClaudeRunHistory,
    projectClaudeRunToWorkLog: accounting.projectClaudeRunToWorkLog,
    finalizeRunDelivery: api.finalizeRunDelivery,
    attachClaudeRunAfterRestart: api.attachClaudeRunAfterRestart,
    readCodexTaskSnapshot: api.readCodexTaskSnapshot,
    isCodex,
    autoApprove: () => hostState.autoApprove,
    restartRequested: () => Boolean(hostState.restartRequest),
    launchTurn: api.launchTurn,
    startTyping: () => late.startTyping(),
    telegram: (...args) => late.telegram(...args),
    codexContextMaintenance,
    streamContextMaintenance,
    contextCompactions: codexObservability.compactions,
    resolvedExplicitSkillNames: api.resolvedExplicitSkillNames,
    taskExternalActivity: api.taskExternalActivity,
    stopClaudeRunProcess: api.stopClaudeRunProcess,
    processIsAlive,
    invalidateCodexThreadRead: api.invalidateCodexThreadRead,
    applyCodexThreadSettings: api.applyCodexThreadSettings,
    trackTurnTokenUsage: api.trackTurnTokenUsage,
    latestContextUsage: (threadId) => codexObservability.usageTracker.latestExactContext(threadId),
    completeContextTurn: (turnId, status) => (
      codexObservability.usageTracker.markTurnCompleted(turnId, status)
    ),
    setLatestDiff: (value) => hostState.setLatestDiff(value),
    requestApproval: api.requestApproval,
    formatCommandApproval: api.formatCommandApproval,
    formatFileApproval: api.formatFileApproval,
    formatPermissionsApproval: late.formatPermissionsApproval,
    requestMcpElicitation: api.requestMcpElicitation,
    requestUserInput: api.requestUserInput,
    discardContextCompactionRun: api.discardContextCompactionRun,
  });
  const providerCatalog = createProviderCatalogComposition({
    taskSyncStore: runtimeData.taskSyncStore,
    workspaceCatalogStore,
    taskRuns: runtimeData.taskRuns,
    taskCatalogCacheMs,
    runProject: taskServices.runProject,
    finalizeTaskCatalog: api.finalizeTaskCatalog,
    findProject,
    saveState: api.saveState,
    ...providerOperations,
    readCodexTaskSnapshot: api.readCodexTaskSnapshot,
    readCodexThread: api.readCodexThread,
    applyCodexObservedSnapshot: api.applyCodexObservedSnapshot,
    applyCodexActiveSnapshot: api.applyCodexActiveSnapshot,
    startClaudeTurn: api.startClaudeTurn,
    steerClaudeTurn: api.steerClaudeTurn,
    claudeTaskSnapshots: providerSnapshots.claudeTaskSnapshots,
    backfillWorkLogPricingMetadata: api.backfillWorkLogPricingMetadata,
    readCodexThreadTitleHistories,
    rememberCodexRolloutPath: codexObservability.rememberRolloutPath,
    capturedCodexExecutionOwner: codexObservability.capturedExecutionOwner,
    codexObservedRuntimeActive,
    codexTransportPid: () => late.codexTransport().pid,
    resolveCodexObservedExecutionOwner,
    codexModelLabel: late.codexModelLabel,
    codexThreadResponseTitle: api.codexThreadResponseTitle,
    pendingTaskTitle,
    clearExpectedTitle: (key) => taskMetadata.clearExpectedTitle(key),
    pinnedTaskTitle,
    reconcilePinnedTitle: (provider, providerTaskId, title) => (
      taskMetadata.reconcilePinnedTitle({ provider, threadId: providerTaskId }, title)
    ),
    savePinnedTaskTitles: api.savePinnedTaskTitles,
    sendRpc: api.sendRpc,
    auditClaudeTranscriptSnapshots: api.auditClaudeTranscriptSnapshots,
    knownCodexRolloutPath: codexObservability.knownRolloutPath,
    codexTransportRunning: () => late.codexTransport().running,
    ensureCodex: async () => {
      await api.startCodexAppServer();
      await api.initializeCodex({ attachSelectedThread: false });
    },
    resolveCodexTaskActivity,
    providerTurnTelemetryStore,
    terminalCommits: completion.terminalCommits,
    commandTrace: commandTraceService,
  });
  const providerStartup = ports.providerStartup.bind(createProviderStartupComposition({
    config,
    threadListLimit,
    selectionStore,
    taskRuns: runtimeData.taskRuns,
    agentProviders: providerCatalog.agentProviders,
    codexProviderTasks: providerOperations.codexProviderTasks,
    getProvider: selectedProvider,
    getProjectRoot: selectedProjectRoot,
    getThreadId: selectedThreadId,
    isCodex,
    startCodex: api.startCodexAppServer,
    initializeCodex: api.initializeCodex,
    sendRpc: api.sendRpc,
    resolveResumedCodexThreadTitle: api.resolveResumedCodexThreadTitle,
    applyCodexThreadSettings: api.applyCodexThreadSettings,
    saveState: api.saveState,
  }));

  return {
    runtimeTimers,
    commandTraceService,
    usageSyncAuto,
    defaultNotificationChatId,
    ...providerProcess,
    ...accounting,
    ...runtimeData,
    workspaceCatalogStore,
    codexObservability,
    codexUsageTracker: codexObservability.usageTracker,
    turnTokenUsage: codexObservability.turnTokenUsage,
    contextCompactions: codexObservability.compactions,
    maintenanceOperations,
    codexTurnStarts: codexObservability.turnStarts,
    codexHookReceipts: codexObservability.hookReceipts,
    replaceCodexHookReceipts: codexObservability.replaceHookReceipts,
    capturedCodexExecutionOwner: codexObservability.capturedExecutionOwner,
    knownCodexRolloutPath: codexObservability.knownRolloutPath,
    rememberCodexRolloutPath: codexObservability.rememberRolloutPath,
    codexTerminalAudit: codexObservability.terminalAudit,
    ...completion,
    codexContextMaintenance,
    streamContextMaintenance,
    ...backgroundWork,
    journalBackfill,
    claudeTranscriptAudit,
    taskCatalogFinalization,
    ...providerSnapshots,
    ...providerOperations,
    ...providerCatalog,
    providerStartup,
  };
}
