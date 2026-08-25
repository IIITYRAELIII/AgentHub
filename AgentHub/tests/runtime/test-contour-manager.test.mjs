import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { canonicalPath } from "../../src/infrastructure/filesystem/config.mjs";
import { LoopbackTelegramApi } from "../../src/infrastructure/network/loopback-telegram-api.mjs";
import { WorkLogUsageSyncStore } from "../../src/infrastructure/persistence/work-log-usage-sync-store.mjs";
import { processIsAlive } from "../../src/infrastructure/process/process-liveness.mjs";
import {
  assertIsolatedTestContourRoot,
  cloneProductionDataToTestContour,
  defaultTestContourRoot,
  installTestContour,
  PLAYWRIGHT_CORE_VERSION,
  prepareTestContourCodexProviders,
  prepareTestContourCandidate,
  republishTestContourPointer,
  stopTestContour,
  TEST_CONTOUR_MODEL,
  TEST_CONTOUR_MODELS,
  TEST_CONTOUR_TERRA_MODEL,
  TEST_CONTOUR_FAKE_MODEL,
  TEST_CONTOUR_WEB_HOST,
  testContourComponentEnabled,
  testContourConfig,
  testContourEnvironment,
  testContourOperationLockTarget,
  testContourPaths,
  uninstallTestContour,
  withTestContourOperationLock,
} from "../../src/runtime/test-contour-manager.mjs";

test("Test Contour uses a sibling runtime instead of production or source", () => {
  assert.equal(TEST_CONTOUR_WEB_HOST, "localhost");
  assert.equal(
    defaultTestContourRoot({ environment: { LOCALAPPDATA: "C:/state" }, platform: "win32" }),
    path.resolve("C:/state", "AgentHub-TestContour"),
  );
  assert.throws(
    () => assertIsolatedTestContourRoot("C:/state/AgentHub/contour", {
      productionRoot: "C:/state/AgentHub",
      sourceRoot: "D:/source/AgentHub",
    }),
    /overlaps protected path/u,
  );
  assert.throws(
    () => assertIsolatedTestContourRoot("D:/source", {
      productionRoot: "C:/state/AgentHub",
      sourceRoot: "D:/source/AgentHub",
    }),
    /overlaps protected path/u,
  );
});

test("Test Contour serializes overlapping lifecycle operations", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-test-contour-lock-"));
  const entered = [];
  let releaseFirst;
  const firstCanFinish = new Promise((resolve) => { releaseFirst = resolve; });
  try {
    assert.equal(
      testContourOperationLockTarget(root),
      `${path.resolve(root)}-operation`,
    );
    const first = withTestContourOperationLock(root, async () => {
      entered.push("first");
      await firstCanFinish;
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    const second = withTestContourOperationLock(root, async () => {
      entered.push("second");
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.deepEqual(entered, ["first"]);
    releaseFirst();
    await Promise.all([first, second]);
    assert.deepEqual(entered, ["first", "second"]);
  } finally {
    releaseFirst?.();
    await rm(root, { recursive: true, force: true });
    await rm(`${root}-operation.lock`, { recursive: true, force: true });
  }
});

test("Test Contour republishes current.json only after the expected runtime is ready", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-test-contour-pointer-"));
  const currentFile = path.join(root, "current.json");
  try {
    await writeFile(currentFile, JSON.stringify({
      current: "candidate-2",
      previous: "candidate-1",
      updatedAt: "2026-08-21T00:00:00.000Z",
    }), "utf8");
    const published = await republishTestContourPointer({
      root,
      releaseId: "candidate-2",
      now: new Date("2026-08-21T12:00:00.000Z"),
    });
    assert.equal(published.current, "candidate-2");
    assert.equal(published.previous, "candidate-1");
    assert.equal(published.updatedAt, "2026-08-21T12:00:00.000Z");
    assert.deepEqual(JSON.parse(await readFile(currentFile, "utf8")), published);
    await assert.rejects(
      republishTestContourPointer({ root, releaseId: "candidate-1" }),
      /does not match current\.json/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Test Contour stops an orphan runtime from data bot.lock", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-test-contour-orphan-"));
  const paths = testContourPaths(root);
  const runtime = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
    windowsHide: true,
  });
  try {
    await mkdir(paths.dataDir, { recursive: true });
    await writeFile(paths.markerFile, JSON.stringify({
      kind: "agent-hub-test-contour",
      id: "test-contour-orphan",
    }), "utf8");
    await writeFile(path.join(paths.dataDir, "bot.lock"), JSON.stringify({
      pid: runtime.pid,
      releaseId: "candidate-orphan",
    }), "utf8");
    const result = await stopTestContour({ root });
    assert.equal(result.stopped, true);
    assert.equal(result.recoveredFromLock, true);
    assert.equal(processIsAlive(runtime.pid), false);
  } finally {
    if (processIsAlive(runtime.pid)) runtime.kill("SIGKILL");
    await rm(root, { recursive: true, force: true });
    await rm(`${root}-operation.lock`, { recursive: true, force: true });
  }
});

test("Test Contour installation is explicit, pinned and removable by owned marker", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-test-contour-install-"));
  const calls = [];
  try {
    const installed = await installTestContour({
      root,
      run: async (command, args, options) => calls.push({ command, args, options }),
    });
    const marker = JSON.parse(await readFile(installed.paths.markerFile, "utf8"));
    const automation = JSON.parse(await readFile(
      path.join(installed.paths.automationRoot, "package.json"),
      "utf8",
    ));
    assert.equal(marker.kind, "agent-hub-test-contour");
    assert.equal(automation.dependencies["playwright-core"], PLAYWRIGHT_CORE_VERSION);
    assert.equal(calls.length, 1);
    assert.ok(calls[0].args.includes("--ignore-scripts"));

    await uninstallTestContour({ root });
    await assert.rejects(readFile(installed.paths.markerFile, "utf8"), /ENOENT/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Test Contour exposes Spark, Terra and accept-all Fake Codex through one runtime", () => {
  const paths = testContourPaths(path.join(os.tmpdir(), "agent-hub-test-contour-config"));
  const config = testContourConfig({
    paths,
    telegramApiBaseUrl: "http://127.0.0.1:43210",
    realCodexExecutable: "codex-test",
  });
  assert.equal(config.codexModel, TEST_CONTOUR_MODEL);
  assert.deepEqual(config.codexModels, TEST_CONTOUR_MODELS);
  assert.ok(config.codexModels.some((item) => item.value === TEST_CONTOUR_TERRA_MODEL));
  assert.ok(config.codexModels.some((item) => item.value === TEST_CONTOUR_FAKE_MODEL));
  assert.equal(config.codexExecutable, process.execPath);
  assert.deepEqual(config.codexExecutableArgs, [
    paths.codexMultiplexerExecutable,
    "--real-executable",
    "codex-test",
    "--fake-executable",
    paths.fakeCodexExecutable,
    "--fake-state",
    paths.fakeCodexStateFile,
    "--routing-state",
    paths.codexMultiplexerStateFile,
  ]);
  assert.equal(config.codexSandboxMode, "workspace-write");
  assert.equal(config.projectRoot, paths.projectRoot);
  assert.equal(config.diagnostics.sentry.enabled, false);
  assert.equal(config.components.testContour, true);
  assert.equal(config.codexRateLimitPolling, false);
  assert.equal(config.claudeRateLimitPolling, false);
  assert.equal(config.createInitialThreadOnStartup, false);
  assert.throws(
    () => testContourConfig({ paths, telegramApiBaseUrl: "https://api.telegram.org" }),
    /must use 127\.0\.0\.1/u,
  );
  assert.throws(
    () => testContourConfig({
      paths,
      telegramApiBaseUrl: "http://127.0.0.1:43210",
      model: "unknown-model",
    }),
    /not available/u,
  );

  const environment = testContourEnvironment({
    paths,
    telegramApiBaseUrl: "http://127.0.0.1:43210",
    releaseId: "candidate-1",
    environment: {
      TELEGRAM_BOT_TOKEN: "production-token",
      TELEGRAM_API_BASE_URL: "https://api.telegram.org",
      SENTRY_DSN: "production-dsn",
      CODEX_EXECUTABLE: "fake-codex",
      AGENT_HUB_RELEASE_ID: "production-release",
      PATH: "safe-path",
    },
  });
  assert.equal(environment.TELEGRAM_BOT_TOKEN, undefined);
  assert.equal(environment.TELEGRAM_API_BASE_URL, "http://127.0.0.1:43210");
  assert.equal(environment.SENTRY_DSN, "");
  assert.equal(environment.CODEX_EXECUTABLE, undefined);
  assert.equal(environment.CODEX_MODEL, TEST_CONTOUR_MODEL);
  assert.equal(environment.CODEX_HOME, paths.codexHome);
  assert.equal(environment.AGENT_HUB_RELEASE_ID, "candidate-1");
  assert.equal(environment.PATH, "safe-path");
});

test("Codex test providers are copied only into the marker-owned Test Contour root", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-test-contour-fake-"));
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "agent-hub-test-contour-fake-source-"));
  try {
    await mkdir(path.join(sourceRoot, "e2e"), { recursive: true });
    await writeFile(path.join(sourceRoot, "e2e", "fake-codex-app-server.mjs"), "export const fake = true;\n", "utf8");
    await writeFile(
      path.join(sourceRoot, "e2e", "test-contour-codex-multiplexer.mjs"),
      "export const multiplexer = true;\n",
      "utf8",
    );
    await installTestContour({ root, run: async () => null });
    const copied = await prepareTestContourCodexProviders({ root, sourceRoot });
    assert.equal(copied.fakeCodexExecutable, testContourPaths(root).fakeCodexExecutable);
    assert.equal(copied.codexMultiplexerExecutable, testContourPaths(root).codexMultiplexerExecutable);
    assert.equal(await readFile(copied.fakeCodexExecutable, "utf8"), "export const fake = true;\n");
    assert.equal(
      await readFile(copied.codexMultiplexerExecutable, "utf8"),
      "export const multiplexer = true;\n",
    );
  } finally {
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(sourceRoot, { recursive: true, force: true }),
    ]);
  }
});

test("production data clone keeps history but detaches live threads and forces Spark", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-test-contour-clone-"));
  const productionRoot = await mkdtemp(path.join(os.tmpdir(), "agent-hub-production-clone-"));
  try {
    const { paths: contourPaths } = await installTestContour({ root, run: async () => null });
    const productionData = path.join(productionRoot, "data");
    await mkdir(productionData, { recursive: true });
    const productionAttachments = path.join(productionRoot, "attachments");
    await mkdir(productionAttachments, { recursive: true });
    await writeFile(path.join(productionAttachments, "history-image.png"), "production image", "utf8");
    const sourceFile = path.join(productionData, "journal.sqlite");
    const source = new DatabaseSync(sourceFile);
    source.exec(`
      CREATE TABLE hub_workspaces (id TEXT PRIMARY KEY) WITHOUT ROWID;
      CREATE TABLE hub_streams (
        id TEXT PRIMARY KEY, settings_json TEXT NOT NULL, updated_at_ms INTEGER NOT NULL
      ) WITHOUT ROWID;
      CREATE TABLE hub_threads (
        provider TEXT, provider_thread_id TEXT, stream_id TEXT, position INTEGER,
        project_root TEXT, source TEXT, linked_at_ms INTEGER, updated_at_ms INTEGER
      );
      CREATE TABLE task_read_model_tasks (
        project_root TEXT, session_cwd TEXT, running INTEGER,
        execution_owner TEXT, turn_id TEXT
      );
      CREATE TABLE task_read_model_turns (active INTEGER);
      CREATE TABLE hub_release_changes (project_root TEXT);
      CREATE TABLE hub_mcp_operations (
        status TEXT, error_text TEXT, completed_at_ms INTEGER
      );
      CREATE TABLE journal_store_meta (key TEXT PRIMARY KEY, value TEXT) WITHOUT ROWID;
      CREATE TABLE journal_records (
        provider TEXT, thread_id TEXT, turn_id TEXT, project_root TEXT,
        task_thread_id TEXT, completed_at_ms INTEGER, record_json TEXT,
        PRIMARY KEY (provider, thread_id, turn_id)
      );
      INSERT INTO hub_workspaces VALUES ('workspace-1');
      INSERT INTO hub_streams VALUES (
        'stream-1', '{"provider":"claude","model":"claude-opus","custom":true}', 1
      );
      INSERT INTO hub_threads VALUES (
        'codex', 'production-thread', 'stream-1', 1,
        'D:/production', 'created', 1, 1
      );
      INSERT INTO task_read_model_tasks VALUES (
        'D:/production', 'D:/production', 1, 'owner', 'turn-1'
      );
      INSERT INTO task_read_model_turns VALUES (1);
      INSERT INTO hub_release_changes VALUES ('D:/production');
      INSERT INTO hub_mcp_operations VALUES ('pending', '', NULL);
      INSERT INTO journal_store_meta VALUES ('revision', '5');
      INSERT INTO journal_records VALUES (
        'codex', 'production-thread', 'turn-1', 'D:/production',
        'production-thread', 1,
        '{"provider":"codex","threadId":"production-thread","turnId":"turn-1","projectRoot":"D:/production"}'
      );
    `);
    source.close();
    await mkdir(contourPaths.dataDir, { recursive: true });
    const productionDeviceId = "11111111-1111-4111-8111-111111111111";
    const contourDeviceId = "22222222-2222-4222-8222-222222222222";
    const identity = (deviceId) => ({
      version: 1,
      deviceId,
      label: "Device",
      platform: "win32",
      publicKey: "cHVibGlj",
      privateKey: "cHJpdmF0ZQ",
      createdAt: "2026-08-21T00:00:00.000Z",
      updatedAt: "2026-08-21T00:00:00.000Z",
      legacyDeviceIds: [],
    });
    await writeFile(
      path.join(productionData, "usage-sync-identity.json"),
      `${JSON.stringify(identity(productionDeviceId), null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      path.join(contourPaths.dataDir, "usage-sync-identity.json"),
      `${JSON.stringify(identity(contourDeviceId), null, 2)}\n`,
      "utf8",
    );
    const usageSyncStore = new WorkLogUsageSyncStore({
      databaseFile: sourceFile,
      deviceId: productionDeviceId,
    });
    await usageSyncStore.importSnapshot({
      events: [{
        deviceId: productionDeviceId,
        provider: "codex",
        threadId: "production-thread",
        turnId: "turn-1",
        completedAt: "2026-08-21T09:00:00.000Z",
        accountKey: "chatgpt:local",
        accountAttribution: "exact",
        usageReported: true,
        usage: { inputTokens: 1_000 },
      }],
    });
    await usageSyncStore.close();
    await Promise.all(["", "-wal", "-shm"].map((suffix) => (
      writeFile(path.join(contourPaths.dataDir, `runtime.sqlite${suffix}`), "stale", "utf8")
    )));
    await mkdir(contourPaths.codexHome, { recursive: true });
    await writeFile(path.join(contourPaths.codexHome, "state_5.sqlite"), "stale", "utf8");
    const contourAttachments = path.join(root, "attachments");
    await mkdir(contourAttachments, { recursive: true });
    await writeFile(path.join(contourAttachments, "stale.png"), "stale image", "utf8");

    const result = await cloneProductionDataToTestContour({
      root,
      productionRoot,
      now: new Date("2026-08-21T10:00:00.000Z"),
    });
    const clone = new DatabaseSync(result.destinationDatabaseFile, { readOnly: true });
    try {
      const settings = JSON.parse(clone.prepare(
        "SELECT settings_json FROM hub_streams WHERE id = 'stream-1'",
      ).get().settings_json);
      assert.equal(settings.provider, "codex");
      assert.equal(settings.model, TEST_CONTOUR_MODEL);
      assert.equal(settings.project, contourPaths.projectRoot);
      assert.equal(settings.custom, true);
      assert.equal(clone.prepare("SELECT updated_at_ms FROM hub_streams").get().updated_at_ms, 1);
      assert.deepEqual({ ...clone.prepare(`
        SELECT project_root, detached_at_ms FROM hub_threads
      `).get() }, {
        project_root: contourPaths.projectRoot,
        detached_at_ms: Date.parse("2026-08-21T10:00:00.000Z"),
      });
      assert.deepEqual({ ...clone.prepare(`
        SELECT project_root, session_cwd, running, execution_owner, turn_id
        FROM task_read_model_tasks
      `).get() }, {
        project_root: contourPaths.projectRoot,
        session_cwd: contourPaths.projectRoot,
        running: 0,
        execution_owner: null,
        turn_id: null,
      });
      assert.equal(clone.prepare("SELECT active FROM task_read_model_turns").get().active, 0);
      assert.equal(
        clone.prepare("SELECT project_root FROM hub_release_changes").get().project_root,
        contourPaths.projectRoot,
      );
      assert.equal(clone.prepare("SELECT status FROM hub_mcp_operations").get().status, "failed");
      assert.equal(clone.prepare("SELECT value FROM journal_store_meta WHERE key = 'revision'").get().value, "6");
      assert.equal(
        clone.prepare("SELECT value FROM journal_store_meta WHERE key = 'test_contour_clone_at_ms'").get().value,
        String(Date.parse("2026-08-21T10:00:00.000Z")),
      );
      const journalRecord = clone.prepare(`
        SELECT project_root, record_json FROM journal_records
      `).get();
      assert.equal(journalRecord.project_root, contourPaths.projectRoot);
      assert.equal(JSON.parse(journalRecord.record_json).projectRoot, contourPaths.projectRoot);
      assert.equal(result.detachedThreads, 1);
      assert.equal(result.preservedCatalogTasks, 1);
      assert.equal(result.remappedJournalRecords, 1);
      assert.equal(result.journalRecords, 1);
      assert.equal(result.remappedUsageSyncEvents, 1);
      assert.equal(
        clone.prepare("SELECT device_id FROM usage_sync_events").get().device_id,
        contourDeviceId,
      );
      assert.equal(result.attachmentsCloned, true);
      assert.equal(result.runtimeStateReset, true);
      assert.equal(result.codexStateReset, true);
      await Promise.all(["", "-wal", "-shm"].map(async (suffix) => {
        await assert.rejects(
          readFile(path.join(contourPaths.dataDir, `runtime.sqlite${suffix}`)),
          { code: "ENOENT" },
        );
      }));
      await assert.rejects(readFile(path.join(contourPaths.codexHome, "state_5.sqlite")), { code: "ENOENT" });
      assert.equal(
        await readFile(path.join(contourAttachments, "history-image.png"), "utf8"),
        "production image",
      );
      await assert.rejects(readFile(path.join(contourAttachments, "stale.png")), { code: "ENOENT" });
    } finally {
      clone.close();
    }
  } finally {
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(productionRoot, { recursive: true, force: true }),
    ]);
  }
});

test("Test Contour component is default-off and read from production config", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-test-contour-component-"));
  const file = path.join(root, "config.json");
  try {
    assert.equal(await testContourComponentEnabled({ productionConfigFile: file }), false);
    await writeFile(file, JSON.stringify({ components: { testContour: true } }), "utf8");
    assert.equal(await testContourComponentEnabled({ productionConfigFile: file }), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("candidate preparation deploys only into the isolated runtime root", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-test-contour-deploy-"));
  const sourceRoot = path.join(os.tmpdir(), "agent-hub-test-contour-source");
  const calls = [];
  try {
    const result = await prepareTestContourCandidate({
      root,
      sourceRoot,
      deploy: async (options) => {
        calls.push(options);
        const releaseRoot = path.join(root, "releases", "candidate-1");
        const webAppRoot = path.join(releaseRoot, "assets", "web-app");
        await mkdir(webAppRoot, { recursive: true });
        await writeFile(
          path.join(webAppRoot, "index.html"),
          '<html lang="ru"><head><link rel="stylesheet" href="/test-contour-watermark.css"></head><body></body></html>',
          "utf8",
        );
        await options.beforePointerCommit({ releaseRoot });
        assert.match(
          await readFile(path.join(webAppRoot, "index.html"), "utf8"),
          /<div class="test-contour-watermark" aria-hidden="true">ТЕСТ<\/div>/u,
        );
        return { releaseId: "candidate-1", releaseRoot };
      },
    });
    assert.equal(result.releaseId, "candidate-1");
    assert.equal(calls[0].runtimeRoot, canonicalPath(root));
    assert.equal(calls[0].sourceRoot, sourceRoot);
    assert.match(
      await readFile(path.join(result.releaseRoot, "assets", "web-app", "index.html"), "utf8"),
      /<html data-test-contour="" lang="ru">/u,
    );
    assert.match(
      await readFile(path.join(result.releaseRoot, "assets", "web-app", "index.html"), "utf8"),
      /<div class="test-contour-watermark" aria-hidden="true">ТЕСТ<\/div>/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("loopback Telegram adapter captures all synthetic traffic locally", async () => {
  const telegram = new LoopbackTelegramApi();
  try {
    await telegram.start();
    const response = await fetch(`${telegram.baseUrl}/bot123:test/getUpdates`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ offset: 0 }),
    });
    assert.equal(response.ok, true);
    assert.deepEqual(await response.json(), { ok: true, result: [] });
    assert.equal(new URL(telegram.baseUrl).hostname, "127.0.0.1");
    assert.equal(telegram.calls.at(-1).method, "getUpdates");
  } finally {
    await telegram.stop();
  }
});
