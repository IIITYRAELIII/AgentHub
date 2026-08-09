import assert from "node:assert/strict";
import test from "node:test";
import { TelegramSettingsCallbackService } from "../../../src/interfaces/telegram/telegram-settings-callbacks.mjs";

function service(events, changed = true) {
  const getter = (value) => () => value;
  return new TelegramSettingsCallbackService({
    telegram: async (method, body) => events.push({ method, body }),
    dispatchSetting: async (_callback, name, value) => {
      events.push({ name, value });
      return {
        selected: {
          streamId: "stream-new",
          provider: name === "provider" ? value : "codex",
          projectRoot: name === "project" ? value : "D:/workspace",
          threadId: "thread-new",
          title: "New task",
        },
        setting: { changed },
      };
    },
    sendMessage: async (text) => events.push({ text }),
    formatApprovalMode: () => "approval",
    approvalModeKeyboard: () => ({ inline_keyboard: [] }),
    providerTitle: () => "Codex",
    activeProject: () => ({ name: "Workspace" }),
    activeProvider: getter("codex"),
    selectTaskFromBinding: async (binding, context) => events.push({ selected: binding, context }),
    callbackContext: () => ({ clientId: "telegram:1" }),
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

test("settings callback service keeps the new task binding after project switch", async () => {
  const events = [];
  const callbacks = service(events);
  assert.equal(await callbacks.handle(callback, { kind: "project", index: 0 }), true);
  assert.equal(await callbacks.handle(callback, { kind: "codex-model", model: "sol" }), true);
  assert.ok(events.some((event) => event.name === "project" && event.value === "D:/workspace"));
  assert.ok(events.some((event) => (
    event.selected?.threadId === "thread-new"
    && event.selected?.taskTitle === "New task"
    && event.context?.clientId === "telegram:1"
  )));
  assert.ok(events.some((event) => event.text === "Codex model: SOL"));
});

test("settings callback service keeps the new task binding after provider switch", async () => {
  const events = [];
  const callbacks = service(events);
  assert.equal(await callbacks.handle(callback, { kind: "engine", provider: "claude" }), true);
  assert.ok(events.some((event) => (
    event.selected?.provider === "claude"
    && event.selected?.threadId === "thread-new"
    && event.context?.clientId === "telegram:1"
  )));
});

test("settings callback service declines unrelated routes", async () => {
  assert.equal(await service([]).handle(callback, { kind: "task-view" }), false);
});
