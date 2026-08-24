import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { callDesktopControl } from "../../desktop-control.mjs";
import { readRuntimeState } from "../../src/infrastructure/persistence/runtime-state-store.mjs";
import {
  CHAT_ID,
  delay,
  FakeTelegramApi,
  stopPid,
  USER_ID,
  waitFor,
} from "../../e2e/telegram-harness.mjs";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const BOT_FILE = path.join(ROOT, "agent-hub-main.mjs");
const FAKE_CODEX_FILE = path.join(ROOT, "e2e", "fake-codex-app-server.mjs");

test("local control client survives App Server exit during delayed startup and shares tasks", { timeout: 60_000 }, async (t) => {
  const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "telegram-local-control-e2e-"));
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
    projects: [{ name: "Local control E2E", path: projectRoot }],
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
    // The delayed initialize models a recovering App Server. The local control
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
  assert.equal(initial.apiVersion, 3);
  const initialCodexState = await readFile(codexStatePath, "utf8").then(JSON.parse);
  assert.equal(initialCodexState.initializeCompletedAt ?? null, null,
    "Desktop control waited for Codex initialization");
  assert.equal(initial.tasks.length, 1);
  const firstThreadId = initial.selected.threadId;
  assert.equal(firstThreadId, savedThreadId);
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
    ...initial.selected,
  }, { runtimeRoot });
  assert.equal(configured.settings.reasoning, "medium");
  const automatic = await callDesktopControl("update-setting", {
    name: "approvalMode",
    value: "auto",
  }, { runtimeRoot });
  assert.equal(automatic.settings.approvalMode, "auto");
  await callDesktopControl("update-setting", { name: "approvalMode", value: "manual" }, { runtimeRoot });
  for (const [name, value] of [
    ["streamOrderMode", "manual"],
    ["streamCardWidthMode", "fixed"],
    ["streamCardFixedWidth", 237],
    ["streamCardGapEnabled", true],
  ]) {
    await callDesktopControl("update-setting", { name, value }, { runtimeRoot });
  }
  const streamSettingsSnapshot = await callDesktopControl("snapshot", {}, { runtimeRoot });
  assert.deepEqual({
    streamOrderMode: streamSettingsSnapshot.settings.streamOrderMode,
    streamCardWidthMode: streamSettingsSnapshot.settings.streamCardWidthMode,
    streamCardFixedWidth: streamSettingsSnapshot.settings.streamCardFixedWidth,
    streamCardGapEnabled: streamSettingsSnapshot.settings.streamCardGapEnabled,
  }, {
    streamOrderMode: "manual",
    streamCardWidthMode: "fixed",
    streamCardFixedWidth: 237,
    streamCardGapEnabled: true,
  });
  const persistedStreamSettings = await readRuntimeState(dataDir);
  assert.deepEqual({
    streamOrderMode: persistedStreamSettings.streamOrderMode,
    streamCardWidthMode: persistedStreamSettings.streamCardWidthMode,
    streamCardFixedWidth: persistedStreamSettings.streamCardFixedWidth,
    streamCardGapEnabled: persistedStreamSettings.streamCardGapEnabled,
  }, {
    streamOrderMode: "manual",
    streamCardWidthMode: "fixed",
    streamCardFixedWidth: 237,
    streamCardGapEnabled: true,
  });
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
  const steerCountBeforeCompactionInput = Number(
    (await readFile(codexStatePath, "utf8").then(JSON.parse)).requestCounts["turn/steer"] ?? 0,
  );
  const compactingInput = await callDesktopControl("send-message", {
    text: "[long-final] must wait for context maintenance",
    provider: "codex",
    threadId: firstThreadId,
    clientUserMessageId: "desktop-message-during-compaction",
    followUpMode: "steer",
  }, { runtimeRoot });
  assert.equal(compactingInput.accepted, false);
  assert.equal(compactingInput.deferred, true);
  assert.equal(compactingInput.queued, true);
  assert.equal(compactingInput.reason, "context-maintenance");
  assert.equal(
    Number((await readFile(codexStatePath, "utf8").then(JSON.parse)).requestCounts["turn/steer"] ?? 0),
    steerCountBeforeCompactionInput,
    "input during compaction must not be steered into the compacting turn",
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
  const compactionQueuedCompletion = await waitFor(async () => {
    const snapshot = await callDesktopControl("snapshot", {}, { runtimeRoot });
    const receipt = snapshot.messageReceipts.find((item) => (
      item.clientUserMessageId === "desktop-message-during-compaction"
    ));
    const task = snapshot.tasks.find((item) => item.threadId === firstThreadId);
    const stillQueued = snapshot.deferredInputs.some((item) => (
      item.clientUserMessageId === "desktop-message-during-compaction"
    ));
    return receipt?.runId
      && receipt?.turnId
      && !stillQueued
      && snapshot.activeCount === 0
      && task?.running === false
      && task?.run == null
      && String(task?.lastAnswer ?? "").endsWith("ФИНАЛ_НЕ_ОБРЕЗАН")
      ? snapshot
      : null;
  }, "queued message completion after context compaction", 15_000).catch(async (error) => {
    const snapshot = await callDesktopControl("snapshot", {}, { runtimeRoot }).catch(() => null);
    throw new Error(`${error.message}; snapshot=${JSON.stringify({
      activeCount: snapshot?.activeCount,
      deferredInputs: snapshot?.deferredInputs,
      messageReceipts: snapshot?.messageReceipts,
      tasks: snapshot?.tasks?.map((task) => ({
        threadId: task.threadId,
        running: task.running,
        run: task.run,
        lastAnswer: task.lastAnswer,
        title: task.title,
        context: task.context,
      })),
    })}`);
  });
  const compactionQueuedTask = compactionQueuedCompletion.tasks.find((item) => (
    item.threadId === firstThreadId
  ));
  assert.equal(compactionQueuedTask.running, false);
  assert.equal(compactionQueuedTask.run, null);
  assert.ok(compactionQueuedTask.lastAnswer.length > 6_000);
  assert.match(compactionQueuedTask.lastAnswer, /ФИНАЛ_НЕ_ОБРЕЗАН$/u);
  const compactionQueuedReceipt = compactionQueuedCompletion.messageReceipts.find((item) => (
    item.clientUserMessageId === "desktop-message-during-compaction"
  ));
  assert.equal(compactionQueuedReceipt.accepted, true);
  assert.ok(compactionQueuedReceipt.runId);
  assert.ok(compactionQueuedReceipt.turnId);
  const stateAfterCompactionQueue = await readFile(codexStatePath, "utf8").then(JSON.parse);
  const compactionQueuedProviderItems = stateAfterCompactionQueue.threads
    .flatMap((thread) => thread.turns)
    .flatMap((turn) => turn.items)
    .filter((item) => item.clientId === "desktop-message-during-compaction");
  assert.equal(compactionQueuedProviderItems.length, 1, "deferred input reached the provider more than once");
  const compactionQueuedHistory = await waitFor(async () => {
    const result = await callDesktopControl("task-history", {
      provider: "codex",
      threadId: firstThreadId,
      limit: 10,
    }, { runtimeRoot });
    const exchange = result.items.find((item) => item.messages.some((message) => (
      message.clientUserMessageId === "desktop-message-during-compaction"
    )));
    return exchange?.answer?.endsWith("ФИНАЛ_НЕ_ОБРЕЗАН") ? { result, exchange } : null;
  }, "full queued answer history after context compaction", 5_000);
  assert.equal(compactionQueuedHistory.result.total, 2);
  assert.ok(compactionQueuedHistory.exchange.answer.length > 6_000);
  assert.match(compactionQueuedHistory.exchange.answer, /ФИНАЛ_НЕ_ОБРЕЗАН$/u);
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
      ...beforeCompaction.selected,
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
  // The local control socket is intentionally available before `initialize`
  // completes.  Killing that first process must not reject the Hub's
  // top-level startup and terminate the Hub itself.
  await delay(100);
  assert.equal(bot.exitCode, null, `Hub exited while reconnecting: ${stderr}`);
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
  }, "desktop context compaction reconnect", 5_000).catch(async (error) => {
    const state = await readFile(codexStatePath, "utf8").catch(() => "");
    throw new Error(`${error.message}; codexState=${state}; stderr=${stderr}`);
  });
  assert.match(compactedAfterDisconnect.compactionId, /^[0-9a-f-]{36}$/u);
  const replacementCodexPid = await waitFor(async () => {
    const value = Number((await readFile(codexPidPath, "utf8").catch(() => "")).trim());
    return value && value !== firstCodexPid ? value : null;
  }, "replacement Codex App Server", 5_000);
  assert.notEqual(replacementCodexPid, firstCodexPid);
  await waitFor(async () => {
    const snapshot = await callDesktopControl("snapshot", {}, { runtimeRoot });
    const task = snapshot.tasks.find((item) => item.threadId === firstThreadId);
    const context = task?.context;
    return context?.compaction?.id === compactedAfterDisconnect.compactionId
      && context.compaction.status === "completed"
      && !task.maintenance
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
  assert.equal(firstStart.accepted, true, JSON.stringify(firstStart));
  assert.equal(firstStart.threadId, firstThreadId);
  assert.equal(firstStart.clientUserMessageId, firstMessageId);
  assert.equal(firstStart.runId, null);
  assert.equal(firstStart.turnId, null);
  assert.equal(firstStart.queued, true);
  assert.equal(firstStart.reason, "message-intake");
  // A receipt is deliberately a fast acknowledgement and does not persist a
  // whole snapshot. Verify durable acceptance, then wait for asynchronous turn
  // materialization through the dedicated receipt projection.
  assert.equal("snapshot" in firstStart, false);
  const messageSnapshot = await waitFor(async () => {
    const snapshot = await callDesktopControl("snapshot", {}, { runtimeRoot });
    const receipt = snapshot.messageReceipts.find((item) => (
      item.clientUserMessageId === firstMessageId
    ));
    return receipt?.runId && receipt?.turnId ? snapshot : null;
  }, "durably accepted desktop message materialization", 5_000);
  assert.equal(messageSnapshot.selected.threadId, firstThreadId);
  const firstReceipt = messageSnapshot.messageReceipts.find((receipt) => (
    receipt.clientUserMessageId === firstMessageId
  ));
  assert.equal(firstReceipt.accepted, true);
  assert.ok(firstReceipt.runId);
  assert.ok(firstReceipt.turnId);
  assert.equal("fingerprint" in firstReceipt, false);
  const firstTurnId = firstReceipt.turnId;

  const secondTask = await callDesktopControl("new-task", { provider: "codex" }, { runtimeRoot });
  assert.notEqual(secondTask.selected.threadId, firstThreadId);
  const secondThreadId = secondTask.selected.threadId;
  const secondStart = await callDesktopControl("send-message", {
    text: "[slow] desktop B",
    provider: "codex",
    threadId: secondThreadId,
  }, { runtimeRoot });
  assert.equal(secondStart.accepted, true);
  const parallel = await waitFor(async () => {
    const snapshot = await callDesktopControl("snapshot", {}, { runtimeRoot });
    return snapshot.activeCount === 2 ? snapshot : null;
  }, "parallel durable desktop message materialization", 5_000);
  assert.equal(parallel.activeCount, 2, JSON.stringify({
    secondSelected: secondTask.selected,
    secondStart,
    activeRuns: parallel.runs,
  }));
  assert.equal(
    parallel.tasks.filter((item) => item.running).length,
    2,
    JSON.stringify(parallel.tasks.map((item) => ({
      workspaceId: item.workspaceId,
      streamId: item.streamId,
      threadId: item.threadId,
      selected: item.selected,
      running: item.running,
    }))),
  );

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
  assert.equal(steered.turnId, firstTurnId);
  assert.equal(steered.clientUserMessageId, steerMessageId);
  const deferred = await callDesktopControl("send-message", {
    text: "manual follow-up",
    provider: "codex",
    threadId: firstThreadId,
  }, { runtimeRoot });
  assert.equal(deferred.accepted, false);
  assert.equal(deferred.reason, "task-running");
  assert.equal(deferred.deferred, true);
  assert.equal(deferred.queued, undefined);
  const deferredSnapshot = await callDesktopControl("snapshot", {}, { runtimeRoot });
  assert.equal(deferredSnapshot.deferredInputs.length, 1);
  assert.equal(deferredSnapshot.deferredInputs[0].provider, "codex");
  assert.equal(deferredSnapshot.deferredInputs[0].threadId, firstThreadId);
  const completedEdits = [];
  const firstEditPromise = callDesktopControl("deferred-input", {
      id: deferred.id,
      action: "edit",
      text: "parallel duplicate, first edit",
    }, { runtimeRoot }).then((result) => {
      completedEdits.push("parallel duplicate, first edit");
      return result;
    });
  const editedDeferredPromise = callDesktopControl("deferred-input", {
      id: deferred.id,
      action: "edit",
      text: "parallel duplicate, edited",
    }, { runtimeRoot }).then((result) => {
      completedEdits.push("parallel duplicate, edited");
      return result;
    });
  const [firstEdit, editedDeferred] = await Promise.all([firstEditPromise, editedDeferredPromise]);
  assert.equal(firstEdit.accepted, true);
  assert.equal(editedDeferred.accepted, true);
  const finalEditedText = (await callDesktopControl("snapshot", {}, { runtimeRoot }))
    .deferredInputs.find((item) => item.id === deferred.id)?.text;
  assert.equal(completedEdits.includes(finalEditedText), true,
    "serialized edits must persist one of the two accepted values regardless of IPC response order");
  const queuedOnce = await callDesktopControl("deferred-input", {
    id: deferred.id,
    action: "queue",
  }, { runtimeRoot });
  const queuedTwice = await callDesktopControl("deferred-input", {
    id: deferred.id,
    action: "queue",
  }, { runtimeRoot });
  assert.equal(queuedOnce.accepted, true);
  assert.equal(queuedTwice.accepted, true);
  assert.equal(queuedTwice.queued, true);
  const [steeredQueued, duplicateSteer] = await Promise.all([
    callDesktopControl("deferred-input", { id: deferred.id, action: "steer" }, { runtimeRoot }),
    callDesktopControl("deferred-input", { id: deferred.id, action: "steer" }, { runtimeRoot }),
  ]);
  assert.equal(steeredQueued.accepted, true);
  assert.equal(duplicateSteer.accepted, true);
  assert.equal(steeredQueued.clientUserMessageId, deferred.clientUserMessageId);
  assert.equal(duplicateSteer.turnId, firstTurnId);
  assert.equal((await callDesktopControl("snapshot", {}, { runtimeRoot })).deferredInputs.length, 0);

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
    renamedSecond.tasks.find((item) => item.threadId === secondThreadId)?.threadTitle,
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
  assert.deepEqual(
    telegram.calls.filter((call) => ["sendMessage", "sendPhoto", "editMessageText"].includes(call.method)),
    [],
    "Desktop-started progress, approvals and final answers must stay out of Telegram",
  );
  const history = await waitFor(async () => {
    const result = await callDesktopControl("task-history", {
      provider: "codex",
      threadId: firstThreadId,
      limit: 10,
    }, { runtimeRoot });
    const slowExchange = result.items.find((item) => item.messages.some((message) => (
      message.clientUserMessageId === firstMessageId
    )));
    return result.total === 3 && /Готово: \[slow\] desktop A/u.test(slowExchange?.answer ?? "")
      ? result
      : null;
  }, "background task history hydration", 5_000);
  assert.equal(history.total, 3);
  const slowExchange = history.items.find((item) => item.messages.some((message) => (
    message.clientUserMessageId === firstMessageId
  )));
  assert.ok(slowExchange);
  assert.match(slowExchange.prompt, /^\[slow\] desktop A/u);
  assert.match(slowExchange.answer, /Готово: \[slow\] desktop A/);
  const userMessages = slowExchange.messages.filter((item) => item.role === "user");
  assert.deepEqual(userMessages.map((item) => item.clientUserMessageId), [
    firstMessageId,
    steerMessageId,
    deferred.clientUserMessageId,
  ]);
  assert.ok(userMessages.every((item) => (
    item.itemId && item.itemId !== item.clientUserMessageId
  )));

  const attachmentRoot = path.join(runtimeRoot, "attachments");
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
    /вне каталога вложений Agent Hub/,
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
  assert.equal(
    renamed.tasks.find((item) => item.threadId === firstThreadId)?.threadTitle,
    "Desktop renamed",
  );
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

  const loadTasks = [];
  for (let index = 0; index < 5; index += 1) {
    const created = await callDesktopControl("new-task", { provider: "codex" }, { runtimeRoot });
    loadTasks.push({
      provider: created.selected.provider,
      streamId: created.selected.streamId,
      threadId: created.selected.threadId,
      index,
    });
  }
  assert.equal(new Set(loadTasks.map((task) => task.streamId)).size, 5);
  const acknowledgementLatenciesMs = [];
  const sendMeasured = async (params) => {
    const startedAtMs = performance.now();
    const result = await callDesktopControl("send-message", params, { runtimeRoot });
    acknowledgementLatenciesMs.push(performance.now() - startedAtMs);
    return result;
  };
  const loadRoots = await Promise.all(loadTasks.map((task) => sendMeasured({
    text: `[slow] load root ${task.index}`,
    provider: task.provider,
    threadId: task.threadId,
    clientUserMessageId: `load-${task.index}-root`,
  })));
  assert.ok(loadRoots.every((result) => result.accepted && result.queued));
  await waitFor(async () => {
    const snapshot = await callDesktopControl("snapshot", {}, { runtimeRoot });
    const runningLoadTasks = snapshot.tasks.filter((task) => (
      loadTasks.some((candidate) => candidate.threadId === task.threadId) && task.running
    ));
    return runningLoadTasks.length === 5 ? snapshot : null;
  }, "five parallel desktop runs", 5_000);

  const loadDeferredPairs = await Promise.all(loadTasks.map(async (task) => {
    const [first, second] = await Promise.all([
      sendMeasured({
        text: `load queued A ${task.index}`,
        provider: task.provider,
        threadId: task.threadId,
        clientUserMessageId: `load-${task.index}-queue-a`,
      }),
      sendMeasured({
        text: `load queued B ${task.index}`,
        provider: task.provider,
        threadId: task.threadId,
        clientUserMessageId: `load-${task.index}-queue-b`,
      }),
    ]);
    assert.equal(first.deferred, true);
    assert.equal(second.deferred, true);
    return { task, first, second };
  }));
  await Promise.all(loadDeferredPairs.flatMap(({ first, second }) => [
    callDesktopControl("deferred-input", { id: first.id, action: "queue" }, { runtimeRoot }),
    callDesktopControl("deferred-input", { id: second.id, action: "queue" }, { runtimeRoot }),
  ]));
  const loadSteers = await Promise.all(loadDeferredPairs.map(({ first }) => (
    callDesktopControl("deferred-input", { id: first.id, action: "steer" }, { runtimeRoot })
  )));
  assert.ok(loadSteers.every((result) => result.accepted && result.turnId));

  const loadClientIds = loadTasks.flatMap((task) => [
    `load-${task.index}-root`,
    `load-${task.index}-queue-a`,
    `load-${task.index}-queue-b`,
  ]);
  const completedLoad = await waitFor(async () => {
    const snapshot = await callDesktopControl("snapshot", {}, { runtimeRoot });
    const receiptIds = new Set(snapshot.messageReceipts
      .filter((receipt) => receipt.runId && receipt.turnId)
      .map((receipt) => receipt.clientUserMessageId));
    const loadQueueIsEmpty = !snapshot.deferredInputs.some((input) => (
      loadClientIds.includes(input.clientUserMessageId)
    ));
    const loadTasksAreIdle = loadTasks.every((candidate) => {
      const task = snapshot.tasks.find((item) => item.threadId === candidate.threadId);
      return task && !task.running && task.run == null;
    });
    return loadQueueIsEmpty
      && loadTasksAreIdle
      && loadClientIds.every((clientUserMessageId) => receiptIds.has(clientUserMessageId))
      ? snapshot
      : null;
  }, "five-stream queued message completion", 20_000);
  assert.equal(completedLoad.deferredInputs.some((input) => (
    loadClientIds.includes(input.clientUserMessageId)
  )), false);
  const maxAcknowledgementLatencyMs = Math.max(...acknowledgementLatenciesMs);
  assert.ok(maxAcknowledgementLatencyMs < 2_000,
    `local acknowledgement exceeded 2 seconds: ${JSON.stringify(acknowledgementLatenciesMs)}`);
  t.diagnostic(`five-stream local ACK max ${maxAcknowledgementLatencyMs.toFixed(1)}ms`);

  const providerStateAfterLoad = await readFile(codexStatePath, "utf8").then(JSON.parse);
  const providerClientIdCounts = new Map();
  for (const item of providerStateAfterLoad.threads
    .flatMap((thread) => thread.turns)
    .flatMap((turn) => turn.items)) {
    if (!loadClientIds.includes(item.clientId)) continue;
    providerClientIdCounts.set(item.clientId, (providerClientIdCounts.get(item.clientId) ?? 0) + 1);
  }
  assert.deepEqual(
    loadClientIds.map((clientUserMessageId) => providerClientIdCounts.get(clientUserMessageId) ?? 0),
    Array.from({ length: loadClientIds.length }, () => 1),
  );
  for (const task of loadTasks) {
    const expectedHistoryClientIds = [
      `load-${task.index}-queue-a`,
      `load-${task.index}-queue-b`,
      `load-${task.index}-root`,
    ];
    const hydratedHistory = await waitFor(async () => {
      const result = await callDesktopControl("task-history", {
        provider: task.provider,
        threadId: task.threadId,
        limit: 10,
      }, { runtimeRoot });
      const historyClientIds = result.items
        .flatMap((exchange) => exchange.messages)
        .filter((message) => message.role === "user")
        .map((message) => message.clientUserMessageId)
        .filter((clientUserMessageId) => loadClientIds.includes(clientUserMessageId))
        .sort();
      const queuedExchange = result.items.find((exchange) => exchange.messages.some((message) => (
        message.clientUserMessageId === `load-${task.index}-queue-b`
      )));
      return result.total === 2
        && JSON.stringify(historyClientIds) === JSON.stringify(expectedHistoryClientIds)
        && new RegExp(`Готово: load queued B ${task.index}$`, "u").test(queuedExchange?.answer ?? "")
        ? { result, historyClientIds, queuedExchange }
        : null;
    }, `load history ${task.index}`, 5_000);
    assert.deepEqual(hydratedHistory.historyClientIds, expectedHistoryClientIds);
    assert.match(
      hydratedHistory.queuedExchange.answer,
      new RegExp(`Готово: load queued B ${task.index}$`, "u"),
    );
  }

  const archived = await callDesktopControl("archive-task", {
    provider: "codex",
    threadId: firstThreadId,
  }, { runtimeRoot });
  assert.notEqual(archived.selected.threadId, firstThreadId);
  assert.doesNotMatch(stderr, /Unhandled asynchronous error|Cannot start desktop control/i);
});
