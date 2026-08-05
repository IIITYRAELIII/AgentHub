import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { serverConfigurationEntries, updateServerConfiguration } from "./src/interfaces/web/server-configuration.mjs";

test("server configuration exposes only its editable non-secret fields", () => {
  const entries = serverConfigurationEntries({
    autoApproveOnStart: true,
    guardConcurrentRepositoryWrites: false,
    components: { codexContextCleanup: true },
    codexRolloutContext: { scanIntervalSeconds: 1800 },
    codexSandboxMode: "workspace-write",
    codexRpcTimeoutSeconds: 30,
    deferredInputTtlHours: 168,
    progressStartDelayMs: 500,
    deliveryRetryIntervalSeconds: 15,
    logMaxFiles: 5,
    token: "secret",
  }, { logMaxFiles: 7 });
  assert.equal(entries.length, 10);
  assert.equal(JSON.stringify(entries).includes("secret"), false);
  assert.deepEqual(entries.find((entry) => entry.key === "logMaxFiles"), {
    key: "logMaxFiles", name: "Хранение журналов", type: "integer", value: 7,
    hint: "Сколько файлов журнала Hub держит, прежде чем удалять самые старые.",
    display: "7 файлов", unit: "файлов", min: 1, max: 100, pending: true,
  });
  const sandboxMode = entries.find((entry) => entry.key === "codexSandboxMode");
  assert.equal(sandboxMode?.display, "Только рабочая папка");
  assert.deepEqual(sandboxMode?.choices, [
    { value: "workspace-write", label: "Только рабочая папка" },
    { value: "danger-full-access", label: "Полный доступ" },
  ]);
  const cleanupInterval = entries.find((entry) => entry.key === "codexRolloutContext.scanIntervalSeconds");
  assert.equal(cleanupInterval?.value, 30);
  assert.equal(cleanupInterval?.display, "30 мин");
});

test("server configuration persists only validated whitelisted values", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-server-config-"));
  const configPath = path.join(directory, "config.json");
  context.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(configPath, JSON.stringify({ telegramBotToken: "secret", components: { codexContextCleanup: false }, codexRolloutContext: {}, unrelated: 1 }), "utf8");
  const result = await updateServerConfiguration({
    configPath,
    changes: {
      autoApproveOnStart: true,
      "components.codexContextCleanup": true,
      "codexRolloutContext.scanIntervalSeconds": 45,
      codexSandboxMode: "danger-full-access",
      logMaxFiles: "8",
    },
    environment: {},
    protectConfig: async () => {},
  });
  assert.deepEqual(result, {
    autoApproveOnStart: true,
    "components.codexContextCleanup": true,
    "codexRolloutContext.scanIntervalSeconds": 2700,
    codexSandboxMode: "danger-full-access",
    logMaxFiles: 8,
  });
  const saved = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(saved.telegramBotToken, "secret");
  assert.equal(saved.unrelated, 1);
  assert.deepEqual(saved.components, { codexContextCleanup: true });
  assert.deepEqual(saved.codexRolloutContext, { scanIntervalSeconds: 2700 });
  assert.equal(saved.codexSandboxMode, "danger-full-access");
  assert.equal(saved.logMaxFiles, 8);
  await assert.rejects(
    updateServerConfiguration({ configPath, changes: { telegramBotToken: "leak" }, environment: {}, protectConfig: async () => {} }),
    /нельзя менять/u,
  );
  await assert.rejects(
    updateServerConfiguration({ configPath, changes: { codexSandboxMode: "unelevated" }, environment: {}, protectConfig: async () => {} }),
    /допустимых/u,
  );
  await assert.rejects(
    updateServerConfiguration({ configPath, changes: { codexRpcTimeoutSeconds: 40 }, environment: { CODEX_RPC_TIMEOUT_SECONDS: "30" }, protectConfig: async () => {} }),
    /CODEX_RPC_TIMEOUT_SECONDS/u,
  );
});
