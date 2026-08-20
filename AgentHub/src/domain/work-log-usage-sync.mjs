import crypto from "node:crypto";

import { normalizeServiceTier, normalizeTokenUsage } from "./token-usage.mjs";

export const USAGE_SYNC_SNAPSHOT_VERSION = 1;

function nonEmpty(value) {
  return String(value ?? "").trim();
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

export function usageSyncEventIdentity(event) {
  const provider = normalizedProvider(event?.provider);
  const deviceId = nonEmpty(event?.deviceId);
  const threadId = nonEmpty(event?.threadId);
  const turnId = nonEmpty(event?.turnId);
  if (!deviceId || !threadId || !turnId) return "";
  return `usage:${sha256(JSON.stringify([deviceId, provider, threadId, turnId]))}`;
}

export function normalizeUsageSyncEvent(value = {}) {
  const provider = normalizedProvider(value.provider);
  const deviceId = nonEmpty(value.deviceId);
  const threadId = nonEmpty(value.threadId);
  const turnId = nonEmpty(value.turnId);
  const completedAt = nonEmpty(value.completedAt);
  if (!deviceId || !threadId || !turnId || !completedAt) return null;
  const accountKey = nonEmpty(value.accountKey);
  const estimatedCredits = positiveNumber(value.estimatedCredits ?? value.credits);
  const usage = normalizeTokenUsage(value.usage);
  const event = {
    version: USAGE_SYNC_SNAPSHOT_VERSION,
    eventId: nonEmpty(value.eventId),
    deviceId,
    source: nonEmpty(value.source) || "sync",
    provider,
    threadId,
    turnId,
    taskThreadId: nonEmpty(value.taskThreadId) || threadId,
    completedAt,
    startedAt: nonEmpty(value.startedAt),
    accountKey,
    accountAttribution: normalizeAttribution(value.accountAttribution, Boolean(accountKey)),
    estimatedCredits,
    usage,
    usageReported: value.usageReported === false ? false : true,
    model: nonEmpty(value.model).toLowerCase(),
    serviceTier: value.serviceTier == null ? "" : normalizeServiceTier(value.serviceTier),
    observedAt: nonEmpty(value.observedAt) || new Date().toISOString(),
  };
  event.eventId ||= usageSyncEventIdentity(event);
  if (!event.eventId) return null;
  return event;
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
    accountAttribution: record?.accountAttribution,
    estimatedCredits: record?.estimatedCredits,
    usage: record?.usage,
    usageReported: record?.usageReported,
    model: record?.model,
    serviceTier: record?.serviceTier,
  });
}

function eventRank(event) {
  return [
    event.accountAttribution === "exact" ? 1 : 0,
    event.accountKey ? 1 : 0,
    positiveNumber(event.estimatedCredits) > 0 ? 1 : 0,
    Date.parse(event.observedAt) || 0,
  ];
}

function strongerEvent(left, right) {
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
      byId.set(event.eventId, existing ? strongerEvent(existing, event) : event);
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
  exportedAt = new Date().toISOString(),
} = {}) {
  const events = Object.values(turns)
    .map((record) => usageSyncEventFromLedgerRecord(record, { deviceId }))
    .filter(Boolean);
  return {
    version: USAGE_SYNC_SNAPSHOT_VERSION,
    deviceId: nonEmpty(deviceId),
    exportedAt,
    events: mergeUsageSyncEvents(events),
  };
}

export function syncedUsageEventsToTurns(events = []) {
  const turns = {};
  for (const event of mergeUsageSyncEvents(events)) {
    const threadId = `sync:${event.deviceId}:${event.threadId}`;
    const key = `${event.provider}\0${threadId}\0${event.turnId}`;
    turns[key] = {
      provider: event.provider,
      threadId,
      taskThreadId: threadId,
      turnId: event.turnId,
      completedAt: event.completedAt,
      startedAt: event.startedAt,
      accountKey: event.accountKey,
      accountAttribution: event.accountAttribution,
      estimatedCredits: event.estimatedCredits,
      usage: event.usage,
      usageReported: event.usageReported,
      model: event.model,
      serviceTier: event.serviceTier,
      syncDeviceId: event.deviceId,
      syncSource: event.source,
      syncEventId: event.eventId,
    };
  }
  return turns;
}
