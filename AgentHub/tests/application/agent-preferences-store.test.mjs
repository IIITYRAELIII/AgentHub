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
    codexModels: ["sol", "gpt-6-astra", "terra"],
    claudeModels: ["sonnet", "opus"],
    reasoningEfforts: ["low", "high"],
    collaborationModes: ["default", "plan"],
    defaultCodexModel: "sol",
    defaultCodexReasoningEffort: "high",
    defaultCodexCollaborationMode: "default",
    defaultClaudeModel: "sonnet",
    defaultClaudeReasoningEffort: "high",
    defaultClaudeCollaborationMode: "default",
    normalizeCodexModel: (value) => ["sol", "gpt-6-astra", "terra"].includes(value) ? value : "sol",
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
    codexCatalogInitialized: false,
    codexCatalogSeen: [],
    codexCatalogNovel: [],
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
    quickMessageActionMode: "send",
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
    codexCatalogInitialized: false,
    codexCatalogSeen: [],
    codexCatalogNovel: [],
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
    quickMessageActionMode: "send",
    pinnedWorkspaceStreams: {
      "workspace-1": ["stream-1", "stream-2"],
    },
    quickMessages: {
      global: [
        { title: "пинг", text: "пинг" },
        { title: "пинг", text: "пинг" },
      ],
      streams: {
        "stream-1": [
          { title: "релизь", text: "релизь" },
          { title: "Тест", text: "запусти тесты" },
          { title: "релизь", text: "релизь" },
        ],
      },
      workspaces: {
        "workspace-1": [{ title: "Проверь", text: "проверь" }],
      },
    },
  });
  assert.throws(() => store.setCodexModel("unknown"), /unknown Codex model/u);
  assert.throws(() => store.setClaudeReasoning("ultra"), /unknown Claude reasoning effort/u);
  assert.deepEqual(store.setActivityRecentMinutes(240), { changed: true });
  assert.equal(store.activityRecentMinutes, 240);
  assert.deepEqual(store.setStreamCardFixedWidth(451), { changed: true });
  assert.equal(store.streamCardFixedWidth, 450);
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
    workspaces: { "workspace-2": [{ title: "релизь", text: "релизь" }] },
  });
  assert.deepEqual(store.setQuickMessageActionMode("invalid"), { changed: true });
  assert.equal(store.quickMessageActionMode, "insert");
  assert.deepEqual(store.setQuickMessageActionMode("send"), { changed: true });
  assert.equal(store.quickMessageActionMode, "send");
});

test("Codex catalog history survives state restore without marking initial models new", () => {
  const { store } = fixture();
  assert.deepEqual(store.recordCodexCatalog([{ value: "gpt-6-astra" }, { value: "sol" }]), []);
  assert.deepEqual(store.recordCodexCatalog([{ value: "gpt-7-new" }, { value: "gpt-6-astra" },
    { value: "gpt-6-sol" }]),
    ["gpt-7-new"]);
  const { store: restarted } = fixture();
  restarted.restore(JSON.parse(JSON.stringify(store.snapshot())));
  assert.deepEqual(restarted.recordCodexCatalog([{ value: "gpt-6-astra" }, { value: "gpt-7-new" }]),
    ["gpt-7-new"]);
  assert.deepEqual(restarted.recordCodexCatalog([{ value: "gpt-6-astra" }]), []);
  assert.throws(() => restarted.setCodexModel("gpt-5.4"), /unknown Codex model/u);
});

test("prompt template action mode defaults safely and survives persistence", () => {
  const { store } = fixture();
  assert.equal(store.quickMessageActionMode, "insert");
  store.restore({ quickMessageActionMode: "unknown" });
  assert.equal(store.quickMessageActionMode, "insert");
  store.setQuickMessageActionMode("send");

  const { store: restored } = fixture();
  restored.restore(JSON.parse(JSON.stringify(store.snapshot())));
  assert.equal(restored.quickMessageActionMode, "send");
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

test("Astra survives the persisted Codex preference round-trip", () => {
  const { store } = fixture();
  assert.deepEqual(store.setCodexModel("gpt-6-astra"), { changed: true });

  const persisted = JSON.parse(JSON.stringify(store.snapshot()));
  const { store: restored } = fixture();
  restored.restore(persisted);

  assert.equal(restored.codexModel, "gpt-6-astra");
  assert.equal(restored.current("codex").model, "gpt-6-astra");
});
