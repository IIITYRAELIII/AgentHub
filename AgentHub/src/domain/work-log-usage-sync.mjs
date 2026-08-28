import crypto from "node:crypto";

import { normalizeServiceTier, normalizeTokenUsage } from "./token-usage.mjs";

export const USAGE_SYNC_SNAPSHOT_VERSION = 1;

function nonEmpty(value) {
  return String(value ?? "").trim();
}

function boundedText(value, limit = 256) {
  return nonEmpty(value).replaceAll(/[\p{Cc}\p{Cf}]/gu, " ").replaceAll(/\s+/gu, " ").slice(0, limit);
}

function normalizedProvider(value) {
  const provider = nonEmpty(value).toLowerCase();
  return provider || "unknown";
}

function positiveNumber(value) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function normalizeAttribution(value, hasAccountKey) {
  const candidate = nonEmpty(value).toLowerCase();
  if (candidate === "exact" || candidate === "inferred") return candidate;
  return hasAccountKey ? "exact" : "inferred";
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value), "utf8").digest("hex");
}

const PSEUDONYM_PATTERN = /^[0-9a-f]{64}$/u;

/**
 * Turn identity used for deduplication. Provider thread and turn ids are
 * globally unique on their own, so the device is deliberately not part of the
 * identity: the same turn recovered from a restored journal on another
 * installation must collapse into one event instead of being counted twice.
 */
export function usageSyncEventIdentity(event) {
  const provider = normalizedProvider(event?.provider);
  const threadId = nonEmpty(event?.threadId);
  const turnId = nonEmpty(event?.turnId);
  if (!threadId || !turnId) return "";
  return `usage:${sha256(JSON.stringify([provider, threadId, turnId]))}`;
}

/**
 * Stable pseudonym for a provider thread. Raw thread ids never leave the
 * device: they are correlatable identifiers that carry no accounting value,
 * because grouping only needs the pseudonym to be stable.
 */
export function usageSyncThreadKey({ provider, threadId } = {}) {
  const id = nonEmpty(threadId);
  return id ? sha256(JSON.stringify([normalizedProvider(provider), id])) : "";
}

function pseudonym(value) {
  const candidate = nonEmpty(value).toLowerCase();
  return PSEUDONYM_PATTERN.test(candidate) ? candidate : "";
}

export function normalizeUsageSyncEvent(value = {}) {
  const provider = normalizedProvider(value.provider);
  const deviceId = nonEmpty(value.deviceId);
  const completedAt = nonEmpty(value.completedAt);
  // Events recorded before pseudonymization still carry raw ids; they are
  // converted here and the raw values are dropped from the sync model.
  const eventId = nonEmpty(value.eventId) || usageSyncEventIdentity(value);
  const threadKey = pseudonym(value.threadKey)
    || usageSyncThreadKey({ provider, threadId: value.threadId });
  const taskKey = pseudonym(value.taskKey)
    || usageSyncThreadKey({ provider, threadId: value.taskThreadId })
    || threadKey;
  if (!deviceId || !completedAt || !eventId || !threadKey) return null;
  const accountKey = nonEmpty(value.accountKey);
  const estimatedCredits = positiveNumber(value.estimatedCredits ?? value.credits);
  const estimateKind = nonEmpty(value.estimateKind);
  const imageGenerationCount = Math.max(0, Math.floor(Number(value.imageGenerationCount) || 0));
  const usage = normalizeTokenUsage(value.usage);
  return {
    version: USAGE_SYNC_SNAPSHOT_VERSION,
    eventId,
    deviceId,
    source: nonEmpty(value.source) || "sync",
    provider,
    threadKey,
    taskKey,
    completedAt,
    startedAt: nonEmpty(value.startedAt),
    accountKey,
    accountLabel: boundedText(value.accountLabel),
    accountType: boundedText(value.accountType, 80),
    accountPlan: boundedText(value.accountPlan ?? value.accountPlanType ?? value.planType, 80),
    accountAttribution: normalizeAttribution(value.accountAttribution, Boolean(accountKey)),
    estimatedCredits,
    estimateKind,
    imageGenerationCount,
    contextProbe: value.contextProbe === true,
    usage,
    usageReported: value.usageReported === false ? false : true,
    model: nonEmpty(value.model).toLowerCase(),
    serviceTier: value.serviceTier == null ? "" : normalizeServiceTier(value.serviceTier),
    deviceLabel: boundedText(value.deviceLabel, 80),
    observedAt: nonEmpty(value.observedAt) || new Date().toISOString(),
  };
}

export function usageSyncEventFromLedgerRecord(record, { deviceId, source = "local" } = {}) {
  return normalizeUsageSyncEvent({
    deviceId,
    source,
    provider: record?.provider,
    threadId: record?.threadId,
    turnId: record?.turnId,
    taskThreadId: record?.taskThreadId,
    completedAt: record?.completedAt,
    startedAt: record?.startedAt,
    accountKey: record?.accountKey,
    accountLabel: record?.accountLabel,
    accountType: record?.accountType,
    accountPlan: record?.accountPlan,
    accountAttribution: record?.accountAttribution,
    estimatedCredits: record?.estimatedCredits,
    estimateKind: record?.estimateKind,
    imageGenerationCount: record?.imageGenerationCount,
    contextProbe: record?.contextProbe,
    usage: record?.usage,
    usageReported: record?.usageReported,
    model: record?.model,
    serviceTier: record?.serviceTier,
    deviceLabel: record?.deviceLabel,
    observedAt: record?.observedAt || record?.completedAt,
  });
}

function eventRank(event) {
  return [
    event.accountAttribution === "exact" ? 1 : 0,
    event.accountKey ? 1 : 0,
    positiveNumber(event.estimatedCredits) > 0 ? 1 : 0,
    event.estimateKind || event.imageGenerationCount > 0 || event.contextProbe ? 1 : 0,
    Date.parse(event.observedAt) || 0,
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
  for (let index = 0; index < leftRank.length; index += 1) {
    if (leftRank[index] !== rightRank[index]) {
      return leftRank[index] > rightRank[index] ? left : right;
    }
  }
  return left.eventId <= right.eventId ? left : right;
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
} = {}) {
  const afterObservedMs = Date.parse(afterObservedAt) || 0;
  const events = Object.values(turns)
    .map((record) => usageSyncEventFromLedgerRecord(record, { deviceId }))
    .map((event) => event ? { ...event, deviceLabel: boundedText(deviceLabel, 80) || event.deviceLabel } : null)
    .filter((event) => !event || !afterObservedMs || (Date.parse(event.observedAt) || 0) > afterObservedMs)
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
      accountKey: event.accountKey,
      accountLabel: event.accountLabel,
      accountType: event.accountType,
      accountPlan: event.accountPlan,
      accountAttribution: event.accountAttribution,
      estimatedCredits: event.estimatedCredits,
      estimateKind: event.estimateKind,
      imageGenerationCount: event.imageGenerationCount,
      contextProbe: event.contextProbe,
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
