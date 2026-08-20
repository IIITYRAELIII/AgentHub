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

test("the first exact context after an automatic compaction is immutable", () => {
  let now = Date.parse("2026-08-08T19:58:35.000Z");
  const tracker = new ContextCompactionTracker({
    clock: () => now,
    idFactory: () => "mid-turn-id",
  });
  tracker.begin("thread-mid-turn", {
    origin: "automatic",
    turnId: "turn-long",
    beforePercent: 87.1,
  });
  now += 1_000;
  tracker.complete("thread-mid-turn", {
    turnId: "turn-long",
    completedAt: now,
  });

  assert.equal(tracker.observeContext({
    threadId: "thread-mid-turn",
    turnId: "turn-long",
    usedTokens: 23_068,
    modelContextWindow: 258_400,
    provisional: true,
    updatedAt: new Date(now + 1).toISOString(),
  }), null);
  const measured = tracker.observeContext({
    threadId: "thread-mid-turn",
    turnId: "turn-long",
    usedTokens: 25_247,
    modelContextWindow: 258_400,
    provisional: false,
    updatedAt: new Date(now + 2).toISOString(),
  });
  assert.equal(measured.afterPercent, 9.770511);
  assert.equal(measured.measurementStatus, "completed");

  assert.equal(tracker.observeContext({
    threadId: "thread-mid-turn",
    turnId: "turn-long",
    usedTokens: 79_389,
    modelContextWindow: 258_400,
    provisional: false,
    updatedAt: new Date(now + 399_000).toISOString(),
  }), null);
  assert.equal(tracker.get("thread-mid-turn").afterPercent, 9.770511);
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
  assert.equal((await settlement)?.status, "timeout");
  assert.equal(tracker.get("thread-provider-turn").stage, "timeout");
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

test("a running compaction becomes a timeout immediately after process restart", () => {
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
    id: "interrupted-compaction",
    origin: "automatic",
    status: "timeout",
    stage: "timeout",
    turnId: null,
    itemId: null,
    captureRawItem: false,
    startedAt: "2026-08-11T00:14:30.000Z",
    compactedAt: null,
    completedAt: "2026-08-11T00:15:00.000Z",
    probeTurnIds: [],
  });
  assert.equal(tracker.isRunning("thread-restarted"), false);
  assert.equal(scheduled, 0);
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

test("an exact probe restores a compaction result after process restart", () => {
  const changes = [];
  const original = new ContextCompactionTracker({
    idFactory: () => "restart-id",
    onChanged: (event) => changes.push(event),
  });
  const started = original.begin("thread-restart", {
    origin: "automatic",
    beforePercent: 89,
    captureRawItem: true,
  });
  original.complete("thread-restart", { turnId: "compaction-turn" });
  original.annotate("thread-restart", started.id, {
    measurementStatus: "running",
    probeTurnId: "probe-turn",
  });

  const snapshot = original.snapshot();
  assert.equal(changes.length, 3);
  assert.deepEqual(snapshot[0][1].probeTurnIds, ["probe-turn"]);
  assert.equal(snapshot[0][1].rawItem, undefined);

  const restored = new ContextCompactionTracker();
  restored.restore(snapshot);
  const result = restored.observeContext({
    threadId: "thread-restart",
    turnId: "probe-turn",
    usedTokens: 41_838,
    modelContextWindow: 258_400,
    provisional: false,
  });

  assert.equal(result.measurementStatus, "completed");
  assert.equal(result.beforePercent, 89);
  assert.equal(result.afterPercent, 16.191176);
  original.dispose();
  restored.dispose();
});

test("a later compaction keeps recent probe turn ids for history filtering", () => {
  let nextId = 0;
  const tracker = new ContextCompactionTracker({ idFactory: () => `compaction-${++nextId}` });
  const first = tracker.begin("thread-history");
  tracker.complete("thread-history");
  tracker.annotate("thread-history", first.id, { probeTurnId: "probe-old" });

  const second = tracker.begin("thread-history");
  assert.equal(second.id, "compaction-2");
  assert.deepEqual(second.probeTurnIds, ["probe-old"]);
  tracker.dispose();
});
