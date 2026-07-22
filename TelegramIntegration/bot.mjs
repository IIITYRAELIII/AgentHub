import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync } from "node:fs";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import process from "node:process";
import {
  findContainingProject,
  INTEGRATION_ROOT,
  loadConfig,
  pathInsideOrSame,
  samePath,
} from "./config.mjs";
import {
  buildClaudeArgs,
  buildClaudePrompt,
  claudeThinkingTokens,
  formatClaudeUsage,
  parseClaudeResult,
  parseClaudeStreamEvent,
} from "./claude.mjs";
import {
  ClaudeOutputReader,
  cleanupOrphanedClaudeRunOutputs,
  openClaudeRunOutput,
  processIsAlive,
  removeClaudeRunOutput,
  spawnClaudeWorker,
  stopProcessTree,
} from "./claude-run-io.mjs";
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
import { randomStatusHeaderFileName } from "./status-header.mjs";
import { formatTaskTokenUsage } from "./token-usage.mjs";
import { telegramPrompt } from "./telegram-message.mjs";
import {
  captureTaskGitBaseline,
  cleanupTaskGitIndexes,
  resolveTaskGitRepoRoots,
  taskGitDiff,
} from "./task-git-diff.mjs";
import { TaskDiffStore } from "./task-diff-store.mjs";
import { findRepositoryWriteConflict } from "./repository-conflict.mjs";
import { callTelegramJson, telegramBotApiUrl, telegramFileApiUrl } from "./telegram-api.mjs";
import { parsePendingInputCallback, pendingInputKeyboard } from "./deferred-input.mjs";
import {
  appendMessageBindings,
  findMessageBinding,
  readMessageBindings,
  removeMessageBindings,
} from "./message-bindings.mjs";
import {
  readCodexThreadTitleHistories,
  readCodexThreadTitleHistory,
} from "./send-message.mjs";
import {
  formatProgressHeartbeat,
  markProgressHeartbeat,
  PROGRESS_STALLED_AFTER_MS,
  retainProgressMessageAfterEditError,
} from "./progress-heartbeat.mjs";
import {
  serializableTaskRun,
  shouldAutoObserveTask,
  TaskDismissalRegistry,
  TaskRunRegistry,
  taskRunKey,
  updateObservedResponse,
  updateTaskRunTitle,
} from "./task-runs.mjs";
import {
  codexFinalTurnAnswer,
  codexTurnAnswer,
  listClaudeSessionSnapshots,
  readClaudeSessionSnapshot,
} from "./last-message.mjs";
import {
  codexThreadHistory,
  mergeActiveTaskHistory,
  visibleTaskHistory,
} from "./task-history.mjs";
import { startCodexTurnWithRecovery } from "./codex-recovery.mjs";
import {
  approvalCallbackData,
  approvalMatchesTelegramMessage,
  codexApprovalResponse,
  codexThreadWaitingOnApproval,
  createApprovalKey,
  formatMcpElicitation,
  formatPermissionsApproval,
  mcpElicitationAutoResponse,
  parseApprovalCallback,
} from "./codex-approvals.mjs";
import { contextualCallback, resolveContextualCallback } from "./callback-context.mjs";
import { PersistentDeliveryOutbox } from "./delivery-outbox.mjs";
import { installRotatingConsole } from "./rotating-log.mjs";
import { readJsonWithBackup, writeTextAtomic } from "./state-store.mjs";
import { LocalTaskSyncStore } from "./task-sync-store.mjs";
import { shouldLogPollingFailure, telegramPollingRetryDelay } from "./poll-retry.mjs";
import { unavailableLocalMcpOverrides } from "./local-mcp-preflight.mjs";
import { SingleInstanceGuard } from "./instance-lock.mjs";
import { BackgroundJobQueue } from "./background-job-queue.mjs";
import { PersistentBackgroundJobStore } from "./background-job-store.mjs";
import { resolveClaudeInvocation as resolveInstalledClaudeInvocation } from "./claude-invocation.mjs";
import {
  catalogEntryIsSelected,
  claudeCatalogEntry,
  claudeSnapshotActivityAtMs,
  claudeSnapshotActivityState,
  codexCatalogEntry,
  codexObservedExecutionOwner,
  codexThreadRunning,
  mergeTaskCatalog,
  parseTaskCatalogCallback,
  pinnedTaskTitle as readPinnedTaskTitle,
  pinTaskTitle as writePinnedTaskTitle,
  readCodexRolloutActivity,
  runningTaskReplyMarkup,
  selectCodexTurn,
  TASK_EXECUTION_OWNERS,
  taskExecutionRuntimeLabel,
  taskExecutionRuntimeShortLabel,
  taskCatalogCallback,
} from "./task-catalog.mjs";
import { botReplacementInvocation } from "./runtime-restart.mjs";
import { RuntimeCommandServer } from "./runtime-command.mjs";
import { defaultRuntimeRoot } from "./runtime-layout.mjs";
import { runTtsWorkerRequest } from "./tts-worker-client.mjs";
import { parseTaskViewCallbackData, taskViewCallbackData } from "./task-view-callback.mjs";
import { resolveCodexExecutable as resolveInstalledCodexExecutable } from "./codex-invocation.mjs";

const config = await loadConfig();
const defaultDataDirectory = path.join(INTEGRATION_ROOT, "data");
const logDirectory = samePath(config.dataDir, defaultDataDirectory)
  ? INTEGRATION_ROOT
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
const CODEX_TASK_SOURCE_KINDS = ["cli", "vscode", "exec", "appServer", "unknown"];
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
const INSTANCE_LOCK_FILE = path.join(config.dataDir, "bot.lock");
const SPEECH_TEXTS_FILE = path.join(config.dataDir, "speech-texts.json");
const PINNED_TASK_TITLES_FILE = path.join(config.dataDir, "pinned-task-titles.json");
const TASK_SYNC_FILE = path.join(config.dataDir, "task-sync.json");
const TASK_DIFFS_FILE = path.join(config.dataDir, "task-diffs.json");
const TELEGRAM_LIMIT = 3900;
const THREAD_LIST_LIMIT = 10;
const TASK_PICKER_PAGE_SIZE = 8;
const MAX_DEFERRED_INPUTS = 500;
const MAX_BACKGROUND_MEDIA_JOBS = 20;
const MAX_BACKGROUND_SPEECH_JOBS = 10;
const MAX_INTERACTIVE_JOBS = 10;
const PYTHON_EXE = config.pythonExe;
const TTS_PYTHON_EXE = config.ttsPythonExe;
const TRANSCRIBE_SCRIPT = path.join(import.meta.dirname, "transcribe.py");
const TTS_WORKER_SCRIPT = config.ttsWorkerScript;
const WHISPER_MODEL_DIR = config.whisperModelDir;
const TTS_CACHE_DIR = config.ttsCacheDir;
const AUDIO_DIR = config.audioDir;
const IMAGE_DIR = path.join(config.dataDir, "images");
const STATUS_HEADER_DIR = path.join(import.meta.dirname, "assets", "status");
const TTS_DIR = config.ttsDir;
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
const runtimeCommandRoot = process.env.TELEGRAM_INTEGRATION_RUNTIME_ROOT
  ?? (process.env.TELEGRAM_CODEX_CONFIG ? path.dirname(config.configPath) : defaultRuntimeRoot());
const runtimeCommandServer = new RuntimeCommandServer({
  runtimeRoot: runtimeCommandRoot,
  handler: async (request) => {
    const script = request.command === "send-message" ? "send-message.mjs" : "send-images.mjs";
    const result = await spawnCapture(
      process.execPath,
      [path.join(import.meta.dirname, script), ...request.args],
      {
        cwd: request.cwd,
        env: {
          ...process.env,
          ...request.environment,
          TELEGRAM_CODEX_CONFIG: config.configPath,
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
  },
});
await runtimeCommandServer.start();

let updateOffset = 0;
let chatId = null;
let activeProjectRoot = DEFAULT_PROJECT_ROOT;
const threadIdsByProvider = { codex: null, claude: null };
const pinnedTaskTitles = {};
let threadId = null;
let activeThreadTitle = "";
let latestDiff = "";
let requestSequence = 1;
let stopping = false;
let autoApprove = config.autoApproveOnStart;
let codexRestarting = false;
let restartRequest = null;
let processingUpdateId = null;
let stateWriteQueue = Promise.resolve();
let lastStateBackupAt = 0;
let speechWriteQueue = Promise.resolve();
let bindingWriteQueue = Promise.resolve();
let ttsWorker = null;
let typingInterval = null;
let deliveryOutboxTimer = null;
let selectedTaskWatchTimer = null;
let selectedTaskWatchInFlight = false;
const SELECTED_TASK_WATCH_INTERVAL_MS = 2_000;
const EXTERNAL_TASK_POLL_INTERVAL_MS = 1_500;
const MANAGED_TASK_FALLBACK_POLL_INTERVAL_MS = 5_000;
const CLAUDE_OUTPUT_POLL_INTERVAL_MS = 250;
const CODEX_THREAD_READ_CACHE_MS = 250;
const TASK_CATALOG_CACHE_MS = 1_500;
const CODEX_RPC_TIMEOUT_MS = config.codexRpcTimeoutSeconds * 1000;
const pendingRpc = new Map();
const pendingApprovals = new Map();
const threadTokenTotals = new Map();
const turnTokenUsage = new Map();
const turnTemporaryFiles = new Map();
const turnSpeechButtons = new Map();
const speechTexts = new Map();
const taskRuns = new TaskRunRegistry();
const backgroundJobStore = new PersistentBackgroundJobStore({
  directoryPath: BACKGROUND_JOBS_DIR,
  maxItems: MAX_BACKGROUND_MEDIA_JOBS + MAX_BACKGROUND_SPEECH_JOBS,
});
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
const queueTimers = new Map();
const taskDiffs = new TaskDiffStore({ filePath: TASK_DIFFS_FILE, limit: 100 });
await taskDiffs.load();
const lastTaskMessages = new Map();
const lastSeenTaskTurnIds = new Map();
const uiContextNonce = randomUUID();
let taskCatalog = [];
let taskCatalogRefreshedAt = 0;
let taskCatalogRefreshInFlight = null;
const codexThreadReadCache = new Map();
const taskSyncStore = new LocalTaskSyncStore({ filePath: TASK_SYNC_FILE });
await taskSyncStore.load();

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
    try {
      bindingWriteQueue = bindingWriteQueue
        .catch(() => {})
        .then(() => appendMessageBindings(config.dataDir, [{
          ...item.binding,
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
  },
  onPermanentFailure: async (item, error) => {
    console.error(`Dropping permanent Telegram delivery ${item.id}:`, error.message);
  },
});
await deliveryOutbox.load();

try {
  const savedSpeechTexts = JSON.parse(await readFile(SPEECH_TEXTS_FILE, "utf8"));
  if (Array.isArray(savedSpeechTexts)) {
    for (const [id, text] of savedSpeechTexts.slice(-20)) {
      if (/^[0-9a-f]+$/.test(id) && typeof text === "string" && text.trim()) speechTexts.set(id, text);
    }
  }
} catch (error) {
  if (error?.code !== "ENOENT") console.error("Cannot read saved speech texts:", error.message);
}

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
  return {
    ...selectedTask(),
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
  const protectedIds = new Set([...pendingApprovals.values()]
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
  scheduleDeliveryOutboxFlush();
  return { queued: true, outboxId: queued.id };
}

async function sendRunLongMessage(run, text, {
  speechText = null,
  forceSpeechButton = false,
  reliable = false,
  deliveryGroupId = randomUUID(),
} = {}) {
  const value = `🧵 ${runTaskTitle(run)}\n\n${String(text)}`;
  const speechId = rememberSpeechText(speechText, forceSpeechButton);
  let queued = false;
  let sequence = 0;
  for (let start = 0; start < value.length; start += TELEGRAM_LIMIT) {
    const isLast = start + TELEGRAM_LIMIT >= value.length;
    const extra = isLast && speechId
      ? { reply_markup: { inline_keyboard: [[{ text: "🔊 Озвучить", callback_data: `speech:${speechId}` }]] } }
      : {};
    if (reliable) {
      const result = await sendReliableRunMessage(
        run,
        value.slice(start, start + TELEGRAM_LIMIT),
        extra,
        {},
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
  includeDiff = false,
  description = "финальный ответ",
} = {}) {
  run.finalizing = true;
  await deliveryOutbox.discard({ supersedeKey: progressOutboxKey(run) }).catch((error) => {
    console.error("Cannot discard stale progress delivery:", error.message);
  });
  rememberLastTaskMessage(run, answer);
  if (run?.turnId) setBoundedMapValue(lastSeenTaskTurnIds, taskRunKey(run), run.turnId, 500);
  let finalDelivery = null;
  if (deliver) {
    finalDelivery = await safelyDeliverRunMessage(
      run,
      () => sendRunLongMessage(run, message, {
        speechText,
        forceSpeechButton,
        reliable: true,
      }),
      description,
    );
  }
  if (includeDiff && run.latestDiff) {
    await safelyDeliverRunMessage(
      run,
      () => sendReliableRunMessage(
        run,
        "Изменения этой задачи доступны после её выбора по команде /diff.",
        {},
        {},
        {
          forceQueue: finalDelivery?.queued === true,
          groupId: finalDelivery?.groupId ?? randomUUID(),
          sequence: finalDelivery?.nextSequence ?? 0,
        },
      ),
      "уведомление об изменениях",
    );
  }
  await completeRun(run);
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

const TOKEN_USAGE_FIELDS = [
  "inputTokens",
  "cachedInputTokens",
  "outputTokens",
  "reasoningOutputTokens",
  "totalTokens",
];

function emptyTokenUsage() {
  return Object.fromEntries(TOKEN_USAGE_FIELDS.map((field) => [field, 0]));
}

function normalizeTokenUsage(usage) {
  const normalized = emptyTokenUsage();
  for (const field of TOKEN_USAGE_FIELDS) {
    const value = Number(usage?.[field]);
    if (Number.isFinite(value) && value >= 0) normalized[field] = Math.trunc(value);
  }
  return normalized;
}

function tokenUsageDelta(current, previous, fallback) {
  if (!previous || TOKEN_USAGE_FIELDS.some((field) => current[field] < previous[field])) {
    return normalizeTokenUsage(fallback);
  }
  return Object.fromEntries(TOKEN_USAGE_FIELDS.map((field) => [field, current[field] - previous[field]]));
}

function addTokenUsage(total, addition) {
  return Object.fromEntries(TOKEN_USAGE_FIELDS.map((field) => [field, total[field] + addition[field]]));
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

function formatTurnTokenUsage(tracker) {
  if (!tracker?.reported) return "📊 Токены за задачу: нет данных.";
  const { inputTokens, cachedInputTokens, outputTokens, reasoningOutputTokens, totalTokens } = tracker.usage;
  const uncachedInputTokens = Math.max(0, inputTokens - cachedInputTokens);
  return formatTaskTokenUsage({
    totalTokens,
    inputTokens: uncachedInputTokens,
    cachedInputTokens,
    outputTokens,
    reasoningOutputTokens,
  });
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

async function syncActiveCodexThreadSettings() {
  if (!isCodex() || !threadId) return;
  const result = await sendRpc("thread/resume", {
    threadId,
    approvalPolicy: "on-request",
    sandbox: "workspace-write",
  });
  if (!isWorkspaceThread(result.thread ?? {})) {
    throw new Error("задача относится к другой активной папке");
  }
  activeThreadTitle = await resolveResumedCodexThreadTitle(threadId, result.thread);
  applyCodexThreadSettings(threadId, result);
  await saveState();
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
try {
  const loadedState = await readJsonWithBackup(STATE_FILE, { backupFile: STATE_BACKUP_FILE });
  if (!loadedState.value) throw Object.assign(new Error("state file is missing"), { code: "ENOENT" });
  if (loadedState.recovered) console.warn(`Recovered runtime state from ${loadedState.source}`);
  const saved = loadedState.value;
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
    if (item?.id && item?.threadId && item?.provider) pendingInputs.set(item.id, item);
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
    console.log(`Local MCP unavailable; disabled for Integration App Server: ${endpoints}`);
  }
  console.error(`Starting Codex: ${command}`);
  return spawn(command, [...config.codexExecutableArgs, ...mcp.args, ...args], {
    cwd: activeProjectRoot,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
}

let codex = null;
let codexLines = null;

async function handleCodexTransportExit(instance, code, signal, cause = null) {
  if (codex !== instance) return;
  const detail = cause?.message ?? `code=${code}, signal=${signal}`;
  console.error(`Codex app-server stopped (${detail}).`);
  const error = new Error(`Codex app-server stopped (${detail})`);
  for (const pending of pendingRpc.values()) {
    clearTimeout(pending.timer);
    pending.reject(error);
  }
  pendingRpc.clear();
  const wasActive = isCodex();
  const hadCodexRuns = taskRuns.values().some((run) => run.provider === "codex");
  codex = null;
  codexLines = null;
  if (stopping) return;
  if (!wasActive && !hadCodexRuns) return;
  for (const run of taskRuns.values().filter((item) => item.provider === "codex")) {
    setProgressStage(run, "Связь с Codex потеряна. Переподключаюсь…");
  }
  if (!codexRestarting) setTimeout(() => void restartCodexAfterCrash(), 2000);
}

async function startCodexAppServer() {
  if (codex) return;
  const child = await spawnCodex(["app-server", "--stdio"]);
  try {
    await new Promise((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
  } catch (error) {
    child.kill();
    throw new Error(`Codex app-server failed to start: ${error.message}`, { cause: error });
  }
  codex = child;
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (data) => console.error(`[codex] ${data.trimEnd()}`));
  child.on("error", (error) => {
    void handleCodexTransportExit(child, null, null, error);
  });
  child.stdin.on("error", (error) => {
    void handleCodexTransportExit(child, null, null, error);
  });
  child.on("exit", (code, signal) => {
    void handleCodexTransportExit(child, code, signal);
  });

  codexLines = createInterface({ input: child.stdout });
  codexLines.on("line", (line) => {
    try {
      void handleCodexMessage(JSON.parse(line)).catch((error) => {
        console.error("Codex event handling error:", error.message);
      });
    } catch (error) {
      console.error("Invalid app-server message:", error.message);
    }
  });
}

async function stopCodexAppServerTree() {
  const child = codex;
  if (!child) return;
  if (!child.pid) {
    child.kill();
    return;
  }
  await stopProcessTree(child.pid).catch(() => child.kill());
}

function writeCodexMessage(message) {
  if (!codex) throw new Error("Codex App Server is not running");
  if (typeof codex.send === "function") {
    codex.send(message);
    return;
  }
  codex.stdin.write(`${JSON.stringify(message)}\n`);
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
  if (!codex) return Promise.reject(new Error("Codex App Server is not running"));
  const id = requestSequence++;
  const promise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (!pendingRpc.delete(id)) return;
      reject(new Error(`Codex RPC ${method} timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    pendingRpc.set(id, { resolve, reject, timer, method });
  });
  try {
    writeCodexMessage({ method, id, params });
  } catch (error) {
    clearTimeout(pendingRpc.get(id)?.timer);
    pendingRpc.delete(id);
    return Promise.reject(error);
  }
  return promise;
}

function invalidateCodexThreadRead(threadId) {
  const key = String(threadId ?? "").trim();
  if (key) codexThreadReadCache.delete(key);
}

async function readCodexThread(threadId, { fresh = false } = {}) {
  const key = String(threadId ?? "").trim();
  if (!key) throw new Error("Codex thread id is missing");
  const cached = codexThreadReadCache.get(key);
  if (cached?.promise) return cached.promise;
  if (!fresh && cached?.value && cached.expiresAt > Date.now()) return cached.value;

  const entry = { value: null, expiresAt: 0, promise: null };
  entry.promise = sendRpc("thread/read", { threadId: key, includeTurns: true });
  codexThreadReadCache.set(key, entry);
  try {
    entry.value = await entry.promise;
    entry.expiresAt = Date.now() + CODEX_THREAD_READ_CACHE_MS;
    entry.promise = null;
    if (codexThreadReadCache.size > 200) {
      codexThreadReadCache.delete(codexThreadReadCache.keys().next().value);
    }
    return entry.value;
  } catch (error) {
    if (codexThreadReadCache.get(key) === entry) codexThreadReadCache.delete(key);
    throw error;
  }
}

function sendNotification(method, params = {}) {
  writeCodexMessage({ method, params });
}

function respondRpc(id, result) {
  writeCodexMessage({ id, result });
}

async function initializeProvider() {
  if (!isCodex()) {
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
  if (!codex) {
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

async function buildTaskCatalog() {
  const [codexResult, claudeResult] = await Promise.allSettled([
    listAllCodexThreads(),
    listClaudeSessionSnapshots(),
  ]);
  const entries = [];
  if (codexResult.status === "fulfilled") {
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
          : codexObservedExecutionOwner(activity);
        const entry = codexCatalogEntry(thread, project, {
          rolloutRunning,
          executionOwner: rolloutRunning ? executionOwner : null,
          lastActivityAtMs: activity.lastActivityAtMs,
        });
        const titleHistory = titleHistories.get(thread.id)
          ?? { currentTitle: "", recoverableTitle: "" };
        if (titleHistory.recoverableTitle
          && (entry.title === titleHistory.currentTitle || entry.title === "Без названия")) {
          entry.title = titleHistory.recoverableTitle.slice(0, 80);
        }
        const pinnedTitle = pinnedTaskTitle(entry.provider, entry.threadId);
        if (pinnedTitle && codexThreadResponseTitle(thread) !== pinnedTitle) {
          await sendRpc("thread/name/set", { threadId: entry.threadId, name: pinnedTitle });
        }
        entry.title = pinnedTitle || entry.title;
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

function taskPickerButtonText(entry) {
  const selected = catalogEntryIsSelected(entry, selectedTask()) ? "✓ " : "";
  const running = entry.running ? "⏳ " : entry.activityUnknown ? "❔ " : "";
  const runtime = entry.running ? `${taskExecutionRuntimeShortLabel(entry.executionOwner)} · ` : "";
  const provider = entry.provider === "codex" ? "Codex" : "Claude";
  const project = config.showProjectButton && config.showTaskProject
    ? `${entry.projectName} · `
    : "";
  return `${selected}${running}${runtime}${provider} · ${project}${entry.title}`.slice(0, 90);
}

async function sendThreadPicker({ editMessage = null, page = 0 } = {}) {
  const catalog = await refreshTaskCatalog();
  const pageCount = Math.max(1, Math.ceil(catalog.length / TASK_PICKER_PAGE_SIZE));
  const safePage = Math.max(0, Math.min(Number(page) || 0, pageCount - 1));
  const visible = catalog.slice(
    safePage * TASK_PICKER_PAGE_SIZE,
    (safePage + 1) * TASK_PICKER_PAGE_SIZE,
  );
  const keyboard = visible.map((entry) => [{
    text: taskPickerButtonText(entry),
    callback_data: taskCatalogCallback(entry),
  }]);
  if (pageCount > 1) {
    const navigation = [];
    if (safePage > 0) navigation.push({ text: "←", callback_data: `tasks-page:${safePage - 1}` });
    navigation.push({ text: `${safePage + 1}/${pageCount}`, callback_data: `tasks-page:${safePage}` });
    if (safePage + 1 < pageCount) navigation.push({ text: "→", callback_data: `tasks-page:${safePage + 1}` });
    keyboard.push(navigation);
  }
  keyboard.push([{
    text: `🆕 Новая задача: ${providerTitle()} · ${activeProject().name}`,
    callback_data: uiCallback("thread:new"),
  }]);
  if (isCodex() && threadId) {
    keyboard.push([{
      text: "❌ Архивировать текущую задачу",
      callback_data: uiCallback("thread:archive"),
    }]);
  }
  const runningCount = catalog.filter((entry) => entry.running).length;
  const text = catalog.length
    ? `Все задачи Codex и Claude в разрешённых папках: ${catalog.length}\nВыполняются: ${runningCount}\n\nВыберите задачу:`
    : "В разрешённых папках пока нет задач Codex или Claude.";
  const replyMarkup = { inline_keyboard: keyboard };
  if (editMessage) {
    await telegram("editMessageText", {
      chat_id: editMessage.chat.id,
      message_id: editMessage.message_id,
      text,
      reply_markup: replyMarkup,
    });
  } else {
    await sendMessage(text, { reply_markup: replyMarkup });
  }
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
      if (!codex) {
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
    if (isCodex() && !codex) {
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
  let catalog = taskCatalog;
  try {
    catalog = await refreshTaskCatalog();
  } catch (error) {
    console.error("Cannot refresh task catalog for status:", error.message);
    catalog = mergeTaskCatalog(taskCatalog, taskRuns.values());
  }
  let task = "Не выбрана";
  if (snapshot.threadId) {
    const current = catalog.find((entry) => catalogEntryIsSelected(entry, selected));
    task = current?.title || snapshot.taskTitle
      || `${codexSelected ? "Codex" : "Claude"} · ${snapshot.threadId.slice(0, 8)}`;
  }

  let limits;
  try {
    limits = codexSelected
      ? formatCodexRateLimits(await sendRpc("account/rateLimits/read", {}, { timeoutMs: 5_000 }))
      : formatClaudeRateLimits(await readClaudeRateLimits());
  } catch (error) {
    console.error(`Cannot read ${codexSelected ? "Codex" : "Claude"} limits for status:`, error.message);
    limits = `Не удалось получить: ${error.message}`;
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
  const run = {
    id: randomUUID(),
    provider,
    chatId: target?.chatId ?? chatId,
    projectRoot,
    projectName: project?.name ?? path.basename(projectRoot),
    threadId: targetThreadId,
    turnId: null,
    sessionId: provider === "codex" ? null : targetThreadId,
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
    responseText: "",
    status: "running",
    startedAt: new Date().toISOString(),
    progressMessageIds: [],
    progressStage: "Задача принята.",
    progressReasoning: "",
    lastMeaningfulProgressAt: new Date().toISOString(),
    lastProgressText: "",
    progressStartTimer: null,
    progressTimer: null,
    progressUpdateInFlight: false,
    progressUpdatePending: false,
    observer: false,
    displayRequested: true,
    latestDiff: "",
    gitBaseline: null,
    process: null,
  };
  taskRuns.add(run);
  invalidateTaskCatalog();
  await persistTaskDiff(taskRunKey(run), "");
  if (isSelectedRun(run)) latestDiff = "";
  run.gitBaseline = await captureTaskGitBaseline(run.projectRoot, config.dataDir, run.id);
  syncTaskRun(run);
  await saveState();
  run.progressStartTimer = setTimeout(() => {
    run.progressStartTimer = null;
    void startProgressMessage(run);
  }, config.progressStartDelayMs);
  return run;
}

async function startProgressMessage(run, { forceNew = false } = {}) {
  if (!run || run.status !== "running" || (!forceNew && run.progressMessageIds.length)) return;
  if (run.observer) run.displayRequested = true;
  const initialProgress = renderProgress(run);
  const message = await sendReliableRunMessage(
    run,
    initialProgress,
    {},
    { kind: "progress" },
    { supersedeKey: progressOutboxKey(run) },
  );
  if (taskRuns.forTask(run) !== run || run.status !== "running") {
    if (message?.message_id) {
      await telegram("deleteMessage", { chat_id: run.chatId, message_id: message.message_id }).catch(() => {});
    }
    return;
  }
  if (Number.isSafeInteger(message?.message_id)) run.progressMessageIds.push(message.message_id);
  run.lastProgressText = initialProgress;
  await saveState();
}

async function clearRunProgressMessages(run) {
  if (!run) return;
  while (run.progressUpdateInFlight) await delay(50);
  const previousIds = [...run.progressMessageIds];
  run.progressMessageIds = [];
  run.lastProgressText = "";
  for (const messageId of previousIds) {
    await telegram("deleteMessage", {
      chat_id: run.chatId,
      message_id: messageId,
    }).catch((error) => {
      console.warn(`Cannot remove old progress message ${messageId}:`, error.message);
    });
  }
  if (previousIds.length) {
    const removed = new Set(previousIds);
    bindingWriteQueue = bindingWriteQueue
      .catch(() => {})
      .then(() => removeMessageBindings(
        config.dataDir,
        (binding) => binding.chatId === run.chatId && removed.has(binding.messageId),
      ));
    await bindingWriteQueue;
  }
}

async function replaceRunProgressMessage(run) {
  await clearRunProgressMessages(run);
  await startProgressMessage(run, { forceNew: true });
}

function setProgressStage(run, stage) {
  if (!run) return;
  const value = String(stage ?? "").trim();
  if (value && value !== run.progressStage) {
    run.progressStage = value;
    noteRunActivity(run);
  }
  scheduleProgressUpdate(run);
}

function appendProgressReasoning(run, delta) {
  if (!run) return;
  const value = String(delta ?? "");
  run.progressReasoning += value;
  if (run.progressReasoning.length > 5000) run.progressReasoning = run.progressReasoning.slice(-5000);
  if (value) noteRunActivity(run);
  scheduleProgressUpdate(run);
}

function noteRunActivity(run, value = Date.now()) {
  if (!run) return;
  const timestamp = value instanceof Date ? value.getTime() : Number(value);
  if (!Number.isFinite(timestamp)) return;
  const previous = Date.parse(String(run.lastMeaningfulProgressAt ?? ""));
  if (!Number.isFinite(previous) || timestamp > previous) {
    run.lastMeaningfulProgressAt = new Date(timestamp).toISOString();
  }
}

function progressHeartbeatState(run, now = Date.now()) {
  const lastActivity = Date.parse(String(run?.lastMeaningfulProgressAt ?? run?.startedAt ?? ""));
  return Number.isFinite(lastActivity) && now - lastActivity >= PROGRESS_STALLED_AFTER_MS
    ? "stalled"
    : "active";
}

function renderProgress(run, done = false) {
  const fallbackModel = run?.provider === "claude"
    ? CLAUDE_MODEL_LABELS[claudeModel]
    : codexModelLabel(codexModel);
  const fallbackReasoning = CODEX_REASONING_LABELS[
    run?.provider === "claude" ? claudeReasoningEffort : codexReasoningEffort
  ];
  const heading = formatProgressHeading({
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
  const parts = [heading, run?.progressStage || "Выполняется…"];
  if (done) return parts.join("\n\n").slice(0, TELEGRAM_LIMIT);
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

function scheduleProgressUpdate(run, delayMs = 1500) {
  if (!run?.progressMessageIds.length || run.progressTimer) return;
  run.progressTimer = setTimeout(() => {
    run.progressTimer = null;
    void flushProgressUpdate(run);
  }, delayMs);
}

async function flushProgressUpdate(run, done = false) {
  if (!run?.progressMessageIds.length) return;
  if (run.progressUpdateInFlight) {
    run.progressUpdatePending = true;
    return;
  }
  const text = renderProgress(run, done);
  if (text === run.lastProgressText) return;
  run.progressUpdateInFlight = true;
  let retryNeeded = false;
  try {
    const retained = [];
    for (const messageId of run.progressMessageIds) {
      try {
        await telegram("editMessageText", { chat_id: run.chatId, message_id: messageId, text });
        retained.push(messageId);
      } catch (error) {
        if (retainProgressMessageAfterEditError(error)) {
          retained.push(messageId);
          if (error?.retryable === true) retryNeeded = true;
        } else {
          console.error(`Cannot update task progress message ${messageId}:`, error.message);
        }
      }
    }
    run.progressMessageIds = retained;
    if (!retryNeeded && retained.length) run.lastProgressText = text;
    await saveState();
  } finally {
    run.progressUpdateInFlight = false;
    if (run.progressUpdatePending) {
      run.progressUpdatePending = false;
      scheduleProgressUpdate(run, 0);
    }
  }
  if (retryNeeded) scheduleProgressUpdate(run);
}

async function finishProgress(run, stage) {
  if (!run) return;
  run.status = "finishing";
  if (run.progressStartTimer) {
    clearTimeout(run.progressStartTimer);
    run.progressStartTimer = null;
  }
  if (run.progressTimer) {
    clearTimeout(run.progressTimer);
    run.progressTimer = null;
  }
  run.progressStage = stage;
  if (!run.progressMessageIds.length) {
    run.progressReasoning = "";
    run.lastProgressText = "";
    return;
  }
  while (run.progressUpdateInFlight) await delay(50);
  await flushProgressUpdate(run, true);
  run.progressMessageIds = [];
  run.progressReasoning = "";
  run.lastProgressText = "";
}

async function completeRun(run) {
  if (!run) return;
  for (const [key, approval] of pendingApprovals) {
    if (approval.runId === run.id) pendingApprovals.delete(key);
  }
  if (run.observerTimer) {
    clearTimeout(run.observerTimer);
    run.observerTimer = null;
  }
  if (run.claudeDrainTimer) {
    clearTimeout(run.claudeDrainTimer);
    run.claudeDrainTimer = null;
  }
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
      if (!codex) {
        await startCodexAppServer();
        await initializeCodex({ attachSelectedThread: false });
      }
      const result = await readCodexThread(target.threadId, { fresh: true });
      const activity = await readCodexRolloutActivity(result.thread?.path);
      return {
        state: codexThreadRunning(result.thread, { rolloutRunning: activity.running }) ? "active" : "inactive",
        executionOwner: codexObservedExecutionOwner(activity),
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
  const repoRoots = await taskRepositoryRoots(target.projectRoot);
  if (!repoRoots.length) return null;
  const catalog = await refreshTaskCatalog();
  const candidates = [
    ...taskRuns.values(),
    ...catalog.filter((entry) => entry.running),
  ];
  const enriched = await Promise.all(candidates.map(async (candidate) => ({
    ...candidate,
    repoRoots: candidate.gitBaseline?.repoRoot
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
    await saveState();
    turnSpeechButtons.set(run.turnId, forceSpeechButton);
    if (temporaryFiles.length) turnTemporaryFiles.set(run.turnId, temporaryFiles);
    if (!turnTokenUsage.has(run.turnId)) {
      setBoundedMapValue(turnTokenUsage, run.turnId, { usage: emptyTokenUsage(), reported: false }, 200);
    }
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
  const existingRun = taskRuns.forTask(target);
  const externalActivity = existingRun
    ? { state: "active", executionOwner: existingRun.executionOwner }
    : await taskExternalActivity(target);
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
  if (!allowRepositoryConflict) {
    const repositoryConflict = await activeRepositoryConflict(target);
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
  }
  if (target.provider === "codex" && catalogEntryIsSelected(target, selectedTask())) {
    try {
      await syncActiveCodexThreadSettings();
    } catch (error) {
      console.error("Cannot sync Codex thread settings before turn:", error.message);
    }
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

function scheduleQueuedInput(item, delayMs = 2000) {
  if (!item || queueTimers.has(item.id)) return;
  const timer = setTimeout(() => {
    queueTimers.delete(item.id);
    void processQueuedInput(item.id);
  }, delayMs);
  queueTimers.set(item.id, timer);
}

async function processQueuedInput(id) {
  const item = queuedInputs.get(id);
  if (!item) return;
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
  if (taskRuns.forTask(target) || externalActivity.state !== "inactive"
    || await activeRepositoryConflict(target)) {
    scheduleQueuedInput(item);
    return;
  }

  try {
    const run = await beginRun(item.input, target);
    await launchTurn(run, item.input, item.temporaryFiles ?? [], {
      forceSpeechButton: item.forceSpeechButton === true,
    });
    queuedInputs.delete(id);
    await saveState();
    await updateDeferredMessage(item, `▶️ Сообщение из очереди отправлено в задачу «${item.taskTitle}».`);
  } catch (error) {
    queuedInputs.delete(id);
    item.lastError = String(error.message ?? error);
    item.lastAttemptAt = new Date().toISOString();
    item.attempts = Number(item.attempts ?? 0) + 1;
    pendingInputs.set(id, item);
    await saveState();
    await updateDeferredMessage(
      item,
      `⚠️ Не удалось запустить сообщение из очереди: ${item.lastError}\n\nСообщение сохранено. Выберите дальнейшее действие:`,
      pendingInputKeyboard(item.id, { allowForce: item.allowForce === true }),
    );
    await sendMessageTo(item.chatId, "Сообщение не потеряно и возвращено в сохранённые после ошибки запуска.");
  }
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

async function refreshTaskDiff(run) {
  if (!run) return "";
  const captured = await taskGitDiff(run.gitBaseline, config.dataDir, run.id);
  if (captured !== null) run.latestDiff = captured;
  await persistTaskDiff(taskRunKey(run), run.latestDiff ?? "");
  if (isSelectedRun(run)) latestDiff = run.latestDiff ?? "";
  return run.latestDiff ?? "";
}

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
  const output = await openClaudeRunOutput(config.dataDir, turnId);
  run.claudeOutputPath = output.outputPath;
  run.claudeErrorPath = output.errorPath;
  run.claudeReadOffset = 0;
  run.claudeThinkingPeak = 0;
  run.claudeFailureText = "";
  run.claudeResult = null;
  run.claudeExitCode = null;
  run.claudeExited = false;
  run.claudeSettled = false;
  const invocation = resolveClaudeInvocation();
  let worker;
  let outputClosed = false;
  let callbacksEnabled = false;
  let spawnError = null;
  try {
    // Вывод уходит в файл, а процесс отвязан от бота: перезапуск бота больше не
    // рвёт поток stream-json и не убивает начатый ход. Обработчики навешиваются
    // синхронно внутри spawnClaudeWorker, иначе ошибка запуска теряется.
    worker = spawnClaudeWorker({
      command: invocation.command,
      args: [...invocation.prefixArgs, ...args],
      cwd: run.projectRoot,
      stdout: output.outputHandle.fd,
      stderr: output.errorHandle.fd,
      env: {
        ...process.env,
        MAX_THINKING_TOKENS: String(claudeThinkingTokens(run.reasoningId)),
      },
      onError: (error) => {
        spawnError = error;
        if (callbacksEnabled) void finishClaudeRun(run, { spawnError: error });
      },
      onExit: (code) => {
        run.claudeExitCode = code;
        run.claudeExited = true;
        if (callbacksEnabled) void drainClaudeRun(run);
      },
    });
  } finally {
    await Promise.all([
      output.outputHandle.close().catch(() => {}),
      output.errorHandle.close().catch(() => {}),
    ]);
    outputClosed = true;
  }
  if (!outputClosed) return;
  if (spawnError) {
    await finishClaudeRun(run, { spawnError });
    return;
  }
  run.process = worker;
  run.pid = worker.pid ?? null;
  await saveState();
  callbacksEnabled = true;
  if (spawnError) {
    await finishClaudeRun(run, { spawnError });
    return;
  }
  if (run.claudeExited) {
    await drainClaudeRun(run);
    return;
  }
  if (run.claudeSettled || taskRuns.forTask(run) !== run) return;
  startTyping();
  scheduleClaudeRunDrain(run, 0);
}

function claudeRunReader(run) {
  if (!run.claudeReader || run.claudeReader.path !== run.claudeOutputPath) {
    run.claudeReader = new ClaudeOutputReader(run.claudeOutputPath, {
      offset: run.claudeReadOffset ?? 0,
    });
    run.claudeReader.path = run.claudeOutputPath;
  }
  return run.claudeReader;
}

function scheduleClaudeRunDrain(run, delayMs = CLAUDE_OUTPUT_POLL_INTERVAL_MS) {
  if (!run || run.claudeSettled || run.claudeDrainTimer || stopping) return;
  if (taskRuns.forTask(run) !== run) return;
  run.claudeDrainTimer = setTimeout(() => {
    run.claudeDrainTimer = null;
    void drainClaudeRun(run);
  }, delayMs);
}

// Читает всё, что CLI успел дописать в файл хода, и решает, продолжать ли
// наблюдение: ход завершён, когда пришёл result либо процесс больше не жив.
async function drainClaudeRun(run) {
  if (!run || run.claudeSettled || taskRuns.forTask(run) !== run) return;
  if (run.claudeDrainInFlight) {
    run.claudeDrainPending = true;
    return;
  }
  run.claudeDrainInFlight = true;
  try {
    do {
      run.claudeDrainPending = false;
      const reader = claudeRunReader(run);
      const lines = await reader.read();
      run.claudeReadOffset = reader.offset;
      for (const line of lines) handleClaudeStreamLine(run, line);
    } while (run.claudeDrainPending);
  } catch (error) {
    console.error(`Cannot read Claude output for task ${run.threadId}:`, error.message);
  } finally {
    run.claudeDrainInFlight = false;
  }
  if (run.claudeSettled || taskRuns.forTask(run) !== run) return;
  const processGone = run.claudeExited === true
    || (run.pid ? !processIsAlive(run.pid) : !run.process);
  if (run.claudeResult || processGone) {
    await finishClaudeRun(run);
    return;
  }
  scheduleClaudeRunDrain(run);
}

function handleClaudeStreamLine(run, line) {
  const parsed = parseClaudeStreamEvent(line);
  if (!parsed) return;
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
  if (parsed.result) run.claudeResult = parsed.result;
}

async function readClaudeRunResult(run) {
  if (run.claudeResult) return run.claudeResult;
  if (!run.claudeOutputPath) return null;
  try {
    const text = await readFile(run.claudeOutputPath, "utf8");
    return text.trim() ? parseClaudeResult(text) : null;
  } catch {
    // Файл потерян или не содержит разбираемого результата.
    return null;
  }
}

async function readClaudeRunError(run) {
  if (!run.claudeErrorPath) return "";
  try {
    return String(await readFile(run.claudeErrorPath, "utf8")).trim().slice(-2000);
  } catch {
    return "";
  }
}

async function finishClaudeRun(run, { spawnError = null } = {}) {
  if (!run || run.claudeSettled) return;
  run.claudeSettled = true;
  if (run.claudeDrainTimer) {
    clearTimeout(run.claudeDrainTimer);
    run.claudeDrainTimer = null;
  }
  run.process = null;
  const turnId = run.turnId;
  const files = turnTemporaryFiles.get(turnId) ?? run.claudeTemporaryFiles ?? [];
  turnTemporaryFiles.delete(turnId);
  run.claudeTemporaryFiles = [];
  await Promise.all(files.map((file) => unlink(file).catch(() => {})));
  const outputPaths = { outputPath: run.claudeOutputPath, errorPath: run.claudeErrorPath };
  // Код возврата известен только когда ход завершился при живом боте; после
  // перезапуска о нём судим по содержимому файла хода.
  const exitCode = Number.isInteger(run.claudeExitCode) ? run.claudeExitCode : null;
  const forceSpeechButton = run.claudeForceSpeechButton === true;

  try {
    if (spawnError) throw spawnError;
    const result = await readClaudeRunResult(run);
    if (!result) {
      throw new Error(
        run.claudeFailureText
          || await readClaudeRunError(run)
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
    await refreshTaskDiff(run);
    const answer = String(result.result ?? "").trim()
      || run.claudeFailureText
      || (result.is_error ? "Claude Code завершил задачу с ошибкой." : "Задача завершена.");
    const failed = (exitCode !== null && exitCode !== 0) || result.is_error === true;
    await finishProgress(run, failed ? `Claude остановлен: ${answer}` : "Задача завершена.");
    const response = failed ? `Ошибка Claude Code: ${answer}` : answer;
    await finalizeRunDelivery(run, {
      answer: response,
      message: `${response}\n\n${formatClaudeUsage(result, run.claudeThinkingPeak ?? 0)}`,
      speechText: answer,
      forceSpeechButton,
      includeDiff: true,
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
  await removeClaudeRunOutput(outputPaths);
}

// Отменить ход можно и после перезапуска бота, когда объекта процесса уже нет,
// поэтому останавливаем по сохранённому PID. Дочитывание файла само завершит ход.
async function stopClaudeRunProcess(run) {
  if (!run) return false;
  const pid = Number(run.pid ?? run.process?.pid);
  if (!processIsAlive(pid)) {
    run.claudeExited = true;
    void drainClaudeRun(run);
    return true;
  }
  const stopped = await stopProcessTree(pid);
  if (!stopped) console.error(`Cannot stop Claude process tree ${pid}`);
  return stopped;
}

// После перезапуска бота дочерний процесс CLI потерян как объект, но сам ход
// продолжается: подключаемся к нему заново через файл вывода и живой PID.
async function attachClaudeRunAfterRestart(run) {
  const alive = processIsAlive(run.pid);
  run.process = null;
  run.claudeReader = null;
  run.claudeSettled = false;
  run.claudeExited = !alive;
  run.claudeExitCode = null;
  run.claudeReadOffset = 0;
  run.claudeThinkingPeak = 0;
  run.claudeFailureText = "";
  run.claudeResult = null;
  run.responseText = "";
  setProgressStage(run, alive
    ? "Переподключился к выполняющемуся ходу Claude."
    : "Дочитываю прерванный ход Claude…");
  if (alive) startTyping();
  await saveState();
  await drainClaudeRun(run);
}

async function handleCodexMessage(message) {
  if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
    const pending = pendingRpc.get(message.id);
    if (pending) {
      pendingRpc.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message ?? JSON.stringify(message.error)));
      else pending.resolve(message.result);
    }
    return;
  }

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
      void saveState();
    }
    if (eventTurnId && !turnTokenUsage.has(eventTurnId)) {
      setBoundedMapValue(turnTokenUsage, eventTurnId, { usage: emptyTokenUsage(), reported: false }, 200);
    }
  }
  if (method === "thread/tokenUsage/updated") trackTurnTokenUsage(params);
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
    run.status = "finishing";
    const completedTurnId = eventTurnId ?? run.turnId;
    const tokenSummary = formatTurnTokenUsage(turnTokenUsage.get(completedTurnId));
    turnTokenUsage.delete(completedTurnId);
    const temporaryFiles = turnTemporaryFiles.get(completedTurnId) ?? [];
    turnTemporaryFiles.delete(completedTurnId);
    const forceSpeechButton = turnSpeechButtons.get(completedTurnId) ?? false;
    turnSpeechButtons.delete(completedTurnId);
    await Promise.all(temporaryFiles.map((file) => unlink(file).catch(() => {})));
    const status = params.turn?.status ?? "completed";
    const error = params.turn?.error?.message;
    const answer = await completedCodexAnswer(run, completedTurnId, params.turn)
      || (error ? `Ошибка: ${error}` : `Задача завершена: ${status}`);
    await refreshTaskDiff(run);
    await finishProgress(run, error || status === "failed" ? `Задача завершилась с ошибкой: ${error ?? status}` : "Задача завершена.");
    await finalizeRunDelivery(run, {
      answer,
      message: `${answer}\n\n${tokenSummary}`,
      forceSpeechButton,
      includeDiff: true,
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
  const waitingOnApproval = codexThreadWaitingOnApproval(threadStatus);
  return {
    answer,
    finalAnswer: codexFinalTurnAnswer(turn),
    reasoning: "",
    completed: turn?.status !== "inProgress",
    active: turn?.status === "inProgress",
    waitingOnApproval,
    stage: turn?.status === "inProgress"
      ? waitingOnApproval
        ? "🔐 Ожидается подтверждение разрешений."
        : describeCodexItem(lastItem, false)
      : turn?.status === "completed"
        ? "Задача завершена."
        : `Задача остановлена: ${turn?.status ?? "неизвестно"}.`,
  };
}

function observedRun(binding, targetChatId, snapshot, turnId = null) {
  const executionOwner = binding.provider === "codex"
    ? snapshot.executionOwner ?? TASK_EXECUTION_OWNERS.EXTERNAL
    : TASK_EXECUTION_OWNERS.EXTERNAL;
  const run = {
    id: randomUUID(),
    provider: binding.provider,
    chatId: targetChatId,
    projectRoot: binding.projectRoot,
    projectName: findProject(binding.projectRoot)?.name ?? path.basename(binding.projectRoot),
    threadId: binding.threadId,
    sessionId: binding.provider === "claude" ? binding.threadId : null,
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
    appServer: binding.provider === "codex"
      ? taskExecutionRuntimeLabel(executionOwner)
      : "Внешний Claude CLI",
    collaborationMode: "default",
    responseText: snapshot.answer ?? "",
    observedInitialResponseText: String(snapshot.answer ?? ""),
    observedResponseChanged: false,
    status: "running",
    startedAt: new Date().toISOString(),
    progressMessageIds: [],
    progressStage: snapshot.stage ?? "Подключение к выполняющейся задаче…",
    progressReasoning: snapshot.reasoning ?? "",
    lastMeaningfulProgressAt: new Date().toISOString(),
    lastProgressText: "",
    progressStartTimer: null,
    progressTimer: null,
    progressUpdateInFlight: false,
    progressUpdatePending: false,
    observerTimer: null,
    observer: true,
    displayRequested: false,
    latestDiff: "",
    gitBaseline: null,
    process: null,
  };
  taskRuns.add(run);
  invalidateTaskCatalog();
  syncTaskRun(run, {
    active: true,
    stage: snapshot.stage,
    answer: snapshot.answer,
    activityAtMs: snapshot.activityAtMs ?? snapshot.modifiedAtMs ?? Date.now(),
  });
  void captureTaskGitBaseline(run.projectRoot, config.dataDir, run.id).then(async (baseline) => {
    if (taskRuns.forTask(run) !== run) return;
    run.gitBaseline = baseline;
    await saveState();
  });
  return run;
}

function updateObservedRun(run, snapshot) {
  const previousReasoning = run.progressReasoning;
  const previousStage = run.progressStage;
  const responseChanged = updateObservedResponse(run, snapshot?.answer);
  run.progressReasoning = String(snapshot?.reasoning ?? run.progressReasoning);
  run.progressStage = String(snapshot?.stage ?? run.progressStage);
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
  const result = threadResult ?? await readCodexThread(run.threadId, { fresh });
  const turns = Array.isArray(result.thread?.turns) ? result.thread.turns : [];
  const activity = await readCodexRolloutActivity(result.thread?.path);
  const turn = selectCodexTurn(turns, {
    requestedTurnId: run.turnId,
    rolloutActiveTurnIds: activity.activeTurnIds,
    strictRequested: run.observer !== true,
  });
  if (!turn) return null;
  const snapshot = {
    ...codexTurnSnapshot(turn, result.thread?.status),
    turnId: turn.id,
    activityAtMs: activity.lastActivityAtMs,
    model: activity.model,
    reasoningEffort: activity.reasoningEffort,
    executionOwner: run?.observer === true
      ? codexObservedExecutionOwner(activity, turn.id)
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
  updateObservedRun(run, snapshot);
  const answer = String(snapshot?.answer ?? "").trim()
    || savedLastTaskMessage(run)
    || "Ход завершён без текстового ответа.";
  await refreshTaskDiff(run);
  await finishProgress(run, snapshot?.stage ?? "Задача завершена.");
  await finalizeRunDelivery(run, {
    answer,
    deliver: true,
    includeDiff: true,
    description: "финальный ответ наблюдаемого хода",
  });
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
  const tokenSummary = formatTurnTokenUsage(turnTokenUsage.get(completedTurnId));
  turnTokenUsage.delete(completedTurnId);
  const temporaryFiles = turnTemporaryFiles.get(completedTurnId) ?? [];
  turnTemporaryFiles.delete(completedTurnId);
  const forceSpeechButton = turnSpeechButtons.get(completedTurnId) ?? false;
  turnSpeechButtons.delete(completedTurnId);
  await Promise.all(temporaryFiles.map((file) => unlink(file).catch(() => {})));
  const answer = String(snapshot?.finalAnswer ?? "").trim()
    || String(snapshot?.answer ?? "").trim()
    || run.responseText.trim()
    || "Ход завершён без текстового ответа.";
  await refreshTaskDiff(run);
  await finishProgress(run, snapshot?.stage ?? "Задача завершена.");
  await finalizeRunDelivery(run, {
    answer,
    message: `${answer}\n\n${tokenSummary}`,
    forceSpeechButton,
    includeDiff: true,
    description: "восстановленный финальный ответ Codex",
  });
}

function scheduleObservedRun(run) {
  if ((!run?.observer && run?.provider !== "codex")
    || run.observerTimer
    || taskRuns.forTask(run) !== run) return;
  const delayMs = run.observer === true
    ? EXTERNAL_TASK_POLL_INTERVAL_MS
    : MANAGED_TASK_FALLBACK_POLL_INTERVAL_MS;
  run.observerTimer = setTimeout(() => {
    run.observerTimer = null;
    void pollObservedRun(run);
  }, delayMs);
}

async function pollObservedRun(run) {
  if ((!run?.observer && run?.provider !== "codex") || taskRuns.forTask(run) !== run) return;
  try {
    const snapshot = run.provider === "codex"
      ? await readCodexTaskSnapshot(run)
      : await readClaudeTaskSnapshot(run.threadId);
    if (snapshot?.activityUnknown) {
      await finishUnknownObservedClaudeRun(run, snapshot);
      return;
    }
    if (!snapshot) {
      setProgressStage(run, "Ожидаю данные текущего хода…");
      if (markProgressHeartbeat(run, "waiting")) scheduleProgressUpdate(run);
      scheduleObservedRun(run);
      return;
    }
    if (snapshot.turnId && snapshot.turnId !== run.turnId) {
      const previousTurnId = run.turnId;
      run.turnId = snapshot.turnId;
      taskRuns.reindex(run, { turnId: previousTurnId });
    }
    if (snapshot.completed) {
      if (run.observer) {
        await finishObservedRun(run, snapshot);
      } else {
        await finishManagedCodexSnapshot(run, snapshot);
      }
      return;
    }
    run.executionOwner = run.observer === true
      ? snapshot.executionOwner ?? TASK_EXECUTION_OWNERS.EXTERNAL
      : TASK_EXECUTION_OWNERS.TELEGRAM;
    if (run.provider === "codex") {
      run.appServer = taskExecutionRuntimeLabel(run.executionOwner);
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
    scheduleObservedRun(run);
  } catch (error) {
    console.error(`Cannot observe ${run.provider} task ${run.threadId}:`, error.message);
    setProgressStage(run, `Не удалось обновить ход: ${error.message}`);
    if (markProgressHeartbeat(run, "error")) scheduleProgressUpdate(run);
    scheduleObservedRun(run);
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
      const missedCompletedTurn = previousTurnId
        && previousTurnId !== snapshot.turnId
        && answer
        && taskRunKey(currentTask) === key
        && !dismissedExternalTasks.has(task);
      if (missedCompletedTurn) {
        const completedRun = {
          ...task,
          chatId,
          taskTitle: activeThreadTitle,
          turnId: snapshot.turnId,
        };
        rememberLastTaskMessage(completedRun, answer);
        await safelyDeliverRunMessage(
          completedRun,
          () => sendRunLongMessage(completedRun, answer, { speechText: answer, reliable: true }),
          "пропущенный короткий внешний финал",
        );
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
    const run = observedRun({
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

function taskViewRun(binding, targetChatId) {
  return {
    provider: binding.provider,
    projectRoot: binding.projectRoot,
    threadId: binding.threadId,
    chatId: targetChatId,
    taskTitle: binding.taskTitle,
  };
}

async function readTaskViewHistory(binding, { completedOnly = false } = {}) {
  const task = taskViewRun(binding, binding.chatId);
  try {
    if (binding.provider === "codex") {
      if (!codex) {
        await startCodexAppServer();
        await initializeCodex({ attachSelectedThread: false });
      }
      const result = await readCodexThread(binding.threadId, { fresh: true });
      const history = codexThreadHistory(result.thread?.turns);
      const snapshot = completedOnly ? null : await readCodexTaskSnapshot({
        ...task,
        turnId: null,
        observer: true,
      }, { threadResult: result });
      mergeActiveTaskHistory(history, snapshot);
      taskSyncStore.recordHistory(task, history, snapshot);
      await taskSyncStore.save();
      return { history, snapshot };
    }
    const snapshot = await readClaudeTaskSnapshot(binding.threadId);
    const history = snapshot?.history ?? [];
    taskSyncStore.recordHistory(task, history, completedOnly ? null : snapshot);
    await taskSyncStore.save();
    return {
      history,
      snapshot: completedOnly ? null : snapshot,
    };
  } catch (error) {
    const history = taskSyncStore.history(task)
      .filter((item) => !completedOnly || item.completed);
    if (!history.length) throw error;
    console.warn(`Using cached local history for ${binding.provider} task ${binding.threadId}:`, error.message);
    return {
      history,
      snapshot: completedOnly ? null : taskSyncStore.snapshot(task),
    };
  }
}

async function renderTaskView(binding, targetChatId, {
  count = 1,
  completedOnly = false,
} = {}) {
  const task = taskViewRun(binding, targetChatId);
  const { history, snapshot } = await readTaskViewHistory(binding, { completedOnly });
  const running = taskRuns.forTask(task);
  if (running) {
    mergeActiveTaskHistory(history, {
      active: true,
      turnId: running.turnId ?? running.id,
      prompt: running.promptPreview,
      answer: running.responseText,
    });
  }
  const view = visibleTaskHistory(history, count, { completedOnly });
  await deleteTaskTelegramMessages(task, targetChatId);

  const historyButton = view.hasMore
    ? {
      reply_markup: {
        inline_keyboard: [[{
          text: `👀 Показать ещё · ${view.shown}/${view.total}`,
          callback_data: taskViewCallbackData({
            action: completedOnly ? "history-last" : "history-all",
            provider: task.provider,
            threadId: task.threadId,
            count: view.nextCount,
          }) ?? `history-more:${completedOnly ? "l" : "a"}:${view.nextCount}`,
        }]],
      },
    }
    : {};
  await sendRunMessage(
    task,
    `🧵 ${runTaskTitle(task)}\n\n`
      + (view.total
        ? `Показано сообщений: ${view.shown} из ${view.total}.`
        : "История этой задачи пока пуста."),
    historyButton,
    { kind: "task-view-navigation" },
  );

  let rendered = false;
  for (const exchange of view.items) {
    if (exchange.prompt) {
      await sendTaskViewText(task, "👤 Вы", exchange.prompt, "task-view-user");
      rendered = true;
    }
    if (!exchange.active && exchange.answer) {
      await sendTaskViewText(
        task,
        binding.provider === "claude" ? "🤖 Claude" : "🤖 Codex",
        exchange.answer,
        "task-view-assistant",
      );
      rendered = true;
    }
  }

  if (!rendered && completedOnly) {
    const answer = savedLastTaskMessage(task);
    if (answer) {
      await sendTaskViewText(
        task,
        binding.provider === "claude" ? "🤖 Claude" : "🤖 Codex",
        answer,
        "task-view-assistant",
      );
      rendered = true;
    }
  }
  return { snapshot, rendered };
}

async function showTaskMessage(binding, targetChatId, { count = 1 } = {}) {
  const task = {
    provider: binding.provider,
    projectRoot: binding.projectRoot,
    threadId: binding.threadId,
  };
  if (dismissedExternalTasks.delete(task)) await saveState();
  const view = await renderTaskView(binding, targetChatId, { count });
  const running = taskRuns.forTask(task);
  if (running) {
    const selectedTitle = isSelectedRun(running) ? activeThreadTitle : null;
    const catalogTitle = taskCatalog.find((entry) => catalogEntryIsSelected(entry, running))?.title;
    if (updateTaskRunTitle(running, selectedTitle || catalogTitle || binding.taskTitle)) {
      await saveState();
    }
    running.chatId = targetChatId;
    if (running.observer) running.displayRequested = true;
    await startProgressMessage(running, { forceNew: true });
    return;
  }

  if (view.snapshot?.active) {
    const run = observedRun(
      binding,
      targetChatId,
      view.snapshot,
      binding.provider === "codex" ? view.snapshot.turnId : null,
    );
    run.displayRequested = true;
    await startProgressMessage(run, { forceNew: true });
    scheduleObservedRun(run);
    await saveState();
    return;
  }

  if (view.snapshot?.activityUnknown) {
    await sendRunMessage(
      { ...task, chatId: targetChatId, taskTitle: binding.taskTitle },
      "❔ Активность Claude неизвестна: транскрипт не завершён, но давно не обновлялся. Новое сообщение не будет запущено в этом треде без явного подтверждения.",
    );
    await saveState();
    return;
  }

  if (!view.rendered) {
    await sendRunMessage(
      { ...task, chatId: targetChatId, taskTitle: binding.taskTitle },
      "У этой задачи пока нет выполняющегося хода или сохранённого ответа.",
    );
  }
  await saveState();
}

async function showLastTaskMessage(binding, targetChatId, { count = 1 } = {}) {
  const view = await renderTaskView(binding, targetChatId, {
    count,
    completedOnly: true,
  });
  if (!view.rendered) {
    await sendRunMessage(
      { ...binding, chatId: targetChatId },
      "У этой задачи пока нет сохранённого завершённого ответа.",
    );
  }
  await saveState();
}

function taskViewIdentityMatches(binding, identity) {
  return binding?.provider === identity?.provider
    && String(binding?.threadId ?? "").toLowerCase() === String(identity?.threadId ?? "").toLowerCase();
}

async function resolveTaskViewBinding(identity, targetChatId, sourceMessageId) {
  const stored = await findMessageBinding(config.dataDir, targetChatId, sourceMessageId);
  if (!identity) return stored;
  if (taskViewIdentityMatches(stored, identity)) return stored;

  let entry = taskCatalog.find((item) => taskViewIdentityMatches(item, identity));
  if (!entry) {
    entry = (await refreshTaskCatalog()).find((item) => taskViewIdentityMatches(item, identity));
  }
  if (entry) {
    return {
      chatId: targetChatId,
      messageId: sourceMessageId,
      provider: entry.provider,
      threadId: entry.threadId,
      projectRoot: entry.projectRoot,
      taskTitle: entry.title,
      createdAt: new Date().toISOString(),
    };
  }

  const selected = selectedTask();
  if (!taskViewIdentityMatches(selected, identity)) return null;
  return {
    chatId: targetChatId,
    messageId: sourceMessageId,
    ...selected,
    taskTitle: activeThreadTitle,
    createdAt: new Date().toISOString(),
  };
}

async function recoverTaskRun(run) {
  if (run.observer) {
    run.displayRequested = run.displayRequested === true;
    const snapshot = run.provider === "codex" && codex
      ? await readCodexTaskSnapshot(run)
      : run.provider === "claude"
        ? await readClaudeTaskSnapshot(run.threadId)
        : null;
    if (snapshot?.active) {
      updateObservedRun(run, snapshot);
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
    if (snapshot?.completed) {
      await finishObservedRun(run, snapshot);
      return;
    }
    if (snapshot?.activityUnknown) {
      await finishUnknownObservedClaudeRun(run, snapshot);
      return;
    }
  }
  if (run.provider === "claude" && run.claudeOutputPath) {
    await attachClaudeRunAfterRestart(run);
    return;
  }
  if (run.provider !== "codex" || !codex) {
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
  if (!turn) {
    await finishProgress(run, "Не удалось найти сохранённый запуск.");
    await completeRun(run);
    return;
  }
  run.responseText = recoveredCodexAnswer(turn) || run.responseText;
  if (turn.status === "inProgress"
    && autoApprove
    && run.observer !== true
    && codexThreadWaitingOnApproval(result.thread?.status)) {
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
  if (turn.status === "inProgress") {
    const previousTurnId = run.turnId;
    run.turnId = turn.id;
    taskRuns.reindex(run, { turnId: previousTurnId });
    setProgressStage(run, "Подключено к продолжающейся задаче.");
    scheduleObservedRun(run);
    startTyping();
    await saveState();
    return;
  }

  if (restartRequest && turn.status === "interrupted") {
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
  await finishProgress(run, turn.status === "completed" ? "Задача завершена." : `Задача остановлена: ${turn.status}.`);
  await finalizeRunDelivery(run, {
    answer,
    description: "восстановленный ответ",
  });
}

async function recoverActiveRuns({ provider = null } = {}) {
  const runs = taskRuns.values().filter((run) => !provider || run.provider === provider);
  if (runs.some((run) => run.provider === "codex") && !codex) {
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
  if (autoApprove) {
    respondRpc(rpcId, codexApprovalResponse(kind, "once", params));
    return;
  }
  const key = createApprovalKey();
  const approval = {
    rpcId,
    kind,
    params,
    runId: run?.id ?? null,
    chatId: run?.chatId ?? chatId,
  };
  pendingApprovals.set(key, approval);
  const decisions = [
    [{ text: "✅ Разрешить", callback_data: approvalCallbackData(key, "once") }],
    [{ text: "✅ На сессию", callback_data: approvalCallbackData(key, "session") }],
    [{ text: "❌ Отклонить", callback_data: approvalCallbackData(key, "decline") }],
  ];
  const extra = { reply_markup: { inline_keyboard: decisions } };
  try {
    const message = run
      ? await sendRunMessage(run, text, extra, { kind: "approval" })
      : await sendMessage(text, extra);
    approval.messageId = message?.message_id ?? null;
  } catch (error) {
    pendingApprovals.delete(key);
    throw error;
  }
}

async function requestMcpElicitation(rpcId, params, run = null) {
  const acceptResponse = mcpElicitationAutoResponse(params);
  if (autoApprove && acceptResponse) {
    respondRpc(rpcId, acceptResponse);
    if (run) setProgressStage(run, "MCP-запрос подтверждён автоматически. Продолжаю…");
    return;
  }
  const key = createApprovalKey();
  const approval = {
    rpcId,
    kind: "mcp-elicitation",
    params,
    acceptResponse,
    runId: run?.id ?? null,
    chatId: run?.chatId ?? chatId,
  };
  pendingApprovals.set(key, approval);
  const decisions = [];
  if (acceptResponse) {
    decisions.push([{ text: "✅ Принять", callback_data: approvalCallbackData(key, "once") }]);
  }
  if (params.mode === "url" && params.url) {
    decisions.push([{ text: "🌐 Открыть ссылку", url: params.url }]);
  }
  decisions.push([{ text: "❌ Отклонить", callback_data: approvalCallbackData(key, "decline") }]);
  const text = formatMcpElicitation(params)
    + (!acceptResponse && params.mode === "form"
      ? "\n\nАвтоматически заполнить эту форму безопасно нельзя."
      : "");
  const extra = { reply_markup: { inline_keyboard: decisions } };
  try {
    const message = run
      ? await sendRunMessage(run, text, extra, { kind: "approval" })
      : await sendMessage(text, extra);
    approval.messageId = message?.message_id ?? null;
  } catch (error) {
    pendingApprovals.delete(key);
    throw error;
  }
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
    await analyzeImage(item.payload.message, item.payload.target);
    return;
  }
  if (item.kind === "voice") {
    await transcribeVoice(item.payload.message, item.payload.target);
    return;
  }
  if (item.kind === "speech") {
    await processSpeechRequest(item.payload.chatId, item.payload.text);
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

async function enqueueBackgroundJob(kind, payload, targetChatId) {
  await backgroundJobStore.load();
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
  const item = await backgroundJobStore.enqueue({ kind, payload });
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
  await updateRestartMessage("🔄 Перезапускаю бота…").catch(() => {});
  await saveState();
  await Promise.allSettled([
    stateWriteQueue,
    bindingWriteQueue,
    speechWriteQueue,
    taskSyncStore.save(),
    deliveryOutbox.waitForWrites(),
    backgroundJobStore.waitForWrites(),
  ]);
  stopping = true;
  stopRuntimeTimers();
  await stopCodexAppServerTree();
  stopTtsWorker();
  await runtimeCommandServer.close();
  await instanceGuard.release();
  const invocation = botReplacementInvocation({
    botFile: path.join(import.meta.dirname, "bot.mjs"),
    integrationRoot: INTEGRATION_ROOT,
  });
  const replacement = spawn(invocation.command, invocation.args, invocation.options);
  replacement.unref();
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
    : "🔄 Перезапускаю бота…");
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

async function transcribeVoice(message, target) {
  if (!config.voiceEnabled) {
    await sendMessageTo(target.chatId, "Голосовые сообщения отключены в конфигурации.");
    return;
  }
  const media = message.voice ?? message.audio;
  if (!media?.file_id) return;
  if ((media.file_size ?? 0) > 20 * 1024 * 1024) {
    await sendMessageTo(target.chatId, "Голосовой файл слишком большой. Максимальный размер — 20 МБ.");
    return;
  }

  await sendMessageTo(target.chatId, "🎙 Распознаю голосовое сообщение…");
  await mkdir(AUDIO_DIR, { recursive: true });
  const extension = message.voice ? ".ogg" : path.extname(media.file_name ?? "") || ".audio";
  const audioPath = path.join(AUDIO_DIR, `${randomUUID()}${extension}`);
  try {
    const file = await telegram("getFile", { file_id: media.file_id });
    const response = await fetch(telegramFileApiUrl(config.telegramApiBaseUrl, token, file.file_path), {
      signal: AbortSignal.timeout(60000),
    });
    if (!response.ok) throw new Error(`Telegram file download: HTTP ${response.status}`);
    await writeFile(audioPath, Buffer.from(await response.arrayBuffer()));
    const transcript = await runTranscription(audioPath);
    if (!transcript) {
      await sendMessageTo(target.chatId, "Не удалось распознать речь в сообщении.");
      return;
    }
    await sendMessageTo(target.chatId, `📝 Распознано:\n${transcript}`);
    await startTurn(telegramPrompt(message, transcript), [], {
      forceSpeechButton: true,
      target,
    });
  } catch (error) {
    await sendMessageTo(target.chatId, `Ошибка распознавания: ${error.message}`);
  } finally {
    await unlink(audioPath).catch(() => {});
  }
}

async function analyzeImage(message, target) {
  const photo = message.photo?.at(-1);
  const document = message.document?.mime_type?.startsWith("image/") ? message.document : null;
  const media = photo ?? document;
  if (!media?.file_id) return;
  if ((media.file_size ?? 0) > 20 * 1024 * 1024) {
    await sendMessageTo(target.chatId, "Изображение слишком большое. Максимальный размер — 20 МБ.");
    return;
  }

  await sendMessageTo(target.chatId, "🖼 Изображение получено, начинаю анализ…");
  await mkdir(IMAGE_DIR, { recursive: true });
  let imagePath;
  try {
    const file = await telegram("getFile", { file_id: media.file_id });
    const extension = path.extname(document?.file_name ?? file.file_path ?? "") || ".jpg";
    imagePath = path.join(IMAGE_DIR, `${randomUUID()}${extension}`);
    const response = await fetch(telegramFileApiUrl(config.telegramApiBaseUrl, token, file.file_path), {
      signal: AbortSignal.timeout(60000),
    });
    if (!response.ok) throw new Error(`Telegram file download: HTTP ${response.status}`);
    await writeFile(imagePath, Buffer.from(await response.arrayBuffer()));
    const prompt = message.caption?.trim() ||
      "Проанализируй это изображение с учётом предыдущих сообщений пользователя.";
    await startTurn([
      { type: "text", text: prompt },
      { type: "localImage", path: imagePath },
    ], [imagePath], { target });
  } catch (error) {
    if (imagePath) await unlink(imagePath).catch(() => {});
    await sendMessageTo(target.chatId, `Не удалось обработать изображение: ${error.message}`);
  }
}

function runTranscription(audioPath) {
  return new Promise((resolve, reject) => {
    const worker = spawn(PYTHON_EXE, [TRANSCRIBE_SCRIPT, audioPath], {
      cwd: activeProjectRoot,
      windowsHide: true,
      env: {
        ...process.env,
        PYTHONUTF8: "1",
        WHISPER_MODEL: config.whisperModel,
        WHISPER_MODEL_DIR,
      },
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      worker.kill();
      reject(new Error("превышено время распознавания (5 минут)"));
    }, 5 * 60 * 1000);
    worker.stdout.setEncoding("utf8");
    worker.stderr.setEncoding("utf8");
    worker.stdout.on("data", (chunk) => { stdout += chunk; });
    worker.stderr.on("data", (chunk) => { stderr += chunk; });
    worker.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    worker.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(stderr.trim() || `Whisper завершился с кодом ${code}`));
    });
  });
}

async function synthesizeSpeech(text) {
  await mkdir(TTS_DIR, { recursive: true });
  const id = randomUUID();
  const outputPath = path.join(TTS_DIR, `${randomUUID()}.ogg`);
  let currentWorker = null;
  return runTtsWorkerRequest({
    spawnWorker: () => spawn(TTS_PYTHON_EXE, [
      TTS_WORKER_SCRIPT,
      "--idle-timeout", String(config.ttsIdleTimeoutSeconds),
      "--model", config.ttsModel,
      "--speaker", config.ttsSpeaker,
      "--cache-dir", TTS_CACHE_DIR,
      "--max-chars", String(config.ttsMaxChars),
    ], {
      cwd: INTEGRATION_ROOT,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PYTHONUTF8: "1", TORCH_HOME: TTS_CACHE_DIR },
    }),
    request: { id, text, outputPath },
    timeoutMs: config.ttsRequestTimeoutSeconds * 1000,
    terminateWorker: (worker) => stopProcessTree(worker.pid).catch(() => worker.kill()),
    onWorkerChange: (worker) => {
      if (worker) {
        currentWorker = worker;
        ttsWorker = worker;
      } else if (ttsWorker === currentWorker) {
        ttsWorker = null;
      }
    },
    onDiagnostic: (message) => {
      if (message) console.error(`[tts] ${message}`);
    },
  });
}

function stopTtsWorker() {
  const worker = ttsWorker;
  if (!worker) return;
  ttsWorker = null;
  void stopProcessTree(worker.pid).catch(() => worker.kill());
}

function rememberSpeechText(text, force = false) {
  const value = String(text ?? "").trim();
  if (!config.ttsEnabled || !value || (!force && value.length < config.ttsButtonMinChars)) return null;
  while (speechTexts.size >= 100) speechTexts.delete(speechTexts.keys().next().value);
  const id = randomUUID().replaceAll("-", "").slice(0, 16);
  speechTexts.set(id, value);
  void saveSpeechTexts().catch((error) => console.error("Cannot save speech texts:", error.message));
  return id;
}

function saveSpeechTexts() {
  const content = `${JSON.stringify([...speechTexts], null, 2)}\n`;
  speechWriteQueue = speechWriteQueue
    .catch(() => {})
    .then(() => writeTextAtomic(SPEECH_TEXTS_FILE, content));
  return speechWriteQueue;
}

async function sendVoiceFile(targetChatId, voicePath) {
  const form = new FormData();
  form.append("chat_id", String(targetChatId));
  form.append("voice", new Blob([await readFile(voicePath)], { type: "audio/ogg" }), path.basename(voicePath));
  const response = await fetch(telegramBotApiUrl(config.telegramApiBaseUrl, token, "sendVoice"), {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(5 * 60 * 1000),
  });
  const payload = await response.json();
  if (!payload.ok) throw new Error(`Telegram sendVoice: ${payload.description ?? response.status}`);
  return payload.result;
}

async function processSpeechRequest(targetChatId, text) {
  const tick = () => telegram("sendChatAction", { chat_id: targetChatId, action: "record_voice" }).catch(() => {});
  const activity = setInterval(tick, 4000);
  tick();
  let voicePath;
  try {
    voicePath = await synthesizeSpeech(text);
    await sendVoiceFile(targetChatId, voicePath);
  } catch (error) {
    await sendMessageTo(targetChatId, `Не удалось озвучить ответ: ${error.message}`);
  } finally {
    clearInterval(activity);
    if (voicePath) await unlink(voicePath).catch(() => {});
  }
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

async function handleApprovalCallback(callback) {
  const resolvedCallback = resolveContextualCallback(callback.data, currentUiContextToken());
  if (resolvedCallback.stale) {
    await telegram("answerCallbackQuery", {
      callback_query_id: callback.id,
      text: "Это меню устарело. Откройте его заново.",
      show_alert: true,
    });
    return;
  }
  if (resolvedCallback.contextual) callback = { ...callback, data: resolvedCallback.action };
  const pendingAction = parsePendingInputCallback(callback.data);
  if (pendingAction) {
    const { action, id } = pendingAction;
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

  const speechMatch = /^speech:([0-9a-f]+)$/.exec(callback.data ?? "");
  if (speechMatch) {
    const text = speechTexts.get(speechMatch[1]);
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
    }, callback.message.chat.id);
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
  const taskViewAction = parseTaskViewCallbackData(callback.data);
  const historyMatch = /^history-more:([al]):(\d+)$/.exec(callback.data ?? "");
  if (historyMatch || taskViewAction?.action.startsWith("history-")) {
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
      : historyMatch[1] === "l";
    const count = taskViewAction?.count
      ?? Math.max(1, Math.min(Number(historyMatch[2]) || 1, 50));
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
  if (taskViewAction?.action === "show"
    || callback.data === "show-message"
    || callback.data === "show-last-message") {
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
  const modeMatch = /^approval-mode:(manual|auto)$/.exec(callback.data ?? "");
  if (modeMatch) {
    autoApprove = modeMatch[1] === "auto";
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
  const projectMatch = /^p:(\d+)$/.exec(callback.data ?? "");
  if (projectMatch) {
    try {
      const switched = await switchProject(Number(projectMatch[1]));
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
  const engineMatch = /^engine:(codex|claude)$/.exec(callback.data ?? "");
  if (engineMatch) {
    try {
      const switched = await switchProvider(engineMatch[1]);
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
  const codexModelMatch = /^codex-model:(.+)$/.exec(callback.data ?? "");
  if (codexModelMatch) {
    try {
      const switched = switchCodexModel(codexModelMatch[1]);
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
  const codexReasoningMatch = /^codex-reasoning:(low|medium|high|xhigh|max|ultra)$/.exec(callback.data ?? "");
  if (codexReasoningMatch) {
    const value = codexReasoningMatch[1];
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
  const codexModeMatch = /^codex-mode:(default|plan)$/.exec(callback.data ?? "");
  if (codexModeMatch) {
    const value = codexModeMatch[1];
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
  const claudeReasoningMatch = /^claude-reasoning:(low|medium|high|xhigh|max|ultra)$/.exec(callback.data ?? "");
  if (claudeReasoningMatch) {
    const value = claudeReasoningMatch[1];
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
  const claudeModeMatch = /^claude-mode:(default|plan)$/.exec(callback.data ?? "");
  if (claudeModeMatch) {
    const value = claudeModeMatch[1];
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
  const modelMatch = /^model:(sonnet|opus|haiku)$/.exec(callback.data ?? "");
  if (modelMatch) {
    try {
      const switched = switchModel(modelMatch[1]);
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
  const taskPageMatch = /^tasks-page:(\d+)$/.exec(callback.data ?? "");
  if (taskPageMatch) {
    await telegram("answerCallbackQuery", { callback_query_id: callback.id });
    scheduleInteractiveJob("Страница списка задач", callback.message.chat.id, () => sendThreadPicker({
        editMessage: callback.message,
        page: Number(taskPageMatch[1]),
      }));
    return;
  }
  const catalogSelection = parseTaskCatalogCallback(callback.data);
  if (catalogSelection) {
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
  if (callback.data === "thread:new") {
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
  if (callback.data === "thread:archive") {
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
  const approvalCallback = parseApprovalCallback(callback.data);
  if (!approvalCallback) {
    await telegram("answerCallbackQuery", {
      callback_query_id: callback.id,
      text: "Эта кнопка устарела",
      show_alert: true,
    });
    return;
  }
  const { key, action } = approvalCallback;
  const approval = pendingApprovals.get(key);
  if (!approval) {
    await telegram("answerCallbackQuery", { callback_query_id: callback.id, text: "Запрос уже закрыт" });
    return;
  }
  if (!approvalMatchesTelegramMessage(approval, callback)
    || (approval.runId && !taskRuns.values().some((run) => run.id === approval.runId))) {
    await telegram("answerCallbackQuery", {
      callback_query_id: callback.id,
      text: "Этот запрос больше не относится к активному ходу",
      show_alert: true,
    });
    return;
  }
  pendingApprovals.delete(key);
  const response = approval.kind === "mcp-elicitation"
    ? action === "decline"
      ? { action: "decline" }
      : approval.acceptResponse
    : codexApprovalResponse(approval.kind, action, approval.params);
  if (!response) {
    await telegram("answerCallbackQuery", {
      callback_query_id: callback.id,
      text: "Для этой формы нужен явный ввод данных",
      show_alert: true,
    });
    pendingApprovals.set(key, approval);
    return;
  }
  respondRpc(approval.rpcId, response);
  const decision = action === "once" ? "разрешено" : action === "session" ? "разрешено на сессию" : "отклонено";
  await telegram("answerCallbackQuery", { callback_query_id: callback.id, text: `Решение: ${decision}` });
  await telegram("editMessageReplyMarkup", {
    chat_id: callback.message.chat.id,
    message_id: callback.message.message_id,
    reply_markup: { inline_keyboard: [] },
  });
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

async function handleTelegramMessage(message) {
  const senderId = message.from?.id;
  if (!config.allowedUserIds.has(senderId)) {
    console.warn(`Rejected Telegram user ${senderId ?? "unknown"}`);
    return;
  }
  if (config.privateChatsOnly && message.chat?.type !== "private") {
    console.warn(`Rejected non-private Telegram chat ${message.chat?.id ?? "unknown"}`);
    return;
  }
  if (config.allowedChatIds && !config.allowedChatIds.has(message.chat?.id)) {
    console.warn(`Rejected Telegram chat ${message.chat?.id ?? "unknown"}`);
    return;
  }
  chatId = message.chat.id;
  const repliedMessageId = message.reply_to_message?.message_id;
  if (Number.isSafeInteger(repliedMessageId)) {
    const binding = await findMessageBinding(config.dataDir, message.chat.id, repliedMessageId);
    if (binding) {
      let activated;
      try {
        activated = await activateMessageBinding(binding);
      } catch (error) {
        await sendMessage(`Не удалось открыть задачу из этого сообщения: ${error.message}`);
        return;
      }
      if (activated.changed) {
        await sendTaskSwitchNotification();
      }
    }
  }
  if (message.photo || message.document?.mime_type?.startsWith("image/")) {
    const target = selectedTurnTarget(message.chat.id);
    await bindIncomingTaskMessage(
      message,
      message.caption?.trim() || "Изображение без подписи",
    );
    await enqueueBackgroundJob("image", { message, target }, target.chatId);
    return;
  }
  if (message.voice || message.audio) {
    const target = selectedTurnTarget(message.chat.id);
    await bindIncomingTaskMessage(message, "Голосовое сообщение");
    await enqueueBackgroundJob("voice", { message, target }, target.chatId);
    return;
  }
  const rawText = message.text?.trim();
  const text = MENU_COMMANDS.get(rawText) ?? rawText;
  if (!text) return;

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

async function pollTelegram() {
  let consecutiveFailures = 0;
  while (!stopping) {
    try {
      const updates = await telegram("getUpdates", {
        offset: updateOffset,
        timeout: 30,
        allowed_updates: ["message", "callback_query"],
      });
      consecutiveFailures = 0;
      for (const update of updates) {
        processingUpdateId = update.update_id;
        try {
          if (update.callback_query && isAllowedCallback(update.callback_query)) {
            await handleApprovalCallback(update.callback_query);
          } else if (update.message) {
            await handleTelegramMessage(update.message);
          }
        } catch (error) {
          console.error(`Telegram update ${update.update_id} failed:`, error.message);
          const targetChatId = update.message?.chat?.id ?? update.callback_query?.message?.chat?.id;
          if (Number.isSafeInteger(targetChatId)) {
            await sendMessageTo(
              targetChatId,
              `Не удалось обработать сообщение: ${error.message}`,
            ).catch(() => {});
          }
        }
        updateOffset = update.update_id + 1;
        await saveState();
        processingUpdateId = null;
        if (restartRequest && !restartRequest.waitingForRuns && !stopping) {
          await performRestart();
        }
        if (stopping) break;
      }
    } catch (error) {
      consecutiveFailures += 1;
      const retryDelayMs = telegramPollingRetryDelay(consecutiveFailures);
      if (shouldLogPollingFailure(consecutiveFailures)) {
        console.error(
          `Telegram polling error (${consecutiveFailures}; retry in ${retryDelayMs} ms):`,
          error.message,
        );
      }
      await delay(retryDelayMs);
    }
  }
}

function isAllowedCallback(callback) {
  const chat = callback.message?.chat;
  return config.allowedUserIds.has(callback.from?.id)
    && (!config.privateChatsOnly || chat?.type === "private")
    && (!config.allowedChatIds || config.allowedChatIds.has(chat?.id));
}

async function telegram(method, body) {
  return callTelegramJson({
    token,
    method,
    body,
    apiBaseUrl: config.telegramApiBaseUrl,
  });
}

function scheduleDeliveryOutboxFlush(delayMs = config.deliveryRetryIntervalSeconds * 1000) {
  if (deliveryOutboxTimer || stopping) return;
  deliveryOutboxTimer = setTimeout(() => {
    deliveryOutboxTimer = null;
    void flushDeliveryOutbox();
  }, delayMs);
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

async function telegramMultipart(method, body, fileField, filePath) {
  const form = new FormData();
  for (const [key, value] of Object.entries(body)) {
    if (value == null) continue;
    form.set(key, typeof value === "object" ? JSON.stringify(value) : String(value));
  }
  form.set(
    fileField,
    new Blob([await readFile(filePath)], { type: "image/png" }),
    path.basename(filePath),
  );
  try {
    const response = await fetch(`${config.telegramApiBaseUrl}/bot${token}/${method}`, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(40000),
    });
    const payload = await response.json();
    if (!payload.ok) {
      const error = new Error(`Telegram ${method}: ${payload.description ?? response.status}`);
      error.retryable = response.status === 429 || response.status >= 500;
      error.retryAfterMs = Number(payload.parameters?.retry_after ?? 0) * 1000;
      throw error;
    }
    return payload.result;
  } catch (error) {
    if (typeof error.retryable !== "boolean") error.retryable = true;
    throw error;
  }
}

async function sendStatusCard(
  text,
  extra = {},
  activeProviders = [],
  { targetChatId = chatId, provider = activeProvider } = {},
) {
  if (!targetChatId) return;
  const headerPath = path.join(
    STATUS_HEADER_DIR,
    randomStatusHeaderFileName(provider, activeProviders),
  );
  if (!existsSync(headerPath)) return sendMessageTo(targetChatId, text, extra);
  const caption = String(text);
  if (caption.length > 1000) {
    await telegramMultipart("sendPhoto", { chat_id: targetChatId }, "photo", headerPath);
    return sendMessageTo(targetChatId, caption, extra);
  }
  return telegramMultipart("sendPhoto", {
    chat_id: targetChatId,
    caption,
    ...extra,
  }, "photo", headerPath);
}

async function sendMessage(text, extra = {}) {
  if (!chatId) return;
  return sendMessageTo(chatId, text, extra);
}

async function sendMessageTo(targetChatId, text, extra = {}) {
  const options = Object.hasOwn(extra, "reply_markup")
    ? extra
    : { ...extra, reply_markup: BOT_MENU };
  return telegram("sendMessage", { chat_id: targetChatId, text: String(text), ...options });
}

async function sendLongMessage(text, {
  speechText = null,
  forceSpeechButton = false,
  maxParts = Number.POSITIVE_INFINITY,
} = {}) {
  const value = String(text);
  const speechId = rememberSpeechText(speechText, forceSpeechButton);
  const maximumLength = Number.isFinite(maxParts) ? TELEGRAM_LIMIT * Math.max(1, maxParts) : value.length;
  const truncated = value.length > maximumLength;
  const visible = truncated
    ? `${value.slice(0, Math.max(0, maximumLength - 80))}\n\n… вывод ограничен ${maxParts} сообщениями.`
    : value;
  for (let start = 0; start < visible.length; start += TELEGRAM_LIMIT) {
    const isLast = start + TELEGRAM_LIMIT >= visible.length;
    const extra = isLast && speechId
      ? { reply_markup: { inline_keyboard: [[{ text: "🔊 Озвучить", callback_data: `speech:${speechId}` }]] } }
      : {};
    await sendMessage(visible.slice(start, start + TELEGRAM_LIMIT), extra);
  }
}

function startTyping() {
  if (typingInterval || !chatId) return;
  const tick = () => telegram("sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => {});
  tick();
  typingInterval = setInterval(tick, 4000);
}

function stopTyping() {
  if (!typingInterval) return;
  clearInterval(typingInterval);
  typingInterval = null;
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
  if (selectedTaskWatchTimer) {
    clearTimeout(selectedTaskWatchTimer);
    selectedTaskWatchTimer = null;
  }
  for (const timer of queueTimers.values()) clearTimeout(timer);
  queueTimers.clear();
  for (const run of taskRuns.values()) {
    if (run.progressStartTimer) clearTimeout(run.progressStartTimer);
    if (run.progressTimer) clearTimeout(run.progressTimer);
    if (run.observerTimer) clearTimeout(run.observerTimer);
    if (run.claudeDrainTimer) clearTimeout(run.claudeDrainTimer);
    run.progressStartTimer = null;
    run.progressTimer = null;
    run.observerTimer = null;
    run.claudeDrainTimer = null;
  }
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
  stopTtsWorker();
  await runtimeCommandServer.close();
  await Promise.allSettled([
    stateWriteQueue,
    speechWriteQueue,
    bindingWriteQueue,
    taskSyncStore.save(),
    deliveryOutbox.waitForWrites(),
    backgroundJobStore.waitForWrites(),
  ]);
  await instanceGuard.release();
}

process.on("unhandledRejection", (error) => {
  console.error("Unhandled asynchronous error:", error);
});

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

await initializeProvider();
await recoverActiveRuns().catch(async (error) => {
  console.error("Cannot recover active tasks:", error.message);
  await sendMessage(`⚠️ Не удалось восстановить активные задачи: ${error.message}`).catch(() => {});
});
await restoreBackgroundJobs().catch(async (error) => {
  console.error("Cannot recover background jobs:", error.message);
  await sendMessage(`⚠️ Не удалось восстановить фоновые медиа-задачи: ${error.message}`).catch(() => {});
});
for (const item of queuedInputs.values()) scheduleQueuedInput(item, 500);
scheduleDeliveryOutboxFlush(1_000);
scheduleSelectedTaskWatch(500);
try {
  await telegram("setMyCommands", {
    commands: BOT_COMMANDS,
  });
} catch (error) {
  console.error("Cannot register Telegram commands:", error.message);
}
let restartFinalized = false;
if (restartRequest) {
  restartFinalized = await finalizeRestartMessage().catch((error) => {
    console.error("Cannot finalize bot restart:", error.message);
    return false;
  });
}
console.log(`Telegram/${providerTitle()} bridge ready for ${config.allowedUserIds.size} user(s); project: ${activeProjectRoot}`);
await pollTelegram();
