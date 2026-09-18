import assert from "node:assert/strict";
import test from "node:test";

import {
  ContextCompactionTracker,
  isContextCompactionItem,
  isRawCompactionItem,
} from "../../../src/providers/codex/context-compaction-tracker.mjs";

test("exact bound rotation metadata survives snapshot restore without replacing compaction measurements", () => {
  const original = new ContextCompactionTracker({ idFactory: () => "rotation-source-operation" });
  const record = original.begin("source-thread", { origin: "manual" });
  original.complete("source-thread", { operationId: record.id });
  original.annotate("source-thread", record.id, {
    beforePercent: 78, afterPercent: 26, rotated: true,
    rotationThreadId: "target-thread", rotationCompletedAt: "2026-09-11T01:00:00.000Z",
  });
  const restored = new ContextCompactionTracker();
  restored.restore(original.snapshot());
  assert.equal(restored.get("source-thread").rotationThreadId, "target-thread");
  assert.equal(restored.get("source-thread").rotationCompletedAt, "2026-09-11T01:00:00.000Z");
  assert.equal(restored.get("source-thread").rotationAfterPercent, undefined);
  assert.equal(restored.annotate("source-thread", "unrelated-operation", { afterPercent: 90 }), null);
  const measured = new ContextCompactionTracker();
  measured.restore(restored.snapshot());
  assert.equal(measured.get("source-thread").rotated, true);
  assert.equal(measured.get("source-thread").beforePercent, 78);
  assert.equal(measured.get("source-thread").afterPercent, 26);
  assert.equal(measured.get("source-thread").rotationAfterPercent, undefined);
  original.dispose();
  restored.dispose();
  measured.dispose();
});

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

test("a late compaction item cannot replace the original context baseline", () => {
  const tracker = new ContextCompactionTracker({ idFactory: () => "hub-compaction" });
  const started = tracker.begin("thread-baseline", {
    origin: "automatic",
    beforePercent: 77.748452,
    captureRawItem: true,
  });

  const observed = tracker.begin("thread-baseline", {
    origin: "automatic",
    turnId: "compaction-turn",
    itemId: "compaction-item",
    beforePercent: 6.87113,
  });

  assert.equal(observed.id, started.id);
  assert.equal(observed.itemId, "compaction-item");
  assert.equal(observed.beforePercent, 77.748452);
  tracker.dispose();
});

test("an unavailable measurement never becomes a fabricated zero", () => {
  const tracker = new ContextCompactionTracker({ idFactory: () => "measurement-id" });
  const started = tracker.begin("thread-measurement", { beforePercent: null });
  assert.equal(started.beforePercent, undefined);
  tracker.complete("thread-measurement");
  tracker.annotate("thread-measurement", started.id, {
    beforePercent: 80,
    afterPercent: null,
    measurementStatus: "failed",
  });
  assert.equal(tracker.get("thread-measurement").beforePercent, 80);
  assert.equal(tracker.get("thread-measurement").afterPercent, undefined);
  assert.equal(tracker.get("thread-measurement").measurementStatus, "failed");
  tracker.annotate("thread-measurement", started.id, {
    afterPercent: 0,
    measurementStatus: "completed",
  });
  assert.equal(tracker.get("thread-measurement").afterPercent, 0);
  assert.equal(tracker.get("thread-measurement").measurementStatus, "completed");
  tracker.dispose();
});

test("a missing completion becomes unknown until reconciliation", () => {
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
  assert.equal(tracker.get("thread-3").status, "unknown");
  assert.equal(tracker.get("thread-3").stage, "reconciling");
  assert.equal(tracker.isRunning("thread-3"), false);
  assert.equal(settled[0].record.status, "unknown");
  tracker.dispose();
});

test("a confirmed provider turn replaces the request-start watchdog with a bounded timeout", async () => {
  let now = Date.parse("2026-08-19T12:11:40.000Z");
  let nextTimerId = 0;
  const scheduled = new Map();
  const tracker = new ContextCompactionTracker({
    clock: () => now,
    idFactory: () => "provider-turn-id",
    setTimer: (handler, timeoutMs) => {
      const timer = { id: ++nextTimerId, handler, timeoutMs };
      scheduled.set(timer.id, timer);
      return timer;
    },
    clearTimer: (timer) => scheduled.delete(timer.id),
  });

  tracker.begin("thread-provider-turn");
  assert.equal(scheduled.size, 1);
  assert.equal([...scheduled.values()][0].timeoutMs, 2 * 60_000);

  const started = tracker.begin("thread-provider-turn", { turnId: "compaction-turn" });
  const settlement = tracker.waitForSettlement("thread-provider-turn", started.id);
  assert.equal(scheduled.size, 1);
  assert.equal([...scheduled.values()][0].timeoutMs, 10 * 60_000);

  now += 5 * 60_000;
  assert.equal(tracker.get("thread-provider-turn").status, "running");
  assert.equal(tracker.get("thread-provider-turn").turnId, "compaction-turn");

  now += 5 * 60_000;
  [...scheduled.values()][0].handler();
  assert.equal((await settlement)?.status, "unknown");
  assert.equal(tracker.get("thread-provider-turn").stage, "reconciling");
  assert.equal(tracker.isRunning("thread-provider-turn"), false);
  tracker.dispose();
});

test("an interrupted provider turn settles its pending compaction", async () => {
  const tracker = new ContextCompactionTracker({ idFactory: () => "interrupted-id" });
  const started = tracker.begin("thread-interrupted", { turnId: "compaction-turn" });
  const settlement = tracker.waitForSettlement("thread-interrupted", started.id);

  assert.equal(tracker.settleProviderTurn("thread-interrupted", {
    turnId: "compaction-turn",
    status: "interrupted",
  }), true);
  assert.equal((await settlement)?.status, "failed");
  assert.equal(tracker.isRunning("thread-interrupted"), false);
  tracker.dispose();
});

test("a running compaction becomes unknown immediately after process restart", () => {
  const now = Date.parse("2026-08-11T00:15:00.000Z");
  let scheduled = 0;
  const tracker = new ContextCompactionTracker({
    clock: () => now,
    setTimer: () => {
      scheduled += 1;
      return { unref() {} };
    },
  });

  tracker.restore([[
    "thread-restarted",
    {
      id: "interrupted-compaction",
      origin: "automatic",
      status: "running",
      stage: "compacting",
      startedAt: "2026-08-11T00:14:30.000Z",
    },
  ]]);

  assert.deepEqual(tracker.get("thread-restarted"), {
    operationId: "interrupted-compaction",
    id: "interrupted-compaction",
    streamId: null,
    revision: 1,
    origin: "automatic",
    status: "unknown",
    stage: "reconciling",
    turnId: null,
    itemId: null,
    captureRawItem: false,
    startedAt: "2026-08-11T00:14:30.000Z",
    compactedAt: null,
    completedAt: "2026-08-11T00:15:00.000Z",
  });
  assert.equal(tracker.isRunning("thread-restarted"), false);
  assert.equal(scheduled, 0);
  tracker.dispose();
});

test("a reordered completion cannot settle a newer compaction operation", () => {
  let nextId = 0;
  const tracker = new ContextCompactionTracker({
    idFactory: () => "operation-" + (++nextId),
  });
  const first = tracker.begin("thread-reorder");
  tracker.fail("thread-reorder", first.operationId);
  const second = tracker.begin("thread-reorder");

  assert.equal(tracker.complete("thread-reorder", {
    operationId: first.operationId,
  }), null);
  assert.equal(tracker.get("thread-reorder").operationId, second.operationId);
  assert.equal(tracker.get("thread-reorder").status, "running");
  tracker.dispose();
});

test("a failed compaction remains visible after it stops running", async () => {
  let now = Date.parse("2026-08-08T12:50:36.000Z");
  const settled = [];
  const tracker = new ContextCompactionTracker({
    clock: () => now,
    idFactory: () => "failed-id",
    onSettled: (event) => settled.push(event),
  });
  const started = tracker.begin("thread-failed", {
    origin: "automatic",
    beforePercent: 78,
  });
  const settlement = tracker.waitForSettlement("thread-failed", started.id);
  now += 16_000;

  assert.equal(tracker.fail("thread-failed", started.id), true);
  assert.equal(tracker.isRunning("thread-failed"), false);
  assert.equal(tracker.get("thread-failed").status, "failed");
  assert.equal(tracker.get("thread-failed").beforePercent, 78);
  assert.equal(tracker.get("thread-failed").completedAt, "2026-08-08T12:50:52.000Z");
  assert.equal((await settlement)?.status, "failed");
  assert.equal(settled[0].record.status, "failed");
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

test("first fresh same-turn estimate survives later actual usage and restart", () => {
  const boundary = "2026-09-17T01:00:00.000Z";
  const tracker = new ContextCompactionTracker({ clock: () => Date.parse(boundary) });
  const record = tracker.begin("thread", { turnId: "turn", origin: "automatic" });
  tracker.beginCleanup("thread", { turnId: "turn", compactedAt: boundary });
  const estimate = { threadId: "thread", turnId: "turn", usedTokens: 64099,
    modelContextWindow: 258400, provisional: true, updatedAt: boundary };
  const observed = tracker.observeContext(estimate);
  assert.equal(observed.afterPercent, 24.806115);
  assert.equal(observed.measurementKind, "estimated");
  tracker.complete("thread", { turnId: "turn" });
  assert.equal(tracker.observeContext({ ...estimate, provisional: false, usedTokens: 73742 }), null);
  assert.equal(tracker.observeContext({ ...estimate, usedTokens: 99999 }), null);
  tracker.annotate("thread", record.id, { measurementStatus: "failed" });
  assert.equal(tracker.get("thread").measurementStatus, "completed");
  const restored = new ContextCompactionTracker();
  restored.restore(tracker.snapshot());
  assert.equal(restored.get("thread").afterPercent, 24.806115);
  assert.equal(restored.get("thread").measurementKind, "estimated");
  tracker.dispose(); restored.dispose();
});

test("old wrong-turn and missing estimates cannot fabricate a zero or replace a new compaction", () => {
  const boundary = "2026-09-17T01:00:00.000Z";
  const tracker = new ContextCompactionTracker({ clock: () => Date.parse(boundary) });
  tracker.begin("thread", { turnId: "turn", origin: "automatic" });
  tracker.complete("thread", { turnId: "turn", completedAt: boundary });
  const estimate = { threadId: "thread", turnId: "turn", usedTokens: 0,
    modelContextWindow: 258400, provisional: true, updatedAt: boundary };
  for (const delta of [
    { turnId: "earlier" }, { threadId: "other" }, { updatedAt: "2026-09-16T01:00:00.000Z" },
    { provisional: false }, { usedTokens: null }, { usedTokens: undefined },
    { usedTokens: NaN }, { modelContextWindow: 0 },
  ]) assert.equal(tracker.observeContext({ ...estimate, ...delta }), null);
  assert.equal(tracker.get("thread").afterPercent, undefined);
  assert.equal(tracker.observeContext(estimate).afterPercent, 0);
  tracker.begin("thread", { turnId: "next", origin: "automatic" });
  assert.equal(tracker.get("thread").afterPercent, undefined);
  assert.equal(tracker.observeContext(estimate), null);
  tracker.dispose();
});
