import assert from "node:assert/strict";
import test from "node:test";

import { AgentPreferencesStore } from "../../src/application/agent-preferences-store.mjs";
import { TaskMetadataStore } from "../../src/application/task-metadata-store.mjs";
import { TaskSelectionStore } from "../../src/application/task-selection-store.mjs";

function fixture() {
  const selectionStore = new TaskSelectionStore({
    activeProvider: "codex",
    activeProjectRoot: "D:/Work",
    threadId: "thread-1",
  });
  const taskMetadata = new TaskMetadataStore({
    validReasoningEfforts: ["low", "high"],
  });
  const store = new AgentPreferencesStore({
    selectionStore,
    taskMetadata,
    codexModels: ["sol", "terra"],
    claudeModels: ["sonnet", "opus"],
    reasoningEfforts: ["low", "high"],
    collaborationModes: ["default", "plan"],
    defaultCodexModel: "sol",
    defaultCodexReasoningEffort: "high",
    defaultCodexCollaborationMode: "default",
    defaultClaudeModel: "sonnet",
    defaultClaudeReasoningEffort: "high",
    defaultClaudeCollaborationMode: "default",
    normalizeCodexModel: (value) => ["sol", "terra"].includes(value) ? value : "sol",
    resolveCodexThreadSettings: (payload, current) => ({
      model: payload?.model ?? current.model,
      reasoningEffort: payload?.reasoningEffort ?? current.reasoningEffort,
    }),
  });
  return { selectionStore, taskMetadata, store };
}

test("agent preferences restore and validate both providers in one state owner", () => {
  const { store } = fixture();
  store.restore({
    codexModel: "terra",
    codexReasoningEffort: "low",
    codexCollaborationMode: "plan",
    claudeModel: "opus",
    claudeReasoningEffort: "low",
    claudeCollaborationMode: "plan",
    includeClaudeUsage: false,
    activityRecentMinutes: 90,
    streamOrderMode: "manual",
    streamCardWidthMode: "fixed",
    streamCardFixedWidth: 237,
    streamCardGapEnabled: true,
    showInlineFileRevealButtons: true,
    pinnedWorkspaceStreams: {
      "workspace-1": ["stream-1", "stream-2", "stream-1"],
      "": ["ignored"],
      "workspace-2": "ignored",
    },
    quickMessages: {
      global: ["пинг", "пинг"],
      streams: {
        "stream-1": ["релизь", { label: "Тест", text: "запусти тесты" }, "релизь"],
      },
      workspaces: {
        "workspace-1": [{ label: "Проверь", text: "проверь" }, ""],
      },
    },
  });
  assert.deepEqual(store.snapshot(), {
    codexModel: "terra",
    codexReasoningEffort: "low",
    codexCollaborationMode: "plan",
    claudeModel: "opus",
    claudeReasoningEffort: "low",
    claudeCollaborationMode: "plan",
    includeClaudeUsage: false,
    activityRecentMinutes: 90,
    streamOrderMode: "manual",
    streamCardWidthMode: "fixed",
    streamCardFixedWidth: 237,
    streamCardGapEnabled: true,
    showInlineFileRevealButtons: true,
    pinnedWorkspaceStreams: {
      "workspace-1": ["stream-1", "stream-2"],
    },
    quickMessages: {
      global: [{ id: "пинг", label: "пинг", text: "пинг" }],
      streams: {
        "stream-1": [
          { id: "релизь", label: "релизь", text: "релизь" },
          { id: "Тест", label: "Тест", text: "запусти тесты" },
        ],
      },
      workspaces: {
        "workspace-1": [{ id: "Проверь", label: "Проверь", text: "проверь" }],
      },
    },
  });
  assert.throws(() => store.setCodexModel("unknown"), /unknown Codex model/u);
  assert.throws(() => store.setClaudeReasoning("ultra"), /unknown Claude reasoning effort/u);
  assert.deepEqual(store.setActivityRecentMinutes(240), { changed: true });
  assert.equal(store.activityRecentMinutes, 240);
  assert.deepEqual(store.setStreamCardFixedWidth(451), { changed: true });
  assert.equal(store.streamCardFixedWidth, 450);
  assert.deepEqual(store.setShowInlineFileRevealButtons(false), { changed: true });
  assert.equal(store.showInlineFileRevealButtons, false);
  assert.deepEqual(
    store.setPinnedWorkspaceStreams(JSON.stringify({ "workspace-2": ["stream-3"] })),
    { changed: true },
  );
  assert.deepEqual(store.pinnedWorkspaceStreams, { "workspace-2": ["stream-3"] });
  assert.deepEqual(
    store.setQuickMessages(JSON.stringify({ workspaces: { "workspace-2": ["релизь"] } })),
    { changed: true },
  );
  assert.deepEqual(store.quickMessages, {
    global: [],
    streams: {},
    workspaces: { "workspace-2": [{ id: "релизь", label: "релизь", text: "релизь" }] },
  });
});

test("inline file reveal buttons are server-persisted and default off for legacy state", () => {
  const { store } = fixture();
  assert.equal(store.showInlineFileRevealButtons, false);
  assert.equal(store.restore({ showInlineFileRevealButtons: true }).showInlineFileRevealButtons, true);
  assert.equal(store.snapshot().showInlineFileRevealButtons, true);
});

test("task preferences follow the selected Codex thread without becoming task identity", () => {
  const { selectionStore, taskMetadata, store } = fixture();
  store.setCodexModel("terra");
  store.setCodexReasoning("low");
  store.rememberCodexTaskSettings();
  selectionStore.setThread("thread-2", { provider: "codex" });
  store.restoreCodexTaskSettings("thread-2");
  assert.deepEqual(store.captureCodex(), {
    model: "sol",
    reasoningEffort: "high",
    collaborationMode: "default",
  });
  store.applyCodexThreadSettings("thread-2", { model: "terra", reasoningEffort: "low" });
  assert.equal(store.codexModel, "terra");
  assert.deepEqual(taskMetadata.codexSettings("thread-1"), {
    model: "terra",
    reasoningEffort: "low",
  });
});
