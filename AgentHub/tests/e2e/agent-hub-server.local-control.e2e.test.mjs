import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { callDesktopControl as sendDesktopControl } from "../../desktop-control.mjs";
import { JournalDatabase } from "../../src/infrastructure/persistence/journal-database.mjs";
import { LocalTaskSyncStore } from "../../src/infrastructure/persistence/task-sync-store.mjs";
import { WorkspaceCatalogStore } from "../../src/infrastructure/persistence/workspace-catalog-store.mjs";
import { readRuntimeState } from "../../src/infrastructure/persistence/runtime-state-store.mjs";
import {
  CHAT_ID,
  diagnosticTail,
  e2eFailureArtifactDirectory,
  delay,
  E2eChildProcessOwner,
  FakeTelegramApi,
  stopPid,
  USER_ID,
  waitFor,
} from "../../e2e/telegram-harness.mjs";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const BOT_FILE = path.join(ROOT, "agent-hub-main.mjs");
const FAKE_CODEX_FILE = path.join(ROOT, "e2e", "fake-codex-app-server.mjs");

async function callDesktopControl(action, params, options) {
  const caller = new Error().stack;
  try {
    return await sendDesktopControl(action, params, options);
  } catch (error) {
    throw new Error(`${action}: ${error.message}\n${caller}`, { cause: error });
  }
}

test("local control client survives App Server exit during delayed startup and shares tasks", { timeout: 120_000 }, async (t) => {
  const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "telegram-local-control-e2e-"));
  const dataDir = path.join(runtimeRoot, "data");
  const projectRoot = path.join(runtimeRoot, "project");
  const configPath = path.join(runtimeRoot, "config.json");
  const codexStatePath = path.join(runtimeRoot, "fake-codex-state.json");
  const autoCompactionReleaseFile = path.join(runtimeRoot, "release-auto-compaction");
  const codexPidPath = path.join(runtimeRoot, "fake-codex.pid");
  const savedThreadId = "10000000-0000-4000-8000-000000000001";
  await Promise.all([mkdir(dataDir, { recursive: true }), mkdir(projectRoot, { recursive: true })]);
  const journalDatabase = new JournalDatabase(path.join(dataDir, "journal.sqlite"));
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
    nextTurn: 2,
    nextMessage: 3,
    // The delayed initialize models a recovering App Server. The local control
    // pipe must be available before that recovery finishes.
    initializeDelayMs: 1_500,
    // Keep the manual compaction observable long enough for the settings guard
    // assertion even on a loaded Windows host.
    manualCompactionDelayMs: 1_500,
    autoCompactionReleaseFile,
    threads: [{
      id: savedThreadId,
      cwd: projectRoot,
      name: "Saved large task",
      preview: "",
      updatedAt: Math.floor(Date.now() / 1000),
      turns: [{
        id: "00000000-0000-4000-8000-000000000001",
        status: "completed",
        prompt: "Ответь строго: AGENT_HUB_CONTEXT_PROBE_OK_V1",
        items: [{
          id: "synthetic-probe:user",
          clientId: "agent-hub-context-probe:e2e-synthetic",
          type: "userMessage",
          content: [{ type: "text", text: "Ответь строго: AGENT_HUB_CONTEXT_PROBE_OK_V1" }],
        }, {
          id: "synthetic-probe:agent",
          type: "agentMessage",
          text: "AGENT_HUB_CONTEXT_PROBE_OK_V1",
          phase: "final_answer",
        }],
      }],
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

  let stderr = "";
  let bot = null;
  let testCompleted = false;
  const controlWaits = [];
  const botOwner = new E2eChildProcessOwner({ label: "local-control Agent Hub" });
  const startBot = () => {
    bot = botOwner.start(() => spawn(process.execPath, [BOT_FILE], {
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
    }));
    bot.stderr.setEncoding("utf8");
    bot.stderr.on("data", (chunk) => { stderr += chunk; });
    return bot;
  };
  const stopBot = async () => {
    const current = bot;
    if (!current) return;
    await botOwner.stop();
    if (bot === current) bot = null;
  };
  const waitForControl = async (label) => {
    const observation = { label, startedAt: new Date().toISOString(), attempts: 0, lastError: null };
    controlWaits.push(observation);
    try {
      const snapshot = await waitFor(
        async () => {
          observation.attempts += 1;
          try {
            return await callDesktopControl("snapshot", {}, { runtimeRoot });
          } catch (error) {
            observation.lastError = { code: error.cause?.code ?? error.code ?? null,
              message: diagnosticTail(error.message, 1024), observedAt: new Date().toISOString() };
            throw error;
          }
        },
        label,
        8_000,
      );
      botOwner.recordEndpointOwner(snapshot.server?.process ?? null);
      observation.completedAt = new Date().toISOString();
      observation.outcome = "succeeded";
      return snapshot;
    } catch (error) {
      observation.completedAt = new Date().toISOString();
      observation.outcome = "failed";
      throw botOwner.failure(error, { stage: label, controlWaits });
    }
  };
  startBot();
  t.after(async () => {
    let cleanupError = null;
    try {
      await stopBot();
    } catch (error) {
      cleanupError = error;
    } finally {
      journalDatabase.close();
      await telegram.stop();
    }
    if (testCompleted) {
      await rm(runtimeRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } else {
      // The outer file runner removes TEMP after the failed child. Keep only
      // bounded diagnostics in the checkout's existing ignored WIP artifact area.
      const diagnosticDirectory = e2eFailureArtifactDirectory(ROOT, runtimeRoot);
      await mkdir(diagnosticDirectory, { recursive: true });
      const diagnosticPath = path.join(diagnosticDirectory, "e2e-process-diagnostics.json");
      let startupSpans;
      let traceDatabase;
      try {
        traceDatabase = new DatabaseSync(path.join(dataDir, "command-traces.sqlite"), { readOnly: true });
        startupSpans = traceDatabase.prepare("SELECT * FROM command_trace_spans WHERE stage LIKE 'startup-%' ORDER BY rowid DESC LIMIT 64")
          .all().map((span) => {
            const metadata = JSON.parse(span.metadata_json);
            return { stage: span.stage, outcome: span.outcome, observedAt: span.observed_at_ms,
              durationMs: span.monotonic_duration_ms,
              metadata: Object.fromEntries(["pid", "instanceId", "releaseId", "operationSpanId", "startupTraceId", "startedAtMs"]
                .filter((key) => Object.hasOwn(metadata, key)).map((key) => [key, metadata[key]])) };
          });
      } catch (error) {
        startupSpans = { unavailable: diagnosticTail(error.message, 1024) };
      } finally { traceDatabase?.close(); }
      await writeFile(diagnosticPath, `${JSON.stringify(botOwner.diagnostics({ controlWaits, startupSpans }), null, 2)}\n`, "utf8");
      t.diagnostic(`Preserved local-control failure diagnostics: ${diagnosticPath}`);
    }
    if (cleanupError) throw cleanupError;
  });

  const initial = await waitForControl("desktop control startup");
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

  const configuredModel = await callDesktopControl("update-setting", {
    name: "model",
    value: "gpt-6-astra",
    ...initial.selected,
  }, { runtimeRoot });
  assert.equal(configuredModel.settings.model, "gpt-6-astra");
  const codexStateAfterModelUpdate = await readFile(codexStatePath, "utf8").then(JSON.parse);
  assert.equal(codexStateAfterModelUpdate.requestCounts["thread/settings/update"], 2);
  assert.equal(codexStateAfterModelUpdate.requestCounts["thread/resume"], 1);
  assert.equal(
    codexStateAfterModelUpdate.threads.find((thread) => thread.id === firstThreadId)?.model,
    "gpt-6-astra",
  );
  const persistedStateAfterModelUpdate = await readRuntimeState(dataDir);
  assert.deepEqual(persistedStateAfterModelUpdate.codexTaskSettings[firstThreadId], {
    model: "gpt-6-astra",
    reasoningEffort: "high",
  });
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
    followUpMode: "queue",
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
  await writeFile(autoCompactionReleaseFile, "release", "utf8");
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
  const syntheticProbeTurnIds = stateAfterCompactionQueue.threads
    .flatMap((thread) => thread.turns)
    .filter((turn) => turn.items.some((item) => (
      String(item.clientId ?? "").startsWith("agent-hub-context-probe:")
    )))
    .map((turn) => turn.id);
  assert.deepEqual(syntheticProbeTurnIds, ["00000000-0000-4000-8000-000000000001"],
    "context maintenance must not generate a synthetic turn beyond the retained fixture history");
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
  assert.equal(compactionQueuedHistory.result.items.filter((item) => (
    !syntheticProbeTurnIds.includes(item.id)
  )).length, 2);
  assert.ok(compactionQueuedHistory.exchange.answer.length > 6_000);
  assert.match(compactionQueuedHistory.exchange.answer, /ФИНАЛ_НЕ_ОБРЕЗАН$/u);
  const beforeCompaction = await callDesktopControl("snapshot", {}, { runtimeRoot });
  const contextBefore = beforeCompaction.tasks.find((item) => item.threadId === firstThreadId)?.context;
  assert.equal(contextBefore.usedTokens, 130);
  assert.equal(contextBefore.modelContextWindow, 200_000);
  const compacted = await callDesktopControl("compact-context", {
    provider: "codex",
    threadId: firstThreadId,
  }, { runtimeRoot }).catch(async (error) => {
    const snapshot = await callDesktopControl("snapshot", {}, { runtimeRoot }).catch(() => null);
    const state = await readRuntimeState(dataDir).catch(() => null);
    throw new Error(`${error.message}; snapshot=${JSON.stringify({
      activeCount: snapshot?.activeCount,
      task: snapshot?.tasks?.find((item) => item.threadId === firstThreadId),
      activeRuns: state?.activeRuns,
    })}`);
  });
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
  }, "desktop context compaction", 5_000).catch(async error => {
    const snapshot = await callDesktopControl("snapshot", {}, { runtimeRoot });
    const task = snapshot.tasks.find(item => item.threadId === firstThreadId);
    throw new Error(`${error.message}; compaction readback=${JSON.stringify({
      running: task?.running, context: task?.context,
      run: task?.run && { turnId: task.run.turnId, operationKind: task.run.operationKind },
    })}`, { cause: error });
  });
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

  const startupProcess = (await callDesktopControl("snapshot", {}, { runtimeRoot })).server.process;
  const startupHealth = await callDesktopControl("runtime-health", {}, { runtimeRoot });
  assert.equal(startupHealth.live, true);
  assert.equal(startupHealth.ready, true);
  assert.equal(startupHealth.process.pid, startupProcess.pid);
  assert.equal(startupHealth.process.releaseId, startupProcess.releaseId);
  const expectedStartupStages = ["configuration", "infrastructure", "web", "desktop-control", "runtime-command", "hub-mcp", "history",
    "provider", "runs", "readiness", "timers"].map((stage) => `startup-${stage}`);
  const startupSpans = await waitFor(() => {
    const traceDatabase = new DatabaseSync(path.join(dataDir, "command-traces.sqlite"), { readOnly: true });
    try {
      const spans = traceDatabase.prepare("SELECT * FROM command_trace_spans WHERE stage LIKE 'startup-%'")
        .all().map((span) => ({ ...span, metadata: JSON.parse(span.metadata_json) }))
        .filter((span) => span.metadata.instanceId === startupProcess.instanceId);
      return expectedStartupStages.every((stage) => spans.some((span) => span.stage === stage
        && span.outcome === "succeeded")) ? spans : null;
    } finally { traceDatabase.close(); }
  }, "startup measurements persisted through production composition", 5_000);
  for (const span of startupSpans.filter((entry) => expectedStartupStages.includes(entry.stage))) {
    assert.equal(span.metadata.releaseId, startupProcess.releaseId);
    if (span.outcome !== "succeeded") continue;
    assert.ok(startupSpans.some((entry) => entry.outcome === "started"
      && entry.stage === span.stage && entry.metadata.operationSpanId === span.metadata.operationSpanId),
    `${span.stage} must retain its start marker and terminal measurement`);
    assert.ok(span.monotonic_duration_ms >= 0);
  }

  const firstMessageId = "desktop-message-first";
  const steerMessageId = "desktop-message-steer";
  const firstStart = await callDesktopControl("send-message", {
    text: "[slow][unkeyed-history-tail] desktop A",
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
  assert.equal(steered.steerPending, true);
  assert.equal(steered.deferred, false);
  assert.equal(steered.queued, false);
  assert.equal(steered.turnId, firstTurnId);
  assert.equal(steered.clientUserMessageId, steerMessageId);
  const additionalSteerMessageIds = [
    "desktop-message-steer-2",
    "desktop-message-steer-3",
    "desktop-message-steer-4",
  ];
  for (const [index, clientUserMessageId] of additionalSteerMessageIds.entries()) {
    const additional = await callDesktopControl("send-message", {
      text: `Точное уточнение ${index + 2}`,
      provider: "codex",
      threadId: firstThreadId,
      clientUserMessageId,
      followUpMode: "steer",
    }, { runtimeRoot });
    assert.equal(additional.accepted, true);
    assert.equal(additional.turnId, firstTurnId);
  }
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
  const deferredEntry = deferredSnapshot.deferredInputs.find((item) => item.id === deferred.id);
  assert.ok(deferredEntry, JSON.stringify(deferredSnapshot.deferredInputs));
  assert.equal(deferredEntry.provider, "codex");
  assert.equal(deferredEntry.threadId, firstThreadId);
  await assert.rejects(callDesktopControl("deferred-input", {
    id: deferred.id,
    action: "edit",
    text: "legacy edit",
  }, { runtimeRoot }), /только через возврат в основной композер/u);
  const preparedComposer = await callDesktopControl("deferred-input", {
    id: deferred.id,
    action: "composer-prepare",
  }, { runtimeRoot });
  assert.equal(preparedComposer.draft.text, "manual follow-up");
  await callDesktopControl("deferred-input", {
    id: deferred.id,
    action: "composer-release",
    token: preparedComposer.token,
  }, { runtimeRoot });
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
  const acceptedIds = [
    firstMessageId,
    steerMessageId,
    ...additionalSteerMessageIds,
    deferred.clientUserMessageId,
  ];

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
    return result.total === 4
      && /Готово: \[slow\]\[unkeyed-history-tail\] desktop A/u.test(slowExchange?.answer ?? "")
      ? result
      : null;
  }, "background task history hydration", 5_000).catch(async (error) => {
    const result = await callDesktopControl("task-history", {
      provider: "codex", threadId: firstThreadId, limit: 10,
    }, { runtimeRoot });
    throw new Error(`${error.message}; history=${JSON.stringify(result.items.map((item) => ({
      id: item.id, prompt: item.prompt, answer: item.answer?.slice(0, 150),
      clientIds: item.messages.map((message) => message.clientUserMessageId),
    })))}`, { cause: error });
  });
  assert.equal(history.total, 4);
  assert.equal(history.items.find((item) => syntheticProbeTurnIds.includes(item.id))?.answer,
    "AGENT_HUB_CONTEXT_PROBE_OK_V1", "retained marker-shaped history remains visible");
  const slowExchange = history.items.find((item) => item.messages.some((message) => (
    message.clientUserMessageId === firstMessageId
  )));
  assert.ok(slowExchange);
  assert.match(slowExchange.prompt, /^\[slow\]\[unkeyed-history-tail\] desktop A/u);
  assert.match(slowExchange.answer, /Готово: \[slow\]\[unkeyed-history-tail\] desktop A/);
  const userMessages = slowExchange.messages.filter((item) => item.role === "user");
  assert.deepEqual(
    userMessages.map((item) => item.clientUserMessageId).filter(Boolean),
    acceptedIds,
  );
  const providerStateAfterUnkeyedRefresh = await readFile(codexStatePath, "utf8").then(JSON.parse);
  for (const clientUserMessageId of acceptedIds) {
    const effects = providerStateAfterUnkeyedRefresh.threads
      .flatMap((thread) => thread.turns)
      .flatMap((turn) => turn.items)
      .filter((item) => item.clientId === clientUserMessageId);
    assert.equal(effects.length, 1, `provider repeated exact message ${clientUserMessageId}`);
  }
  const navigationReload = await callDesktopControl("task-history", {
    provider: "codex",
    threadId: firstThreadId,
    limit: 10,
  }, { runtimeRoot });
  const reloadedExchange = navigationReload.items.find((item) => item.id === firstTurnId);
  assert.deepEqual(
    reloadedExchange.messages
      .filter((item) => item.role === "user")
      .map((item) => item.clientUserMessageId)
      .filter(Boolean),
    acceptedIds,
  );

  // Exercise the production observer path rather than only the merge helper:
  // the fake App Server exposes a real VS Code rollout, local control discovers
  // it, and repeated task-history hydration crosses reader -> snapshot service
  // -> observation/read-model projection. A malformed tail makes the exact
  // turn explicitly incremental, reproducing the original 1->2->3->4 class.
  await callDesktopControl("rename-task", {
    provider: "codex",
    threadId: firstThreadId,
    title: "__E2E_EXTERNAL_UNCHANGED__",
  }, { runtimeRoot });
  const externalState = await waitFor(async () => {
    const state = await readFile(codexStatePath, "utf8").then(JSON.parse);
    const thread = state.threads.find((item) => item.id === firstThreadId);
    const turn = thread?.turns.find((item) => item.prompt === "[external-unchanged] VSCode task");
    return turn?.id && thread?.externalRolloutPath
      ? { turnId: turn.id, rolloutPath: thread.externalRolloutPath }
      : null;
  }, "unchanged external rollout creation", 5_000);
  await appendFile(externalState.rolloutPath, "{malformed-incremental-tail}\n", "utf8");
  const readExternalOccurrenceIds = async () => {
    const result = await callDesktopControl("task-history", {
      provider: "codex",
      threadId: firstThreadId,
      limit: 20,
      refreshSource: true,
    }, { runtimeRoot });
    const exchange = result.items.find((item) => item.id === externalState.turnId);
    const users = (exchange?.messages ?? [])
      .filter((message) => (
        message.role === "user"
        && message.text === "[external-unchanged] VSCode task"
        && (message.clientUserMessageId || message.sourceOccurrenceId)
      ));
    // The keyed root keeps its canonical command identity across adapters;
    // independent unkeyed observations must retain their exact source identity.
    return users.map((message) => message.clientUserMessageId || message.sourceOccurrenceId);
  };
  const initialExternalOccurrenceIds = await waitFor(async () => {
    const ids = await readExternalOccurrenceIds();
    return ids.length === 2 && ids.includes(`fake-vscode-${externalState.turnId}`) ? ids : null;
  }, "incremental external history hydration", 5_000);
  for (let replay = 0; replay < 4; replay += 1) {
    assert.deepEqual(
      await readExternalOccurrenceIds(),
      initialExternalOccurrenceIds,
      `unchanged incremental replay ${replay + 1} multiplied an occurrence`,
    );
  }
  await appendFile(externalState.rolloutPath, `${JSON.stringify({
    timestamp: new Date().toISOString(),
    type: "response_item",
    payload: {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "[external-unchanged] VSCode task" }],
      internal_chat_message_metadata_passthrough: { turn_id: externalState.turnId },
    },
  })}\n`, "utf8");
  const appendedExternalOccurrenceIds = await waitFor(async () => {
    const ids = await readExternalOccurrenceIds();
    return ids.length === initialExternalOccurrenceIds.length + 1 ? ids : null;
  }, "new identical external occurrence", 5_000);
  assert.deepEqual(
    appendedExternalOccurrenceIds.slice(0, initialExternalOccurrenceIds.length),
    initialExternalOccurrenceIds,
  );
  for (let replay = 0; replay < 3; replay += 1) {
    assert.deepEqual(await readExternalOccurrenceIds(), appendedExternalOccurrenceIds);
  }
  const readDurableExternalOccurrences = () => {
    const db = new DatabaseSync(path.join(dataDir, "journal.sqlite"), { readOnly: true });
    try { return db.prepare(`SELECT m.client_user_message_id,m.source_occurrence_id
      FROM task_read_model_messages m JOIN task_read_model_turns t ON t.provider=m.provider AND t.thread_id=m.thread_id AND t.position=m.turn_position
      WHERE t.provider='codex' AND t.thread_id=? AND t.id=? AND m.role='user' ORDER BY m.position`).all(firstThreadId, externalState.turnId); }
    finally { db.close(); }
  };
  const durableBeforeRestart = readDurableExternalOccurrences();
  assert.deepEqual(durableBeforeRestart.map((row) => row.client_user_message_id || row.source_occurrence_id), appendedExternalOccurrenceIds, "restart fixture must first commit exact canonical occurrence order");
  await stopBot();
  startBot();
  await waitForControl("incremental observer restart");
  let restartOccurrenceIds = [];
  const restoredOccurrenceIds = await waitFor(async () => {
      const ids = await readExternalOccurrenceIds();
      restartOccurrenceIds = ids;
      // Control becomes available before rollout recovery. Equal cardinality
      // can still contain provisional App Server identities; await exact ones.
      return ids.length === appendedExternalOccurrenceIds.length
        && ids.every((id, index) => id === appendedExternalOccurrenceIds[index]) ? ids : null;
    }, "incremental occurrence recovery after restart", 8_000).catch((error) => {
      throw new Error(`${error.message}; expected=${JSON.stringify(appendedExternalOccurrenceIds)}; actual=${JSON.stringify(restartOccurrenceIds)}; before=${JSON.stringify(durableBeforeRestart)}; after=${JSON.stringify(readDurableExternalOccurrences())}`);
    });
  assert.deepEqual(
    restoredOccurrenceIds,
    appendedExternalOccurrenceIds,
  );
  await callDesktopControl("rename-task", {
    provider: "codex",
    threadId: firstThreadId,
    title: "__E2E_EXTERNAL_UNCHANGED_RELEASE__",
  }, { runtimeRoot });
  await waitFor(async () => {
    const [snapshot, runtimeState, providerState] = await Promise.all([
      callDesktopControl("snapshot", {}, { runtimeRoot }),
      readRuntimeState(dataDir),
      readFile(codexStatePath, "utf8").then(JSON.parse),
    ]);
    const task = snapshot.tasks.find((item) => item.threadId === firstThreadId);
    const providerThread = providerState.threads.find((item) => item.id === firstThreadId);
    const providerTurn = providerThread?.turns.find((item) => item.id === externalState.turnId);
    const runSettled = !runtimeState.activeRuns.some((run) => (
      run.provider === "codex"
      && run.threadId === firstThreadId
      && ["running", "finishing"].includes(run.status)
    ));
    return task && !task.running && providerTurn?.status !== "inProgress" && runSettled
      ? snapshot
      : null;
  }, "unchanged external rollout release", 8_000);

  const pairedTask = await callDesktopControl("new-task", { provider: "codex" }, { runtimeRoot });
  const pairedThreadId = pairedTask.selected.threadId;
  const pairedClientIds = ["paired-rollout-client-one", "paired-rollout-client-two"];
  const pairedPrompt = "[rollout-exact-pair] одинаковый последовательный ввод";
  const readPairedHistory = () => callDesktopControl("task-history", {
    provider: "codex",
    threadId: pairedThreadId,
    limit: 10,
  }, { runtimeRoot });
  for (const clientUserMessageId of pairedClientIds) {
    const sent = await callDesktopControl("send-message", {
      text: pairedPrompt,
      provider: "codex",
      threadId: pairedThreadId,
      clientUserMessageId,
    }, { runtimeRoot });
    assert.equal(sent.accepted, true);
    await waitFor(async () => {
      const history = await readPairedHistory();
      const exchange = history.items.find((item) => item.messages.some((message) => (
        message.clientUserMessageId === clientUserMessageId
      )));
      return exchange?.completed === true ? history : null;
    }, `paired rollout completion ${clientUserMessageId}`, 5_000);
  }
  const assertPairedProjection = async () => {
    const history = await waitFor(async () => {
      const candidate = await readPairedHistory();
      const candidateExchanges = pairedClientIds.map((clientUserMessageId) => (
        candidate.items.find((item) => item.messages.some((message) => (
          message.clientUserMessageId === clientUserMessageId
        )))
      ));
      return candidateExchanges.every((exchange) => (
        exchange?.completed === true
        && exchange.messages.filter((message) => message.role === "user").length === 1
        && exchange.messages.filter((message) => (
          message.role === "agent" && message.kind !== "subagent"
        )).length === 1
      )) ? candidate : null;
    }, "stable paired rollout projection", 5_000);
    const exchanges = pairedClientIds.map((clientUserMessageId) => history.items.find((item) => (
      item.messages.some((message) => message.clientUserMessageId === clientUserMessageId)
    )));
    assert.equal(exchanges.every(Boolean), true, JSON.stringify(history.items));
    for (const [index, exchange] of exchanges.entries()) {
      const users = exchange.messages.filter((message) => message.role === "user");
      const assistants = exchange.messages.filter((message) => (
        message.role === "agent" && message.kind !== "subagent"
      ));
      assert.equal(users.length, 1, JSON.stringify(users));
      assert.equal(users[0].clientUserMessageId, pairedClientIds[index]);
      assert.equal(assistants.length, 1, JSON.stringify(assistants));
    }
    return history;
  };
  await assertPairedProjection();
  const pairedProviderState = await readFile(codexStatePath, "utf8").then(JSON.parse);
  const pairedProviderEffects = pairedProviderState.threads
    .find((thread) => thread.id === pairedThreadId)
    ?.turns.flatMap((turn) => turn.items)
    .filter((item) => pairedClientIds.includes(item.clientId)) ?? [];
  assert.deepEqual(
    pairedProviderEffects.map((item) => item.clientId).sort(),
    pairedClientIds.slice().sort(),
  );
  await assertPairedProjection();
  await callDesktopControl("select-task", {
    provider: "codex",
    threadId: firstThreadId,
  }, { runtimeRoot });
  await callDesktopControl("select-task", {
    provider: "codex",
    threadId: pairedThreadId,
  }, { runtimeRoot });
  await assertPairedProjection();
  await stopBot();
  startBot();
  await waitForControl("paired rollout restart");
  await assertPairedProjection();

  const recoveryThreadId = "e2e-corrupted-terminal-thread";
  const recoveryTurnId = "e2e-corrupted-terminal-turn";
  const recoveryRunId = "e2e-corrupted-terminal-run";
  const recoveryIds = Array.from({ length: 6 }, (_, index) => `e2e-recovery-message-${index + 1}`);
  const recoveryUsers = recoveryIds.map((clientUserMessageId, index) => ({
    itemId: `e2e-provider-user-${index + 1}`,
    clientUserMessageId,
    role: "user",
    text: index < 2 ? "Одинаковый recovery текст" : `Recovery message ${index + 1}`,
  }));
  const journalFile = path.join(dataDir, "journal.sqlite");
  const terminalFile = path.join(dataDir, "runtime.sqlite");
  const ledgerFile = path.join(dataDir, "message-command-ledger.sqlite");
  const readRecoveredUsers = async () => {
    const result = await callDesktopControl("task-history", {
      provider: "codex",
      threadId: recoveryThreadId,
      limit: 10,
    }, { runtimeRoot });
    return result.items.find((item) => item.id === recoveryTurnId)?.messages
      ?.filter((item) => item.role === "user") ?? [];
  };
  const readSearchSourceGroups = () => {
    const database = new DatabaseSync(journalFile, { readOnly: true });
    try {
      return database.prepare(`
        SELECT source, COUNT(*) AS count
        FROM task_message_search_documents
        WHERE provider = 'codex' AND thread_id = ? AND turn_id = ?
        GROUP BY source ORDER BY source
      `).all(recoveryThreadId, recoveryTurnId).map((row) => ({
        source: row.source,
        count: Number(row.count),
      }));
    } finally {
      database.close();
    }
  };
  const startAndWaitForControl = async (label) => {
    startBot();
    return waitForControl(label);
  };

  await stopBot();
  await journalDatabase.upsertRecords([{
    provider: "codex",
    threadId: recoveryThreadId,
    taskThreadId: recoveryThreadId,
    turnId: recoveryTurnId,
    projectRoot,
    status: "completed",
    prompt: "Canonical recovery root",
    body: "Recovery final",
    startedAt: "2026-09-04T08:00:00.000Z",
    completedAt: "2026-09-04T08:01:00.000Z",
  }]);
  const recoveryTask = {
    provider: "codex",
    threadId: recoveryThreadId,
    projectRoot,
    title: "Corrupted terminal recovery",
    running: false,
    updatedAtMs: Date.now(),
  };
  const recoveryWorkspaceCatalog = new WorkspaceCatalogStore({ databaseFile: journalFile });
  await recoveryWorkspaceCatalog.load();
  try {
    recoveryWorkspaceCatalog.assignCatalogEntries([recoveryTask]);
  } finally {
    recoveryWorkspaceCatalog.close();
  }
  const recoveryStore = new LocalTaskSyncStore({
    filePath: path.join(dataDir, "task-sync.json"),
    databaseFile: journalFile,
    terminalDatabaseFile: terminalFile,
    messageCommandDatabaseFile: ledgerFile,
  });
  await recoveryStore.load();
  await recoveryStore.recordCatalog([recoveryTask], Date.now());
  await recoveryStore.recordHistory(recoveryTask, [{
    id: recoveryTurnId,
    prompt: "Corrupted tail",
    answer: "Recovery final",
    status: "completed",
    active: false,
    completed: true,
    messages: [
      { itemId: `${recoveryTurnId}:rollout-user:0`, role: "user", text: "Corrupted tail" },
      { itemId: `${recoveryTurnId}:agent:final`, role: "agent", text: "Recovery final" },
    ],
  }]);
  recoveryStore.close();
  const recoveryTerminalPayloadJson = JSON.stringify({
    history: {
      id: recoveryRunId,
      provider: "codex",
      threadId: recoveryThreadId,
      turnId: recoveryTurnId,
      promptPreview: "Canonical recovery root",
      userMessages: recoveryUsers,
    },
  });
  const terminalSeed = new DatabaseSync(terminalFile);
  terminalSeed.prepare(`
    INSERT INTO provider_turn_terminals (
      provider, thread_id, turn_id, terminal_revision, status, final_answer,
      usage_identity, last_message_json, payload_json, payload_bytes, content_hash, committed_at
    ) VALUES ('codex', ?, ?, 1, 'completed', ?, '', NULL, ?, ?, 'e2e-terminal-recovery', ?)
    ON CONFLICT(provider, thread_id, turn_id) DO UPDATE SET
      terminal_revision = excluded.terminal_revision,
      status = excluded.status,
      final_answer = excluded.final_answer,
      payload_json = excluded.payload_json,
      payload_bytes = excluded.payload_bytes,
      content_hash = excluded.content_hash,
      committed_at = excluded.committed_at
  `).run(
    recoveryThreadId,
    recoveryTurnId,
    "Recovery final",
    recoveryTerminalPayloadJson,
    Buffer.byteLength(recoveryTerminalPayloadJson, "utf8"),
    new Date().toISOString(),
  );
  terminalSeed.close();
  const terminalVerification = new DatabaseSync(terminalFile, { readOnly: true });
  const exactTerminalRow = terminalVerification.prepare(`
    SELECT thread_id, turn_id, payload_json FROM provider_turn_terminals
    WHERE provider = 'codex' AND thread_id = ? AND turn_id = ?
  `).get(recoveryThreadId, recoveryTurnId);
  terminalVerification.close();
  assert.ok(exactTerminalRow);
  assert.equal(exactTerminalRow.thread_id, recoveryThreadId);
  assert.equal(exactTerminalRow.turn_id, recoveryTurnId);
  const terminalPayload = JSON.parse(exactTerminalRow.payload_json);
  assert.deepEqual(
    terminalPayload.history.userMessages.map((item) => item.clientUserMessageId),
    recoveryIds,
    "terminal payload must retain the six exact accepted identities",
  );

  const readModel = new DatabaseSync(journalFile);
  const turnPosition = Number(readModel.prepare(`
    SELECT position FROM task_read_model_turns
    WHERE provider = 'codex' AND thread_id = ? AND id = ?
  `).get(recoveryThreadId, recoveryTurnId).position);
  const firstUserPosition = Number(readModel.prepare(`
    SELECT MIN(position) AS position FROM task_read_model_messages
    WHERE provider = 'codex' AND thread_id = ? AND turn_position = ? AND role = 'user'
  `).get(recoveryThreadId, turnPosition).position);
  readModel.prepare(`
    DELETE FROM task_read_model_messages
    WHERE provider = 'codex' AND thread_id = ? AND turn_position = ?
      AND role = 'user' AND position <> ?
  `).run(recoveryThreadId, turnPosition, firstUserPosition);
  readModel.prepare(`
    UPDATE task_read_model_messages
    SET item_id = ?, client_user_message_id = NULL, text = 'Corrupted tail',
        author = '', origin_json = '{}'
    WHERE provider = 'codex' AND thread_id = ? AND turn_position = ? AND position = ?
  `).run(`${recoveryTurnId}:rollout-user:0`, recoveryThreadId, turnPosition, firstUserPosition);
  readModel.prepare(`
    UPDATE task_read_model_turns SET user_message_authority = ''
    WHERE provider = 'codex' AND thread_id = ? AND position = ?
  `).run(recoveryThreadId, turnPosition);
  readModel.close();

  const ledger = new DatabaseSync(ledgerFile);
  const ledgerRows = new Map(recoveryIds.map((clientUserMessageId) => {
    const exact = {
      provider: "codex",
      threadId: recoveryThreadId,
      turnId: recoveryTurnId,
      runId: recoveryRunId,
      clientUserMessageId,
    };
    return [clientUserMessageId, {
      item_json: JSON.stringify(exact),
      receipt_json: JSON.stringify({ ...exact, result: exact }),
      result_json: JSON.stringify(exact),
    }];
  }));
  const insertRecoveryLedger = ledger.prepare(`
    INSERT INTO message_commands (
      client_user_message_id, state, item_json, receipt_json, result_json,
      accepted_at_ms, terminal_at_ms, updated_at_ms, revision
    ) VALUES (?, 'completed', ?, ?, ?, 1, 2, 2, 1)
    ON CONFLICT(client_user_message_id) DO UPDATE SET
      state = excluded.state,
      item_json = excluded.item_json,
      receipt_json = excluded.receipt_json,
      result_json = excluded.result_json,
      terminal_at_ms = excluded.terminal_at_ms,
      updated_at_ms = excluded.updated_at_ms,
      revision = message_commands.revision + 1
  `);
  for (const [clientUserMessageId, row] of ledgerRows) {
    insertRecoveryLedger.run(
      clientUserMessageId,
      row.item_json,
      row.receipt_json,
      row.result_json,
    );
  }
  const firstRecoveryId = recoveryIds[0];
  const firstLedger = ledgerRows.get(firstRecoveryId);
  const omitIdentityField = (value, field) => {
    const parsed = JSON.parse(String(value ?? "{}"));
    const remove = (item) => {
      if (!item || typeof item !== "object") return;
      delete item[field];
      for (const child of Object.values(item)) remove(child);
    };
    remove(parsed);
    return JSON.stringify(parsed);
  };
  ledger.prepare(`
    UPDATE message_commands SET item_json = ?, receipt_json = ?, result_json = ?
    WHERE client_user_message_id = ?
  `).run(
    omitIdentityField(firstLedger.item_json, "runId"),
    omitIdentityField(firstLedger.receipt_json, "runId"),
    omitIdentityField(firstLedger.result_json, "runId"),
    firstRecoveryId,
  );
  ledger.close();

  await startAndWaitForControl("missing-run recovery restart");
  assert.deepEqual(
    (await readRecoveredUsers()).map((item) => item.clientUserMessageId).filter(Boolean),
    [],
    "missing authoritative run evidence must leave the corrupted row unchanged",
  );
  await stopBot();

  let mutableLedger = new DatabaseSync(ledgerFile);
  const conflictingResult = JSON.parse(firstLedger.result_json);
  conflictingResult.turnId = "conflicting-turn";
  mutableLedger.prepare(`
    UPDATE message_commands SET item_json = ?, receipt_json = ?, result_json = ?
    WHERE client_user_message_id = ?
  `).run(firstLedger.item_json, firstLedger.receipt_json, JSON.stringify(conflictingResult), firstRecoveryId);
  mutableLedger.close();
  await startAndWaitForControl("conflicting-evidence recovery restart");
  assert.deepEqual(
    (await readRecoveredUsers()).map((item) => item.clientUserMessageId).filter(Boolean),
    [],
    "conflicting authoritative evidence must leave the corrupted row unchanged",
  );
  await stopBot();

  mutableLedger = new DatabaseSync(ledgerFile);
  for (const [clientUserMessageId, row] of ledgerRows) {
    mutableLedger.prepare(`
      UPDATE message_commands SET item_json = ?, receipt_json = ?, result_json = ?
      WHERE client_user_message_id = ?
    `).run(row.item_json, row.receipt_json, row.result_json, clientUserMessageId);
  }
  mutableLedger.close();

  let stableSearchGroups = null;
  for (let restart = 1; restart <= 3; restart += 1) {
    await startAndWaitForControl(`exact recovery restart ${restart}`);
    const recoveredUsers = await waitFor(async () => {
      const users = await readRecoveredUsers();
      return users.length === recoveryIds.length
        && users.every((item) => item.clientUserMessageId)
        ? users
        : null;
    }, `exact six-message recovery ${restart}`, 8_000);
    assert.deepEqual(recoveredUsers.map((item) => item.clientUserMessageId), recoveryIds);
    const sourceGroups = readSearchSourceGroups();
    assert.deepEqual(sourceGroups.map((group) => group.source), ["history", "journal"]);
    if (stableSearchGroups) assert.deepEqual(sourceGroups, stableSearchGroups);
    else stableSearchGroups = sourceGroups;
    if (restart < 3) await stopBot();
  }
  const providerStateAfterRecovery = await readFile(codexStatePath, "utf8").then(JSON.parse);
  for (const clientUserMessageId of acceptedIds) {
    assert.equal(providerStateAfterRecovery.threads
      .flatMap((thread) => thread.turns)
      .flatMap((turn) => turn.items)
      .filter((item) => item.clientId === clientUserMessageId).length, 1);
  }
  for (const clientUserMessageId of recoveryIds) {
    assert.equal(providerStateAfterRecovery.threads
      .flatMap((thread) => thread.turns)
      .flatMap((turn) => turn.items)
      .filter((item) => item.clientId === clientUserMessageId).length, 0,
    "read-model recovery must never dispatch a provider effect");
  }
  await callDesktopControl("select-task", {
    provider: "codex",
    threadId: firstThreadId,
  }, { runtimeRoot });
  await waitFor(async () => {
    const [snapshot, runtimeState] = await Promise.all([
      callDesktopControl("snapshot", {}, { runtimeRoot }),
      readRuntimeState(dataDir),
    ]);
    const selectedTask = snapshot.tasks.find((item) => item.threadId === firstThreadId);
    const runSettled = !runtimeState.activeRuns.some((run) => (
      run.provider === "codex"
      && run.threadId === firstThreadId
      && ["running", "finishing"].includes(run.status)
    ));
    return snapshot.activeCount === 0 && !selectedTask?.running && runSettled ? snapshot : null;
  }, "post-recovery task idle", 8_000);

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
  assert.equal(imageStart.accepted, true, JSON.stringify(imageStart));
  const imageRunIdentity = await waitFor(async () => {
    const state = await readRuntimeState(dataDir);
    const run = state.activeRuns.find((item) => (
      item.clientUserMessageId === imageStart.clientUserMessageId
      && item.provider === "codex"
      && item.threadId === firstThreadId
    ));
    return run?.id && run?.turnId && ["running", "finishing"].includes(run.status)
      ? { runId: run.id, turnId: run.turnId }
      : null;
  }, "desktop image turn admission", 5_000);
  assert.ok(imageRunIdentity.runId);
  assert.ok(imageRunIdentity.turnId);
  await waitFor(async () => {
    const [snapshot, state] = await Promise.all([
      callDesktopControl("snapshot", {}, { runtimeRoot }),
      readRuntimeState(dataDir),
    ]);
    const receipt = snapshot.messageReceipts.find((item) => (
      item.clientUserMessageId === imageStart.clientUserMessageId
    ));
    const stillActive = state.activeRuns.some((run) => (
      run.id === imageRunIdentity.runId
      && ["running", "finishing"].includes(run.status)
    ));
    return !stillActive
      && receipt?.runId === imageRunIdentity.runId
      && receipt?.turnId === imageRunIdentity.turnId
      ? snapshot
      : null;
  }, "desktop image turn admission release", 15_000);

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
  assert.equal(cancelStart.accepted, true, JSON.stringify(cancelStart));
  await waitFor(async () => {
    const snapshot = await callDesktopControl("snapshot", {}, { runtimeRoot });
    return snapshot.tasks.find((item) => item.threadId === firstThreadId)?.running ? snapshot : null;
  }, "desktop cancellable turn", 5_000);
  await waitFor(async () => {
    const state = await readRuntimeState(dataDir);
    return state.activeRuns.find(run => run.threadId === firstThreadId
      && run.clientUserMessageId === cancelStart.clientUserMessageId && run.turnId) ?? null;
  }, "exact provider cancellation target", 5_000);
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

  const reservedPrompt = "Ответь строго: AGENT_HUB_CONTEXT_PROBE_OK_V1";
  const reservedAnswer = "AGENT_HUB_CONTEXT_PROBE_OK_V1";
  const reservedClientId = "desktop-manual-context-probe-text";
  const reservedTask = loadTasks[0];
  const reservedStart = await callDesktopControl("send-message", {
    text: reservedPrompt,
    provider: reservedTask.provider,
    threadId: reservedTask.threadId,
    clientUserMessageId: reservedClientId,
  }, { runtimeRoot });
  assert.equal(reservedStart.accepted, true);
  const reservedCompletion = await waitFor(async () => {
    const snapshot = await callDesktopControl("snapshot", {}, { runtimeRoot });
    const receipt = snapshot.messageReceipts.find((item) => (
      item.clientUserMessageId === reservedClientId
    ));
    const task = snapshot.tasks.find((item) => item.threadId === reservedTask.threadId);
    return receipt?.turnId && !task?.running && task?.lastAnswer === reservedAnswer
      ? { snapshot, receipt, task }
      : null;
  }, "ordinary reserved-phrase turn completion", 10_000);
  assert.equal(reservedCompletion.task.lastAnswer, reservedAnswer);
  const reservedHistory = await waitFor(async () => {
    const result = await callDesktopControl("task-history", {
      provider: reservedTask.provider,
      threadId: reservedTask.threadId,
      limit: 10,
    }, { runtimeRoot });
    const exchange = result.items.find((item) => item.messages.some((message) => (
      message.clientUserMessageId === reservedClientId
    )));
    return exchange?.prompt === reservedPrompt && exchange?.answer === reservedAnswer
      ? exchange
      : null;
  }, "ordinary reserved-phrase history projection", 5_000);
  assert.equal(reservedHistory.prompt, reservedPrompt);
  assert.equal(reservedHistory.answer, reservedAnswer);
  const reservedJournalTurn = await waitFor(async () => {
    const ledger = await journalDatabase.loadLedger().catch(() => null);
    return Object.values(ledger?.turns ?? {}).find((turn) => (
      turn.turnId === reservedCompletion.receipt.turnId
    )) ?? null;
  }, "ordinary reserved-phrase journal projection", 5_000);
  assert.equal(reservedJournalTurn.prompt, reservedPrompt);
  assert.equal(reservedJournalTurn.body, reservedAnswer);
  assert.equal(reservedJournalTurn.contextProbe, undefined);

  const reservedProviderPid = Number((await readFile(codexPidPath, "utf8")).trim());
  await stopPid(reservedProviderPid);
  await waitFor(async () => {
    const value = Number((await readFile(codexPidPath, "utf8").catch(() => "")).trim());
    return value && value !== reservedProviderPid ? value : null;
  }, "provider reconnect after ordinary reserved-phrase turn", 5_000);
  const reconnectedReservedSnapshot = await callDesktopControl("snapshot", {}, { runtimeRoot });
  assert.equal(
    reconnectedReservedSnapshot.tasks.find((item) => item.threadId === reservedTask.threadId)?.lastAnswer,
    reservedAnswer,
  );
  const reconnectedReservedHistory = await callDesktopControl("task-history", {
    provider: reservedTask.provider,
    threadId: reservedTask.threadId,
    limit: 10,
  }, { runtimeRoot });
  assert.equal(reconnectedReservedHistory.items.some((item) => (
    item.prompt === reservedPrompt && item.answer === reservedAnswer
  )), true);

  const archived = await callDesktopControl("archive-task", {
    provider: "codex",
    threadId: firstThreadId,
  }, { runtimeRoot });
  assert.notEqual(archived.selected.threadId, firstThreadId);
  assert.doesNotMatch(stderr, /Unhandled asynchronous error|Cannot start desktop control/i);
  testCompleted = true;
});
