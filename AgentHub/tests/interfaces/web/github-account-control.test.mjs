import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createDesktopApplicationRouter } from "../../../src/interfaces/desktop/desktop-application-router.mjs";
import { ServerControlController } from "../../../src/interfaces/web/server-control-controller.mjs";
import { GitHubAccountService } from "../../../src/application/github-account-service.mjs";
import { GitHubAccountVault } from "../../../src/infrastructure/filesystem/github-account-vault.mjs";
import { GitHubDeviceAuthorization } from "../../../src/infrastructure/network/github-device-authorization.mjs";
import { createRuntimeRestartComposition } from "../../../src/composition/runtime-restart-composition.mjs";

test("protected local control connects/disconnects shared account without secret receipts or command dispatch", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hub-github-control-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const token = "github_pat_SYNTHETIC_CONTROL_VALUE_123456";
  const deviceCode = "synthetic_device_code_12345678901234567890";
  let now = Date.now();
  const fetchImpl = async url => {
    if (url.endsWith("/login/device/code")) return Response.json({ device_code: deviceCode, user_code: "ABCD-EFGH",
      verification_uri: "https://github.com/login/device", expires_in: 900, interval: 5 });
    if (url.endsWith("/login/oauth/access_token")) return Response.json({ access_token: token, token_type: "bearer" });
    return url.endsWith("/user") ? Response.json({ id: 111, login: "hub-account", name: "Hub Account" }) : new Response("", { status: 403 });
  };
  const vault = new GitHubAccountVault({ directory, crypt: async bytes => Buffer.from(bytes).reverse(), protect: async () => {} });
  const service = await new GitHubAccountService({ directory, vault,
    fetchImpl, deviceAuthorization: new GitHubDeviceAuthorization({ clientId: "public_fixture", fetchImpl, now: () => now }),
  }).initialize();
  const controller = new ServerControlController({ config: { projectRoot: directory, components: {}, miniApp: {} },
    desktopSnapshot: async () => ({}), spawnCapture: async () => ({}), preTurnInstructions: {},
    readAutostart: async () => ({}), githubAccount: service });
  const handlers = new Proxy({ connectGitHub: params => controller.connectGitHub(params),
    pollGitHubLogin: params => controller.pollGitHubLogin(params), cancelGitHubLogin: params => controller.cancelGitHubLogin(params),
    disconnectGitHub: () => controller.disconnectGitHub(), snapshot: () => controller.snapshot() },
  { get: (target, name) => target[name] ?? (async () => ({})) });
  const dispatches = [], traces = [];
  const receiptFile = path.join(directory, "control-receipts.json");
  const router = createDesktopApplicationRouter({ handlers, receiptFile,
    commands: { dispatch: async (...args) => { dispatches.push(args); }, settingTarget: () => ({}) },
    commandTrace: { recordBestEffort: value => traces.push(value) } });
  const submit = source => router.handleDesktopControl({ action: "connect-github-account", params: {}, context: { source, commandId: "github-connect" } });
  for (const source of ["trusted-device", "telegram-mini-app", "remote"]) await assert.rejects(submit(source), /локальному/u);
  const started = await submit("desktop-control");
  assert.equal(started.login.userCode, "ABCD-EFGH");
  assert.equal(JSON.stringify(started).includes(deviceCode), false);
  for (const source of ["trusted-device", "telegram-mini-app", "remote"]) {
    for (const action of ["poll-github-account-login", "cancel-github-account-login"]) {
      await assert.rejects(router.handleDesktopControl({ action, params: { attemptId: started.login.attemptId }, context: { source } }), /локальному/u);
    }
  }
  now += 5000;
  const response = await router.handleDesktopControl({ action: "poll-github-account-login", params: { attemptId: started.login.attemptId }, context: { source: "desktop-control" } });
  assert.equal(response.githubAccount.status, "connected");
  assert.equal(JSON.stringify(response).includes(token), false);
  assert.equal(JSON.stringify(await controller.snapshot()).includes(token), false);
  assert.equal(JSON.stringify(traces).includes(token), false);
  assert.deepEqual(dispatches, []);
  const receipts = await readFile(receiptFile, "utf8").catch(error => { if (error.code === "ENOENT") return ""; throw error; });
  assert.equal(receipts.includes(token), false);
  assert.equal(receipts.includes("github-connect"), false);
  const disconnected = await router.handleDesktopControl({ action: "disconnect-github-account", params: {}, context: { source: "local-mini-app" } });
  assert.equal(disconnected.githubAccount.status, "disconnected");
});

test("actual runtime resource phases fence and join account writes, recover admission, then dispose", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hub-github-drain-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const vault = new GitHubAccountVault({ directory, crypt: async bytes => Buffer.from(bytes).reverse(), protect: async () => {} });
  const service = await new GitHubAccountService({ directory, vault, fetchImpl: async url => {
    if (url.endsWith("/user")) { await held; return Response.json({ id: 34, login: "drain-account" }); }
    return new Response("", { status: 403 });
  } }).initialize();
  const noop = async () => {}, store = { close: noop };
  const { runtimeResources } = createRuntimeRestartComposition({ githubAccount: service,
    getRestartRequest: () => null, updateOffset: () => 0, hasBlockingWork: () => false,
    setWaiting: noop, updateRestartMessage: noop, saveState: noop, beginStopping: () => true, stopRuntimeTimers() {},
    runtimeStateCoordinator: { flush: noop }, telegramDeliveryService: { waitForBindingWrites: noop },
    mediaController: { waitForWrites: noop }, taskSyncStore: { save: noop, close: noop },
    deliveryOutbox: { waitForIdle: noop }, backgroundJobStore: { waitForWrites: noop }, failedUpdateStore: { waitForWrites: noop },
    workLogUsageStore: store, rateLimitHistoryStore: store, workspaceCatalogStore: store,
    taskReadStateStore: store, runtimeStateStore: store });
  const pending = service.connect("github_pat_SYNTHETIC_DRAIN_VALUE_12345");
  assert.equal((await runtimeResources.quiesce()).ok, true);
  await assert.rejects(service.disconnect(), /остановки/u);
  let joined = false;
  const drain = runtimeResources.drain().then(value => { joined = true; return value; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(joined, false);
  release();
  await pending;
  assert.equal((await drain).ok, true);
  assert.equal((await runtimeResources.recover()).ok, true);
  await service.disconnect();
  assert.equal((await runtimeResources.finalize()).ok, true);
  service.resume();
  await assert.rejects(service.connect("github_pat_SYNTHETIC_DRAIN_VALUE_12345"), /остановки/u);
});
