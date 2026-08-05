import { access, readFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { isIP } from "node:net";
import path from "node:path";
import process from "node:process";
import {
  CLAUDE_PERMISSION_MODES,
  CODEX_COLLABORATION_MODES,
  CODEX_REASONING_EFFORTS,
  normalizeCodexSandboxMode,
} from "../../domain/agent-runtime-settings.mjs";
import { defaultRuntimeRoot, runtimeLayout } from "./runtime-layout.mjs";

export const AGENT_HUB_ROOT = path.resolve(import.meta.dirname);

export async function resolveConfigPath({
  environment = process.env,
  agentHubRoot = AGENT_HUB_ROOT,
  accessImpl = access,
} = {}) {
  const explicitConfig = environment.AGENT_HUB_CONFIG;
  if (explicitConfig) return path.resolve(explicitConfig);
  const layout = runtimeLayout(defaultRuntimeRoot({ environment }));
  const external = layout.configFile;
  const activation = layout.activationFile;
  try {
    await Promise.all([accessImpl(external), accessImpl(activation)]);
    return external;
  } catch {
    return path.join(agentHubRoot, "config.json");
  }
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

function nonNegativeInteger(value, fallback, name) {
  const number = Number(value ?? fallback);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return number;
}

function stringArray(value, name) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${name} must be an array of strings`);
  }
  return value.map((item) => item.trim()).filter(Boolean);
}

function codexRolloutContextSettings(value, { enabled = null } = {}) {
  const raw = value ?? {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("codexRolloutContext must be an object");
  }
  return {
    enabled: enabled == null ? raw.enabled === true : enabled === true,
    keepRecentImages: nonNegativeInteger(
      raw.keepRecentImages,
      4,
      "codexRolloutContext.keepRecentImages",
    ),
    minReclaimBytes: nonNegativeInteger(
      raw.minReclaimBytes,
      1024 * 1024,
      "codexRolloutContext.minReclaimBytes",
    ),
    scanIntervalSeconds: positiveInteger(
      raw.scanIntervalSeconds,
      30 * 60,
      "codexRolloutContext.scanIntervalSeconds",
    ),
    maxFilesPerPass: positiveInteger(
      raw.maxFilesPerPass,
      8,
      "codexRolloutContext.maxFilesPerPass",
    ),
  };
}

export function miniAppSettings(value, { configDirectory = process.cwd() } = {}) {
  const raw = value ?? {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("miniApp must be an object");
  }
  const host = String(raw.host ?? "127.0.0.1").trim().toLowerCase();
  if (!["127.0.0.1", "localhost", "::1"].includes(host)) {
    throw new Error("miniApp.host must be a loopback address for the local pilot");
  }
  const port = positiveInteger(raw.port, 8787, "miniApp.port");
  if (port > 65_535) throw new Error("miniApp.port must be at most 65535");
  const quickTunnelRaw = raw.quickTunnel ?? {};
  if (!quickTunnelRaw || typeof quickTunnelRaw !== "object" || Array.isArray(quickTunnelRaw)) {
    throw new Error("miniApp.quickTunnel must be an object");
  }
  const tunnelProvider = String(quickTunnelRaw.provider ?? "cloudflare").trim().toLowerCase();
  if (!["cloudflare", "pinggy"].includes(tunnelProvider)) {
    throw new Error("miniApp.quickTunnel.provider must be cloudflare or pinggy");
  }
  const tunnelMode = String(quickTunnelRaw.mode ?? "quick").trim().toLowerCase();
  if (!["quick", "named"].includes(tunnelMode)) {
    throw new Error("miniApp.quickTunnel.mode must be quick or named");
  }
  if (tunnelMode === "named" && tunnelProvider !== "cloudflare") {
    throw new Error("miniApp.quickTunnel.mode named requires provider cloudflare");
  }
  const executable = String(
    process.env.CLOUDFLARED_EXECUTABLE
      ?? quickTunnelRaw.executable
      ?? (tunnelProvider === "pinggy" ? "ssh" : "cloudflared"),
  ).trim();
  if (!executable) throw new Error("miniApp.quickTunnel.executable must not be empty");
  const publicPort = positiveInteger(
    quickTunnelRaw.publicPort,
    port + 1,
    "miniApp.quickTunnel.publicPort",
  );
  if (publicPort > 65_535 || publicPort === port) {
    throw new Error("miniApp.quickTunnel.publicPort must be a different valid port");
  }
  const controlPort = positiveInteger(
    quickTunnelRaw.controlPort,
    4300,
    "miniApp.quickTunnel.controlPort",
  );
  if (controlPort > 65_535 || controlPort === port || controlPort === publicPort) {
    throw new Error("miniApp.quickTunnel.controlPort must be a different valid port");
  }
  const menuText = String(quickTunnelRaw.menuText ?? "Журнал").trim();
  if (!menuText || menuText.length > 64) {
    throw new Error("miniApp.quickTunnel.menuText must contain 1-64 characters");
  }
  const edgeBindAddress = String(quickTunnelRaw.edgeBindAddress ?? "").trim() || null;
  if (edgeBindAddress && !isIP(edgeBindAddress)) {
    throw new Error("miniApp.quickTunnel.edgeBindAddress must be an IPv4 or IPv6 address");
  }
  let publicUrl = null;
  let tokenFile = null;
  if (tunnelMode === "named") {
    const rawPublicUrl = String(quickTunnelRaw.publicUrl ?? "").trim().replace(/\/+$/u, "");
    let parsedPublicUrl;
    try {
      parsedPublicUrl = new URL(rawPublicUrl);
    } catch {
      throw new Error("miniApp.quickTunnel.publicUrl must be an absolute HTTPS URL");
    }
    if (
      parsedPublicUrl.protocol !== "https:"
      || parsedPublicUrl.username
      || parsedPublicUrl.password
      || parsedPublicUrl.search
      || parsedPublicUrl.hash
      || parsedPublicUrl.pathname !== "/"
    ) {
      throw new Error("miniApp.quickTunnel.publicUrl must be an HTTPS origin without credentials, path, query or hash");
    }
    publicUrl = rawPublicUrl;
    const rawTokenFile = String(quickTunnelRaw.tokenFile ?? "").trim();
    if (!rawTokenFile) {
      throw new Error("miniApp.quickTunnel.tokenFile is required in named mode");
    }
    tokenFile = path.resolve(configDirectory, rawTokenFile);
  }
  const workerRaw = raw.worker ?? {};
  if (!workerRaw || typeof workerRaw !== "object" || Array.isArray(workerRaw)) {
    throw new Error("miniApp.worker must be an object");
  }
  const workerEnabled = workerRaw.enabled === true;
  const workerMenuText = String(workerRaw.menuText ?? "Журнал").trim();
  if (!workerMenuText || workerMenuText.length > 64) {
    throw new Error("miniApp.worker.menuText must contain 1-64 characters");
  }
  let workerPublicUrl = null;
  let workerSyncSecretFile = null;
  if (workerEnabled) {
    const rawWorkerPublicUrl = String(workerRaw.publicUrl ?? "").trim().replace(/\/+$/u, "");
    let parsedWorkerPublicUrl;
    try {
      parsedWorkerPublicUrl = new URL(rawWorkerPublicUrl);
    } catch {
      throw new Error("miniApp.worker.publicUrl must be an absolute HTTPS URL");
    }
    if (
      parsedWorkerPublicUrl.protocol !== "https:"
      || parsedWorkerPublicUrl.username
      || parsedWorkerPublicUrl.password
      || parsedWorkerPublicUrl.search
      || parsedWorkerPublicUrl.hash
      || parsedWorkerPublicUrl.pathname !== "/"
    ) {
      throw new Error("miniApp.worker.publicUrl must be an HTTPS origin without credentials, path, query or hash");
    }
    workerPublicUrl = rawWorkerPublicUrl;
    const rawSyncSecretFile = String(workerRaw.syncSecretFile ?? "").trim();
    if (!rawSyncSecretFile) {
      throw new Error("miniApp.worker.syncSecretFile is required when the Worker publisher is enabled");
    }
    workerSyncSecretFile = path.resolve(configDirectory, rawSyncSecretFile);
  }
  return {
    enabled: raw.enabled !== false,
    host,
    port,
    quickTunnel: {
      enabled: quickTunnelRaw.enabled === true,
      provider: tunnelProvider,
      mode: tunnelMode,
      executable,
      menuText,
      publicPort,
      controlPort,
      edgeBindAddress,
      publicUrl,
      tokenFile,
    },
    worker: {
      enabled: workerEnabled,
      publicUrl: workerPublicUrl,
      syncSecretFile: workerSyncSecretFile,
      menuText: workerMenuText,
      retrySeconds: positiveInteger(workerRaw.retrySeconds, 15, "miniApp.worker.retrySeconds"),
      refreshSeconds: positiveInteger(workerRaw.refreshSeconds, 60, "miniApp.worker.refreshSeconds"),
    },
  };
}

export function httpBaseUrl(value, name) {
  const normalized = String(value).trim().replace(/\/$/, "");
  let parsed;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error(`${name} must be an absolute HTTP(S) URL`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${name} must use HTTP or HTTPS`);
  }
  const loopback = parsed.hostname === "localhost"
    || parsed.hostname === "127.0.0.1"
    || parsed.hostname === "[::1]";
  if (parsed.protocol === "http:" && !loopback) {
    throw new Error(`${name} must use HTTPS unless it points to loopback`);
  }
  return normalized;
}

export function canonicalPath(value) {
  const resolved = path.resolve(value);
  let existing = resolved;
  const missingTail = [];
  while (true) {
    try {
      return path.join(realpathSync.native(existing), ...missingTail.reverse());
    } catch {
      const parent = path.dirname(existing);
      if (parent === existing) return resolved;
      missingTail.push(path.basename(existing));
      existing = parent;
    }
  }
}

export function samePath(left, right) {
  const a = canonicalPath(left);
  const b = canonicalPath(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

export function repositoryWriteGuardEnabled(raw = {}) {
  return raw.guardConcurrentRepositoryWrites === true;
}

export function pathInsideOrSame(child, parent) {
  const relative = path.relative(canonicalPath(parent), canonicalPath(child));
  return !relative || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function findContainingProject(projects, candidatePath) {
  return projects
    .filter((project) => pathInsideOrSame(candidatePath, project.path))
    .sort((left, right) => right.path.length - left.path.length)[0];
}

export function canonicalizeProjectRoots(value, projects) {
  const aliases = new Map(projects.map((project) => [project.path, project.path]));
  const discoverAliases = (text) => {
    const starts = text.matchAll(/[A-Za-z]:[\\/]/g);
    for (const match of starts) {
      const start = match.index;
      for (let end = start + 3; end <= text.length; end += 1) {
        const terminator = end === text.length || text[end] === "\\" || text[end] === "/" || text[end] === "\0";
        if (!terminator) continue;
        const candidate = text.slice(start, end);
        try {
          const project = findContainingProject(projects, candidate);
          if (project) {
            aliases.set(candidate, project.path);
            break;
          }
        } catch {
          // Arbitrary saved text may only resemble a filesystem path.
        }
      }
    }
  };
  const collectAliases = (item) => {
    if (typeof item === "string") {
      discoverAliases(item);
      return;
    }
    if (Array.isArray(item)) {
      item.forEach(collectAliases);
      return;
    }
    if (!item || typeof item !== "object") return;
    for (const [key, nested] of Object.entries(item)) {
      discoverAliases(key);
      if ((key === "projectRoot" || key === "activeProjectRoot") && typeof nested === "string") {
        const project = findContainingProject(projects, nested);
        if (project) aliases.set(nested, project.path);
      }
      collectAliases(nested);
    }
  };
  collectAliases(value);

  const orderedAliases = [...aliases.entries()]
    .filter(([alias, canonical]) => !samePath(alias, canonical) || alias !== canonical)
    .sort((left, right) => right[0].length - left[0].length);
  const rewriteString = (text) => {
    let result = text;
    for (const [alias, canonical] of orderedAliases) {
      const pattern = new RegExp(alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
      result = result.replace(pattern, (match) => (
        match === match.toLowerCase() ? canonical.toLowerCase() : canonical
      ));
    }
    return result;
  };
  const rewrite = (item) => {
    if (typeof item === "string") return rewriteString(item);
    if (Array.isArray(item)) return item.map(rewrite);
    if (!item || typeof item !== "object") return item;
    return Object.fromEntries(Object.entries(item).map(([key, nested]) => [
      rewriteString(key),
      rewrite(nested),
    ]));
  };
  return rewrite(value);
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
  const configPath = await resolveConfigPath();
  const configDirectory = path.dirname(configPath);
  let raw;
  try {
    raw = JSON.parse(await readFile(configPath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(`Configuration not found: ${configPath}. Copy config.example.json to config.json.`);
    }
    throw new Error(`Cannot read ${configPath}: ${error.message}`);
  }

  const legacyProfile = String(process.env.AGENT_HUB_PROFILE ?? raw.profile ?? "")
    .trim()
    .toLowerCase();
  if (legacyProfile && !["full", "telegram", "journal"].includes(legacyProfile)) {
    throw new Error('legacy profile must be one of: "full", "telegram", "journal"');
  }
  let components;
  if (raw.components == null) {
    const migratedProfile = legacyProfile || "full";
    components = {
      telegram: migratedProfile !== "journal",
      miniApp: migratedProfile === "full",
      androidApp: migratedProfile === "full",
      codexContextCleanup: raw.codexRolloutContext?.enabled === true,
    };
  } else {
    if (!raw.components || typeof raw.components !== "object" || Array.isArray(raw.components)) {
      throw new Error("components must be an object");
    }
    for (const name of Object.keys(raw.components)) {
      if (!["telegram", "miniApp", "androidApp", "codexContextCleanup"].includes(name)) {
        throw new Error(`unknown component: ${name}`);
      }
    }
    components = {
      telegram: raw.components.telegram === true,
      miniApp: raw.components.miniApp === true,
      androidApp: raw.components.androidApp === true,
      codexContextCleanup: raw.components.codexContextCleanup == null
        ? raw.codexRolloutContext?.enabled === true
        : raw.components.codexContextCleanup === true,
    };
  }
  if (components.miniApp && !components.telegram) {
    throw new Error("miniApp component requires telegram component");
  }
  const telegramEnabled = components.telegram;
  const configuredToken = String(
    process.env.TELEGRAM_BOT_TOKEN ?? raw.telegramBotToken ?? "",
  ).trim();
  if (telegramEnabled && !/^\d+:[A-Za-z0-9_-]+$/.test(configuredToken)) {
    throw new Error("telegramBotToken is missing or invalid");
  }
  // TelegramClient remains constructed because shared controllers depend on
  // its interface. Network-facing Telegram paths stay disabled with the component.
  const token = telegramEnabled ? configuredToken : "0:journal-only";

  const projectRoot = path.resolve(
    process.env.CODEX_PROJECT_ROOT ?? raw.projectRoot ?? path.join(AGENT_HUB_ROOT, "..", ".."),
  );
  const projects = process.env.CODEX_PROJECT_ROOT
    ? [{ name: path.basename(projectRoot) || projectRoot, path: projectRoot }]
    : loadProjects(raw, projectRoot);
  const allowedUserIds = telegramEnabled
    ? requireIntegerArray(raw.allowedUserIds, "allowedUserIds")
    : new Set();
  const allowedChatIds = telegramEnabled
    ? raw.allowedChatIds == null
      ? null
      : requireIntegerArray(raw.allowedChatIds, "allowedChatIds")
    : new Set();
  const dataDir = path.resolve(configDirectory, raw.dataDir ?? "data");
  const defaultTtsVenv = path.join(defaultRuntimeRoot(), "tts-venv");
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
  const codexReasoningEffort = String(
    process.env.CODEX_REASONING_EFFORT ?? raw.codexReasoningEffort ?? "high",
  ).trim().toLowerCase();
  if (!CODEX_REASONING_EFFORTS.includes(codexReasoningEffort)) {
    throw new Error(
      `codexReasoningEffort must be one of: ${CODEX_REASONING_EFFORTS.join(", ")}`,
    );
  }
  const codexCollaborationMode = String(
    process.env.CODEX_COLLABORATION_MODE ?? raw.codexCollaborationMode ?? "default",
  ).trim().toLowerCase();
  if (!CODEX_COLLABORATION_MODES.includes(codexCollaborationMode)) {
    throw new Error(
      `codexCollaborationMode must be one of: ${CODEX_COLLABORATION_MODES.join(", ")}`,
    );
  }
  const codexSandboxMode = normalizeCodexSandboxMode(
    process.env.CODEX_SANDBOX_MODE ?? raw.codexSandboxMode ?? "workspace-write",
  );

  const miniApp = miniAppSettings(raw.miniApp, { configDirectory });
  miniApp.enabled = components.miniApp || components.androidApp;
  if (!miniApp.enabled) {
    miniApp.enabled = false;
    miniApp.quickTunnel.enabled = false;
    miniApp.worker.enabled = false;
  }

  return {
    configPath,
    components,
    telegramEnabled,
    token,
    projectRoot,
    projects,
    showProjectButton: raw.showProjectButton !== false,
    showTaskProject: raw.showTaskProject !== false,
    guardConcurrentRepositoryWrites: repositoryWriteGuardEnabled(raw),
    miniApp,
    provider,
    telegramApiBaseUrl: httpBaseUrl(
      process.env.TELEGRAM_API_BASE_URL ?? raw.telegramApiBaseUrl ?? "https://api.telegram.org",
      "telegramApiBaseUrl",
    ),
    codexExecutable: String(process.env.CODEX_EXECUTABLE ?? raw.codexExecutable ?? "").trim(),
    codexExecutableArgs: stringArray(raw.codexExecutableArgs, "codexExecutableArgs"),
    codexRpcTimeoutSeconds: positiveInteger(
      process.env.CODEX_RPC_TIMEOUT_SECONDS ?? raw.codexRpcTimeoutSeconds,
      30,
      "codexRpcTimeoutSeconds",
    ),
    codexModel: String(process.env.CODEX_MODEL ?? raw.codexModel ?? "").trim(),
    codexReasoningEffort,
    codexCollaborationMode,
    codexSandboxMode,
    codexModels: loadCodexModels(raw),
    codexRolloutContext: codexRolloutContextSettings(raw.codexRolloutContext, {
      enabled: components.codexContextCleanup,
    }),
    claudeExecutable: String(process.env.CLAUDE_EXECUTABLE ?? raw.claudeExecutable ?? "claude").trim(),
    claudeExecutableArgs: stringArray(raw.claudeExecutableArgs, "claudeExecutableArgs"),
    claudeModel: String(process.env.CLAUDE_MODEL ?? raw.claudeModel ?? "").trim(),
    claudePermissionMode,
    claudeReasoningEffort: String(
      process.env.CLAUDE_REASONING_EFFORT ?? raw.claudeReasoningEffort ?? "high",
    ).trim().toLowerCase(),
    claudeCollaborationMode: String(
      process.env.CLAUDE_COLLABORATION_MODE ?? raw.claudeCollaborationMode ?? "default",
    ).trim().toLowerCase(),
    autoApproveOnStart: raw.autoApproveOnStart === true,
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
    ttsRequestTimeoutSeconds: positiveInteger(raw.ttsRequestTimeoutSeconds, 60, "ttsRequestTimeoutSeconds"),
    ttsButtonMinChars: positiveInteger(raw.ttsButtonMinChars, 1, "ttsButtonMinChars"),
    ttsMaxChars: positiveInteger(raw.ttsMaxChars, 20000, "ttsMaxChars"),
    logMaxBytes: positiveInteger(raw.logMaxBytes, 5 * 1024 * 1024, "logMaxBytes"),
    logMaxFiles: positiveInteger(raw.logMaxFiles, 5, "logMaxFiles"),
    deliveryRetryIntervalSeconds: positiveInteger(
      raw.deliveryRetryIntervalSeconds,
      15,
      "deliveryRetryIntervalSeconds",
    ),
    deferredInputTtlHours: positiveInteger(raw.deferredInputTtlHours, 168, "deferredInputTtlHours"),
    progressStartDelayMs: positiveInteger(raw.progressStartDelayMs, 500, "progressStartDelayMs"),
    pythonExe: path.resolve(
      process.env.WHISPER_PYTHON ?? raw.pythonExe ?? path.join(
        defaultRuntimeRoot(),
        "voice-venv",
        process.platform === "win32" ? path.join("Scripts", "python.exe") : path.join("bin", "python"),
      ),
    ),
    ttsPythonExe: path.resolve(
      process.env.TTS_PYTHON ?? raw.ttsPythonExe ?? path.join(
        defaultTtsVenv,
        process.platform === "win32" ? path.join("Scripts", "python.exe") : path.join("bin", "python"),
      ),
    ),
    ttsWorkerScript: path.resolve(
      process.env.TTS_WORKER_SCRIPT
        ?? (raw.ttsWorkerScript ? path.resolve(configDirectory, raw.ttsWorkerScript) : null)
        ?? path.join(AGENT_HUB_ROOT, "tts_worker.py"),
    ),
    whisperModelDir: path.resolve(
      process.env.WHISPER_MODEL_DIR
        ?? (raw.whisperModelDir ? path.resolve(configDirectory, raw.whisperModelDir) : null)
        ?? path.join(dataDir, "models", "whisper"),
    ),
    ttsCacheDir: path.resolve(
      process.env.TTS_CACHE_DIR
        ?? (raw.ttsCacheDir ? path.resolve(configDirectory, raw.ttsCacheDir) : null)
        ?? path.join(dataDir, "models", "silero"),
    ),
    dataDir,
    stateFile: path.join(dataDir, "state.json"),
    deliveryOutboxDir: path.join(dataDir, "delivery-outbox"),
    audioDir: path.join(dataDir, "audio"),
    ttsDir: path.join(dataDir, "tts"),
  };
}
