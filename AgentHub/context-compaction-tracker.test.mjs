import assert from "node:assert/strict";
import test from "node:test";

import {
  ContextCompactionTracker,
  isContextCompactionItem,
} from "./context-compaction-tracker.mjs";

test("modern compaction item lifecycle completes a manual request without changing its id", () => {
  let now = Date.parse("2026-07-31T18:20:00.000Z");
  const tracker = new ContextCompactionTracker({
    clock: () => now,
    idFactory: () => "manual-compaction",
  });
  const manual = tracker.begin("thread-1", { origin: "manual" });
  now += 1_000;
  const observed = tracker.begin("thread-1", {
    origin: "automatic",
    turnId: "turn-1",
    itemId: "item-1",
    startedAt: now,
  });
  assert.equal(observed.id, manual.id);
  assert.equal(observed.origin, "manual");
  assert.equal(observed.itemId, "item-1");
  now += 1_000;
  const completed = tracker.complete("thread-1", {
    turnId: "turn-1",
    itemId: "item-1",
    completedAt: now,
  });
  assert.equal(completed.id, "manual-compaction");
  assert.equal(completed.status, "completed");
  assert.equal(tracker.isRunning("thread-1"), false);
  tracker.dispose();
});

test("an automatic compaction is visible from start through completion", () => {
  const tracker = new ContextCompactionTracker({ idFactory: () => "auto-id" });
  const started = tracker.begin("thread-2", {
    origin: "automatic",
    turnId: "turn-2",
    itemId: "item-2",
  });
  assert.equal(started.origin, "automatic");
  assert.equal(tracker.isRunning("thread-2"), true);
  const completed = tracker.complete("thread-2", { turnId: "turn-2", itemId: "item-2" });
  assert.equal(completed.status, "completed");
  assert.equal(completed.origin, "automatic");
  tracker.dispose();
});

test("a missing completion becomes a bounded timeout instead of staying active forever", () => {
  let callback = null;
  let now = Date.parse("2026-07-31T18:20:00.000Z");
  const tracker = new ContextCompactionTracker({
    clock: () => now,
    idFactory: () => "timeout-id",
    setTimer: (handler) => {
      callback = handler;
      return { unref() {} };
    },
    clearTimer: () => {},
  });
  tracker.begin("thread-3");
  now += 120_000;
  callback();
  assert.equal(tracker.get("thread-3").status, "timeout");
  assert.equal(tracker.isRunning("thread-3"), false);
  tracker.dispose();
});

test("both current and wire-format compaction item names are accepted", () => {
  assert.equal(isContextCompactionItem({ type: "contextCompaction" }), true);
  assert.equal(isContextCompactionItem({ type: "context_compaction" }), true);
  assert.equal(isContextCompactionItem({ type: "agentMessage" }), false);
});
