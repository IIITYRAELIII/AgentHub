import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { ProviderLoginService } from "../../src/application/provider-login-service.mjs";

function fakeWorker(pid) {
  const worker = new EventEmitter();
  worker.pid = pid;
  worker.stdout = new EventEmitter();
  worker.stderr = new EventEmitter();
  worker.killed = false;
  worker.kill = () => { worker.killed = true; };
  return worker;
}

function createService(overrides = {}) {
  const calls = { rpc: [], spawned: [], stopped: [], changed: [], timers: [] };
  let loginCounter = 0;
  const service = new ProviderLoginService({
    sendRpc: async (method, params) => {
      calls.rpc.push([method, params]);
      if (method === "account/login/start") {
        loginCounter += 1;
        return { type: "chatgpt", loginId: `login-${loginCounter}`, authUrl: `https://auth.example/${loginCounter}` };
      }
      return {};
    },
    resolveClaudeInvocation: () => ({ command: "claude.exe", prefixArgs: ["--x"] }),
    spawnProcess: (command, args, options) => {
      const worker = fakeWorker(100 + calls.spawned.length);
      calls.spawned.push({ command, args, options, worker });
      return worker;
    },
    stopProcessTree: async (pid) => { calls.stopped.push(pid); return true; },
    readClaudeLoggedIn: async () => true,
    onAccountChanged: async (provider) => { calls.changed.push(provider); },
    timers: {
      setTimeout: (callback, delay) => { const timer = { callback, delay }; calls.timers.push(timer); return timer; },
      clearTimeout: (timer) => { if (timer) timer.cleared = true; },
    },
    clock: () => Date.parse("2026-09-13T12:00:00.000Z"),
    logger: { error() {} },
    ...overrides,
  });
  return { service, calls };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test("Codex sign-in uses the App Server managed login and settles on its completion notification", async () => {
  const { service, calls } = createService();
  const entry = await service.start("codex");
  assert.deepEqual(calls.rpc[0], ["account/login/start", { type: "chatgpt" }]);
  assert.equal(entry.status, "pending");
  assert.equal(entry.authUrl, "https://auth.example/1");

  service.observeCodexMessage({ method: "account/login/completed", params: { loginId: "other", success: true } });
  assert.equal(service.entry("codex").status, "pending", "a foreign login id must not settle the attempt");

  service.observeCodexMessage({ method: "account/login/completed", params: { loginId: "login-1", success: true } });
  await settle();
  const settled = service.entry("codex");
  assert.equal(settled.status, "succeeded");
  assert.equal(settled.authUrl, null);
  assert.deepEqual(calls.changed, ["codex"]);
  assert.equal(calls.timers[0].cleared, true);
});

test("a repeated Codex sign-in cancels the unfinished one instead of racing it", async () => {
  const { service, calls } = createService();
  await service.start("codex");
  const second = await service.start("codex");
  assert.deepEqual(calls.rpc.map(([method, params]) => [method, params.loginId ?? null]), [
    ["account/login/start", null],
    ["account/login/cancel", "login-1"],
    ["account/login/start", null],
  ]);
  assert.equal(second.authUrl, "https://auth.example/2");
  service.observeCodexMessage({ method: "account/login/completed", params: { loginId: "login-1", success: false, error: "cancelled" } });
  assert.equal(service.entry("codex").status, "pending");
});

test("explicit cancel and timeout close a Codex sign-in without inventing success", async () => {
  const { service, calls } = createService();
  await service.start("codex");
  assert.equal((await service.cancel("codex")).status, "cancelled");
  assert.deepEqual(calls.rpc.at(-1), ["account/login/cancel", { loginId: "login-1" }]);

  await service.start("codex");
  calls.timers.at(-1).callback();
  await settle();
  const timedOut = service.entry("codex");
  assert.equal(timedOut.status, "failed");
  assert.match(timedOut.error, /Время ожидания/u);
  assert.deepEqual(calls.rpc.at(-1), ["account/login/cancel", { loginId: "login-2" }]);
});

test("failed Codex completion and account updates are reported without throwing", async () => {
  const { service, calls } = createService();
  await service.start("codex");
  service.observeCodexMessage({ method: "account/login/completed", params: { loginId: "login-1", success: false, error: "denied" } });
  assert.equal(service.entry("codex").status, "failed");
  assert.equal(service.entry("codex").error, "denied");
  service.observeCodexMessage({ method: "account/updated", params: { authMode: "chatgpt" } });
  service.observeCodexMessage({ method: "turn/started", params: {} });
  service.observeCodexMessage(null);
  await settle();
  assert.deepEqual(calls.changed, ["codex"]);
});

test("Claude sign-in runs the official CLI, exposes its URL and confirms the account", async () => {
  const { service, calls } = createService();
  const entry = await service.start("claude");
  assert.equal(entry.status, "pending");
  const { command, args, options, worker } = calls.spawned[0];
  assert.equal(command, "claude.exe");
  assert.deepEqual(args, ["--x", "auth", "login"]);
  assert.equal(options.windowsHide, true);

  worker.stdout.emit("data", "Opening browser. If it does not open, visit: https://claude.example/oauth?x=1.\n");
  assert.equal(service.entry("claude").authUrl, "https://claude.example/oauth?x=1");
  worker.emit("close", 0);
  await settle();
  assert.equal(service.entry("claude").status, "succeeded");
  assert.deepEqual(calls.changed, ["claude"]);
});

test("Claude sign-in fails when the CLI exits badly or does not confirm the account", async () => {
  const { service, calls } = createService({ readClaudeLoggedIn: async () => false });
  await service.start("claude");
  calls.spawned[0].worker.emit("close", 1);
  assert.equal(service.entry("claude").status, "failed");
  assert.match(service.entry("claude").error, /кодом 1/u);

  await service.start("claude");
  calls.spawned[1].worker.emit("close", 0);
  await settle();
  assert.equal(service.entry("claude").status, "failed");
  assert.match(service.entry("claude").error, /не подтвердил/u);
});

test("a repeated Claude sign-in stops the previous CLI and ignores its late exit", async () => {
  const { service, calls } = createService();
  await service.start("claude");
  await service.start("claude");
  assert.deepEqual(calls.stopped, [100]);
  calls.spawned[0].worker.emit("close", 0);
  await settle();
  assert.equal(service.entry("claude").status, "pending");
  assert.deepEqual(calls.changed, []);

  assert.equal((await service.cancel("claude")).status, "cancelled");
  assert.deepEqual(calls.stopped, [100, 101]);
});

test("unknown providers and malformed Codex responses are rejected", async () => {
  const { service } = createService({ sendRpc: async () => ({ loginId: "x", authUrl: "http://insecure" }) });
  await assert.rejects(service.start("gemini"), /Неизвестный провайдер/u);
  await assert.rejects(service.start("codex"), /не вернул ссылку/u);
  assert.equal(service.entry("codex").status, "failed");
});
