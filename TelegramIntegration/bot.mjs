import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync } from "node:fs";
import { mkdir, open, readdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
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
  formatTaskSwitchMessage,
  showLastMessageReplyMarkup,
  statusHeaderFileName,
} from "./status.mjs";
import { formatTaskTokenUsage } from "./token-usage.mjs";
import { telegramPrompt } from "./telegram-message.mjs";
import { parsePendingInputCallback, pendingInputKeyboard } from "./deferred-input.mjs";
import { appendMessageBindings, findMessageBinding } from "./message-bindings.mjs";
import {
  serializableTaskRun,
  TaskDismissalRegistry,
  TaskRunRegistry,
  taskRunKey,
  updateObservedResponse,
  updateTaskRunTitle,
} from "./task-runs.mjs";
import {
  codexTurnAnswer,
  listClaudeSessionSnapshots,
  readClaudeSessionSnapshot,
} from "./last-message.mjs";
import {
  catalogEntryIsSelected,
  claudeCatalogEntry,
  codexCatalogEntry,
  codexThreadRunning,
  mergeTaskCatalog,
  parseTaskCatalogCallback,
  readCodexRolloutActivity,
  runningTaskReplyMarkup,
  selectCodexTurn,
  taskCatalogCallback,
} from "./task-catalog.mjs";

const config = await loadConfig();
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
const INSTANCE_LOCK_FILE = path.join(config.dataDir, "bot.lock");
const SPEECH_TEXTS_FILE = path.join(config.dataDir, "speech-texts.json");
const TELEGRAM_LIMIT = 3900;
const THREAD_LIST_LIMIT = 10;
const TASK_PICKER_PAGE_SIZE = 8;
const PYTHON_EXE = config.pythonExe;
const TTS_PYTHON_EXE = config.ttsPythonExe;
const TRANSCRIBE_SCRIPT = path.join(import.meta.dirname, "transcribe.py");
const TTS_WORKER_SCRIPT = path.join(import.meta.dirname, "tts_worker.py");
const TTS_CACHE_DIR = path.join(INTEGRATION_ROOT, ".silero-models");
const AUDIO_DIR = config.audioDir;
const IMAGE_DIR = path.join(config.dataDir, "images");
const STATUS_HEADER_DIR = path.join(import.meta.dirname, "assets", "status");
const TTS_DIR = config.ttsDir;
const AGENT_ICONS = ["👾", "🦉", "🐙", "🕶️", "🚀", "⚡", "💻", "🔮", "🛰️", "🔥", "✨"];
const agentIcon = AGENT_ICONS[Math.floor(Math.random() * AGENT_ICONS.length)];
const BOT_COMMANDS = [
  { command: "agent", description: "Переключить Claude Code/Codex" },
  { command: "model", description: "Сменить модель" },
  { command: "reasoning", description: "Сменить мощь дум (Codex/Claude)" },
  { command: "mode", description: "Переключить Plan/Work (Codex/Claude)" },
  { command: "projects", description: "Сменить активный проект" },
  { command: "new", description: "Новый контекст" },
  { command: "tasks", description: "Список задач" },
  { command: "resume", description: "Выбрать существующую задачу" },
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

let instanceLockHandle = null;

function processExists(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function acquireInstanceLock() {
  try {
    instanceLockHandle = await open(INSTANCE_LOCK_FILE, "wx");
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const existingPid = Number.parseInt(await readFile(INSTANCE_LOCK_FILE, "utf8").catch(() => ""), 10);
    if (processExists(existingPid)) {
      throw new Error(`Telegram bot is already running (PID ${existingPid})`);
    }
    await unlink(INSTANCE_LOCK_FILE).catch(() => {});
    instanceLockHandle = await open(INSTANCE_LOCK_FILE, "wx");
  }
  await instanceLockHandle.writeFile(`${process.pid}\n`, "utf8");
}

async function releaseInstanceLock() {
  if (!instanceLockHandle) return;
  await instanceLockHandle.close().catch(() => {});
  instanceLockHandle = null;
  await unlink(INSTANCE_LOCK_FILE).catch(() => {});
}

await acquireInstanceLock();

let updateOffset = 0;
let chatId = null;
let activeProjectRoot = DEFAULT_PROJECT_ROOT;
const threadIdsByProvider = { codex: null, claude: null };
let threadId = null;
let activeThreadTitle = "";
let latestDiff = "";
let requestSequence = 1;
let approvalSequence = 1;
let stopping = false;
let autoApprove = config.autoApproveOnStart;
let codexRestarting = false;
let restartRequest = null;
let stateWriteQueue = Promise.resolve();
let bindingWriteQueue = Promise.resolve();
let ttsWorker = null;
let ttsLines = null;
let ttsSequence = 1;
let typingInterval = null;
const pendingRpc = new Map();
const pendingApprovals = new Map();
const threadTokenTotals = new Map();
const turnTokenUsage = new Map();
const turnTemporaryFiles = new Map();
const turnSpeechButtons = new Map();
const pendingTts = new Map();
const speechTexts = new Map();
const taskRuns = new TaskRunRegistry();
const dismissedExternalTasks = new TaskDismissalRegistry();
const pendingInputs = new Map();
const queuedInputs = new Map();
const queueTimers = new Map();
const taskDiffs = new Map();
const lastTaskMessages = new Map();
let taskCatalog = [];

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

async function bindRunMessage(run, message) {
  if (!run?.threadId || !Number.isSafeInteger(run.chatId) || !Number.isSafeInteger(message?.message_id)) return;
  const binding = {
    chatId: run.chatId,
    messageId: message.message_id,
    provider: run.provider,
    threadId: run.threadId,
    projectRoot: run.projectRoot,
    taskTitle: runTaskTitle(run),
    createdAt: new Date().toISOString(),
  };
  bindingWriteQueue = bindingWriteQueue
    .catch(() => {})
    .then(() => appendMessageBindings(config.dataDir, [binding]));
  await bindingWriteQueue;
}

async function sendRunMessage(run, text, extra = {}) {
  const message = await sendMessageTo(run.chatId, text, extra);
  await bindRunMessage(run, message).catch((error) => {
    console.error("Cannot bind task message:", error.message);
  });
  return message;
}

async function sendRunLongMessage(run, text, { speechText = null, forceSpeechButton = false } = {}) {
  const value = `🧵 ${runTaskTitle(run)}\n\n${String(text)}`;
  const speechId = rememberSpeechText(speechText, forceSpeechButton);
  for (let start = 0; start < value.length; start += TELEGRAM_LIMIT) {
    const isLast = start + TELEGRAM_LIMIT >= value.length;
    const extra = isLast && speechId
      ? { reply_markup: { inline_keyboard: [[{ text: "🔊 Озвучить", callback_data: `speech:${speechId}` }]] } }
      : {};
    await sendRunMessage(run, value.slice(start, start + TELEGRAM_LIMIT), extra);
  }
}

async function sendTaskSwitchNotification({ targetChatId = chatId, showLastMessage = true } = {}) {
  const task = {
    ...selectedTask(),
    chatId: targetChatId,
    taskTitle: activeThreadTitle,
  };
  const extra = { parse_mode: "HTML" };
  if (showLastMessage && task.threadId) extra.reply_markup = showLastMessageReplyMarkup();
  const message = await sendMessageTo(targetChatId, formatTaskSwitchMessage({
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

function rememberLastTaskMessage(run, text) {
  const value = String(text ?? "").trim();
  if (!run?.threadId || !value) return;
  lastTaskMessages.set(taskRunKey(run), {
    text: value,
    updatedAt: new Date().toISOString(),
  });
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
  threadTokenTotals.set(params.threadId, current);

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
  codexTaskSettings[id] = {
    model: codexModel,
    reasoningEffort: codexReasoningEffort,
  };
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
  codexTaskSettings[id] = resolved;
  if (isCodex() && id === threadId) {
    codexModel = resolved.model;
    codexReasoningEffort = resolved.reasoningEffort;
  }
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
  activeThreadTitle = threadTitle(result.thread ?? {});
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

try {
  const saved = JSON.parse(await readFile(STATE_FILE, "utf8"));
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
  if (CLAUDE_MODELS.includes(saved.claudeModel)) claudeModel = saved.claudeModel;
  if (typeof saved.codexModel === "string") codexModel = normalizeCodexModel(saved.codexModel);
  if (CODEX_REASONING_EFFORTS.includes(saved.codexReasoningEffort)) {
    codexReasoningEffort = saved.codexReasoningEffort;
  }
  if (saved.codexTaskSettings && typeof saved.codexTaskSettings === "object") {
    for (const [savedThreadId, settings] of Object.entries(saved.codexTaskSettings)) {
      if (!settings || typeof settings !== "object") continue;
      if (typeof settings.model !== "string" || !settings.model.trim()) continue;
      if (!CODEX_REASONING_EFFORTS.includes(settings.reasoningEffort)) continue;
      codexTaskSettings[savedThreadId] = {
        model: settings.model.trim(),
        reasoningEffort: settings.reasoningEffort,
      };
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
  if (Array.isArray(saved.dismissedExternalTasks)) {
    dismissedExternalTasks.restore(saved.dismissedExternalTasks);
  }
  for (const item of Array.isArray(saved.pendingInputs) ? saved.pendingInputs : []) {
    if (item?.id && item?.threadId && item?.provider) pendingInputs.set(item.id, item);
  }
  for (const item of Array.isArray(saved.queuedInputs) ? saved.queuedInputs : []) {
    if (item?.id && item?.threadId && item?.provider) queuedInputs.set(item.id, item);
  }
  if (saved.restartRequest && typeof saved.restartRequest === "object"
    && Number.isSafeInteger(saved.restartRequest.chatId)
    && Number.isSafeInteger(saved.restartRequest.messageId)) {
    restartRequest = {
      chatId: saved.restartRequest.chatId,
      messageId: saved.restartRequest.messageId,
      requestedAt: String(saved.restartRequest.requestedAt ?? ""),
      waitingForRuns: saved.restartRequest.waitingForRuns === true,
    };
  }
  const savedRuns = Array.isArray(saved.activeRuns)
    ? saved.activeRuns
    : saved.activeRun && typeof saved.activeRun === "object"
      ? [saved.activeRun]
      : [];
  for (const savedRun of savedRuns) {
    if (!savedRun || typeof savedRun !== "object" || savedRun.status !== "running") continue;
    taskRuns.add({
      ...savedRun,
      chatId: Number.isSafeInteger(savedRun.chatId) ? savedRun.chatId : chatId,
      responseText: String(savedRun.responseText ?? ""),
      observedInitialResponseText: typeof savedRun.observedInitialResponseText === "string"
        ? savedRun.observedInitialResponseText
        : String(savedRun.responseText ?? ""),
      observedResponseChanged: savedRun.observedResponseChanged === true,
      progressStage: String(savedRun.progressStage ?? "Восстановление задачи…"),
      progressReasoning: String(savedRun.progressReasoning ?? ""),
      lastProgressText: String(savedRun.lastProgressText ?? ""),
      progressMessageIds: Array.isArray(savedRun.progressMessageIds)
        ? savedRun.progressMessageIds.filter(Number.isSafeInteger)
        : Number.isSafeInteger(savedRun.progressMessageId)
          ? [savedRun.progressMessageId]
          : [],
      progressStartTimer: null,
      progressTimer: null,
      progressUpdateInFlight: false,
      process: null,
    });
  }
  if (activeProvider === "codex" && threadId) {
    if (codexTaskSettings[threadId]) restoreCodexTaskSettings(threadId);
    else rememberCodexTaskSettings(threadId);
  }
} catch (error) {
  if (error?.code !== "ENOENT") console.error("Cannot read state:", error.message);
}

async function findVscodeCodexExecutable() {
  if (process.platform !== "win32") return null;
  const extensionsDir = path.join(process.env.USERPROFILE ?? "", ".vscode", "extensions");
  let entries;
  try {
    entries = await readdir(extensionsDir, { withFileTypes: true });
  } catch {
    return null;
  }

  const candidates = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith("openai.chatgpt-")) continue;
    const executable = path.join(extensionsDir, entry.name, "bin", "windows-x86_64", "codex.exe");
    if (!existsSync(executable)) continue;
    const info = await stat(executable);
    candidates.push({ executable, mtimeMs: info.mtimeMs });
  }
  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);
  return candidates[0]?.executable ?? null;
}

async function resolveCodexExecutable() {
  if (config.codexExecutable) return config.codexExecutable;
  const vscodeExecutable = await findVscodeCodexExecutable();
  if (vscodeExecutable) return vscodeExecutable;
  if (process.platform !== "win32") return "codex";
  const explicit = path.join(process.env.USERPROFILE ?? "", ".codex", ".sandbox-bin", "codex.exe");
  if (existsSync(explicit)) return explicit;
  return "codex";
}

async function spawnCodex(args) {
  const command = await resolveCodexExecutable();
  console.error(`Starting Codex: ${command}`);
  return spawn(command, args, {
    cwd: activeProjectRoot,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
}

let codex = null;
let codexLines = null;

async function startCodexAppServer() {
  if (codex) return;
  codex = await spawnCodex(["app-server", "--stdio"]);
  codex.stderr.setEncoding("utf8");
  codex.stderr.on("data", (data) => console.error(`[codex] ${data.trimEnd()}`));
  codex.on("error", (error) => console.error("Codex app-server failed to start:", error.message));
  codex.on("exit", async (code, signal) => {
    console.error(`Codex app-server stopped (code=${code}, signal=${signal}).`);
    const error = new Error(`Codex app-server stopped (code=${code}, signal=${signal})`);
    for (const pending of pendingRpc.values()) pending.reject(error);
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
  });

  codexLines = createInterface({ input: codex.stdout });
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

function sendRpc(method, params = {}) {
  if (!codex) return Promise.reject(new Error("Codex App Server is not running"));
  const id = requestSequence++;
  const promise = new Promise((resolve, reject) => pendingRpc.set(id, { resolve, reject }));
  codex.stdin.write(`${JSON.stringify({ method, id, params })}\n`);
  return promise;
}

function sendNotification(method, params = {}) {
  if (!codex) throw new Error("Codex App Server is not running");
  codex.stdin.write(`${JSON.stringify({ method, params })}\n`);
}

function respondRpc(id, result) {
  if (!codex) throw new Error("Codex App Server is not running");
  codex.stdin.write(`${JSON.stringify({ id, result })}\n`);
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
    try {
      const result = await sendRpc("thread/resume", {
        threadId,
        approvalPolicy: "on-request",
        sandbox: "workspace-write",
      });
      if (!isWorkspaceThread(result.thread ?? {})) {
        throw new Error("saved thread belongs to another project");
      }
      activeThreadTitle = threadTitle(result.thread ?? {});
      applyCodexThreadSettings(threadId, result);
      if (!result.thread?.name) await nameTelegramThread(threadId);
      return;
    } catch (error) {
      console.error("Cannot resume saved thread:", error.message);
      threadId = null;
    }
  }
  await createThread();
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

function formatThread(thread) {
  const current = thread.id === threadId ? " (текущая)" : "";
  const updated = new Date(thread.updatedAt * 1000).toLocaleString("ru-RU");
  const project = activeProject().name;
  return `${threadTitle(thread)}${current}\nПроект: ${project}\nОбновлена: ${updated}\nID: ${thread.id}`;
}

async function refreshTaskCatalog() {
  const [codexResult, claudeResult] = await Promise.allSettled([
    listAllCodexThreads(),
    listClaudeSessionSnapshots(),
  ]);
  const entries = [];
  if (codexResult.status === "fulfilled") {
    const batchSize = 16;
    for (let start = 0; start < codexResult.value.length; start += batchSize) {
      const batch = codexResult.value.slice(start, start + batchSize);
      const values = await Promise.all(batch.map(async (thread) => {
        const project = findProject(thread.cwd);
        if (!project) return null;
        const rolloutRunning = thread.status?.type === "active"
          ? true
          : await readCodexRolloutActivity(thread.path).then((activity) => activity.running);
        return codexCatalogEntry(thread, project, { rolloutRunning });
      }));
      entries.push(...values.filter(Boolean));
    }
  } else {
    console.error("Cannot discover Codex tasks:", codexResult.reason?.message ?? codexResult.reason);
  }
  if (claudeResult.status === "fulfilled") {
    for (const snapshot of claudeResult.value) {
      const project = snapshot.cwd ? findProject(snapshot.cwd) : null;
      if (project && snapshot.sessionId) entries.push(claudeCatalogEntry(snapshot, project));
    }
  } else {
    console.error("Cannot discover Claude tasks:", claudeResult.reason?.message ?? claudeResult.reason);
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
  if (titleChanged) await saveState();
  return taskCatalog;
}

function taskPickerButtonText(entry) {
  const selected = catalogEntryIsSelected(entry, selectedTask()) ? "✓ " : "";
  const running = entry.running ? "⏳ " : "";
  const provider = entry.provider === "codex" ? "Codex" : "Claude";
  const project = config.showTaskProject ? `${entry.projectName} · ` : "";
  return `${selected}${running}${provider} · ${project}${entry.title}`.slice(0, 90);
}

async function sendThreadPicker({ editMessage = null, page = 0 } = {}) {
  const catalog = await refreshTaskCatalog();
  const pageCount = Math.max(1, Math.ceil(catalog.length / TASK_PICKER_PAGE_SIZE));
  const safePage = Math.max(0, Math.min(Number(page) || 0, pageCount - 1));
  const visible = catalog.slice(
    safePage * TASK_PICKER_PAGE_SIZE,
    (safePage + 1) * TASK_PICKER_PAGE_SIZE,
  );
  const keyboard = [[{
    text: `🟢 + Новая: ${providerTitle()} · ${activeProject().name}`,
    callback_data: "thread:new",
  }], ...visible.map((entry) => [{
    text: taskPickerButtonText(entry),
    callback_data: taskCatalogCallback(entry),
  }])];
  if (pageCount > 1) {
    const navigation = [];
    if (safePage > 0) navigation.push({ text: "←", callback_data: `tasks-page:${safePage - 1}` });
    navigation.push({ text: `${safePage + 1}/${pageCount}`, callback_data: `tasks-page:${safePage}` });
    if (safePage + 1 < pageCount) navigation.push({ text: "→", callback_data: `tasks-page:${safePage + 1}` });
    keyboard.push(navigation);
  }
  if (isCodex() && threadId) {
    keyboard.push([{
      text: "❌ Архивировать текущую задачу",
      callback_data: "thread:archive",
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
    callback_data: `p:${index}`,
  }]);
  await sendMessage(
    `Активный проект: ${project.name}\n${activeProjectRoot}\n\nВыберите проект:`,
    { reply_markup: { inline_keyboard: keyboard } },
  );
}

async function sendAgentPicker() {
  const keyboard = [
    [{ text: `${!isCodex() ? "✓ " : ""}Claude Code`, callback_data: "engine:claude" }],
    [{ text: `${isCodex() ? "✓ " : ""}Codex`, callback_data: "engine:codex" }],
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
      callback_data: `codex-model:${model.value}`,
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
    callback_data: `model:${value}`,
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
  activeThreadTitle = threadTitle(result.thread ?? {});
  latestDiff = taskDiffs.get(taskRunKey(selectedTask())) ?? "";
  await saveState();
  if (notify) {
    await sendTaskSwitchNotification();
  }
  return true;
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
  if (isCodex()) restoreCodexTaskSettings(threadId);
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
    ? { reply_markup: showLastMessageReplyMarkup() }
    : {});
  if (task) {
    await bindRunMessage(task, message).catch((error) => {
      console.error("Cannot bind archive result message:", error.message);
    });
  }
  return message;
}

async function sendStatus() {
  const project = activeProject();
  let catalog = taskCatalog;
  try {
    catalog = await refreshTaskCatalog();
  } catch (error) {
    console.error("Cannot refresh task catalog for status:", error.message);
    catalog = mergeTaskCatalog(taskCatalog, taskRuns.values());
  }
  let task = "Не выбрана";
  if (threadId) {
    const current = catalog.find((entry) => catalogEntryIsSelected(entry, selectedTask()));
    task = current?.title || activeThreadTitle || `${providerTitle()} · ${threadId.slice(0, 8)}`;
  }

  let limits;
  try {
    limits = isCodex()
      ? formatCodexRateLimits(await sendRpc("account/rateLimits/read"))
      : formatClaudeRateLimits(await readClaudeRateLimits());
  } catch (error) {
    console.error(`Cannot read ${providerTitle()} limits for status:`, error.message);
    limits = `Не удалось получить: ${error.message}`;
  }

  const runningTasks = catalog
    .filter((entry) => entry.running)
    .map((entry) => `${entry.provider === "codex" ? "Codex" : "Claude"} · ${entry.projectName} · ${entry.title}`);
  const selectedBusy = catalog.some((entry) => (
    entry.running && catalogEntryIsSelected(entry, selectedTask())
  ));
  const statusText = formatStatusMessage({
    provider: isCodex() ? "CODEX" : "CLAUDE",
    busy: selectedBusy,
    runningTasks,
    model: isCodex() ? codexModelLabel(codexModel) : CLAUDE_MODEL_LABELS[claudeModel],
    reasoning: CODEX_REASONING_LABELS[isCodex() ? codexReasoningEffort : claudeReasoningEffort],
    mode: CODEX_COLLABORATION_MODE_LABELS[isCodex() ? codexCollaborationMode : claudeCollaborationMode],
    task,
    project: config.showProjectButton ? project.name : null,
    limits,
  });
  const replyMarkup = runningTaskReplyMarkup(catalog, selectedTask());
  await sendStatusCard(statusText, replyMarkup.inline_keyboard.length
    ? { parse_mode: "HTML", reply_markup: replyMarkup }
    : { parse_mode: "HTML" });
}

async function sendReasoningPicker() {
  const current = isCodex() ? codexReasoningEffort : claudeReasoningEffort;
  const prefix = isCodex() ? "codex-reasoning" : "claude-reasoning";
  const keyboard = CODEX_REASONING_EFFORTS.map((value) => [{
    text: `${value === current ? "✓ " : ""}${CODEX_REASONING_LABELS[value]}`,
    callback_data: `${prefix}:${value}`,
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
    callback_data: `${prefix}:${value}`,
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
  const savedCodexSettings = provider === "codex"
    ? codexTaskSettings[targetThreadId] ?? {}
    : {};
  const modelId = provider === "codex"
    ? savedCodexSettings.model ?? (targetThreadId === threadId ? codexModel : defaultCodexModel)
    : claudeModel;
  const reasoningId = provider === "codex"
    ? savedCodexSettings.reasoningEffort
      ?? (targetThreadId === threadId ? codexReasoningEffort : defaultCodexReasoningEffort)
    : claudeReasoningEffort;
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
    collaborationMode: provider === "codex" ? codexCollaborationMode : claudeCollaborationMode,
    responseText: "",
    status: "running",
    startedAt: new Date().toISOString(),
    progressMessageIds: [],
    progressStage: "Задача принята.",
    progressReasoning: "",
    lastProgressText: "",
    progressStartTimer: null,
    progressTimer: null,
    progressUpdateInFlight: false,
    latestDiff: "",
    process: null,
  };
  dismissedExternalTasks.delete(run);
  taskRuns.add(run);
  taskDiffs.set(taskRunKey(run), "");
  if (isSelectedRun(run)) latestDiff = "";
  await saveState();
  run.progressStartTimer = setTimeout(() => {
    run.progressStartTimer = null;
    void startProgressMessage(run);
  }, 3000);
  return run;
}

async function startProgressMessage(run, { forceNew = false } = {}) {
  if (!run || run.status !== "running" || (!forceNew && run.progressMessageIds.length)) return;
  const initialProgress = renderProgress(run);
  const message = await sendRunMessage(run, initialProgress);
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

function setProgressStage(run, stage) {
  if (!run) return;
  const value = String(stage ?? "").trim();
  if (value) run.progressStage = value;
  scheduleProgressUpdate(run);
}

function appendProgressReasoning(run, delta) {
  if (!run) return;
  run.progressReasoning += String(delta ?? "");
  if (run.progressReasoning.length > 5000) run.progressReasoning = run.progressReasoning.slice(-5000);
  scheduleProgressUpdate(run);
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
    model: run?.model ?? fallbackModel,
    reasoning: run?.reasoning ?? fallbackReasoning,
    task: runTaskTitle(run),
    project: config.showProjectButton ? runProject(run).name : null,
  });
  const parts = [heading, run?.progressStage || "Выполняется…"];
  if (done) return parts.join("\n\n").slice(0, TELEGRAM_LIMIT);
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

function scheduleProgressUpdate(run) {
  if (!run?.progressMessageIds.length || run.progressTimer) return;
  run.progressTimer = setTimeout(() => {
    run.progressTimer = null;
    void flushProgressUpdate(run);
  }, 1500);
}

async function flushProgressUpdate(run, done = false) {
  if (!run?.progressMessageIds.length || run.progressUpdateInFlight) return;
  const text = renderProgress(run, done);
  if (text === run.lastProgressText) return;
  run.progressUpdateInFlight = true;
  try {
    const retained = [];
    for (const messageId of run.progressMessageIds) {
      try {
        await telegram("editMessageText", { chat_id: run.chatId, message_id: messageId, text });
        retained.push(messageId);
      } catch (error) {
        if (String(error.message).includes("message is not modified")) {
          retained.push(messageId);
        } else {
          console.error(`Cannot update task progress message ${messageId}:`, error.message);
        }
      }
    }
    run.progressMessageIds = retained;
    run.lastProgressText = text;
    await saveState();
  } finally {
    run.progressUpdateInFlight = false;
  }
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
  if (run.observerTimer) {
    clearTimeout(run.observerTimer);
    run.observerTimer = null;
  }
  taskRuns.remove(run);
  run.status = "completed";
  run.process = null;
  if (!taskRuns.size) stopTyping();
  await saveState();
  if (restartRequest?.waitingForRuns && !restartBlockingRuns().length && !stopping) {
    setTimeout(() => void performRestart(), 0);
  }
}

async function taskIsExternallyActive(target) {
  if (!target?.threadId) return false;
  try {
    if (target.provider === "codex") {
      if (!codex) {
        await startCodexAppServer();
        await initializeCodex({ attachSelectedThread: false });
      }
      const result = await sendRpc("thread/read", { threadId: target.threadId, includeTurns: true });
      return codexThreadRunning(result.thread);
    }
    return Boolean((await readClaudeSessionSnapshot(target.threadId))?.active);
  } catch (error) {
    console.error(`Cannot check ${target.provider} task activity:`, error.message);
    return true;
  }
}

async function deferConflictingInput(input, temporaryFiles, { forceSpeechButton = false } = {}) {
  const item = {
    id: randomUUID(),
    chatId,
    provider: activeProvider,
    projectRoot: activeProjectRoot,
    threadId,
    taskTitle: activeThreadTitle,
    input,
    temporaryFiles,
    forceSpeechButton,
    createdAt: new Date().toISOString(),
  };
  pendingInputs.set(item.id, item);
  await saveState();
  const preview = inputPreview(input);
  const message = await sendMessageTo(chatId,
    "Выбранная задача уже выполняется. Новое сообщение сохранено и не потеряно."
      + `${preview ? `\n\n${preview.slice(0, 700)}` : ""}\n\nЧто сделать?`,
    { reply_markup: pendingInputKeyboard(item.id) });
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
    const result = await sendRpc("turn/start", {
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
    });
    const previousTurnId = run.turnId;
    run.turnId = result.turn.id;
    taskRuns.reindex(run, { turnId: previousTurnId });
    await saveState();
    turnSpeechButtons.set(run.turnId, forceSpeechButton);
    if (temporaryFiles.length) turnTemporaryFiles.set(run.turnId, temporaryFiles);
    if (!turnTokenUsage.has(run.turnId)) {
      turnTokenUsage.set(run.turnId, { usage: emptyTokenUsage(), reported: false });
    }
    startTyping();
  } catch (error) {
    await Promise.all(temporaryFiles.map((file) => unlink(file).catch(() => {})));
    await finishProgress(run, `Ошибка запуска: ${error.message}`);
    await completeRun(run);
    throw error;
  }
}

async function startTurn(input, temporaryFiles = [], { forceSpeechButton = false } = {}) {
  const target = {
    provider: activeProvider,
    projectRoot: activeProjectRoot,
    threadId,
    taskTitle: activeThreadTitle,
    chatId,
  };
  if (taskRuns.forTask(target) || await taskIsExternallyActive(target)) {
    return deferConflictingInput(input, temporaryFiles, { forceSpeechButton });
  }
  if (target.provider === "codex") {
    try {
      await syncActiveCodexThreadSettings();
    } catch (error) {
      console.error("Cannot sync Codex thread settings before turn:", error.message);
    }
  }
  const run = await beginRun(input, target);
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
  };
  if (taskRuns.forTask(target) || await taskIsExternallyActive(target)) {
    scheduleQueuedInput(item);
    return;
  }

  queuedInputs.delete(id);
  await saveState();
  try {
    const run = await beginRun(item.input, target);
    await launchTurn(run, item.input, item.temporaryFiles ?? [], {
      forceSpeechButton: item.forceSpeechButton === true,
    });
    await updateDeferredMessage(item, `▶️ Сообщение из очереди отправлено в задачу «${item.taskTitle}».`);
  } catch (error) {
    await updateDeferredMessage(item, `⚠️ Не удалось запустить сообщение из очереди: ${error.message}`);
    await sendMessageTo(item.chatId, `Не удалось выполнить сообщение из очереди: ${error.message}`);
  }
}

function resolveClaudeInvocation() {
  const requested = config.claudeExecutable || "claude";
  if (process.platform !== "win32") return { command: requested, prefixArgs: [] };

  const nativeCandidates = [];
  if (requested === "claude") {
    nativeCandidates.push(path.join(process.env.USERPROFILE ?? "", ".local", "bin", "claude.exe"));
  } else if (/\.exe$/i.test(requested)) {
    nativeCandidates.push(requested);
  }
  const shimDirectory = /\.(cmd|bat)$/i.test(requested)
    ? path.dirname(path.resolve(requested))
    : path.join(process.env.APPDATA ?? "", "npm");
  if (requested === "claude" || /\.(cmd|bat)$/i.test(requested)) {
    nativeCandidates.push(
      path.join(shimDirectory, "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe"),
    );
  }
  const nativeExecutable = nativeCandidates.find((candidate) => candidate && existsSync(candidate));
  if (nativeExecutable) return { command: nativeExecutable, prefixArgs: [] };

  const npmCli = path.join(shimDirectory, "node_modules", "@anthropic-ai", "claude-code", "cli.js");
  if (existsSync(npmCli)) return { command: process.execPath, prefixArgs: [npmCli] };
  const npmCliWrapper = path.join(shimDirectory, "node_modules", "@anthropic-ai", "claude-code", "cli-wrapper.cjs");
  if (existsSync(npmCliWrapper)) return { command: process.execPath, prefixArgs: [npmCliWrapper] };
  return { command: requested, prefixArgs: [] };
}

function spawnCapture(command, args, options = {}) {
  return new Promise((resolve) => {
    const worker = spawn(command, args, {
      cwd: activeProjectRoot,
      windowsHide: true,
      ...options,
    });
    let stdout = "";
    let stderr = "";
    worker.stdout?.setEncoding("utf8");
    worker.stderr?.setEncoding("utf8");
    worker.stdout?.on("data", (chunk) => { stdout += chunk; });
    worker.stderr?.on("data", (chunk) => { stderr += chunk; });
    worker.on("error", (error) => resolve({ code: null, stdout, stderr, error }));
    worker.on("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

async function readGitDiff(projectRoot = activeProjectRoot) {
  const result = await spawnCapture("git", ["diff", "--no-ext-diff", "--"], { cwd: projectRoot });
  return result.code === 0 ? result.stdout.trim() : "";
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
  const invocation = resolveClaudeInvocation();
  const worker = spawn(invocation.command, [...invocation.prefixArgs, ...args], {
    cwd: run.projectRoot,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    env: {
      ...process.env,
      MAX_THINKING_TOKENS: String(claudeThinkingTokens(run.reasoningId)),
    },
  });
  run.process = worker;
  run.pid = worker.pid ?? null;
  await saveState();
  startTyping();
  let stdout = "";
  let stderr = "";
  let streamedResult = null;
  let claudeFailureText = "";
  let peakThinkingTokens = 0;
  let settled = false;
  worker.stdout.setEncoding("utf8");
  worker.stderr.setEncoding("utf8");
  const outputLines = createInterface({ input: worker.stdout });
  outputLines.on("line", (line) => {
    stdout += `${line}\n`;
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
      scheduleProgressUpdate(run);
    }
    // Claude Code headless не раскрывает текст мышления, поэтому показываем
    // индикатор с оценкой числа «думательных» токенов. Если текст всё же придёт
    // (в будущих версиях) — выводим и его в блок рассуждений.
    if (parsed.thinkingDelta) appendProgressReasoning(run, parsed.thinkingDelta);
    if (parsed.thinkingTokens != null) {
      peakThinkingTokens = Math.max(peakThinkingTokens, parsed.thinkingTokens);
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
      claudeFailureText = `Исчерпан лимит Claude. Сброс: ${resetText}.`;
      setProgressStage(run, claudeFailureText);
    }
    if (parsed.event?.type === "assistant" && parsed.event.error) {
      const messageText = parsed.event.message?.content
        ?.filter((item) => item?.type === "text")
        .map((item) => item.text)
        .join("\n")
        .trim();
      if (messageText) claudeFailureText = messageText;
    }
    const streamEvent = parsed.event?.type === "stream_event" ? parsed.event.event : null;
    if (streamEvent?.type === "content_block_start" && streamEvent.content_block?.type === "tool_use") {
      setProgressStage(run, `Claude использует инструмент ${streamEvent.content_block.name ?? ""}…`);
    }
    if (parsed.result) streamedResult = parsed.result;
  });
  worker.stderr.on("data", (chunk) => { stderr += chunk; });

  const finish = async (code, spawnError = null) => {
    if (settled) return;
    settled = true;
    run.process = null;
    const files = turnTemporaryFiles.get(turnId) ?? [];
    turnTemporaryFiles.delete(turnId);
    await Promise.all(files.map((file) => unlink(file).catch(() => {})));

    try {
      if (spawnError) throw spawnError;
      const result = streamedResult ?? (stdout.trim() ? parseClaudeResult(stdout) : null);
      if (!result && code !== 0) {
        throw new Error(claudeFailureText || stderr.trim() || `Claude Code завершился с кодом ${code}`);
      }
      if (!result) throw new Error("Claude Code не вернул результат");
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
      run.latestDiff = await readGitDiff(run.projectRoot);
      taskDiffs.set(taskRunKey(run), run.latestDiff);
      if (isSelectedRun(run)) latestDiff = run.latestDiff;
      const answer = String(result.result ?? "").trim()
        || claudeFailureText
        || (result.is_error ? "Claude Code завершил задачу с ошибкой." : "Задача завершена.");
      const failed = code !== 0 || result.is_error;
      await finishProgress(run, failed ? `Claude остановлен: ${answer}` : "Задача завершена.");
      const response = failed ? `Ошибка Claude Code: ${answer}` : answer;
      rememberLastTaskMessage(run, response);
      await sendRunLongMessage(run, `${response}\n\n${formatClaudeUsage(result, peakThinkingTokens)}`, { speechText: answer, forceSpeechButton });
      if (run.latestDiff) await sendRunMessage(run, "Изменения этой задачи доступны после её выбора по команде /diff.");
      await completeRun(run);
    } catch (error) {
      await finishProgress(run, `Claude остановлен: ${error.message}`);
      await sendRunLongMessage(run, `Ошибка Claude Code: ${error.message}`);
      await completeRun(run);
    }
  };

  worker.on("error", (error) => void finish(null, error));
  worker.on("exit", (code) => void finish(code));
}

async function handleCodexMessage(message) {
  if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
    const pending = pendingRpc.get(message.id);
    if (pending) {
      pendingRpc.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message ?? JSON.stringify(message.error)));
      else pending.resolve(message.result);
    }
    return;
  }

  const { method, params = {}, id } = message;
  const eventTurnId = params.turn?.id ?? params.turnId ?? null;
  let run = taskRuns.forEvent({
    turnId: eventTurnId,
    threadId: params.threadId,
    provider: "codex",
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
      turnTokenUsage.set(eventTurnId, { usage: emptyTokenUsage(), reported: false });
    }
  }
  if (method === "thread/tokenUsage/updated") trackTurnTokenUsage(params);
  if (method === "turn/diff/updated" && run) {
    run.latestDiff = params.diff ?? run.latestDiff;
    taskDiffs.set(taskRunKey(run), run.latestDiff);
    if (isSelectedRun(run)) latestDiff = run.latestDiff;
  }
  if (method === "item/agentMessage/delta" && run) {
    run.responseText += params.delta ?? "";
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
  } else if (method === "turn/completed") {
    if (!run) {
      console.warn(`Completed Codex turn ${eventTurnId ?? "unknown"} has no registered task run`);
      return;
    }
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
    const answer = run.responseText.trim() || (error ? `Ошибка: ${error}` : `Задача завершена: ${status}`);
    await finishProgress(run, error || status === "failed" ? `Задача завершилась с ошибкой: ${error ?? status}` : "Задача завершена.");
    rememberLastTaskMessage(run, answer);
    await sendRunLongMessage(run, `${answer}\n\n${tokenSummary}`, { speechText: answer, forceSpeechButton });
    if (run.latestDiff) await sendRunMessage(run, "Изменения этой задачи доступны после её выбора по команде /diff.");
    await completeRun(run);
  }
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

function codexTurnSnapshot(turn) {
  const items = Array.isArray(turn?.items) ? turn.items : [];
  const lastItem = items.at(-1);
  const answer = recoveredCodexAnswer(turn);
  return {
    answer,
    reasoning: "",
    completed: turn?.status !== "inProgress",
    active: turn?.status === "inProgress",
    stage: turn?.status === "inProgress"
      ? describeCodexItem(lastItem, false)
      : turn?.status === "completed"
        ? "Задача завершена."
        : `Задача остановлена: ${turn?.status ?? "неизвестно"}.`,
  };
}

function observedRun(binding, targetChatId, snapshot, turnId = null) {
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
    model: binding.provider === "claude" ? "Claude Code" : "Codex",
    modelId: null,
    reasoning: "Подключённый ход",
    reasoningId: null,
    collaborationMode: "default",
    responseText: snapshot.answer ?? "",
    observedInitialResponseText: String(snapshot.answer ?? ""),
    observedResponseChanged: false,
    status: "running",
    startedAt: new Date().toISOString(),
    progressMessageIds: [],
    progressStage: snapshot.stage ?? "Подключение к выполняющейся задаче…",
    progressReasoning: snapshot.reasoning ?? "",
    lastProgressText: "",
    progressStartTimer: null,
    progressTimer: null,
    progressUpdateInFlight: false,
    observerTimer: null,
    observer: true,
    latestDiff: "",
    process: null,
  };
  taskRuns.add(run);
  return run;
}

function updateObservedRun(run, snapshot) {
  const responseChanged = updateObservedResponse(run, snapshot?.answer);
  run.progressReasoning = String(snapshot?.reasoning ?? run.progressReasoning);
  run.progressStage = String(snapshot?.stage ?? run.progressStage);
  scheduleProgressUpdate(run);
  return responseChanged;
}

async function readCodexTaskSnapshot(run) {
  const result = await sendRpc("thread/read", { threadId: run.threadId, includeTurns: true });
  const turns = Array.isArray(result.thread?.turns) ? result.thread.turns : [];
  const activity = await readCodexRolloutActivity(result.thread?.path);
  const turn = selectCodexTurn(turns, {
    requestedTurnId: run.turnId,
    rolloutActiveTurnIds: activity.activeTurnIds,
  });
  if (!turn) return null;
  const snapshot = {
    ...codexTurnSnapshot(turn),
    turnId: turn.id,
  };
  return snapshot;
}

async function finishObservedRun(run, snapshot) {
  if (taskRuns.forTask(run) !== run) return;
  const responseChanged = updateObservedRun(run, snapshot);
  const answer = String(snapshot?.answer ?? "").trim()
    || savedLastTaskMessage(run)
    || "Ход завершён без текстового ответа.";
  await finishProgress(run, snapshot?.stage ?? "Задача завершена.");
  rememberLastTaskMessage(run, answer);
  if (responseChanged) await sendRunLongMessage(run, answer, { speechText: answer });
  await completeRun(run);
}

function scheduleObservedRun(run) {
  if (!run?.observer || run.observerTimer || taskRuns.forTask(run) !== run) return;
  run.observerTimer = setTimeout(() => {
    run.observerTimer = null;
    void pollObservedRun(run);
  }, 1500);
}

async function pollObservedRun(run) {
  if (!run?.observer || taskRuns.forTask(run) !== run) return;
  try {
    const snapshot = run.provider === "codex"
      ? await readCodexTaskSnapshot(run)
      : await readClaudeSessionSnapshot(run.threadId);
    if (!snapshot) {
      setProgressStage(run, "Ожидаю данные текущего хода…");
      scheduleObservedRun(run);
      return;
    }
    if (snapshot.turnId && snapshot.turnId !== run.turnId) {
      const previousTurnId = run.turnId;
      run.turnId = snapshot.turnId;
      taskRuns.reindex(run, { turnId: previousTurnId });
    }
    if (snapshot.completed) {
      await finishObservedRun(run, snapshot);
      return;
    }
    updateObservedRun(run, snapshot);
    scheduleObservedRun(run);
  } catch (error) {
    console.error(`Cannot observe ${run.provider} task ${run.threadId}:`, error.message);
    setProgressStage(run, `Не удалось обновить ход: ${error.message}`);
    scheduleObservedRun(run);
  }
}

async function showTaskMessage(binding, targetChatId) {
  const task = {
    provider: binding.provider,
    projectRoot: binding.projectRoot,
    threadId: binding.threadId,
  };
  if (dismissedExternalTasks.delete(task)) await saveState();
  const running = taskRuns.forTask(task);
  if (running) {
    const selectedTitle = isSelectedRun(running) ? activeThreadTitle : null;
    const catalogTitle = taskCatalog.find((entry) => catalogEntryIsSelected(entry, running))?.title;
    if (updateTaskRunTitle(running, selectedTitle || catalogTitle || binding.taskTitle)) {
      await saveState();
    }
    running.chatId = targetChatId;
    await startProgressMessage(running, { forceNew: true });
    return;
  }

  if (binding.provider === "codex") {
    const probe = { ...binding, chatId: targetChatId, turnId: null };
    const snapshot = await readCodexTaskSnapshot(probe);
    if (snapshot?.active) {
      const run = observedRun(binding, targetChatId, snapshot, snapshot.turnId);
      await startProgressMessage(run, { forceNew: true });
      scheduleObservedRun(run);
      await saveState();
      return;
    }
    const answer = snapshot?.answer || savedLastTaskMessage(task);
    if (answer) {
      rememberLastTaskMessage(task, answer);
      await sendRunLongMessage({ ...task, chatId: targetChatId, taskTitle: binding.taskTitle }, answer);
      await saveState();
      return;
    }
  } else {
    const snapshot = await readClaudeSessionSnapshot(binding.threadId);
    if (snapshot?.active) {
      const run = observedRun(binding, targetChatId, snapshot);
      await startProgressMessage(run, { forceNew: true });
      scheduleObservedRun(run);
      await saveState();
      return;
    }
    const answer = snapshot?.answer || savedLastTaskMessage(task);
    if (answer) {
      rememberLastTaskMessage(task, answer);
      await sendRunLongMessage({ ...task, chatId: targetChatId, taskTitle: binding.taskTitle }, answer);
      await saveState();
      return;
    }
  }

  await sendRunMessage(
    { ...task, chatId: targetChatId, taskTitle: binding.taskTitle },
    "У этой задачи пока нет выполняющегося хода или сохранённого ответа.",
  );
}

async function recoverTaskRun(run) {
  if (run.observer) {
    const snapshot = run.provider === "codex" && codex
      ? await readCodexTaskSnapshot(run)
      : run.provider === "claude"
        ? await readClaudeSessionSnapshot(run.threadId)
        : null;
    if (snapshot?.active) {
      updateObservedRun(run, snapshot);
      scheduleObservedRun(run);
      startTyping();
      await saveState();
      return;
    }
    if (snapshot?.completed) {
      await finishObservedRun(run, snapshot);
      return;
    }
  }
  if (run.provider !== "codex" || !codex) {
    await finishProgress(run, "Локальный процесс прервался при перезапуске бота.");
    await sendRunMessage(
      run,
      `⚠️ Запуск ${run.provider === "claude" ? "Claude" : "Codex"} был прерван. `
        + `Контекст ${run.threadId ?? "не успел получить ID"} сохранён и доступен для продолжения.`,
    );
    await completeRun(run);
    return;
  }

  const result = await sendRpc("thread/read", { threadId: run.threadId, includeTurns: true });
  const turn = result.thread?.turns?.find((item) => item.id === run.turnId)
    ?? result.thread?.turns?.at(-1);
  if (!turn) {
    await finishProgress(run, "Не удалось найти сохранённый запуск.");
    await completeRun(run);
    return;
  }
  run.responseText = recoveredCodexAnswer(turn) || run.responseText;
  if (turn.status === "inProgress") {
    const previousTurnId = run.turnId;
    run.turnId = turn.id;
    taskRuns.reindex(run, { turnId: previousTurnId });
    setProgressStage(run, "Подключено к продолжающейся задаче.");
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
  rememberLastTaskMessage(run, answer);
  await sendRunLongMessage(run, answer, { speechText: answer });
  await completeRun(run);
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
    respondRpc(rpcId, { decision: "accept" });
    return;
  }
  const key = String(approvalSequence++);
  pendingApprovals.set(key, { rpcId, kind, runId: run?.id ?? null });
  const decisions = [
    [{ text: "✅ Разрешить", callback_data: `a:${key}:once` }],
    [{ text: "✅ На сессию", callback_data: `a:${key}:session` }],
    [{ text: "❌ Отклонить", callback_data: `a:${key}:decline` }],
  ];
  const extra = { reply_markup: { inline_keyboard: decisions } };
  if (run) await sendRunMessage(run, text, extra);
  else await sendMessage(text, extra);
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
  ]);
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
      { text: autoApprove ? "⚡ Авто: включено" : "⚡ Включить авто", callback_data: "approval-mode:auto" },
      { text: autoApprove ? "🔐 Вернуть ручной" : "🔐 Ручной: включён", callback_data: "approval-mode:manual" },
    ]],
  };
}

function restartBlockingRuns() {
  return taskRuns.values().filter((run) => !run.observer);
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
  restartRequest.waitingForRuns = false;
  await updateRestartMessage("🔄 Перезапускаю бота…").catch(() => {});
  await saveState();
  await releaseInstanceLock();
  const replacement = spawn(
    process.execPath,
    [path.join(import.meta.dirname, "bot.mjs")],
    {
      cwd: INTEGRATION_ROOT,
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    },
  );
  replacement.unref();
  stopping = true;
  codex?.kill();
  for (const run of restartBlockingRuns()) run.process?.kill();
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
  const message = await sendMessage(blockingRuns.length
    ? `🔄 Перезапущу бота после завершения выполняющихся задач: ${blockingRuns.length}.`
    : "🔄 Перезапускаю бота…");
  if (!message?.message_id) throw new Error("Telegram не вернул ID сообщения перезапуска");
  restartRequest = {
    chatId,
    messageId: message.message_id,
    requestedAt: new Date().toISOString(),
    waitingForRuns: blockingRuns.length > 0,
  };
  await saveState();
  if (!blockingRuns.length) await performRestart();
}

async function transcribeVoice(message) {
  if (!config.voiceEnabled) {
    await sendMessage("Голосовые сообщения отключены в конфигурации.");
    return;
  }
  const media = message.voice ?? message.audio;
  if (!media?.file_id) return;
  if ((media.file_size ?? 0) > 20 * 1024 * 1024) {
    await sendMessage("Голосовой файл слишком большой. Максимальный размер — 20 МБ.");
    return;
  }

  await sendMessage("🎙 Распознаю голосовое сообщение…");
  await mkdir(AUDIO_DIR, { recursive: true });
  const extension = message.voice ? ".ogg" : path.extname(media.file_name ?? "") || ".audio";
  const audioPath = path.join(AUDIO_DIR, `${randomUUID()}${extension}`);
  try {
    const file = await telegram("getFile", { file_id: media.file_id });
    const response = await fetch(`https://api.telegram.org/file/bot${token}/${file.file_path}`, {
      signal: AbortSignal.timeout(60000),
    });
    if (!response.ok) throw new Error(`Telegram file download: HTTP ${response.status}`);
    await writeFile(audioPath, Buffer.from(await response.arrayBuffer()));
    const transcript = await runTranscription(audioPath);
    if (!transcript) {
      await sendMessage("Не удалось распознать речь в сообщении.");
      return;
    }
    await sendMessage(`📝 Распознано:\n${transcript}`);
    await startTurn(telegramPrompt(message, transcript), [], { forceSpeechButton: true });
  } catch (error) {
    await sendMessage(`Ошибка распознавания: ${error.message}`);
  } finally {
    await unlink(audioPath).catch(() => {});
  }
}

async function analyzeImage(message) {
  const photo = message.photo?.at(-1);
  const document = message.document?.mime_type?.startsWith("image/") ? message.document : null;
  const media = photo ?? document;
  if (!media?.file_id) return;
  if ((media.file_size ?? 0) > 20 * 1024 * 1024) {
    await sendMessage("Изображение слишком большое. Максимальный размер — 20 МБ.");
    return;
  }

  await sendMessage("🖼 Изображение получено, начинаю анализ…");
  await mkdir(IMAGE_DIR, { recursive: true });
  let imagePath;
  try {
    const file = await telegram("getFile", { file_id: media.file_id });
    const extension = path.extname(document?.file_name ?? file.file_path ?? "") || ".jpg";
    imagePath = path.join(IMAGE_DIR, `${randomUUID()}${extension}`);
    const response = await fetch(`https://api.telegram.org/file/bot${token}/${file.file_path}`, {
      signal: AbortSignal.timeout(60000),
    });
    if (!response.ok) throw new Error(`Telegram file download: HTTP ${response.status}`);
    await writeFile(imagePath, Buffer.from(await response.arrayBuffer()));
    const prompt = message.caption?.trim() ||
      "Проанализируй это изображение с учётом предыдущих сообщений пользователя.";
    await startTurn([
      { type: "text", text: prompt },
      { type: "localImage", path: imagePath },
    ], [imagePath]);
  } catch (error) {
    if (imagePath) await unlink(imagePath).catch(() => {});
    await sendMessage(`Не удалось обработать изображение: ${error.message}`);
  }
}

function runTranscription(audioPath) {
  return new Promise((resolve, reject) => {
    const worker = spawn(PYTHON_EXE, [TRANSCRIBE_SCRIPT, audioPath], {
      cwd: activeProjectRoot,
      windowsHide: true,
      env: { ...process.env, PYTHONUTF8: "1", WHISPER_MODEL: config.whisperModel },
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

async function ensureTtsWorker() {
  if (ttsWorker) return;
  await mkdir(TTS_DIR, { recursive: true });
  ttsWorker = spawn(TTS_PYTHON_EXE, [
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
  });
  ttsWorker.stderr.setEncoding("utf8");
  ttsWorker.stderr.on("data", (data) => console.error(`[tts] ${data.trimEnd()}`));
  ttsWorker.on("error", (error) => console.error("TTS worker failed to start:", error.message));
  ttsWorker.on("exit", (code, signal) => {
    const error = new Error(`TTS worker stopped (code=${code}, signal=${signal})`);
    for (const request of pendingTts.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    pendingTts.clear();
    ttsLines?.close();
    ttsLines = null;
    ttsWorker = null;
  });
  ttsLines = createInterface({ input: ttsWorker.stdout });
  ttsLines.on("line", (line) => {
    try {
      const message = JSON.parse(line);
      const request = pendingTts.get(message.id);
      if (!request) return;
      pendingTts.delete(message.id);
      clearTimeout(request.timer);
      if (message.ok) request.resolve(message.outputPath);
      else request.reject(new Error(message.error || "Неизвестная ошибка TTS"));
    } catch (error) {
      console.error("Invalid TTS worker message:", error.message);
    }
  });
}

async function synthesizeSpeech(text) {
  await ensureTtsWorker();
  const id = ttsSequence++;
  const outputPath = path.join(TTS_DIR, `${randomUUID()}.ogg`);
  const promise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingTts.delete(id);
      stopTtsWorker();
      reject(new Error(`превышено время озвучивания (${config.ttsRequestTimeoutSeconds} сек.)`));
    }, config.ttsRequestTimeoutSeconds * 1000);
    pendingTts.set(id, { resolve, reject, timer });
  });
  // The Windows venv launcher may keep a piped stdin line buffered until EOF.
  // Close stdin after the single request so the Python worker receives it immediately.
  ttsWorker.stdin.end(`${JSON.stringify({ id, text, outputPath })}\n`);
  return promise;
}

function stopTtsWorker() {
  const worker = ttsWorker;
  if (!worker) return;
  if (process.platform === "win32" && worker.pid) {
    const killer = spawn("taskkill.exe", ["/PID", String(worker.pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
    killer.unref();
  } else {
    worker.kill();
  }
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
  return writeFile(SPEECH_TEXTS_FILE, `${JSON.stringify([...speechTexts], null, 2)}\n`, "utf8");
}

async function sendVoiceFile(targetChatId, voicePath) {
  const form = new FormData();
  form.append("chat_id", String(targetChatId));
  form.append("voice", new Blob([await readFile(voicePath)], { type: "audio/ogg" }), path.basename(voicePath));
  const response = await fetch(`https://api.telegram.org/bot${token}/sendVoice`, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(5 * 60 * 1000),
  });
  const payload = await response.json();
  if (!payload.ok) throw new Error(`Telegram sendVoice: ${payload.description ?? response.status}`);
  return payload.result;
}

async function processSpeechRequest(callback, text) {
  const targetChatId = callback.message.chat.id;
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

async function handleApprovalCallback(callback) {
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
    await telegram("answerCallbackQuery", {
      callback_query_id: callback.id,
      text: "Готовлю голосовое сообщение…",
    });
    void processSpeechRequest(callback, text).catch((error) => {
      console.error("Speech request failed:", error.message);
    });
    return;
  }
  if (callback.data === "show-message" || callback.data === "show-last-message") {
    const targetChatId = callback.message?.chat?.id;
    const sourceMessageId = callback.message?.message_id;
    const binding = await findMessageBinding(config.dataDir, targetChatId, sourceMessageId);
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
    try {
      await sendThreadPicker({
        editMessage: callback.message,
        page: Number(taskPageMatch[1]),
      });
    } catch (error) {
      await sendMessageTo(callback.message.chat.id, `Не удалось обновить список задач: ${error.message}`);
    }
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
    const alreadySelected = catalogEntryIsSelected(entry, selectedTask());
    await telegram("answerCallbackQuery", {
      callback_query_id: callback.id,
      text: alreadySelected ? "Эта задача уже выбрана" : "Переключаю задачу…",
    });
    try {
      const removePicker = telegram("deleteMessage", {
        chat_id: callback.message.chat.id,
        message_id: callback.message.message_id,
      }).catch(() => telegram("editMessageReplyMarkup", {
        chat_id: callback.message.chat.id,
        message_id: callback.message.message_id,
        reply_markup: { inline_keyboard: [] },
      }).catch(() => {}));
      if (!alreadySelected) {
        await activateMessageBinding({
          provider: entry.provider,
          projectRoot: entry.projectRoot,
          threadId: entry.threadId,
          taskTitle: entry.title,
        });
        await Promise.all([
          sendTaskSwitchNotification({ targetChatId: callback.message.chat.id }),
          removePicker,
        ]);
      } else {
        await removePicker;
      }
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
  const threadMatch = /^t:([0-9a-f-]+)$/i.exec(callback.data ?? "");
  if (threadMatch) {
    const selectedThreadId = threadMatch[1];
    const alreadySelected = selectedThreadId === threadId;
    await telegram("answerCallbackQuery", {
      callback_query_id: callback.id,
      text: alreadySelected ? "Эта задача уже выбрана" : "Переключаю задачу…",
    });
    try {
      const removePicker = telegram("deleteMessage", {
        chat_id: callback.message.chat.id,
        message_id: callback.message.message_id,
      }).catch(() => telegram("editMessageReplyMarkup", {
        chat_id: callback.message.chat.id,
        message_id: callback.message.message_id,
        reply_markup: { inline_keyboard: [] },
      }).catch(() => {}));
      if (!alreadySelected) {
        const resumed = await resumeThread(selectedThreadId, { notify: false });
        if (!resumed) return;
        await Promise.all([
          sendTaskSwitchNotification({ targetChatId: callback.message.chat.id }),
          removePicker,
        ]);
      } else {
        await removePicker;
      }
    } catch (error) {
      await sendMessageTo(callback.message.chat.id, `Ошибка выбора задачи: ${error.message}`);
    }
    return;
  }

  const match = /^a:(\d+):(once|session|decline)$/.exec(callback.data ?? "");
  if (!match) return;
  const [, key, action] = match;
  const approval = pendingApprovals.get(key);
  if (!approval) {
    await telegram("answerCallbackQuery", { callback_query_id: callback.id, text: "Запрос уже закрыт" });
    return;
  }
  pendingApprovals.delete(key);
  const decision = action === "once" ? "accept" : action === "session" ? "acceptForSession" : "decline";
  respondRpc(approval.rpcId, { decision });
  await telegram("answerCallbackQuery", { callback_query_id: callback.id, text: `Решение: ${decision}` });
  await telegram("editMessageReplyMarkup", {
    chat_id: callback.message.chat.id,
    message_id: callback.message.message_id,
    reply_markup: { inline_keyboard: [] },
  });
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
  await saveState();
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
    await analyzeImage(message);
    return;
  }
  if (message.voice || message.audio) {
    await transcribeVoice(message);
    return;
  }
  const rawText = message.text?.trim();
  const text = MENU_COMMANDS.get(rawText) ?? rawText;
  if (!text) return;

  if (text === "/start" || text === "/help") {
    await sendMessage(
      `Бот подключён к Claude Code и Codex. Текущий агент: ${providerTitle()}. Отправьте текст, изображение или голосовое сообщение.\n\n` +
        "/agent — переключить Claude Code/Codex\n/model — сменить модель\n/reasoning — мощь дум Codex/Claude\n/mode — режим Plan/Work Codex/Claude\n/projects — сменить активный проект\n/new — новый контекст\n/tasks — список задач и создание новой\n/resume — выбрать задачу\n/archive — архивировать текущую задачу\n/status — статус, текущая задача и лимиты\n/approvals — режим подтверждений\n/restart — перезапустить бота\n/diff — последний diff\n/cancel — остановить задачу",
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
    await sendStatus();
  } else if (text === "/approvals") {
    await sendMessage(formatApprovalMode(), { reply_markup: approvalModeKeyboard() });
  } else if (text === "/restart") {
    await restartBot();
  } else if (text === "/tasks" || text === "/resume") {
    await sendThreadPicker();
  } else if (text.startsWith("/resume ")) {
    const selectedThreadId = text.slice("/resume ".length).trim();
    if (!/^[0-9a-f-]+$/i.test(selectedThreadId)) {
      return sendMessage("Укажите корректный ID задачи или используйте /resume без параметров.");
    }
    await resumeThread(selectedThreadId);
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
    await sendStatus();
  } else if (text === "/diff") {
    await sendLongMessage(latestDiff || "В последней задаче изменений файлов нет.");
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
      dismissedExternalTasks.add(run);
      const stopConfirmed = run.provider === "codex" && !interruptError;
      await finishProgress(run, stopConfirmed
        ? "Остановка запрошена; наблюдение отключено."
        : "Наблюдение отключено; локальная блокировка снята.");
      await completeRun(run);
      await sendRunMessage(run, stopConfirmed
        ? "Запрошена остановка этой задачи. Наблюдение отключено, можно отправлять новое сообщение."
        : run.provider === "codex"
          ? `Отключил наблюдение и снял локальную блокировку. Codex не подтвердил остановку: ${interruptError.message}`
          : "Отключил наблюдение и снял локальную блокировку. Остановить внешний процесс Claude из этой сессии бот не может.");
      return;
    }
    if (run.provider === "codex") {
      await sendRpc("turn/interrupt", { threadId: run.threadId, turnId: run.turnId });
    } else if (run.process) {
      run.process.kill();
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
    await startTurn(telegramPrompt(message, text));
  }
}

async function pollTelegram() {
  while (!stopping) {
    try {
      const updates = await telegram("getUpdates", {
        offset: updateOffset,
        timeout: 30,
        allowed_updates: ["message", "callback_query"],
      });
      for (const update of updates) {
        updateOffset = update.update_id + 1;
        await saveState();
        if (update.callback_query && isAllowedCallback(update.callback_query)) {
          await handleApprovalCallback(update.callback_query);
        } else if (update.message) {
          await handleTelegramMessage(update.message);
        }
      }
    } catch (error) {
      console.error("Telegram polling error:", error.message);
      await delay(3000);
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
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(40000),
  });
  const payload = await response.json();
  if (!payload.ok) throw new Error(`Telegram ${method}: ${payload.description ?? response.status}`);
  return payload.result;
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
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(40000),
  });
  const payload = await response.json();
  if (!payload.ok) throw new Error(`Telegram ${method}: ${payload.description ?? response.status}`);
  return payload.result;
}

async function sendStatusCard(text, extra = {}) {
  if (!chatId) return;
  const headerPath = path.join(STATUS_HEADER_DIR, statusHeaderFileName(activeProvider));
  if (!existsSync(headerPath)) return sendMessage(text, extra);
  const caption = String(text);
  if (caption.length > 1000) {
    await telegramMultipart("sendPhoto", { chat_id: chatId }, "photo", headerPath);
    return sendMessage(caption, extra);
  }
  return telegramMultipart("sendPhoto", {
    chat_id: chatId,
    caption,
    ...extra,
  }, "photo", headerPath);
}

async function sendMessage(text, extra = {}) {
  if (!chatId) return;
  return sendMessageTo(chatId, text, extra);
}

async function sendMessageTo(targetChatId, text, extra = {}) {
  return telegram("sendMessage", { chat_id: targetChatId, text: String(text), ...extra });
}

async function sendLongMessage(text, { speechText = null, forceSpeechButton = false } = {}) {
  const value = String(text);
  const speechId = rememberSpeechText(speechText, forceSpeechButton);
  for (let start = 0; start < value.length; start += TELEGRAM_LIMIT) {
    const isLast = start + TELEGRAM_LIMIT >= value.length;
    const extra = isLast && speechId
      ? { reply_markup: { inline_keyboard: [[{ text: "🔊 Озвучить", callback_data: `speech:${speechId}` }]] } }
      : {};
    await sendMessage(value.slice(start, start + TELEGRAM_LIMIT), extra);
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
    pendingInputs: [...pendingInputs.values()],
    queuedInputs: [...queuedInputs.values()],
    lastTaskMessages: [...lastTaskMessages.entries()].slice(-500),
    restartRequest,
  }, null, 2)}\n`;
  stateWriteQueue = stateWriteQueue
    .catch(() => {})
    .then(() => writeFile(STATE_FILE, content, "utf8"));
  return stateWriteQueue;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`Stopping on ${signal}...`);
  codex?.kill();
  for (const run of taskRuns.values()) run.process?.kill();
  stopTtsWorker();
  await releaseInstanceLock();
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
for (const item of queuedInputs.values()) scheduleQueuedInput(item, 500);
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
if (chatId && !restartFinalized) {
  await sendMessage("Бот запущен.", { reply_markup: BOT_MENU }).catch((error) => {
    console.error("Cannot update Telegram keyboard:", error.message);
  });
}
console.log(`Telegram/${providerTitle()} bridge ready for ${config.allowedUserIds.size} user(s); project: ${activeProjectRoot}`);
await pollTelegram();
