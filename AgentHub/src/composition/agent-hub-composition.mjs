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
import {
  claudeResultEstimatedCredits,
  claudeResultTokenUsage,
  scanClaudeHistoricalTranscriptFile,
} from "../providers/claude/claude-work-log.mjs";
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
import { readClaudeSessionSnapshot } from "../../last-message.mjs";
import * as approvalProtocol from "../providers/codex/codex-approvals.mjs";
const { formatPermissionsApproval, parseApprovalCallback } = approvalProtocol;
import { contextualCallback } from "../interfaces/telegram/callback-context.mjs";
import { taskViewCallbackData } from "../interfaces/telegram/task-view-callback.mjs";
import { writeTextAtomic } from "../infrastructure/persistence/state-store.mjs";
import {
  catalogEntryIsSelected,
  mergeTaskCatalog,
  readCodexRolloutActivity,
  TASK_EXECUTION_OWNERS,
  taskExecutionRuntimeLabel,
  taskOrderingActivityAtMs,
} from "../../task-catalog.mjs";
import {
  codexObservedRuntimeActive,
  resolveCodexTaskActivity,
  resolveCodexObservedExecutionOwner,
} from "../providers/codex/codex-runtime-owner.mjs";
import { conciseTurnTitle } from "../application/turn-title.mjs";
import { defaultRuntimeRoot } from "../infrastructure/filesystem/runtime-layout.mjs";
import { TelegramTaskPickerService } from "../interfaces/telegram/task-picker.mjs";
import {
  approvalModeKeyboard as presentApprovalModeKeyboard,
  formatApprovalMode as presentApprovalMode,
  formatCommandApproval as presentCommandApproval,
  formatFileApproval as presentFileApproval,
} from "../interfaces/telegram/approval-presentation.mjs";
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
import { TaskIdentityResolver } from "../application/task-identity-resolver.mjs";
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
import { createRunObservationComposition } from "./run-observation-composition.mjs";
import { createTaskViewComposition } from "./task-view-composition.mjs";
import { createRuntimeRestartComposition } from "./runtime-restart-composition.mjs";
import { createDesktopReadSystemWiring } from "./desktop-read-system-wiring-composition.mjs";
import { createDesktopCommandWiring } from "./desktop-command-wiring-composition.mjs";
import { createDesktopRunRouterWiring } from "./desktop-run-router-wiring-composition.mjs";
import { createRuntimeDataComposition } from "./runtime-data-composition.mjs";
import { createBackgroundWorkComposition } from "./background-work-composition.mjs";
import { createRuntimeStateRestorationComposition } from "./runtime-state-restoration-composition.mjs";
import { runStartupMaintenance } from "./startup-maintenance-composition.mjs";
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
let agentHubBootstrapComposition = null;

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
let runAdmissionComposition = null;
let deferredInputController = null;
let runtimeCommandRoutingComposition = null;
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
  getProjectRoot: () => activeProjectRoot,
  stopProcessTree,
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
const {
  managedRunLifecycle,
  turnEndDelivery,
  codexRunFinalizer,
} = createRunCompletionComposition({
  config,
  taskRuns,
  currentTarget: () => ({
    provider: activeProvider,
    projectRoot: activeProjectRoot,
    threadId,
    taskTitle: activeThreadTitle,
    chatId,
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
  turnEndNotifications,
  runJournal,
  lastSeenTaskTurnIds,
  codexTurnStarts,
  discardManualContextCompactionRun,
  finalizeRunDelivery,
  refreshTaskDiff,
  runTaskTitle,
  currentChatId: () => chatId,
  defaultNotificationChatId,
  changedFilesForRun,
  persistManagedRunHistory,
});
const codexContextMaintenance = createCodexContextMaintenanceComposition({
  config,
  runtimeTimers,
  contextCompactions,
  sanitizer: codexRolloutContextSanitizer,
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
  getActiveThreadTitle: () => activeThreadTitle,
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
const providerStartup = createProviderStartupComposition({
  config,
  threadListLimit: THREAD_LIST_LIMIT,
  selectionStore,
  taskRuns,
  agentProviders,
  codexProviderTasks,
  getProvider: () => activeProvider,
  getProjectRoot: () => activeProjectRoot,
  getThreadId: () => threadId,
  isCodex,
  startCodex: startCodexAppServer,
  initializeCodex,
  sendRpc,
  resolveResumedCodexThreadTitle,
  applyCodexThreadSettings,
  saveState,
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
const {
  deliveryOutbox,
  scheduleDeliveryOutboxFlush,
} = await createDeliveryOutboxComposition({
  directoryPath: DELIVERY_OUTBOX_DIR,
  retryIntervalMs: config.deliveryRetryIntervalSeconds * 1000,
  runtimeTimers,
  isStopping: () => stopping,
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

const {
  runtimeStateCoordinator,
  stateLoadFailed,
  restoredState: restoredRuntimeState,
} = await createRuntimeStateRestorationComposition({
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
    getChatId: () => chatId,
    getUpdateOffset: () => updateOffset,
    getRestartRequest: () => restartRequest,
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
});
let restoredTurnEndSnapshot = {};
if (restoredRuntimeState) {
  chatId = restoredRuntimeState.chatId;
  updateOffset = restoredRuntimeState.updateOffset;
  restartRequest = restoredRuntimeState.restartRequest;
  replaceCodexHookReceipts(restoredRuntimeState.codexHookReceipts);
  restoredTurnEndSnapshot = restoredRuntimeState.restoredTurnEndSnapshot;
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

await runStartupMaintenance({
  config,
  stateLoadFailed,
  taskRuns,
  pinnedTaskTitlesFile: PINNED_TASK_TITLES_FILE,
  taskMetadata,
});

const codexLifecycle = createCodexLifecycleComposition({
  config,
  rpcTimeoutMs: CODEX_RPC_TIMEOUT_MS,
  runtimeDependencies: {
    getActiveProjectRoot: () => activeProjectRoot,
    stopProcessTree,
    handleMessage: handleCodexMessage,
    isStopping: () => stopping,
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
const { runtime: codexRuntime, transport: codexTransport, controller: codexLifecycleController } = codexLifecycle;
runtimeCommandRoutingComposition = createRuntimeCommandRoutingComposition({
  pinnedTaskTitle,
  codexThreadResponseTitle,
  runTaskTitle,
  getTaskCatalog: () => taskCatalog,
  getActiveProvider: () => activeProvider,
  getThreadId: () => threadId,
  getActiveThreadTitle: () => activeThreadTitle,
  threadTitle,
  storedCodexThreadTitle,
  runtimeNotificationController,
  codexLifecycleController,
});

async function startCodexAppServer() {
  await codexLifecycle.start();
}

async function stopCodexAppServerTree() {
  await codexLifecycle.stop();
}

async function restartCodexAfterCrash() {
  return codexLifecycle.restartAfterCrash();
}

function sendRpc(method, params = {}, { timeoutMs = CODEX_RPC_TIMEOUT_MS } = {}) {
  return codexLifecycle.sendRpc(method, params, { timeoutMs });
}

function invalidateCodexThreadRead(threadId) {
  codexLifecycle.invalidateThreadRead(threadId);
}

function readCodexThread(threadId, options = {}) {
  return codexLifecycle.readThread(threadId, options);
}

function sendNotification(method, params = {}) {
  codexLifecycle.sendNotification(method, params);
}

function respondRpc(id, result) {
  codexLifecycle.respondRpc(id, result);
}

async function initializeProvider() {
  return providerStartup.initializeProvider();
}

async function initializeCodex({ attachSelectedThread = true } = {}) {
  return codexLifecycle.initialize({ attachSelectedThread });
}

async function attachCodexThread() {
  return providerStartup.attachCodexThread();
}

async function createThread() {
  return providerStartup.createThread();
}

async function listThreads() {
  return providerStartup.listThreads();
}

function isWorkspaceThread(thread) {
  return providerStartup.isWorkspaceThread(thread);
}

function threadTitle(thread) {
  return providerStartup.threadTitle(thread);
}

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

let desktopCommands;
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
    activeProvider: () => activeProvider,
    activeProjectRoot: () => activeProjectRoot,
    activeThreadTitle: () => activeThreadTitle,
    autoApprove: () => autoApprove,
    chatId: () => chatId,
    threadId: () => threadId,
    isCodex,
    hasThread: () => Boolean(threadId),
    selectedTask,
    selectedTurnTarget,
    activeProject,
    restartRequest: () => restartRequest,
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
    resolveTask: (...args) => desktopCommands.desktopSnapshotActions.messageTarget(...args),
    lastTaskMessage: savedLastTaskMessageRecord,
    enqueueSpeech: (target, text) => backgroundJobs.enqueue(
      "speech",
      { chatId, text },
      chatId,
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
    readCachedHistory: (binding) => taskViewController.readHistory(binding, { cachedOnly: true }),
    refreshHistory: (binding) => taskViewController.readHistory(binding),
    attachmentImporter: importCodexDesktopAttachments,
    warn: (...args) => console.warn(...args),
  },
});

function trustedDeviceUserId(context) {
  return resolveDesktopTrustedDeviceUserId(context);
}

desktopCommands = createDesktopCommandWiring({
  models: {
    reasoningEfforts: CODEX_REASONING_EFFORTS,
    collaborationModes: CODEX_COLLABORATION_MODES,
  },
  projects: PROJECTS,
  state: {
    activeProvider: () => activeProvider,
    activeProjectRoot: () => activeProjectRoot,
    activeTaskTitle: () => activeThreadTitle,
    autoApprove: () => autoApprove,
    setAutoApprove: (value) => { autoApprove = value; },
    chatId: () => chatId,
    threadId: () => threadId,
    updateOffset: () => updateOffset,
    processingUpdateId: () => processingUpdateId,
    restartRequest: () => restartRequest,
    setRestartRequest: (value) => { restartRequest = value; },
    latestDiff: () => latestDiff,
    setLatestDiff: (value) => { latestDiff = value; },
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
      setLatest: (value) => { latestDiff = value; },
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
    chatId: () => chatId,
    selectedTask,
    activeTaskTitle: () => activeThreadTitle,
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
    isDeferredInputProcessing: (id) => deferredInputController.isProcessing(id),
    cancelDeferredInputSchedule: (id) => deferredInputController.cancelSchedule(id),
    updateDeferredReceipt: updateDeferredDesktopReceipt,
    cleanupDeferredFiles,
    updateDeferredMessage,
    scheduleNextDeferredInput: (item) => deferredInputController.scheduleNextForTask(item),
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

function resumeThread(...args) { return telegramTaskActions.resume(...args); }

function renameCurrentTask(...args) { return telegramTaskActions.rename(...args); }

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

const {
  telegramDeliveryService,
  taskProgress,
} = createRunPresentationComposition({
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
  activeTaskTitle: () => activeThreadTitle,
  activeProjectName: () => activeProject().name,
  taskSwitchSettings,
  showLastMessageReplyMarkup,
  formatTaskSwitchMessage,
  formatTaskAlreadySelectedMessage,
  saveState,
  retainProgressMessageAfterEditError,
});

runAdmissionComposition = createRunAdmissionComposition({
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
  getActiveThreadTitle: () => activeThreadTitle,
  getChatId: () => chatId,
  taskExecutionOwners: TASK_EXECUTION_OWNERS,
  deferredInputPresentation,
  sendMessageTo,
  saveState,
});
deferredInputController = runAdmissionComposition.deferredInputController;

function resolvedExplicitSkillNames(...args) {
  return runAdmissionComposition.resolvedExplicitSkillNames(...args);
}
function discardManualContextCompactionRun(...args) {
  return runAdmissionComposition.discardManualContextCompactionRun(...args);
}
function taskExternalActivity(...args) {
  return runAdmissionComposition.taskExternalActivity(...args);
}
function launchTurn(...args) { return runAdmissionComposition.launchTurn(...args); }
function startTurn(...args) { return runAdmissionComposition.startTurn(...args); }
function cleanupDeferredFiles(...args) {
  return runAdmissionComposition.cleanupDeferredFiles(...args);
}
function updateDeferredMessage(...args) {
  return deferredInputPresentation.updateTelegramMessage(...args);
}
function updateDeferredDesktopReceipt(...args) {
  return deferredInputPresentation.updateDesktopReceipt(...args);
}
function scheduleQueuedInput(...args) {
  return runAdmissionComposition.scheduleQueuedInput(...args);
}

function runtimeCommandTaskTitle(...args) {
  return runtimeCommandRoutingComposition.taskTitle(...args);
}
function authorizeRuntimeCommand(...args) {
  return runtimeCommandRoutingComposition.authorize(...args);
}
function reconcileRuntimeCommand(...args) {
  return runtimeCommandRoutingComposition.reconcile(...args);
}
function handleRuntimeCommand(...args) {
  return runtimeCommandRoutingComposition.handle(...args);
}
async function refreshTaskDiff(run) {
  if (!run) return "";
  const captured = await taskGitDiff(run.gitBaseline, config.dataDir, run.id);
  if (captured !== null) run.latestDiff = captured;
  await persistTaskDiff(taskRunKey(run), run.latestDiff ?? "");
  if (isSelectedRun(run)) latestDiff = run.latestDiff ?? "";
  return run.latestDiff ?? "";
}

const {
  claudeRunController,
  taskObserver,
  claudeTurnLauncher,
  runRecovery,
  selectedTaskWatch,
} = createRunObservationComposition({
  dataDir: config.dataDir,
  claudeOutputPollIntervalMs: CLAUDE_OUTPUT_POLL_INTERVAL_MS,
  taskRuns,
  isStopping: () => stopping,
  handleClaudeStreamEvent,
  finishClaudeRun,
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
  autoApprove: () => autoApprove,
  persistClaudeRunHistory,
  resolveClaudeInvocation,
  logWarning: (...args) => console.warn(...args),
  safelyDeliverRunMessage,
  sendRunMessage,
  dismissedExternalTasks,
  lastSeenTaskTurnIds,
  runtimeTimers,
  selectedTaskWatchIntervalMs: SELECTED_TASK_WATCH_INTERVAL_MS,
  selectedTask,
  chatId: () => chatId,
  activeTaskTitle: () => activeThreadTitle,
  rememberLastTaskMessage,
  logError: (...args) => console.error(...args.map((value) => value?.message ?? value)),
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

const taskViewController = createTaskViewComposition({
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
  taskProgress,
  taskObserver,
  findMessageBinding: (targetChatId, messageId) => (
    findMessageBinding(config.dataDir, targetChatId, messageId)
  ),
  taskCatalog: () => taskCatalog,
  refreshTaskCatalog,
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

const {
  restartNotifications,
  runtimeResources,
  runtimeRestart,
} = createRuntimeRestartComposition({
  getRestartRequest: () => restartRequest,
  setRestartRequest: (value) => { restartRequest = value; },
  isStopping: () => stopping,
  setStopping: (value) => { stopping = value; },
  beginStopping: () => {
    if (stopping) return false;
    stopping = true;
    return true;
  },
  sendMessage: sendMessageTo,
  telegram,
  saveState,
  formatRestartCompleteMessage,
  completeMessageState: () => ({
    provider: providerTitle(),
    task: activeThreadTitle || (threadId ? `${providerTitle()} · ${threadId.slice(0, 8)}` : "Не выбрана"),
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
  desktopControlServer: () => agentHubBootstrapComposition?.desktopControlServer() ?? null,
  runtimeCommandServer,
  instanceGuard,
  workLogUsageStore,
  rateLimitHistoryStore,
  taskReadStateStore,
  runtimeStateStore,
  updateOffset: () => updateOffset,
  hasBlockingWork: restartHasBlockingWork,
  setWaiting: (value) => { restartRequest.waitingForRuns = value; },
  stopRuntimeTimers,
  agentHubRoot: AGENT_HUB_ROOT,
  instanceLockFile: INSTANCE_LOCK_FILE,
  isCodex,
  taskRuns,
  startCodexAppServer,
  initializeCodex,
  runRecovery,
  updateRestartMessage: (message) => restartNotifications.update(message),
  startRuntimeTimers,
  delay,
});

function restartMessageIsEditable(...args) { return restartNotifications.editable(...args); }
function announceDesktopRestart(...args) { return restartNotifications.announceDesktop(...args); }
function updateRestartMessage(...args) { return restartNotifications.update(...args); }
function finalizeRestartMessage(...args) { return restartNotifications.finalize(...args); }

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

agentHubBootstrapComposition = createAgentHubBootstrapComposition({
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
  hasPendingRestart: () => Boolean(restartRequest),
  finalizeRestart: finalizeRestartMessage,
  markReady: () => instanceGuard.markReady(),
  readyMessage: () => (
    `Agent Hub ready; components: ${Object.entries(config.components).filter(([, enabled]) => enabled).map(([name]) => name).join(", ") || "core"}; provider: ${providerTitle()}; project: ${activeProjectRoot}`
  ),
  pollTelegram,
  warnUser: (message) => sendMessage(message).catch(() => {}),
  beginStopping: () => {
    if (stopping) return false;
    stopping = true;
    return true;
  },
});
const { startAgentHub, shutdownAgentHub } = agentHubBootstrapComposition;

export { startAgentHub, shutdownAgentHub };
