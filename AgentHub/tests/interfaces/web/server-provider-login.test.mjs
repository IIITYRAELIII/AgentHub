import assert from "node:assert/strict";
import test from "node:test";
import { createDesktopApplicationRouter } from "../../../src/interfaces/desktop/desktop-application-router.mjs";
import { ServerControlController } from "../../../src/interfaces/web/server-control-controller.mjs";

const CODE = "Kc0de-AbC_123#sTaTe-456_xyz";

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

test("server snapshot, which also reaches remote clients, exposes only sign-in state", async () => {
  const controller = createController({
    providerLogin: {
      snapshot: () => [
        { provider: "codex", status: "pending", attemptId: "4", authUrl: "https://auth.example/1", startedAt: "s", finishedAt: null, error: null, loginId: "hidden" },
        { provider: "claude", status: "failed", attemptId: "3", authUrl: null, startedAt: "s", finishedAt: "f", error: "denied", code: CODE },
      ],
    },
  });
  const snapshot = await controller.snapshot();
  assert.deepEqual(snapshot.accounts, [
    { provider: "codex", status: "pending", attemptId: "4", startedAt: "s", finishedAt: null, error: null },
    { provider: "claude", status: "failed", attemptId: "3", startedAt: "s", finishedAt: "f", error: "denied" },
  ]);
  const serialized = JSON.stringify(snapshot);
  for (const secret of ["auth.example", "hidden", "Kc0de", "sTaTe"]) assert.equal(serialized.includes(secret), false);
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
  assert.deepEqual(started.snapshot, { refreshed: true });
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
