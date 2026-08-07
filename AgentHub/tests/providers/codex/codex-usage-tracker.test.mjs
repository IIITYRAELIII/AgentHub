import assert from "node:assert/strict";
import test from "node:test";

import { CodexUsageTracker } from "../../../src/providers/codex/codex-usage-tracker.mjs";

function usage(totalTokens, {
  inputTokens = totalTokens,
  cachedInputTokens = 0,
  outputTokens = 0,
  reasoningOutputTokens = 0,
} = {}) {
  return { totalTokens, inputTokens, cachedInputTokens, outputTokens, reasoningOutputTokens };
}

test("CodexUsageTracker accumulates one turn from thread-total deltas", () => {
  const tracker = new CodexUsageTracker();
  tracker.turns.set("turn-1", { usage: usage(0), reported: false });
  tracker.track({
    threadId: "thread-1",
    turnId: "turn-1",
    tokenUsage: { total: usage(100), last: usage(100), modelContextWindow: 1_000 },
  });
  tracker.track({
    threadId: "thread-1",
    turnId: "turn-1",
    tokenUsage: { total: usage(140), last: usage(40), modelContextWindow: 1_000 },
  });
  const result = tracker.consume("turn-1");
  assert.equal(result.reported, true);
  assert.equal(result.usage.totalTokens, 140);
  assert.equal(tracker.turns.has("turn-1"), false);
});

test("CodexUsageTracker returns the newest context for a thread", () => {
  const times = [new Date("2026-08-04T10:00:00.000Z"), new Date("2026-08-04T10:01:00.000Z")];
  const tracker = new CodexUsageTracker({ now: () => times.shift() });
  tracker.rememberContext({
    threadId: "thread-1",
    turnId: "turn-1",
    tokenUsage: { last: usage(120), modelContextWindow: 1_000 },
  });
  tracker.rememberContext({
    threadId: "thread-1",
    turnId: "turn-2",
    tokenUsage: { last: usage(220), modelContextWindow: 2_000 },
  });
  assert.equal(tracker.latestContext("thread-1", "turn-1").turnId, "turn-2");
  assert.equal(tracker.latestContext("thread-1", "turn-2").usedTokens, 220);
});

test("CodexUsageTracker waits for the post-compaction context measurement", async () => {
  const times = [new Date("2026-08-04T10:00:00.000Z"), new Date("2026-08-04T10:01:00.000Z")];
  const tracker = new CodexUsageTracker({ now: () => times.shift() });
  tracker.rememberContext({
    threadId: "thread-1",
    turnId: "turn-1",
    tokenUsage: { last: usage(800), modelContextWindow: 1_000 },
  });
  const pending = tracker.waitForContextUpdate("thread-1", {
    after: "2026-08-04T10:00:00.000Z",
    timeoutMs: 100,
  });
  tracker.rememberContext({
    threadId: "thread-1",
    turnId: "compact-1",
    tokenUsage: { last: usage(180), modelContextWindow: 1_000 },
  });
  assert.equal((await pending)?.usedTokens, 180);
});

test("CodexUsageTracker marks compaction-only context as provisional", () => {
  const times = [
    new Date("2026-08-04T10:00:00.000Z"),
    new Date("2026-08-04T10:01:00.000Z"),
  ];
  const tracker = new CodexUsageTracker({ now: () => times.shift() });
  tracker.turns.set("compact-1", { usage: usage(0), reported: false });
  tracker.rememberContext({
    threadId: "thread-1",
    turnId: "turn-1",
    tokenUsage: { last: usage(800), modelContextWindow: 1_000 },
  });

  tracker.track({
    threadId: "thread-1",
    turnId: "compact-1",
    tokenUsage: {
      total: usage(900),
      last: usage(180, { inputTokens: 0 }),
      modelContextWindow: 1_000,
    },
  }, { provisionalContext: true });

  assert.equal(tracker.latestContext("thread-1").usedTokens, 180);
  assert.equal(tracker.latestContext("thread-1").provisional, true);
  assert.equal(tracker.consume("compact-1").reported, true);
});

test("CodexUsageTracker restores bounded compatible state", () => {
  const tracker = new CodexUsageTracker({ totalLimit: 1, turnLimit: 1, contextLimit: 1 });
  tracker.restore({
    threadTokenTotals: [["old", usage(1)], ["thread", usage(2)]],
    turnTokenUsage: [["old", { usage: usage(1) }], ["turn", { usage: usage(3), reported: true }]],
    threadContextUsage: [
      ["bad", { modelContextWindow: 0 }],
      ["thread\0turn", {
        threadId: "thread",
        turnId: "turn",
        modelContextWindow: 10,
        usedTokens: 4,
        provisional: false,
        updatedAt: "2026-08-04T10:00:00.000Z",
      }],
    ],
  });
  assert.deepEqual(tracker.snapshot(), {
    threadTokenTotals: [["thread", usage(2)]],
    turnTokenUsage: [["turn", { usage: usage(3), reported: true }]],
    threadContextUsage: [["thread\0turn", {
      threadId: "thread",
      turnId: "turn",
      modelContextWindow: 10,
      usedTokens: 4,
      provisional: false,
      updatedAt: "2026-08-04T10:00:00.000Z",
    }]],
  });
});

test("CodexUsageTracker keeps maps bounded and has an empty consume fallback", () => {
  const tracker = new CodexUsageTracker({ totalLimit: 1, contextLimit: 1 });
  tracker.track({ threadId: "one", turnId: "a", tokenUsage: { total: usage(1) } });
  tracker.track({ threadId: "two", turnId: "b", tokenUsage: { total: usage(2) } });
  assert.deepEqual([...tracker.threadTotals.keys()], ["two"]);
  assert.deepEqual(tracker.consume("missing"), { usage: usage(0), reported: false });
});
