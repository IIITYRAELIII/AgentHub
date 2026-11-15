import assert from "node:assert/strict";
import test from "node:test";
import { createDesktopApplicationRouter } from "../../../src/interfaces/desktop/desktop-application-router.mjs";
import { ServerControlController } from "../../../src/interfaces/web/server-control-controller.mjs";
import { ProviderLoginService } from "../../../src/application/provider-login-service.mjs";
import { DesktopControlServer, callDesktopControl } from "../../../src/infrastructure/process/desktop-control.mjs";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const CODE = "Kc0de-AbC_123#sTaTe-456_xyz";

test("hub410 official login replies cross actual IPC without unrelated oversized snapshots", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hub410-login-ipc-"));
  let broadReads = 0, starts = 0;
  const worker = new EventEmitter(); worker.pid = 4242; worker.stdout = new EventEmitter(); worker.stderr = new EventEmitter();
  const submitted = []; worker.stdin = { write: (value, done) => { submitted.push(value); done(); } }; worker.kill = () => {};
  const service = new ProviderLoginService({
    sendRpc: async method => { if (method === "account/login/start") { starts++; return { loginId: "synthetic-login", authUrl: "https://auth.example/synthetic" }; } return {}; },
    resolveClaudeInvocation: () => ({ command: "synthetic-cli" }), spawnProcess: () => worker,
    stopProcessTree: async () => true, readClaudeLoggedIn: async () => true, claudeUrlWaitMs: 0,
    timers: { setTimeout: () => null, clearTimeout() {} }, logger: { error() {} },
  });
  const controller = createController({ providerLogin: service, desktopSnapshot: async () => {
    broadReads++; return { unrelatedHistory: "synthetic-unrelated-history".repeat(200_000) };
  } });
  const router = createDesktopApplicationRouter({
    handlers: new Proxy({}, { get: (_target, name) => controller[name]?.bind(controller) ?? (async () => assert.fail(`unused handler ${String(name)}`)) }),
    commands: { dispatch: async () => assert.fail("login is not a Task mutation"), settingTarget: () => ({}) },
  });
  const server = new DesktopControlServer({ runtimeRoot: directory, handler: router.handleDesktopControl, protectSecret: async () => {} });
  try {
    await server.start();
    const invoke = (action, params) => callDesktopControl(action, params, { runtimeRoot: directory });
    const started = await invoke("start-provider-login", { provider: "codex" });
    assert.equal(started.accepted, true); assert.equal(started.login.authUrl, "https://auth.example/synthetic");
    assert.equal(starts, 1); assert.equal(started.accounts[0].attemptId, started.login.attemptId);
    assert.ok(Buffer.byteLength(JSON.stringify(started)) < 8192);
    const claude = await invoke("start-provider-login", { provider: "claude" });
    const reply = await invoke("submit-provider-login-code", { provider: "claude", attemptId: claude.login.attemptId, code: CODE });
    assert.deepEqual(submitted, [`${CODE}\n`]); assert.equal(JSON.stringify(reply).includes(CODE), false);
    const cancelled = await invoke("cancel-provider-login", { provider: "codex" });
    assert.equal(cancelled.login.status, "cancelled"); assert.equal(cancelled.accounts[0].status, "cancelled");
    assert.equal(broadReads, 0, "an already-started login reply cannot depend on a full desktop read");
    assert.equal(JSON.stringify(started.accounts).includes("auth.example"), false);
  } finally { service.dispose(); await server.close(); await rm(directory, { recursive: true, force: true }); }
});

function createController(overrides = {}) {
  return new ServerControlController({
    config: { projectRoot: "C:/work", configPath: "C:/runtime/config.json", components: {}, miniApp: {} },
    desktopSnapshot: async () => ({ refreshed: true }),
    spawnCapture: async () => ({ code: 0, stdout: "", stderr: "" }),
    preTurnInstructions: { snapshot: async () => ({}), updateGlobal: async (content) => ({ content }) },
    readAutostart: async () => ({ supported: false, enabled: false }),
    ...overrides,
  });
}

test("server snapshot exposes login state and only allowlisted current-account fields", async () => {
  const controller = createController({
    providerLogin: {
      snapshot: () => [
        { provider: "codex", status: "pending", attemptId: "4", authUrl: "https://auth.example/1", startedAt: "s", finishedAt: null, error: null, loginId: "hidden", currentAccount: { state: "signed-in", email: "me@example.test", method: "chatgpt", accessToken: "secret-token", accountId: "private-id" } },
        { provider: "claude", status: "failed", attemptId: "3", authUrl: null, startedAt: "s", finishedAt: "f", error: "denied", code: CODE },
      ],
    },
  });
  const snapshot = await controller.snapshot();
  assert.deepEqual(snapshot.accounts, [
    { provider: "codex", status: "pending", attemptId: "4", startedAt: "s", finishedAt: null, error: null, currentAccount: { state: "signed-in", email: "me@example.test", method: "chatgpt" } },
    { provider: "claude", status: "failed", attemptId: "3", startedAt: "s", finishedAt: "f", error: "denied", currentAccount: { state: "unknown" } },
  ]);
  const serialized = JSON.stringify(snapshot);
  for (const secret of ["auth.example", "hidden", "Kc0de", "sTaTe", "secret-token", "private-id"]) assert.equal(serialized.includes(secret), false);
});

test("server controller starts, submits a code and cancels without echoing the code", async () => {
  const calls = [];
  const controller = createController({
    providerLogin: {
      snapshot: () => [],
      start: async (provider) => { calls.push(["start", provider]); return { provider, status: "pending", attemptId: "1", authUrl: "https://auth.example/1" }; },
      submitCode: async (provider, code, attemptId) => { calls.push(["code", provider, code, attemptId]); return { provider, status: "pending", attemptId }; },
      cancel: async (provider) => { calls.push(["cancel", provider]); return { provider, status: "cancelled", authUrl: null }; },
    },
  });
  const started = await controller.startProviderLogin({ provider: "codex" });
  assert.equal(started.login.authUrl, "https://auth.example/1");
  assert.deepEqual(started.accounts, []);
  const submitted = await controller.submitProviderLoginCode({ provider: "claude", code: CODE, attemptId: "1" });
  assert.equal(JSON.stringify(submitted).includes("Kc0de"), false);
  const cancelled = await controller.cancelProviderLogin({ provider: "codex" });
  assert.equal(cancelled.login.status, "cancelled");
  assert.deepEqual(calls, [["start", "codex"], ["code", "claude", CODE, "1"], ["cancel", "codex"]]);
});

test("server controller without a sign-in service reports it instead of failing silently", async () => {
  const controller = createController();
  assert.deepEqual((await controller.snapshot()).accounts, []);
  await assert.rejects(controller.startProviderLogin({ provider: "codex" }), /недоступен/u);
  await assert.rejects(controller.submitProviderLoginCode({ provider: "claude", code: CODE }), /недоступен/u);
});

test("provider sign-in and its code are available only to the local Hub", async () => {
  const calls = [];
  const handlers = new Proxy({}, {
    get: (_target, name) => async (params) => {
      calls.push([name, params?.provider]);
      return { accepted: true };
    },
  });
  const control = createDesktopApplicationRouter({
    handlers,
    commands: { dispatch: async () => ({ accepted: true }), settingTarget: () => ({}) },
  });
  for (const action of ["start-provider-login", "submit-provider-login-code", "cancel-provider-login"]) {
    for (const source of ["trusted-device", "telegram-mini-app", "shared-dashboard-bot", ""]) {
      await assert.rejects(
        () => control.handleDesktopControl({ action, params: { provider: "claude", code: CODE }, context: { source, userId: "7" } }),
        /только локальному Agent Hub/u,
      );
    }
    // The local VS Code panel reaches /api/control with its webview session.
    for (const source of ["desktop-control", "local-mini-app", "local-vscode-webview"]) {
      assert.ok(await control.handleDesktopControl({
        action,
        params: { provider: "claude", code: CODE },
        context: { source, userId: "7", commandId: `cmd-${source}` },
      }));
    }
  }
  assert.deepEqual(calls, [
    ["startProviderLogin", "claude"], ["startProviderLogin", "claude"], ["startProviderLogin", "claude"],
    ["submitProviderLoginCode", "claude"], ["submitProviderLoginCode", "claude"], ["submitProviderLoginCode", "claude"],
    ["cancelProviderLogin", "claude"], ["cancelProviderLogin", "claude"], ["cancelProviderLogin", "claude"],
  ]);
});
