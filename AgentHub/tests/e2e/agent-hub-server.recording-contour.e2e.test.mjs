import { PersistentDeliveryOutbox } from "../../src/infrastructure/persistence/delivery-outbox.mjs";
import { PersistentBackgroundJobStore } from "../../src/infrastructure/persistence/background-job-store.mjs";
import { LoopbackTelegramApi } from "../../src/infrastructure/network/loopback-telegram-api.mjs";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { RecordingContourProvider } from "../../src/providers/recording-contour-provider.mjs";
import { prepareRecordingContourEnvironment } from "../../src/infrastructure/filesystem/test-contour-recording-environment.mjs";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { callDesktopControl } from "../../desktop-control.mjs";
import { RuntimeStateStore, readRuntimeState } from "../../src/infrastructure/persistence/runtime-state-store.mjs";
import { WorkspaceCatalogStore } from "../../src/infrastructure/persistence/workspace-catalog-store.mjs";
import { LocalTaskSyncStore } from "../../src/infrastructure/persistence/task-sync-store.mjs";
import { messageRequestFingerprint } from "../../src/infrastructure/persistence/message-receipts.mjs";
import { captureSqliteCohort } from "../../src/runtime/sqlite-cohort-snapshot.mjs";
import { prepareRecordingContourCohort } from "../../src/runtime/test-contour-cohort-preparation.mjs";
import { stopPid } from "../../e2e/telegram-harness.mjs";

const sourceRoot = path.resolve(import.meta.dirname, "../..");
const threadId = "10000000-0000-4000-8000-000000000182";
const clientUserMessageId = "synthetic-recording-paused-command";
const text = "[child:../../escape] [hold:forever] [fail] Literal synthetic queue";
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const hash = async (file) => createHash("sha256").update(await readFile(file)).digest("hex");

async function preparedFixture(t, { paused = true, withSidecars = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "hub-recording-boot-"));
  // This test creates and owns every source byte as well as the writable copy.
  t.after(async () => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const dataDir = path.join(root, "synthetic-source", "data");
  const projectRoot = path.join(root, "synthetic-source", "project");
  await mkdir(dataDir, { recursive: true });
  await mkdir(projectRoot);
  const catalog = new WorkspaceCatalogStore({ databaseFile: path.join(dataDir, "journal.sqlite") });
  const history = new LocalTaskSyncStore({ filePath: path.join(dataDir, "task-sync.json"), databaseFile: path.join(dataDir, "journal.sqlite") });
  const runtime = new RuntimeStateStore({ dataDir });
  let target;
  const fingerprint = await messageRequestFingerprint({ text, attachmentIdentities: [] });
  const sourceRollout = path.join(projectRoot, "untouched-source-rollout.jsonl");
  await writeFile(sourceRollout, "owned rollout sentinel; never an executable recording input");
  const capturedAudit = withSidecars ? {
    version: 18, subagentBackfillPending: true, completedThrough: "2026-01-01T00:00:00.000Z",
    positions: [[threadId, { path: sourceRollout, offset: 0, backlog: true }]],
    pendingTurns: [[threadId, { thread: { id: threadId, path: sourceRollout, cwd: projectRoot },
      turns: [{ turnId: "captured-source-turn", startedAt: "2026-01-01T00:00:00.000Z" }] }]],
    historicalSubagentBackfill: { pending: true, initialized: true, prepared: true, totalFiles: 1,
      queue: [{ thread: { id: threadId, path: sourceRollout, cwd: projectRoot }, offset: 0, size: 100 }] },
  } : undefined;

  try {
    await catalog.load(); await history.load(); await runtime.load();
    const workspace = catalog.createWorkspace({ name: "Synthetic recording", settings: { workingDirectory: projectRoot } });
    const stream = catalog.createStream({ workspaceId: workspace.id, name: "Original Stream" });
    catalog.updateStreamSettings(stream.id, { project: projectRoot });
    target = { workspaceId: workspace.id, streamId: stream.id, provider: "codex", threadId, projectRoot };
    catalog.bindThread(target);
    await history.recordHistory(target, [{ id: "synthetic-original-final", status: "completed", completed: true,
      startedAt: new Date(Date.now() - 2000).toISOString(), completedAt: new Date(Date.now() - 1000).toISOString(),
      messages: [{ itemId: "synthetic-agent", role: "agent", phase: "final_answer", text: "Retained synthetic final" }] }]);
    const item = { ...target, id: "synthetic-paused-intake", clientUserMessageId, clientSource: "desktop-control",
      input: [{ type: "text", text }], paused, createdAt: new Date().toISOString(),
      conflictKind: "message-intake", telegramDeliveryRequested: false };
    const receipt = { provider: "codex", threadId, clientUserMessageId, fingerprint,
      createdAt: item.createdAt, result: { accepted: true, queued: true, id: item.id } };
    await runtime.saveDeferredIntake({ item, destination: "queued", receipt });
    await runtime.save({ activeProvider: "codex", activeProjectRoot: projectRoot, streamId: stream.id,
      threadIds: { codex: threadId, claude: null }, activeThreadTitle: "Original Stream", activeRuns: [],
      pendingInputs: [], queuedInputs: [item], desktopMessageReceipts: [receipt],
      ...(capturedAudit ? { codexTerminalAudit: capturedAudit } : {}) });
  } finally {
    await runtime.close(); await history.close(); await catalog.close();
  }
  let delivery, background;
  if (withSidecars) {
    const outbox = new PersistentDeliveryOutbox({ directoryPath: path.join(dataDir, "delivery-outbox"), deliver: async () => { throw new Error("fixture must not deliver"); } });
    delivery = await outbox.enqueue({ method: "sendMessage", body: { chat_id: 84, text: "Captured synthetic outbox envelope" } });
    const jobs = new PersistentBackgroundJobStore({ directoryPath: path.join(dataDir, "background-jobs") });
    background = await jobs.enqueue({ kind: "speech", payload: { chatId: 84, text: "Captured synthetic inert speech" } });
  }
  const captured = await captureSqliteCohort({ sourceDataDirectory: dataDir,
    outputDirectory: path.join(root, "raw"), includeQueueFiles: true });
  const prepared = await prepareRecordingContourCohort({ captureManifestFile: captured.manifestFile,
    outputDirectory: path.join(root, "writable"), sourceConfig: { projectRoot, projects: [{ name: "Synthetic recording", path: projectRoot }] } });
  const before = await Promise.all(captured.manifest.databases.map(async ({ name }) => [name, await hash(path.join(captured.dataDirectory, name))]));
  return { root, target, fingerprint, captured, prepared, before, delivery, background, sourceRollout };
}

function ledger(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try { return db.prepare("SELECT client_user_message_id, fingerprint, state FROM message_commands WHERE client_user_message_id = ?").get(clientUserMessageId); }
  finally { db.close(); }
}

test("recording boot fixture prepares owned SQLite, paused queue and exact marker", { timeout: 10000 }, async (t) => {
  const f = await preparedFixture(t);
  assert.equal(f.prepared.manifest.phase, "prepared");
  assert.equal(f.prepared.manifest.bootable, false);
  const state = await readRuntimeState(path.join(f.prepared.root, "data"));
  const queued = state.queuedInputs.find((item) => item.clientUserMessageId === clientUserMessageId);
  assert.equal(queued.paused, true);
  assert.equal(queued.threadId, threadId);
  assert.equal(queued.streamId, f.target.streamId);
  assert.deepEqual(queued.input, [{ type: "text", text }]);
  assert.equal(queued.projectRoot, f.target.projectRoot);
  const command = ledger(path.join(f.prepared.root, "data", "message-command-ledger.sqlite"));
  assert.equal(command.fingerprint, f.fingerprint);
  assert.equal(command.state, "queued");
  assert.notEqual(f.prepared.recording.projectRoot, f.target.projectRoot);
  const marker = JSON.parse(await readFile(path.join(f.prepared.recording.root, "recording-provider.json"), "utf8"));
  assert.deepEqual(marker.threads.map((item) => item.id), [threadId]);
  assert.equal(await hash(path.join(f.prepared.recording.root, "recording-provider.json")), f.prepared.manifest.recordingMarkerSha256);
});

async function runtimeEnvironment(f, { telegramApiBaseUrl = null } = {}) {
  const runtimeRoot = f.prepared.root;
  const configFile = path.join(runtimeRoot, "config.json");
  await writeFile(configFile, JSON.stringify({
    components: { telegram: Boolean(telegramApiBaseUrl), miniApp: false, androidApp: false, sharedDashboardBot: false, testContour: true, codexContextCleanup: false },
    telegramBotToken: "123:test-contour-token", telegramApiBaseUrl, allowedUserIds: [42], allowedChatIds: [84],
    provider: "codex", projectRoot: f.prepared.recording.projectRoot, projects: f.prepared.recording.projects,
    dataDir: path.join(runtimeRoot, "data"), testContourRecording: { schemaVersion: 1, root: f.prepared.recording.root },
    codexExecutable: "must-never-run-raw-provider", codexExecutableAutoUpdate: true,
    codexExecutableArgs: ["--must-never-use-raw-args"],
    codexRolloutContext: { enabled: false }, codexRateLimitPolling: false, claudeRateLimitPolling: false,
    createInitialThreadOnStartup: false, voiceEnabled: false, ttsEnabled: false,
    guardConcurrentRepositoryWrites: false, taskBoard: { triageEnabled: false },
    diagnostics: { sentry: { enabled: false, dsn: "" } },
  }), "utf8");
  const environment = await prepareRecordingContourEnvironment(f.prepared.recording.root, { ...process.env,
    OPENAI_API_KEY: "inherited-secret-must-drop", NODE_OPTIONS: "--require must-not-load" });
  Object.assign(environment, { AGENT_HUB_CONFIG: configFile, AGENT_HUB_RUNTIME_ROOT: runtimeRoot, AGENT_HUB_TEST_CONTOUR: "1",
    CODEX_EXECUTABLE: "must-never-run-environment-provider", CODEX_EXECUTABLE_AUTO_UPDATE: "true",
    AGENT_HUB_RECORDING_PROVIDER_ROOT: f.prepared.recording.root, AGENT_HUB_DISABLE_SECRET_ACL: "1", AGENT_HUB_LAUNCHER: "" });
  return environment;
}

test("recording full Hub shell restores the same paused command across restart", { timeout: 25000 }, async (t) => {
  const f = await preparedFixture(t);
  const runtimeRoot = f.prepared.root;
  const environment = await runtimeEnvironment(f);
  let child; let stderr = "";
  const stop = async () => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    await Promise.race([exited, delay(1500)]);
    if (child.exitCode === null && child.signalCode === null) { await stopPid(child.pid); await Promise.race([exited, delay(1500)]); }
    assert.ok(child.exitCode !== null || child.signalCode !== null, "owned Hub process must exit before root cleanup");
  };
  // Stop the owned process in finally before the fixture removes its root.
  try {
    for (let generation = 0; generation < 2; generation++) {
      stderr = "";
      child = spawn(process.execPath, [path.join(sourceRoot, "agent-hub-main.mjs")], {
        cwd: runtimeRoot, env: environment, windowsHide: true, stdio: ["ignore", "ignore", "pipe"],
      });
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-12000); });
      const deadline = Date.now() + 8000;
      let snapshot;
      while (Date.now() < deadline) {
        assert.ok(child.exitCode === null && child.signalCode === null, stderr);
        try { snapshot = await callDesktopControl("snapshot", { compactSnapshot: true, snapshotProtocol: 4 }, { runtimeRoot, timeoutMs: 600 }); }
        catch { await delay(100); continue; }
        const providerStarted = await stat(path.join(f.prepared.recording.root, "recording-provider.sqlite")).then(() => true, () => false);
        if (providerStarted && snapshot.collectionDeltas?.conversations?.reset?.some((task) => task.threadId === threadId)) break;
        await delay(100);
      }
      assert.equal(snapshot?.apiVersion, 4, stderr);
      const task = snapshot.collectionDeltas.conversations.reset.find((item) => item.threadId === threadId);
      assert.equal(task?.streamId, f.target.streamId);
      assert.equal(task.running, false);
      const queued = snapshot.deferredInputs.find((item) => item.clientUserMessageId === clientUserMessageId);
      assert.equal(queued?.state, "paused");
      assert.equal(queued?.threadId, threadId);
      await stop();
      const command = ledger(path.join(runtimeRoot, "data", "message-command-ledger.sqlite"));
      assert.equal(command.fingerprint, f.fingerprint);
      assert.equal(command.state, "queued");
      // A forced Windows process stop can leave the schema and rows in WAL.
      // Open the owned fixture database writable so SQLite can recover it,
      // then fence every statement as query-only before asserting its state.
      const provider = new DatabaseSync(path.join(f.prepared.recording.root, "recording-provider.sqlite"));
      try {
        provider.exec("PRAGMA query_only = 1");
        assert.equal(provider.prepare("SELECT count(*) AS count FROM commands").get().count, 0);
      } finally { provider.close(); }
    }
    for (const [name, expected] of f.before) assert.equal(await hash(path.join(f.captured.dataDirectory, name)), expected);
  } finally { await stop(); }
});


test("recording queued command survives Hub replacement and commits the same provider terminal once", { timeout: 25000 }, async (t) => {
  const f = await preparedFixture(t, { paused: false, withSidecars: true });
  const runtimeRoot = f.prepared.root;
  const telegram = new LoopbackTelegramApi({ userId: 42, chatId: 84 });
  await telegram.start(); t.after(() => telegram.stop());
  const environment = await runtimeEnvironment(f, { telegramApiBaseUrl: telegram.baseUrl });
  const configModule = pathToFileURL(path.join(sourceRoot, "src/infrastructure/filesystem/config.mjs")).href;
  const probe = `const {loadConfig}=await import(${JSON.stringify(configModule)});const c=await loadConfig();console.log(JSON.stringify({executable:c.codexExecutable,args:c.codexExecutableArgs,autoUpdate:c.codexExecutableAutoUpdate,home:process.env.HOME,claudeHome:process.env.CLAUDE_CONFIG_DIR,apiKey:process.env.OPENAI_API_KEY,nodeOptions:process.env.NODE_OPTIONS}));`;
  const { stdout } = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", probe], {
    cwd: runtimeRoot, env: environment, windowsHide: true, timeout: 3000,
  });
  const loaded = JSON.parse(stdout.trim());
  assert.equal(loaded.executable, process.execPath);
  assert.deepEqual(loaded.args, [path.join(sourceRoot, "src/providers/recording-contour-codex-cli.mjs"), "--recording-root", f.prepared.recording.root]);
  assert.equal(loaded.autoUpdate, false);
  assert.equal(path.dirname(loaded.home), f.prepared.recording.root);
  assert.equal(path.dirname(loaded.claudeHome), f.prepared.recording.root);
  assert.equal(loaded.apiKey, undefined); assert.equal(loaded.nodeOptions, undefined);
  let child; let stderr = "";
  let commandReader = null;
  const stop = async () => {
    commandReader?.close(); commandReader = null;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, "exit"); child.kill("SIGTERM");
    await Promise.race([exited, delay(1500)]);
    if (child.exitCode === null && child.signalCode === null) { await stopPid(child.pid); await Promise.race([exited, delay(1500)]); }
    assert.ok(child.exitCode !== null || child.signalCode !== null, "owned Hub must exit before fixture cleanup");
  };
  const start = () => {
    stderr = "";
    child = spawn(process.execPath, [path.join(sourceRoot, "agent-hub-main.mjs")], {
      cwd: runtimeRoot, env: environment, windowsHide: true, stdio: ["ignore", "ignore", "pipe"],
    });
    child.stderr.setEncoding("utf8"); child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-12000); });
  };
  const waitFor = async (predicate, label) => {
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      assert.ok(child.exitCode === null && child.signalCode === null, stderr);
      const value = await predicate(); if (value) return value;
      await delay(100);
    }
    assert.fail(`${label} timed out: ${stderr}`);
  };
  const readCommand = () => {
    const file = path.join(f.prepared.recording.root, "recording-provider.sqlite");
    try {
      // The writer creates this database and switches it to WAL during startup.
      // Retain one read-only observer per Hub generation. SQLite itself may wait
      // at most 1 s for that schema/WAL lock; no SQL error is retried or hidden.
      commandReader ??= new DatabaseSync(file, { readOnly: true, timeout: 1000 });
      return commandReader.prepare("SELECT * FROM commands WHERE client_id=?").get(clientUserMessageId);
    } catch (error) {
      // These two states mean the provider has not published its schema yet.
      if (!/unable to open|no such table/.test(error.message)) throw error;
      return null;
    }
  };
  try {
    start();
    const command = await waitFor(async () => {
      const value = readCommand(); if (!value) return null;
      const state = await readRuntimeState(path.join(runtimeRoot, "data"));
      return state.activeRuns?.some((run) => run.turnId === value.turn_id) ? value : null;
    }, "recorded command and persisted active run");
    assert.equal(command.thread_id, threadId);
    assert.equal(JSON.parse(command.canonical_json).clientUserMessageId, clientUserMessageId);
    assert.equal(JSON.parse(command.canonical_json).streamId, f.target.streamId);
    const receiptFile = path.join(f.prepared.recording.root, "delivery-receipts", `${createHash("sha256").update(f.delivery.id).digest("hex")}.json`);
    const recordingDelivery = await waitFor(async () => {
      const receipt = await readFile(receiptFile, "utf8").catch(() => null);
      const pending = await readdir(path.join(runtimeRoot, "data", "delivery-outbox"));
      return receipt && !pending.some((name) => name.endsWith(".json")) ? receipt : null;
    }, "captured recording delivery and outbox ACK");
    const receipt = JSON.parse(recordingDelivery);
    assert.equal(receipt.deliveryId, f.delivery.id);
    assert.equal(receipt.idempotencyKey, f.delivery.id);
    assert.ok(receipt.firstAttemptId);
    assert.equal([...telegram.messages.values()].some((message) => message.text === f.delivery.body.text), false);

    await stop();
    const provider = new RecordingContourProvider({ root: f.prepared.recording.root, provider: "codex" });
    const answer = "Explicit literal terminal after owned Hub replacement";
    try { provider.finish({ threadId, turnId: command.turn_id, status: "completed", answer }); }
    finally { provider.close(); }
    start();
    const history = await waitFor(async () => {
      try {
        const result = await callDesktopControl("task-history", { provider: "codex", threadId, limit: 20 }, { runtimeRoot, timeoutMs: 600 });
        return result.items?.some((item) => item.messages?.some((message) => message.role === "agent" && message.text === answer)) ? result : null;
      } catch { return null; }
    }, "recovered terminal history");
    const exchange = history.items.find((item) => item.messages.some((message) => message.text === answer));
    assert.equal(exchange.id, command.turn_id);
    assert.equal(exchange.messages.filter((message) => message.role === "user" && message.clientUserMessageId === clientUserMessageId).length, 1);
    assert.equal(history.items.flatMap((item) => item.messages).filter((message) => message.text === answer).length, 1);
    await waitFor(async () => {
      const state = await readRuntimeState(path.join(runtimeRoot, "data"));
      return !state.activeRuns?.some((run) => run.turnId === command.turn_id);
    }, "terminal active run removal");
    assert.equal(readCommand().turn_id, command.turn_id);
    assert.equal(commandReader.prepare("SELECT count(*) AS count FROM commands").get().count, 1);
    await stop();
    const finalCommand = ledger(path.join(runtimeRoot, "data", "message-command-ledger.sqlite"));
    assert.equal(finalCommand.fingerprint, f.fingerprint);
    assert.equal(finalCommand.state, "completed");
    assert.equal(await readFile(receiptFile, "utf8"), recordingDelivery);
    const jobs = new PersistentBackgroundJobStore({ directoryPath: path.join(runtimeRoot, "data", "background-jobs") });
    await jobs.load();
    assert.deepEqual(jobs.values(), [f.background]);
    const retainedAudit = (await readRuntimeState(path.join(runtimeRoot, "data"))).codexTerminalAudit;
    assert.equal(retainedAudit.lastRun.status, "excluded");
    assert.equal(retainedAudit.lastRun.pendingTurns, 1);
    assert.equal(retainedAudit.pendingTurns[0][1].thread.path, f.sourceRollout);
    assert.equal(retainedAudit.historicalSubagentBackfill.queue[0].thread.path, f.sourceRollout);
    assert.equal(retainedAudit.historicalSubagentBackfill.pending, true);
    assert.equal(await readFile(f.sourceRollout, "utf8"), "owned rollout sentinel; never an executable recording input");


    for (const [name, expected] of f.before) assert.equal(await hash(path.join(f.captured.dataDirectory, name)), expected);
  } finally { await stop(); }
});
