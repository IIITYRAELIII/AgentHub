import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync } from "node:fs";
import { mkdir, open, readdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import process from "node:process";
import { INTEGRATION_ROOT, loadConfig } from "./config.mjs";
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
  formatStatusMessage,
  formatTaskSwitchMessage,
} from "./status.mjs";
import { formatTaskTokenUsage } from "./token-usage.mjs";
import { telegramPrompt } from "./telegram-message.mjs";
import { findMessageBinding } from "./message-bindings.mjs";

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
// Claude использует те же уровни «силы дум» и режимы Plan/Work, что и Codex,
// но применяет их по-своему: сила дум -> бюджет thinking-токенов, режим -> permission-mode.
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
const PYTHON_EXE = config.pythonExe;
const TTS_PYTHON_EXE = config.ttsPythonExe;
const TRANSCRIBE_SCRIPT = path.join(import.meta.dirname, "transcribe.py");
const TTS_WORKER_SCRIPT = path.join(import.meta.dirname, "tts_worker.py");
const TTS_CACHE_DIR = path.join(INTEGRATION_ROOT, ".silero-models");
const AUDIO_DIR = config.audioDir;
const IMAGE_DIR = path.join(config.dataDir, "images");
const TTS_DIR = config.ttsDir;
const BOT_COMMANDS = [
  { command: "engine", description: "Переключить Claude Code/Codex" },
  { command: "model", description: "Сменить модель" },
  { command: "reasoning", description: "Сменить силу дум (Codex/Claude)" },
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
    [{ text: "🤖 Движок" },{ text: "🎛 Модель" },...(config.showProjectButton ? [{ text: "📁 Проект" }] : []),],
    [{ text: "🧠 Сила дум" },{ text: "🛠 Plan/Work" },],
    [{ text: "📋 Задачи" },{ text: "ℹ️ Статус" },{ text: "🔐 Доступ" },],
    [{ text: "⛔ Стоп" }, { text: "❓ Помощь" }, { text: "🔄 Рестарт" }],
  ],
  resize_keyboard: true,
  is_persistent: true,
};
const MENU_COMMANDS = new Map([
  ["🤖 Движок", "/engine"],
  ["🎛 Модель", "/model"],
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
let activeTurnId = null;
let latestDiff = "";
let responseText = "";
let requestSequence = 1;
let approvalSequence = 1;
let stopping = false;
let autoApprove = config.autoApproveOnStart;
let activeClaudeProcess = null;
let activeRun = null;
let progressMessageId = null;
let progressStartTimer = null;
let progressStage = "";
let progressReasoning = "";
let progressTimer = null;
let lastProgressText = "";
let progressUpdateInFlight = false;
let codexRestarting = false;
let stateWriteQueue = Promise.resolve();
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

function samePath(left, right) {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function pathInsideOrSame(child, parent) {
  const childPath = path.resolve(child);
  const parentPath = path.resolve(parent);
  const relative = path.relative(parentPath, childPath);
  if (!relative) return true;
  if (relative.startsWith("..") || path.isAbsolute(relative)) return false;
  return true;
}

function findProject(projectRoot) {
  return PROJECTS.find((project) => samePath(project.path, projectRoot));
}

function activeProject() {
  return findProject(activeProjectRoot) ?? PROJECTS[0];
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
  if (saved.activeRun && typeof saved.activeRun === "object" && saved.activeRun.status === "running") {
    activeRun = saved.activeRun;
    if (Number.isSafeInteger(saved.activeRun.progressMessageId)) {
      progressMessageId = saved.activeRun.progressMessageId;
    }
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
    codex = null;
    codexLines = null;
    if (stopping) return;
    if (!wasActive) return;
    stopTyping();
    setProgressStage("Связь с Codex потеряна. Переподключаюсь…");
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
  if (stopping || !isCodex() || codexRestarting) return;
  codexRestarting = true;
  try {
    await startCodexAppServer();
    await initializeCodex();
    await recoverActiveRun();
    if (activeTurnId) startTyping();
    setProgressStage("Соединение с Codex восстановлено.");
  } catch (error) {
    console.error("Cannot restart Codex app-server:", error.message);
    setProgressStage(`Codex пока недоступен: ${error.message}`);
    if (!stopping && isCodex()) setTimeout(() => void restartCodexAfterCrash(), 5000);
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

async function initializeCodex() {
  await sendRpc("initialize", {
    clientInfo: {
      name: "telegram_codex_bridge",
      title: "Telegram Codex Bridge",
      version: "0.1.0",
    },
    capabilities: { experimentalApi: true },
  });
  sendNotification("initialized");
  await attachCodexThread();
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
    latestDiff = "";
    responseText = "";
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

async function listThreads() {
  if (!isCodex()) {
    return threadId ? [{
      id: threadId,
      cwd: activeProjectRoot,
      name: "Текущая сессия Claude",
      updatedAt: Math.floor(Date.now() / 1000),
    }] : [];
  }
  const threads = [];
  let cursor = null;
  do {
    const result = await sendRpc("thread/list", {
      cursor,
      limit: 50,
      sortKey: "updated_at",
      sortDirection: "desc",
    });
    threads.push(...(result.data ?? []).filter(isWorkspaceThread));
    cursor = result.nextCursor ?? null;
  } while (cursor && threads.length < THREAD_LIST_LIMIT);
  return threads.slice(0, THREAD_LIST_LIMIT);
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

async function sendThreadPicker({ editMessage = null } = {}) {
  if (!isCodex()) {
    const keyboard = [[{ text: "➕ Создать новую задачу", callback_data: "thread:new" }]];
    const current = threadId ? `\n\nТекущая сессия: ${threadId}` : "";
    const text = `Claude Code не предоставляет CLI для списка сессий.${current}\nДля известного ID используйте /resume <ID>.`;
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
    return;
  }
  const threads = await listThreads();
  const keyboard = [[{
    text: "➕ Создать новую задачу",
    callback_data: "thread:new",
  }], ...threads.map((thread) => [{
    text: `${thread.id === threadId ? "✓ " : ""}${config.showTaskProject ? `${activeProject().name} · ` : ""}${threadTitle(thread)}`,
    callback_data: `t:${thread.id}`,
  }])];
  if (threadId) {
    keyboard.push([{
      text: "❌ Архивировать текущую задачу",
      callback_data: "thread:archive",
    }]);
  }
  const text = threads.length ? "Выберите задачу:" : "В этом проекте пока нет задач.";
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

async function sendEnginePicker() {
  const keyboard = [
    [{ text: `${!isCodex() ? "✓ " : ""}Claude Code`, callback_data: "engine:claude" }],
    [{ text: `${isCodex() ? "✓ " : ""}Codex`, callback_data: "engine:codex" }],
  ];
  await sendMessage(
    `Активный движок: ${providerTitle()}\n\nВыберите движок:`,
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
  if (activeTurnId) return null;
  const project = PROJECTS[index];
  if (!project) throw new Error("unknown project");
  if (samePath(project.path, activeProjectRoot)) return { project, changed: false };

  rememberCodexTaskSettings();
  const previous = {
    activeProjectRoot,
    threadId,
    latestDiff,
    responseText,
    threadIdsByProvider: { ...threadIdsByProvider },
  };
  activeProjectRoot = project.path;
  threadId = null;
  threadIdsByProvider.codex = null;
  threadIdsByProvider.claude = null;
  latestDiff = "";
  responseText = "";
  try {
    await createThread();
  } catch (error) {
    ({ activeProjectRoot, threadId, latestDiff, responseText } = previous);
    Object.assign(threadIdsByProvider, previous.threadIdsByProvider);
    await saveState();
    throw error;
  }
  return { project, changed: true };
}

async function switchProvider(target) {
  if (activeTurnId) return null;
  if (target !== "codex" && target !== "claude") throw new Error("unknown provider");
  if (target === activeProvider) return { changed: false };

  rememberCodexTaskSettings();
  const previous = { activeProvider, threadId, codexModel, codexReasoningEffort };
  threadIdsByProvider[activeProvider] = threadId;
  activeProvider = target;
  threadId = threadIdsByProvider[target] ?? null;
  if (target === "codex" && threadId) restoreCodexTaskSettings(threadId);
  latestDiff = "";
  responseText = "";
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
  await saveState();
  return { changed: true };
}

async function resumeThread(selectedThreadId, { notify = true } = {}) {
  if (activeTurnId) {
    await sendMessage("Сначала завершите или отмените текущую задачу.");
    return false;
  }
  if (!isCodex()) {
    threadId = selectedThreadId;
    activeThreadTitle = `Сессия Claude · ${selectedThreadId.slice(0, 8)}`;
    latestDiff = "";
    responseText = "";
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
  latestDiff = "";
  responseText = "";
  await saveState();
  if (notify) {
    await sendMessage(formatTaskSwitchMessage({
      task: activeThreadTitle,
      project: activeProject().name,
      showProject: config.showProjectButton,
      ...taskSwitchSettings(),
    }), { parse_mode: "HTML" });
  }
  return true;
}

async function activateMessageBinding(binding) {
  if (activeTurnId) return { changed: false, reason: "active-turn" };
  const project = findProject(binding.projectRoot);
  if (!project) throw new Error("проект привязанного сообщения больше не разрешён");
  if (binding.provider !== "codex" && binding.provider !== "claude") {
    throw new Error("неизвестный движок привязанного сообщения");
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
    responseText,
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
  latestDiff = "";
  responseText = "";
  try {
    if (isCodex() && !codex) {
      await startCodexAppServer();
      await initializeCodex();
    } else {
      await resumeThread(binding.threadId, { notify: false });
    }
    await saveState();
    return { changed: true, activeTitle: activeThreadTitle };
  } catch (error) {
    ({
      activeProjectRoot,
      activeProvider,
      threadId,
      latestDiff,
      responseText,
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
  responseText = "";
  await saveState();

  const [nextThread] = (await listThreads()).filter((thread) => thread.id !== archivedThreadId);
  if (nextThread) await resumeThread(nextThread.id, { notify: false });

  return { archived: true, archivedThread, nextThread: nextThread ?? null };
}

function archiveBlockedReason() {
  if (activeTurnId) return "active-turn";
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

async function sendStatus() {
  const project = activeProject();
  let task = "Не выбрана";
  if (threadId) {
    try {
      const threads = await listThreads();
      const current = threads.find((thread) => thread.id === threadId);
      task = current ? threadTitle(current) : "Telegram";
    } catch (error) {
      console.error("Cannot read current task for status:", error.message);
      task = "Telegram";
    }
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

  await sendMessage(formatStatusMessage({
    provider: isCodex() ? "CODEX" : "CLAUDE",
    busy: Boolean(activeTurnId),
    model: isCodex() ? codexModelLabel(codexModel) : CLAUDE_MODEL_LABELS[claudeModel],
    reasoning: CODEX_REASONING_LABELS[isCodex() ? codexReasoningEffort : claudeReasoningEffort],
    mode: CODEX_COLLABORATION_MODE_LABELS[isCodex() ? codexCollaborationMode : claudeCollaborationMode],
    task,
    project: project.name,
    limits,
  }));
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

async function beginRun(input) {
  activeRun = {
    id: randomUUID(),
    provider: activeProvider,
    projectRoot: activeProjectRoot,
    threadId,
    turnId: null,
    sessionId: isCodex() ? null : threadId,
    promptPreview: inputPreview(input),
    model: isCodex() ? codexModelLabel(codexModel) : CLAUDE_MODEL_LABELS[claudeModel],
    reasoning: CODEX_REASONING_LABELS[isCodex() ? codexReasoningEffort : claudeReasoningEffort],
    responseText: "",
    status: "running",
    startedAt: new Date().toISOString(),
    progressMessageId: null,
  };
  progressStage = "Задача принята.";
  progressReasoning = "";
  responseText = "";
  lastProgressText = "";
  await saveState();
  progressStartTimer = setTimeout(() => {
    progressStartTimer = null;
    void startProgressMessage();
  }, 3000);
}

async function startProgressMessage() {
  if (!activeRun || activeRun.status !== "running" || progressMessageId) return;
  const runId = activeRun.id;
  const initialProgress = renderProgress();
  const message = await sendMessage(initialProgress);
  if (!activeRun || activeRun.id !== runId || activeRun.status !== "running") {
    if (message?.message_id) {
      await telegram("deleteMessage", { chat_id: chatId, message_id: message.message_id }).catch(() => {});
    }
    return;
  }
  progressMessageId = message?.message_id ?? null;
  lastProgressText = initialProgress;
  activeRun.progressMessageId = progressMessageId;
  await saveState();
}

function setProgressStage(stage) {
  const value = String(stage ?? "").trim();
  if (value) progressStage = value;
  scheduleProgressUpdate();
}

function appendProgressReasoning(delta) {
  progressReasoning += String(delta ?? "");
  if (progressReasoning.length > 5000) progressReasoning = progressReasoning.slice(-5000);
  scheduleProgressUpdate();
}

function renderProgress(done = false) {
  const title = `${done ? "✅" : "⏳"} ${activeRun?.provider === "claude" ? "Claude Code" : "Codex"} · ${activeProject().name}`;
  const fallbackModel = activeRun?.provider === "claude"
    ? CLAUDE_MODEL_LABELS[claudeModel]
    : codexModelLabel(codexModel);
  const fallbackReasoning = CODEX_REASONING_LABELS[
    activeRun?.provider === "claude" ? claudeReasoningEffort : codexReasoningEffort
  ];
  const settings = `${activeRun?.model ?? fallbackModel} - ${activeRun?.reasoning ?? fallbackReasoning}`;
  const parts = [`${title}\n${settings}`, progressStage || "Выполняется…"];
  if (done) return parts.join("\n\n").slice(0, TELEGRAM_LIMIT);
  if (progressReasoning.trim()) {
    const reasoning = progressReasoning.trim();
    parts.push(`💭 ${reasoning.length > 900 ? `…${reasoning.slice(-900)}` : reasoning}`);
  }
  if (responseText.trim()) {
    const answer = responseText.trim();
    parts.push(`✍️ Ответ формируется:\n${answer.length > 2400 ? `…${answer.slice(-2400)}` : answer}`);
  }
  return parts.join("\n\n").slice(0, TELEGRAM_LIMIT);
}

function scheduleProgressUpdate() {
  if (!progressMessageId || progressTimer) return;
  progressTimer = setTimeout(() => {
    progressTimer = null;
    void flushProgressUpdate();
  }, 1500);
}

async function flushProgressUpdate(done = false) {
  if (!progressMessageId || progressUpdateInFlight) return;
  const text = renderProgress(done);
  if (text === lastProgressText) return;
  progressUpdateInFlight = true;
  try {
    await telegram("editMessageText", { chat_id: chatId, message_id: progressMessageId, text });
    lastProgressText = text;
    if (activeRun) {
      activeRun.responseText = responseText;
      await saveState();
    }
  } catch (error) {
    if (!String(error.message).includes("message is not modified")) {
      console.error("Cannot update task progress:", error.message);
    }
  } finally {
    progressUpdateInFlight = false;
  }
}

async function finishProgress(stage) {
  if (activeRun) activeRun.status = "finishing";
  if (progressStartTimer) {
    clearTimeout(progressStartTimer);
    progressStartTimer = null;
  }
  if (progressTimer) {
    clearTimeout(progressTimer);
    progressTimer = null;
  }
  progressStage = stage;
  if (!progressMessageId) {
    progressReasoning = "";
    lastProgressText = "";
    return;
  }
  while (progressUpdateInFlight) await delay(50);
  await flushProgressUpdate(true);
  progressMessageId = null;
  progressReasoning = "";
  lastProgressText = "";
}

async function startTurn(input, temporaryFiles = [], { forceSpeechButton = false } = {}) {
  if (activeTurnId) {
    await sendMessage("Предыдущая задача ещё выполняется. Используйте /cancel или дождитесь завершения.");
    return;
  }
  if (isCodex()) {
    try {
      await syncActiveCodexThreadSettings();
    } catch (error) {
      console.error("Cannot sync Codex thread settings before turn:", error.message);
    }
  }
  await beginRun(input);
  latestDiff = "";
  if (!isCodex()) {
    await startClaudeTurn(input, temporaryFiles, { forceSpeechButton });
    return;
  }
  const items = typeof input === "string" ? [{ type: "text", text: input }] : input;
  try {
    const result = await sendRpc("turn/start", {
      threadId,
      input: items,
      model: codexModel,
      effort: codexReasoningEffort,
      collaborationMode: buildCodexCollaborationMode({
        mode: codexCollaborationMode,
        model: codexModel,
        reasoningEffort: codexReasoningEffort,
      }),
      approvalPolicy: "on-request",
      sandboxPolicy: {
        type: "workspaceWrite",
        writableRoots: [activeProjectRoot],
        networkAccess: false,
      },
    });
    activeTurnId = result.turn.id;
    activeRun.threadId = threadId;
    activeRun.turnId = activeTurnId;
    await saveState();
    turnSpeechButtons.set(activeTurnId, forceSpeechButton);
    if (temporaryFiles.length) turnTemporaryFiles.set(activeTurnId, temporaryFiles);
    if (!turnTokenUsage.has(activeTurnId)) {
      turnTokenUsage.set(activeTurnId, { usage: emptyTokenUsage(), reported: false });
    }
    startTyping();
  } catch (error) {
    await Promise.all(temporaryFiles.map((file) => unlink(file).catch(() => {})));
    await finishProgress(`Ошибка запуска: ${error.message}`);
    activeRun = null;
    await saveState();
    throw error;
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

async function readGitDiff() {
  const result = await spawnCapture("git", ["diff", "--no-ext-diff", "--"]);
  return result.code === 0 ? result.stdout.trim() : "";
}

async function startClaudeTurn(input, temporaryFiles, { forceSpeechButton = false } = {}) {
  const turnId = randomUUID();
  const prompt = buildClaudePrompt(input);
  const contentItems = Array.isArray(input) ? input : [];
  const additionalDirectories = contentItems
    .filter((item) => item?.type === "localImage" && item.path)
    .map((item) => path.dirname(item.path));
  const planMode = claudeCollaborationMode === "plan";
  const args = buildClaudeArgs({
    prompt,
    sessionId: threadId,
    model: claudeModel,
    permissionMode: planMode ? "plan" : config.claudePermissionMode,
    autoApprove: planMode ? false : autoApprove,
    additionalDirectories,
  });

  activeTurnId = turnId;
  activeRun.turnId = turnId;
  if (temporaryFiles.length) turnTemporaryFiles.set(turnId, temporaryFiles);
  const invocation = resolveClaudeInvocation();
  const worker = spawn(invocation.command, [...invocation.prefixArgs, ...args], {
    cwd: activeProjectRoot,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    env: {
      ...process.env,
      MAX_THINKING_TOKENS: String(claudeThinkingTokens(claudeReasoningEffort)),
    },
  });
  activeClaudeProcess = worker;
  activeRun.pid = worker.pid ?? null;
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
    if (parsed.sessionId && parsed.sessionId !== threadId) {
      threadId = parsed.sessionId;
      if (activeRun) {
        activeRun.sessionId = parsed.sessionId;
        activeRun.threadId = parsed.sessionId;
      }
      void saveState();
    }
    if (parsed.textDelta) {
      responseText += parsed.textDelta;
      scheduleProgressUpdate();
    }
    // Claude Code headless не раскрывает текст мышления, поэтому показываем
    // индикатор с оценкой числа «думательных» токенов. Если текст всё же придёт
    // (в будущих версиях) — выводим и его в блок рассуждений.
    if (parsed.thinkingDelta) appendProgressReasoning(parsed.thinkingDelta);
    if (parsed.thinkingTokens != null) {
      peakThinkingTokens = Math.max(peakThinkingTokens, parsed.thinkingTokens);
      if (!responseText.trim()) {
        setProgressStage(`🧠 Claude размышляет (~${parsed.thinkingTokens} токенов)…`);
      }
    }
    if (parsed.event?.type === "system" && parsed.event?.subtype === "api_retry") {
      const reason = parsed.event.error ? `: ${parsed.event.error}` : "";
      setProgressStage(`Claude повторяет запрос (${parsed.event.attempt}/${parsed.event.max_retries})${reason}…`);
    }
    if (parsed.event?.type === "rate_limit_event" && parsed.event.rate_limit_info?.status === "rejected") {
      const resetAt = Number(parsed.event.rate_limit_info.resetsAt);
      const resetText = Number.isFinite(resetAt)
        ? new Date(resetAt * 1000).toLocaleString("ru-RU")
        : "неизвестно";
      claudeFailureText = `Исчерпан лимит Claude. Сброс: ${resetText}.`;
      setProgressStage(claudeFailureText);
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
      setProgressStage(`Claude использует инструмент ${streamEvent.content_block.name ?? ""}…`);
    }
    if (parsed.result) streamedResult = parsed.result;
  });
  worker.stderr.on("data", (chunk) => { stderr += chunk; });

  const finish = async (code, spawnError = null) => {
    if (settled) return;
    settled = true;
    activeClaudeProcess = null;
    stopTyping();
    const files = turnTemporaryFiles.get(turnId) ?? [];
    turnTemporaryFiles.delete(turnId);
    await Promise.all(files.map((file) => unlink(file).catch(() => {})));
    activeTurnId = null;

    try {
      if (spawnError) throw spawnError;
      const result = streamedResult ?? (stdout.trim() ? parseClaudeResult(stdout) : null);
      if (!result && code !== 0) {
        throw new Error(claudeFailureText || stderr.trim() || `Claude Code завершился с кодом ${code}`);
      }
      if (!result) throw new Error("Claude Code не вернул результат");
      if (result.session_id) {
        threadId = result.session_id;
        await saveState();
      }
      latestDiff = await readGitDiff();
      const answer = String(result.result ?? "").trim()
        || claudeFailureText
        || (result.is_error ? "Claude Code завершил задачу с ошибкой." : "Задача завершена.");
      const failed = code !== 0 || result.is_error;
      await finishProgress(failed ? `Claude остановлен: ${answer}` : "Задача завершена.");
      const response = failed ? `Ошибка Claude Code: ${answer}` : answer;
      await sendLongMessage(`${response}\n\n${formatClaudeUsage(result, peakThinkingTokens)}`, { speechText: answer, forceSpeechButton });
      if (latestDiff) await sendMessage("Изменения доступны по команде /diff.");
      activeRun = null;
      await saveState();
    } catch (error) {
      await finishProgress(`Claude остановлен: ${error.message}`);
      await sendLongMessage(`Ошибка Claude Code: ${error.message}`);
      activeRun = null;
      await saveState();
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
  if (method === "thread/settings/updated") {
    applyCodexThreadSettings(params.threadId, params.threadSettings);
    void saveState();
  }
  if (method === "turn/started") {
    activeTurnId = params.turn?.id ?? activeTurnId;
    if (activeRun && activeTurnId) {
      activeRun.turnId = activeTurnId;
      activeRun.threadId = params.threadId ?? threadId;
      void saveState();
    }
    if (activeTurnId && !turnTokenUsage.has(activeTurnId)) {
      turnTokenUsage.set(activeTurnId, { usage: emptyTokenUsage(), reported: false });
    }
  }
  if (method === "thread/tokenUsage/updated") trackTurnTokenUsage(params);
  if (method === "turn/diff/updated") latestDiff = params.diff ?? latestDiff;
  if (method === "item/agentMessage/delta") {
    responseText += params.delta ?? "";
    scheduleProgressUpdate();
  }
  if (method === "item/reasoning/summaryTextDelta" || method === "item/plan/delta") {
    appendProgressReasoning(params.delta);
  }
  if (method === "item/started") setProgressStage(describeCodexItem(params.item, false));
  if (method === "item/completed") setProgressStage(describeCodexItem(params.item, true));

  if (method === "item/commandExecution/requestApproval") {
    await requestApproval(id, "command", params, formatCommandApproval(params));
  } else if (method === "item/fileChange/requestApproval") {
    await requestApproval(id, "file", params, formatFileApproval(params));
  } else if (method === "turn/completed") {
    stopTyping();
    const completedTurnId = params.turn?.id ?? activeTurnId;
    const tokenSummary = formatTurnTokenUsage(turnTokenUsage.get(completedTurnId));
    turnTokenUsage.delete(completedTurnId);
    const temporaryFiles = turnTemporaryFiles.get(completedTurnId) ?? [];
    turnTemporaryFiles.delete(completedTurnId);
    const forceSpeechButton = turnSpeechButtons.get(completedTurnId) ?? false;
    turnSpeechButtons.delete(completedTurnId);
    await Promise.all(temporaryFiles.map((file) => unlink(file).catch(() => {})));
    activeTurnId = null;
    const status = params.turn?.status ?? "completed";
    const error = params.turn?.error?.message;
    const answer = responseText.trim() || (error ? `Ошибка: ${error}` : `Задача завершена: ${status}`);
    await finishProgress(error || status === "failed" ? `Задача завершилась с ошибкой: ${error ?? status}` : "Задача завершена.");
    await sendLongMessage(`${answer}\n\n${tokenSummary}`, { speechText: answer, forceSpeechButton });
    if (latestDiff) await sendMessage("Изменения доступны по команде /diff.");
    activeRun = null;
    responseText = "";
    await saveState();
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
  return progressStage || (completed ? "Этап завершён." : "Выполняется следующий этап…");
}

function recoveredCodexAnswer(turn) {
  const messages = (turn?.items ?? []).filter((item) => item?.type === "agentMessage" && item.text?.trim());
  return messages.at(-1)?.text?.trim() ?? "";
}

async function recoverActiveRun() {
  if (!activeRun || activeRun.status !== "running") return;
  if (activeRun.provider !== activeProvider || !samePath(activeRun.projectRoot, activeProjectRoot)) {
    await sendMessage("⚠️ Найдена незавершённая задача из другого проекта или движка. Её идентификаторы сохранены в state.json.");
    return;
  }

  progressMessageId = activeRun.progressMessageId ?? progressMessageId;
  responseText = String(activeRun.responseText ?? "");
  const recoveredThreadId = activeRun.threadId ?? activeRun.sessionId ?? threadId;
  if (isCodex() && recoveredThreadId !== threadId) rememberCodexTaskSettings();
  threadId = recoveredThreadId;
  if (isCodex()) restoreCodexTaskSettings(threadId);
  if (!isCodex()) {
    await finishProgress("Процесс Claude прервался, но сессия сохранена.");
    await sendMessage(`⚠️ Запуск Claude был прерван. Сессия ${threadId ?? "не успела получить ID"} сохранена и остаётся выбранной.`);
    activeRun = null;
    await saveState();
    return;
  }

  const result = await sendRpc("thread/read", { threadId, includeTurns: true });
  const turn = result.thread?.turns?.find((item) => item.id === activeRun.turnId)
    ?? result.thread?.turns?.at(-1);
  if (!turn) {
    await finishProgress("Не удалось найти сохранённый запуск.");
    activeRun = null;
    await saveState();
    return;
  }
  responseText = recoveredCodexAnswer(turn) || responseText;
  if (turn.status === "inProgress") {
    activeTurnId = turn.id;
    activeRun.turnId = turn.id;
    setProgressStage("Подключено к продолжающейся задаче.");
    startTyping();
    await saveState();
    return;
  }

  const answer = recoveredCodexAnswer(turn)
    || responseText.trim()
    || turn.error?.message
    || `Сохранённый запуск завершён со статусом ${turn.status}.`;
  await finishProgress(turn.status === "completed" ? "Задача завершена." : `Задача остановлена: ${turn.status}.`);
  await sendLongMessage(answer, { speechText: answer });
  activeTurnId = null;
  activeRun = null;
  responseText = "";
  await saveState();
}

async function requestApproval(rpcId, kind, params, text) {
  if (autoApprove) {
    respondRpc(rpcId, { decision: "accept" });
    return;
  }
  const key = String(approvalSequence++);
  pendingApprovals.set(key, { rpcId, kind });
  const decisions = [
    [{ text: "✅ Разрешить", callback_data: `a:${key}:once` }],
    [{ text: "✅ На сессию", callback_data: `a:${key}:session` }],
    [{ text: "❌ Отклонить", callback_data: `a:${key}:decline` }],
  ];
  await sendMessage(text, { reply_markup: { inline_keyboard: decisions } });
}

function formatCommandApproval(params) {
  const command = params.command ?? "(команда не указана)";
  const cwd = params.cwd ?? activeProjectRoot;
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

async function restartBot() {
  await sendMessage("🔄 Перезапускаю бота…");
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
  activeClaudeProcess?.kill();
  setTimeout(() => process.exit(0), 500).unref();
}

async function transcribeVoice(message) {
  if (!config.voiceEnabled) {
    await sendMessage("Голосовые сообщения отключены в конфигурации.");
    return;
  }
  if (activeTurnId) {
    await sendMessage("Предыдущая задача ещё выполняется. Дождитесь завершения или нажмите «Остановить».");
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
  if (activeTurnId) {
    await sendMessage("Предыдущая задача ещё выполняется. Дождитесь завершения или нажмите «Стоп».");
    return;
  }
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
      if (!switched) {
        await telegram("answerCallbackQuery", {
          callback_query_id: callback.id,
          text: "Сначала завершите или отмените текущую задачу",
          show_alert: true,
        });
        return;
      }
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
      if (!switched) {
        await telegram("answerCallbackQuery", {
          callback_query_id: callback.id,
          text: "Сначала завершите или отмените текущую задачу",
          show_alert: true,
        });
        return;
      }
      await telegram("answerCallbackQuery", {
        callback_query_id: callback.id,
        text: switched.changed ? "Движок переключён" : "Этот движок уже активен",
      });
      await telegram("editMessageReplyMarkup", {
        chat_id: callback.message.chat.id,
        message_id: callback.message.message_id,
        reply_markup: { inline_keyboard: [] },
      });
      if (switched.changed) {
        await sendMessage(`Активный движок: ${providerTitle()}\nПроект: ${activeProject().name}`);
      }
    } catch (error) {
      await telegram("answerCallbackQuery", {
        callback_query_id: callback.id,
        text: "Не удалось переключить движок",
        show_alert: true,
      });
      await sendMessage(`Ошибка переключения движка: ${error.message}`);
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
  if (callback.data === "thread:new") {
    if (activeTurnId) {
      await telegram("answerCallbackQuery", {
        callback_query_id: callback.id,
        text: "Сначала завершите или отмените текущую задачу",
        show_alert: true,
      });
      return;
    }
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
        sendMessageTo(callback.message.chat.id, archiveMessage(result)),
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
      if (!alreadySelected) {
        const resumed = await resumeThread(selectedThreadId, { notify: false });
        if (!resumed) return;
        await sendMessageTo(
          callback.message.chat.id,
          formatTaskSwitchMessage({
            task: activeThreadTitle,
            project: activeProject().name,
            showProject: config.showProjectButton,
            ...taskSwitchSettings(),
          }),
          { parse_mode: "HTML" },
        );
      }
      await telegram("deleteMessage", {
        chat_id: callback.message.chat.id,
        message_id: callback.message.message_id,
      }).catch(() => telegram("editMessageReplyMarkup", {
        chat_id: callback.message.chat.id,
        message_id: callback.message.message_id,
        reply_markup: { inline_keyboard: [] },
      }));
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
      const activated = await activateMessageBinding(binding);
      if (activated.reason === "active-turn") {
        await sendMessage("Нельзя переключиться на задачу из этого сообщения: другая задача ещё выполняется. Дождитесь завершения или остановите её.");
        return;
      }
      if (activated.changed) {
        await sendMessage(
          formatTaskSwitchMessage({
            task: activated.activeTitle,
            project: activeProject().name,
            showProject: config.showProjectButton,
            ...taskSwitchSettings(),
          }),
          { parse_mode: "HTML" },
        );
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
      `Бот подключён к Claude Code и Codex. Текущий движок: ${providerTitle()}. Отправьте текст, изображение или голосовое сообщение.\n\n` +
        "/engine — переключить Claude Code/Codex\n/model — сменить модель\n/reasoning — уровень Reasoning Codex\n/mode — режим Plan/Work Codex\n/projects — сменить активный проект\n/new — новый контекст\n/tasks — список задач и создание новой\n/resume — выбрать задачу\n/archive — архивировать текущую задачу\n/status — статус, текущая задача и лимиты\n/approvals — режим подтверждений\n/restart — перезапустить бота\n/diff — последний diff\n/cancel — остановить задачу",
      { reply_markup: BOT_MENU },
    );
  } else if (text === "/engine") {
    await sendEnginePicker();
  } else if (text === "/model") {
    await sendModelPicker();
  } else if (text === "/reasoning") {
    await sendReasoningPicker();
  } else if (text === "/mode") {
    await sendCollaborationModePicker();
  } else if (text === "/projects" || text === "/folders" || text === "/folder") {
    await sendProjectPicker();
  } else if (text === "/new") {
    if (activeTurnId) return sendMessage("Сначала завершите или отмените текущую задачу.");
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
    await sendMessage(archiveMessage(result));
    await sendThreadPicker();
  } else if (text === "/current" || text === "/thread") {
    await sendStatus();
  } else if (text === "/diff") {
    await sendLongMessage(latestDiff || "В последней задаче изменений файлов нет.");
  } else if (text === "/cancel") {
    if (!activeTurnId) return sendMessage("Активной задачи нет.");
    if (isCodex()) await sendRpc("turn/interrupt", { threadId, turnId: activeTurnId });
    else activeClaudeProcess?.kill();
    await sendMessage("Запрошена остановка задачи.");
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
    activeRun,
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
  activeClaudeProcess?.kill();
  stopTtsWorker();
  await releaseInstanceLock();
}

process.on("unhandledRejection", (error) => {
  console.error("Unhandled asynchronous error:", error);
});

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

await initializeProvider();
await recoverActiveRun().catch(async (error) => {
  console.error("Cannot recover active task:", error.message);
  await sendMessage(`⚠️ Не удалось восстановить активную задачу: ${error.message}`).catch(() => {});
});
try {
  await telegram("setMyCommands", {
    commands: BOT_COMMANDS,
  });
} catch (error) {
  console.error("Cannot register Telegram commands:", error.message);
}
if (chatId) {
  await sendMessage("Бот запущен.", { reply_markup: BOT_MENU }).catch((error) => {
    console.error("Cannot update Telegram keyboard:", error.message);
  });
}
console.log(`Telegram/${providerTitle()} bridge ready for ${config.allowedUserIds.size} user(s); project: ${activeProjectRoot}`);
await pollTelegram();
