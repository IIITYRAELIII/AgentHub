import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";

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
