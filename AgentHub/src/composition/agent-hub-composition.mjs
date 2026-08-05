import { readFile, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import dns from "node:dns";
import path from "node:path";
import process from "node:process";
import {
  canonicalizeProjectRoots,
  findContainingProject,
  AGENT_HUB_ROOT,
  loadConfig,
  pathInsideOrSame,
  samePath,
} from "../infrastructure/filesystem/config.mjs";
import { parseClaudeLimits } from "../providers/claude/claude.mjs";
import {
  claudeResultEstimatedCredits,
  claudeResultTokenUsage,
  scanClaudeHistoricalTranscriptFile,
} from "../providers/claude/claude-work-log.mjs";
import { cleanupOrphanedClaudeRunOutputs, processIsAlive, stopProcessTree } from "../providers/claude/claude-run-io.mjs";
import { ClaudeRunController } from "../providers/claude/claude-run-controller.mjs";
import { ClaudeTurnLauncher } from "../providers/claude/claude-turn-launcher.mjs";
import {
  CODEX_COLLABORATION_MODE_LABELS,
  CODEX_COLLABORATION_MODES,
  CODEX_REASONING_EFFORTS,
  CODEX_REASONING_LABELS,
  resolveCodexThreadSettings,
} from "../providers/codex/codex-settings.mjs";
import {
  codexThreadSandboxSettings,
} from "../providers/codex/codex-sandbox.mjs";
import * as telegramStatus from "../interfaces/telegram/status.mjs";
const {
  formatArchiveMessage, formatClaudeRateLimits, formatCodexRateLimits, formatProgressHeading,
  formatRestartCompleteMessage, formatTaskAlreadySelectedMessage, formatTaskSwitchMessage,
  showLastMessageReplyMarkup,
} = telegramStatus;
import {
  findCodexRolloutPath,
  readCodexTurnUsage,
  scanCodexTurnPricingMetadata,
} from "../providers/codex/codex-turn-usage.mjs";
import { CodexRunFinalizer } from "../providers/codex/codex-run-finalizer.mjs";
import { CodexContextMaintenanceService } from "../providers/codex/codex-context-maintenance-service.mjs";
import { emptyTokenUsage } from "../domain/token-usage.mjs";
import { telegramPrompt } from "../interfaces/telegram/telegram-message.mjs";
import {
  forwardBundleAttachmentPaths,
  restoreForwardBundle,
} from "../interfaces/telegram/telegram-forward-bundle.mjs";
import {
  captureTaskGitBaseline,
  cleanupTaskGitIndexes,
  resolveTaskGitRepoRoots,
  taskGitDiff,
} from "../infrastructure/filesystem/task-git-diff.mjs";
import { TaskDiffStore } from "../infrastructure/persistence/task-diff-store.mjs";
import { findRepositoryWriteConflict } from "../infrastructure/filesystem/repository-conflict.mjs";
import {
  deferredInputMatchesRun,
  deferredEditableText,
  deferredResponseAnnotations,
  pendingInputKeyboard,
  replaceDeferredInputText,
  restoreDeferredInput,
} from "../domain/deferred-input.mjs";
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
  serializableTaskRun,
  TaskDismissalRegistry,
  TaskRunRegistry,
  taskRunIsActive,
  taskRunKey,
  updateTaskRunTitle,
} from "../domain/task-runs.mjs";
import { readClaudeSessionSnapshot } from "../../last-message.mjs";
import {
  mergeActiveTaskHistory,
  mergeCompletedTaskHistory,
} from "../application/task-history.mjs";
import * as approvalProtocol from "../providers/codex/codex-approvals.mjs";
const { formatPermissionsApproval, parseApprovalCallback } = approvalProtocol;
import { contextualCallback } from "../interfaces/telegram/callback-context.mjs";
import { taskViewCallbackData } from "../interfaces/telegram/task-view-callback.mjs";
import { PersistentDeliveryOutbox } from "../infrastructure/persistence/delivery-outbox.mjs";
import { writeTextAtomic } from "../infrastructure/persistence/state-store.mjs";
import { taskHasUnreadAnswer } from "../infrastructure/persistence/task-read-state-store.mjs";
import { LocalTaskSyncStore } from "../infrastructure/persistence/task-sync-store.mjs";
import { MessageReceiptRegistry } from "../infrastructure/persistence/message-receipts.mjs";
import { createDesktopMessageController } from "../interfaces/desktop/desktop-message-controller.mjs";
import { createTrustedDeviceManager, resolveTrustedDeviceUserId } from "../interfaces/web/trusted-device-access.mjs";
import { unavailableLocalMcpOverrides } from "../infrastructure/process/local-mcp-preflight.mjs";
import { captureProcess } from "../infrastructure/process/process-capture.mjs";
import { BackgroundJobQueue } from "../runtime/background-job-queue.mjs";
import { PersistentBackgroundJobController } from "../runtime/background-job-controller.mjs";
import { PersistentBackgroundJobStore } from "../infrastructure/persistence/background-job-store.mjs";
import { FailedTelegramUpdateStore } from "../infrastructure/persistence/failed-update-store.mjs";
import { resolveClaudeInvocation as resolveInstalledClaudeInvocation } from "../providers/claude/claude-invocation.mjs";
import {
  catalogEntryIsSelected,
  mergeTaskCatalog,
  readCodexRolloutActivity,
  statusTaskEntries,
  TASK_EXECUTION_OWNERS,
  taskExecutionRuntimeLabel,
  normalizeTaskExecutionOwner,
  taskOrderingActivityAtMs,
  taskCatalogTitleSignature,
} from "../../task-catalog.mjs";
import {
  codexObservedRuntimeActive,
  resolveCodexTaskActivity,
  resolveCodexObservedExecutionOwner,
} from "../providers/codex/codex-runtime-owner.mjs";
import {
  botReplacementInvocation,
  directWindowsLauncherInvocation,
  launchReplacementAndWait,
} from "../runtime/runtime-restart.mjs";
import {
  finalizeSuccessfulReplacement,
  restorePreviousBotAfterFailedReplacement,
} from "../runtime/restart-recovery.mjs";
import { CodexLifecycleController } from "../providers/codex/codex-lifecycle-controller.mjs";
import { conciseTurnTitle } from "../application/turn-title.mjs";
import { DesktopControlServer } from "../../desktop-control.mjs";
import { defaultRuntimeRoot } from "../infrastructure/filesystem/runtime-layout.mjs";
import { TelegramTaskPickerService } from "../interfaces/telegram/task-picker.mjs";
import { RestartNotificationService } from "../interfaces/telegram/restart-notification-service.mjs";
import { TelegramTaskActionService } from "../interfaces/telegram/telegram-task-action-service.mjs";
import {
  approvalModeKeyboard as presentApprovalModeKeyboard,
  formatApprovalMode as presentApprovalMode,
  formatCommandApproval as presentCommandApproval,
  formatFileApproval as presentFileApproval,
} from "../interfaces/telegram/approval-presentation.mjs";
import { TaskViewController } from "../interfaces/telegram/task-view-controller.mjs";
import { TelegramDeliveryService } from "../interfaces/telegram/telegram-delivery-service.mjs";
import { resolveCodexExecutable as resolveInstalledCodexExecutable } from "../providers/codex/codex-invocation.mjs";
import { CodexAppServerLifecycle } from "../providers/codex/codex-app-server-lifecycle.mjs";
import { TaskProgressController } from "../interfaces/telegram/task-progress-controller.mjs";
import { TaskObservationService } from "../application/task-observation-service.mjs";
import { SelectedTaskWatchService } from "../application/selected-task-watch-service.mjs";
import {
  DeferredInputController,
  isRetryableDeferredLaunchError,
} from "../application/deferred-input-controller.mjs";
import { ensureLocalWebSecret } from "../interfaces/web/local-web-auth.mjs";
import { fitTaskHistoryPayload } from "../domain/response-budget.mjs";
import { RuntimeResourceRegistry } from "../runtime/runtime-resource-registry.mjs";
import { RuntimeRestartController } from "../runtime/runtime-restart-controller.mjs";
import { RunCoordinator } from "../application/run-coordinator.mjs";
import {
  commandClientContext,
  commandTaskTarget,
  createApplicationCommandService,
} from "../application/application-command-service.mjs";
import { DesktopDeferredInputService } from "../interfaces/desktop/desktop-deferred-input-service.mjs";
import { DesktopSettingsService } from "../interfaces/desktop/desktop-settings-service.mjs";
import { createDesktopSnapshotFactory } from "../interfaces/desktop/desktop-snapshot.mjs";
import { createDesktopTaskHistoryFactory } from "../interfaces/desktop/desktop-task-history.mjs";
import { DesktopTaskService } from "../interfaces/desktop/desktop-task-service.mjs";
import { DesktopSystemService } from "../interfaces/desktop/desktop-system-service.mjs";
import { DesktopReadModelService } from "../interfaces/desktop/desktop-read-model-service.mjs";
import { TaskCommandService } from "../application/task-command-service.mjs";
import { TaskNavigationService } from "../application/task-navigation-service.mjs";
import { RestartRequestService } from "../application/restart-request-service.mjs";
import { createDesktopApplicationRouter } from "../interfaces/desktop/desktop-application-router.mjs";
import { agentHubAutostartShortcut } from "../interfaces/web/server-page.mjs";
import {
  defaultAutostartInstallScript,
  ServerControlController,
} from "../interfaces/web/server-control-controller.mjs";
import { RunProgressPresentation } from "../application/run-progress-presentation.mjs";
import { RuntimeTimerCoordinator } from "../runtime/runtime-timer-coordinator.mjs";
import {
  TurnEndDeliveryService,
} from "../application/turn-end-delivery-service.mjs";
import { DeferredInputStore } from "../application/deferred-input-store.mjs";
import { DeferredInputService } from "../application/deferred-input-service.mjs";
import {
  ManagedRunLifecycleService,
  runInputPreview,
} from "../application/managed-run-lifecycle-service.mjs";
import { RunRecoveryCoordinator } from "../application/run-recovery-coordinator.mjs";
import { RunConflictPolicy } from "../application/run-conflict-policy.mjs";
import {
  createHubRuntimeSnapshot,
  HubRuntimeStateCoordinator,
  restoreHubRuntimeSnapshot,
} from "../application/hub-runtime-state-coordinator.mjs";
import { TaskIdentityResolver } from "../application/task-identity-resolver.mjs";
import { createHubStaticSettings } from "./hub-static-settings.mjs";
import { createCodexObservabilityComposition } from "./codex-observability-composition.mjs";
import { createClientInterfaceComposition } from "./client-interface-composition.mjs";
import { createHubInfrastructure } from "./infrastructure-composition.mjs";
import { createProviderSnapshotComposition } from "./provider-snapshot-composition.mjs";
import { createProviderOperationComposition } from "./provider-operation-composition.mjs";
import { createProviderCatalogComposition } from "./provider-catalog-composition.mjs";
import { createRuntimeLifecycleComposition } from "./runtime-lifecycle-composition.mjs";
import { createStateComposition } from "./state-composition.mjs";
import { createTelegramControllerComposition } from "./telegram-controller-composition.mjs";

if (process.platform === "win32") dns.setDefaultResultOrder("ipv4first");

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
  findProject,
  authorizeRuntimeCommand,
  reconcileRuntimeCommand,
  handleRuntimeCommand,
  stopProcessTree,
});
let activeProvider = config.provider === "codex" ? "codex" : "claude";
function isCodex() {
  return activeProvider === "codex";
}
function providerTitle() {
  return isCodex() ? "Codex" : "Claude Code";
}
const token = config.token;
let desktopControlServer = null;

let updateOffset = 0;
let chatId = null;
let activeProjectRoot = DEFAULT_PROJECT_ROOT;
let threadId = null;
let activeThreadTitle = "";
const { taskMetadata, selectionStore, agentPreferences } = createStateComposition({
  config,
  initialProvider: activeProvider,
  initialProjectRoot: activeProjectRoot,
  codexModels: CODEX_MODELS,
  claudeModels: CLAUDE_MODELS,
  defaultCodexModel,
  defaultCodexReasoningEffort,
  normalizeCodexModel,
  onSelection: (selection) => {
    activeProvider = selection.activeProvider;
    activeProjectRoot = selection.activeProjectRoot;
    threadId = selection.threadId;
    activeThreadTitle = selection.activeThreadTitle;
  },
});
let latestDiff = "";
let stopping = false;
let autoApprove = config.autoApproveOnStart;
let restartRequest = null;
let processingUpdateId = null;
let telegramDeliveryService = null;
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
const taskRuns = new TaskRunRegistry();
const lastSeenTaskTurnIds = new Map();
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
  isHistoricalBackfillIdle: () => taskRuns.size === 0 && !restartRequest,
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
const turnTemporaryFiles = new Map();
const turnSpeechButtons = new Map();
const managedRunLifecycle = new ManagedRunLifecycleService({
  taskRuns,
  currentTarget: () => ({
    provider: activeProvider,
    projectRoot: activeProjectRoot,
    threadId,
    taskTitle: activeThreadTitle,
    chatId,
  }),
  findProject,
  codexSettings: (target) => taskMetadata.codexSettings(target),
  currentPreferences: (provider) => ({
    ...agentPreferences.current(provider),
    defaultModel: provider === "codex"
      ? agentPreferences.defaultCodexModel
      : agentPreferences.claudeModel,
    defaultReasoningEffort: provider === "codex"
      ? agentPreferences.defaultCodexReasoningEffort
      : agentPreferences.claudeReasoningEffort,
  }),
  modelLabel: codexModelLabel,
  claudeModelLabels: CLAUDE_MODEL_LABELS,
  reasoningLabels: CODEX_REASONING_LABELS,
  clearClaudeCancellation: (key) => cancelledManagedClaudeTasks.delete(key),
  captureGitBaseline: (projectRoot, runId) => (
    captureTaskGitBaseline(projectRoot, config.dataDir, runId)
  ),
  persistTaskDiff,
  syncRun: syncTaskRun,
  invalidateCatalog: invalidateTaskCatalog,
  saveState,
  scheduleProgressStart: (run) => taskProgress.scheduleStart(run, config.progressStartDelayMs),
  clearSelectedDiff: (run) => { if (isSelectedRun(run)) latestDiff = ""; },
  clearApprovals: (run) => {
    for (const [key, approval] of approvalController.pending) {
      if (approval.runId === run.id) approvalController.pending.delete(key);
    }
  },
  pauseObservation: (run) => taskObserver.pause(run),
  pauseClaude: (run) => claudeRunController.pause(run),
  stopTyping: () => stopTyping(),
  afterCompletion: async () => {
    if (restartRequest?.waitingForRuns && !restartHasBlockingWork() && !stopping) {
      setTimeout(() => void performRestart(), 0);
    }
  },
});
const turnEndDelivery = new TurnEndDeliveryService({
  notifications: turnEndNotifications,
  taskRuns,
  projectTurn: (...args) => runJournal.projectTurn(...args),
  rememberLastMessage: (...args) => runJournal.rememberLastMessage(...args),
  rememberSeenTurn: (task, turnId) => {
    setBoundedMapValue(lastSeenTaskTurnIds, taskRunKey(task), turnId, 500);
  },
  saveState,
});
const codexRunFinalizer = new CodexRunFinalizer({
  turnStarts: codexTurnStarts,
  notifications: turnEndNotifications,
  discardManualCompaction: discardManualContextCompactionRun,
  finalizeRunDelivery,
  refreshTaskDiff,
  runTitle: runTaskTitle,
  currentChatId: () => chatId,
  defaultNotificationChatId,
  changedFiles: changedFilesForRun,
  saveState,
  persistHistory: persistManagedRunHistory,
  projectTurn: (...args) => runJournal.projectTurn(...args),
  completeRun: (run) => managedRunLifecycle.complete(run),
});
const codexContextMaintenance = new CodexContextMaintenanceService({
  timers: runtimeTimers,
  compactions: contextCompactions,
  sanitizer: codexRolloutContextSanitizer,
  contextCleanupEnabled: () => config.components.codexContextCleanup,
  periodicCleanupEnabled: () => config.codexRolloutContext.enabled,
  // Temporarily disabled: recycling an App Server immediately after compaction
  // can leave the compaction UI waiting. Periodic sanitation remains enabled.
  compactionTriggeredCleanupEnabled: false,
  scanIntervalMs: () => config.codexRolloutContext.scanIntervalSeconds * 1_000,
  isStopping: () => stopping,
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
  ensureTransport: async () => {
    if (codexTransport.running) return;
    await startCodexAppServer();
    await initializeCodex({ attachSelectedThread: false });
  },
  resumeThread: (targetThreadId, sandbox) => sendRpc("thread/resume", {
    threadId: targetThreadId,
    ...sandbox,
  }),
  startCompaction: (targetThreadId) => sendRpc("thread/compact/start", {
    threadId: targetThreadId,
  }),
  sandboxSettings: () => codexThreadSandboxSettings(config.codexSandboxMode),
});
const backgroundJobStore = new PersistentBackgroundJobStore({
  directoryPath: BACKGROUND_JOBS_DIR,
  maxItems: MAX_BACKGROUND_MEDIA_JOBS + MAX_BACKGROUND_SPEECH_JOBS,
});
const failedUpdateStore = new FailedTelegramUpdateStore({ directoryPath: FAILED_UPDATES_DIR });
await failedUpdateStore.load();
const backgroundJobs = new PersistentBackgroundJobController({
  store: backgroundJobStore,
  maxMediaJobs: MAX_BACKGROUND_MEDIA_JOBS,
  maxSpeechJobs: MAX_BACKGROUND_SPEECH_JOBS,
  isStopping: () => stopping,
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
const interactiveJobs = new BackgroundJobQueue({
  concurrency: 2,
  maxJobs: MAX_INTERACTIVE_JOBS,
});
const dismissedExternalTasks = new TaskDismissalRegistry();
const cancelledManagedClaudeTasks = new Map();
const deferredInputs = new DeferredInputStore();
const pendingInputs = deferredInputs.pending;
const forwardBundles = new Map();
const queuedInputs = deferredInputs.queued;
const desktopMessageReceipts = new MessageReceiptRegistry();
const taskDiffs = new TaskDiffStore({ filePath: TASK_DIFFS_FILE, limit: 100 });
await taskDiffs.load();
const statusMediaFileIds = new Map();
let synchronizedTaskTitleSignature = "";
let taskTitlesSynchronizedAt = 0;
let workLogPricingBackfillAttempted = false;
const claudeTranscriptAuditState = new Map();
const taskSyncStore = new LocalTaskSyncStore({
  filePath: TASK_SYNC_FILE,
  databaseFile: path.join(config.dataDir, "journal.sqlite"),
  canonicalizeProjectRoot: (projectRoot) => findProject(projectRoot)?.path ?? projectRoot,
  canonicalizeValue: (value) => canonicalizeProjectRoots(value, PROJECTS),
});
await taskSyncStore.load();
await taskSyncStore.save();
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
  activeProjectRoot: () => activeProjectRoot,
  codexSandboxMode: () => config.codexSandboxMode,
  invalidateTaskCatalog,
  restoreCodexTaskSettings,
  updateActiveCodexThreadSettings,
  clearLatestDiff: () => { latestDiff = ""; },
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
  autoApprove: () => autoApprove,
  restartRequested: () => Boolean(restartRequest),
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
  setLatestDiff: (value) => { latestDiff = value; },
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
  currentChatId: () => chatId,
  currentProvider: () => activeProvider,
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
  isStopping: () => stopping,
  findProject,
  refreshTaskCatalog,
  currentTaskCatalog: () => taskCatalog,
  currentTaskRuns: () => taskRuns.values(),
  codexModelLabel,
  agentHubRoot: AGENT_HUB_ROOT,
  stopProcessTree,
  startTurn,
  activeProjectRoot: () => activeProjectRoot,
  approvalProtocol,
  autoApprove: () => autoApprove,
  respondRpc,
  sendRunMessage,
  runExists: (id) => taskRuns.values().some((run) => run.id === id),
  taskProgress: () => taskProgress,
});

function invalidateTaskCatalog() {
  taskCatalogService.invalidate();
}

function syncTaskRun(run, {
  active = run?.status === "running",
  stage = run?.progressStage,
  answer = run?.responseText,
  activityAtMs = Date.parse(run?.lastMeaningfulProgressAt ?? run?.startedAt ?? "") || Date.now(),
} = {}) {
  if (!run?.provider || !run?.threadId) return;
  const changed = taskSyncStore.recordSnapshot(run, {
    active,
    turnId: run.turnId,
    model: run.model,
    activityAtMs,
    stage,
    answer,
    executionOwner: run.executionOwner,
  }, {
    executionOwner: run.executionOwner,
  });
  if (changed) {
    void taskSyncStore.save().catch((error) => {
      console.error("Cannot save local task sync:", error.message);
    });
  }
}
const deliveryOutbox = new PersistentDeliveryOutbox({
  directoryPath: DELIVERY_OUTBOX_DIR,
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
await deliveryOutbox.load();

const taskIdentity = new TaskIdentityResolver({
  selectionStore,
  projects: PROJECTS,
  findContainingProject,
  catalogEntries: taskCatalog,
  catalogEntryIsSelected,
  taskRuns,
  taskMetadata,
  preferences: agentPreferences,
  currentChatId: () => chatId,
  contextualCallback,
  samePath,
});
function findProject(...args) { return taskIdentity.findProject(...args); }
function activeProject(...args) { return taskIdentity.activeProject(...args); }
function selectedTask(...args) { return taskIdentity.selectedTask(...args); }
function selectedTurnTarget(...args) { return taskIdentity.selectedTurnTarget(...args); }
function currentUiContextToken(...args) { return taskIdentity.currentUiContextToken(...args); }
function uiCallback(...args) { return taskIdentity.uiCallback(...args); }
function selectedRun(...args) { return taskIdentity.selectedRun(...args); }
function isSelectedRun(...args) { return taskIdentity.isSelectedRun(...args); }
function runProject(...args) { return taskIdentity.runProject(...args); }
function runTaskTitle(...args) { return taskIdentity.runTaskTitle(...args); }
function pinnedTaskTitle(...args) { return taskIdentity.pinnedTaskTitle(...args); }
function pinTaskTitle(...args) { return taskIdentity.pinTaskTitle(...args); }
function pendingTaskTitle(...args) { return taskIdentity.pendingTaskTitle(...args); }
function expectTaskTitleConfirmation(...args) {
  return taskIdentity.expectTaskTitleConfirmation(...args);
}

function setBoundedMapValue(map, key, value, limit) {
  if (map.has(key)) map.delete(key);
  map.set(key, value);
  while (map.size > limit) map.delete(map.keys().next().value);
}

async function persistTaskDiff(key, value) {
  taskDiffs.remember(key, value);
  try {
    await taskDiffs.set(key, value);
  } catch (error) {
    console.error("Cannot persist task diff:", error.message);
  }
}

function runMessageBinding(...args) { return telegramDeliveryService.runMessageBinding(...args); }
function bindRunMessage(...args) { return telegramDeliveryService.bindRunMessage(...args); }
function sendRunMessage(...args) { return telegramDeliveryService.sendRunMessage(...args); }
function bindIncomingTaskMessage(...args) {
  return telegramDeliveryService.bindIncomingTaskMessage(...args);
}
function deleteTaskTelegramMessages(...args) {
  return telegramDeliveryService.deleteTaskMessages(...args);
}

function sendTaskViewText(...args) { return telegramDeliveryService.sendTaskViewText(...args); }
function progressOutboxKey(...args) { return telegramDeliveryService.progressOutboxKey(...args); }
function sendReliableRunMessage(...args) {
  return telegramDeliveryService.sendReliableRunMessage(...args);
}
function sendRunLongMessage(...args) { return telegramDeliveryService.sendRunLongMessage(...args); }

function clearDeliveredProgressMessages(...args) {
  return telegramDeliveryService.clearDeliveredProgressMessages(...args);
}
function safelyDeliverRunMessage(...args) {
  return telegramDeliveryService.safelyDeliverRunMessage(...args);
}
function finalizeRunDelivery(...args) { return telegramDeliveryService.finalizeRunDelivery(...args); }
function sendTaskSelectionNotification(options = {}) {
  return telegramDeliveryService.sendTaskSelectionNotification({ targetChatId: chatId, ...options });
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

function applyCodexRolloutContext(run, usageResult) {
  if (!run || !usageResult) return;
  if (usageResult.startedAt) run.startedAt = usageResult.startedAt;
  if (usageResult.model) run.modelId = usageResult.model;
  if (usageResult.serviceTier) run.serviceTier = usageResult.serviceTier;
  if (usageResult.prompt) run.promptPreview = String(usageResult.prompt);
  if (usageResult.toolMetricsKnown === true) {
    run.skillsUsed = [...new Set(usageResult.skillsUsed ?? [])];
    run.mcpCalls = Array.isArray(usageResult.mcpCalls) ? usageResult.mcpCalls : [];
    run.toolMetricsKnown = true;
  }
  const changedFiles = [];
  for (const file of Array.isArray(usageResult.changedFiles) ? usageResult.changedFiles : []) {
    const absolute = path.isAbsolute(file) ? path.resolve(file) : path.resolve(run.projectRoot, file);
    const relative = path.relative(run.projectRoot, absolute);
    if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) continue;
    changedFiles.push(relative.replaceAll(path.sep, "/"));
  }
  if (changedFiles.length) run.rolloutChangedFiles = [...new Set(changedFiles)];
}

function changedFilesForRun(run) {
  const diff = String(run?.latestDiff ?? "");
  const repoRoot = String(
    run?.gitBaseline?.projectRoot ?? run?.gitBaseline?.repoRoot ?? "",
  ).trim();
  if (!diff || !repoRoot) return [];
  const files = new Set(Array.isArray(run?.rolloutChangedFiles) ? run.rolloutChangedFiles : []);
  for (const match of diff.matchAll(/^(?:\+\+\+|---) (.+)$/gm)) {
    const token = match[1].trim();
    let gitPath = token;
    if (token.startsWith('"')) {
      try {
        gitPath = JSON.parse(token);
      } catch {
        continue;
      }
    }
    if (!gitPath || gitPath === "/dev/null" || !/^[ab]\//u.test(gitPath)) continue;
    const absolute = path.resolve(repoRoot, gitPath.slice(2).replaceAll("/", path.sep));
    const relative = path.relative(run.projectRoot, absolute);
    if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) continue;
    files.add(relative.replaceAll(path.sep, "/"));
  }
  return [...files].sort((left, right) => left.localeCompare(right));
}

async function projectTurnUsageToWorkLog(completion, { title = "", body = "" } = {}) {
  return runJournal.projectTurn(completion, { title, body });
}

async function projectClaudeRunToWorkLog(run, {
  answer,
  status = "completed",
  result = null,
  snapshot = null,
} = {}) {
  if (!run?.threadId) return null;
  await refreshTaskDiff(run);
  let transcriptTurn = null;
  let transcriptPath = String(snapshot?.transcriptPath ?? "").trim();
  if (!transcriptPath) {
    const current = await readClaudeSessionSnapshot(run.threadId).catch(() => null);
    transcriptPath = String(current?.transcriptPath ?? "").trim();
  }
  if (transcriptPath) {
    const scan = await scanClaudeHistoricalTranscriptFile(transcriptPath).catch((error) => {
      console.error(`Cannot read Claude transcript for journal ${run.threadId}:`, error.message);
      return null;
    });
    transcriptTurn = scan?.turns?.at(-1) ?? null;
  }
  const resultUsage = claudeResultTokenUsage(result);
  const usage = transcriptTurn?.usageReported ? transcriptTurn.usage : resultUsage.usage;
  const usageReported = transcriptTurn?.usageReported === true || resultUsage.reported === true;
  const modelUsage = result?.modelUsage ?? result?.model_usage;
  const resultModels = modelUsage && typeof modelUsage === "object" && !Array.isArray(modelUsage)
    ? Object.keys(modelUsage).map((value) => String(value).trim().toLowerCase()).filter(Boolean)
    : [];
  const completedAt = transcriptTurn?.completedAt || new Date().toISOString();
  return projectTurnUsageToWorkLog({
    provider: "claude",
    threadId: run.threadId,
    turnId: transcriptTurn?.turnId || run.turnId || randomUUID(),
    projectRoot: run.projectRoot,
    taskTitle: runTaskTitle(run),
    status,
    usage,
    usageReported,
    estimatedCredits: claudeResultEstimatedCredits(result),
    estimateKind: result ? "claude-cli-total-cost-usd" : "",
    model: transcriptTurn?.model || resultModels.join(",") || run.modelId || "",
    serviceTier: transcriptTurn?.serviceTier || "default",
    startedAt: transcriptTurn?.startedAt || run.startedAt,
    completedAt,
    prompt: transcriptTurn?.prompt || run.promptPreview,
    changedFiles: changedFilesForRun(run),
    diff: run.latestDiff ?? "",
    skillsUsed: transcriptTurn?.skillsUsed ?? [],
    mcpCalls: transcriptTurn?.mcpCalls ?? [],
    toolMetricsKnown: transcriptTurn?.toolMetricsKnown === true,
    message: null,
  }, {
    title: conciseTurnTitle(answer, status),
    body: answer,
  });
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

function codexThreadResponseTitle(thread) {
  return String(thread?.name ?? thread?.preview ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

async function storedCodexThreadTitle(id, fallback = "") {
  const pinnedTitle = pinnedTaskTitle("codex", id);
  if (pinnedTitle) return pinnedTitle;
  const titleHistory = await readCodexThreadTitleHistory(id);
  return titleHistory.recoverableTitle
    || titleHistory.currentTitle
    || fallback
    || `Codex · ${id.slice(0, 8)}`;
}

async function resolveResumedCodexThreadTitle(id, thread) {
  const resumedTitle = codexThreadResponseTitle(thread);
  const pinnedTitle = pinnedTaskTitle("codex", id);
  if (pinnedTitle) {
    if (resumedTitle !== pinnedTitle) {
      await sendRpc("thread/name/set", { threadId: id, name: pinnedTitle });
    }
    return pinnedTitle;
  }
  const titleHistory = await readCodexThreadTitleHistory(id);
  const recoveredTitle = titleHistory.recoverableTitle
    && (!resumedTitle || resumedTitle === titleHistory.currentTitle)
    ? titleHistory.recoverableTitle
    : "";
  if (recoveredTitle) {
    await sendRpc("thread/name/set", { threadId: id, name: recoveredTitle });
  }
  return resumedTitle && !recoveredTitle
    ? resumedTitle
    : recoveredTitle
      || titleHistory.currentTitle
      || `Codex · ${id.slice(0, 8)}`;
}

async function updateActiveCodexThreadSettings() {
  if (!isCodex() || !threadId) return;
  if (contextCompactions.isRunning(threadId)) {
    throw new Error("Дождитесь завершения свёртки контекста перед сменой модели или Reasoning");
  }
  rememberCodexTaskSettings();
  await sendRpc("thread/settings/update", {
    threadId,
    model: agentPreferences.codexModel,
    effort: agentPreferences.codexReasoningEffort,
  });
  await saveState();
}

function taskSwitchSettings() {
  if (!isCodex()) return {};
  return {
    model: codexModelLabel(agentPreferences.codexModel),
    reasoning: CODEX_REASONING_LABELS[agentPreferences.codexReasoningEffort],
  };
}

function restorePersistedTaskRun(savedRun, restoredChatId) {
  if (!savedRun || typeof savedRun !== "object"
    || !["running", "finishing"].includes(savedRun.status)) return null;
  const observer = savedRun.observer === true;
  const executionOwner = normalizeTaskExecutionOwner(savedRun.executionOwner)
    ?? (savedRun.provider === "codex"
      ? observer
        ? TASK_EXECUTION_OWNERS.EXTERNAL
        : TASK_EXECUTION_OWNERS.HUB
      : null);
  return {
    ...savedRun,
    observer,
    executionOwner,
    appServer: savedRun.provider === "codex"
      ? taskExecutionRuntimeLabel(executionOwner)
      : savedRun.appServer,
    status: "running",
    chatId: Number.isSafeInteger(savedRun.chatId) ? savedRun.chatId : restoredChatId,
    responseText: String(savedRun.responseText ?? ""),
    observedInitialResponseText: typeof savedRun.observedInitialResponseText === "string"
      ? savedRun.observedInitialResponseText
      : String(savedRun.responseText ?? ""),
    observedResponseChanged: savedRun.observedResponseChanged === true,
    progressStage: String(savedRun.progressStage ?? "Восстановление задачи…"),
    progressReasoning: String(savedRun.progressReasoning ?? ""),
    lastMeaningfulProgressAt: String(
      savedRun.lastMeaningfulProgressAt
        ?? savedRun.progressHeartbeatAt
        ?? savedRun.startedAt
        ?? new Date().toISOString(),
    ),
    lastProgressText: String(savedRun.lastProgressText ?? ""),
    progressMessageIds: Array.isArray(savedRun.progressMessageIds)
      ? savedRun.progressMessageIds.filter(Number.isSafeInteger)
      : Number.isSafeInteger(savedRun.progressMessageId)
        ? [savedRun.progressMessageId]
        : [],
    progressStartTimer: null,
    progressTimer: null,
    progressUpdateInFlight: false,
    progressUpdatePending: false,
    process: null,
  };
}

const deferredInputTtlMs = config.deferredInputTtlHours * 60 * 60 * 1000;
const runtimeStateCoordinator = new HubRuntimeStateCoordinator({
  store: runtimeStateStore,
  canonicalize: (value) => canonicalizeProjectRoots(value, PROJECTS),
  restoreSnapshot: (saved) => restoreHubRuntimeSnapshot(saved, {
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
    restoreDeferredInput,
    deferredInputOptions: {
      guardConcurrentRepositoryWrites: config.guardConcurrentRepositoryWrites,
      persistentFile: isLegacyDesktopAttachmentFile,
    },
    isRetryableDeferredLaunchError,
    desktopMessageReceipts,
    updateDeferredDesktopReceipt,
    forwardBundles,
    restoreForwardBundle,
    forwardBundleAttachmentPaths,
    removeFiles: (files) => Promise.all(files.map((file) => unlink(file).catch(() => {}))),
    deferredInputTtlMs,
    maximumDeferredInputs: MAX_DEFERRED_INPUTS,
    taskRuns,
    restoreTaskRun: restorePersistedTaskRun,
  }),
  createSnapshot: () => createHubRuntimeSnapshot({
    chatId,
    selectionStore,
    taskMetadata,
    preferences: agentPreferences,
    updateOffset,
    taskRuns,
    serializableTaskRun,
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
    codexHookReceipts,
    codexTerminalAudit,
    turnEndNotifications,
    statusMediaFileIds,
    restartRequest,
  }),
});
const restoredRuntimeState = await runtimeStateCoordinator.restore();
const stateLoadFailed = restoredRuntimeState.failed;
let restoredTurnEndSnapshot = {};
if (restoredRuntimeState.value) {
  chatId = restoredRuntimeState.value.chatId;
  updateOffset = restoredRuntimeState.value.updateOffset;
  restartRequest = restoredRuntimeState.value.restartRequest;
  replaceCodexHookReceipts(restoredRuntimeState.value.codexHookReceipts);
  restoredTurnEndSnapshot = restoredRuntimeState.value.restoredTurnEndSnapshot;
  if (activeProvider === "codex" && threadId) {
    if (taskMetadata.codexSettings(threadId)) restoreCodexTaskSettings(threadId);
    else rememberCodexTaskSettings(threadId);
  }
}
workLogUsageStore.setIncludeClaudeUsage(agentPreferences.includeClaudeUsage);

async function initializeJournalProjection() {
  return runJournal.initialize(restoredTurnEndSnapshot);
}

// Journal repair is serialized by WorkLogUsageStore, but it is not a startup
// prerequisite for control pipes or Telegram polling. Keeping it in the
// background prevents a stale interprocess lock from making the whole Hub look
// dead during a replacement hand-off.
const journalStartupReady = initializeJournalProjection().catch((error) => {
  console.error("Cannot initialize journal projection:", error.message);
});

try {
  if (stateLoadFailed) {
    console.warn("Skipping Claude run cleanup because runtime state could not be recovered.");
  } else {
    const activeClaudeRunPaths = taskRuns.values()
      .filter((run) => run.provider === "claude" && !run.observer)
      .flatMap((run) => [run.claudeOutputPath, run.claudeErrorPath])
      .filter(Boolean);
    const removed = await cleanupOrphanedClaudeRunOutputs(config.dataDir, activeClaudeRunPaths);
    if (removed.length) console.log(`Removed ${removed.length} orphaned Claude run file(s).`);
  }
} catch (error) {
  console.warn("Cannot clean orphaned Claude run files:", error.message);
}

try {
  const removed = await cleanupTaskGitIndexes(config.dataDir);
  if (removed) console.log(`Removed ${removed} orphaned task diff index(es).`);
} catch (error) {
  console.warn("Cannot clean orphaned task diff indexes:", error.message);
}

try {
  const savedPinnedTitles = JSON.parse(await readFile(PINNED_TASK_TITLES_FILE, "utf8"));
  taskMetadata.restorePinnedTitles(savedPinnedTitles);
} catch (error) {
  if (error?.code !== "ENOENT") console.error("Cannot read pinned task titles:", error.message);
}

const codexRuntime = new CodexAppServerLifecycle({
  resolveExecutable: () => resolveInstalledCodexExecutable({ requested: config.codexExecutable }),
  unavailableMcpOverrides: unavailableLocalMcpOverrides,
  executableArgs: config.codexExecutableArgs,
  projectRoot: () => activeProjectRoot,
  stopProcessTree,
  onMessage: handleCodexMessage,
  rpcTimeoutMs: CODEX_RPC_TIMEOUT_MS,
  isStopping: () => stopping,
  providerSelected: isCodex,
  activeRuns: () => taskRuns.values(),
  setStage: (run, stage) => taskProgress.setStage(run, stage),
  recoverRuns: () => runRecovery.recoverAll({ provider: "codex" }),
  startTyping,
  attachSelectedThread: attachCodexThread,
  scheduleRetry: (operation, delayMs) => setTimeout(() => void operation(), delayMs),
  logger: console,
});
const codexTransport = codexRuntime.transport;
const codexLifecycleController = new CodexLifecycleController({
  config,
  ensureCodexTransport: async () => {
    if (!codexTransport.running) {
      await startCodexAppServer();
      await initializeCodex({ attachSelectedThread: false });
    }
  },
  readCodexThread,
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
});

async function startCodexAppServer() {
  await codexRuntime.start();
}

async function stopCodexAppServerTree() {
  await codexRuntime.stop();
}

async function restartCodexAfterCrash() {
  return codexRuntime.restartAfterCrash();
}

function sendRpc(method, params = {}, { timeoutMs = CODEX_RPC_TIMEOUT_MS } = {}) {
  return codexTransport.request(method, params, { timeoutMs });
}

function invalidateCodexThreadRead(threadId) {
  codexTransport.invalidateThreadRead(threadId);
}

function readCodexThread(threadId, options = {}) {
  return codexTransport.readThread(threadId, options);
}

function sendNotification(method, params = {}) {
  codexTransport.notify(method, params);
}

function respondRpc(id, result) {
  codexTransport.respond(id, result);
}

async function initializeProvider() {
  if (!config.telegramEnabled) {
    await startCodexAppServer();
    await initializeCodex({ attachSelectedThread: false });
    return;
  }
  if (!isCodex()) {
    await startCodexAppServer();
    await initializeCodex({ attachSelectedThread: false });
    if (!threadId) await createThread();
    return;
  }
  await startCodexAppServer();
  // A saved selected task is only UI state at this point. Loading it here can
  // make startup wait for the complete (and sometimes very large) thread
  // before the local Desktop control pipe exists, so it is resumed lazily.
  // A fresh Telegram Hub has no task to resume, however: create one before
  // accepting updates so a first plain message always has a durable target.
  await initializeCodex({ attachSelectedThread: false });
  if (!threadId) await createThread();
}

async function initializeCodex({ attachSelectedThread = true } = {}) {
  return codexRuntime.initialize({ attachSelectedThread });
}

async function attachCodexThread() {
  if (threadId) {
    const savedThreadId = threadId;
    try {
      const result = await sendRpc("thread/resume", {
        threadId,
        ...codexThreadSandboxSettings(config.codexSandboxMode),
      });
      if (!isWorkspaceThread(result.thread ?? {})) {
        throw new Error("saved thread belongs to another project");
      }
      selectionStore.setTitle(await resolveResumedCodexThreadTitle(threadId, result.thread));
      applyCodexThreadSettings(threadId, result);
      await saveState();
      return true;
    } catch (error) {
      console.error("Cannot resume saved thread:", error.message);
      const savedActiveRun = taskRuns.forTask({
        provider: "codex",
        projectRoot: activeProjectRoot,
        threadId: savedThreadId,
      });
      if (savedActiveRun) {
        console.error(`Keeping active task ${savedThreadId}; recovery will inspect its saved turn.`);
        return false;
      }
      selectionStore.setThread(null, { provider: "codex" });
    }
  }
  await createThread();
  return true;
}

async function createThread() {
  return agentProviders.call(activeProvider, "createTask");
}

async function listThreads() {
  if (!isCodex()) {
    return threadId ? [{
      id: threadId,
      cwd: activeProjectRoot,
      name: "Текущая сессия Claude",
      updatedAt: Math.floor(Date.now() / 1000),
    }] : [];
  }
  return (await codexProviderTasks.discoverTasks())
    .filter(isWorkspaceThread)
    .slice(0, THREAD_LIST_LIMIT);
}

function isWorkspaceThread(thread) {
  if (!thread.cwd) return false;
  return pathInsideOrSame(thread.cwd, activeProjectRoot);
}

function threadTitle(thread) {
  const title = thread.name?.trim() || thread.preview?.trim() || "Без названия";
  return title.replace(/\s+/g, " ").slice(0, 60);
}

async function backfillWorkLogPricingMetadata(codexThreads) {
  if (workLogPricingBackfillAttempted) return;
  workLogPricingBackfillAttempted = true;
  try {
    const missing = await workLogUsageStore.missingPricingTurns({ provider: "codex" });
    const missingByThread = new Map();
    for (const item of missing) {
      const values = missingByThread.get(item.threadId) ?? [];
      values.push(item);
      missingByThread.set(item.threadId, values);
    }
    const threadsById = new Map(
      (codexThreads ?? []).map((thread) => [String(thread.id), thread]),
    );
    const resolved = [];
    for (const [missingThreadId, turns] of missingByThread) {
      let rolloutPath = String(threadsById.get(missingThreadId)?.path ?? "").trim();
      if (!rolloutPath) {
        rolloutPath = await findCodexRolloutPath(missingThreadId, turns[0]?.startedAt);
      }
      if (!rolloutPath) continue;
      const metadata = await scanCodexTurnPricingMetadata(
        rolloutPath,
        turns.map((item) => item.turnId),
      );
      for (const item of turns) {
        const pricing = metadata.get(item.turnId);
        if (pricing?.model) resolved.push({ ...item, ...pricing });
      }
    }
    for (const project of config.projects) {
      await workLogUsageStore.synchronizePricingMetadataAndProject({
        items: resolved,
        projectRoot: project.path,
        projectionProjectRoots: globalWorkLogProjectRoots,
      });
    }
    const missingImageEstimates = await workLogUsageStore
      .missingImageGenerationEstimateTurns({ provider: "codex" });
    const imageEstimates = [];
    for (const item of missingImageEstimates) {
      let rolloutPath = String(threadsById.get(item.threadId)?.path ?? "").trim();
      if (!rolloutPath) {
        rolloutPath = await findCodexRolloutPath(item.threadId, item.startedAt);
      }
      if (!rolloutPath) continue;
      const usage = await readCodexTurnUsage(rolloutPath, item.turnId);
      if (Number(usage?.estimatedCredits) > 0) {
        imageEstimates.push({
          ...item,
          estimatedCredits: usage.estimatedCredits,
          estimateKind: usage.estimateKind,
        });
      }
    }
    for (const project of config.projects) {
      await workLogUsageStore.synchronizeUsageEstimatesAndProject({
        items: imageEstimates,
        projectRoot: project.path,
        projectionProjectRoots: globalWorkLogProjectRoots,
      });
    }
    if (resolved.length) {
      console.log(`Backfilled credit pricing metadata for ${resolved.length} journal turn(s)`);
    }
    if (imageEstimates.length) {
      console.log(`Backfilled image generation estimates for ${imageEstimates.length} journal turn(s)`);
    }
  } catch (error) {
    console.error("Cannot backfill journal credit pricing metadata:", error.message);
  }
}

async function auditClaudeTranscriptSnapshots(snapshots) {
  const records = [];
  for (const snapshot of snapshots ?? []) {
    const transcriptPath = String(snapshot?.transcriptPath ?? "").trim();
    const sessionId = String(snapshot?.sessionId ?? "").trim();
    const project = snapshot?.cwd ? findProject(snapshot.cwd) : null;
    if (!transcriptPath || !sessionId || !project) continue;
    const auditVersion = Number(snapshot.modifiedAtMs) || 0;
    if (claudeTranscriptAuditState.get(transcriptPath) === auditVersion) continue;
    const scan = await scanClaudeHistoricalTranscriptFile(transcriptPath);
    const taskTitle = String(snapshot.title ?? scan.session?.title ?? "").trim();
    for (const turn of scan.turns ?? []) {
      records.push({
        ...turn,
        provider: "claude",
        threadId: sessionId,
        turnId: turn.turnId,
        projectRoot: project.path,
        taskTitle,
        title: turn.body ? conciseTurnTitle(turn.body, turn.status) : turn.title,
        taskThreadId: sessionId,
        parentThreadId: "",
        aggregateOnly: false,
        provisional: false,
        changedFiles: [],
        diff: "",
      });
    }
    claudeTranscriptAuditState.set(transcriptPath, auditVersion);
    while (claudeTranscriptAuditState.size > 2_000) {
      claudeTranscriptAuditState.delete(claudeTranscriptAuditState.keys().next().value);
    }
  }
  if (!records.length) return;
  const result = await workLogUsageStore.recordAutomaticBatchAndProject({
    records,
    projectRoot: config.projectRoot,
    projectionProjectRoots: globalWorkLogProjectRoots,
  });
  if (result.recorded || result.updated) {
    console.log(
      `Audited Claude journal turns: ${result.recorded} added, ${result.updated} updated`,
    );
  }
}

async function finalizeTaskCatalog(mergedEntries) {
  let nextCatalog = mergedEntries;
  for (const entry of nextCatalog) {
    entry.orderingActivityAtMs = taskOrderingActivityAtMs(entry, {
      run: taskRuns.forTask(entry),
      lastMessage: savedLastTaskMessageRecord(entry),
      userMessageAtMs: deferredTaskMessageAtMs(entry),
    });
  }
  nextCatalog = statusTaskEntries(nextCatalog, nextCatalog.length);
  const nextTaskTitleSignature = taskCatalogTitleSignature(nextCatalog);
  const shouldSynchronizeTaskTitles = nextTaskTitleSignature !== synchronizedTaskTitleSignature
    || Date.now() - taskTitlesSynchronizedAt >= TASK_TITLE_RECONCILE_INTERVAL_MS;
  if (shouldSynchronizeTaskTitles) {
    for (const project of config.projects) {
      await workLogUsageStore.synchronizeTaskTitlesAndProject({
        titles: nextCatalog
          .filter((entry) => samePath(entry.projectRoot, project.path))
          .map((entry) => ({
            provider: entry.provider,
            threadId: entry.threadId,
            taskTitle: entry.title,
          })),
        projectRoot: project.path,
        journalDatabaseFile,
        projectionProjectRoots: globalWorkLogProjectRoots,
      });
    }
    synchronizedTaskTitleSignature = nextTaskTitleSignature;
    taskTitlesSynchronizedAt = Date.now();
  }
  let titleChanged = false;
  for (const run of taskRuns.values()) {
    const entry = nextCatalog.find((item) => catalogEntryIsSelected(item, run));
    if (entry) titleChanged = updateTaskRunTitle(run, entry.title) || titleChanged;
  }
  const current = nextCatalog.find((entry) => catalogEntryIsSelected(entry, selectedTask()));
  if (current?.title && current.title !== activeThreadTitle) {
    selectionStore.setTitle(current.title);
    titleChanged = true;
  }
  taskSyncStore.recordCatalog(nextCatalog);
  await taskSyncStore.save();
  if (titleChanged) await saveState();
  return nextCatalog;
}

async function refreshTaskCatalog({ force = false } = {}) {
  return taskCatalogService.refresh({ force });
}

const telegramTaskPicker = new TelegramTaskPickerService({
  refreshCatalog: refreshTaskCatalog,
  selectedTask,
  pageSize: TASK_PICKER_PAGE_SIZE,
  showProject: () => config.showProjectButton && config.showTaskProject,
  providerTitle,
  projectName: () => activeProject().name,
  newTaskCallback: () => uiCallback("thread:new"),
  archiveCallback: () => (isCodex() && threadId ? uiCallback("thread:archive") : null),
  editMessage: (message, view) => telegram("editMessageText", {
    chat_id: message.chat.id,
    message_id: message.message_id,
    text: view.text,
    reply_markup: view.replyMarkup,
  }),
  sendMessage: (view) => sendMessage(view.text, { reply_markup: view.replyMarkup }),
});

function sendThreadPicker(...args) { return telegramTaskPicker.send(...args); }

const serverControlController = new ServerControlController({
  config,
  startedAt: serverStartedAt,
  instanceId: serverInstanceId,
  releaseId: serverReleaseId,
  shortcutPath: agentHubAutostartShortcutPath,
  installScriptPath: defaultAutostartInstallScript(AGENT_HUB_ROOT),
  activeCount: () => taskRuns.values().filter(taskRunIsActive).length,
  restartState: () => ({
    pending: Boolean(restartRequest),
    waiting: restartRequest?.waitingForRuns === true,
    blockingCount: restartRequest
      ? restartBlockingRuns().length + backgroundJobs.size
      : 0,
  }),
  desktopSnapshot: () => desktopSnapshot(),
  spawnCapture,
});

const {
  desktopContextSnapshot,
  desktopRunSnapshot,
  desktopTaskSnapshot,
  desktopSnapshot: rawDesktopSnapshot,
} = createDesktopSnapshotFactory({
  clock: {
    nowMs: () => Date.now(),
    nowIso: () => new Date().toISOString(),
  },
  context: {
    latestUsage: latestThreadContextUsage,
    isCompacting: (contextThreadId) => contextCompactions.isRunning(contextThreadId),
    compactionFor: (contextThreadId) => contextCompactions.get(contextThreadId),
  },
  runs: {
    forTask: (task) => taskRuns.forTask(task),
    titleFor: runTaskTitle,
  },
  tasks: {
    savedLastMessage: savedLastTaskMessageRecord,
    projectNameFor: (projectRoot) => findProject(projectRoot)?.name ?? path.basename(projectRoot),
    entryIsSelected: catalogEntryIsSelected,
    executionRuntimeLabel: taskExecutionRuntimeLabel,
    orderingActivityAtMs: taskOrderingActivityAtMs,
    samePath,
  },
  catalog: {
    entries: () => taskCatalog,
    refreshedAt: () => taskCatalogService.refreshedAt,
    refresh: refreshTaskCatalog,
    merge: mergeTaskCatalog,
  },
  selection: {
    selectedTask,
    hasThread: () => Boolean(threadId),
    selectedTurnTarget,
    activeProject,
    activeThreadTitle: () => activeThreadTitle,
  },
  settings: {
    current: () => ({
      activeProvider,
      activeProjectRoot,
      ...agentPreferences.snapshot(),
      autoApprove,
      codexModels: CODEX_MODELS,
      codexModelLabel,
      claudeModels: CLAUDE_MODELS,
      claudeModelLabels: CLAUDE_MODEL_LABELS,
      reasoningEfforts: CODEX_REASONING_EFFORTS,
      reasoningLabels: CODEX_REASONING_LABELS,
      collaborationModes: CODEX_COLLABORATION_MODES,
      collaborationModeLabels: CODEX_COLLABORATION_MODE_LABELS,
      projects: PROJECTS,
    }),
  },
  deferred: {
    pendingValues: () => [...pendingInputs.values()],
    queuedValues: () => [...queuedInputs.values()],
    inputPreview: runInputPreview,
    editableText: deferredEditableText,
    responseAnnotations: (input) => deferredResponseAnnotations(input)?.annotations ?? [],
    describeAttachments: desktopAttachmentDescriptors,
  },
  receipts: {
    forMessage: (identity) => desktopMessageReceipts.get(identity),
    recent: () => desktopMessageReceipts.snapshot(),
  },
  approvals: {
    snapshot: () => approvalController.snapshot(),
  },
  restart: {
    request: () => restartRequest,
    blockingRuns: restartBlockingRuns,
    compactionCount: () => contextCompactions.runningCount(),
    mediaJobCount: () => backgroundJobs.mediaSize,
    speechJobCount: () => backgroundJobs.speechSize,
  },
  exchangeRates: usdRubRateStore,
  server: {
    snapshot: (...args) => serverControlController.snapshot(...args),
  },
  readState: {
    hasUnread: (answer) => taskHasUnreadAnswer(answer, taskReadStateStore.get(answer)),
  },
  warn: (...args) => console.warn(...args),
});

const desktopReadModel = new DesktopReadModelService({
  snapshot: rawDesktopSnapshot,
  readStateStore: taskReadStateStore,
  trustedDeviceUserId,
  hasAllowedUsers: () => Boolean(config.allowedUserIds.size),
  androidEnabled: () => Boolean(config.components.androidApp),
  lastTaskMessage: savedLastTaskMessageRecord,
});
const desktopSnapshot = (...args) => desktopReadModel.snapshot(...args);

const desktopTaskHistory = createDesktopTaskHistoryFactory({
  selection: {
    activeProvider: () => activeProvider,
    threadId: () => threadId,
    chatId: () => chatId,
  },
  catalog: {
    entries: () => taskCatalog,
    refresh: refreshTaskCatalog,
  },
  historyReader: {
    read: (binding) => taskViewController.readHistory(binding, { cachedOnly: true }),
    refresh: (binding) => taskViewController.readHistory(binding),
  },
  runs: {
    forTask: (binding) => taskRuns.forTask(binding),
  },
  latestMessage: savedLastTaskMessageRecord,
  historyMerger: {
    mergeActive: mergeActiveTaskHistory,
    mergeCompleted: mergeCompletedTaskHistory,
  },
  receipts: {
    forMessage: (identity) => desktopMessageReceipts.get(identity),
    forTurn: (identity) => desktopMessageReceipts.findByTurn(identity),
  },
  attachmentImporter: importCodexDesktopAttachments,
  responseBudget: {
    fit: fitTaskHistoryPayload,
  },
  warn: (...args) => console.warn(...args),
});

const markDesktopTaskRead = (...args) => desktopReadModel.markTaskRead(...args);

const desktopTaskService = new DesktopTaskService({
  catalog: () => taskCatalog,
  refreshCatalog: refreshTaskCatalog,
  activateBinding: activateMessageBinding,
  markRead: markDesktopTaskRead,
  snapshot: desktopSnapshot,
  taskHistory: desktopTaskHistory,
  dispatchCommand: dispatchApplicationCommand,
  commandTaskTarget,
  readTurn: (identity) => workLogUsageStore.getTurn(identity),
  samePath,
  chatId: () => chatId,
  warn: (...args) => console.warn(...args),
});
const desktopSelectTask = (...args) => desktopTaskService.select(...args);
const desktopOpenTask = (...args) => desktopTaskService.openTask(...args);
const desktopOpenTurn = (...args) => desktopTaskService.openTurn(...args);
const desktopMessageTarget = (...args) => desktopTaskService.resolveTarget(...args);

const desktopUpdateSetting = (...args) => desktopSettingsService.update(...args);

const taskCommandService = new TaskCommandService({
  resolveTarget: desktopMessageTarget,
  pinTitle: pinTaskTitle,
  renameCodexTask: (targetThreadId, title) => sendRpc("thread/name/set", {
    threadId: targetThreadId,
    name: title,
  }),
  expectTitleConfirmation: expectTaskTitleConfirmation,
  invalidateCatalog: invalidateTaskCatalog,
  runForTask: (target) => taskRuns.forTask(target),
  updateRunTitle: updateTaskRunTitle,
  catalogEntries: () => taskCatalog,
  catalogEntryIsSelected,
  selection: {
    current: selectedTask,
    setTitle: (title) => selectionStore.setTitle(title),
    clearCodex: () => selectionStore.setThread(null, { provider: "codex", title: "" }),
    selectCodex: (id, title) => selectionStore.setThread(id, { provider: "codex", title }),
  },
  saveTitles: savePinnedTaskTitles,
  saveState,
  snapshot: desktopSnapshot,
  readCodexTask: async (targetThreadId) => (await sendRpc("thread/read", {
    threadId: targetThreadId,
    includeTurns: false,
  })).thread,
  archiveCodexTask: (targetThreadId) => sendRpc("thread/archive", { threadId: targetThreadId }),
  deleteCodexSettings: (targetThreadId) => taskMetadata.deleteCodexSettings(targetThreadId),
  listCodexTasks: listThreads,
  codexTaskTitle: threadTitle,
  restoreCodexSettings: restoreCodexTaskSettings,
  diffs: {
    setLatest: (value) => { latestDiff = value; },
    forTask: (target) => taskDiffs.get(taskRunKey(target)) ?? "",
    refresh: refreshTaskDiff,
  },
  providerCancel: (run) => agentProviders.call(run.provider, "cancelRun", run),
  progress: { setStage: (...args) => taskProgress.setStage(...args), finish: (...args) => taskProgress.finish(...args) },
  dismissedExternalTasks,
  completeRun: (run) => managedRunLifecycle.complete(run),
  createTask: createThread,
  activeProvider: () => activeProvider,
  switchProvider,
});
const desktopRenameTask = (...args) => taskCommandService.rename(...args);
const desktopArchiveTask = (...args) => taskCommandService.archive(...args);
const desktopTaskDiff = (...args) => taskCommandService.diff(...args);
const desktopCancelRun = (...args) => taskCommandService.cancel(...args);

const desktopResolveApproval = (params) => approvalController.resolveFromDesktop(
  String(params.key ?? ""),
  String(params.decision ?? ""),
);
const desktopDeferredInput = (...args) => desktopDeferredInputService.handle(...args);

const restartRequestService = new RestartRequestService({
  getRequest: () => restartRequest,
  setRequest: (value) => { restartRequest = value; },
  blockingWorkCount: () => restartBlockingRuns().length + backgroundJobs.size,
  currentChatId: () => chatId,
  updateOffset: () => updateOffset,
  processingUpdateId: () => processingUpdateId,
  saveState,
  announceDesktop: announceDesktopRestart,
  sendTelegram: sendMessage,
  performRestart,
});
const desktopRestartServer = () => restartRequestService.fromDesktop();

const desktopNewTask = (...args) => taskCommandService.create(...args);

const desktopCompactContext = async (params) => (
  codexContextMaintenance.startManual(await desktopMessageTarget(params))
);

const deferredInputService = new DeferredInputService({
  store: deferredInputs,
  maxItems: MAX_DEFERRED_INPUTS,
  persist: saveState,
  removeFiles: (files) => Promise.all(files.map((file) => unlink(file).catch(() => {}))),
  notify: async (item, { executionOwner, conflictTask }) => {
    const preview = runInputPreview(item.input);
    const runtime = item.provider === "codex"
      ? taskExecutionRuntimeLabel(executionOwner)
      : executionOwner === TASK_EXECUTION_OWNERS.HUB
        ? taskExecutionRuntimeLabel(TASK_EXECUTION_OWNERS.HUB)
        : "Внешний Claude CLI";
    const conflictText = item.conflictKind === "repository"
      ? `Задача «${conflictTask?.taskTitle ?? "Без названия"}» уже работает с тем же Git-репозиторием через ${runtime}. Параллельная запись может смешать изменения.`
      : item.conflictKind === "activity-unknown"
        ? "Claude оставил незавершённый транскрипт, но давно не записывал новые события. Нельзя надёжно определить, продолжает ли работать внешний процесс."
        : `Выбранная задача уже выполняется через ${runtime}.`;
    return sendMessageTo(
      item.chatId,
      `${conflictText} Новое сообщение сохранено и не потеряно.`
        + `${preview ? `\n\n${preview.slice(0, 700)}` : ""}\n\nЧто сделать?`,
      { reply_markup: pendingInputKeyboard(item.id, { allowForce: item.allowForce }) },
    );
  },
});

const runConflictPolicy = new RunConflictPolicy({
  enabled: () => config.guardConcurrentRepositoryWrites,
  resolveRepoRoots: resolveTaskGitRepoRoots,
  taskCatalog: () => refreshTaskCatalog(),
  activeRuns: () => taskRuns.values(),
  findConflict: findRepositoryWriteConflict,
});

const runCoordinator = new RunCoordinator({
  taskRuns,
  providers: agentProviders,
  externalActivity: taskExternalActivity,
  repositoryConflict: (target) => runConflictPolicy.check(target),
  deferInput: (...args) => deferredInputService.defer(...args),
  beginRun: (input, target) => managedRunLifecycle.begin(input, target),
  launchTurn,
  describeAttachments: desktopAttachmentDescriptors,
  hasDeferredBacklog: (target) => deferredInputs.hasBacklog(target),
  scheduleDeferred: scheduleQueuedInput,
  setProgressStage: (...args) => taskProgress.setStage(...args),
  noteRunActivity: (...args) => taskProgress.noteActivity(...args),
  scheduleProgressUpdate: (...args) => taskProgress.schedule(...args),
  notifyInputStart: (target) => {
    // Telegram typing is best-effort and deliberately not persisted. The
    // regular progress card is owned by TaskProgressController after launch.
    void telegram("sendChatAction", {
      chat_id: target.chatId ?? chatId,
      action: "typing",
    }).catch(() => {});
  },
});

const desktopMessageController = createDesktopMessageController({
  attachmentPaths: desktopAttachmentPaths,
  describeAttachments: desktopAttachmentDescriptors,
  resolveTarget: desktopMessageTarget,
  receipts: desktopMessageReceipts,
  persistReceipts: saveState,
  runCoordinator,
});
const desktopDeferredInputService = new DesktopDeferredInputService({
  pendingInputs,
  queuedInputs,
  findReceiptByResultId: (id) => desktopMessageReceipts.findByResultId(id),
  isProcessing: (id) => deferredInputController.isProcessing(id),
  cancelSchedule: (id) => deferredInputController.cancelSchedule(id),
  steerActiveInput: (payload) => desktopMessageController.steerActiveInput(payload),
  responseAnnotations: deferredResponseAnnotations,
  replaceInputText: replaceDeferredInputText,
  saveState,
  updateReceipt: updateDeferredDesktopReceipt,
  cleanupFiles: cleanupDeferredFiles,
  updateMessage: updateDeferredMessage,
  scheduleNext: (item) => deferredInputController.scheduleNextForTask(item),
  scheduleQueued: scheduleQueuedInput,
  selectTask: selectTaskFromBinding,
  clientContext: commandClientContext,
  startTurn,
  runForTask: (target) => taskRuns.forTask(target),
  describeAttachments: desktopAttachmentDescriptors,
  selectedTask,
  dispatchCommand: dispatchApplicationCommand,
  activeTitle: () => activeThreadTitle,
  snapshot: () => desktopSnapshot(),
});
const taskNavigationService = new TaskNavigationService({
  projects: PROJECTS,
  samePath,
  findProject,
  selectionStore,
  activeProjectRoot: () => activeProjectRoot,
  activeProvider: () => activeProvider,
  threadId: () => threadId,
  activeTaskTitle: () => activeThreadTitle,
  isCodex,
  rememberCodexSettings: rememberCodexTaskSettings,
  captureCodexPreferences: () => agentPreferences.captureCodex(),
  restoreCodexPreferences: (value) => agentPreferences.restoreCodex(value),
  restoreCodexThreadSettings: restoreCodexTaskSettings,
  storedCodexThreadTitle,
  selectedTask,
  taskRunKey,
  storedTaskDiff: (key) => taskDiffs.get(key),
  latestDiff: () => latestDiff,
  setLatestDiff: (value) => { latestDiff = value; },
  createThread,
  codexTransportRunning: () => codexTransport.running,
  startCodex: startCodexAppServer,
  initializeCodex,
  attachCodexThread,
  saveState,
});
const desktopSettingsService = new DesktopSettingsService({
  isSelected: catalogEntryIsSelected,
  selectedTask,
  switchProvider,
  isCodex,
  threadId: () => threadId,
  isCompacting: (value) => contextCompactions.isRunning(value),
  switchCodexModel,
  switchClaudeModel: switchModel,
  updateCodexThreadSettings: updateActiveCodexThreadSettings,
  saveState,
  getCodexReasoning: () => agentPreferences.codexReasoningEffort,
  setCodexReasoning: (value) => agentPreferences.setCodexReasoning(value),
  getClaudeReasoning: () => agentPreferences.claudeReasoningEffort,
  setClaudeReasoning: (value) => agentPreferences.setClaudeReasoning(value),
  getCodexMode: () => agentPreferences.codexCollaborationMode,
  setCodexMode: (value) => agentPreferences.setCodexMode(value),
  getClaudeMode: () => agentPreferences.claudeCollaborationMode,
  setClaudeMode: (value) => agentPreferences.setClaudeMode(value),
  getAutoApprove: () => autoApprove,
  setAutoApprove: (value) => { autoApprove = value; },
  getIncludeClaudeUsage: () => agentPreferences.includeClaudeUsage,
  setIncludeClaudeUsage: (value) => {
    agentPreferences.setIncludeClaudeUsage(value);
    workLogUsageStore.setIncludeClaudeUsage(value);
  },
  projectUsage: () => workLogUsageStore.project(null, {
    projectRoot: config.projectRoot,
    projectionProjectRoots: globalWorkLogProjectRoots,
  }),
  findProjectIndex: (value) => PROJECTS.findIndex((project) => samePath(project.path, value)),
  switchProject,
  snapshot: (params) => desktopSnapshot(params),
  reasoningEfforts: CODEX_REASONING_EFFORTS,
  collaborationModes: CODEX_COLLABORATION_MODES,
});

function trustedDeviceUserId(context) {
  const localAndroidUserId = config.components.androidApp && !config.components.telegram
    ? "local"
    : "";
  return resolveTrustedDeviceUserId(config.allowedUserIds, context, localAndroidUserId);
}

const desktopSystemService = new DesktopSystemService({
  activeProvider: () => activeProvider,
  isCodex,
  preferences: (provider) => agentPreferences.current(provider),
  codexModelLabel,
  claudeModelLabels: CLAUDE_MODEL_LABELS,
  reasoningLabels: CODEX_REASONING_LABELS,
  collaborationModeLabels: CODEX_COLLABORATION_MODE_LABELS,
  formattedRateLimits: (provider) => rateLimitTelemetry.formatted(provider),
  activeRunCount: () => taskRuns.values().filter(taskRunIsActive).length,
  backgroundJobCount: () => backgroundJobs.size,
  readRateLimitHistory: (params) => rateLimitHistoryStore.read(params),
  readUsageHistory: (params) => workLogUsageStore.usageHistory(params),
  refreshCatalog: refreshTaskCatalog,
  searchTurns: (...args) => workLogUsageStore.searchTurns(...args),
  projectRoots: () => PROJECTS.map((project) => project.path),
  samePath,
  trustedDeviceManager: (context) => {
    const userId = trustedDeviceUserId(context);
    const manager = createTrustedDeviceManager({
      workerEnabled: config.miniApp.worker.enabled,
      publisher: miniAppLifecycle.publisher,
      localStore: trustedDeviceStore,
    });
    return {
      list: () => manager.list(userId),
      createPairing: () => manager.createPairing(userId),
      revoke: (deviceId) => manager.revoke(userId, deviceId),
    };
  },
  resolveTask: desktopMessageTarget,
  lastTaskMessage: savedLastTaskMessageRecord,
  enqueueSpeech: (target, text) => backgroundJobs.enqueue(
    "speech",
    { chatId, text },
    chatId,
    { dedupeKey: `desktop:${target.provider}:${target.threadId}:speech` },
  ),
  maxSpeechJobs: MAX_BACKGROUND_SPEECH_JOBS,
});
const desktopStatusDetails = (...args) => desktopSystemService.statusDetails(...args);
const desktopRateLimitHistory = (...args) => desktopSystemService.rateLimitHistory(...args);
const desktopUsageHistory = (...args) => desktopSystemService.usageHistory(...args);
const desktopSearch = (...args) => desktopSystemService.search(...args);
const desktopTrustedDevices = (...args) => desktopSystemService.trustedDevices(...args);
const desktopCreateDevicePairing = (...args) => desktopSystemService.createDevicePairing(...args);
const desktopRevokeDevice = (...args) => desktopSystemService.revokeDevice(...args);
const desktopSpeakLastAnswer = (...args) => desktopSystemService.speakLastAnswer(...args);

function telegramMessageCommandContext(message) {
  return {
    source: "telegram",
    userId: message?.from?.id,
    clientId: `telegram:${message?.chat?.id ?? "unknown"}`,
    commandId: Number.isSafeInteger(message?.message_id)
      ? `message:${message.chat.id}:${message.message_id}`
      : null,
  };
}

function telegramCallbackCommandContext(callback) {
  return {
    source: "telegram",
    userId: callback?.from?.id,
    clientId: `telegram:${callback?.message?.chat?.id ?? "unknown"}`,
    commandId: callback?.id ? `callback:${callback.id}` : null,
  };
}

function dispatchTelegramSetting(callback, name, value) {
  const params = { name, value };
  return dispatchApplicationCommand(
    "settings.update",
    params,
    telegramCallbackCommandContext(callback),
    { target: settingCommandTarget(params) },
  );
}

const applicationCommands = createApplicationCommandService({
  selectedTask,
  handlers: {
    selectTask: desktopSelectTask,
    createTask: desktopNewTask,
    renameTask: desktopRenameTask,
    archiveTask: desktopArchiveTask,
    updateSetting: desktopUpdateSetting,
    cancelRun: desktopCancelRun,
    resolveApproval: (payload) => payload.callback
      ? approvalController.handleCallback(payload.callback)
      : desktopResolveApproval(payload),
  },
});

function settingCommandTarget(params) {
  return applicationCommands.settingTarget(params);
}

function dispatchApplicationCommand(type, params, context, { target = null } = {}) {
  return applicationCommands.dispatch(type, params, context, { target });
}

function selectTaskFromBinding(binding, context = {}) {
  return applicationCommands.selectTaskFromBinding(binding, context);
}

const telegramTaskActions = new TelegramTaskActionService({
  selectedTask,
  activeProvider: () => activeProvider,
  activeProjectRoot: () => activeProjectRoot,
  activeTaskTitle: () => activeThreadTitle,
  currentThreadId: () => threadId,
  preferencesSnapshot: () => agentPreferences.snapshot(),
  selectedRun,
  selectTaskFromBinding,
  sendTaskSwitchNotification,
  sendTaskAlreadySelectedNotification,
  dispatchCommand: dispatchApplicationCommand,
  commandTaskTarget,
  isCodex,
  threadTitle,
  formatArchiveMessage,
  sendMessage: sendMessageTo,
  showLastMessageReplyMarkup,
  bindRunMessage,
  telegram,
});

const {
  handleDesktopControl: dispatchDesktopControl,
  forgetDesktopControl,
} = createDesktopApplicationRouter({
  handlers: {
    snapshot: desktopSnapshot,
    taskHistory: desktopTaskHistory,
    rateLimitHistory: desktopRateLimitHistory,
    usageHistory: desktopUsageHistory,
    search: desktopSearch,
    openTask: desktopOpenTask,
    openTurn: desktopOpenTurn,
    sendMessage: desktopMessageController.sendMessage,
    taskDiff: desktopTaskDiff,
    deferredInput: desktopDeferredInput,
    statusDetails: desktopStatusDetails,
    speakLastAnswer: desktopSpeakLastAnswer,
    restartServer: desktopRestartServer,
    setAutostart: (params) => serverControlController.setAutostart(params),
    updateServerConfiguration: (params) => serverControlController.updateConfiguration(params),
    compactContext: desktopCompactContext,
    openAttachment: desktopOpenAttachment,
    trustedDevices: desktopTrustedDevices,
    createDevicePairing: desktopCreateDevicePairing,
    revokeDevice: desktopRevokeDevice,
  },
  commands: applicationCommands,
  receiptFile: path.join(config.dataDir, "desktop-control-receipts.json"),
  reconcileMutation: reconcileDesktopMutation,
});

async function handleDesktopControl(request) {
  return dispatchDesktopControl(request);
}

async function reconcileRemoteDesktopControl({ action, params, context }) {
  try {
    // The Desktop router owns its own pre-effect receipt. Re-entering it with
    // the same command id returns a completed cached result or invokes its
    // action-specific reconciliation; it never repeats an uncertain effect.
    return {
      resolved: true,
      result: await dispatchDesktopControl({ action, params, context }),
    };
  } catch (error) {
    return { resolved: false, error: error.message };
  }
}

async function reconcileDesktopMutation({ action }) {
  // Most Desktop mutations ultimately call external providers or mutate a
  // live App Server. They have no queryable transaction identifier. Repeating
  // an effect after a crash would be worse than reporting its unknown outcome.
  return {
    resolved: false,
    terminal: true,
    error: `Outcome of interrupted ${action} command is unknown; it was not repeated`,
  };
}

async function sendProjectPicker() {
  return telegramSettingsMenu.projectsPicker({ activeProjectRoot });
}

async function sendAgentPicker() {
  return telegramSettingsMenu.agentPicker({ provider: activeProvider });
}

async function sendModelPicker() {
  return telegramSettingsMenu.modelPicker({
    provider: activeProvider,
    codexModel: agentPreferences.codexModel,
    claudeModel: agentPreferences.claudeModel,
    codexModelLabel: codexModelLabel(agentPreferences.codexModel),
  });
}

function switchCodexModel(value) {
  return agentPreferences.setCodexModel(value);
}

function switchModel(value) {
  return agentPreferences.setClaudeModel(value);
}

function switchProject(...args) { return taskNavigationService.switchProject(...args); }

function switchProvider(...args) { return taskNavigationService.switchProvider(...args); }

function resumeThread(...args) { return telegramTaskActions.resume(...args); }

function renameCurrentTask(...args) { return telegramTaskActions.rename(...args); }

function activateMessageBinding(...args) { return taskNavigationService.activate(...args); }

function archiveCurrentThread(...args) { return telegramTaskActions.archive(...args); }

function archiveBlockedReason(...args) { return telegramTaskActions.archiveBlockedReason(...args); }

function sendArchiveMessage(result, targetChatId = chatId) {
  return telegramTaskActions.sendArchive(result, targetChatId);
}

function currentStatusSnapshot(targetChatId = chatId) {
  return telegramTaskActions.statusSnapshot(targetChatId);
}

async function sendStatus(snapshot = currentStatusSnapshot()) {
  return telegramStatusController.send(snapshot);
}

async function sendReasoningPicker() {
  return telegramSettingsMenu.reasoningPicker({
    provider: activeProvider,
    value: agentPreferences.current(activeProvider).reasoningEffort,
  });
}

async function sendCollaborationModePicker() {
  return telegramSettingsMenu.collaborationModePicker({
    provider: activeProvider,
    value: agentPreferences.current(activeProvider).collaborationMode,
  });
}

const runProgressPresentation = new RunProgressPresentation({
  telegramLimit: TELEGRAM_LIMIT,
  claudeModelLabels: CLAUDE_MODEL_LABELS,
  codexReasoningLabels: CODEX_REASONING_LABELS,
  codexModelLabel,
  taskExecutionRuntimeLabel,
  formatProgressHeading,
  formatProgressHeartbeat,
  showProject: () => config.showProjectButton,
  taskTitle: runTaskTitle,
  projectName: (run) => runProject(run).name,
  currentCodexModel: () => agentPreferences.codexModel,
  currentClaudeModel: () => agentPreferences.claudeModel,
  currentCodexReasoning: () => agentPreferences.codexReasoningEffort,
  currentClaudeReasoning: () => agentPreferences.claudeReasoningEffort,
  taskExecutionOwners: TASK_EXECUTION_OWNERS,
});

telegramDeliveryService = new TelegramDeliveryService({
  dataDir: config.dataDir,
  messageLimit: TELEGRAM_LIMIT,
  appendBindings: appendMessageBindings,
  readBindings: readMessageBindings,
  removeBindings: removeMessageBindings,
  pendingApprovalMessageIds: (targetChatId) => [...approvalController.pending.values()]
    .filter((approval) => approval.chatId === targetChatId)
    .map((approval) => approval.messageId)
    .filter(Number.isSafeInteger),
  runTaskTitle,
  samePath,
  taskRuns,
  telegram,
  sendMessageTo,
  deliveryOutbox,
  scheduleDeliveryFlush: scheduleDeliveryOutboxFlush,
  taskRunKey,
  randomId: randomUUID,
  progressHeading: (run, done) => runProgressPresentation.heading(run, done),
  rememberSpeechText: (text, force) => mediaController.rememberSpeechText(text, force),
  taskViewCallbackData,
  completeRun: (run) => managedRunLifecycle.complete(run),
  rememberLastMessage: (run, text) => runJournal.rememberLastMessage(run, text),
  rememberLastSeenTurn: (run, turnId) => (
    setBoundedMapValue(lastSeenTaskTurnIds, taskRunKey(run), turnId, 500)
  ),
  refreshTaskDiff,
  selectedTask,
  activeTaskTitle: () => activeThreadTitle,
  activeProjectName: () => activeProject().name,
  showProject: () => config.showProjectButton,
  taskSwitchSettings,
  showLastMessageReplyMarkup,
  formatTaskSwitchMessage,
  formatTaskAlreadySelectedMessage,
  getProgressController: () => taskProgress,
  saveState,
});

const taskProgress = new TaskProgressController({
  isCurrentRun: (run) => taskRuns.forTask(run) === run,
  render: (run, done) => runProgressPresentation.render(run, done),
  sendInitial: (run, text) => sendReliableRunMessage(
    run,
    text,
    {},
    { kind: "progress" },
    { supersedeKey: progressOutboxKey(run) },
  ),
  deleteMessage: (run, messageId) => telegram("deleteMessage", {
    chat_id: run.chatId,
    message_id: messageId,
  }),
  removeBindings: (run, messageIds) => telegramDeliveryService
    .removeStoredBindings(run.chatId, messageIds),
  editMessage: (run, messageId, text) => telegram("editMessageText", {
    chat_id: run.chatId,
    message_id: messageId,
    text,
  }),
  persist: () => saveState(),
  retainAfterEditError: retainProgressMessageAfterEditError,
});

function explicitSkillCandidatesFromInput(input) {
  const text = typeof input === "string"
    ? input
    : (Array.isArray(input) ? input : [])
      .filter((item) => item?.type === "text")
      .map((item) => String(item.text ?? ""))
      .join("\n");
  return [...new Set(
    [...text.matchAll(/(?:^|[\s([{])\$([A-Za-z0-9][A-Za-z0-9_.:-]*)/gu)]
      .map((match) => match[1]),
  )];
}

async function resolvedExplicitSkillNames(input, cwd) {
  const candidates = explicitSkillCandidatesFromInput(input);
  if (!candidates.length) return [];
  try {
    const result = await sendRpc("skills/list", { cwds: [cwd] });
    const available = new Set(
      (result?.data ?? [])
        .filter((entry) => samePath(entry?.cwd, cwd))
        .flatMap((entry) => entry?.skills ?? [])
        .filter((skill) => skill?.enabled !== false)
        .map((skill) => String(skill?.name ?? "").trim())
        .filter(Boolean),
    );
    return candidates.filter((name) => available.has(name));
  } catch (error) {
    console.warn(`Cannot resolve explicit skills for ${cwd}: ${error.message}`);
    return [];
  }
}

async function discardManualContextCompactionRun(run, turnId = run?.turnId) {
  if (!run || !contextCompactions.isManualTurn(run.threadId, turnId)) return false;
  const normalizedTurnId = String(turnId ?? "").trim();
  codexUsageTracker.deleteTurn(normalizedTurnId);
  turnSpeechButtons.delete(normalizedTurnId);
  const temporaryFiles = turnTemporaryFiles.get(normalizedTurnId) ?? [];
  turnTemporaryFiles.delete(normalizedTurnId);
  await Promise.all(temporaryFiles.map((file) => unlink(file).catch(() => {})));
  await taskProgress.clear(run);
  await managedRunLifecycle.complete(run);
  return true;
}

async function taskExternalActivity(target) {
  if (!target?.threadId) return { state: "inactive", executionOwner: null };
  try {
    return await agentProviders.call(target.provider, "readTaskActivity", target);
  } catch (error) {
    console.error(`Cannot check ${target.provider} task activity:`, error.message);
    return { state: "unknown", executionOwner: TASK_EXECUTION_OWNERS.EXTERNAL };
  }
}

async function launchTurn(run, input, temporaryFiles = [], { forceSpeechButton = false } = {}) {
  return agentProviders.call(
    run.provider,
    "launchTurn",
    run,
    input,
    temporaryFiles,
    { forceSpeechButton },
  );
}

async function startTurn(input, temporaryFiles = [], {
  forceSpeechButton = false,
  target = null,
  allowRepositoryConflict = false,
  allowUnknownExternalActivity = false,
  persistentFiles = false,
} = {}) {
  target ??= {
    ...selectedTask(),
    taskTitle: activeThreadTitle,
    chatId,
  };
  const result = await runCoordinator.start(input, temporaryFiles, {
    forceSpeechButton,
    target,
    allowRepositoryConflict,
    allowUnknownExternalActivity,
    persistentFiles,
  });
  if (!result?.run) return result;
  const { run: _run, ...publicResult } = result;
  return publicResult;
}

async function cleanupDeferredFiles(item) {
  await Promise.all((item?.temporaryFiles ?? []).map((file) => unlink(file).catch(() => {})));
}

function updateDeferredMessage(...args) {
  return deferredInputPresentation.updateTelegramMessage(...args);
}

function updateDeferredDesktopReceipt(...args) {
  return deferredInputPresentation.updateDesktopReceipt(...args);
}

const deferredInputController = new DeferredInputController({
  pendingInputs,
  queuedInputs,
  findStarted: async (item) => {
    const run = taskRuns.forTask({
      provider: item.provider,
      projectRoot: item.projectRoot,
      threadId: item.threadId,
    });
    return deferredInputMatchesRun(item, run) ? run : null;
  },
  isBlocked: async (item) => {
  const target = {
    provider: item.provider,
    projectRoot: item.projectRoot,
    threadId: item.threadId,
    taskTitle: item.taskTitle,
    chatId: item.chatId,
    modelId: item.modelId,
    reasoningId: item.reasoningId,
    collaborationMode: item.collaborationMode,
  };
    const externalActivity = taskRuns.forTask(target)
    ? { state: "active" }
    : await taskExternalActivity(target);
    return Boolean(taskRuns.forTask(target)
      || externalActivity.state !== "inactive"
      || await runConflictPolicy.check(target));
  },
  // The queued item remains durable while RunCoordinator creates and persists
  // the exact managed run before invoking the provider launch operation.
  start: (item) => runCoordinator.startDeferred(item),
  onStateChange: updateDeferredDesktopReceipt,
  persist: () => saveState(),
  updateMessage: updateDeferredMessage,
  pendingKeyboard: (item) => pendingInputKeyboard(item.id, { allowForce: item.allowForce === true }),
  notifyReturned: (item) => sendMessageTo(
    item.chatId,
    "Сообщение не потеряно и возвращено в сохранённые после ошибки запуска.",
  ),
  expire: async (item) => {
    await cleanupDeferredFiles(item);
    await updateDeferredMessage(
      item,
      `⌛ Сохранённое сообщение для задачи «${item.taskTitle}» удалено: срок ожидания истёк.`,
    );
  },
  maxAgeMs: config.deferredInputTtlHours * 60 * 60 * 1000,
});

function scheduleQueuedInput(item, delayMs = 2000) {
  deferredInputController.schedule(item, delayMs);
}

async function processQueuedInput(id) {
  return deferredInputController.process(id);
}

function resolveClaudeInvocation() {
  return resolveInstalledClaudeInvocation({
    requested: config.claudeExecutable || "claude",
    prefixArgs: config.claudeExecutableArgs,
  });
}

function spawnCapture(command, args, options = {}) {
  return captureProcess(command, args, {
    cwd: activeProjectRoot,
    stopProcess: (worker) => stopProcessTree(worker.pid),
    ...options,
  });
}

function runtimeCommandTaskTitleFallback({
  provider,
  threadId: targetThreadId,
  run = null,
  thread = null,
}) {
  const pinnedTitle = pinnedTaskTitle(provider, targetThreadId);
  if (pinnedTitle) return pinnedTitle;
  const currentThreadTitle = provider === "codex" ? codexThreadResponseTitle(thread) : "";
  if (currentThreadTitle) return currentThreadTitle;
  if (run) return runTaskTitle(run);
  const catalogTask = taskCatalog.find((task) => (
    task.provider === provider && task.threadId === targetThreadId
  ));
  if (catalogTask?.title) return catalogTask.title;
  if (activeProvider === provider && threadId === targetThreadId && activeThreadTitle) {
    return activeThreadTitle;
  }
  if (thread) return threadTitle(thread);
  return `${provider === "codex" ? "Codex" : "Claude"} · ${targetThreadId.slice(0, 8)}`;
}

async function runtimeCommandTaskTitle(options) {
  const fallback = runtimeCommandTaskTitleFallback(options);
  return options.provider === "codex"
    ? storedCodexThreadTitle(options.threadId, fallback)
    : fallback;
}

async function authorizeRuntimeCommand(request) {
  return codexLifecycleController.authorize(request);
}

async function reconcileRuntimeCommand(request) {
  return codexLifecycleController.reconcile(request);
}

async function handleRuntimeCommand(request) {
  if (runtimeNotificationController.supports(request.command)) {
    return runtimeNotificationController.handle(request);
  }
  if (codexLifecycleController.supports(request.command)) {
    return codexLifecycleController.handle(request);
  }
  throw new Error(`Unsupported runtime command: ${request.command}`);
}
async function refreshTaskDiff(run) {
  if (!run) return "";
  const captured = await taskGitDiff(run.gitBaseline, config.dataDir, run.id);
  if (captured !== null) run.latestDiff = captured;
  await persistTaskDiff(taskRunKey(run), run.latestDiff ?? "");
  if (isSelectedRun(run)) latestDiff = run.latestDiff ?? "";
  return run.latestDiff ?? "";
}

const claudeRunController = new ClaudeRunController({
  dataDir: config.dataDir,
  pollIntervalMs: CLAUDE_OUTPUT_POLL_INTERVAL_MS,
  isCurrentRun: (run) => taskRuns.forTask(run) === run,
  isStopping: () => stopping,
  onStreamEvent: handleClaudeStreamEvent,
  onComplete: finishClaudeRun,
  onPersist: () => saveState(),
  onActive: () => startTyping(),
  onReconnect: (run, alive) => taskProgress.setStage(run, alive
    ? "Переподключился к выполняющемуся ходу Claude."
    : "Дочитываю прерванный ход Claude…"),
});

function persistManagedRunHistory(...args) { return managedRunHistory.persist(...args); }

function persistClaudeRunHistory(run, options = {}) {
  return persistManagedRunHistory(run, options);
}

async function startClaudeTurn(run, input, temporaryFiles, { forceSpeechButton = false } = {}) {
  return claudeTurnLauncher.start(run, input, temporaryFiles, { forceSpeechButton });
}

function handleClaudeStreamEvent(run, parsed) {
  return claudeEventService.handle(run, parsed);
}

async function finishClaudeRun(run, completion = {}) {
  return runCoordinator.completeManaged(run, completion);
}

// Отменить ход можно и после перезапуска бота, когда объекта процесса уже нет,
// поэтому останавливаем по сохранённому PID. Дочитывание файла само завершит ход.
async function stopClaudeRunProcess(run) {
  const pid = Number(run?.pid ?? run?.process?.pid);
  const stopped = await claudeRunController.stop(run);
  if (!stopped) console.error(`Cannot stop Claude process tree ${pid}`);
  return stopped;
}

// После перезапуска бота дочерний процесс CLI потерян как объект, но сам ход
// продолжается: подключаемся к нему заново через файл вывода и живой PID.
async function attachClaudeRunAfterRestart(run) {
  await claudeRunController.attachAfterRestart(run);
}

async function handleCodexMessage(message) {
  return codexEventService.handle(message);
}

function completedCodexAnswer(...args) { return codexTaskSnapshots.completedAnswer(...args); }

function applyCodexObservedSnapshot(...args) { return codexTaskSnapshots.applyObserved(...args); }

function applyCodexActiveSnapshot(...args) { return codexTaskSnapshots.applyActive(...args); }

async function readCodexTaskSnapshot(run, { threadResult = null, fresh = false } = {}) {
  return codexTaskSnapshots.read(run, { threadResult, fresh });
}

const taskObserver = new TaskObservationService({
  providers: agentProviders,
  taskRuns,
  runCoordinator,
  dataDir: config.dataDir,
  findProject,
  invalidateTaskCatalog,
  syncTaskRun,
  modelLabel: codexModelLabel,
  reasoningLabels: CODEX_REASONING_LABELS,
  noteRunActivity: (...args) => taskProgress.noteActivity(...args),
  scheduleProgressUpdate: (...args) => taskProgress.schedule(...args),
  setProgressStage: (...args) => taskProgress.setStage(...args),
  markProgressHeartbeat,
  progressHeartbeatState: (run, now) => taskProgress.heartbeatState(run, now, PROGRESS_STALLED_AFTER_MS),
  finishProgress: (...args) => taskProgress.finish(...args),
  completeRun: (run) => managedRunLifecycle.complete(run),
  discardManualContextCompactionRun,
  savedLastTaskMessage,
  savedLastTaskMessageRecord,
  externalPollIntervalMs: EXTERNAL_TASK_POLL_INTERVAL_MS,
  managedPollIntervalMs: MANAGED_TASK_FALLBACK_POLL_INTERVAL_MS,
  captureGitBaseline: captureTaskGitBaseline,
});
const claudeTurnLauncher = new ClaudeTurnLauncher({
  taskRuns,
  turnTemporaryFiles,
  taskSnapshots: claudeTaskSnapshots,
  permissionMode: config.claudePermissionMode,
  autoApprove: () => autoApprove,
  persistHistory: persistClaudeRunHistory,
  resolveInvocation: resolveClaudeInvocation,
  runController: claudeRunController,
  logWarning: (...args) => console.warn(...args),
});

const runRecovery = new RunRecoveryCoordinator({
  taskRuns,
  providers: agentProviders,
  runCoordinator,
  observer: taskObserver,
  progress: taskProgress,
  startTyping,
  saveState,
  safeDeliver: safelyDeliverRunMessage,
  sendRunMessage,
  completeRun: (run) => managedRunLifecycle.complete(run),
  logError: (...args) => console.error(...args.map((value) => value?.message ?? value)),
});

const selectedTaskWatch = new SelectedTaskWatchService({
  providers: agentProviders,
  taskRuns,
  dismissedTasks: dismissedExternalTasks,
  lastSeenTurnIds: lastSeenTaskTurnIds,
  timers: runtimeTimers,
  intervalMs: SELECTED_TASK_WATCH_INTERVAL_MS,
  isStopping: () => stopping,
  selectedTask,
  chatId: () => chatId,
  activeTaskTitle: () => activeThreadTitle,
  rememberLastTaskMessage,
  createObservedRun: (...args) => taskObserver.create(...args),
  scheduleObservedRun: (...args) => taskObserver.schedule(...args),
  saveState,
});

async function auditRecentCodexTerminalTurns() {
  if (stopping || !codexTransport.running) return;
  try {
    const changed = await codexTerminalAudit.run();
    if (changed) await saveState();
  } catch (error) {
    console.error("Cannot audit Codex terminal turns:", error.message);
  }
}

function scheduleCodexTerminalAudit(delayMs = SELECTED_TASK_WATCH_INTERVAL_MS) {
  if (stopping) return;
  runtimeTimers.schedule("codex-terminal-audit", async () => {
    await auditRecentCodexTerminalTurns();
    scheduleCodexTerminalAudit();
  }, Math.max(0, Number(delayMs) || 0));
}

const taskViewController = new TaskViewController({
  ensureCodex: async () => {
    if (codexTransport.running) return;
    await startCodexAppServer();
    await initializeCodex({ attachSelectedThread: false });
  },
  findCodexRolloutPath: knownCodexRolloutPath,
  readCodexThread,
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
    const selectedTitle = isSelectedRun(running) ? activeThreadTitle : null;
    const catalogTitle = taskCatalog.find((entry) => catalogEntryIsSelected(entry, running))?.title;
    return selectedTitle || catalogTitle || binding.taskTitle;
  },
  startProgressMessage: (...args) => taskProgress.start(...args),
  createObservedRun: (...args) => taskObserver.create(...args),
  scheduleObservedRun: (...args) => taskObserver.schedule(...args),
  findMessageBinding: (targetChatId, messageId) => (
    findMessageBinding(config.dataDir, targetChatId, messageId)
  ),
  findCatalogEntry: async (identity) => {
    let entry = taskCatalog.find((item) => taskViewController.identityMatches(item, identity));
    if (!entry) {
      entry = (await refreshTaskCatalog()).find((item) => taskViewController.identityMatches(item, identity));
    }
    return entry ?? null;
  },
  selectedTask,
  activeThreadTitle: () => activeThreadTitle,
  logger: console,
});

async function showTaskMessage(binding, targetChatId, { count = 1 } = {}) {
  return taskViewController.show(binding, targetChatId, { count });
}

async function showLastTaskMessage(binding, targetChatId, { count = 1 } = {}) {
  return taskViewController.showLast(binding, targetChatId, { count });
}

async function resolveTaskViewBinding(identity, targetChatId, sourceMessageId) {
  return taskViewController.resolveBinding(identity, targetChatId, sourceMessageId);
}

async function requestApproval(rpcId, kind, params, text, run = null) {
  return approvalController.request(rpcId, kind, params, text, run);
}

async function requestMcpElicitation(rpcId, params, run = null) {
  return approvalController.requestMcp(rpcId, params, run);
}

function formatCommandApproval(params, run = null) {
  return presentCommandApproval(params, run, activeProjectRoot);
}

function formatFileApproval(params) { return presentFileApproval(params); }

function formatApprovalMode() {
  return presentApprovalMode({
    provider: activeProvider,
    autoApprove,
    autoApproveOnStart: config.autoApproveOnStart,
    claudePermissionMode: config.claudePermissionMode,
  });
}

function approvalModeKeyboard() {
  return presentApprovalModeKeyboard({ autoApprove, callback: uiCallback });
}

// Ход Claude больше не привязан к жизни бота: его вывод пишется в файл, а после
// перезапуска бот подключается к тому же процессу. Ждать завершения нужно только
// для Codex, чей App Server перезапускается вместе с ботом.
function restartBlockingRuns() {
  return taskRuns.values().filter((run) => (
    agentProviders.call(run.provider, "blocksRuntimeRestart", run)
  ));
}

function restartHasBlockingWork() {
  return restartBlockingRuns().length > 0
    || backgroundJobs.size > 0;
}

function scheduleDeferredRestartIfReady() {
  if (restartRequest?.waitingForRuns && !restartHasBlockingWork() && !stopping) {
    setTimeout(() => void performRestart(), 0).unref?.();
  }
}

const restartNotifications = new RestartNotificationService({
  getRequest: () => restartRequest,
  setRequest: (value) => { restartRequest = value; },
  isStopping: () => stopping,
  sendMessage: sendMessageTo,
  telegram,
  saveState,
  formatCompleteMessage: formatRestartCompleteMessage,
  completeMessageState: () => ({
    provider: providerTitle(),
    task: activeThreadTitle || (threadId ? `${providerTitle()} · ${threadId.slice(0, 8)}` : "Не выбрана"),
    runningTasks: taskRuns.size,
  }),
  menu: BOT_MENU,
  finalizeReplacement: finalizeSuccessfulReplacement,
});

function restartMessageIsEditable(...args) { return restartNotifications.editable(...args); }
function announceDesktopRestart(...args) { return restartNotifications.announceDesktop(...args); }
function updateRestartMessage(...args) { return restartNotifications.update(...args); }
function finalizeRestartMessage(...args) { return restartNotifications.finalize(...args); }

const runtimeResources = new RuntimeResourceRegistry({
  flush: [
    { name: "journal startup", run: () => journalStartupReady },
    { name: "state writes", run: () => runtimeStateCoordinator.flush() },
    { name: "message binding writes", run: () => telegramDeliveryService.waitForBindingWrites() },
    { name: "media writes", run: () => mediaController.waitForWrites() },
    { name: "task sync", run: () => taskSyncStore.save() },
    { name: "delivery outbox", run: () => deliveryOutbox.waitForWrites() },
    { name: "background jobs", run: () => backgroundJobStore.waitForWrites() },
    { name: "failed updates", run: () => failedUpdateStore.waitForWrites() },
  ],
  suspend: [
    { name: "Codex App Server", run: stopCodexAppServerTree },
    { name: "Mini App publisher", run: () => miniAppLifecycle.closePublisher() },
    { name: "direct gateway", run: () => miniAppLifecycle.closeDirectGateway() },
    { name: "quick tunnel", run: () => miniAppLifecycle.closeQuickTunnel() },
    { name: "public Mini App", run: () => miniAppLifecycle.closePublicServer() },
    { name: "local Mini App", run: () => miniAppLifecycle.closeLocalServer() },
    { name: "Desktop control", run: () => desktopControlServer?.close() },
    { name: "runtime command", run: () => runtimeCommandServer.close() },
    { name: "instance lock", run: () => instanceGuard.release() },
  ],
  finalize: [
    { name: "work log usage", run: () => workLogUsageStore.close() },
    { name: "rate limit history", run: () => rateLimitHistoryStore.close() },
    { name: "task sync store", run: () => taskSyncStore.close() },
    { name: "task read-state store", run: () => taskReadStateStore.close() },
    { name: "runtime state store", run: () => runtimeStateStore.close() },
  ],
});

const runtimeRestart = new RuntimeRestartController({
  getRequest: () => restartRequest,
  updateOffset: () => updateOffset,
  hasBlockingWork: restartHasBlockingWork,
  setWaiting: (value) => { restartRequest.waitingForRuns = value; },
  updateMessage: updateRestartMessage,
  saveState,
  resources: runtimeResources,
  isStopping: () => stopping,
  beginStopping: () => {
    if (stopping) return false;
    stopping = true;
    return true;
  },
  stopTimers: stopRuntimeTimers,
  stopMedia: () => mediaController.stop(),
  launchReplacement: async () => {
    const invocation = botReplacementInvocation({
      botFile: path.join(AGENT_HUB_ROOT, "agent-hub-main.mjs"),
      agentHubRoot: AGENT_HUB_ROOT,
    });
    const launcher = String(process.env.AGENT_HUB_LAUNCHER ?? "").trim();
    const fallbackInvocation = process.platform === "win32" && launcher
      ? directWindowsLauncherInvocation({ launcher })
      : null;
    return launchReplacementAndWait({
      invocation,
      fallbackInvocation,
      lockFile: INSTANCE_LOCK_FILE,
    });
  },
  recoverPrevious: (error) => restorePreviousBotAfterFailedReplacement({
    replacementError: error,
    acquireLock: () => instanceGuard.acquire(),
    startCommandServer: async () => {
      await runtimeCommandServer.start();
      await desktopControlServer?.start();
      await miniAppLifecycle.start();
    },
    setStopping: (value) => { stopping = value; },
    restoreProvider: async () => {
      if (isCodex() || taskRuns.values().some((run) => run.provider === "codex")) {
        await startCodexAppServer();
        await initializeCodex({ attachSelectedThread: isCodex() });
      }
    },
    recoverRuns: (...args) => runRecovery.recoverAll(...args),
    updateMessage: (message) => updateRestartMessage(message).catch(() => {}),
    clearRestartRequest: () => { restartRequest = null; },
    saveState,
    startTimers: startRuntimeTimers,
    markReady: () => instanceGuard.markReady(),
  }),
  finishSuccessfulReplacement: async () => {
    // Detached Claude processes survive; the replacement reconnects by PID/output offset.
    await delay(500);
    process.exit(0);
  },
});

async function performRestart() {
  const result = await runtimeRestart.perform();
  if (result.status === "failed") process.exitCode = 1;
}

async function restartBot() {
  await restartRequestService.fromTelegram();
}

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
  activeProvider: () => activeProvider,
  autoApprove: () => autoApprove,
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
  activeThreadTitle: () => activeThreadTitle,
  selectedTask,
  mediaController,
  pendingInputs,
  queuedInputs,
  backgroundJobs,
  maxSpeechJobs: MAX_BACKGROUND_SPEECH_JOBS,
  currentUiContextToken,
  interactiveJobs,
  isStopping: () => stopping,
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
  setChatId: (value) => { chatId = value; },
  findReplyBinding: (targetChatId, messageId) => (
    findMessageBinding(config.dataDir, targetChatId, messageId)
  ),
  activateMessageBinding,
  setUpdateOffset: (value) => { updateOffset = value; },
  updateOffset: () => updateOffset,
  setProcessingUpdateId: (value) => { processingUpdateId = value; },
  failedUpdateStore,
  restartReady: () => Boolean(restartRequest && !restartRequest.waitingForRuns && !stopping),
  performRestart,
});

function scheduleDeliveryOutboxFlush(delayMs = config.deliveryRetryIntervalSeconds * 1000) {
  if (stopping) return;
  const delayValue = Math.max(0, Number(delayMs) || 0);
  runtimeTimers.schedule("delivery-outbox", () => {
    void flushDeliveryOutbox();
  }, delayValue, { replaceIfEarlier: true });
}

async function flushDeliveryOutbox() {
  try {
    const result = await deliveryOutbox.flush();
    if (result.delivered) {
      console.log(`Delivered ${result.delivered} queued Telegram message(s); remaining: ${result.remaining}.`);
    }
  } catch (error) {
    console.error("Cannot flush Telegram delivery outbox:", error.message);
  } finally {
    scheduleDeliveryOutboxFlush();
  }
}

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

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stopRuntimeTimers() {
  stopTyping();
  contextCompactions.dispose();
  runtimeTimers.clearAll();
  deferredInputController.stop();
  for (const run of taskRuns.values()) {
    taskProgress.pause(run);
    taskObserver.pause(run);
    claudeRunController.pause(run);
  }
}

function startRuntimeTimers() {
  codexContextMaintenance.schedulePeriodic();
  for (const item of queuedInputs.values()) scheduleQueuedInput(item, 500);
  if (config.telegramEnabled) {
    scheduleDeliveryOutboxFlush(1_000);
  }
  selectedTaskWatch.schedule(500);
  scheduleCodexTerminalAudit(500);
  rateLimitTelemetry.schedule(1_000);
}

const { startAgentHub, shutdownAgentHub } = createRuntimeLifecycleComposition({
  telegramEnabled: config.telegramEnabled,
  beginStopping: () => {
    if (stopping) return false;
    stopping = true;
    return true;
  },
  stopRuntimeTimers,
  stopManagedRuns: () => {
    for (const run of taskRuns.values()) {
      agentProviders.call(run.provider, "stopManagedRunForShutdown", run);
    }
  },
  stopMedia: () => mediaController.stop(),
  runtimeResources,
  // The control endpoint is intentionally available before provider recovery,
  // so clients can show cached state while providers are still reconnecting.
  startControlPlane: async () => {
    desktopControlServer = new DesktopControlServer({
      runtimeRoot: runtimeCommandRoot,
      handler: handleDesktopControl,
      protectSecret: process.env.AGENT_HUB_DISABLE_SECRET_ACL === "1"
        ? async () => {}
        : undefined,
    });
    await desktopControlServer.start();
    await runtimeCommandServer.start();
  },
  startMiniApp: () => miniAppLifecycle.start(),
  sanitizeRollouts: () => codexContextMaintenance.runPeriodic({ reschedule: false }),
  initializeProvider,
  providerIsRunning: () => codexTransport.running,
  backfillProviderMetadata: () => codexProviderTasks.discoverTasks()
    .then((threads) => backfillWorkLogPricingMetadata(threads)),
  recoverRuns: (...args) => runRecovery.recoverAll(...args),
  retryNotifications: retryPendingTurnEndNotifications,
  restoreBackgroundJobs: () => backgroundJobs.restore(),
  startTimers: startRuntimeTimers,
  registerTelegramCommands: () => telegram("setMyCommands", { commands: BOT_COMMANDS }),
  hasPendingRestart: () => Boolean(restartRequest),
  finalizeRestart: finalizeRestartMessage,
  markReady: () => instanceGuard.markReady(),
  readyMessage: () => (
    `Agent Hub ready; components: ${Object.entries(config.components).filter(([, enabled]) => enabled).map(([name]) => name).join(", ") || "core"}; provider: ${providerTitle()}; project: ${activeProjectRoot}`
  ),
  pollTelegram,
  warnUser: (message) => sendMessage(message).catch(() => {}),
});

export { startAgentHub, shutdownAgentHub };
