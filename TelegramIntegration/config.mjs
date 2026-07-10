import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { CLAUDE_PERMISSION_MODES } from "./claude.mjs";

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

function positiveInteger(value, fallback, name) {
  const number = Number(value ?? fallback);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return number;
}

function samePath(left, right) {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function loadProjects(raw, defaultRoot) {
  if (raw.projects == null) {
    return [{ name: path.basename(defaultRoot) || defaultRoot, path: defaultRoot }];
  }
  if (!Array.isArray(raw.projects) || raw.projects.length === 0) {
    throw new Error("projects must be a non-empty array");
  }

  const projects = raw.projects.map((project, index) => {
    if (!project || typeof project !== "object" || Array.isArray(project)) {
      throw new Error(`projects[${index}] must be an object with name and path`);
    }
    const projectPath = String(project.path ?? "").trim();
    if (!projectPath) throw new Error(`projects[${index}].path is missing`);
    const resolvedPath = path.resolve(projectPath);
    const name = String(project.name ?? path.basename(resolvedPath) ?? "").trim();
    if (!name) throw new Error(`projects[${index}].name is missing`);
    return { name, path: resolvedPath };
  });

  for (let index = 0; index < projects.length; index += 1) {
    if (projects.findIndex((project) => samePath(project.path, projects[index].path)) !== index) {
      throw new Error(`projects contains duplicate path: ${projects[index].path}`);
    }
  }
  if (!projects.some((project) => samePath(project.path, defaultRoot))) {
    throw new Error("projectRoot must match one of the paths in projects");
  }
  return projects;
}

function loadCodexModels(raw) {
  const defaultModels = [
    { value: "gpt-5.5", label: "GPT-5.5" },
    { value: "gpt-5.6-sol", label: "GPT-5.6-Sol" },
    { value: "gpt-5.6-terra", label: "GPT-5.6-Terra" },
    { value: "gpt-5.6-luna", label: "GPT-5.6-Luna" },
    { value: "gpt-5.4", label: "GPT-5.4" },
    { value: "gpt-5.4-mini", label: "GPT-5.4-Mini" },
    { value: "gpt-5.3-codex-spark", label: "GPT-5.3-Codex-Spark" },
  ];
  const source = raw.codexModels ?? defaultModels;
  if (!Array.isArray(source) || source.length === 0) {
    throw new Error("codexModels must be a non-empty array");
  }

  const models = source.map((model, index) => {
    if (typeof model === "string") {
      const value = model.trim();
      if (!value) throw new Error(`codexModels[${index}] is empty`);
      return { value, label: value };
    }
    if (!model || typeof model !== "object" || Array.isArray(model)) {
      throw new Error(`codexModels[${index}] must be a string or object`);
    }
    const value = String(model.value ?? model.slug ?? "").trim();
    if (!value) throw new Error(`codexModels[${index}].value is missing`);
    const label = String(model.label ?? model.displayName ?? model.display_name ?? value).trim();
    return { value, label: label || value };
  });

  for (let index = 0; index < models.length; index += 1) {
    if (models.findIndex((model) => model.value === models[index].value) !== index) {
      throw new Error(`codexModels contains duplicate value: ${models[index].value}`);
    }
  }
  return models;
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
  const projects = process.env.CODEX_PROJECT_ROOT
    ? [{ name: path.basename(projectRoot) || projectRoot, path: projectRoot }]
    : loadProjects(raw, projectRoot);
  const allowedUserIds = requireIntegerArray(raw.allowedUserIds, "allowedUserIds");
  const allowedChatIds = raw.allowedChatIds == null
    ? null
    : requireIntegerArray(raw.allowedChatIds, "allowedChatIds");
  const dataDir = resolveFromIntegration(raw.dataDir ?? "data");
  const defaultTtsVenv = process.platform === "win32"
    ? path.join(process.env.LOCALAPPDATA ?? INTEGRATION_ROOT, "TelegramIntegration", "tts-venv")
    : path.join(INTEGRATION_ROOT, ".venv-tts");
  const provider = String(process.env.AI_PROVIDER ?? raw.provider ?? "codex").trim().toLowerCase();
  if (provider !== "codex" && provider !== "claude") {
    throw new Error('provider must be either "codex" or "claude"');
  }
  const claudePermissionMode = String(raw.claudePermissionMode ?? "acceptEdits").trim();
  if (!CLAUDE_PERMISSION_MODES.has(claudePermissionMode)) {
    throw new Error(
      `claudePermissionMode must be one of: ${[...CLAUDE_PERMISSION_MODES].join(", ")}`,
    );
  }

  return {
    configPath,
    token,
    projectRoot,
    projects,
    showProjectButton: raw.showProjectButton !== false,
    provider,
    codexExecutable: String(process.env.CODEX_EXECUTABLE ?? raw.codexExecutable ?? "").trim(),
    codexModel: String(process.env.CODEX_MODEL ?? raw.codexModel ?? "").trim(),
    codexModels: loadCodexModels(raw),
    claudeExecutable: String(process.env.CLAUDE_EXECUTABLE ?? raw.claudeExecutable ?? "claude").trim(),
    claudeModel: String(process.env.CLAUDE_MODEL ?? raw.claudeModel ?? "").trim(),
    claudePermissionMode,
    allowedUserIds,
    allowedChatIds,
    privateChatsOnly: raw.privateChatsOnly !== false,
    voiceEnabled: raw.voiceEnabled !== false,
    whisperModel: String(raw.whisperModel ?? "small"),
    ttsEnabled: raw.ttsEnabled !== false,
    ttsModel: String(raw.ttsModel ?? "v5_5_ru").trim(),
    ttsSpeaker: String(raw.ttsSpeaker ?? "xenia").trim(),
    ttsIdleTimeoutSeconds: positiveInteger(
      process.env.TTS_IDLE_TIMEOUT_SECONDS ?? raw.ttsIdleTimeoutSeconds,
      900,
      "ttsIdleTimeoutSeconds",
    ),
    ttsButtonMinChars: positiveInteger(raw.ttsButtonMinChars, 600, "ttsButtonMinChars"),
    ttsMaxChars: positiveInteger(raw.ttsMaxChars, 20000, "ttsMaxChars"),
    pythonExe: path.resolve(
      process.env.WHISPER_PYTHON ?? raw.pythonExe ?? path.join(
        INTEGRATION_ROOT,
        ".venv-telegram",
        process.platform === "win32" ? path.join("Scripts", "python.exe") : path.join("bin", "python"),
      ),
    ),
    ttsPythonExe: path.resolve(
      process.env.TTS_PYTHON ?? raw.ttsPythonExe ?? path.join(
        defaultTtsVenv,
        process.platform === "win32" ? path.join("Scripts", "python.exe") : path.join("bin", "python"),
      ),
    ),
    dataDir,
    stateFile: path.join(dataDir, "state.json"),
    audioDir: path.join(dataDir, "audio"),
    ttsDir: path.join(dataDir, "tts"),
  };
}
