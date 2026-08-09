#!/usr/bin/env node

import { loadConfig } from "./src/infrastructure/filesystem/config.mjs";
import { SharedDashboardBotClient } from "./src/interfaces/web/shared-dashboard-bot-client.mjs";
import { pathToFileURL } from "node:url";

export async function createSharedDashboardBotPairing({
  config = null,
  fetchImpl = globalThis.fetch,
  stdout = process.stdout,
} = {}) {
  const resolvedConfig = config ?? await loadConfig();
  if (!resolvedConfig.sharedDashboardBot?.enabled) {
    throw new Error("Компонент shared-dashboard-bot не включён. Запустите install.py --enable-component shared-dashboard-bot.");
  }
  const client = new SharedDashboardBotClient({
    ...resolvedConfig.sharedDashboardBot,
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
  createSharedDashboardBotPairing().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
