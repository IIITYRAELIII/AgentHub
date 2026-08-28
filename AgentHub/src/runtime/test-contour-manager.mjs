import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import {
  access,
  copyFile,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import process from "node:process";
import { DatabaseSync } from "node:sqlite";

import { deployRuntime } from "./runtime-manager.mjs";
import { normalizeUsageSyncIdentity } from "../domain/usage-sync-identity.mjs";
import { resolveCodexExecutable } from "../infrastructure/process/codex-executable.mjs";
import {
  canonicalPath,
  pathInsideOrSame,
} from "../infrastructure/filesystem/config.mjs";
import {
  defaultRuntimeRoot,
  defaultTestContourRoot,
  runtimeLayout,
  runtimeReleaseDirectory,
} from "../infrastructure/filesystem/runtime-layout.mjs";
import { LoopbackTelegramApi } from "../infrastructure/network/loopback-telegram-api.mjs";
import { localWebAccessUrl } from "../infrastructure/network/loopback-web-access.mjs";
import { JournalDatabase } from "../infrastructure/persistence/journal-database.mjs";
import { writeTextAtomic } from "../infrastructure/persistence/state-store.mjs";
import {
  cloneAttachmentDirectoryToTestContour,
  cloneJournalToTestContour,
} from "../infrastructure/persistence/test-contour-data-clone.mjs";
import { UsageSyncIdentityStore } from "../infrastructure/persistence/usage-sync-identity-store.mjs";
import { WorkLogUsageSyncStore } from "../infrastructure/persistence/work-log-usage-sync-store.mjs";
import { processIsAlive } from "../infrastructure/process/process-liveness.mjs";
import { withInterprocessLocks } from "../infrastructure/process/interprocess-lock.mjs";
import { stopProcessTree } from "../infrastructure/process/process-tree.mjs";

export const TEST_CONTOUR_MODEL = "gpt-5.3-codex-spark";
export const TEST_CONTOUR_TERRA_MODEL = "gpt-5.6-terra";
export const TEST_CONTOUR_FAKE_MODEL = "fake-codex";
export const TEST_CONTOUR_MODELS = Object.freeze([
  Object.freeze({ value: TEST_CONTOUR_MODEL, label: "GPT-5.3-Codex-Spark" }),
  Object.freeze({ value: TEST_CONTOUR_TERRA_MODEL, label: "GPT-5.6-Terra" }),
  Object.freeze({ value: TEST_CONTOUR_FAKE_MODEL, label: "Fake Codex · Принято" }),
]);
export const TEST_CONTOUR_COMPONENT = "testContour";
export const TEST_CONTOUR_PORT = 8877;
export const TEST_CONTOUR_WEB_HOST = "localhost";
export const PLAYWRIGHT_CORE_VERSION = "1.62.1";
const MARKER_FILE = ".agent-hub-test-contour.json";
const STATE_FILE = "test-contour-state.json";
const CONFIG_FILE = "config.json";
const USER_ID = 42;
const CHAT_ID = 84;

export { defaultTestContourRoot };

export function testContourPaths(root = defaultTestContourRoot()) {
  const resolved = path.resolve(root);
  return {
    root: resolved,
    markerFile: path.join(resolved, MARKER_FILE),
    stateFile: path.join(resolved, STATE_FILE),
    configFile: path.join(resolved, CONFIG_FILE),
    projectRoot: path.join(resolved, "project"),
    codexHome: path.join(resolved, "codex-home"),
    fakeCodexExecutable: path.join(resolved, "providers", "fake-codex-app-server.mjs"),
    codexMultiplexerExecutable: path.join(resolved, "providers", "test-contour-codex-multiplexer.mjs"),
    fakeCodexStateFile: path.join(resolved, "data", "fake-codex-state.json"),
    codexMultiplexerStateFile: path.join(resolved, "data", "codex-multiplexer-state.json"),
    dataDir: path.join(resolved, "data"),
    dataBackupsDirectory: path.join(resolved, "backups", "data-clones"),
    automationRoot: path.join(resolved, "automation"),
    artifactsDirectory: path.join(resolved, "artifacts"),
    stdoutFile: path.join(resolved, "test-contour.log"),
    stderrFile: path.join(resolved, "test-contour-error.log"),
  };
}

export function testContourOperationLockTarget(root = defaultTestContourRoot()) {
  return `${path.resolve(root)}-operation`;
}

export function withTestContourOperationLock(root, operation, {
  lock = withInterprocessLocks,
} = {}) {
  if (typeof operation !== "function") throw new TypeError("operation is required");
  return lock([testContourOperationLockTarget(root)], operation, {
    timeoutMs: 10 * 60_000,
    retryDelayMs: 100,
  });
}

export function assertIsolatedTestContourRoot(root, {
  productionRoot = defaultRuntimeRoot(),
  sourceRoot = path.resolve(import.meta.dirname, "..", ".."),
} = {}) {
  const candidate = canonicalPath(root);
  const protectedRoots = [productionRoot, sourceRoot].map(canonicalPath);
  for (const protectedRoot of protectedRoots) {
    if (pathInsideOrSame(candidate, protectedRoot) || pathInsideOrSame(protectedRoot, candidate)) {
      throw new Error(`Test Contour root overlaps protected path: ${candidate}`);
    }
  }
  return candidate;
}

async function readJson(file, fallback = null) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
}

async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function ensureMarker(root) {
  const paths = testContourPaths(root);
  const existing = await readJson(paths.markerFile);
  if (existing?.kind === "agent-hub-test-contour" && existing.id) return existing;
  if (existing) throw new Error(`Foreign Test Contour marker: ${paths.markerFile}`);
  const marker = {
    kind: "agent-hub-test-contour",
    id: randomUUID(),
    createdAt: new Date().toISOString(),
  };
  await writeJson(paths.markerFile, marker);
  return marker;
}

async function requireMarker(root) {
  const paths = testContourPaths(root);
  const marker = await readJson(paths.markerFile);
  if (marker?.kind !== "agent-hub-test-contour" || !marker.id) {
    throw new Error(`Refusing Test Contour operation without owned marker: ${paths.markerFile}`);
  }
  return marker;
}

export async function testContourComponentEnabled({
  productionConfigFile = runtimeLayout(defaultRuntimeRoot()).configFile,
} = {}) {
  const config = await readJson(productionConfigFile, {});
  return config?.components?.[TEST_CONTOUR_COMPONENT] === true;
}

function npmInvocation(args) {
  if (process.platform === "win32") {
    return {
      command: process.env.ComSpec || "cmd.exe",
      args: ["/d", "/s", "/c", "npm", ...args],
    };
  }
  return { command: "npm", args };
}

function runProcess(command, args, { cwd, env = {}, stdio = "inherit" } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio,
      windowsHide: true,
      shell: false,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`Process failed with ${signal ?? `code ${code}`}: ${command} ${args.join(" ")}`));
    });
  });
}

export async function installTestContour({
  root = defaultTestContourRoot(),
  run = runProcess,
} = {}) {
  const isolatedRoot = assertIsolatedTestContourRoot(root);
  const paths = testContourPaths(isolatedRoot);
  await Promise.all([
    mkdir(paths.projectRoot, { recursive: true }),
    mkdir(paths.automationRoot, { recursive: true }),
    mkdir(paths.artifactsDirectory, { recursive: true }),
  ]);
  const marker = await ensureMarker(isolatedRoot);
  await writeFile(
    path.join(paths.projectRoot, "README.md"),
    "# Agent Hub Test\n\nИзолированная рабочая область для проверок Agent Hub.\n",
    "utf8",
  );
  await writeJson(path.join(paths.automationRoot, "package.json"), {
    name: "agent-hub-test-contour-automation",
    private: true,
    version: "0.0.0",
    dependencies: { "playwright-core": PLAYWRIGHT_CORE_VERSION },
  });
  const npm = npmInvocation([
    "install",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--save-exact",
  ]);
  await run(npm.command, npm.args, { cwd: paths.automationRoot });
  return { root: isolatedRoot, marker, paths };
}

async function uninstallTestContourUnlocked({ root }) {
  const isolatedRoot = assertIsolatedTestContourRoot(root);
  await requireMarker(isolatedRoot);
  await stopTestContourUnlocked({ root: isolatedRoot });
  await rm(isolatedRoot, { recursive: true, force: true });
  return { root: isolatedRoot, removed: true };
}

export async function uninstallTestContour({ root = defaultTestContourRoot() } = {}) {
  const isolatedRoot = assertIsolatedTestContourRoot(root);
  return withTestContourOperationLock(
    isolatedRoot,
    () => uninstallTestContourUnlocked({ root: isolatedRoot }),
  );
}

export function testContourConfig({
  paths,
  telegramApiBaseUrl,
  port = TEST_CONTOUR_PORT,
  model = TEST_CONTOUR_MODEL,
  realCodexExecutable = "codex",
} = {}) {
  if (!TEST_CONTOUR_MODELS.some((item) => item.value === model)) {
    throw new Error(`Model ${model} is not available in Test Contour`);
  }
  const parsedTelegramUrl = new URL(String(telegramApiBaseUrl));
  if (parsedTelegramUrl.protocol !== "http:" || parsedTelegramUrl.hostname !== "127.0.0.1") {
    throw new Error("Test Contour Telegram API must use 127.0.0.1 over HTTP");
  }
  return {
    components: {
      telegram: true,
      miniApp: true,
      androidApp: false,
      sharedDashboardBot: false,
      codexContextCleanup: false,
      testContour: true,
    },
    telegramBotToken: "123:test-contour-token",
    telegramApiBaseUrl: parsedTelegramUrl.toString().replace(/\/$/u, ""),
    allowedUserIds: [USER_ID],
    allowedChatIds: [CHAT_ID],
    privateChatsOnly: true,
    provider: "codex",
    projectRoot: paths.projectRoot,
    projects: [{ name: "Test Contour", path: paths.projectRoot }],
    dataDir: paths.dataDir,
    showProjectButton: false,
    showTaskProject: false,
    guardConcurrentRepositoryWrites: false,
    miniApp: {
      host: "127.0.0.1",
      port,
      quickTunnel: { enabled: false },
      worker: { enabled: false },
    },
    codexModel: model,
    codexReasoningEffort: "medium",
    codexSandboxMode: "workspace-write",
    codexCollaborationMode: "default",
    codexModels: TEST_CONTOUR_MODELS.map((item) => ({ ...item })),
    codexExecutable: process.execPath,
    codexExecutableArgs: [
      paths.codexMultiplexerExecutable,
      "--real-executable",
      realCodexExecutable,
      "--fake-executable",
      paths.fakeCodexExecutable,
      "--fake-state",
      paths.fakeCodexStateFile,
      "--routing-state",
      paths.codexMultiplexerStateFile,
    ],
    codexRateLimitPolling: false,
    claudeRateLimitPolling: false,
    createInitialThreadOnStartup: false,
    taskBoard: {
      triageEnabled: false,
      triageModel: model,
      autoPlaceConfidence: 0.82,
      bugReportWorkspaceName: "",
    },
    diagnostics: {
      sentry: {
        enabled: false,
        dsn: "",
        environment: "test-contour",
      },
    },
    voiceEnabled: false,
    ttsEnabled: false,
    autoApproveOnStart: true,
    logMaxBytes: 2_000_000,
    logMaxFiles: 3,
  };
}

export function testContourEnvironment({
  paths,
  telegramApiBaseUrl,
  model = TEST_CONTOUR_MODEL,
  releaseId,
  environment = process.env,
} = {}) {
  const normalizedReleaseId = String(releaseId ?? "").trim();
  if (!/^[A-Za-z0-9._-]+$/u.test(normalizedReleaseId)) {
    throw new Error("Test Contour releaseId is required");
  }
  const result = { ...environment };
  for (const key of [
    "TELEGRAM_BOT_TOKEN",
    "TELEGRAM_API_BASE_URL",
    "SENTRY_DSN",
    "SENTRY_RELEASE",
    "AGENT_HUB_PUBLIC_URL",
    "AGENT_HUB_PROFILE",
    "CODEX_EXECUTABLE",
    "CODEX_EXECUTABLE_ARGS",
  ]) delete result[key];
  return {
    ...result,
    AGENT_HUB_CONFIG: paths.configFile,
    AGENT_HUB_RUNTIME_ROOT: paths.root,
    AGENT_HUB_RELEASE_ID: normalizedReleaseId,
    AGENT_HUB_LAUNCHER: "",
    AGENT_HUB_DISABLE_SECRET_ACL: "1",
    AGENT_HUB_TEST_CONTOUR: "1",
    TELEGRAM_API_BASE_URL: telegramApiBaseUrl,
    AI_PROVIDER: "codex",
    CODEX_MODEL: model,
    CODEX_HOME: paths.codexHome,
    CODEX_PROJECT_ROOT: paths.projectRoot,
    CODEX_SANDBOX_MODE: "workspace-write",
    SENTRY_DSN: "",
    SENTRY_ENVIRONMENT: "test-contour",
  };
}

export async function prepareTestContourCodexProviders({
  root = defaultTestContourRoot(),
  sourceRoot = path.resolve(import.meta.dirname, "..", ".."),
} = {}) {
  const isolatedRoot = assertIsolatedTestContourRoot(root, { sourceRoot });
  await requireMarker(isolatedRoot);
  const paths = testContourPaths(isolatedRoot);
  const sources = [
    [path.join(sourceRoot, "e2e", "fake-codex-app-server.mjs"), paths.fakeCodexExecutable],
    [path.join(sourceRoot, "e2e", "test-contour-codex-multiplexer.mjs"), paths.codexMultiplexerExecutable],
  ];
  await mkdir(path.dirname(paths.fakeCodexExecutable), { recursive: true });
  await Promise.all(sources.map(async ([sourceFile, targetFile]) => {
    await writeTextAtomic(targetFile, await readFile(sourceFile, "utf8"));
  }));
  return {
    fakeCodexExecutable: paths.fakeCodexExecutable,
    codexMultiplexerExecutable: paths.codexMultiplexerExecutable,
  };
}

async function prepareTestContourCodexHome(paths, {
  environment = process.env,
  home = homedir(),
} = {}) {
  const sourceHome = path.resolve(environment.CODEX_HOME || path.join(home, ".codex"));
  const sourceAuth = path.join(sourceHome, "auth.json");
  const targetAuth = path.join(paths.codexHome, "auth.json");
  await mkdir(paths.codexHome, { recursive: true });
  if (canonicalPath(sourceAuth) === canonicalPath(targetAuth)) return targetAuth;
  try {
    await copyFile(sourceAuth, targetAuth);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(`Codex auth.json is required for Test Contour: ${sourceAuth}`);
    }
    throw error;
  }
  return targetAuth;
}

async function markTestContourWebApp(releaseRoot) {
  const indexFile = path.join(releaseRoot, "assets", "web-app", "index.html");
  const source = await readFile(indexFile, "utf8");
  const watermarkMarkup = '<div class="test-contour-watermark" aria-hidden="true">ТЕСТ</div>';
  const withMarker = source.includes("data-test-contour")
    ? source
    : source.replace(/<html\b/u, '<html data-test-contour=""');
  const marked = withMarker.includes(watermarkMarkup)
    ? withMarker
    : withMarker.replace(
      /<\/body>/u,
      `${watermarkMarkup}\n</body>`,
    );
  if (!marked.includes("data-test-contour") || !marked.includes(watermarkMarkup)) {
    throw new Error(`Test Contour web app has no expected document roots: ${indexFile}`);
  }
  await writeFile(indexFile, marked, "utf8");
  return indexFile;
}

export async function prepareTestContourCandidate({
  root = defaultTestContourRoot(),
  sourceRoot = path.resolve(import.meta.dirname, "..", ".."),
  deploy = deployRuntime,
} = {}) {
  const isolatedRoot = assertIsolatedTestContourRoot(root, { sourceRoot });
  await ensureMarker(isolatedRoot);
  const deployed = await deploy({
    sourceRoot,
    runtimeRoot: isolatedRoot,
    beforePointerCommit: ({ releaseRoot }) => markTestContourWebApp(releaseRoot),
  });
  return { root: isolatedRoot, releaseId: deployed.releaseId, releaseRoot: deployed.releaseRoot };
}

async function currentRelease(root) {
  const layout = runtimeLayout(root);
  const pointer = await readJson(layout.currentFile);
  const releaseId = String(pointer?.current ?? "").trim();
  if (!releaseId) throw new Error("Test Contour candidate is not built");
  const releaseRoot = runtimeReleaseDirectory(root, releaseId);
  await access(path.join(releaseRoot, "agent-hub-main.mjs"));
  return { releaseId, releaseRoot };
}

export async function republishTestContourPointer({
  root = defaultTestContourRoot(),
  releaseId,
  now = new Date(),
} = {}) {
  const isolatedRoot = assertIsolatedTestContourRoot(root);
  const layout = runtimeLayout(isolatedRoot);
  const pointer = await readJson(layout.currentFile);
  const expectedRelease = String(releaseId ?? "").trim();
  if (!expectedRelease || String(pointer?.current ?? "").trim() !== expectedRelease) {
    throw new Error("Test Contour runtime does not match current.json");
  }
  const published = { ...pointer, updatedAt: now.toISOString() };
  await writeTextAtomic(layout.currentFile, `${JSON.stringify(published, null, 2)}\n`);
  return published;
}

async function waitFor(operation, description, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await operation();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timeout waiting for ${description}: ${lastError?.message ?? "not ready"}`);
}

async function readyHealth(port) {
  const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2_000) });
  if (!response.ok) return null;
  const body = await response.json();
  return body?.ok === true && body?.live === true && body?.ready === true ? body : null;
}

export async function serveTestContour({
  root = defaultTestContourRoot(),
  port = TEST_CONTOUR_PORT,
  model = TEST_CONTOUR_MODEL,
  spawnImpl = spawn,
} = {}) {
  const isolatedRoot = assertIsolatedTestContourRoot(root);
  const marker = await requireMarker(isolatedRoot);
  const paths = testContourPaths(isolatedRoot);
  const { releaseId, releaseRoot } = await currentRelease(isolatedRoot);
  await Promise.all([
    access(paths.fakeCodexExecutable),
    access(paths.codexMultiplexerExecutable),
  ]);
  const realCodexExecutable = await resolveCodexExecutable();
  const telegram = new LoopbackTelegramApi({ userId: USER_ID, chatId: CHAT_ID });
  await telegram.start();
  await writeJson(paths.configFile, testContourConfig({
    paths,
    telegramApiBaseUrl: telegram.baseUrl,
    port,
    model,
    realCodexExecutable,
  }));
  await rm(paths.stateFile, { force: true });
  const runtime = spawnImpl(process.execPath, [path.join(releaseRoot, "agent-hub-main.mjs")], {
    cwd: releaseRoot,
    env: testContourEnvironment({
      paths,
      telegramApiBaseUrl: telegram.baseUrl,
      model,
      releaseId,
    }),
    stdio: "inherit",
    windowsHide: true,
  });
  let runtimeExit = null;
  runtime.once("exit", (code, signal) => { runtimeExit = { code, signal }; });
  try {
    const health = await waitFor(async () => {
      if (runtimeExit) throw new Error(`candidate exited with ${runtimeExit.signal ?? runtimeExit.code}`);
      return readyHealth(port);
    }, "Test Contour runtime readiness");
    const secret = String(await readFile(path.join(isolatedRoot, "local-web.secret"), "utf8")).trim();
    const url = localWebAccessUrl(`http://${TEST_CONTOUR_WEB_HOST}:${port}/`, secret);
    const state = {
      contourId: marker.id,
      managerPid: process.pid,
      runtimePid: runtime.pid,
      releaseId,
      model,
      models: TEST_CONTOUR_MODELS,
      port,
      url,
      health,
      startedAt: new Date().toISOString(),
    };
    await writeJson(paths.stateFile, state);
    const shutdown = async () => {
      await stopProcessTree(runtime.pid).catch(() => false);
      await telegram.stop().catch(() => null);
      await rm(paths.stateFile, { force: true }).catch(() => null);
    };
    await new Promise((resolve) => {
      process.once("SIGINT", resolve);
      process.once("SIGTERM", resolve);
      runtime.once("exit", resolve);
    });
    await shutdown();
    return state;
  } catch (error) {
    await stopProcessTree(runtime.pid).catch(() => false);
    await telegram.stop().catch(() => null);
    await rm(paths.stateFile, { force: true }).catch(() => null);
    throw error;
  }
}

export async function readTestContourStatus({ root = defaultTestContourRoot() } = {}) {
  const paths = testContourPaths(root);
  const state = await readJson(paths.stateFile);
  if (!state || !processIsAlive(state.managerPid) || !processIsAlive(state.runtimePid)) {
    return { running: false, root: paths.root, state: state ?? null };
  }
  const health = await readyHealth(state.port).catch(() => null);
  return { running: Boolean(health), root: paths.root, state, health };
}

async function stopTestContourUnlocked({ root }) {
  const paths = testContourPaths(root);
  const state = await readJson(paths.stateFile);
  if (!state) {
    const lock = await readJson(path.join(paths.dataDir, "bot.lock"));
    const runtimePid = Number(lock?.pid);
    if (!Number.isInteger(runtimePid) || runtimePid <= 0 || !processIsAlive(runtimePid)) {
      return { stopped: false, reason: "not-running" };
    }
    await requireMarker(root);
    await stopProcessTree(runtimePid).catch(() => false);
    await waitFor(() => !processIsAlive(runtimePid), "orphaned Test Contour shutdown", 15_000);
    return { stopped: true, state: null, recoveredFromLock: true, runtimePid };
  }
  await stopProcessTree(state.managerPid).catch(() => false);
  if (processIsAlive(state.runtimePid)) await stopProcessTree(state.runtimePid).catch(() => false);
  await waitFor(
    () => !processIsAlive(state.managerPid) && !processIsAlive(state.runtimePid),
    "Test Contour shutdown",
    15_000,
  );
  await rm(paths.stateFile, { force: true });
  return { stopped: true, state };
}

export async function stopTestContour({ root = defaultTestContourRoot() } = {}) {
  const isolatedRoot = assertIsolatedTestContourRoot(root);
  return withTestContourOperationLock(
    isolatedRoot,
    () => stopTestContourUnlocked({ root: isolatedRoot }),
  );
}

async function remapClonedUsageSyncEvents({ productionDataDir, contourDataDir, databaseFile }) {
  const productionIdentity = normalizeUsageSyncIdentity(
    await readJson(path.join(productionDataDir, "usage-sync-identity.json")),
  );
  if (!productionIdentity) return { migrated: 0, reason: "production-identity-unavailable" };
  const contourIdentity = new UsageSyncIdentityStore({
    file: path.join(contourDataDir, "usage-sync-identity.json"),
    dataDir: contourDataDir,
  });
  await contourIdentity.load();
  const syncStore = new WorkLogUsageSyncStore({
    databaseFile,
    deviceId: contourIdentity.deviceId,
  });
  try {
    return await syncStore.adoptDeviceIds([
      productionIdentity.deviceId,
      ...productionIdentity.legacyDeviceIds,
    ]);
  } finally {
    await syncStore.close();
  }
}

async function cloneProductionReadStateToTestContour({ production, contourDataDir }) {
  const productionConfig = await readJson(production.configFile, {});
  const productionAccountId = String(productionConfig?.allowedUserIds?.[0] ?? "").trim();
  if (!productionAccountId) return { cloned: 0, reason: "production-account-unavailable" };
  const sourceFile = path.join(production.dataDir, "runtime.sqlite");
  try {
    await access(sourceFile);
  } catch {
    return { cloned: 0, reason: "production-runtime-unavailable" };
  }
  const source = new DatabaseSync(sourceFile, { readOnly: true });
  let rows;
  try {
    const table = source.prepare(`
      SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'task_read_state'
    `).get();
    if (!table) return { cloned: 0, reason: "production-read-state-unavailable" };
    rows = source.prepare(`
      SELECT provider, thread_id, answer_at_ms, answer_turn_id, answer_revision, read_at_ms, updated_at
      FROM task_read_state
      WHERE account_id = ?
    `).all(productionAccountId);
  } finally {
    source.close();
  }
  const destinationFile = path.join(contourDataDir, "runtime.sqlite");
  const destination = new DatabaseSync(destinationFile);
  try {
    destination.exec(`
      CREATE TABLE task_read_state (
        account_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        answer_at_ms INTEGER NOT NULL,
        answer_turn_id TEXT NOT NULL DEFAULT '',
        answer_revision INTEGER NOT NULL DEFAULT 0,
        read_at_ms INTEGER NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (account_id, provider, thread_id)
      ) WITHOUT ROWID
    `);
    const insert = destination.prepare(`
      INSERT INTO task_read_state
        (account_id, provider, thread_id, answer_at_ms, answer_turn_id, answer_revision, read_at_ms, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    destination.exec("BEGIN IMMEDIATE");
    try {
      for (const row of rows) insert.run(
        String(USER_ID),
        row.provider,
        row.thread_id,
        row.answer_at_ms,
        row.answer_turn_id,
        row.answer_revision,
        row.read_at_ms,
        row.updated_at,
      );
      destination.exec("COMMIT");
    } catch (error) {
      destination.exec("ROLLBACK");
      throw error;
    }
  } finally {
    destination.close();
  }
  return { cloned: rows.length };
}

async function cloneProductionDataToTestContourUnlocked({
  root = defaultTestContourRoot(),
  productionRoot = defaultRuntimeRoot(),
  model = TEST_CONTOUR_MODEL,
  now = new Date(),
} = {}) {
  const isolatedRoot = assertIsolatedTestContourRoot(root, { productionRoot });
  await requireMarker(isolatedRoot);
  await stopTestContourUnlocked({ root: isolatedRoot });
  const paths = testContourPaths(isolatedRoot);
  const production = runtimeLayout(productionRoot);
  const result = await cloneJournalToTestContour({
    sourceDatabaseFile: path.join(production.dataDir, "journal.sqlite"),
    destinationDatabaseFile: path.join(paths.dataDir, "journal.sqlite"),
    backupRoot: paths.dataBackupsDirectory,
    projectRoot: paths.projectRoot,
    model,
    now,
  });
  const usageSyncRemap = await remapClonedUsageSyncEvents({
    productionDataDir: production.dataDir,
    contourDataDir: paths.dataDir,
    databaseFile: result.destinationDatabaseFile,
  });
  const attachments = await cloneAttachmentDirectoryToTestContour({
    sourceDirectory: path.join(production.root, "attachments"),
    destinationDirectory: path.join(paths.root, "attachments"),
  });
  await Promise.all([
    ...["", "-wal", "-shm"].map((suffix) => (
      rm(path.join(paths.dataDir, `runtime.sqlite${suffix}`), { force: true })
    )),
    rm(paths.codexHome, { recursive: true, force: true }),
    rm(paths.fakeCodexStateFile, { force: true }),
    rm(paths.codexMultiplexerStateFile, { force: true }),
  ]);
  const readState = await cloneProductionReadStateToTestContour({
    production,
    contourDataDir: paths.dataDir,
  });
  return {
    ...result,
    remappedUsageSyncEvents: usageSyncRemap.migrated,
    attachmentsCloned: attachments.sourcePresent,
    readStateCloned: readState.cloned,
    runtimeStateReset: true,
    codexStateReset: true,
  };
}

export async function cloneProductionDataToTestContour(options = {}) {
  const root = options.root ?? defaultTestContourRoot();
  const isolatedRoot = assertIsolatedTestContourRoot(root, {
    productionRoot: options.productionRoot ?? defaultRuntimeRoot(),
  });
  return withTestContourOperationLock(
    isolatedRoot,
    () => cloneProductionDataToTestContourUnlocked({ ...options, root: isolatedRoot }),
  );
}

async function startTestContourUnlocked({
  root = defaultTestContourRoot(),
  entryFile,
  refresh = false,
  sourceRoot = path.resolve(import.meta.dirname, "..", ".."),
  port = TEST_CONTOUR_PORT,
  model = TEST_CONTOUR_MODEL,
} = {}) {
  const isolatedRoot = assertIsolatedTestContourRoot(root, { sourceRoot });
  const paths = testContourPaths(isolatedRoot);
  await stopTestContourUnlocked({ root: isolatedRoot });
  if (refresh) await prepareTestContourCandidate({ root: isolatedRoot, sourceRoot });
  else await currentRelease(isolatedRoot).catch(() => prepareTestContourCandidate({ root: isolatedRoot, sourceRoot }));
  await prepareTestContourCodexProviders({ root: isolatedRoot, sourceRoot });
  await prepareTestContourCodexHome(paths);
  await rm(paths.stateFile, { force: true });
  const stdout = openSync(paths.stdoutFile, "a");
  const stderr = openSync(paths.stderrFile, "a");
  let manager;
  try {
    manager = spawn(process.execPath, [
      entryFile,
      "serve",
      "--root",
      isolatedRoot,
      "--port",
      String(port),
      "--model",
      model,
    ], {
      cwd: sourceRoot,
      detached: true,
      stdio: ["ignore", stdout, stderr],
      windowsHide: true,
    });
    manager.unref();
  } finally {
    closeSync(stdout);
    closeSync(stderr);
  }
  const state = await waitFor(async () => {
    const state = await readJson(paths.stateFile);
    if (state && processIsAlive(state.managerPid) && processIsAlive(state.runtimePid)) return state;
    if (!processIsAlive(manager.pid)) {
      const errorLog = await readFile(paths.stderrFile, "utf8").catch(() => "");
      throw new Error(`Test Contour manager exited before readiness\n${errorLog.slice(-4_000)}`);
    }
    return null;
  }, "Test Contour background startup");
  await republishTestContourPointer({ root: isolatedRoot, releaseId: state.releaseId });
  return state;
}

export async function startTestContour(options = {}) {
  const root = options.root ?? defaultTestContourRoot();
  const sourceRoot = options.sourceRoot ?? path.resolve(import.meta.dirname, "..", "..");
  const isolatedRoot = assertIsolatedTestContourRoot(root, { sourceRoot });
  return withTestContourOperationLock(
    isolatedRoot,
    () => startTestContourUnlocked({ ...options, root: isolatedRoot, sourceRoot }),
  );
}

export async function openTestContour({ root = defaultTestContourRoot(), spawnImpl = spawn } = {}) {
  const status = await readTestContourStatus({ root });
  if (!status.running) throw new Error("Test Contour is not running");
  const url = status.state.url;
  const child = process.platform === "win32"
    ? spawnImpl("rundll32.exe", ["url.dll,FileProtocolHandler", url], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      })
    : spawnImpl("xdg-open", [url], { detached: true, stdio: "ignore" });
  child.unref();
  return { opened: true, url };
}

async function verifyTestContourUnlocked({
  root = defaultTestContourRoot(),
  entryFile,
  sourceRoot = path.resolve(import.meta.dirname, "..", ".."),
  withAgent = true,
  model = TEST_CONTOUR_MODEL,
} = {}) {
  const paths = testContourPaths(root);
  const state = await startTestContourUnlocked({
    root,
    entryFile,
    refresh: true,
    sourceRoot,
    model,
  });
  const {
    runTestContourUiSmoke,
    TEST_CONTOUR_PROBE,
    TEST_CONTOUR_PROBE_RESPONSE,
  } = await import("../infrastructure/browser/test-contour-ui-smoke.mjs");
  const probeResponse = model === TEST_CONTOUR_FAKE_MODEL
    ? "Принято"
    : TEST_CONTOUR_PROBE_RESPONSE;
  const smoke = await runTestContourUiSmoke({
    url: state.url,
    automationRoot: paths.automationRoot,
    artifactsDirectory: paths.artifactsDirectory,
    withAgent,
    probeResponse,
  });
  let journal = null;
  if (withAgent) {
    journal = await waitFor(async () => {
      const database = new JournalDatabase(path.join(paths.dataDir, "journal.sqlite"));
      try {
        const ledger = await database.loadLedger();
        const record = Object.values(ledger.turns).find((item) => (
          item.provider === "codex"
          && item.model === state.model
          && item.prompt === TEST_CONTOUR_PROBE
          && item.body === probeResponse
          && Date.parse(item.completedAt) >= Date.parse(state.startedAt)
        ));
        return record ? {
          provider: record.provider,
          model: record.model,
          turnId: record.turnId,
          completedAt: record.completedAt,
        } : null;
      } finally {
        database.close();
      }
    }, "Test Contour journal confirmation", 30_000);
  }
  return { state, smoke, journal };
}

export async function verifyTestContour(options = {}) {
  const root = options.root ?? defaultTestContourRoot();
  const sourceRoot = options.sourceRoot ?? path.resolve(import.meta.dirname, "..", "..");
  const isolatedRoot = assertIsolatedTestContourRoot(root, { sourceRoot });
  return withTestContourOperationLock(
    isolatedRoot,
    () => verifyTestContourUnlocked({ ...options, root: isolatedRoot, sourceRoot }),
  );
}
