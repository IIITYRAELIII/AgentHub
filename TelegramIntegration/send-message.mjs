import { readFile } from "node:fs/promises";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { loadConfig } from "./config.mjs";
import { appendMessageBindings } from "./message-bindings.mjs";

const TELEGRAM_MESSAGE_LIMIT = 4096;

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
    } else if (argument === "--help" || argument === "-h") {
      return { help: true, chatId, silent, bindCurrent, text: "" };
    } else {
      textParts.push(argument);
    }
  }
  return { help: false, chatId, silent, bindCurrent, text: textParts.join(" ").trim() };
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

export function notificationParts(taskTitle, text) {
  const title = String(taskTitle).trim() || "Задача";
  const value = String(text).trim();
  const escapedHeader = `🧵 <b>${escapeHtml(title)}</b> 🧵\n\n`;
  const firstLimit = Math.max(1, TELEGRAM_MESSAGE_LIMIT - escapedHeader.length - 32);
  const firstText = value.slice(0, firstLimit);
  return {
    message: `${escapedHeader}${escapeHtml(firstText)}`,
    remaining: value.slice(firstText.length).trimStart(),
  };
}

async function readStdin() {
  if (process.stdin.isTTY) return "";
  const chunks = [];
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) chunks.push(chunk);
  return chunks.join("").trim();
}

async function sendTelegramMessage(token, chatId, text, silent, parseMode = null) {
  const body = {
    chat_id: chatId,
    text,
    disable_notification: silent,
  };
  if (parseMode) body.parse_mode = parseMode;
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(40000),
  });
  const payload = await response.json();
  if (!payload.ok) throw new Error(`Telegram sendMessage: ${payload.description ?? response.status}`);
  return payload.result;
}

export async function main(args = process.argv.slice(2)) {
  const options = parseArguments(args);
  if (options.help) {
    console.log("Usage: node send-message.mjs [--chat-id <id>] [--silent] [--bind-current] <message>");
    console.log("       <command> | node send-message.mjs [--chat-id <id>] [--silent] [--bind-current]");
    return;
  }
  const text = options.text || await readStdin();
  const config = await loadConfig();
  const chatId = resolveChatId(config, options.chatId);
  const sent = [];
  let parts;
  if (options.bindCurrent) {
    const state = JSON.parse(await readFile(config.stateFile, "utf8"));
    const task = currentThreadBinding(state);
    const notification = notificationParts(task.taskTitle, text);
    sent.push(await sendTelegramMessage(config.token, chatId, notification.message, options.silent, "HTML"));
    parts = notification.remaining ? splitTelegramText(notification.remaining) : [];
    for (const part of parts) sent.push(await sendTelegramMessage(config.token, chatId, part, options.silent));
    const createdAt = new Date().toISOString();
    await appendMessageBindings(config.dataDir, sent.map((message) => ({
      chatId,
      messageId: message.message_id,
      ...task,
      createdAt,
    })));
  } else {
    parts = splitTelegramText(text);
    for (const part of parts) sent.push(await sendTelegramMessage(config.token, chatId, part, options.silent));
  }
  console.log(`Sent ${sent.length} message(s) to Telegram chat ${chatId}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`Cannot send Telegram message: ${error.message}`);
    process.exitCode = 1;
  });
}
