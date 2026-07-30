import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  canonicalizeProjectRoots,
  findContainingProject,
  httpBaseUrl,
  loadConfig,
  miniAppSettings,
  pathInsideOrSame,
  repositoryWriteGuardEnabled,
  resolveConfigPath,
  samePath,
} from "./config.mjs";

test("journal profile needs neither Telegram credentials nor Mini App", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-journal-profile-"));
  const configFile = path.join(root, "config.json");
  const previous = process.env.AGENT_HUB_CONFIG;
  try {
    await writeFile(configFile, JSON.stringify({
      profile: "journal",
      projectRoot: root,
      miniApp: { enabled: true },
    }), "utf8");
    process.env.AGENT_HUB_CONFIG = configFile;
    const config = await loadConfig();
    assert.equal(config.profile, "journal");
    assert.equal(config.telegramEnabled, false);
    assert.equal(config.allowedUserIds.size, 0);
    assert.equal(config.allowedChatIds.size, 0);
    assert.equal(config.miniApp.enabled, false);
    assert.deepEqual(config.codexRolloutContext, {
      enabled: false,
      keepRecentImages: 4,
      minReclaimBytes: 1024 * 1024,
      scanIntervalSeconds: 15 * 60,
      maxFilesPerPass: 8,
    });
  } finally {
    if (previous == null) delete process.env.AGENT_HUB_CONFIG;
    else process.env.AGENT_HUB_CONFIG = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("rollout image cleanup requires explicit opt-in and keeps configured interval", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-rollout-cleanup-"));
  const configFile = path.join(root, "config.json");
  const previous = process.env.AGENT_HUB_CONFIG;
  try {
    await writeFile(configFile, JSON.stringify({
      profile: "journal",
      projectRoot: root,
      codexRolloutContext: {
        enabled: true,
        scanIntervalSeconds: 1200,
      },
    }), "utf8");
    process.env.AGENT_HUB_CONFIG = configFile;
    const config = await loadConfig();
    assert.equal(config.codexRolloutContext.enabled, true);
    assert.equal(config.codexRolloutContext.scanIntervalSeconds, 1200);
  } finally {
    if (previous == null) delete process.env.AGENT_HUB_CONFIG;
    else process.env.AGENT_HUB_CONFIG = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("telegram and full profiles share credentials but only full enables Mini App", async () => {
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
    await writeFile(configFile, JSON.stringify({ ...base, profile: "telegram" }), "utf8");
    const telegram = await loadConfig();
    assert.equal(telegram.profile, "telegram");
    assert.equal(telegram.telegramEnabled, true);
    assert.equal(telegram.miniApp.enabled, false);

    await writeFile(configFile, JSON.stringify({ ...base, profile: "full" }), "utf8");
    const full = await loadConfig();
    assert.equal(full.profile, "full");
    assert.equal(full.telegramEnabled, true);
    assert.equal(full.miniApp.enabled, true);
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
