import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  AGENT_HUB_ROOT,
  canonicalizeProjectRoots,
  findContainingProject,
  httpBaseUrl,
  loadConfig,
  miniAppSettings,
  pathInsideOrSame,
  repositoryWriteGuardEnabled,
  resolveConfigPath,
  samePath,
} from "../../../src/infrastructure/filesystem/config.mjs";

test("Agent Hub root remains independent from the config module location", () => {
  assert.equal(AGENT_HUB_ROOT, path.resolve(import.meta.dirname, "..", "..", ".."));
});

test("Codex executable update policy validates disable and exact version pin", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-codex-update-config-"));
  const configFile = path.join(root, "config.json");
  const previous = Object.fromEntries([
    "AGENT_HUB_CONFIG",
    "CODEX_EXECUTABLE_AUTO_UPDATE",
    "CODEX_EXECUTABLE_VERSION_PIN",
  ].map((key) => [key, process.env[key]]));
  try {
    await writeFile(configFile, JSON.stringify({
      components: { telegram: false, miniApp: false, androidApp: false },
      projectRoot: root,
      codexExecutableAutoUpdate: false,
      codexExecutableVersionPin: "0.152.1",
    }), "utf8");
    process.env.AGENT_HUB_CONFIG = configFile;
    delete process.env.CODEX_EXECUTABLE_AUTO_UPDATE;
    delete process.env.CODEX_EXECUTABLE_VERSION_PIN;
    const config = await loadConfig();
    assert.equal(config.codexExecutableAutoUpdate, false);
    assert.equal(config.codexExecutableVersionPin, "0.152.1");

    process.env.CODEX_EXECUTABLE_AUTO_UPDATE = "true";
    process.env.CODEX_EXECUTABLE_VERSION_PIN = "0.151.0-alpha.7.2";
    const overridden = await loadConfig();
    assert.equal(overridden.codexExecutableAutoUpdate, true);
    assert.equal(overridden.codexExecutableVersionPin, "0.151.0-alpha.7.2");

    process.env.CODEX_EXECUTABLE_VERSION_PIN = "latest";
    await assert.rejects(loadConfig(), /codexExecutableVersionPin/u);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("core-only components need neither Telegram credentials nor Web App", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-journal-profile-"));
  const configFile = path.join(root, "config.json");
  const previous = process.env.AGENT_HUB_CONFIG;
  const previousSentryDsn = process.env.SENTRY_DSN;
  const previousSentryEnvironment = process.env.SENTRY_ENVIRONMENT;
  const previousSentryRelease = process.env.SENTRY_RELEASE;
  try {
    await writeFile(configFile, JSON.stringify({
      components: { telegram: false, miniApp: false, androidApp: false },
      projectRoot: root,
      miniApp: { enabled: true },
      codexRateLimitPolling: false,
      claudeRateLimitPolling: false,
    }), "utf8");
    process.env.AGENT_HUB_CONFIG = configFile;
    delete process.env.SENTRY_DSN;
    delete process.env.SENTRY_ENVIRONMENT;
    delete process.env.SENTRY_RELEASE;
    const config = await loadConfig();
    assert.deepEqual(config.components, {
      telegram: false, miniApp: false, androidApp: false, sharedDashboardBot: false, codexContextCleanup: false, testContour: false,
    });
    assert.equal(config.telegramEnabled, false);
    assert.equal(config.allowedUserIds.size, 0);
    assert.equal(config.allowedChatIds.size, 0);
    assert.equal(config.miniApp.enabled, false);
    assert.equal(config.codexRateLimitPolling, false);
    assert.equal(config.claudeRateLimitPolling, false);
    assert.deepEqual(config.codexRolloutContext, {
      enabled: false,
      keepRecentImages: 4,
      minReclaimBytes: 1024 * 1024,
      scanIntervalSeconds: 30 * 60,
      maxFilesPerPass: 8,
    });
    assert.equal(config.codexSandboxMode, "workspace-write");
    assert.deepEqual(config.codexModels.slice(0, 3), [
      { value: "gpt-5.6-terra", label: "GPT-5.6-Terra" },
      { value: "gpt-6-astra", label: "GPT-6 Astra" },
      { value: "gpt-6.1-sol", label: "GPT-6.1 Sol" },
    ]);
    assert.equal(config.whisperModel, "large-v3-turbo");
    assert.equal(config.whisperDevice, "cuda");
    assert.deepEqual(config.contextAutomation, {
      autoCompactAfterTurn: false,
      autoCompactThresholdPercent: 75,
      autoRotateAfterCompaction: false,
      autoRotateThresholdPercent: 20,
    });
    assert.deepEqual(config.taskBoard, {
      triageEnabled: true,
      triageModel: "gpt-5.3-codex-spark",
      autoPlaceConfidence: 0.82,
      bugReportWorkspaceName: "",
    });
    assert.deepEqual(config.releaseValidation, { repositories: [] });
    assert.deepEqual(config.diagnostics.sentry, {
      enabled: false,
      dsn: "",
      environment: "production",
      release: "",
      sampleRate: 1,
      maxEventsPerMinute: 30,
      roots: [root],
    });
  } finally {
    if (previous == null) delete process.env.AGENT_HUB_CONFIG;
    else process.env.AGENT_HUB_CONFIG = previous;
    if (previousSentryDsn == null) delete process.env.SENTRY_DSN;
    else process.env.SENTRY_DSN = previousSentryDsn;
    if (previousSentryEnvironment == null) delete process.env.SENTRY_ENVIRONMENT;
    else process.env.SENTRY_ENVIRONMENT = previousSentryEnvironment;
    if (previousSentryRelease == null) delete process.env.SENTRY_RELEASE;
    else process.env.SENTRY_RELEASE = previousSentryRelease;
    await rm(root, { recursive: true, force: true });
  }
});

test("release validation policy is explicit and disabled by default", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-release-validation-config-"));
  const configFile = path.join(root, "config.json");
  const previous = process.env.AGENT_HUB_CONFIG;
  try {
    await writeFile(configFile, JSON.stringify({
      components: { telegram: false, miniApp: false, androidApp: false },
      projectRoot: root,
      releaseValidation: {
        repositories: [{
          projectRoot: "Bookworm",
          check: {
            kind: "bookworm-android-qa",
            id: "bookworm-frozen-candidate",
            commands: [{ command: ".\\gradlew.bat", args: ["qualityCheck"] }],
            artifacts: ["app/build/report.xml"],
          },
        }],
      },
    }), "utf8");
    process.env.AGENT_HUB_CONFIG = configFile;
    const disabled = await loadConfig();
    assert.equal(disabled.releaseValidation.repositories[0].enabled, false);
    assert.equal(disabled.releaseValidation.repositories[0].projectRoot, path.join(root, "Bookworm"));

    await writeFile(configFile, JSON.stringify({
      components: { telegram: false, miniApp: false, androidApp: false },
      projectRoot: root,
      releaseValidation: {
        repositories: [{
          enabled: true,
          projectRoot: "Bookworm",
          check: {
            kind: "bookworm-android-qa",
            id: "bookworm-frozen-candidate",
            commands: [{ command: ".\\gradlew.bat", args: ["qualityCheck"] }],
          },
        }],
      },
    }), "utf8");
    const enabled = await loadConfig();
    assert.equal(enabled.releaseValidation.repositories[0].enabled, true);
    assert.equal(enabled.releaseValidation.repositories[0].check.commands[0].args[0], "qualityCheck");
  } finally {
    if (previous == null) delete process.env.AGENT_HUB_CONFIG;
    else process.env.AGENT_HUB_CONFIG = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("shipped Codex defaults include Astra while explicit catalogs survive until refresh", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-codex-model-catalog-"));
  const configFile = path.join(root, "config.json");
  const previous = process.env.AGENT_HUB_CONFIG;
  const legacyShippedModels = [
    { value: "gpt-5.5", label: "GPT-5.5" },
    { value: "gpt-5.6-sol", label: "GPT-5.6-Sol" },
    { value: "gpt-5.6-terra", label: "GPT-5.6-Terra" },
    { value: "gpt-5.6-luna", label: "GPT-5.6-Luna" },
    { value: "gpt-5.4", label: "GPT-5.4" },
    { value: "gpt-5.4-mini", label: "GPT-5.4-Mini" },
    { value: "gpt-5.3-codex-spark", label: "GPT-5.3-Codex-Spark" },
  ];
  const astraModel = { value: "gpt-6-astra", label: "GPT-6 Astra" };
  try {
    process.env.AGENT_HUB_CONFIG = configFile;
    const baseConfig = {
      components: { telegram: false, miniApp: false, androidApp: false },
      projectRoot: root,
    };
    await writeFile(configFile, JSON.stringify({
      ...baseConfig,
      codexModels: legacyShippedModels,
    }), "utf8");
    const shippedModels = [
      legacyShippedModels[2],
      astraModel,
      { value: "gpt-6.1-sol", label: "GPT-6.1 Sol" },
      { value: "gpt-6-sol", label: "GPT-6 Sol" },
      { value: "gpt-6-luna", label: "GPT-6 Luna" },
      legacyShippedModels[1], legacyShippedModels[3], legacyShippedModels[6],
    ];
    assert.deepEqual((await loadConfig()).codexModels, legacyShippedModels);

    await writeFile(configFile, JSON.stringify({
      ...baseConfig,
      codexModels: shippedModels.filter(({ value }) => value !== "gpt-6.1-sol"),
    }), "utf8");
    assert.deepEqual((await loadConfig()).codexModels,
      shippedModels.filter(({ value }) => value !== "gpt-6.1-sol"));

    const customModels = legacyShippedModels.map((model, index) => (
      index === 0 ? { ...model, label: "Team Default" } : model
    ));
    await writeFile(configFile, JSON.stringify({ ...baseConfig, codexModels: customModels }), "utf8");
    assert.deepEqual((await loadConfig()).codexModels, customModels);

    const example = JSON.parse(await readFile(
      new URL("../../../config.example.json", import.meta.url),
      "utf8",
    ));
    assert.deepEqual(example.codexModels, shippedModels);
  } finally {
    if (previous == null) delete process.env.AGENT_HUB_CONFIG;
    else process.env.AGENT_HUB_CONFIG = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("Task board validates Spark triage settings", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-task-board-"));
  const configFile = path.join(root, "config.json");
  const previous = process.env.AGENT_HUB_CONFIG;
  try {
    process.env.AGENT_HUB_CONFIG = configFile;
    await writeFile(configFile, JSON.stringify({
      components: { telegram: false, miniApp: false, androidApp: false },
      projectRoot: root,
      taskBoard: {
        triageEnabled: false,
        triageModel: "gpt-5.3-codex-spark",
        autoPlaceConfidence: 0.9,
        bugReportWorkspaceName: "  Agent   HUB  ",
      },
    }), "utf8");
    assert.deepEqual((await loadConfig()).taskBoard, {
      triageEnabled: false,
      triageModel: "gpt-5.3-codex-spark",
      autoPlaceConfidence: 0.9,
      bugReportWorkspaceName: "Agent HUB",
    });
    await writeFile(configFile, JSON.stringify({
      components: { telegram: false, miniApp: false, androidApp: false },
      projectRoot: root,
      taskBoard: { autoPlaceConfidence: 2 },
    }), "utf8");
    await assert.rejects(loadConfig(), /taskBoard\.autoPlaceConfidence/u);
  } finally {
    if (previous == null) delete process.env.AGENT_HUB_CONFIG;
    else process.env.AGENT_HUB_CONFIG = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("context automation validates and loads post-turn thresholds", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-context-automation-"));
  const configFile = path.join(root, "config.json");
  const previous = process.env.AGENT_HUB_CONFIG;
  try {
    process.env.AGENT_HUB_CONFIG = configFile;
    await writeFile(configFile, JSON.stringify({
      components: { telegram: false, miniApp: false, androidApp: false },
      projectRoot: root,
      contextAutomation: {
        autoCompactAfterTurn: true,
        autoCompactThresholdPercent: 76,
        autoRotateAfterCompaction: true,
        autoRotateThresholdPercent: 21,
      },
    }), "utf8");
    assert.deepEqual((await loadConfig()).contextAutomation, {
      autoCompactAfterTurn: true,
      autoCompactThresholdPercent: 76,
      autoRotateAfterCompaction: true,
      autoRotateThresholdPercent: 21,
    });
    await writeFile(configFile, JSON.stringify({
      components: { telegram: false, miniApp: false, androidApp: false },
      projectRoot: root,
      contextAutomation: { autoCompactThresholdPercent: 101 },
    }), "utf8");
    await assert.rejects(loadConfig(), /contextAutomation\.autoCompactThresholdPercent/u);
  } finally {
    if (previous == null) delete process.env.AGENT_HUB_CONFIG;
    else process.env.AGENT_HUB_CONFIG = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("Codex sandbox mode is configurable but only accepts App Server policies", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-codex-sandbox-"));
  const configFile = path.join(root, "config.json");
  const previous = process.env.AGENT_HUB_CONFIG;
  try {
    process.env.AGENT_HUB_CONFIG = configFile;
    await writeFile(configFile, JSON.stringify({
      components: { telegram: false, miniApp: false, androidApp: false },
      projectRoot: root,
      codexSandboxMode: "danger-full-access",
    }), "utf8");
    assert.equal((await loadConfig()).codexSandboxMode, "danger-full-access");
    assert.equal((await loadConfig()).codexRateLimitPolling, true);
    assert.equal((await loadConfig()).claudeRateLimitPolling, true);
    await writeFile(configFile, JSON.stringify({
      components: { telegram: false, miniApp: false, androidApp: false },
      projectRoot: root,
      codexSandboxMode: "unelevated",
    }), "utf8");
    await assert.rejects(loadConfig(), /codexSandboxMode/u);
  } finally {
    if (previous == null) delete process.env.AGENT_HUB_CONFIG;
    else process.env.AGENT_HUB_CONFIG = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("rollout image cleanup stays disabled while keeping its configured interval", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-rollout-cleanup-"));
  const configFile = path.join(root, "config.json");
  const previous = process.env.AGENT_HUB_CONFIG;
  try {
    await writeFile(configFile, JSON.stringify({
      components: { telegram: false, miniApp: false, androidApp: false },
      projectRoot: root,
      codexRolloutContext: {
        enabled: true,
        scanIntervalSeconds: 1200,
      },
    }), "utf8");
    process.env.AGENT_HUB_CONFIG = configFile;
    const config = await loadConfig();
    assert.equal(config.codexRolloutContext.enabled, false);
    assert.equal(config.components.codexContextCleanup, false);
    assert.equal(config.codexRolloutContext.scanIntervalSeconds, 1200);
  } finally {
    if (previous == null) delete process.env.AGENT_HUB_CONFIG;
    else process.env.AGENT_HUB_CONFIG = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("Codex context cleanup ignores a stale enabled component value", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-rollout-component-"));
  const configFile = path.join(root, "config.json");
  const previous = process.env.AGENT_HUB_CONFIG;
  try {
    await writeFile(configFile, JSON.stringify({
      components: {
        telegram: false,
        miniApp: false,
        androidApp: false,
        codexContextCleanup: true,
      },
      projectRoot: root,
    }), "utf8");
    process.env.AGENT_HUB_CONFIG = configFile;
    const config = await loadConfig();
    assert.equal(config.components.codexContextCleanup, false);
    assert.equal(config.codexRolloutContext.enabled, false);
    assert.equal(config.codexRolloutContext.scanIntervalSeconds, 30 * 60);
  } finally {
    if (previous == null) delete process.env.AGENT_HUB_CONFIG;
    else process.env.AGENT_HUB_CONFIG = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("Telegram and Android App components can be enabled independently", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-telegram-profiles-"));
  const configFile = path.join(root, "config.json");
  const previous = process.env.AGENT_HUB_CONFIG;
  try {
    const base = {
      telegramBotToken: "123456:profile_test_token",
      allowedUserIds: [123],
      projectRoot: root,
      miniApp: { enabled: true },
    };
    process.env.AGENT_HUB_CONFIG = configFile;
    await writeFile(configFile, JSON.stringify({
      ...base,
      components: { telegram: true, miniApp: false, androidApp: false },
    }), "utf8");
    const telegram = await loadConfig();
    assert.deepEqual(telegram.components, {
      telegram: true, miniApp: false, androidApp: false, sharedDashboardBot: false, codexContextCleanup: false, testContour: false,
    });
    assert.equal(telegram.telegramEnabled, true);
    assert.equal(telegram.miniApp.enabled, false);

    await writeFile(configFile, JSON.stringify({
      ...base,
      components: { telegram: false, miniApp: false, androidApp: true },
    }), "utf8");
    const web = await loadConfig();
    assert.deepEqual(web.components, {
      telegram: false, miniApp: false, androidApp: true, sharedDashboardBot: false, codexContextCleanup: false, testContour: false,
    });
    assert.equal(web.telegramEnabled, false);
    assert.equal(web.miniApp.enabled, true);
  } finally {
    if (previous == null) delete process.env.AGENT_HUB_CONFIG;
    else process.env.AGENT_HUB_CONFIG = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy profiles migrate to equivalent components", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-legacy-profile-"));
  const configFile = path.join(root, "config.json");
  const previous = process.env.AGENT_HUB_CONFIG;
  try {
    process.env.AGENT_HUB_CONFIG = configFile;
    await writeFile(configFile, JSON.stringify({
      profile: "telegram",
      telegramBotToken: "123456:profile_test_token",
      allowedUserIds: [123],
      projectRoot: root,
      miniApp: { enabled: true },
    }), "utf8");
    const config = await loadConfig();
    assert.deepEqual(config.components, {
      telegram: true, miniApp: false, androidApp: false, sharedDashboardBot: false, codexContextCleanup: false, testContour: false,
    });
    assert.equal(config.miniApp.enabled, false);
  } finally {
    if (previous == null) delete process.env.AGENT_HUB_CONFIG;
    else process.env.AGENT_HUB_CONFIG = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("shared Dashboard bot is independent from personal Telegram and resolves its secret file", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-shared-dashboard-bot-"));
  const configFile = path.join(root, "config.json");
  const previous = process.env.AGENT_HUB_CONFIG;
  try {
    process.env.AGENT_HUB_CONFIG = configFile;
    await writeFile(configFile, JSON.stringify({
      components: {
        telegram: false,
        miniApp: false,
        androidApp: false,
        sharedDashboardBot: true,
      },
      projectRoot: root,
      sharedDashboardBot: {
        publicUrl: "https://hub.example.com",
        hubId: "018f6c86-3f34-7a31-8f27-16f5b96cce70",
        hubName: "Командный Hub",
        secretFile: "shared-dashboard-bot.secret",
        retrySeconds: 7,
      },
    }), "utf8");
    const config = await loadConfig();
    assert.equal(config.telegramEnabled, false);
    assert.deepEqual(config.sharedDashboardBot, {
      enabled: true,
      publicUrl: "https://hub.example.com",
      hubId: "018f6c86-3f34-7a31-8f27-16f5b96cce70",
      hubName: "Командный Hub",
      secretFile: path.join(root, "shared-dashboard-bot.secret"),
      retrySeconds: 7,
    });

    await writeFile(configFile, JSON.stringify({
      components: { sharedDashboardBot: true },
      projectRoot: root,
      sharedDashboardBot: {
        publicUrl: "http://hub.example.com",
        hubId: "018f6c86-3f34-7a31-8f27-16f5b96cce70",
        secretFile: "shared-dashboard-bot.secret",
      },
    }), "utf8");
    await assert.rejects(loadConfig(), /must use HTTPS/u);
  } finally {
    if (previous == null) delete process.env.AGENT_HUB_CONFIG;
    else process.env.AGENT_HUB_CONFIG = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("Mini App component requires Telegram", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-mini-app-dependency-"));
  const configFile = path.join(root, "config.json");
  const previous = process.env.AGENT_HUB_CONFIG;
  try {
    process.env.AGENT_HUB_CONFIG = configFile;
    await writeFile(configFile, JSON.stringify({
      components: { telegram: false, miniApp: true, androidApp: false },
      projectRoot: root,
    }), "utf8");
    await assert.rejects(loadConfig(), /requires telegram component/u);
  } finally {
    if (previous == null) delete process.env.AGENT_HUB_CONFIG;
    else process.env.AGENT_HUB_CONFIG = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("concurrent repository write guard is opt-in", () => {
  assert.equal(repositoryWriteGuardEnabled(), false);
  assert.equal(repositoryWriteGuardEnabled({}), false);
  assert.equal(repositoryWriteGuardEnabled({ guardConcurrentRepositoryWrites: false }), false);
  assert.equal(repositoryWriteGuardEnabled({ guardConcurrentRepositoryWrites: true }), true);
  assert.equal(repositoryWriteGuardEnabled({ guardConcurrentRepositoryWrites: "true" }), false);
});


test("pathInsideOrSame accepts the project itself and nested caller directories", () => {
  assert.equal(pathInsideOrSame("C:\\Workspace", "C:\\Workspace"), true);
  assert.equal(pathInsideOrSame("C:\\Workspace\\Project\\src", "C:\\Workspace"), true);
  assert.equal(pathInsideOrSame("C:\\Workspace-other", "C:\\Workspace"), false);
});

test("findContainingProject chooses the most specific allowed project", () => {
  const projects = [
    { name: "Workspace", path: "C:\\Workspace" },
    { name: "Project", path: "C:\\Workspace\\Project" },
  ];
  assert.equal(
    findContainingProject(projects, "C:\\Workspace\\Project\\src").name,
    "Project",
  );
  assert.equal(findContainingProject(projects, "C:\\Other"), undefined);
});

test("samePath normalizes equivalent paths", () => {
  assert.equal(samePath("C:\\Workspace\\Project\\..\\Project", "C:\\Workspace\\Project"), true);
});

test("Mini App pilot is loopback-only and enabled by default", () => {
  assert.deepEqual(miniAppSettings(), {
    enabled: true,
    host: "127.0.0.1",
    port: 8787,
    quickTunnel: {
      enabled: false,
      provider: "cloudflare",
      mode: "quick",
      executable: "cloudflared",
      menuText: "Журнал",
      publicPort: 8788,
      controlPort: 4300,
      edgeBindAddress: null,
      publicUrl: null,
      tokenFile: null,
    },
    worker: {
      enabled: false,
      publicUrl: null,
      syncSecretFile: null,
      menuText: "Журнал",
      retrySeconds: 15,
      refreshSeconds: 60,
    },
  });
  assert.deepEqual(miniAppSettings({
    enabled: false,
    host: "localhost",
    port: 9000,
    quickTunnel: {
      enabled: true,
      provider: "pinggy",
      mode: "quick",
      executable: "ssh",
      menuText: "Работы",
      publicPort: 9001,
      controlPort: 4301,
      edgeBindAddress: null,
      publicUrl: null,
      tokenFile: null,
    },
  }), {
    enabled: false,
    host: "localhost",
    port: 9000,
    quickTunnel: {
      enabled: true,
      provider: "pinggy",
      mode: "quick",
      executable: "ssh",
      menuText: "Работы",
      publicPort: 9001,
      controlPort: 4301,
      edgeBindAddress: null,
      publicUrl: null,
      tokenFile: null,
    },
    worker: {
      enabled: false,
      publicUrl: null,
      syncSecretFile: null,
      menuText: "Журнал",
      retrySeconds: 15,
      refreshSeconds: 60,
    },
  });
  assert.throws(() => miniAppSettings({ host: "0.0.0.0" }), /loopback/);
  assert.throws(() => miniAppSettings({ port: 65_536 }), /at most 65535/);
  assert.throws(() => miniAppSettings({ quickTunnel: [] }), /must be an object/);
  assert.throws(() => miniAppSettings({ quickTunnel: { menuText: "" } }), /1-64/);
  assert.throws(() => miniAppSettings({ quickTunnel: { provider: "unknown" } }), /cloudflare or pinggy/);
  assert.throws(() => miniAppSettings({ quickTunnel: { publicPort: 8787 } }), /different valid port/);
});

test("Mini App Worker publisher resolves its private secret file", () => {
  const settings = miniAppSettings({
    worker: {
      enabled: true,
      publicUrl: "https://hub.example.test/",
      syncSecretFile: "worker-sync.secret",
      menuText: "Работы",
      retrySeconds: 20,
      refreshSeconds: 90,
    },
  }, {
    configDirectory: "C:\\AgentHub",
  });
  assert.deepEqual(settings.worker, {
    enabled: true,
    publicUrl: "https://hub.example.test",
    syncSecretFile: path.resolve("C:\\AgentHub", "worker-sync.secret"),
    menuText: "Работы",
    retrySeconds: 20,
    refreshSeconds: 90,
  });
  assert.throws(
    () => miniAppSettings({ worker: { enabled: true, publicUrl: "http://hub.example.test" } }),
    /HTTPS URL|HTTPS origin/u,
  );
  assert.throws(
    () => miniAppSettings({ worker: { enabled: true, publicUrl: "https://hub.example.test" } }),
    /syncSecretFile is required/u,
  );
});

test("Mini App named Cloudflare Tunnel resolves its private token file", () => {
  assert.deepEqual(miniAppSettings({
    quickTunnel: {
      enabled: true,
      provider: "cloudflare",
      mode: "named",
      publicUrl: "https://hub.example.test/",
      tokenFile: "cloudflare-tunnel.token",
      edgeBindAddress: "192.0.2.10",
    },
  }, {
    configDirectory: "C:\\AgentHub",
  }).quickTunnel, {
    enabled: true,
    provider: "cloudflare",
    mode: "named",
    executable: "cloudflared",
    menuText: "Журнал",
    publicPort: 8788,
    controlPort: 4300,
    edgeBindAddress: "192.0.2.10",
    publicUrl: "https://hub.example.test",
    tokenFile: path.resolve("C:\\AgentHub", "cloudflare-tunnel.token"),
  });
  assert.throws(
    () => miniAppSettings({ quickTunnel: { mode: "named", provider: "pinggy" } }),
    /requires provider cloudflare/u,
  );
  assert.throws(
    () => miniAppSettings({ quickTunnel: { mode: "named", publicUrl: "http://hub.example.test" } }),
    /absolute HTTPS URL|HTTPS origin/u,
  );
  assert.throws(
    () => miniAppSettings({
      quickTunnel: {
        mode: "named",
        publicUrl: "https://hub.example.test",
      },
    }),
    /tokenFile is required/u,
  );
  assert.throws(
    () => miniAppSettings({ quickTunnel: { edgeBindAddress: "Ethernet" } }),
    /must be an IPv4 or IPv6 address/u,
  );
});

test("filesystem aliases resolve to the configured canonical project path", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "telegram-project-alias-"));
  try {
    const canonical = path.join(root, "canonical");
    const alias = path.join(root, "alias");
    await mkdir(canonical);
    await symlink(canonical, alias, process.platform === "win32" ? "junction" : "dir");
    const projects = [{ name: "Workspace", path: canonical }];
    assert.equal(findContainingProject(projects, alias), projects[0]);
    assert.deepEqual(
      canonicalizeProjectRoots({
        activeProjectRoot: canonical,
        nested: [{ projectRoot: alias }],
        text: `Open ${path.join(alias, "README.md")}`,
        composite: `codex\0${alias.toLowerCase()}\0thread`,
      }, projects),
      {
        activeProjectRoot: canonical,
        nested: [{ projectRoot: canonical }],
        text: `Open ${path.join(canonical, "README.md")}`,
        composite: `codex\0${canonical.toLowerCase()}\0thread`,
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("project root canonicalization does not scan large command output for paths", {
  timeout: 1_000,
}, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-large-state-output-"));
  try {
    const canonical = path.join(root, "canonical");
    const alias = path.join(root, "alias");
    await mkdir(canonical);
    await symlink(canonical, alias, process.platform === "win32" ? "junction" : "dir");
    const output = "C:\\untrusted\\command\\output\\".repeat(8_000);
    const result = canonicalizeProjectRoots({
      activeProjectRoot: alias,
      activeRuns: [{ projectRoot: alias, responseText: output }],
    }, [{ name: "Workspace", path: canonical }]);

    assert.equal(result.activeProjectRoot, canonical);
    assert.equal(result.activeRuns[0].projectRoot, canonical);
    assert.equal(result.activeRuns[0].responseText, output);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Telegram API URL allows plaintext HTTP only on loopback", () => {
  assert.equal(httpBaseUrl("http://127.0.0.1:8081/", "api"), "http://127.0.0.1:8081");
  assert.equal(httpBaseUrl("https://telegram.example", "api"), "https://telegram.example");
  assert.throws(() => httpBaseUrl("http://telegram.example", "api"), /must use HTTPS/);
});

test("resolveConfigPath uses an activated external runtime and workspace fallback", async () => {
  const environment = { LOCALAPPDATA: "C:\\RuntimeBase" };
  const external = await resolveConfigPath({
    environment,
    agentHubRoot: "C:\\Workspace\\AgentHub",
    accessImpl: async () => {},
  });
  assert.equal(external, path.resolve("C:\\RuntimeBase", "AgentHub", "config.json"));

  const legacy = await resolveConfigPath({
    environment,
    agentHubRoot: "C:\\Workspace\\AgentHub",
    accessImpl: async () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); },
  });
  assert.equal(legacy, path.resolve("C:\\Workspace\\AgentHub", "config.json"));
});

test("resolveConfigPath honors the Agent Hub config before runtime discovery", async () => {
  assert.equal(
    await resolveConfigPath({
      environment: { AGENT_HUB_CONFIG: "C:\\Explicit\\config.json" },
      accessImpl: async () => { throw new Error("must not be called"); },
    }),
    path.resolve("C:\\Explicit\\config.json"),
  );
});
