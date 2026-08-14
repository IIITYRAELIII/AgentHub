#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { loadConfig } from "./src/infrastructure/filesystem/config.mjs";
import { SharedDashboardBotClient } from "./src/interfaces/web/shared-dashboard-bot-client.mjs";

async function sharedDashboardBotConfig(config) {
  const resolvedConfig = config ?? await loadConfig();
  if (!resolvedConfig.sharedDashboardBot?.enabled) {
    throw new Error("Компонент shared-dashboard-bot не включён. Запустите install.py --enable-component shared-dashboard-bot.");
  }
  return resolvedConfig.sharedDashboardBot;
}

export async function createSharedDashboardBotEnrollment({
  config = null,
  stdout = process.stdout,
} = {}) {
  const sharedBot = await sharedDashboardBotConfig(config);
  const secret = (await readFile(sharedBot.secretFile, "utf8")).trim();
  if (secret.length < 32 || secret.length > 256) {
    throw new Error("Shared Dashboard bot secret must contain 32-256 characters");
  }
  const enrollment = {
    version: 1,
    hubId: sharedBot.hubId,
    verifier: `sha256:${createHash("sha256").update(secret).digest("hex")}`,
  };
  stdout.write(`${JSON.stringify(enrollment)}\n`);
  return enrollment;
}

export async function createSharedDashboardBotPairing({
  config = null,
  fetchImpl = globalThis.fetch,
  stdout = process.stdout,
} = {}) {
  const sharedBot = await sharedDashboardBotConfig(config);
  const client = new SharedDashboardBotClient({
    ...sharedBot,
    fetchImpl,
    handler: async () => null,
  });
  const pairing = await client.createPairing();
  if (pairing.paired) {
    stdout.write(`Общий бот уже привязан к Telegram user ID ${pairing.userId}.\n`);
  } else {
    stdout.write(`Отправьте общему Telegram-боту: /link ${pairing.code}\n`);
    stdout.write(`Код действует до ${new Date(pairing.expiresAt).toLocaleString("ru-RU")}.\n`);
  }
  return pairing;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const operation = process.argv.includes("--enrollment")
    ? createSharedDashboardBotEnrollment
    : createSharedDashboardBotPairing;
  operation().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
