import assert from "node:assert/strict";
import test from "node:test";
import { ServerControlController } from "./server-control-controller.mjs";

function createController(overrides = {}) {
  return new ServerControlController({
    config: { projectRoot: "C:/work", configPath: "C:/runtime/config.json", components: {}, miniApp: {} },
    startedAt: "2026-08-04T00:00:00.000Z",
    instanceId: "instance",
    releaseId: "release",
    shortcutPath: "C:/Startup/Agent Hub.lnk",
    installScriptPath: "C:/release/install-autostart.ps1",
    processId: 42,
    activeCount: () => 3,
    restartState: () => ({ pending: true, waiting: true, blockingCount: 2 }),
    desktopSnapshot: async () => ({ refreshed: true }),
    spawnCapture: async () => ({ code: 0, stdout: "", stderr: "" }),
    readAutostart: async () => ({ supported: true, enabled: true }),
    ...overrides,
  });
}

test("server controller composes live process, restart and autostart state", async () => {
  const snapshot = await createController().snapshot();
  assert.deepEqual(snapshot.process, {
    status: "running",
    pid: 42,
    startedAt: "2026-08-04T00:00:00.000Z",
    instanceId: "instance",
    releaseId: "release",
    activeCount: 3,
  });
  assert.deepEqual(snapshot.restart, { pending: true, waiting: true, blockingCount: 2 });
  assert.deepEqual(snapshot.autostart, { supported: true, enabled: true });
});

test("server controller owns autostart installation and refreshed response", async () => {
  let invocation = null;
  const controller = createController({
    spawnCapture: async (...args) => {
      invocation = args;
      return { code: 0, stdout: "", stderr: "" };
    },
    setAutostart: async (enabled, options) => {
      assert.equal(enabled, true);
      await options.installAutostart();
      return { supported: true, enabled };
    },
  });
  const result = await controller.setAutostart({ enabled: true });
  assert.equal(invocation[0], "powershell.exe");
  assert.deepEqual(invocation[1].slice(-2), ["-File", "C:/release/install-autostart.ps1"]);
  assert.equal(invocation[2].cwd, "C:/work");
  assert.deepEqual(result.snapshot, { refreshed: true });
  assert.match(result.message, /включён/u);
  await assert.rejects(() => controller.setAutostart({}), /состояние/u);
});

test("server controller accumulates pending safe configuration", async () => {
  const persisted = [];
  const controller = createController({
    persistConfiguration: async (request) => {
      persisted.push(request);
      return request.changes;
    },
  });
  await controller.updateConfiguration({ changes: { logMaxFiles: 7 } });
  await controller.updateConfiguration({ changes: { autoApproveOnStart: true } });
  assert.deepEqual(persisted[0], {
    configPath: "C:/runtime/config.json",
    changes: { logMaxFiles: 7 },
  });
  assert.deepEqual(controller.pendingConfiguration, {
    logMaxFiles: 7,
    autoApproveOnStart: true,
  });
});
