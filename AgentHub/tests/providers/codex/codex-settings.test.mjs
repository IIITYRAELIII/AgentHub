import test from "node:test";
import assert from "node:assert/strict";
import {
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

test("developer instructions preserve Guide, Global, Workspace and Stream order", () => {
  assert.equal(buildCodexDeveloperInstructions({
    guide: "Guide rule",
    global: "Global rule",
    workspace: "Workspace rule",
    stream: "Stream rule",
  }), [
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
    "",
    "<agent_hub_context_probe>",
    "If the User Prompt is exactly \"Ответь строго: AGENT_HUB_CONTEXT_PROBE_OK_V1\", this is an internal context measurement.",
    "Do not call tools or execute pre-turn, release-registry, repository, or other work.",
    "Respond with exactly \"AGENT_HUB_CONTEXT_PROBE_OK_V1\" and no additional text.",
    "This probe-only exception overrides the Agent Hub Guide, Global, Workspace, Stream, and context pre-turn instructions.",
    "</agent_hub_context_probe>",
  ].join("\n"));
  assert.throws(() => buildCodexDeveloperInstructions(), /Guide is required/u);
});

test("collaboration mode carries effective developer instructions", () => {
  assert.equal(buildCodexCollaborationMode({
    mode: "default",
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
    developerInstructions: "Inherited rules",
  }).settings.developer_instructions, "Inherited rules");
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
