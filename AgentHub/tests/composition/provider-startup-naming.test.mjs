import assert from "node:assert/strict";
import test from "node:test";

import { createProviderStartupComposition } from "../../src/composition/provider-startup-composition.mjs";

function fixture(overrides = {}) {
  const calls = [];
  const service = createProviderStartupComposition({
    config: {
      telegramEnabled: true,
      createInitialThreadOnStartup: true,
      codexSandboxMode: "workspace-write",
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
    logger: { error() {}, warn() {} },
    ...overrides,
  });
  return { service, calls };
}

for (const stage of ["naming", "resume-timeout", "save"]) {
  test(`startup ${stage} failure retains the exact Thread and never creates a replacement`, async () => {
    const selected = [];
    const failure = new Error(stage);
    failure.code = "HUB_THREAD_NAMING_PENDING";
    const { service, calls } = fixture({
      getThreadId: () => "exact-thread",
      selectionStore: { setThread: (...args) => selected.push(args), setTitle() {} },
      sendRpc: async () => {
        if (stage === "resume-timeout") throw new Error("RPC timed out");
        return { thread: { id: "exact-thread", cwd: "D:/contour" } };
      },
      resolveResumedCodexThreadTitle: async () => { if (stage === "naming") throw failure; return "Workspace - S8 1"; },
      saveState: async () => { if (stage === "save") throw new Error("disk failure"); },
    });
    assert.equal(await service.attachCodexThread(), false);
    assert.deepEqual(selected, []);
    assert.equal(calls.some(([event]) => event === "create"), false);
  });
}

test("startup still replaces a definitively missing provider Thread, but never from naming failure", async () => {
  const { service, calls } = fixture({
    getThreadId: () => "missing-thread",
    sendRpc: async () => { throw new Error("thread not found: missing-thread"); },
  });
  assert.equal(await service.attachCodexThread(), true);
  assert.equal(calls.filter(([event]) => event === "create").length, 1);
});
