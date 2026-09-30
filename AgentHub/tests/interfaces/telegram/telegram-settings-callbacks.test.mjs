import assert from "node:assert/strict";
import test from "node:test";
import { TelegramSettingsCallbackService } from "../../../src/interfaces/telegram/telegram-settings-callbacks.mjs";
import { TelegramSettingsMenu } from "../../../src/interfaces/telegram/telegram-settings-menu.mjs";
import { contextualCallback, modelCallbackAction } from "../../../src/interfaces/telegram/callback-context.mjs";
import { routeTelegramCallback } from "../../../src/interfaces/telegram/telegram-callback-router.mjs";

function service(events, changed = true, models = {}) {
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
    codexModels: models.codex ?? [{ value: "sol", label: "Sol" }],
    codexModelLabel: (value) => value.toUpperCase(),
    codexReasoningEffort: getter("high"),
    codexCollaborationMode: getter("work"),
    claudeModel: getter("opus"),
    claudeModels: models.claude ?? ["opus"],
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

test("long live Codex and Claude model IDs round-trip through Telegram's 64-byte callbacks", async () => {
  const codexId = `gpt-${"x".repeat(40)}`;
  const claudeId = `claude-${"long-model-".repeat(9)}`;
  const context = "aaaaaaaaaaaa";
  const sent = [];
  const events = [];
  const menu = new TelegramSettingsMenu({
    codexModels: [{ value: codexId, label: "Long Codex" }],
    claudeModels: [claudeId],
    claudeModelLabels: { [claudeId]: "Long Claude" },
    callbackData: (action) => contextualCallback(action, context),
    sendMessage: async (_text, options) => sent.push(options),
  });
  const callbacks = service(events, true, {
    codex: [{ value: codexId, label: "Long Codex" }], claude: [claudeId],
  });
  await menu.modelPicker({ provider: "codex", codexModel: codexId, codexModelLabel: "Long Codex" });
  await menu.modelPicker({ provider: "claude", claudeModel: claudeId });
  for (const [index, expected] of [codexId, claudeId].entries()) {
    const data = sent[index].reply_markup.inline_keyboard[0][0].callback_data;
    assert.ok(Buffer.byteLength(data, "utf8") <= 64);
    const route = routeTelegramCallback(data, context);
    assert.equal(route.kind, index === 0 ? "codex-model" : "claude-model");
    assert.equal(await callbacks.handle(callback, route), true);
    assert.ok(events.some((event) => event.name === "model" && event.value === expected));
    assert.equal(routeTelegramCallback(data, "bbbbbbbbbbbb").kind, "stale");
  }
});

test("a compact model callback cannot select an ID removed by catalog refresh", async () => {
  const codexId = `gpt-${"x".repeat(40)}`;
  const events = [];
  const codexModels = [{ value: codexId, label: "Long Codex" }];
  const callbacks = service(events, true, { codex: codexModels });
  const data = contextualCallback(modelCallbackAction("codex", codexId), "aaaaaaaaaaaa");
  codexModels.splice(0);
  const route = routeTelegramCallback(data, "aaaaaaaaaaaa");
  await callbacks.handle(callback, route);
  assert.equal(events.some((event) => event.name === "model"), false);
  assert.ok(events.some((event) => event.method === "answerCallbackQuery"
    && /устарело/.test(event.body.text)));
});
