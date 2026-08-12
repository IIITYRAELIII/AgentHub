import assert from "node:assert/strict";
import test from "node:test";
import { ServerControlController } from "../../../src/interfaces/web/server-control-controller.mjs";

function createController(overrides = {}) {
  return new ServerControlController({
    config: { projectRoot: "C:/work", configPath: "C:/runtime/config.json", components: {}, miniApp: {} },
    startedAt: "2026-08-04T00:00:00.000Z",
    instanceId: "instance",
    releaseId: "release",
    shortcutPath: "C:/Startup/Agent Hub.lnk",
    installScriptPath: "C:/runtime/AgentHub.RuntimeHost.exe",
    processId: 42,
    activeCount: () => 3,
    restartState: () => ({ pending: true, waiting: true, blockingCount: 2 }),
    desktopSnapshot: async () => ({ refreshed: true }),
    spawnCapture: async () => ({ code: 0, stdout: "", stderr: "" }),
    preTurnInstructions: {
      snapshot: async () => ({ guide: { content: "Guide" }, global: { content: "" } }),
      updateGlobal: async (content) => ({ content }),
    },
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
  assert.equal(invocation[0], "C:/runtime/AgentHub.RuntimeHost.exe");
  assert.deepEqual(invocation[1], ["--install-autostart"]);
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

test("server controller reads and updates only the configured root AGENTS.md", async () => {
  const calls = [];
  const controller = createController({
    config: { projectRoot: "C:/workspace", configPath: "C:/runtime/config.json", components: {}, miniApp: {} },
    readRootAgentsFile: async (options) => {
      calls.push(["read", options]);
      return { content: "# Rules\n", bytes: 8, maximumBytes: 131_072, exists: true };
    },
    updateRootAgentsFile: async (content, options) => {
      calls.push(["update", content, options]);
      return { content, bytes: 9, maximumBytes: 131_072, exists: true };
    },
  });
  assert.equal((await controller.readRootAgents({ path: "C:/escape.md" })).content, "# Rules\n");
  const result = await controller.updateRootAgents({ content: "# Updated", path: "C:/escape.md" });
  assert.equal(result.accepted, true);
  assert.equal(result.document.content, "# Updated");
  assert.match(calls[0][1].file, /workspace[\\/]AGENTS\.md$/u);
  assert.equal(calls[1][1], "# Updated");
  assert.equal(calls[1][2].file, calls[0][1].file);
});

test("server controller exposes Guide and updates only Global pre-turn instructions", async () => {
  const calls = [];
  const controller = createController({
    preTurnInstructions: {
      snapshot: async () => ({ guide: { content: "Guide" }, global: { content: "Global" } }),
      updateGlobal: async (content) => {
        calls.push(content);
        return { content, bytes: 7, maximumBytes: 32_768, exists: true };
      },
    },
  });
  assert.equal((await controller.readPreTurnInstructions()).guide.content, "Guide");
  const result = await controller.updateGlobalPreTurnInstructions({ content: "Updated" });
  assert.deepEqual(calls, ["Updated"]);
  assert.equal(result.document.content, "Updated");
});
