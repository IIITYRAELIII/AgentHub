import { randomUUID } from "node:crypto";
import dns from "node:dns";
import path from "node:path";
import process from "node:process";
import {
  canonicalizeProjectRoots,
  findContainingProject,
  AGENT_HUB_ROOT,
  loadConfig,
  samePath,
} from "../infrastructure/filesystem/config.mjs";
import { parseClaudeLimits } from "../providers/claude/claude.mjs";
import { processIsAlive, stopProcessTree } from "../providers/claude/claude-run-io.mjs";
import {
  CODEX_COLLABORATION_MODE_LABELS,
  CODEX_COLLABORATION_MODES,
  CODEX_REASONING_EFFORTS,
  CODEX_REASONING_LABELS,
  resolveCodexThreadSettings,
} from "../providers/codex/codex-settings.mjs";
import * as telegramStatus from "../interfaces/telegram/status.mjs";
const {
  formatArchiveMessage, formatClaudeRateLimits, formatCodexRateLimits, formatProgressHeading,
  formatRestartCompleteMessage, formatTaskAlreadySelectedMessage, formatTaskSwitchMessage,
  showLastMessageReplyMarkup,
} = telegramStatus;
import {
  readCodexTurnUsage,
} from "../providers/codex/codex-turn-usage.mjs";
import { emptyTokenUsage } from "../domain/token-usage.mjs";
import { telegramPrompt } from "../interfaces/telegram/telegram-message.mjs";
import {
  captureTaskGitBaseline,
  resolveTaskGitRepoRoots,
  taskGitDiff,
} from "../infrastructure/filesystem/task-git-diff.mjs";
import { findRepositoryWriteConflict } from "../infrastructure/filesystem/repository-conflict.mjs";
import {
  appendMessageBindings,
  findMessageBinding,
  readMessageBindings,
  removeMessageBindings,
} from "../infrastructure/persistence/message-bindings.mjs";
import {
  readCodexThreadTitleHistories,
  readCodexThreadTitleHistory,
  resolveChatId as resolveNotificationChatId,
  showMessageReplyMarkup,
} from "../../send-message.mjs";
import {
  formatProgressHeartbeat,
  markProgressHeartbeat,
  PROGRESS_STALLED_AFTER_MS,
  retainProgressMessageAfterEditError,
} from "../runtime/progress-heartbeat.mjs";
import {
  taskRunIsActive,
  taskRunKey,
  updateTaskRunTitle,
} from "../domain/task-runs.mjs";
import { readClaudeSessionSnapshot } from "../providers/claude/claude-session-reader.mjs";
import * as approvalProtocol from "../providers/codex/codex-approvals.mjs";
const { formatPermissionsApproval, parseApprovalCallback } = approvalProtocol;
import { contextualCallback } from "../interfaces/telegram/callback-context.mjs";
import { taskViewCallbackData } from "../interfaces/telegram/task-view-callback.mjs";
import { writeTextAtomic } from "../infrastructure/persistence/state-store.mjs";
import {
  mergeTaskCatalog,
  taskOrderingActivityAtMs,
} from "../application/task-catalog-projection.mjs";
import { readCodexRolloutActivity } from "../providers/codex/codex-rollout-activity.mjs";
import { catalogEntryIsSelected } from "../domain/task-catalog-identity.mjs";
import { TASK_EXECUTION_OWNERS, taskExecutionRuntimeLabel } from "../domain/task-execution-owner.mjs";
import {
  codexObservedRuntimeActive,
  resolveCodexTaskActivity,
  resolveCodexObservedExecutionOwner,
} from "../providers/codex/codex-runtime-owner.mjs";
import { defaultRuntimeRoot } from "../infrastructure/filesystem/runtime-layout.mjs";
import { ensureLocalWebSecret } from "../interfaces/web/local-web-auth.mjs";
import {
  commandTaskTarget,
} from "../application/application-command-service.mjs";
import { agentHubAutostartShortcut } from "../interfaces/web/server-page.mjs";
import {
  defaultAutostartInstallScript,
  ServerControlController,
} from "../interfaces/web/server-control-controller.mjs";
import { RuntimeTimerCoordinator } from "../runtime/runtime-timer-coordinator.mjs";
import { createHubStaticSettings } from "./hub-static-settings.mjs";
import { createCodexObservabilityComposition } from "./codex-observability-composition.mjs";
import { createClientInterfaceComposition } from "./client-interface-composition.mjs";
import { createHubInfrastructure } from "./infrastructure-composition.mjs";
import { createProviderSnapshotComposition } from "./provider-snapshot-composition.mjs";
import { createProviderOperationComposition } from "./provider-operation-composition.mjs";
import { createProviderCatalogComposition } from "./provider-catalog-composition.mjs";
import { createStateComposition } from "./state-composition.mjs";
import { createTelegramControllerComposition } from "./telegram-controller-composition.mjs";
import { createRunPresentationComposition } from "./run-presentation-composition.mjs";
import { createDesktopReadSystemWiring } from "./desktop-read-system-wiring-composition.mjs";
import { createDesktopCommandWiring } from "./desktop-command-wiring-composition.mjs";
import { createDesktopRunRouterWiring } from "./desktop-run-router-wiring-composition.mjs";
import { createRuntimeDataComposition } from "./runtime-data-composition.mjs";
import { createBackgroundWorkComposition } from "./background-work-composition.mjs";
import { createCodexLifecycleComposition } from "./codex-lifecycle-composition.mjs";
import { createRunCompletionComposition } from "./run-completion-composition.mjs";
import { createCodexContextMaintenanceComposition } from "./codex-context-maintenance-composition.mjs";
import { createProviderStartupComposition } from "./provider-startup-composition.mjs";
import { createJournalBackfillComposition } from "./journal-backfill-composition.mjs";
import { createClaudeTranscriptAuditComposition } from "./claude-transcript-audit-composition.mjs";
import { createTaskCatalogFinalizationComposition } from "./task-catalog-finalization-composition.mjs";
import { createProviderProcessComposition } from "./provider-process-composition.mjs";
import { createRunAdmissionComposition } from "./run-admission-composition.mjs";
import { createRuntimeCommandRoutingComposition } from "./runtime-command-routing-composition.mjs";
import { createDeliveryOutboxComposition } from "./delivery-outbox-composition.mjs";
import { createRuntimeTimersComposition, delay } from "./runtime-timers-composition.mjs";
import { createAgentHubBootstrapComposition } from "./agent-hub-bootstrap-composition.mjs";
import { createRunAccountingComposition } from "./run-accounting-composition.mjs";
import { createCodexTaskSettingsComposition } from "./codex-task-settings-composition.mjs";
import { createProviderRuntimeWiring } from "./provider-runtime-wiring-composition.mjs";
import { createTaskInteractionWiring } from "./task-interaction-wiring-composition.mjs";
import { createRuntimeRestartWiring } from "./runtime-restart-wiring-composition.mjs";
import { createTaskStateWiring } from "./task-state-wiring-composition.mjs";
import { createRuntimeStateBootstrapWiring } from "./runtime-state-bootstrap-wiring-composition.mjs";
import { createTelegramShellWiring } from "./telegram-shell-wiring-composition.mjs";
import { createAgentHubDeferredPorts } from "./agent-hub-deferred-ports.mjs";
import { HubSessionState } from "../runtime/hub-session-state.mjs";

if (process.platform === "win32") dns.setDefaultResultOrder("ipv4first");

const agentHubDeferred = createAgentHubDeferredPorts();
const config = await loadConfig();
const serverStartedAt = new Date().toISOString();
const serverInstanceId = randomUUID();
const serverReleaseId = path.basename(AGENT_HUB_ROOT);
const {
  globalWorkLogProjectRoots,
  journalDatabaseFile,
  legacyWorkLogLedgerFile,
  legacyWorkLogFile,
  claudeModels: CLAUDE_MODELS,
  claudeModelLabels: CLAUDE_MODEL_LABELS,
  codexModels: CODEX_MODELS,
  normalizeCodexModel,
  codexModelLabel,
  defaultCodexModel,
  defaultCodexReasoningEffort,
  projects: PROJECTS,
  defaultProjectRoot: DEFAULT_PROJECT_ROOT,
  stateFile: STATE_FILE,
  stateBackupFile: STATE_BACKUP_FILE,
  deliveryOutboxDirectory: DELIVERY_OUTBOX_DIR,
  backgroundJobsDirectory: BACKGROUND_JOBS_DIR,
  failedUpdatesDirectory: FAILED_UPDATES_DIR,
  instanceLockFile: INSTANCE_LOCK_FILE,
  pinnedTaskTitlesFile: PINNED_TASK_TITLES_FILE,
  taskSyncFile: TASK_SYNC_FILE,
  taskDiffsFile: TASK_DIFFS_FILE,
  exchangeRatesFile: EXCHANGE_RATES_FILE,
  statusHeaderDirectory: STATUS_HEADER_DIR,
  telegramLimit: TELEGRAM_LIMIT,
  threadListLimit: THREAD_LIST_LIMIT,
  taskPickerPageSize: TASK_PICKER_PAGE_SIZE,
  maxDeferredInputs: MAX_DEFERRED_INPUTS,
  maxBackgroundMediaJobs: MAX_BACKGROUND_MEDIA_JOBS,
  maxBackgroundSpeechJobs: MAX_BACKGROUND_SPEECH_JOBS,
  maxInteractiveJobs: MAX_INTERACTIVE_JOBS,
  botCommands: BOT_COMMANDS,
  botMenu: BOT_MENU,
  menuCommands: MENU_COMMANDS,
} = createHubStaticSettings(config, AGENT_HUB_ROOT);
const runtimeCommandRoot = process.env.AGENT_HUB_RUNTIME_ROOT
  ?? (process.env.AGENT_HUB_CONFIG
    ? path.dirname(config.configPath)
    : defaultRuntimeRoot());
const agentHubAutostartShortcutPath = agentHubAutostartShortcut({ environment: process.env });
const localWebSecret = config.miniApp.enabled
  ? await ensureLocalWebSecret(path.join(runtimeCommandRoot, "local-web.secret"))
  : "";
const {
  trustedDeviceStore,
  codexRolloutContextSanitizer,
  workLogUsageStore,
  miniAppServer,
  publicMiniAppServer,
  usdRubRateStore,
  instanceGuard,
  runtimeStateStore,
  taskReadStateStore,
  turnEndNotifications,
  runtimeNotificationController,
  runJournal,
  runtimeCommandServer,
  rateLimitHistoryStore,
} = await createHubInfrastructure({
  config,
  agentHubRoot: AGENT_HUB_ROOT,
  runtimeCommandRoot,
  localWebSecret,
  journalDatabaseFile,
  legacyWorkLogLedgerFile,
  legacyWorkLogFile,
  globalWorkLogProjectRoots,
  stateFile: STATE_FILE,
  stateBackupFile: STATE_BACKUP_FILE,
  instanceLockFile: INSTANCE_LOCK_FILE,
  exchangeRatesFile: EXCHANGE_RATES_FILE,
  handleDesktopControl,
  findProject: agentHubDeferred.api.findProject,
  authorizeRuntimeCommand: agentHubDeferred.api.authorizeRuntimeCommand,
  reconcileRuntimeCommand: agentHubDeferred.api.reconcileRuntimeCommand,
  handleRuntimeCommand: agentHubDeferred.api.handleRuntimeCommand,
  stopProcessTree,
});
const initialProvider = config.provider === "codex" ? "codex" : "claude";
const token = config.token;
const { taskMetadata, selectionStore, agentPreferences } = createStateComposition({
  config,
  initialProvider,
  initialProjectRoot: DEFAULT_PROJECT_ROOT,
  codexModels: CODEX_MODELS,
  claudeModels: CLAUDE_MODELS,
  defaultCodexModel,
  defaultCodexReasoningEffort,
  normalizeCodexModel,
});
function selectedProvider() { return selectionStore.activeProvider; }
function selectedProjectRoot() { return selectionStore.activeProjectRoot; }
function selectedThreadId() { return selectionStore.threadId; }
function selectedTaskTitle() { return selectionStore.activeThreadTitle; }
function isCodex() { return selectedProvider() === "codex"; }
function providerTitle() { return isCodex() ? "Codex" : "Claude Code"; }
const hostState = new HubSessionState({ autoApprove: config.autoApproveOnStart });
const {
  ports: {
    runAdmission: runAdmissionPort,
    runtimeCommand: runtimeCommandPort,
    codexTaskSettings: codexTaskSettingsPort,
    providerRuntime: providerRuntimePort,
    taskInteraction: taskInteractionPort,
    runtimeRestart: runtimeRestartPort,
    taskState: taskStatePort,
    telegramShell: telegramShellPort,
    telegramDelivery: telegramDeliveryPort,
    codexLifecycle: codexLifecyclePort,
    providerStartup: providerStartupPort,
    desktopCommands: desktopCommandsPort,
    deferredInput: deferredInputPort,
    bootstrap: bootstrapPort,
  },
  api: {
  resolvedExplicitSkillNames,
  discardManualContextCompactionRun,
  taskExternalActivity,
  launchTurn,
  startTurn,
  cleanupDeferredFiles,
  scheduleQueuedInput,
  runtimeCommandTaskTitle,
  authorizeRuntimeCommand,
  reconcileRuntimeCommand,
  handleRuntimeCommand,
  codexThreadResponseTitle,
  storedCodexThreadTitle,
  resolveResumedCodexThreadTitle,
  updateActiveCodexThreadSettings,
  taskSwitchSettings,
  persistManagedRunHistory,
  persistClaudeRunHistory,
  startClaudeTurn,
  stopClaudeRunProcess,
  attachClaudeRunAfterRestart,
  handleCodexMessage,
  completedCodexAnswer,
  applyCodexObservedSnapshot,
  applyCodexActiveSnapshot,
  readCodexTaskSnapshot,
  scheduleCodexTerminalAudit,
  readCachedHistory,
  refreshHistory,
  showTaskMessage,
  showLastTaskMessage,
  resolveTaskViewBinding,
  requestApproval,
  requestMcpElicitation,
  formatCommandApproval,
  formatFileApproval,
  formatApprovalMode,
  approvalModeKeyboard,
  restartBlockingRuns,
  restartHasBlockingWork,
  scheduleDeferredRestartIfReady,
  restartMessageIsEditable,
  announceDesktopRestart,
  updateRestartMessage,
  finalizeRestartMessage,
  performRestart,
  restartBot,
  invalidateTaskCatalog,
  syncTaskRun,
  persistTaskDiff,
  findProject,
  activeProject,
  selectedTask,
  selectedTurnTarget,
  currentUiContextToken,
  uiCallback,
  selectedRun,
  isSelectedRun,
  runProject,
  runTaskTitle,
  pinnedTaskTitle,
  pinTaskTitle,
  pendingTaskTitle,
  expectTaskTitleConfirmation,
  sendThreadPicker,
  sendProjectPicker,
  sendAgentPicker,
  sendModelPicker,
  switchCodexModel,
  switchModel,
  resumeThread,
  renameCurrentTask,
  archiveCurrentThread,
  archiveBlockedReason,
  sendArchiveMessage,
  currentStatusSnapshot,
  sendReasoningPicker,
  sendCollaborationModePicker,
  runMessageBinding,
  bindRunMessage,
  sendRunMessage,
  bindIncomingTaskMessage,
  deleteTaskMessages: deleteTaskTelegramMessages,
  sendTaskViewText,
  sendReliableRunMessage,
  sendRunLongMessage,
  clearDeliveredProgressMessages,
  safelyDeliverRunMessage,
  finalizeRunDelivery,
  startCodexAppServer,
  stopCodexAppServerTree,
  restartCodexAfterCrash,
  sendRpc,
  invalidateCodexThreadRead,
  readCodexThread,
  sendNotification,
  respondRpc,
  initializeCodex,
  initializeProvider,
  attachCodexThread,
  createThread,
  listThreads,
  isWorkspaceThread,
  threadTitle,
  desktopMessageTarget: deferredDesktopMessageTarget,
  isDeferredInputProcessing,
  cancelDeferredInputSchedule,
  scheduleNextDeferredInput,
  desktopControlServer,
  },
} = agentHubDeferred;
const runtimeTimers = new RuntimeTimerCoordinator();
const SELECTED_TASK_WATCH_INTERVAL_MS = 2_000;
const EXTERNAL_TASK_POLL_INTERVAL_MS = 1_500;
const MANAGED_TASK_FALLBACK_POLL_INTERVAL_MS = 5_000;
const CLAUDE_OUTPUT_POLL_INTERVAL_MS = 250;
const TASK_CATALOG_CACHE_MS = 1_500;
const TASK_TITLE_RECONCILE_INTERVAL_MS = 5 * 60_000;
const CODEX_RPC_TIMEOUT_MS = config.codexRpcTimeoutSeconds * 1000;
function defaultNotificationChatId() {
  return config.telegramEnabled ? resolveNotificationChatId(config, null) : null;
}
const {
  resolveClaudeInvocation,
  spawnCapture,
} = createProviderProcessComposition({
  config,
  getProjectRoot: selectedProjectRoot,
  stopProcessTree,
});
const {
  applyCodexRolloutContext,
  changedFilesForRun,
  projectTurnUsageToWorkLog,
  projectClaudeRunToWorkLog,
} = createRunAccountingComposition({
  runJournal,
  refreshTaskDiff,
  runTaskTitle,
});
const {
  taskRuns,
  dismissedExternalTasks,
  deferredInputs,
  pendingInputs,
  queuedInputs,
  taskDiffs,
  taskSyncStore,
  lastSeenTaskTurnIds,
  turnTemporaryFiles,
  turnSpeechButtons,
  cancelledManagedClaudeTasks,
  forwardBundles,
  desktopMessageReceipts,
  statusMediaFileIds,
} = await createRuntimeDataComposition({
  config,
  projects: PROJECTS,
  taskDiffsFile: TASK_DIFFS_FILE,
  taskSyncFile: TASK_SYNC_FILE,
  findProject,
  canonicalizeProjectRoots,
});
const codexObservability = createCodexObservabilityComposition({
  config,
  sendRpc,
  scheduleDeferredRestartIfReady,
  taskRuns,
  turnEndNotifications,
  workLogUsageStore,
  changedFilesForRun,
  projectTurnUsageToWorkLog,
  runtimeCommandTaskTitle,
  rememberLastTaskMessage,
  lastSeenTaskTurnIds,
  saveState,
  deliverTurnEndNotification,
  defaultNotificationChatId,
  findProject,
  resolveTaskByProviderRef: ({ provider, providerTaskId }) => taskCatalog.find((entry) => (
    entry.provider === provider && String(entry.threadId) === String(providerTaskId)
  )),
  globalWorkLogProjectRoots,
  isHistoricalBackfillIdle: () => taskRuns.size === 0 && !hostState.restartRequest,
});
const {
  usageTracker: codexUsageTracker,
  turnTokenUsage,
  compactions: contextCompactions,
  turnStarts: codexTurnStarts,
  hookReceipts: codexHookReceipts,
  replaceHookReceipts: replaceCodexHookReceipts,
  capturedExecutionOwner: capturedCodexExecutionOwner,
  knownRolloutPath: knownCodexRolloutPath,
  rememberRolloutPath: rememberCodexRolloutPath,
  terminalAudit: codexTerminalAudit,
} = codexObservability;
const {
  managedRunLifecycle,
  turnEndDelivery,
  codexRunFinalizer,
} = createRunCompletionComposition({
  config,
  taskRuns,
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
  codexModelLabel,
  claudeModelLabels: CLAUDE_MODEL_LABELS,
  reasoningLabels: CODEX_REASONING_LABELS,
  cancelledManagedClaudeTasks,
  persistTaskDiff,
  syncTaskRun,
  invalidateTaskCatalog,
  saveState,
  scheduleProgressStart: (run) => taskProgress.scheduleStart(run, config.progressStartDelayMs),
  clearSelectedDiff: (run) => { if (isSelectedRun(run)) hostState.setLatestDiff(""); },
  clearApprovals: (run) => {
    for (const [key, approval] of approvalController.pending) {
      if (approval.runId === run.id) approvalController.pending.delete(key);
    }
  },
  pauseObservation: (run) => taskObserver.pause(run),
  pauseClaude: (run) => claudeRunController.pause(run),
  stopTyping: () => stopTyping(),
  afterCompletion: async () => {
    if (hostState.restartRequest?.waitingForRuns && !restartHasBlockingWork() && !hostState.stopping) {
      setTimeout(() => void performRestart(), 0);
    }
  },
  turnEndNotifications,
  runJournal,
  lastSeenTaskTurnIds,
  codexTurnStarts,
  discardManualContextCompactionRun,
  finalizeRunDelivery,
  refreshTaskDiff,
  runTaskTitle,
  currentChatId: () => hostState.chatId,
  defaultNotificationChatId,
  changedFilesForRun,
  persistManagedRunHistory,
});
const codexContextMaintenance = createCodexContextMaintenanceComposition({
  config,
  runtimeTimers,
  contextCompactions,
  sanitizer: codexRolloutContextSanitizer,
  isStopping: () => hostState.stopping,
  transportRunning: () => codexTransport.running,
  activeRuns: () => taskRuns.values(),
  runIsActive: taskRunIsActive,
  refreshTaskCatalog,
  knownRolloutPath: knownCodexRolloutPath,
  readThread: readCodexThread,
  rememberRolloutPath: rememberCodexRolloutPath,
  stopTransport: stopCodexAppServerTree,
  startTransport: startCodexAppServer,
  initializeTransport: initializeCodex,
  providerIsSelected: isCodex,
  setTransportRestarting: (value) => codexRuntime.setRestarting(value),
  invalidateTaskCatalog,
  restartTransportAfterCrash: restartCodexAfterCrash,
  runForTask: (target) => taskRuns.forTask(target),
  sendRpc,
});
const {
  failedUpdateStore,
  backgroundJobStore,
  backgroundJobs,
  interactiveJobs,
} = await createBackgroundWorkComposition({
  backgroundDirectory: BACKGROUND_JOBS_DIR,
  failedUpdatesDirectory: FAILED_UPDATES_DIR,
  maxMediaJobs: MAX_BACKGROUND_MEDIA_JOBS,
  maxSpeechJobs: MAX_BACKGROUND_SPEECH_JOBS,
  maxInteractiveJobs: MAX_INTERACTIVE_JOBS,
  isStopping: () => hostState.stopping,
  onIdle: scheduleDeferredRestartIfReady,
  sendMessage: (...args) => sendMessageTo(...args),
  media: {
    captureImage: (...args) => mediaController.captureImage(...args),
    analyzeImage: (...args) => mediaController.analyzeImage(...args),
    transcribeVoice: (...args) => mediaController.transcribeVoice(...args),
    processSpeechRequest: (...args) => mediaController.processSpeechRequest(...args),
  },
  forwardBundles: {
    imageDescriptor: (...args) => forwardBundleController.imageDescriptor(...args),
    completeImage: (...args) => forwardBundleController.completeImage(...args),
    failImage: (...args) => forwardBundleController.failImage(...args),
    pendingImageJobs: () => forwardBundleController.pendingImageJobs(),
  },
});
const journalBackfill = createJournalBackfillComposition({
  projects: PROJECTS,
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
  projects: PROJECTS,
  titleReconcileIntervalMs: TASK_TITLE_RECONCILE_INTERVAL_MS,
  journalDatabaseFile,
  projectionProjectRoots: globalWorkLogProjectRoots,
  workLogUsageStore,
  taskRuns,
  savedLastTaskMessageRecord,
  deferredTaskMessageAtMs,
  selectedTask,
  getActiveThreadTitle: selectedTaskTitle,
  selectionStore,
  taskSyncStore,
  saveState,
});
const {
  claudeTaskSnapshots,
  claudeEventService,
  codexTaskSnapshots,
} = createProviderSnapshotComposition({
  readClaudeSessionSnapshot,
  findProject,
  saveState,
  cancelledManagedClaudeTasks,
  isSelectedRun,
  taskRuns,
  selectionStore,
  runTaskTitle,
  bindRunMessage,
  taskProgress: () => taskProgress,
  knownCodexRolloutPath,
  capturedCodexExecutionOwner,
  readCodexThread,
  codexTransportPid: () => codexTransport.pid,
  codexModelLabel,
  reasoningLabels: CODEX_REASONING_LABELS,
  delay,
});
const {
  codexProviderTasks,
  claudeProviderTasks,
  codexCompletionService,
  claudeCompletionService,
  claudeRecoveryService,
  codexRecoveryService,
  codexTurnService,
  providerCancellationService,
  codexEventService,
} = createProviderOperationComposition({
  taskRuns,
  selectionStore,
  saveState,
  taskProgress: () => taskProgress,
  taskObserver: () => taskObserver,
  managedRunLifecycle,
  runRecovery: () => runRecovery,
  runCoordinator: () => runCoordinator,
  turnTemporaryFiles,
  turnSpeechButtons,
  turnTokenUsage,
  cancelledManagedClaudeTasks,
  taskDiffs,
  isSelectedRun,
  codexTransportRunning: () => codexTransport.running,
  startCodexTransport: startCodexAppServer,
  initializeCodex,
  sendRpc,
  activeProjectRoot: selectedProjectRoot,
  codexSandboxMode: () => config.codexSandboxMode,
  invalidateTaskCatalog,
  restoreCodexTaskSettings,
  updateActiveCodexThreadSettings,
  clearLatestDiff: () => hostState.setLatestDiff(""),
  consumeTurnTokenTracker,
  waitForTurnEndCompletion,
  readCodexThread,
  readCodexTurnUsage,
  applyCodexRolloutContext,
  finalizeCodexRunDelivery,
  completedCodexAnswer,
  persistClaudeRunHistory,
  projectClaudeRunToWorkLog,
  finalizeRunDelivery,
  attachClaudeRunAfterRestart,
  readCodexTaskSnapshot,
  isCodex,
  autoApprove: () => hostState.autoApprove,
  restartRequested: () => Boolean(hostState.restartRequest),
  launchTurn,
  startTyping: () => startTyping(),
  telegram: (...args) => telegram(...args),
  codexContextMaintenance,
  contextCompactions,
  resolvedExplicitSkillNames,
  taskExternalActivity,
  stopClaudeRunProcess,
  processIsAlive,
  invalidateCodexThreadRead,
  applyCodexThreadSettings,
  trackTurnTokenUsage,
  setLatestDiff: (value) => hostState.setLatestDiff(value),
  requestApproval,
  formatCommandApproval,
  formatFileApproval,
  formatPermissionsApproval,
  requestMcpElicitation,
  discardManualContextCompactionRun,
});
const {
  managedRunHistory,
  agentProviders,
  taskCatalogService,
  taskCatalog,
} = createProviderCatalogComposition({
  taskSyncStore,
  taskRuns,
  taskCatalogCacheMs: TASK_CATALOG_CACHE_MS,
  runProject,
  finalizeTaskCatalog,
  findProject,
  saveState,
  codexProviderTasks,
  claudeProviderTasks,
  codexCompletionService,
  claudeCompletionService,
  codexRecoveryService,
  claudeRecoveryService,
  codexTurnService,
  providerCancellationService,
  readCodexTaskSnapshot,
  readCodexThread,
  applyCodexObservedSnapshot,
  applyCodexActiveSnapshot,
  startClaudeTurn,
  claudeTaskSnapshots,
  backfillWorkLogPricingMetadata,
  readCodexThreadTitleHistories,
  rememberCodexRolloutPath,
  capturedCodexExecutionOwner,
  codexObservedRuntimeActive,
  codexTransportPid: () => codexTransport.pid,
  resolveCodexObservedExecutionOwner,
  codexModelLabel,
  codexThreadResponseTitle,
  pendingTaskTitle,
  clearExpectedTitle: (key) => taskMetadata.clearExpectedTitle(key),
  pinnedTaskTitle,
  reconcilePinnedTitle: (provider, providerTaskId, title) => (
    taskMetadata.reconcilePinnedTitle({ provider, threadId: providerTaskId }, title)
  ),
  savePinnedTaskTitles,
  sendRpc,
  auditClaudeTranscriptSnapshots,
  knownCodexRolloutPath,
  codexTransportRunning: () => codexTransport.running,
  ensureCodex: async () => {
    await startCodexAppServer();
    await initializeCodex({ attachSelectedThread: false });
  },
  resolveCodexTaskActivity,
});
const providerStartup = providerStartupPort.bind(createProviderStartupComposition({
  config,
  threadListLimit: THREAD_LIST_LIMIT,
  selectionStore,
  taskRuns,
  agentProviders,
  codexProviderTasks,
  getProvider: selectedProvider,
  getProjectRoot: selectedProjectRoot,
  getThreadId: selectedThreadId,
  isCodex,
  startCodex: startCodexAppServer,
  initializeCodex,
  sendRpc,
  resolveResumedCodexThreadTitle,
  applyCodexThreadSettings,
  saveState,
}));

const {
  telegramClient,
  telegram,
  miniAppLifecycle,
  desktopAttachments,
  desktopAttachmentPaths,
  isLegacyDesktopAttachmentFile,
  desktopAttachmentDescriptors,
  importCodexDesktopAttachments,
  desktopOpenAttachment,
  desktopSubmitBugReport,
  telegramMultipart,
  sendStatusCard,
  sendMessage,
  sendMessageTo,
  sendLongMessage,
  startTyping,
  stopTyping,
  deferredInputPresentation,
  telegramSettingsMenu,
  rateLimitTelemetry,
  telegramStatusController,
  mediaController,
  approvalController,
} = await createClientInterfaceComposition({
  config,
  token,
  botMenu: BOT_MENU,
  statusHeaderDirectory: STATUS_HEADER_DIR,
  statusMediaFileIds,
  saveState,
  currentChatId: () => hostState.chatId,
  currentProvider: selectedProvider,
  telegramLimit: TELEGRAM_LIMIT,
  miniAppServer,
  publicMiniAppServer,
  runtimeCommandRoot,
  journalDatabaseFile,
  handleDesktopControl,
  reconcileRemoteDesktopControl,
  forgetDesktopControl: (id) => forgetDesktopControl(id),
  trustedDeviceUserId,
  desktopMessageReceipts,
  projects: PROJECTS,
  codexModels: CODEX_MODELS,
  claudeModels: CLAUDE_MODELS,
  claudeModelLabels: CLAUDE_MODEL_LABELS,
  reasoningEfforts: CODEX_REASONING_EFFORTS,
  reasoningLabels: CODEX_REASONING_LABELS,
  collaborationModes: CODEX_COLLABORATION_MODES,
  collaborationModeLabels: CODEX_COLLABORATION_MODE_LABELS,
  uiCallback,
  resolveClaudeInvocation,
  parseClaudeLimits,
  formatClaudeRateLimits,
  formatCodexRateLimits,
  spawnCapture,
  sendRpc,
  codexTransportRunning: () => codexTransport.running,
  rateLimitHistoryStore,
  workLogUsageStore,
  runtimeTimers,
  isStopping: () => hostState.stopping,
  findProject,
  refreshTaskCatalog,
  currentTaskCatalog: () => taskCatalog,
  currentTaskRuns: () => taskRuns.values(),
  codexModelLabel,
  agentHubRoot: AGENT_HUB_ROOT,
  stopProcessTree,
  startTurn,
  activeProjectRoot: selectedProjectRoot,
  approvalProtocol,
  autoApprove: () => hostState.autoApprove,
  respondRpc,
  sendRunMessage,
  runExists: (id) => taskRuns.values().some((run) => run.id === id),
  taskProgress: () => taskProgress,
});

const {
  deliveryOutbox,
  scheduleDeliveryOutboxFlush,
} = await createDeliveryOutboxComposition({
  directoryPath: DELIVERY_OUTBOX_DIR,
  retryIntervalMs: config.deliveryRetryIntervalSeconds * 1000,
  runtimeTimers,
  isStopping: () => hostState.stopping,
  deliver: (method, body) => {
    if (method !== "sendPhotoFile") return telegram(method, body);
    const { photo_path: photoPath, ...telegramBody } = body;
    return telegramMultipart("sendPhoto", telegramBody, "photo", photoPath);
  },
  onDelivered: (item, result) => telegramDeliveryService.recordDeliveredOutbox(item, result),
  onPermanentFailure: async (item, error) => {
    console.error(`Quarantined permanent Telegram delivery ${item.id}:`, error.message);
  },
});

taskStatePort.bind(createTaskStateWiring({
  taskCatalogService,
  taskSyncStore,
  selectionStore,
  projects: PROJECTS,
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

function setBoundedMapValue(map, key, value, limit) {
  if (map.has(key)) map.delete(key);
  map.set(key, value);
  while (map.size > limit) map.delete(map.keys().next().value);
}

function sendTaskSelectionNotification(options = {}) {
  return telegramDeliveryPort.api.sendTaskSelectionNotification({ targetChatId: hostState.chatId, ...options });
}
function sendTaskSwitchNotification(options = {}) { return sendTaskSelectionNotification(options); }
function sendTaskAlreadySelectedNotification(options = {}) {
  return sendTaskSelectionNotification({ ...options, alreadySelected: true });
}

function rememberLastTaskMessage(run, text) {
  return runJournal.rememberLastMessage(run, text);
}

function savedLastTaskMessage(task) {
  return runJournal.lastMessage(task);
}

function savedLastTaskMessageRecord(task) {
  return runJournal.lastMessageRecord(task);
}

function deferredTaskMessageAtMs(task) {
  return deferredInputs.latestActivityAt(task);
}

function latestThreadContextUsage(contextThreadId, contextTurnId = "") {
  return codexUsageTracker.latestContext(contextThreadId, contextTurnId);
}

function trackTurnTokenUsage(params) {
  return codexUsageTracker.track(params);
}

function consumeTurnTokenTracker(turnId) {
  return codexUsageTracker.consume(turnId);
}

async function finalizeCodexRunDelivery(run, {
  answer,
  turnId: completedTurnId = run?.turnId,
  status = "completed",
  tracker = { usage: emptyTokenUsage(), reported: false },
  forceSpeechButton = false,
  deliver = true,
  silent = false,
  description = "финальный ответ Codex",
} = {}) {
  return codexRunFinalizer.finalize(run, {
    answer,
    turnId: completedTurnId,
    status,
    tracker,
    forceSpeechButton,
    deliver,
    silent,
    description,
  });
}

async function deliverTurnEndNotification(completion) {
  return turnEndDelivery.deliver(completion);
}

async function retryPendingTurnEndNotifications() {
  return turnEndDelivery.retryPending();
}

async function waitForTurnEndCompletion(identity, timeoutMs = 2_000) {
  return turnEndDelivery.waitForCompletion(identity, timeoutMs);
}

function rememberCodexTaskSettings(...args) {
  return agentPreferences.rememberCodexTaskSettings(...args);
}
function restoreCodexTaskSettings(...args) {
  return agentPreferences.restoreCodexTaskSettings(...args);
}
function applyCodexThreadSettings(...args) {
  return agentPreferences.applyCodexThreadSettings(...args);
}

const {
  runtimeStateCoordinator,
  journalStartupReady,
} = await createRuntimeStateBootstrapWiring({
  restoration: {
    config,
    projects: PROJECTS,
    maximumDeferredInputs: MAX_DEFERRED_INPUTS,
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
      codexTurnStarts,
      codexTerminalAudit,
      turnEndNotifications,
      dismissedExternalTasks,
      cancelledManagedClaudeTasks,
      pendingInputs,
      queuedInputs,
      isLegacyDesktopAttachmentFile,
      desktopMessageReceipts,
      updateDeferredDesktopReceipt,
      forwardBundles,
      taskRuns,
    },
    snapshotContext: {
      getChatId: () => hostState.chatId,
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
      codexTurnStarts,
      codexTerminalAudit,
      turnEndNotifications,
      statusMediaFileIds,
    },
  },
  applyRestoredState: (restoredState) => {
    hostState.restore(restoredState);
    replaceCodexHookReceipts(restoredState.codexHookReceipts);
    const restoredThreadId = selectedThreadId();
    if (isCodex() && restoredThreadId) {
      if (taskMetadata.codexSettings(restoredThreadId)) restoreCodexTaskSettings(restoredThreadId);
      else rememberCodexTaskSettings(restoredThreadId);
    }
    return restoredState.restoredTurnEndSnapshot;
  },
  initializeJournal: (restoredTurnEndSnapshot) => runJournal.initialize(restoredTurnEndSnapshot),
  startupMaintenance: {
    config,
    taskRuns,
    pinnedTaskTitlesFile: PINNED_TASK_TITLES_FILE,
    taskMetadata,
  },
  logger: console,
});
workLogUsageStore.setIncludeClaudeUsage(agentPreferences.includeClaudeUsage);

const codexLifecycle = createCodexLifecycleComposition({
  config,
  rpcTimeoutMs: CODEX_RPC_TIMEOUT_MS,
  runtimeDependencies: {
    getActiveProjectRoot: selectedProjectRoot,
    stopProcessTree,
    handleMessage: handleCodexMessage,
    isStopping: () => hostState.stopping,
    providerSelected: isCodex,
    activeRuns: () => taskRuns.values(),
    setStage: (run, stage) => taskProgress.setStage(run, stage),
    recoverRuns: () => runRecovery.recoverAll({ provider: "codex" }),
    startTyping,
    attachSelectedThread: attachCodexThread,
  },
  controllerDependencies: {
    readCodexRolloutActivity,
    readCodexTurnUsage,
    findProject,
    codexTurnStarts,
    setBoundedMapValue,
    setHookReceipt: (kind, receipt) => { codexHookReceipts[kind] = receipt; },
    taskRuns,
    saveState,
    taskTitle: runtimeCommandTaskTitle,
    taskGitDiff,
    changedFilesForRun,
    turnEndNotifications,
    defaultNotificationChatId,
    projectTurnUsageToWorkLog,
    rememberLastTaskMessage,
    lastSeenTaskTurnIds,
    deliverTurnEndNotification,
  },
});
codexLifecyclePort.bind(codexLifecycle);
const { runtime: codexRuntime, transport: codexTransport, controller: codexLifecycleController } = codexLifecycle;
codexTaskSettingsPort.bind(createCodexTaskSettingsComposition({
  pinnedTaskTitle,
  readCodexThreadTitleHistory,
  sendRpc,
  isCodex,
  getThreadId: selectedThreadId,
  contextCompactions,
  agentPreferences,
  saveState,
  codexModelLabel,
  reasoningLabels: CODEX_REASONING_LABELS,
}));
runtimeCommandPort.bind(createRuntimeCommandRoutingComposition({
  pinnedTaskTitle,
  codexThreadResponseTitle,
  runTaskTitle,
  getTaskCatalog: () => taskCatalog,
  getActiveProvider: selectedProvider,
  getThreadId: selectedThreadId,
  getActiveThreadTitle: selectedTaskTitle,
  threadTitle,
  storedCodexThreadTitle,
  runtimeNotificationController,
  codexLifecycleController,
}));

async function backfillWorkLogPricingMetadata(codexThreads) {
  return journalBackfill.backfill(codexThreads);
}

async function auditClaudeTranscriptSnapshots(snapshots) {
  return claudeTranscriptAudit.audit(snapshots);
}

async function finalizeTaskCatalog(mergedEntries) {
  return taskCatalogFinalization.finalize(mergedEntries);
}

async function refreshTaskCatalog({ force = false } = {}) {
  return taskCatalogService.refresh({ force });
}

const serverControlController = new ServerControlController({
  config,
  startedAt: serverStartedAt,
  instanceId: serverInstanceId,
  releaseId: serverReleaseId,
  shortcutPath: agentHubAutostartShortcutPath,
  installScriptPath: defaultAutostartInstallScript(AGENT_HUB_ROOT),
  activeCount: () => taskRuns.values().filter(taskRunIsActive).length,
  restartState: () => ({
    pending: Boolean(hostState.restartRequest),
    waiting: hostState.restartRequest?.waitingForRuns === true,
    blockingCount: hostState.restartRequest
      ? restartBlockingRuns().length + backgroundJobs.size
      : 0,
  }),
  desktopSnapshot: () => desktopSnapshot(),
  spawnCapture,
});

const {
  trustedDeviceUserId: resolveDesktopTrustedDeviceUserId,
  desktopStatusDetails,
  desktopRateLimitHistory,
  desktopUsageHistory,
  desktopSearch,
  desktopTrustedDevices,
  desktopCreateDevicePairing,
  desktopRevokeDevice,
  desktopSpeakLastAnswer,
  desktopContextSnapshot,
  desktopRunSnapshot,
  desktopTaskSnapshot,
  desktopSnapshot,
  desktopTaskHistory,
  markDesktopTaskRead,
} = createDesktopReadSystemWiring({
  config,
  models: {
    codexModels: CODEX_MODELS,
    codexModelLabel,
    claudeModels: CLAUDE_MODELS,
    claudeModelLabels: CLAUDE_MODEL_LABELS,
    reasoningEfforts: CODEX_REASONING_EFFORTS,
    reasoningLabels: CODEX_REASONING_LABELS,
    collaborationModes: CODEX_COLLABORATION_MODES,
    collaborationModeLabels: CODEX_COLLABORATION_MODE_LABELS,
  },
  projects: PROJECTS,
  maxSpeechJobs: MAX_BACKGROUND_SPEECH_JOBS,
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
    preferences: (provider) => agentPreferences.current(provider),
    preferencesSnapshot: () => agentPreferences.snapshot(),
    formattedRateLimits: (provider) => rateLimitTelemetry.formatted(provider),
    activeRunCount: () => taskRuns.values().filter(taskRunIsActive).length,
    backgroundJobCount: () => backgroundJobs.size,
    readRateLimitHistory: (params) => rateLimitHistoryStore.read(params),
    readUsageHistory: (params) => workLogUsageStore.usageHistory(params),
    refreshCatalog: refreshTaskCatalog,
    searchTurns: (...args) => workLogUsageStore.searchTurns(...args),
    projectRoots: () => PROJECTS.map((project) => project.path),
    samePath,
    miniAppPublisher: miniAppLifecycle.publisher,
    trustedDeviceStore,
    resolveTask: deferredDesktopMessageTarget,
    lastTaskMessage: savedLastTaskMessageRecord,
    enqueueSpeech: (target, text) => backgroundJobs.enqueue(
      "speech",
      { chatId: hostState.chatId, text },
      hostState.chatId,
      { dedupeKey: `desktop:${target.provider}:${target.threadId}:speech` },
    ),
    latestContextUsage: latestThreadContextUsage,
    isCompacting: (contextThreadId) => contextCompactions.isRunning(contextThreadId),
    compactionFor: (contextThreadId) => contextCompactions.get(contextThreadId),
    runForTask: (task) => taskRuns.forTask(task),
    runTitle: runTaskTitle,
    findProject,
    catalogEntryIsSelected,
    executionRuntimeLabel: taskExecutionRuntimeLabel,
    orderingActivityAtMs: taskOrderingActivityAtMs,
    samePath,
    catalogEntries: () => taskCatalog,
    catalogRefreshedAt: () => taskCatalogService.refreshedAt,
    refreshCatalog: refreshTaskCatalog,
    mergeCatalog: mergeTaskCatalog,
    pendingValues: () => [...pendingInputs.values()],
    queuedValues: () => [...queuedInputs.values()],
    describeAttachments: desktopAttachmentDescriptors,
    receiptForMessage: (identity) => desktopMessageReceipts.get(identity),
    recentReceipts: () => desktopMessageReceipts.snapshot(),
    receiptForTurn: (identity) => desktopMessageReceipts.findByTurn(identity),
    approvalSnapshot: () => approvalController.snapshot(),
    restartBlockingRuns,
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

function trustedDeviceUserId(context) {
  return resolveDesktopTrustedDeviceUserId(context);
}

const desktopCommands = createDesktopCommandWiring({
  models: {
    reasoningEfforts: CODEX_REASONING_EFFORTS,
    collaborationModes: CODEX_COLLABORATION_MODES,
  },
  projects: PROJECTS,
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
    latestDiff: () => hostState.latestDiff,
    setLatestDiff: (value) => hostState.setLatestDiff(value),
    isCodex,
    selectedTask,
  },
  services: {
    catalogEntries: () => taskCatalog,
    refreshCatalog: refreshTaskCatalog,
    markTaskRead: markDesktopTaskRead,
    snapshot: desktopSnapshot,
    taskHistory: desktopTaskHistory,
    readTurn: (identity) => workLogUsageStore.getTurn(identity),
    samePath,
    warn: (...args) => console.warn(...args),
    pinTitle: pinTaskTitle,
    sendRpc,
    expectTitleConfirmation: expectTaskTitleConfirmation,
    invalidateCatalog: invalidateTaskCatalog,
    runForTask: (target) => taskRuns.forTask(target),
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
    deleteCodexSettings: (targetThreadId) => taskMetadata.deleteCodexSettings(targetThreadId),
    listCodexTasks: listThreads,
    codexTaskTitle: threadTitle,
    restoreCodexSettings: restoreCodexTaskSettings,
    diffs: {
      setLatest: (value) => hostState.setLatestDiff(value),
      forTask: (target) => taskDiffs.get(taskRunKey(target)) ?? "",
      refresh: refreshTaskDiff,
    },
    providerCancel: (run) => agentProviders.call(run.provider, "cancelRun", run),
    progress: {
      setStage: (...args) => taskProgress.setStage(...args),
      finish: (...args) => taskProgress.finish(...args),
    },
    dismissedExternalTasks,
    completeRun: (run) => managedRunLifecycle.complete(run),
    createTask: createThread,
    blockingWorkCount: () => restartBlockingRuns().length + backgroundJobs.size,
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
    projectUsage: () => workLogUsageStore.project(null, {
      projectRoot: config.projectRoot,
      projectionProjectRoots: globalWorkLogProjectRoots,
    }),
    approvalController,
    preferencesSnapshot: () => agentPreferences.snapshot(),
    selectedRun,
    sendTaskSwitchNotification,
    sendTaskAlreadySelectedNotification,
    formatArchiveMessage,
    sendMessage: sendMessageTo,
    showLastMessageReplyMarkup,
    bindRunMessage,
    telegram,
  },
});

const {
  applicationCommands,
  restartRequestService,
  telegramTaskActions,
  desktopSnapshotActions,
  dispatchApplicationCommand,
  settingCommandTarget,
  selectTaskFromBinding,
  switchProvider,
  switchProject,
  activateBinding: activateMessageBinding,
} = desktopCommands;
const {
  openTask: desktopOpenTask,
  openTurn: desktopOpenTurn,
  messageTarget: desktopMessageTarget,
  taskDiff: desktopTaskDiff,
  restartServer: desktopRestartServer,
} = desktopSnapshotActions;
desktopCommandsPort.bind({ messageTarget: desktopSnapshotActions.messageTarget });

const {
  runConflictPolicy,
  runCoordinator,
  telegramMessageCommandContext,
  telegramCallbackCommandContext,
  dispatchTelegramSetting,
  handleDesktopControl: dispatchDesktopControl,
  forgetDesktopControl,
  reconcileRemoteDesktopControl: dispatchRemoteDesktopReconciliation,
} = createDesktopRunRouterWiring({
  config,
  constants: {
    maxDeferredInputs: MAX_DEFERRED_INPUTS,
    taskExecutionOwners: TASK_EXECUTION_OWNERS,
  },
  state: {
    chatId: () => hostState.chatId,
    selectedTask,
    activeTaskTitle: selectedTaskTitle,
  },
  services: {
    startManualCompaction: (target) => codexContextMaintenance.startManual(target),
    deferredInputs,
    saveState,
    executionRuntimeLabel: taskExecutionRuntimeLabel,
    sendMessageTo,
    resolveRepoRoots: resolveTaskGitRepoRoots,
    refreshCatalog: () => refreshTaskCatalog(),
    activeRuns: () => taskRuns.values(),
    findConflict: findRepositoryWriteConflict,
    taskRuns,
    providers: agentProviders,
    externalActivity: taskExternalActivity,
    beginRun: (input, target) => managedRunLifecycle.begin(input, target),
    launchTurn,
    describeAttachments: desktopAttachmentDescriptors,
    hasDeferredBacklog: (target) => deferredInputs.hasBacklog(target),
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
  },
  desktop: {
    snapshot: desktopSnapshot,
    taskHistory: desktopTaskHistory,
    rateLimitHistory: desktopRateLimitHistory,
    usageHistory: desktopUsageHistory,
    search: desktopSearch,
    openTask: desktopOpenTask,
    openTurn: desktopOpenTurn,
    taskDiff: desktopTaskDiff,
    statusDetails: desktopStatusDetails,
    speakLastAnswer: desktopSpeakLastAnswer,
    restartServer: desktopRestartServer,
    openAttachment: desktopOpenAttachment,
    submitBugReport: desktopSubmitBugReport,
    trustedDevices: desktopTrustedDevices,
    createDevicePairing: desktopCreateDevicePairing,
    revokeDevice: desktopRevokeDevice,
    messageTarget: desktopMessageTarget,
    selectTaskFromBinding,
    dispatchApplicationCommand,
    settingCommandTarget,
    applicationCommands,
  },
});

function handleDesktopControl(request) {
  return dispatchDesktopControl(request);
}

function reconcileRemoteDesktopControl(request) {
  return dispatchRemoteDesktopReconciliation(request);
}

function sendStatus(snapshot = currentStatusSnapshot()) {
  return telegramShellPort.api.sendStatus(snapshot);
}

telegramShellPort.bind(createTelegramShellWiring({
  taskPicker: {
    refreshCatalog: refreshTaskCatalog,
    selectedTask,
    pageSize: TASK_PICKER_PAGE_SIZE,
    showProject: () => config.showProjectButton && config.showTaskProject,
    providerTitle,
    projectName: () => activeProject().name,
    newTaskCallback: () => uiCallback("thread:new"),
    archiveCallback: () => (isCodex() && selectedThreadId() ? uiCallback("thread:archive") : null),
    editMessage: (message, view) => telegram("editMessageText", {
      chat_id: message.chat.id,
      message_id: message.message_id,
      text: view.text,
      reply_markup: view.replyMarkup,
    }),
    sendMessage: (view) => sendMessage(view.text, { reply_markup: view.replyMarkup }),
  },
  settingsMenu: telegramSettingsMenu,
  taskActions: telegramTaskActions,
  statusController: telegramStatusController,
  activeProjectRoot: selectedProjectRoot,
  activeProvider: selectedProvider,
  agentPreferences,
  codexModelLabel,
  currentChatId: () => hostState.chatId,
}));

const runPresentationComposition = createRunPresentationComposition({
  telegramLimit: TELEGRAM_LIMIT,
  claudeModelLabels: CLAUDE_MODEL_LABELS,
  codexReasoningLabels: CODEX_REASONING_LABELS,
  codexModelLabel,
  taskExecutionRuntimeLabel,
  formatProgressHeading,
  formatProgressHeartbeat,
  showProject: () => config.showProjectButton,
  runTaskTitle,
  runProject,
  agentPreferences,
  taskExecutionOwners: TASK_EXECUTION_OWNERS,
  dataDir: config.dataDir,
  appendMessageBindings,
  readMessageBindings,
  removeMessageBindings,
  approvalController,
  samePath,
  taskRuns,
  telegram,
  sendMessageTo,
  deliveryOutbox,
  scheduleDeliveryOutboxFlush,
  taskRunKey,
  mediaController,
  taskViewCallbackData,
  managedRunLifecycle,
  runJournal,
  rememberLastSeenTurn: (run, turnId) => (
    setBoundedMapValue(lastSeenTaskTurnIds, taskRunKey(run), turnId, 500)
  ),
  refreshTaskDiff,
  selectedTask,
  activeTaskTitle: selectedTaskTitle,
  activeProjectName: () => activeProject().name,
  taskSwitchSettings,
  showLastMessageReplyMarkup,
  formatTaskSwitchMessage,
  formatTaskAlreadySelectedMessage,
  saveState,
  retainProgressMessageAfterEditError,
});
const {
  telegramDeliveryService,
  taskProgress,
} = runPresentationComposition;
telegramDeliveryPort.bind(telegramDeliveryService);

const runAdmissionComposition = runAdmissionPort.bind(createRunAdmissionComposition({
  config,
  samePath,
  sendRpc,
  contextCompactions,
  codexUsageTracker,
  turnSpeechButtons,
  turnTemporaryFiles,
  taskProgress,
  managedRunLifecycle,
  agentProviders,
  taskRuns,
  runCoordinator,
  runConflictPolicy,
  pendingInputs,
  queuedInputs,
  getSelectedTask: selectedTask,
  getActiveThreadTitle: selectedTaskTitle,
  getChatId: () => hostState.chatId,
  taskExecutionOwners: TASK_EXECUTION_OWNERS,
  deferredInputPresentation,
  sendMessageTo,
  saveState,
}));
const deferredInputController = runAdmissionComposition.deferredInputController;
deferredInputPort.bind(deferredInputController);
function updateDeferredMessage(...args) {
  return deferredInputPresentation.updateTelegramMessage(...args);
}
function updateDeferredDesktopReceipt(...args) {
  return deferredInputPresentation.updateDesktopReceipt(...args);
}
async function refreshTaskDiff(run) {
  if (!run) return "";
  const captured = await taskGitDiff(run.gitBaseline, config.dataDir, run.id);
  if (captured !== null) run.latestDiff = captured;
  await persistTaskDiff(taskRunKey(run), run.latestDiff ?? "");
  if (isSelectedRun(run)) hostState.setLatestDiff(run.latestDiff ?? "");
  return run.latestDiff ?? "";
}

const providerRuntimeWiring = providerRuntimePort.bind(createProviderRuntimeWiring({
  observation: {
    dataDir: config.dataDir,
    claudeOutputPollIntervalMs: CLAUDE_OUTPUT_POLL_INTERVAL_MS,
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
    reasoningLabels: CODEX_REASONING_LABELS,
    markProgressHeartbeat,
    progressStalledAfterMs: PROGRESS_STALLED_AFTER_MS,
    managedRunLifecycle,
    discardManualContextCompactionRun,
    savedLastTaskMessage,
    savedLastTaskMessageRecord,
    externalPollIntervalMs: EXTERNAL_TASK_POLL_INTERVAL_MS,
    managedPollIntervalMs: MANAGED_TASK_FALLBACK_POLL_INTERVAL_MS,
    captureTaskGitBaseline,
    turnTemporaryFiles,
    claudeTaskSnapshots,
    claudePermissionMode: config.claudePermissionMode,
    autoApprove: () => hostState.autoApprove,
    resolveClaudeInvocation,
    logWarning: (...args) => console.warn(...args),
    safelyDeliverRunMessage,
    sendRunMessage,
    dismissedExternalTasks,
    lastSeenTaskTurnIds,
    runtimeTimers,
    selectedTaskWatchIntervalMs: SELECTED_TASK_WATCH_INTERVAL_MS,
    selectedTask,
    chatId: () => hostState.chatId,
    activeTaskTitle: selectedTaskTitle,
    rememberLastTaskMessage,
    logError: (...args) => console.error(...args.map((value) => value?.message ?? value)),
  },
  managedRunHistory,
  claudeEventService,
  runCoordinator,
  codexEventService,
  codexTaskSnapshots,
  codexTerminalAudit,
  codexTransport,
  saveState,
  isStopping: () => hostState.stopping,
  runtimeTimers,
  selectedTaskWatchIntervalMs: SELECTED_TASK_WATCH_INTERVAL_MS,
  logger: console,
}));
const {
  claudeRunController,
  taskObserver,
  runRecovery,
  selectedTaskWatch,
} = providerRuntimeWiring;

const {
  stopRuntimeTimers,
  startRuntimeTimers,
} = createRuntimeTimersComposition({
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
  rateLimitTelemetry,
});

taskInteractionPort.bind(createTaskInteractionWiring({
  taskView: {
    ensureCodex: async () => {
      if (codexTransport.running) return;
      await startCodexAppServer();
      await initializeCodex({ attachSelectedThread: false });
    },
    findCodexRolloutPath: knownCodexRolloutPath,
    readCodexThread,
    readCodexRolloutActivity,
    readCodexSnapshot: readCodexTaskSnapshot,
    readClaudeSnapshot: (...args) => claudeTaskSnapshots.read(...args),
    attachmentImporter: importCodexDesktopAttachments,
    taskSyncStore,
    taskRuns,
    deleteTaskMessages: deleteTaskTelegramMessages,
    sendRunMessage,
    sendTaskViewText,
    runTaskTitle,
    savedLastTaskMessage,
    dismissedExternalTasks,
    saveState,
    resolveRunningTitle: (running, binding) => {
      const selectedTitle = isSelectedRun(running) ? selectedTaskTitle() : null;
      const catalogTitle = taskCatalog.find((entry) => catalogEntryIsSelected(entry, running))?.title;
      return selectedTitle || catalogTitle || binding.taskTitle;
    },
    taskProgress,
    taskObserver,
    findMessageBinding: (targetChatId, messageId) => (
      findMessageBinding(config.dataDir, targetChatId, messageId)
    ),
    taskCatalog: () => taskCatalog,
    refreshTaskCatalog,
    selectedTask,
    activeThreadTitle: selectedTaskTitle,
    logger: console,
  },
  approvalController,
  activeProvider: selectedProvider,
  autoApprove: () => hostState.autoApprove,
  autoApproveOnStart: config.autoApproveOnStart,
  claudePermissionMode: config.claudePermissionMode,
  activeProjectRoot: selectedProjectRoot,
  uiCallback,
}));

const runtimeRestartWiring = runtimeRestartPort.bind(createRuntimeRestartWiring({
  taskRuns,
  agentProviders,
  backgroundJobs,
  getRestartRequest: () => hostState.restartRequest,
  isStopping: () => hostState.stopping,
  restartRequestService,
  runtimeRestart: {
    getRestartRequest: () => hostState.restartRequest,
    setRestartRequest: (value) => hostState.setRestartRequest(value),
    isStopping: () => hostState.stopping,
    setStopping: (value) => hostState.setStopping(value),
    beginStopping: () => {
      return hostState.beginStopping();
    },
    sendMessage: sendMessageTo,
    telegram,
    saveState,
    formatRestartCompleteMessage,
    completeMessageState: () => ({
      provider: providerTitle(),
      task: selectedTaskTitle() || (selectedThreadId() ? `${providerTitle()} · ${selectedThreadId().slice(0, 8)}` : "Не выбрана"),
      runningTasks: taskRuns.size,
    }),
    botMenu: BOT_MENU,
    journalStartupReady,
    runtimeStateCoordinator,
    telegramDeliveryService,
    mediaController,
    taskSyncStore,
    deliveryOutbox,
    backgroundJobStore,
    failedUpdateStore,
    stopCodexAppServerTree,
    miniAppLifecycle,
    desktopControlServer,
    runtimeCommandServer,
    instanceGuard,
    workLogUsageStore,
    rateLimitHistoryStore,
    taskReadStateStore,
    runtimeStateStore,
    updateOffset: () => hostState.updateOffset,
    setWaiting: (value) => hostState.setRestartWaiting(value),
    stopRuntimeTimers,
    agentHubRoot: AGENT_HUB_ROOT,
    instanceLockFile: INSTANCE_LOCK_FILE,
    isCodex,
    taskRuns,
    startCodexAppServer,
    initializeCodex,
    runRecovery,
    updateRestartMessage: (message) => runtimeRestartWiring.updateRestartMessage(message),
    startRuntimeTimers,
    delay,
  },
}));
const { runtimeResources } = runtimeRestartWiring;

function dismissCallbackMenu(...args) { return telegramTaskActions.dismissMenu(...args); }

const {
  forwardBundleController,
  pollTelegram,
} = createTelegramControllerComposition({
  telegram,
  config,
  menuCommands: MENU_COMMANDS,
  botMenu: BOT_MENU,
  projects: PROJECTS,
  reasoningLabels: CODEX_REASONING_LABELS,
  collaborationModeLabels: CODEX_COLLABORATION_MODE_LABELS,
  claudeModelLabels: CLAUDE_MODEL_LABELS,
  parseApprovalCallback,
  dispatchTelegramSetting,
  dispatchApplicationCommand,
  telegramCallbackCommandContext,
  telegramMessageCommandContext,
  commandTaskTarget,
  activeProject,
  activeProvider: selectedProvider,
  autoApprove: () => hostState.autoApprove,
  agentPreferences,
  codexModelLabel,
  providerTitle,
  resolveTaskViewBinding,
  taskRuns,
  refreshTaskDiff,
  taskDiffs,
  taskRunKey,
  selectTaskFromBinding,
  showLastTaskMessage,
  showTaskMessage,
  sendMessage,
  sendMessageTo,
  sendLongMessage,
  sendTaskSwitchNotification,
  sendTaskAlreadySelectedNotification,
  sendThreadPicker,
  refreshTaskCatalog,
  taskCatalog: () => taskCatalog,
  archiveBlockedReason,
  archiveCurrentThread,
  sendArchiveMessage,
  dismissCallbackMenu,
  updateDeferredDesktopReceipt,
  cleanupDeferredFiles,
  saveState,
  updateDeferredMessage,
  deferredInputController,
  scheduleQueuedInput,
  startTurn,
  desktopAttachmentDescriptors,
  activeThreadTitle: selectedTaskTitle,
  selectedTask,
  mediaController,
  pendingInputs,
  queuedInputs,
  backgroundJobs,
  maxSpeechJobs: MAX_BACKGROUND_SPEECH_JOBS,
  currentUiContextToken,
  interactiveJobs,
  isStopping: () => hostState.stopping,
  sendAgentPicker,
  sendModelPicker,
  sendReasoningPicker,
  sendCollaborationModePicker,
  sendProjectPicker,
  currentStatusSnapshot,
  sendStatus,
  formatApprovalMode,
  approvalModeKeyboard,
  restartBot,
  resumeThread,
  renameCurrentTask,
  sendRunMessage,
  bindIncomingTaskMessage,
  telegramPrompt,
  forwardBundles,
  selectedTurnTarget,
  setChatId: (value) => hostState.setChatId(value),
  findReplyBinding: (targetChatId, messageId) => (
    findMessageBinding(config.dataDir, targetChatId, messageId)
  ),
  activateMessageBinding,
  setUpdateOffset: (value) => hostState.setUpdateOffset(value),
  updateOffset: () => hostState.updateOffset,
  setProcessingUpdateId: (value) => hostState.setProcessingUpdateId(value),
  failedUpdateStore,
  restartReady: () => Boolean(hostState.restartRequest && !hostState.restartRequest.waitingForRuns && !hostState.stopping),
  performRestart,
});

function saveState() {
  rememberCodexTaskSettings();
  selectionStore.rememberCurrentThread();
  return runtimeStateCoordinator.save();
}

function savePinnedTaskTitles() {
  return writeTextAtomic(
    PINNED_TASK_TITLES_FILE,
    `${JSON.stringify(taskMetadata.pinnedTitlesSnapshot(), null, 2)}\n`,
  );
}

const agentHubBootstrapComposition = createAgentHubBootstrapComposition({
  config,
  runtimeCommandRoot,
  handleDesktopControl,
  runtimeCommandServer,
  stopRuntimeTimers,
  taskRuns,
  agentProviders,
  mediaController,
  runtimeResources,
  miniAppLifecycle,
  sanitizeRollouts: () => codexContextMaintenance.runPeriodic({ reschedule: false }),
  initializeProvider,
  providerIsRunning: () => codexTransport.running,
  backfillProviderMetadata: () => codexProviderTasks.discoverTasks()
    .then((threads) => backfillWorkLogPricingMetadata(threads)),
  recoverRuns: (...args) => runRecovery.recoverAll(...args),
  retryNotifications: retryPendingTurnEndNotifications,
  restoreBackgroundJobs: () => backgroundJobs.restore(),
  startRuntimeTimers,
  registerTelegramCommands: () => telegram("setMyCommands", { commands: BOT_COMMANDS }),
  hasPendingRestart: () => Boolean(hostState.restartRequest),
  finalizeRestart: finalizeRestartMessage,
  markReady: () => instanceGuard.markReady(),
  readyMessage: () => (
    `Agent Hub ready; components: ${Object.entries(config.components).filter(([, enabled]) => enabled).map(([name]) => name).join(", ") || "core"}; provider: ${providerTitle()}; project: ${selectedProjectRoot()}`
  ),
  pollTelegram,
  warnUser: (message) => sendMessage(message).catch(() => {}),
  beginStopping: () => {
    return hostState.beginStopping();
  },
});
bootstrapPort.bind(agentHubBootstrapComposition);
const { startAgentHub, shutdownAgentHub } = agentHubBootstrapComposition;

export { startAgentHub, shutdownAgentHub };
