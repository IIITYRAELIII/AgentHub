import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { findContainingProject, loadConfig } from "./src/infrastructure/filesystem/config.mjs";
import {
  currentCallerBinding,
  currentThreadBinding,
  resolveChatId,
} from "./send-message.mjs";
import { appendMessageBindings } from "./src/infrastructure/persistence/message-bindings.mjs";
import { telegramBotApiUrl } from "./src/infrastructure/telegram/telegram-api.mjs";
import { forwardRuntimeCommand, runtimeCommandUnavailable } from "./src/infrastructure/process/runtime-command.mjs";
import { isMainModule } from "./src/infrastructure/process/main-module.mjs";
import { resolveAllowedNotificationPath } from "./src/infrastructure/telegram/notification-security.mjs";
import { readRuntimeState } from "./src/infrastructure/persistence/runtime-state-store.mjs";
import { parseSendImagesArguments } from "./src/infrastructure/telegram/notification-command-arguments.mjs";

export const parseArguments = parseSendImagesArguments;

export function albumMedia(files, caption = "") {
  return files.map((file, index) => ({
    type: "photo",
    media: `attach://photo${index}`,
    ...(index === 0 && caption ? { caption } : {}),
  }));
}

async function resolveBinding(config, options) {
  if (!options.bindCurrent && !options.bindActive) return null;

  const state = await readRuntimeState(config.dataDir, { legacyFile: config.stateFile });
  if (!state) throw new Error("Agent Hub runtime state is not available");
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
  const options = parseSendImagesArguments(args);
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
