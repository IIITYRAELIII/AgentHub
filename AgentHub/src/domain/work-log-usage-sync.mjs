import {
  LEGACY_USAGE_EVENT_SCHEMA_VERSION,
  mergeUsageLimitSamples,
  normalizeUsageTurnFact,
  usageThreadKey,
  usageTurnFactFromLegacyEvent,
  usageTurnFactId,
  USAGE_FACT_SCHEMA_VERSION,
  USAGE_FACT_TYPES,
} from "./usage-facts.mjs";

export const USAGE_SYNC_SNAPSHOT_VERSION = 1;

function nonEmpty(value) {
  return String(value ?? "").trim();
}

function boundedText(value, limit = 256) {
  return nonEmpty(value).replaceAll(/[\p{Cc}\p{Cf}]/gu, " ").replaceAll(/\s+/gu, " ").slice(0, limit);
}

function positiveNumber(value) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

/**
 * Turn identity used for deduplication. Provider thread and turn ids are
 * globally unique on their own, so the device is deliberately not part of the
 * identity: the same turn recovered from a restored journal on another
 * installation must collapse into one event instead of being counted twice.
 */
export function usageSyncEventIdentity(event) {
  return usageTurnFactId(event);
}

/**
 * Stable pseudonym for a provider thread. Raw thread ids never leave the
 * device: they are correlatable identifiers that carry no accounting value,
 * because grouping only needs the pseudonym to be stable.
 */
export function usageSyncThreadKey({ provider, threadId } = {}) {
  return usageThreadKey({ provider, threadId });
}

export function normalizeUsageSyncEvent(value = {}, options = {}) {
  const schemaVersion = Number(value?.schemaVersion ?? value?.version ?? LEGACY_USAGE_EVENT_SCHEMA_VERSION);
  let event = null;
  if (schemaVersion === USAGE_FACT_SCHEMA_VERSION) {
    if (nonEmpty(value?.type) !== USAGE_FACT_TYPES.TURN) return null;
    event = normalizeUsageTurnFact(value);
  } else if (schemaVersion === LEGACY_USAGE_EVENT_SCHEMA_VERSION) {
    event = usageTurnFactFromLegacyEvent(value, options).fact;
  } else {
    return null;
  }
  if (!event) return null;
  return {
    ...event,
    version: USAGE_SYNC_SNAPSHOT_VERSION,
    source: nonEmpty(value.source) || "sync",
  };
}

function runtimeHomeIdForRecord(record, { runtimeHomeId = "", defaultRuntimeHomeIds = {} } = {}) {
  const provider = nonEmpty(record?.provider).toLowerCase();
  return nonEmpty(record?.runtimeHomeId)
    || nonEmpty(defaultRuntimeHomeIds?.[provider])
    || nonEmpty(runtimeHomeId);
}

export function usageSyncEventFromLedgerRecord(record, {
  deviceId,
  source = "local",
  runtimeHomeId = "",
  defaultRuntimeHomeIds = {},
} = {}) {
  if (!nonEmpty(record?.startedAt)) {
    return normalizeUsageSyncEvent({
      schemaVersion: LEGACY_USAGE_EVENT_SCHEMA_VERSION,
      deviceId,
      source,
      provider: record?.provider,
      threadId: record?.threadId,
      turnId: record?.turnId,
      taskThreadId: record?.taskThreadId,
      completedAt: record?.completedAt,
      estimatedCredits: record?.estimatedCredits,
      estimateKind: record?.estimateKind,
      imageGenerationCount: record?.imageGenerationCount,
      limitSamples: record?.limitSamples,
      usage: record?.usage,
      usageReported: record?.usageReported,
      model: record?.model,
      serviceTier: record?.serviceTier,
      serviceUsageKind: record?.serviceUsageKind,
      deviceLabel: record?.deviceLabel,
      observedAt: record?.observedAt || record?.completedAt,
    });
  }
  return normalizeUsageSyncEvent({
    schemaVersion: USAGE_FACT_SCHEMA_VERSION,
    type: "turn",
    deviceId,
    source,
    runtimeHomeId: runtimeHomeIdForRecord(record, { runtimeHomeId, defaultRuntimeHomeIds }),
    provider: record?.provider,
    threadId: record?.threadId,
    turnId: record?.turnId,
    taskThreadId: record?.taskThreadId,
    completedAt: record?.completedAt,
    startedAt: record?.startedAt,
    estimatedCredits: record?.estimatedCredits,
    estimateKind: record?.estimateKind,
    imageGenerationCount: record?.imageGenerationCount,
    limitSamples: record?.limitSamples,
    usage: record?.usage,
    usageReported: record?.usageReported,
    model: record?.model,
    serviceTier: record?.serviceTier,
    serviceUsageKind: record?.serviceUsageKind,
    deviceLabel: record?.deviceLabel,
    observedAt: record?.observedAt || record?.completedAt,
  });
}

function eventRank(event) {
  return [
    event.schemaVersion === USAGE_FACT_SCHEMA_VERSION ? 1 : 0,
    event.runtimeHomeId ? 1 : 0,
    event.startedAt ? 1 : 0,
    Array.isArray(event.limitSamples) ? event.limitSamples.length : 0,
    event.usageReported ? 1 : 0,
    event.usage?.totalTokens || 0,
    event.serviceUsageKind ? 1 : 0,
    positiveNumber(event.estimatedCredits) > 0 ? 1 : 0,
    event.estimateKind || event.imageGenerationCount > 0 ? 1 : 0,
  ];
}

/**
 * Resolves two records of the same turn. Exact account attribution wins over
 * inferred, then a known account, then reported credits, then the later
 * observation; the event id breaks the remaining ties so the choice is
 * deterministic regardless of arrival order.
 */
export function strongerUsageSyncEvent(left, right) {
  const leftRank = eventRank(left);
  const rightRank = eventRank(right);
  let winner = left;
  let loser = right;
  for (let index = 0; index < leftRank.length; index += 1) {
    if (leftRank[index] !== rightRank[index]) {
      winner = leftRank[index] > rightRank[index] ? left : right;
      loser = winner === left ? right : left;
      break;
    }
  }
  if (winner === left && loser === right && leftRank.every((value, index) => value === rightRank[index])) {
    winner = left.eventId <= right.eventId ? left : right;
    loser = winner === left ? right : left;
  }
  const observedAt = [winner.observedAt, loser.observedAt]
    .filter(Boolean)
    .sort((a, b) => (Date.parse(a) || 0) - (Date.parse(b) || 0))[0] || winner.observedAt;
  return {
    ...winner,
    serviceUsageKind: winner.serviceUsageKind || loser.serviceUsageKind,
    observedAt,
    limitSamples: mergeUsageLimitSamples(loser.limitSamples, winner.limitSamples),
  };
}

export function mergeUsageSyncEvents(...collections) {
  const byId = new Map();
  for (const collection of collections) {
    const events = Array.isArray(collection)
      ? collection
      : Array.isArray(collection?.events) ? collection.events : [];
    for (const value of events) {
      const event = normalizeUsageSyncEvent(value);
      if (!event) continue;
      const existing = byId.get(event.eventId);
      byId.set(event.eventId, existing ? strongerUsageSyncEvent(existing, event) : event);
    }
  }
  return [...byId.values()].sort((left, right) => (
    Date.parse(left.completedAt) - Date.parse(right.completedAt)
    || left.deviceId.localeCompare(right.deviceId)
    || left.eventId.localeCompare(right.eventId)
  ));
}

export function usageSyncSnapshotFromLedger(turns = {}, {
  deviceId,
  deviceLabel = "",
  exportedAt = new Date().toISOString(),
  afterObservedAt = "",
  runtimeHomeId = "",
  defaultRuntimeHomeIds = {},
} = {}) {
  const afterObservedMs = Date.parse(afterObservedAt) || 0;
  const events = Object.values(turns)
    .map((record) => usageSyncEventFromLedgerRecord(record, {
      deviceId,
      runtimeHomeId,
      defaultRuntimeHomeIds,
    }))
    .map((event) => event
      ? { ...event, deviceLabel: boundedText(deviceLabel, 80) || event.deviceLabel }
      : null)
    .filter((event) => !event || !afterObservedMs || (Date.parse(event.observedAt) || 0) >= afterObservedMs)
    .filter(Boolean);
  return {
    version: USAGE_SYNC_SNAPSHOT_VERSION,
    deviceId: nonEmpty(deviceId),
    deviceLabel: boundedText(deviceLabel, 80),
    exportedAt,
    events: mergeUsageSyncEvents(events),
  };
}

export function syncedUsageEventsToTurns(events = []) {
  const turns = {};
  for (const event of mergeUsageSyncEvents(events)) {
    const threadId = `sync:${event.deviceId}:${event.threadKey}`;
    const key = `${event.provider}\0${threadId}\0${event.eventId}`;
    turns[key] = {
      provider: event.provider,
      threadId,
      taskThreadId: `sync:${event.deviceId}:${event.taskKey}`,
      turnId: event.eventId,
      completedAt: event.completedAt,
      startedAt: event.startedAt,
      accountKey: "",
      accountLabel: "",
      accountType: "",
      accountPlan: "",
      accountAttribution: "inferred",
      estimatedCredits: event.estimatedCredits,
      estimateKind: event.estimateKind,
      imageGenerationCount: event.imageGenerationCount,
      runtimeHomeId: event.runtimeHomeId,
      limitSamples: event.limitSamples,
      usage: event.usage,
      usageReported: event.usageReported,
      model: event.model,
      serviceTier: event.serviceTier,
      syncDeviceLabel: event.deviceLabel,
      syncDeviceId: event.deviceId,
      syncSource: event.source,
      syncEventId: event.eventId,
    };
  }
  return turns;
}
