import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";

import { CodexHubMcpBridgeRecovery } from "../../src/providers/codex/codex-hub-mcp-bridge-recovery.mjs";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const FAKE_CODEX = path.join(ROOT, "e2e", "fake-codex-app-server.mjs");

function startFake(root, stateFile) {
  const child = spawn(process.execPath, [
    FAKE_CODEX,
    "--state",
    stateFile,
    "--require-test-contour",
    "--accept-all",
    "app-server",
    "--stdio",
  ], {
    cwd: root,
    env: {
      ...process.env,
      AGENT_HUB_RUNTIME_ROOT: root,
      AGENT_HUB_TEST_CONTOUR: "1",
      AGENT_HUB_TEST_CONTOUR_PROFILE: "fake-codex",
    },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const pending = new Map();
  const notifications = [];
  let sequence = 1;
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    const message = JSON.parse(line);
    if (message.id !== undefined) {
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      if (message.error) request.reject(new Error(message.error.message));
      else request.resolve(message.result);
      return;
    }
    notifications.push(message);
  });
  return {
    child,
    notifications,
    async stop() {
      lines.close();
      child.stdin.end();
      if (child.exitCode === null && child.signalCode === null) child.kill();
      if (child.exitCode === null && child.signalCode === null) await once(child, "exit");
    },
    request(method, params = {}) {
      const id = sequence++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
      });
    },
  };
}

async function waitForNotification(fake, method, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = fake.notifications.find((message) => message.method === method);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timeout waiting for ${method}`);
}

async function waitForNotificationAt(fake, method, index, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = fake.notifications.filter((message) => message.method === method)[index];
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timeout waiting for ${method} at index ${index}`);
}

async function bounded(promise, timeoutMs = 2_000) {
  let timer = null;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Operation exceeded ${timeoutMs} ms`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test("accept-all Fake Codex completes arbitrary delivery input with Принято", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-fake-codex-"));
  const stateFile = path.join(root, "data", "fake-state.json");
  await mkdir(path.dirname(stateFile), { recursive: true });
  const fake = startFake(root, stateFile);
  t.after(async () => {
    await fake.stop();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  await fake.request("initialize");
  await fake.request("thread/ensure", { threadId: "thread-delivery", model: "fake-codex" });
  const started = await fake.request("turn/start", {
    threadId: "thread-delivery",
    model: "fake-codex",
    input: [{ type: "text", text: "[hold] [fail] любое сообщение" }],
  });
  const completed = await waitForNotification(fake, "turn/completed");
  assert.equal(completed.params.turn.id, started.turn.id);
  assert.equal(completed.params.turn.status, "completed");
  assert.equal(completed.params.turn.items.at(-1).text, "Принято");
});

test("accept-all Fake Codex restores one unfinished turn after restart", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-fake-codex-restart-"));
  const stateFile = path.join(root, "data", "fake-state.json");
  await mkdir(path.dirname(stateFile), { recursive: true });
  await writeFile(stateFile, `${JSON.stringify({
    nextThread: 2,
    nextTurn: 2,
    nextMessage: 2,
    crashedOnce: false,
    requestCounts: {},
    threads: [{
      id: "thread-restart",
      cwd: root,
      name: "Restart delivery",
      preview: "до рестарта",
      updatedAt: Math.floor(Date.now() / 1000),
      model: "fake-codex",
      reasoningEffort: "medium",
      archived: false,
      turns: [{
        id: "turn-restart",
        status: "inProgress",
        prompt: "до рестарта",
        items: [],
      }],
    }],
  }, null, 2)}\n`, "utf8");
  const fake = startFake(root, stateFile);
  t.after(async () => {
    await fake.stop();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  await fake.request("initialize");
  const completed = await waitForNotification(fake, "turn/completed");
  assert.equal(completed.params.turn.id, "turn-restart");
  assert.equal(completed.params.turn.status, "completed");
  assert.equal(completed.params.turn.items.at(-1).text, "Принято");
});

test("App Server bridge bounds pre-dispatch and lost-response failures then preserves same-thread success", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-fake-codex-mcp-bridge-"));
  const stateFile = path.join(root, "data", "fake-state.json");
  await mkdir(path.dirname(stateFile), { recursive: true });
  const fake = startFake(root, stateFile);
  t.after(async () => {
    await fake.stop();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  await fake.request("initialize");
  await fake.request("thread/ensure", { threadId: "thread-hub-mcp-bridge", model: "fake-codex" });

  const reloads = [];
  const wakes = [];
  const stages = [];
  const operations = new Map([
    ["send-lost-response", { status: "succeeded", result: { sent: true } }],
  ]);
  const recovery = new CodexHubMcpBridgeRecovery({
    reloadMcp: async () => {
      reloads.push("reload");
      return fake.request("config/mcpServer/reload");
    },
    readOperation: (requestId) => operations.get(requestId) ?? null,
    wakeDeferredInputs: () => wakes.push("wake"),
    setStage: (_run, stage) => stages.push(stage),
    logger: { log: () => {}, error: () => {} },
  });

  async function runScenario(prompt, itemIndex, turnIndex) {
    const started = await fake.request("turn/start", {
      threadId: "thread-hub-mcp-bridge",
      model: "fake-codex",
      input: [{ type: "text", text: prompt }],
    });
    const completedItem = await waitForNotificationAt(fake, "item/completed", itemIndex);
    assert.equal(completedItem.params.threadId, "thread-hub-mcp-bridge");
    assert.equal(completedItem.params.turnId, started.turn.id);
    const result = await bounded(recovery.observe({
      method: "item/completed",
      item: completedItem.params.item,
      run: { id: started.turn.id },
    }));
    const completedTurn = await waitForNotificationAt(fake, "turn/completed", turnIndex);
    assert.equal(completedTurn.params.turn.id, started.turn.id);
    return result;
  }

  const preDispatch = await runScenario("[hub-mcp-no-admission]", 0, 0);
  assert.equal(preDispatch.calls[0].outcome, "pre-dispatch");
  assert.deepEqual(reloads, ["reload"]);

  const lostResponse = await runScenario("[hub-mcp-lost-response]", 1, 1);
  assert.equal(lostResponse.calls[0].outcome, "authoritative-succeeded");
  assert.deepEqual(reloads, ["reload", "reload"]);

  const success = await runScenario("[hub-mcp-success-vocabulary]", 2, 2);
  assert.equal(success, null);
  assert.deepEqual(reloads, ["reload", "reload"]);
  assert.deepEqual(wakes, ["wake", "wake"]);
  assert.equal(stages.length, 2);
});

test("Fake Codex preserves loaded Thread ownership across process restart", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-fake-codex-loaded-restart-"));
  const stateFile = path.join(root, "data", "fake-state.json");
  const threadId = "10000000-0000-4000-8000-000000000020";
  await mkdir(path.dirname(stateFile), { recursive: true });
  let fake = startFake(root, stateFile);
  t.after(async () => {
    if (fake) await fake.stop();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  await fake.request("initialize");
  await fake.request("thread/ensure", { threadId, model: "fake-codex" });
  assert.deepEqual((await fake.request("thread/loaded/list")).data, [threadId]);
  await fake.stop();
  fake = null;

  fake = startFake(root, stateFile);
  await fake.request("initialize");
  assert.deepEqual((await fake.request("thread/loaded/list")).data, [threadId]);
});

test("Fake Codex allocates above retained turn ids across process restart", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-fake-codex-turn-sequence-"));
  const stateFile = path.join(root, "data", "fake-state.json");
  const historicalThreadId = "10000000-0000-4000-8000-000000000001";
  const currentThreadId = "10000000-0000-4000-8000-000000000020";
  await mkdir(path.dirname(stateFile), { recursive: true });
  await writeFile(stateFile, `${JSON.stringify({
    nextThread: 21,
    nextTurn: 9,
    nextMessage: 1,
    loadedThreadIds: [currentThreadId],
    crashedOnce: false,
    requestCounts: {},
    threads: [
      {
        id: historicalThreadId,
        cwd: root,
        name: "Historical",
        preview: "",
        updatedAt: 1,
        model: "fake-codex",
        reasoningEffort: "medium",
        archived: false,
        turns: [{ id: "20000000-0000-4000-8000-000000000022", status: "completed", prompt: "old", items: [] }],
      },
      {
        id: currentThreadId,
        cwd: root,
        name: "Current",
        preview: "",
        updatedAt: 2,
        model: "fake-codex",
        reasoningEffort: "medium",
        archived: false,
        turns: [],
      },
    ],
  }, null, 2)}\n`, "utf8");
  let fake = startFake(root, stateFile);
  t.after(async () => {
    if (fake) await fake.stop();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  await fake.request("initialize");
  const first = await fake.request("turn/start", {
    threadId: currentThreadId,
    input: [{ type: "text", text: "first after recovery" }],
  });
  assert.equal(first.turn.id, "20000000-0000-4000-8000-000000000023");
  await fake.stop();
  fake = null;

  fake = startFake(root, stateFile);
  await fake.request("initialize");
  const second = await fake.request("turn/start", {
    threadId: currentThreadId,
    input: [{ type: "text", text: "second after restart" }],
  });
  assert.equal(second.turn.id, "20000000-0000-4000-8000-000000000024");
});
