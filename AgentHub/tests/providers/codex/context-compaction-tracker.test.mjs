import assert from "node:assert/strict";
import test from "node:test";

import {
  ContextCompactionTracker,
  isContextCompactionItem,
  isRawCompactionItem,
} from "../../../src/providers/codex/context-compaction-tracker.mjs";

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
  const cleaning = tracker.beginCleanup("thread-1", {
    turnId: "turn-1",
    itemId: "item-1",
    compactedAt: now,
  });
  assert.equal(cleaning.status, "running");
  assert.equal(cleaning.stage, "cleaning-images");
  assert.equal(tracker.isRunning("thread-1"), true);
  now += 1_000;
  const completed = tracker.complete("thread-1", {
    turnId: "turn-1",
    itemId: "item-1",
    completedAt: now,
  });
  assert.equal(completed.id, "manual-compaction");
  assert.equal(completed.status, "completed");
  assert.equal(completed.stage, "completed");
  assert.equal(tracker.isRunning("thread-1"), false);
  assert.equal(tracker.isManualTurn("thread-1", "turn-1"), true);
  assert.equal(tracker.isManualTurn("thread-1", "turn-other"), false);
  tracker.dispose();
});

test("an automatic compaction is visible from start through completion", () => {
  const settled = [];
  const tracker = new ContextCompactionTracker({
    idFactory: () => "auto-id",
    onSettled: (event) => settled.push(event),
  });
  const started = tracker.begin("thread-2", {
    origin: "automatic",
    turnId: "turn-2",
    itemId: "item-2",
  });
  assert.equal(started.origin, "automatic");
  assert.equal(tracker.isRunning("thread-2"), true);
  assert.equal(tracker.runningCount(), 1);
  const completed = tracker.complete("thread-2", { turnId: "turn-2", itemId: "item-2" });
  assert.equal(completed.status, "completed");
  assert.equal(completed.origin, "automatic");
  assert.equal(tracker.isManualTurn("thread-2", "turn-2"), false);
  assert.equal(tracker.runningCount(), 0);
  assert.equal(settled.length, 1);
  assert.equal(settled[0].threadId, "thread-2");
  assert.equal(settled[0].record.status, "completed");
  tracker.annotate("thread-2", started.id, { beforePercent: 86.4, afterPercent: 18.2 });
  assert.equal(tracker.get("thread-2").beforePercent, 86.4);
  assert.equal(tracker.get("thread-2").afterPercent, 18.2);
  tracker.dispose();
});

test("a missing completion becomes a bounded timeout instead of staying active forever", () => {
  let callback = null;
  let now = Date.parse("2026-07-31T18:20:00.000Z");
  const settled = [];
  const tracker = new ContextCompactionTracker({
    clock: () => now,
    idFactory: () => "timeout-id",
    setTimer: (handler) => {
      callback = handler;
      return { unref() {} };
    },
    clearTimer: () => {},
    onSettled: (event) => settled.push(event),
  });
  tracker.begin("thread-3");
  now += 120_000;
  callback();
  assert.equal(tracker.get("thread-3").status, "timeout");
  assert.equal(tracker.isRunning("thread-3"), false);
  assert.equal(settled[0].record.status, "timeout");
  tracker.dispose();
});

test("both current and wire-format compaction item names are accepted", () => {
  assert.equal(isContextCompactionItem({ type: "contextCompaction" }), true);
  assert.equal(isContextCompactionItem({ type: "context_compaction" }), true);
  assert.equal(isContextCompactionItem({ type: "agentMessage" }), false);
});

test("raw compaction items are retained for a clean Thread transfer", async () => {
  const tracker = new ContextCompactionTracker({ idFactory: () => "rotation-id" });
  const started = tracker.begin("thread-rotation", {
    origin: "manual",
    captureRawItem: true,
  });
  const pending = tracker.waitForRawItem("thread-rotation", started.id);
  const item = { type: "compaction", encrypted_content: "opaque" };
  tracker.rememberRawItem("thread-rotation", { turnId: "turn-1", item });
  assert.equal(await pending, item);
  assert.equal(await tracker.waitForRawItem("thread-rotation", started.id), item);
  assert.equal(tracker.clearRawItem("thread-rotation", started.id), true);
  assert.equal(isRawCompactionItem(item), true);
  assert.equal(isRawCompactionItem({ type: "message" }), false);
  tracker.dispose();
});

test("raw compaction items are ignored outside rotation", () => {
  const tracker = new ContextCompactionTracker({ idFactory: () => "manual-id" });
  tracker.begin("thread-manual", { origin: "manual" });
  assert.equal(tracker.rememberRawItem("thread-manual", {
    item: { type: "compaction", encrypted_content: "opaque" },
  }), null);
  assert.equal(tracker.get("thread-manual").rawItem, undefined);
  tracker.dispose();
});

test("rotation can await the exact compaction without polling", async () => {
  const tracker = new ContextCompactionTracker({ idFactory: () => "rotation-id" });
  const started = tracker.begin("thread-rotation", { origin: "manual" });
  const settlement = tracker.waitForSettlement("thread-rotation", started.id);
  tracker.complete("thread-rotation", { itemId: "wire-item" });
  assert.equal((await settlement)?.status, "completed");
  assert.equal(await tracker.waitForSettlement("thread-rotation", "other-id"), null);
  tracker.dispose();
});
