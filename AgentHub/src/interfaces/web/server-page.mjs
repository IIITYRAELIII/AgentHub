import { randomUUID } from "node:crypto";
import { access, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { serverConfigurationEntries } from "./server-configuration.mjs";

export const ROOT_AGENTS_MAX_BYTES = 128 * 1024;

function requiredRootAgentsTarget(file) {
  const value = String(file ?? "").trim();
  if (!value) throw new Error("Путь корневого AGENTS.md не настроен");
  return path.resolve(value);
}

export function rootAgentsFile(projectRoot) {
  const root = String(projectRoot ?? "").trim();
  if (!root) throw new Error("Корень рабочего пространства Agent Hub не настроен");
  return path.join(path.resolve(root), "AGENTS.md");
}

export async function readRootAgents({
  file,
  maximumBytes = ROOT_AGENTS_MAX_BYTES,
  statImpl = stat,
  readFileImpl = readFile,
} = {}) {
  const target = requiredRootAgentsTarget(file);
  let fileStat;
  try {
    fileStat = await statImpl(target);
  } catch (error) {
    if (error?.code === "ENOENT") return { content: "", bytes: 0, maximumBytes, exists: false };
    throw error;
  }
  if (!fileStat.isFile()) throw new Error("Корневой AGENTS.md не является файлом");
  if (fileStat.size > maximumBytes) {
    throw new Error(`Корневой AGENTS.md превышает лимит ${maximumBytes} байт`);
  }
  const body = await readFileImpl(target);
  if (body.byteLength > maximumBytes) {
    throw new Error(`Корневой AGENTS.md превышает лимит ${maximumBytes} байт`);
  }
  return {
    content: body.toString("utf8"),
    bytes: body.byteLength,
    maximumBytes,
    exists: true,
  };
}

export async function updateRootAgents(content, {
  file,
  maximumBytes = ROOT_AGENTS_MAX_BYTES,
  writeFileImpl = writeFile,
  renameImpl = rename,
  unlinkImpl = unlink,
  createId = randomUUID,
} = {}) {
  if (typeof content !== "string") throw new Error("Содержимое AGENTS.md должно быть строкой");
  const body = Buffer.from(content, "utf8");
  if (body.byteLength > maximumBytes) {
    throw new Error(`Корневой AGENTS.md превышает лимит ${maximumBytes} байт`);
  }
  const target = requiredRootAgentsTarget(file);
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${createId()}.tmp`);
  try {
    await writeFileImpl(temporary, body, { flag: "wx", mode: 0o600 });
    await renameImpl(temporary, target);
  } finally {
    await unlinkImpl(temporary).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
  }
  return { content, bytes: body.byteLength, maximumBytes, exists: true };
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
  instanceId = "",
  releaseId = "",
  activeCount = 0,
  restart = {},
  autostart = { supported: false, enabled: false },
  pendingConfiguration = {},
} = {}) {
  const webAppEnabled = config?.miniApp?.enabled === true
    || config?.components?.miniApp === true
    || config?.components?.androidApp === true;
  const contextOptimizationEnabled = config?.contextAutomation?.autoCompactAfterTurn === true
    || config?.contextAutomation?.autoRotateAfterCompaction === true;

  return {
    process: {
      status: "running",
      pid: Number(processId) || null,
      startedAt: startedAt ?? null,
      instanceId: String(instanceId ?? "").trim() || null,
      releaseId: String(releaseId ?? "").trim() || null,
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
        note: "Журнал, очередь, App Server и локальные подключения.",
      },
      {
        id: "web-app",
        name: "Web App",
        enabled: webAppEnabled,
        note: webAppEnabled
          ? "Общий интерфейс для браузера и мобильных приложений."
          : "Не используется: Mini App и Android App выключены.",
      },
      {
        id: "telegram",
        name: "Telegram Bot",
        enabled: config?.components?.telegram === true,
        note: config?.components?.telegram === true
          ? "Принимает сообщения и управляет задачами."
          : "Бот отключён.",
      },
      {
        id: "shared-dashboard-bot",
        name: "Общий бот дашборда",
        enabled: config?.components?.sharedDashboardBot === true,
        note: config?.components?.sharedDashboardBot === true
          ? "Принимает карточки через общего командного Telegram-бота."
          : "Общий бот дашборда отключён.",
      },
      {
        id: "telegram-mini-app",
        name: "Telegram Mini App",
        enabled: config?.components?.miniApp === true,
        note: config?.components?.miniApp === true
          ? "Интерфейс Agent Hub внутри Telegram."
          : "Mini App отключено.",
      },
      {
        id: "android-app",
        name: "Android App",
        enabled: config?.components?.androidApp === true,
        note: config?.components?.androidApp === true
          ? "Отдельное мобильное приложение без Telegram."
          : "Android-приложение отключено.",
      },
      {
        id: "codex-context-optimization",
        name: "Оптимизация Codex",
        enabled: contextOptimizationEnabled,
        note: "Автосвёртка, авторотация и очистка контекста Codex.",
      },
    ],
    configuration: serverConfigurationEntries(config, pendingConfiguration),
  };
}
