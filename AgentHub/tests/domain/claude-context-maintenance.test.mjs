import assert from "node:assert/strict";
import test from "node:test";

import {
  CLAUDE_COMPACTION_PROMPT,
  claudeCompactionClientId,
  claudeCompactionEvent,
  isClaudeCompactionClientId,
  isClaudeCompactionRun,
} from "../../src/domain/claude-context-maintenance.mjs";

test("Claude compaction prompt stays the exact CLI command", () => {
  assert.equal(CLAUDE_COMPACTION_PROMPT, "/compact");
});

test("Claude compaction client identity is recognised only by its own prefix", () => {
  const identity = claudeCompactionClientId();
  assert.equal(isClaudeCompactionClientId(identity), true);
  assert.equal(isClaudeCompactionClientId("ordinary-client-id"), false);
  assert.equal(isClaudeCompactionClientId(""), false);
});

test("only a Claude run carrying the compaction identity counts as maintenance", () => {
  const identity = claudeCompactionClientId();
  assert.equal(isClaudeCompactionRun({ provider: "claude", clientUserMessageId: identity }), true);
  assert.equal(isClaudeCompactionRun({ provider: "claude", claudeCompaction: true }), true);
  assert.equal(isClaudeCompactionRun({ provider: "codex", clientUserMessageId: identity }), false);
  assert.equal(isClaudeCompactionRun({ provider: "claude", clientUserMessageId: "user-1" }), false);
});

test("compaction start and outcome are read from the CLI status events", () => {
  assert.deepEqual(
    claudeCompactionEvent({ type: "system", subtype: "status", status: "compacting" }),
    { stage: "started" },
  );
  assert.deepEqual(
    claudeCompactionEvent({ type: "system", subtype: "status", status: null, compact_result: "success" }),
    { stage: "settled", succeeded: true, result: "success" },
  );
  assert.deepEqual(
    claudeCompactionEvent({ type: "system", subtype: "status", status: null, compact_result: "error" }),
    { stage: "settled", succeeded: false, result: "error" },
  );
  assert.equal(claudeCompactionEvent({ type: "system", subtype: "status", status: null }), null);
  assert.equal(claudeCompactionEvent({ type: "assistant" }), null);
});

test("compaction boundary carries the exact context before and after", () => {
  // Полезная нагрузка снята с настоящего вывода Claude Code 2.1.246.
  assert.deepEqual(claudeCompactionEvent({
    type: "system",
    subtype: "compact_boundary",
    compact_metadata: {
      trigger: "manual",
      pre_tokens: 37_041,
      post_tokens: 3_760,
      cumulative_dropped_tokens: 33_281,
      duration_ms: 42_239,
    },
  }), {
    stage: "boundary",
    origin: "manual",
    preTokens: 37_041,
    postTokens: 3_760,
    droppedTokens: 33_281,
    durationMs: 42_239,
  });
  assert.equal(
    claudeCompactionEvent({
      type: "system",
      subtype: "compact_boundary",
      compact_metadata: { trigger: "auto" },
    }).origin,
    "automatic",
  );
});
