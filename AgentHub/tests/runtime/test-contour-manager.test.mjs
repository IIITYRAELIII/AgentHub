import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { LoopbackTelegramApi } from "../../src/infrastructure/network/loopback-telegram-api.mjs";
import {
  assertIsolatedTestContourRoot,
  defaultTestContourRoot,
  installTestContour,
  PLAYWRIGHT_CORE_VERSION,
  prepareTestContourCandidate,
  TEST_CONTOUR_MODEL,
  TEST_CONTOUR_WEB_HOST,
  testContourComponentEnabled,
  testContourConfig,
  testContourEnvironment,
  testContourPaths,
  uninstallTestContour,
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

test("Test Contour config is loopback-only, Spark-backed and environment-isolated", () => {
  const paths = testContourPaths(path.join(os.tmpdir(), "agent-hub-test-contour-config"));
  const config = testContourConfig({
    paths,
    telegramApiBaseUrl: "http://127.0.0.1:43210",
  });
  assert.equal(config.codexModel, TEST_CONTOUR_MODEL);
  assert.equal(config.codexSandboxMode, "workspace-write");
  assert.equal(config.projectRoot, paths.projectRoot);
  assert.equal(config.diagnostics.sentry.enabled, false);
  assert.equal(config.components.testContour, true);
  assert.throws(
    () => testContourConfig({ paths, telegramApiBaseUrl: "https://api.telegram.org" }),
    /must use 127\.0\.0\.1/u,
  );

  const environment = testContourEnvironment({
    paths,
    telegramApiBaseUrl: "http://127.0.0.1:43210",
    environment: {
      TELEGRAM_BOT_TOKEN: "production-token",
      TELEGRAM_API_BASE_URL: "https://api.telegram.org",
      SENTRY_DSN: "production-dsn",
      CODEX_EXECUTABLE: "fake-codex",
      PATH: "safe-path",
    },
  });
  assert.equal(environment.TELEGRAM_BOT_TOKEN, undefined);
  assert.equal(environment.TELEGRAM_API_BASE_URL, "http://127.0.0.1:43210");
  assert.equal(environment.SENTRY_DSN, "");
  assert.equal(environment.CODEX_EXECUTABLE, undefined);
  assert.equal(environment.CODEX_MODEL, TEST_CONTOUR_MODEL);
  assert.equal(environment.PATH, "safe-path");
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
        return { releaseId: "candidate-1", releaseRoot: path.join(root, "releases", "candidate-1") };
      },
    });
    assert.equal(result.releaseId, "candidate-1");
    assert.equal(calls[0].runtimeRoot, path.resolve(root));
    assert.equal(calls[0].sourceRoot, sourceRoot);
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
