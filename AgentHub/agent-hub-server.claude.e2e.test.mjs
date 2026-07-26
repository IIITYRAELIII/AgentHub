import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  delay,
  FakeTelegramApi,
  readJson,
  readLockPid,
  stopPid,
  USER_ID,
  CHAT_ID,
  waitFor,
} from "./e2e/telegram-harness.mjs";
import { processIsAlive } from "./claude-run-io.mjs";

const AGENT_HUB_ROOT = path.resolve(import.meta.dirname);
const BOT_FILE = path.join(AGENT_HUB_ROOT, "agent-hub-server.mjs");
const FAKE_CODEX_FILE = path.join(AGENT_HUB_ROOT, "e2e", "fake-codex-app-server.mjs");
const FAKE_CLAUDE_FILE = path.join(AGENT_HUB_ROOT, "e2e", "fake-claude-cli.mjs");

function encodedProjectDirectory(projectPath) {
  return String(projectPath).replace(/[\\/:]+/g, "-");
}

test("claude runs parallel tasks, survives a bot restart and ignores stale transcripts", {
  timeout: 120_000,
}, async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "telegram-claude-e2e-"));
  const dataDir = path.join(temporaryRoot, "data");
  const projectRoot = path.join(temporaryRoot, "project");
  const fakeHome = path.join(temporaryRoot, "home");
  const transcriptRoot = path.join(fakeHome, ".claude", "projects");
  const holdDirectory = path.join(temporaryRoot, "hold");
  const configPath = path.join(temporaryRoot, "config.json");
  const codexStatePath = path.join(temporaryRoot, "fake-codex-state.json");
  const statePath = path.join(dataDir, "state.json");
  const lockPath = path.join(dataDir, "bot.lock");
  await Promise.all([
    mkdir(dataDir, { recursive: true }),
    mkdir(projectRoot, { recursive: true }),
    mkdir(transcriptRoot, { recursive: true }),
    mkdir(holdDirectory, { recursive: true }),
  ]);
  const telegram = new FakeTelegramApi();
  await telegram.start();
  let bot = null;
  let stdout = "";
  let stderr = "";
  const claudePids = new Set();

  async function startBot() {
    bot = spawn(process.execPath, [BOT_FILE], {
      cwd: AGENT_HUB_ROOT,
      env: {
        ...process.env,
        AGENT_HUB_CONFIG: configPath,
        AGENT_HUB_RUNTIME_ROOT: temporaryRoot,
        AGENT_HUB_LAUNCHER: "",
        AGENT_HUB_DISABLE_SECRET_ACL: "1",
        USERPROFILE: fakeHome,
        HOME: fakeHome,
        FAKE_CLAUDE_HOLD_DIR: holdDirectory,
        FAKE_CLAUDE_TRANSCRIPT_ROOT: transcriptRoot,
        FAKE_CLAUDE_USAGE_DELAY_MS: "3000",
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    bot.stdout.setEncoding("utf8");
    bot.stderr.setEncoding("utf8");
    bot.stdout.on("data", (chunk) => { stdout += chunk; });
    bot.stderr.on("data", (chunk) => { stderr += chunk; });
    return bot;
  }

  async function stopBot() {
    if (bot && bot.exitCode == null) {
      bot.kill("SIGTERM");
      await Promise.race([
        new Promise((resolve) => bot.once("exit", resolve)),
        delay(2_000),
      ]);
    }
    try {
      const replacementPid = await readLockPid(lockPath);
      if (replacementPid !== bot?.pid) await stopPid(replacementPid);
    } catch {}
    bot = null;
  }

  async function activeRuns() {
    return (await readJson(statePath)).activeRuns ?? [];
  }

  async function releaseHold(name) {
    await writeFile(path.join(holdDirectory, name), "release", "utf8");
  }

  async function rememberClaudePids() {
    for (const run of await activeRuns()) {
      if (run.provider === "claude" && Number.isSafeInteger(run.pid)) claudePids.add(run.pid);
    }
  }

  t.after(async () => {
    // Ходы Claude намеренно переживают остановку бота, поэтому гасим их вручную.
    await releaseHold("alpha").catch(() => {});
    await releaseHold("beta").catch(() => {});
    await stopBot();
    for (const pid of claudePids) await stopPid(pid);
    await telegram.stop();
    await delay(300);
    await rm(temporaryRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  await writeFile(configPath, `${JSON.stringify({
    telegramBotToken: "123:test-token",
    telegramApiBaseUrl: telegram.baseUrl,
    allowedUserIds: [USER_ID],
    allowedChatIds: [CHAT_ID],
    privateChatsOnly: true,
    provider: "claude",
    projectRoot,
    projects: [{ name: "E2E", path: projectRoot }],
    dataDir,
    codexExecutable: process.execPath,
    codexExecutableArgs: [FAKE_CODEX_FILE, "--state", codexStatePath],
    claudeExecutable: process.execPath,
    claudeExecutableArgs: [FAKE_CLAUDE_FILE],
    showProjectButton: false,
    showTaskProject: false,
    voiceEnabled: false,
    ttsEnabled: false,
    progressStartDelayMs: 50,
    deliveryRetryIntervalSeconds: 1,
    logMaxBytes: 1_000_000,
    logMaxFiles: 2,
  }, null, 2)}\n`, "utf8");

  const orphanRunDirectory = path.join(dataDir, "claude-runs");
  const orphanOutput = path.join(orphanRunDirectory, "orphan.jsonl");
  const orphanError = path.join(orphanRunDirectory, "orphan.err.log");
  await mkdir(orphanRunDirectory, { recursive: true });
  await Promise.all([
    writeFile(orphanOutput, "orphan", "utf8"),
    writeFile(orphanError, "orphan", "utf8"),
  ]);

  await startBot();
  await waitFor(() => readJson(statePath).catch(() => null), "initial bot state");
  await waitFor(async () => {
    const files = await Promise.all([
      readFile(orphanOutput, "utf8").then(() => true, () => false),
      readFile(orphanError, "utf8").then(() => true, () => false),
    ]);
    return files.every((exists) => !exists);
  }, "orphaned Claude run cleanup");
  telegram.pushMessage("/start");
  try {
    await telegram.waitForText("Бот подключён к Claude Code и Codex.");
  } catch (error) {
    throw new Error(`${error.message}\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  }
  assert.equal((await readJson(statePath)).activeProvider, "claude");

  // Первая задача Claude виснет до снятия удержания и остаётся управляемой ботом.
  let mark = telegram.calls.length;
  const firstPrompt = "[hold:alpha] [child:alpha-child] первая задача Claude";
  telegram.pushMessage(firstPrompt);
  await telegram.waitForVisibleText(`Claude выполняет: ${firstPrompt}`, {
    after: mark,
    timeoutMs: 15_000,
  });
  const firstRun = await waitFor(async () => {
    const runs = await activeRuns();
    return runs.length === 1 && runs[0].threadId ? runs[0] : null;
  }, "first Claude run with a session id", 15_000);
  assert.equal(firstRun.provider, "claude");
  assert.equal(firstRun.observer, false);
  assert.equal(firstRun.executionOwner, "telegram");
  assert.ok(String(firstRun.claudeOutputPath ?? "").endsWith(".jsonl"),
    "a managed Claude turn must stream through its own output file");
  assert.ok(Number.isSafeInteger(firstRun.pid), "the Claude process id must be persisted");
  await rememberClaudePids();
  const alphaChildPid = await waitFor(async () => {
    const value = Number(await readFile(path.join(holdDirectory, "alpha-child.pid"), "utf8").catch(() => ""));
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  }, "Claude descendant pid");
  claudePids.add(alphaChildPid);

  // Пока первая задача занята, новое сообщение уходит в отложенные.
  mark = telegram.calls.length;
  const secondPrompt = "[hold:beta] вторая задача Claude";
  telegram.pushMessage(secondPrompt);
  const deferred = await telegram.waitForText(secondPrompt, { after: mark });
  assert.match(deferred.body.text, /уже выполняется через Telegram CLI/);
  const newTaskButton = deferred.body.reply_markup.inline_keyboard.flat()
    .find((button) => button.callback_data.startsWith("pending:new:"));
  assert.ok(newTaskButton, "a busy Claude task must offer a parallel new task");

  mark = telegram.calls.length;
  telegram.pushCallback(newTaskButton.callback_data, deferred.result);
  await telegram.waitForVisibleText(`Claude выполняет: ${secondPrompt}`, {
    after: mark,
    timeoutMs: 15_000,
  });
  const parallelRuns = await waitFor(async () => {
    const runs = await activeRuns();
    return runs.length === 2 && runs.every((run) => run.threadId) ? runs : null;
  }, "two parallel Claude runs", 15_000);
  assert.equal(new Set(parallelRuns.map((run) => run.threadId)).size, 2,
    "parallel Claude tasks must use different sessions");
  assert.equal(new Set(parallelRuns.map((run) => run.claudeOutputPath)).size, 2,
    "parallel Claude tasks must not share an output file");
  await rememberClaudePids();
  const secondThreadId = (await readJson(statePath)).threadIds.claude;
  assert.equal(secondThreadId, parallelRuns.find((run) => run.promptPreview.includes("beta"))?.threadId);

  // Переключение между двумя живыми задачами и «глазки» на первой.
  mark = telegram.calls.length;
  telegram.pushMessage("/tasks");
  const picker = await telegram.waitForText("Выберите задачу:", { after: mark, timeoutMs: 15_000 });
  const runningButtons = picker.body.reply_markup.inline_keyboard.flat()
    .filter((button) => button.callback_data.startsWith("task:l:"));
  assert.equal(
    runningButtons.filter((button) => parallelRuns.some((run) => (
      button.callback_data === `task:l:${run.threadId}`
    ))).length,
    2,
    "both live Claude tasks must be selectable",
  );
  const firstTaskButton = runningButtons
    .find((button) => button.callback_data === `task:l:${firstRun.threadId}`);

  mark = telegram.calls.length;
  telegram.pushCallback(firstTaskButton.callback_data, picker.result);
  const switched = await telegram.waitForText("Текущая задача", { after: mark, timeoutMs: 15_000 });
  await waitFor(async () => (await readJson(statePath)).threadIds.claude === firstRun.threadId,
    "switch to the first live Claude task");

  mark = telegram.calls.length;
  const durableEye = switched.body.reply_markup.inline_keyboard.flat()
    .find((button) => button.callback_data === `task-view:s:l:${firstRun.threadId}`);
  assert.ok(durableEye, "task switch must carry a self-contained task identity");
  await Promise.all([
    rm(path.join(dataDir, "telegram-thread-bindings.json"), { force: true }),
    rm(path.join(dataDir, "telegram-thread-bindings.d"), { recursive: true, force: true }),
  ]);
  telegram.pushCallback(durableEye.callback_data, switched.result);
  await telegram.waitForVisibleText(firstPrompt, { after: mark, timeoutMs: 15_000 });
  assert.equal((await activeRuns()).length, 2, "opening a live view must not stop either task");

  // Медленный /status выполняется вне последовательного polling и не задерживает
  // следующую критичную команду /cancel.
  const cancelStartedAt = Date.now();
  telegram.pushMessage("/status");
  await delay(100);
  mark = telegram.calls.length;
  telegram.pushMessage("/cancel");
  try {
    await telegram.waitForText("Запрошена остановка этой задачи", { after: mark });
  } catch (error) {
    throw new Error(
      `${error.message}\nAPI calls:\n${JSON.stringify(
        telegram.callsAfter(mark).filter((call) => call.method !== "getUpdates").slice(-20),
        null,
        2,
      )}`
      + `\nstderr:\n${stderr}`,
    );
  }
  assert.ok(Date.now() - cancelStartedAt < 2_500,
    "a slow status probe must not delay cancellation in the Telegram update loop");
  const remaining = await waitFor(async () => {
    const runs = await activeRuns();
    return runs.length === 1 ? runs[0] : null;
  }, "only the selected Claude task cancelled", 15_000);
  assert.equal(remaining.threadId, secondThreadId,
    "cancelling one Claude task must keep the parallel one running");
  await waitFor(() => !processIsAlive(alphaChildPid), "cancelled Claude descendant", 15_000);

  // Перезапуск бота при живом ходе: процесс CLI переживает его и дописывает ответ.
  mark = telegram.calls.length;
  const restartedBot = bot;
  restartedBot.kill("SIGTERM");
  await new Promise((resolve) => restartedBot.once("exit", resolve));
  await startBot();
  const restoredRun = await waitFor(async () => {
    const runs = await activeRuns();
    return runs.length === 1 && runs[0].claudeSettled === false ? runs[0] : null;
  }, "Claude run reattached after a bot restart", 20_000);
  assert.equal(restoredRun.threadId, secondThreadId);
  assert.equal(restoredRun.observer, false,
    "a reattached Claude turn must stay managed by the bot");
  assert.equal(
    telegram.callsAfter(mark, "sendMessage").some((call) => (
      String(call.body.text ?? "").includes("был прерван")
    )),
    false,
    "a surviving Claude process must not be reported as interrupted",
  );

  // Штатный /restart не должен ждать завершения хода Claude: он переживает
  // перезапуск, в отличие от хода Codex со своим App Server.
  mark = telegram.calls.length;
  telegram.pushMessage("/restart");
  const restarting = await telegram.waitForText("Перезапускаю Agent Hub", { after: mark, timeoutMs: 15_000 });
  assert.equal(
    telegram.callsAfter(mark, "sendMessage").some((call) => (
      String(call.body.text ?? "").includes("после завершения выполняющихся задач")
    )),
    false,
    "a live Claude turn must not postpone the restart",
  );
  await telegram.waitForCall(
    "editMessageText",
    (call) => call.body.message_id === restarting.result.message_id
      && String(call.body.text).includes("AGENT HUB ПЕРЕЗАПУЩЕН"),
    { after: mark, timeoutMs: 20_000 },
  );
  bot = null;
  const runAfterRestartCommand = await waitFor(async () => {
    const runs = await activeRuns();
    return runs.length === 1 ? runs[0] : null;
  }, "Claude turn kept running across /restart", 15_000);
  assert.equal(runAfterRestartCommand.threadId, secondThreadId);

  mark = telegram.calls.length;
  await releaseHold("beta");
  await telegram.waitForText(`Claude готово: ${secondPrompt}`, { after: mark, timeoutMs: 25_000 });
  await waitFor(async () => (await activeRuns()).length === 0,
    "reattached Claude turn delivered its final answer", 20_000);

  // Брошенный незавершённый транскрипт имеет неопределённую живость: он не
  // считается активным, но новый ход требует явного подтверждения пользователя.
  const staleSessionId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const staleTranscript = path.join(
    transcriptRoot,
    encodedProjectDirectory(projectRoot),
    `${staleSessionId}.jsonl`,
  );
  const staleTimestamp = new Date(Date.now() - 45 * 60_000).toISOString();
  await mkdir(path.dirname(staleTranscript), { recursive: true });
  await writeFile(staleTranscript, `${[
    {
      type: "user",
      sessionId: staleSessionId,
      cwd: projectRoot,
      timestamp: staleTimestamp,
      message: { role: "user", content: [{ type: "text", text: "заброшенный ход" }] },
    },
    {
      type: "ai-title",
      sessionId: staleSessionId,
      cwd: projectRoot,
      timestamp: staleTimestamp,
      aiTitle: "Заброшенный ход",
    },
  ].map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
  const staleTime = new Date(Date.now() - 45 * 60_000);
  await utimes(staleTranscript, staleTime, staleTime);

  mark = telegram.calls.length;
  telegram.pushMessage("/tasks");
  const stalePicker = await telegram.waitForText("Выберите задачу:", { after: mark, timeoutMs: 15_000 });
  const staleButton = stalePicker.body.reply_markup.inline_keyboard.flat()
    .find((button) => button.callback_data === `task:l:${staleSessionId}`);
  assert.ok(staleButton, "an abandoned Claude session must still be selectable");

  mark = telegram.calls.length;
  telegram.pushCallback(staleButton.callback_data, stalePicker.result);
  await waitFor(async () => (await readJson(statePath)).threadIds.claude === staleSessionId,
    "switch to the abandoned Claude session", 15_000);

  mark = telegram.calls.length;
  const stalePrompt = "сообщение в брошенную сессию";
  telegram.pushMessage(stalePrompt);
  const uncertain = await telegram.waitForText("Нельзя надёжно определить", {
    after: mark,
    timeoutMs: 15_000,
  });
  const forceButton = uncertain.body.reply_markup.inline_keyboard.flat()
    .find((button) => button.callback_data.startsWith("pending:force:"));
  assert.ok(forceButton, "unknown Claude activity must require an explicit force action");
  assert.equal(
    telegram.callsAfter(mark, "sendMessage").some((call) => (
      String(call.body.text ?? "").includes(`Claude готово: ${stalePrompt}`)
    )),
    false,
    "an uncertain transcript must not start a new turn automatically",
  );

  mark = telegram.calls.length;
  telegram.pushCallback(forceButton.callback_data, uncertain.result);
  await telegram.waitForText(`Claude готово: ${stalePrompt}`, { after: mark, timeoutMs: 25_000 });
  try {
    await waitFor(async () => (await activeRuns()).length === 0, "stale session turn completion", 15_000);
  } catch (error) {
    const state = await readJson(statePath);
    const transcriptFiles = await readdir(transcriptRoot, { recursive: true });
    throw new Error(
      `${error.message}\nactiveRuns:\n${JSON.stringify(await activeRuns(), null, 2)}`
      + `\nselected:\n${JSON.stringify({
        activeProvider: state.activeProvider,
        threadId: state.threadId,
        threadIds: state.threadIds,
        activeThreadTitle: state.activeThreadTitle,
      }, null, 2)}`
      + `\ntranscripts:\n${JSON.stringify(transcriptFiles, null, 2)}`
      + `\nstderr:\n${stderr}`,
    );
  }

  assert.equal(stderr.includes("Unhandled asynchronous error"), false, stderr);
});
