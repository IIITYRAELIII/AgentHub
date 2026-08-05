import { mkdir, readFile, unlink } from "node:fs/promises";
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
} from "./config.mjs";
import { parseClaudeLimits } from "./src/providers/claude/claude.mjs";
import {
  claudeResultEstimatedCredits,
  claudeResultTokenUsage,
  scanClaudeHistoricalTranscriptFile,
} from "./src/providers/claude/claude-work-log.mjs";
import {
  cleanupOrphanedClaudeRunOutputs,
  processIsAlive,
  stopProcessTree,
} from "./src/providers/claude/claude-run-io.mjs";
import { ClaudeRunController } from "./src/providers/claude/claude-run-controller.mjs";
import { ClaudeTurnLauncher } from "./src/providers/claude/claude-turn-launcher.mjs";
import {
  CODEX_COLLABORATION_MODE_LABELS,
  CODEX_COLLABORATION_MODES,
  CODEX_REASONING_EFFORTS,
  CODEX_REASONING_LABELS,
  resolveCodexThreadSettings,
} from "./src/providers/codex/codex-settings.mjs";
import {
  codexThreadSandboxSettings,
} from "./src/providers/codex/codex-sandbox.mjs";
import {
  formatArchiveMessage,
  formatProgressHeading,
  formatRestartCompleteMessage,
  formatTaskAlreadySelectedMessage,
  formatTaskSwitchMessage,
  showLastMessageReplyMarkup,
} from "./status.mjs";
import {
  discoverCodexRollouts,
  discoverCodexSubagentRollouts,
  findCodexRolloutPath,
  readCodexRolloutSession,
  readCodexSubagentSpawn,
  readCodexTurnUsage,
  scanCodexHistoricalRollout,
  scanCodexTurnPricingMetadata,
} from "./src/providers/codex/codex-turn-usage.mjs";
import { CodexTerminalAudit } from "./src/providers/codex/codex-terminal-audit.mjs";
import { CodexTerminalReconciliationService } from "./src/providers/codex/codex-terminal-reconciliation-service.mjs";
import { scanCodexHistoricalRolloutInWorker } from "./src/providers/codex/codex-historical-backfill.mjs";
import { resolveCodexJournalProject } from "./src/providers/codex/codex-journal-project.mjs";
import { RateLimitHistoryStore } from "./rate-limit-history.mjs";
import { RateLimitTelemetryService } from "./src/application/rate-limit-telemetry-service.mjs";
import { CODEX_AUDIT_SOURCE_KINDS } from "./src/providers/codex/codex-subagent-accounting.mjs";
import { CodexRunFinalizer } from "./src/providers/codex/codex-run-finalizer.mjs";
import { CodexContextMaintenanceService } from "./src/providers/codex/codex-context-maintenance-service.mjs";
import { CodexUsageTracker } from "./src/providers/codex/codex-usage-tracker.mjs";
import { randomStatusHeaderFileName } from "./status-header.mjs";
import { TelegramClient } from "./telegram-client.mjs";
import { emptyTokenUsage } from "./token-usage.mjs";
import { telegramPrompt } from "./telegram-message.mjs";
import {
  forwardBundleAttachmentPaths,
  restoreForwardBundle,
  TelegramForwardBundleController,
} from "./telegram-forward-bundle.mjs";
import {
  captureTaskGitBaseline,
  cleanupTaskGitIndexes,
  resolveTaskGitRepoRoots,
  taskGitDiff,
} from "./task-git-diff.mjs";
import { TaskDiffStore } from "./task-diff-store.mjs";
import { findRepositoryWriteConflict } from "./repository-conflict.mjs";
import {
  deferredInputMatchesRun,
  deferredEditableText,
  deferredResponseAnnotations,
  pendingInputKeyboard,
  replaceDeferredInputText,
  restoreDeferredInput,
} from "./src/domain/deferred-input.mjs";
import {
  appendMessageBindings,
  findMessageBinding,
  migrateMessageBindings,
  readMessageBindings,
  removeMessageBindings,
} from "./message-bindings.mjs";
import {
  readCodexThreadTitleHistories,
  readCodexThreadTitleHistory,
  resolveChatId as resolveNotificationChatId,
  showMessageReplyMarkup,
} from "./send-message.mjs";
import {
  formatProgressHeartbeat,
  markProgressHeartbeat,
  PROGRESS_STALLED_AFTER_MS,
  retainProgressMessageAfterEditError,
} from "./progress-heartbeat.mjs";
import {
  serializableTaskRun,
  TaskDismissalRegistry,
  TaskRunRegistry,
  taskRunIsActive,
  taskRunKey,
  updateTaskRunTitle,
} from "./src/domain/task-runs.mjs";
import {
  codexFinalTurnAnswer,
  listClaudeSessionSnapshots,
  readClaudeSessionSnapshot,
} from "./last-message.mjs";
import {
  mergeActiveTaskHistory,
  mergeCompletedTaskHistory,
} from "./task-history.mjs";
import {
  formatPermissionsApproval,
  parseApprovalCallback,
} from "./src/providers/codex/codex-approvals.mjs";
import { contextualCallback } from "./callback-context.mjs";
import { taskViewCallbackData } from "./task-view-callback.mjs";
import { PersistentDeliveryOutbox } from "./delivery-outbox.mjs";
import { installRotatingConsole } from "./rotating-log.mjs";
import { writeTextAtomic } from "./state-store.mjs";
import { RuntimeStateStore } from "./src/infrastructure/persistence/runtime-state-store.mjs";
import { TaskReadStateStore, taskHasUnreadAnswer } from "./task-read-state-store.mjs";
import { LocalTaskSyncStore } from "./task-sync-store.mjs";
import { MessageReceiptRegistry } from "./message-receipts.mjs";
import { createDesktopMessageController } from "./src/interfaces/desktop/desktop-message-controller.mjs";
import { createTrustedDeviceManager, resolveTrustedDeviceUserId } from "./trusted-device-access.mjs";
import { TrustedDeviceStore } from "./trusted-device-store.mjs";
import { unavailableLocalMcpOverrides } from "./local-mcp-preflight.mjs";
import { SingleInstanceGuard } from "./instance-lock.mjs";
import { BackgroundJobQueue } from "./background-job-queue.mjs";
import { PersistentBackgroundJobController } from "./background-job-controller.mjs";
import { PersistentBackgroundJobStore } from "./background-job-store.mjs";
import { FailedTelegramUpdateStore } from "./failed-update-store.mjs";
import { resolveClaudeInvocation as resolveInstalledClaudeInvocation } from "./src/providers/claude/claude-invocation.mjs";
import {
  catalogEntryIsSelected,
  catalogEntriesWithoutLiveActivity,
  catalogTaskKey,
  claudeCatalogEntry,
  claudeSnapshotActivityAtMs,
  claudeSnapshotActivityState,
  codexRolloutTurnState,
  codexCatalogEntry,
  mergeTaskCatalog,
  preferredCodexTaskTitle,
  readCodexRolloutActivity,
  selectCodexTurn,
  selectExactActiveCodexTurnId,
  statusTaskEntries,
  TASK_EXECUTION_OWNERS,
  taskExecutionRuntimeLabel,
  normalizeTaskExecutionOwner,
  taskOrderingActivityAtMs,
  taskCatalogTitleSignature,
} from "./task-catalog.mjs";
import {
  codexObservedRuntimeActive,
  resolveCodexTaskActivity,
  resolveCodexObservedExecutionOwner,
} from "./src/providers/codex/codex-runtime-owner.mjs";
import { CodexRolloutContextSanitizer } from "./src/providers/codex/codex-rollout-context.mjs";
import {
  botReplacementInvocation,
  directWindowsLauncherInvocation,
  launchReplacementAndWait,
} from "./runtime-restart.mjs";
import {
  finalizeSuccessfulReplacement,
  restorePreviousBotAfterFailedReplacement,
} from "./restart-recovery.mjs";
import { RuntimeCommandServer } from "./runtime-command.mjs";
import { RuntimeNotificationController } from "./runtime-notification-controller.mjs";
import { captureProcess } from "./process-capture.mjs";
import { CodexLifecycleController } from "./src/providers/codex/codex-lifecycle-controller.mjs";
import {
  TurnEndNotificationRegistry,
  turnEndKey,
} from "./turn-end-notifications.mjs";
import { conciseTurnTitle } from "./turn-title.mjs";
import { DesktopControlServer } from "./desktop-control.mjs";
import { defaultRuntimeRoot } from "./runtime-layout.mjs";
import { MediaController } from "./media-controller.mjs";
import { TelegramMessageController } from "./src/interfaces/telegram/telegram-message-controller.mjs";
import { ApprovalController } from "./approval-controller.mjs";
import { TelegramCallbackController } from "./src/interfaces/telegram/telegram-callback-controller.mjs";
import { routeTelegramCallback } from "./src/interfaces/telegram/telegram-callback-router.mjs";
import { buildTaskPicker } from "./task-picker.mjs";
import { TaskViewController } from "./task-view-controller.mjs";
import { TelegramPollingController } from "./src/interfaces/telegram/telegram-polling-controller.mjs";
import { TelegramSettingsMenu } from "./src/interfaces/telegram/telegram-settings-menu.mjs";
import { TelegramStatusController } from "./src/interfaces/telegram/telegram-status-controller.mjs";
import { resolveCodexExecutable as resolveInstalledCodexExecutable } from "./src/providers/codex/codex-invocation.mjs";
import { CodexAppServerLifecycle } from "./src/providers/codex/codex-app-server-lifecycle.mjs";
import { CodexAccountingResolver } from "./src/providers/codex/codex-accounting-resolver.mjs";
import { createCodexAssistantAttachmentImporter } from "./src/providers/codex/codex-assistant-attachments.mjs";
import { TaskProgressController } from "./src/interfaces/telegram/task-progress-controller.mjs";
import { TaskObservationService } from "./src/application/task-observation-service.mjs";
import { ProviderTaskActivityService } from "./src/application/provider-task-activity-service.mjs";
import { SelectedTaskWatchService } from "./src/application/selected-task-watch-service.mjs";
import {
  DeferredInputController,
  isRetryableDeferredLaunchError,
} from "./src/application/deferred-input-controller.mjs";
import { WorkLogUsageStore } from "./work-log-usage.mjs";
import { miniAppMenuButtonRequests, MiniAppServer } from "./mini-app-server.mjs";
import { MiniAppPublisher } from "./mini-app-publisher.mjs";
import { DirectGatewayController, loadDirectGatewaySettings } from "./direct-gateway.mjs";
import { QuickTunnelController } from "./quick-tunnel.mjs";
import { ensureLocalWebSecret } from "./local-web-auth.mjs";
import { fitTaskHistoryPayload } from "./response-budget.mjs";
import { RuntimeLifecycleController } from "./src/runtime/runtime-lifecycle-controller.mjs";
import { RuntimeResourceRegistry } from "./src/runtime/runtime-resource-registry.mjs";
import { RuntimeRestartController } from "./src/runtime/runtime-restart-controller.mjs";
import { RunCoordinator } from "./src/application/run-coordinator.mjs";
import { createAgentProviderRegistry } from "./src/providers/provider-adapters.mjs";
import { ClaudeProviderTaskService, CodexProviderTaskService } from "./src/providers/provider-task-service.mjs";
import { appendRunActivity, codexItemActivity } from "./src/domain/run-activity.mjs";
import {
  commandClientContext,
  commandTaskTarget,
  createApplicationCommandService,
} from "./application-command-service.mjs";
import { DesktopAttachmentService } from "./src/interfaces/desktop/desktop-attachment-service.mjs";
import { TelegramSettingsCallbackService } from "./src/interfaces/telegram/telegram-settings-callbacks.mjs";
import { TelegramTaskCallbackService } from "./src/interfaces/telegram/telegram-task-callbacks.mjs";
import { TelegramInputCallbackService } from "./src/interfaces/telegram/telegram-input-callbacks.mjs";
import { ClaudeCompletionService, CodexCompletionService } from "./src/providers/provider-completion-services.mjs";
import { ClaudeRecoveryService, CodexRecoveryService } from "./src/providers/provider-recovery-services.mjs";
import { ClaudeTaskSnapshotService } from "./src/providers/claude/claude-task-snapshot-service.mjs";
import { CodexTurnService, ProviderCancellationService, unsupportedProviderSteer } from "./src/providers/provider-turn-services.mjs";
import { TelegramCommandService } from "./src/interfaces/telegram/telegram-command-service.mjs";
import { CodexEventService } from "./src/providers/codex/codex-event-service.mjs";
import {
  CodexTaskSnapshotService,
  codexTurnSnapshot,
  codexTurnStartedAt,
  describeCodexItem, recoveredCodexAnswer,
} from "./src/providers/codex/codex-task-snapshot-service.mjs";
import { ClaudeEventService } from "./src/providers/claude/claude-event-service.mjs";
import { ClaudeCatalogProjectionService, CodexCatalogProjectionService } from "./src/providers/provider-catalog-services.mjs";
import { DesktopDeferredInputService } from "./src/interfaces/desktop/desktop-deferred-input-service.mjs";
import { DesktopSettingsService } from "./src/interfaces/desktop/desktop-settings-service.mjs";
import { ProviderTaskCatalogBuilder } from "./src/providers/provider-task-catalog-builder.mjs";
import { TaskCatalogService } from "./task-catalog-service.mjs";
import { TaskSelectionStore } from "./src/application/task-selection-store.mjs";
import { createDesktopSnapshotFactory } from "./src/interfaces/desktop/desktop-snapshot.mjs";
import { createDesktopTaskHistoryFactory } from "./src/interfaces/desktop/desktop-task-history.mjs";
import { createDesktopApplicationRouter } from "./src/interfaces/desktop/desktop-application-router.mjs";
import { UsdRubRateStore } from "./exchange-rate.mjs";
import { agentHubAutostartShortcut } from "./server-page.mjs";
import {
  defaultAutostartInstallScript,
  ServerControlController,
} from "./server-control-controller.mjs";
import {
  ContextCompactionTracker,
  isContextCompactionItem,
} from "./src/providers/codex/context-compaction-tracker.mjs";
import { RunProgressPresentation } from "./src/application/run-progress-presentation.mjs";
import { AgentHubStartupCoordinator } from "./src/application/agent-hub-startup-coordinator.mjs";
import { RuntimeTimerCoordinator } from "./src/runtime/runtime-timer-coordinator.mjs";
import { RunJournalService } from "./run-journal-service.mjs";
import {
  TurnEndDeliveryService,
  fallbackTurnEndMessage,
} from "./turn-end-delivery-service.mjs";
import { AgentPreferencesStore } from "./src/application/agent-preferences-store.mjs";
import { DeferredInputStore } from "./src/application/deferred-input-store.mjs";
import { DeferredInputService } from "./src/application/deferred-input-service.mjs";
import {
  ManagedRunLifecycleService,
  runInputPreview,
} from "./src/application/managed-run-lifecycle-service.mjs";
import { RunRecoveryCoordinator } from "./src/application/run-recovery-coordinator.mjs";
import { RunConflictPolicy } from "./src/application/run-conflict-policy.mjs";
import {
  createHubRuntimeSnapshot,
  HubRuntimeStateCoordinator,
  restoreHubRuntimeSnapshot,
} from "./src/application/hub-runtime-state-coordinator.mjs";
import { TaskMetadataStore } from "./src/application/task-metadata-store.mjs";
import { TaskIdentityResolver } from "./src/application/task-identity-resolver.mjs";

if (process.platform === "win32") dns.setDefaultResultOrder("ipv4first");

const config = await loadConfig();
const serverStartedAt = new Date().toISOString();
const serverInstanceId = randomUUID();
const serverReleaseId = path.basename(import.meta.dirname);
const globalWorkLogProjectRoots = config.projects.map((project) => project.path);
const journalDatabaseFile = path.join(config.dataDir, "journal.sqlite");
const legacyWorkLogLedgerFile = path.join(config.dataDir, "work-log-usage.json");
const legacyWorkLogFile = path.join(config.projectRoot, "WORK_LOG.md");
const runtimeCommandRoot = process.env.AGENT_HUB_RUNTIME_ROOT
  ?? (process.env.AGENT_HUB_CONFIG
    ? path.dirname(config.configPath)
    : defaultRuntimeRoot());
const agentHubAutostartShortcutPath = agentHubAutostartShortcut({ environment: process.env });
const localWebSecret = config.miniApp.enabled
  ? await ensureLocalWebSecret(path.join(runtimeCommandRoot, "local-web.secret"))
  : "";
const trustedDeviceStore = new TrustedDeviceStore({
  filePath: path.join(config.dataDir, "trusted-devices.json"),
});
await trustedDeviceStore.load();
const codexRolloutContextSanitizer = new CodexRolloutContextSanitizer({
  ...config.codexRolloutContext,
});
const workLogUsageStore = new WorkLogUsageStore({
  ledgerFile: legacyWorkLogLedgerFile,
  databaseFile: journalDatabaseFile,
  defaultProjectRoot: config.projectRoot,
});
const miniAppServer = config.miniApp.enabled
  ? new MiniAppServer({
    ...config.miniApp,
    botToken: config.token,
    allowedUserIds: config.allowedUserIds,
    localAccessSecret: localWebSecret,
    deviceStore: trustedDeviceStore,
    controlHandler: handleDesktopControl,
    attachmentDirectory: path.join(runtimeCommandRoot, "DesktopApp", "attachments"),
    journalDatabaseFile,
  })
  : null;
const publicMiniAppServer = config.miniApp.enabled && config.miniApp.quickTunnel.enabled
  ? new MiniAppServer({
    host: config.miniApp.host,
    port: config.miniApp.quickTunnel.publicPort,
    botToken: config.token,
    allowedUserIds: config.allowedUserIds,
    requireTelegramAuth: true,
    deviceStore: trustedDeviceStore,
    controlHandler: handleDesktopControl,
    attachmentDirectory: path.join(runtimeCommandRoot, "DesktopApp", "attachments"),
    journalDatabaseFile,
  })
  : null;
const defaultDataDirectory = path.join(AGENT_HUB_ROOT, "data");
const logDirectory = samePath(config.dataDir, defaultDataDirectory)
  ? AGENT_HUB_ROOT
  : config.dataDir;
installRotatingConsole({
  stdoutFile: path.join(logDirectory, "agent-hub.log"),
  stderrFile: path.join(logDirectory, "agent-hub-error.log"),
  maxBytes: config.logMaxBytes,
  maxFiles: config.logMaxFiles,
  mirror: process.stdout.isTTY || process.stderr.isTTY,
});
let activeProvider = config.provider === "codex" ? "codex" : "claude";
function isCodex() {
  return activeProvider === "codex";
}
function providerTitle() {
  return isCodex() ? "Codex" : "Claude Code";
}
const CLAUDE_MODELS = ["sonnet", "opus", "haiku"];
const CLAUDE_MODEL_LABELS = { sonnet: "Sonnet", opus: "Opus", haiku: "Haiku" };
// Claude использует те же уровни «мощи дум» и режимы Plan/Work, что и Codex,
// но применяет их по-своему: мощь дум -> бюджет thinking-токенов, режим -> permission-mode.
const CODEX_MODELS = config.codexModels;
const CODEX_MODEL_VALUES = new Set(CODEX_MODELS.map((model) => model.value));
function normalizeCodexModel(value) {
  return CODEX_MODEL_VALUES.has(value) ? value : CODEX_MODELS[0].value;
}
function codexModelLabel(value) {
  return CODEX_MODELS.find((model) => model.value === value)?.label ?? value;
}
const defaultCodexModel = normalizeCodexModel(config.codexModel);
const defaultCodexReasoningEffort = CODEX_REASONING_EFFORTS.includes(config.codexReasoningEffort)
  ? config.codexReasoningEffort
  : "high";
const taskMetadata = new TaskMetadataStore({
  validReasoningEfforts: CODEX_REASONING_EFFORTS,
});
const PROJECTS = config.projects;
const DEFAULT_PROJECT_ROOT = config.projectRoot;
const STATE_FILE = config.stateFile;
const STATE_BACKUP_FILE = `${STATE_FILE}.bak`;
const DELIVERY_OUTBOX_DIR = config.deliveryOutboxDir;
const BACKGROUND_JOBS_DIR = path.join(config.dataDir, "background-jobs");
const FAILED_UPDATES_DIR = path.join(config.dataDir, "failed-updates");
const INSTANCE_LOCK_FILE = path.join(config.dataDir, "bot.lock");
const PINNED_TASK_TITLES_FILE = path.join(config.dataDir, "pinned-task-titles.json");
const TASK_SYNC_FILE = path.join(config.dataDir, "task-sync.json");
const TASK_DIFFS_FILE = path.join(config.dataDir, "task-diffs.json");
const EXCHANGE_RATES_FILE = path.join(config.dataDir, "exchange-rates.json");
const TELEGRAM_LIMIT = 3900;
const THREAD_LIST_LIMIT = 10;
const TASK_PICKER_PAGE_SIZE = 8;
const MAX_DEFERRED_INPUTS = 500;
const MAX_BACKGROUND_MEDIA_JOBS = 20;
const MAX_BACKGROUND_SPEECH_JOBS = 10;
const MAX_INTERACTIVE_JOBS = 10;
const STATUS_HEADER_DIR = path.join(import.meta.dirname, "assets", "status");
const AGENT_ICONS = ["👾", "🦉", "🐙", "🕶️", "🚀", "⚡", "💻", "🔮", "🛰️", "🔥", "✨"];
const agentIcon = AGENT_ICONS[Math.floor(Math.random() * AGENT_ICONS.length)];
const BOT_COMMANDS = [
  { command: "menu", description: "Показать панель кнопок" },
  { command: "agent", description: "Переключить Claude Code/Codex" },
  { command: "model", description: "Сменить модель" },
  { command: "reasoning", description: "Сменить мощь дум (Codex/Claude)" },
  { command: "mode", description: "Переключить Plan/Work (Codex/Claude)" },
  { command: "projects", description: "Сменить активный проект" },
  { command: "new", description: "Новый контекст" },
  { command: "tasks", description: "Список задач" },
  { command: "resume", description: "Выбрать существующую задачу" },
  { command: "rename", description: "Закрепить название текущей задачи" },
  { command: "archive", description: "Архивировать текущую задачу" },
  { command: "status", description: "Статус и текущая задача" },
  { command: "approvals", description: "Режим подтверждений" },
  { command: "restart", description: "Перезапустить бота" },
  { command: "diff", description: "Последние изменения" },
  { command: "cancel", description: "Остановить текущую задачу" },
  { command: "help", description: "Справка" },
];
const BOT_MENU = {
  keyboard: [
    [{ text: `${agentIcon} Агент` },{ text: "🎛 Модель" },...(config.showProjectButton ? [{ text: "📁 Проект" }] : []),],
    [{ text: "🧠 Мощь дум" },{ text: "🛠 Plan/Work" },],
    [{ text: "📋 Задачи" },{ text: "ℹ️ Статус" },{ text: "🔐 Доступ" },],
    [{ text: "⛔ Стоп" }, { text: "❓ Помощь" }, { text: "🔄 Рестарт" }],
  ],
  resize_keyboard: true,
  is_persistent: true,
};
const MENU_COMMANDS = new Map([
  ...AGENT_ICONS.map((icon) => [`${icon} Агент`, "/agent"]),
  ["🧑‍💻 Агент", "/agent"],
  ["🤖 Движок", "/agent"],
  ["🎛 Модель", "/model"],
  ["🧠 Мощь дум", "/reasoning"],
  ["🧠 Сила дум", "/reasoning"],
  ["🛠 Plan/Work", "/mode"],
  ["📁 Папка", "/projects"],
  ["📁 Проект", "/projects"],
  ["🆕 Новая", "/new"],
  ["🆕 Новая задача", "/new"],
  ["📋 Задачи", "/tasks"],
  ["🎯 Текущая", "/current"],
  ["🧵 Поток", "/thread"],
  ["🧵 Поток Codex", "/thread"],
  ["ℹ️ Статус", "/status"],
  ["📝 Изменения", "/diff"],
  ["🔐 Доступ", "/approvals"],
  ["🔐 Подтверждения", "/approvals"],
  ["🔄 Перезапустить", "/restart"],
  ["🔄 Рестарт", "/restart"],
  ["⛔ Стоп", "/cancel"],
  ["⛔ Остановить", "/cancel"],
  ["❓ Помощь", "/help"],
]);

const token = config.token;
await mkdir(path.dirname(STATE_FILE), { recursive: true });
const usdRubRateStore = new UsdRubRateStore({ cacheFile: EXCHANGE_RATES_FILE });
await usdRubRateStore.load().catch((error) => {
  console.warn(`Cannot load cached exchange rate: ${error.message}`);
});
void usdRubRateStore.refresh().then((rate) => {
  console.log(`USD/RUB rate refreshed from CBR: ${rate.usdRub}`);
}).catch((error) => {
  console.warn(`Cannot refresh USD/RUB rate from CBR; cached value remains active: ${error.message}`);
});

const instanceGuard = new SingleInstanceGuard({ dataDir: config.dataDir, lockFile: INSTANCE_LOCK_FILE });
await instanceGuard.acquire();
const runtimeStateStore = new RuntimeStateStore({
  dataDir: config.dataDir,
  legacyFile: STATE_FILE,
  legacyBackupFile: STATE_BACKUP_FILE,
});
const taskReadStateStore = new TaskReadStateStore({ dataDir: config.dataDir });
const bindingsMigration = await migrateMessageBindings(config.dataDir);
if (bindingsMigration.imported || bindingsMigration.archived.length) {
  console.log(
    `Telegram bindings migrated to runtime.sqlite: ${bindingsMigration.count}; archived legacy paths: ${bindingsMigration.archived.length}`,
  );
}
const turnEndNotifications = new TurnEndNotificationRegistry();
const runtimeNotificationController = new RuntimeNotificationController({
  config,
  moduleRoot: import.meta.dirname,
  runProcess: captureProcess,
  stopProcess: (worker) => stopProcessTree(worker.pid),
});
const runJournal = new RunJournalService({
  usageStore: workLogUsageStore,
  findProject,
  defaultProjectRoot: config.projectRoot,
  projectionProjectRoots: globalWorkLogProjectRoots,
  legacyLedgerFile: legacyWorkLogLedgerFile,
  legacyWorkLogFile,
});
const runtimeCommandServer = new RuntimeCommandServer({
  runtimeRoot: runtimeCommandRoot,
  authorize: authorizeRuntimeCommand,
  reconcile: reconcileRuntimeCommand,
  handler: handleRuntimeCommand,
});
const rateLimitHistoryStore = new RateLimitHistoryStore({
  databaseFile: path.join(config.dataDir, "journal.sqlite"),
  rawFile: path.join(config.dataDir, "rate-limits-raw.jsonl"),
  csvFile: path.join(config.dataDir, "rate-limits.csv"),
});
const retiredRateLimitExports = await rateLimitHistoryStore.retireCompatibilityExports();
if (retiredRateLimitExports.retired) {
  console.log(
    `Retired ${retiredRateLimitExports.removed.length} legacy rate-limit export file(s)`,
  );
}
let desktopControlServer = null;

let updateOffset = 0;
let chatId = null;
let activeProjectRoot = DEFAULT_PROJECT_ROOT;
let threadId = null;
let activeThreadTitle = "";
const selectionStore = new TaskSelectionStore({
  activeProvider,
  activeProjectRoot,
  threadId,
  activeThreadTitle,
});
selectionStore.subscribe((selection) => {
  activeProvider = selection.activeProvider;
  activeProjectRoot = selection.activeProjectRoot;
  threadId = selection.threadId;
  activeThreadTitle = selection.activeThreadTitle;
});
const agentPreferences = new AgentPreferencesStore({
  selectionStore,
  taskMetadata,
  codexModels: CODEX_MODELS.map((model) => model.value),
  claudeModels: CLAUDE_MODELS,
  reasoningEfforts: CODEX_REASONING_EFFORTS,
  collaborationModes: CODEX_COLLABORATION_MODES,
  defaultCodexModel,
  defaultCodexReasoningEffort,
  defaultCodexCollaborationMode: config.codexCollaborationMode,
  defaultClaudeModel: config.claudeModel,
  defaultClaudeReasoningEffort: config.claudeReasoningEffort,
  defaultClaudeCollaborationMode: config.claudeCollaborationMode,
  normalizeCodexModel,
  resolveCodexThreadSettings,
});
let latestDiff = "";
let stopping = false;
let autoApprove = config.autoApproveOnStart;
let restartRequest = null;
let processingUpdateId = null;
let bindingWriteQueue = Promise.resolve();
const runtimeTimers = new RuntimeTimerCoordinator();
const SELECTED_TASK_WATCH_INTERVAL_MS = 2_000;
const EXTERNAL_TASK_POLL_INTERVAL_MS = 1_500;
const MANAGED_TASK_FALLBACK_POLL_INTERVAL_MS = 5_000;
const CLAUDE_OUTPUT_POLL_INTERVAL_MS = 250;
const TASK_CATALOG_CACHE_MS = 1_500;
const TASK_TITLE_RECONCILE_INTERVAL_MS = 5 * 60_000;
const CODEX_RPC_TIMEOUT_MS = config.codexRpcTimeoutSeconds * 1000;
const codexUsageTracker = new CodexUsageTracker();
const turnTokenUsage = codexUsageTracker.turns;
const codexRolloutPathsByThreadId = new Map();
const contextCompactions = new ContextCompactionTracker({
  cleanupTimeoutMs: Math.max(
    2 * 60_000,
    (config.codexRolloutContext.scanIntervalSeconds + 60) * 1_000,
  ),
  onSettled: () => scheduleDeferredRestartIfReady(),
});
const codexTurnStarts = new Map();
const codexAccounting = new CodexAccountingResolver({
  readThread: (parentThreadId) => sendRpc("thread/read", { threadId: parentThreadId, includeTurns: false }),
  findRollout: (parentThreadId) => findCodexRolloutPath(parentThreadId, ""),
  readRolloutSession: readCodexRolloutSession,
  readSubagentSpawn: readCodexSubagentSpawn,
  scanHistoricalRollout: scanCodexHistoricalRollout,
});
let codexHookReceipts = { start: null, stop: null };

function capturedCodexExecutionOwner(threadId, turnId) {
  const normalizedTurnId = String(turnId ?? "").trim();
  if (!normalizedTurnId) return null;
  const record = codexTurnStarts.get(turnEndKey({
    provider: "codex",
    threadId: String(threadId ?? "").trim(),
    turnId: normalizedTurnId,
  }));
  const owner = normalizeTaskExecutionOwner(record?.executionOwner);
  return Object.values(TASK_EXECUTION_OWNERS).includes(owner)
      && owner !== TASK_EXECUTION_OWNERS.EXTERNAL
    ? owner
    : null;
}

async function knownCodexRolloutPath(threadId, startedAt = "") {
  const key = String(threadId ?? "").trim();
  const known = String(codexRolloutPathsByThreadId.get(key) ?? "").trim();
  if (known) return known;
  if (!String(startedAt ?? "").trim()) return "";
  const discovered = await findCodexRolloutPath(key, startedAt);
  if (discovered) setBoundedMapValue(codexRolloutPathsByThreadId, key, discovered, 5_000);
  return discovered;
}

function defaultNotificationChatId() {
  return config.telegramEnabled ? resolveNotificationChatId(config, null) : null;
}

async function rememberAuditedCodexTurnStart(thread, project, turn) {
  const identity = {
    provider: "codex",
    threadId: String(thread?.id ?? "").trim(),
    turnId: String(turn?.turnId ?? "").trim(),
  };
  if (!identity.threadId || !identity.turnId) return;
  const key = turnEndKey(identity);
  const existing = codexTurnStarts.get(key);
  if (existing?.gitBaseline) return;
  const gitBaseline = await captureTaskGitBaseline(
    project.path,
    config.dataDir,
    `terminal-audit-${identity.turnId}`,
  );
  const record = {
    ...existing,
    ...identity,
    projectRoot: project.path,
    startedAt: existing?.startedAt || String(turn?.startedAt ?? ""),
    prompt: existing?.prompt || "",
    gitBaseline: gitBaseline ?? existing?.gitBaseline ?? null,
  };
  setBoundedMapValue(codexTurnStarts, key, record, 500);
  const run = taskRuns.forEvent({
    ...identity,
    allowThreadFallback: true,
  });
  if (run) {
    run.turnId ||= identity.turnId;
    run.startedAt = record.startedAt || run.startedAt;
    run.gitBaseline = record.gitBaseline ?? run.gitBaseline;
    taskRuns.reindex(run);
  }
}

const codexTerminalReconciliation = new CodexTerminalReconciliationService({
  notifications: turnEndNotifications,
  turnStarts: codexTurnStarts,
  workLogStore: workLogUsageStore,
  accountingThread: (thread) => codexAccounting.accountingThread(thread),
  subagentParentTurnId: (thread, accountingThread) => codexAccounting.subagentParentTurnId(thread, accountingThread),
  readTurnUsage: readCodexTurnUsage,
  taskGitDiff,
  dataDir: config.dataDir,
  changedFilesForRun,
  projectTurn: projectTurnUsageToWorkLog,
  taskTitle: runtimeCommandTaskTitle,
  defaultChatId: defaultNotificationChatId,
  fallbackMessage: fallbackTurnEndMessage,
  rememberLastMessage: rememberLastTaskMessage,
  rememberSeenTurn: (task, turnId) => {
    setBoundedMapValue(lastSeenTaskTurnIds, taskRunKey(task), turnId, 500);
  },
  saveState,
  deliverNotification: deliverTurnEndNotification,
});
const codexTerminalAudit = new CodexTerminalAudit({
  listPage: (cursor, limit) => sendRpc("thread/list", {
    cursor,
    limit,
    sortKey: "updated_at",
    sortDirection: "desc",
    sourceKinds: CODEX_AUDIT_SOURCE_KINDS,
  }),
  readThread: (threadId) => sendRpc("thread/read", {
    threadId,
    includeTurns: true,
  }),
  isTurnActive: async (thread, turnId) => {
    const activity = await readCodexRolloutActivity(thread?.path);
    return activity.activeTurnIds.includes(String(turnId));
  },
  onTurnStarted: rememberAuditedCodexTurnStart,
  onTurnActive: async (thread, project, turnId) => {
    const identity = {
      provider: "codex",
      threadId: String(thread?.id ?? ""),
      turnId: String(turnId),
    };
    const result = await workLogUsageStore.retractProvisionalAndProject({
      ...identity,
      projectRoot: project.path,
      projectionProjectRoots: globalWorkLogProjectRoots,
    });
    if (!result.retracted) return;
    turnEndNotifications.retract(identity);
    await saveState();
    console.log(`Retracted premature Codex terminal turn ${identity.turnId}`);
  },
  resolveProject: (thread) => resolveCodexJournalProject(thread, {
    findProject,
    readSession: readCodexRolloutSession,
    resolveParentProject: (parentThreadId) => {
      const parent = taskCatalog.find((entry) => (
        entry.provider === "codex" && String(entry.threadId) === String(parentThreadId)
      ));
      return parent ? findProject(parent.projectRoot) : null;
    },
  }),
  reconcile: (...args) => codexTerminalReconciliation.reconcile(...args),
  discoverHistoricalThreads: () => discoverCodexRollouts(),
  discoverSupplementalThreads: () => discoverCodexSubagentRollouts(),
  scanHistoricalFile: scanCodexHistoricalRolloutInWorker,
  shouldRunHistoricalBackfill: () => taskRuns.size === 0 && !restartRequest,
});
const turnTemporaryFiles = new Map();
const turnSpeechButtons = new Map();
const taskRuns = new TaskRunRegistry();
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
  rememberRolloutPath: (threadId, rolloutPath) => (
    setBoundedMapValue(codexRolloutPathsByThreadId, threadId, rolloutPath, 5_000)
  ),
  stopTransport: stopCodexAppServerTree,
  startTransport: startCodexAppServer,
  initializeTransport: initializeCodex,
  providerIsSelected: isCodex,
  setTransportRestarting: (value) => codexRuntime.setRestarting(value),
  invalidateTaskCatalog,
  restartTransportAfterCrash: restartCodexAfterCrash,
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
const lastSeenTaskTurnIds = new Map();
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
const claudeTaskSnapshots = new ClaudeTaskSnapshotService({
  readSession: readClaudeSessionSnapshot,
  findProject,
  taskRunKey,
  activityAtMs: claudeSnapshotActivityAtMs,
  activityState: claudeSnapshotActivityState,
  saveState,
  cancelledTasks: cancelledManagedClaudeTasks,
  logError: (...args) => console.error(...args),
});
const claudeEventService = new ClaudeEventService({
  isSelectedRun,
  reindexRun: (run, previous) => taskRuns.reindex(run, previous),
  setSelectedThread: (threadId, title) => selectionStore.setThread(threadId, {
    provider: "claude",
    title,
  }),
  runTitle: runTaskTitle,
  bindRunMessage,
  saveState,
  noteActivity: (...args) => taskProgress.noteActivity(...args),
  scheduleProgress: (...args) => taskProgress.schedule(...args),
  appendReasoning: (...args) => taskProgress.appendReasoning(...args),
  setStage: (...args) => taskProgress.setStage(...args),
  appendActivity: appendRunActivity,
  logError: (...args) => console.error(...args),
});
const codexTaskSnapshots = new CodexTaskSnapshotService({
  knownRolloutPath: knownCodexRolloutPath,
  readRolloutActivity: readCodexRolloutActivity,
  rolloutTurnState: codexRolloutTurnState,
  capturedOwner: capturedCodexExecutionOwner,
  runtimeActive: codexObservedRuntimeActive,
  resolveOwner: resolveCodexObservedExecutionOwner,
  readThread: readCodexThread,
  selectTurn: selectCodexTurn,
  turnSnapshot: codexTurnSnapshot,
  turnStartedAt: codexTurnStartedAt,
  describeItem: describeCodexItem,
  hubOwner: () => TASK_EXECUTION_OWNERS.HUB,
  agentHubPid: () => codexTransport.pid,
});
const codexProviderTasks = new CodexProviderTaskService({
  transportRunning: () => codexTransport.running,
  startTransport: startCodexAppServer,
  initialize: initializeCodex,
  sendRpc,
  selection: selectionStore,
  activeProjectRoot: () => activeProjectRoot,
  sandboxMode: () => config.codexSandboxMode,
  invalidateCatalog: invalidateTaskCatalog,
  restoreSettings: restoreCodexTaskSettings,
  updateSettings: updateActiveCodexThreadSettings,
  clearLatestDiff: () => { latestDiff = ""; },
  saveState,
});
const claudeProviderTasks = new ClaudeProviderTaskService({
  selection: selectionStore,
  clearLatestDiff: () => { latestDiff = ""; },
  saveState,
});
const codexCompletionService = new CodexCompletionService({
  runForTask: (run) => taskRuns.forTask(run),
  consumeTracker: consumeTurnTokenTracker,
  waitForCompletion: waitForTurnEndCompletion,
  readThread: readCodexThread,
  readTurnUsage: readCodexTurnUsage,
  applyRolloutContext: applyCodexRolloutContext,
  finalizeDelivery: finalizeCodexRunDelivery,
  finishProgress: (...args) => taskProgress.finish(...args),
  completedAnswer: completedCodexAnswer,
  temporaryFiles: turnTemporaryFiles,
  speechButtons: turnSpeechButtons,
  logError: (...args) => console.error(...args),
});
const claudeCompletionService = new ClaudeCompletionService({
  runForTask: (run) => taskRuns.forTask(run),
  isSelectedRun,
  reindexRun: (run, previous) => taskRuns.reindex(run, previous),
  setSelectedThread: (sessionId, title) => selectionStore.setThread(sessionId, {
    provider: "claude",
    title,
  }),
  saveState,
  finishProgress: (...args) => taskProgress.finish(...args),
  persistHistory: persistClaudeRunHistory,
  projectWorkLog: projectClaudeRunToWorkLog,
  finalizeDelivery: finalizeRunDelivery,
  temporaryFiles: turnTemporaryFiles,
  logError: (...args) => console.error(...args),
});
const claudeRecoveryService = new ClaudeRecoveryService({
  attach: attachClaudeRunAfterRestart,
  finishInterrupted: (...args) => runRecovery.finishInterrupted(...args),
});
const codexRecoveryService = new CodexRecoveryService({
  transportRunning: () => codexTransport.running,
  readTaskSnapshot: readCodexTaskSnapshot,
  startTransport: startCodexAppServer,
  initialize: initializeCodex,
  isCodex,
  finishInterrupted: (...args) => runRecovery.finishInterrupted(...args),
  readThread: readCodexThread,
  autoApprove: () => autoApprove,
  restartRequested: () => Boolean(restartRequest),
  finishProgress: (...args) => taskProgress.finish(...args),
  completeRun: (run) => managedRunLifecycle.complete(run),
  recoveredAnswer: recoveredCodexAnswer,
  setProgressStage: (...args) => taskProgress.setStage(...args),
  launchTurn,
  reindexRun: (run, previous) => taskRuns.reindex(run, previous),
  scheduleObservedRun: (...args) => taskObserver.schedule(...args),
  startTyping: () => startTyping(),
  saveState,
  telegram: (...args) => telegram(...args),
  consumeTracker: consumeTurnTokenTracker,
  finalizeDelivery: finalizeCodexRunDelivery,
  turnTokenUsage,
});
const codexTurnService = new CodexTurnService({
  sendRpc,
  sandboxMode: () => config.codexSandboxMode,
  compactionRecycle: () => codexContextMaintenance.recycleInFlight,
  resolvedSkillNames: resolvedExplicitSkillNames,
  reindexRun: (run, previous) => taskRuns.reindex(run, previous),
  saveState,
  startTyping: () => startTyping(),
  scheduleObservedRun: (...args) => taskObserver.schedule(...args),
  finishProgress: (...args) => taskProgress.finish(...args),
  completeRun: (run) => managedRunLifecycle.complete(run),
  readThread: readCodexThread,
  speechButtons: turnSpeechButtons,
  temporaryFiles: turnTemporaryFiles,
  turnTokenUsage,
});
const providerCancellationService = new ProviderCancellationService({
  interruptCodex: (run) => codexTurnService.interrupt(run),
  runForTask: (run) => taskRuns.forTask(run),
  completeRun: (run) => managedRunLifecycle.complete(run),
  readCodexSnapshot: readCodexTaskSnapshot,
  finishObserved: (...args) => taskObserver.finish(...args),
  completeManaged: (run, options) => runCoordinator.completeManaged(run, options),
  taskExternalActivity,
  stopClaudeRun: stopClaudeRunProcess,
  processIsAlive,
  taskRunKey,
  saveState,
  cancelledClaudeTasks: cancelledManagedClaudeTasks,
  logWarn: (...args) => console.warn(...args),
  logError: (...args) => console.error(...args),
});
const codexEventService = new CodexEventService({
  invalidateThreadRead: invalidateCodexThreadRead,
  forEvent: (reference) => taskRuns.forEvent(reference),
  reindexRun: (run, previous) => taskRuns.reindex(run, previous),
  applyThreadSettings: applyCodexThreadSettings,
  saveState,
  trackTokenUsage: trackTurnTokenUsage,
  taskKey: taskRunKey,
  isSelectedRun,
  setSelectedDiff: (value) => { latestDiff = value; },
  appendActivity: appendRunActivity,
  noteActivity: (...args) => taskProgress.noteActivity(...args),
  scheduleProgress: (...args) => taskProgress.schedule(...args),
  appendReasoning: (...args) => taskProgress.appendReasoning(...args),
  isCompactionItem: isContextCompactionItem,
  beginCompaction: (...args) => contextCompactions.begin(...args),
  getCompaction: (threadId) => contextCompactions.get(threadId),
  beginCompactionCleanup: (...args) => codexContextMaintenance.beginCompactionCleanup(...args),
  setStage: (...args) => taskProgress.setStage(...args),
  describeItem: describeCodexItem,
  itemActivity: codexItemActivity,
  requestApproval,
  formatCommandApproval,
  formatFileApproval,
  formatPermissionsApproval,
  requestMcpElicitation,
  discardManualCompaction: discardManualContextCompactionRun,
  consumeTracker: consumeTurnTokenTracker,
  finishObserved: (...args) => taskObserver.finish(...args),
  turnSnapshot: codexTurnSnapshot,
  completeManaged: (run, completion) => runCoordinator.completeManaged(run, completion),
  turnTokenUsage,
  speechButtons: turnSpeechButtons,
  temporaryFiles: turnTemporaryFiles,
  taskDiffs,
  logWarn: (...args) => console.warn(...args),
  logError: (...args) => console.error(...args),
});
const codexCatalogProjection = new CodexCatalogProjectionService({
  backfillPricing: backfillWorkLogPricingMetadata,
  readTitleHistories: readCodexThreadTitleHistories,
  findProject,
  rememberRolloutPath: (threadId, rolloutPath) => (
    setBoundedMapValue(codexRolloutPathsByThreadId, threadId, rolloutPath, 5_000)
  ),
  readActivity: readCodexRolloutActivity,
  runForTask: (reference) => taskRuns.forTask(reference),
  selectActiveTurnId: selectExactActiveCodexTurnId,
  capturedOwner: capturedCodexExecutionOwner,
  runtimeActive: codexObservedRuntimeActive,
  agentHubPid: () => codexTransport.pid,
  resolveOwner: resolveCodexObservedExecutionOwner,
  hubOwner: TASK_EXECUTION_OWNERS.HUB,
  catalogEntry: codexCatalogEntry,
  modelLabel: codexModelLabel,
  threadResponseTitle: codexThreadResponseTitle,
  confirmationKey: catalogTaskKey,
  expectedTitle: pendingTaskTitle,
  clearExpectedTitle: (key) => taskMetadata.clearExpectedTitle(key),
  preferredTitle: preferredCodexTaskTitle,
  pinnedTitle: pinnedTaskTitle,
  setThreadName: (threadId, name) => sendRpc("thread/name/set", { threadId, name }),
  reconcilePinnedTitle: (provider, threadId, title) => (
    taskMetadata.reconcilePinnedTitle({ provider, threadId }, title)
  ),
  savePinnedTitles: savePinnedTaskTitles,
  saveState,
});
const claudeCatalogProjection = new ClaudeCatalogProjectionService({
  audit: auditClaudeTranscriptSnapshots,
  findProject,
  applyManagedCancellation: (snapshot) => claudeTaskSnapshots.applyManagedCancellation(snapshot),
  catalogEntry: claudeCatalogEntry,
  logError: (...args) => console.error(...args),
});

const providerTaskActivity = new ProviderTaskActivityService({
  knownCodexRolloutPath,
  codexRunning: () => codexTransport.running,
  codexPid: () => codexTransport.pid,
  ensureCodex: async () => {
    await startCodexAppServer();
    await initializeCodex({ attachSelectedThread: false });
  },
  readCodexThread,
  capturedCodexExecutionOwner,
  claudeTaskSnapshots,
  resolveActivity: resolveCodexTaskActivity,
});

const agentProviders = createAgentProviderRegistry({
  taskRunIsActive,
  codex: {
    listAllCodexThreads: () => codexProviderTasks.discoverTasks(),
    buildCodexTaskCatalogEntries: (threads) => codexCatalogProjection.project(threads),
    createCodexTask: () => codexProviderTasks.createTask(),
    launchCodexTurn: (...args) => codexTurnService.launch(...args),
    steerCodexTurn: (...args) => codexTurnService.steer(...args),
    cancelCodexProviderRun: (...args) => providerCancellationService.cancelCodex(...args),
    readCodexTaskActivity: (target) => providerTaskActivity.readCodex(target),
    readCodexTaskSnapshot,
    completeObservedCodexRun: (...args) => codexCompletionService.completeObserved(...args),
    completeManagedCodexRun: (...args) => codexCompletionService.completeManaged(...args),
    recoverCodexRun: (...args) => codexRecoveryService.recover(...args),
    readCodexRecoverySnapshot: (...args) => codexRecoveryService.readSnapshot(...args),
    prepareCodexRecovery: (...args) => codexRecoveryService.prepare(...args),
    applyCodexObservedSnapshot,
    applyCodexActiveSnapshot,
  },
  claude: {
    listClaudeSessionSnapshots,
    buildClaudeTaskCatalogEntries: (snapshots) => claudeCatalogProjection.project(snapshots),
    createClaudeTask: () => claudeProviderTasks.createTask(),
    launchClaudeTurn: (...args) => startClaudeTurn(...args),
    steerClaudeTurn: unsupportedProviderSteer,
    cancelClaudeProviderRun: (...args) => providerCancellationService.cancelClaude(...args),
    readClaudeTaskActivity: (target) => providerTaskActivity.readClaude(target),
    readClaudeTaskSnapshot: (...args) => claudeTaskSnapshots.read(...args),
    completeObservedClaudeRun: (...args) => claudeCompletionService.completeObserved(...args),
    completeManagedClaudeRun: (...args) => claudeCompletionService.completeManaged(...args),
    recoverClaudeRun: (...args) => claudeRecoveryService.recover(...args),
  },
});
// Runtime activity cannot be restored from a durable catalog row. Managed runs
// are restored separately, while external activity is revalidated from rollout
// files. Showing cached `running=true` here creates a full-catalog phantom state
// while the first provider scan is still in progress or unavailable.
const providerTaskCatalogBuilder = new ProviderTaskCatalogBuilder({
  durableEntries: () => catalogEntriesWithoutLiveActivity(taskSyncStore.catalog()),
  sources: agentProviders.catalogSources(),
  managedRuns: () => taskRuns.values().map((run) => ({
    ...run,
    projectName: runProject(run).name,
  })),
  merge: mergeTaskCatalog,
  finalize: finalizeTaskCatalog,
  onSourceError: ({ name, reason }) => {
    console.error(`Cannot discover ${name} tasks:`, reason?.message ?? reason);
  },
});
const taskCatalogService = new TaskCatalogService({
  initialEntries: catalogEntriesWithoutLiveActivity(taskSyncStore.catalog()),
  cacheMs: TASK_CATALOG_CACHE_MS,
  build: () => providerTaskCatalogBuilder.build(),
});
const taskCatalog = taskCatalogService.entries;

let mediaController;
const telegramClient = new TelegramClient({
  token,
  apiBaseUrl: config.telegramApiBaseUrl,
  menu: BOT_MENU,
  statusHeaderDirectory: STATUS_HEADER_DIR,
  selectStatusHeader: randomStatusHeaderFileName,
  getStatusFileId: (name) => statusMediaFileIds.get(name) ?? null,
  rememberStatusFileId: async (name, fileId) => {
    if (fileId) statusMediaFileIds.set(name, fileId);
    else statusMediaFileIds.delete(name);
    await saveState();
  },
  getDefaultChatId: () => chatId,
  getDefaultProvider: () => activeProvider,
  rememberSpeechText: (...args) => mediaController?.rememberSpeechText(...args) ?? null,
  messageLimit: TELEGRAM_LIMIT,
});
const telegram = (method, body) => {
  if (method !== "answerCallbackQuery") return telegramClient.request(method, body);
  telegramClient.answerCallback(body, {
    onError: (error) => console.warn(`Telegram callback acknowledgement failed: ${error.message}`),
  });
  return Promise.resolve(undefined);
};
let quickTunnelController = null;
let miniAppPublisher = null;
let directGatewayController = null;
const desktopAttachments = new DesktopAttachmentService({
  assistantAttachmentImporterFactory: createCodexAssistantAttachmentImporter,
  runtimeCommandRoot,
  projectRoot: config.projectRoot,
  projectRoots: config.projects.map((project) => project.path),
  workerEnabled: config.miniApp.worker.enabled,
  publisher: () => miniAppPublisher,
  trustedUserId: (context) => trustedDeviceUserId(context),
});
const desktopAttachmentPaths = (...args) => desktopAttachments.paths(...args);
const isLegacyDesktopAttachmentFile = (...args) => desktopAttachments.isLegacyFile(...args);
const desktopAttachmentDescriptors = (...args) => desktopAttachments.descriptors(...args);
const importCodexDesktopAttachments = (...args) => desktopAttachments.importCodex(...args);
const desktopOpenAttachment = (...args) => desktopAttachments.open(...args);

async function configureTelegramMiniAppMenu(url, text) {
  if (!config.components.miniApp) return;
  await Promise.all(miniAppMenuButtonRequests({
    url,
    text,
    chatIds: config.allowedUserIds,
  }).map((body) => telegram("setChatMenuButton", body)));
}

async function startMiniApp() {
  if (!miniAppServer) return null;
  const address = await miniAppServer.start();
  const directGateway = await loadDirectGatewaySettings(
    path.join(runtimeCommandRoot, "gateway.json"),
    { localUrl: address.url },
  );
  if (directGateway.enabled) {
    directGatewayController ??= new DirectGatewayController(directGateway);
    const publicUrl = await directGatewayController.start();
    await configureTelegramMiniAppMenu(publicUrl, config.miniApp.worker.menuText);
    console.log(`Direct Agent Hub gateway ready at ${publicUrl}`);
  }
  if (config.miniApp.worker.enabled) {
    miniAppPublisher ??= new MiniAppPublisher({
      journalDatabaseFile,
      ...config.miniApp.worker,
      controlHandler: handleDesktopControl,
      controlReceiptFile: path.join(config.dataDir, "mini-app-control-receipts.json"),
      controlReconciler: reconcileRemoteDesktopControl,
      onControlResultDelivered: async ({ id }) => forgetDesktopControl(id),
      attachmentDirectory: path.join(runtimeCommandRoot, "DesktopApp", "attachments"),
      onPublished: async (url) => {
        await configureTelegramMiniAppMenu(url, config.miniApp.worker.menuText);
        console.log(`Agent Hub Worker ready at ${url}`);
      },
    });
    await miniAppPublisher.start().catch((error) => {
      console.warn(`Cannot publish Mini App journal yet: ${error.message}`);
    });
  }
  if (!config.miniApp.quickTunnel.enabled) {
    return directGateway.enabled ? { ...address, publicUrl: directGateway.publicUrl } : address;
  }
  const publicAddress = await publicMiniAppServer.start();
  quickTunnelController ??= new QuickTunnelController({
    executable: config.miniApp.quickTunnel.executable,
    provider: config.miniApp.quickTunnel.provider,
    mode: config.miniApp.quickTunnel.mode,
    publicUrl: config.miniApp.quickTunnel.publicUrl,
    tokenFile: config.miniApp.quickTunnel.tokenFile,
    edgeBindAddress: config.miniApp.quickTunnel.edgeBindAddress,
    controlPort: config.miniApp.quickTunnel.controlPort,
    localUrl: publicAddress.url,
    onUrl: async (url) => {
      await configureTelegramMiniAppMenu(url, config.miniApp.quickTunnel.menuText);
    },
  });
  const publicUrl = await quickTunnelController.start();
  console.log(`Public Agent Hub Web App ready at ${publicUrl}`);
  return { ...address, publicUrl };
}
const telegramMultipart = (method, body, fileField, filePath) => (
  telegramClient.multipart(method, body, fileField, filePath)
);
const sendStatusCard = (...args) => telegramClient.sendStatusCard(...args);
const sendMessage = (...args) => telegramClient.sendMessage(...args);
const sendMessageTo = (...args) => telegramClient.sendMessageTo(...args);
const sendLongMessage = (...args) => telegramClient.sendLongMessage(...args);
const startTyping = () => telegramClient.startTyping();
const stopTyping = () => telegramClient.stopTyping();
const telegramSettingsMenu = new TelegramSettingsMenu({
  projects: PROJECTS,
  codexModels: CODEX_MODELS,
  claudeModels: CLAUDE_MODELS,
  claudeModelLabels: CLAUDE_MODEL_LABELS,
  reasoningEfforts: CODEX_REASONING_EFFORTS,
  reasoningLabels: CODEX_REASONING_LABELS,
  collaborationModes: CODEX_COLLABORATION_MODES,
  collaborationModeLabels: CODEX_COLLABORATION_MODE_LABELS,
  callbackData: uiCallback,
  sendMessage,
});
const rateLimitTelemetry = new RateLimitTelemetryService({
  resolveClaudeInvocation,
  parseClaudeLimits,
  spawnCapture,
  readCodexRateLimits: () => sendRpc("account/rateLimits/read", {}, { timeoutMs: 5_000 }),
  codexRunning: () => codexTransport.running,
  historyStore: rateLimitHistoryStore,
  workLogUsageStore,
  timers: runtimeTimers,
  isStopping: () => stopping,
});
const telegramStatusController = new TelegramStatusController({
  config,
  projects: PROJECTS,
  findProject,
  refreshTaskCatalog,
  currentTaskCatalog: () => taskCatalog,
  currentTaskRuns: () => taskRuns.values(),
  readCodexRateLimits: () => rateLimitTelemetry.readCodex(),
  readClaudeRateLimits: () => rateLimitTelemetry.readClaude(),
  codexModelLabel,
  claudeModelLabels: CLAUDE_MODEL_LABELS,
  reasoningLabels: CODEX_REASONING_LABELS,
  collaborationModeLabels: CODEX_COLLABORATION_MODE_LABELS,
  sendStatusCard,
});
mediaController = new MediaController({
  config,
  token,
  agentHubRoot: AGENT_HUB_ROOT,
  telegram,
  sendMessage: sendMessageTo,
  startTurn,
  activeProjectRoot: () => activeProjectRoot,
  stopProcessTree,
});
await mediaController.load();
const approvalController = new ApprovalController({
  autoApprove: () => autoApprove,
  respond: respondRpc,
  send: sendMessage,
  sendForRun: sendRunMessage,
  runExists: (id) => taskRuns.values().some((run) => run.id === id),
  setProgressStage: (...args) => taskProgress.setStage(...args),
  telegram,
  currentChatId: () => chatId,
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
  onDelivered: async (item, result) => {
    if (!item.binding || !Number.isSafeInteger(result?.message_id)) return;
    const {
      replacesProgressMessageIds = [],
      ...storedBinding
    } = item.binding;
    try {
      bindingWriteQueue = bindingWriteQueue
        .catch(() => {})
        .then(() => appendMessageBindings(config.dataDir, [{
          ...storedBinding,
          messageId: result.message_id,
        }]));
      await bindingWriteQueue;
      if (item.binding.kind === "progress") {
        const run = taskRuns.forTask(item.binding);
        if (!run || run.finalizing) {
          await telegram("deleteMessage", {
            chat_id: item.body?.chat_id ?? item.binding.chatId,
            message_id: result.message_id,
          }).catch(() => {});
        } else if (!run.progressMessageIds.includes(result.message_id)) {
          run.progressMessageIds.push(result.message_id);
          run.lastProgressText = String(item.body?.text ?? "");
          taskProgress.schedule(run);
          await saveState();
        }
      }
    } catch (error) {
      console.error(`Cannot bind queued Telegram delivery ${item.id}:`, error.message);
    }
    if (Array.isArray(replacesProgressMessageIds) && replacesProgressMessageIds.length) {
      try {
        await clearDeliveredProgressMessages(
          item.body?.chat_id ?? item.binding.chatId,
          replacesProgressMessageIds,
        );
      } catch (error) {
        console.error(`Cannot replace progress after Telegram delivery ${item.id}:`, error.message);
      }
    }
  },
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

function runMessageBinding(run, metadata = {}) {
  if (!run?.threadId || !Number.isSafeInteger(run.chatId)) return null;
  return {
    chatId: run.chatId,
    provider: run.provider,
    threadId: run.threadId,
    projectRoot: run.projectRoot,
    taskTitle: runTaskTitle(run),
    createdAt: new Date().toISOString(),
    ...metadata,
  };
}

async function bindRunMessage(run, message, metadata = {}) {
  const binding = runMessageBinding(run, metadata);
  if (!binding || !Number.isSafeInteger(message?.message_id)) return;
  bindingWriteQueue = bindingWriteQueue
    .catch(() => {})
    .then(() => appendMessageBindings(config.dataDir, [{
      ...binding,
      messageId: message.message_id,
    }]));
  await bindingWriteQueue;
}

async function sendRunMessage(run, text, extra = {}, bindingMetadata = {}) {
  const message = await sendMessageTo(run.chatId, text, extra);
  await bindRunMessage(run, message, bindingMetadata).catch((error) => {
    console.error("Cannot bind task message:", error.message);
  });
  return message;
}

function sameTaskBinding(binding, task, targetChatId = null) {
  return binding?.provider === task?.provider
    && String(binding?.threadId ?? "") === String(task?.threadId ?? "")
    && samePath(binding?.projectRoot, task?.projectRoot)
    && (targetChatId == null || binding.chatId === targetChatId);
}

async function bindIncomingTaskMessage(message, text, target = null) {
  const task = target ?? selectedTask();
  if (!task.threadId || !Number.isSafeInteger(message?.message_id)) return;
  const binding = {
    ...task,
    chatId: message.chat.id,
    messageId: message.message_id,
    taskTitle: task.taskTitle ?? activeThreadTitle,
    createdAt: new Date((Number(message.date) || Math.floor(Date.now() / 1000)) * 1000).toISOString(),
    kind: "incoming-user",
    role: "user",
    text: String(text ?? "").trim(),
  };
  bindingWriteQueue = bindingWriteQueue
    .catch(() => {})
    .then(() => appendMessageBindings(config.dataDir, [binding]));
  await bindingWriteQueue;
}

async function deleteTaskTelegramMessages(task, targetChatId) {
  const bindings = await readMessageBindings(config.dataDir);
  const protectedIds = new Set([...approvalController.pending.values()]
    .filter((approval) => approval.chatId === targetChatId)
    .map((approval) => approval.messageId)
    .filter(Number.isSafeInteger));
  const maximumAgeMs = 47 * 60 * 60 * 1000;
  const now = Date.now();
  const messageIds = [...new Set(bindings
    .filter((binding) => sameTaskBinding(binding, task, targetChatId))
    .filter((binding) => !protectedIds.has(binding.messageId))
    .filter((binding) => {
      const createdAt = Date.parse(String(binding.createdAt ?? ""));
      return Number.isFinite(createdAt) && now - createdAt < maximumAgeMs;
    })
    .map((binding) => binding.messageId))]
    .sort((left, right) => left - right);
  if (!messageIds.length) return 0;

  const removed = new Set();
  for (let start = 0; start < messageIds.length; start += 100) {
    const batch = messageIds.slice(start, start + 100);
    try {
      await telegram("deleteMessages", {
        chat_id: targetChatId,
        message_ids: batch,
      });
      batch.forEach((messageId) => removed.add(messageId));
    } catch (batchError) {
      console.warn(`Cannot batch-delete task messages: ${batchError.message}`);
      for (const messageId of batch) {
        try {
          await telegram("deleteMessage", {
            chat_id: targetChatId,
            message_id: messageId,
          });
          removed.add(messageId);
        } catch (error) {
          console.warn(`Cannot delete Telegram message ${messageId}: ${error.message}`);
        }
      }
    }
  }
  if (removed.size) {
    bindingWriteQueue = bindingWriteQueue
      .catch(() => {})
      .then(() => removeMessageBindings(
        config.dataDir,
        (binding) => binding.chatId === targetChatId && removed.has(binding.messageId),
      ));
    await bindingWriteQueue;
  }
  const run = taskRuns.forTask(task);
  if (run) {
    run.progressMessageIds = run.progressMessageIds.filter((messageId) => !removed.has(messageId));
    if (!run.progressMessageIds.length) run.lastProgressText = "";
  }
  return removed.size;
}

async function sendTaskViewText(run, heading, text, kind) {
  const value = `${heading}\n\n${String(text ?? "").trim()}`;
  for (let start = 0; start < value.length; start += TELEGRAM_LIMIT) {
    await sendRunMessage(
      run,
      value.slice(start, start + TELEGRAM_LIMIT),
      {},
      { kind, role: kind === "task-view-user" ? "user" : "assistant" },
    );
  }
}

function progressOutboxKey(run) {
  return `progress:${taskRunKey(run)}`;
}

async function sendReliableRunMessage(
  run,
  text,
  extra = {},
  bindingMetadata = {},
  delivery = {},
) {
  const body = { chat_id: run.chatId, text: String(text), ...extra };
  if (delivery.supersedeKey) {
    await deliveryOutbox.discard({ supersedeKey: delivery.supersedeKey });
  }
  if (!delivery.forceQueue) {
    try {
      const message = await telegram("sendMessage", body);
      await bindRunMessage(run, message, bindingMetadata).catch((error) => {
        console.error("Cannot bind task message:", error.message);
      });
      return message;
    } catch (error) {
      if (error?.retryable !== true) throw error;
      console.warn(`Telegram delivery will be queued: ${error.message}`);
    }
  }
  const queued = await deliveryOutbox.enqueue({
    method: "sendMessage",
    body,
    binding: runMessageBinding(run, bindingMetadata),
    groupId: delivery.groupId ?? null,
    sequence: delivery.sequence ?? 0,
    supersedeKey: delivery.supersedeKey ?? null,
  });
  scheduleDeliveryOutboxFlush(0);
  return { queued: true, outboxId: queued.id };
}

async function sendRunLongMessage(run, text, {
  speechText = null,
  forceSpeechButton = false,
  reliable = false,
  durable = false,
  silent = false,
  deliveryGroupId = randomUUID(),
  replaceProgressMessageIds = [],
} = {}) {
  const value = `${runProgressPresentation.heading(run, true)}\n\n${String(text)}`;
  const speechId = mediaController.rememberSpeechText(speechText, forceSpeechButton);
  const diffCallbackData = taskViewCallbackData({
    action: "diff",
    provider: run.provider,
    threadId: run.threadId,
  }) ?? "task-diff";
  let queued = durable;
  let sequence = 0;
  for (let start = 0; start < value.length; start += TELEGRAM_LIMIT) {
    const isLast = start + TELEGRAM_LIMIT >= value.length;
    const extra = {
      ...(silent ? { disable_notification: true } : {}),
      ...(isLast
        ? {
          reply_markup: {
            inline_keyboard: [
              ...(speechId
                ? [[{ text: "🔊 Озвучить", callback_data: `speech:${speechId}` }]]
                : []),
              [{ text: "Изменения", callback_data: diffCallbackData }],
            ],
          },
        }
        : {}),
    };
    if (reliable) {
      const result = await sendReliableRunMessage(
        run,
        value.slice(start, start + TELEGRAM_LIMIT),
        extra,
        isLast && replaceProgressMessageIds.length
          ? { replacesProgressMessageIds: [...replaceProgressMessageIds] }
          : {},
        { forceQueue: queued, groupId: deliveryGroupId, sequence },
      );
      queued ||= result?.queued === true;
    } else {
      await sendRunMessage(run, value.slice(start, start + TELEGRAM_LIMIT), extra);
    }
    sequence += 1;
  }
  return { queued, groupId: deliveryGroupId, nextSequence: sequence };
}

async function clearDeliveredProgressMessages(targetChatId, values) {
  const messageIds = [...new Set(values ?? [])]
    .filter(Number.isSafeInteger);
  if (!messageIds.length) return;
  for (const messageId of messageIds) {
    await telegram("deleteMessage", {
      chat_id: targetChatId,
      message_id: messageId,
    }).catch((error) => {
      console.warn(`Cannot remove completed progress message ${messageId}:`, error.message);
    });
  }
  await removeMessageBindings(
    config.dataDir,
    (binding) => binding.chatId === targetChatId && messageIds.includes(binding.messageId),
  ).catch((error) => {
    console.warn("Cannot remove completed progress bindings:", error.message);
  });
}

async function safelyDeliverRunMessage(run, delivery, description = "сообщение задачи") {
  try {
    return await delivery();
  } catch (error) {
    console.error(`Cannot deliver ${description} for task ${run?.threadId ?? run?.id ?? "unknown"}:`, error.message);
    return null;
  }
}

async function finalizeRunDelivery(run, {
  answer,
  message = answer,
  speechText = answer,
  forceSpeechButton = false,
  deliver = true,
  silent = false,
  complete = true,
  description = "финальный ответ",
} = {}) {
  run.finalizing = true;
  await deliveryOutbox.discard({ supersedeKey: progressOutboxKey(run) }).catch((error) => {
    console.error("Cannot discard stale progress delivery:", error.message);
  });
  rememberLastTaskMessage(run, answer);
  if (run?.turnId) setBoundedMapValue(lastSeenTaskTurnIds, taskRunKey(run), run.turnId, 500);
  await refreshTaskDiff(run).catch((error) => {
    console.error(`Cannot refresh final diff for task ${run?.threadId ?? run?.id ?? "unknown"}:`, error.message);
  });
  let deliveryResult = null;
  if (deliver) {
    // A completed run must never disappear between remembering its answer and
    // sending it to Telegram. Persist every final part in the outbox first;
    // the run can then be closed safely even if Telegram is temporarily down.
    deliveryResult = await sendRunLongMessage(run, message, {
      speechText,
      forceSpeechButton,
      reliable: true,
      durable: true,
      silent,
      replaceProgressMessageIds: run.finishedProgressMessageIds ?? [],
    });
  }
  if (complete) await managedRunLifecycle.complete(run);
  return deliveryResult;
}

async function sendTaskSelectionNotification({
  targetChatId = chatId,
  showLastMessage = true,
  alreadySelected = false,
} = {}) {
  const task = {
    ...selectedTask(),
    chatId: targetChatId,
    taskTitle: activeThreadTitle,
  };
  const extra = { parse_mode: "HTML" };
  if (showLastMessage && task.threadId) extra.reply_markup = showLastMessageReplyMarkup(task);
  const formatMessage = alreadySelected
    ? formatTaskAlreadySelectedMessage
    : formatTaskSwitchMessage;
  const message = await sendMessageTo(targetChatId, formatMessage({
    task: activeThreadTitle,
    project: activeProject().name,
    showProject: config.showProjectButton,
    ...taskSwitchSettings(),
  }), extra);
  await bindRunMessage(task, message).catch((error) => {
    console.error("Cannot bind task-switch message:", error.message);
  });
  return message;
}

function sendTaskSwitchNotification(options = {}) {
  return sendTaskSelectionNotification(options);
}

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
  codexHookReceipts = restoredRuntimeState.value.codexHookReceipts;
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

async function sendThreadPicker({ editMessage = null, page = 0 } = {}) {
  const catalog = await refreshTaskCatalog();
  const view = buildTaskPicker({
    catalog,
    selectedTask: selectedTask(),
    page,
    pageSize: TASK_PICKER_PAGE_SIZE,
    showProject: config.showProjectButton && config.showTaskProject,
    providerTitle: providerTitle(),
    projectName: activeProject().name,
    newTaskCallback: uiCallback("thread:new"),
    archiveCallback: isCodex() && threadId ? uiCallback("thread:archive") : null,
  });
  if (editMessage) {
    await telegram("editMessageText", {
      chat_id: editMessage.chat.id,
      message_id: editMessage.message_id,
      text: view.text,
      reply_markup: view.replyMarkup,
    });
  } else {
    await sendMessage(view.text, { reply_markup: view.replyMarkup });
  }
}

const serverControlController = new ServerControlController({
  config,
  startedAt: serverStartedAt,
  instanceId: serverInstanceId,
  releaseId: serverReleaseId,
  shortcutPath: agentHubAutostartShortcutPath,
  installScriptPath: defaultAutostartInstallScript(import.meta.dirname),
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

function desktopReadAccountId(context = null) {
  const requested = String(context?.userId ?? "").trim();
  if (requested) return trustedDeviceUserId(context);
  if (config.allowedUserIds.size || config.components.androidApp) return trustedDeviceUserId(null);
  return "local";
}

function desktopSnapshot(params = {}, context = null) {
  return rawDesktopSnapshot({
    ...(params ?? {}),
    // Read state always belongs to the authenticated/local Hub account. A
    // remote client cannot select another account through request parameters.
    accountId: desktopReadAccountId(context),
  });
}

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

function markDesktopTaskRead(entry, context = null) {
  const lastMessage = savedLastTaskMessageRecord(entry);
  if (!lastMessage?.updatedAt) return null;
  return taskReadStateStore.markRead({
    accountId: desktopReadAccountId(context),
    provider: entry.provider,
    threadId: entry.threadId,
    answerAt: lastMessage.updatedAt,
    answerTurnId: lastMessage.turnId,
  });
}

async function desktopSelectTask(params, context = null) {
  const provider = String(params.provider ?? "").trim();
  const selectedThreadId = String(params.threadId ?? "").trim();
  if (!['codex', 'claude'].includes(provider) || !selectedThreadId) {
    throw new Error("Укажите корректную задачу");
  }
  let entry = taskCatalog.find((item) => item.provider === provider && item.threadId === selectedThreadId);
  if (!entry) {
    entry = (await refreshTaskCatalog()).find((item) => (
      item.provider === provider && item.threadId === selectedThreadId
    ));
  } else {
    void refreshTaskCatalog().catch((error) => {
      console.warn(`Cannot refresh task catalog after task selection: ${error.message}`);
    });
  }
  if (!entry) throw new Error("Задача не найдена в локальном каталоге");
  const activation = await activateMessageBinding({
    provider: entry.provider,
    projectRoot: entry.projectRoot,
    threadId: entry.threadId,
    taskTitle: entry.title,
  });
  markDesktopTaskRead(entry, context);
  return {
    ...await desktopSnapshot({}, context),
    selectionChanged: activation.changed,
  };
}

async function desktopOpenTask(params, context = null) {
  const snapshot = await dispatchApplicationCommand(
    "task.select",
    params,
    context,
    { target: commandTaskTarget(params) },
  );
  return {
    snapshot,
    history: await desktopTaskHistory({
      provider: params.provider,
      threadId: params.threadId,
      limit: params.limit,
      maxAnswerChars: params.maxAnswerChars,
    }),
  };
}

async function desktopOpenTurn(params, context = null) {
  const provider = String(params.provider ?? "").trim();
  const taskThread = String(params.taskThreadId ?? "").trim();
  const turnThread = String(params.turnThreadId ?? taskThread).trim();
  const selectedTurnId = String(params.turnId ?? "").trim();
  if (!["codex", "claude"].includes(provider) || !taskThread || !turnThread || !selectedTurnId) {
    throw new Error("Укажите корректный ход");
  }
  const entry = taskCatalog.find((item) => item.provider === provider && item.threadId === taskThread);
  void refreshTaskCatalog().catch((error) => {
    console.warn(`Cannot refresh task catalog after Desktop turn open: ${error.message}`);
  });
  if (!entry) throw new Error("Задача не найдена в локальном каталоге");
  const record = await workLogUsageStore.getTurn({
    provider,
    threadId: turnThread,
    turnId: selectedTurnId,
  });
  if (!record) throw new Error("Ход не найден в журнале");
  const recordedTaskThread = String(record.taskThreadId ?? record.threadId ?? "").trim();
  if (
    recordedTaskThread !== taskThread
    || (record.projectRoot && !samePath(record.projectRoot, entry.projectRoot))
  ) {
    throw new Error("Ход не относится к выбранной задаче");
  }
  await dispatchApplicationCommand(
    "task.select",
    { taskTitle: entry.title },
    context,
    {
      target: commandTaskTarget({
        provider: entry.provider,
        projectRoot: entry.projectRoot,
        threadId: entry.threadId,
      }),
    },
  );
  return {
    snapshot: await desktopSnapshot({}, context),
    history: await desktopTaskHistory({
      provider,
      threadId: taskThread,
      limit: params.limit,
      maxAnswerChars: params.maxAnswerChars,
    }),
    focusedTurn: {
      provider,
      taskThreadId: taskThread,
      turnThreadId: turnThread,
      turnId: selectedTurnId,
      title: String(record.title ?? ""),
      prompt: String(record.prompt ?? ""),
      answer: String(record.body ?? record.text ?? "").slice(
        0,
        Math.max(1_000, Math.min(Number(params.maxAnswerChars) || 200_000, 200_000)),
      ),
      status: String(record.status ?? ""),
      startedAt: record.startedAt ?? null,
      completedAt: record.completedAt ?? null,
    },
  };
}

async function desktopMessageTarget(params) {
  const requestedProvider = String(params.provider ?? "").trim();
  const requestedThreadId = String(params.threadId ?? "").trim();
  if (!["codex", "claude"].includes(requestedProvider) || !requestedThreadId) {
    throw new Error("Команда не содержит точный адрес задачи");
  }
  const catalog = await refreshTaskCatalog();
  const entry = catalog.find((item) => (
    item.provider === requestedProvider && item.threadId === requestedThreadId
  ));
  if (!entry) throw new Error("Задача сообщения больше не существует в локальном каталоге");
  return {
    provider: entry.provider,
    projectRoot: entry.projectRoot,
    sessionCwd: entry.sessionCwd ?? null,
    threadId: entry.threadId,
    taskTitle: entry.title,
    chatId,
  };
}

async function desktopUpdateSetting(params) {
  return desktopSettingsService.update(params);
}

async function desktopRenameTask(params) {
  const target = await desktopMessageTarget(params);
  const pinnedTitle = pinTaskTitle(target.provider, target.threadId, String(params.title ?? ""));
  if (!pinnedTitle) throw new Error("Укажите непустое название");
  if (target.provider === "codex") {
    await sendRpc("thread/name/set", { threadId: target.threadId, name: pinnedTitle });
    expectTaskTitleConfirmation(target.provider, target.threadId, pinnedTitle);
    invalidateTaskCatalog();
  }
  const run = taskRuns.forTask(target);
  if (run) updateTaskRunTitle(run, pinnedTitle);
  const entry = taskCatalog.find((item) => catalogEntryIsSelected(item, target));
  if (entry) entry.title = pinnedTitle;
  if (catalogEntryIsSelected(target, selectedTask())) selectionStore.setTitle(pinnedTitle);
  await savePinnedTaskTitles();
  await saveState();
  return {
    ...await desktopSnapshot({ refresh: true }),
    renamedTitle: pinnedTitle,
  };
}

async function desktopArchiveTask(params) {
  const target = await desktopMessageTarget(params);
  if (target.provider !== "codex") throw new Error("Claude не поддерживает архивирование");
  if (taskRuns.forTask(target)) throw new Error("Сначала остановите активный ход");
  const archivedResult = await sendRpc("thread/read", {
    threadId: target.threadId,
    includeTurns: false,
  });
  await sendRpc("thread/archive", { threadId: target.threadId });
  invalidateTaskCatalog();
  taskMetadata.deleteCodexSettings(target.threadId);
  const isCurrent = catalogEntryIsSelected(target, selectedTask());
  let nextThread = null;
  if (isCurrent) {
    selectionStore.setThread(null, { provider: "codex", title: "" });
    latestDiff = "";
    [nextThread] = (await listThreads()).filter((item) => item.id !== target.threadId);
    if (nextThread) {
      selectionStore.setThread(nextThread.id, { provider: "codex", title: threadTitle(nextThread) });
      restoreCodexTaskSettings(threadId);
      latestDiff = taskDiffs.get(taskRunKey(selectedTask())) ?? "";
    }
  }
  await saveState();
  const result = {
    archived: true,
    archivedThread: archivedResult.thread ?? { id: target.threadId },
  };
  if (!result.archived) throw new Error("Задача не выбрана");
  return {
    ...await desktopSnapshot({ refresh: true }),
    archivedThread: archivedResult.thread ?? { id: target.threadId },
    nextThread,
  };
}

async function desktopTaskDiff(params) {
  const target = await desktopMessageTarget(params);
  const run = taskRuns.forTask(target);
  const text = run ? await refreshTaskDiff(run) : taskDiffs.get(taskRunKey(target)) ?? "";
  return { text, empty: !text };
}

async function desktopCancelRun(params) {
  const target = await desktopMessageTarget(params);
  const run = taskRuns.forTask(target);
  if (!run) return { accepted: false, message: "В выбранной задаче сейчас ничего не выполняется" };
  const result = await agentProviders.call(run.provider, "cancelRun", run);
  if (result.interruptFailed) {
    if (run.observer) {
      taskProgress.setStage(run, result.message);
      return {
        ...result,
        message: `${result.message}. Параллельный ход не будет запущен.`,
      };
    }
    return result;
  }
  if (run.observer) {
    dismissedExternalTasks.add(run);
    await taskProgress.finish(run, result.stopRequested
      ? "Остановка запрошена; наблюдение отключено."
      : "Наблюдение отключено; внешний ход продолжает работу.");
    await managedRunLifecycle.complete(run);
    return {
      accepted: true,
      message: result.stopRequested
        ? "Запрошена остановка этой задачи. Пока внешний ход фактически активен, новые сообщения будут сохранены, а не запущены параллельно."
        : "Отключил наблюдение. Внешний Claude продолжает работу; новые сообщения будут сохранены до его завершения.",
    };
  }
  if (!result.detach) return result;
  await taskProgress.finish(run, "Наблюдение отключено; внешний Claude продолжает работу.");
  await managedRunLifecycle.complete(run);
  return result;
}

async function desktopResolveApproval(params) {
  return approvalController.resolveFromDesktop(
    String(params.key ?? ""),
    String(params.decision ?? ""),
  );
}

async function desktopDeferredInput(params, context = null) {
  return desktopDeferredInputService.handle(params, context);
}

async function desktopStatusDetails() {
  let limits;
  try {
    limits = await rateLimitTelemetry.formatted(activeProvider);
  } catch (error) {
    limits = `Не удалось получить: ${error.message}`;
  }
  const codexSelected = isCodex();
  const preferences = agentPreferences.current(activeProvider);
  return {
    provider: activeProvider,
    model: codexSelected ? codexModelLabel(preferences.model) : CLAUDE_MODEL_LABELS[preferences.model],
    reasoning: CODEX_REASONING_LABELS[preferences.reasoningEffort],
    mode: CODEX_COLLABORATION_MODE_LABELS[preferences.collaborationMode],
    limits,
    activeCount: taskRuns.values().filter(taskRunIsActive).length,
    backgroundJobs: backgroundJobs.size,
  };
}

async function desktopSpeakLastAnswer(params) {
  const target = await desktopMessageTarget(params);
  const message = savedLastTaskMessageRecord(target);
  const text = String(message?.text ?? "").trim();
  if (!text) throw new Error("У задачи ещё нет завершённого ответа");
  const job = await backgroundJobs.enqueue("speech", { chatId, text }, chatId, {
    dedupeKey: `desktop:${target.provider}:${target.threadId}:speech`,
  });
  if (!job) throw new Error(`Очередь озвучивания заполнена (${MAX_BACKGROUND_SPEECH_JOBS})`);
  return { accepted: true, message: "Озвучивание будет отправлено в Telegram" };
}

async function desktopRestartServer() {
  if (restartRequest) return { accepted: false, message: "Перезапуск уже запрошен" };
  const blockingRuns = restartBlockingRuns();
  const blockingWorkCount = blockingRuns.length
    + backgroundJobs.size;
  restartRequest = {
    chatId,
    // Desktop control must acknowledge a persisted restart request before a
    // slow Telegram request or the replacement hand-off can close its pipe.
    // The replacement will post the final card if this first announcement did
    // not get a chance to finish.
    messageId: null,
    requestedAt: new Date().toISOString(),
    waitingForRuns: blockingWorkCount > 0,
    minimumUpdateOffset: updateOffset,
  };
  await saveState();
  const request = restartRequest;
  void announceDesktopRestart(request, blockingWorkCount);
  if (!blockingWorkCount) setTimeout(() => void performRestart(), 0).unref();
  return {
    accepted: true,
    waiting: blockingWorkCount > 0,
    message: blockingWorkCount > 0 ? "Перезапуск ожидает завершения задач" : "Agent Hub Server перезапускается",
  };
}

async function desktopNewTask(params) {
  const provider = String(params.provider ?? activeProvider).trim();
  if (!['codex', 'claude'].includes(provider)) throw new Error("Неизвестный агент");
  if (provider !== activeProvider) await switchProvider(provider);
  await createThread();
  return desktopSnapshot({ refresh: true });
}

async function desktopRateLimitHistory(params) {
  return rateLimitHistoryStore.read({
    range: params.range,
    maxPointsPerSeries: params.maxPointsPerSeries,
  });
}

async function desktopUsageHistory(params) {
  return workLogUsageStore.usageHistory({
    range: params.range,
    maxPoints: params.maxPoints,
  });
}

async function desktopSearch(params) {
  const query = String(params.query ?? "").trim().slice(0, 200);
  if (query.length < 2) return { query, results: [] };
  const catalog = await refreshTaskCatalog();
  const results = await workLogUsageStore.searchTurns(query, {
    limit: Math.min(Math.max(Number(params.limit) || 100, 1), 200),
    perTask: 3,
    projectRoots: PROJECTS.map((project) => project.path),
  });
  return {
    query,
    results: results.map((result) => {
      const entry = catalog.find((candidate) => (
        candidate.provider === result.provider
        && candidate.threadId === result.threadId
        && (!result.projectRoot || samePath(candidate.projectRoot, result.projectRoot))
      ));
      return {
        id: entry ? `${entry.provider}:${entry.threadId}` : `${result.provider}:${result.threadId}`,
        provider: result.provider,
        threadId: result.threadId,
        projectRoot: result.projectRoot,
        title: entry?.title ?? result.taskTitle,
        latestAt: result.latestAt,
        matches: result.matches,
      };
    }),
  };
}

async function desktopCompactContext(params) {
  const target = await desktopMessageTarget(params);
  if (target.provider !== "codex") throw new Error("Свёртка контекста доступна только для Codex");
  const run = taskRuns.forTask(target);
  if (taskRunIsActive(run)) throw new Error("Сначала завершите или остановите текущий ход");
  if (contextCompactions.isRunning(target.threadId)) {
    return { accepted: false, message: "Свёртка контекста уже выполняется" };
  }
  if (!codexTransport.running) {
    await startCodexAppServer();
    await initializeCodex({ attachSelectedThread: false });
  }
  const compaction = contextCompactions.begin(target.threadId, { origin: "manual" });
  try {
    // A thread discovered from rollout history is not necessarily loaded in
    // this particular App Server process. Compacting an unloaded thread makes
    // the real server answer `Thread not found`, even though it is present in
    // the shared local catalog.
    await sendRpc("thread/resume", {
      threadId: target.threadId,
      ...codexThreadSandboxSettings(config.codexSandboxMode),
    });
    await sendRpc("thread/compact/start", { threadId: target.threadId });
    return {
      accepted: true,
      compactionId: compaction.id,
      message: "Свёртка контекста запущена",
    };
  } catch (error) {
    contextCompactions.fail(target.threadId, compaction.id);
    throw error;
  }
}

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

async function desktopTrustedDevices(_params, context) {
  const userId = trustedDeviceUserId(context);
  return createTrustedDeviceManager({
    workerEnabled: config.miniApp.worker.enabled,
    publisher: miniAppPublisher,
    localStore: trustedDeviceStore,
  }).list(userId);
}

async function desktopCreateDevicePairing(_params, context) {
  const userId = trustedDeviceUserId(context);
  return createTrustedDeviceManager({
    workerEnabled: config.miniApp.worker.enabled,
    publisher: miniAppPublisher,
    localStore: trustedDeviceStore,
  }).createPairing(userId);
}

async function desktopRevokeDevice(params, context) {
  const deviceId = String(params?.deviceId ?? "").trim().toLowerCase();
  if (!/^[0-9a-f-]{36}$/u.test(deviceId)) throw new Error("Некорректный идентификатор устройства");
  const userId = trustedDeviceUserId(context);
  return createTrustedDeviceManager({
    workerEnabled: config.miniApp.worker.enabled,
    publisher: miniAppPublisher,
    localStore: trustedDeviceStore,
  }).revoke(userId, deviceId);
}

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

async function switchProject(index) {
  const project = PROJECTS[index];
  if (!project) throw new Error("unknown project");
  if (samePath(project.path, activeProjectRoot)) return { project, changed: false };

  rememberCodexTaskSettings();
  const previousSelection = selectionStore.snapshot();
  const previousLatestDiff = latestDiff;
  selectionStore.switchProject(project.path);
  latestDiff = "";
  try {
    await createThread();
  } catch (error) {
    selectionStore.restore(previousSelection);
    latestDiff = previousLatestDiff;
    await saveState();
    throw error;
  }
  return { project, changed: true };
}

async function switchProvider(target) {
  if (target !== "codex" && target !== "claude") throw new Error("unknown provider");
  if (target === activeProvider) return { changed: false };

  rememberCodexTaskSettings();
  const previousSelection = selectionStore.snapshot();
  const previous = agentPreferences.captureCodex();
  selectionStore.switchProvider(target);
  if (target === "codex" && threadId) restoreCodexTaskSettings(threadId);
  latestDiff = "";
  try {
    if (isCodex()) {
      if (!codexTransport.running) {
        await startCodexAppServer();
        await initializeCodex();
      } else {
        await attachCodexThread();
      }
    } else if (!threadId) {
      await createThread();
    }
  } catch (error) {
    selectionStore.restore(previousSelection);
    agentPreferences.restoreCodex(previous);
    await saveState();
    throw error;
  }
  latestDiff = taskDiffs.get(taskRunKey(selectedTask())) ?? "";
  await saveState();
  return { changed: true };
}

async function resumeThread(selectedThreadId, { notify = true, context = {} } = {}) {
  const result = await selectTaskFromBinding({
    provider: activeProvider,
    projectRoot: activeProjectRoot,
    threadId: selectedThreadId,
  }, context);
  if (notify) {
    if (result.selectionChanged) await sendTaskSwitchNotification();
    else await sendTaskAlreadySelectedNotification();
  }
  return true;
}

async function renameCurrentTask(title, context = {}) {
  if (!threadId) throw new Error("текущая задача не выбрана");
  const result = await dispatchApplicationCommand(
    "task.rename",
    { title },
    context,
    { target: commandTaskTarget(selectedTask()) },
  );
  return result.renamedTitle;
}

async function activateMessageBinding(binding) {
  const project = findProject(binding.projectRoot);
  if (!project) throw new Error("проект привязанного сообщения больше не разрешён");
  if (binding.provider !== "codex" && binding.provider !== "claude") {
    throw new Error("неизвестный агент привязанного сообщения");
  }
  const alreadyActive = samePath(project.path, activeProjectRoot)
    && binding.provider === activeProvider
    && binding.threadId === threadId;
  if (alreadyActive) return { changed: false };

  rememberCodexTaskSettings();
  const previousSelection = selectionStore.snapshot();
  const previous = {
    latestDiff,
    preferences: agentPreferences.captureCodex(),
  };
  selectionStore.selectTask({
    activeProjectRoot: project.path,
    activeProvider: binding.provider,
    threadId: binding.threadId,
    activeThreadTitle: binding.taskTitle?.trim()
      || `${binding.provider === "codex" ? "Codex" : "Claude"} · ${binding.threadId.slice(0, 8)}`,
  });
  if (isCodex()) {
    restoreCodexTaskSettings(threadId);
    // Desktop already selected this durable catalog entry. Avoid scanning a
    // potentially huge rollout only to rediscover the title the caller sent.
    if (!binding.taskTitle?.trim()) {
      selectionStore.setTitle(await storedCodexThreadTitle(threadId, activeThreadTitle));
    }
  }
  latestDiff = taskDiffs.get(taskRunKey(selectedTask())) ?? "";
  try {
    // Selecting/opening a chat changes only local UI state. Starting an
    // unavailable App Server here makes a harmless task click wait for its
    // full startup timeout. The first operation that needs Codex starts it.
    await saveState();
    return { changed: true, activeTitle: activeThreadTitle };
  } catch (error) {
    selectionStore.restore(previousSelection);
    latestDiff = previous.latestDiff;
    agentPreferences.restoreCodex(previous.preferences);
    await saveState();
    throw error;
  }
}

async function archiveCurrentThread(context = {}) {
  const blockedReason = archiveBlockedReason();
  if (blockedReason) return { archived: false, reason: blockedReason };
  const result = await dispatchApplicationCommand(
    "task.archive",
    {},
    context,
    { target: commandTaskTarget(selectedTask()) },
  );
  return {
    archived: true,
    archivedThread: result.archivedThread,
    nextThread: result.nextThread ?? null,
  };
}

function archiveBlockedReason() {
  if (selectedRun()) return "active-turn";
  if (!isCodex()) return "unsupported";
  if (!threadId) return "no-current";
  return null;
}

function archiveMessage(result) {
  return formatArchiveMessage({
    archivedTask: threadTitle(result.archivedThread),
    activeTask: result.nextThread ? threadTitle(result.nextThread) : null,
  });
}

async function sendArchiveMessage(result, targetChatId = chatId) {
  const task = result.nextThread ? {
    ...selectedTask(),
    chatId: targetChatId,
    taskTitle: activeThreadTitle,
  } : null;
  const message = await sendMessageTo(targetChatId, archiveMessage(result), task
    ? { reply_markup: showLastMessageReplyMarkup(task) }
    : {});
  if (task) {
    await bindRunMessage(task, message).catch((error) => {
      console.error("Cannot bind archive result message:", error.message);
    });
  }
  return message;
}

function currentStatusSnapshot(targetChatId = chatId) {
  return {
    chatId: targetChatId,
    provider: activeProvider,
    projectRoot: activeProjectRoot,
    threadId,
    taskTitle: activeThreadTitle,
    ...agentPreferences.snapshot(),
  };
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
  removeBindings: async (run, messageIds) => {
    const removed = new Set(messageIds);
    bindingWriteQueue = bindingWriteQueue
      .catch(() => {})
      .then(() => removeMessageBindings(
        config.dataDir,
        (binding) => binding.chatId === run.chatId && removed.has(binding.messageId),
      ));
    await bindingWriteQueue;
  },
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

async function updateDeferredMessage(item, text, replyMarkup = { inline_keyboard: [] }) {
  if (!item?.messageId) return;
  await telegram("editMessageText", {
    chat_id: item.chatId,
    message_id: item.messageId,
    text,
    reply_markup: replyMarkup,
  }).catch(() => {});
}

function updateDeferredDesktopReceipt(item, state, started = null) {
  const identity = {
    provider: item?.provider,
    threadId: item?.threadId,
    clientUserMessageId: item?.clientUserMessageId,
  };
  if (!identity.clientUserMessageId) return false;
  const base = {
    id: item.id,
    clientUserMessageId: item.clientUserMessageId,
  };
  if (state === "started") {
    return desktopMessageReceipts.updateResult(identity, {
      accepted: true,
      deferred: false,
      queued: false,
      cancelled: false,
      runId: started?.id ?? null,
      threadId: started?.threadId ?? item.threadId,
      turnId: started?.turnId ?? null,
      clientUserMessageId: item.clientUserMessageId,
      attachments: item.persistentFiles
        ? desktopAttachmentDescriptors(item.temporaryFiles)
        : [],
    });
  }
  if (state === "steered") {
    return desktopMessageReceipts.updateResult(identity, {
      accepted: true,
      deferred: false,
      queued: false,
      cancelled: false,
      steered: true,
      id: item.id,
      runId: started?.runId ?? null,
      threadId: started?.threadId ?? item.threadId,
      turnId: started?.turnId ?? null,
      clientUserMessageId: item.clientUserMessageId,
      attachments: item.persistentFiles
        ? desktopAttachmentDescriptors(item.temporaryFiles)
        : [],
    });
  }
  if (state === "cancelled") {
    return desktopMessageReceipts.updateResult(identity, {
      ...base,
      accepted: false,
      deferred: false,
      cancelled: true,
      message: "Сохранённое сообщение отменено.",
    });
  }
  const queued = ["queued", "dispatching", "retrying"].includes(state);
  return desktopMessageReceipts.updateResult(identity, {
    ...base,
    accepted: false,
    deferred: true,
    queued,
    dispatching: state === "dispatching",
    reason: state === "pending" ? "launch-failed" : item.conflictKind ?? "task-running",
    message: state === "dispatching"
      ? "Сообщение отправляется в задачу."
      : state === "retrying"
        ? "Запуск временно недоступен; сообщение остаётся первым в очереди."
        : state === "pending"
          ? "Не удалось запустить сообщение; требуется выбрать дальнейшее действие."
          : "Сообщение поставлено в очередь и будет отправлено после текущего хода.",
  });
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

async function persistManagedRunHistory(run, {
  answer = "",
  status = "inProgress",
  active = true,
  turnId = run?.turnId,
} = {}) {
  if (!run?.threadId || !turnId) return;
  try {
    const history = taskSyncStore.history(run);
    mergeActiveTaskHistory(history, {
      active: true,
      turnId,
      prompt: run.promptPreview,
      answer: run.responseText,
      clientUserMessageId: run.clientUserMessageId,
      userMessages: run.userMessages,
      responseItemId: run.responseItemId,
      activities: run.activities,
      startedAt: run.startedAt,
      attachments: run.messageAttachments ?? [],
    });
    const current = history.findLast((item) => String(item?.id ?? "") === String(turnId));
    if (current) {
      current.active = active;
      current.completed = !active;
      current.status = status;
      current.answer = String(answer || run.responseText || "").trim();
      current.activities = Array.isArray(run.activities) ? run.activities.map((item) => ({ ...item })) : [];
      if (!active) current.completedAt = new Date().toISOString();
      if (current.answer) {
        const messages = Array.isArray(current.messages) ? current.messages : [];
        const itemId = String(run.responseItemId ?? "").trim() || `${turnId}:agent:final`;
        const existing = messages.find((message) => (
          message.role === "agent" && String(message.itemId ?? "") === itemId
        ));
        if (existing) {
          existing.text = current.answer;
          existing.time = current.completedAt ?? existing.time;
        } else {
          messages.push({
            itemId,
            role: "agent",
            text: current.answer,
            ...(current.completedAt ? { time: current.completedAt } : {}),
          });
        }
        current.messages = messages;
      }
    }
    taskSyncStore.recordHistory(run, history, {
      active,
      turnId: active ? turnId : null,
      activityAtMs: Date.now(),
      stage: run.progressStage,
      answer: String(answer || run.responseText || "").trim(),
      executionOwner: active ? TASK_EXECUTION_OWNERS.HUB : null,
    });
    await taskSyncStore.save();
  } catch (error) {
    console.error(`Cannot persist managed task history ${run.threadId}:`, error.message);
  }
}

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

async function completedCodexAnswer(run, completedTurnId, eventTurn = null) {
  let answer = codexFinalTurnAnswer(eventTurn);
  if (answer) return answer;
  for (const waitMs of [0, 100, 250, 500]) {
    if (waitMs) await delay(waitMs);
    try {
      const result = await readCodexThread(run.threadId, { fresh: true });
      const completedTurn = (result.thread?.turns ?? [])
        .find((turn) => String(turn?.id ?? "") === String(completedTurnId ?? ""));
      answer = codexFinalTurnAnswer(completedTurn);
      if (answer) return answer;
    } catch (readError) {
      console.warn(`Cannot read completed Codex turn ${completedTurnId ?? "unknown"}: ${readError.message}`);
    }
  }
  return run.responseText.trim();
}

function applyCodexObservedSnapshot(run, snapshot) {
  if (!run.turnId && snapshot?.turnId) {
    run.turnId = snapshot.turnId;
    taskRuns.reindex(run);
  }
  if (snapshot?.model) run.model = codexModelLabel(snapshot.model);
  if (snapshot?.reasoningEffort) {
    run.reasoning = CODEX_REASONING_LABELS[snapshot.reasoningEffort]
      ?? snapshot.reasoningEffort;
  }
}

function applyCodexActiveSnapshot(run, snapshot) {
  run.appServer = taskExecutionRuntimeLabel(run.executionOwner);
  run.activeTurnCount = Math.max(1, Number(snapshot?.activeTurnCount) || 1);
}

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
  const command = params.command ?? "(команда не указана)";
  const cwd = params.cwd ?? run?.projectRoot ?? activeProjectRoot;
  const reason = params.reason ? `\nПричина: ${params.reason}` : "";
  return `Codex запрашивает запуск команды:\n\n${command}\n\nКаталог: ${cwd}${reason}`;
}

function formatFileApproval(params) {
  const reason = params.reason ? `\nПричина: ${params.reason}` : "";
  return `Codex запрашивает изменение файлов.${reason}\n\nИспользуйте /diff после выполнения для просмотра общего diff.`;
}

function formatDuration(minutes) {
  if (minutes % 1440 === 0) return `${minutes / 1440} дн.`;
  if (minutes % 60 === 0) return `${minutes / 60} ч.`;
  return `${minutes} мин.`;
}

function formatApprovalMode() {
  if (!isCodex()) {
    return autoApprove
      ? "⚠️ Claude Code: bypassPermissions включён до перезапуска. Все действия выполняются без проверки разрешений."
      : `Claude Code: режим ${config.claudePermissionMode}. Для headless CLI отдельные запросы разрешений в Telegram недоступны.`;
  }
  return autoApprove
    ? `⚡ Автоподтверждение включено${config.autoApproveOnStart ? " по умолчанию" : " до перезапуска бота"}. Команды и изменения файлов выполняются без запроса.`
    : "🔐 Ручной режим. Команды и изменения файлов требуют подтверждения.";
}

function approvalModeKeyboard() {
  return {
    inline_keyboard: [[
      { text: autoApprove ? "⚡ Авто: включено" : "⚡ Включить авто", callback_data: uiCallback("approval-mode:auto") },
      { text: autoApprove ? "🔐 Вернуть ручной" : "🔐 Ручной: включён", callback_data: uiCallback("approval-mode:manual") },
    ]],
  };
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

function restartMessageIsEditable(request = restartRequest) {
  return Number.isSafeInteger(request?.chatId) && Number.isSafeInteger(request?.messageId);
}

async function announceDesktopRestart(request, blockingWorkCount) {
  if (!request || !Number.isSafeInteger(request.chatId)) return false;
  try {
    const message = await sendMessageTo(request.chatId, blockingWorkCount
      ? `🔄 Agent Hub Server перезапустится после завершения выполняющихся задач: ${blockingWorkCount}.`
      : "🔄 Перезапускаю Agent Hub Server…");
    if (!Number.isSafeInteger(message?.message_id) || restartRequest !== request || stopping) return false;
    request.messageId = message.message_id;
    await saveState();
    return true;
  } catch (error) {
    // A Telegram outage must not turn an already persisted Desktop request into
    // a failed release. The replacement still records the restart in the UI.
    console.warn(`Cannot announce Desktop restart: ${error.message}`);
    return false;
  }
}

async function updateRestartMessage(text, extra = {}) {
  if (!restartMessageIsEditable()) return false;
  await telegram("editMessageText", {
    chat_id: restartRequest.chatId,
    message_id: restartRequest.messageId,
    text,
    ...extra,
  });
  return true;
}

async function finalizeRestartMessage() {
  if (!restartRequest) return false;
  const request = restartRequest;
  const text = formatRestartCompleteMessage({
    provider: providerTitle(),
    task: activeThreadTitle || (threadId ? `${providerTitle()} · ${threadId.slice(0, 8)}` : "Не выбрана"),
    runningTasks: taskRuns.size,
  });
  if (!restartMessageIsEditable(request)) {
    try {
      if (Number.isSafeInteger(request.chatId)) {
        await sendMessageTo(request.chatId, text, { parse_mode: "HTML", reply_markup: BOT_MENU });
      }
    } catch (error) {
      console.error("Cannot send restart completion message:", error.message);
    }
    restartRequest = null;
    await saveState();
    return true;
  }
  return finalizeSuccessfulReplacement({
    updateMessage: () => updateRestartMessage(text, { parse_mode: "HTML" }),
    sendFallback: () => sendMessageTo(request.chatId, text, {
      parse_mode: "HTML",
      reply_markup: BOT_MENU,
    }),
    clearRestartRequest: () => { restartRequest = null; },
    saveState,
    logError: (message, error) => console.error(`${message}:`, error.message),
  });
}

const runtimeResources = new RuntimeResourceRegistry({
  flush: [
    { name: "journal startup", run: () => journalStartupReady },
    { name: "state writes", run: () => runtimeStateCoordinator.flush() },
    { name: "message binding writes", run: () => bindingWriteQueue },
    { name: "media writes", run: () => mediaController.waitForWrites() },
    { name: "task sync", run: () => taskSyncStore.save() },
    { name: "delivery outbox", run: () => deliveryOutbox.waitForWrites() },
    { name: "background jobs", run: () => backgroundJobStore.waitForWrites() },
    { name: "failed updates", run: () => failedUpdateStore.waitForWrites() },
  ],
  suspend: [
    { name: "Codex App Server", run: stopCodexAppServerTree },
    { name: "Mini App publisher", run: () => miniAppPublisher?.close() },
    { name: "direct gateway", run: () => directGatewayController?.close() },
    { name: "quick tunnel", run: () => quickTunnelController?.close() },
    { name: "public Mini App", run: () => publicMiniAppServer?.close() },
    { name: "local Mini App", run: () => miniAppServer?.close() },
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
      botFile: path.join(import.meta.dirname, "agent-hub-main.mjs"),
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
      await startMiniApp();
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
  if (restartRequest) {
    await sendMessage(restartRequest.waitingForRuns
      ? "Перезапуск уже ожидает завершения выполняющихся задач."
      : "Бот уже перезапускается.");
    return;
  }
  const blockingRuns = restartBlockingRuns();
  const blockingWorkCount = blockingRuns.length
    + backgroundJobs.size;
  const message = await sendMessage(blockingWorkCount
    ? `🔄 Перезапущу бота после завершения выполняющихся задач: ${blockingWorkCount}.`
    : "🔄 Перезапускаю Agent Hub…");
  if (!message?.message_id) throw new Error("Telegram не вернул ID сообщения перезапуска");
  restartRequest = {
    chatId,
    messageId: message.message_id,
    requestedAt: new Date().toISOString(),
    waitingForRuns: blockingWorkCount > 0,
    minimumUpdateOffset: Number.isSafeInteger(processingUpdateId)
      ? processingUpdateId + 1
      : updateOffset,
  };
  await saveState();
  if (!blockingWorkCount && processingUpdateId == null) await performRestart();
}

async function dismissCallbackMenu(message) {
  if (!message?.chat?.id || !message?.message_id) return;
  await telegram("deleteMessage", {
    chat_id: message.chat.id,
    message_id: message.message_id,
  }).catch(() => telegram("editMessageReplyMarkup", {
    chat_id: message.chat.id,
    message_id: message.message_id,
    reply_markup: { inline_keyboard: [] },
  }).catch(() => {}));
}

const telegramSettingsCallbacks = new TelegramSettingsCallbackService({
  telegram,
  dispatchSetting: dispatchTelegramSetting,
  sendMessage,
  formatApprovalMode,
  approvalModeKeyboard,
  providerTitle,
  activeProject,
  activeProvider: () => activeProvider,
  autoApprove: () => autoApprove,
  codexModel: () => agentPreferences.codexModel,
  codexModelLabel,
  codexReasoningEffort: () => agentPreferences.codexReasoningEffort,
  codexCollaborationMode: () => agentPreferences.codexCollaborationMode,
  claudeModel: () => agentPreferences.claudeModel,
  claudeReasoningEffort: () => agentPreferences.claudeReasoningEffort,
  claudeCollaborationMode: () => agentPreferences.claudeCollaborationMode,
  projects: PROJECTS,
  reasoningLabels: CODEX_REASONING_LABELS,
  collaborationModeLabels: CODEX_COLLABORATION_MODE_LABELS,
  claudeModelLabels: CLAUDE_MODEL_LABELS,
});

const telegramTaskCallbacks = new TelegramTaskCallbackService({
  telegram,
  resolveTaskViewBinding,
  runForTask: (binding) => taskRuns.forTask(binding),
  refreshTaskDiff,
  storedTaskDiff: (key) => taskDiffs.get(key),
  taskRunKey,
  sendLongMessage,
  selectTaskFromBinding,
  callbackContext: telegramCallbackCommandContext,
  showLastTaskMessage,
  showTaskMessage,
  sendMessageTo,
  sendTaskSwitchNotification,
  sendTaskAlreadySelectedNotification,
  scheduleInteractiveJob,
  sendThreadPicker,
  taskCatalog: () => taskCatalog,
  refreshTaskCatalog,
  dispatchApplicationCommand,
  activeProvider: () => activeProvider,
  sendMessage,
  providerTitle,
  archiveBlockedReason,
  archiveCurrentThread,
  sendArchiveMessage,
  dismissCallbackMenu,
  logError: (...args) => console.error(...args),
});

const telegramInputCallbacks = new TelegramInputCallbackService({
  telegram,
  sendMessageTo,
  updateDeferredDesktopReceipt,
  cleanupDeferredFiles,
  saveState,
  updateDeferredMessage,
  scheduleNextForTask: (item) => deferredInputController.scheduleNextForTask(item),
  selectTaskFromBinding,
  callbackContext: telegramCallbackCommandContext,
  showTaskMessage,
  scheduleQueuedInput,
  startTurn,
  runForTask: (binding) => taskRuns.forTask(binding),
  describeAttachments: desktopAttachmentDescriptors,
  dispatchApplicationCommand,
  activeThreadTitle: () => activeThreadTitle,
  selectedTask,
  speechText: (id) => mediaController.speechText(id),
  forwardBundleController: {
    bundleById: (...args) => forwardBundleController.bundleById(...args),
    submit: (...args) => forwardBundleController.submit(...args),
    undo: (...args) => forwardBundleController.undo(...args),
    cancel: (...args) => forwardBundleController.cancel(...args),
  },
  pendingInputs,
  queuedInputs,
  backgroundJobs,
  maxSpeechJobs: MAX_BACKGROUND_SPEECH_JOBS,
  sendTaskSwitchNotification,
  logError: (...args) => console.error(...args),
});

async function dispatchTelegramCallback(callback, route) {
  if (await telegramSettingsCallbacks.handle(callback, route)) return;
  if (await telegramTaskCallbacks.handle(callback, route)) return;
  if (await telegramInputCallbacks.handle(callback, route)) return;
  const approvalHandled = route.kind === "approval" && await dispatchApplicationCommand(
    "approval.resolve",
    { callback },
    telegramCallbackCommandContext(callback),
  );
  if (!approvalHandled) {
    await telegram("answerCallbackQuery", {
      callback_query_id: callback.id,
      text: "Эта кнопка устарела",
      show_alert: true,
    });
  }
}

const telegramCallbackController = new TelegramCallbackController({
  currentContextToken: currentUiContextToken,
  telegram,
  dispatch: dispatchTelegramCallback,
  routeCallback: (data, contextToken) => routeTelegramCallback(data, contextToken, parseApprovalCallback),
});

async function handleTelegramCallback(callback) {
  return telegramCallbackController.handle(callback);
}

function scheduleInteractiveJob(label, targetChatId, operation) {
  try {
    const job = interactiveJobs.enqueue(async () => {
      if (stopping) return;
      await operation();
    });
    void job.catch(async (error) => {
      console.error(`Interactive Telegram job ${label} failed:`, error.message);
      if (!stopping && Number.isSafeInteger(targetChatId)) {
        await sendMessageTo(targetChatId, `Не удалось выполнить «${label}»: ${error.message}`).catch(() => {});
      }
    });
    return true;
  } catch (error) {
    console.warn(`Interactive Telegram queue rejected ${label}:`, error.message);
    if (Number.isSafeInteger(targetChatId)) {
      void sendMessageTo(
        targetChatId,
        `Слишком много команд просмотра. Повторите «${label}» немного позже.`,
      ).catch(() => {});
    }
    return false;
  }
}

const telegramCommandService = new TelegramCommandService({
  sendMessage,
  providerTitle,
  sendAgentPicker,
  sendModelPicker,
  sendReasoningPicker,
  sendModePicker: sendCollaborationModePicker,
  sendProjectPicker,
  dispatchCommand: dispatchApplicationCommand,
  messageContext: telegramMessageCommandContext,
  activeProvider: () => activeProvider,
  statusSnapshot: currentStatusSnapshot,
  scheduleInteractiveJob,
  sendStatus,
  approvalModeText: formatApprovalMode,
  approvalModeKeyboard,
  restart: restartBot,
  sendTaskPicker: sendThreadPicker,
  resumeThread,
  renameCurrentTask,
  archiveCurrentTask: archiveCurrentThread,
  sendArchiveMessage,
  selectedTask,
  runForTask: (target) => taskRuns.forTask(target),
  refreshTaskDiff,
  storedTaskDiff: (key) => taskDiffs.get(key) ?? "",
  taskKey: taskRunKey,
  sendLongMessage,
  sendRunMessage,
  bindIncomingMessage: bindIncomingTaskMessage,
  startTurn,
  prompt: telegramPrompt,
  commandTaskTarget,
  menu: BOT_MENU,
});
const telegramCommandHandlers = telegramCommandService.handlers();

const forwardBundleController = new TelegramForwardBundleController({
  bundles: forwardBundles,
  selectedTarget: selectedTurnTarget,
  bindIncomingMessage: bindIncomingTaskMessage,
  sendCard: (targetChatId, text, replyMarkup) => (
    sendMessageTo(targetChatId, text, { reply_markup: replyMarkup })
  ),
  editCard: (targetChatId, messageId, text, replyMarkup) => telegram("editMessageText", {
    chat_id: targetChatId,
    message_id: messageId,
    text,
    reply_markup: replyMarkup,
  }),
  save: saveState,
  startTurn,
  enqueueImage: (payload, dedupeKey) => backgroundJobs.enqueue(
    "forward-bundle-image",
    payload,
    payload.chatId,
    { dedupeKey },
  ),
  removeFile: (file) => unlink(file).catch(() => {}),
});

const telegramMessageController = new TelegramMessageController({
  config,
  menuCommands: MENU_COMMANDS,
  setChatId: (value) => { chatId = value; },
  findReplyBinding: (targetChatId, messageId) => (
    findMessageBinding(config.dataDir, targetChatId, messageId)
  ),
  activateBinding: activateMessageBinding,
  notifyTaskSwitch: sendTaskSwitchNotification,
  selectedTurnTarget,
  bindIncomingMessage: bindIncomingTaskMessage,
  enqueueMedia: (...args) => backgroundJobs.enqueue(...args),
  commandHandlers: telegramCommandHandlers,
  handleBundleText: (message, text) => forwardBundleController.handleText(message, text),
  handleBundleMedia: (message, options) => forwardBundleController.handleImage(message, options),
  handleText: (message, text) => startTurn(telegramPrompt(message, text)),
  sendMessage,
});

async function handleTelegramMessage(message) {
  return telegramMessageController.handle(message);
}

const telegramPollingController = new TelegramPollingController({
  telegram,
  config,
  getOffset: () => updateOffset,
  setOffset: (value) => { updateOffset = value; },
  setProcessingUpdateId: (value) => { processingUpdateId = value; },
  handleMessage: handleTelegramMessage,
  handleCallback: handleTelegramCallback,
  sendMessage: sendMessageTo,
  saveState,
  preserveFailedUpdate: (update, error) => failedUpdateStore.add(update, error),
  afterUpdate: async () => {
    if (restartRequest && !restartRequest.waitingForRuns && !stopping) await performRestart();
  },
  stopping: () => stopping,
});

async function pollTelegram() {
  return telegramPollingController.run();
}

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

const runtimeLifecycle = new RuntimeLifecycleController({
  beginStopping: () => {
    if (stopping) return false;
    stopping = true;
    return true;
  },
  stopTimers: stopRuntimeTimers,
  stopManagedRuns: () => {
    for (const run of taskRuns.values()) {
      agentProviders.call(run.provider, "stopManagedRunForShutdown", run);
    }
  },
  stopMedia: () => mediaController.stop(),
  resources: runtimeResources,
});

let agentHubStartPromise = null;

const startupCoordinator = new AgentHubStartupCoordinator({
  telegramEnabled: config.telegramEnabled,
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
  startMiniApp: () => miniAppServer ? startMiniApp() : null,
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

async function startAgentHubOnce() {
  return startupCoordinator.start();
}

export function startAgentHub() {
  agentHubStartPromise ??= startAgentHubOnce();
  return agentHubStartPromise;
}

export function shutdownAgentHub(signal = "shutdown") {
  return runtimeLifecycle.shutdown(signal);
}
