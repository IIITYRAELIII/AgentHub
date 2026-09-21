import test from "node:test";
import assert from "node:assert/strict";
import {
  buildCodexApplicationContext,
  buildCodexCollaborationMode,
  buildCodexDeveloperInstructions,
  CODEX_COLLABORATION_MODES,
  CODEX_REASONING_EFFORTS,
  resolveCodexThreadSettings,
} from "../../../src/providers/codex/codex-settings.mjs";

test("buildCodexCollaborationMode preserves selected model and reasoning", () => {
  assert.deepEqual(buildCodexCollaborationMode({
    mode: "plan",
    model: "gpt-5.6-sol",
    reasoningEffort: "xhigh",
  }), {
    mode: "plan",
    settings: {
      model: "gpt-5.6-sol",
      reasoning_effort: "xhigh",
      developer_instructions: null,
    },
  });
});

test("developer instructions preserve the four configured rule layers", () => {
  const instructions = buildCodexDeveloperInstructions({
    guide: "Guide rule",
    global: "Global rule",
    workspace: "Workspace rule",
    stream: "Stream rule",
  });
  assert.equal(instructions, [
    "<agent_hub_instruction_precedence>",
    "Within Agent Hub-managed instructions, later layers refine earlier layers:",
    "Agent Hub Guide < Global pre-turn instructions < Workspace < Stream.",
    "Workspace and Stream rules are the specific workflow policy for this Hub context and override conflicting repository defaults.",
    "Use the User Prompt as the task-specific intent unless it conflicts with system, safety, or developer requirements.",
    "</agent_hub_instruction_precedence>",
    "",
    "<agent_hub_guide>",
    "Guide rule",
    "</agent_hub_guide>",
    "",
    "<global_pre_turn_instructions>",
    "Global rule",
    "</global_pre_turn_instructions>",
    "",
    "<workspace_instructions>",
    "Workspace rule",
    "</workspace_instructions>",
    "",
    "<stream_instructions>",
    "Stream rule",
    "</stream_instructions>",
  ].join("\n"));
  assert.doesNotMatch(instructions, /AGENT_HUB_CONTEXT_PROBE/u);
  assert.doesNotMatch(instructions, /Ответь строго/u);
  assert.throws(() => buildCodexDeveloperInstructions(), /Guide is required/u);
});

test("application context carries exact rules independently of model catalog modes", () => {
  const rules = "<agent_hub_context>\nSynthetic context\n</agent_hub_context>";
  assert.deepEqual(buildCodexApplicationContext(rules), {
    "agent-hub": { kind: "application", value: rules },
  });
  assert.deepEqual(buildCodexApplicationContext(null), {
    "agent-hub": { kind: "application", value: "" },
  });
  for (const mode of CODEX_COLLABORATION_MODES) {
    assert.equal(buildCodexCollaborationMode({
      mode, model: "gpt-6-astra", reasoningEffort: "high",
    }).settings.developer_instructions, null);
  }
});

test("Codex selectors expose supported values", () => {
  assert.deepEqual(CODEX_COLLABORATION_MODES, ["default", "plan"]);
  assert.deepEqual(CODEX_REASONING_EFFORTS, ["low", "medium", "high", "xhigh", "max", "ultra"]);
});

test("buildCodexCollaborationMode rejects invalid selections", () => {
  assert.throws(
    () => buildCodexCollaborationMode({ mode: "chat", model: "gpt-5.6-sol", reasoningEffort: "high" }),
    /unknown Codex collaboration mode/,
  );
  assert.throws(
    () => buildCodexCollaborationMode({ mode: "default", model: "gpt-5.6-sol", reasoningEffort: "huge" }),
    /unknown Codex reasoning effort/,
  );
});

test("resolveCodexThreadSettings reads effective settings from thread resume", () => {
  assert.deepEqual(resolveCodexThreadSettings({
    model: "gpt-5.6-terra",
    reasoningEffort: "medium",
  }, {
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
  }), {
    model: "gpt-5.6-terra",
    reasoningEffort: "medium",
  });
});

test("resolveCodexThreadSettings reads thread settings notifications and keeps valid fallbacks", () => {
  assert.deepEqual(resolveCodexThreadSettings({
    threadSettings: {
      model: "gpt-5.6-luna",
      effort: "unsupported",
    },
  }, {
    model: "gpt-5.6-sol",
    reasoningEffort: "xhigh",
  }), {
    model: "gpt-5.6-luna",
    reasoningEffort: "xhigh",
  });
});
