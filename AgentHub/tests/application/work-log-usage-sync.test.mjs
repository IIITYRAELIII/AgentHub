import assert from "node:assert/strict";
import test from "node:test";

import {
  mergeUsageSyncEvents,
  normalizeUsageSyncEvent,
  syncedUsageEventsToTurns,
  usageSyncEventIdentity,
  usageSyncSnapshotFromLedger,
  usageSyncThreadKey,
} from "../../src/domain/work-log-usage-sync.mjs";
import {
  incomingLedgerRecord,
  mergeLedgerRecord,
  normalizedLedger,
} from "../../src/application/work-log-usage-projection.mjs";

test("usage sync events identify the turn and never keep raw provider ids", () => {
  const event = normalizeUsageSyncEvent({
    deviceId: "device-a",
    provider: "Codex",
    threadId: "thread-1",
    turnId: "turn-1",
    completedAt: "2026-08-20T01:00:00.000Z",
    credits: 12,
    accountKey: "chatgpt:owner",
  });

  assert.equal(event.provider, "codex");
  assert.equal(event.estimatedCredits, 12);
  assert.equal(event.accountAttribution, "exact");
  assert.equal(event.eventId, usageSyncEventIdentity({
    provider: "codex",
    threadId: "thread-1",
    turnId: "turn-1",
  }));
  assert.equal(event.threadKey, usageSyncThreadKey({ provider: "codex", threadId: "thread-1" }));
  assert.equal(event.taskKey, event.threadKey);
  for (const field of ["threadId", "turnId", "taskThreadId"]) {
    assert.ok(!Object.hasOwn(event, field), `${field} must not survive into a sync event`);
  }
  assert.ok(!JSON.stringify(event).includes("thread-1"));
  assert.ok(!JSON.stringify(event).includes("turn-1"));
});

test("turn identity is independent of the device that recorded it", () => {
  const turn = {
    provider: "codex",
    threadId: "thread-1",
    turnId: "turn-1",
    completedAt: "2026-08-20T01:00:00.000Z",
  };
  const first = normalizeUsageSyncEvent({ ...turn, deviceId: "device-a" });
  const second = normalizeUsageSyncEvent({ ...turn, deviceId: "device-b" });

  assert.equal(first.eventId, second.eventId);
  assert.equal(mergeUsageSyncEvents([first], [second]).length, 1);
});

test("corrected ledger usage advances the same sync event without touching unchanged turns", () => {
  const fields = {
    provider: "codex",
    threadId: "thread-1",
    turnId: "turn-1",
    completedAt: "2026-08-20T01:00:00.000Z",
    accountKey: "chatgpt:owner",
    usageReported: false,
  };
  const original = incomingLedgerRecord({
    ...fields,
    observedAt: "2026-08-20T01:01:00.000Z",
  });
  const unchanged = incomingLedgerRecord({
    ...fields,
    observedAt: "2026-08-25T01:00:00.000Z",
  });

  mergeLedgerRecord(original, unchanged);
  assert.equal(original.observedAt, "2026-08-20T01:01:00.000Z");

  const corrected = incomingLedgerRecord({
    ...fields,
    usageReported: true,
    usage: { inputTokens: 100, outputTokens: 25, totalTokens: 125 },
    observedAt: "2026-08-25T01:02:00.000Z",
  });
  mergeLedgerRecord(original, corrected);
  assert.equal(original.observedAt, "2026-08-25T01:02:00.000Z");

  const snapshot = usageSyncSnapshotFromLedger({ turn: original }, { deviceId: "device-a" });
  assert.equal(snapshot.events.length, 1);
  assert.equal(snapshot.events[0].observedAt, "2026-08-25T01:02:00.000Z");
  assert.equal(snapshot.events[0].usage.totalTokens, 125);

  const restored = normalizedLedger({ version: 9, turns: { turn: original } });
  assert.equal(restored.ledger.turns.turn.observedAt, "2026-08-25T01:02:00.000Z");
});

test("a sync event without a resolvable turn identity is rejected", () => {
  const base = {
    deviceId: "device-a",
    provider: "codex",
    completedAt: "2026-08-20T01:00:00.000Z",
  };
  assert.equal(normalizeUsageSyncEvent({ ...base, threadId: "thread-1" }), null);
  assert.equal(normalizeUsageSyncEvent({ ...base, turnId: "turn-1" }), null);
  assert.equal(normalizeUsageSyncEvent({ ...base, eventId: "usage:x" }), null);
});

test("already pseudonymized events are accepted without raw ids", () => {
  const threadKey = usageSyncThreadKey({ provider: "codex", threadId: "thread-1" });
  const event = normalizeUsageSyncEvent({
    deviceId: "device-b",
    provider: "codex",
    eventId: "usage:abc",
    threadKey,
    completedAt: "2026-08-20T01:00:00.000Z",
  });

  assert.equal(event.eventId, "usage:abc");
  assert.equal(event.threadKey, threadKey);
  assert.equal(event.taskKey, threadKey, "a missing task pseudonym falls back to the thread");
});

test("usage sync merge deduplicates events and keeps stronger account attribution", () => {
  const weak = normalizeUsageSyncEvent({
    deviceId: "device-a",
    provider: "codex",
    threadId: "thread-1",
    turnId: "turn-1",
    completedAt: "2026-08-20T01:00:00.000Z",
    credits: 1,
    accountKey: "chatgpt:owner",
    accountAttribution: "inferred",
    observedAt: "2026-08-20T01:01:00.000Z",
  });
  const strong = {
    ...weak,
    accountAttribution: "exact",
    observedAt: "2026-08-20T01:00:30.000Z",
  };

  const merged = mergeUsageSyncEvents([weak], [strong]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].accountAttribution, "exact");
});

test("usage sync snapshot exports ledger records as minimal remote turns", () => {
  const snapshot = usageSyncSnapshotFromLedger({
    "codex\u0000thread-1\u0000turn-1": {
      provider: "codex",
      threadId: "thread-1",
      turnId: "turn-1",
      completedAt: "2026-08-20T01:00:00.000Z",
      estimatedCredits: 12,
      estimateKind: "imagegen-default",
      imageGenerationCount: 2,
      contextProbe: true,
      accountKey: "chatgpt:owner",
      accountLabel: "owner@example.com",
      accountType: "chatgpt",
      accountPlan: "plus",
      accountAttribution: "exact",
    },
  }, { deviceId: "device-a", deviceLabel: "SidorukSV" });

  assert.equal(snapshot.version, 1);
  assert.equal(snapshot.events.length, 1);
  assert.ok(!JSON.stringify(snapshot).includes("thread-1"), "raw thread ids stay on the device");
  assert.ok(!JSON.stringify(snapshot).includes("turn-1"), "raw turn ids stay on the device");

  const [event] = snapshot.events;
  assert.equal(event.observedAt, "2026-08-20T01:00:00.000Z");
  assert.equal(event.deviceLabel, "SidorukSV");
  assert.equal(event.accountLabel, "owner@example.com");
  assert.equal(event.accountType, "chatgpt");
  assert.equal(event.accountPlan, "plus");
  assert.equal(event.estimateKind, "imagegen-default");
  assert.equal(event.imageGenerationCount, 2);
  assert.equal(event.contextProbe, true);
  const turns = syncedUsageEventsToTurns(snapshot.events);
  const key = `codex\u0000sync:device-a:${event.threadKey}\u0000${event.eventId}`;
  assert.deepEqual(Object.keys(turns), [key]);
  assert.equal(turns[key].syncDeviceId, "device-a");
  assert.equal(turns[key].syncDeviceLabel, "SidorukSV");
  assert.equal(turns[key].accountLabel, "owner@example.com");
  assert.equal(turns[key].taskThreadId, `sync:device-a:${event.taskKey}`);
  assert.equal(turns[key].estimateKind, "imagegen-default");
  assert.equal(turns[key].imageGenerationCount, 2);
  assert.equal(turns[key].contextProbe, true);
});

test("usage sync snapshot can export only records observed after a watermark", () => {
  const snapshot = usageSyncSnapshotFromLedger({
    "codex\u0000thread-1\u0000turn-1": {
      provider: "codex",
      threadId: "thread-1",
      turnId: "turn-1",
      completedAt: "2026-08-20T01:00:00.000Z",
      observedAt: "2026-08-20T01:01:00.000Z",
    },
    "codex\u0000thread-2\u0000turn-2": {
      provider: "codex",
      threadId: "thread-2",
      turnId: "turn-2",
      completedAt: "2026-08-20T02:00:00.000Z",
      observedAt: "2026-08-20T02:01:00.000Z",
    },
  }, {
    deviceId: "device-a",
    afterObservedAt: "2026-08-20T01:30:00.000Z",
  });

  assert.equal(snapshot.events.length, 1);
  assert.equal(snapshot.events[0].completedAt, "2026-08-20T02:00:00.000Z");
});

test("turns of one thread stay grouped after pseudonymization", () => {
  const record = (turnId) => ({
    provider: "codex",
    threadId: "thread-1",
    turnId,
    completedAt: "2026-08-20T01:00:00.000Z",
  });
  const snapshot = usageSyncSnapshotFromLedger({
    "codex\u0000thread-1\u0000turn-1": record("turn-1"),
    "codex\u0000thread-1\u0000turn-2": record("turn-2"),
  }, { deviceId: "device-a" });

  const turns = Object.values(syncedUsageEventsToTurns(snapshot.events));
  assert.equal(turns.length, 2);
  assert.equal(new Set(turns.map((turn) => turn.threadId)).size, 1);
});
