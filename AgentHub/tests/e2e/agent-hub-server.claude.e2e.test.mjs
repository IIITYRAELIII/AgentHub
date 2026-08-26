import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  delay,
  FakeTelegramApi,
  readLockPid,
  stopPid,
  USER_ID,
  CHAT_ID,
  waitFor,
} from "../../e2e/telegram-harness.mjs";
import { processIsAlive } from "../../src/providers/claude/claude-run-io.mjs";
import { callDesktopControl } from "../../desktop-control.mjs";
import { JournalDatabase } from "../../src/infrastructure/persistence/journal-database.mjs";
import { readRuntimeState } from "../../src/infrastructure/persistence/runtime-state-store.mjs";

const AGENT_HUB_ROOT = path.resolve(import.meta.dirname, "..", "..");
const BOT_FILE = path.join(AGENT_HUB_ROOT, "agent-hub-main.mjs");
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
  const journalDatabasePath = path.join(dataDir, "journal.sqlite");
  const lockPath = path.join(dataDir, "bot.lock");
  await Promise.all([
    mkdir(dataDir, { recursive: true }),
    mkdir(projectRoot, { recursive: true }),
    mkdir(transcriptRoot, { recursive: true }),
    mkdir(holdDirectory, { recursive: true }),
  ]);
  const nestedSessionId = "11111111-2222-4333-8444-555555555555";
  const nestedSessionCwd = path.join(projectRoot, "Utilities", "AgentHub");
  const nestedLatestCwd = path.join(nestedSessionCwd, "scratch");
  const nestedTranscriptDirectory = path.join(
    transcriptRoot,
    encodedProjectDirectory(nestedSessionCwd),
  );
  await Promise.all([
    mkdir(nestedSessionCwd, { recursive: true }),
    mkdir(nestedTranscriptDirectory, { recursive: true }),
    mkdir(nestedLatestCwd, { recursive: true }),
  ]);
  const nestedTranscriptEntry = (value) => JSON.stringify({
    sessionId: nestedSessionId,
    cwd: nestedSessionCwd,
    timestamp: new Date().toISOString(),
    ...value,
  });
  await writeFile(path.join(nestedTranscriptDirectory, `${nestedSessionId}.jsonl`), [
    nestedTranscriptEntry({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "Вложенная задача Claude" }] },
    }),
    nestedTranscriptEntry({ type: "ai-title", aiTitle: "Вложенная задача Claude" }),
    nestedTranscriptEntry({
      type: "assistant",
      message: {
        role: "assistant",
        stop_reason: "end_turn",
        content: [{ type: "text", text: "Исходный ответ" }],
      },
    }),
    nestedTranscriptEntry({ type: "last-prompt" }),
    nestedTranscriptEntry({
      type: "custom-title",
      customTitle: "Переименованная задача Claude",
      cwd: nestedLatestCwd,
    }),
    // Claude продолжает добавлять ai-title после пользовательского /rename;
    // явное имя всё равно должно оставаться главным.
    nestedTranscriptEntry({ type: "ai-title", aiTitle: "Вложенная задача Claude", cwd: nestedLatestCwd }),
  ].join("\n") + "\n", "utf8");
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
    const stoppingBot = bot;
    if (stoppingBot && stoppingBot.exitCode == null) {
      stoppingBot.kill("SIGTERM");
      const exited = await Promise.race([
        new Promise((resolve) => stoppingBot.once("exit", () => resolve(true))),
        delay(2_000).then(() => false),
      ]);
      if (!exited && stoppingBot.exitCode == null) await stopPid(stoppingBot.pid);
    }
    try {
      const replacementPid = await readLockPid(lockPath);
      if (replacementPid !== stoppingBot?.pid) await stopPid(replacementPid);
    } catch {}
    bot = null;
  }

  async function activeRuns() {
    return (await runtimeState()).activeRuns ?? [];
  }

  async function runtimeState() {
    return readRuntimeState(dataDir);
  }

  async function telegramSelectedThread(provider = "claude") {
    const state = await runtimeState();
    return state.clientTaskSelections
      ?.find(([clientId]) => clientId === `telegram:${CHAT_ID}`)?.[1]?.provider === provider
      ? state.clientTaskSelections
        .find(([clientId]) => clientId === `telegram:${CHAT_ID}`)?.[1]?.threadId
      : null;
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
    components: { telegram: true, miniApp: false, androidApp: false },
    provider: "claude",
    projectRoot,
    projects: [{ name: "E2E", path: projectRoot }],
    dataDir,
    codexExecutable: process.execPath,
    codexExecutableArgs: [FAKE_CODEX_FILE, "--state", codexStatePath],
    codexRolloutContext: { enabled: false },
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
  await waitFor(() => runtimeState().catch(() => null), "initial bot state");
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
  assert.equal((await runtimeState()).activeProvider, "claude");

  // Сессия, созданная из вложенной папки проекта, продолжается из того же cwd.
  // Fake Claude намеренно отклоняет --resume из другого каталога.
  let mark = telegram.calls.length;
  telegram.pushMessage("/tasks");
  const nestedPicker = await telegram.waitForText("Выберите поток:", {
    after: mark,
    timeoutMs: 15_000,
  });
  const nestedTaskButton = nestedPicker.body.reply_markup.inline_keyboard.flat()
    .find((button) => button.callback_data === `task:l:${nestedSessionId}`);
  assert.ok(nestedTaskButton, "nested Claude session must be present in the task catalog");
  assert.match(nestedTaskButton.text, /Other - Stream 3/);
  telegram.pushCallback(nestedTaskButton.callback_data, nestedPicker.result);
  await waitFor(async () => await telegramSelectedThread() === nestedSessionId,
    "select nested Claude session");
  mark = telegram.calls.length;
  const nestedPrompt = "Продолжить вложенную задачу";
  telegram.pushMessage(nestedPrompt);
  try {
    await telegram.waitForVisibleText(`Claude готово: ${nestedPrompt}`, {
      after: mark,
      timeoutMs: 15_000,
    });
  } catch (error) {
    throw new Error(
      `${error.message}\nstate:\n${JSON.stringify(await runtimeState().catch(() => null), null, 2)}`
      + `\nstdout:\n${stdout}\nstderr:\n${stderr}`,
    );
  }
  const nestedTranscript = await readFile(
    path.join(nestedTranscriptDirectory, `${nestedSessionId}.jsonl`),
    "utf8",
  );
  assert.match(nestedTranscript, /Продолжить вложенную задачу/);

  // Возобновление Claude с изображением обязано передать prompt отдельно от
  // многозначного --add-dir. Иначе реальный CLI поглощает prompt как ещё один
  // каталог и отвечает ошибкой про отсутствующий deferred tool marker.
  const attachmentDirectory = path.join(temporaryRoot, "attachments");
  const imagePath = path.join(attachmentDirectory, "resume-image.png");
  await mkdir(attachmentDirectory, { recursive: true });
  await writeFile(imagePath, Buffer.from("fake-claude-image"));
  const imagePrompt = "Проверь изображение в продолженной задаче Claude";
  const imageStart = await callDesktopControl("send-message", {
    text: imagePrompt,
    provider: "claude",
    threadId: nestedSessionId,
    attachments: [imagePath],
    clientUserMessageId: "claude-resume-image",
  }, { runtimeRoot: temporaryRoot });
  assert.equal(imageStart.accepted, true);
  const imageExchange = await waitFor(async () => {
    const imageHistory = await callDesktopControl("task-history", {
      provider: "claude",
      threadId: nestedSessionId,
      limit: 10,
      refreshSource: true,
    }, { runtimeRoot: temporaryRoot });
    return imageHistory.items.find((item) => (
      item.prompt.includes(imagePrompt) && /Claude готово:/.test(item.answer)
    )) ?? null;
  }, "durable resumed Claude image exchange", 15_000);
  assert.doesNotMatch(imageExchange.answer, /deferred tool marker/i);

  // Первая задача Claude виснет до снятия удержания и остаётся управляемой ботом.
  mark = telegram.calls.length;
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
  assert.equal(firstRun.executionOwner, "hub");
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
  assert.match(deferred.body.text, /уже выполняется через Agent Hub Server/);
  const newTaskButton = deferred.body.reply_markup.inline_keyboard.flat()
    .find((button) => button.callback_data.startsWith("pending:new:"));
  assert.ok(newTaskButton, "a busy Claude task must offer a parallel new task");

  mark = telegram.calls.length;
  telegram.pushCallback(newTaskButton.callback_data, deferred.result);
  try {
    await telegram.waitForVisibleText(`Claude выполняет: ${secondPrompt}`, {
      after: mark,
      timeoutMs: 15_000,
    });
  } catch (error) {
    throw new Error(
      `${error.message}\nstate:\n${JSON.stringify(await runtimeState().catch(() => null), null, 2)}`
      + `\nstdout:\n${stdout}\nstderr:\n${stderr}`,
    );
  }
  const parallelRuns = await waitFor(async () => {
    const runs = await activeRuns();
    return runs.length === 2 && runs.every((run) => run.threadId) ? runs : null;
  }, "two parallel Claude runs", 15_000);
  assert.equal(new Set(parallelRuns.map((run) => run.threadId)).size, 2,
    "parallel Claude tasks must use different sessions");
  assert.equal(new Set(parallelRuns.map((run) => run.claudeOutputPath)).size, 2,
    "parallel Claude tasks must not share an output file");
  await rememberClaudePids();
  const secondThreadId = await telegramSelectedThread();
  assert.equal(secondThreadId, parallelRuns.find((run) => run.promptPreview.includes("beta"))?.threadId);

  // Переключение между двумя живыми задачами и «глазки» на первой.
  mark = telegram.calls.length;
  telegram.pushMessage("/tasks");
  const picker = await telegram.waitForText("Выберите поток:", { after: mark, timeoutMs: 15_000 });
  const runningButtons = picker.body.reply_markup.inline_keyboard.flat()
    .filter((button) => button.callback_data.startsWith("task:l:"));
  assert.equal(
    runningButtons.filter((button) => parallelRuns.some((run) => (
      button.callback_data === `task:l:${run.threadId}`
    ))).length,
    2,
    `both live Claude tasks must be selectable\nruns: ${JSON.stringify(parallelRuns)}\nbuttons: ${JSON.stringify(runningButtons)}`,
  );
  const firstTaskButton = runningButtons
    .find((button) => button.callback_data === `task:l:${firstRun.threadId}`);

  mark = telegram.calls.length;
  telegram.pushCallback(firstTaskButton.callback_data, picker.result);
  const switched = await telegram.waitForText("Текущий поток", { after: mark, timeoutMs: 15_000 });
  await waitFor(async () => await telegramSelectedThread() === firstRun.threadId,
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
  const statusMark = telegram.calls.length;
  telegram.pushMessage("/status");
  await delay(100);
  mark = telegram.calls.length;
  telegram.pushMessage("/cancel");
  let cancellationCall;
  try {
    cancellationCall = await telegram.waitForText("Запрошена остановка этого потока", { after: mark });
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
  assert.equal(
    telegram.calls.slice(statusMark, cancellationCall.index)
      .some((call) => call.method === "sendPhoto"),
    false,
    "a slow status probe must not delay cancellation in the Telegram update loop",
  );
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
  try {
    await telegram.waitForCall(
      "editMessageText",
      (call) => call.body.message_id === restarting.result.message_id
        && String(call.body.text).includes("AGENT HUB ПЕРЕЗАПУЩЕН"),
      { after: mark, timeoutMs: 20_000 },
    );
  } catch (error) {
    throw new Error(
      `${error.message}\nlock:\n${await readFile(lockPath, "utf8").catch(() => "missing")}`
      + `\nstate:\n${JSON.stringify(await runtimeState().catch(() => null), null, 2)}`
      + `\nAPI calls:\n${JSON.stringify(
        telegram.callsAfter(mark).filter((call) => call.method !== "getUpdates").slice(-20),
        null,
        2,
      )}`
      + `\nstdout:\n${stdout}\nstderr:\n${stderr}`,
    );
  }
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
  const journalTurn = await waitFor(async () => {
    const ledger = await new JournalDatabase(journalDatabasePath).loadLedger().catch(() => null);
    return Object.values(ledger?.turns ?? {}).find((turn) => (
      turn.provider === "claude"
      && String(turn.body ?? "").includes(secondPrompt)
    )) ?? null;
  }, "Claude journal entry", 15_000);
  assert.equal(journalTurn.threadId, secondThreadId);
  assert.equal(journalTurn.estimatedCredits, 0.1);
  assert.equal(journalTurn.estimateKind, "claude-cli-total-cost-usd");

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
  const stalePicker = await telegram.waitForText("Выберите поток:", { after: mark, timeoutMs: 15_000 });
  const staleButton = stalePicker.body.reply_markup.inline_keyboard.flat()
    .find((button) => button.callback_data === `task:l:${staleSessionId}`);
  assert.ok(staleButton, "an abandoned Claude session must still be selectable");

  mark = telegram.calls.length;
  telegram.pushCallback(staleButton.callback_data, stalePicker.result);
  await telegram.waitForText("Текущий поток", { after: mark, timeoutMs: 15_000 });
  await waitFor(async () => await telegramSelectedThread() === staleSessionId,
    "switch to the abandoned Claude session", 15_000);

  mark = telegram.calls.length;
  const stalePrompt = "сообщение в брошенную сессию";
  telegram.pushMessage(stalePrompt);
  let uncertain;
  try {
    uncertain = await telegram.waitForText("Нельзя надёжно определить", {
      after: mark,
      timeoutMs: 15_000,
    });
  } catch (error) {
    throw new Error(
      `${error.message}\nstate:\n${JSON.stringify(await runtimeState().catch(() => null), null, 2)}`
      + `\nfailedUpdates:\n${JSON.stringify(
        await readdir(path.join(dataDir, "failed-updates")).catch(() => []),
        null,
        2,
      )}`
      + `\nAPI calls:\n${JSON.stringify(
        telegram.callsAfter(mark).filter((call) => call.method !== "getUpdates").slice(-20),
        null,
        2,
      )}`
      + `\nstdout:\n${stdout}\nstderr:\n${stderr}`,
      { cause: error },
    );
  }
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
    const state = await runtimeState();
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

  // Если локальный transcript удалён, task-sync всё равно сохраняет карточку.
  // Следующий ход должен пересоздать тот же UUID через --session-id, а не
  // бесконечно повторять заведомо неработающий --resume.
  await rm(staleTranscript, { force: true });
  mark = telegram.calls.length;
  const recoveredPrompt = "восстановить исчезнувшую сессию Claude";
  telegram.pushMessage(recoveredPrompt);
  await telegram.waitForText(`Claude готово: ${recoveredPrompt}`, {
    after: mark,
    timeoutMs: 25_000,
  });
  await waitFor(async () => (await activeRuns()).length === 0,
    "missing Claude session recovery", 15_000);
  assert.equal(await readFile(staleTranscript, "utf8").then(() => true, () => false), true,
    "the missing transcript must be recreated under the original task UUID");
  const recoveredHistory = await callDesktopControl("task-history", {
    provider: "claude",
    threadId: staleSessionId,
    limit: 20,
  }, { runtimeRoot: temporaryRoot });
  const recoveredExchange = recoveredHistory.items.find((item) => item.prompt.includes(recoveredPrompt));
  assert.ok(recoveredExchange, "the recovered user message must remain in task history");
  assert.match(recoveredExchange.answer, /Claude готово:/);
  assert.doesNotMatch(stderr, /No conversation found with session ID/);

  assert.equal(stderr.includes("Unhandled asynchronous error"), false, stderr);
});
