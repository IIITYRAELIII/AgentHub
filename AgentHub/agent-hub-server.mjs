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
import * as telegramStatus from "./src/interfaces/telegram/status.mjs";
const {
  formatArchiveMessage, formatClaudeRateLimits, formatCodexRateLimits, formatProgressHeading,
  formatRestartCompleteMessage, formatTaskAlreadySelectedMessage, formatTaskSwitchMessage,
  showLastMessageReplyMarkup,
} = telegramStatus;
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
import { randomStatusHeaderFileName } from "./src/interfaces/telegram/status-header.mjs";
import { TelegramClient } from "./telegram-client.mjs";
import { emptyTokenUsage } from "./token-usage.mjs";
import { telegramPrompt } from "./src/interfaces/telegram/telegram-message.mjs";
import {
  forwardBundleAttachmentPaths,
  restoreForwardBundle,
  TelegramForwardBundleController,
} from "./src/interfaces/telegram/telegram-forward-bundle.mjs";
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
} from "./src/infrastructure/persistence/message-bindings.mjs";
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
import { listClaudeSessionSnapshots, readClaudeSessionSnapshot } from "./last-message.mjs";
import {
  mergeActiveTaskHistory,
  mergeCompletedTaskHistory,
} from "./task-history.mjs";
import * as approvalProtocol from "./src/providers/codex/codex-approvals.mjs";
const { formatPermissionsApproval, parseApprovalCallback } = approvalProtocol;
import { contextualCallback } from "./src/interfaces/telegram/callback-context.mjs";
import { taskViewCallbackData } from "./src/interfaces/telegram/task-view-callback.mjs";
import { PersistentDeliveryOutbox } from "./delivery-outbox.mjs";
import { installRotatingConsole } from "./rotating-log.mjs";
import { writeTextAtomic } from "./state-store.mjs";
import { RuntimeStateStore } from "./src/infrastructure/persistence/runtime-state-store.mjs";
import { TaskReadStateStore, taskHasUnreadAnswer } from "./task-read-state-store.mjs";
import { LocalTaskSyncStore } from "./task-sync-store.mjs";
import { MessageReceiptRegistry } from "./message-receipts.mjs";
import { createDesktopMessageController } from "./src/interfaces/desktop/desktop-message-controller.mjs";
import { createTrustedDeviceManager, resolveTrustedDeviceUserId } from "./src/interfaces/web/trusted-device-access.mjs";
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
} from "./src/application/turn-end-notifications.mjs";
import { conciseTurnTitle } from "./turn-title.mjs";
import { DesktopControlServer } from "./desktop-control.mjs";
import { defaultRuntimeRoot } from "./runtime-layout.mjs";
import { MediaController } from "./src/interfaces/telegram/media-controller.mjs";
import { TelegramMessageController } from "./src/interfaces/telegram/telegram-message-controller.mjs";
import { ApprovalController } from "./src/interfaces/telegram/approval-controller.mjs";
import { TelegramCallbackController } from "./src/interfaces/telegram/telegram-callback-controller.mjs";
import { routeTelegramCallback } from "./src/interfaces/telegram/telegram-callback-router.mjs";
import { TelegramTaskPickerService } from "./src/interfaces/telegram/task-picker.mjs";
import { InteractiveJobService } from "./src/interfaces/telegram/interactive-job-service.mjs";
import { RestartNotificationService } from "./src/interfaces/telegram/restart-notification-service.mjs";
import {
  approvalModeKeyboard as presentApprovalModeKeyboard,
  formatApprovalMode as presentApprovalMode,
  formatCommandApproval as presentCommandApproval,
  formatFileApproval as presentFileApproval,
} from "./src/interfaces/telegram/approval-presentation.mjs";
import { TaskViewController } from "./src/interfaces/telegram/task-view-controller.mjs";
import { TelegramPollingController } from "./src/interfaces/telegram/telegram-polling-controller.mjs";
import { TelegramSettingsMenu } from "./src/interfaces/telegram/telegram-settings-menu.mjs";
import { TelegramStatusController } from "./src/interfaces/telegram/telegram-status-controller.mjs";
import { TelegramDeliveryService } from "./src/interfaces/telegram/telegram-delivery-service.mjs";
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
import { miniAppMenuButtonRequests, MiniAppServer } from "./src/interfaces/web/mini-app-server.mjs";
import { MiniAppPublisher } from "./src/interfaces/web/mini-app-publisher.mjs";
import { DirectGatewayController, loadDirectGatewaySettings } from "./src/interfaces/web/direct-gateway.mjs";
import { QuickTunnelController } from "./quick-tunnel.mjs";
import { ensureLocalWebSecret } from "./src/interfaces/web/local-web-auth.mjs";
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
import { DesktopTaskService } from "./src/interfaces/desktop/desktop-task-service.mjs";
import { DesktopSystemService } from "./src/interfaces/desktop/desktop-system-service.mjs";
import { DeferredInputPresentationService } from "./src/interfaces/desktop/deferred-input-presentation-service.mjs";
import { TaskCommandService } from "./src/application/task-command-service.mjs";
import { TaskNavigationService } from "./src/application/task-navigation-service.mjs";
import { ManagedRunHistoryService } from "./src/application/managed-run-history-service.mjs";
import { RestartRequestService } from "./src/application/restart-request-service.mjs";
import { createDesktopApplicationRouter } from "./src/interfaces/desktop/desktop-application-router.mjs";
import { UsdRubRateStore } from "./exchange-rate.mjs";
import { agentHubAutostartShortcut } from "./src/interfaces/web/server-page.mjs";
import {
  defaultAutostartInstallScript,
  ServerControlController,
} from "./src/interfaces/web/server-control-controller.mjs";
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
let telegramDeliveryService = null;
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
  modelLabel: codexModelLabel,
  reasoningLabels: CODEX_REASONING_LABELS,
  runtimeLabel: taskExecutionRuntimeLabel,
  delay,
  reindexRun: (run) => taskRuns.reindex(run),
  logger: console,
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
const managedRunHistory = new ManagedRunHistoryService({
  taskSyncStore,
  mergeActiveHistory: mergeActiveTaskHistory,
  hubExecutionOwner: TASK_EXECUTION_OWNERS.HUB,
  nowIso: () => new Date().toISOString(),
  nowMs: () => Date.now(),
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

const deferredInputPresentation = new DeferredInputPresentationService({
  telegram,
  receipts: desktopMessageReceipts,
  describeAttachments: desktopAttachmentDescriptors,
});
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
  formatClaudeRateLimits,
  formatCodexRateLimits,
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
  parseClaudeLimits,
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
  approvalProtocol,
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
      publisher: miniAppPublisher,
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

function activateMessageBinding(...args) { return taskNavigationService.activate(...args); }

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
  await restartRequestService.fromTelegram();
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

const telegramCallbackController = new TelegramCallbackController({
  currentContextToken: currentUiContextToken,
  telegram,
  handlers: [telegramSettingsCallbacks, telegramTaskCallbacks, telegramInputCallbacks],
  dispatchApproval: (callback) => dispatchApplicationCommand(
    "approval.resolve",
    { callback },
    telegramCallbackCommandContext(callback),
  ),
  routeCallback: (data, contextToken) => routeTelegramCallback(data, contextToken, parseApprovalCallback),
});

async function handleTelegramCallback(callback) {
  return telegramCallbackController.handle(callback);
}

const interactiveJobService = new InteractiveJobService({
  queue: interactiveJobs,
  stopping: () => stopping,
  sendMessage: sendMessageTo,
});

function scheduleInteractiveJob(...args) { return interactiveJobService.schedule(...args); }

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
