import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { callDesktopControl } from "./desktop-control.mjs";
import {
  CHAT_ID,
  delay,
  FakeTelegramApi,
  stopPid,
  USER_ID,
  waitFor,
} from "./e2e/telegram-harness.mjs";

const ROOT = path.resolve(import.meta.dirname);
const BOT_FILE = path.join(ROOT, "bot.mjs");
const FAKE_CODEX_FILE = path.join(ROOT, "e2e", "fake-codex-app-server.mjs");

test("desktop client shares tasks and parallel runs with the Integration backend", { timeout: 30_000 }, async (t) => {
  const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "telegram-desktop-e2e-"));
  const dataDir = path.join(runtimeRoot, "data");
  const projectRoot = path.join(runtimeRoot, "project");
  const configPath = path.join(runtimeRoot, "config.json");
  const codexStatePath = path.join(runtimeRoot, "fake-codex-state.json");
  await Promise.all([mkdir(dataDir, { recursive: true }), mkdir(projectRoot, { recursive: true })]);
  const telegram = new FakeTelegramApi();
  await telegram.start();
  await writeFile(configPath, `${JSON.stringify({
    telegramBotToken: "123:test-token",
    telegramApiBaseUrl: telegram.baseUrl,
    allowedUserIds: [USER_ID],
    allowedChatIds: [CHAT_ID],
    privateChatsOnly: true,
    provider: "codex",
    projectRoot,
    projects: [{ name: "Desktop E2E", path: projectRoot }],
    dataDir,
    codexExecutable: process.execPath,
    codexExecutableArgs: [FAKE_CODEX_FILE, "--state", codexStatePath],
    codexModel: "gpt-5.6-sol",
    codexReasoningEffort: "high",
    showProjectButton: false,
    voiceEnabled: false,
    ttsEnabled: false,
    progressStartDelayMs: 50,
  }, null, 2)}\n`, "utf8");

  const bot = spawn(process.execPath, [BOT_FILE], {
    cwd: ROOT,
    env: {
      ...process.env,
      TELEGRAM_CODEX_CONFIG: configPath,
      TELEGRAM_INTEGRATION_RUNTIME_ROOT: runtimeRoot,
      TELEGRAM_INTEGRATION_LAUNCHER: "",
      TELEGRAM_INTEGRATION_DISABLE_SECRET_ACL: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stderr = "";
  bot.stderr.setEncoding("utf8");
  bot.stderr.on("data", (chunk) => { stderr += chunk; });
  t.after(async () => {
    if (bot.exitCode == null) {
      bot.kill("SIGTERM");
      await Promise.race([new Promise((resolve) => bot.once("exit", resolve)), delay(2_000)]);
    }
    if (bot.exitCode == null) await stopPid(bot.pid);
    await telegram.stop();
    await rm(runtimeRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  const initial = await waitFor(
    () => callDesktopControl("snapshot", {}, { runtimeRoot }).catch(() => null),
    "desktop control startup",
  );
  assert.equal(initial.tasks.length, 1);
  const firstThreadId = initial.selected.threadId;

  const firstStart = await callDesktopControl("send-message", { text: "[slow] desktop A" }, { runtimeRoot });
  assert.equal(firstStart.accepted, true);
  const duplicate = await callDesktopControl("send-message", { text: "parallel duplicate" }, { runtimeRoot });
  assert.equal(duplicate.accepted, false);
  assert.equal(duplicate.reason, "task-running");

  const secondTask = await callDesktopControl("new-task", { provider: "codex" }, { runtimeRoot });
  assert.notEqual(secondTask.selected.threadId, firstThreadId);
  const secondStart = await callDesktopControl("send-message", { text: "[slow] desktop B" }, { runtimeRoot });
  assert.equal(secondStart.accepted, true);
  const parallel = await callDesktopControl("snapshot", {}, { runtimeRoot });
  assert.equal(parallel.activeCount, 2);
  assert.equal(parallel.tasks.filter((item) => item.running).length, 2);

  const selectedFirst = await callDesktopControl("select-task", {
    provider: "codex",
    threadId: firstThreadId,
  }, { runtimeRoot });
  assert.equal(selectedFirst.selected.threadId, firstThreadId);

  const completed = await waitFor(async () => {
    const snapshot = await callDesktopControl("snapshot", {}, { runtimeRoot });
    return snapshot.activeCount === 0 ? snapshot : null;
  }, "parallel desktop turns completion", 10_000);
  assert.ok(completed.tasks.every((item) => !item.running));
  const history = await callDesktopControl("task-history", {
    provider: "codex",
    threadId: firstThreadId,
    limit: 10,
  }, { runtimeRoot });
  assert.equal(history.total, 1);
  assert.equal(history.items[0].prompt, "[slow] desktop A");
  assert.match(history.items[0].answer, /Готово: \[slow\] desktop A/);
  assert.doesNotMatch(stderr, /Unhandled asynchronous error|Cannot start desktop control/i);
});
