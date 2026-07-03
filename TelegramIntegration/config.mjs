import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

export const INTEGRATION_ROOT = path.resolve(import.meta.dirname);

function resolveFromIntegration(value) {
  return path.resolve(INTEGRATION_ROOT, value);
}

function requireIntegerArray(value, name) {
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => !Number.isSafeInteger(item))) {
    throw new Error(`${name} must be a non-empty array of integer Telegram IDs`);
  }
  return new Set(value);
}

export async function loadConfig() {
  const configPath = path.resolve(
    process.env.TELEGRAM_CODEX_CONFIG ?? path.join(INTEGRATION_ROOT, "config.json"),
  );
  let raw;
  try {
    raw = JSON.parse(await readFile(configPath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(`Configuration not found: ${configPath}. Copy config.example.json to config.json.`);
    }
    throw new Error(`Cannot read ${configPath}: ${error.message}`);
  }

  const token = String(process.env.TELEGRAM_BOT_TOKEN ?? raw.telegramBotToken ?? "").trim();
  if (!/^\d+:[A-Za-z0-9_-]+$/.test(token)) {
    throw new Error("telegramBotToken is missing or invalid");
  }

  const projectRoot = path.resolve(
    process.env.CODEX_PROJECT_ROOT ?? raw.projectRoot ?? path.join(INTEGRATION_ROOT, "..", ".."),
  );
  const allowedUserIds = requireIntegerArray(raw.allowedUserIds, "allowedUserIds");
  const allowedChatIds = raw.allowedChatIds == null
    ? null
    : requireIntegerArray(raw.allowedChatIds, "allowedChatIds");
  const dataDir = resolveFromIntegration(raw.dataDir ?? "data");

  return {
    configPath,
    token,
    projectRoot,
    allowedUserIds,
    allowedChatIds,
    privateChatsOnly: raw.privateChatsOnly !== false,
    voiceEnabled: raw.voiceEnabled !== false,
    whisperModel: String(raw.whisperModel ?? "small"),
    pythonExe: path.resolve(
      process.env.WHISPER_PYTHON ?? raw.pythonExe ?? path.join(
        INTEGRATION_ROOT,
        ".venv-telegram",
        process.platform === "win32" ? path.join("Scripts", "python.exe") : path.join("bin", "python"),
      ),
    ),
    dataDir,
    stateFile: path.join(dataDir, "state.json"),
    audioDir: path.join(dataDir, "audio"),
  };
}
