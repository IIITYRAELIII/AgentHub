import { prepareRecordingContourEnvironment, recordingContourEnvironment } from "../infrastructure/filesystem/test-contour-recording-environment.mjs";
import { randomUUID } from "node:crypto";
import { prepareTestContourRecordingConfiguration, readTestContourRecordingConfiguration } from "../infrastructure/filesystem/test-contour-recording-configuration.mjs";
import { recordingContourProfile } from "../infrastructure/filesystem/test-contour-recording-profile.mjs";
import { activateContourAdoption, readContourAdoption, rollbackContourAdoption, snapshotContourAdoptionControl, stageContourAdoption, writeContourAdoption } from "./test-contour-cohort-adoption.mjs";
import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync } from "node:fs";
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
import { pathToFileURL } from "node:url";
import process from "node:process";
import { DatabaseSync } from "node:sqlite";

import { deployRuntime } from "./runtime-manager.mjs";
import { normalizeUsageSyncIdentity } from "../domain/usage-sync-identity.mjs";
import { resolveCodexExecutable } from "../infrastructure/process/codex-executable.mjs";
import {
  canonicalPath,
  pathInsideOrSame,
  samePath,
} from "../infrastructure/filesystem/config.mjs";
import { prepareTaskContourSource } from "../infrastructure/filesystem/task-git-workspace.mjs";
import { assertReleaseCandidateContourSource } from "../infrastructure/filesystem/release-git-workspace.mjs";
import {
  defaultRuntimeRoot,
  defaultTestContourRoot,
  runtimeLayout,
  runtimeReleaseDirectory,
} from "../infrastructure/filesystem/runtime-layout.mjs";
import { LoopbackTelegramApi } from "../infrastructure/network/loopback-telegram-api.mjs";
import { localWebAccessUrl } from "../infrastructure/network/loopback-web-access.mjs";
import { JournalDatabase } from "../infrastructure/persistence/journal-database.mjs";
import {
  MessageCommandLedgerStore,
  messageCommandLedgerPath,
} from "../infrastructure/persistence/message-command-ledger-store.mjs";
import { writeTextAtomic } from "../infrastructure/persistence/state-store.mjs";
import {
  cloneAttachmentDirectoryToTestContour,
  cloneJournalToTestContour,
} from "../infrastructure/persistence/test-contour-data-clone.mjs";
import { UsageSyncIdentityStore } from "../infrastructure/persistence/usage-sync-identity-store.mjs";
import { WorkLogUsageSyncStore } from "../infrastructure/persistence/work-log-usage-sync-store.mjs";
import { WorkspaceCatalogStore } from "../infrastructure/persistence/workspace-catalog-store.mjs";
import { processIsAlive } from "../infrastructure/process/process-liveness.mjs";
import { withInterprocessLocks } from "../infrastructure/process/interprocess-lock.mjs";
import { stopProcessTree } from "../infrastructure/process/process-tree.mjs";
import {
  assertTestContourOperationOwner,
  beginTestContourOperation,
  failStaleTestContourOperation,
  readTestContourOperationDocument,
  recoverReadyTestContourOperation,
  testContourOperationReadback,
  testContourOperationStateFile,
  transitionTestContourOperation,
  visibleTestContourOperation,
} from "./test-contour-operation-state.mjs";

export const TEST_CONTOUR_SPARK_MODEL = "gpt-5.3-codex-spark";
export const TEST_CONTOUR_TERRA_MODEL = "gpt-5.6-terra";
export const TEST_CONTOUR_FAKE_MODEL = "fake-codex";
export const TEST_CONTOUR_MODEL = TEST_CONTOUR_FAKE_MODEL;
export const TEST_CONTOUR_MODELS = Object.freeze([
  Object.freeze({ value: TEST_CONTOUR_SPARK_MODEL, label: "GPT-5.3-Codex-Spark" }),
  Object.freeze({ value: TEST_CONTOUR_TERRA_MODEL, label: "GPT-5.6-Terra" }),
  Object.freeze({ value: TEST_CONTOUR_FAKE_MODEL, label: "Fake Codex · Принято" }),
]);
export const TEST_CONTOUR_COMPONENT = "testContour";
export const TEST_CONTOUR_DEV_SOURCE = "dev";
export const TEST_CONTOUR_RELEASE_CANDIDATE_SOURCE = "release-candidate";
export const TEST_CONTOUR_PORT = 8877;
export const RECORDING_COHORT_MANAGER_VERSION = 1;
export const TEST_CONTOUR_WEB_HOST = "localhost";
export const PLAYWRIGHT_CORE_VERSION = "1.62.1";
const MARKER_FILE = ".agent-hub-test-contour.json";
const STATE_FILE = "test-contour-state.json";
const CONFIG_FILE = "config.json";
const SOURCE_FILE = "test-contour-source.json";
const USER_ID = 42;
const CHAT_ID = 84;
const TEST_CONTOUR_DRAIN_STATES = new Set(["accepted", "queued", "dispatching", "started", "unknown"]);

export { defaultTestContourRoot };

function requireTestContourModel(model) {
  if (!TEST_CONTOUR_MODELS.some((item) => item.value === model)) {
    throw new Error(`Model ${model} is not available in Test Contour`);
  }
  return model;
}

export function testContourPaths(root = defaultTestContourRoot()) {
  const resolved = canonicalPath(root);
  return {
    root: resolved,
    markerFile: path.join(resolved, MARKER_FILE),
    stateFile: path.join(resolved, STATE_FILE),
    operationFile: testContourOperationStateFile(resolved),
    configFile: path.join(resolved, CONFIG_FILE),
    sourceFile: path.join(resolved, SOURCE_FILE),
    taskGitDataDirectory: path.join(resolved, "task-git"),
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

export async function alignTestContourStreamModel({
  databaseFile,
  model,
  databaseFactory = (file) => new DatabaseSync(file),
  attempts = 12,
  retryDelayMs = 250,
  wait = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
} = {}) {
  requireTestContourModel(model);
  if (!databaseFile || !existsSync(databaseFile)) return { updated: 0, reason: "journal-unavailable" };
  const maxAttempts = Math.max(1, Number(attempts) || 1);
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let database = null;
    try {
      database = databaseFactory(databaseFile);
      const table = database.prepare(`
        SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'hub_streams'
      `).get();
      if (!table) return { updated: 0, reason: "stream-catalog-unavailable" };
      const rows = database.prepare("SELECT id, settings_json FROM hub_streams").all();
      const update = database.prepare("UPDATE hub_streams SET settings_json = ? WHERE id = ?");
      let updated = 0;
      database.exec("BEGIN IMMEDIATE");
      try {
        for (const row of rows) {
          const settings = JSON.parse(row.settings_json);
          if (settings.provider === "codex" && settings.model === model) continue;
          update.run(JSON.stringify({ ...settings, provider: "codex", model }), row.id);
          updated += 1;
        }
        database.exec("COMMIT");
      } catch (error) {
        try { database.exec("ROLLBACK"); } catch {}
        throw error;
      }
      return { updated };
    } catch (error) {
      const code = Number(error?.errcode);
      if (!Number.isInteger(code) || (code & 0xff) !== 10) throw error;
      if (attempt === maxAttempts) {
        throw new Error(
          `Test Contour SQLite handoff failed after ${maxAttempts} attempts: ${error.message}`,
          { cause: error },
        );
      }
    } finally {
      database?.close();
    }
    await wait(retryDelayMs);
  }
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

function fakeThreadSequence(threadId) {
  const match = /^10000000-0000-4000-8000-(\d{12})$/u.exec(String(threadId ?? "").trim());
  return match ? Number(match[1]) : 0;
}

function fakeTurnSequence(turnId) {
  const match = /^20000000-0000-4000-8000-(\d{12})$/u.exec(String(turnId ?? "").trim());
  return match ? Number(match[1]) : 0;
}

function persistedTestContourFakeTurnSequence(databaseFile) {
  if (!existsSync(databaseFile)) return 0;
  const database = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    database.exec("PRAGMA query_only = ON; PRAGMA busy_timeout = 0;");
    const tables = new Set(database.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table'
    `).all().map((row) => String(row.name)));
    const turnIds = [];
    if (tables.has("task_read_model_turns")) {
      turnIds.push(...database.prepare(`
        SELECT id AS turn_id FROM task_read_model_turns WHERE provider = 'codex'
      `).all().map((row) => row.turn_id));
    }
    if (tables.has("task_read_model_tasks")) {
      turnIds.push(...database.prepare(`
        SELECT turn_id FROM task_read_model_tasks
        WHERE provider = 'codex' AND turn_id IS NOT NULL
      `).all().map((row) => row.turn_id));
    }
    if (tables.has("journal_records")) {
      turnIds.push(...database.prepare(`
        SELECT turn_id FROM journal_records WHERE provider = 'codex'
      `).all().map((row) => row.turn_id));
    }
    return Math.max(0, ...turnIds.map(fakeTurnSequence));
  } finally {
    database.close();
  }
}

function fakeCodexThread({ threadId, projectRoot, name, model, updatedAtMs = 0 }) {
  return {
    id: threadId,
    cwd: String(projectRoot ?? "").trim(),
    name: String(name ?? "").trim() || "Восстановленная тестовая задача",
    preview: "",
    updatedAt: Math.max(0, Math.floor(Number(updatedAtMs) / 1_000)) || Math.floor(Date.now() / 1_000),
    turns: [],
    model,
    reasoningEffort: "medium",
    archived: false,
  };
}

async function activeTestContourCodexCommands(dataDir) {
  if (!existsSync(messageCommandLedgerPath(dataDir))) return [];
  const ledger = new MessageCommandLedgerStore({ dataDir, readOnly: true });
  try {
    return ledger.activeRecords().filter((record) => (
      String(record.item?.provider ?? "").trim().toLowerCase() === "codex"
    ));
  } finally {
    ledger.close();
  }
}

async function persistedTestContourCodexThreads({ databaseFile, projectRoot, model }) {
  if (!existsSync(databaseFile)) return [];
  const catalog = new WorkspaceCatalogStore({ databaseFile, readOnly: true });
  try {
    await catalog.load();
    return catalog.hierarchy().flatMap((workspace) => workspace.streams.flatMap((stream) => (
      stream.threads
        .filter((thread) => thread.provider === "codex")
        .map((thread) => fakeCodexThread({
          threadId: thread.threadId,
          projectRoot: thread.projectRoot || stream.settings?.project || projectRoot,
          name: stream.displayName,
          model,
          updatedAtMs: thread.updatedAtMs,
        }))
    )));
  } finally {
    catalog.close();
  }
}

export async function reconcileTestContourFakeCodexState({
  root = defaultTestContourRoot(),
  model = TEST_CONTOUR_FAKE_MODEL,
} = {}) {
  const paths = testContourPaths(root);
  if (model !== TEST_CONTOUR_FAKE_MODEL) {
    return { status: "disabled", model, recoveredThreadCount: 0, activeCommandCount: 0 };
  }
  await mkdir(paths.dataDir, { recursive: true });
  const databaseFile = path.join(paths.dataDir, "journal.sqlite");
  const [catalogThreads, commands, saved, persistedTurnSequence] = await Promise.all([
    persistedTestContourCodexThreads({
      databaseFile,
      projectRoot: paths.projectRoot,
      model,
    }),
    activeTestContourCodexCommands(paths.dataDir),
    readJson(paths.fakeCodexStateFile, {}),
    Promise.resolve().then(() => persistedTestContourFakeTurnSequence(databaseFile)),
  ]);
  const desired = new Map(catalogThreads.map((thread) => [thread.id, thread]));
  const unresolvedCommands = [];
  for (const record of commands) {
    const threadId = String(record.item?.threadId ?? "").trim();
    if (!threadId) {
      if (TEST_CONTOUR_DRAIN_STATES.has(record.state)) {
        unresolvedCommands.push(record.clientUserMessageId);
      }
      continue;
    }
    if (!desired.has(threadId)) {
      desired.set(threadId, fakeCodexThread({
        threadId,
        projectRoot: record.item?.projectRoot || paths.projectRoot,
        name: record.item?.taskTitle,
        model,
        updatedAtMs: record.updatedAtMs,
      }));
    }
  }
  if (unresolvedCommands.length) {
    throw new Error(
      `Fake Codex recovery cannot resolve ${unresolvedCommands.length} durable command Thread identities`,
    );
  }
  const existingThreads = Array.isArray(saved?.threads) ? saved.threads : [];
  const existingIds = new Set(existingThreads.map((thread) => String(thread?.id ?? "").trim()).filter(Boolean));
  const recoveredThreads = [...desired.values()].filter((thread) => !existingIds.has(thread.id));
  const threads = [...existingThreads, ...recoveredThreads];
  const requiredLoadedThreadIds = commands
    .filter((record) => TEST_CONTOUR_DRAIN_STATES.has(record.state))
    .map((record) => String(record.item?.threadId ?? "").trim())
    .filter(Boolean);
  const loadedThreadIds = [...new Set([
    ...(Array.isArray(saved?.loadedThreadIds) ? saved.loadedThreadIds : []),
    ...requiredLoadedThreadIds,
  ].map((threadId) => String(threadId ?? "").trim()).filter(Boolean))].sort();
  const retainedTurnSequence = Math.max(
    0,
    ...threads.flatMap((thread) => (
      Array.isArray(thread?.turns) ? thread.turns : []
    )).map((turn) => fakeTurnSequence(turn?.id)),
  );
  const durableTurnSequence = Math.max(persistedTurnSequence, retainedTurnSequence);
  const nextTurn = Math.max(1, Number(saved?.nextTurn) || 1, durableTurnSequence + 1);
  const diagnostics = {
    version: 1,
    status: "ready",
    catalogThreadCount: catalogThreads.length,
    activeCommandCount: commands.length,
    queuedCommandCount: commands.filter((record) => record.state === "queued").length,
    recoveredThreadCount: recoveredThreads.length,
    retainedThreadCount: existingThreads.length,
    requiredLoadedThreadCount: requiredLoadedThreadIds.length,
    durableTurnSequence,
    nextTurn,
    updatedAt: new Date().toISOString(),
  };
  const nextState = {
    ...(saved && typeof saved === "object" ? saved : {}),
    nextThread: Math.max(
      1,
      Number(saved?.nextThread) || 1,
      ...threads.map((thread) => fakeThreadSequence(thread.id) + 1),
    ),
    nextTurn,
    nextMessage: Math.max(1, Number(saved?.nextMessage) || 1),
    threads,
    loadedThreadIds,
    crashedOnce: saved?.crashedOnce === true,
    requestCounts: saved?.requestCounts && typeof saved.requestCounts === "object"
      ? saved.requestCounts
      : {},
    hubRecovery: diagnostics,
  };
  await writeTextAtomic(paths.fakeCodexStateFile, `${JSON.stringify(nextState, null, 2)}\n`);
  return diagnostics;
}

export async function testContourFakeCodexQueueDiagnostics({
  root = defaultTestContourRoot(),
} = {}) {
  const paths = testContourPaths(root);
  const [commands, fakeState] = await Promise.all([
    activeTestContourCodexCommands(paths.dataDir),
    readJson(paths.fakeCodexStateFile, {}),
  ]);
  const fakeThreadIds = new Set((Array.isArray(fakeState?.threads) ? fakeState.threads : [])
    .map((thread) => String(thread?.id ?? "").trim())
    .filter(Boolean));
  const drainCommands = commands.filter((record) => TEST_CONTOUR_DRAIN_STATES.has(record.state));
  const fakeCommands = drainCommands.filter((record) => (
    fakeThreadIds.has(String(record.item?.threadId ?? "").trim())
  ));
  const stateCounts = Object.fromEntries([...new Set(fakeCommands.map((record) => record.state))]
    .sort()
    .map((state) => [state, fakeCommands.filter((record) => record.state === state).length]));
  const missingThreadIds = [...new Set(drainCommands
    .map((record) => String(record.item?.threadId ?? "").trim())
    .filter((threadId) => threadId && !fakeThreadIds.has(threadId)))].sort();
  const unresolvedCommandIds = drainCommands
    .filter((record) => !String(record.item?.threadId ?? "").trim())
    .map((record) => record.clientUserMessageId)
    .sort();
  return {
    status: missingThreadIds.length || unresolvedCommandIds.length
      ? "blocked"
      : fakeCommands.length ? "draining" : "ready",
    activeCommandCount: fakeCommands.length,
    stateCounts,
    missingThreadIds,
    unresolvedCommandIds,
    oldestAcceptedAtMs: fakeCommands.length
      ? Math.min(...fakeCommands.map((record) => Number(record.acceptedAtMs) || Number.POSITIVE_INFINITY))
      : null,
  };
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
  recordingSourceConfig = null,
} = {}) {
  const isolatedRoot = assertIsolatedTestContourRoot(root);
  const paths = testContourPaths(isolatedRoot);
  await Promise.all([
    mkdir(paths.projectRoot, { recursive: true }),
    mkdir(paths.automationRoot, { recursive: true }),
    mkdir(paths.artifactsDirectory, { recursive: true }),
  ]);
  const marker = await ensureMarker(isolatedRoot);
  if (recordingSourceConfig) await prepareTestContourRecordingConfiguration({ root: isolatedRoot, sourceConfig: recordingSourceConfig });
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
  recording = null,
  sourceRoot = path.resolve(import.meta.dirname, "../.."),
} = {}) {
  requireTestContourModel(model);
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
    projectRoot: recording?.projectRoot ?? paths.projectRoot,
    projects: recording?.projects ?? [{ name: "Test Contour", path: paths.projectRoot }],
    ...(recording ? { testContourRecording: { schemaVersion: 1, root: recording.root } } : {}),
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
    codexExecutableAutoUpdate: false,
    codexExecutableArgs: recording ? [
      path.join(sourceRoot, "src", "providers", "recording-contour-codex-cli.mjs"),
      "--recording-root", recording.root,
    ] : [
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
  contourId,
  operationId = null,
  port,
  runtimeNonce,
  environment = process.env,
  recording = null,
} = {}) {
  const normalizedReleaseId = String(releaseId ?? "").trim();
  const normalizedContourId = String(contourId ?? "").trim();
  const normalizedOperationId = String(operationId ?? "").trim();
  const normalizedRuntimeNonce = String(runtimeNonce ?? "").trim();
  const normalizedPort = Number(port);
  if (!/^[A-Za-z0-9._-]+$/u.test(normalizedReleaseId)) {
    throw new Error("Test Contour releaseId is required");
  }
  if (!normalizedContourId || !normalizedRuntimeNonce
      || !Number.isInteger(normalizedPort) || normalizedPort <= 0) {
    throw new Error("Test Contour runtime identity requires contourId, port and nonce");
  }
  const result = recording ? recordingContourEnvironment(recording.root, environment) : { ...environment };
  for (const key of [
    "TELEGRAM_BOT_TOKEN",
    "TELEGRAM_API_BASE_URL",
    "SENTRY_DSN",
    "SENTRY_RELEASE",
    "AGENT_HUB_PUBLIC_URL",
    "AGENT_HUB_PROFILE",
    "CODEX_EXECUTABLE",
    "CODEX_EXECUTABLE_ARGS",
    "AGENT_HUB_RECORDING_PROVIDER_ROOT",
  ]) delete result[key];
  if (recording) delete result.CODEX_PROJECT_ROOT;
  return {
    ...result,
    AGENT_HUB_CONFIG: paths.configFile,
    AGENT_HUB_RUNTIME_ROOT: paths.root,
    AGENT_HUB_RELEASE_ID: normalizedReleaseId,
    AGENT_HUB_TEST_CONTOUR_ID: normalizedContourId,
    AGENT_HUB_TEST_CONTOUR_OPERATION_ID: normalizedOperationId,
    AGENT_HUB_TEST_CONTOUR_PORT: String(normalizedPort),
    AGENT_HUB_TEST_CONTOUR_RUNTIME_NONCE: normalizedRuntimeNonce,
    AGENT_HUB_LAUNCHER: "",
    AGENT_HUB_DISABLE_SECRET_ACL: "1",
    AGENT_HUB_TEST_CONTOUR: "1",
    TELEGRAM_API_BASE_URL: telegramApiBaseUrl,
    AI_PROVIDER: "codex",
    CODEX_MODEL: model,
    CODEX_HOME: recording ? result.CODEX_HOME : paths.codexHome,
    ...(recording ? { AGENT_HUB_RECORDING_PROVIDER_ROOT: recording.root } : { CODEX_PROJECT_ROOT: paths.projectRoot }),
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

export async function resolveTestContourSource({
  root = defaultTestContourRoot(),
  sourceRoot = path.resolve(import.meta.dirname, "..", ".."),
  sourceKind = TEST_CONTOUR_DEV_SOURCE,
  prepareSource = prepareTaskContourSource,
  validateReleaseSource = assertReleaseCandidateContourSource,
} = {}) {
  const isolatedRoot = assertIsolatedTestContourRoot(root, { sourceRoot });
  if (sourceKind === TEST_CONTOUR_RELEASE_CANDIDATE_SOURCE) {
    const source = await validateReleaseSource({ sourceRoot });
    if (source.kind !== TEST_CONTOUR_RELEASE_CANDIDATE_SOURCE
        || source.branch !== "main"
        || !String(source.headCommit ?? "").trim()) {
      throw new Error("release candidate contour must use the exact clean main HEAD");
    }
    return {
      kind: TEST_CONTOUR_RELEASE_CANDIDATE_SOURCE,
      branch: "main",
      headCommit: String(source.headCommit).trim(),
      sourceRoot: canonicalPath(source.sourceRoot),
    };
  }
  if (sourceKind !== TEST_CONTOUR_DEV_SOURCE) {
    throw new Error(`Unknown Test Contour source kind: ${sourceKind}`);
  }
  const paths = testContourPaths(isolatedRoot);
  const source = await prepareSource({
    sourceRoot,
    integrationRoot: paths.taskGitDataDirectory,
  });
  if (source.branch !== "dev" || !String(source.headCommit ?? "").trim()) {
    throw new Error("Test Contour candidate must use the exact dev HEAD");
  }
  return {
    kind: TEST_CONTOUR_DEV_SOURCE,
    branch: source.branch,
    headCommit: String(source.headCommit).trim(),
    sourceRoot: canonicalPath(source.sourceRoot),
  };
}

export async function prepareTestContourCandidate({
  root = defaultTestContourRoot(),
  sourceRoot = path.resolve(import.meta.dirname, "..", ".."),
  source = null,
  sourceKind = TEST_CONTOUR_DEV_SOURCE,
  operation = null,
  port = TEST_CONTOUR_PORT,
  deploy = deployRuntime,
  prepareSource = prepareTaskContourSource,
  validateReleaseSource = assertReleaseCandidateContourSource,
} = {}) {
  const isolatedRoot = assertIsolatedTestContourRoot(root, { sourceRoot });
  const marker = await ensureMarker(isolatedRoot);
  const resolvedSource = source ?? await resolveTestContourSource({
    root: isolatedRoot,
    sourceRoot,
    sourceKind,
    prepareSource,
    validateReleaseSource,
  });
  const expectedBranch = sourceKind === TEST_CONTOUR_RELEASE_CANDIDATE_SOURCE ? "main" : "dev";
  if (resolvedSource.kind !== sourceKind
      || resolvedSource.branch !== expectedBranch
      || !String(resolvedSource.headCommit ?? "").trim()) {
    throw new Error(`Test Contour candidate must use the exact ${expectedBranch} HEAD`);
  }
  const candidateSourceRoot = canonicalPath(resolvedSource.sourceRoot);
  const revalidateReleaseSource = async () => {
    if (sourceKind !== TEST_CONTOUR_RELEASE_CANDIDATE_SOURCE) return;
    const current = await validateReleaseSource({ sourceRoot: candidateSourceRoot });
    if (current.kind !== resolvedSource.kind
        || current.branch !== resolvedSource.branch
        || String(current.headCommit).trim() !== resolvedSource.headCommit
        || !samePath(current.sourceRoot, candidateSourceRoot)) {
      throw new Error("release candidate contour source identity changed during preparation");
    }
  };
  await revalidateReleaseSource();
  const deployed = await deploy({
    sourceRoot: candidateSourceRoot,
    runtimeRoot: isolatedRoot,
    beforeManifest: async ({ stagingRoot }) => {
      await revalidateReleaseSource();
      if (operation) await assertTestContourOperationOwner(isolatedRoot, operation);
      await markTestContourWebApp(stagingRoot);
    },
    // A prepared candidate is not active. The pointer is committed only after
    // its exact manager/runtime pair has reported ready.
    writePointer: async () => {},
    protectPointer: async () => {},
  });
  await revalidateReleaseSource();
  return {
    root: isolatedRoot,
    releaseId: deployed.releaseId,
    releaseRoot: deployed.releaseRoot,
    contourId: marker.id,
    sourceRoot: candidateSourceRoot,
    kind: resolvedSource.kind,
    branch: resolvedSource.branch,
    headCommit: resolvedSource.headCommit,
  };
}

async function currentRelease(root, expectedReleaseId = null) {
  const layout = runtimeLayout(root);
  const pointer = expectedReleaseId ? null : await readJson(layout.currentFile);
  const releaseId = String(expectedReleaseId ?? pointer?.current ?? "").trim();
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

async function publishPreparedTestContourCandidate({
  root,
  candidate,
  operation,
  expectedPreviousReleaseId = null,
  now = new Date(),
} = {}) {
  await assertTestContourOperationOwner(root, operation);
  const paths = testContourPaths(root);
  const layout = runtimeLayout(root);
  const pointer = await readJson(layout.currentFile, {});
  const current = String(pointer?.current ?? "").trim() || null;
  const expectedPrevious = String(expectedPreviousReleaseId ?? "").trim() || null;
  if (current !== expectedPrevious && current !== candidate.releaseId) {
    throw new Error(
      `Test Contour candidate ${candidate.releaseId} was superseded by current release ${current ?? "none"}`,
    );
  }
  const published = {
    current: candidate.releaseId,
    previous: current === candidate.releaseId
      ? pointer.previous ?? expectedPrevious
      : current,
    updatedAt: now.toISOString(),
  };
  await writeTextAtomic(layout.currentFile, `${JSON.stringify(published, null, 2)}\n`);
  const source = {
    kind: candidate.kind,
    branch: candidate.branch,
    headCommit: candidate.headCommit,
    sourceRoot: candidate.sourceRoot,
    contourId: operation.target.contourId,
    port: operation.target.port,
    model: operation.target.model,
    preparedAt: operation.createdAt,
    activatedAt: now.toISOString(),
    operationId: operation.operationId,
    releaseId: candidate.releaseId,
  };
  await writeJson(paths.sourceFile, source);
  return { pointer: published, source };
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

export async function readyTestContourHealth(port, {
  root = defaultTestContourRoot(),
  requireFakeQueue = false,
  expectedIdentity = null,
} = {}) {
  const baseUrl = `http://127.0.0.1:${port}`;
  const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(2_000) });
  if (!response.ok) return null;
  const body = await response.json();
  if (body?.ok !== true || body?.live !== true || body?.ready !== true) return null;
  if (expectedIdentity) {
    const served = body?.testContourRuntime;
    const lock = await readJson(path.join(testContourPaths(root).dataDir, "bot.lock"));
    if (!served
        || served.contourId !== expectedIdentity.contourId
        || served.releaseId !== expectedIdentity.releaseId
        || (served.operationId ?? null) !== (expectedIdentity.operationId ?? null)
        || served.model !== expectedIdentity.model
        || served.runtimeNonce !== expectedIdentity.runtimeNonce
        || Number(served.pid) !== Number(expectedIdentity.runtimePid)
        || Number(served.expectedPort) !== Number(expectedIdentity.port)
        || Number(served.actualPort) !== Number(port)
        || Number(lock?.pid) !== Number(expectedIdentity.runtimePid)
        || lock?.releaseId !== expectedIdentity.releaseId
        || lock?.ready !== true) return null;
  }
  if (!requireFakeQueue) return body;
  const paths = testContourPaths(root);
  const fakeState = await readJson(paths.fakeCodexStateFile, {});
  const recovery = fakeState?.hubRecovery ?? { status: "missing" };
  const queue = await testContourFakeCodexQueueDiagnostics({ root });
  if (recovery.status !== "ready" || queue.status !== "ready") {
    throw new Error(`Fake Codex queue recovery is ${queue.status}: ${JSON.stringify({ recovery, queue })}`);
  }
  return {
    ...body,
    testContour: {
      fakeCodexRecovery: recovery,
      fakeCodexQueue: queue,
    },
  };
}

async function requireRecordingBoot(paths, recording) {
  if (!recording) return;
  await recordingContourProfile({ schemaVersion: 1, root: recording.root }, {
    dataDir: paths.dataDir,
    environment: { AGENT_HUB_TEST_CONTOUR: "1", AGENT_HUB_RUNTIME_ROOT: paths.root },
  });
}

export async function serveTestContour({
  root = defaultTestContourRoot(),
  port = TEST_CONTOUR_PORT,
  model = TEST_CONTOUR_MODEL,
  releaseId: requestedReleaseId = null,
  operationId = null,
  sourceBranch = null,
  sourceHeadCommit = null,
  protectedRuntimeRoot = null,
  spawnImpl = spawn,
} = {}) {
  // The recording manager has owned HOME/LOCALAPPDATA. Its parent supplies the
  // original protected root before environment isolation, bound to this launch.
  const recordingManagerRoot = process.env.AGENT_HUB_RECORDING_MANAGER_ROOT;
  if (protectedRuntimeRoot || recordingManagerRoot) {
    if (!path.isAbsolute(String(protectedRuntimeRoot ?? ""))
        || !samePath(recordingManagerRoot ?? "", root)
        || !samePath(process.env.AGENT_HUB_RECORDING_MANAGER_PRODUCTION_ROOT ?? "", protectedRuntimeRoot)) {
      throw new Error("Recording manager protected runtime identity is missing or mismatched");
    }
  }
  const isolatedRoot = assertIsolatedTestContourRoot(root, {
    ...(protectedRuntimeRoot ? { productionRoot: protectedRuntimeRoot } : {}),
  });
  const marker = await requireMarker(isolatedRoot);
  const paths = testContourPaths(isolatedRoot);
  const recording = await readTestContourRecordingConfiguration(isolatedRoot);
  if (protectedRuntimeRoot && !recording) throw new Error("Recording manager launch requires a prepared recording profile");
  await requireRecordingBoot(paths, recording);
  const { releaseId, releaseRoot } = await currentRelease(isolatedRoot, requestedReleaseId);
  if (!recording) await Promise.all([
    access(paths.fakeCodexExecutable),
    access(paths.codexMultiplexerExecutable),
  ]);
  if (recording) await prepareRecordingContourEnvironment(recording.root);
  const realCodexExecutable = recording ? null : await resolveCodexExecutable();
  const telegram = new LoopbackTelegramApi({ userId: USER_ID, chatId: CHAT_ID });
  await telegram.start();
  await writeJson(paths.configFile, testContourConfig({
    paths,
    telegramApiBaseUrl: telegram.baseUrl,
    port,
    model,
    realCodexExecutable,
    recording,
    sourceRoot: releaseRoot,
  }));
  if (!recording) await rm(paths.stateFile, { force: true });
  const runtimeNonce = randomUUID();
  const runtime = spawnImpl(process.execPath, [path.join(releaseRoot, "agent-hub-main.mjs")], {
    cwd: releaseRoot,
    env: testContourEnvironment({
      paths,
      telegramApiBaseUrl: telegram.baseUrl,
      model,
      releaseId,
      contourId: marker.id,
      operationId,
      port,
      runtimeNonce,
      recording,
    }),
    stdio: "inherit",
    windowsHide: true,
  });
  let runtimeExit = null;
  runtime.once("exit", (code, signal) => { runtimeExit = { code, signal }; });
  try {
    const health = await waitFor(async () => {
      if (runtimeExit) throw new Error(`candidate exited with ${runtimeExit.signal ?? runtimeExit.code}`);
      return readyTestContourHealth(port, {
        root: isolatedRoot,
        requireFakeQueue: !recording && model === TEST_CONTOUR_FAKE_MODEL,
        expectedIdentity: {
          contourId: marker.id,
          releaseId,
          operationId: String(operationId ?? "").trim() || null,
          port,
          model,
          runtimeNonce,
          runtimePid: runtime.pid,
        },
      });
    }, "Test Contour runtime readiness");
    const secret = String(await readFile(path.join(isolatedRoot, "local-web.secret"), "utf8")).trim();
    const url = localWebAccessUrl(`http://${TEST_CONTOUR_WEB_HOST}:${port}/`, secret);
    const state = {
      contourId: marker.id,
      managerPid: process.pid,
      runtimePid: runtime.pid,
      releaseId,
      operationId: String(operationId ?? "").trim() || null,
      runtimeNonce,
      source: String(sourceHeadCommit ?? "").trim() ? {
        branch: String(sourceBranch ?? "dev").trim() || "dev",
        headCommit: String(sourceHeadCommit).trim(),
      } : null,
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

/* Дешёвый признак того, что контур сейчас владеет своими файлами.

   readTestContourStatus дополнительно опрашивает health по HTTP и для
   регулярной фоновой проверки слишком тяжёл. Здесь достаточно того, что оба
   процесса контура живы: пока это так, его journal.sqlite не пересоздаётся. */
export async function testContourRuntimeAlive({ root = defaultTestContourRoot() } = {}) {
  const state = await readJson(testContourPaths(root).stateFile);
  if (!state) return false;
  return processIsAlive(state.managerPid) && processIsAlive(state.runtimePid);
}

export async function readTestContourStatus({
  root = defaultTestContourRoot(),
  expectedOperationId = null,
  expectedHeadCommit = null,
} = {}) {
  const paths = testContourPaths(root);
  const [state, source, operationDocument] = await Promise.all([
    readJson(paths.stateFile),
    readJson(paths.sourceFile),
    readTestContourOperationDocument(root),
  ]);
  const operationReadback = testContourOperationReadback(operationDocument, {
    expectedOperationId,
    expectedHeadCommit,
  });
  const activeSource = state?.source?.headCommit
    ? { ...source, ...state.source }
    : source;
  const planned = operationDocument.current?.status === "running";
  if (!state || !processIsAlive(state.managerPid) || !processIsAlive(state.runtimePid)) {
    return {
      running: false,
      root: paths.root,
      state: state ?? null,
      source: activeSource,
      status: planned ? "refreshing" : "stopped",
      planned,
      operation: operationReadback.current,
      readback: operationReadback,
    };
  }
  const recording = await readTestContourRecordingConfiguration(root);
  await requireRecordingBoot(paths, recording);
  const health = await readyTestContourHealth(state.port, {
    root: paths.root,
    requireFakeQueue: !recording && state.model === TEST_CONTOUR_FAKE_MODEL,
    expectedIdentity: state.contourId && state.releaseId ? {
      contourId: state.contourId,
      releaseId: state.releaseId,
      operationId: state.operationId ?? null,
      port: state.port,
      model: state.model,
      runtimeNonce: state.runtimeNonce,
      runtimePid: state.runtimePid,
    } : null,
  }).catch(() => null);
  return {
    running: Boolean(health),
    root: paths.root,
    state,
    health,
    source: activeSource,
    status: planned ? "refreshing" : (health ? "ready" : "not-ready"),
    planned,
    operation: operationReadback.current,
    readback: operationReadback,
  };
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
  if (await readTestContourRecordingConfiguration(isolatedRoot)) {
    throw Object.assign(new Error("Recording cohorts require fresh coherent preparation; legacy clone/reset is forbidden"), {
      code: "CONTOUR_RECORDING_REFRESH_REQUIRES_COHORT",
    });
  }
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

async function launchTestContourCandidate({
  root,
  entryFile,
  candidate,
  port,
  model,
  operation = null,
  spawnManager = spawn,
  onManagerSpawn = async () => {},
} = {}) {
  const paths = testContourPaths(root);
  const candidateSourceRoot = candidate.sourceRoot;
  const recording = await readTestContourRecordingConfiguration(root);
  await requireRecordingBoot(paths, recording);
  if (recording) entryFile = await recordingManagerEntry(candidateSourceRoot);
  if (!recording) {
    await prepareTestContourCodexProviders({ root, sourceRoot: candidateSourceRoot });
    await prepareTestContourCodexHome(paths);
    await alignTestContourStreamModel({
      databaseFile: path.join(paths.dataDir, "journal.sqlite"),
      model,
    });
    await reconcileTestContourFakeCodexState({ root, model });
    await rm(paths.stateFile, { force: true });
  }
  const managerEnvironment = recording ? await prepareRecordingContourEnvironment(recording.root) : null;
  const protectedRuntimeRoot = defaultRuntimeRoot();
  if (recording) assertIsolatedTestContourRoot(root, { productionRoot: protectedRuntimeRoot, sourceRoot: candidateSourceRoot });
  const stdout = openSync(paths.stdoutFile, "a");
  const stderr = openSync(paths.stderrFile, "a");
  let manager;
  try {
    const args = [
      entryFile,
      "serve",
      "--root",
      root,
      "--port",
      String(port),
      "--model",
      model,
      "--release-id",
      candidate.releaseId,
    ];
    if (operation?.operationId) args.push("--operation-id", operation.operationId);
    if (candidate.branch) args.push("--source-branch", candidate.branch);
    if (candidate.headCommit) args.push("--source-head", candidate.headCommit);
    if (recording) args.push("--protected-runtime-root", protectedRuntimeRoot);
    manager = spawnManager(process.execPath, args, {
      cwd: candidateSourceRoot,
      ...(managerEnvironment ? { env: { ...managerEnvironment,
        AGENT_HUB_RECORDING_MANAGER_ROOT: root,
        AGENT_HUB_RECORDING_MANAGER_PRODUCTION_ROOT: protectedRuntimeRoot,
      } } : {}),
      detached: true,
      stdio: ["ignore", stdout, stderr],
      windowsHide: true,
    });
    manager.unref();
    await onManagerSpawn(manager);
  } finally {
    closeSync(stdout);
    closeSync(stderr);
  }
  return waitFor(async () => {
    const state = await readJson(paths.stateFile);
    if (state && processIsAlive(state.managerPid) && processIsAlive(state.runtimePid)) return state;
    if (!processIsAlive(manager.pid)) {
      const errorLog = await readFile(paths.stderrFile, "utf8").catch(() => "");
      throw new Error(`Test Contour manager exited before readiness\n${errorLog.slice(-4_000)}`);
    }
    return null;
  }, "Test Contour background startup");
}

async function recordingManagerEntry(sourceRoot) {
  const entry = path.join(sourceRoot, "test-contour.mjs");
  await access(entry);
  const manager = await import(pathToFileURL(path.join(sourceRoot, "src/runtime/test-contour-manager.mjs")).href);
  if (manager.RECORDING_COHORT_MANAGER_VERSION !== RECORDING_COHORT_MANAGER_VERSION) throw new Error("Candidate manager does not support the prepared recording cohort");
  return entry;
}

async function recoverInterruptedTestContourRefresh(root) {
  const document = await readTestContourOperationDocument(root);
  const operation = document.current;
  if (operation?.status !== "running" || processIsAlive(Number(operation.ownerPid))) return null;
  const status = await readTestContourStatus({ root });
  const stateMatches = status.running
    && status.state?.operationId === operation.operationId
    && status.state?.releaseId === operation.releaseId
    && status.state?.source?.headCommit === operation.source?.headCommit
    && canonicalPath(operation.target?.root) === canonicalPath(root)
    && status.state?.contourId === operation.target?.contourId
    && Number(status.state?.port) === Number(operation.target?.port)
    && status.state?.model === operation.target?.model;
  if (!stateMatches) {
    await failStaleTestContourOperation(root, {
      operationId: operation.operationId,
      reason: "owner-crash-before-ready-runtime",
    });
    return { recovered: false, operation };
  }
  const candidate = {
    releaseId: operation.releaseId,
    releaseRoot: runtimeReleaseDirectory(root, operation.releaseId),
    kind: operation.source.kind ?? TEST_CONTOUR_DEV_SOURCE,
    branch: operation.source.branch,
    headCommit: operation.source.headCommit,
    sourceRoot: operation.source.sourceRoot,
  };
  const published = await publishPreparedTestContourCandidate({
    root,
    candidate,
    operation,
    expectedPreviousReleaseId: operation.previousReleaseId,
  });
  const ready = await recoverReadyTestContourOperation(root, {
    operationId: operation.operationId,
    releaseId: operation.releaseId,
    runtime: {
      managerPid: status.state.managerPid,
      runtimePid: status.state.runtimePid,
    },
  });
  return { recovered: true, operation: ready, state: status.state, source: published.source };
}

async function refreshTestContourUnlocked({
  root,
  entryFile,
  sourceRoot,
  port,
  model,
  sourceKind = TEST_CONTOUR_DEV_SOURCE,
  forceFreshCandidate = false,
  prepareSource = prepareTaskContourSource,
  validateReleaseSource = assertReleaseCandidateContourSource,
  prepareCandidate = prepareTestContourCandidate,
  stopRuntime = stopTestContourUnlocked,
  launchCandidate = launchTestContourCandidate,
  beforeCutover = async () => {},
  adoption = null,
} = {}) {
  const recording = await readTestContourRecordingConfiguration(root);
  if (recording) await requireRecordingBoot(testContourPaths(root), recording);
  await recoverInterruptedTestContourRefresh(root);
  const marker = await ensureMarker(root);
  const source = await resolveTestContourSource({
    root,
    sourceRoot,
    sourceKind,
    prepareSource,
    validateReleaseSource,
  });
  const currentStatus = await readTestContourStatus({ root });
  const currentOperation = currentStatus.operation;
  const exactReadyTarget = currentStatus.running
    && currentStatus.status === "ready"
    && currentStatus.planned === false
    && currentOperation?.status === "ready"
    && currentOperation?.phase === "ready"
    && canonicalPath(currentOperation.target?.root) === canonicalPath(root)
    && currentOperation.target?.contourId === marker.id
    && Number(currentOperation.target?.port) === Number(port)
    && currentOperation.target?.model === model
    && (currentOperation.source?.kind ?? TEST_CONTOUR_DEV_SOURCE) === source.kind
    && currentOperation.source?.branch === source.branch
    && currentOperation.source?.headCommit === source.headCommit
    && canonicalPath(currentOperation.source?.sourceRoot) === canonicalPath(source.sourceRoot)
    && currentStatus.state?.contourId === marker.id
    && Number(currentStatus.state?.port) === Number(port)
    && currentStatus.state?.model === model
    && currentStatus.state?.operationId === currentOperation.operationId
    && currentStatus.state?.releaseId === currentOperation.releaseId
    && currentStatus.source?.headCommit === source.headCommit;
  if (!forceFreshCandidate && exactReadyTarget) {
    return {
      ...currentStatus.state,
      source: currentStatus.source,
      operation: currentStatus.operation,
      operationId: currentStatus.operation?.operationId ?? null,
      refreshOutcome: "coalesced",
    };
  }

  const operation = await beginTestContourOperation(root, {
    kind: "refresh",
    source,
    target: { root, contourId: marker.id, port, model },
  });
  try {
    const candidate = await prepareCandidate({
      root,
      sourceRoot,
      sourceKind,
      source,
      operation,
      port,
      model,
      validateReleaseSource,
    });
    if (recording || adoption) await recordingManagerEntry(candidate.sourceRoot);
    const previousReleaseId = currentStatus.state?.releaseId
      ?? String((await readJson(runtimeLayout(root).currentFile, {}))?.current ?? "").trim()
      ?? null;
    let currentOperation = await transitionTestContourOperation(root, {
      operationId: operation.operationId,
      ownerToken: operation.ownerToken,
      phase: "prepared",
      patch: {
        releaseId: candidate.releaseId,
        previousReleaseId: previousReleaseId || null,
      },
    });
    await beforeCutover({ candidate, operation: visibleTestContourOperation(currentOperation), currentStatus });
    if (adoption) {
      await writeContourAdoption(root, adoption, { operationId: operation.operationId, releaseId: candidate.releaseId });
      await snapshotContourAdoptionControl(root, adoption);
    }
    await assertTestContourOperationOwner(root, operation);
    currentOperation = await transitionTestContourOperation(root, {
      operationId: operation.operationId,
      ownerToken: operation.ownerToken,
      phase: "stopping",
    });
    await stopRuntime({ root });
    await assertTestContourOperationOwner(root, operation);
    if (adoption) await activateContourAdoption(root, adoption);
    currentOperation = await transitionTestContourOperation(root, {
      operationId: operation.operationId,
      ownerToken: operation.ownerToken,
      phase: "starting",
    });
    const state = await launchCandidate({
      root,
      entryFile,
      candidate,
      port,
      model,
      operation: currentOperation,
      onManagerSpawn: async (manager) => {
        currentOperation = await transitionTestContourOperation(root, {
          operationId: operation.operationId,
          ownerToken: operation.ownerToken,
          phase: "starting",
          patch: { managerPid: manager.pid },
        });
      },
    });
    if (state.releaseId !== candidate.releaseId
        || state.operationId !== operation.operationId
        || state.source?.headCommit !== source.headCommit
        || state.contourId !== marker.id
        || Number(state.port) !== Number(port)
        || state.model !== model) {
      throw new Error("Test Contour ready runtime does not match its refresh operation");
    }
    currentOperation = await transitionTestContourOperation(root, {
      operationId: operation.operationId,
      ownerToken: operation.ownerToken,
      phase: "publishing",
      patch: {
        runtime: { managerPid: state.managerPid, runtimePid: state.runtimePid },
      },
    });
    const published = await publishPreparedTestContourCandidate({
      root,
      candidate,
      operation,
      expectedPreviousReleaseId: previousReleaseId,
    });
    const ready = await transitionTestContourOperation(root, {
      operationId: operation.operationId,
      ownerToken: operation.ownerToken,
      phase: "ready",
      status: "ready",
      patch: {
        releaseId: candidate.releaseId,
        runtime: { managerPid: state.managerPid, runtimePid: state.runtimePid },
      },
    });
    if (adoption) await writeContourAdoption(root, adoption, { phase: "committed" });
    return {
      ...state,
      source: published.source,
      operation: visibleTestContourOperation(ready),
      operationId: ready.operationId,
      refreshOutcome: "refreshed",
    };
  } catch (error) {
    // A launched candidate may already have changed its owned cohort. Preserve
    // both generations on ambiguous failure; never silently discard that data.
    if (adoption?.phase === "switching") {
      await assertTestContourOperationOwner(root, operation);
      await rollbackContourAdoption(root, adoption);
    }
    await transitionTestContourOperation(root, {
      operationId: operation.operationId,
      ownerToken: operation.ownerToken,
      phase: "failed",
      status: "failed",
      patch: { reason: error.message },
    }).catch(() => null);
    throw error;
  }
}

async function recoverContourAdoptionUnlocked(root) {
  const adoption = await readContourAdoption(root);
  if (!adoption || ["staged", "committed", "rolled-back"].includes(adoption.phase)) return adoption;
  // The lease serializes current callers, but an older installed manager may
  // have completed a later refresh without understanding this adoption journal.
  // A stale A must never stop or rename the live state of independent B.
  const operationDocument = await readTestContourOperationDocument(root);
  const current = operationDocument.current;
  const marker = await requireMarker(root);
  if (!adoption.operationId || current?.operationId !== adoption.operationId
      || !current.target?.root || !samePath(current.target.root, root)
      || !adoption.contourId || current.target.contourId !== adoption.contourId
      || marker.id !== adoption.contourId) {
    throw new Error("Recording adoption requires manual reconciliation: its operation identity was superseded; no process or cohort changed");
  }
  if (["stopping", "switching", "rolling-back"].includes(adoption.phase)) {
    if (!["prepared", "stopping", "failed"].includes(current.phase)) throw new Error("Recording adoption requires manual reconciliation: prelaunch journal conflicts with current operation phase");
    await stopTestContourUnlocked({ root });
    const afterStop = await readTestContourOperationDocument(root);
    if (afterStop.current?.operationId !== adoption.operationId
        || afterStop.current?.ownerToken !== current.ownerToken
        || !samePath(afterStop.current?.target?.root ?? "", root)
        || afterStop.current?.target?.contourId !== adoption.contourId
        || !["prepared", "stopping", "failed"].includes(afterStop.current?.phase)) throw new Error("Recording adoption operation changed before rollback; both cohorts retained");
    return rollbackContourAdoption(root, adoption);
  }
  if (adoption.phase === "activated") {
    await recoverInterruptedTestContourRefresh(root);
    const document = await readTestContourOperationDocument(root);
    const status = await readTestContourStatus({ root });
    if (document.current?.operationId === adoption.operationId && document.current.status === "ready"
        && status.status === "ready" && status.state?.operationId === adoption.operationId
        && status.state?.releaseId === adoption.releaseId) {
      return writeContourAdoption(root, adoption, { phase: "committed" });
    }
  }
  throw new Error("Recording adoption requires manual reconciliation; old and candidate cohorts are preserved");
}

// One canonical root and the same operation lease as refresh. This is an
// explicit migration, never an implicit clone/reset or a per-Task contour.
export async function adoptRecordingTestContour({ root = defaultTestContourRoot(), preparedRoot,
  sourceRoot = path.resolve(import.meta.dirname, "..", ".."), entryFile,
  port = TEST_CONTOUR_PORT, model = TEST_CONTOUR_MODEL, ...dependencies } = {}) {
  if (!preparedRoot || !path.isAbsolute(preparedRoot)) throw new Error("An explicit prepared cohort root is required");
  if (dependencies.sourceKind && dependencies.sourceKind !== TEST_CONTOUR_DEV_SOURCE) throw new Error("Recording adoption accepts only dev");
  const isolatedRoot = assertIsolatedTestContourRoot(root, { sourceRoot });
  return withTestContourOperationLock(isolatedRoot, async () => {
    await requireMarker(isolatedRoot);
    await recoverContourAdoptionUnlocked(isolatedRoot);
    const adoption = await stageContourAdoption({ root: isolatedRoot, preparedRoot });
    return refreshTestContourUnlocked({ ...dependencies, root: isolatedRoot, sourceRoot, entryFile, port, model,
      sourceKind: TEST_CONTOUR_DEV_SOURCE, forceFreshCandidate: true, adoption });
  });
}

async function startTestContourUnlocked({
  root = defaultTestContourRoot(),
  entryFile,
  refresh = false,
  sourceRoot = path.resolve(import.meta.dirname, "..", ".."),
  port = TEST_CONTOUR_PORT,
  model = TEST_CONTOUR_MODEL,
  sourceKind = TEST_CONTOUR_DEV_SOURCE,
  ...dependencies
} = {}) {
  const isolatedRoot = assertIsolatedTestContourRoot(root, { sourceRoot });
  await recoverContourAdoptionUnlocked(isolatedRoot);
  if (refresh) {
    return refreshTestContourUnlocked({
      root: isolatedRoot,
      entryFile,
      sourceRoot,
      port,
      model,
      sourceKind,
      ...dependencies,
    });
  }
  if (sourceKind !== TEST_CONTOUR_DEV_SOURCE) {
    throw new Error("ordinary Test Contour start accepts only the exact dev source");
  }
  const expectedSource = await resolveTestContourSource({
    root: isolatedRoot,
    sourceRoot,
    sourceKind: TEST_CONTOUR_DEV_SOURCE,
    prepareSource: dependencies.prepareSource ?? prepareTaskContourSource,
  });
  const source = await readJson(testContourPaths(isolatedRoot).sourceFile);
  const candidate = await currentRelease(isolatedRoot).then((release) => ({
    ...release,
    kind: source?.kind ?? TEST_CONTOUR_DEV_SOURCE,
    sourceRoot: source?.sourceRoot ?? sourceRoot,
    branch: source?.branch ?? null,
    headCommit: source?.headCommit ?? null,
    contourId: source?.contourId ?? null,
    operationId: source?.operationId ?? null,
    port: Number(source?.port) || null,
    model: source?.model ?? null,
  })).catch(() => null);
  if (!candidate
      || !candidate.contourId
      || !candidate.operationId
      || candidate.port !== port
      || candidate.model !== model
      || candidate.kind !== TEST_CONTOUR_DEV_SOURCE
      || candidate.branch !== expectedSource.branch
      || candidate.headCommit !== expectedSource.headCommit
      || !samePath(candidate.sourceRoot, expectedSource.sourceRoot)) {
    return refreshTestContourUnlocked({
      root: isolatedRoot,
      entryFile,
      sourceRoot,
      port,
      model,
      sourceKind,
      ...dependencies,
    });
  }
  await stopTestContourUnlocked({ root: isolatedRoot });
  const launchCandidate = dependencies.launchCandidate ?? launchTestContourCandidate;
  const state = await launchCandidate({
    root: isolatedRoot,
    entryFile,
    candidate,
    port,
    model,
    operation: { operationId: candidate.operationId },
  });
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

export function testContourSmokeAgentPolicy({ withAgent = true, recording = null } = {}) {
  if (withAgent && recording) {
    return {
      withAgent: false,
      agentProbeSkipped: "recording-contour-external-effects-denied",
    };
  }
  return { withAgent: Boolean(withAgent), agentProbeSkipped: null };
}

async function verifyTestContourUnlocked({
  root = defaultTestContourRoot(),
  entryFile,
  sourceRoot = path.resolve(import.meta.dirname, "..", ".."),
  withAgent = true,
  model = TEST_CONTOUR_MODEL,
  sourceKind = TEST_CONTOUR_DEV_SOURCE,
  port = TEST_CONTOUR_PORT,
  startContour = startTestContourUnlocked,
  smokeRunner = null,
  readRecordingConfiguration = readTestContourRecordingConfiguration,
} = {}) {
  const paths = testContourPaths(root);
  const state = await startContour({
    root,
    entryFile,
    refresh: true,
    sourceRoot,
    model,
    sourceKind,
    port,
  });
  const recording = await readRecordingConfiguration(root);
  const smokePolicy = testContourSmokeAgentPolicy({ withAgent, recording });
  const {
    runTestContourUiSmoke,
    TEST_CONTOUR_PROBE,
    TEST_CONTOUR_PROBE_RESPONSE,
  } = await import("../infrastructure/browser/test-contour-ui-smoke.mjs");
  const probeResponse = model === TEST_CONTOUR_FAKE_MODEL
    ? "Принято"
    : TEST_CONTOUR_PROBE_RESPONSE;
  const runSmoke = smokeRunner ?? runTestContourUiSmoke;
  const smoke = await runSmoke({
    url: state.url,
    automationRoot: paths.automationRoot,
    artifactsDirectory: paths.artifactsDirectory,
    withAgent: smokePolicy.withAgent,
    model: state.model,
    probeResponse,

  });
  let journal = null;
  if (smokePolicy.withAgent) {
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
  return {
    state,
    smoke,
    journal,
    ...(smokePolicy.agentProbeSkipped ? { agentProbeSkipped: smokePolicy.agentProbeSkipped } : {}),
  };
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
