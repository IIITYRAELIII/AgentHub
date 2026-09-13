import assert from "node:assert/strict";
import test from "node:test";
import { createDesktopApplicationRouter } from "../../../src/interfaces/desktop/desktop-application-router.mjs";
import { ServerControlController } from "../../../src/interfaces/web/server-control-controller.mjs";

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

test("server snapshot exposes only provider sign-in state", async () => {
  const controller = createController({
    providerLogin: {
      snapshot: () => [
        { provider: "codex", status: "pending", authUrl: "https://auth.example/1", startedAt: "s", finishedAt: null, error: null, loginId: "hidden" },
        { provider: "claude", status: "failed", authUrl: null, startedAt: "s", finishedAt: "f", error: "denied" },
      ],
    },
  });
  const snapshot = await controller.snapshot();
  assert.deepEqual(snapshot.accounts, [
    { provider: "codex", status: "pending", authUrl: "https://auth.example/1", startedAt: "s", finishedAt: null, error: null },
    { provider: "claude", status: "failed", authUrl: null, startedAt: "s", finishedAt: "f", error: "denied" },
  ]);
});

test("server controller starts and cancels provider sign-in with a refreshed snapshot", async () => {
  const calls = [];
  const controller = createController({
    providerLogin: {
      snapshot: () => [],
      start: async (provider) => { calls.push(["start", provider]); return { provider, status: "pending", authUrl: "https://auth.example/1" }; },
      cancel: async (provider) => { calls.push(["cancel", provider]); return { provider, status: "cancelled", authUrl: null }; },
    },
  });
  const started = await controller.startProviderLogin({ provider: "codex" });
  assert.equal(started.login.authUrl, "https://auth.example/1");
  assert.deepEqual(started.snapshot, { refreshed: true });
  const cancelled = await controller.cancelProviderLogin({ provider: "codex" });
  assert.equal(cancelled.login.status, "cancelled");
  assert.deepEqual(calls, [["start", "codex"], ["cancel", "codex"]]);
});

test("server controller without a sign-in service reports it instead of failing silently", async () => {
  const controller = createController();
  assert.deepEqual((await controller.snapshot()).accounts, []);
  await assert.rejects(controller.startProviderLogin({ provider: "codex" }), /недоступен/u);
});

test("provider sign-in is available only to the local Hub", async () => {
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
  for (const action of ["start-provider-login", "cancel-provider-login"]) {
    for (const source of ["trusted-device", "telegram-mini-app", "shared-dashboard-bot", ""]) {
      await assert.rejects(
        () => control.handleDesktopControl({ action, params: { provider: "codex" }, context: { source, userId: "7" } }),
        /только локальному Agent Hub/u,
      );
    }
    assert.ok(await control.handleDesktopControl({
      action,
      params: { provider: "claude" },
      context: { source: "desktop-control", userId: "7" },
    }));
  }
  assert.deepEqual(calls, [["startProviderLogin", "claude"], ["cancelProviderLogin", "claude"]]);
});
