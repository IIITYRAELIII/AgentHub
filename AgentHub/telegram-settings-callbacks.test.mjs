import assert from "node:assert/strict";
import test from "node:test";
import { TelegramSettingsCallbackService } from "./telegram-settings-callbacks.mjs";

function service(events, changed = true) {
  const getter = (value) => () => value;
  return new TelegramSettingsCallbackService({
    telegram: async (method, body) => events.push({ method, body }),
    dispatchSetting: async (_callback, name, value) => {
      events.push({ name, value });
      return { setting: { changed } };
    },
    sendMessage: async (text) => events.push({ text }),
    formatApprovalMode: () => "approval",
    approvalModeKeyboard: () => ({ inline_keyboard: [] }),
    providerTitle: () => "Codex",
    activeProject: () => ({ name: "Workspace" }),
    activeProvider: getter("codex"),
    autoApprove: getter(true),
    codexModel: getter("sol"),
    codexModelLabel: (value) => value.toUpperCase(),
    codexReasoningEffort: getter("high"),
    codexCollaborationMode: getter("work"),
    claudeModel: getter("opus"),
    claudeReasoningEffort: getter("high"),
    claudeCollaborationMode: getter("work"),
    projects: [{ name: "Workspace", path: "D:/workspace" }],
    reasoningLabels: { high: "High" },
    collaborationModeLabels: { work: "Work" },
    claudeModelLabels: { opus: "Opus" },
  });
}

const callback = { id: "cb", message: { chat: { id: 1 }, message_id: 2 } };

test("settings callback service handles project and model routes", async () => {
  const events = [];
  const callbacks = service(events);
  assert.equal(await callbacks.handle(callback, { kind: "project", index: 0 }), true);
  assert.equal(await callbacks.handle(callback, { kind: "codex-model", model: "sol" }), true);
  assert.ok(events.some((event) => event.name === "project" && event.value === "D:/workspace"));
  assert.ok(events.some((event) => event.text === "Codex model: SOL"));
});

test("settings callback service declines unrelated routes", async () => {
  assert.equal(await service([]).handle(callback, { kind: "task-view" }), false);
});

