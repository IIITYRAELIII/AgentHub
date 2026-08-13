import assert from "node:assert/strict";
import test from "node:test";

import {
  CLAUDE_MODEL_LABELS,
  CLAUDE_REASONING_EFFORTS,
  claudeModelLabel,
  claudeModelOptions,
} from "../../../src/domain/agent-runtime-settings.mjs";

test("Claude settings reflect native CLI effort levels without Codex ultra", () => {
  assert.deepEqual(CLAUDE_REASONING_EFFORTS, ["low", "medium", "high", "xhigh", "max"]);
});

test("Claude model options distinguish exact observed versions from latest aliases", () => {
  assert.equal(claudeModelLabel("claude-opus-4-7"), "Opus 4.7");
  assert.equal(claudeModelLabel("claude-opus-5"), "Opus 5");
  assert.equal(CLAUDE_MODEL_LABELS["claude-sonnet-5"], "Sonnet 5");
  assert.deepEqual(
    claudeModelOptions({
      aliases: ["opus", "sonnet"],
      observed: ["claude-opus-4-7", "claude-opus-5", "claude-opus-5"],
      selected: "opus",
    }),
    [
      { value: "claude-opus-5", label: "Opus 5" },
      { value: "claude-opus-4-7", label: "Opus 4.7" },
      { value: "opus", label: "Opus (latest)" },
      { value: "sonnet", label: "Sonnet (latest)" },
    ],
  );
});
