import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

test("desktop client shares tasks and parallel runs with Agent Hub Server", { timeout: 60_000 }, async (t) => {
  const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "telegram-desktop-e2e-"));
  const dataDir = path.join(runtimeRoot, "data");
  const projectRoot = path.join(runtimeRoot, "project");
  const configPath = path.join(runtimeRoot, "config.json");
  const codexStatePath = path.join(runtimeRoot, "fake-codex-state.json");
  const codexPidPath = path.join(runtimeRoot, "fake-codex.pid");
  const savedThreadId = "10000000-0000-4000-8000-000000000001";
  await Promise.all([mkdir(dataDir, { recursive: true }), mkdir(projectRoot, { recursive: true })]);
  const telegram = new FakeTelegramApi();
  await telegram.start();
  await writeFile(configPath, `${JSON.stringify({
    components: { telegram: true, miniApp: false, androidApp: false },
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
    codexExecutableArgs: [
      FAKE_CODEX_FILE,
      "--state", codexStatePath,
      "--pid-file", codexPidPath,
    ],
    codexRolloutContext: { enabled: false },
    codexModel: "gpt-5.6-sol",
    codexReasoningEffort: "high",
    showProjectButton: false,
    voiceEnabled: false,
    ttsEnabled: false,
    progressStartDelayMs: 50,
  }, null, 2)}\n`, "utf8");
  await writeFile(codexStatePath, `${JSON.stringify({
    nextThread: 2,
    nextTurn: 1,
    nextMessage: 1,
    // The delayed initialize models a recovering App Server.  The Desktop
    // pipe must be available before that recovery finishes.
    initializeDelayMs: 1_500,
    threads: [{
      id: savedThreadId,
      cwd: projectRoot,
      name: "Saved large task",
      preview: "",
      updatedAt: Math.floor(Date.now() / 1000),
      turns: [],
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      archived: false,
    }],
    crashedOnce: false,
    requestCounts: {},
  }, null, 2)}\n`, "utf8");
  await writeFile(path.join(dataDir, "state.json"), `${JSON.stringify({
    activeProvider: "codex",
    activeProjectRoot: projectRoot,
    threadIds: { codex: savedThreadId, claude: null },
    activeThreadTitle: "Saved large task",
  }, null, 2)}\n`, "utf8");

  const startupStartedAt = Date.now();
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
  assert.ok(Date.now() - startupStartedAt < 1_400, "Desktop control waited for Codex initialization");
  assert.equal(initial.tasks.length, 1);
  const firstThreadId = initial.selected.threadId;
  assert.equal(firstThreadId, savedThreadId);
  const initialCodexState = await readFile(codexStatePath, "utf8").then(JSON.parse);
  assert.equal(initialCodexState.requestCounts["thread/resume"] ?? 0, 0,
    "startup must not resume the selected saved thread");
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
  const approvalStart = await callDesktopControl("send-message", {
    text: "[approval][auto-compact] desktop",
    provider: "codex",
    threadId: firstThreadId,
  }, { runtimeRoot });
  assert.equal(approvalStart.accepted, true);
  const approvalSnapshot = await waitFor(async () => {
    const snapshot = await callDesktopControl("snapshot", {}, { runtimeRoot });
    return snapshot.pendingApprovals.length ? snapshot : null;
  }, "desktop approval request", 5_000);
  assert.match(approvalSnapshot.pendingApprovals[0].text, /E2E approval|command/i);
  const autoCompacting = await waitFor(async () => {
    const snapshot = await callDesktopControl("snapshot", {}, { runtimeRoot });
    const context = snapshot.tasks.find((item) => item.threadId === firstThreadId)?.context;
    return context?.compacting && context?.compaction?.origin === "automatic" ? snapshot : null;
  }, "automatic context compaction start", 5_000);
  assert.equal(
    autoCompacting.tasks.find((item) => item.threadId === firstThreadId)?.context?.compaction?.status,
    "running",
  );
  await waitFor(async () => {
    const snapshot = await callDesktopControl("snapshot", {}, { runtimeRoot });
    const context = snapshot.tasks.find((item) => item.threadId === firstThreadId)?.context;
    return context?.compaction?.origin === "automatic" && context.compaction.status === "completed"
      && context.usedTokens === 92_592
      ? snapshot
      : null;
  }, "automatic context compaction completion", 5_000);
  await callDesktopControl("resolve-approval", {
    key: approvalSnapshot.pendingApprovals[0].key,
    decision: "once",
  }, { runtimeRoot });
  await waitFor(async () => {
    const snapshot = await callDesktopControl("snapshot", {}, { runtimeRoot });
    return snapshot.activeCount === 0 ? snapshot : null;
  }, "desktop approval completion", 15_000).catch(async (error) => {
    const snapshot = await callDesktopControl("snapshot", {}, { runtimeRoot }).catch(() => null);
    throw new Error(`${error.message}; snapshot=${JSON.stringify({
      activeCount: snapshot?.activeCount,
      tasks: snapshot?.tasks?.map((task) => ({
        threadId: task.threadId,
        running: task.running,
        title: task.title,
        context: task.context,
      })),
    })}`);
  });
  const beforeCompaction = await callDesktopControl("snapshot", {}, { runtimeRoot });
  const contextBefore = beforeCompaction.tasks.find((item) => item.threadId === firstThreadId)?.context;
  assert.equal(contextBefore.usedTokens, 130);
  assert.equal(contextBefore.modelContextWindow, 200_000);
  const compacted = await callDesktopControl("compact-context", {
    provider: "codex",
    threadId: firstThreadId,
  }, { runtimeRoot });
  assert.equal(compacted.accepted, true);
  assert.match(compacted.compactionId, /^[0-9a-f-]{36}$/u);
  await assert.rejects(
    callDesktopControl("update-setting", {
      name: "model",
      value: "gpt-5.6-terra",
    }, { runtimeRoot }),
    /завершения свёртки контекста/iu,
  );
  const compactedSnapshot = await waitFor(async () => {
    const snapshot = await callDesktopControl("snapshot", {}, { runtimeRoot });
    const context = snapshot.tasks.find((item) => item.threadId === firstThreadId)?.context;
    return context?.usedTokens === 92_592 && context?.compaction?.status === "completed"
      ? snapshot
      : null;
  }, "desktop context compaction", 5_000);
  assert.equal(
    compactedSnapshot.tasks.find((item) => item.threadId === firstThreadId)?.context?.compaction?.id,
    compacted.compactionId,
  );
  const firstCodexPid = Number((await readFile(codexPidPath, "utf8")).trim());
  await stopPid(firstCodexPid);
  const compactedAfterDisconnect = await waitFor(async () => {
    try {
      const result = await callDesktopControl("compact-context", {
        provider: "codex",
        threadId: firstThreadId,
      }, { runtimeRoot });
      return result.accepted ? result : null;
    } catch {
      return null;
    }
  }, "desktop context compaction reconnect", 5_000);
  assert.match(compactedAfterDisconnect.compactionId, /^[0-9a-f-]{36}$/u);
  const replacementCodexPid = await waitFor(async () => {
    const value = Number((await readFile(codexPidPath, "utf8").catch(() => "")).trim());
    return value && value !== firstCodexPid ? value : null;
  }, "replacement Codex App Server", 5_000);
  assert.notEqual(replacementCodexPid, firstCodexPid);
  await waitFor(async () => {
    const snapshot = await callDesktopControl("snapshot", {}, { runtimeRoot });
    const context = snapshot.tasks.find((item) => item.threadId === firstThreadId)?.context;
    return context?.compaction?.id === compactedAfterDisconnect.compactionId
      && context.compaction.status === "completed"
      ? snapshot
      : null;
  }, "desktop context compaction after reconnect", 5_000);

  const firstMessageId = "desktop-message-first";
  const steerMessageId = "desktop-message-steer";
  const firstStart = await callDesktopControl("send-message", {
    text: "[slow] desktop A",
    provider: "codex",
    threadId: firstThreadId,
    clientUserMessageId: firstMessageId,
  }, { runtimeRoot });
  assert.equal(firstStart.accepted, true);
  assert.equal(firstStart.threadId, firstThreadId);
  assert.equal(firstStart.clientUserMessageId, firstMessageId);
  const retriedStart = await callDesktopControl("send-message", {
    text: "[slow] desktop A",
    provider: "codex",
    threadId: firstThreadId,
    clientUserMessageId: firstMessageId,
  }, { runtimeRoot });
  assert.equal(retriedStart.accepted, true);
  assert.equal(retriedStart.turnId, firstStart.turnId);
  assert.equal(retriedStart.snapshot.selected.threadId, firstThreadId);
  await assert.rejects(
    callDesktopControl("send-message", {
      text: "Это уже другое сообщение",
      provider: "codex",
      threadId: firstThreadId,
      clientUserMessageId: firstMessageId,
    }, { runtimeRoot }),
    /идентификатор сообщения уже использован/i,
  );
  const steered = await callDesktopControl("send-message", {
    text: "Сначала проверь точные идентификаторы",
    provider: "codex",
    threadId: firstThreadId,
    clientUserMessageId: steerMessageId,
    followUpMode: "steer",
  }, { runtimeRoot });
  assert.equal(steered.accepted, true);
  assert.equal(steered.steered, true);
  assert.equal(steered.turnId, firstStart.turnId);
  assert.equal(steered.clientUserMessageId, steerMessageId);
  const duplicate = await callDesktopControl("send-message", {
    text: "parallel duplicate",
    provider: "codex",
    threadId: firstThreadId,
  }, { runtimeRoot });
  assert.equal(duplicate.accepted, false);
  assert.equal(duplicate.reason, "task-running");
  assert.equal(duplicate.deferred, true);
  assert.equal(duplicate.snapshot.deferredInputs.length, 1);
  assert.equal(duplicate.snapshot.deferredInputs[0].provider, "codex");
  assert.equal(duplicate.snapshot.deferredInputs[0].threadId, firstThreadId);
  const cancelledDeferred = await callDesktopControl("deferred-input", {
    id: duplicate.id,
    action: "cancel",
  }, { runtimeRoot });
  assert.equal(cancelledDeferred.accepted, true);
  assert.equal((await callDesktopControl("snapshot", {}, { runtimeRoot })).deferredInputs.length, 0);

  const secondTask = await callDesktopControl("new-task", { provider: "codex" }, { runtimeRoot });
  assert.notEqual(secondTask.selected.threadId, firstThreadId);
  const secondThreadId = secondTask.selected.threadId;
  const secondStart = await callDesktopControl("send-message", {
    text: "[slow] desktop B",
    provider: "codex",
    threadId: secondThreadId,
  }, { runtimeRoot });
  assert.equal(secondStart.accepted, true);
  const parallel = await callDesktopControl("snapshot", {}, { runtimeRoot });
  assert.equal(parallel.activeCount, 2);
  assert.equal(parallel.tasks.filter((item) => item.running).length, 2);

  const selectedFirst = await callDesktopControl("select-task", {
    provider: "codex",
    threadId: firstThreadId,
  }, { runtimeRoot });
  assert.equal(selectedFirst.selected.threadId, firstThreadId);
  const renamedSecond = await callDesktopControl("rename-task", {
    provider: "codex",
    threadId: secondThreadId,
    title: "Desktop second exact",
  }, { runtimeRoot });
  assert.equal(renamedSecond.selected.threadId, firstThreadId);
  assert.equal(
    renamedSecond.tasks.find((item) => item.threadId === secondThreadId)?.title,
    "Desktop second exact",
  );

  const completed = await waitFor(async () => {
    const snapshot = await callDesktopControl("snapshot", {}, { runtimeRoot });
    return snapshot.activeCount === 0 ? snapshot : null;
  }, "parallel desktop turns completion", 15_000);
  assert.ok(completed.tasks.every((item) => !item.running));
  assert.equal(
    completed.tasks.find((item) => item.threadId === firstThreadId)?.context?.usedTokens,
    130,
    "newer real usage must replace the post-compaction context usage",
  );
  const history = await waitFor(async () => {
    const result = await callDesktopControl("task-history", {
      provider: "codex",
      threadId: firstThreadId,
      limit: 10,
    }, { runtimeRoot });
    return result.total === 2 ? result : null;
  }, "background task history hydration", 5_000);
  assert.equal(history.total, 2);
  const slowExchange = history.items.find((item) => item.prompt === "[slow] desktop A");
  assert.ok(slowExchange);
  assert.match(slowExchange.answer, /Готово: \[slow\] desktop A/);
  const userMessages = slowExchange.messages.filter((item) => item.role === "user");
  assert.deepEqual(userMessages.map((item) => item.clientUserMessageId), [
    firstMessageId,
    steerMessageId,
  ]);
  assert.ok(userMessages.every((item) => (
    item.itemId && item.itemId !== item.clientUserMessageId
  )));

  const attachmentRoot = path.join(runtimeRoot, "DesktopApp", "attachments");
  const imagePath = path.join(attachmentRoot, "desktop.png");
  await mkdir(attachmentRoot, { recursive: true });
  await writeFile(imagePath, Buffer.from("fake-png-for-e2e"));
  await assert.rejects(
    callDesktopControl("send-message", {
      text: "outside image",
      attachments: [configPath],
      provider: "codex",
      threadId: firstThreadId,
    }, { runtimeRoot }),
    /вне каталога Desktop-приложения/,
  );
  const imageStart = await callDesktopControl("send-message", {
    text: "desktop image",
    attachments: [imagePath],
    provider: "codex",
    threadId: firstThreadId,
  }, { runtimeRoot });
  assert.equal(imageStart.accepted, true);
  await waitFor(async () => {
    const snapshot = await callDesktopControl("snapshot", {}, { runtimeRoot });
    return snapshot.activeCount === 0 ? snapshot : null;
  }, "desktop image turn completion", 15_000);

  const renamed = await callDesktopControl("rename-task", {
    title: "Desktop renamed",
    provider: "codex",
    threadId: firstThreadId,
  }, { runtimeRoot });
  assert.equal(renamed.selected.title, "Desktop renamed");
  const diff = await callDesktopControl("task-diff", {
    provider: "codex",
    threadId: firstThreadId,
  }, { runtimeRoot });
  assert.equal(typeof diff.text, "string");
  const cancelStart = await callDesktopControl("send-message", {
    text: "[hold] desktop cancel",
    provider: "codex",
    threadId: firstThreadId,
  }, { runtimeRoot });
  assert.equal(cancelStart.accepted, true);
  await waitFor(async () => {
    const snapshot = await callDesktopControl("snapshot", {}, { runtimeRoot });
    return snapshot.tasks.find((item) => item.threadId === firstThreadId)?.running ? snapshot : null;
  }, "desktop cancellable turn", 5_000);
  const cancelResult = await callDesktopControl("cancel-run", {
    provider: "codex",
    threadId: firstThreadId,
  }, { runtimeRoot });
  assert.equal(cancelResult.accepted, true);
  await waitFor(async () => {
    const snapshot = await callDesktopControl("snapshot", {}, { runtimeRoot });
    return snapshot.activeCount === 0 ? snapshot : null;
  }, "desktop cancellation", 15_000);
  const archived = await callDesktopControl("archive-task", {
    provider: "codex",
    threadId: firstThreadId,
  }, { runtimeRoot });
  assert.notEqual(archived.selected.threadId, firstThreadId);
  assert.doesNotMatch(stderr, /Unhandled asynchronous error|Cannot start desktop control/i);
});
