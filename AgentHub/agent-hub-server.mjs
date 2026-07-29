import { spawn } from "node:child_process";
import { mkdir, readFile, stat, unlink } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
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
import {
  buildClaudeArgs,
  buildClaudePrompt,
  claudeFailureMessage,
  claudeThinkingTokens,
  formatClaudeUsage,
  resolveClaudeSessionCwd,
} from "./claude.mjs";
import {
  cleanupOrphanedClaudeRunOutputs,
  processIsAlive,
  stopProcessTree,
} from "./claude-run-io.mjs";
import { ClaudeRunController } from "./claude-run-controller.mjs";
import {
  buildCodexCollaborationMode,
  CODEX_COLLABORATION_MODE_LABELS,
  CODEX_COLLABORATION_MODES,
  CODEX_REASONING_EFFORTS,
  CODEX_REASONING_LABELS,
  resolveCodexThreadSettings,
} from "./codex-settings.mjs";
import {
  formatArchiveMessage,
  formatClaudeRateLimits,
  formatCodexRateLimits,
  formatProgressHeading,
  formatRestartCompleteMessage,
  formatStatusMessage,
  formatTaskAlreadySelectedMessage,
  formatTaskSwitchMessage,
  showLastMessageReplyMarkup,
} from "./status.mjs";
import {
  findCodexRolloutPath,
  readCodexTurnUsage,
  scanCodexTurnPricingMetadata,
} from "./codex-turn-usage.mjs";
import { CodexTerminalAudit } from "./codex-terminal-audit.mjs";
import { appendRateLimitRows, codexRateLimitRows } from "./rate-limit-history.mjs";
import {
  CODEX_AUDIT_SOURCE_KINDS,
  CODEX_TASK_SOURCE_KINDS,
  resolveCodexAccountingThread,
} from "./codex-subagent-accounting.mjs";
import { routeCodexFinalDelivery } from "./codex-final-delivery.mjs";
import { randomStatusHeaderFileName } from "./status-header.mjs";
import { TelegramClient } from "./telegram-client.mjs";
import {
  addTokenUsage,
  emptyTokenUsage,
  formatTurnTokenUsage,
  normalizeTokenUsage,
  tokenUsageDelta,
} from "./token-usage.mjs";
import { telegramPrompt } from "./telegram-message.mjs";
import {
  captureTaskGitBaseline,
  cleanupTaskGitIndexes,
  resolveTaskGitRepoRoots,
  taskGitDiff,
} from "./task-git-diff.mjs";
import { TaskDiffStore } from "./task-diff-store.mjs";
import { findRepositoryWriteConflict } from "./repository-conflict.mjs";
import { pendingInputKeyboard, restoreDeferredInput } from "./deferred-input.mjs";
import {
  appendMessageBindings,
  findMessageBinding,
  readMessageBindings,
  removeMessageBindings,
} from "./message-bindings.mjs";
import {
  readCodexThreadTitleHistories,
  readCodexThreadTitleHistory,
  parseArguments as parseSendMessageArguments,
  resolveChatId as resolveNotificationChatId,
  showMessageReplyMarkup,
} from "./send-message.mjs";
import { parseArguments as parseSendImagesArguments } from "./send-images.mjs";
import {
  cleanRuntimeCallerEnvironment,
  resolveAllowedNotificationCwd,
  resolveAllowedNotificationPath,
} from "./notification-security.mjs";
import {
  formatProgressHeartbeat,
  markProgressHeartbeat,
  PROGRESS_STALLED_AFTER_MS,
  retainProgressMessageAfterEditError,
} from "./progress-heartbeat.mjs";
import {
  createManagedTaskRun,
  createObservedTaskRun,
  serializableTaskRun,
  shouldAutoObserveTask,
  shouldDeliverObservedCompletion,
  TaskDismissalRegistry,
  TaskRunRegistry,
  taskRunKey,
  updateObservedResponse,
  updateTaskRunTitle,
} from "./task-runs.mjs";
import {
  codexFinalTurnAnswer,
  codexTurnHasExplicitFinalAnswer,
  codexTurnAnswer,
  listClaudeSessionSnapshots,
  readClaudeSessionSnapshot,
} from "./last-message.mjs";
import {
  codexThreadHistory,
  mergeActiveTaskHistory,
} from "./task-history.mjs";
import { startCodexTurnWithRecovery } from "./codex-recovery.mjs";
import {
  codexThreadWaitingOnApproval,
  formatPermissionsApproval,
} from "./codex-approvals.mjs";
import { contextualCallback } from "./callback-context.mjs";
import { taskViewCallbackData } from "./task-view-callback.mjs";
import { PersistentDeliveryOutbox } from "./delivery-outbox.mjs";
import { installRotatingConsole } from "./rotating-log.mjs";
import { readJsonWithBackup, writeTextAtomic } from "./state-store.mjs";
import { LocalTaskSyncStore } from "./task-sync-store.mjs";
import { unavailableLocalMcpOverrides } from "./local-mcp-preflight.mjs";
import { SingleInstanceGuard } from "./instance-lock.mjs";
import { BackgroundJobQueue } from "./background-job-queue.mjs";
import { PersistentBackgroundJobStore } from "./background-job-store.mjs";
import { FailedTelegramUpdateStore } from "./failed-update-store.mjs";
import { resolveClaudeInvocation as resolveInstalledClaudeInvocation } from "./claude-invocation.mjs";
import {
  catalogEntryIsSelected,
  claudeCatalogEntry,
  claudeSnapshotActivityAtMs,
  claudeSnapshotActivityState,
  codexRolloutTurnState,
  codexCatalogEntry,
  codexThreadRunning,
  mergeTaskCatalog,
  pinnedTaskTitle as readPinnedTaskTitle,
  pinTaskTitle as writePinnedTaskTitle,
  preferredCodexTaskTitle,
  reconcilePinnedTaskTitle,
  readCodexRolloutActivity,
  runningTaskReplyMarkup,
  selectCodexTurn,
  selectExactActiveCodexTurnId,
  TASK_EXECUTION_OWNERS,
  taskExecutionRuntimeLabel,
} from "./task-catalog.mjs";
import { resolveCodexObservedExecutionOwner } from "./codex-runtime-owner.mjs";
import {
  botReplacementInvocation,
  directWindowsLauncherInvocation,
  launchReplacementAndWait,
} from "./runtime-restart.mjs";
import { restorePreviousBotAfterFailedReplacement } from "./restart-recovery.mjs";
import { RuntimeCommandServer } from "./runtime-command.mjs";
import {
  TurnEndNotificationRegistry,
  turnEndKey,
} from "./turn-end-notifications.mjs";
import { conciseTurnTitle } from "./turn-title.mjs";
import { DesktopControlServer } from "./desktop-control.mjs";
import { defaultRuntimeRoot } from "./runtime-layout.mjs";
import { MediaController } from "./media-controller.mjs";
import { TelegramMessageController } from "./telegram-message-controller.mjs";
import { ApprovalController } from "./approval-controller.mjs";
import { TelegramCallbackController } from "./telegram-callback-controller.mjs";
import { buildTaskPicker } from "./task-picker.mjs";
import { TaskViewController } from "./task-view-controller.mjs";
import { TelegramPollingController } from "./telegram-polling-controller.mjs";
import { resolveCodexExecutable as resolveInstalledCodexExecutable } from "./codex-invocation.mjs";
import { CodexAppServerTransport } from "./codex-app-server-transport.mjs";
import { TaskProgressController } from "./task-progress-controller.mjs";
import { TaskObserverController } from "./task-observer-controller.mjs";
import { DeferredInputController } from "./deferred-input-controller.mjs";
import { resolveTaskRecoveryAction, TASK_RECOVERY_ACTIONS } from "./task-recovery.mjs";
import { WorkLogUsageStore } from "./work-log-usage.mjs";
import { miniAppMenuButtonRequests, MiniAppServer } from "./mini-app-server.mjs";
import { MiniAppPublisher } from "./mini-app-publisher.mjs";
import { QuickTunnelController } from "./quick-tunnel.mjs";

const config = await loadConfig();
const workLogUsageStore = new WorkLogUsageStore({
  ledgerFile: path.join(config.dataDir, "work-log-usage.json"),
  defaultProjectRoot: config.projectRoot,
});
const miniAppServer = config.miniApp.enabled
  ? new MiniAppServer({
    ...config.miniApp,
    workLogFile: path.join(config.projectRoot, "WORK_LOG.md"),
    botToken: config.token,
    allowedUserIds: config.allowedUserIds,
  })
  : null;
const publicMiniAppServer = config.miniApp.enabled && config.miniApp.quickTunnel.enabled
  ? new MiniAppServer({
    host: config.miniApp.host,
    port: config.miniApp.quickTunnel.publicPort,
    workLogFile: path.join(config.projectRoot, "WORK_LOG.md"),
    botToken: config.token,
    allowedUserIds: config.allowedUserIds,
    requireTelegramAuth: true,
  })
  : null;
const defaultDataDirectory = path.join(AGENT_HUB_ROOT, "data");
const logDirectory = samePath(config.dataDir, defaultDataDirectory)
  ? AGENT_HUB_ROOT
  : config.dataDir;
installRotatingConsole({
  stdoutFile: path.join(logDirectory, "telegram-codex.log"),
  stderrFile: path.join(logDirectory, "telegram-codex-error.log"),
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
let claudeModel = CLAUDE_MODELS.includes(config.claudeModel) ? config.claudeModel : "sonnet";
// Claude использует те же уровни «мощи дум» и режимы Plan/Work, что и Codex,
// но применяет их по-своему: мощь дум -> бюджет thinking-токенов, режим -> permission-mode.
let claudeReasoningEffort = CODEX_REASONING_EFFORTS.includes(config.claudeReasoningEffort)
  ? config.claudeReasoningEffort
  : "high";
let claudeCollaborationMode = CODEX_COLLABORATION_MODES.includes(config.claudeCollaborationMode)
  ? config.claudeCollaborationMode
  : "default";
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
let codexModel = defaultCodexModel;
let codexReasoningEffort = defaultCodexReasoningEffort;
let codexCollaborationMode = config.codexCollaborationMode;
const codexTaskSettings = {};
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
const STATUS_LIMITS_CACHE_MS = 60_000;
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

const instanceGuard = new SingleInstanceGuard({ dataDir: config.dataDir, lockFile: INSTANCE_LOCK_FILE });
await instanceGuard.acquire();
const turnEndNotifications = new TurnEndNotificationRegistry();
const deliveringTurnEndKeys = new Set();
const runtimeCommandRoot = process.env.AGENT_HUB_RUNTIME_ROOT
  ?? process.env.TELEGRAM_INTEGRATION_RUNTIME_ROOT
  ?? ((process.env.AGENT_HUB_CONFIG ?? process.env.TELEGRAM_CODEX_CONFIG)
    ? path.dirname(config.configPath)
    : defaultRuntimeRoot());
const runtimeCommandServer = new RuntimeCommandServer({
  runtimeRoot: runtimeCommandRoot,
  handler: handleRuntimeCommand,
});
await runtimeCommandServer.start();
let desktopControlServer = null;
let desktopMutationQueue = Promise.resolve();

let updateOffset = 0;
let chatId = null;
let activeProjectRoot = DEFAULT_PROJECT_ROOT;
const threadIdsByProvider = { codex: null, claude: null };
const pinnedTaskTitles = {};
let threadId = null;
let activeThreadTitle = "";
let latestDiff = "";
let stopping = false;
let autoApprove = config.autoApproveOnStart;
let codexRestarting = false;
let restartRequest = null;
let processingUpdateId = null;
let stateWriteQueue = Promise.resolve();
let lastStateBackupAt = 0;
let bindingWriteQueue = Promise.resolve();
let deliveryOutboxTimer = null;
let deliveryOutboxTimerDueAt = 0;
let selectedTaskWatchTimer = null;
let selectedTaskWatchInFlight = false;
let rateLimitPollTimer = null;
const reconcilingCodexTerminalTurns = new Set();
const SELECTED_TASK_WATCH_INTERVAL_MS = 2_000;
const COMPLETED_CODEX_TERMINAL_GRACE_MS = 10_000;
const EXTERNAL_TASK_POLL_INTERVAL_MS = 1_500;
const MANAGED_TASK_FALLBACK_POLL_INTERVAL_MS = 5_000;
const CLAUDE_OUTPUT_POLL_INTERVAL_MS = 250;
const TASK_CATALOG_CACHE_MS = 1_500;
const CODEX_RPC_TIMEOUT_MS = config.codexRpcTimeoutSeconds * 1000;
const threadTokenTotals = new Map();
const turnTokenUsage = new Map();
const codexTurnStarts = new Map();
const codexAccountingThreadRoots = new Map();
let codexHookReceipts = { start: null, stop: null };

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
      workLogFile: path.join(project.path, "WORK_LOG.md"),
    });
    if (!result.retracted) return;
    turnEndNotifications.retract(identity);
    await saveState();
    console.log(`Retracted premature Codex terminal turn ${identity.turnId}`);
  },
  resolveProject: (thread) => findProject(thread.cwd),
  reconcile: reconcileRecentCodexTerminalTurn,
});
const turnTemporaryFiles = new Map();
const turnSpeechButtons = new Map();
const taskRuns = new TaskRunRegistry();
const backgroundJobStore = new PersistentBackgroundJobStore({
  directoryPath: BACKGROUND_JOBS_DIR,
  maxItems: MAX_BACKGROUND_MEDIA_JOBS + MAX_BACKGROUND_SPEECH_JOBS,
});
const failedUpdateStore = new FailedTelegramUpdateStore({ directoryPath: FAILED_UPDATES_DIR });
await failedUpdateStore.load();
const scheduledBackgroundJobIds = new Set();
const backgroundMediaJobs = new BackgroundJobQueue({
  concurrency: 1,
  maxJobs: MAX_BACKGROUND_MEDIA_JOBS,
  onChange: handleBackgroundJobQueueChange,
});
const backgroundSpeechJobs = new BackgroundJobQueue({
  concurrency: 1,
  maxJobs: MAX_BACKGROUND_SPEECH_JOBS,
  onChange: handleBackgroundJobQueueChange,
});
const interactiveJobs = new BackgroundJobQueue({
  concurrency: 2,
  maxJobs: MAX_INTERACTIVE_JOBS,
});
const dismissedExternalTasks = new TaskDismissalRegistry();
const cancelledManagedClaudeTasks = new Map();
const pendingInputs = new Map();
const gitRepoRoots = new Map();
const queuedInputs = new Map();
const taskDiffs = new TaskDiffStore({ filePath: TASK_DIFFS_FILE, limit: 100 });
await taskDiffs.load();
const lastTaskMessages = new Map();
const lastSeenTaskTurnIds = new Map();
const statusMediaFileIds = new Map();
const statusLimitsCache = new Map();
const statusLimitsInFlight = new Map();
const uiContextNonce = randomUUID();
let taskCatalog = [];
let taskCatalogRefreshedAt = 0;
let taskCatalogRefreshInFlight = null;
let workLogPricingBackfillAttempted = false;
const taskSyncStore = new LocalTaskSyncStore({
  filePath: TASK_SYNC_FILE,
  canonicalizeProjectRoot: (projectRoot) => findProject(projectRoot)?.path ?? projectRoot,
  canonicalizeValue: (value) => canonicalizeProjectRoots(value, PROJECTS),
});
await taskSyncStore.load();
await taskSyncStore.save();

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

async function startMiniApp() {
  if (!miniAppServer) return null;
  const address = await miniAppServer.start();
  if (config.miniApp.worker.enabled) {
    miniAppPublisher ??= new MiniAppPublisher({
      workLogFile: path.join(config.projectRoot, "WORK_LOG.md"),
      ...config.miniApp.worker,
      onPublished: async (url) => {
        await Promise.all(miniAppMenuButtonRequests({
          url,
          text: config.miniApp.worker.menuText,
          chatIds: config.allowedUserIds,
        }).map((body) => telegram("setChatMenuButton", body)));
        console.log(`Telegram Mini App Worker ready at ${url}`);
      },
    });
    await miniAppPublisher.start().catch((error) => {
      console.warn(`Cannot publish Mini App journal yet: ${error.message}`);
    });
  }
  if (!config.miniApp.quickTunnel.enabled) return address;
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
      await Promise.all(miniAppMenuButtonRequests({
        url,
        text: config.miniApp.quickTunnel.menuText,
        chatIds: config.allowedUserIds,
      }).map((body) => telegram("setChatMenuButton", body)));
    },
  });
  const publicUrl = await quickTunnelController.start();
  console.log(`Telegram Mini App ready at ${publicUrl}`);
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
  setProgressStage,
  telegram,
  currentChatId: () => chatId,
});

function invalidateTaskCatalog() {
  taskCatalogRefreshedAt = 0;
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
          scheduleProgressUpdate(run);
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

function findProject(projectRoot) {
  return findContainingProject(PROJECTS, projectRoot);
}

function activeProject() {
  return findProject(activeProjectRoot) ?? PROJECTS[0];
}

function selectedTask() {
  return { provider: activeProvider, projectRoot: activeProjectRoot, threadId };
}

function selectedTurnTarget(targetChatId = chatId) {
  const selected = selectedTask();
  const catalogEntry = taskCatalog.find((entry) => catalogEntryIsSelected(entry, selected));
  return {
    ...selected,
    sessionCwd: catalogEntry?.sessionCwd ?? null,
    taskTitle: activeThreadTitle,
    chatId: targetChatId,
    modelId: activeProvider === "codex" ? codexModel : claudeModel,
    reasoningId: activeProvider === "codex" ? codexReasoningEffort : claudeReasoningEffort,
    collaborationMode: activeProvider === "codex" ? codexCollaborationMode : claudeCollaborationMode,
  };
}

function currentUiContextToken() {
  return createHash("sha256")
    .update(`${uiContextNonce}\0${activeProvider}\0${path.resolve(activeProjectRoot)}\0${threadId ?? ""}`)
    .digest("hex")
    .slice(0, 12);
}

function uiCallback(action) {
  return contextualCallback(action, currentUiContextToken());
}

function selectedRun() {
  return taskRuns.forTask(selectedTask());
}

function isSelectedRun(run) {
  return Boolean(run)
    && run.provider === activeProvider
    && samePath(run.projectRoot, activeProjectRoot)
    && String(run.threadId ?? "") === String(threadId ?? "");
}

function runProject(run) {
  return findProject(run?.projectRoot) ?? { name: path.basename(run?.projectRoot ?? "") || "Проект" };
}

function runTaskTitle(run) {
  return String(run?.taskTitle ?? "").trim()
    || `${run?.provider === "claude" ? "Claude" : "Codex"} · ${String(run?.threadId ?? run?.id ?? "").slice(0, 8)}`;
}

function pinnedTaskTitle(provider, id) {
  return readPinnedTaskTitle(pinnedTaskTitles, provider, id);
}

function pinTaskTitle(provider, id, title) {
  return writePinnedTaskTitle(pinnedTaskTitles, provider, id, title);
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

function setBoundedObjectValue(object, key, value, limit) {
  if (Object.hasOwn(object, key)) delete object[key];
  object[key] = value;
  while (Object.keys(object).length > limit) delete object[Object.keys(object)[0]];
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

async function bindIncomingTaskMessage(message, text) {
  const task = selectedTask();
  if (!task.threadId || !Number.isSafeInteger(message?.message_id)) return;
  const binding = {
    ...task,
    chatId: message.chat.id,
    messageId: message.message_id,
    taskTitle: activeThreadTitle,
    createdAt: new Date((Number(message.date) || Math.floor(Date.now() / 1000)) * 1000).toISOString(),
    kind: "incoming-user",
    role: "user",
    text: String(text ?? "").trim().slice(0, 12000),
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
  const value = `${runProgressHeading(run, true)}\n\n${String(text)}`;
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
  if (complete) await completeRun(run);
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
  const value = String(text ?? "").trim();
  if (!run?.threadId || !value) return;
  setBoundedMapValue(lastTaskMessages, taskRunKey(run), {
    text: value,
    updatedAt: new Date().toISOString(),
  }, 500);
}

function savedLastTaskMessage(task) {
  return lastTaskMessages.get(taskRunKey(task))?.text ?? "";
}

function savedLastTaskMessageRecord(task) {
  return lastTaskMessages.get(taskRunKey(task)) ?? null;
}

function trackTurnTokenUsage(params) {
  const current = normalizeTokenUsage(params.tokenUsage?.total);
  const previous = threadTokenTotals.get(params.threadId);
  setBoundedMapValue(threadTokenTotals, params.threadId, current, 500);

  const tracker = turnTokenUsage.get(params.turnId);
  if (!tracker) return;
  const delta = tokenUsageDelta(current, previous, params.tokenUsage?.last);
  tracker.usage = addTokenUsage(tracker.usage, delta);
  tracker.reported = true;
}

function consumeTurnTokenTracker(turnId) {
  const tracker = turnTokenUsage.get(turnId);
  turnTokenUsage.delete(turnId);
  return tracker
    ? { usage: normalizeTokenUsage(tracker.usage), reported: tracker.reported === true }
    : { usage: emptyTokenUsage(), reported: false };
}

function fallbackTurnEndMessage(status) {
  if (status === "completed") return "Ход завершён.";
  if (status === "aborted") return "Ход остановлен пользователем.";
  if (status === "cancelled") return "Ход отменён.";
  if (status === "failed") return "Ход завершился с ошибкой.";
  return `Ход завершён со статусом ${status}.`;
}

function applyCodexRolloutContext(run, usageResult) {
  if (!run || !usageResult) return;
  if (usageResult.startedAt) run.startedAt = usageResult.startedAt;
  if (usageResult.model) run.modelId = usageResult.model;
  if (usageResult.serviceTier) run.serviceTier = usageResult.serviceTier;
  if (usageResult.prompt) run.promptPreview = String(usageResult.prompt).slice(0, 100_000);
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
  const workLogId = completion?.message?.workLogId;
  const project = findProject(completion.projectRoot);
  if (!project) throw new Error(`Cannot find WORK_LOG project for ${completion.projectRoot}`);
  const fields = {
    provider: completion.provider,
    threadId: completion.threadId,
    turnId: completion.turnId,
    usage: completion.usage,
    usageReported: completion.usageReported,
    estimatedCredits: completion.estimatedCredits,
    estimateKind: completion.estimateKind,
    model: completion.model,
    serviceTier: completion.serviceTier,
    taskThreadId: completion.taskThreadId,
    parentThreadId: completion.parentThreadId,
    aggregateOnly: completion.aggregateOnly,
    provisional: completion.provisional,
    taskTitle: completion.taskTitle,
    title: title || (body ? conciseTurnTitle(body, completion.status) : ""),
    body,
    prompt: completion.prompt,
    changedFiles: completion.changedFiles,
    diff: completion.diff,
    startedAt: completion.startedAt,
    completedAt: completion.completedAt,
    status: completion.status,
    projectRoot: project.path,
    workLogFile: path.join(project.path, "WORK_LOG.md"),
  };
  if (!workLogId) {
    return workLogUsageStore.recordAutomaticAndProject({
      ...fields,
    });
  }
  return workLogUsageStore.recordAndProject({
    ...fields,
    workLogId,
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
  if (!run || !completedTurnId) {
    return finalizeRunDelivery(run, {
      answer,
      forceSpeechButton,
      deliver,
      silent,
      description,
    });
  }
  const startKey = turnEndKey({
    provider: "codex",
    threadId: run.threadId,
    turnId: completedTurnId,
  });
  const turnStart = codexTurnStarts.get(startKey);
  if (turnStart) {
    run.gitBaseline = turnStart.gitBaseline ?? run.gitBaseline;
    run.startedAt = turnStart.startedAt || run.startedAt;
    run.promptPreview = turnStart.prompt || run.promptPreview;
  }
  await refreshTaskDiff(run).catch((error) => {
    console.error(`Cannot capture changed files for turn ${completedTurnId}:`, error.message);
  });
  const existingCompletion = turnEndNotifications.get({
    provider: "codex",
    threadId: run.threadId,
    turnId: completedTurnId,
  });
  const completion = turnEndNotifications.recordCompletion({
    provider: "codex",
    threadId: run.threadId,
    turnId: completedTurnId,
    projectRoot: run.projectRoot,
    taskTitle: runTaskTitle(run),
    chatId: run.chatId ?? chatId ?? defaultNotificationChatId(),
    status,
    usage: tracker.usage,
    usageReported: tracker.reported === true,
    imageGenerationCount: tracker.imageGenerationCount ?? 0,
    estimatedCredits: tracker.estimatedCredits ?? 0,
    estimateKind: tracker.estimateKind ?? "",
    model: tracker.model ?? run.modelId ?? "",
    serviceTier: tracker.serviceTier ?? run.serviceTier ?? "default",
    startedAt: run.startedAt,
    prompt: run.promptPreview,
    finalAnswer: String(answer ?? "").trim(),
    changedFiles: changedFilesForRun(run),
    diff: run.latestDiff ?? "",
  });
  codexTurnStarts.delete(startKey);
  await saveState();
  const resolvedTracker = completion
    ? {
      usage: completion.usage,
      reported: completion.usageReported,
      estimatedCredits: completion.estimatedCredits,
      model: completion.model,
      serviceTier: completion.serviceTier,
    }
    : tracker;
  const shouldDeliver = deliver || Boolean(existingCompletion);
  const message = [
    answer,
    formatTurnTokenUsage(resolvedTracker),
  ].filter(Boolean).join("\n\n");
  const delivery = await routeCodexFinalDelivery({
    completion,
    deliverStandard: async () => {
      if (completion) {
        await projectTurnUsageToWorkLog(completion, {
          title: conciseTurnTitle(answer, status),
          body: answer,
        }).catch((error) => {
          console.error(`Cannot update WORK_LOG usage for turn ${completedTurnId}:`, error.message);
        });
      }
      const result = await finalizeRunDelivery(run, {
        answer,
        message,
        speechText: answer,
        forceSpeechButton,
        deliver: shouldDeliver,
        silent,
        complete: false,
        description,
      });
      if (completion) {
        turnEndNotifications.markDelivered(completion);
        await saveState();
      }
      return result;
    },
  });
  await completeRun(run);
  return delivery.result;
}

async function deliverTurnEndNotification(completion) {
  if (!completion) return false;
  const key = turnEndKey(completion);
  if (turnEndNotifications.hasDelivered(key) || deliveringTurnEndKeys.has(key)) return false;
  deliveringTurnEndKeys.add(key);
  try {
    const notificationBody = completion.finalAnswer
      || completion.message?.text
      || fallbackTurnEndMessage(completion.status);
    const notificationTitle = completion.message?.title
      || conciseTurnTitle(notificationBody, completion.status);
    const journal = await projectTurnUsageToWorkLog(completion, {
      title: notificationTitle,
      body: notificationBody,
    });
    if (!completion.aggregateOnly) {
      rememberLastTaskMessage({
        provider: completion.provider,
        projectRoot: completion.projectRoot,
        threadId: completion.threadId,
      }, notificationBody);
      if (completion.turnId) {
        setBoundedMapValue(lastSeenTaskTurnIds, taskRunKey(completion), completion.turnId, 500);
      }
    }
    if (journal?.projectionError) {
      console.error(
        `WORK_LOG projection deferred for turn ${completion.turnId}: ${journal.projectionError}`,
      );
    }
    turnEndNotifications.markDelivered(key);
    await saveState();
    return true;
  } finally {
    deliveringTurnEndKeys.delete(key);
  }
}

async function retryPendingTurnEndNotifications() {
  for (const completion of turnEndNotifications.values()) {
    const run = taskRuns.forEvent({
      provider: completion.provider,
      threadId: completion.threadId,
      turnId: completion.turnId,
      allowThreadFallback: true,
    });
    if (run && ["running", "finishing"].includes(run.status)) continue;
    await deliverTurnEndNotification(completion).catch((error) => {
      console.error(`Cannot deliver pending turn-end notification ${completion.turnId}:`, error.message);
    });
  }
}

async function waitForTurnEndCompletion(identity, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const completion = turnEndNotifications.get(identity);
    if (completion?.usageReported || Number(completion?.estimatedCredits) > 0) return completion;
    await delay(50);
  }
  return turnEndNotifications.get(identity);
}

function rememberCodexTaskSettings(id = isCodex() ? threadId : null) {
  if (!id) return;
  setBoundedObjectValue(codexTaskSettings, id, {
    model: codexModel,
    reasoningEffort: codexReasoningEffort,
  }, 500);
}

function restoreCodexTaskSettings(id, { inheritCurrent = false } = {}) {
  if (!id) return;
  const saved = codexTaskSettings[id];
  const fallbackModel = inheritCurrent ? codexModel : defaultCodexModel;
  const fallbackReasoning = inheritCurrent ? codexReasoningEffort : defaultCodexReasoningEffort;
  codexModel = saved && typeof saved.model === "string" && saved.model.trim()
    ? saved.model.trim()
    : fallbackModel;
  codexReasoningEffort = saved && CODEX_REASONING_EFFORTS.includes(saved.reasoningEffort)
    ? saved.reasoningEffort
    : fallbackReasoning;
  rememberCodexTaskSettings(id);
}

function applyCodexThreadSettings(id, payload) {
  if (!id) return;
  const current = codexTaskSettings[id] ?? {
    model: codexModel,
    reasoningEffort: codexReasoningEffort,
  };
  const resolved = resolveCodexThreadSettings(payload, current);
  setBoundedObjectValue(codexTaskSettings, id, resolved, 500);
  if (isCodex() && id === threadId) {
    codexModel = resolved.model;
    codexReasoningEffort = resolved.reasoningEffort;
  }
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
  rememberCodexTaskSettings();
  await sendRpc("thread/settings/update", {
    threadId,
    model: codexModel,
    effort: codexReasoningEffort,
  });
  await saveState();
}

function taskSwitchSettings() {
  if (!isCodex()) return {};
  return {
    model: codexModelLabel(codexModel),
    reasoning: CODEX_REASONING_LABELS[codexReasoningEffort],
  };
}

let stateLoadFailed = false;
let restoredTurnEndSnapshot = {};
try {
  const loadedState = await readJsonWithBackup(STATE_FILE, { backupFile: STATE_BACKUP_FILE });
  if (!loadedState.value) throw Object.assign(new Error("state file is missing"), { code: "ENOENT" });
  if (loadedState.recovered) console.warn(`Recovered runtime state from ${loadedState.source}`);
  const saved = canonicalizeProjectRoots(loadedState.value, PROJECTS);
  if (Array.isArray(saved.statusMediaFileIds)) {
    for (const [name, fileId] of saved.statusMediaFileIds.slice(-50)) {
      if (typeof name === "string" && typeof fileId === "string" && fileId) {
        statusMediaFileIds.set(name, fileId);
      }
    }
  }
  if (typeof saved.activeProjectRoot === "string") {
    const savedProject = findProject(saved.activeProjectRoot);
    if (savedProject) activeProjectRoot = savedProject.path;
  }
  const savedProvider = saved.activeProvider ?? saved.provider;
  if (savedProvider === "codex" || savedProvider === "claude") activeProvider = savedProvider;
  if (saved.threadIds && typeof saved.threadIds === "object") {
    if (typeof saved.threadIds.codex === "string") threadIdsByProvider.codex = saved.threadIds.codex;
    if (typeof saved.threadIds.claude === "string") threadIdsByProvider.claude = saved.threadIds.claude;
  } else if (typeof saved.threadId === "string" && typeof saved.provider === "string") {
    threadIdsByProvider[saved.provider] = saved.threadId;
  }
  threadId = threadIdsByProvider[activeProvider] ?? null;
  if (typeof saved.activeThreadTitle === "string") activeThreadTitle = saved.activeThreadTitle;
  if (saved.pinnedTaskTitles && typeof saved.pinnedTaskTitles === "object") {
    for (const [key, value] of Object.entries(saved.pinnedTaskTitles)) {
      const title = String(value ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
      if (key.includes("\0") && title) pinnedTaskTitles[key] = title;
    }
  }
  if (CLAUDE_MODELS.includes(saved.claudeModel)) claudeModel = saved.claudeModel;
  if (typeof saved.codexModel === "string") codexModel = normalizeCodexModel(saved.codexModel);
  if (CODEX_REASONING_EFFORTS.includes(saved.codexReasoningEffort)) {
    codexReasoningEffort = saved.codexReasoningEffort;
  }
  if (saved.codexTaskSettings && typeof saved.codexTaskSettings === "object") {
    for (const [savedThreadId, settings] of Object.entries(saved.codexTaskSettings).slice(-500)) {
      if (!settings || typeof settings !== "object") continue;
      if (typeof settings.model !== "string" || !settings.model.trim()) continue;
      if (!CODEX_REASONING_EFFORTS.includes(settings.reasoningEffort)) continue;
      setBoundedObjectValue(codexTaskSettings, savedThreadId, {
        model: settings.model.trim(),
        reasoningEffort: settings.reasoningEffort,
      }, 500);
    }
  }
  if (CODEX_COLLABORATION_MODES.includes(saved.codexCollaborationMode)) {
    codexCollaborationMode = saved.codexCollaborationMode;
  }
  if (CODEX_REASONING_EFFORTS.includes(saved.claudeReasoningEffort)) {
    claudeReasoningEffort = saved.claudeReasoningEffort;
  }
  if (CODEX_COLLABORATION_MODES.includes(saved.claudeCollaborationMode)) {
    claudeCollaborationMode = saved.claudeCollaborationMode;
  }
  if (Number.isSafeInteger(saved.chatId)) chatId = saved.chatId;
  if (Number.isSafeInteger(saved.updateOffset) && saved.updateOffset >= 0) updateOffset = saved.updateOffset;
  if (Array.isArray(saved.lastTaskMessages)) {
    for (const entry of saved.lastTaskMessages) {
      if (!Array.isArray(entry) || typeof entry[0] !== "string" || typeof entry[1]?.text !== "string") continue;
      lastTaskMessages.set(entry[0], entry[1]);
    }
  }
  if (Array.isArray(saved.lastSeenTaskTurnIds)) {
    for (const entry of saved.lastSeenTaskTurnIds.slice(-500)) {
      if (!Array.isArray(entry) || typeof entry[0] !== "string" || typeof entry[1] !== "string") continue;
      lastSeenTaskTurnIds.set(entry[0], entry[1]);
    }
  }
  if (Array.isArray(saved.threadTokenTotals)) {
    for (const entry of saved.threadTokenTotals.slice(-500)) {
      if (!Array.isArray(entry) || typeof entry[0] !== "string" || !entry[1]) continue;
      threadTokenTotals.set(entry[0], normalizeTokenUsage(entry[1]));
    }
  }
  if (Array.isArray(saved.turnTokenUsage)) {
    for (const entry of saved.turnTokenUsage.slice(-200)) {
      if (!Array.isArray(entry) || typeof entry[0] !== "string" || !entry[1]) continue;
      turnTokenUsage.set(entry[0], {
        usage: normalizeTokenUsage(entry[1].usage),
        reported: entry[1].reported === true,
      });
    }
  }
  if (Array.isArray(saved.codexTurnStarts)) {
    for (const entry of saved.codexTurnStarts.slice(-500)) {
      if (!Array.isArray(entry) || typeof entry[0] !== "string" || !entry[1]) continue;
      codexTurnStarts.set(entry[0], entry[1]);
    }
  }
  if (saved.codexHookReceipts && typeof saved.codexHookReceipts === "object") {
    codexHookReceipts = {
      start: saved.codexHookReceipts.start ?? null,
      stop: saved.codexHookReceipts.stop ?? null,
    };
  }
  codexTerminalAudit.restore(saved.codexTerminalAudit);
  restoredTurnEndSnapshot = saved.turnEndNotifications ?? {};
  const restoredNotificationStats = turnEndNotifications.restore(restoredTurnEndSnapshot);
  if (restoredNotificationStats.droppedLegacyPending || restoredNotificationStats.droppedStalePending) {
    console.warn(
      `Discarded deferred turn-end messages: legacy=${restoredNotificationStats.droppedLegacyPending}, stale=${restoredNotificationStats.droppedStalePending}`,
    );
  }
  if (Array.isArray(saved.dismissedExternalTasks)) {
    dismissedExternalTasks.restore(saved.dismissedExternalTasks);
  }
  for (const [key, cancelledAtMs] of Array.isArray(saved.cancelledManagedClaudeTasks)
    ? saved.cancelledManagedClaudeTasks
    : []) {
    if (typeof key === "string" && Number.isFinite(Number(cancelledAtMs))) {
      setBoundedMapValue(cancelledManagedClaudeTasks, key, Number(cancelledAtMs), 200);
    }
  }
  for (const item of Array.isArray(saved.pendingInputs) ? saved.pendingInputs : []) {
    const restored = restoreDeferredInput(item, {
      guardConcurrentRepositoryWrites: config.guardConcurrentRepositoryWrites,
    });
    if (!restored) continue;
    (restored.destination === "queued" ? queuedInputs : pendingInputs)
      .set(restored.item.id, restored.item);
  }
  for (const item of Array.isArray(saved.queuedInputs) ? saved.queuedInputs : []) {
    if (item?.id && item?.threadId && item?.provider) queuedInputs.set(item.id, item);
  }
  const restoredDeferred = [
    ...[...pendingInputs.values()].map((item) => ({ collection: pendingInputs, item })),
    ...[...queuedInputs.values()].map((item) => ({ collection: queuedInputs, item })),
  ].sort((left, right) => (
    (Date.parse(left.item.createdAt ?? "") || 0) - (Date.parse(right.item.createdAt ?? "") || 0)
  ));
  const deferredCutoff = Date.now() - config.deferredInputTtlHours * 60 * 60 * 1000;
  for (let index = restoredDeferred.length - 1; index >= 0; index -= 1) {
    const entry = restoredDeferred[index];
    const createdAt = Date.parse(String(entry.item.createdAt ?? ""));
    if (!Number.isFinite(createdAt) || createdAt >= deferredCutoff) continue;
    entry.collection.delete(entry.item.id);
    restoredDeferred.splice(index, 1);
    await Promise.all((entry.item.temporaryFiles ?? []).map((file) => unlink(file).catch(() => {})));
  }
  while (restoredDeferred.length > MAX_DEFERRED_INPUTS) {
    const oldest = restoredDeferred.shift();
    oldest.collection.delete(oldest.item.id);
    await Promise.all((oldest.item.temporaryFiles ?? []).map((file) => unlink(file).catch(() => {})));
  }
  if (saved.restartRequest && typeof saved.restartRequest === "object"
    && Number.isSafeInteger(saved.restartRequest.chatId)
    && Number.isSafeInteger(saved.restartRequest.messageId)) {
    restartRequest = {
      chatId: saved.restartRequest.chatId,
      messageId: saved.restartRequest.messageId,
      requestedAt: String(saved.restartRequest.requestedAt ?? ""),
      waitingForRuns: saved.restartRequest.waitingForRuns === true,
      minimumUpdateOffset: Number.isSafeInteger(saved.restartRequest.minimumUpdateOffset)
        ? saved.restartRequest.minimumUpdateOffset
        : 0,
    };
  }
  const savedRuns = Array.isArray(saved.activeRuns)
    ? saved.activeRuns
    : saved.activeRun && typeof saved.activeRun === "object"
      ? [saved.activeRun]
      : [];
  for (const savedRun of savedRuns) {
    if (!savedRun || typeof savedRun !== "object"
      || !["running", "finishing"].includes(savedRun.status)) continue;
    const observer = savedRun.observer === true;
    const executionOwner = savedRun.executionOwner
      ?? (savedRun.provider === "codex"
        ? observer
          ? TASK_EXECUTION_OWNERS.VSCODE
          : TASK_EXECUTION_OWNERS.TELEGRAM
        : null);
    taskRuns.add({
      ...savedRun,
      observer,
      executionOwner,
      appServer: savedRun.provider === "codex"
        ? taskExecutionRuntimeLabel(executionOwner)
        : savedRun.appServer,
      status: "running",
      chatId: Number.isSafeInteger(savedRun.chatId) ? savedRun.chatId : chatId,
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
    });
  }
  if (activeProvider === "codex" && threadId) {
    if (codexTaskSettings[threadId]) restoreCodexTaskSettings(threadId);
    else rememberCodexTaskSettings(threadId);
  }
} catch (error) {
  if (error?.code !== "ENOENT") {
    stateLoadFailed = true;
    console.error("Cannot read state:", error.message);
  }
}

const restoredTurnMessages = [
  ...(Array.isArray(restoredTurnEndSnapshot.pending) ? restoredTurnEndSnapshot.pending : []),
  ...(Array.isArray(restoredTurnEndSnapshot.completions)
    ? restoredTurnEndSnapshot.completions.map((completion) => completion?.message)
    : []),
].filter(Boolean);
await workLogUsageStore.mergeTurnTexts(restoredTurnMessages).catch((error) => {
  console.error("Cannot restore WORK_LOG turn texts:", error.message);
});
for (const project of config.projects) {
  await workLogUsageStore.project(path.join(project.path, "WORK_LOG.md"), {
    projectRoot: project.path,
  }).catch((error) => {
    console.error(`Cannot refresh WORK_LOG usage for ${project.path}:`, error.message);
  });
}

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
  if (savedPinnedTitles && typeof savedPinnedTitles === "object") {
    for (const [key, value] of Object.entries(savedPinnedTitles)) {
      const title = String(value ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
      if (key.includes("\0") && title) pinnedTaskTitles[key] = title;
    }
  }
} catch (error) {
  if (error?.code !== "ENOENT") console.error("Cannot read pinned task titles:", error.message);
}

async function resolveCodexExecutable() {
  return resolveInstalledCodexExecutable({ requested: config.codexExecutable });
}

async function spawnCodex(args) {
  const command = await resolveCodexExecutable();
  const mcp = await unavailableLocalMcpOverrides();
  if (mcp.disabled.length > 0) {
    const endpoints = mcp.disabled
      .map((server) => `${server.name} (${server.host}:${server.port})`)
      .join(", ");
    console.log(`Local MCP unavailable; disabled for Agent Hub Server: ${endpoints}`);
  }
  console.error(`Starting Codex: ${command}`);
  const child = spawn(command, [...config.codexExecutableArgs, ...mcp.args, ...args], {
    cwd: activeProjectRoot,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  await new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  return child;
}

async function handleCodexTransportExit({ detail }) {
  console.error(`Codex app-server stopped (${detail}).`);
  const wasActive = isCodex();
  const hadCodexRuns = taskRuns.values().some((run) => run.provider === "codex");
  if (stopping) return;
  if (!wasActive && !hadCodexRuns) return;
  for (const run of taskRuns.values().filter((item) => item.provider === "codex")) {
    setProgressStage(run, "Связь с Codex потеряна. Переподключаюсь…");
  }
  if (!codexRestarting) setTimeout(() => void restartCodexAfterCrash(), 2000);
}

const codexTransport = new CodexAppServerTransport({
  spawnProcess: spawnCodex,
  stopProcessTree,
  onMessage: handleCodexMessage,
  onExit: handleCodexTransportExit,
  rpcTimeoutMs: CODEX_RPC_TIMEOUT_MS,
});

async function startCodexAppServer() {
  await codexTransport.start();
}

async function stopCodexAppServerTree() {
  await codexTransport.stop();
}

async function restartCodexAfterCrash() {
  const hasCodexRuns = taskRuns.values().some((run) => run.provider === "codex");
  if (stopping || (!isCodex() && !hasCodexRuns) || codexRestarting) return;
  codexRestarting = true;
  try {
    await startCodexAppServer();
    await initializeCodex({ attachSelectedThread: isCodex() });
    await recoverActiveRuns({ provider: "codex" });
    if (taskRuns.size) startTyping();
    for (const run of taskRuns.values().filter((item) => item.provider === "codex")) {
      setProgressStage(run, "Соединение с Codex восстановлено.");
    }
  } catch (error) {
    console.error("Cannot restart Codex app-server:", error.message);
    for (const run of taskRuns.values().filter((item) => item.provider === "codex")) {
      setProgressStage(run, `Codex пока недоступен: ${error.message}`);
    }
    if (!stopping && (isCodex() || hasCodexRuns)) setTimeout(() => void restartCodexAfterCrash(), 5000);
  } finally {
    codexRestarting = false;
  }
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
  if (config.profile === "journal") {
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
  await initializeCodex();
}

async function initializeCodex({ attachSelectedThread = true } = {}) {
  await sendRpc("initialize", {
    clientInfo: {
      name: "telegram_codex_bridge",
      title: "Telegram Codex Bridge",
      version: "0.1.0",
    },
    capabilities: { experimentalApi: true },
  });
  sendNotification("initialized");
  if (attachSelectedThread) await attachCodexThread();
}

async function attachCodexThread() {
  if (threadId) {
    const savedThreadId = threadId;
    try {
      const result = await sendRpc("thread/resume", {
        threadId,
        approvalPolicy: "on-request",
        sandbox: "workspace-write",
      });
      if (!isWorkspaceThread(result.thread ?? {})) {
        throw new Error("saved thread belongs to another project");
      }
      activeThreadTitle = await resolveResumedCodexThreadTitle(threadId, result.thread);
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
      threadId = null;
    }
  }
  await createThread();
  return true;
}

async function createThread() {
  if (!isCodex()) {
    threadId = null;
    activeThreadTitle = "Новая задача Claude";
    latestDiff = "";
    await saveState();
    return;
  }
  const result = await sendRpc("thread/start", {
    cwd: activeProjectRoot,
    approvalPolicy: "on-request",
    sandbox: "workspace-write",
    serviceName: "telegram_codex_bridge",
  });
  threadId = result.thread.id;
  invalidateTaskCatalog();
  restoreCodexTaskSettings(threadId, { inheritCurrent: true });
  await updateActiveCodexThreadSettings();
  activeThreadTitle = await nameTelegramThread(threadId);
  latestDiff = "";
  await saveState();
}

async function nameTelegramThread(id) {
  const timestamp = new Date().toLocaleString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  const title = `Telegram · ${timestamp}`;
  await sendRpc("thread/name/set", { threadId: id, name: title });
  return title;
}

async function listAllCodexThreads() {
  if (!codexTransport.running) {
    await startCodexAppServer();
    await initializeCodex({ attachSelectedThread: false });
  }
  const threads = [];
  let cursor = null;
  const seenCursors = new Set();
  do {
    if (cursor && seenCursors.has(cursor)) break;
    if (cursor) seenCursors.add(cursor);
    const result = await sendRpc("thread/list", {
      cursor,
      limit: 100,
      sortKey: "updated_at",
      sortDirection: "desc",
      sourceKinds: CODEX_TASK_SOURCE_KINDS,
    });
    threads.push(...(result.data ?? []));
    cursor = result.nextCursor ?? null;
  } while (cursor);
  return threads;
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
  return (await listAllCodexThreads())
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
        workLogFile: path.join(project.path, "WORK_LOG.md"),
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
        workLogFile: path.join(project.path, "WORK_LOG.md"),
      });
    }
    if (resolved.length) {
      console.log(`Backfilled credit pricing metadata for ${resolved.length} WORK_LOG turn(s)`);
    }
    if (imageEstimates.length) {
      console.log(`Backfilled image generation estimates for ${imageEstimates.length} WORK_LOG turn(s)`);
    }
  } catch (error) {
    console.error("Cannot backfill WORK_LOG credit pricing metadata:", error.message);
  }
}

async function buildTaskCatalog() {
  const [codexResult, claudeResult] = await Promise.allSettled([
    listAllCodexThreads(),
    listClaudeSessionSnapshots(),
  ]);
  const entries = [];
  let pinnedTitlesChanged = false;
  if (codexResult.status === "fulfilled") {
    await backfillWorkLogPricingMetadata(codexResult.value);
    const titleHistories = await readCodexThreadTitleHistories();
    const batchSize = 16;
    for (let start = 0; start < codexResult.value.length; start += batchSize) {
      const batch = codexResult.value.slice(start, start + batchSize);
      const values = await Promise.all(batch.map(async (thread) => {
        const project = findProject(thread.cwd);
        if (!project) return null;
        const activity = await readCodexRolloutActivity(thread.path);
        const rolloutRunning = thread.status?.type === "active" || activity.running;
        const existingRun = taskRuns.forTask({
          provider: "codex",
          projectRoot: project.path,
          threadId: thread.id,
        });
        const executionOwner = existingRun?.observer === false
          ? TASK_EXECUTION_OWNERS.TELEGRAM
          : await resolveCodexObservedExecutionOwner(activity, {
            rolloutPath: thread.path,
            agentHubPid: codexTransport.pid,
          });
        const entry = codexCatalogEntry(thread, project, {
          rolloutRunning,
          executionOwner: rolloutRunning ? executionOwner : null,
          lastActivityAtMs: activity.lastActivityAtMs,
        });
        const titleHistory = titleHistories.get(thread.id)
          ?? { currentTitle: "", recoverableTitle: "" };
        const appServerTitle = codexThreadResponseTitle(thread);
        const discoveredTitle = preferredCodexTaskTitle(appServerTitle, titleHistory);
        if (discoveredTitle && appServerTitle !== discoveredTitle) {
          await sendRpc("thread/name/set", { threadId: entry.threadId, name: discoveredTitle });
        }
        const resolvedTitle = reconcilePinnedTaskTitle(
          pinnedTaskTitles,
          entry.provider,
          entry.threadId,
          discoveredTitle,
        );
        pinnedTitlesChanged = resolvedTitle.changed || pinnedTitlesChanged;
        entry.title = resolvedTitle.title || entry.title;
        return entry;
      }));
      entries.push(...values.filter(Boolean));
    }
  } else {
    console.error("Cannot discover Codex tasks:", codexResult.reason?.message ?? codexResult.reason);
    entries.push(...taskSyncStore.catalog({ provider: "codex" }));
  }
  if (claudeResult.status === "fulfilled") {
    for (const snapshot of claudeResult.value) {
      const project = snapshot.cwd ? findProject(snapshot.cwd) : null;
      if (project && snapshot.sessionId) {
        entries.push(claudeCatalogEntry(applyManagedClaudeCancellation(snapshot), project));
      }
    }
  } else {
    console.error("Cannot discover Claude tasks:", claudeResult.reason?.message ?? claudeResult.reason);
    entries.push(...taskSyncStore.catalog({ provider: "claude" }));
  }
  taskCatalog = mergeTaskCatalog(entries, taskRuns.values().map((run) => ({
    ...run,
    projectName: runProject(run).name,
  })));
  if (pinnedTitlesChanged) await savePinnedTaskTitles();
  for (const project of config.projects) {
    await workLogUsageStore.synchronizeTaskTitlesAndProject({
      titles: taskCatalog
        .filter((entry) => samePath(entry.projectRoot, project.path))
        .map((entry) => ({
          provider: entry.provider,
          threadId: entry.threadId,
          taskTitle: entry.title,
        })),
      projectRoot: project.path,
      workLogFile: path.join(project.path, "WORK_LOG.md"),
    });
  }
  let titleChanged = false;
  for (const run of taskRuns.values()) {
    const entry = taskCatalog.find((item) => catalogEntryIsSelected(item, run));
    if (entry) titleChanged = updateTaskRunTitle(run, entry.title) || titleChanged;
  }
  const current = taskCatalog.find((entry) => catalogEntryIsSelected(entry, selectedTask()));
  if (current?.title && current.title !== activeThreadTitle) {
    activeThreadTitle = current.title;
    titleChanged = true;
  }
  taskSyncStore.recordCatalog(taskCatalog);
  await taskSyncStore.save();
  if (titleChanged) await saveState();
  taskCatalogRefreshedAt = Date.now();
  return taskCatalog;
}

async function refreshTaskCatalog({ force = false } = {}) {
  if (!force && taskCatalog.length && Date.now() - taskCatalogRefreshedAt < TASK_CATALOG_CACHE_MS) {
    return taskCatalog;
  }
  if (taskCatalogRefreshInFlight) return taskCatalogRefreshInFlight;
  taskCatalogRefreshInFlight = buildTaskCatalog();
  try {
    return await taskCatalogRefreshInFlight;
  } finally {
    taskCatalogRefreshInFlight = null;
  }
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

function desktopRunSnapshot(run) {
  if (!run) return null;
  return {
    id: run.id,
    turnId: run.turnId ?? null,
    provider: run.provider,
    threadId: run.threadId,
    taskTitle: runTaskTitle(run),
    status: run.status,
    observer: run.observer === true,
    executionOwner: run.executionOwner ?? null,
    runtime: run.appServer ?? null,
    model: run.model ?? null,
    reasoning: run.reasoning ?? null,
    stage: String(run.progressStage ?? "Выполняется…"),
    prompt: String(run.promptPreview ?? ""),
    progress: String(run.progressReasoning ?? ""),
    response: String(run.responseText ?? ""),
    startedAt: run.startedAt ?? null,
    lastActivityAt: run.lastMeaningfulProgressAt ?? run.progressHeartbeatAt ?? run.startedAt ?? null,
  };
}

function desktopTaskSnapshot(entry) {
  const task = {
    provider: entry.provider,
    projectRoot: entry.projectRoot,
    threadId: entry.threadId,
  };
  const run = taskRuns.forTask(task);
  const lastMessage = savedLastTaskMessageRecord(task);
  return {
    provider: entry.provider,
    projectRoot: entry.projectRoot,
    projectName: entry.projectName ?? findProject(entry.projectRoot)?.name ?? path.basename(entry.projectRoot),
    threadId: entry.threadId,
    title: entry.title,
    selected: catalogEntryIsSelected(entry, selectedTask()),
    running: Boolean(run || entry.running),
    activityUnknown: entry.activityUnknown === true,
    executionOwner: run?.executionOwner ?? entry.executionOwner ?? null,
    runtime: run?.appServer ?? (entry.executionOwner ? taskExecutionRuntimeLabel(entry.executionOwner) : null),
    updatedAtMs: Math.max(
      Number(entry.lastActivityAtMs) || 0,
      Number(entry.updatedAtMs) || 0,
      Date.parse(run?.lastMeaningfulProgressAt ?? run?.startedAt ?? "") || 0,
    ),
    lastAnswer: lastMessage?.text ?? "",
    lastAnswerAt: lastMessage?.updatedAt ?? null,
    run: desktopRunSnapshot(run),
  };
}

async function desktopSnapshot({ refresh = false } = {}) {
  const catalogStale = Date.now() - taskCatalogRefreshedAt >= 5_000;
  if (refresh || !taskCatalog.length || catalogStale) {
    await refreshTaskCatalog({ force: Boolean(refresh || catalogStale) }).catch((error) => {
      console.warn("Cannot refresh desktop task catalog:", error.message);
    });
  }
  let catalog = taskCatalog;
  if (!catalog.some((entry) => catalogEntryIsSelected(entry, selectedTask())) && threadId) {
    catalog = mergeTaskCatalog(catalog, [{
      ...selectedTurnTarget(),
      projectName: activeProject().name,
      startedAt: new Date().toISOString(),
    }]);
  }
  const tasks = catalog.map(desktopTaskSnapshot);
  return {
    apiVersion: 2,
    generatedAt: new Date().toISOString(),
    selected: {
      ...selectedTask(),
      title: activeThreadTitle,
      projectName: activeProject().name,
      model: activeProvider === "codex" ? codexModelLabel(codexModel) : CLAUDE_MODEL_LABELS[claudeModel],
      reasoning: CODEX_REASONING_LABELS[
        activeProvider === "codex" ? codexReasoningEffort : claudeReasoningEffort
      ],
      mode: CODEX_COLLABORATION_MODE_LABELS[
        activeProvider === "codex" ? codexCollaborationMode : claudeCollaborationMode
      ],
    },
    settings: {
      provider: activeProvider,
      model: activeProvider === "codex" ? codexModel : claudeModel,
      reasoning: activeProvider === "codex" ? codexReasoningEffort : claudeReasoningEffort,
      mode: activeProvider === "codex" ? codexCollaborationMode : claudeCollaborationMode,
      approvalMode: autoApprove ? "auto" : "manual",
      models: activeProvider === "codex"
        ? CODEX_MODELS.map((model) => ({ value: model.value, label: model.label }))
        : CLAUDE_MODELS.map((value) => ({ value, label: CLAUDE_MODEL_LABELS[value] })),
      reasoningOptions: CODEX_REASONING_EFFORTS.map((value) => ({
        value,
        label: CODEX_REASONING_LABELS[value],
      })),
      modeOptions: CODEX_COLLABORATION_MODES.map((value) => ({
        value,
        label: CODEX_COLLABORATION_MODE_LABELS[value],
      })),
      projects: PROJECTS.map((project) => ({
        name: project.name,
        path: project.path,
        selected: samePath(project.path, activeProjectRoot),
      })),
    },
    pendingApprovals: approvalController.snapshot(),
    deferredInputs: [
      ...[...pendingInputs.values()].map((item) => ({
        id: item.id,
        state: "pending",
        taskTitle: item.taskTitle,
        preview: inputPreview(item.input).slice(0, 1_000),
        allowForce: item.allowForce === true,
        conflictKind: item.conflictKind ?? null,
      })),
      ...[...queuedInputs.values()].map((item) => ({
        id: item.id,
        state: "queued",
        taskTitle: item.taskTitle,
        preview: inputPreview(item.input).slice(0, 1_000),
        allowForce: false,
        conflictKind: item.conflictKind ?? null,
      })),
    ],
    restartPending: Boolean(restartRequest),
    activeCount: tasks.filter((item) => item.running).length,
    tasks,
  };
}

async function desktopTaskHistory(params) {
  const provider = String(params.provider ?? activeProvider).trim();
  const selectedThreadId = String(params.threadId ?? threadId ?? "").trim();
  if (!['codex', 'claude'].includes(provider) || !selectedThreadId) {
    throw new Error("Укажите корректную задачу");
  }
  const catalog = await refreshTaskCatalog();
  const entry = catalog.find((item) => item.provider === provider && item.threadId === selectedThreadId);
  if (!entry) throw new Error("Задача не найдена в локальном каталоге");
  const binding = {
    provider: entry.provider,
    projectRoot: entry.projectRoot,
    threadId: entry.threadId,
    taskTitle: entry.title,
    chatId,
  };
  const { history } = await taskViewController.readHistory(binding);
  const running = taskRuns.forTask(binding);
  if (running) {
    mergeActiveTaskHistory(history, {
      active: true,
      turnId: running.turnId ?? running.id,
      prompt: running.promptPreview,
      answer: running.responseText,
    });
  }
  const total = history.length;
  const requestedEnd = Number(params.before);
  const end = Number.isSafeInteger(requestedEnd)
    ? Math.max(0, Math.min(requestedEnd, total))
    : total;
  const limit = Math.max(1, Math.min(Number(params.limit) || 10, 20));
  const start = Math.max(0, end - limit);
  return {
    provider,
    threadId: selectedThreadId,
    title: entry.title,
    total,
    start,
    end,
    nextBefore: start > 0 ? start : null,
    items: history.slice(start, end).map((item) => ({
      id: String(item.id ?? ""),
      prompt: String(item.prompt ?? "").slice(0, 100_000),
      answer: String(item.answer ?? "").slice(0, 200_000),
      status: String(item.status ?? ""),
      active: item.active === true,
      completed: item.completed === true,
    })),
  };
}

async function desktopSelectTask(params) {
  const provider = String(params.provider ?? "").trim();
  const selectedThreadId = String(params.threadId ?? "").trim();
  if (!['codex', 'claude'].includes(provider) || !selectedThreadId) {
    throw new Error("Укажите корректную задачу");
  }
  const catalog = await refreshTaskCatalog();
  const entry = catalog.find((item) => item.provider === provider && item.threadId === selectedThreadId);
  if (!entry) throw new Error("Задача не найдена в локальном каталоге");
  await activateMessageBinding({
    provider: entry.provider,
    projectRoot: entry.projectRoot,
    threadId: entry.threadId,
    taskTitle: entry.title,
  });
  return desktopSnapshot();
}

async function desktopSendMessage(params) {
  const text = String(params.text ?? "").trim();
  const attachments = await desktopAttachmentPaths(params.attachments);
  if (!text && !attachments.length) throw new Error("Введите сообщение или добавьте изображение");
  if (text.length > 100_000) throw new Error("Сообщение слишком длинное");
  const input = attachments.length
    ? [
      { type: "text", text: text || "Проанализируй приложенное изображение." },
      ...attachments.map((file) => ({ type: "localImage", path: file })),
    ]
    : text;
  const target = selectedTurnTarget(chatId);
  if (!target.threadId) throw new Error("Сначала выберите или создайте задачу");
  const existingRun = taskRuns.forTask(target);
  const externalActivity = existingRun
    ? { state: "active", executionOwner: existingRun.executionOwner }
    : await taskExternalActivity(target);
  if (existingRun || externalActivity.state !== "inactive") {
    const deferred = await deferConflictingInput(input, attachments, {
      executionOwner: existingRun?.executionOwner
        ?? externalActivity.executionOwner
        ?? TASK_EXECUTION_OWNERS.EXTERNAL,
      target,
      allowForce: externalActivity.state === "unknown" && !existingRun,
      conflictKind: externalActivity.state === "unknown" && !existingRun
        ? "activity-unknown"
        : "task-running",
    });
    return {
      accepted: false,
      deferred: true,
      id: deferred.id,
      reason: externalActivity.state === "unknown" ? "activity-unknown" : "task-running",
      message: externalActivity.state === "unknown"
        ? "Сообщение сохранено: нельзя надёжно определить, завершён ли предыдущий ход."
        : "Сообщение сохранено: выберите новую задачу, очередь или отмену справа.",
      snapshot: await desktopSnapshot(),
    };
  }
  const repositoryConflict = await activeRepositoryConflict(target);
  if (repositoryConflict) {
    const deferred = await deferConflictingInput(input, attachments, {
      executionOwner: repositoryConflict.executionOwner ?? TASK_EXECUTION_OWNERS.EXTERNAL,
      target,
      allowForce: true,
      conflictKind: "repository",
      conflictTask: repositoryConflict,
    });
    return {
      accepted: false,
      deferred: true,
      id: deferred.id,
      reason: "repository-conflict",
      message: `Сообщение сохранено: задача «${repositoryConflict.taskTitle ?? "Без названия"}» уже изменяет тот же Git-репозиторий.`,
      snapshot: await desktopSnapshot(),
    };
  }
  const run = await beginRun(input, target);
  await launchTurn(run, input, attachments);
  return { accepted: true, runId: run.id, snapshot: await desktopSnapshot() };
}

async function desktopAttachmentPaths(values) {
  if (values == null) return [];
  if (!Array.isArray(values) || values.length > 8) throw new Error("Можно приложить не более восьми изображений");
  const allowedRoot = path.join(runtimeCommandRoot, "DesktopApp", "attachments");
  const result = [];
  for (const value of values) {
    const file = path.resolve(String(value ?? ""));
    if (!pathInsideOrSame(file, allowedRoot)) throw new Error("Изображение находится вне каталога Desktop-приложения");
    if (!/\.(?:png|jpe?g|webp|gif|bmp)$/i.test(file)) throw new Error("Неподдерживаемый формат изображения");
    const info = await stat(file);
    if (!info.isFile() || info.size <= 0 || info.size > 20 * 1024 * 1024) {
      throw new Error("Изображение отсутствует или превышает 20 МБ");
    }
    result.push(file);
  }
  return result;
}

async function desktopUpdateSetting(params) {
  const name = String(params.name ?? "").trim();
  const value = String(params.value ?? "").trim();
  if (name === "provider") {
    await switchProvider(value);
  } else if (name === "model") {
    if (isCodex()) {
      switchCodexModel(value);
      await updateActiveCodexThreadSettings();
    } else {
      switchModel(value);
      await saveState();
    }
  } else if (name === "reasoning") {
    if (!CODEX_REASONING_EFFORTS.includes(value)) throw new Error("Неизвестный уровень reasoning");
    if (isCodex()) {
      codexReasoningEffort = value;
      await updateActiveCodexThreadSettings();
    } else {
      claudeReasoningEffort = value;
      await saveState();
    }
  } else if (name === "mode") {
    if (!CODEX_COLLABORATION_MODES.includes(value)) throw new Error("Неизвестный режим работы");
    if (isCodex()) codexCollaborationMode = value;
    else claudeCollaborationMode = value;
    await saveState();
  } else if (name === "approvalMode") {
    if (value !== "auto" && value !== "manual") throw new Error("Неизвестный режим подтверждений");
    autoApprove = value === "auto";
  } else if (name === "project") {
    const index = PROJECTS.findIndex((project) => samePath(project.path, value));
    if (index < 0) throw new Error("Проект не найден");
    await switchProject(index);
  } else {
    throw new Error("Неизвестная настройка Desktop-приложения");
  }
  return desktopSnapshot({ refresh: true });
}

async function desktopRenameTask(params) {
  await renameCurrentTask(String(params.title ?? ""));
  return desktopSnapshot({ refresh: true });
}

async function desktopArchiveTask() {
  const result = await archiveCurrentThread();
  if (!result.archived) throw new Error(result.reason === "active-turn"
    ? "Сначала остановите активный ход"
    : result.reason === "unsupported" ? "Claude не поддерживает архивирование" : "Задача не выбрана");
  return desktopSnapshot({ refresh: true });
}

async function desktopTaskDiff() {
  const target = selectedTask();
  const run = taskRuns.forTask(target);
  const text = run ? await refreshTaskDiff(run) : taskDiffs.get(taskRunKey(target)) ?? "";
  return { text, empty: !text };
}

async function desktopCancelRun() {
  const run = selectedRun();
  if (!run) return { accepted: false, message: "В выбранной задаче сейчас ничего не выполняется" };
  if (run.provider === "codex") {
    await sendRpc("turn/interrupt", { threadId: run.threadId, turnId: run.turnId });
    return { accepted: true, message: "Остановка Codex запрошена" };
  }
  if (run.process || processIsAlive(run.pid)) {
    if (!await stopClaudeRunProcess(run)) throw new Error("Не удалось остановить дерево процессов Claude");
    return { accepted: true, message: "Claude остановлен" };
  }
  return { accepted: false, message: "Внешний Claude нельзя остановить из Agent Hub Server" };
}

async function desktopResolveApproval(params) {
  return approvalController.resolveFromDesktop(
    String(params.key ?? ""),
    String(params.decision ?? ""),
  );
}

async function desktopDeferredInput(params) {
  const id = String(params.id ?? "");
  const action = String(params.action ?? "");
  const item = pendingInputs.get(id) ?? queuedInputs.get(id);
  if (!item) throw new Error("Сохранённое сообщение уже обработано");
  if (action === "cancel") {
    pendingInputs.delete(id);
    queuedInputs.delete(id);
    await cleanupDeferredFiles(item);
    await saveState();
    await updateDeferredMessage(item, "❌ Сохранённое сообщение отменено.");
    return { accepted: true, message: "Сохранённое сообщение отменено" };
  }
  if (!pendingInputs.has(id)) throw new Error("Сообщение уже находится в очереди");
  if (action === "queue") {
    pendingInputs.delete(id);
    queuedInputs.set(id, item);
    await saveState();
    await updateDeferredMessage(item, `⏳ Сообщение поставлено в очередь задачи «${item.taskTitle}».`);
    scheduleQueuedInput(item, 500);
    return { accepted: true, message: "Сообщение поставлено в очередь" };
  }
  const binding = {
    provider: item.provider,
    projectRoot: item.projectRoot,
    threadId: item.threadId,
    taskTitle: item.taskTitle,
  };
  if (action === "force") {
    if (item.allowForce !== true) throw new Error("Принудительный запуск для этого сообщения не разрешён");
    await activateMessageBinding(binding);
    const outcome = await startTurn(item.input, item.temporaryFiles ?? [], {
      forceSpeechButton: item.forceSpeechButton === true,
      target: {
        ...binding,
        chatId: item.chatId,
        modelId: item.modelId,
        reasoningId: item.reasoningId,
        collaborationMode: item.collaborationMode,
      },
      allowRepositoryConflict: item.conflictKind === "repository",
      allowUnknownExternalActivity: item.conflictKind === "activity-unknown",
    });
    if (outcome?.deferred) throw new Error("Условие безопасного запуска всё ещё не выполнено");
    pendingInputs.delete(id);
    await saveState();
    await updateDeferredMessage(item, `⚠️ Сообщение отправлено в задачу «${item.taskTitle}».`);
    return { accepted: true, message: "Сообщение принудительно запущено" };
  }
  if (action === "new") {
    await activateMessageBinding(binding);
    await createThread();
    const outcome = await startTurn(item.input, item.temporaryFiles ?? [], {
      forceSpeechButton: item.forceSpeechButton === true,
    });
    if (outcome?.deferred) throw new Error("Новая задача неожиданно оказалась занята");
    pendingInputs.delete(id);
    await saveState();
    await updateDeferredMessage(item, `🆕 Сообщение отправлено в новую задачу «${activeThreadTitle}».`);
    return { accepted: true, message: "Сообщение отправлено в новую задачу", snapshot: await desktopSnapshot() };
  }
  throw new Error("Неизвестное действие с сохранённым сообщением");
}

async function desktopStatusDetails() {
  const codexSelected = isCodex();
  let limits;
  try {
    limits = codexSelected
      ? formatCodexRateLimits(await sendRpc("account/rateLimits/read", {}, { timeoutMs: 5_000 }))
      : formatClaudeRateLimits(await readClaudeRateLimits());
  } catch (error) {
    limits = `Не удалось получить: ${error.message}`;
  }
  return {
    provider: activeProvider,
    model: codexSelected ? codexModelLabel(codexModel) : CLAUDE_MODEL_LABELS[claudeModel],
    reasoning: CODEX_REASONING_LABELS[codexSelected ? codexReasoningEffort : claudeReasoningEffort],
    mode: CODEX_COLLABORATION_MODE_LABELS[codexSelected ? codexCollaborationMode : claudeCollaborationMode],
    limits,
    activeCount: taskRuns.values().length,
    backgroundJobs: backgroundMediaJobs.size + backgroundSpeechJobs.size,
  };
}

async function desktopSpeakLastAnswer() {
  const target = selectedTask();
  const message = savedLastTaskMessageRecord(target);
  const text = String(message?.text ?? "").trim();
  if (!text) throw new Error("У задачи ещё нет завершённого ответа");
  const job = await enqueueBackgroundJob("speech", { chatId, text }, chatId, {
    dedupeKey: `desktop:${target.provider}:${target.threadId}:speech`,
  });
  if (!job) throw new Error(`Очередь озвучивания заполнена (${MAX_BACKGROUND_SPEECH_JOBS})`);
  return { accepted: true, message: "Озвучивание будет отправлено в Telegram" };
}

async function desktopRestartServer() {
  if (restartRequest) return { accepted: false, message: "Перезапуск уже запрошен" };
  const blockingRuns = restartBlockingRuns();
  const blockingWorkCount = blockingRuns.length + backgroundMediaJobs.size + backgroundSpeechJobs.size;
  const message = await sendMessage(blockingWorkCount
    ? `🔄 Agent Hub Server перезапустится после завершения выполняющихся задач: ${blockingWorkCount}.`
    : "🔄 Перезапускаю Agent Hub Server…");
  if (!message?.message_id) throw new Error("Telegram не вернул ID сообщения перезапуска");
  restartRequest = {
    chatId,
    messageId: message.message_id,
    requestedAt: new Date().toISOString(),
    waitingForRuns: blockingWorkCount > 0,
    minimumUpdateOffset: updateOffset,
  };
  await saveState();
  if (!blockingWorkCount) setTimeout(() => void performRestart(), 250).unref();
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

function serializeDesktopMutation(operation) {
  const next = desktopMutationQueue.catch(() => {}).then(operation);
  desktopMutationQueue = next.catch(() => {});
  return next;
}

async function handleDesktopControl({ action, params }) {
  if (action === "snapshot") return desktopSnapshot(params);
  if (action === "task-history") return desktopTaskHistory(params);
  if (action === "select-task") return serializeDesktopMutation(() => desktopSelectTask(params));
  if (action === "send-message") return serializeDesktopMutation(() => desktopSendMessage(params));
  if (action === "new-task") return serializeDesktopMutation(() => desktopNewTask(params));
  if (action === "update-setting") return serializeDesktopMutation(() => desktopUpdateSetting(params));
  if (action === "rename-task") return serializeDesktopMutation(() => desktopRenameTask(params));
  if (action === "archive-task") return serializeDesktopMutation(() => desktopArchiveTask());
  if (action === "task-diff") return desktopTaskDiff();
  if (action === "cancel-run") return serializeDesktopMutation(() => desktopCancelRun());
  if (action === "resolve-approval") return serializeDesktopMutation(() => desktopResolveApproval(params));
  if (action === "deferred-input") return serializeDesktopMutation(() => desktopDeferredInput(params));
  if (action === "status-details") return desktopStatusDetails();
  if (action === "speak-last-answer") return desktopSpeakLastAnswer();
  if (action === "restart-server") return serializeDesktopMutation(() => desktopRestartServer());
  throw new Error(`Неизвестная desktop-команда: ${action}`);
}

async function sendProjectPicker() {
  const project = activeProject();
  const keyboard = PROJECTS.map((item, index) => [{
    text: `${samePath(item.path, activeProjectRoot) ? "✓ " : ""}${item.name}`,
    callback_data: uiCallback(`p:${index}`),
  }]);
  await sendMessage(
    `Активный проект: ${project.name}\n${activeProjectRoot}\n\nВыберите проект:`,
    { reply_markup: { inline_keyboard: keyboard } },
  );
}

async function sendAgentPicker() {
  const keyboard = [
    [{ text: `${!isCodex() ? "✓ " : ""}Claude Code`, callback_data: uiCallback("engine:claude") }],
    [{ text: `${isCodex() ? "✓ " : ""}Codex`, callback_data: uiCallback("engine:codex") }],
  ];
  await sendMessage(
    `Активный агент: ${providerTitle()}\n\nВыберите агента:`,
    { reply_markup: { inline_keyboard: keyboard } },
  );
}

async function sendModelPicker() {
  if (isCodex()) {
    const keyboard = CODEX_MODELS.map((model) => [{
      text: `${model.value === codexModel ? "? " : ""}${model.label}`,
      callback_data: uiCallback(`codex-model:${model.value}`),
    }]);
    await sendMessage(
      `Current Codex model: ${codexModelLabel(codexModel)}

Choose model for next Codex turns:`,
      { reply_markup: { inline_keyboard: keyboard } },
    );
    return;
  }
  const keyboard = CLAUDE_MODELS.map((value) => [{
    text: `${value === claudeModel ? "✓ " : ""}${CLAUDE_MODEL_LABELS[value]}`,
    callback_data: uiCallback(`model:${value}`),
  }]);
  await sendMessage(
    `Текущая модель Claude Code: ${CLAUDE_MODEL_LABELS[claudeModel]}\n\nВыберите модель:`,
    { reply_markup: { inline_keyboard: keyboard } },
  );
}

function switchCodexModel(value) {
  if (!CODEX_MODEL_VALUES.has(value)) throw new Error("unknown Codex model");
  if (value === codexModel) return { changed: false };
  codexModel = value;
  return { changed: true };
}

function switchModel(value) {
  if (!CLAUDE_MODELS.includes(value)) throw new Error("unknown model");
  if (value === claudeModel) return { changed: false };
  claudeModel = value;
  return { changed: true };
}

async function switchProject(index) {
  const project = PROJECTS[index];
  if (!project) throw new Error("unknown project");
  if (samePath(project.path, activeProjectRoot)) return { project, changed: false };

  rememberCodexTaskSettings();
  const previous = {
    activeProjectRoot,
    threadId,
    latestDiff,
    threadIdsByProvider: { ...threadIdsByProvider },
  };
  activeProjectRoot = project.path;
  threadId = null;
  threadIdsByProvider.codex = null;
  threadIdsByProvider.claude = null;
  latestDiff = "";
  try {
    await createThread();
  } catch (error) {
    ({ activeProjectRoot, threadId, latestDiff } = previous);
    Object.assign(threadIdsByProvider, previous.threadIdsByProvider);
    await saveState();
    throw error;
  }
  return { project, changed: true };
}

async function switchProvider(target) {
  if (target !== "codex" && target !== "claude") throw new Error("unknown provider");
  if (target === activeProvider) return { changed: false };

  rememberCodexTaskSettings();
  const previous = { activeProvider, threadId, codexModel, codexReasoningEffort };
  threadIdsByProvider[activeProvider] = threadId;
  activeProvider = target;
  threadId = threadIdsByProvider[target] ?? null;
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
    threadIdsByProvider[target] = threadId;
    ({ activeProvider, threadId, codexModel, codexReasoningEffort } = previous);
    await saveState();
    throw error;
  }
  latestDiff = taskDiffs.get(taskRunKey(selectedTask())) ?? "";
  await saveState();
  return { changed: true };
}

async function resumeThread(selectedThreadId, { notify = true } = {}) {
  if (selectedThreadId === threadId) {
    if (notify) await sendTaskAlreadySelectedNotification();
    return true;
  }
  if (!isCodex()) {
    threadId = selectedThreadId;
    activeThreadTitle = `Сессия Claude · ${selectedThreadId.slice(0, 8)}`;
    latestDiff = taskDiffs.get(taskRunKey(selectedTask())) ?? "";
    await saveState();
    if (notify) await sendMessage(`Выбрана сессия Claude: ${threadId}`);
    return true;
  }
  rememberCodexTaskSettings();
  const result = await sendRpc("thread/resume", {
    threadId: selectedThreadId,
    approvalPolicy: "on-request",
    sandbox: "workspace-write",
  });
  if (!isWorkspaceThread(result.thread ?? {})) {
    throw new Error("задача относится к другой активной папке");
  }
  threadId = result.thread?.id ?? selectedThreadId;
  restoreCodexTaskSettings(threadId);
  applyCodexThreadSettings(threadId, result);
  activeThreadTitle = await resolveResumedCodexThreadTitle(threadId, result.thread);
  latestDiff = taskDiffs.get(taskRunKey(selectedTask())) ?? "";
  await saveState();
  if (notify) {
    await sendTaskSwitchNotification();
  }
  return true;
}

async function renameCurrentTask(title) {
  if (!threadId) throw new Error("текущая задача не выбрана");
  const pinnedTitle = pinTaskTitle(activeProvider, threadId, title);
  if (!pinnedTitle) throw new Error("укажите непустое название после /rename");
  if (isCodex()) {
    await sendRpc("thread/name/set", { threadId, name: pinnedTitle });
    invalidateTaskCatalog();
  }
  activeThreadTitle = pinnedTitle;
  const run = selectedRun();
  if (run) updateTaskRunTitle(run, pinnedTitle);
  const entry = taskCatalog.find((item) => catalogEntryIsSelected(item, selectedTask()));
  if (entry) entry.title = pinnedTitle;
  await savePinnedTaskTitles();
  await saveState();
  return pinnedTitle;
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
  const previous = {
    activeProjectRoot,
    activeProvider,
    threadId,
    latestDiff,
    activeThreadTitle,
    codexModel,
    codexReasoningEffort,
    threadIdsByProvider: { ...threadIdsByProvider },
  };
  activeProjectRoot = project.path;
  activeProvider = binding.provider;
  threadId = binding.threadId;
  activeThreadTitle = binding.taskTitle?.trim() || `${binding.provider === "codex" ? "Codex" : "Claude"} · ${binding.threadId.slice(0, 8)}`;
  threadIdsByProvider[activeProvider] = threadId;
  if (isCodex()) {
    restoreCodexTaskSettings(threadId);
    activeThreadTitle = await storedCodexThreadTitle(threadId, activeThreadTitle);
  }
  latestDiff = taskDiffs.get(taskRunKey(selectedTask())) ?? "";
  try {
    if (isCodex() && !codexTransport.running) {
      await startCodexAppServer();
      await initializeCodex({ attachSelectedThread: false });
    }
    await saveState();
    return { changed: true, activeTitle: activeThreadTitle };
  } catch (error) {
    ({
      activeProjectRoot,
      activeProvider,
      threadId,
      latestDiff,
      activeThreadTitle,
      codexModel,
      codexReasoningEffort,
    } = previous);
    Object.assign(threadIdsByProvider, previous.threadIdsByProvider);
    await saveState();
    throw error;
  }
}

async function archiveCurrentThread() {
  const blockedReason = archiveBlockedReason();
  if (blockedReason) return { archived: false, reason: blockedReason };

  const archivedThreadId = threadId;
  const archivedResult = await sendRpc("thread/read", {
    threadId: archivedThreadId,
    includeTurns: false,
  });
  const archivedThread = archivedResult.thread ?? { id: archivedThreadId };
  await sendRpc("thread/archive", { threadId: archivedThreadId });
  invalidateTaskCatalog();
  delete codexTaskSettings[archivedThreadId];
  threadId = null;
  threadIdsByProvider.codex = null;
  latestDiff = "";
  await saveState();

  const [nextThread] = (await listThreads()).filter((thread) => thread.id !== archivedThreadId);
  if (nextThread) {
    threadId = nextThread.id;
    threadIdsByProvider.codex = threadId;
    restoreCodexTaskSettings(threadId);
    activeThreadTitle = threadTitle(nextThread);
    latestDiff = taskDiffs.get(taskRunKey(selectedTask())) ?? "";
    await saveState();
  }

  return { archived: true, archivedThread, nextThread: nextThread ?? null };
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
    codexModel,
    codexReasoningEffort,
    codexCollaborationMode,
    claudeModel,
    claudeReasoningEffort,
    claudeCollaborationMode,
  };
}

async function sendStatus(snapshot = currentStatusSnapshot()) {
  const project = findProject(snapshot.projectRoot) ?? PROJECTS[0];
  const selected = {
    provider: snapshot.provider,
    projectRoot: snapshot.projectRoot,
    threadId: snapshot.threadId,
  };
  const codexSelected = snapshot.provider === "codex";
  const limitsKey = codexSelected ? "codex" : "claude";
  const readLimits = async () => {
    const cached = statusLimitsCache.get(limitsKey);
    if (cached && Date.now() - cached.at < STATUS_LIMITS_CACHE_MS) return cached.value;
    if (statusLimitsInFlight.has(limitsKey)) return statusLimitsInFlight.get(limitsKey);
    const request = (async () => {
      const value = codexSelected
        ? formatCodexRateLimits(await sendRpc("account/rateLimits/read", {}, { timeoutMs: 5_000 }))
        : formatClaudeRateLimits(await readClaudeRateLimits());
      statusLimitsCache.set(limitsKey, { at: Date.now(), value });
      return value;
    })();
    statusLimitsInFlight.set(limitsKey, request);
    try {
      return await request;
    } finally {
      statusLimitsInFlight.delete(limitsKey);
    }
  };
  const [catalogResult, limitsResult] = await Promise.allSettled([
    refreshTaskCatalog(),
    readLimits(),
  ]);
  let catalog = taskCatalog;
  if (catalogResult.status === "fulfilled") {
    catalog = catalogResult.value;
  } else {
    console.error("Cannot refresh task catalog for status:", catalogResult.reason?.message ?? catalogResult.reason);
    catalog = mergeTaskCatalog(taskCatalog, taskRuns.values());
  }
  let task = "Не выбрана";
  if (snapshot.threadId) {
    const current = catalog.find((entry) => catalogEntryIsSelected(entry, selected));
    task = current?.title || snapshot.taskTitle
      || `${codexSelected ? "Codex" : "Claude"} · ${snapshot.threadId.slice(0, 8)}`;
  }

  let limits;
  if (limitsResult.status === "fulfilled") {
    limits = limitsResult.value;
  } else {
    const error = limitsResult.reason;
    console.error(`Cannot read ${codexSelected ? "Codex" : "Claude"} limits for status:`, error?.message ?? error);
    limits = `Не удалось получить: ${error?.message ?? error}`;
  }

  const runningTasks = catalog
    .filter((entry) => entry.running)
    .map((entry) => `${entry.provider === "codex" ? "Codex" : "Claude"} · ${entry.projectName} · ${entry.title}`);
  const runningProviders = [...new Set(catalog
    .filter((entry) => entry.running)
    .map((entry) => entry.provider))];
  const selectedBusy = catalog.some((entry) => (
    entry.running && catalogEntryIsSelected(entry, selected)
  ));
  const replyMarkup = runningTaskReplyMarkup(catalog, selected, {
    showProject: config.showProjectButton,
  });
  const statusText = formatStatusMessage({
    provider: codexSelected ? "CODEX" : "CLAUDE",
    busy: selectedBusy,
    runningTasks,
    model: codexSelected ? codexModelLabel(snapshot.codexModel) : CLAUDE_MODEL_LABELS[snapshot.claudeModel],
    reasoning: CODEX_REASONING_LABELS[codexSelected
      ? snapshot.codexReasoningEffort : snapshot.claudeReasoningEffort],
    mode: CODEX_COLLABORATION_MODE_LABELS[codexSelected
      ? snapshot.codexCollaborationMode : snapshot.claudeCollaborationMode],
    task,
    project: config.showProjectButton ? project.name : null,
    limits,
    showTaskButtons: replyMarkup.inline_keyboard.length > 0,
  });
  await sendStatusCard(
    statusText,
    replyMarkup.inline_keyboard.length
      ? { parse_mode: "HTML", reply_markup: replyMarkup }
      : { parse_mode: "HTML" },
    runningProviders,
    { targetChatId: snapshot.chatId, provider: snapshot.provider },
  );
}

async function sendReasoningPicker() {
  const current = isCodex() ? codexReasoningEffort : claudeReasoningEffort;
  const prefix = isCodex() ? "codex-reasoning" : "claude-reasoning";
  const keyboard = CODEX_REASONING_EFFORTS.map((value) => [{
    text: `${value === current ? "✓ " : ""}${CODEX_REASONING_LABELS[value]}`,
    callback_data: uiCallback(`${prefix}:${value}`),
  }]);
  const hint = isCodex()
    ? "Выберите уровень для следующих запросов:"
    : "Выберите уровень (для Claude это бюджет «расширенного мышления»):";
  await sendMessage(
    `Reasoning ${providerTitle()}: ${CODEX_REASONING_LABELS[current]}\n\n${hint}`,
    { reply_markup: { inline_keyboard: keyboard } },
  );
}

async function sendCollaborationModePicker() {
  const current = isCodex() ? codexCollaborationMode : claudeCollaborationMode;
  const prefix = isCodex() ? "codex-mode" : "claude-mode";
  const keyboard = [CODEX_COLLABORATION_MODES.map((value) => ({
    text: `${value === current ? "✓ " : ""}${CODEX_COLLABORATION_MODE_LABELS[value]}`,
    callback_data: uiCallback(`${prefix}:${value}`),
  }))];
  const hint = isCodex()
    ? "Выберите режим для следующих запросов:"
    : "Выберите режим (Plan — Claude только планирует, ничего не меняя):";
  await sendMessage(
    `Режим ${providerTitle()}: ${CODEX_COLLABORATION_MODE_LABELS[current]}\n\n${hint}`,
    { reply_markup: { inline_keyboard: keyboard } },
  );
}

const taskProgress = new TaskProgressController({
  isCurrentRun: (run) => taskRuns.forTask(run) === run,
  render: renderProgress,
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

function inputPreview(input) {
  const text = typeof input === "string"
    ? input
    : input?.filter((item) => item?.type === "text").map((item) => item.text).join("\n");
  return String(text ?? "").trim().slice(0, 500);
}

async function beginRun(input, target = null) {
  const provider = target?.provider ?? activeProvider;
  const projectRoot = target?.projectRoot ?? activeProjectRoot;
  const project = findProject(projectRoot);
  const targetThreadId = target?.threadId ?? threadId;
  const targetTaskTitle = target?.taskTitle ?? activeThreadTitle;
  if (provider === "claude") {
    cancelledManagedClaudeTasks.delete(taskRunKey({
      provider,
      projectRoot,
      threadId: targetThreadId,
    }));
  }
  const savedCodexSettings = provider === "codex"
    ? codexTaskSettings[targetThreadId] ?? {}
    : {};
  const modelId = target?.modelId ?? (provider === "codex"
    ? savedCodexSettings.model ?? (targetThreadId === threadId ? codexModel : defaultCodexModel)
    : claudeModel);
  const reasoningId = target?.reasoningId ?? (provider === "codex"
    ? savedCodexSettings.reasoningEffort
      ?? (targetThreadId === threadId ? codexReasoningEffort : defaultCodexReasoningEffort)
    : claudeReasoningEffort);
  const run = createManagedTaskRun({
    provider,
    chatId: target?.chatId ?? chatId,
    projectRoot,
    projectName: project?.name ?? path.basename(projectRoot),
    sessionCwd: target?.sessionCwd ?? null,
    threadId: targetThreadId,
    taskTitle: targetTaskTitle,
    promptPreview: inputPreview(input),
    model: provider === "codex" ? codexModelLabel(modelId) : CLAUDE_MODEL_LABELS[modelId],
    modelId,
    reasoning: CODEX_REASONING_LABELS[reasoningId],
    reasoningId,
    executionOwner: TASK_EXECUTION_OWNERS.TELEGRAM,
    appServer: provider === "codex"
      ? taskExecutionRuntimeLabel(TASK_EXECUTION_OWNERS.TELEGRAM)
      : "Telegram CLI",
    collaborationMode: target?.collaborationMode
      ?? (provider === "codex" ? codexCollaborationMode : claudeCollaborationMode),
  });
  taskRuns.add(run);
  invalidateTaskCatalog();
  await persistTaskDiff(taskRunKey(run), "");
  if (isSelectedRun(run)) latestDiff = "";
  run.gitBaseline = await captureTaskGitBaseline(run.projectRoot, config.dataDir, run.id);
  syncTaskRun(run);
  await saveState();
  taskProgress.scheduleStart(run, config.progressStartDelayMs);
  return run;
}

async function startProgressMessage(run, { forceNew = false } = {}) {
  return taskProgress.start(run, { forceNew });
}

async function clearRunProgressMessages(run) {
  return taskProgress.clear(run);
}

async function replaceRunProgressMessage(run) {
  return taskProgress.replace(run);
}

function setProgressStage(run, stage) {
  taskProgress.setStage(run, stage);
}

function appendProgressReasoning(run, delta) {
  taskProgress.appendReasoning(run, delta);
}

function noteRunActivity(run, value = Date.now()) {
  taskProgress.noteActivity(run, value);
}

function progressHeartbeatState(run, now = Date.now()) {
  return taskProgress.heartbeatState(run, now, PROGRESS_STALLED_AFTER_MS);
}

function renderProgress(run, done = false) {
  const heading = runProgressHeading(run, done);
  const parts = [heading, run?.progressStage || "Выполняется…"];
  if (done) return parts.join("\n\n").slice(0, TELEGRAM_LIMIT);
  if (Number(run?.activeTurnCount) > 1) {
    parts.push(`🔀 Активных ходов в этой задаче: ${Number(run.activeTurnCount)}`);
  }
  const heartbeat = formatProgressHeartbeat(run);
  if (heartbeat) parts.push(heartbeat);
  if (run?.progressReasoning.trim()) {
    const reasoning = run.progressReasoning.trim();
    parts.push(`💭 ${reasoning.length > 900 ? `…${reasoning.slice(-900)}` : reasoning}`);
  }
  if (run?.responseText.trim()) {
    const answer = run.responseText.trim();
    parts.push(`✍️ Ответ формируется:\n${answer.length > 2400 ? `…${answer.slice(-2400)}` : answer}`);
  }
  return parts.join("\n\n").slice(0, TELEGRAM_LIMIT);
}

function runProgressHeading(run, done = false) {
  const fallbackModel = run?.provider === "claude"
    ? CLAUDE_MODEL_LABELS[claudeModel]
    : codexModelLabel(codexModel);
  const fallbackReasoning = CODEX_REASONING_LABELS[
    run?.provider === "claude" ? claudeReasoningEffort : codexReasoningEffort
  ];
  return formatProgressHeading({
    done,
    provider: run?.provider === "claude" ? "Claude Code" : "Codex",
    model: run?.observer ? run.model || null : run?.model ?? fallbackModel,
    reasoning: run?.observer
      ? run.reasoning || "Подключённый ход"
      : run?.reasoning ?? fallbackReasoning,
    runtime: run?.appServer ?? (
      run?.provider === "codex"
        ? taskExecutionRuntimeLabel(run?.executionOwner ?? (
          run?.observer ? TASK_EXECUTION_OWNERS.VSCODE : TASK_EXECUTION_OWNERS.TELEGRAM
        ))
        : run?.observer ? "Внешний Claude CLI" : "Telegram CLI"
    ),
    task: runTaskTitle(run),
    project: config.showProjectButton ? runProject(run).name : null,
  });
}

function scheduleProgressUpdate(run, delayMs = 1500) {
  taskProgress.schedule(run, delayMs);
}

async function flushProgressUpdate(run, done = false) {
  return taskProgress.flush(run, done);
}

async function finishProgress(run, stage) {
  const completedMessageIds = [...run?.progressMessageIds ?? []];
  run.finishedProgressMessageIds = [...new Set([
    ...(run.finishedProgressMessageIds ?? []),
    ...completedMessageIds,
  ])];
  return taskProgress.finish(run, stage);
}

async function completeRun(run) {
  if (!run) return;
  for (const [key, approval] of approvalController.pending) {
    if (approval.runId === run.id) approvalController.pending.delete(key);
  }
  taskObserver.pause(run);
  claudeRunController.pause(run);
  taskRuns.remove(run);
  invalidateTaskCatalog();
  run.status = "completed";
  run.process = null;
  syncTaskRun(run, { active: false });
  if (!taskRuns.size) stopTyping();
  await saveState();
  if (restartRequest?.waitingForRuns && !restartHasBlockingWork() && !stopping) {
    setTimeout(() => void performRestart(), 0);
  }
}

// Единая точка чтения состояния сессии Claude: у неё нет живого App Server,
// поэтому «активность» из транскрипта дополнительно проверяется на свежесть.
// Брошенный незавершённый транскрипт помечается stale и не блокирует задачу.
function applyManagedClaudeCancellation(snapshot) {
  if (!snapshot?.sessionId || !snapshot.cwd) return snapshot;
  const project = findProject(snapshot.cwd);
  if (!project) return snapshot;
  const key = taskRunKey({
    provider: "claude",
    projectRoot: project.path,
    threadId: snapshot.sessionId,
  });
  const cancelledAtMs = cancelledManagedClaudeTasks.get(key);
  if (!Number.isFinite(cancelledAtMs)) return snapshot;
  const activityAtMs = claudeSnapshotActivityAtMs(snapshot);
  if (Number.isFinite(activityAtMs) && activityAtMs > cancelledAtMs) {
    cancelledManagedClaudeTasks.delete(key);
    void saveState().catch((error) => {
      console.error("Cannot persist cleared Claude cancellation marker:", error.message);
    });
    return snapshot;
  }
  return {
    ...snapshot,
    active: false,
    completed: true,
    cancelled: true,
  };
}

async function readClaudeTaskSnapshot(sessionId) {
  const rawSnapshot = await readClaudeSessionSnapshot(sessionId);
  const snapshot = applyManagedClaudeCancellation(rawSnapshot);
  if (!snapshot) return null;
  const activityState = claudeSnapshotActivityState(snapshot);
  return {
    ...snapshot,
    active: activityState === "active",
    activityUnknown: activityState === "unknown",
    stale: activityState === "unknown",
    activityAtMs: claudeSnapshotActivityAtMs(snapshot),
  };
}

async function taskExternalActivity(target) {
  if (!target?.threadId) return { state: "inactive", executionOwner: null };
  try {
    if (target.provider === "codex") {
      if (!codexTransport.running) {
        await startCodexAppServer();
        await initializeCodex({ attachSelectedThread: false });
      }
      const result = await readCodexThread(target.threadId, {
        fresh: true,
        includeTurns: false,
      });
      const activity = await readCodexRolloutActivity(result.thread?.path);
      return {
        state: codexThreadRunning(result.thread, { rolloutRunning: activity.running }) ? "active" : "inactive",
        executionOwner: await resolveCodexObservedExecutionOwner(activity, {
          rolloutPath: result.thread?.path,
          agentHubPid: codexTransport.pid,
        }),
      };
    }
    const snapshot = await readClaudeTaskSnapshot(target.threadId);
    return {
      state: snapshot?.activityUnknown ? "unknown" : snapshot?.active ? "active" : "inactive",
      executionOwner: TASK_EXECUTION_OWNERS.EXTERNAL,
    };
  } catch (error) {
    console.error(`Cannot check ${target.provider} task activity:`, error.message);
    return { state: "unknown", executionOwner: TASK_EXECUTION_OWNERS.EXTERNAL };
  }
}

async function taskRepositoryRoots(projectRoot) {
  const resolved = path.resolve(String(projectRoot ?? ""));
  const key = process.platform === "win32" ? resolved.toLowerCase() : resolved;
  if (gitRepoRoots.has(key)) return gitRepoRoots.get(key);
  const repoRoots = await resolveTaskGitRepoRoots(projectRoot);
  // Cache only successful discovery: a non-repository directory can become a
  // repository later without requiring a bot restart.
  if (repoRoots.length) gitRepoRoots.set(key, repoRoots);
  return repoRoots;
}

async function activeRepositoryConflict(target) {
  if (!config.guardConcurrentRepositoryWrites) return null;
  const repoRoots = await taskRepositoryRoots(target.projectRoot);
  if (!repoRoots.length) return null;
  const catalog = await refreshTaskCatalog();
  const candidates = [
    ...taskRuns.values(),
    ...catalog.filter((entry) => entry.running),
  ];
  const enriched = await Promise.all(candidates.map(async (candidate) => ({
    ...candidate,
    repoRoots: Array.isArray(candidate.gitBaseline?.repositories)
      ? candidate.gitBaseline.repositories.map((repository) => repository.repoRoot)
      : candidate.gitBaseline?.repoRoot
        ? [candidate.gitBaseline.repoRoot]
        : await taskRepositoryRoots(candidate.projectRoot),
  })));
  return findRepositoryWriteConflict(target, repoRoots, enriched);
}

async function deferConflictingInput(input, temporaryFiles, {
  forceSpeechButton = false,
  executionOwner = TASK_EXECUTION_OWNERS.EXTERNAL,
  target = selectedTurnTarget(),
  allowForce = false,
  conflictKind = "task-running",
  conflictTask = null,
} = {}) {
  if (pendingInputs.size + queuedInputs.size >= MAX_DEFERRED_INPUTS) {
    await Promise.all(temporaryFiles.map((file) => unlink(file).catch(() => {})));
    throw new Error("очередь сохранённых сообщений переполнена; сначала обработайте или отмените старые сообщения");
  }
  const item = {
    id: randomUUID(),
    chatId: target.chatId,
    provider: target.provider,
    projectRoot: target.projectRoot,
    threadId: target.threadId,
    taskTitle: target.taskTitle,
    modelId: target.modelId,
    reasoningId: target.reasoningId,
    collaborationMode: target.collaborationMode,
    input,
    temporaryFiles,
    forceSpeechButton,
    allowForce,
    conflictKind,
    createdAt: new Date().toISOString(),
  };
  pendingInputs.set(item.id, item);
  await saveState();
  const preview = inputPreview(input);
  const runtime = target.provider === "codex"
    ? taskExecutionRuntimeLabel(executionOwner)
    : executionOwner === TASK_EXECUTION_OWNERS.TELEGRAM ? "Telegram CLI" : "Внешний Claude CLI";
  const conflictText = conflictKind === "repository"
    ? `Задача «${conflictTask?.taskTitle ?? "Без названия"}» уже работает с тем же Git-репозиторием через ${runtime}. Параллельная запись может смешать изменения.`
    : conflictKind === "activity-unknown"
      ? "Claude оставил незавершённый транскрипт, но давно не записывал новые события. Нельзя надёжно определить, продолжает ли работать внешний процесс."
      : `Выбранная задача уже выполняется через ${runtime}.`;
  const message = await sendMessageTo(target.chatId,
    `${conflictText} Новое сообщение сохранено и не потеряно.`
      + `${preview ? `\n\n${preview.slice(0, 700)}` : ""}\n\nЧто сделать?`,
    { reply_markup: pendingInputKeyboard(item.id, { allowForce }) });
  item.messageId = message?.message_id ?? null;
  await saveState();
  return { deferred: true, id: item.id };
}

async function launchTurn(run, input, temporaryFiles = [], { forceSpeechButton = false } = {}) {
  if (run.provider !== "codex") {
    await startClaudeTurn(run, input, temporaryFiles, { forceSpeechButton });
    return;
  }
  const items = typeof input === "string" ? [{ type: "text", text: input }] : input;
  try {
    const result = await startCodexTurnWithRecovery({
      threadId: run.threadId,
      startTurn: () => sendRpc("turn/start", {
        threadId: run.threadId,
        input: items,
        model: run.modelId,
        effort: run.reasoningId,
        collaborationMode: buildCodexCollaborationMode({
          mode: run.collaborationMode,
          model: run.modelId,
          reasoningEffort: run.reasoningId,
        }),
        approvalPolicy: "on-request",
        sandboxPolicy: {
          type: "workspaceWrite",
          writableRoots: [run.projectRoot],
          networkAccess: false,
        },
      }),
      resume: (params) => sendRpc("thread/resume", {
        ...params,
        approvalPolicy: "on-request",
        sandbox: "workspace-write",
      }),
      rollback: (params) => sendRpc("thread/rollback", params),
    });
    const previousTurnId = run.turnId;
    run.turnId = result.turn.id;
    taskRuns.reindex(run, { turnId: previousTurnId });
    turnSpeechButtons.set(run.turnId, forceSpeechButton);
    if (temporaryFiles.length) turnTemporaryFiles.set(run.turnId, temporaryFiles);
    if (!turnTokenUsage.has(run.turnId)) {
      setBoundedMapValue(turnTokenUsage, run.turnId, { usage: emptyTokenUsage(), reported: false }, 200);
    }
    await saveState();
    startTyping();
    scheduleObservedRun(run);
  } catch (error) {
    await Promise.all(temporaryFiles.map((file) => unlink(file).catch(() => {})));
    await finishProgress(run, `Ошибка запуска: ${error.message}`);
    await completeRun(run);
    throw error;
  }
}

async function startTurn(input, temporaryFiles = [], {
  forceSpeechButton = false,
  target = null,
  allowRepositoryConflict = false,
  allowUnknownExternalActivity = false,
} = {}) {
  target ??= {
    ...selectedTask(),
    taskTitle: activeThreadTitle,
    chatId,
  };
  // Give Telegram immediate, non-persistent feedback while activity checks and
  // App Server preflight run. The regular progress card follows after launch.
  void telegram("sendChatAction", {
    chat_id: target.chatId ?? chatId,
    action: "typing",
  }).catch(() => {});
  const existingRun = taskRuns.forTask(target);
  const [externalActivity, repositoryConflict] = existingRun
    ? [{ state: "active", executionOwner: existingRun.executionOwner }, null]
    : await Promise.all([
      taskExternalActivity(target),
      allowRepositoryConflict ? null : activeRepositoryConflict(target),
    ]);
  if (existingRun || externalActivity.state === "active"
    || (externalActivity.state === "unknown" && !allowUnknownExternalActivity)) {
    return deferConflictingInput(input, temporaryFiles, {
      forceSpeechButton,
      executionOwner: existingRun?.executionOwner
        ?? externalActivity.executionOwner
        ?? TASK_EXECUTION_OWNERS.EXTERNAL,
      target,
      allowForce: externalActivity.state === "unknown" && !existingRun,
      conflictKind: externalActivity.state === "unknown" && !existingRun
        ? "activity-unknown"
        : "task-running",
    });
  }
  if (repositoryConflict) {
    return deferConflictingInput(input, temporaryFiles, {
      forceSpeechButton,
      executionOwner: repositoryConflict.executionOwner ?? TASK_EXECUTION_OWNERS.EXTERNAL,
      target,
      allowForce: true,
      conflictKind: "repository",
      conflictTask: repositoryConflict,
    });
  }
  let run;
  try {
    run = await beginRun(input, target);
  } catch (error) {
    const concurrentRun = taskRuns.forTask(target);
    if (error.message !== "this task is already running" || !concurrentRun) throw error;
    return deferConflictingInput(input, temporaryFiles, {
      forceSpeechButton,
      executionOwner: concurrentRun.executionOwner ?? TASK_EXECUTION_OWNERS.TELEGRAM,
      target,
    });
  }
  await launchTurn(run, input, temporaryFiles, { forceSpeechButton });
  return { started: true, runId: run.id };
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

const deferredInputController = new DeferredInputController({
  pendingInputs,
  queuedInputs,
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
      || await activeRepositoryConflict(target));
  },
  start: async (item) => {
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
    const run = await beginRun(item.input, target);
    await launchTurn(run, item.input, item.temporaryFiles ?? [], {
      forceSpeechButton: item.forceSpeechButton === true,
    });
  },
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
  return new Promise((resolve) => {
    const {
      timeoutMs = 20_000,
      maxOutputBytes = 1024 * 1024,
      ...spawnOptions
    } = options;
    const worker = spawn(command, args, {
      cwd: activeProjectRoot,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      ...spawnOptions,
    });
    let stdout = "";
    let stderr = "";
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...result, stdout, stderr, stdoutTruncated, stderrTruncated });
    };
    const append = (current, chunk, markTruncated) => {
      if (Buffer.byteLength(current, "utf8") >= maxOutputBytes) {
        markTruncated();
        return current;
      }
      const combined = current + chunk;
      if (Buffer.byteLength(combined, "utf8") <= maxOutputBytes) return combined;
      markTruncated();
      return Buffer.from(combined, "utf8").subarray(0, maxOutputBytes).toString("utf8");
    };
    const timer = setTimeout(() => {
      const error = new Error(`process timed out after ${timeoutMs} ms: ${command}`);
      error.code = "ETIMEDOUT";
      void stopProcessTree(worker.pid).catch(() => worker.kill());
      finish({ code: null, error });
    }, timeoutMs);
    worker.stdout?.setEncoding("utf8");
    worker.stderr?.setEncoding("utf8");
    worker.stdout?.on("data", (chunk) => {
      stdout = append(stdout, chunk, () => { stdoutTruncated = true; });
    });
    worker.stderr?.on("data", (chunk) => {
      stderr = append(stderr, chunk, () => { stderrTruncated = true; });
    });
    worker.on("error", (error) => finish({ code: null, error }));
    worker.on("close", (code) => finish({ code }));
  });
}

async function spawnRuntimeNotification(script, args, requestCwd, callerEnvironment = {}) {
  const result = await spawnCapture(
    process.execPath,
    [path.join(import.meta.dirname, script), ...args],
    {
      cwd: requestCwd,
      env: {
        ...cleanRuntimeCallerEnvironment(process.env, callerEnvironment),
        AGENT_HUB_CONFIG: config.configPath,
        TELEGRAM_CODEX_CONFIG: config.configPath,
        AGENT_HUB_DIRECT: "1",
        TELEGRAM_INTEGRATION_DIRECT: "1",
      },
      timeoutMs: 180_000,
      maxOutputBytes: 256 * 1024,
    },
  );
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || result.error?.message || `${script} failed`);
  }
  return result.stdout.trim();
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

function runtimeCommandIdentity(environment = {}) {
  const codexThreadId = String(environment.CODEX_THREAD_ID ?? "").trim();
  const claudeThreadId = String(environment.CLAUDE_CODE_SESSION_ID ?? "").trim();
  if (codexThreadId && claudeThreadId) {
    throw new Error("Cannot identify the runtime caller: both Codex and Claude IDs are set");
  }
  if (codexThreadId) return { provider: "codex", threadId: codexThreadId };
  if (claudeThreadId) return { provider: "claude", threadId: claudeThreadId };
  throw new Error("Cannot identify the runtime caller");
}

async function exactRuntimeCommandTurn(identity, run) {
  if (identity.provider === "codex") {
    if (!codexTransport.running) {
      await startCodexAppServer();
      await initializeCodex({ attachSelectedThread: false });
    }
    const result = await readCodexThread(identity.threadId, {
      fresh: true,
      includeTurns: false,
    });
    const rolloutPath = String(result.thread?.path ?? "").trim();
    if (rolloutPath) {
      const turnId = selectExactActiveCodexTurnId(
        await readCodexRolloutActivity(rolloutPath),
      );
      if (turnId) return { turnId, threadResult: result };
    }
  }
  if (run?.turnId && ["running", "finishing"].includes(run.status)) {
    return { turnId: run.turnId, threadResult: null };
  }
  throw new Error("Cannot bind the deferred notification to one exact active turn");
}

async function ensureDeferredCodexTurnObserved({
  identity,
  project,
  taskTitle,
  targetChatId,
  turnId,
  threadResult,
}) {
  if (identity.provider !== "codex") return null;
  const task = {
    provider: "codex",
    projectRoot: project.path,
    threadId: identity.threadId,
    turnId,
    observer: true,
    exactTurnObserver: true,
  };
  const snapshot = await readCodexTaskSnapshot(task, { threadResult, fresh: !threadResult });
  if (!snapshot?.active || snapshot.turnId !== turnId) {
    throw new Error("Cannot observe the exact Codex turn selected for deferred delivery");
  }
  let observed = taskRuns.forTask(task);
  if (observed) {
    if (observed.observer !== true) return observed;
    if (observed.exactTurnObserver === true && observed.turnId !== turnId) {
      await pollObservedRun(observed);
      observed = taskRuns.forTask(task);
      if (observed) {
        throw new Error(`Cannot replace exact Codex turn observer ${observed.turnId} with ${turnId}`);
      }
    }
  }
  if (observed) {
    observed.exactTurnObserver = true;
    updateObservedRun(observed, snapshot);
  } else {
    observed = await observedRun({
      ...identity,
      projectRoot: project.path,
      taskTitle,
      exactTurnObserver: true,
    }, targetChatId, snapshot, turnId);
    observed.exactTurnObserver = true;
  }
  const rolloutPath = String(threadResult?.thread?.path ?? "").trim();
  if (rolloutPath) {
    try {
      applyCodexRolloutContext(
        observed,
        await readCodexTurnUsage(rolloutPath, turnId, { attempts: 1 }),
      );
    } catch (error) {
      console.error(`Cannot read Codex turn context ${turnId}:`, error.message);
    }
  }
  scheduleObservedRun(observed);
  return observed;
}

async function handleRuntimeCommand(request) {
  const allowedRoots = config.projects.map((project) => project.path);
  const requestCwd = await resolveAllowedNotificationCwd(request.cwd, { roots: allowedRoots });

  if (request.command === "turn-start") {
    if (request.args.length !== 1) throw new Error("turn-start requires one JSON payload");
    const payload = JSON.parse(request.args[0]);
    const identity = runtimeCommandIdentity(request.environment);
    if (identity.provider !== "codex"
      || payload.provider !== identity.provider
      || payload.threadId !== identity.threadId) {
      throw new Error("turn-start caller identity does not match its payload");
    }
    const requestedProjectRoot = payload.projectRoot ?? request.cwd;
    await resolveAllowedNotificationCwd(requestedProjectRoot, { roots: allowedRoots });
    const project = findProject(requestedProjectRoot);
    if (!project) throw new Error("Cannot match the started turn to a configured project");
    const turnId = String(payload.turnId ?? "").trim();
    if (!turnId) throw new Error("turn-start payload is missing turnId");
    const startedAt = String(payload.startedAt ?? new Date().toISOString());
    const prompt = String(payload.prompt ?? "").trim().slice(0, 100_000);
    const key = turnEndKey({ provider: "codex", threadId: identity.threadId, turnId });
    const existing = codexTurnStarts.get(key);
    const record = {
      provider: "codex",
      threadId: identity.threadId,
      turnId,
      projectRoot: project.path,
      startedAt: existing?.startedAt || startedAt,
      prompt: prompt || existing?.prompt || "",
      gitBaseline: payload.gitBaseline && typeof payload.gitBaseline === "object"
        ? payload.gitBaseline
        : existing?.gitBaseline ?? null,
    };
    setBoundedMapValue(codexTurnStarts, key, record, 500);
    codexHookReceipts.start = {
      receivedAt: new Date().toISOString(),
      threadId: identity.threadId,
      turnId,
      projectRoot: project.path,
      source: String(payload.source ?? "turn-start"),
      hasPrompt: Boolean(record.prompt),
      hasGitBaseline: Boolean(record.gitBaseline),
    };
    const run = taskRuns.forEvent({
      provider: "codex",
      threadId: identity.threadId,
      turnId,
      allowThreadFallback: true,
    });
    if (run) {
      run.turnId ||= turnId;
      run.startedAt = record.startedAt || run.startedAt;
      run.promptPreview = record.prompt || run.promptPreview;
      run.gitBaseline = record.gitBaseline ?? run.gitBaseline;
      taskRuns.reindex(run);
    }
    await saveState();
    return `Recorded Codex turn start ${turnId}.`;
  }

  if (request.command === "turn-complete") {
    if (request.args.length !== 1) throw new Error("turn-complete requires one JSON payload");
    const payload = JSON.parse(request.args[0]);
    const identity = runtimeCommandIdentity(request.environment);
    if (identity.provider !== "codex"
      || payload.provider !== identity.provider
      || payload.threadId !== identity.threadId) {
      throw new Error("turn-complete caller identity does not match its payload");
    }
    const requestedProjectRoot = payload.projectRoot ?? request.cwd;
    await resolveAllowedNotificationCwd(requestedProjectRoot, {
      roots: allowedRoots,
    });
    const project = findProject(requestedProjectRoot);
    if (!project) throw new Error("Cannot match the completed turn to a configured project");
    codexHookReceipts.stop = {
      receivedAt: new Date().toISOString(),
      threadId: identity.threadId,
      turnId: String(payload.turnId ?? ""),
      projectRoot: project.path,
      source: String(payload.source ?? "turn-complete"),
      status: String(payload.status ?? "unknown"),
      usageReported: payload.usageReported === true,
    };
    const run = taskRuns.forEvent({
      provider: "codex",
      threadId: identity.threadId,
      turnId: payload.turnId,
      allowThreadFallback: true,
    });
    const deliveredIdentity = {
      provider: "codex",
      threadId: identity.threadId,
      turnId: payload.turnId,
    };
    const turnStart = codexTurnStarts.get(turnEndKey(deliveredIdentity));
    if (run && turnStart) {
      run.gitBaseline = turnStart.gitBaseline ?? run.gitBaseline;
      run.startedAt = turnStart.startedAt || run.startedAt;
      run.promptPreview = turnStart.prompt || run.promptPreview;
    }
    const alreadyDelivered = turnEndNotifications.hasDelivered(deliveredIdentity);
    const taskTitle = await runtimeCommandTaskTitle({ ...identity, run });
    let baselineChangedFiles = [];
    let turnDiff = String(payload.diff ?? "");
    if (turnStart?.gitBaseline) {
      const baselineDiff = await taskGitDiff(
        turnStart.gitBaseline,
        config.dataDir,
        `turn-complete-${payload.turnId}`,
      ) ?? "";
      turnDiff = baselineDiff || turnDiff;
      baselineChangedFiles = changedFilesForRun({
        projectRoot: project.path,
        gitBaseline: turnStart.gitBaseline,
        latestDiff: turnDiff,
      });
    }
    const changedFiles = [...new Set([
      ...(Array.isArray(payload.changedFiles) ? payload.changedFiles : []),
      ...baselineChangedFiles,
      ...changedFilesForRun(run),
    ])];
    const completion = turnEndNotifications.recordCompletion({
      provider: "codex",
      threadId: identity.threadId,
      turnId: payload.turnId,
      projectRoot: project.path,
      taskTitle,
      chatId: defaultNotificationChatId(),
      status: payload.status,
      usage: payload.usage,
      usageReported: payload.usageReported === true,
      imageGenerationCount: payload.imageGenerationCount ?? 0,
      estimatedCredits: payload.estimatedCredits
        ?? (payload.estimatedUnits != null ? Number(payload.estimatedUnits) / 8_000 : 0),
      estimateKind: payload.estimateKind ?? "",
      model: payload.model ?? "",
      serviceTier: payload.serviceTier ?? payload.service_tier ?? "default",
      startedAt: payload.startedAt ?? turnStart?.startedAt ?? run?.startedAt,
      completedAt: payload.completedAt,
      prompt: payload.prompt ?? turnStart?.prompt ?? run?.promptPreview,
      finalAnswer: payload.finalAnswer ?? "",
      changedFiles,
      diff: turnDiff || run?.latestDiff || "",
    });
    if (!completion && alreadyDelivered) {
      const finalAnswer = String(payload.finalAnswer ?? "").trim();
      await projectTurnUsageToWorkLog({
        ...deliveredIdentity,
        projectRoot: project.path,
        taskTitle,
        status: payload.status,
        usage: normalizeTokenUsage(payload.usage),
        usageReported: payload.usageReported === true,
        estimatedCredits: payload.estimatedCredits
          ?? (payload.estimatedUnits != null ? Number(payload.estimatedUnits) / 8_000 : 0),
        estimateKind: payload.estimateKind ?? "",
        model: payload.model ?? "",
        serviceTier: payload.serviceTier ?? payload.service_tier ?? "default",
        startedAt: payload.startedAt ?? turnStart?.startedAt ?? run?.startedAt,
        completedAt: payload.completedAt,
        prompt: payload.prompt ?? turnStart?.prompt ?? run?.promptPreview,
        changedFiles,
        diff: turnDiff || run?.latestDiff || "",
        message: null,
      }, {
        title: conciseTurnTitle(finalAnswer, payload.status),
        body: finalAnswer,
      });
      if (finalAnswer) {
        rememberLastTaskMessage({
          provider: "codex",
          threadId: identity.threadId,
          projectRoot: project.path,
        }, finalAnswer);
        setBoundedMapValue(lastSeenTaskTurnIds, taskRunKey({
          provider: "codex",
          threadId: identity.threadId,
          projectRoot: project.path,
        }), payload.turnId, 500);
      }
    }
    codexTurnStarts.delete(turnEndKey(deliveredIdentity));
    await saveState();
    if (completion && (!run || !["running", "finishing"].includes(run.status))) {
      await deliverTurnEndNotification(completion);
    }
    return completion ? `Recorded Codex turn completion ${payload.turnId}.` : "Turn was already delivered.";
  }

  const messageCommand = request.command === "send-message";
  const script = messageCommand ? "send-message.mjs" : "send-images.mjs";
  const options = messageCommand
    ? parseSendMessageArguments(request.args)
    : parseSendImagesArguments(request.args);
  resolveNotificationChatId(config, options.chatId);

  if (messageCommand && options.messageFile) {
    options.messageFile = await resolveAllowedNotificationPath(options.messageFile, {
      roots: allowedRoots,
      cwd: requestCwd,
    });
  }
  if (request.command === "send-images") {
    await Promise.all(options.files.map((file) => resolveAllowedNotificationPath(file, {
      roots: allowedRoots,
      cwd: requestCwd,
    })));
  }
  return spawnRuntimeNotification(script, request.args, requestCwd, request.environment);
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
  onReconnect: (run, alive) => setProgressStage(run, alive
    ? "Переподключился к выполняющемуся ходу Claude."
    : "Дочитываю прерванный ход Claude…"),
});

async function startClaudeTurn(run, input, temporaryFiles, { forceSpeechButton = false } = {}) {
  const turnId = randomUUID();
  const prompt = buildClaudePrompt(input);
  const contentItems = Array.isArray(input) ? input : [];
  const additionalDirectories = contentItems
    .filter((item) => item?.type === "localImage" && item.path)
    .map((item) => path.dirname(item.path));
  const planMode = run.collaborationMode === "plan";
  const args = buildClaudeArgs({
    prompt,
    sessionId: run.threadId,
    model: run.modelId,
    permissionMode: run.collaborationMode === "plan" ? "plan" : config.claudePermissionMode,
    autoApprove: planMode ? false : autoApprove,
    additionalDirectories,
  });

  run.turnId = turnId;
  taskRuns.reindex(run, { turnId: null });
  if (temporaryFiles.length) turnTemporaryFiles.set(turnId, temporaryFiles);
  run.claudeTemporaryFiles = [...temporaryFiles];
  run.claudeForceSpeechButton = forceSpeechButton === true;
  let snapshot = null;
  if (run.threadId) {
    snapshot = await readClaudeTaskSnapshot(run.threadId).catch((error) => {
      console.warn(`Cannot resolve Claude session directory ${run.threadId}:`, error.message);
      return null;
    });
  }
  const sessionCwd = resolveClaudeSessionCwd(
    run.projectRoot,
    snapshot?.cwd ?? run.sessionCwd,
  );
  run.sessionCwd = sessionCwd;
  const invocation = resolveClaudeInvocation();
  await claudeRunController.start(run, {
    command: invocation.command,
    args: [...invocation.prefixArgs, ...args],
    cwd: sessionCwd,
    env: {
      ...process.env,
      MAX_THINKING_TOKENS: String(claudeThinkingTokens(run.reasoningId)),
    },
  });
}

function handleClaudeStreamEvent(run, parsed) {
  if (parsed.sessionId && parsed.sessionId !== run.threadId) {
    const previousThreadId = run.threadId;
    const wasSelected = isSelectedRun(run);
    run.sessionId = parsed.sessionId;
    run.threadId = parsed.sessionId;
    if (!run.taskTitle || run.taskTitle === "Новая задача Claude") {
      run.taskTitle = `Сессия Claude · ${parsed.sessionId.slice(0, 8)}`;
    }
    taskRuns.reindex(run, { threadId: previousThreadId });
    if (wasSelected) {
      threadId = parsed.sessionId;
      threadIdsByProvider.claude = parsed.sessionId;
      activeThreadTitle = runTaskTitle(run);
    }
    for (const messageId of run.progressMessageIds) {
      void bindRunMessage(run, { message_id: messageId }).catch((error) => {
        console.error("Cannot bind Claude progress message:", error.message);
      });
    }
    void saveState();
  }
  if (parsed.textDelta) {
    run.responseText += parsed.textDelta;
    noteRunActivity(run);
    scheduleProgressUpdate(run);
  }
  // Claude Code headless не раскрывает текст мышления, поэтому показываем
  // индикатор с оценкой числа «думательных» токенов. Если текст всё же придёт
  // (в будущих версиях) — выводим и его в блок рассуждений.
  if (parsed.thinkingDelta) appendProgressReasoning(run, parsed.thinkingDelta);
  if (parsed.thinkingTokens != null) {
    run.claudeThinkingPeak = Math.max(Number(run.claudeThinkingPeak ?? 0), parsed.thinkingTokens);
    if (!run.responseText.trim()) {
      setProgressStage(run, `🧠 Claude размышляет (~${parsed.thinkingTokens} токенов)…`);
    }
  }
  if (parsed.event?.type === "system" && parsed.event?.subtype === "api_retry") {
    const reason = parsed.event.error ? `: ${parsed.event.error}` : "";
    setProgressStage(run, `Claude повторяет запрос (${parsed.event.attempt}/${parsed.event.max_retries})${reason}…`);
  }
  if (parsed.event?.type === "rate_limit_event" && parsed.event.rate_limit_info?.status === "rejected") {
    const resetAt = Number(parsed.event.rate_limit_info.resetsAt);
    const resetText = Number.isFinite(resetAt)
      ? new Date(resetAt * 1000).toLocaleString("ru-RU")
      : "неизвестно";
    run.claudeFailureText = `Исчерпан лимит Claude. Сброс: ${resetText}.`;
    setProgressStage(run, run.claudeFailureText);
  }
  if (parsed.event?.type === "assistant" && parsed.event.error) {
    const messageText = parsed.event.message?.content
      ?.filter((item) => item?.type === "text")
      .map((item) => item.text)
      .join("\n")
      .trim();
    if (messageText) run.claudeFailureText = messageText;
  }
  const streamEvent = parsed.event?.type === "stream_event" ? parsed.event.event : null;
  if (streamEvent?.type === "content_block_start" && streamEvent.content_block?.type === "tool_use") {
    setProgressStage(run, `Claude использует инструмент ${streamEvent.content_block.name ?? ""}…`);
  }
}

async function finishClaudeRun(run, {
  spawnError = null,
  result,
  errorText = "",
  exitCode = null,
} = {}) {
  if (!run) return;
  const turnId = run.turnId;
  const files = turnTemporaryFiles.get(turnId) ?? run.claudeTemporaryFiles ?? [];
  turnTemporaryFiles.delete(turnId);
  run.claudeTemporaryFiles = [];
  await Promise.all(files.map((file) => unlink(file).catch(() => {})));
  const forceSpeechButton = run.claudeForceSpeechButton === true;

  try {
    if (spawnError) throw spawnError;
    if (!result) {
      throw new Error(
        run.claudeFailureText
          || errorText
          || (exitCode === null
            ? "Claude Code завершился, не вернув результат"
            : `Claude Code завершился с кодом ${exitCode}`),
      );
    }
    if (result.session_id) {
      const previousThreadId = run.threadId;
      const wasSelected = isSelectedRun(run);
      run.threadId = result.session_id;
      run.sessionId = result.session_id;
      if (!run.taskTitle || run.taskTitle === "Новая задача Claude") {
        run.taskTitle = `Сессия Claude · ${result.session_id.slice(0, 8)}`;
      }
      taskRuns.reindex(run, { threadId: previousThreadId });
      if (wasSelected) {
        threadId = result.session_id;
        threadIdsByProvider.claude = result.session_id;
        activeThreadTitle = run.taskTitle;
      }
      await saveState();
    }
    const failed = (exitCode !== null && exitCode !== 0) || result.is_error === true;
    const answer = failed
      ? claudeFailureMessage(result, {
        streamFailureText: run.claudeFailureText,
        errorText,
        exitCode,
      })
      : String(result.result ?? "").trim() || "Задача завершена.";
    if (failed) {
      console.error(`Claude turn ${run.turnId ?? "unknown"} failed: ${answer}`);
    }
    await finishProgress(run, failed ? `Claude остановлен: ${answer}` : "Задача завершена.");
    const response = failed ? `Ошибка Claude Code: ${answer}` : answer;
    await finalizeRunDelivery(run, {
      answer: response,
      message: `${response}\n\n${formatClaudeUsage(result, run.claudeThinkingPeak ?? 0)}`,
      speechText: answer,
      forceSpeechButton,
      description: "финальный ответ Claude",
    });
  } catch (error) {
    await finishProgress(run, `Claude остановлен: ${error.message}`);
    const answer = `Ошибка Claude Code: ${error.message}`;
    await finalizeRunDelivery(run, {
      answer,
      description: "ошибка Claude",
    });
  }
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
  const { method, params = {}, id } = message;
  if (params.threadId) invalidateCodexThreadRead(params.threadId);
  if (id !== undefined && method) {
    console.error(`Codex server request received: ${method}`);
  }
  const eventTurnId = params.turn?.id ?? params.turnId ?? null;
  let run = taskRuns.forEvent({
    turnId: eventTurnId,
    threadId: params.threadId,
    provider: "codex",
    allowThreadFallback: method === "turn/started",
  });
  if (method === "thread/settings/updated") {
    applyCodexThreadSettings(params.threadId, params.threadSettings);
    void saveState();
  }
  if (method === "turn/started") {
    if (run && eventTurnId) {
      const previous = { turnId: run.turnId, threadId: run.threadId };
      run.turnId = eventTurnId;
      run.threadId = params.threadId ?? run.threadId;
      taskRuns.reindex(run, previous);
    }
    if (eventTurnId && !turnTokenUsage.has(eventTurnId)) {
      setBoundedMapValue(turnTokenUsage, eventTurnId, { usage: emptyTokenUsage(), reported: false }, 200);
    }
    if (run && eventTurnId) void saveState();
  }
  if (method === "thread/tokenUsage/updated") {
    trackTurnTokenUsage(params);
    void saveState();
  }
  if (method === "turn/diff/updated" && run) {
    run.latestDiff = params.diff ?? run.latestDiff;
    taskDiffs.remember(taskRunKey(run), run.latestDiff);
    if (isSelectedRun(run)) latestDiff = run.latestDiff;
  }
  if (method === "item/agentMessage/delta" && run) {
    const delta = params.delta ?? "";
    run.responseText += delta;
    if (delta) noteRunActivity(run);
    scheduleProgressUpdate(run);
  }
  if ((method === "item/reasoning/summaryTextDelta" || method === "item/plan/delta") && run) {
    appendProgressReasoning(run, params.delta);
  }
  if (method === "item/started" && run) setProgressStage(run, describeCodexItem(params.item, false));
  if (method === "item/completed" && run) setProgressStage(run, describeCodexItem(params.item, true));

  if (method === "item/commandExecution/requestApproval") {
    await requestApproval(id, "command", params, formatCommandApproval(params, run), run);
  } else if (method === "item/fileChange/requestApproval") {
    await requestApproval(id, "file", params, formatFileApproval(params), run);
  } else if (method === "item/permissions/requestApproval") {
    await requestApproval(id, "permissions", params, formatPermissionsApproval(params), run);
  } else if (method === "mcpServer/elicitation/request") {
    await requestMcpElicitation(id, params, run);
  } else if (method === "turn/completed") {
    if (!run) {
      turnTokenUsage.delete(eventTurnId);
      turnSpeechButtons.delete(eventTurnId);
      const temporaryFiles = turnTemporaryFiles.get(eventTurnId) ?? [];
      turnTemporaryFiles.delete(eventTurnId);
      await Promise.all(temporaryFiles.map((file) => unlink(file).catch(() => {})));
      console.warn(`Completed Codex turn ${eventTurnId ?? "unknown"} has no registered task run`);
      return;
    }
    if (run.status !== "running") return;
    if (run.observer === true) {
      const completedTurnId = eventTurnId ?? run.turnId;
      const tracker = consumeTurnTokenTracker(completedTurnId);
      turnSpeechButtons.delete(completedTurnId);
      const temporaryFiles = turnTemporaryFiles.get(completedTurnId) ?? [];
      turnTemporaryFiles.delete(completedTurnId);
      await Promise.all(temporaryFiles.map((file) => unlink(file).catch(() => {})));
      await finishObservedRun(run, {
        ...codexTurnSnapshot(params.turn),
        turnId: completedTurnId,
        executionOwner: run.executionOwner,
        tokenTracker: tracker,
      });
      return;
    }
    run.status = "finishing";
    const completedTurnId = eventTurnId ?? run.turnId;
    const tracker = consumeTurnTokenTracker(completedTurnId);
    const temporaryFiles = turnTemporaryFiles.get(completedTurnId) ?? [];
    turnTemporaryFiles.delete(completedTurnId);
    const forceSpeechButton = turnSpeechButtons.get(completedTurnId) ?? false;
    turnSpeechButtons.delete(completedTurnId);
    await Promise.all(temporaryFiles.map((file) => unlink(file).catch(() => {})));
    const status = params.turn?.status ?? "completed";
    const error = params.turn?.error?.message;
    const answer = await completedCodexAnswer(run, completedTurnId, params.turn)
      || (error ? `Ошибка: ${error}` : `Задача завершена: ${status}`);
    await finishProgress(run, error || status === "failed" ? `Задача завершилась с ошибкой: ${error ?? status}` : "Задача завершена.");
    await finalizeCodexRunDelivery(run, {
      answer,
      turnId: completedTurnId,
      status,
      tracker,
      forceSpeechButton,
      description: "финальный ответ Codex",
    });
  }
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

function describeCodexItem(item, completed) {
  if (!item || typeof item !== "object") return completed ? "Этап завершён." : "Выполняется следующий этап…";
  const mark = completed ? "✓" : "⚙";
  if (item.type === "commandExecution") {
    const command = String(item.command ?? "команда").replace(/\s+/g, " ").slice(0, 180);
    return `${mark} ${completed ? "Команда выполнена" : `Выполняется команда: ${command}`}`;
  }
  if (item.type === "fileChange") return `${mark} ${completed ? "Изменения файлов применены" : "Изменяются файлы…"}`;
  if (item.type === "mcpToolCall") return `${mark} Инструмент ${item.server ?? "MCP"}/${item.tool ?? ""}${completed ? " завершён" : " выполняется…"}`;
  if (item.type === "dynamicToolCall") return `${mark} Инструмент ${item.tool ?? ""}${completed ? " завершён" : " выполняется…"}`;
  if (item.type === "webSearch") return `${mark} ${completed ? "Поиск завершён" : "Выполняется поиск…"}`;
  if (item.type === "imageView") return `${mark} ${completed ? "Изображение изучено" : "Изучается изображение…"}`;
  if (item.type === "reasoning") return completed ? "✓ Анализ завершён." : "Анализирую задачу…";
  if (item.type === "plan") return completed ? "✓ План подготовлен." : "Составляю план…";
  return completed ? "Этап завершён." : "Выполняется следующий этап…";
}

function recoveredCodexAnswer(turn) {
  return codexTurnAnswer(turn);
}

function codexTurnSnapshot(turn, threadStatus = null) {
  const items = Array.isArray(turn?.items) ? turn.items : [];
  const lastItem = items.at(-1);
  const answer = recoveredCodexAnswer(turn);
  const hasExplicitFinalAnswer = codexTurnHasExplicitFinalAnswer(turn);
  const waitingOnApproval = codexThreadWaitingOnApproval(threadStatus);
  const prompt = codexThreadHistory([turn]).at(-1)?.prompt ?? "";
  return {
    answer,
    finalAnswer: codexFinalTurnAnswer(turn),
    reasoning: "",
    prompt,
    completed: turn?.status !== "inProgress",
    active: turn?.status === "inProgress",
    status: turn?.status === "completed" ? "completed" : String(turn?.status ?? "stopped"),
    waitingOnApproval,
    stage: turn?.status === "inProgress"
      ? waitingOnApproval
        ? "🔐 Ожидается подтверждение разрешений."
        : describeCodexItem(lastItem, false)
      : turn?.status === "completed" || hasExplicitFinalAnswer
        ? "Задача завершена."
        : `Задача остановлена: ${turn?.status ?? "неизвестно"}.`,
  };
}

async function observedRun(binding, targetChatId, snapshot, turnId = null) {
  const executionOwner = binding.provider === "codex"
    ? snapshot.executionOwner ?? TASK_EXECUTION_OWNERS.EXTERNAL
    : TASK_EXECUTION_OWNERS.EXTERNAL;
  const run = createObservedTaskRun({
    provider: binding.provider,
    chatId: targetChatId,
    projectRoot: binding.projectRoot,
    projectName: findProject(binding.projectRoot)?.name ?? path.basename(binding.projectRoot),
    threadId: binding.threadId,
    turnId,
    taskTitle: binding.taskTitle,
    promptPreview: "",
    model: binding.provider === "codex" && snapshot.model
      ? codexModelLabel(snapshot.model)
      : null,
    modelId: null,
    reasoning: binding.provider === "codex" && snapshot.reasoningEffort
      ? CODEX_REASONING_LABELS[snapshot.reasoningEffort] ?? snapshot.reasoningEffort
      : "Подключённый ход",
    reasoningId: null,
    executionOwner,
    activeTurnCount: Number(snapshot.activeTurnCount) || 1,
    appServer: binding.provider === "codex"
      ? taskExecutionRuntimeLabel(executionOwner)
      : "Внешний Claude CLI",
    collaborationMode: "default",
  }, snapshot);
  run.gitBaseline = await captureTaskGitBaseline(run.projectRoot, config.dataDir, run.id);
  taskRuns.add(run);
  invalidateTaskCatalog();
  syncTaskRun(run, {
    active: true,
    stage: snapshot.stage,
    answer: snapshot.answer,
    activityAtMs: snapshot.activityAtMs ?? snapshot.modifiedAtMs ?? Date.now(),
  });
  return run;
}

function updateObservedRun(run, snapshot) {
  const previousReasoning = run.progressReasoning;
  const previousStage = run.progressStage;
  const responseChanged = updateObservedResponse(run, snapshot?.answer);
  if (run.provider === "codex" && !run.turnId && snapshot?.turnId) {
    run.turnId = snapshot.turnId;
    taskRuns.reindex(run);
  }
  if (!run.promptPreview && snapshot?.prompt) run.promptPreview = String(snapshot.prompt).slice(0, 4_000);
  run.progressReasoning = String(snapshot?.reasoning ?? run.progressReasoning);
  run.progressStage = String(snapshot?.stage ?? run.progressStage);
  run.activeTurnCount = Math.max(1, Number(snapshot?.activeTurnCount) || 1);
  if (run.provider === "codex" && snapshot?.model) {
    run.model = codexModelLabel(snapshot.model);
  }
  if (run.provider === "codex" && snapshot?.reasoningEffort) {
    run.reasoning = CODEX_REASONING_LABELS[snapshot.reasoningEffort]
      ?? snapshot.reasoningEffort;
  }
  const activityAtMs = Number(snapshot?.activityAtMs ?? snapshot?.modifiedAtMs);
  if (Number.isFinite(activityAtMs)) noteRunActivity(run, activityAtMs);
  if (responseChanged || run.progressReasoning !== previousReasoning || run.progressStage !== previousStage) {
    noteRunActivity(run);
  }
  scheduleProgressUpdate(run);
  return responseChanged;
}

async function readCodexTaskSnapshot(run, { threadResult = null, fresh = false } = {}) {
  const result = threadResult ?? await readCodexThread(run.threadId, {
    fresh,
    includeTurns: false,
  });
  const turns = Array.isArray(result.thread?.turns) ? result.thread.turns : [];
  const exactTurnObserver = run.exactTurnObserver === true;
  const activity = await readCodexRolloutActivity(
    result.thread?.path,
    exactTurnObserver ? { freshnessMs: Number.POSITIVE_INFINITY } : {},
  );
  if (!turns.length) {
    const threadActive = result.thread?.status?.type === "active";
    const {
      turnId,
      active,
      completed,
      latestAnswer,
      finalAnswer,
    } = codexRolloutTurnState(activity, run.turnId, {
      exact: exactTurnObserver,
      threadActive,
    });
    return {
      answer: active ? latestAnswer : finalAnswer,
      finalAnswer,
      reasoning: "",
      completed,
      active,
      status: completed ? "completed" : active ? "inProgress" : "stopped",
      waitingOnApproval: false,
      stage: active
        ? "Выполняется следующий этап…"
        : finalAnswer ? "Задача завершена." : "Задача остановлена или неактивна.",
      turnId,
      activeTurnCount: activity.activeTurnIds.length,
      activityAtMs: Number(activity.activityAtMsByTurnId?.[turnId])
        || activity.lastActivityAtMs,
      model: activity.model,
      reasoningEffort: activity.reasoningEffort,
      executionOwner: run?.observer === true
        ? await resolveCodexObservedExecutionOwner(activity, {
          turnId,
          rolloutPath: result.thread?.path,
          agentHubPid: codexTransport.pid,
        })
        : TASK_EXECUTION_OWNERS.TELEGRAM,
    };
  }
  const turn = selectCodexTurn(turns, {
    requestedTurnId: run.turnId,
    rolloutActiveTurnIds: activity.activeTurnIds,
    strictRequested: exactTurnObserver || run.observer !== true,
  });
  if (!turn) return null;
  const snapshot = {
    ...codexTurnSnapshot(turn, result.thread?.status),
    turnId: turn.id,
    activeTurnCount: activity.activeTurnIds.length || (turn?.status === "inProgress" ? 1 : 0),
    activityAtMs: Number(activity.activityAtMsByTurnId?.[turn.id])
      || activity.lastActivityAtMs,
    model: activity.model,
    reasoningEffort: activity.reasoningEffort,
    executionOwner: run?.observer === true
      ? await resolveCodexObservedExecutionOwner(activity, {
        turnId: turn.id,
        rolloutPath: result.thread?.path,
        agentHubPid: codexTransport.pid,
      })
      : TASK_EXECUTION_OWNERS.TELEGRAM,
  };
  if (!snapshot.active && activity.activeTurnIds.includes(turn.id)) {
    return {
      ...snapshot,
      completed: false,
      active: true,
      stage: describeCodexItem(turn.items?.at(-1), false),
    };
  }
  return snapshot;
}

async function finishObservedRun(run, snapshot) {
  if (taskRuns.forTask(run) !== run) return;
  const completedTurnId = snapshot?.turnId ?? run.turnId;
  let tracker = run.provider === "codex"
    ? snapshot?.tokenTracker ?? consumeTurnTokenTracker(completedTurnId)
    : null;
  updateObservedRun(run, snapshot);
  const answer = String(snapshot?.answer ?? "").trim()
    || savedLastTaskMessage(run)
    || "Ход завершён без текстового ответа.";
  const deliver = shouldDeliverObservedCompletion(
    run,
    answer,
    savedLastTaskMessageRecord(run),
  );
  await finishProgress(run, snapshot?.stage ?? "Задача завершена.");
  if (run.provider === "codex") {
    if (run.executionOwner !== TASK_EXECUTION_OWNERS.TELEGRAM) {
      const hooked = await waitForTurnEndCompletion({
        provider: "codex",
        threadId: run.threadId,
        turnId: completedTurnId,
      });
      if (hooked?.usageReported || Number(hooked?.estimatedCredits) > 0) {
        tracker = {
          usage: hooked.usage,
          reported: hooked.usageReported === true,
          estimatedCredits: hooked.estimatedCredits,
          estimateKind: hooked.estimateKind,
          model: hooked.model,
          serviceTier: hooked.serviceTier,
        };
      } else if (!tracker?.reported) {
        try {
          const result = await readCodexThread(run.threadId, {
            fresh: true,
            includeTurns: false,
          });
          const usageResult = await readCodexTurnUsage(
            result.thread?.path,
            completedTurnId,
          );
          tracker = {
            usage: usageResult.usage,
            reported: usageResult.reported === true,
            imageGenerationCount: usageResult.imageGenerationCount,
            estimatedCredits: usageResult.estimatedCredits,
            estimateKind: usageResult.estimateKind,
            model: usageResult.model,
            serviceTier: usageResult.serviceTier,
          };
          applyCodexRolloutContext(run, usageResult);
        } catch (error) {
          console.error(`Cannot read fallback usage for Codex turn ${completedTurnId}:`, error.message);
        }
      }
    }
    await finalizeCodexRunDelivery(run, {
      answer,
      turnId: completedTurnId,
      status: snapshot?.status ?? "completed",
      tracker,
      deliver,
      silent: run.displayRequested !== true,
      description: "финальный ответ наблюдаемого хода",
    });
  } else {
    await finalizeRunDelivery(run, {
      answer,
      deliver,
      silent: run.displayRequested !== true,
      description: "финальный ответ наблюдаемого хода",
    });
  }
}

// Незавершённый транскрипт после долгой тишины не доказывает ни завершение, ни
// продолжение процесса. Снимаем live-наблюдение, но не выдаём частичный текст за
// финальный ответ; следующий запуск в этом треде потребует явного подтверждения.
async function finishUnknownObservedClaudeRun(run, snapshot) {
  if (taskRuns.forTask(run) !== run) return;
  const activityAtMs = Number(snapshot?.activityAtMs);
  const idleMinutes = Number.isFinite(activityAtMs)
    ? Math.max(1, Math.round((Date.now() - activityAtMs) / 60_000))
    : null;
  const stage = idleMinutes
    ? `Активность Claude неизвестна: нет новых событий ${idleMinutes} мин.`
    : "Активность Claude неизвестна: новых событий нет.";
  updateObservedRun(run, { ...snapshot, stage });
  await finishProgress(run, stage);
  await completeRun(run);
  console.log(`Claude activity became unknown for ${run.threadId}`);
}

async function finishManagedCodexSnapshot(run, snapshot) {
  if (taskRuns.forTask(run) !== run || run.status !== "running") return;
  run.status = "finishing";
  const completedTurnId = run.turnId;
  const tracker = consumeTurnTokenTracker(completedTurnId);
  const temporaryFiles = turnTemporaryFiles.get(completedTurnId) ?? [];
  turnTemporaryFiles.delete(completedTurnId);
  const forceSpeechButton = turnSpeechButtons.get(completedTurnId) ?? false;
  turnSpeechButtons.delete(completedTurnId);
  await Promise.all(temporaryFiles.map((file) => unlink(file).catch(() => {})));
  const answer = String(snapshot?.finalAnswer ?? "").trim()
    || String(snapshot?.answer ?? "").trim()
    || run.responseText.trim()
    || "Ход завершён без текстового ответа.";
  await finishProgress(run, snapshot?.stage ?? "Задача завершена.");
  await finalizeCodexRunDelivery(run, {
    answer,
    turnId: completedTurnId,
    status: snapshot?.status ?? "completed",
    tracker,
    forceSpeechButton,
    description: "восстановленный финальный ответ Codex",
  });
}

const taskObserver = new TaskObserverController({
  canObserve: (run) => Boolean(
    (run?.observer || run?.provider === "codex")
      && taskRuns.forTask(run) === run,
  ),
  readSnapshot: (run) => run.provider === "codex"
    ? readCodexTaskSnapshot(run)
    : readClaudeTaskSnapshot(run.threadId),
  pollDelay: (run) => run.observer === true
    ? EXTERNAL_TASK_POLL_INTERVAL_MS
    : MANAGED_TASK_FALLBACK_POLL_INTERVAL_MS,
  onUnknown: finishUnknownObservedClaudeRun,
  onMissing: async (run) => {
    setProgressStage(run, "Ожидаю данные текущего хода…");
    if (markProgressHeartbeat(run, "waiting")) scheduleProgressUpdate(run);
  },
  onTurnChanged: async (run, turnId) => {
    if (run.exactTurnObserver === true) {
      throw new Error(`Exact Codex turn observer cannot move from ${run.turnId} to ${turnId}`);
    }
    const previousTurnId = run.turnId;
    run.turnId = turnId;
    taskRuns.reindex(run, { turnId: previousTurnId });
  },
  onCompleted: async (run, snapshot) => {
    if (run.observer) await finishObservedRun(run, snapshot);
    else await finishManagedCodexSnapshot(run, snapshot);
  },
  onActive: async (run, snapshot) => {
    run.executionOwner = run.observer === true
      ? snapshot.executionOwner ?? TASK_EXECUTION_OWNERS.EXTERNAL
      : TASK_EXECUTION_OWNERS.TELEGRAM;
    if (run.provider === "codex") {
      run.appServer = taskExecutionRuntimeLabel(run.executionOwner);
      run.activeTurnCount = Math.max(1, Number(snapshot.activeTurnCount) || 1);
    }
    if (Number.isFinite(Number(snapshot.activityAtMs ?? snapshot.modifiedAtMs))) {
      noteRunActivity(run, Number(snapshot.activityAtMs ?? snapshot.modifiedAtMs));
    }
    if (markProgressHeartbeat(run, progressHeartbeatState(run))) scheduleProgressUpdate(run);
    if (run.observer) {
      updateObservedRun(run, snapshot);
    } else {
      const answer = String(snapshot.answer ?? "").trim();
      if (answer && answer !== run.responseText) {
        run.responseText = answer;
        noteRunActivity(run);
      }
      run.progressReasoning = String(snapshot.reasoning ?? run.progressReasoning);
      run.progressStage = String(snapshot.stage ?? run.progressStage);
      scheduleProgressUpdate(run);
    }
    syncTaskRun(run, {
      active: true,
      stage: snapshot.stage,
      answer: snapshot.answer,
      activityAtMs: snapshot.activityAtMs ?? snapshot.modifiedAtMs ?? Date.now(),
    });
  },
  onError: async (run, error) => {
    console.error(`Cannot observe ${run.provider} task ${run.threadId}:`, error.message);
    setProgressStage(run, `Не удалось обновить ход: ${error.message}`);
    if (markProgressHeartbeat(run, "error")) scheduleProgressUpdate(run);
  },
});

function scheduleObservedRun(run) {
  taskObserver.schedule(run);
}

async function pollObservedRun(run) {
  return taskObserver.poll(run);
}

async function codexAccountingThread(thread) {
  const targetThreadId = String(thread?.id ?? "").trim();
  const cached = codexAccountingThreadRoots.get(targetThreadId);
  if (cached) return cached;
  const resolved = await resolveCodexAccountingThread(thread, {
    readThread: async (parentThreadId) => {
      const response = await sendRpc("thread/read", {
        threadId: parentThreadId,
        includeTurns: false,
      });
      return response?.thread;
    },
  });
  if (resolved.isSubagent) {
    setBoundedMapValue(codexAccountingThreadRoots, targetThreadId, resolved, 2_000);
  }
  return resolved;
}

async function reconcileRecentCodexTerminalTurn(thread, project, terminal) {
  const completedAtMs = Date.parse(String(terminal?.completedAt ?? ""));
  if (terminal?.status === "completed"
    && Number.isFinite(completedAtMs)
    && Date.now() - completedAtMs < COMPLETED_CODEX_TERMINAL_GRACE_MS) return false;
  const identity = {
    provider: "codex",
    threadId: String(thread.id),
    turnId: String(terminal.turnId),
  };
  const key = turnEndKey(identity);
  const subagentThread = Boolean(String(thread?.parentThreadId ?? "").trim());
  const alreadyDelivered = turnEndNotifications.hasDelivered(identity);
  const pendingCompletion = turnEndNotifications.get(identity);
  if (!subagentThread
    && pendingCompletion
    && pendingCompletion.status !== "unknown"
    && pendingCompletion.usageReported) return true;
  if (reconcilingCodexTerminalTurns.has(key)) return false;
  reconcilingCodexTerminalTurns.add(key);
  try {
    const accountingThread = await codexAccountingThread(thread);
    const usageResult = await readCodexTurnUsage(thread.path, identity.turnId);
    const authoritativeStatus = terminal?.authoritative === true;
    if (!usageResult.terminal && !authoritativeStatus) return false;
    const resolvedStatus = usageResult.terminal
      ? (usageResult.status || terminal.status)
      : terminal.status;
    const resolvedCompletedAt = usageResult.terminal
      ? (usageResult.completedAt || terminal.completedAt)
      : terminal.completedAt;
    const provisional = authoritativeStatus && !usageResult.terminal;
    const turnStart = codexTurnStarts.get(key);
    const baselineDiff = turnStart?.gitBaseline
      ? await taskGitDiff(
        turnStart.gitBaseline,
        config.dataDir,
        `terminal-audit-${identity.turnId}`,
      ) ?? ""
      : "";
    const turnDiff = baselineDiff || usageResult.diff || "";
    const changedFiles = [...new Set([
      ...(usageResult.changedFiles ?? []).flatMap((file) => {
        const absolute = path.resolve(String(file));
        const relative = path.relative(project.path, absolute);
        if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return [];
        return [relative.replaceAll(path.sep, "/")];
      }),
      ...changedFilesForRun({
        projectRoot: project.path,
        gitBaseline: turnStart?.gitBaseline,
        latestDiff: turnDiff,
      }),
    ])];
    if (accountingThread.isSubagent) {
      const finalAnswer = String(usageResult.finalAnswer ?? "").trim();
      const journal = await projectTurnUsageToWorkLog({
        ...identity,
        taskThreadId: accountingThread.threadId,
        parentThreadId: accountingThread.parentThreadId,
        aggregateOnly: true,
        projectRoot: project.path,
        taskTitle: await runtimeCommandTaskTitle({
          provider: "codex",
          threadId: accountingThread.threadId,
          thread: accountingThread.thread,
        }),
        status: resolvedStatus,
        provisional,
        usage: usageResult.usage,
        usageReported: usageResult.reported === true,
        estimatedCredits: usageResult.estimatedCredits,
        estimateKind: usageResult.estimateKind,
        model: usageResult.model,
        serviceTier: usageResult.serviceTier,
        startedAt: usageResult.startedAt,
        completedAt: resolvedCompletedAt,
        prompt: usageResult.prompt,
        changedFiles,
        diff: turnDiff,
        message: null,
      }, {
        title: conciseTurnTitle(finalAnswer, resolvedStatus),
        body: finalAnswer,
      });
      if (journal?.projectionError) {
        console.error(
          `WORK_LOG subagent projection deferred for turn ${identity.turnId}: ${journal.projectionError}`,
        );
      }
      codexTurnStarts.delete(key);
      console.log(
        `Accounted Codex subagent turn ${identity.turnId} to thread ${accountingThread.threadId}`,
      );
      return true;
    }
    if (alreadyDelivered) {
      const registeredMessage = turnEndNotifications.takePendingMessage(identity);
      const journalTurn = await workLogUsageStore.getTurn(identity);
      const correctedBody = usageResult.finalAnswer
        || registeredMessage?.text
        || (journalTurn?.provisional ? fallbackTurnEndMessage(resolvedStatus) : "");
      const correctedTitle = correctedBody
        ? registeredMessage?.title || conciseTurnTitle(correctedBody, resolvedStatus)
        : "";
      const journal = await projectTurnUsageToWorkLog({
        ...identity,
        projectRoot: project.path,
        taskTitle: await runtimeCommandTaskTitle({ ...identity, thread }),
        status: resolvedStatus,
        usage: usageResult.usage,
        usageReported: usageResult.reported === true,
        estimatedCredits: usageResult.estimatedCredits,
        estimateKind: usageResult.estimateKind,
        model: usageResult.model,
        serviceTier: usageResult.serviceTier,
        startedAt: usageResult.startedAt,
        completedAt: resolvedCompletedAt,
        prompt: usageResult.prompt,
        changedFiles,
        diff: turnDiff,
        message: null,
      }, {
        title: correctedTitle,
        body: correctedBody,
      });
      if (journal?.projectionError) {
        console.error(
          `WORK_LOG correction deferred for turn ${identity.turnId}: ${journal.projectionError}`,
        );
      }
      if (correctedBody) {
        rememberLastTaskMessage({
          ...identity,
          projectRoot: project.path,
        }, correctedBody);
        setBoundedMapValue(lastSeenTaskTurnIds, taskRunKey({
          ...identity,
          projectRoot: project.path,
        }), identity.turnId, 500);
      }
      codexTurnStarts.delete(key);
      if (registeredMessage || correctedBody) await saveState();
      console.log(`Reconciled delivered Codex terminal turn ${identity.turnId} (${resolvedStatus})`);
      return true;
    }
    const completion = turnEndNotifications.recordCompletion({
      ...identity,
      projectRoot: project.path,
      taskTitle: await runtimeCommandTaskTitle({ ...identity, thread }),
      chatId: defaultNotificationChatId(),
      status: resolvedStatus,
      provisional,
      usage: usageResult.usage,
      usageReported: usageResult.reported === true,
      imageGenerationCount: usageResult.imageGenerationCount,
      estimatedCredits: usageResult.estimatedCredits,
      estimateKind: usageResult.estimateKind,
      model: usageResult.model,
      serviceTier: usageResult.serviceTier,
      startedAt: usageResult.startedAt,
      completedAt: resolvedCompletedAt,
      prompt: usageResult.prompt,
      finalAnswer: usageResult.finalAnswer,
      changedFiles,
      diff: turnDiff,
    });
    codexTurnStarts.delete(key);
    await saveState();
    if (completion) {
      await deliverTurnEndNotification(completion);
      console.log(`Recovered unhooked Codex terminal turn ${identity.turnId} (${completion.status})`);
    }
    return true;
  } catch (error) {
    console.error(`Cannot recover unhooked Codex turn ${identity.turnId}:`, error.message);
    throw error;
  } finally {
    reconcilingCodexTerminalTurns.delete(key);
  }
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

function scheduleRateLimitPoll(delayMs = 5 * 60_000) {
  if (rateLimitPollTimer || stopping) return;
  rateLimitPollTimer = setTimeout(() => {
    rateLimitPollTimer = null;
    void pollRateLimits();
  }, Math.max(0, Number(delayMs) || 0));
}

async function pollRateLimits() {
  try {
    if (!codexTransport.running) return;
    const observedAt = new Date().toISOString();
    const result = await sendRpc("account/rateLimits/read", {}, { timeoutMs: 5_000 });
    const summary = formatCodexRateLimits(result);
    await appendRateLimitRows(
      path.join(config.dataDir, "rate-limits.csv"),
      codexRateLimitRows(result, observedAt),
    );
    await workLogUsageStore.projectRateLimits(
      path.join(config.projectRoot, "WORK_LOG.md"),
      summary,
      observedAt,
    );
  } catch (error) {
    console.error("Cannot poll Codex rate limits:", error.message);
  } finally {
    scheduleRateLimitPoll();
  }
}

function scheduleSelectedTaskWatch(delayMs = SELECTED_TASK_WATCH_INTERVAL_MS) {
  if (selectedTaskWatchTimer || stopping) return;
  selectedTaskWatchTimer = setTimeout(() => {
    selectedTaskWatchTimer = null;
    void watchSelectedTask();
  }, delayMs);
}

async function watchSelectedTask() {
  if (selectedTaskWatchInFlight || stopping) return;
  selectedTaskWatchInFlight = true;
  try {
    void auditRecentCodexTerminalTurns();
    const task = selectedTask();
    if (!chatId || !task.threadId) return;
    const existingRun = taskRuns.forTask(task);
    if (existingRun) return;
    const snapshot = task.provider === "codex"
      ? await readCodexTaskSnapshot({ ...task, turnId: null, observer: true })
      : await readClaudeTaskSnapshot(task.threadId);
    // Пока читался внешний snapshot, пользователь мог выбрать другую задачу или
    // Telegram мог уже запустить управляемый ход. Нельзя применять устаревший
    // результат ни к новой выбранной задаче, ни поверх начатого запуска.
    const currentTask = selectedTask();
    const currentRun = taskRuns.forTask(task);
    if (currentRun) return;
    if (dismissedExternalTasks.has(task) && !snapshot?.active) {
      dismissedExternalTasks.delete(task);
      await saveState();
    }
    if (snapshot?.completed && snapshot.turnId) {
      const key = taskRunKey(task);
      const previousTurnId = lastSeenTaskTurnIds.get(key);
      const turnChanged = previousTurnId !== snapshot.turnId;
      if (turnChanged) setBoundedMapValue(lastSeenTaskTurnIds, key, snapshot.turnId, 500);
      const answer = String(snapshot.answer ?? "").trim();
      if (turnChanged && answer) {
        const completedRun = {
          ...task,
          chatId,
          taskTitle: activeThreadTitle,
          turnId: snapshot.turnId,
        };
        rememberLastTaskMessage(completedRun, answer);
      }
      if (turnChanged) await saveState();
    }
    if (!shouldAutoObserveTask({
      task,
      selectedTask: currentTask,
      snapshot,
      existingRun: currentRun,
      dismissed: dismissedExternalTasks.has(task),
    })) return;
    const run = await observedRun({
      ...task,
      chatId,
      taskTitle: activeThreadTitle,
    }, chatId, snapshot, task.provider === "codex" ? snapshot.turnId : null);
    scheduleObservedRun(run);
    await saveState();
    console.log(`Silently observing external ${task.provider} task ${task.threadId}`);
  } catch (error) {
    console.error("Cannot watch selected external task:", error.message);
  } finally {
    selectedTaskWatchInFlight = false;
    scheduleSelectedTaskWatch();
  }
}

const taskViewController = new TaskViewController({
  ensureCodex: async () => {
    if (codexTransport.running) return;
    await startCodexAppServer();
    await initializeCodex({ attachSelectedThread: false });
  },
  readCodexThread,
  readCodexSnapshot: readCodexTaskSnapshot,
  readClaudeSnapshot: readClaudeTaskSnapshot,
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
  startProgressMessage,
  createObservedRun: observedRun,
  scheduleObservedRun,
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

async function recoverTaskRun(run) {
  let observerSnapshot = null;
  if (run.observer) {
    run.displayRequested = run.displayRequested === true;
    observerSnapshot = run.provider === "codex" && codexTransport.running
      ? await readCodexTaskSnapshot(run)
      : run.provider === "claude"
        ? await readClaudeTaskSnapshot(run.threadId)
        : null;
    const observerAction = resolveTaskRecoveryAction({ run, observerSnapshot });
    if (observerAction === TASK_RECOVERY_ACTIONS.OBSERVE) {
      updateObservedRun(run, observerSnapshot);
      if (run.displayRequested === true) {
        await replaceRunProgressMessage(run);
      } else {
        await clearRunProgressMessages(run);
      }
      scheduleObservedRun(run);
      if (run.displayRequested === true) startTyping();
      await saveState();
      return;
    }
    if (observerAction === TASK_RECOVERY_ACTIONS.FINISH_OBSERVED) {
      await finishObservedRun(run, observerSnapshot);
      return;
    }
    if (observerAction === TASK_RECOVERY_ACTIONS.UNKNOWN_OBSERVED) {
      await finishUnknownObservedClaudeRun(run, observerSnapshot);
      return;
    }
  }
  const initialAction = resolveTaskRecoveryAction({
    run,
    observerSnapshot,
    codexAvailable: codexTransport.running,
  });
  if (initialAction === TASK_RECOVERY_ACTIONS.ATTACH_CLAUDE) {
    await attachClaudeRunAfterRestart(run);
    return;
  }
  if (initialAction === TASK_RECOVERY_ACTIONS.INTERRUPTED_LOCAL) {
    await finishProgress(run, "Локальный процесс прервался при перезапуске бота.");
    await safelyDeliverRunMessage(
      run,
      () => sendRunMessage(
        run,
        `⚠️ Запуск ${run.provider === "claude" ? "Claude" : "Codex"} был прерван. `
          + `Контекст ${run.threadId ?? "не успел получить ID"} сохранён и доступен для продолжения.`,
      ),
      "уведомление о прерывании",
    );
    await completeRun(run);
    return;
  }

  const result = await readCodexThread(run.threadId, { fresh: true });
  const turn = result.thread?.turns?.find((item) => item.id === run.turnId)
    ?? result.thread?.turns?.at(-1);
  const recoveryAction = resolveTaskRecoveryAction({
    run,
    codexAvailable: codexTransport.running,
    codexTurn: turn,
    waitingOnApproval: codexThreadWaitingOnApproval(result.thread?.status),
    autoApprove,
    restartRequested: Boolean(restartRequest),
  });
  if (recoveryAction === TASK_RECOVERY_ACTIONS.MISSING_CODEX_TURN) {
    await finishProgress(run, "Не удалось найти сохранённый запуск.");
    await completeRun(run);
    return;
  }
  run.responseText = recoveredCodexAnswer(turn) || run.responseText;
  if (recoveryAction === TASK_RECOVERY_ACTIONS.RETRY_LOST_APPROVAL) {
    const originalPrompt = codexThreadHistory([turn]).at(-1)?.prompt
      || run.promptPreview
      || "текущую задачу";
    run.responseText = "";
    run.progressReasoning = "";
    setProgressStage(run, "Восстанавливаю ход после потерянного запроса подтверждения…");
    await launchTurn(
      run,
      "Продолжи текущую задачу с места остановки. Предыдущий ход завис на запросе подтверждения, "
        + "который был потерян при переподключении App Server. Проверь уже выполненные действия и файлы, "
        + `не повторяй завершённую работу. Исходный запрос:\n\n${originalPrompt}`,
    );
    return;
  }
  if (recoveryAction === TASK_RECOVERY_ACTIONS.ATTACH_CODEX) {
    const previousTurnId = run.turnId;
    run.turnId = turn.id;
    taskRuns.reindex(run, { turnId: previousTurnId });
    if (!turnTokenUsage.has(run.turnId)) {
      setBoundedMapValue(turnTokenUsage, run.turnId, { usage: emptyTokenUsage(), reported: false }, 200);
    }
    setProgressStage(run, "Подключено к продолжающейся задаче.");
    scheduleObservedRun(run);
    startTyping();
    await saveState();
    return;
  }

  if (recoveryAction === TASK_RECOVERY_ACTIONS.DISMISS_RESTART_INTERRUPTION) {
    while (run.progressUpdateInFlight) await delay(50);
    for (const messageId of run.progressMessageIds) {
      await telegram("deleteMessage", {
        chat_id: run.chatId,
        message_id: messageId,
      }).catch(() => {});
    }
    run.progressMessageIds = [];
    run.progressReasoning = "";
    run.lastProgressText = "";
    await completeRun(run);
    return;
  }

  const answer = recoveredCodexAnswer(turn)
    || run.responseText.trim()
    || turn.error?.message
    || `Сохранённый запуск завершён со статусом ${turn.status}.`;
  const tracker = consumeTurnTokenTracker(run.turnId);
  const recoveredAsCompleted = turn.status === "completed" || codexTurnHasExplicitFinalAnswer(turn);
  await finishProgress(run, recoveredAsCompleted ? "Задача завершена." : `Задача остановлена: ${turn.status}.`);
  await finalizeCodexRunDelivery(run, {
    answer,
    turnId: run.turnId,
    status: turn.status ?? "completed",
    tracker,
    description: "восстановленный ответ",
  });
}

async function recoverActiveRuns({ provider = null } = {}) {
  const runs = taskRuns.values().filter((run) => !provider || run.provider === provider);
  if (runs.some((run) => run.provider === "codex") && !codexTransport.running) {
    await startCodexAppServer();
    await initializeCodex({ attachSelectedThread: isCodex() });
  }
  for (const run of runs) {
    try {
      await recoverTaskRun(run);
    } catch (error) {
      console.error(`Cannot recover task ${run.id}:`, error.message);
      await sendRunMessage(run, `⚠️ Не удалось восстановить задачу: ${error.message}`).catch(() => {});
      await completeRun(run);
    }
  }
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

async function readClaudeRateLimits() {
  const invocation = resolveClaudeInvocation();
  const result = await spawnCapture(invocation.command, [
    ...invocation.prefixArgs,
    "--print", "--output-format", "text", "--permission-mode", "dontAsk", "/usage",
  ], { timeoutMs: 5_000, maxOutputBytes: 64 * 1024 });
  if (result.error) throw result.error;
  if (result.code !== 0) throw new Error(result.stderr.trim() || `Claude Code завершился с кодом ${result.code}`);
  return result.stdout;
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
  return taskRuns.values().filter((run) => !run.observer && run.provider === "codex");
}

function restartHasBlockingWork() {
  return restartBlockingRuns().length > 0
    || backgroundMediaJobs.size > 0
    || backgroundSpeechJobs.size > 0;
}

function handleBackgroundJobQueueChange({ size }) {
  if (size === 0 && restartRequest?.waitingForRuns && !restartHasBlockingWork() && !stopping) {
    setTimeout(() => void performRestart(), 0);
  }
}

function backgroundJobQueue(kind) {
  return kind === "speech" ? backgroundSpeechJobs : backgroundMediaJobs;
}

function persistedBackgroundJobCount(kind) {
  if (kind === "speech") return backgroundJobStore.count("speech");
  return backgroundJobStore.count("image") + backgroundJobStore.count("voice");
}

async function executeBackgroundJob(item) {
  if (item.kind === "image") {
    await mediaController.analyzeImage(item.payload.message, item.payload.target);
    return;
  }
  if (item.kind === "voice") {
    await mediaController.transcribeVoice(item.payload.message, item.payload.target);
    return;
  }
  if (item.kind === "speech") {
    await mediaController.processSpeechRequest(item.payload.chatId, item.payload.text);
    return;
  }
  throw new Error(`unsupported background job kind: ${item.kind}`);
}

function scheduleBackgroundJob(item) {
  if (scheduledBackgroundJobIds.has(item.id)) return true;
  const queue = backgroundJobQueue(item.kind);
  try {
    const job = queue.enqueue(async () => {
      try {
        if (stopping) return;
        await executeBackgroundJob(item);
      } finally {
        // A service stop may tear down App Server/TTS while the work is still
        // running. Keep the durable record in that case so the next process can
        // retry it instead of treating an interrupted attempt as completed.
        if (!stopping) await backgroundJobStore.remove(item.id);
        scheduledBackgroundJobIds.delete(item.id);
      }
    });
    scheduledBackgroundJobIds.add(item.id);
    void job.catch((error) => {
      console.error(`Background ${item.kind} processing failed:`, error.message);
    });
    return true;
  } catch (error) {
    if (error?.code !== "QUEUE_FULL") throw error;
    return false;
  }
}

async function enqueueBackgroundJob(kind, payload, targetChatId, { dedupeKey = null } = {}) {
  await backgroundJobStore.load();
  const replayed = backgroundJobStore.findByDedupeKey(dedupeKey);
  if (replayed) {
    scheduleBackgroundJob(replayed);
    return replayed;
  }
  const limit = kind === "speech" ? MAX_BACKGROUND_SPEECH_JOBS : MAX_BACKGROUND_MEDIA_JOBS;
  if (persistedBackgroundJobCount(kind) >= limit) {
    if (kind !== "speech") {
      await sendMessageTo(
        targetChatId,
        `Очередь медиа переполнена (${MAX_BACKGROUND_MEDIA_JOBS}). Отправьте файл позже.`,
      );
    }
    return null;
  }
  const item = await backgroundJobStore.enqueue({ kind, payload, dedupeKey });
  if (!scheduleBackgroundJob(item)) {
    console.warn(`Persistent background job ${item.id} is waiting for a free ${kind} queue slot.`);
  }
  return item;
}

async function restoreBackgroundJobs() {
  const count = await backgroundJobStore.load();
  if (!count) return;
  let scheduled = 0;
  for (const item of backgroundJobStore.values()) {
    if (scheduleBackgroundJob(item)) scheduled += 1;
  }
  console.log(`Restored ${scheduled}/${count} persistent background job(s).`);
}

async function updateRestartMessage(text, extra = {}) {
  if (!restartRequest) return;
  await telegram("editMessageText", {
    chat_id: restartRequest.chatId,
    message_id: restartRequest.messageId,
    text,
    ...extra,
  });
}

async function finalizeRestartMessage() {
  if (!restartRequest) return false;
  const request = restartRequest;
  const text = formatRestartCompleteMessage({
    provider: providerTitle(),
    task: activeThreadTitle || (threadId ? `${providerTitle()} · ${threadId.slice(0, 8)}` : "Не выбрана"),
    runningTasks: taskRuns.size,
  });
  try {
    await updateRestartMessage(text, { parse_mode: "HTML" });
  } catch (error) {
    console.error("Cannot update restart message:", error.message);
    await sendMessageTo(request.chatId, text, {
      parse_mode: "HTML",
      reply_markup: BOT_MENU,
    });
  }
  restartRequest = null;
  await saveState();
  return true;
}

async function performRestart() {
  if (stopping || !restartRequest) return;
  if (updateOffset < Number(restartRequest.minimumUpdateOffset ?? 0)) return;
  if (restartHasBlockingWork()) {
    restartRequest.waitingForRuns = true;
    return;
  }
  restartRequest.waitingForRuns = false;
  await updateRestartMessage("🔄 Перезапускаю Agent Hub…").catch(() => {});
  await saveState();
  await Promise.allSettled([
    stateWriteQueue,
    bindingWriteQueue,
    mediaController.waitForWrites(),
    taskSyncStore.save(),
    deliveryOutbox.waitForWrites(),
    backgroundJobStore.waitForWrites(),
    failedUpdateStore.waitForWrites(),
  ]);
  stopping = true;
  stopRuntimeTimers();
  await stopCodexAppServerTree();
  mediaController.stop();
  await miniAppPublisher?.close();
  await quickTunnelController?.close();
  await publicMiniAppServer?.close();
  await miniAppServer?.close();
  await desktopControlServer?.close();
  await runtimeCommandServer.close();
  await instanceGuard.release();
  const invocation = botReplacementInvocation({
    botFile: path.join(import.meta.dirname, "agent-hub-server.mjs"),
    agentHubRoot: AGENT_HUB_ROOT,
  });
  const launcher = String(
    process.env.AGENT_HUB_LAUNCHER ?? process.env.TELEGRAM_INTEGRATION_LAUNCHER ?? "",
  ).trim();
  const fallbackInvocation = process.platform === "win32" && launcher
    ? directWindowsLauncherInvocation({ launcher })
    : null;
  try {
    const replacement = await launchReplacementAndWait({
      invocation,
      fallbackInvocation,
      lockFile: INSTANCE_LOCK_FILE,
    });
    console.log(
      `Replacement bot ready: PID ${replacement.lock.pid}; attempt ${replacement.attempt}`
        + `${replacement.usedFallback ? " (direct launcher fallback)" : ""}.`,
    );
  } catch (error) {
    console.error("Cannot start replacement bot:", error.message);
    try {
      await restorePreviousBotAfterFailedReplacement({
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
        recoverRuns: recoverActiveRuns,
        updateMessage: (message) => updateRestartMessage(message).catch(() => {}),
        clearRestartRequest: () => { restartRequest = null; },
        saveState,
        startTimers: startRuntimeTimers,
        markReady: () => instanceGuard.markReady(),
      });
      return;
    } catch (restoreError) {
      console.error("Cannot restore the previous bot after failed replacement:", restoreError.message);
      process.exitCode = 1;
    }
  }
  // Процессы Claude намеренно переживают перезапуск: новый бот подхватит их
  // по сохранённому PID и файлу вывода.
  setTimeout(() => process.exit(0), 500).unref();
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
    + backgroundMediaJobs.size
    + backgroundSpeechJobs.size;
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

async function selectCatalogTask(callback, entry) {
  const targetChatId = callback.message.chat.id;
  const alreadySelected = catalogEntryIsSelected(entry, selectedTask());
  await telegram("answerCallbackQuery", {
    callback_query_id: callback.id,
    text: alreadySelected ? "Эта задача уже выбрана" : "Переключаю задачу…",
  });
  if (!alreadySelected) {
    await activateMessageBinding({
      provider: entry.provider,
      projectRoot: entry.projectRoot,
      threadId: entry.threadId,
      taskTitle: entry.title,
    });
  }
  await Promise.all([
    alreadySelected
      ? sendTaskAlreadySelectedNotification({ targetChatId })
      : sendTaskSwitchNotification({ targetChatId }),
    dismissCallbackMenu(callback.message),
  ]);
}

async function dispatchTelegramCallback(callback, route) {
  if (route.kind === "pending-input") {
    const { action, id } = route;
    const item = pendingInputs.get(id);
    if (!item) {
      await telegram("answerCallbackQuery", {
        callback_query_id: callback.id,
        text: "Сохранённое сообщение уже обработано",
        show_alert: true,
      });
      return;
    }
    const binding = {
      provider: item.provider,
      projectRoot: item.projectRoot,
      threadId: item.threadId,
      taskTitle: item.taskTitle,
    };
    await telegram("answerCallbackQuery", {
      callback_query_id: callback.id,
      text: action === "new" ? "Создаю новую задачу…"
        : action === "queue" ? "Ставлю сообщение в очередь…"
          : action === "force" ? "Запускаю после явного подтверждения…"
          : action === "show" ? "Показываю текущий ход…"
            : "Сообщение отменено",
    });
    try {
      if (action === "cancel") {
        pendingInputs.delete(id);
        await cleanupDeferredFiles(item);
        await saveState();
        await updateDeferredMessage(item, "❌ Сохранённое сообщение отменено.");
        return;
      }
      if (action === "show") {
        const activated = await activateMessageBinding(binding);
        if (activated.changed) {
          await sendTaskSwitchNotification({
            targetChatId: item.chatId,
            showLastMessage: false,
          });
        }
        await showTaskMessage(binding, item.chatId);
        return;
      }
      if (action === "queue") {
        pendingInputs.delete(id);
        queuedInputs.set(id, item);
        await saveState();
        await updateDeferredMessage(
          item,
          `⏳ Сообщение поставлено в очередь задачи «${item.taskTitle}» и будет отправлено после завершения текущего хода.`,
        );
        scheduleQueuedInput(item, 500);
        return;
      }

      if (action === "force") {
        if (item.allowForce !== true) throw new Error("принудительный запуск для этого сообщения не разрешён");
        await activateMessageBinding(binding);
        const outcome = await startTurn(item.input, item.temporaryFiles ?? [], {
          forceSpeechButton: item.forceSpeechButton === true,
          target: {
            ...binding,
            chatId: item.chatId,
            modelId: item.modelId,
            reasoningId: item.reasoningId,
            collaborationMode: item.collaborationMode,
          },
          allowRepositoryConflict: item.conflictKind === "repository",
          allowUnknownExternalActivity: item.conflictKind === "activity-unknown",
        });
        if (outcome?.deferred) throw new Error("условие безопасного запуска всё ещё не выполнено");
        pendingInputs.delete(id);
        await saveState();
        await updateDeferredMessage(item, `⚠️ Сообщение отправлено в задачу «${item.taskTitle}» после явного подтверждения.`);
        return;
      }

      await activateMessageBinding(binding);
      await createThread();
      const newTaskTitle = activeThreadTitle;
      const outcome = await startTurn(item.input, item.temporaryFiles ?? [], {
        forceSpeechButton: item.forceSpeechButton === true,
      });
      if (outcome?.deferred) throw new Error("новая задача неожиданно оказалась занята");
      pendingInputs.delete(id);
      await saveState();
      await updateDeferredMessage(item, `🆕 Сообщение отправлено в новую задачу «${newTaskTitle}».`);
      await sendTaskSwitchNotification({ targetChatId: item.chatId });
    } catch (error) {
      console.error(`Cannot process pending input ${id}:`, error.message);
      await sendMessageTo(item.chatId, `Не удалось обработать сохранённое сообщение: ${error.message}`);
    }
    return;
  }

  if (route.kind === "speech") {
    const text = mediaController.speechText(route.id);
    if (!text) {
      await telegram("answerCallbackQuery", {
        callback_query_id: callback.id,
        text: "Текст ответа уже недоступен",
        show_alert: true,
      });
      return;
    }
    const speechJob = await enqueueBackgroundJob("speech", {
      chatId: callback.message.chat.id,
      text,
    }, callback.message.chat.id, { dedupeKey: `callback:${callback.id}:speech` });
    if (!speechJob) {
      await telegram("answerCallbackQuery", {
        callback_query_id: callback.id,
        text: `Очередь озвучивания заполнена (${MAX_BACKGROUND_SPEECH_JOBS})`,
        show_alert: true,
      });
      return;
    }
    await telegram("answerCallbackQuery", {
      callback_query_id: callback.id,
      text: backgroundSpeechJobs.pending
        ? `Озвучивание поставлено в очередь: ${backgroundSpeechJobs.pending}`
        : "Готовлю голосовое сообщение…",
    });
    return;
  }
  const taskViewAction = route.taskView;
  const historyMatch = route.legacyHistory;
  if (route.kind === "task-diff") {
    const targetChatId = callback.message?.chat?.id;
    const sourceMessageId = callback.message?.message_id;
    const binding = await resolveTaskViewBinding(taskViewAction, targetChatId, sourceMessageId);
    if (!binding) {
      await telegram("answerCallbackQuery", {
        callback_query_id: callback.id,
        text: "Изменения этой задачи уже недоступны",
        show_alert: true,
      });
      return;
    }
    await telegram("answerCallbackQuery", {
      callback_query_id: callback.id,
      text: "Загружаю изменения…",
    });
    scheduleInteractiveJob("Изменения", targetChatId, async () => {
      const run = taskRuns.forTask(binding);
      const diff = run
        ? await refreshTaskDiff(run)
        : taskDiffs.get(taskRunKey(binding)) ?? "";
      await sendLongMessage(
        diff || "В этой задаче изменений файлов нет.",
        { maxParts: 8, targetChatId },
      );
    });
    return;
  }
  if (route.kind === "task-history") {
    const targetChatId = callback.message?.chat?.id;
    const sourceMessageId = callback.message?.message_id;
    const binding = await resolveTaskViewBinding(taskViewAction, targetChatId, sourceMessageId);
    if (!binding) {
      await telegram("answerCallbackQuery", {
        callback_query_id: callback.id,
        text: "История этой задачи уже недоступна",
        show_alert: true,
      });
      return;
    }
    await telegram("answerCallbackQuery", {
      callback_query_id: callback.id,
      text: "Загружаю предыдущие сообщения…",
    });
    const completedOnly = taskViewAction
      ? taskViewAction.action === "history-last"
      : historyMatch.scope === "l";
    const count = taskViewAction?.count
      ?? Math.max(1, Math.min(Number(historyMatch.count) || 1, 50));
    try {
      await activateMessageBinding(binding);
      if (completedOnly) {
        await showLastTaskMessage(binding, targetChatId, { count });
      } else {
        await showTaskMessage(binding, targetChatId, { count });
      }
    } catch (error) {
      console.error("Cannot load task history:", error.message);
      await sendMessageTo(targetChatId, `Не удалось загрузить историю задачи: ${error.message}`);
    }
    return;
  }
  if (route.kind === "task-view") {
    const targetChatId = callback.message?.chat?.id;
    const sourceMessageId = callback.message?.message_id;
    const binding = await resolveTaskViewBinding(taskViewAction, targetChatId, sourceMessageId);
    if (!binding) {
      await telegram("answerCallbackQuery", {
        callback_query_id: callback.id,
        text: "Привязка задачи уже недоступна",
        show_alert: true,
      });
      return;
    }
    await telegram("answerCallbackQuery", {
      callback_query_id: callback.id,
      text: "Открываю задачу…",
    });
    try {
      const activated = await activateMessageBinding(binding);
      if (activated.changed) {
        await sendTaskSwitchNotification({
          targetChatId,
          showLastMessage: false,
        });
      }
      await showTaskMessage(binding, targetChatId);
    } catch (error) {
      console.error("Cannot show bound task message:", error.message);
      await sendMessageTo(targetChatId, `Не удалось показать сообщение задачи: ${error.message}`);
    }
    return;
  }
  if (route.kind === "approval-mode") {
    autoApprove = route.mode === "auto";
    await telegram("answerCallbackQuery", {
      callback_query_id: callback.id,
      text: autoApprove ? "Автоподтверждение включено" : "Ручной режим включён",
    });
    await telegram("editMessageText", {
      chat_id: callback.message.chat.id,
      message_id: callback.message.message_id,
      text: formatApprovalMode(),
      reply_markup: approvalModeKeyboard(),
    });
    return;
  }
  if (route.kind === "project") {
    try {
      const switched = await switchProject(route.index);
      await telegram("answerCallbackQuery", {
        callback_query_id: callback.id,
        text: switched.changed ? "Папка изменена" : "Эта папка уже активна",
      });
      await telegram("editMessageReplyMarkup", {
        chat_id: callback.message.chat.id,
        message_id: callback.message.message_id,
        reply_markup: { inline_keyboard: [] },
      });
      if (switched.changed) {
        await sendMessage(
          `Активная папка: ${switched.project.name}\n${switched.project.path}\nСоздан новый контекст ${providerTitle()}.`,
        );
      }
    } catch (error) {
      await telegram("answerCallbackQuery", {
        callback_query_id: callback.id,
        text: "Не удалось сменить проект",
        show_alert: true,
      });
      await sendMessage(`Ошибка смены папки: ${error.message}`);
    }
    return;
  }
  if (route.kind === "engine") {
    try {
      const switched = await switchProvider(route.provider);
      await telegram("answerCallbackQuery", {
        callback_query_id: callback.id,
        text: switched.changed ? "Агент переключён" : "Этот агент уже активен",
      });
      await telegram("editMessageReplyMarkup", {
        chat_id: callback.message.chat.id,
        message_id: callback.message.message_id,
        reply_markup: { inline_keyboard: [] },
      });
      if (switched.changed) {
        await sendMessage(`Активный агент: ${providerTitle()}\nПроект: ${activeProject().name}`);
      }
    } catch (error) {
      await telegram("answerCallbackQuery", {
        callback_query_id: callback.id,
        text: "Не удалось переключить агента",
        show_alert: true,
      });
      await sendMessage(`Ошибка переключения агента: ${error.message}`);
    }
    return;
  }
  if (route.kind === "codex-model") {
    try {
      const switched = switchCodexModel(route.model);
      await updateActiveCodexThreadSettings();
      await telegram("answerCallbackQuery", {
        callback_query_id: callback.id,
        text: switched.changed ? "Codex model changed" : "This Codex model is already selected",
      });
      await telegram("editMessageReplyMarkup", {
        chat_id: callback.message.chat.id,
        message_id: callback.message.message_id,
        reply_markup: { inline_keyboard: [] },
      });
      if (switched.changed) {
        await sendMessage(`Codex model: ${codexModelLabel(codexModel)}`);
      }
    } catch (error) {
      await telegram("answerCallbackQuery", {
        callback_query_id: callback.id,
        text: "Cannot change Codex model",
        show_alert: true,
      });
      await sendMessage(`Codex model switch error: ${error.message}`);
    }
    return;
  }
  if (route.kind === "codex-reasoning") {
    const value = route.value;
    const changed = value !== codexReasoningEffort;
    codexReasoningEffort = value;
    try {
      await updateActiveCodexThreadSettings();
    } catch (error) {
      await telegram("answerCallbackQuery", {
        callback_query_id: callback.id,
        text: "Не удалось изменить Reasoning",
        show_alert: true,
      });
      await sendMessage(`Ошибка смены Reasoning Codex: ${error.message}`);
      return;
    }
    await telegram("answerCallbackQuery", {
      callback_query_id: callback.id,
      text: changed ? "Reasoning изменён" : "Этот уровень уже выбран",
    });
    await telegram("editMessageReplyMarkup", {
      chat_id: callback.message.chat.id,
      message_id: callback.message.message_id,
      reply_markup: { inline_keyboard: [] },
    });
    if (changed) await sendMessage(`Reasoning Codex: ${CODEX_REASONING_LABELS[codexReasoningEffort]}`);
    return;
  }
  if (route.kind === "codex-mode") {
    const value = route.value;
    const changed = value !== codexCollaborationMode;
    codexCollaborationMode = value;
    await saveState();
    await telegram("answerCallbackQuery", {
      callback_query_id: callback.id,
      text: changed ? "Режим Codex изменён" : "Этот режим уже выбран",
    });
    await telegram("editMessageReplyMarkup", {
      chat_id: callback.message.chat.id,
      message_id: callback.message.message_id,
      reply_markup: { inline_keyboard: [] },
    });
    if (changed) await sendMessage(`Режим Codex: ${CODEX_COLLABORATION_MODE_LABELS[codexCollaborationMode]}`);
    return;
  }
  if (route.kind === "claude-reasoning") {
    const value = route.value;
    const changed = value !== claudeReasoningEffort;
    claudeReasoningEffort = value;
    await saveState();
    await telegram("answerCallbackQuery", {
      callback_query_id: callback.id,
      text: changed ? "Reasoning изменён" : "Этот уровень уже выбран",
    });
    await telegram("editMessageReplyMarkup", {
      chat_id: callback.message.chat.id,
      message_id: callback.message.message_id,
      reply_markup: { inline_keyboard: [] },
    });
    if (changed) await sendMessage(`Reasoning Claude Code: ${CODEX_REASONING_LABELS[claudeReasoningEffort]}`);
    return;
  }
  if (route.kind === "claude-mode") {
    const value = route.value;
    const changed = value !== claudeCollaborationMode;
    claudeCollaborationMode = value;
    await saveState();
    await telegram("answerCallbackQuery", {
      callback_query_id: callback.id,
      text: changed ? "Режим Claude изменён" : "Этот режим уже выбран",
    });
    await telegram("editMessageReplyMarkup", {
      chat_id: callback.message.chat.id,
      message_id: callback.message.message_id,
      reply_markup: { inline_keyboard: [] },
    });
    if (changed) await sendMessage(`Режим Claude Code: ${CODEX_COLLABORATION_MODE_LABELS[claudeCollaborationMode]}`);
    return;
  }
  if (route.kind === "claude-model") {
    try {
      const switched = switchModel(route.model);
      await saveState();
      await telegram("answerCallbackQuery", {
        callback_query_id: callback.id,
        text: switched.changed ? "Модель изменена" : "Эта модель уже выбрана",
      });
      await telegram("editMessageReplyMarkup", {
        chat_id: callback.message.chat.id,
        message_id: callback.message.message_id,
        reply_markup: { inline_keyboard: [] },
      });
      if (switched.changed) {
        await sendMessage(`Модель Claude Code: ${CLAUDE_MODEL_LABELS[claudeModel]}`);
      }
    } catch (error) {
      await telegram("answerCallbackQuery", {
        callback_query_id: callback.id,
        text: "Не удалось сменить модель",
        show_alert: true,
      });
      await sendMessage(`Ошибка смены модели: ${error.message}`);
    }
    return;
  }
  if (route.kind === "task-page") {
    await telegram("answerCallbackQuery", { callback_query_id: callback.id });
    scheduleInteractiveJob("Страница списка задач", callback.message.chat.id, () => sendThreadPicker({
        editMessage: callback.message,
        page: route.page,
      }));
    return;
  }
  if (route.kind === "catalog-task") {
    const catalogSelection = route.catalogTask;
    let entry = taskCatalog.find((item) => (
      item.provider === catalogSelection.provider && item.threadId === catalogSelection.threadId
    ));
    if (!entry) {
      entry = (await refreshTaskCatalog()).find((item) => (
        item.provider === catalogSelection.provider && item.threadId === catalogSelection.threadId
      ));
    }
    if (!entry) {
      await telegram("answerCallbackQuery", {
        callback_query_id: callback.id,
        text: "Задача больше не найдена",
        show_alert: true,
      });
      return;
    }
    try {
      await selectCatalogTask(callback, entry);
    } catch (error) {
      await sendMessageTo(callback.message.chat.id, `Ошибка выбора задачи: ${error.message}`);
    }
    return;
  }
  if (route.kind === "thread-new") {
    try {
      await createThread();
      await telegram("answerCallbackQuery", {
        callback_query_id: callback.id,
        text: "Новая задача создана",
      });
      await telegram("editMessageReplyMarkup", {
        chat_id: callback.message.chat.id,
        message_id: callback.message.message_id,
        reply_markup: { inline_keyboard: [] },
      });
      await sendMessage(`Создана новая задача ${providerTitle()} в текущем проекте.`);
    } catch (error) {
      await telegram("answerCallbackQuery", {
        callback_query_id: callback.id,
        text: "Не удалось создать задачу",
        show_alert: true,
      });
      console.error("Cannot create thread:", error.message);
    }
    return;
  }
  if (route.kind === "thread-archive") {
    const blockedReason = archiveBlockedReason();
    if (blockedReason) {
      const messages = {
        "active-turn": "Сначала завершите или отмените текущую задачу",
        unsupported: "Архивация доступна только для задач Codex",
        "no-current": "Текущая задача не выбрана",
      };
      await telegram("answerCallbackQuery", {
        callback_query_id: callback.id,
        text: messages[blockedReason] ?? "Архивация недоступна",
        show_alert: true,
      });
      return;
    }
    await telegram("answerCallbackQuery", {
      callback_query_id: callback.id,
      text: "Архивирую задачу…",
    });
    try {
      const result = await archiveCurrentThread();
      if (!result.archived) {
        await sendMessageTo(callback.message.chat.id, "Архивация задачи стала недоступна. Обновите список задач.");
        return;
      }
      const outcomes = await Promise.allSettled([
        sendArchiveMessage(result, callback.message.chat.id),
        sendThreadPicker({ editMessage: callback.message }),
      ]);
      const failures = outcomes.filter((outcome) => outcome.status === "rejected");
      if (failures.length) {
        throw new AggregateError(failures.map((failure) => failure.reason), "Не удалось полностью обновить меню архивации");
      }
    } catch (error) {
      console.error("Cannot archive thread:", error.message);
      await sendMessageTo(callback.message.chat.id, `Ошибка архивации задачи: ${error.message}`);
    }
    return;
  }
  if (route.kind !== "approval" || !await approvalController.handleCallback(callback)) {
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

async function handleTelegramCommand(message, text) {
  if (text === "/menu" || text === "/keyboard") {
    await sendMessage("⌨️ Панель кнопок показана.", { reply_markup: BOT_MENU });
  } else if (text === "/start" || text === "/help") {
    await sendMessage(
      `Бот подключён к Claude Code и Codex. Текущий агент: ${providerTitle()}. Отправьте текст, изображение или голосовое сообщение.\n\n` +
        "/menu — показать панель кнопок\n/agent — переключить Claude Code/Codex\n/model — сменить модель\n/reasoning — мощь дум Codex/Claude\n/mode — режим Plan/Work Codex/Claude\n/projects — сменить активный проект\n/new — новый контекст\n/tasks — список задач и создание новой\n/resume — выбрать задачу\n/rename — закрепить название текущей задачи\n/archive — архивировать текущую задачу\n/status — статус, текущая задача и лимиты\n/approvals — режим подтверждений\n/restart — перезапустить бота\n/diff — последний diff\n/cancel — остановить задачу",
      { reply_markup: BOT_MENU },
    );
  } else if (text === "/agent" || text === "/engine") {
    await sendAgentPicker();
  } else if (text === "/model") {
    await sendModelPicker();
  } else if (text === "/reasoning") {
    await sendReasoningPicker();
  } else if (text === "/mode") {
    await sendCollaborationModePicker();
  } else if (text === "/projects" || text === "/folders" || text === "/folder") {
    await sendProjectPicker();
  } else if (text === "/new") {
    await createThread();
    await sendMessage(`Создан новый контекст ${providerTitle()}.`);
  } else if (text === "/status") {
    const snapshot = currentStatusSnapshot(message.chat.id);
    scheduleInteractiveJob("Статус", message.chat.id, () => sendStatus(snapshot));
  } else if (text === "/approvals") {
    await sendMessage(formatApprovalMode(), { reply_markup: approvalModeKeyboard() });
  } else if (text === "/restart") {
    await restartBot();
  } else if (text === "/tasks" || text === "/resume") {
    scheduleInteractiveJob("Список задач", message.chat.id, () => sendThreadPicker());
  } else if (text.startsWith("/resume ")) {
    const selectedThreadId = text.slice("/resume ".length).trim();
    if (!/^[0-9a-f-]+$/i.test(selectedThreadId)) {
      return sendMessage("Укажите корректный ID задачи или используйте /resume без параметров.");
    }
    await resumeThread(selectedThreadId);
  } else if (text === "/rename") {
    await sendMessage("Укажите новое постоянное название: /rename Название задачи");
  } else if (text.startsWith("/rename ")) {
    try {
      const title = await renameCurrentTask(text.slice("/rename ".length));
      await sendMessage(`✅ Название закреплено: «${title}». Автозаголовки Codex больше его не изменят.`);
    } catch (error) {
      await sendMessage(`Не удалось переименовать задачу: ${error.message}`);
    }
  } else if (text === "/archive") {
    const result = await archiveCurrentThread();
    if (!result.archived) {
      if (result.reason === "active-turn") return sendMessage("Сначала завершите или отмените текущую задачу.");
      if (result.reason === "unsupported") return sendMessage("Архивация доступна только для задач Codex.");
      return sendMessage("Текущая задача не выбрана.");
    }
    await sendArchiveMessage(result);
    await sendThreadPicker();
  } else if (text === "/current" || text === "/thread") {
    const snapshot = currentStatusSnapshot(message.chat.id);
    scheduleInteractiveJob("Текущая задача", message.chat.id, () => sendStatus(snapshot));
  } else if (text === "/diff") {
    const target = selectedTask();
    const run = taskRuns.forTask(target);
    scheduleInteractiveJob(
      "Изменения",
      message.chat.id,
      async () => {
        const diff = run ? await refreshTaskDiff(run) : taskDiffs.get(taskRunKey(target)) ?? "";
        await sendLongMessage(diff || "В выбранной задаче изменений файлов нет.", { maxParts: 8 });
      },
    );
  } else if (text === "/cancel") {
    const run = selectedRun();
    if (!run) return sendMessage("В выбранной задаче сейчас ничего не выполняется.");
    if (run.observer) {
      let interruptError = null;
      if (run.provider === "codex") {
        try {
          await sendRpc("turn/interrupt", { threadId: run.threadId, turnId: run.turnId });
        } catch (error) {
          interruptError = error;
          console.warn(`Cannot interrupt observed Codex task ${run.threadId}:`, error.message);
        }
      }
      if (run.provider === "codex" && interruptError) {
        setProgressStage(run, `Не удалось остановить внешний ход: ${interruptError.message}`);
        await sendRunMessage(
          run,
          `Codex не подтвердил остановку: ${interruptError.message}. Наблюдение и блокировка сохранены; параллельный ход не будет запущен.`,
        );
        return;
      }
      dismissedExternalTasks.add(run);
      const stopRequested = run.provider === "codex";
      await finishProgress(run, stopRequested
        ? "Остановка запрошена; наблюдение отключено."
        : "Наблюдение отключено; внешний ход продолжает работу.");
      await completeRun(run);
      await sendRunMessage(run, stopRequested
        ? "Запрошена остановка этой задачи. Пока внешний ход фактически активен, новые сообщения будут сохранены, а не запущены параллельно."
        : "Отключил наблюдение. Внешний Claude продолжает работу; новые сообщения будут сохранены до его завершения.");
      return;
    }
    if (run.provider === "codex") {
      await sendRpc("turn/interrupt", { threadId: run.threadId, turnId: run.turnId });
    } else if (run.process || processIsAlive(run.pid)) {
      if (!await stopClaudeRunProcess(run)) {
        await sendRunMessage(run, "Не удалось остановить дерево процессов Claude; задача остаётся активной.");
        return;
      }
      setBoundedMapValue(
        cancelledManagedClaudeTasks,
        taskRunKey(run),
        Date.now(),
        200,
      );
      await saveState();
    } else {
      await finishProgress(run, "Наблюдение отключено; внешний Claude продолжает работу.");
      await completeRun(run);
      await sendRunMessage(run, "Отключил наблюдение. Остановить внешний процесс Claude из этой сессии бот не может.");
      return;
    }
    await sendRunMessage(run, "Запрошена остановка этой задачи.");
  } else if (text.startsWith("/")) {
    await sendMessage("Неизвестная команда. Используйте /help.");
  } else {
    await bindIncomingTaskMessage(message, text);
    await startTurn(telegramPrompt(message, text));
  }
}

const telegramCommandHandlers = Object.fromEntries([
  "menu", "keyboard", "start", "help", "agent", "engine", "model", "reasoning", "mode",
  "projects", "folders", "folder", "new", "status", "approvals", "restart", "tasks", "resume",
  "rename", "archive", "current", "thread", "diff", "cancel",
].map((command) => [command, ({ message, text }) => handleTelegramCommand(message, text)]));

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
  enqueueMedia: enqueueBackgroundJob,
  commandHandlers: telegramCommandHandlers,
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
  const dueAt = Date.now() + delayValue;
  if (deliveryOutboxTimer) {
    if (deliveryOutboxTimerDueAt <= dueAt) return;
    clearTimeout(deliveryOutboxTimer);
    deliveryOutboxTimer = null;
  }
  deliveryOutboxTimerDueAt = dueAt;
  deliveryOutboxTimer = setTimeout(() => {
    deliveryOutboxTimer = null;
    deliveryOutboxTimerDueAt = 0;
    void flushDeliveryOutbox();
  }, delayValue);
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
  threadIdsByProvider[activeProvider] = threadId;
  const content = `${JSON.stringify({
    chatId,
    activeProjectRoot,
    activeThreadTitle,
    activeProvider,
    threadIds: threadIdsByProvider,
    pinnedTaskTitles,
    claudeModel,
    codexModel,
    codexReasoningEffort,
    codexTaskSettings,
    codexCollaborationMode,
    claudeReasoningEffort,
    claudeCollaborationMode,
    updateOffset,
    activeRuns: taskRuns.values().map(serializableTaskRun),
    dismissedExternalTasks: dismissedExternalTasks.values(),
    cancelledManagedClaudeTasks: [...cancelledManagedClaudeTasks.entries()],
    pendingInputs: [...pendingInputs.values()],
    queuedInputs: [...queuedInputs.values()],
    lastTaskMessages: [...lastTaskMessages.entries()].slice(-500),
    lastSeenTaskTurnIds: [...lastSeenTaskTurnIds.entries()].slice(-500),
    threadTokenTotals: [...threadTokenTotals.entries()].slice(-500),
    turnTokenUsage: [...turnTokenUsage.entries()].slice(-200),
    codexTurnStarts: [...codexTurnStarts.entries()].slice(-500),
    codexHookReceipts,
    codexTerminalAudit: codexTerminalAudit.snapshot(),
    turnEndNotifications: turnEndNotifications.snapshot(),
    statusMediaFileIds: [...statusMediaFileIds.entries()].slice(-50),
    restartRequest,
  }, null, 2)}\n`;
  stateWriteQueue = stateWriteQueue
    .catch(() => {})
    .then(async () => {
      await writeTextAtomic(STATE_FILE, content);
      if (Date.now() - lastStateBackupAt >= 30_000) {
        await writeTextAtomic(STATE_BACKUP_FILE, content);
        lastStateBackupAt = Date.now();
      }
    });
  return stateWriteQueue;
}

function savePinnedTaskTitles() {
  return writeTextAtomic(
    PINNED_TASK_TITLES_FILE,
    `${JSON.stringify(pinnedTaskTitles, null, 2)}\n`,
  );
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stopRuntimeTimers() {
  stopTyping();
  if (deliveryOutboxTimer) {
    clearTimeout(deliveryOutboxTimer);
    deliveryOutboxTimer = null;
  }
  deliveryOutboxTimerDueAt = 0;
  if (selectedTaskWatchTimer) {
    clearTimeout(selectedTaskWatchTimer);
    selectedTaskWatchTimer = null;
  }
  if (rateLimitPollTimer) {
    clearTimeout(rateLimitPollTimer);
    rateLimitPollTimer = null;
  }
  deferredInputController.stop();
  for (const run of taskRuns.values()) {
    taskProgress.pause(run);
    taskObserver.pause(run);
    claudeRunController.pause(run);
  }
}

function startRuntimeTimers() {
  if (config.telegramEnabled) {
    for (const item of queuedInputs.values()) scheduleQueuedInput(item, 500);
    scheduleDeliveryOutboxFlush(1_000);
  }
  scheduleSelectedTaskWatch(500);
  scheduleRateLimitPoll(1_000);
}

async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`Stopping on ${signal}...`);
  stopRuntimeTimers();
  await stopCodexAppServerTree();
  // Ходы Claude оставляем работать: следующий запуск бота подключится к ним заново.
  for (const run of taskRuns.values()) {
    if (run.provider === "codex") run.process?.kill();
  }
  mediaController.stop();
  await miniAppPublisher?.close();
  await quickTunnelController?.close();
  await publicMiniAppServer?.close();
  await miniAppServer?.close();
  await desktopControlServer?.close();
  await runtimeCommandServer.close();
  await Promise.allSettled([
    stateWriteQueue,
    mediaController.waitForWrites(),
    bindingWriteQueue,
    taskSyncStore.save(),
    deliveryOutbox.waitForWrites(),
    backgroundJobStore.waitForWrites(),
    failedUpdateStore.waitForWrites(),
  ]);
  await instanceGuard.release();
}

process.on("unhandledRejection", (error) => {
  console.error("Unhandled asynchronous error:", error);
});

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

await initializeProvider();
if (codexTransport.running) {
  await listAllCodexThreads()
    .then((threads) => backfillWorkLogPricingMetadata(threads))
    .catch((error) => console.error("Cannot list Codex threads for credit backfill:", error.message));
}
if (config.telegramEnabled) {
  await recoverActiveRuns().catch(async (error) => {
    console.error("Cannot recover active tasks:", error.message);
    await sendMessage(`⚠️ Не удалось восстановить активные задачи: ${error.message}`).catch(() => {});
  });
  await retryPendingTurnEndNotifications();
  await restoreBackgroundJobs().catch(async (error) => {
    console.error("Cannot recover background jobs:", error.message);
    await sendMessage(`⚠️ Не удалось восстановить фоновые медиа-задачи: ${error.message}`).catch(() => {});
  });
}
desktopControlServer = new DesktopControlServer({
  runtimeRoot: runtimeCommandRoot,
  handler: handleDesktopControl,
  protectSecret: (process.env.AGENT_HUB_DISABLE_SECRET_ACL
    ?? process.env.TELEGRAM_INTEGRATION_DISABLE_SECRET_ACL) === "1"
    ? async () => {}
    : undefined,
});
await desktopControlServer.start();
if (miniAppServer) {
  try {
    const address = await startMiniApp();
    console.log(`Mini App ready at ${address.url}`);
  } catch (error) {
    console.error("Cannot start Mini App:", error.message);
  }
}
startRuntimeTimers();
if (config.telegramEnabled) {
  try {
    await telegram("setMyCommands", {
      commands: BOT_COMMANDS,
    });
  } catch (error) {
    console.error("Cannot register Telegram commands:", error.message);
  }
}
let restartFinalized = false;
if (restartRequest) {
  restartFinalized = await finalizeRestartMessage().catch((error) => {
    console.error("Cannot finalize bot restart:", error.message);
    return false;
  });
}
await instanceGuard.markReady();
console.log(
  `Agent Hub ready; profile: ${config.profile}; provider: ${providerTitle()}; project: ${activeProjectRoot}`,
);
if (config.telegramEnabled) {
  await pollTelegram();
} else {
  await new Promise(() => {});
}
