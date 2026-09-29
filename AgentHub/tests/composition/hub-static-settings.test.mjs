import assert from "node:assert/strict";
import test from "node:test";

import { createHubStaticSettings } from "../../src/composition/hub-static-settings.mjs";

test("Codex model normalization accepts canonical IDs and display labels", () => {
  const settings = createHubStaticSettings({
    codexModels: [
      { value: "gpt-5.5", label: "GPT-5.5" },
      { value: "gpt-6-astra", label: "GPT-6 Astra" },
      { value: "gpt-5.6-sol", label: "GPT-5.6-Sol" },
    ],
    codexModel: "GPT-5.6-Sol",
    codexReasoningEffort: "high",
    projects: [{ path: "D:/Work" }],
    dataDir: "D:/Data",
    projectRoot: "D:/Work",
    stateFile: "D:/Data/state.json",
    deliveryOutboxDir: "D:/Data/outbox",
    showProjectButton: false,
  }, "D:/AgentHub");

  assert.equal(settings.normalizeCodexModel("gpt-5.6-sol"), "gpt-5.6-sol");
  assert.equal(settings.normalizeCodexModel("GPT-5.6-Sol"), "gpt-5.6-sol");
  assert.equal(settings.normalizeCodexModel("GPT-6 Astra"), "gpt-6-astra");
  assert.equal(settings.codexModelLabel("gpt-6-astra"), "GPT-6 Astra");
  assert.deepEqual(settings.codexModels.slice(0, 3), [
    { value: "gpt-6-astra", label: "GPT-6 Astra" },
    { value: "gpt-5.6-sol", label: "GPT-5.6-Sol" },
  ]);
  assert.equal(settings.normalizeCodexModel("gpt-5.5"), "gpt-5.5");
  assert.equal(settings.defaultCodexModel, "gpt-6-astra");
});

test("Telegram keyboard omits task capture while keeping the legacy command", () => {
  const settings = createHubStaticSettings({
    codexModels: [{ value: "gpt-5.6-sol", label: "GPT-5.6-Sol" }],
    codexModel: "gpt-5.6-sol",
    codexReasoningEffort: "high",
    projects: [{ path: "D:/Work" }],
    dataDir: "D:/Data",
    projectRoot: "D:/Work",
    stateFile: "D:/Data/state.json",
    deliveryOutboxDir: "D:/Data/outbox",
    showProjectButton: false,
  }, "D:/AgentHub");

  const buttonLabels = settings.botMenu.keyboard.flat().map((button) => button.text);
  assert.equal(buttonLabels.includes("📥 Задача"), false);
  assert.equal(buttonLabels.includes("📋 Потоки"), true);
  assert.equal(buttonLabels.includes("📋 Задачи"), false);
  assert.equal(settings.menuCommands.get("📥 Задача"), "/task");
  assert.equal(settings.menuCommands.get("📋 Потоки"), "/streams");
  assert.equal(settings.menuCommands.get("📋 Задачи"), "/tasks");
  assert.equal(settings.botCommands.some(({ command }) => command === "streams"), true);
  assert.equal(settings.botCommands.some(({ command }) => command === "tasks"), false);
  assert.equal(settings.botCommands.some(({ command }) => command === "task"), false);
});
