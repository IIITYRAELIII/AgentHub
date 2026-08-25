import assert from "node:assert/strict";
import test from "node:test";

import { createCodexTaskSettingsComposition } from "../../src/composition/codex-task-settings-composition.mjs";

function dependencies({ sendRpc, events }) {
  return {
    pinnedTaskTitle: () => "",
    readCodexThreadTitleHistory: async () => ({}),
    sendRpc,
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
