import assert from "node:assert/strict";
import test from "node:test";

import { createStreamAgentSettingsService } from "../../src/application/stream-agent-settings-service.mjs";

function fixture() {
  const streams = new Map([
    ["s1", { id: "s1", settings: { provider: "claude", model: "claude-sonnet-5", reasoning: "high", mode: "default" } }],
    ["s2", { id: "s2", settings: { provider: "claude", model: "claude-opus-5", reasoning: "low", mode: "default" } }],
    ["s3", { id: "s3", settings: {} }],
  ]);
  const workspaceCatalog = {
    stream: (id) => streams.get(id) ?? null,
    updateStreamSettings: (id, settings) => {
      const stream = { ...streams.get(id), settings };
      streams.set(id, stream);
      return stream;
    },
  };
  const selection = { streamId: "s1", activeProvider: "claude" };
  const values = { model: "claude-sonnet-5", reasoningEffort: "high", collaborationMode: "default" };
  const agentPreferences = {
    current: () => ({ ...values }),
    defaultClaudeModel: "claude-sonnet-5",
    defaultClaudeReasoningEffort: "medium",
    defaultClaudeCollaborationMode: "default",
    defaultCodexModel: "gpt-5.6-sol",
    defaultCodexReasoningEffort: "medium",
    defaultCodexCollaborationMode: "default",
    setClaudeModel: (value) => { values.model = value; },
    setClaudeReasoning: (value) => { values.reasoningEffort = value; },
    setClaudeMode: (value) => { values.collaborationMode = value; },
    setCodexModel: (value) => {
      if (!["gpt-5.6-sol", "gpt-5.6-terra", "gpt-6-astra"].includes(value)) throw new Error("unknown Codex model");
      values.model = value;
    },
    setCodexReasoning: (value) => {
      if (!["medium", "high"].includes(value)) throw new Error("unknown Codex reasoning effort");
      values.reasoningEffort = value;
    },
    setCodexMode: (value) => {
      if (value !== "default") throw new Error("unknown Codex collaboration mode");
      values.collaborationMode = value;
    },
  };
  const service = createStreamAgentSettingsService({
    workspaceCatalog,
    selectionStore: {
      get streamId() { return selection.streamId; },
      get activeProvider() { return selection.activeProvider; },
    },
    agentPreferences,
  });
  return { service, streams, selection, values };
}

test("a changed model is stored in the selected Stream", () => {
  const { service, streams, values } = fixture();
  values.model = "claude-opus-5";
  service.remember();
  assert.equal(streams.get("s1").settings.model, "claude-opus-5");
  assert.equal(streams.get("s1").settings.reasoning, "high");
});

test("selecting another Stream restores its own model instead of carrying the previous one", () => {
  const { service, selection, values } = fixture();
  values.model = "claude-opus-4-5";
  service.remember();
  selection.streamId = "s2";
  service.apply("s2");
  assert.equal(values.model, "claude-opus-5");
  assert.equal(values.reasoningEffort, "low");
  selection.streamId = "s1";
  service.apply("s1");
  assert.equal(values.model, "claude-opus-4-5");
});

test("a Stream without saved settings falls back to the provider default", () => {
  const { service, values } = fixture();
  values.model = "claude-opus-5";
  const resolved = service.apply("s3");
  assert.equal(values.model, "claude-sonnet-5");
  assert.equal(resolved.explicit, false);
});

test("a Stream with a saved model reports it as explicit", () => {
  const { service } = fixture();
  assert.equal(service.apply("s2").explicit, true);
});

test("a model saved for the other provider falls back to the provider default", () => {
  const { service, selection, values } = fixture();
  selection.activeProvider = "codex";
  assert.doesNotThrow(() => service.apply("s2"));
  assert.equal(values.model, "gpt-5.6-sol");
  assert.equal(values.reasoningEffort, "medium");
});

test("switching a Codex Stream to Astra preserves the canonical model ID", () => {
  const { service, selection, streams, values } = fixture();
  selection.activeProvider = "codex";
  values.model = "gpt-6-astra";
  values.reasoningEffort = "high";
  service.remember();
  assert.equal(streams.get("s1").settings.model, "gpt-6-astra");

  values.model = "gpt-5.6-sol";
  service.apply("s1");
  assert.equal(values.model, "gpt-6-astra");
});

test("unrelated Stream settings survive an agent settings update", () => {
  const { service, streams, values } = fixture();
  streams.get("s1").settings.workingDirectory = "D:/one";
  values.model = "claude-opus-5";
  service.remember();
  assert.equal(streams.get("s1").settings.workingDirectory, "D:/one");
});
