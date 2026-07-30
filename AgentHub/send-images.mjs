import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { findContainingProject, loadConfig } from "./config.mjs";
import {
  currentCallerBinding,
  currentThreadBinding,
  resolveChatId,
} from "./send-message.mjs";
import { appendMessageBindings } from "./message-bindings.mjs";
import { telegramBotApiUrl } from "./telegram-api.mjs";
import { forwardRuntimeCommand, runtimeCommandUnavailable } from "./runtime-command.mjs";
import { isMainModule } from "./main-module.mjs";
import { resolveAllowedNotificationPath } from "./notification-security.mjs";

const MAX_ALBUM_SIZE = 10;

export function parseArguments(args) {
  let chatId = null;
  let silent = false;
  let bindCurrent = false;
  let bindActive = false;
  let caption = "";
  const files = [];

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--chat-id") {
      if (index + 1 >= args.length) throw new Error("--chat-id requires a value");
      chatId = args[++index];
    } else if (argument === "--caption") {
      if (index + 1 >= args.length) throw new Error("--caption requires a value");
      caption = args[++index];
    } else if (argument === "--silent") {
      silent = true;
    } else if (argument === "--bind-current") {
      bindCurrent = true;
    } else if (argument === "--bind-active") {
      bindActive = true;
    } else if (argument === "--help" || argument === "-h") {
      return { help: true, chatId, silent, bindCurrent, bindActive, caption, files };
    } else {
      files.push(argument);
    }
  }

  if (bindCurrent && bindActive) throw new Error("Use either --bind-current or --bind-active, not both");
  if (!files.length && !args.includes("--help") && !args.includes("-h")) {
    throw new Error("Specify at least one image");
  }
  if (files.length > MAX_ALBUM_SIZE) {
    throw new Error(`Telegram albums contain at most ${MAX_ALBUM_SIZE} images`);
  }

  return { help: false, chatId, silent, bindCurrent, bindActive, caption, files };
}

export function albumMedia(files, caption = "") {
  return files.map((file, index) => ({
    type: "photo",
    media: `attach://photo${index}`,
    ...(index === 0 && caption ? { caption } : {}),
  }));
}

async function resolveBinding(config, options) {
  if (!options.bindCurrent && !options.bindActive) return null;

  const state = JSON.parse(await readFile(config.stateFile, "utf8"));
  const task = options.bindCurrent
    ? await currentCallerBinding(state)
    : currentThreadBinding(state);
  const project = findContainingProject(config.projects, task.projectRoot);
  if (!project) {
    throw new Error(`cannot bind a reply: ${task.projectRoot} is outside the configured Telegram projects`);
  }
  task.projectRoot = project.path;
  return task;
}

async function sendSingleImage(config, chatId, file, caption, silent) {
  const form = new FormData();
  form.append("chat_id", String(chatId));
  form.append("disable_notification", String(silent));
  if (caption) form.append("caption", caption);
  form.append("photo", new Blob([await readFile(file)], { type: "image/png" }), path.basename(file));

  const response = await fetch(telegramBotApiUrl(config.telegramApiBaseUrl, config.token, "sendPhoto"), {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(40000),
  });
  const payload = await response.json();
  if (!payload.ok) throw new Error(`Telegram sendPhoto: ${payload.description ?? response.status}`);
  return [payload.result];
}

async function sendAlbum(config, chatId, files, caption, silent) {
  const form = new FormData();
  form.append("chat_id", String(chatId));
  form.append("disable_notification", String(silent));
  form.append("media", JSON.stringify(albumMedia(files, caption)));

  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    form.append(
      `photo${index}`,
      new Blob([await readFile(file)], { type: "image/png" }),
      path.basename(file),
    );
  }

  const response = await fetch(telegramBotApiUrl(config.telegramApiBaseUrl, config.token, "sendMediaGroup"), {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(40000),
  });
  const payload = await response.json();
  if (!payload.ok) throw new Error(`Telegram sendMediaGroup: ${payload.description ?? response.status}`);
  return payload.result;
}

export async function main(args = process.argv.slice(2)) {
  const options = parseArguments(args);
  if (options.help) {
    console.log("Usage: node send-images.mjs [--chat-id <id>] [--silent]");
    console.log("       [--bind-current | --bind-active] [--caption <text>] <image> [image...]");
    return;
  }

  const config = await loadConfig();
  const chatId = resolveChatId(config, options.chatId);
  const files = await Promise.all(options.files.map((file) => resolveAllowedNotificationPath(file, {
    roots: config.projects.map((project) => project.path),
  })));
  const task = await resolveBinding(config, options);
  const caption = options.caption || (task ? `Код — ${task.taskTitle}` : "");
  const sent = files.length === 1
    ? await sendSingleImage(config, chatId, files[0], caption, options.silent)
    : await sendAlbum(config, chatId, files, caption, options.silent);

  if (task) {
    const createdAt = new Date().toISOString();
    await appendMessageBindings(config.dataDir, sent.map((message) => ({
      chatId,
      messageId: message.message_id,
      ...task,
      createdAt,
    })));
  }

  console.log(`Sent ${sent.length} image(s) to Telegram chat ${chatId}.`);
}

if (isMainModule(import.meta.url)) {
  const run = async () => {
    const args = process.argv.slice(2);
    if (process.env.AGENT_HUB_DIRECT !== "1") {
      try {
        const result = await forwardRuntimeCommand("send-images", args);
        if (result) console.log(result);
        return;
      } catch (error) {
        if (!runtimeCommandUnavailable(error)) throw error;
      }
    }
    await main(args);
  };
  run().catch((error) => {
    console.error(`Cannot send Telegram images: ${error.message}`);
    process.exitCode = 1;
  });
}
