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
const BOT_FILE = path.join(ROOT, "agent-hub-server.mjs");
const FAKE_CODEX_FILE = path.join(ROOT, "e2e", "fake-codex-app-server.mjs");

test("desktop client shares tasks and parallel runs with Agent Hub Server", { timeout: 30_000 }, async (t) => {
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
      AGENT_HUB_CONFIG: configPath,
      AGENT_HUB_RUNTIME_ROOT: runtimeRoot,
      AGENT_HUB_LAUNCHER: "",
      AGENT_HUB_DISABLE_SECRET_ACL: "1",
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
  assert.equal(initial.apiVersion, 2);
  assert.equal(initial.tasks.length, 1);
  const firstThreadId = initial.selected.threadId;
  assert.equal(initial.settings.provider, "codex");
  assert.equal(initial.settings.reasoning, "high");
  assert.equal(initial.settings.mode, "default");
  assert.equal(initial.settings.approvalMode, "manual");
  assert.ok(initial.settings.models.some((model) => model.value === "gpt-5.6-sol"));
  const statusDetails = await callDesktopControl("status-details", {}, { runtimeRoot });
  assert.equal(statusDetails.provider, "codex");
  assert.equal(statusDetails.model, "GPT-5.6-Sol");
  assert.equal(typeof statusDetails.limits, "string");

  const configured = await callDesktopControl("update-setting", {
    name: "reasoning",
    value: "medium",
  }, { runtimeRoot });
  assert.equal(configured.settings.reasoning, "medium");
  const automatic = await callDesktopControl("update-setting", {
    name: "approvalMode",
    value: "auto",
  }, { runtimeRoot });
  assert.equal(automatic.settings.approvalMode, "auto");
  await callDesktopControl("update-setting", { name: "approvalMode", value: "manual" }, { runtimeRoot });
  const approvalStart = await callDesktopControl("send-message", { text: "[approval] desktop" }, { runtimeRoot });
  assert.equal(approvalStart.accepted, true);
  const approvalSnapshot = await waitFor(async () => {
    const snapshot = await callDesktopControl("snapshot", {}, { runtimeRoot });
    return snapshot.pendingApprovals.length ? snapshot : null;
  }, "desktop approval request", 5_000);
  assert.match(approvalSnapshot.pendingApprovals[0].text, /E2E approval|command/i);
  await callDesktopControl("resolve-approval", {
    key: approvalSnapshot.pendingApprovals[0].key,
    decision: "once",
  }, { runtimeRoot });
  await waitFor(async () => {
    const snapshot = await callDesktopControl("snapshot", {}, { runtimeRoot });
    return snapshot.activeCount === 0 ? snapshot : null;
  }, "desktop approval completion", 5_000);

  const firstStart = await callDesktopControl("send-message", { text: "[slow] desktop A" }, { runtimeRoot });
  assert.equal(firstStart.accepted, true);
  const duplicate = await callDesktopControl("send-message", { text: "parallel duplicate" }, { runtimeRoot });
  assert.equal(duplicate.accepted, false);
  assert.equal(duplicate.reason, "task-running");
  assert.equal(duplicate.deferred, true);
  assert.equal(duplicate.snapshot.deferredInputs.length, 1);
  const cancelledDeferred = await callDesktopControl("deferred-input", {
    id: duplicate.id,
    action: "cancel",
  }, { runtimeRoot });
  assert.equal(cancelledDeferred.accepted, true);
  assert.equal((await callDesktopControl("snapshot", {}, { runtimeRoot })).deferredInputs.length, 0);

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
  assert.equal(history.total, 2);
  const slowExchange = history.items.find((item) => item.prompt === "[slow] desktop A");
  assert.ok(slowExchange);
  assert.match(slowExchange.answer, /Готово: \[slow\] desktop A/);

  const attachmentRoot = path.join(runtimeRoot, "DesktopApp", "attachments");
  const imagePath = path.join(attachmentRoot, "desktop.png");
  await mkdir(attachmentRoot, { recursive: true });
  await writeFile(imagePath, Buffer.from("fake-png-for-e2e"));
  await assert.rejects(
    callDesktopControl("send-message", {
      text: "outside image",
      attachments: [configPath],
    }, { runtimeRoot }),
    /вне каталога Desktop-приложения/,
  );
  const imageStart = await callDesktopControl("send-message", {
    text: "desktop image",
    attachments: [imagePath],
  }, { runtimeRoot });
  assert.equal(imageStart.accepted, true);
  await waitFor(async () => {
    const snapshot = await callDesktopControl("snapshot", {}, { runtimeRoot });
    return snapshot.activeCount === 0 ? snapshot : null;
  }, "desktop image turn completion", 10_000);

  const renamed = await callDesktopControl("rename-task", { title: "Desktop renamed" }, { runtimeRoot });
  assert.equal(renamed.selected.title, "Desktop renamed");
  const diff = await callDesktopControl("task-diff", {}, { runtimeRoot });
  assert.equal(typeof diff.text, "string");
  const cancelStart = await callDesktopControl("send-message", { text: "[hold] desktop cancel" }, { runtimeRoot });
  assert.equal(cancelStart.accepted, true);
  const cancelResult = await callDesktopControl("cancel-run", {}, { runtimeRoot });
  assert.equal(cancelResult.accepted, true);
  await waitFor(async () => {
    const snapshot = await callDesktopControl("snapshot", {}, { runtimeRoot });
    return snapshot.activeCount === 0 ? snapshot : null;
  }, "desktop cancellation", 5_000);
  const archived = await callDesktopControl("archive-task", {}, { runtimeRoot });
  assert.notEqual(archived.selected.threadId, firstThreadId);
  assert.doesNotMatch(stderr, /Unhandled asynchronous error|Cannot start desktop control/i);
});
