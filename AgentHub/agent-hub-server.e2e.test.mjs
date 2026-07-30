import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFile, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  CHAT_ID,
  delay,
  FakeTelegramApi,
  readJson,
  readLockPid,
  stopPid,
  USER_ID,
  waitFor,
} from "./e2e/telegram-harness.mjs";

const AGENT_HUB_ROOT = path.resolve(import.meta.dirname);
const BOT_FILE = path.join(AGENT_HUB_ROOT, "agent-hub-server.mjs");
const FAKE_CODEX_FILE = path.join(AGENT_HUB_ROOT, "e2e", "fake-codex-app-server.mjs");
const FAKE_CLAUDE_FILE = path.join(AGENT_HUB_ROOT, "e2e", "fake-claude-cli.mjs");
const FAKE_TTS_FILE = path.join(AGENT_HUB_ROOT, "e2e", "fake-tts-worker.mjs");

function callbackAction(value) {
  return String(value ?? "").replace(/:u:[0-9a-f]{12}$/i, "");
}

function callbackButton(call, action) {
  return call.body.reply_markup.inline_keyboard.flat()
    .find((button) => callbackAction(button.callback_data) === action);
}

function multipartField(call, name) {
  const marker = `name="${name}"\r\n\r\n`;
  const start = call.rawBody.indexOf(marker);
  if (start < 0) return "";
  const valueStart = start + marker.length;
  const valueEnd = call.rawBody.indexOf("\r\n--", valueStart);
  return call.rawBody.slice(valueStart, valueEnd < 0 ? undefined : valueEnd);
}

test("bot routes tasks, live views, queues, parallel turns, failures and restarts headlessly", { timeout: 75_000 }, async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "telegram-bot-e2e-"));
  const dataDir = path.join(temporaryRoot, "data");
  const projectRoot = path.join(temporaryRoot, "project");
  const secondProjectRoot = path.join(temporaryRoot, "project-two");
  const configPath = path.join(temporaryRoot, "config.json");
  const codexStatePath = path.join(temporaryRoot, "fake-codex-state.json");
  const statePath = path.join(dataDir, "state.json");
  const workLogPath = path.join(projectRoot, "WORK_LOG.md");
  const secondWorkLogPath = path.join(secondProjectRoot, "WORK_LOG.md");
  const workLogLedgerPath = path.join(dataDir, "work-log-usage.json");
  const lockPath = path.join(dataDir, "bot.lock");
  await Promise.all([
    mkdir(dataDir, { recursive: true }),
    mkdir(projectRoot, { recursive: true }),
    mkdir(secondProjectRoot, { recursive: true }),
  ]);
  const telegram = new FakeTelegramApi();
  await telegram.start();
  let bot = null;
  let stdout = "";
  let stderr = "";

  async function startBot() {
    bot = spawn(process.execPath, [BOT_FILE], {
      cwd: AGENT_HUB_ROOT,
      env: {
        ...process.env,
        AGENT_HUB_CONFIG: configPath,
        AGENT_HUB_RUNTIME_ROOT: temporaryRoot,
        AGENT_HUB_LAUNCHER: "",
        AGENT_HUB_DISABLE_SECRET_ACL: "1",
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
    if (bot?.exitCode == null) {
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

  t.after(async () => {
    await stopBot();
    await telegram.stop();
    await delay(200);
    await rm(temporaryRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  await writeFile(configPath, `${JSON.stringify({
    telegramBotToken: "123:test-token",
    telegramApiBaseUrl: telegram.baseUrl,
    allowedUserIds: [USER_ID],
    allowedChatIds: [CHAT_ID],
    privateChatsOnly: true,
    provider: "codex",
    projectRoot,
    projects: [{ name: "E2E", path: projectRoot }, { name: "E2E-2", path: secondProjectRoot }],
    dataDir,
    codexExecutable: process.execPath,
    codexExecutableArgs: [FAKE_CODEX_FILE, "--state", codexStatePath],
    codexRolloutContext: { enabled: false },
    codexModel: "gpt-5.6-sol",
    codexReasoningEffort: "high",
    codexModels: [
      { value: "gpt-5.6-sol", label: "GPT-5.6-Sol" },
      { value: "gpt-e2e", label: "GPT-E2E" },
    ],
    showProjectButton: false,
    showTaskProject: false,
    voiceEnabled: false,
    ttsEnabled: true,
    ttsPythonExe: process.execPath,
    ttsWorkerScript: FAKE_TTS_FILE,
    ttsRequestTimeoutSeconds: 2,
    claudeExecutable: process.execPath,
    claudeExecutableArgs: [FAKE_CLAUDE_FILE],
    progressStartDelayMs: 50,
    deliveryRetryIntervalSeconds: 1,
    logMaxBytes: 1_000_000,
    logMaxFiles: 2,
  }, null, 2)}\n`, "utf8");
  await writeFile(workLogPath, "# Глобальный журнал работ\n", "utf8");
  await writeFile(secondWorkLogPath, "# Глобальный журнал работ\n", "utf8");

  telegram.failNext("getUpdates", 500);
  await startBot();
  const initialState = await waitFor(() => readJson(statePath).catch(() => null), "initial bot state");
  await waitFor(
    () => readFile(path.join(dataDir, "agent-hub.log"), "utf8").catch(() => null),
    "isolated E2E log",
  );
  const firstThreadId = initialState.threadIds.codex;
  assert.match(firstThreadId, /^[0-9a-f-]{36}$/i);
  telegram.pushMessage("/start");
  try {
    const startMessage = await telegram.waitForText("Бот подключён к Claude Code и Codex.");
    assert.equal(startMessage.body.reply_markup.is_persistent, true);
    assert.ok(startMessage.body.reply_markup.keyboard.length > 0);
    const commands = telegram.calls.find((call) => call.method === "setMyCommands");
    assert.equal(commands?.body?.commands?.[0]?.command, "menu");
  } catch (error) {
    throw new Error(`${error.message}\nstdout:\n${stdout}\nstderr:\n${stderr}\nAPI calls:\n${JSON.stringify(telegram.calls.slice(-20), null, 2)}`);
  }

  let mark = telegram.calls.length;
  telegram.pushMessage("/menu");
  const restoredMenu = await telegram.waitForText("Панель кнопок показана", { after: mark });
  assert.equal(restoredMenu.body.reply_markup.is_persistent, true);
  assert.ok(restoredMenu.body.reply_markup.keyboard.flat().some((button) => button.text === "📋 Задачи"));

  mark = telegram.calls.length;
  telegram.pushMessage("/new");
  const newThreadMessage = await telegram.waitForText("Создан новый контекст Codex.", { after: mark });
  assert.equal(newThreadMessage.body.reply_markup.is_persistent, true,
    "plain replies must refresh the persistent control keyboard");
  const secondThreadId = (await readJson(statePath)).threadIds.codex;
  assert.notEqual(secondThreadId, firstThreadId);

  mark = telegram.calls.length;
  telegram.pushMessage("/tasks");
  const pickerCall = await telegram.waitForText("Выберите задачу:", { after: mark });
  const picker = pickerCall.result;
  const pickerRows = pickerCall.body.reply_markup.inline_keyboard;
  assert.equal(callbackAction(pickerRows.at(-2)[0].callback_data), "thread:new");
  assert.equal(callbackAction(pickerRows.at(-1)[0].callback_data), "thread:archive");
  const staleArchiveButton = callbackButton(pickerCall, "thread:archive");

  mark = telegram.calls.length;
  telegram.pushMessage("/tasks");
  const currentPickerCall = await telegram.waitForText("Выберите задачу:", { after: mark });
  const selectFirst = currentPickerCall.body.reply_markup.inline_keyboard.flat()
    .find((button) => button.callback_data === `task:c:${firstThreadId}`);
  assert.ok(selectFirst, "first task must be selectable");

  mark = telegram.calls.length;
  telegram.pushCallback(selectFirst.callback_data, currentPickerCall.result);
  const switched = await telegram.waitForText("Текущая задача изменена", { after: mark });
  assert.equal((await readJson(statePath)).threadIds.codex, firstThreadId);
  assert.equal(
    switched.body.reply_markup.inline_keyboard[0][0].callback_data,
    `task-view:s:c:${firstThreadId}`,
  );

  mark = telegram.calls.length;
  telegram.pushCallback(staleArchiveButton.callback_data, picker);
  await telegram.waitForCall("answerCallbackQuery", (call) => (
    call.body.show_alert === true && String(call.body.text).includes("меню устарело")
  ), { after: mark });
  assert.equal(
    (await readJson(codexStatePath)).threads.find((item) => item.id === firstThreadId)?.archived,
    false,
    "an archive button from an old task menu must never archive the newly selected task",
  );

  mark = telegram.calls.length;
  telegram.pushMessage("/tasks");
  const repeatPickerCall = await telegram.waitForText("Выберите задачу:", { after: mark });
  const repeatButton = repeatPickerCall.body.reply_markup.inline_keyboard
    .flat().find((button) => button.callback_data === `task:c:${firstThreadId}`);
  mark = telegram.calls.length;
  telegram.pushCallback(repeatButton.callback_data, repeatPickerCall.result);
  await telegram.waitForText("Текущая задача уже выбрана", { after: mark });

  mark = telegram.calls.length;
  telegram.pushMessage("/model");
  const modelPicker = await telegram.waitForText("Current Codex model", { after: mark });
  mark = telegram.calls.length;
  telegram.pushCallback(callbackButton(modelPicker, "codex-model:gpt-e2e").callback_data, modelPicker.result);
  await telegram.waitForText("Codex model: GPT-E2E", { after: mark });
  await waitFor(async () => (await readJson(statePath)).codexModel === "gpt-e2e", "model switch");

  mark = telegram.calls.length;
  telegram.pushMessage("/reasoning");
  const reasoningPicker = await telegram.waitForText("Reasoning Codex", { after: mark });
  mark = telegram.calls.length;
  telegram.pushCallback(callbackButton(reasoningPicker, "codex-reasoning:medium").callback_data, reasoningPicker.result);
  await telegram.waitForText("Reasoning Codex:", { after: mark });
  await waitFor(async () => (await readJson(statePath)).codexReasoningEffort === "medium", "reasoning switch");

  mark = telegram.calls.length;
  telegram.pushMessage("/mode");
  const modePicker = await telegram.waitForText("Выберите режим для следующих запросов", { after: mark });
  mark = telegram.calls.length;
  telegram.pushCallback(callbackButton(modePicker, "codex-mode:plan").callback_data, modePicker.result);
  await telegram.waitForText("Режим Codex: Plan", { after: mark });
  await waitFor(async () => (await readJson(statePath)).codexCollaborationMode === "plan", "mode switch");

  mark = telegram.calls.length;
  telegram.pushMessage("/rename E2E основная");
  await telegram.waitForText("Название закреплено: «E2E основная»", { after: mark });
  assert.equal((await readJson(statePath)).activeThreadTitle, "E2E основная");

  // Forwarded conversations stay in one durable draft until the user submits
  // the complete batch, including their own comments.
  mark = telegram.calls.length;
  telegram.pushMessage("Первая реплика клиента", {
    forward_origin: {
      type: "user",
      sender_user: { id: 701, is_bot: false, first_name: "Иван", last_name: "Клиент" },
      date: Math.floor(Date.now() / 1000) - 10,
    },
  });
  const bundleCard = await telegram.waitForText("Собираю пачку для «E2E основная»", { after: mark });
  let savedBundleState = await readJson(statePath);
  assert.equal(savedBundleState.forwardBundles.length, 1);
  assert.equal(savedBundleState.activeRuns.length, 0,
    "a forwarded message must not start a turn before explicit bundle submission");
  const savedBundleId = savedBundleState.forwardBundles[0].id;
  await stopBot();
  await startBot();
  savedBundleState = await waitFor(async () => {
    const state = await readJson(statePath).catch(() => null);
    return state?.forwardBundles?.[0]?.id === savedBundleId ? state : null;
  }, "forward bundle restore after restart");

  const bundleEditMark = telegram.calls.length;
  telegram.pushMessage("Вторая реплика клиента", {
    forward_origin: {
      type: "hidden_user",
      sender_user_name: "Мария",
      date: Math.floor(Date.now() / 1000) - 5,
    },
  });
  telegram.pushMessage("Мой комментарий к переписке");
  await telegram.waitForCall(
    "editMessageText",
    (call) => String(call.body.text).includes("Сообщений: 3 · переслано: 2 · ваших: 1"),
    { after: bundleEditMark },
  );
  savedBundleState = await readJson(statePath);
  assert.equal(savedBundleState.forwardBundles[0].items.length, 3);

  const albumOrigin = {
    type: "hidden_user",
    sender_user_name: "Клиент со скриншотами",
    date: Math.floor(Date.now() / 1000) - 2,
  };
  for (let index = 1; index <= 3; index += 1) {
    telegram.pushMessage(null, {
      caption: index === 1 ? "К сообщению приложены три скриншота" : undefined,
      media_group_id: "e2e-forwarded-album",
      photo: [{ file_id: `e2e-forwarded-photo-${index}`, file_size: 128 }],
      forward_origin: albumOrigin,
    });
  }
  try {
    savedBundleState = await waitFor(async () => {
      const state = await readJson(statePath).catch(() => null);
      const items = state?.forwardBundles?.[0]?.items ?? [];
      const attachments = items.flatMap((item) => item.attachments ?? []);
      return items.length === 6
        && attachments.length === 3
        && attachments.every((attachment) => attachment.status === "ready")
        ? state
        : null;
    }, "forwarded album captured by bundle", 8_000);
  } catch (error) {
    const failedState = await readJson(statePath).catch(() => null);
    throw new Error(
      `${error.message}\nforwardBundles=${JSON.stringify(failedState?.forwardBundles)}`
      + `\nbackgroundJobs=${JSON.stringify(await readdir(path.join(dataDir, "background-jobs")).catch(() => []))}`
      + `\nrecentCalls=${JSON.stringify(telegram.recentCalls(bundleEditMark, 30))}`
      + `\nstdout:\n${stdout}\nstderr:\n${stderr}`,
      { cause: error },
    );
  }
  assert.equal(savedBundleState.activeRuns.length, 0,
    "forwarded album must not start independent turns");
  assert.equal(savedBundleState.pendingInputs.length, 0,
    "forwarded album must not create deferred inputs");
  await telegram.waitForCall(
    "editMessageText",
    (call) => String(call.body.text).includes(
      "Сообщений: 6 · переслано: 5 · ваших: 1 · изображений: 3",
    ),
    { after: bundleEditMark },
  );

  mark = telegram.calls.length;
  const submitBundle = bundleCard.body.reply_markup.inline_keyboard.flat()
    .find((button) => button.callback_data.startsWith("forward-bundle:send:"));
  telegram.pushCallback(submitBundle.callback_data, bundleCard.result);
  const bundleFinal = await telegram.waitForText("Готово: Ниже пакет сообщений", {
    after: mark,
    timeoutMs: 8_000,
  });
  assert.match(bundleFinal.body.text, /Переслано · Иван Клиент/);
  assert.match(bundleFinal.body.text, /Переслано · Мария/);
  assert.match(bundleFinal.body.text, /Сообщение 3 · Вы/);
  await waitFor(async () => (await readJson(statePath)).forwardBundles.length === 0,
    "submitted forward bundle cleanup");

  // A slow media download must not block the Telegram update loop, and the
  // resulting turn must remain bound to the task selected when media arrived.
  telegram.fileDownloadDelayMs = 1_200;
  const downloadIndex = telegram.fileDownloads.length;
  mark = telegram.calls.length;
  telegram.pushMessage(null, {
    caption: "[media] медленная картинка",
    photo: [{ file_id: "e2e-photo", file_size: 128 }],
  });
  await telegram.waitForText("Изображение получено", { after: mark });
  await waitFor(() => telegram.fileDownloads[downloadIndex], "delayed media download start");

  const menuMark = telegram.calls.length;
  telegram.pushMessage("/menu");
  const menuDuringDownload = await telegram.waitForText("Панель кнопок показана", {
    after: menuMark,
    timeoutMs: 800,
  });
  assert.equal(telegram.fileDownloads[downloadIndex].completedAt, null,
    "commands must be handled while media is still downloading");

  mark = telegram.calls.length;
  telegram.pushMessage("/tasks");
  const mediaTaskPicker = await telegram.waitForText("Выберите задачу:", { after: mark, timeoutMs: 800 });
  const selectSecondDuringDownload = mediaTaskPicker.body.reply_markup.inline_keyboard.flat()
    .find((button) => button.callback_data === `task:c:${secondThreadId}`);
  assert.ok(selectSecondDuringDownload, "second task must remain selectable during media processing");
  mark = telegram.calls.length;
  telegram.pushCallback(selectSecondDuringDownload.callback_data, mediaTaskPicker.result);
  await telegram.waitForText("Текущая задача изменена", { after: mark, timeoutMs: 800 });
  assert.equal((await readJson(statePath)).threadIds.codex, secondThreadId);

  await telegram.waitForText("Готово: [media] медленная картинка", { after: menuMark, timeoutMs: 8_000 });
  assert.ok(telegram.fileDownloads[downloadIndex].completedAt >= menuDuringDownload.at,
    "the menu response must precede completion of the delayed download");
  assert.equal((await readJson(statePath)).threadIds.codex, secondThreadId,
    "finishing delayed media must not switch the selected task back");
  telegram.fileDownloadDelayMs = 0;

  mark = telegram.calls.length;
  telegram.pushMessage("/tasks");
  const returnAfterMediaPicker = await telegram.waitForText("Выберите задачу:", { after: mark });
  const returnToFirstAfterMedia = returnAfterMediaPicker.body.reply_markup.inline_keyboard.flat()
    .find((button) => button.callback_data === `task:c:${firstThreadId}`);
  assert.ok(returnToFirstAfterMedia, "original media task must remain selectable");
  mark = telegram.calls.length;
  telegram.pushCallback(returnToFirstAfterMedia.callback_data, returnAfterMediaPicker.result);
  await telegram.waitForText("Текущая задача изменена", { after: mark });

  telegram.fileDownloadDelayMs = 500;
  mark = telegram.calls.length;
  telegram.pushMessage(null, {
    caption: "[media-race-a] первая картинка",
    photo: [{ file_id: "e2e-photo-race-a", file_size: 128 }],
  });
  telegram.pushMessage(null, {
    caption: "[media-race-b] вторая картинка",
    photo: [{ file_id: "e2e-photo-race-b", file_size: 128 }],
  });
  await telegram.waitForText("Готово: [media-race-a] первая картинка", { after: mark, timeoutMs: 8_000 });
  await telegram.waitForText("Готово: [media-race-b] вторая картинка", { after: mark, timeoutMs: 8_000 });
  assert.equal(
    telegram.callsAfter(mark, "sendMessage").filter((call) => (
      String(call.body.text ?? "").includes("Готово: [media-race-")
    )).length,
    2,
    "two rapidly submitted images must be processed once each in queue order",
  );
  telegram.fileDownloadDelayMs = 0;

  // Once Telegram's offset has advanced, an accepted media job must survive a
  // hard process loss instead of requiring the user to resend the image.
  telegram.fileDownloadDelayMs = 5_000;
  mark = telegram.calls.length;
  const durableMediaUpdateId = telegram.nextUpdateId;
  const durableDownloadIndex = telegram.fileDownloads.length;
  telegram.pushMessage(null, {
    caption: "[media-restart] картинка после аварийного рестарта",
    photo: [{ file_id: "e2e-photo-restart", file_size: 128 }],
  });
  await waitFor(async () => {
    const names = await readdir(path.join(dataDir, "background-jobs")).catch(() => []);
    return names.some((name) => name.endsWith(".json"));
  }, "durable media job persistence");
  await waitFor(async () => (await readJson(statePath)).updateOffset > durableMediaUpdateId,
    "Telegram offset committed after durable media acceptance");
  await waitFor(() => telegram.fileDownloads[durableDownloadIndex], "durable media download start");
  const botBeforeMediaRestore = bot;
  botBeforeMediaRestore.kill("SIGKILL");
  await new Promise((resolve) => botBeforeMediaRestore.once("exit", resolve));
  telegram.fileDownloadDelayMs = 0;
  await startBot();
  await telegram.waitForText("Готово: [media-restart] картинка после аварийного рестарта", {
    after: mark,
    timeoutMs: 12_000,
  });
  await waitFor(async () => {
    const names = await readdir(path.join(dataDir, "background-jobs")).catch(() => []);
    return names.filter((name) => name.endsWith(".json")).length === 0;
  }, "restored media job cleanup", 12_000);
  assert.equal(
    telegram.callsAfter(mark, "sendMessage").filter((call) => (
      String(call.body.text ?? "").includes("Готово: [media-restart] картинка после аварийного рестарта")
    )).length,
    1,
    "a recovered media job must complete once",
  );

  mark = telegram.calls.length;
  telegram.pushMessage("[slow] обычное завершение");
  let normalProgress;
  try {
    normalProgress = await telegram.waitForText(
      "Проверяю сценарий: [slow] обычное завершение",
      { after: mark, timeoutMs: 12_000 },
    );
  } catch (error) {
    const failedState = await readJson(statePath).catch(() => null);
    const failedOutbox = await readdir(path.join(dataDir, "delivery-outbox")).catch(() => []);
    throw new Error(
      `${error.message}\nstateOffset=${failedState?.updateOffset} nextUpdateId=${telegram.nextUpdateId}`
      + ` activeRuns=${JSON.stringify(failedState?.activeRuns)}`
      + ` pending=${JSON.stringify(failedState?.pendingInputs)}`
      + ` queued=${JSON.stringify(failedState?.queuedInputs)}`
      + ` lastMessages=${JSON.stringify(failedState?.lastTaskMessages)}`
      + ` restart=${JSON.stringify(failedState?.restartRequest)}`
      + ` outbox=${JSON.stringify(failedOutbox)}`
      + `\nupdates=${JSON.stringify(telegram.updates.slice(-5))}`
      + `\nstdout:\n${stdout}\nstderr:\n${stderr}`,
      { cause: error },
    );
  }
  const normalProgressId = normalProgress.result.message_id;
  const normalFinal = await telegram.waitForText("Готово: [slow] обычное завершение", {
    after: mark,
    timeoutMs: 12_000,
  });
  assert.match(normalFinal.body.text, /^✅ Codex · /);
  assert.match(normalFinal.body.text, /\n🧵 /);
  assert.match(normalFinal.body.text, /\n⚙ Agent Hub Server/);
  assert.match(normalFinal.body.text, /Кредиты за задачу: нет тарифа для gpt-e2e/);
  const normalProgressDeletion = await telegram.waitForCall("deleteMessage", (call) => (
    call.body.message_id === normalProgressId
  ), { after: mark });
  assert.ok(
    telegram.calls.indexOf(normalFinal) < telegram.calls.indexOf(normalProgressDeletion),
    "the live progress card must remain visible until the final answer is delivered",
  );
  await waitFor(async () => (await readJson(statePath)).activeRuns.length === 0, "normal turn completion");
  const normalJournalTurn = await waitFor(async () => {
    const ledger = await readJson(workLogLedgerPath).catch(() => null);
    return Object.values(ledger?.turns ?? {}).find((item) => (
      String(item.body ?? item.text ?? "").includes("Готово: [slow] обычное завершение")
    )) ?? null;
  }, "normal Codex turn journal projection");
  assert.equal(normalJournalTurn.status, "completed");
  assert.match(await readFile(workLogPath, "utf8"), /Готово: \[slow\] обычное завершение/);
  assert.equal(
    telegram.callsAfter(normalFinal.index + 1, "sendPhoto").some((call) => (
      call.rawBody.includes("Ход завершён.") && call.rawBody.includes("Кредиты за задачу:")
    )),
    false,
    "turn usage must be appended to the final answer instead of a separate card",
  );
  assert.equal(
    telegram.callsAfter(mark, "sendMessage").some((call) => (
      String(call.body.text ?? "").includes("Изменения этой задачи доступны после её выбора по команде /diff.")
    )),
    false,
    "the final answer must not be followed by a separate diff notification",
  );
  const normalDiffButton = normalFinal.body.reply_markup.inline_keyboard.flat()
    .find((button) => button.text === "Изменения");
  assert.ok(normalDiffButton, "every completed answer must expose its task diff");
  mark = telegram.calls.length;
  telegram.pushCallback(normalDiffButton.callback_data, normalFinal.result);
  await telegram.waitForText("diff --fake", { after: mark });

  mark = telegram.calls.length;
  telegram.pushMessage("/diff");
  await telegram.waitForText("diff --fake", { after: mark });

  const normalSpeechButton = normalFinal.body.reply_markup.inline_keyboard.flat()
    .find((button) => button.callback_data.startsWith("speech:"));
  assert.ok(normalSpeechButton, "a completed answer must expose speech synthesis");
  mark = telegram.calls.length;
  telegram.pushCallback(normalSpeechButton.callback_data, normalFinal.result);
  await telegram.waitForCall("sendVoice", (call) => call.rawBody.includes("OggS-fake-voice"), {
    after: mark,
    timeoutMs: 4_000,
  });
  await waitFor(async () => {
    const names = await readdir(path.join(dataDir, "background-jobs")).catch(() => []);
    return names.filter((name) => name.endsWith(".json")).length === 0;
  }, "successful speech job cleanup");

  mark = telegram.calls.length;
  telegram.pushMessage("[tts-stall] проверка зависшего синтеза");
  const stalledSpeechFinal = await telegram.waitForText("Готово: [tts-stall] проверка зависшего синтеза", { after: mark });
  await waitFor(async () => (await readJson(statePath)).activeRuns.length === 0, "stalled speech source completion");
  const stalledSpeechButton = stalledSpeechFinal.body.reply_markup.inline_keyboard.flat()
    .find((button) => button.callback_data.startsWith("speech:"));
  mark = telegram.calls.length;
  telegram.pushCallback(stalledSpeechButton.callback_data, stalledSpeechFinal.result);
  await telegram.waitForText("нет прогресса озвучивания более 2 сек.", { after: mark, timeoutMs: 5_000 });

  mark = telegram.calls.length;
  telegram.pushCallback(normalSpeechButton.callback_data, normalFinal.result);
  await telegram.waitForCall("sendVoice", (call) => call.rawBody.includes("OggS-fake-voice"), {
    after: mark,
    timeoutMs: 4_000,
  });

  mark = telegram.calls.length;
  telegram.pushMessage("[tts-hold] озвучка после аварийного рестарта");
  const durableSpeechFinal = await telegram.waitForText("Готово: [tts-hold] озвучка после аварийного рестарта", { after: mark });
  await waitFor(async () => (await readJson(statePath)).activeRuns.length === 0, "durable speech source completion");
  const durableSpeechButton = durableSpeechFinal.body.reply_markup.inline_keyboard.flat()
    .find((button) => button.callback_data.startsWith("speech:"));
  const speechMarkersBeforeRestart = (await readdir(path.join(dataDir, "tts")).catch(() => []))
    .filter((name) => name.endsWith(".started")).length;
  telegram.pushCallback(durableSpeechButton.callback_data, durableSpeechFinal.result);
  await waitFor(async () => {
    const names = await readdir(path.join(dataDir, "tts")).catch(() => []);
    return names.filter((name) => name.endsWith(".started")).length > speechMarkersBeforeRestart;
  }, "durable speech worker start");
  await waitFor(async () => {
    const names = await readdir(path.join(dataDir, "background-jobs")).catch(() => []);
    return names.some((name) => name.endsWith(".json"));
  }, "durable speech job persistence");
  const botBeforeSpeechRestore = bot;
  botBeforeSpeechRestore.kill("SIGKILL");
  await new Promise((resolve) => botBeforeSpeechRestore.once("exit", resolve));
  await startBot();
  await telegram.waitForCall("sendVoice", (call) => call.rawBody.includes("OggS-fake-voice"), {
    after: mark,
    timeoutMs: 6_000,
  });
  await waitFor(async () => {
    const names = await readdir(path.join(dataDir, "background-jobs")).catch(() => []);
    return names.filter((name) => name.endsWith(".json")).length === 0;
  }, "restored speech job cleanup", 6_000);
  assert.equal(telegram.callsAfter(mark, "sendVoice").length, 1,
    "a restored speech job must upload exactly one voice message");

  mark = telegram.calls.length;
  telegram.pushMessage("[approval] подтверждение команды");
  let approval;
  try {
    approval = await telegram.waitForText("Codex запрашивает запуск команды", { after: mark });
  } catch (error) {
    const failedState = await readJson(statePath).catch(() => null);
    throw new Error(
      `${error.message}\nstate=${JSON.stringify(failedState)}\nstdout:\n${stdout}\nstderr:\n${stderr}`,
      { cause: error },
    );
  }
  const approveOnce = approval.body.reply_markup.inline_keyboard.flat()
    .find((button) => /^a:[0-9a-f-]{36}:once$/i.test(button.callback_data));
  assert.ok(approveOnce, "approval message must expose one-time acceptance");
  telegram.pushCallback(approveOnce.callback_data, approval.result);
  await telegram.waitForText("Подтверждение: accept", { after: mark });
  await waitFor(async () => (await readJson(statePath)).activeRuns.length === 0, "approved turn completion");

  mark = telegram.calls.length;
  telegram.pushMessage("/approvals");
  const approvalMode = await telegram.waitForText("Ручной режим", { after: mark });
  const enableAuto = callbackButton(approvalMode, "approval-mode:auto");
  telegram.pushCallback(enableAuto.callback_data, approvalMode.result);
  await telegram.waitForCall("answerCallbackQuery", (call) => call.body.text === "Автоподтверждение включено", { after: mark });

  mark = telegram.calls.length;
  telegram.pushMessage("[elicitation] автоматическое MCP-подтверждение");
  await telegram.waitForText("MCP elicitation: accept:true", { after: mark });
  assert.equal(telegram.callsAfter(mark, "sendMessage").some((call) => (
    String(call.body.text ?? "").includes("MCP запрашивает подтверждение")
  )), false, "safe MCP elicitation must not ask the user in auto mode");
  await waitFor(async () => (await readJson(statePath)).activeRuns.length === 0, "auto-approved MCP turn completion");

  mark = telegram.calls.length;
  telegram.pushMessage("/approvals");
  const autoApprovalMode = await telegram.waitForText("Автоподтверждение включено", { after: mark });
  const returnManual = callbackButton(autoApprovalMode, "approval-mode:manual");
  telegram.pushCallback(returnManual.callback_data, autoApprovalMode.result);
  await telegram.waitForCall("answerCallbackQuery", (call) => call.body.text === "Ручной режим включён", { after: mark });

  mark = telegram.calls.length;
  telegram.pushMessage("[hold] основной ход");
  const progress = await telegram.waitForText("[hold] основной ход", { after: mark });
  assert.match(progress.body.text, /Ответ формируется|Задача принята|Проверяю сценарий/);
  await waitFor(async () => (await readJson(statePath)).activeRuns.length === 1, "held run registration");
  const readsBeforeManagedFallback = Number(
    (await readJson(codexStatePath)).requestCounts?.["thread/read"] ?? 0,
  );
  await new Promise((resolve) => setTimeout(resolve, 1_800));
  const heldRun = (await readJson(statePath)).activeRuns[0];
  assert.equal(heldRun.observer, false, "Agent Hub run must persist as managed");
  assert.equal(heldRun.executionOwner, "hub", "Agent Hub run owner must survive progress polling");
  assert.equal(heldRun.appServer, "Agent Hub Server");
  assert.equal(
    Number((await readJson(codexStatePath)).requestCounts?.["thread/read"] ?? 0),
    readsBeforeManagedFallback,
    "a managed Agent Hub turn must use streamed events instead of polling every 1.5 seconds",
  );

  mark = telegram.calls.length;
  telegram.pushMessage("показать, но не отправлять");
  const showDeferred = await telegram.waitForText("показать, но не отправлять", { after: mark });
  const showButton = showDeferred.body.reply_markup.inline_keyboard.flat()
    .find((button) => button.callback_data.startsWith("pending:show:"));
  mark = telegram.calls.length;
  telegram.pushCallback(showButton.callback_data, showDeferred.result);
  await telegram.waitForText("Показано сообщений:", { after: mark });
  const cancelShown = showDeferred.body.reply_markup.inline_keyboard.flat()
    .find((button) => button.callback_data.startsWith("pending:cancel:"));
  telegram.pushCallback(cancelShown.callback_data, showDeferred.result);
  await telegram.waitForCall("editMessageText", (call) => String(call.body.text).includes("отменено"), { after: mark });

  mark = telegram.calls.length;
  telegram.pushMessage("очередь после остановки");
  const queuedDeferred = await telegram.waitForText("очередь после остановки", { after: mark });
  const queueButton = queuedDeferred.body.reply_markup.inline_keyboard.flat()
    .find((button) => button.callback_data.startsWith("pending:queue:"));
  telegram.pushCallback(queueButton.callback_data, queuedDeferred.result);
  await telegram.waitForCall("editMessageText", (call) => String(call.body.text).includes("поставлено в очередь"), { after: mark });

  mark = telegram.calls.length;
  const parallelPrompt = "[hold] [resume-error] параллельная новая задача";
  telegram.pushMessage(parallelPrompt);
  const newDeferred = await telegram.waitForText(parallelPrompt, { after: mark });
  const newButton = newDeferred.body.reply_markup.inline_keyboard.flat()
    .find((button) => button.callback_data.startsWith("pending:new:"));
  mark = telegram.calls.length;
  telegram.pushCallback(newButton.callback_data, newDeferred.result);
  const parallelProgress = await telegram.waitForText(parallelPrompt, { after: mark });
  const parallelThreadId = (await readJson(statePath)).threadIds.codex;
  assert.notEqual(parallelThreadId, firstThreadId);
  await waitFor(async () => (await readJson(statePath)).activeRuns.length === 2,
    "two independently active tasks");
  const terminalAuditBeforeRestart = await waitFor(async () => {
    const snapshot = (await readJson(statePath)).codexTerminalAudit;
    return Date.parse(snapshot?.completedThrough ?? "") > 0 ? snapshot : null;
  }, "persistent Codex terminal audit cursor");
  const botBeforeParallelRestart = bot;
  botBeforeParallelRestart.kill("SIGTERM");
  await new Promise((resolve) => botBeforeParallelRestart.once("exit", resolve));
  await startBot();
  const restoredParallelRuns = await waitFor(async () => {
    const runs = (await readJson(statePath)).activeRuns;
    return runs.length === 2 ? runs : null;
  }, "two active tasks restored after process restart");
  assert.equal(restoredParallelRuns.every((run) => run.observer === false), true);
  assert.equal(restoredParallelRuns.every((run) => run.executionOwner === "hub"), true);
  assert.equal((await readJson(statePath)).threadIds.codex, parallelThreadId,
    "a transient resume error must not replace the selected active task with a new thread");
  const terminalAuditAfterRestart = await waitFor(async () => {
    const snapshot = (await readJson(statePath)).codexTerminalAudit;
    return Date.parse(snapshot?.completedThrough ?? "") >= Date.parse(
      terminalAuditBeforeRestart.completedThrough,
    ) ? snapshot : null;
  }, "Codex terminal audit cursor restored after process restart");
  assert.equal(Array.isArray(terminalAuditAfterRestart.positions), true);

  mark = telegram.calls.length;
  telegram.pushMessage("/tasks");
  const activePickerCall = await telegram.waitForText("Выберите задачу:", { after: mark });
  const activeRows = activePickerCall.body.reply_markup.inline_keyboard;
  const heldTaskButton = activeRows.flat().find((button) => button.callback_data === `task:c:${firstThreadId}`);
  telegram.pushCallback(heldTaskButton.callback_data, activePickerCall.result);
  const heldSwitch = await telegram.waitForText("Текущая задача изменена", { after: mark });
  assert.equal((await readJson(statePath)).threadIds.codex, firstThreadId);

  mark = telegram.calls.length;
  telegram.pushCallback("show-last-message", heldSwitch.result);
  await telegram.waitForText("[hold] основной ход", { after: mark });
  assert.equal((await readJson(statePath)).threadIds.codex, firstThreadId,
    "show-last-message must select and display the first live task");

  mark = telegram.calls.length;
  telegram.pushCallback("show-message", parallelProgress.result);
  await telegram.waitForText(parallelPrompt, { after: mark });
  assert.equal((await readJson(statePath)).threadIds.codex, parallelThreadId,
    "show-message must select and display the second live task");
  assert.equal((await readJson(statePath)).activeRuns.length, 2,
    "switching views must not stop either task");

  mark = telegram.calls.length;
  telegram.pushMessage("/cancel");
  await telegram.waitForText("Запрошена остановка этой задачи", { after: mark });
  const restoredFinal = await telegram.waitForText("Ход остановлен тестом", { after: mark });
  assert.match(restoredFinal.body.text, /Кредиты за задачу: нет тарифа для gpt-e2e/);
  assert.match(restoredFinal.body.text, /^✅ Codex · /);
  await waitFor(async () => (await readJson(statePath)).activeRuns.length === 1,
    "cancelling the selected parallel task only");
  const stoppedJournalTurn = await waitFor(async () => {
    const ledger = await readJson(workLogLedgerPath).catch(() => null);
    return Object.values(ledger?.turns ?? {}).find((item) => (
      String(item.body ?? item.text ?? "").includes("Ход остановлен тестом")
    )) ?? null;
  }, "aborted Codex turn journal projection after restart");
  assert.notEqual(stoppedJournalTurn.status, "completed");
  assert.match(await readFile(workLogPath, "utf8"), /Ход остановлен тестом/);
  assert.equal(
    telegram.callsAfter(restoredFinal.index + 1, "sendPhoto").some((call) => (
      call.rawBody.includes("Кредиты за задачу:")
    )),
    false,
    "recovered turn usage must stay in the final answer",
  );

  mark = telegram.calls.length;
  telegram.pushMessage("/tasks");
  const remainingPickerCall = await telegram.waitForText("Выберите задачу:", { after: mark });
  const remainingHeldButton = remainingPickerCall.body.reply_markup.inline_keyboard.flat()
    .find((button) => button.callback_data === `task:c:${firstThreadId}`);
  telegram.pushCallback(remainingHeldButton.callback_data, remainingPickerCall.result);
  await telegram.waitForText("Текущая задача изменена", { after: mark });

  mark = telegram.calls.length;
  telegram.pushMessage("/tasks");
  const archivePickerCall = await telegram.waitForText("Выберите задачу:", { after: mark });
  telegram.pushCallback(callbackButton(archivePickerCall, "thread:archive").callback_data, archivePickerCall.result);
  const blockedArchive = await telegram.waitForCall(
    "answerCallbackQuery",
    (call) => call.body.show_alert === true && String(call.body.text).includes("завершите"),
    { after: mark },
  );
  assert.ok(blockedArchive);

  mark = telegram.calls.length;
  telegram.pushMessage("/cancel");
  await telegram.waitForText("Запрошена остановка этой задачи", { after: mark });
  const queuedFinal = await telegram.waitForText("Готово: очередь после остановки", { after: mark, timeoutMs: 12_000 });
  await waitFor(async () => (await readJson(statePath)).activeRuns.length === 0, "queued turn completion", 12_000);

  mark = telegram.calls.length;
  telegram.pushMessage("[hold] ход для глазок");
  await telegram.waitForText("[hold] ход для глазок", { after: mark });
  const finalSource = queuedFinal.result;
  const progressBeforeView = (await readJson(statePath)).activeRuns[0].progressMessageIds[0];

  mark = telegram.calls.length;
  telegram.pushCallback("show-last-message", finalSource);
  await telegram.waitForText("[hold] ход для глазок", { after: mark });
  const historyNavigation = await telegram.waitForText("Показано сообщений: 1", { after: mark });
  await telegram.waitForText("⚙ Agent Hub Server", { after: mark });
  const lastViewTexts = telegram.callsAfter(mark, "sendMessage").map((call) => String(call.body.text ?? ""));
  assert.equal(lastViewTexts.some((text) => text.includes("[hold] ход для глазок")), true,
    "show-last-message must attach to the current live turn");
  assert.equal(telegram.callsAfter(mark, "deleteMessages").some((call) => (
    call.body.message_ids.includes(progressBeforeView)
  )), true, "opening a live task must remove its old progress card");
  await waitFor(async () => {
    const ids = (await readJson(statePath)).activeRuns[0].progressMessageIds;
    return ids.length === 1 && !ids.includes(progressBeforeView);
  }, "live progress card replacement");
  const progressAfterView = (await readJson(statePath)).activeRuns[0].progressMessageIds;
  assert.equal(progressAfterView.includes(progressBeforeView), false,
    "the deleted progress id must not remain attached to the run");
  assert.equal(progressAfterView.length, 1,
    "the live progress card must be recreated below the compact history");

  const showMore = historyNavigation.body.reply_markup.inline_keyboard.flat()
    .find((button) => button.callback_data === `task-view:ha:c:${firstThreadId}:2`);
  assert.ok(showMore, "live history must expose show-more navigation");
  mark = telegram.calls.length;
  telegram.pushCallback(showMore.callback_data, historyNavigation.result);
  const secondHistoryNavigation = await telegram.waitForText("Показано сообщений: 2", { after: mark });
  await telegram.waitForText("[hold] ход для глазок", { after: mark });

  const showThird = secondHistoryNavigation.body.reply_markup.inline_keyboard.flat()
    .find((button) => button.callback_data === `task-view:ha:c:${firstThreadId}:3`);
  assert.ok(showThird, "the next history expansion must request exactly one additional exchange");
  mark = telegram.calls.length;
  telegram.pushCallback(showThird.callback_data, secondHistoryNavigation.result);
  await telegram.waitForText("Показано сообщений: 3", { after: mark });
  await telegram.waitForText("[hold] ход для глазок", { after: mark });

  telegram.pushMessage("/cancel");
  await waitFor(async () => (await readJson(statePath)).activeRuns.length === 0, "eye-test cancellation");

  mark = telegram.calls.length;
  telegram.failNext("sendMessage", 500);
  telegram.failNext("sendMessage", 500);
  telegram.pushMessage("ответ после сетевой ошибки");
  await telegram.waitForText("Готово: ответ после сетевой ошибки", { after: mark, timeoutMs: 12_000 });
  await waitFor(async () => {
    try {
      return (await readdir(path.join(dataDir, "delivery-outbox"))).length === 0;
    } catch {
      return true;
    }
  }, "delivery retry cleanup");

  mark = telegram.calls.length;
  telegram.pushMessage("[hold] восстановление после процесса");
  await telegram.waitForText("[hold] восстановление после процесса", { after: mark });
  const oldBot = bot;
  oldBot.kill("SIGTERM");
  await new Promise((resolve) => oldBot.once("exit", resolve));
  await startBot();
  await waitFor(async () => (await readJson(statePath)).activeRuns.length === 1, "restored active run");
  telegram.pushMessage("/cancel");
  await waitFor(async () => (await readJson(statePath)).activeRuns.length === 0, "restored run cancellation");

  const autoConfig = await readJson(configPath);
  autoConfig.autoApproveOnStart = true;
  await writeFile(configPath, `${JSON.stringify(autoConfig, null, 2)}\n`, "utf8");
  mark = telegram.calls.length;
  telegram.pushMessage("/approvals");
  const beforeOrphanMode = await telegram.waitForText("Ручной режим", { after: mark });
  const enableOrphanAuto = callbackButton(beforeOrphanMode, "approval-mode:auto");
  telegram.pushCallback(enableOrphanAuto.callback_data, beforeOrphanMode.result);
  await telegram.waitForCall("answerCallbackQuery", (call) => call.body.text === "Автоподтверждение включено", { after: mark });

  mark = telegram.calls.length;
  telegram.pushMessage("[orphan-approval] восстановление потерянного запроса");
  await telegram.waitForText("[orphan-approval] восстановление потерянного запроса", { after: mark });
  const orphanedBot = bot;
  orphanedBot.kill("SIGTERM");
  await new Promise((resolve) => orphanedBot.once("exit", resolve));
  await startBot();
  await telegram.waitForText("Продолжи текущую задачу с места остановки", {
    after: mark,
    timeoutMs: 15_000,
  });
  await waitFor(async () => (await readJson(statePath)).activeRuns.length === 0,
    "orphaned auto-approval recovery", 15_000);

  mark = telegram.calls.length;
  telegram.pushMessage("[crash-once] восстановление App Server");
  await telegram.waitForText("Восстановлено: [crash-once] восстановление App Server", {
    after: mark,
    timeoutMs: 15_000,
  });
  await waitFor(async () => (await readJson(statePath)).activeRuns.length === 0, "app-server crash recovery");

  mark = telegram.calls.length;
  telegram.pushMessage("/rename __E2E_EXTERNAL_HOLD__");
  await telegram.waitForText("Название закреплено", { after: mark });
  const externalRun = await waitFor(async () => {
    const runs = (await readJson(statePath)).activeRuns;
    return runs.length === 1 && runs[0].observer === true ? runs[0] : null;
  }, "silent external VSCode task discovery", 8_000);
  assert.equal(externalRun.executionOwner, "vscode");
  assert.equal(externalRun.displayRequested, false);
  assert.deepEqual(externalRun.progressMessageIds, [],
    "background discovery must not draw a progress card without an eye-button request");
  const botBeforeExternalRestore = bot;
  botBeforeExternalRestore.kill("SIGTERM");
  await new Promise((resolve) => botBeforeExternalRestore.once("exit", resolve));
  await startBot();
  const restoredExternalRun = await waitFor(async () => {
    const runs = (await readJson(statePath)).activeRuns;
    return runs.length === 1 && runs[0].observer === true ? runs[0] : null;
  }, "external VSCode task restored after bot restart", 8_000);
  assert.equal(restoredExternalRun.executionOwner, "vscode",
    "restoring an observed task must preserve its actual runtime owner");

  mark = telegram.calls.length;
  telegram.pushMessage("/tasks");
  const externalPicker = await telegram.waitForText("Выберите задачу:", { after: mark });
  const externalButton = externalPicker.body.reply_markup.inline_keyboard.flat()
    .find((button) => button.callback_data === `task:c:${externalRun.threadId}`);
  assert.ok(externalButton);
  mark = telegram.calls.length;
  telegram.pushCallback(externalButton.callback_data, externalPicker.result);
  const externalSelected = await telegram.waitForText("Текущая задача уже выбрана", { after: mark });
  const externalEye = externalSelected.body.reply_markup.inline_keyboard.flat()
    .find((button) => button.callback_data === `task-view:s:c:${externalRun.threadId}`);
  assert.ok(externalEye);
  mark = telegram.calls.length;
  telegram.pushCallback(externalEye.callback_data, externalSelected.result);
  await telegram.waitForText("VSCode App Server", { after: mark });
  await waitFor(async () => (await readJson(statePath)).activeRuns[0]?.progressMessageIds.length === 1,
    "external task progress shown on demand");
  mark = telegram.calls.length;
  telegram.pushMessage("/cancel");
  await telegram.waitForText("Codex не подтвердил остановку: no active turn to interrupt", { after: mark });
  await waitFor(async () => (await readJson(statePath)).activeRuns.length === 1,
    "failed external interrupt keeps observation and task lock");

  mark = telegram.calls.length;
  telegram.pushMessage("сообщение при неудачной остановке внешнего хода");
  const blockedInput = await telegram.waitForText("сообщение при неудачной остановке внешнего хода", { after: mark });
  const cancelBlockedInput = blockedInput.body.reply_markup.inline_keyboard.flat()
    .find((button) => button.callback_data.startsWith("pending:cancel:"));
  assert.ok(cancelBlockedInput, "a second turn must be deferred while the external task is still active");
  telegram.pushCallback(cancelBlockedInput.callback_data, blockedInput.result);
  await telegram.waitForCall("editMessageText", (call) => String(call.body.text).includes("отменено"), { after: mark });
  assert.equal((await readJson(statePath)).activeRuns.length, 1);

  mark = telegram.calls.length;
  telegram.pushMessage("/rename __E2E_EXTERNAL_RELEASE__");
  await telegram.waitForText("Название закреплено", { after: mark });
  const requestedExternalFinal = await telegram.waitForText("Внешний ход завершён тестом", {
    after: mark,
    timeoutMs: 12_000,
  });
  assert.notEqual(requestedExternalFinal.body.disable_notification, true,
    "an explicitly displayed external turn must keep a normal final notification");
  await waitFor(async () => (await readJson(statePath)).activeRuns.length === 0,
    "external observer completes only after the external turn really stops", 12_000);
  const externalJournalTurn = await waitFor(async () => {
    const ledger = await readJson(workLogLedgerPath).catch(() => null);
    return Object.values(ledger?.turns ?? {}).find((item) => (
      String(item.body ?? item.text ?? "").includes("Внешний ход завершён тестом")
    )) ?? null;
  }, "external Codex turn context in journal");
  assert.equal(externalJournalTurn.prompt, "[external-hold] VSCode task");

  mark = telegram.calls.length;
  telegram.pushMessage("сообщение после реальной остановки внешнего хода");
  await telegram.waitForText("Готово: сообщение после реальной остановки внешнего хода", {
    after: mark,
    timeoutMs: 12_000,
  });

  mark = telegram.calls.length;
  telegram.pushMessage("/rename __E2E_EXTERNAL_SHORT__");
  await telegram.waitForText("Название закреплено", { after: mark });
  await waitFor(async () => (await readJson(statePath)).activeRuns.length === 0,
    "short external turn completed between polls", 8_000);
  const backgroundExternalFinals = telegram.calls.slice(mark).filter((call) => (
    call.method === "sendMessage"
      && String(call.body.text ?? "").includes("Короткий внешний VSCode-ход завершён")
  ));
  assert.deepEqual(backgroundExternalFinals, [],
    "selecting a task must not deliver the full final of its background external turn");
  await waitFor(async () => (await readJson(statePath)).lastTaskMessages
    .some(([, message]) => String(message?.text ?? "").includes("Короткий внешний VSCode-ход завершён")),
  "suppressed external final in task history", 8_000);

  mark = telegram.calls.length;
  telegram.pushMessage("/rename __E2E_EXTERNAL_UNCHANGED__");
  await telegram.waitForText("Название закреплено", { after: mark });
  await waitFor(async () => {
    const runs = (await readJson(statePath)).activeRuns;
    return runs.length === 1 && runs[0].observer === true ? runs[0] : null;
  }, "external task with an existing answer is observed", 8_000);
  const botBeforeUnchangedRestore = bot;
  botBeforeUnchangedRestore.kill("SIGTERM");
  await new Promise((resolve) => botBeforeUnchangedRestore.once("exit", resolve));
  const offlineCodexState = await readJson(codexStatePath);
  const offlineThread = offlineCodexState.threads.find((thread) => (
    thread.turns.some((turn) => turn.prompt === "[external-unchanged] VSCode task")
  ));
  const offlineTurn = offlineThread.turns.find((turn) => (
    turn.prompt === "[external-unchanged] VSCode task"
  ));
  offlineTurn.status = "completed";
  offlineThread.updatedAt = Math.floor(Date.now() / 1000);
  await writeFile(codexStatePath, `${JSON.stringify(offlineCodexState, null, 2)}\n`, "utf8");
  await appendFile(offlineThread.externalRolloutPath, `${JSON.stringify({
    timestamp: new Date().toISOString(),
    type: "event_msg",
    payload: { type: "task_complete", turn_id: offlineTurn.id },
  })}\n`, "utf8");
  mark = telegram.calls.length;
  await startBot();
  await waitFor(async () => (await readJson(statePath)).activeRuns.length === 0,
    "offline external terminal reconciled after restart", 12_000);
  const offlineJournalTurn = await waitFor(async () => {
    const ledger = await readJson(workLogLedgerPath).catch(() => null);
    return Object.values(ledger?.turns ?? {}).find((turn) => turn.turnId === offlineTurn.id) ?? null;
  }, "offline external terminal written to the journal", 12_000);
  assert.equal(offlineJournalTurn.prompt, "[external-unchanged] VSCode task");
  assert.equal(offlineJournalTurn.status, "completed");
  await new Promise((resolve) => setTimeout(resolve, 2_500));
  const repeatedUnchangedAnswers = telegram.calls.slice(mark).filter((call) => (
    call.method === "sendMessage"
      && String(call.body.text ?? "").includes("Накопленный внешний текст")
  ));
  assert.deepEqual(repeatedUnchangedAnswers, [],
    "restored observer must not resend an unchanged accumulated answer");

  mark = telegram.calls.length;
  telegram.pushMessage("/new");
  await telegram.waitForText("Создан новый контекст Codex", { after: mark });
  mark = telegram.calls.length;
  telegram.pushMessage("/status");
  const statusCard = await telegram.waitForCall("sendPhoto", () => true, { after: mark });
  const statusMarkup = JSON.parse(multipartField(statusCard, "reply_markup"));
  assert.equal(statusMarkup.inline_keyboard.length, 4);
  assert.match(multipartField(statusCard, "caption"), /🧵НЕДАВНИЕ ЗАДАЧИ \(0\)🧵/);

  mark = telegram.calls.length;
  telegram.pushMessage("/agent");
  const agentPicker = await telegram.waitForText("Выберите агента:", { after: mark });
  telegram.pushCallback(callbackButton(agentPicker, "engine:claude").callback_data, agentPicker.result);
  await telegram.waitForText("Активный агент: Claude Code", { after: mark });
  assert.equal((await readJson(statePath)).activeProvider, "claude");
  mark = telegram.calls.length;
  telegram.pushMessage("проверка Claude");
  await telegram.waitForText("Claude готово: проверка Claude", { after: mark });
  await waitFor(async () => (await readJson(statePath)).activeRuns.length === 0, "Claude turn completion");
  mark = telegram.calls.length;
  telegram.pushMessage("/agent");
  const returnAgentPicker = await telegram.waitForText("Выберите агента:", { after: mark });
  telegram.pushCallback(callbackButton(returnAgentPicker, "engine:codex").callback_data, returnAgentPicker.result);
  await telegram.waitForText("Активный агент: Codex", { after: mark });
  assert.equal((await readJson(statePath)).activeProvider, "codex");

  mark = telegram.calls.length;
  telegram.pushMessage("/projects");
  const projectPicker = await telegram.waitForText("Выберите проект:", { after: mark });
  telegram.pushCallback(callbackButton(projectPicker, "p:1").callback_data, projectPicker.result);
  await telegram.waitForText("Активная папка: E2E-2", { after: mark });
  assert.equal(path.resolve((await readJson(statePath)).activeProjectRoot), path.resolve(secondProjectRoot));
  mark = telegram.calls.length;
  telegram.pushMessage("/new");
  await telegram.waitForText("Создан новый контекст Codex", { after: mark });
  mark = telegram.calls.length;
  telegram.pushMessage("[multi-project] общий журнал");
  await telegram.waitForText("Готово: [multi-project] общий журнал", {
    after: mark,
    timeoutMs: 12_000,
  });
  await waitFor(async () => (
    (await readFile(workLogPath, "utf8")).includes("[multi-project] общий журнал")
  ), "global multi-project journal projection");
  assert.doesNotMatch(await readFile(secondWorkLogPath, "utf8"), /\[multi-project\] общий журнал/);
  mark = telegram.calls.length;
  telegram.pushMessage("/projects");
  const returnProjectPicker = await telegram.waitForText("Выберите проект:", { after: mark });
  telegram.pushCallback(callbackButton(returnProjectPicker, "p:0").callback_data, returnProjectPicker.result);
  await telegram.waitForText("Активная папка: E2E", { after: mark });
  assert.equal(path.resolve((await readJson(statePath)).activeProjectRoot), path.resolve(projectRoot));

  mark = telegram.calls.length;
  telegram.pushMessage("/restart");
  telegram.pushMessage("сообщение из того же пакета после рестарта");
  const restarting = await telegram.waitForText("Перезапускаю Agent Hub", { after: mark });
  await telegram.waitForCall(
    "editMessageText",
    (call) => call.body.message_id === restarting.result.message_id
      && String(call.body.text).includes("AGENT HUB ПЕРЕЗАПУЩЕН"),
    { after: mark, timeoutMs: 12_000 },
  );
  await telegram.waitForText("Готово: сообщение из того же пакета после рестарта", {
    after: mark,
    timeoutMs: 12_000,
  });
  assert.equal(
    telegram.callsAfter(mark, "sendMessage").filter((call) => (
      String(call.body.text ?? "").includes("Готово: сообщение из того же пакета после рестарта")
    )).length,
    1,
    "an update already fetched beside /restart must be handled exactly once by the replacement",
  );
  await waitFor(async () => (await readJson(statePath)).activeRuns.length === 0,
    "post-restart turn completion");

  mark = telegram.calls.length;
  telegram.pushMessage("/archive");
  await telegram.waitForText("архивирована", { after: mark });

  assert.equal(stderr.includes("Unhandled asynchronous error"), false, stderr);
  assert.equal(stderr.includes("Telegram polling error (1; retry in 3000 ms)"), true,
    "the bot must survive an initial Telegram polling failure");
  assert.equal(stdout.includes("Agent Hub ready"), true, stdout);
});
