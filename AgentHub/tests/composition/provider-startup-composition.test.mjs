import assert from "node:assert/strict";
import test from "node:test";

import { createProviderStartupComposition } from "../../src/composition/provider-startup-composition.mjs";

function fixture(config = {}, refreshCodexModels = async () => {},
  refreshClaudeModels = async () => {}, startCodex = async () => {},
  waitForModelRetry = async () => {}) {
  const calls = [];
  const service = createProviderStartupComposition({
    config: {
      telegramEnabled: true,
      createInitialThreadOnStartup: true,
      codexSandboxMode: "workspace-write",
      ...config,
    },
    threadListLimit: 10,
    selectionStore: { setThread() {}, setTitle() {} },
    taskRuns: { values: () => [], forTask: () => null },
    agentProviders: { call: async (...args) => calls.push(["create", ...args]) },
    codexProviderTasks: { discoverTasks: async () => [] },
    getProvider: () => "codex",
    getProjectRoot: () => "D:/contour",
    getThreadId: () => null,
    isCodex: () => true,
    startCodex: async () => { calls.push(["start"]); await startCodex(); },
    initializeCodex: async (options) => calls.push(["initialize", options]),
    sendRpc: async () => ({}),
    refreshCodexModels,
    refreshClaudeModels,
    waitForModelRetry,
    resolveResumedCodexThreadTitle: async () => "Thread",
    applyCodexThreadSettings() {},
    saveState: async () => {},
  });
  return { service, calls };
}

test("provider startup can skip the empty Telegram bootstrap Thread", async () => {
  const { service, calls } = fixture({ createInitialThreadOnStartup: false });

  await service.initializeProvider();

  assert.deepEqual(calls, [
    ["start"],
    ["initialize", { attachSelectedThread: false }],
  ]);
});

test("failed startup catalog retries in background and a later complete response becomes available", async () => {
  const attempts = [];
  const { service } = fixture({ createInitialThreadOnStartup: false }, async ({ source }) => {
    attempts.push(source);
    return attempts.length === 3;
  }, async () => {}, async () => {}, async () => {});
  await service.initializeProvider();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(attempts, ["startup", "startup-retry-1", "startup-retry-2"]);
});

test("provider startup begins model discovery without waiting for it", async () => {
  let releaseDiscovery;
  const discovery = new Promise((resolve) => { releaseDiscovery = resolve; });
  const { service, calls } = fixture({}, async () => {
    calls.push(["codex-discover"]);
    await discovery;
  }, async () => calls.push(["claude-discover"]));

  await service.initializeProvider();
  assert.deepEqual(calls, [
    ["start"],
    ["claude-discover"],
    ["initialize", { attachSelectedThread: false }],
    ["create", "codex", "createTask"],
    ["codex-discover"],
  ]);
  releaseDiscovery();
});

test("Claude discovery still starts when Codex App Server cannot start", async () => {
  const { service, calls } = fixture({}, async () => calls.push(["codex-discover"]),
    async () => calls.push(["claude-discover"]),
    async () => { throw new Error("Codex unavailable"); });
  await assert.rejects(service.initializeProvider(), /Codex unavailable/u);
  assert.deepEqual(calls, [["start"], ["claude-discover"]]);
});
