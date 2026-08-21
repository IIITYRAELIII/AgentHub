import assert from "node:assert/strict";
import test from "node:test";

import { createProviderStartupComposition } from "../../src/composition/provider-startup-composition.mjs";

function fixture(config = {}) {
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
    startCodex: async () => calls.push(["start"]),
    initializeCodex: async (options) => calls.push(["initialize", options]),
    sendRpc: async () => ({}),
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
