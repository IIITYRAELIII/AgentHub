import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { callDesktopControl } from "../../desktop-control.mjs";
import { readRuntimeState } from "../../src/infrastructure/persistence/runtime-state-store.mjs";
import {
  CHAT_ID,
  E2eChildProcessOwner,
  FakeTelegramApi,
  USER_ID,
  waitFor,
} from "../../e2e/telegram-harness.mjs";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const BOT_FILE = path.join(ROOT, "agent-hub-main.mjs");
const FAKE_CODEX_FILE = path.join(ROOT, "e2e", "fake-codex-app-server.mjs");

test("terminal SQLite contention preserves rapid FIFO intake and resumes one drain", { timeout: 150_000 }, async (t) => {
  const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "agent-hub-terminal-fifo-e2e-"));
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
    projects: [{ name: "Terminal FIFO E2E", path: projectRoot }],
    dataDir,
    codexExecutable: process.execPath,
    codexExecutableArgs: [FAKE_CODEX_FILE, "--state", codexStatePath, "--pid-file", codexPidPath],
    codexRolloutContext: { enabled: false },
    progressStartDelayMs: 10,
  }, null, 2)}\n`, "utf8");
  await writeFile(codexStatePath, `${JSON.stringify({
    nextThread: 2,
    nextTurn: 1,
    nextMessage: 1,
    threads: [{
      id: savedThreadId,
      cwd: projectRoot,
      name: "Terminal FIFO",
      preview: "",
      updatedAt: Math.floor(Date.now() / 1_000),
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
    activeThreadTitle: "Terminal FIFO",
  }, null, 2)}\n`, "utf8");

  let stderr = "";
  let bot = null;
  const botOwner = new E2eChildProcessOwner({ label: "terminal-contention Agent Hub" });
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
  };
  const stopBot = async () => {
    const current = bot;
    if (!current) return;
    await botOwner.stop();
    if (bot === current) bot = null;
  };
  startBot();
  t.after(async () => {
    await stopBot();
    await telegram.stop();
    await rm(runtimeRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  const initial = await waitFor(
    () => callDesktopControl("snapshot", {}, { runtimeRoot }).catch(() => null),
    "local control startup",
    10_000,
  );
  const threadId = initial.selected.threadId;
  const clientIds = Array.from({ length: 8 }, (_, index) => `fifo-busy-${index + 1}`);
  const root = await callDesktopControl("send-message", {
    text: "[hold] fifo 1",
    provider: "codex",
    threadId,
    clientUserMessageId: clientIds[0],
  }, { runtimeRoot });
  assert.equal(root.accepted, true, JSON.stringify(root));
  await waitFor(async () => {
    const snapshot = await callDesktopControl("snapshot", {}, { runtimeRoot });
    return snapshot.tasks.find((item) => item.threadId === threadId)?.running ? snapshot : null;
  }, "held root", 5_000);

  for (let index = 1; index < clientIds.length; index += 1) {
    const deferred = await callDesktopControl("send-message", {
      text: `fifo ${index + 1}`,
      provider: "codex",
      threadId,
      clientUserMessageId: clientIds[index],
    }, { runtimeRoot });
    assert.equal(deferred.deferred, true, JSON.stringify(deferred));
    const queued = await callDesktopControl("deferred-input", {
      id: deferred.id,
      action: "queue",
    }, { runtimeRoot });
    assert.equal(queued.accepted, true, JSON.stringify(queued));
  }

  const blocker = new DatabaseSync(path.join(dataDir, "runtime.sqlite"));
  let blocked = false;
  try {
    blocker.exec("BEGIN IMMEDIATE;");
    blocked = true;
    const releaseBlocker = setTimeout(() => {
      if (!blocked) return;
      blocker.exec("COMMIT;");
      blocked = false;
    }, 500);
    const cancelled = await callDesktopControl("cancel-run", {
      provider: "codex",
      threadId,
    }, { runtimeRoot });
    clearTimeout(releaseBlocker);
    assert.equal(cancelled.accepted, true, JSON.stringify(cancelled));
  } finally {
    if (blocked) blocker.exec("ROLLBACK;");
    blocker.close();
  }

  const settled = await waitFor(async () => {
    const [snapshot, providerState] = await Promise.all([
      callDesktopControl("snapshot", {}, { runtimeRoot }),
      readFile(codexStatePath, "utf8").then(JSON.parse),
    ]);
    const task = snapshot.tasks.find((item) => item.threadId === threadId);
    const providerClientIds = providerState.threads
      .find((thread) => thread.id === threadId)
      ?.turns.flatMap((turn) => turn.items)
      .filter((item) => clientIds.includes(item.clientId))
      .map((item) => item.clientId) ?? [];
    return !task?.running
      && !snapshot.deferredInputs.some((item) => clientIds.includes(item.clientUserMessageId))
      && JSON.stringify(providerClientIds) === JSON.stringify(clientIds)
      ? { snapshot, providerClientIds }
      : null;
  }, "FIFO drain after transient terminal contention", 35_000).catch(async (error) => {
    const [snapshot, providerState, runtimeState] = await Promise.all([
      callDesktopControl("snapshot", {}, { runtimeRoot }).catch((failure) => ({ error: failure.message })),
      readFile(codexStatePath, "utf8").then(JSON.parse),
      readRuntimeState(dataDir),
    ]);
    throw new Error([
      error.message,
      `task=${JSON.stringify(snapshot.tasks?.find((item) => item.threadId === threadId) ?? null)}`,
      `deferred=${JSON.stringify(snapshot.deferredInputs?.filter((item) => clientIds.includes(item.clientUserMessageId)) ?? [])}`,
      `receipts=${JSON.stringify(snapshot.messageReceipts?.filter((item) => clientIds.includes(item.clientUserMessageId)) ?? [])}`,
      `runs=${JSON.stringify(runtimeState.activeRuns?.filter((run) => run.threadId === threadId) ?? [])}`,
      `turns=${JSON.stringify(providerState.threads.find((thread) => thread.id === threadId)?.turns ?? [])}`,
      `stderr=${stderr.slice(-4_000)}`,
    ].join("\n"));
  });
  assert.deepEqual(settled.providerClientIds, clientIds);

  const assertHistory = async () => {
    const history = await callDesktopControl("task-history", {
      provider: "codex",
      threadId,
      limit: 20,
    }, { runtimeRoot });
    const messages = history.items.flatMap((exchange) => exchange.messages);
    const visibleClientIds = messages
      .filter((message) => message.role === "user" && clientIds.includes(message.clientUserMessageId))
      .map((message) => message.clientUserMessageId);
    assert.deepEqual(
      clientIds.map((clientUserMessageId) => visibleClientIds.filter((id) => id === clientUserMessageId).length),
      Array.from({ length: clientIds.length }, () => 1),
    );
    for (const clientUserMessageId of clientIds) {
      const exchange = history.items.find((item) => item.messages.some(
        (message) => message.role === "user"
          && message.clientUserMessageId === clientUserMessageId,
      ));
      assert.ok(exchange, `missing exchange for ${clientUserMessageId}`);
      assert.equal(
        exchange.messages.filter((message) => message.role === "agent").length,
        1,
        `expected one assistant response for ${clientUserMessageId}`,
      );
    }
  };
  await assertHistory();
  await callDesktopControl("select-task", { provider: "codex", threadId }, { runtimeRoot });
  await assertHistory();
  await stopBot();
  startBot();
  await waitFor(
    () => callDesktopControl("snapshot", {}, { runtimeRoot }).catch(() => null),
    "restart",
    10_000,
  );
  await assertHistory();
});
