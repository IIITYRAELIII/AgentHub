import assert from "node:assert/strict";
import test from "node:test";

import { createHubStaticSettings } from "../../src/composition/hub-static-settings.mjs";

test("Codex model normalization accepts canonical IDs and display labels", () => {
  const settings = createHubStaticSettings({
    codexModels: [
      { value: "gpt-5.6-sol", label: "GPT-5.6-Sol" },
      { value: "gpt-5.5", label: "GPT-5.5" },
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
  assert.equal(settings.defaultCodexModel, "gpt-5.6-sol");
});
