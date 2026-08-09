#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const WEBHOOK_SECRET_PATTERN = /^[A-Za-z0-9_-]{32,256}$/u;
const BOT_TOKEN_PATTERN = /^\d+:[A-Za-z0-9_-]{20,}$/u;

export async function configureSharedDashboardBotWebhook({
  publicUrl,
  tokenFile,
  webhookSecretFile,
  fetchImpl = globalThis.fetch,
} = {}) {
  const origin = new URL(String(publicUrl ?? ""));
  if (origin.protocol !== "https:" || origin.pathname !== "/" || origin.search || origin.hash) {
    throw new Error("publicUrl must be an HTTPS origin without path, query or hash");
  }
  const token = (await readFile(path.resolve(String(tokenFile ?? "")), "utf8")).trim();
  const webhookSecret = (await readFile(path.resolve(String(webhookSecretFile ?? "")), "utf8")).trim();
  if (!BOT_TOKEN_PATTERN.test(token)) throw new Error("token file does not contain a valid Telegram bot token");
  if (!WEBHOOK_SECRET_PATTERN.test(webhookSecret)) {
    throw new Error("webhook secret must contain 32-256 ASCII letters, digits, underscores or hyphens");
  }
  const webhookUrl = new URL("/api/dashboard-bot/webhook", origin).href;
  const telegram = async (method, body) => {
    const response = await fetchImpl(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result.ok !== true) {
      throw new Error(`Telegram ${method} failed: ${result.description ?? `HTTP ${response.status}`}`);
    }
  };
  await telegram("setWebhook", {
    url: webhookUrl,
    secret_token: webhookSecret,
    allowed_updates: ["message", "callback_query"],
    drop_pending_updates: false,
  });
  await telegram("setMyCommands", {
    commands: [
      { command: "link", description: "Привязать свой Agent Hub" },
      { command: "done", description: "Отправить собранную пачку" },
      { command: "separate", description: "Отправить задачи раздельно" },
      { command: "cancel", description: "Отменить текущую пачку" },
      { command: "unlink", description: "Удалить привязку" },
      { command: "help", description: "Как пользоваться ботом" },
    ],
  });
  return { ok: true, webhookUrl };
}

async function main() {
  const { values } = parseArgs({
    options: {
      url: { type: "string" },
      "token-file": { type: "string" },
      "webhook-secret-file": { type: "string" },
    },
    strict: true,
  });
  if (!values.url || !values["token-file"] || !values["webhook-secret-file"]) {
    throw new Error("Usage: npm run dashboard-bot:webhook -- --url https://hub.example.com --token-file <path> --webhook-secret-file <path>");
  }
  const result = await configureSharedDashboardBotWebhook({
    publicUrl: values.url,
    tokenFile: values["token-file"],
    webhookSecretFile: values["webhook-secret-file"],
  });
  console.log(`Общий Telegram webhook настроен: ${result.webhookUrl}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
