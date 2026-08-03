import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { serverConfigurationEntries, updateServerConfiguration } from "./server-configuration.mjs";

test("server configuration exposes only its editable non-secret fields", () => {
  const entries = serverConfigurationEntries({
    autoApproveOnStart: true,
    guardConcurrentRepositoryWrites: false,
    codexRolloutContext: { enabled: true },
    codexSandboxMode: "workspace-write",
    codexRpcTimeoutSeconds: 30,
    deferredInputTtlHours: 168,
    progressStartDelayMs: 500,
    deliveryRetryIntervalSeconds: 15,
    logMaxFiles: 5,
    token: "secret",
  }, { logMaxFiles: 7 });
  assert.equal(entries.length, 9);
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
});

test("server configuration persists only validated whitelisted values", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-server-config-"));
  const configPath = path.join(directory, "config.json");
  context.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(configPath, JSON.stringify({ telegramBotToken: "secret", codexRolloutContext: { enabled: false }, unrelated: 1 }), "utf8");
  const result = await updateServerConfiguration({
    configPath,
    changes: {
      autoApproveOnStart: true,
      "codexRolloutContext.enabled": true,
      codexSandboxMode: "danger-full-access",
      logMaxFiles: "8",
    },
    environment: {},
    protectConfig: async () => {},
  });
  assert.deepEqual(result, {
    autoApproveOnStart: true,
    "codexRolloutContext.enabled": true,
    codexSandboxMode: "danger-full-access",
    logMaxFiles: 8,
  });
  const saved = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(saved.telegramBotToken, "secret");
  assert.equal(saved.unrelated, 1);
  assert.deepEqual(saved.codexRolloutContext, { enabled: true });
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
