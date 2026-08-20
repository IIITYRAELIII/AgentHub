import assert from "node:assert/strict";
import test from "node:test";

import {
  mergeUsageSyncEvents,
  normalizeUsageSyncEvent,
  syncedUsageEventsToTurns,
  usageSyncEventIdentity,
  usageSyncSnapshotFromLedger,
} from "../../src/domain/work-log-usage-sync.mjs";

test("usage sync events get stable device-scoped ids", () => {
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
  assert.equal(event.eventId, usageSyncEventIdentity(event));
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
      accountKey: "chatgpt:owner",
      accountAttribution: "exact",
    },
  }, { deviceId: "device-a" });

  assert.equal(snapshot.version, 1);
  assert.equal(snapshot.events.length, 1);
  const turns = syncedUsageEventsToTurns(snapshot.events);
  assert.deepEqual(Object.keys(turns), ["codex\u0000sync:device-a:thread-1\u0000turn-1"]);
  assert.equal(turns["codex\u0000sync:device-a:thread-1\u0000turn-1"].syncDeviceId, "device-a");
});
