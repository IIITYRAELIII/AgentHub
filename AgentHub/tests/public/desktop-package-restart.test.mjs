import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { RestartRequestService } from "../../src/application/restart-request-service.mjs";
import { packageBindingDigest } from "../../src/infrastructure/filesystem/runtime-package-target.mjs";
import { MaintenanceOperationStore } from "../../src/infrastructure/persistence/maintenance-operation-store.mjs";
import { callDesktopControl, DesktopControlServer, desktopControlSecretFile } from "../../src/infrastructure/process/desktop-control.mjs";
import { createDesktopApplicationRouter } from "../../src/interfaces/desktop/desktop-application-router.mjs";
import { createDesktopControlRouter } from "../../src/interfaces/desktop/desktop-control-router.mjs";

async function fixture(t, { preparationError = null, stopping = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-package-control-"));
  let server;
  t.after(async () => {
    await server?.close();
    await rm(root, { recursive: true, force: true });
  });
  const dataDir = path.join(root, "data");
  await mkdir(dataDir);
  const store = new MaintenanceOperationStore({ dataDir });
  const input = { operationId: "package-control-original", tag: "2.1.3",
    archive: path.join(root, "release.zip"), descriptor: path.join(root, "release.json"),
    installer: path.join(root, "install_release.py") };
  // Initialize the isolated store before read-only negative-case assertions.
  assert.equal(store.get(input.operationId), null);
  const events = [], received = [];
  let request = null, schedules = 0, handlerCalls = 0;
  const service = new RestartRequestService({
    operationStore: store, currentTarget: () => ({}),
    getRequest: () => request, setRequest: value => { request = value; },
    blockingWorkCount: () => 1, currentChatId: () => null,
    updateOffset: () => 0, processingUpdateId: () => null,
    saveState: async () => { assert.ok(store.getReadonly(input.operationId)); events.push("persisted-before-save"); },
    announceDesktop: async () => {}, sendTelegram: async () => {},
    performRestart: () => assert.fail("isolated intake must not stop or replace a runtime"),
    scheduleRestart: () => { schedules++; }, isStopping: () => stopping,
    // The actual owner performs strict validation, original lookup and durable
    // admission. Package I/O is the controlled port; no real assets or Host run.
    preparePackage: async params => {
      events.push("prepare"); received.push(params);
      if (preparationError) throw preparationError;
      const binding = { operationId: params.operationId };
      return { schema: 1, binding, sha256: packageBindingDigest(binding) };
    },
  });
  const handlers = new Proxy({
    restartPackage: params => service.fromPackage(params),
    snapshot: async params => ({ params }),
  }, { get: (target, key) => key in target ? target[key] : async () => assert.fail(`unrelated handler ${String(key)}`) });
  const router = createDesktopApplicationRouter({ handlers,
    commands: { dispatch: async () => assert.fail("package admission has its existing owner"), settingTarget: () => ({}) },
    receiptFile: path.join(root, "desktop-receipts.json"),
  });
  server = new DesktopControlServer({ runtimeRoot: root, protectSecret: async () => {},
    handler: value => { handlerCalls++; return router.handleDesktopControl(value); },
  });
  await server.start();
  return { input, store, router, events, received, root,
    schedules: () => schedules, handlerCalls: () => handlerCalls,
    send: (params = input, commandId = input.operationId) => callDesktopControl("restart-package", params, { runtimeRoot: root, commandId }),
  };
}

test("authenticated Desktop package input reaches its real owner once under the original identity", async t => {
  const f = await fixture(t);
  const result = await f.send();
  assert.deepEqual(result, { accepted: true, waiting: true, operationId: f.input.operationId });
  assert.deepEqual(f.received, [f.input]);
  assert.deepEqual(f.events, ["prepare", "persisted-before-save"]);
  const original = f.store.getReadonly(f.input.operationId);
  assert.equal(original.status, "blocked");
  assert.equal(original.phase, "waiting-for-work");
  assert.deepEqual(original.blockers, ["active-work"]);
  assert.equal(original.metadata.packageInputSha256, packageBindingDigest(f.input));
  assert.deepEqual(await f.send(), result); // Same durable Desktop command.
  assert.equal((await f.send(f.input, "package-original-readback")).accepted, false);
  assert.deepEqual(f.store.getReadonly(f.input.operationId), original);
  assert.equal(f.received.length, 1);
  assert.equal(f.schedules(), 0);
  await assert.rejects(f.send({ ...f.input, tag: "2.1.4" }), /fingerprint conflict/u);
  await assert.rejects(f.send({ ...f.input, tag: "2.1.4" }, "changed-business-input"), /input changed/u);
  assert.deepEqual(f.store.getReadonly(f.input.operationId), original);
});

test("authenticated Desktop package input keeps every foreign key for strict owner refusal", async t => {
  const f = await fixture(t);
  for (const [index, extra] of [{ foreign: true }, { maxResponseBytes: 123 },
    { limit: 1 }, { clientTiming: {} }, { source: "desktop-control" }].entries()) {
    await assert.rejects(f.send({ ...f.input, ...extra }, `foreign-package-key-${index}`),
      /Package restart requires only its exact original and public asset paths/u);
  }
  assert.equal(f.store.getReadonly(f.input.operationId), null);
  assert.deepEqual(f.events, []);
  assert.equal(f.schedules(), 0);
});

test("authenticated Desktop package preparation refusal does not admit or schedule a restart", async t => {
  const f = await fixture(t, { preparationError: new Error("package backup preflight refused") });
  await assert.rejects(f.send(), /package backup preflight refused/u);
  assert.deepEqual(f.received, [f.input]);
  assert.equal(f.store.getReadonly(f.input.operationId), null);
  assert.equal(f.schedules(), 0);
});

test("authenticated Desktop package admission preserves the existing stopping fence", async t => {
  const f = await fixture(t, { stopping: true });
  await assert.rejects(f.send(), /Runtime is already stopping/u);
  assert.deepEqual(f.events, []);
  assert.equal(f.store.getReadonly(f.input.operationId), null);
  assert.equal(f.schedules(), 0);
});

test("Desktop package authentication fails before the application router and owner", async t => {
  const f = await fixture(t);
  const secretFile = desktopControlSecretFile(f.root);
  const secret = await readFile(secretFile);
  try {
    await writeFile(secretFile, "invalid-client-secret".repeat(4));
    await assert.rejects(f.send(), /authentication failed/iu);
  } finally {
    await writeFile(secretFile, secret);
  }
  assert.equal(f.handlerCalls(), 0);
  assert.deepEqual(f.events, []);
  assert.equal(f.store.getReadonly(f.input.operationId), null);
});

test("package local privilege and ordinary response budgets keep their existing boundaries", async t => {
  const f = await fixture(t);
  for (const source of ["trusted-device", "telegram-mini-app", "foreign"]) {
    await assert.rejects(f.router.handleDesktopControl({ action: "restart-package", params: f.input,
      context: { source, commandId: `remote-package-${source}` } }), /локальному/u);
  }
  assert.deepEqual(f.events, []);
  const accepted = await f.router.handleDesktopControl({ action: "restart-package", params: f.input,
    context: { source: "local-mini-app", commandId: "local-package-original" } });
  assert.equal(accepted.accepted, true);
  assert.deepEqual(f.received, [f.input]);
  assert.equal(f.schedules(), 0);
  const desktop = await f.router.handleDesktopControl({ action: "snapshot", params: { maxResponseBytes: 9_000_000 },
    context: { source: "desktop-control" } });
  assert.equal(desktop.params.maxResponseBytes, 3_500_000);
  const mini = await f.router.handleDesktopControl({ action: "snapshot", params: {},
    context: { source: "telegram-mini-app" } });
  assert.equal(mini.params.maxResponseBytes, 850_000);
  assert.equal(mini.params.compactSnapshot, true);
});

for (const [key, value] of [["clientTiming", {}], ["clientTraceId", "forbidden-trace"]]) {
  test(`same-command package replay rejects an added ${key} before cached success`, async t => {
    const f = await fixture(t);
    const accepted = await f.send();
    const original = f.store.getReadonly(f.input.operationId);
    const receiptFile = path.join(f.root, "desktop-receipts.json");
    const receipt = JSON.parse(await readFile(receiptFile, "utf8")).records
      .find(row => row.id === f.input.operationId);
    await assert.rejects(f.send({ ...f.input, [key]: value }), /fingerprint conflict|Package restart requires/u);
    assert.deepEqual(f.store.getReadonly(f.input.operationId), original);
    assert.deepEqual(f.received, [f.input]);
    assert.equal(f.schedules(), 0);
    assert.deepEqual(JSON.parse(await readFile(receiptFile, "utf8")).records
      .find(row => row.id === f.input.operationId), receipt);
    assert.deepEqual(await f.send(), accepted);
    assert.deepEqual(f.store.getReadonly(f.input.operationId), original);
    assert.equal(f.received.length, 1);
  });
}

test("ordinary mutation keeps trace-only replay independent from business input", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-ordinary-trace-replay-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let effects = 0;
  const router = createDesktopControlRouter({
    handlers: { mutate: async () => ({ effect: ++effects }) }, mutationActions: ["mutate"],
    receiptFile: path.join(root, "receipts.json"),
  });
  const request = { action: "mutate", params: { value: 7 },
    context: { source: "desktop-control", commandId: "ordinary-original" } };
  const original = await router.handleDesktopControl(request);
  assert.deepEqual(await router.handleDesktopControl({ ...request,
    params: { value: 7, clientTiming: {}, clientTraceId: "new-observation" } }), original);
  assert.equal(effects, 1);
  await assert.rejects(router.handleDesktopControl({ ...request, params: { value: 8 } }), /fingerprint conflict/u);
  assert.equal(effects, 1);
});
