import { access, unlink } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

function booleanLabel(value) {
  return value ? "Включено" : "Выключено";
}

function secondsLabel(value) {
  const seconds = Math.max(0, Number(value) || 0);
  return `${seconds} с`;
}

export function agentHubAutostartShortcut({ environment = process.env } = {}) {
  const appData = String(environment.APPDATA ?? "").trim();
  if (!appData) return "";
  return path.join(
    appData,
    "Microsoft",
    "Windows",
    "Start Menu",
    "Programs",
    "Startup",
    "Agent Hub.lnk",
  );
}

export async function readAgentHubAutostart({
  platform = process.platform,
  shortcutPath = agentHubAutostartShortcut(),
  accessImpl = access,
} = {}) {
  if (platform !== "win32") return { supported: false, enabled: false };
  if (!shortcutPath) return { supported: true, enabled: false };
  try {
    await accessImpl(shortcutPath);
    return { supported: true, enabled: true };
  } catch {
    return { supported: true, enabled: false };
  }
}

export async function setAgentHubAutostart(enabled, {
  platform = process.platform,
  shortcutPath = agentHubAutostartShortcut(),
  installAutostart,
  unlinkImpl = unlink,
} = {}) {
  if (platform !== "win32") throw new Error("Автозапуск Agent Hub поддержан только в Windows");
  if (enabled) {
    if (typeof installAutostart !== "function") throw new Error("Установщик автозапуска недоступен");
    await installAutostart();
    return { supported: true, enabled: true };
  }
  if (shortcutPath) {
    try {
      await unlinkImpl(shortcutPath);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return { supported: true, enabled: false };
}

export function serverPageSnapshot({
  config,
  processId = process.pid,
  startedAt,
  activeCount = 0,
  restart = {},
  autostart = { supported: false, enabled: false },
} = {}) {
  return {
    process: {
      status: "running",
      pid: Number(processId) || null,
      startedAt: startedAt ?? null,
      activeCount: Math.max(0, Number(activeCount) || 0),
    },
    autostart: {
      supported: autostart.supported === true,
      enabled: autostart.enabled === true,
    },
    restart: {
      pending: restart.pending === true,
      waiting: restart.waiting === true,
      blockingCount: Math.max(0, Number(restart.blockingCount) || 0),
    },
    components: [
      {
        id: "core",
        name: "Локальный HUB",
        enabled: true,
        note: "Журнал, очередь, App Server и IPC.",
      },
      {
        id: "telegram",
        name: "Telegram",
        enabled: config?.components?.telegram === true,
        note: config?.components?.telegram === true ? "Бот и Mini App." : "Компонент отключён.",
      },
      {
        id: "web-app",
        name: "Web App",
        enabled: config?.components?.webApp === true,
        note: config?.components?.webApp === true ? "Браузер, Android и Desktop WebView." : "Компонент отключён.",
      },
      {
        id: "worker",
        name: "Публикация Worker",
        enabled: config?.miniApp?.worker?.enabled === true,
        note: config?.miniApp?.worker?.enabled === true ? "Защищённый внешний доступ." : "Не используется.",
      },
    ],
    configuration: [
      { name: "Автоподтверждение при запуске", value: booleanLabel(config?.autoApproveOnStart) },
      { name: "Защита параллельной записи", value: booleanLabel(config?.guardConcurrentRepositoryWrites) },
      { name: "Контекст Codex", value: booleanLabel(config?.codexRolloutContext?.enabled) },
      { name: "Тайм-аут Codex RPC", value: secondsLabel(config?.codexRpcTimeoutSeconds) },
      { name: "Очередь входящих", value: `${Math.max(0, Number(config?.deferredInputTtlHours) || 0)} ч` },
      { name: "Появление прогресса", value: `${Math.max(0, Number(config?.progressStartDelayMs) || 0)} мс` },
      { name: "Повтор доставки", value: secondsLabel(config?.deliveryRetryIntervalSeconds) },
      { name: "Журналы", value: `${Math.max(0, Number(config?.logMaxFiles) || 0)} файлов` },
    ],
  };
}
