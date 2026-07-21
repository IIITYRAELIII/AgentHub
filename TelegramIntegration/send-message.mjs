import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { findContainingProject, loadConfig } from "./config.mjs";
import { PersistentDeliveryOutbox } from "./delivery-outbox.mjs";
import { appendMessageBindings } from "./message-bindings.mjs";
import { taskViewCallbackData } from "./task-view-callback.mjs";
import { callTelegramJson, telegramBotApiUrl } from "./telegram-api.mjs";
import { forwardRuntimeCommand, runtimeCommandUnavailable } from "./runtime-command.mjs";

const TELEGRAM_MESSAGE_LIMIT = 4096;
const TELEGRAM_CAPTION_LIMIT = 1024;
const NOTIFICATION_CARD_DIRECTORY = path.join(
  import.meta.dirname,
  "assets",
  "notification-cards",
);
const titleHistoryFileCache = new Map();

export const NOTIFICATION_CATEGORIES = Object.freeze({
  action: Object.freeze({ emoji: "🚨", title: "ТРЕБУЕТСЯ ДЕЙСТВИЕ" }),
  done: Object.freeze({ emoji: "✅", title: "ЗАДАЧА ВЫПОЛНЕНА" }),
  intermediate: Object.freeze({ emoji: "📌", title: "ПРОМЕЖУТОЧНЫЙ РЕЗУЛЬТАТ" }),
  progress: Object.freeze({ emoji: "⏳", title: "ЗАДАЧА ВЫПОЛНЯЕТСЯ" }),
  warning: Object.freeze({ emoji: "⚠️", title: "ВНИМАНИЕ" }),
  info: Object.freeze({ emoji: "ℹ️", title: "ИНФОРМАЦИЯ" }),
});

export function escapeHtml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export function splitTelegramText(value, limit = TELEGRAM_MESSAGE_LIMIT) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error("Message text is empty");
  const chunks = [];
  for (let start = 0; start < text.length; start += limit) {
    chunks.push(text.slice(start, start + limit));
  }
  return chunks;
}

export function resolveNotificationCategory(value = "info") {
  const key = String(value || "info").trim().toLowerCase();
  const category = NOTIFICATION_CATEGORIES[key];
  if (!category) {
    throw new Error(`Unknown --category value "${value}"; use ${Object.keys(NOTIFICATION_CATEGORIES).join(", ")}`);
  }
  return { key, ...category };
}

export function resolveChatId(config, explicitChatId = null) {
  if (explicitChatId != null) {
    const value = Number(explicitChatId);
    if (!Number.isSafeInteger(value)) throw new Error("--chat-id must be an integer");
    return value;
  }
  const allowedChats = [...(config.allowedChatIds ?? [])];
  if (allowedChats.length === 1) return allowedChats[0];
  const allowedUsers = [...config.allowedUserIds];
  if (allowedChats.length === 0 && allowedUsers.length === 1) return allowedUsers[0];
  throw new Error("Cannot choose the recipient automatically; specify --chat-id <id>");
}

export function parseArguments(args) {
  let chatId = null;
  let silent = false;
  let bindCurrent = false;
  let bindActive = false;
  let category = "info";
  let messageFile = null;
  const textParts = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--chat-id") {
      if (index + 1 >= args.length) throw new Error("--chat-id requires a value");
      chatId = args[++index];
    } else if (argument === "--silent") {
      silent = true;
    } else if (argument === "--bind-current") {
      bindCurrent = true;
    } else if (argument === "--bind-active") {
      bindActive = true;
    } else if (argument === "--category") {
      if (index + 1 >= args.length) throw new Error("--category requires a value");
      category = resolveNotificationCategory(args[++index]).key;
    } else if (argument.startsWith("--category=")) {
      category = resolveNotificationCategory(argument.slice("--category=".length)).key;
    } else if (argument === "--message-file") {
      if (index + 1 >= args.length) throw new Error("--message-file requires a value");
      messageFile = args[++index];
    } else if (argument.startsWith("--message-file=")) {
      messageFile = argument.slice("--message-file=".length);
      if (!messageFile) throw new Error("--message-file requires a value");
    } else if (argument === "--help" || argument === "-h") {
      return { help: true, chatId, silent, bindCurrent, bindActive, category, messageFile, text: "" };
    } else {
      textParts.push(argument);
    }
  }
  if (bindCurrent && bindActive) throw new Error("Use either --bind-current or --bind-active, not both");
  const text = textParts.join(" ").trim();
  if (messageFile && text) throw new Error("Use either --message-file or positional message text, not both");
  return { help: false, chatId, silent, bindCurrent, bindActive, category, messageFile, text };
}

export function looksLikeUtf8Mojibake(value) {
  const cyrillic = String(value ?? "").match(/[А-Яа-яЁё]/g) ?? [];
  if (cyrillic.length < 20) return false;
  const suspiciousLeads = cyrillic.filter((character) => character === "Р" || character === "С").length;
  return suspiciousLeads / cyrillic.length >= 0.42;
}

export function validateMessageText(value) {
  const text = String(value ?? "").replace(/^\uFEFF/, "").trim();
  if (!text) throw new Error("Message text is empty");
  if (looksLikeUtf8Mojibake(text)) {
    throw new Error("Message text looks like corrupted UTF-8; use --message-file with a UTF-8 file");
  }
  return text;
}

export async function resolveMessageText(options, {
  readFileImpl = readFile,
  readStdinImpl = readStdin,
} = {}) {
  if (options.messageFile) {
    return validateMessageText(await readFileImpl(path.resolve(options.messageFile), "utf8"));
  }
  if (options.text) return validateMessageText(options.text);
  return validateMessageText(await readStdinImpl());
}

export function currentThreadBinding(state) {
  const provider = state?.activeProvider ?? state?.provider;
  const threadId = state?.threadIds?.[provider]
    ?? state?.threadId
    ?? (state?.activeRun?.provider === provider ? state.activeRun.threadId ?? state.activeRun.sessionId : null);
  if ((provider !== "codex" && provider !== "claude") || typeof threadId !== "string" || !threadId.trim()) {
    throw new Error("Current task is not available in data/state.json");
  }
  if (typeof state.activeProjectRoot !== "string" || !state.activeProjectRoot.trim()) {
    throw new Error("Current project is not available in data/state.json");
  }
  const taskTitle = String(
    state.activeThreadTitle
      ?? state.activeRun?.promptPreview?.split(/\r?\n/).find((line) => line.trim())
      ?? `${provider === "codex" ? "Codex" : "Claude"} · ${threadId.slice(0, 8)}`,
  ).trim().replace(/\s+/g, " ").slice(0, 120);
  return { provider, threadId, projectRoot: state.activeProjectRoot, taskTitle };
}

export function codexThreadTitleFromIndex(indexText, threadId) {
  return codexThreadTitleHistoryFromIndex(indexText, threadId).currentTitle;
}

function normalizedThreadTitle(value) {
  return String(value ?? "").trim().replace(/\s+/g, " ").slice(0, 120);
}

function generatedTelegramThreadTitle(value) {
  return /^Telegram · \d{2}\.\d{2}\.\d{4}, \d{2}:\d{2}$/.test(value);
}

function codexThreadTitleHistory(titles = []) {
  const currentTitle = titles.at(-1) ?? "";
  const recoverableTitle = generatedTelegramThreadTitle(currentTitle)
    ? titles.findLast((title) => title !== currentTitle && !generatedTelegramThreadTitle(title)) ?? ""
    : "";
  return { currentTitle, recoverableTitle };
}

export function codexThreadTitleHistoriesFromIndex(indexText) {
  const titlesByThreadId = new Map();
  for (const line of String(indexText ?? "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (typeof entry.id !== "string"
        || typeof entry.thread_name !== "string"
        || !entry.thread_name.trim()) continue;
      const titles = titlesByThreadId.get(entry.id) ?? [];
      titles.push(normalizedThreadTitle(entry.thread_name));
      titlesByThreadId.set(entry.id, titles);
    } catch {
      // Ignore an incomplete line while Codex is updating the append-only index.
    }
  }
  return new Map([...titlesByThreadId].map(([threadId, titles]) => (
    [threadId, codexThreadTitleHistory(titles)]
  )));
}

export function codexThreadTitleHistoryFromIndex(indexText, threadId) {
  return codexThreadTitleHistoriesFromIndex(indexText).get(threadId)
    ?? { currentTitle: "", recoverableTitle: "" };
}

export async function readCodexThreadTitleHistories(environment = process.env) {
  const codexHome = path.resolve(environment.CODEX_HOME || path.join(homedir(), ".codex"));
  const indexPath = path.join(codexHome, "session_index.jsonl");
  try {
    const info = await stat(indexPath);
    const cached = titleHistoryFileCache.get(indexPath);
    if (cached?.size === info.size && cached?.mtimeMs === info.mtimeMs) return cached.value;
    const indexText = await readFile(indexPath, "utf8");
    const value = codexThreadTitleHistoriesFromIndex(indexText);
    titleHistoryFileCache.set(indexPath, { size: info.size, mtimeMs: info.mtimeMs, value });
    if (titleHistoryFileCache.size > 8) {
      titleHistoryFileCache.delete(titleHistoryFileCache.keys().next().value);
    }
    return value;
  } catch {
    return new Map();
  }
}

export async function readCodexThreadTitleHistory(threadId, environment = process.env) {
  return (await readCodexThreadTitleHistories(environment)).get(threadId)
    ?? { currentTitle: "", recoverableTitle: "" };
}

function matchingStateTitle(state, provider, threadId) {
  const activeProvider = state?.activeProvider ?? state?.provider;
  const activeThreadId = state?.threadIds?.[activeProvider]
    ?? state?.threadId
    ?? (state?.activeRun?.provider === activeProvider
      ? state.activeRun.threadId ?? state.activeRun.sessionId
      : null);
  if (activeProvider !== provider || activeThreadId !== threadId) return "";
  return String(state?.activeThreadTitle ?? "").trim().replace(/\s+/g, " ").slice(0, 120);
}

export async function currentCallerBinding(state, environment = process.env, cwd = process.cwd()) {
  const codexThreadId = String(environment.CODEX_THREAD_ID ?? "").trim();
  const claudeThreadId = String(environment.CLAUDE_CODE_SESSION_ID ?? "").trim();
  if (codexThreadId && claudeThreadId) {
    throw new Error("Cannot identify the caller: both CODEX_THREAD_ID and CLAUDE_CODE_SESSION_ID are set");
  }

  if (claudeThreadId) {
    return {
      provider: "claude",
      threadId: claudeThreadId,
      projectRoot: path.resolve(environment.CLAUDE_PROJECT_DIR || cwd),
      taskTitle: matchingStateTitle(state, "claude", claudeThreadId) || `Claude · ${claudeThreadId.slice(0, 8)}`,
    };
  }

  if (!codexThreadId) {
    const detail = environment.CLAUDECODE
      ? "CLAUDECODE is set, but CLAUDE_CODE_SESSION_ID is missing"
      : "neither CODEX_THREAD_ID nor CLAUDE_CODE_SESSION_ID is set";
    throw new Error(`--bind-current cannot identify the calling AI session: ${detail}; use --bind-active only to intentionally bind to the task selected in the Telegram bot`);
  }

  const { currentTitle: taskTitle } = await readCodexThreadTitleHistory(codexThreadId, environment);

  return {
    provider: "codex",
    threadId: codexThreadId,
    projectRoot: path.resolve(environment.CODEX_PROJECT_ROOT || cwd),
    taskTitle: taskTitle
      || matchingStateTitle(state, "codex", codexThreadId)
      || `Codex · ${codexThreadId.slice(0, 8)}`,
  };
}

export function compactNotificationTaskTitle(taskTitle, maxLength = 56) {
  const value = String(taskTitle).trim().replace(/\s+/g, " ");
  if (!value) return "Задача";

  const pathParts = value.split(/[\\/]/).filter(Boolean);
  const title = pathParts.length > 1 ? pathParts.at(-1) : value;
  if (title.length <= maxLength) return title;
  return `${title.slice(0, Math.max(1, maxLength - 1)).trimEnd()}…`;
}

export function notificationCardPath(categoryName = "info") {
  const category = resolveNotificationCategory(categoryName);
  return path.join(NOTIFICATION_CARD_DIRECTORY, `${category.key}.png`);
}

export function notificationParts(taskTitle, text, categoryName = "info") {
  const title = compactNotificationTaskTitle(taskTitle);
  const value = String(text).trim();
  const category = resolveNotificationCategory(categoryName);
  const escapedHeader = `🧵 <b>${escapeHtml(title)}</b>\n\n`;
  const fallbackHeader = `${category.emoji} <b><u>${category.title}</u></b> ${category.emoji}\n\n`;
  const firstLimit = Math.max(1, TELEGRAM_CAPTION_LIMIT - escapedHeader.length - 32);
  const firstText = value.slice(0, firstLimit);
  return {
    caption: `${escapedHeader}${escapeHtml(firstText)}`,
    fallbackMessage: `${fallbackHeader}${escapedHeader}${escapeHtml(firstText)}`,
    cardPath: notificationCardPath(category.key),
    remaining: value.slice(firstText.length).trimStart(),
  };
}

export function showMessageReplyMarkup(binding = null) {
  return {
    inline_keyboard: [[{
        text: "👀 Показать сообщение",
      callback_data: taskViewCallbackData({ action: "show", ...binding }) ?? "show-message",
    }]],
  };
}

async function readStdin() {
  if (process.stdin.isTTY) return "";
  const chunks = [];
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) chunks.push(chunk);
  return chunks.join("").trim();
}

async function sendTelegramMessage(
  token,
  apiBaseUrl,
  chatId,
  text,
  silent,
  parseMode = null,
  replyMarkup = null,
  { outbox = null, binding = null } = {},
) {
  const body = {
    chat_id: chatId,
    text,
    disable_notification: silent,
  };
  if (parseMode) body.parse_mode = parseMode;
  if (replyMarkup) body.reply_markup = replyMarkup;
  try {
    return await callTelegramJson({ token, apiBaseUrl, method: "sendMessage", body });
  } catch (error) {
    if (!outbox || error?.retryable !== true) throw error;
    const item = await outbox.enqueue({ method: "sendMessage", body, binding });
    return { queued: true, outboxId: item.id };
  }
}

async function sendTelegramNotificationCard(
  token,
  apiBaseUrl,
  chatId,
  file,
  caption,
  silent,
  replyMarkup,
) {
  const form = new FormData();
  form.append("chat_id", String(chatId));
  form.append("disable_notification", String(silent));
  form.append("parse_mode", "HTML");
  form.append("caption", caption);
  form.append("reply_markup", JSON.stringify(replyMarkup));
  form.append("photo", new Blob([await readFile(file)], { type: "image/png" }), path.basename(file));

  try {
    const response = await fetch(telegramBotApiUrl(apiBaseUrl, token, "sendPhoto"), {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(40_000),
    });
    const payload = await response.json();
    if (!payload.ok) {
      const error = new Error(`Telegram sendPhoto: ${payload.description ?? response.status}`);
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

export function notificationCardOutboxBody({
  chatId,
  file,
  caption,
  silent,
  replyMarkup,
}) {
  return {
    chat_id: chatId,
    caption,
    disable_notification: silent,
    parse_mode: "HTML",
    reply_markup: replyMarkup,
    photo_path: file,
  };
}

export async function main(args = process.argv.slice(2)) {
  const options = parseArguments(args);
  if (options.help) {
    console.log("Usage: node send-message.mjs [--chat-id <id>] [--silent] [--bind-current | --bind-active] [--category <name>] [--message-file <utf8-file> | <message>]");
    console.log("       <command> | node send-message.mjs [--chat-id <id>] [--silent] [--bind-current | --bind-active] [--category <name>]");
    console.log(`Categories: ${Object.keys(NOTIFICATION_CATEGORIES).join(", ")} (default: info; used with a binding option)`);
    return;
  }
  const text = await resolveMessageText(options);
  const config = await loadConfig();
  const chatId = resolveChatId(config, options.chatId);
  const outbox = new PersistentDeliveryOutbox({
    directoryPath: config.deliveryOutboxDir,
    deliver: async () => {},
  });
  const sent = [];
  let parts;
  if (options.bindCurrent || options.bindActive) {
    const state = JSON.parse(await readFile(config.stateFile, "utf8"));
    const task = options.bindCurrent
      ? await currentCallerBinding(state)
      : currentThreadBinding(state);
    const project = findContainingProject(config.projects, task.projectRoot);
    if (!project) {
      throw new Error(`cannot bind a reply: ${task.projectRoot} is outside the configured Telegram projects`);
    }
    task.projectRoot = project.path;
    const binding = {
      chatId,
      ...task,
      createdAt: new Date().toISOString(),
    };
    const notification = notificationParts(task.taskTitle, text, options.category);
    try {
      sent.push(await sendTelegramNotificationCard(
        config.token,
        config.telegramApiBaseUrl,
        chatId,
        notification.cardPath,
        notification.caption,
        options.silent,
        showMessageReplyMarkup(binding),
      ));
    } catch (error) {
      if (error?.retryable === true) {
        const item = await outbox.enqueue({
          method: "sendPhotoFile",
          body: notificationCardOutboxBody({
            chatId,
            file: notification.cardPath,
            caption: notification.caption,
            silent: options.silent,
            replyMarkup: showMessageReplyMarkup(binding),
          }),
          binding,
        });
        sent.push({ queued: true, outboxId: item.id });
        console.error(`Cannot send notification card now; queued the image: ${error.message}`);
      } else {
        console.error(`Cannot send notification card; falling back to text: ${error.message}`);
        sent.push(await sendTelegramMessage(
          config.token,
          config.telegramApiBaseUrl,
          chatId,
          notification.fallbackMessage,
          options.silent,
          "HTML",
          showMessageReplyMarkup(binding),
          { outbox, binding },
        ));
      }
    }
    parts = notification.remaining ? splitTelegramText(notification.remaining) : [];
    for (const part of parts) {
      sent.push(await sendTelegramMessage(
        config.token,
        config.telegramApiBaseUrl,
        chatId,
        part,
        options.silent,
        null,
        null,
        { outbox, binding },
      ));
    }
    await appendMessageBindings(config.dataDir, sent
      .filter((message) => Number.isSafeInteger(message?.message_id))
      .map((message) => ({
        ...binding,
        messageId: message.message_id,
      })));
  } else {
    parts = splitTelegramText(text);
    for (const part of parts) {
      sent.push(await sendTelegramMessage(
        config.token,
        config.telegramApiBaseUrl,
        chatId,
        part,
        options.silent,
        null,
        null,
        { outbox },
      ));
    }
  }
  const queued = sent.filter((message) => message?.queued).length;
  console.log(queued
    ? `Queued ${queued} Telegram message(s) for chat ${chatId}.`
    : `Sent ${sent.length} message(s) to Telegram chat ${chatId}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const run = async () => {
    const args = process.argv.slice(2);
    if (process.env.TELEGRAM_INTEGRATION_DIRECT !== "1") {
      try {
        const result = await forwardRuntimeCommand("send-message", args);
        if (result) console.log(result);
        return;
      } catch (error) {
        if (!runtimeCommandUnavailable(error)) throw error;
      }
    }
    await main(args);
  };
  run().catch((error) => {
    console.error(`Cannot send Telegram message: ${error.message}`);
    process.exitCode = 1;
  });
}
