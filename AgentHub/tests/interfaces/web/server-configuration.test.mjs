import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { serverConfigurationEntries, updateServerConfiguration } from "../../../src/interfaces/web/server-configuration.mjs";

test("sync endpoint uses the ordinary private writer and preserves unrelated settings", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hub-sync-setting-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configPath = path.join(root, "config.json");
  const original = { telegramBotToken: "synthetic-secret", dataDir: "own-data", privatePolicy: { version: 1 } };
  await writeFile(configPath, JSON.stringify(original));
  await updateServerConfiguration({ configPath, changes: { usageSyncServerUrl: " https://sync.example.invalid/ " },
    environment: {}, protectConfig: async () => {} });
  assert.deepEqual(JSON.parse(await readFile(configPath)), { ...original, usageSyncServerUrl: "https://sync.example.invalid" });
  const entry = serverConfigurationEntries({ usageSyncServerUrl: "https://sync.example.invalid" })
    .find(value => value.key === "usageSyncServerUrl");
  assert.equal(entry.type, "url");
  assert.equal(entry.value, "https://sync.example.invalid");
  const before = await readFile(configPath);
  await assert.rejects(updateServerConfiguration({ configPath, changes: { usageSyncServerUrl: "https://user:secret@example.invalid" },
    environment: {}, protectConfig: async () => {} }), /without credentials/u);
  assert.deepEqual(await readFile(configPath), before);
  await updateServerConfiguration({ configPath, changes: { usageSyncServerUrl: "" }, environment: {}, protectConfig: async () => {} });
  assert.equal(JSON.parse(await readFile(configPath)).usageSyncServerUrl, "");
});

test("server configuration exposes only its editable non-secret fields", () => {
  const entries = serverConfigurationEntries({
    autoApproveOnStart: true,
    guardConcurrentRepositoryWrites: false,
    codexExecutableAutoUpdate: true,
    components: { codexContextCleanup: true },
    codexRolloutContext: { scanIntervalSeconds: 1800 },
    contextAutomation: {
      autoCompactAfterTurn: true,
      autoCompactThresholdPercent: 75,
      autoRotateAfterCompaction: true,
      autoRotateThresholdPercent: 20,
    },
    codexSandboxMode: "workspace-write",
    codexRpcTimeoutSeconds: 30,
    deferredInputTtlHours: 168,
    progressStartDelayMs: 500,
    deliveryRetryIntervalSeconds: 15,
    logMaxFiles: 5,
    token: "secret",
  }, { logMaxFiles: 7 });
  assert.equal(entries.length, 16);
  assert.equal(JSON.stringify(entries).includes("secret"), false);
  assert.deepEqual(entries.find((entry) => entry.key === "codexExecutableAutoUpdate"), {
    key: "codexExecutableAutoUpdate",
    name: "Автообновление Codex",
    hint: "На безопасном перезапуске проверяет новейший уже установленный официальный Codex. Не скачивает бинарники и не переключается во время активного хода.",
    type: "boolean",
    value: true,
    display: "Включено",
    unit: "",
    min: null,
    max: null,
    pending: false,
    presentation: "advanced",
  });
  assert.deepEqual(entries.find((entry) => entry.key === "logMaxFiles"), {
    key: "logMaxFiles", name: "Хранение диагностических логов", type: "integer", value: 7,
    hint: "Сколько архивных файлов обычных событий и ошибок хранит Hub. Самые старые удаляются автоматически.",
    display: "7 файлов", unit: "файлов", min: 1, max: 100, pending: true,
    presentation: "advanced",
  });
  const sandboxMode = entries.find((entry) => entry.key === "codexSandboxMode");
  assert.equal(sandboxMode?.name, "Полный доступ Codex");
  assert.equal(sandboxMode?.display, "Только рабочая папка");
  assert.equal(sandboxMode?.presentation, "access-toggle");
  assert.equal(
    sandboxMode?.hint,
    "Выключено — только рабочая папка: запись ограничена проектом, сеть отключена.",
  );
  assert.deepEqual(sandboxMode?.choices, [
    { value: "workspace-write", label: "Только рабочая папка" },
    { value: "danger-full-access", label: "Полный доступ" },
  ]);
  const cleanupInterval = entries.find((entry) => entry.key === "codexRolloutContext.scanIntervalSeconds");
  assert.equal(cleanupInterval?.value, 30);
  assert.equal(cleanupInterval?.display, "30 мин");
  const autoCompact = entries.find((entry) => entry.key === "contextAutomation.autoCompactAfterTurn");
  assert.equal(autoCompact?.name, "Авто-свёртка после хода");
  assert.equal(autoCompact?.presentation, "automation");
  assert.equal(autoCompact?.inlineValueKey, "contextAutomation.autoCompactThresholdPercent");
  const autoCompactThreshold = entries.find((entry) => (
    entry.key === "contextAutomation.autoCompactThresholdPercent"
  ));
  assert.deepEqual(autoCompactThreshold?.visibleWhen, {
    key: "contextAutomation.autoCompactAfterTurn",
    value: true,
  });
  assert.equal(autoCompactThreshold?.inlineFor, "contextAutomation.autoCompactAfterTurn");
  const autoRotate = entries.find((entry) => entry.key === "contextAutomation.autoRotateAfterCompaction");
  assert.equal(autoRotate?.presentation, "automation");
  assert.equal(autoRotate?.inlineValueKey, "contextAutomation.autoRotateThresholdPercent");
  const autoRotateThreshold = entries.find((entry) => (
    entry.key === "contextAutomation.autoRotateThresholdPercent"
  ));
  assert.deepEqual(autoRotateThreshold?.visibleWhen, {
    key: "contextAutomation.autoRotateAfterCompaction",
    value: true,
  });
  assert.equal(autoRotateThreshold?.inlineFor, "contextAutomation.autoRotateAfterCompaction");
  assert.deepEqual(
    entries.find((entry) => entry.key === "components.codexContextCleanup"),
    {
      key: "components.codexContextCleanup",
      name: "Очистка контекста Codex",
      hint: "ПОКА НЕДОСТУПНО — в процессе переосмысления.",
      type: "boolean",
      value: false,
      display: "Выключено",
      unit: "",
      min: null,
      max: null,
      pending: false,
      disabled: true,
    },
  );
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
      codexExecutableAutoUpdate: false,
      "codexRolloutContext.scanIntervalSeconds": 45,
      "contextAutomation.autoCompactAfterTurn": true,
      "contextAutomation.autoCompactThresholdPercent": 75,
      "contextAutomation.autoRotateAfterCompaction": true,
      "contextAutomation.autoRotateThresholdPercent": 30,
      codexSandboxMode: "danger-full-access",
      logMaxFiles: "8",
    },
    environment: {},
    protectConfig: async () => {},
  });
  assert.deepEqual(result, {
    autoApproveOnStart: true,
    codexExecutableAutoUpdate: false,
    "codexRolloutContext.scanIntervalSeconds": 2700,
    "contextAutomation.autoCompactAfterTurn": true,
    "contextAutomation.autoCompactThresholdPercent": 75,
    "contextAutomation.autoRotateAfterCompaction": true,
    "contextAutomation.autoRotateThresholdPercent": 30,
    codexSandboxMode: "danger-full-access",
    logMaxFiles: 8,
  });
  const saved = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(saved.telegramBotToken, "secret");
  assert.equal(saved.unrelated, 1);
  assert.equal(saved.codexExecutableAutoUpdate, false);
  assert.deepEqual(saved.components, { codexContextCleanup: false });
  assert.deepEqual(saved.codexRolloutContext, { scanIntervalSeconds: 2700 });
  assert.deepEqual(saved.contextAutomation, {
    autoCompactAfterTurn: true,
    autoCompactThresholdPercent: 75,
    autoRotateAfterCompaction: true,
    autoRotateThresholdPercent: 30,
  });
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
    updateServerConfiguration({ configPath, changes: { "components.codexContextCleanup": true }, environment: {}, protectConfig: async () => {} }),
    /временно недоступна/u,
  );
  await assert.rejects(
    updateServerConfiguration({ configPath, changes: { codexRpcTimeoutSeconds: 40 }, environment: { CODEX_RPC_TIMEOUT_SECONDS: "30" }, protectConfig: async () => {} }),
    /CODEX_RPC_TIMEOUT_SECONDS/u,
  );
});
