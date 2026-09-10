import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const SERVER = process.env.FAKE_CODEX_SERVER || path.join(ROOT, "e2e", "fake-codex-app-server.mjs");
const THREAD = "10000000-0000-4000-8000-000000000001";

async function startServer(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-fake-codex-reply-"));
  const statePath = path.join(root, "fake-codex-state.json");
  await writeFile(statePath, JSON.stringify({
    nextThread: 2, nextTurn: 1, nextMessage: 1, crashedOnce: false, requestCounts: {},
    threads: [{
      id: THREAD, cwd: root, name: "t", preview: "", updatedAt: 0, turns: [],
      model: "m", reasoningEffort: "low", archived: false,
    }],
  }));
  const child = spawn(process.execPath, [SERVER, "--state", statePath], {
    stdio: ["pipe", "pipe", "inherit"], windowsHide: true,
  });
  const inbox = [];
  const listeners = new Set();
  createInterface({ input: child.stdout }).on("line", (line) => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    inbox.push(message);
    for (const listener of listeners) listener();
  });
  t.after(async () => {
    // Уже завершившийся child не выдаст второго exit — не ждать его.
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.kill();
      await exited;
    }
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  const request = (id, method, params) => {
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        listeners.delete(check);
        reject(new Error(`no reply for ${method} id=${id} within 3000 ms`));
      }, 3_000);
      const check = () => {
        const reply = inbox.find((message) => message.id === id);
        if (!reply) return;
        clearTimeout(timer);
        listeners.delete(check);
        resolve(reply);
      };
      listeners.add(check);
      check();
    });
  };
  return { child, statePath, inbox, request };
}

test("fake Codex answers every request even when persisting its state fails", async (t) => {
  const server = await startServer(t);
  assert.ok((await server.request(1, "thread/read", { threadId: THREAD })).result?.thread);

  // Делаем rename внутри save() невозможным: на месте state-файла — каталог.
  await rm(server.statePath, { force: true });
  await mkdir(server.statePath);

  const failed = await server.request(2, "thread/read", { threadId: THREAD });
  assert.equal(failed.id, 2);
  assert.match(String(failed.error?.message ?? ""), /rename/u, "Hub должен получить ошибку, а не таймаут");
  assert.equal(failed.result, undefined);

  const alive = await server.request(3, "thread/list", { limit: 1 });
  assert.ok(Array.isArray(alive.result?.data));
  assert.equal(server.child.exitCode, null, "сервер остаётся живым и продолжает отвечать");
});

test("fake Codex never leaves thread/read unanswered while another process reads its state file", async (t) => {
  const server = await startServer(t);
  const { readFile } = await import("node:fs/promises");
  const deadline = Date.now() + 1_500;
  let reads = 0;
  const reader = (async () => {
    while (Date.now() < deadline) {
      await readFile(server.statePath, "utf8").catch(() => {});
      reads += 1;
    }
  })();
  let id = 10;
  const replies = [];
  while (Date.now() < deadline) {
    id += 1;
    replies.push(await server.request(id, "thread/read", { threadId: THREAD }));
  }
  await reader;
  assert.ok(reads > 0);
  assert.ok(replies.length > 0);
  // Самодостаточный инвариант: каждый запрос получил ответ — результат или
  // явную ошибку, но не тишину. Повтор rename лишь снижает долю ошибок и
  // гарантий не даёт, поэтому их число — диагностика, а не условие.
  for (const reply of replies) assert.ok(reply.result !== undefined || reply.error !== undefined);
  const errors = replies.filter((reply) => reply.error);
  t.diagnostic(`rename retries exhausted: ${errors.length} of ${replies.length} replies`);
});
