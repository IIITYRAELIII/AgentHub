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
  codexUsageAccount,
  usageAuthFingerprint,
} from "../../src/domain/usage-account-identity.mjs";
import {
  authObservationId,
  detectIdentityCollisions,
  limitObservationId,
  normalizeLimitObservation,
  usageFactSummary,
} from "../../src/domain/usage-facts.mjs";

const RUNTIME_HOME_ID = "1".repeat(64);

function turn(extra = {}) {
  return {
    schemaVersion: 2,
    type: "turn",
    eventId: `usage:${"a".repeat(64)}`,
    deviceId: "device-a",
    provider: "codex",
    runtimeHomeId: RUNTIME_HOME_ID,
    threadKey: usageSyncThreadKey({ provider: "codex", threadId: "thread-1" }),
    taskKey: usageSyncThreadKey({ provider: "codex", threadId: "task-1" }),
    startedAt: "2026-08-20T00:59:00.000Z",
    completedAt: "2026-08-20T01:00:00.000Z",
    observedAt: "2026-08-20T01:00:01.000Z",
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    usageReported: true,
    model: "gpt-5.6-sol",
    serviceTier: "fast",
    ...extra,
  };
}

test("schema 2 turn facts reject account fields at the sync boundary", () => {
  assert.equal(normalizeUsageSyncEvent(turn({ accountKey: "chatgpt:owner" })), null);
  assert.equal(normalizeUsageSyncEvent(turn({ accountAttribution: "exact" })), null);
});

test("legacy schema 1 events are accepted but lose every account hint", () => {
  const event = normalizeUsageSyncEvent({
    schemaVersion: 1,
    deviceId: "device-a",
    provider: "codex",
    threadId: "thread-1",
    turnId: "turn-1",
    completedAt: "2026-08-20T01:00:00.000Z",
    credits: 12,
    accountKey: "chatgpt:owner",
    accountLabel: "owner@example.test",
    accountType: "chatgpt",
    accountPlan: "pro",
    accountAttribution: "exact",
  });

  assert.equal(event.schemaVersion, 1);
  assert.equal(event.estimatedCredits, 12);
  assert.equal(event.runtimeHomeId, "");
  for (const field of ["accountKey", "accountLabel", "accountType", "accountPlan", "accountAttribution"]) {
    assert.ok(!Object.hasOwn(event, field), `${field} must not survive legacy ingest`);
  }
});

test("schema 2 turns require runtimeHomeId and startedAt", () => {
  assert.equal(normalizeUsageSyncEvent(turn({ runtimeHomeId: "" })), null);
  assert.equal(normalizeUsageSyncEvent(turn({ startedAt: "" })), null);
});

test("turn identity stays independent of the device that recorded it", () => {
  const first = usageSyncEventIdentity({ provider: "codex", threadId: "thread-1", turnId: "turn-1" });
  const second = usageSyncEventIdentity({ provider: "codex", threadId: "thread-1", turnId: "turn-1" });
  assert.equal(first, second);
});

test("limit samples preserve primary and secondary lanes separately", () => {
  const event = normalizeUsageSyncEvent(turn({
    limitSamples: [
      {
        observedAt: "2026-08-20T00:59:10.000Z",
        limitId: "codex",
        window: "secondary",
        windowMinutes: 10080,
        usedPercent: 50,
        resetsAt: "2026-08-27T00:00:00.000Z",
        planType: "pro",
      },
      {
        observedAt: "2026-08-20T00:59:10.000Z",
        limitId: "codex",
        window: "primary",
        windowMinutes: 300,
        usedPercent: 10,
        resetsAt: "2026-08-20T05:00:00.000Z",
        planType: "pro",
      },
    ],
  }));

  assert.deepEqual(event.limitSamples.map((sample) => sample.window), ["primary", "secondary"]);
  assert.deepEqual(event.limitSamples.map((sample) => sample.windowMinutes), [300, 10080]);
});

test("limit observation identity is derived from canonical lane fields", () => {
  const staleId = `limit:${"0".repeat(64)}`;
  const base = {
    schemaVersion: 2,
    type: "limit_observation",
    observationId: staleId,
    deviceId: "device-a",
    provider: "codex",
    accountKey: "chatgpt:owner",
    limitId: "codex",
    usedPercent: 10,
    observedAt: "2026-08-20T01:00:00.000Z",
  };

  const primary = normalizeLimitObservation({ ...base, window: "primary" });
  const secondary = normalizeLimitObservation({ ...base, window: "secondary" });

  assert.equal(primary.observationId, limitObservationId({ ...base, window: "primary" }));
  assert.equal(secondary.observationId, limitObservationId({ ...base, window: "secondary" }));
  assert.notEqual(primary.observationId, staleId);
  assert.notEqual(primary.observationId, secondary.observationId);
});

test("usage fact summary is deterministic and ignores presentation fields", () => {
  const first = usageFactSummary([
    turn({ source: "local", deviceLabel: "local name" }),
    {
      schemaVersion: 2,
      type: "limit_observation",
      observationId: `limit:${"0".repeat(64)}`,
      deviceId: "device-a",
      provider: "codex",
      accountKey: "chatgpt:owner",
      limitId: "codex",
      window: "primary",
      usedPercent: 10,
      observedAt: "2026-08-20T01:00:00.000Z",
    },
  ]);
  const second = usageFactSummary([
    {
      schemaVersion: 2,
      type: "limit_observation",
      observationId: `limit:${"9".repeat(64)}`,
      deviceId: "device-a",
      provider: "codex",
      accountKey: "chatgpt:owner",
      limitId: "codex",
      window: "primary",
      usedPercent: 10,
      observedAt: "2026-08-20T01:00:00.000Z",
    },
    turn({ source: "sync", deviceLabel: "remote name" }),
  ]);

  assert.equal(first.count, 2);
  assert.deepEqual(first.byType, {
    turn: 1,
    auth_observation: 0,
    limit_observation: 1,
  });
  assert.equal(first.digest, second.digest);
});

test("merge adds richer limit samples without moving the original observation time", () => {
  const earlier = normalizeUsageSyncEvent(turn({
    observedAt: "2026-08-20T01:00:01.000Z",
    limitSamples: [{
      observedAt: "2026-08-20T00:59:10.000Z",
      limitId: "codex",
      window: "primary",
      usedPercent: 10,
    }],
  }));
  const richer = normalizeUsageSyncEvent(turn({
    observedAt: "2026-08-20T01:05:01.000Z",
    limitSamples: [{
      observedAt: "2026-08-20T00:59:10.000Z",
      limitId: "codex",
      window: "secondary",
      usedPercent: 50,
    }],
  }));

  const [merged] = mergeUsageSyncEvents([earlier], [richer]);
  assert.equal(merged.observedAt, "2026-08-20T01:00:01.000Z");
  assert.deepEqual(merged.limitSamples.map((sample) => sample.window), ["primary", "secondary"]);
});

test("merge preserves conflicting limit samples and stays order-independent", () => {
  const first = normalizeUsageSyncEvent(turn({
    limitSamples: [{
      observedAt: "2026-08-20T00:59:10.000Z",
      limitId: "codex",
      window: "primary",
      usedPercent: 10,
    }],
  }));
  const second = normalizeUsageSyncEvent(turn({
    limitSamples: [{
      observedAt: "2026-08-20T00:59:10.000Z",
      limitId: "codex",
      window: "primary",
      usedPercent: 20,
    }],
  }));

  const [forward] = mergeUsageSyncEvents([first], [second]);
  const [reverse] = mergeUsageSyncEvents([second], [first]);

  assert.deepEqual(forward.limitSamples, reverse.limitSamples);
  assert.deepEqual(forward.limitSamples.map((sample) => sample.usedPercent), [10, 20]);
});

test("same-turn sync keeps richer cache-write and request-tier evidence in either order", () => {
  const legacy = normalizeUsageSyncEvent(turn({
    usage: { inputTokens: 300_000, cachedInputTokens: 100_000,
      outputTokens: 5_000, totalTokens: 305_000 },
  }));
  const enriched = normalizeUsageSyncEvent(turn({
    usage: {
      inputTokens: 300_000, cachedInputTokens: 100_000, cacheWriteInputTokens: 50_000,
      outputTokens: 5_000, totalTokens: 305_000,
      longContextInputTokens: 300_000, longContextCachedInputTokens: 100_000,
      longContextCacheWriteInputTokens: 50_000, longContextOutputTokens: 5_000,
    },
  }));
  const [forward] = mergeUsageSyncEvents([legacy], [enriched]);
  const [reverse] = mergeUsageSyncEvents([enriched], [legacy]);
  assert.deepEqual(forward.usage, enriched.usage);
  assert.deepEqual(reverse.usage, enriched.usage);
});

test("limit samples use canonical byte order instead of locale collation", () => {
  const event = normalizeUsageSyncEvent(turn({
    limitSamples: [
      { observedAt: "2026-08-20T00:59:10.000Z", limitId: "z", window: "primary", usedPercent: 1 },
      { observedAt: "2026-08-20T00:59:10.000Z", limitId: "ä", window: "primary", usedPercent: 1 },
      { observedAt: "2026-08-20T00:59:10.000Z", limitId: "pro", window: "primary", usedPercent: 1 },
      { observedAt: "2026-08-20T00:59:10.000Z", limitId: "PRO", window: "primary", usedPercent: 1 },
    ],
  }));

  assert.deepEqual(event.limitSamples.map((sample) => sample.limitId), ["PRO", "pro", "z", "ä"]);
});

test("usage sync snapshot exports schema 2 turn facts without raw ids or accounts", () => {
  const snapshot = usageSyncSnapshotFromLedger({
    "codex\u0000thread-1\u0000turn-1": {
      provider: "codex",
      threadId: "thread-1",
      turnId: "turn-1",
      startedAt: "2026-08-20T00:59:00.000Z",
      completedAt: "2026-08-20T01:00:00.000Z",
      estimatedCredits: 12,
      accountKey: "chatgpt:owner",
      accountAttribution: "exact",
    },
  }, {
    deviceId: "device-a",
    deviceLabel: "SidorukSV",
    defaultRuntimeHomeIds: { codex: RUNTIME_HOME_ID },
  });

  assert.equal(snapshot.events.length, 1);
  const [event] = snapshot.events;
  assert.equal(event.schemaVersion, 2);
  assert.equal(event.type, "turn");
  assert.equal(event.runtimeHomeId, RUNTIME_HOME_ID);
  assert.equal(event.deviceLabel, "SidorukSV");
  assert.ok(!JSON.stringify(snapshot).includes("thread-1"));
  assert.ok(!JSON.stringify(snapshot).includes("turn-1"));
  for (const field of ["accountKey", "accountLabel", "accountType", "accountPlan", "accountAttribution"]) {
    assert.ok(!Object.hasOwn(event, field), `${field} must not cross the wire`);
  }

  const turns = syncedUsageEventsToTurns(snapshot.events);
  const key = `codex\u0000sync:device-a:${event.threadKey}\u0000${event.eventId}`;
  assert.deepEqual(Object.keys(turns), [key]);
  assert.equal(turns[key].accountKey, "");
  assert.equal(turns[key].accountAttribution, "inferred");
});

test("usage sync snapshot keeps local turns without startedAt as accountless legacy facts", () => {
  const snapshot = usageSyncSnapshotFromLedger({
    "codex\u0000thread-1\u0000turn-1": {
      provider: "codex",
      threadId: "thread-1",
      turnId: "turn-1",
      completedAt: "2026-08-20T01:00:00.000Z",
      observedAt: "2026-08-20T01:00:01.000Z",
      estimatedCredits: 12,
      accountKey: "chatgpt:owner",
      accountAttribution: "exact",
      usage: { inputTokens: 10 },
    },
  }, {
    deviceId: "device-a",
    defaultRuntimeHomeIds: { codex: RUNTIME_HOME_ID },
  });

  assert.equal(snapshot.events.length, 1);
  const [event] = snapshot.events;
  assert.equal(event.schemaVersion, 1);
  assert.equal(event.runtimeHomeId, "");
  assert.equal(event.startedAt, "");
  assert.equal(event.completedAt, "2026-08-20T01:00:00.000Z");
  assert.equal(event.estimatedCredits, 12);
  assert.deepEqual(event.usage, {
    inputTokens: 10,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
  });
  for (const field of ["accountKey", "accountLabel", "accountType", "accountPlan", "accountAttribution"]) {
    assert.ok(!Object.hasOwn(event, field), `${field} must not cross the fallback legacy wire`);
  }
});

test("unknown higher versions and schema 2 record types are rejected", () => {
  assert.equal(normalizeUsageSyncEvent(turn({ schemaVersion: 3 })), null);
  assert.equal(normalizeUsageSyncEvent(turn({ type: "declared_epoch" })), null);
});

test("generic Codex credential classes do not become account keys", () => {
  assert.equal(codexUsageAccount({ account: { type: "apiKey" } }), null);
  assert.equal(codexUsageAccount({ account: { type: "amazonBedrock" } }), null);
});

test("auth fingerprints use only non-secret account fields", () => {
  const salt = "local-salt";
  const base = usageAuthFingerprint(salt, {
    accountKey: "chatgpt:owner",
    accountPlan: "pro",
    token: "secret-one",
  });
  const withOtherToken = usageAuthFingerprint(salt, {
    accountKey: "chatgpt:owner",
    accountPlan: "pro",
    token: "secret-two",
  });
  const otherPlan = usageAuthFingerprint(salt, {
    accountKey: "chatgpt:owner",
    accountPlan: "plus",
  });

  assert.equal(base, withOtherToken);
  assert.notEqual(base, otherPlan);
});

test("identity collisions require overlapping auth observations", () => {
  const firstInstallation = "11111111-2222-3333-8444-555555555555";
  const secondInstallation = "22222222-3333-4444-9555-666666666666";
  assert.notEqual(
    authObservationId({
      deviceId: "device-a",
      installationInstanceId: firstInstallation,
      provider: "codex",
      runtimeHomeId: RUNTIME_HOME_ID,
      accountKey: "chatgpt:owner",
      observedAt: "2026-08-20T01:00:00.000Z",
    }),
    authObservationId({
      deviceId: "device-a",
      installationInstanceId: secondInstallation,
      provider: "codex",
      runtimeHomeId: RUNTIME_HOME_ID,
      accountKey: "chatgpt:owner",
      observedAt: "2026-08-20T01:00:00.000Z",
    }),
  );
  assert.deepEqual(detectIdentityCollisions([{
    schemaVersion: 2,
    type: "auth_observation",
    deviceId: "device-a",
    installationInstanceId: firstInstallation,
    provider: "codex",
    runtimeHomeId: RUNTIME_HOME_ID,
    accountKey: "chatgpt:owner",
    observedAt: "2026-08-20T01:00:00.000Z",
  }, {
    schemaVersion: 2,
    type: "auth_observation",
    deviceId: "device-a",
    installationInstanceId: secondInstallation,
    provider: "codex",
    runtimeHomeId: RUNTIME_HOME_ID,
    accountKey: "chatgpt:owner",
    observedAt: "2026-08-20T01:05:00.000Z",
  }]), []);

  assert.deepEqual(detectIdentityCollisions([{
    schemaVersion: 2,
    type: "auth_observation",
    deviceId: "device-a",
    installationInstanceId: firstInstallation,
    provider: "codex",
    runtimeHomeId: RUNTIME_HOME_ID,
    accountKey: "chatgpt:owner",
    observedAt: "2026-08-20T01:00:00.000Z",
  }, {
    schemaVersion: 2,
    type: "auth_observation",
    deviceId: "device-a",
    installationInstanceId: secondInstallation,
    provider: "codex",
    runtimeHomeId: RUNTIME_HOME_ID,
    accountKey: "chatgpt:owner",
    observedAt: "2026-08-20T01:00:00.000Z",
  }]), [{
    deviceId: "device-a",
    installationInstanceIds: [firstInstallation, secondInstallation],
    reason: "identity-collision",
  }]);
});
