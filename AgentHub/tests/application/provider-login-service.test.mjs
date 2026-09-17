import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { manualClaudeLoginCode, ProviderLoginService } from "../../src/application/provider-login-service.mjs";

const CODE = "Kc0de-AbC_123#sTaTe-456_xyz";

function fakeWorker(pid) {
  const worker = new EventEmitter();
  worker.pid = pid;
  worker.stdout = new EventEmitter();
  worker.stderr = new EventEmitter();
  worker.stdin = {
    writes: [],
    destroyed: false,
    writableEnded: false,
    write(chunk, callback) { this.writes.push(chunk); callback?.(); return true; },
  };
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
  const calls = { rpc: [], spawned: [], stopped: [], changed: [], timers: [], errors: [] };
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
    claudeUrlWaitMs: 0,
    logger: { error: (...args) => calls.errors.push(args.join(" ")) },
    ...overrides,
  });
  return { service, calls };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test("account display reads are nonblocking, coalesced and refreshed independently of login attempts", async () => {
  let now = 0;
  const first = deferred();
  const calls = [];
  let fail = false;
  const { service } = createService({ clock: () => now, readAccount: async (provider) => {
    calls.push(provider);
    if (provider === "codex" && calls.filter((p) => p === "codex").length === 1) return first.promise;
    if (fail) throw new Error("private-error-must-not-reach-snapshot");
    return provider === "codex" ? { account: null, requiresOpenaiAuth: true }
      : { loggedIn: true, email: "claude@example.test", authMethod: "claude.ai", accessToken: "secret-token" };
  } });
  assert.equal(service.snapshot()[0].currentAccount.state, "checking");
  service.snapshot();
  await settle();
  assert.deepEqual(calls, ["codex", "claude"]);
  assert.equal(service.entry("claude").currentAccount.email, "claude@example.test");
  first.resolve({ account: { type: "chatgpt", email: "codex@example.test", token: "secret-token" } });
  await settle();
  assert.equal(service.entry("codex").status, "idle");
  assert.equal(service.entry("codex").currentAccount.email, "codex@example.test");
  now = 30_001;
  assert.equal(service.entry("codex").currentAccount.state, "checking");
  await settle();
  assert.equal(service.entry("codex").currentAccount.state, "signed-out");
  fail = true;
  now += 30_001;
  service.snapshot();
  await settle();
  assert.equal(service.entry("codex").currentAccount.state, "unknown");
  assert.equal(service.entry("claude").currentAccount.state, "unknown");
  assert.doesNotMatch(JSON.stringify(service.snapshot()), /secret-token|private-error/u);
  service.dispose();
});

test("account change rejects a stale in-flight read and shutdown starts no follow-up probe", async () => {
  const old = deferred();
  let count = 0;
  const { service } = createService({ readAccount: async () => {
    count += 1;
    return count === 1 ? old.promise : { account: { type: "chatgpt", email: "new@example.test" } };
  } });
  service.entry("codex");
  await settle();
  service.observeCodexMessage({ method: "account/updated" });
  old.resolve({ account: { type: "chatgpt", email: "old@example.test" } });
  await settle();
  assert.equal(service.entry("codex").currentAccount.email, "new@example.test");
  assert.equal(count, 2);
  service.dispose();
  service.observeCodexMessage({ method: "account/updated" });
  service.snapshot();
  await settle();
  assert.equal(count, 2);
});

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
  const { service } = createService({
    sendRpc: async (method) => {
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

test("Claude sign-in runs the official CLI and returns its printed link only to the local starter", async () => {
  const printed = "https://claude.com/cai/oauth/authorize?code=true&state=abc";
  const { service, calls } = createService({
    claudeUrlWaitMs: 5_000,
    spawnProcess: (command, args, options) => {
      const worker = fakeWorker(100);
      calls.spawned.push({ command, args, options, worker });
      setImmediate(() => worker.stdout.emit("data",
        `Opening browser to sign in…\nIf the browser didn't open, visit: ${printed}\nPaste code here if prompted > `));
      return worker;
    },
  });
  const entry = await service.start("claude");
  assert.equal(entry.status, "pending");
  assert.equal(entry.authUrl, printed);
  assert.equal(entry.attemptId, "1");
  const { command, args, options } = calls.spawned[0];
  assert.equal(command, "claude.exe");
  assert.deepEqual(args, ["--x", "auth", "login"]);
  assert.equal(options.windowsHide, true);
  assert.deepEqual(options.stdio, ["pipe", "pipe", "pipe"]);
  assert.equal(JSON.stringify(service.snapshot()).includes("claude.com"), false);

  calls.spawned[0].worker.emit("close", 0);
  await settle();
  assert.equal(service.entry("claude").status, "succeeded");
  assert.deepEqual(calls.changed, ["claude"]);
});

test("the printed link and the invalid-code notice survive stream chunk boundaries", async () => {
  const printed = "https://claude.com/cai/oauth/authorize?code=true&state=abc";
  const { service, calls } = createService({
    claudeUrlWaitMs: 5_000,
    spawnProcess: (command, args, options) => {
      const worker = fakeWorker(100);
      calls.spawned.push({ command, args, options, worker });
      setImmediate(() => {
        worker.stdout.emit("data", "Opening browser to sign in…\nIf the browser didn't open, visit: https://claude.com/cai/oauth/auth");
        worker.stderr.emit("data", "noise without newline ");
        worker.stdout.emit("data", "orize?code=true&state=abc\r\nPaste code here if prompted > ");
      });
      return worker;
    },
  });
  const started = await service.start("claude");
  assert.equal(started.authUrl, printed, "a link cut by a chunk boundary must not be accepted");

  const { worker } = calls.spawned[0];
  worker.stderr.emit("data", "Invalid co");
  assert.equal(service.entry("claude").error, null, "a partial notice line is not matched yet");
  worker.stdout.emit("data", "de. unrelated stdout\n");
  assert.equal(service.entry("claude").error, null, "stdout and stderr lines are framed separately");
  worker.stderr.emit("data", "de. Please make sure the full code was copied.\n");
  assert.match(service.entry("claude").error, /не принял код/u);
});

test("a start without a printed link returns after the bounded wait instead of hanging", async () => {
  const { service } = createService({ claudeUrlWaitMs: 20 });
  const entry = await service.start("claude");
  assert.equal(entry.status, "pending");
  assert.equal(entry.authUrl, null);
});

test("the manual code goes once, verbatim, to the stdin of the exact running Claude attempt", async () => {
  const { service, calls } = createService();
  const started = await service.start("claude");
  const { worker } = calls.spawned[0];

  for (const bad of ["", "   ", "no-hash", "#state", "code#", "a#b#c", "code #state", "x".repeat(4097)]) {
    await assert.rejects(service.submitCode("claude", bad, started.attemptId), /code#state/u);
  }
  await assert.rejects(service.submitCode("claude", CODE, "999"), /другой попытке/u);
  await assert.rejects(service.submitCode("codex", CODE, started.attemptId), /только для Claude/u);
  assert.deepEqual(worker.stdin.writes, [], "rejected codes never reach the CLI");

  const submitted = await service.submitCode("claude", `  ${CODE}\n`, started.attemptId);
  assert.equal(submitted.status, "pending");
  assert.deepEqual(worker.stdin.writes, [`${CODE}\n`]);

  worker.stderr.emit("data", "Invalid code. Please make sure the full code was copied.\n");
  assert.match(service.entry("claude").error, /не принял код/u);
  await service.submitCode("claude", CODE, started.attemptId);
  assert.equal(service.entry("claude").error, null, "a new code clears the previous notice");

  worker.emit("close", 0);
  await settle();
  assert.equal(service.entry("claude").status, "succeeded");
  await assert.rejects(service.submitCode("claude", CODE, started.attemptId), /ожидающего код/u);

  const everything = JSON.stringify([service.snapshot(), service.entry("claude"), calls.errors]);
  assert.equal(everything.includes("Kc0de"), false, "the code is kept nowhere");
  assert.equal(everything.includes("sTaTe"), false);
});

test("a code for a replaced, cancelled or exited attempt is refused", async () => {
  const { service, calls } = createService();
  const first = await service.start("claude");
  const second = await service.start("claude");
  await assert.rejects(service.submitCode("claude", CODE, first.attemptId), /другой попытке/u);
  assert.deepEqual(calls.spawned[0].worker.stdin.writes, []);

  await service.cancel("claude");
  await assert.rejects(service.submitCode("claude", CODE, second.attemptId), /ожидающего код/u);
  assert.deepEqual(calls.spawned[1].worker.stdin.writes, []);

  const third = await service.start("claude");
  calls.spawned[2].worker.emit("close", 1);
  await assert.rejects(service.submitCode("claude", CODE, third.attemptId), /ожидающего код/u);
  assert.equal(manualClaudeLoginCode(` ${CODE} `), CODE);
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

test("dispose fences in-flight and queued operations: no pending sign-in survives shutdown", async () => {
  const release = deferred();
  const rpc = [];
  const timers = [];
  const spawned = [];
  const { service } = createService({
    sendRpc: async (method, params) => {
      rpc.push([method, params.loginId ?? null]);
      if (method !== "account/login/start") return {};
      await release.promise;
      return { loginId: "login-1", authUrl: "https://auth.example/1" };
    },
    spawnProcess: () => { spawned.push(true); return fakeWorker(900); },
    timers: {
      setTimeout: (callback) => { timers.push(callback); return {}; },
      clearTimeout: () => {},
    },
  });
  const first = service.start("codex");
  const second = service.start("codex");
  await settle();
  service.dispose();
  const claude = service.start("claude");
  const code = service.submitCode("claude", CODE, "1");
  release.resolve();
  await assert.rejects(first, /останавливается/u);
  await assert.rejects(second, /останавливается/u);
  await assert.rejects(claude, /останавливается/u);
  await assert.rejects(code, /останавливается/u);
  assert.deepEqual(rpc, [["account/login/start", null], ["account/login/cancel", "login-1"]]);
  assert.equal(timers.length, 0, "no sign-in timeout may be armed after dispose");
  assert.equal(spawned.length, 0, "no sign-in CLI may start after dispose");
  assert.deepEqual(service.snapshot().map((entry) => entry.status), ["cancelled", "idle"]);
  assert.equal((await service.cancel("codex")).status, "cancelled");
  assert.equal(rpc.length, 2);
});

test("unknown providers and malformed Codex responses are rejected", async () => {
  const { service } = createService({ sendRpc: async () => ({ loginId: "x", authUrl: "http://insecure" }) });
  assert.throws(() => service.start("gemini"), /Неизвестный провайдер/u);
  await assert.rejects(service.start("codex"), /не вернул ссылку/u);
  assert.equal(service.entry("codex").status, "failed");
});
