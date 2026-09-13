import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { ProviderLoginService } from "../../src/application/provider-login-service.mjs";

function fakeWorker(pid) {
  const worker = new EventEmitter();
  worker.pid = pid;
  worker.stdout = Object.assign(new EventEmitter(), { resumed: false, resume() { this.resumed = true; } });
  worker.stderr = Object.assign(new EventEmitter(), { resumed: false, resume() { this.resumed = true; } });
  worker.kills = 0;
  worker.kill = () => { worker.kills += 1; };
  return worker;
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
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

test("Codex sign-in uses the App Server managed login and settles on its exact completion", async () => {
  const { service, calls } = createService();
  const entry = await service.start("codex");
  assert.deepEqual(calls.rpc[0], ["account/login/start", { type: "chatgpt" }]);
  assert.equal(entry.status, "pending");
  assert.equal(entry.authUrl, "https://auth.example/1", "the local starter receives the sign-in link");
  assert.equal("authUrl" in service.entry("codex"), false, "snapshots never carry the sign-in link");

  for (const loginId of ["other", null, undefined]) {
    service.observeCodexMessage({ method: "account/login/completed", params: { loginId, success: true } });
  }
  assert.equal(service.entry("codex").status, "pending", "foreign or missing login ids must not settle the attempt");

  service.observeCodexMessage({ method: "account/login/completed", params: { loginId: "login-1", success: true } });
  await settle();
  assert.equal(service.entry("codex").status, "succeeded");
  assert.deepEqual(calls.changed, ["codex"]);
  assert.equal(calls.timers[0].cleared, true);
});

test("a completion that arrives before the start response binds its login id is ignored", async () => {
  const release = deferred();
  const rpc = [];
  const { service } = createService({
    sendRpc: async (method, params) => {
      rpc.push([method, params]);
      if (method !== "account/login/start") return {};
      await release.promise;
      return { loginId: "login-late", authUrl: "https://auth.example/late" };
    },
  });
  const starting = service.start("codex");
  await settle();
  service.observeCodexMessage({ method: "account/login/completed", params: { loginId: null, success: true } });
  service.observeCodexMessage({ method: "account/login/completed", params: { loginId: "login-late", success: true } });
  release.resolve();
  await starting;
  assert.equal(service.entry("codex").status, "pending");
});

test("concurrent Codex starts are serialized: the second cancels the first instead of racing it", async () => {
  const release = deferred();
  let starts = 0;
  const rpc = [];
  const { service } = createService({
    sendRpc: async (method, params) => {
      rpc.push([method, params.loginId ?? null]);
      if (method !== "account/login/start") return {};
      starts += 1;
      const current = starts;
      if (current === 1) await release.promise;
      return { loginId: `login-${current}`, authUrl: `https://auth.example/${current}` };
    },
  });
  const first = service.start("codex");
  const second = service.start("codex");
  await settle();
  assert.equal(starts, 1, "the second start must wait for the first one");
  release.resolve();
  const [firstEntry, secondEntry] = await Promise.all([first, second]);
  assert.equal(firstEntry.authUrl, "https://auth.example/1");
  assert.equal(secondEntry.authUrl, "https://auth.example/2");
  assert.deepEqual(rpc, [
    ["account/login/start", null],
    ["account/login/cancel", "login-1"],
    ["account/login/start", null],
  ]);
});

test("a cancel issued while a start is in flight cancels that exact sign-in", async () => {
  const release = deferred();
  const rpc = [];
  const { service } = createService({
    sendRpc: async (method, params) => {
      rpc.push([method, params.loginId ?? null]);
      if (method !== "account/login/start") return {};
      await release.promise;
      return { loginId: "login-1", authUrl: "https://auth.example/1" };
    },
  });
  const starting = service.start("codex");
  const cancelling = service.cancel("codex");
  await settle();
  release.resolve();
  await starting;
  assert.equal((await cancelling).status, "cancelled");
  assert.deepEqual(rpc, [["account/login/start", null], ["account/login/cancel", "login-1"]]);
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

test("Claude sign-in runs the official CLI, drains its output and confirms the account", async () => {
  const { service, calls } = createService();
  const entry = await service.start("claude");
  assert.equal(entry.status, "pending");
  assert.equal(entry.authUrl, null, "the printed manual-code link is not surfaced");
  const { command, args, options, worker } = calls.spawned[0];
  assert.equal(command, "claude.exe");
  assert.deepEqual(args, ["--x", "auth", "login"]);
  assert.equal(options.windowsHide, true);
  assert.equal(worker.stdout.resumed && worker.stderr.resumed, true);

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

test("an exited Claude CLI is never stopped again, and its late status cannot overwrite a cancel", async () => {
  const status = deferred();
  const { service, calls } = createService({ readClaudeLoggedIn: () => status.promise });
  await service.start("claude");
  const { worker } = calls.spawned[0];
  worker.emit("close", 0);
  assert.equal((await service.cancel("claude")).status, "cancelled");
  service.dispose();
  assert.deepEqual(calls.stopped, [], "a closed child's PID may already belong to another process");
  assert.equal(worker.kills, 0);
  status.resolve(true);
  await settle();
  assert.equal(service.entry("claude").status, "cancelled");
  assert.deepEqual(calls.changed, []);
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

test("dispose closes only pending sign-ins of this service", async () => {
  const { service, calls } = createService();
  await service.start("claude");
  await service.start("codex");
  service.dispose();
  await settle();
  assert.deepEqual(calls.stopped, [100]);
  assert.equal(calls.spawned[0].worker.kills, 1);
  assert.deepEqual(calls.rpc.at(-1), ["account/login/cancel", { loginId: "login-1" }]);
  assert.deepEqual(service.snapshot().map((entry) => entry.status), ["cancelled", "cancelled"]);
  service.dispose();
  await settle();
  assert.deepEqual(calls.stopped, [100], "a second dispose has nothing left to stop");
});

test("unknown providers and malformed Codex responses are rejected", async () => {
  const { service } = createService({ sendRpc: async () => ({ loginId: "x", authUrl: "http://insecure" }) });
  assert.throws(() => service.start("gemini"), /Неизвестный провайдер/u);
  await assert.rejects(service.start("codex"), /не вернул ссылку/u);
  assert.equal(service.entry("codex").status, "failed");
});
