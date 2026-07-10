import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import process from "node:process";
import { INTEGRATION_ROOT, loadConfig } from "./config.mjs";
import { buildClaudeArgs, buildClaudePrompt, formatClaudeUsage, parseClaudeLimits, parseClaudeResult } from "./claude.mjs";
import { formatTaskTokenUsage } from "./token-usage.mjs";

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
const CODEX_MODELS = config.codexModels;
const CODEX_MODEL_VALUES = new Set(CODEX_MODELS.map((model) => model.value));
function normalizeCodexModel(value) {
  return CODEX_MODEL_VALUES.has(value) ? value : CODEX_MODELS[0].value;
}
function codexModelLabel(value) {
  return CODEX_MODELS.find((model) => model.value === value)?.label ?? value;
}
let codexModel = normalizeCodexModel(config.codexModel);
const PROJECTS = config.projects;
const DEFAULT_PROJECT_ROOT = config.projectRoot;
const STATE_FILE = config.stateFile;
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
  { command: "model", description: "Сменить модель Claude Code" },
  { command: "projects", description: "Сменить активный проект" },
  { command: "new", description: "Новый контекст" },
  { command: "tasks", description: "Список задач" },
  { command: "resume", description: "Выбрать существующую задачу" },
  { command: "status", description: "Статус и текущая задача" },
  { command: "limits", description: "Лимиты AI-провайдера" },
  { command: "approvals", description: "Режим подтверждений" },
  { command: "restart", description: "Перезапустить бота" },
  { command: "diff", description: "Последние изменения" },
  { command: "cancel", description: "Остановить текущую задачу" },
  { command: "help", description: "Справка" },
];
const BOT_MENU = {
  keyboard: [
    [{ text: "🤖 Движок" }, { text: "🎛 Модель" }],
    [{ text: "📁 Проект" }, { text: "📋 Задачи" }],
    [{ text: "📊 Лимиты" }, { text: "ℹ️ Статус" }],
    [{ text: "⛔ Стоп" }, { text: "🔐 Доступ" }],
    [{ text: "❓ Помощь" }, { text: "🔄 Рестарт" }],
  ],
  resize_keyboard: true,
  is_persistent: true,
};
const MENU_COMMANDS = new Map([
  ["🤖 Движок", "/engine"],
  ["🎛 Модель", "/model"],
  ["📁 Папка", "/projects"],
  ["📁 Проект", "/projects"],
  ["🆕 Новая", "/new"],
  ["🆕 Новая задача", "/new"],
  ["📋 Задачи", "/tasks"],
  ["🎯 Текущая", "/current"],
  ["📊 Лимиты", "/limits"],
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

let updateOffset = 0;
let chatId = null;
let activeProjectRoot = DEFAULT_PROJECT_ROOT;
const threadIdsByProvider = { codex: null, claude: null };
let threadId = null;
let activeTurnId = null;
let latestDiff = "";
let responseText = "";
let requestSequence = 1;
let approvalSequence = 1;
let stopping = false;
let autoApprove = false;
let activeClaudeProcess = null;
let ttsWorker = null;
let ttsLines = null;
let ttsSequence = 1;
let typingInterval = null;
const pendingRpc = new Map();
const pendingApprovals = new Map();
const threadTokenTotals = new Map();
const turnTokenUsage = new Map();
const turnTemporaryFiles = new Map();
const pendingTts = new Map();
const speechTexts = new Map();

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
  if (CLAUDE_MODELS.includes(saved.claudeModel)) claudeModel = saved.claudeModel;
  if (typeof saved.codexModel === "string") codexModel = normalizeCodexModel(saved.codexModel);
  if (Number.isSafeInteger(saved.chatId)) chatId = saved.chatId;
  if (Number.isSafeInteger(saved.updateOffset) && saved.updateOffset >= 0) updateOffset = saved.updateOffset;
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
    if (wasActive) {
      activeTurnId = null;
      stopTyping();
    }
    if (chatId) {
      await sendMessage(
        `⚠️ Codex app-server остановлен (код ${code ?? "?"}).` +
          (wasActive ? " Переключитесь на движок командой /engine — Codex перезапустится при следующем выборе." : ""),
      ).catch((sendError) => console.error("Cannot report Codex shutdown:", sendError.message));
    }
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
  await nameTelegramThread(threadId);
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
  await sendRpc("thread/name/set", { threadId: id, name: `Telegram · ${timestamp}` });
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

async function sendThreadPicker() {
  if (!isCodex()) {
    const keyboard = [[{ text: "➕ Создать новую задачу", callback_data: "thread:new" }]];
    const current = threadId ? `\n\nТекущая сессия: ${threadId}` : "";
    await sendMessage(
      `Claude Code не предоставляет CLI для списка сессий.${current}\nДля известного ID используйте /resume <ID>.`,
      { reply_markup: { inline_keyboard: keyboard } },
    );
    return;
  }
  const threads = await listThreads();
  const keyboard = [[{
    text: "➕ Создать новую задачу",
    callback_data: "thread:new",
  }], ...threads.map((thread) => [{
    text: `${thread.id === threadId ? "✓ " : ""}${path.basename(thread.cwd)} · ${threadTitle(thread)}`,
    callback_data: `t:${thread.id}`,
  }])];
  const text = threads.length ? "Выберите задачу:" : "В этом проекте пока нет задач.";
  await sendMessage(text, { reply_markup: { inline_keyboard: keyboard } });
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

  const previous = { activeProvider, threadId };
  threadIdsByProvider[activeProvider] = threadId;
  activeProvider = target;
  threadId = threadIdsByProvider[target] ?? null;
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
    ({ activeProvider, threadId } = previous);
    await saveState();
    throw error;
  }
  await saveState();
  return { changed: true };
}

async function resumeThread(selectedThreadId) {
  if (activeTurnId) {
    await sendMessage("Сначала завершите или отмените текущую задачу.");
    return false;
  }
  if (!isCodex()) {
    threadId = selectedThreadId;
    latestDiff = "";
    responseText = "";
    await saveState();
    await sendMessage(`Выбрана сессия Claude: ${threadId}`);
    return true;
  }
  const result = await sendRpc("thread/resume", {
    threadId: selectedThreadId,
    approvalPolicy: "on-request",
    sandbox: "workspace-write",
  });
  if (!isWorkspaceThread(result.thread ?? {})) {
    throw new Error("задача относится к другой активной папке");
  }
  threadId = result.thread?.id ?? selectedThreadId;
  latestDiff = "";
  responseText = "";
  await saveState();
  await sendMessage(`Выбрана задача: ${threadTitle(result.thread ?? {})}`);
  return true;
}

async function sendStatus() {
  const project = activeProject();
  if (!threadId) {
    return sendMessage(
      `${providerTitle()} ${activeTurnId ? "выполняет задачу" : "готов"}.\n` +
      `Активная папка: ${project.name}\n${activeProjectRoot}\nНовая сессия будет создана при следующем запросе.`,
    );
  }
  const threads = await listThreads();
  const current = threads.find((thread) => thread.id === threadId);
  const name = current ? threadTitle(current) : "Telegram";
  const openHint = isCodex()
    ? `VS Code и Codex App: откройте этот проект и выберите поток в истории.\nCLI: codex resume ${threadId}`
    : `CLI: claude --resume ${threadId}`;
  await sendMessage(
    `${providerTitle()}: ${activeTurnId ? `выполняет задачу ${activeTurnId}` : "готов"}\n\n` +
      `Текущая задача\n${name}\nID: ${threadId}\nПапка: ${project.name}\n${activeProjectRoot}\n\n` +
      openHint,
  );
}

async function startTurn(input, temporaryFiles = []) {
  if (activeTurnId) {
    await sendMessage("Предыдущая задача ещё выполняется. Используйте /cancel или дождитесь завершения.");
    return;
  }
  responseText = "";
  latestDiff = "";
  if (!isCodex()) {
    await startClaudeTurn(input, temporaryFiles);
    return;
  }
  const items = typeof input === "string" ? [{ type: "text", text: input }] : input;
  try {
    const result = await sendRpc("turn/start", {
      threadId,
      input: items,
      model: codexModel,
      approvalPolicy: "on-request",
      sandboxPolicy: {
        type: "workspaceWrite",
        writableRoots: [activeProjectRoot],
        networkAccess: false,
      },
    });
    activeTurnId = result.turn.id;
    if (temporaryFiles.length) turnTemporaryFiles.set(activeTurnId, temporaryFiles);
    if (!turnTokenUsage.has(activeTurnId)) {
      turnTokenUsage.set(activeTurnId, { usage: emptyTokenUsage(), reported: false });
    }
    startTyping();
    await sendMessage("Задача принята.");
  } catch (error) {
    await Promise.all(temporaryFiles.map((file) => unlink(file).catch(() => {})));
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

async function startClaudeTurn(input, temporaryFiles) {
  const turnId = randomUUID();
  const prompt = buildClaudePrompt(input);
  const contentItems = Array.isArray(input) ? input : [];
  const additionalDirectories = contentItems
    .filter((item) => item?.type === "localImage" && item.path)
    .map((item) => path.dirname(item.path));
  const args = buildClaudeArgs({
    prompt,
    sessionId: threadId,
    model: claudeModel,
    permissionMode: config.claudePermissionMode,
    autoApprove,
    additionalDirectories,
  });

  activeTurnId = turnId;
  if (temporaryFiles.length) turnTemporaryFiles.set(turnId, temporaryFiles);
  const invocation = resolveClaudeInvocation();
  const worker = spawn(invocation.command, [...invocation.prefixArgs, ...args], {
    cwd: activeProjectRoot,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  activeClaudeProcess = worker;
  startTyping();
  let stdout = "";
  let stderr = "";
  let settled = false;
  worker.stdout.setEncoding("utf8");
  worker.stderr.setEncoding("utf8");
  worker.stdout.on("data", (chunk) => { stdout += chunk; });
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
      if (code !== 0) throw new Error(stderr.trim() || `Claude Code завершился с кодом ${code}`);
      const result = parseClaudeResult(stdout);
      if (result.session_id) {
        threadId = result.session_id;
        await saveState();
      }
      latestDiff = await readGitDiff();
      const answer = String(result.result ?? "").trim()
        || (result.is_error ? "Claude Code завершил задачу с ошибкой." : "Задача завершена.");
      await sendLongMessage(`${answer}\n\n${formatClaudeUsage(result)}`, { speechText: answer });
      if (latestDiff) await sendMessage("Изменения доступны по команде /diff.");
    } catch (error) {
      await sendLongMessage(`Ошибка Claude Code: ${error.message}`);
    }
  };

  worker.on("error", (error) => void finish(null, error));
  worker.on("exit", (code) => void finish(code));
  await sendMessage("Задача принята.");
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
  if (method === "turn/started") {
    activeTurnId = params.turn?.id ?? activeTurnId;
    if (activeTurnId && !turnTokenUsage.has(activeTurnId)) {
      turnTokenUsage.set(activeTurnId, { usage: emptyTokenUsage(), reported: false });
    }
  }
  if (method === "thread/tokenUsage/updated") trackTurnTokenUsage(params);
  if (method === "turn/diff/updated") latestDiff = params.diff ?? latestDiff;
  if (method === "item/agentMessage/delta") responseText += params.delta ?? "";

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
    await Promise.all(temporaryFiles.map((file) => unlink(file).catch(() => {})));
    activeTurnId = null;
    const status = params.turn?.status ?? "completed";
    const error = params.turn?.error?.message;
    const answer = responseText.trim() || (error ? `Ошибка: ${error}` : `Задача завершена: ${status}`);
    responseText = "";
    await sendLongMessage(`${answer}\n\n${tokenSummary}`, { speechText: answer });
    if (latestDiff) await sendMessage("Изменения доступны по команде /diff.");
  }
}

async function requestApproval(rpcId, kind, params, text) {
  if (autoApprove) {
    respondRpc(rpcId, { decision: "accept" });
    await sendMessage(`⚡ Автоматически разрешено: ${kind === "command" ? "команда" : "изменение файлов"}.`);
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

function formatResetRemaining(resetsAtSeconds) {
  const resetsAtMs = Number(resetsAtSeconds) * 1000;
  if (!Number.isFinite(resetsAtMs)) return "";
  const diffMs = resetsAtMs - Date.now();
  if (diffMs <= 0) return "сейчас";

  const totalMinutes = Math.ceil(diffMs / 60000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  const parts = [];
  if (days) parts.push(`${days} дн.`);
  if (hours) parts.push(`${hours} ч.`);
  if (!days && minutes) parts.push(`${minutes} мин.`);
  return parts.join(" ") || "меньше минуты";
}

function formatRateLimits(result) {
  const buckets = result.rateLimitsByLimitId
    ? Object.values(result.rateLimitsByLimitId)
    : result.rateLimits
      ? [result.rateLimits]
      : [];
  if (!buckets.length) return "Codex не вернул сведения о лимитах.";

  buckets.sort((left, right) => (left.limitId === "codex" ? -1 : right.limitId === "codex" ? 1 : 0));
  const lines = [];
  for (const bucket of buckets) {
    if (lines.length) lines.push("");
    lines.push(bucket.limitName || bucket.limitId || "codex");
    for (const window of [bucket.primary, bucket.secondary]) {
      if (!window) continue;
      const used = Number(window.usedPercent ?? 0);
      const remaining = Math.max(0, 100 - used);
      const reset = window.resetsAt ? formatResetRemaining(window.resetsAt) : "неизвестно";
      lines.push(`${remaining.toFixed(1)}% - ${reset}`);
    }
    if (bucket.rateLimitReachedType) lines.push(`Ограничение достигнуто: ${bucket.rateLimitReachedType}`);
  }
  const resetCredits = result.rateLimitResetCredits?.availableCount;
  if (resetCredits != null) lines.push(`\nДоступно сбросов: ${resetCredits}`);
  return lines.join("\n");
}

function parseClaudeResetTime(value) {
  const match = String(value ?? "").match(/^([A-Z][a-z]{2}) (\d{1,2}), (\d{1,2}):(\d{2})(am|pm)/);
  if (!match) return null;
  const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"].indexOf(match[1]);
  if (month < 0) return null;
  let hour = Number(match[3]) % 12;
  if (match[5] === "pm") hour += 12;
  const now = new Date();
  let reset = new Date(now.getFullYear(), month, Number(match[2]), hour, Number(match[4]));
  if (reset.getTime() < now.getTime() - 86400000) {
    reset = new Date(now.getFullYear() + 1, month, Number(match[2]), hour, Number(match[4]));
  }
  return Math.floor(reset.getTime() / 1000);
}

function formatClaudeRateLimits(text) {
  const limits = parseClaudeLimits(text);
  if (!limits.length) return "claude\nНе удалось распознать данные о лимитах.";
  const lines = ["claude"];
  for (const limit of limits.filter((item) => !item.model)) {
    const remaining = Math.max(0, 100 - limit.usedPercent);
    const resetAt = parseClaudeResetTime(limit.resetsText);
    lines.push(`${remaining.toFixed(1)}% - ${resetAt ? formatResetRemaining(resetAt) : "неизвестно"}`);
  }
  for (const limit of limits.filter((item) => item.model)) {
    const remaining = Math.max(0, 100 - limit.usedPercent);
    const resetAt = parseClaudeResetTime(limit.resetsText);
    lines.push("", `Claude ${limit.model}`, `${remaining.toFixed(1)}% - ${resetAt ? formatResetRemaining(resetAt) : "неизвестно"}`);
  }
  return lines.join("\n");
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
    ? "⚡ Автоподтверждение включено до перезапуска бота. Команды и изменения файлов выполняются без запроса."
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
    await startTurn(transcript);
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
      reject(new Error("превышено время озвучивания (10 минут)"));
    }, 10 * 60 * 1000);
    pendingTts.set(id, { resolve, reject, timer });
  });
  ttsWorker.stdin.write(`${JSON.stringify({ id, text, outputPath })}\n`);
  return promise;
}

function rememberSpeechText(text) {
  if (!config.ttsEnabled || String(text).trim().length < config.ttsButtonMinChars) return null;
  while (speechTexts.size >= 20) speechTexts.delete(speechTexts.keys().next().value);
  const id = randomUUID().replaceAll("-", "").slice(0, 16);
  speechTexts.set(id, String(text).trim());
  return id;
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
    await sendMessage(`Не удалось озвучить ответ: ${error.message}`);
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
      await saveState();
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
  const threadMatch = /^t:([0-9a-f-]+)$/i.exec(callback.data ?? "");
  if (threadMatch) {
    try {
      const resumed = await resumeThread(threadMatch[1]);
      await telegram("answerCallbackQuery", {
        callback_query_id: callback.id,
        text: resumed ? "Задача выбрана" : "Переключение недоступно",
      });
      if (resumed) {
        await telegram("editMessageReplyMarkup", {
          chat_id: callback.message.chat.id,
          message_id: callback.message.message_id,
          reply_markup: { inline_keyboard: [] },
        });
      }
    } catch (error) {
      await telegram("answerCallbackQuery", { callback_query_id: callback.id, text: "Не удалось выбрать задачу" });
      await sendMessage(`Ошибка выбора задачи: ${error.message}`);
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
        "/engine — переключить Claude Code/Codex\n/model — сменить модель Claude Code\n/projects — сменить активный проект\n/new — новый контекст\n/tasks — список задач и создание новой\n/resume — выбрать задачу\n/status — статус и текущая задача\n/limits — остаток лимитов\n/approvals — режим подтверждений\n/restart — перезапустить бота\n/diff — последний diff\n/cancel — остановить задачу",
      { reply_markup: BOT_MENU },
    );
  } else if (text === "/engine") {
    await sendEnginePicker();
  } else if (text === "/model") {
    await sendModelPicker();
  } else if (text === "/projects" || text === "/folders" || text === "/folder") {
    await sendProjectPicker();
  } else if (text === "/new") {
    if (activeTurnId) return sendMessage("Сначала завершите или отмените текущую задачу.");
    await createThread();
    await sendMessage(`Создан новый контекст ${providerTitle()}.`);
  } else if (text === "/status") {
    await sendStatus();
  } else if (text === "/limits") {
    if (!isCodex()) {
      try {
        await sendMessage(formatClaudeRateLimits(await readClaudeRateLimits()));
      } catch (error) {
        await sendMessage(`Не удалось получить лимиты Claude: ${error.message}`);
      }
      return;
    }
    try {
      await sendMessage(formatRateLimits(await sendRpc("account/rateLimits/read")));
    } catch (error) {
      await sendMessage(`Не удалось получить лимиты Codex: ${error.message}`);
    }
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
    await startTurn(text);
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
  return telegram("sendMessage", { chat_id: chatId, text: String(text), ...extra });
}

async function sendLongMessage(text, { speechText = null } = {}) {
  const value = String(text);
  const speechId = rememberSpeechText(speechText);
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

async function saveState() {
  threadIdsByProvider[activeProvider] = threadId;
  await writeFile(
    STATE_FILE,
    `${JSON.stringify({ chatId, activeProjectRoot, activeProvider, threadIds: threadIdsByProvider, claudeModel, codexModel, updateOffset }, null, 2)}\n`,
    "utf8",
  );
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
  ttsWorker?.kill();
}

process.on("unhandledRejection", (error) => {
  console.error("Unhandled asynchronous error:", error);
});

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

await initializeProvider();
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
