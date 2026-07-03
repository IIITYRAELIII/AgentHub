import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import process from "node:process";
import { INTEGRATION_ROOT, loadConfig } from "./config.mjs";

const config = await loadConfig();
const PROJECT_ROOT = config.projectRoot;
const STATE_FILE = config.stateFile;
const TELEGRAM_LIMIT = 3900;
const THREAD_LIST_LIMIT = 10;
const PYTHON_EXE = config.pythonExe;
const TRANSCRIBE_SCRIPT = path.join(import.meta.dirname, "transcribe.py");
const AUDIO_DIR = config.audioDir;
const BOT_COMMANDS = [
  { command: "new", description: "Новый контекст" },
  { command: "tasks", description: "Список задач" },
  { command: "resume", description: "Выбрать существующую задачу" },
  { command: "status", description: "Статус и текущая задача" },
  { command: "limits", description: "Остаток лимитов Codex" },
  { command: "approvals", description: "Режим подтверждений" },
  { command: "restart", description: "Перезапустить бота" },
  { command: "diff", description: "Последние изменения" },
  { command: "cancel", description: "Остановить текущую задачу" },
  { command: "help", description: "Справка" },
];
const BOT_MENU = {
  keyboard: [
    [{ text: "📋 Задачи" }, { text: "📊 Лимиты" }, { text: "ℹ️ Статус" }],
    [{ text: "⛔ Стоп" }, { text: "🔐 Доступ" }],
    [{ text: "❓ Помощь" }, { text: "🔄 Рестарт" }],
  ],
  resize_keyboard: true,
  is_persistent: true,
};
const MENU_COMMANDS = new Map([
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
let threadId = null;
let activeTurnId = null;
let latestDiff = "";
let responseText = "";
let requestSequence = 1;
let approvalSequence = 1;
let stopping = false;
let autoApprove = false;
const pendingRpc = new Map();
const pendingApprovals = new Map();
const threadTokenTotals = new Map();
const turnTokenUsage = new Map();

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
  const number = (value) => value.toLocaleString("ru-RU");
  return `📊 Токены за задачу: ${number(totalTokens)}\n` +
    `Вход: ${number(inputTokens)}\n` +
    `Вход без кэша: ${number(uncachedInputTokens)}\n` +
    `Из кэша: ${number(cachedInputTokens)}\n` +
    `Выход: ${number(outputTokens)} (рассуждения: ${number(reasoningOutputTokens)}).`;
}

try {
  const saved = JSON.parse(await readFile(STATE_FILE, "utf8"));
  if (typeof saved.threadId === "string") threadId = saved.threadId;
  if (Number.isSafeInteger(saved.chatId)) chatId = saved.chatId;
  if (Number.isSafeInteger(saved.updateOffset) && saved.updateOffset >= 0) updateOffset = saved.updateOffset;
} catch (error) {
  if (error?.code !== "ENOENT") console.error("Cannot read state:", error.message);
}

function spawnCodex(args) {
  if (process.platform === "win32") {
    return spawn("cmd.exe", ["/c", "codex", ...args], {
      cwd: PROJECT_ROOT,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
  }
  return spawn("codex", args, {
    cwd: PROJECT_ROOT,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
}

const codex = spawnCodex(["app-server"]);

codex.stderr.setEncoding("utf8");
codex.stderr.on("data", (data) => console.error(`[codex] ${data.trimEnd()}`));
codex.on("exit", async (code, signal) => {
  console.error(`Codex app-server stopped (code=${code}, signal=${signal}).`);
  if (stopping) return;
  stopping = true;
  const error = new Error(`Codex app-server stopped (code=${code}, signal=${signal})`);
  for (const pending of pendingRpc.values()) pending.reject(error);
  pendingRpc.clear();
  if (chatId) {
    await sendMessage(`Codex app-server остановлен (код ${code ?? "?"}). Перезапустите бот.`)
      .catch((sendError) => console.error("Cannot report Codex shutdown:", sendError.message));
  }
  process.exit(code || 1);
});

const lines = createInterface({ input: codex.stdout });
lines.on("line", (line) => {
  try {
    void handleCodexMessage(JSON.parse(line)).catch((error) => {
      console.error("Codex event handling error:", error.message);
    });
  } catch (error) {
    console.error("Invalid app-server message:", error.message);
  }
});

function sendRpc(method, params = {}) {
  const id = requestSequence++;
  const promise = new Promise((resolve, reject) => pendingRpc.set(id, { resolve, reject }));
  codex.stdin.write(`${JSON.stringify({ method, id, params })}\n`);
  return promise;
}

function sendNotification(method, params = {}) {
  codex.stdin.write(`${JSON.stringify({ method, params })}\n`);
}

function respondRpc(id, result) {
  codex.stdin.write(`${JSON.stringify({ id, result })}\n`);
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

  if (threadId) {
    try {
      const result = await sendRpc("thread/resume", {
        threadId,
        approvalPolicy: "on-request",
        sandbox: "workspace-write",
      });
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
  const result = await sendRpc("thread/start", {
    cwd: PROJECT_ROOT,
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
  const relative = path.relative(PROJECT_ROOT, path.resolve(thread.cwd));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function threadTitle(thread) {
  const title = thread.name?.trim() || thread.preview?.trim() || "Без названия";
  return title.replace(/\s+/g, " ").slice(0, 60);
}

function formatThread(thread) {
  const current = thread.id === threadId ? " (текущая)" : "";
  const updated = new Date(thread.updatedAt * 1000).toLocaleString("ru-RU");
  const project = path.relative(PROJECT_ROOT, thread.cwd) || path.basename(PROJECT_ROOT);
  return `${threadTitle(thread)}${current}\nПроект: ${project}\nОбновлена: ${updated}\nID: ${thread.id}`;
}

async function sendThreadPicker() {
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

async function resumeThread(selectedThreadId) {
  if (activeTurnId) {
    await sendMessage("Сначала завершите или отмените текущую задачу.");
    return false;
  }
  const result = await sendRpc("thread/resume", {
    threadId: selectedThreadId,
    approvalPolicy: "on-request",
    sandbox: "workspace-write",
  });
  threadId = result.thread?.id ?? selectedThreadId;
  latestDiff = "";
  responseText = "";
  await saveState();
  await sendMessage(`Выбрана задача: ${threadTitle(result.thread ?? {})}`);
  return true;
}

async function sendStatus() {
  if (!threadId) {
    return sendMessage(`Codex ${activeTurnId ? "выполняет задачу" : "готов"}.\nТекущая задача не выбрана.`);
  }
  const threads = await listThreads();
  const current = threads.find((thread) => thread.id === threadId);
  const name = current ? threadTitle(current) : "Telegram";
  await sendMessage(
    `Codex: ${activeTurnId ? `выполняет задачу ${activeTurnId}` : "готов"}\n\n` +
      `Текущая задача\n${name}\nID: ${threadId}\nПроект: ${PROJECT_ROOT}\n\n` +
      `VS Code и Codex App: откройте этот проект и выберите поток в истории.\n` +
      `CLI: codex resume ${threadId}`,
  );
}

async function startTurn(text) {
  if (activeTurnId) {
    await sendMessage("Предыдущая задача ещё выполняется. Используйте /cancel или дождитесь завершения.");
    return;
  }
  responseText = "";
  latestDiff = "";
  const result = await sendRpc("turn/start", {
    threadId,
    input: [{ type: "text", text }],
    approvalPolicy: "on-request",
    sandboxPolicy: {
      type: "workspaceWrite",
      writableRoots: [PROJECT_ROOT],
      networkAccess: false,
    },
  });
  activeTurnId = result.turn.id;
  if (!turnTokenUsage.has(activeTurnId)) {
    turnTokenUsage.set(activeTurnId, { usage: emptyTokenUsage(), reported: false });
  }
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
    const completedTurnId = params.turn?.id ?? activeTurnId;
    const tokenSummary = formatTurnTokenUsage(turnTokenUsage.get(completedTurnId));
    turnTokenUsage.delete(completedTurnId);
    activeTurnId = null;
    const status = params.turn?.status ?? "completed";
    const error = params.turn?.error?.message;
    const answer = responseText.trim() || (error ? `Ошибка: ${error}` : `Задача завершена: ${status}`);
    responseText = "";
    await sendLongMessage(`${answer}\n\n${tokenSummary}`);
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
  const cwd = params.cwd ?? PROJECT_ROOT;
  const reason = params.reason ? `\nПричина: ${params.reason}` : "";
  return `Codex запрашивает запуск команды:\n\n${command}\n\nКаталог: ${cwd}${reason}`;
}

function formatFileApproval(params) {
  const reason = params.reason ? `\nПричина: ${params.reason}` : "";
  return `Codex запрашивает изменение файлов.${reason}\n\nИспользуйте /diff после выполнения для просмотра общего diff.`;
}

function formatRateLimits(result) {
  const buckets = result.rateLimitsByLimitId
    ? Object.values(result.rateLimitsByLimitId)
    : result.rateLimits
      ? [result.rateLimits]
      : [];
  if (!buckets.length) return "Codex не вернул сведения о лимитах.";

  const lines = ["Лимиты Codex:"];
  for (const bucket of buckets) {
    const name = bucket.limitName || bucket.limitId || "Основной лимит";
    lines.push(`\n${name}`);
    for (const [label, window] of [["Основной", bucket.primary], ["Дополнительный", bucket.secondary]]) {
      if (!window) continue;
      const used = Number(window.usedPercent ?? 0);
      const remaining = Math.max(0, 100 - used);
      const duration = window.windowDurationMins ? `, окно ${formatDuration(window.windowDurationMins)}` : "";
      const reset = window.resetsAt
        ? `\nСброс: ${new Date(window.resetsAt * 1000).toLocaleString("ru-RU")}`
        : "";
      lines.push(`${label}: осталось ${remaining.toFixed(1)}% (использовано ${used.toFixed(1)}%${duration})${reset}`);
    }
    if (bucket.rateLimitReachedType) lines.push(`Ограничение достигнуто: ${bucket.rateLimitReachedType}`);
  }
  const resetCredits = result.rateLimitResetCredits?.availableCount;
  if (resetCredits != null) lines.push(`\nДоступно сбросов: ${resetCredits}`);
  return lines.join("\n");
}

function formatAccountTokenUsage(result) {
  const number = (value) => Number(value ?? 0).toLocaleString("ru-RU");
  const buckets = Array.isArray(result?.dailyUsageBuckets) ? result.dailyUsageBuckets : [];
  const recent = [...buckets]
    .sort((left, right) => String(right.startDate).localeCompare(String(left.startDate)))
    .slice(0, 7);
  const today = new Date().toISOString().slice(0, 10);
  const todayTokens = buckets.find((bucket) => bucket.startDate === today)?.tokens ?? 0;
  const lastSevenDays = recent.reduce((sum, bucket) => sum + Number(bucket.tokens ?? 0), 0);
  const summary = result?.summary ?? {};
  const lines = [
    "Использование токенов:",
    `Сегодня: ${number(todayTokens)}`,
    `Последние 7 дней: ${number(lastSevenDays)}`,
  ];
  if (summary.lifetimeTokens != null) lines.push(`Всего: ${number(summary.lifetimeTokens)}`);
  if (summary.peakDailyTokens != null) lines.push(`Максимум за день: ${number(summary.peakDailyTokens)}`);
  return lines.join("\n");
}

function formatDuration(minutes) {
  if (minutes % 1440 === 0) return `${minutes / 1440} дн.`;
  if (minutes % 60 === 0) return `${minutes / 60} ч.`;
  return `${minutes} мин.`;
}

function formatApprovalMode() {
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
      cwd: PROJECT_ROOT,
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    },
  );
  replacement.unref();
  stopping = true;
  codex.kill();
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

function runTranscription(audioPath) {
  return new Promise((resolve, reject) => {
    const worker = spawn(PYTHON_EXE, [TRANSCRIBE_SCRIPT, audioPath], {
      cwd: PROJECT_ROOT,
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

async function handleApprovalCallback(callback) {
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
      await sendMessage("Создана новая задача Codex в текущем проекте.");
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
  if (message.voice || message.audio) {
    await transcribeVoice(message);
    return;
  }
  const rawText = message.text?.trim();
  const text = MENU_COMMANDS.get(rawText) ?? rawText;
  if (!text) return;

  if (text === "/start" || text === "/help") {
    await sendMessage(
      "Бот подключён к локальному Codex. Отправьте задачу обычным сообщением.\n\n" +
        "/new — новый контекст\n/tasks — список задач и создание новой\n/resume — выбрать задачу\n/status — статус и текущая задача\n/limits — остаток лимитов\n/approvals — режим подтверждений\n/restart — перезапустить бота\n/diff — последний diff\n/cancel — остановить задачу",
      { reply_markup: BOT_MENU },
    );
  } else if (text === "/new") {
    if (activeTurnId) return sendMessage("Сначала завершите или отмените текущую задачу.");
    await createThread();
    await sendMessage("Создан новый контекст Codex.");
  } else if (text === "/status") {
    await sendStatus();
  } else if (text === "/limits") {
    const [limits, usage] = await Promise.allSettled([
      sendRpc("account/rateLimits/read"),
      sendRpc("account/usage/read", null),
    ]);
    const sections = [];
    if (limits.status === "fulfilled") sections.push(formatRateLimits(limits.value));
    else sections.push(`Не удалось получить лимиты Codex: ${limits.reason.message}`);
    if (usage.status === "fulfilled") sections.push(formatAccountTokenUsage(usage.value));
    else sections.push(`Не удалось получить статистику токенов: ${usage.reason.message}`);
    await sendLongMessage(sections.join("\n\n"));
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
    await sendRpc("turn/interrupt", { threadId, turnId: activeTurnId });
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

async function sendLongMessage(text) {
  const value = String(text);
  for (let start = 0; start < value.length; start += TELEGRAM_LIMIT) {
    await sendMessage(value.slice(start, start + TELEGRAM_LIMIT));
  }
}

async function saveState() {
  await writeFile(STATE_FILE, `${JSON.stringify({ chatId, threadId, updateOffset }, null, 2)}\n`, "utf8");
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`Stopping on ${signal}...`);
  codex.kill();
}

process.on("unhandledRejection", (error) => {
  console.error("Unhandled asynchronous error:", error);
});

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

await initializeCodex();
try {
  await telegram("setMyCommands", {
    commands: BOT_COMMANDS,
  });
} catch (error) {
  console.error("Cannot register Telegram commands:", error.message);
}
if (chatId) {
  await sendMessage("Клавиатура обновлена.", { reply_markup: BOT_MENU }).catch((error) => {
    console.error("Cannot update Telegram keyboard:", error.message);
  });
}
console.log(`Telegram/Codex bridge ready for ${config.allowedUserIds.size} user(s); project: ${PROJECT_ROOT}`);
await pollTelegram();
