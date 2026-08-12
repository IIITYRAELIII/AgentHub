import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  agentHubAutostartShortcut,
  readAgentHubAutostart,
  readRootAgents,
  ROOT_AGENTS_MAX_BYTES,
  rootAgentsFile,
  serverPageSnapshot,
  setAgentHubAutostart,
  updateRootAgents,
} from "../../../src/interfaces/web/server-page.mjs";

test("Agent Hub autostart uses only its own Windows Startup shortcut", () => {
  assert.equal(agentHubAutostartShortcut({ environment: { APPDATA: "C:/AppData" } }),
    path.join("C:/AppData", "Microsoft", "Windows", "Start Menu", "Programs", "Startup", "Agent Hub.lnk"));
  assert.equal(agentHubAutostartShortcut({ environment: {} }), "");
});

test("Agent Hub autostart state is derived from shortcut presence", async () => {
  assert.deepEqual(await readAgentHubAutostart({
    platform: "win32",
    shortcutPath: "C:/Startup/Agent Hub.lnk",
    accessImpl: async () => {},
  }), { supported: true, enabled: true });
  assert.deepEqual(await readAgentHubAutostart({
    platform: "win32",
    shortcutPath: "C:/Startup/Agent Hub.lnk",
    accessImpl: async () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); },
  }), { supported: true, enabled: false });
  assert.deepEqual(await readAgentHubAutostart({ platform: "linux" }), { supported: false, enabled: false });
});

test("Agent Hub autostart enable installs and disable removes only Hub shortcut", async () => {
  let installed = 0;
  let removed = "";
  assert.deepEqual(await setAgentHubAutostart(true, {
    platform: "win32",
    installAutostart: async () => { installed += 1; },
  }), { supported: true, enabled: true });
  assert.equal(installed, 1);
  assert.deepEqual(await setAgentHubAutostart(false, {
    platform: "win32",
    shortcutPath: "C:/Startup/Agent Hub.lnk",
    unlinkImpl: async (target) => { removed = target; },
  }), { supported: true, enabled: false });
  assert.equal(removed, "C:/Startup/Agent Hub.lnk");
  await assert.rejects(() => setAgentHubAutostart(true, { platform: "linux" }), /Windows/);
});

test("root AGENTS editor reads UTF-8 and replaces the fixed file atomically", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-root-agents-"));
  const file = rootAgentsFile(directory);
  try {
    assert.equal(file, path.join(directory, "AGENTS.md"));
    assert.deepEqual(await readRootAgents({ file }), {
      content: "", bytes: 0, maximumBytes: ROOT_AGENTS_MAX_BYTES, exists: false,
    });
    await writeFile(file, "# Правила\n", "utf8");
    const initial = await readRootAgents({ file });
    assert.equal(initial.content, "# Правила\n");
    assert.equal(initial.bytes, Buffer.byteLength("# Правила\n", "utf8"));

    const updated = await updateRootAgents("# Новые правила\n", { file });
    assert.equal(updated.bytes, Buffer.byteLength("# Новые правила\n", "utf8"));
    assert.equal(await readFile(file, "utf8"), "# Новые правила\n");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("root AGENTS editor enforces its byte limit before writing", async () => {
  let writes = 0;
  await assert.rejects(() => updateRootAgents("я".repeat(65_537), {
    file: "C:/workspace/AGENTS.md",
    writeFileImpl: async () => { writes += 1; },
  }), /превышает лимит/u);
  assert.equal(writes, 0);
  await assert.rejects(() => readRootAgents({ file: "" }), /Путь/u);
});

test("server page snapshot excludes secrets and absolute filesystem paths", () => {
  const snapshot = serverPageSnapshot({
    config: {
      components: {
        telegram: true, miniApp: true, androidApp: true, sharedDashboardBot: true, codexContextCleanup: true,
      },
      miniApp: { enabled: true, worker: { enabled: true } },
      autoApproveOnStart: true,
      guardConcurrentRepositoryWrites: true,
      contextAutomation: { autoCompactAfterTurn: true, autoRotateAfterCompaction: true },
      codexRolloutContext: { enabled: true, scanIntervalSeconds: 1800 },
      codexRpcTimeoutSeconds: 30,
      deferredInputTtlHours: 168,
      progressStartDelayMs: 500,
      deliveryRetryIntervalSeconds: 15,
      logMaxFiles: 5,
      token: "secret-token",
      configPath: "C:/Users/private/config.json",
    },
    processId: 42,
    startedAt: "2026-08-02T00:00:00.000Z",
    instanceId: "instance-1",
    releaseId: "release-1",
    activeCount: 2,
    restart: { pending: true, waiting: true, blockingCount: 2 },
    autostart: { supported: true, enabled: true },
  });
  assert.equal(JSON.stringify(snapshot).includes("secret-token"), false);
  assert.equal(JSON.stringify(snapshot).includes("C:/Users/private"), false);
  assert.deepEqual(snapshot.process, {
    status: "running",
    pid: 42,
    startedAt: "2026-08-02T00:00:00.000Z",
    instanceId: "instance-1",
    releaseId: "release-1",
    activeCount: 2,
  });
  assert.deepEqual(snapshot.components.map(({ id, name, enabled }) => ({ id, name, enabled })), [
    { id: "core", name: "Локальный HUB", enabled: true },
    { id: "web-app", name: "Web App", enabled: true },
    { id: "telegram", name: "Telegram Bot", enabled: true },
    { id: "shared-dashboard-bot", name: "Общий бот дашборда", enabled: true },
    { id: "telegram-mini-app", name: "Telegram Mini App", enabled: true },
    { id: "android-app", name: "Android App", enabled: true },
    { id: "codex-context-optimization", name: "Оптимизация Codex", enabled: true },
  ]);
  assert.equal(
    snapshot.components.find((component) => component.id === "codex-context-optimization")?.note,
    "Автосвёртка, авторотация и очистка контекста Codex.",
  );
  assert.equal(snapshot.components.some((component) => component.id === "worker"), false);
});

test("server page derives Web App state from its mobile consumers", () => {
  const disabled = serverPageSnapshot({ config: { components: {}, miniApp: {} } });
  assert.equal(disabled.components.find((component) => component.id === "web-app")?.enabled, false);

  const androidOnly = serverPageSnapshot({
    config: { components: { androidApp: true }, miniApp: {} },
  });
  assert.equal(androidOnly.components.find((component) => component.id === "web-app")?.enabled, true);
});
