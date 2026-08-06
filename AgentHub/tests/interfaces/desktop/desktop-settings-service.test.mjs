import assert from "node:assert/strict";
import test from "node:test";
import { DesktopSettingsService } from "../../../src/interfaces/desktop/desktop-settings-service.mjs";

test("Desktop settings service rejects a stale task-scoped mutation", async () => {
  const noop = () => {};
  const service = new DesktopSettingsService({
    isSelected: () => false, selectedTask: () => ({}), switchProvider: async () => ({}), isCodex: () => true,
    threadId: () => "t1", isCompacting: () => false, switchCodexModel: () => ({}), switchClaudeModel: () => ({}),
    updateCodexThreadSettings: async () => {}, saveState: async () => {}, getCodexReasoning: () => "high",
    setCodexReasoning: noop, getClaudeReasoning: () => "high", setClaudeReasoning: noop,
    getCodexMode: () => "default", setCodexMode: noop, getClaudeMode: () => "default", setClaudeMode: noop,
    getAutoApprove: () => true, setAutoApprove: noop, getIncludeClaudeUsage: () => true, setIncludeClaudeUsage: noop,
    projectUsage: async () => {}, findProjectIndex: () => 0, switchProject: async () => ({}), snapshot: async () => ({}),
    reasoningEfforts: ["high"], collaborationModes: ["default"],
  });
  await assert.rejects(service.update({ name: "model", value: "gpt" }), /уже не к выбранной/u);
});
