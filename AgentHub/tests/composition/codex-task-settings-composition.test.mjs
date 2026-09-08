import assert from "node:assert/strict";
import test from "node:test";

import { createCodexTaskSettingsComposition } from "../../src/composition/codex-task-settings-composition.mjs";

function dependencies({ sendRpc, events, resumeCodexThread = async () => {} }) {
  return {
    pinnedTaskTitle: () => "",
    readCodexThreadTitleHistory: async () => ({}),
    sendRpc,
    resumeCodexThread,
    isCodex: () => true,
    getThreadId: () => "thread-1",
    contextCompactions: { isRunning: () => false },
    agentPreferences: {
      codexModel: "fake-codex",
      codexReasoningEffort: "medium",
      rememberCodexTaskSettings: () => events.push("remember"),
    },
    saveState: async () => { events.push("save"); },
    codexModelLabel: (value) => value,
    reasoningLabels: { medium: "Medium" },
  };
}

test("Codex task settings persist metadata only after provider acceptance", async () => {
  const events = [];
  const composition = createCodexTaskSettingsComposition(dependencies({
    events,
    sendRpc: async () => {
      events.push("rpc");
      const error = new Error("backend rejected settings");
      error.data = { kind: "threadBackendChangeRequiresNewThread" };
      throw error;
    },
  }));

  await assert.rejects(composition.updateActiveCodexThreadSettings(), /backend rejected/u);

  assert.deepEqual(events, ["rpc"]);
});

test("Codex task settings persist accepted provider settings before snapshot save", async () => {
  const events = [];
  const composition = createCodexTaskSettingsComposition(dependencies({
    events,
    sendRpc: async () => { events.push("rpc"); },
  }));

  await composition.updateActiveCodexThreadSettings();

  assert.deepEqual(events, ["rpc", "remember", "save"]);
});

test("Codex task settings resume an unloaded thread before persisting the requested model", async () => {
  const events = [];
  let attempts = 0;
  const composition = createCodexTaskSettingsComposition(dependencies({
    events,
    sendRpc: async (method, params) => {
      attempts += 1;
      events.push(`${method}:${params.model}`);
      if (attempts === 1) throw new Error("thread not found: thread-1");
    },
    resumeCodexThread: async ({ threadId }) => events.push(`resume:${threadId}`),
  }));

  await composition.updateActiveCodexThreadSettings();

  assert.deepEqual(events, [
    "thread/settings/update:fake-codex",
    "resume:thread-1",
    "thread/settings/update:fake-codex",
    "remember",
    "save",
  ]);
});
