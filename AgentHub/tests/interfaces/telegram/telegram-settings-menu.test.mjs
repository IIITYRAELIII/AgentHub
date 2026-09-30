import assert from "node:assert/strict";
import test from "node:test";

import { TelegramSettingsMenu } from "../../../src/interfaces/telegram/telegram-settings-menu.mjs";

function fixture() {
  const sent = [];
  const menu = new TelegramSettingsMenu({
    projects: [
      { name: "One", path: "C:\\one" },
      { name: "Two", path: "C:\\two" },
    ],
    codexModels: [{ value: "sol", label: "Sol" }, { value: "terra", label: "Terra" }],
    claudeModels: ["sonnet", "opus"],
    claudeModelLabels: { sonnet: "Sonnet", opus: "Opus" },
    reasoningEfforts: ["high", "medium"],
    reasoningLabels: { high: "High", medium: "Medium" },
    collaborationModes: ["default", "plan"],
    collaborationModeLabels: { default: "Work", plan: "Plan" },
    callbackData: (value) => `ctx:${value}`,
    sendMessage: async (...args) => sent.push(args),
  });
  return { menu, sent };
}

test("Telegram settings menu marks current project and provider", async () => {
  const { menu, sent } = fixture();
  await menu.projectsPicker({ activeProjectRoot: "C:\\two" });
  await menu.agentPicker({ provider: "codex" });

  assert.match(sent[0][0], /Активный проект: Two/);
  assert.equal(sent[0][1].reply_markup.inline_keyboard[1][0].text, "✓ Two");
  assert.equal(sent[1][1].reply_markup.inline_keyboard[1][0].text, "✓ Codex");
});

test("Telegram settings menu builds model, reasoning and mode callbacks", async () => {
  const { menu, sent } = fixture();
  await menu.modelPicker({
    provider: "codex",
    codexModel: "sol",
    codexModelLabel: "Sol",
  });
  await menu.reasoningPicker({ provider: "claude", value: "high" });
  await menu.collaborationModePicker({ provider: "codex", value: "default" });

  assert.match(sent[0][0], /Current Codex model: Sol/);
  assert.equal(sent[0][1].reply_markup.inline_keyboard[0][0].callback_data, "ctx:codex-model:sol");
  assert.equal(sent[1][1].reply_markup.inline_keyboard[0][0].callback_data, "ctx:claude-reasoning:high");
  assert.equal(sent[2][1].reply_markup.inline_keyboard[0][0].callback_data, "ctx:codex-mode:default");
});

test("Telegram model picker reads refreshed provider arrays", async () => {
  const { menu, sent } = fixture();
  menu.codexModels.splice(0, menu.codexModels.length,
    { value: "gpt-6.1-sol", label: "GPT-6.1 Sol" },
    { value: "gpt-6-sol", label: "GPT-6 Sol" });
  menu.claudeModels.splice(0, menu.claudeModels.length,
    "default", "claude-sonnet-5");
  menu.claudeModelLabels.default = "Default";
  menu.claudeModelLabels["claude-sonnet-5"] = "Sonnet 5";
  await menu.modelPicker({ provider: "codex", codexModel: "gpt-6-sol",
    codexModelLabel: "GPT-6 Sol" });
  await menu.modelPicker({ provider: "claude", claudeModel: "claude-sonnet-5" });
  assert.deepEqual(sent[0][1].reply_markup.inline_keyboard.map(([item]) => item.callback_data), [
    "ctx:codex-model:gpt-6.1-sol", "ctx:codex-model:gpt-6-sol",
  ]);
  assert.deepEqual(sent[1][1].reply_markup.inline_keyboard.map(([item]) => item.callback_data), [
    "ctx:model:default", "ctx:model:claude-sonnet-5",
  ]);
});
