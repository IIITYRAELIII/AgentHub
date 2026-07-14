import test from "node:test";
import assert from "node:assert/strict";
import {
  buildCodexCollaborationMode,
  CODEX_COLLABORATION_MODES,
  CODEX_REASONING_EFFORTS,
} from "./codex-settings.mjs";

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
