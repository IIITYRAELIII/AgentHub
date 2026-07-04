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
    provider,
    claudeExecutable: String(process.env.CLAUDE_EXECUTABLE ?? raw.claudeExecutable ?? "claude").trim(),
    claudeModel: String(process.env.CLAUDE_MODEL ?? raw.claudeModel ?? "").trim(),
    claudePermissionMode,
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
