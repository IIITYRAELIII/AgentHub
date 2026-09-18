import { createHash } from "node:crypto";

import { normalizeServiceTier, normalizeTokenUsage } from "./token-usage.mjs";
import { isCredentialClassAccountKey } from "./usage-account-identity.mjs";

export const USAGE_FACT_SCHEMA_VERSION = 2;
export const LEGACY_USAGE_EVENT_SCHEMA_VERSION = 1;
export const USAGE_FACT_TYPES = Object.freeze({
  TURN: "turn",
  AUTH_OBSERVATION: "auth_observation",
  LIMIT_OBSERVATION: "limit_observation",
});

/**
 * Fields that identified a billing account on a usage event before USG-001. A
 * `turn` fact must never carry them: the account is derived from the owning
 * device's own observations, not asserted by the record.
 */
export const FORBIDDEN_TURN_ACCOUNT_FIELDS = Object.freeze([
  "accountKey",
  "accountLabel",
  "accountType",
  "accountPlan",
  "accountAttribution",
  "accountRecovery",
]);

const PSEUDONYM_PATTERN = /^[0-9a-f]{64}$/u;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function text(value) {
  return String(value ?? "").trim();
}

function boundedText(value, limit = 256) {
  return text(value)
    .replaceAll(/[\p{Cc}\p{Cf}]/gu, " ")
    .replaceAll(/\s+/gu, " ")
    .slice(0, limit);
}

function provider(value) {
  return text(value).toLowerCase() || "unknown";
}

function pseudonym(value) {
  const candidate = text(value).toLowerCase();
  return PSEUDONYM_PATTERN.test(candidate) ? candidate : "";
}

function sha256(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}

function sortedJsonValue(value) {
  if (Array.isArray(value)) return value.map(sortedJsonValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortedJsonValue(value[key])]),
  );
}

function canonicalJson(value) {
  return JSON.stringify(sortedJsonValue(value));
}

function timestamp(value) {
  const candidate = text(value);
  return Number.isFinite(Date.parse(candidate)) ? candidate : "";
}

function positiveNumber(value) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function usageTurnFactId({ provider: name, threadId, turnId } = {}) {
  const thread = text(threadId);
  const turn = text(turnId);
  if (!thread || !turn) return "";
  return `usage:${sha256(JSON.stringify([provider(name), thread, turn]))}`;
}

export function usageThreadKey({ provider: name, threadId } = {}) {
  const id = text(threadId);
  return id ? sha256(JSON.stringify([provider(name), id])) : "";
}

export function authObservationId({
  deviceId, installationInstanceId, provider: name, runtimeHomeId, accountKey, observedAt,
} = {}) {
  return `auth:${sha256(JSON.stringify([
    text(deviceId),
    text(installationInstanceId),
    provider(name),
    text(runtimeHomeId),
    text(accountKey),
    text(observedAt),
  ]))}`;
}

export function limitObservationId({
  deviceId, provider: name, accountKey, limitId, window, observedAt,
} = {}) {
  return `limit:${sha256(JSON.stringify([
    text(deviceId), provider(name), text(accountKey), text(limitId), text(window), text(observedAt),
  ]))}`;
}

/**
 * Series identity for every correlation rule. The lane is part of it: one
 * `limitId` carries several windows of different duration at once, so joining
 * on `limitId` alone would merge a five-hour and a weekly series and destroy the
 * limit delta.
 */
export function usageSeriesKey({ provider: name, accountKey, limitId, window } = {}) {
  return JSON.stringify([provider(name), text(accountKey), text(limitId), text(window)]);
}

export function normalizeUsageLimitSample(value = {}) {
  const observedAt = timestamp(value.observedAt);
  const limitId = text(value.limitId);
  const window = text(value.window);
  const usedPercent = finiteNumber(value.usedPercent);
  if (!observedAt || !limitId || !window || usedPercent === null) return null;
  return {
    observedAt,
    limitId,
    window,
    windowMinutes: finiteNumber(value.windowMinutes),
    usedPercent,
    resetsAt: timestamp(value.resetsAt),
    planType: boundedText(value.planType, 80),
  };
}

function compareUtf8Text(left, right) {
  return Buffer.compare(Buffer.from(String(left ?? ""), "utf8"), Buffer.from(String(right ?? ""), "utf8"));
}

function compareNullableNumber(left, right) {
  const leftMissing = left === null;
  const rightMissing = right === null;
  if (leftMissing || rightMissing) return leftMissing === rightMissing ? 0 : leftMissing ? -1 : 1;
  return left - right;
}

function limitSampleKey(sample) {
  return JSON.stringify([
    sample.observedAt,
    sample.limitId,
    sample.window,
    sample.windowMinutes,
    sample.usedPercent,
    sample.resetsAt,
    sample.planType,
  ]);
}

function compareUsageLimitSample(left, right) {
  return compareUtf8Text(left.observedAt, right.observedAt)
    || compareUtf8Text(left.limitId, right.limitId)
    || compareUtf8Text(left.window, right.window)
    || compareNullableNumber(left.windowMinutes, right.windowMinutes)
    || compareNullableNumber(left.usedPercent, right.usedPercent)
    || compareUtf8Text(left.resetsAt, right.resetsAt)
    || compareUtf8Text(left.planType, right.planType);
}

/**
 * Set union keyed by the normalized sample body, kept in canonical UTF-8 byte
 * order by observation, lane, limit and value fields.
 * The merge is order-independent and idempotent, so two installations holding
 * the same facts compute the same correlation input regardless of arrival order.
 *
 * Later evidence may add samples and move an interval from inadmissible to
 * admissible; that is convergence. Dropping or rewriting a sample is forbidden,
 * because it would make the result depend on import history.
 */
export function mergeUsageLimitSamples(...collections) {
  const byKey = new Map();
  for (const collection of collections) {
    for (const value of Array.isArray(collection) ? collection : []) {
      const sample = normalizeUsageLimitSample(value);
      if (!sample) continue;
      const key = limitSampleKey(sample);
      if (!byKey.has(key)) byKey.set(key, sample);
    }
  }
  return [...byKey.values()].sort(compareUsageLimitSample);
}

export function hasForbiddenTurnAccountFields(value) {
  return FORBIDDEN_TURN_ACCOUNT_FIELDS.some((field) => text(value?.[field]) !== "");
}

function turnFactBody(value, { eventId, threadKey }) {
  return {
    schemaVersion: USAGE_FACT_SCHEMA_VERSION,
    type: USAGE_FACT_TYPES.TURN,
    eventId,
    deviceId: text(value.deviceId),
    provider: provider(value.provider),
    runtimeHomeId: text(value.runtimeHomeId),
    threadKey,
    taskKey: pseudonym(value.taskKey)
      || usageThreadKey({ provider: value.provider, threadId: value.taskThreadId })
      || threadKey,
    startedAt: timestamp(value.startedAt),
    completedAt: timestamp(value.completedAt),
    usage: normalizeTokenUsage(value.usage),
    usageReported: value.usageReported === false ? false : true,
    model: text(value.model).toLowerCase(),
    serviceTier: value.serviceTier == null ? "" : normalizeServiceTier(value.serviceTier),
    estimatedCredits: positiveNumber(value.estimatedCredits ?? value.credits),
    estimateKind: text(value.estimateKind),
    imageGenerationCount: Math.max(0, Math.floor(Number(value.imageGenerationCount) || 0)),
    limitSamples: mergeUsageLimitSamples(value.limitSamples),
    deviceLabel: boundedText(value.deviceLabel, 80),
    observedAt: timestamp(value.observedAt) || timestamp(value.completedAt),
  };
}

/**
 * Strict normalization for a record that crosses the wire. Producing account
 * fields on a turn is a contract violation and is rejected outright rather than
 * silently stripped, so a regression surfaces at its source instead of becoming
 * a quiet behaviour change.
 */
export function normalizeUsageTurnFact(value = {}) {
  if (hasForbiddenTurnAccountFields(value)) return null;
  const eventId = text(value.eventId) || usageTurnFactId(value);
  const threadKey = pseudonym(value.threadKey)
    || usageThreadKey({ provider: value.provider, threadId: value.threadId });
  if (!eventId || !threadKey) return null;
  const fact = turnFactBody(value, { eventId, threadKey });
  if (!fact.deviceId || !fact.runtimeHomeId || !fact.startedAt || !fact.completedAt) return null;
  return fact;
}

export function isPublishableUsageTurnFact(value) {
  return Boolean(normalizeUsageTurnFact(value));
}

/**
 * Read compatibility for schema 1 usage events.
 *
 * Account fields are dropped, including `exact` ones: they were resolved from
 * ambient state at the moment the record was written, which is often long after
 * the turn ran, so they carry no evidence about it. They are not retained as
 * hints either — a retained guess is eventually promoted, which is the exact
 * mechanism this contract removes.
 *
 * `runtimeHomeId` is supplied only by a local refill on the owning device, which
 * reads the home from the rollout file's own path. No remote party can perform
 * that step, so a legacy event from another device stays unattributable rather
 * than falling back to `deviceId + provider`.
 */
export function usageTurnFactFromLegacyEvent(value = {}, { runtimeHomeId = "" } = {}) {
  const eventId = text(value.eventId) || usageTurnFactId(value);
  const threadKey = pseudonym(value.threadKey)
    || usageThreadKey({ provider: value.provider, threadId: value.threadId });
  if (!eventId || !threadKey) return { fact: null, attributable: false, reason: "invalid-event" };

  const fact = {
    ...turnFactBody({ ...value, runtimeHomeId }, { eventId, threadKey }),
    schemaVersion: LEGACY_USAGE_EVENT_SCHEMA_VERSION,
    legacy: true,
  };
  if (!fact.deviceId || !fact.completedAt) {
    return { fact: null, attributable: false, reason: "invalid-event" };
  }
  if (!fact.runtimeHomeId) return { fact, attributable: false, reason: "home-not-tracked" };
  if (!fact.startedAt) return { fact, attributable: false, reason: "missing-started-at" };
  return { fact, attributable: true, reason: "" };
}

export function normalizeUsageFact(value = {}, options = {}) {
  const schemaVersion = Number(value?.schemaVersion ?? value?.version ?? LEGACY_USAGE_EVENT_SCHEMA_VERSION);
  if (!Number.isInteger(schemaVersion) || schemaVersion < LEGACY_USAGE_EVENT_SCHEMA_VERSION) {
    return null;
  }
  if (schemaVersion === LEGACY_USAGE_EVENT_SCHEMA_VERSION) {
    return usageTurnFactFromLegacyEvent(value, options).fact;
  }
  if (schemaVersion !== USAGE_FACT_SCHEMA_VERSION) return null;
  const type = text(value?.type);
  if (type === USAGE_FACT_TYPES.TURN) return normalizeUsageTurnFact(value);
  if (type === USAGE_FACT_TYPES.AUTH_OBSERVATION) return normalizeAuthObservation(value);
  if (type === USAGE_FACT_TYPES.LIMIT_OBSERVATION) return normalizeLimitObservation(value);
  return null;
}

export function usageFactIdentity(value = {}) {
  const fact = normalizeUsageFact(value);
  if (!fact) return "";
  if (fact.type === USAGE_FACT_TYPES.AUTH_OBSERVATION) return fact.observationId;
  if (fact.type === USAGE_FACT_TYPES.LIMIT_OBSERVATION) return fact.observationId;
  return fact.eventId;
}

function summaryFactPayload(fact) {
  const {
    deviceLabel,
    legacy,
    source,
    version,
    ...payload
  } = fact ?? {};
  return sortedJsonValue(payload);
}

export function usageFactSummary(facts = []) {
  const byType = {
    turn: 0,
    auth_observation: 0,
    limit_observation: 0,
  };
  const lines = [];
  for (const value of Array.isArray(facts) ? facts : []) {
    const fact = normalizeUsageFact(value);
    if (!fact) continue;
    const type = fact.type || USAGE_FACT_TYPES.TURN;
    const identity = usageFactIdentity(fact);
    if (!identity) continue;
    byType[type] = (byType[type] ?? 0) + 1;
    lines.push(canonicalJson([type, identity, summaryFactPayload(fact)]));
  }
  lines.sort((left, right) => Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")));
  return {
    version: 1,
    count: lines.length,
    byType,
    digest: `sha256:${sha256(lines.join("\n"))}`,
  };
}

export function normalizeAuthObservation(value = {}) {
  const deviceId = text(value.deviceId);
  const runtimeHomeId = text(value.runtimeHomeId);
  const accountKey = text(value.accountKey);
  const observedAt = timestamp(value.observedAt);
  const installationInstanceId = text(value.installationInstanceId);
  if (
    !deviceId
    || !runtimeHomeId
    || !accountKey
    || !observedAt
    || !UUID_PATTERN.test(installationInstanceId)
  ) {
    return null;
  }
  // A credential class is not an account: two unrelated keys would collapse into
  // one billing identity.
  if (isCredentialClassAccountKey(accountKey)) return null;
  const name = provider(value.provider);
  return {
    schemaVersion: USAGE_FACT_SCHEMA_VERSION,
    type: USAGE_FACT_TYPES.AUTH_OBSERVATION,
    observationId: authObservationId({
      deviceId, installationInstanceId, provider: name, runtimeHomeId, accountKey, observedAt,
    }),
    deviceId,
    installationInstanceId,
    provider: name,
    runtimeHomeId,
    accountKey,
    accountLabel: boundedText(value.accountLabel),
    accountType: boundedText(value.accountType, 80),
    accountPlan: boundedText(value.accountPlan, 80),
    observedAt,
    evidenceSource: text(value.evidenceSource),
    authFingerprint: text(value.authFingerprint),
  };
}

export function normalizeLimitObservation(value = {}) {
  const deviceId = text(value.deviceId);
  const accountKey = text(value.accountKey);
  const limitId = text(value.limitId);
  const window = text(value.window);
  const observedAt = timestamp(value.observedAt);
  const usedPercent = finiteNumber(value.usedPercent);
  if (!deviceId || !accountKey || !limitId || !window || !observedAt || usedPercent === null) {
    return null;
  }
  if (isCredentialClassAccountKey(accountKey)) return null;
  const name = provider(value.provider);
  return {
    schemaVersion: USAGE_FACT_SCHEMA_VERSION,
    type: USAGE_FACT_TYPES.LIMIT_OBSERVATION,
    observationId: limitObservationId({
      deviceId, provider: name, accountKey, limitId, window, observedAt,
    }),
    deviceId,
    provider: name,
    accountKey,
    limitId,
    window,
    windowMinutes: finiteNumber(value.windowMinutes),
    usedPercent,
    resetsAt: timestamp(value.resetsAt),
    observedAt,
    reachedType: boundedText(value.reachedType, 80),
  };
}

/**
 * Two distinct installations publishing under one device id with overlapping
 * observation times means a copied profile. Attribution for that device is
 * suspended; candidate sets are never merged to resolve it.
 */
export function detectIdentityCollisions(observations = []) {
  const byDevice = new Map();
  for (const value of Array.isArray(observations) ? observations : []) {
    const observation = normalizeAuthObservation(value);
    if (!observation) continue;
    if (!byDevice.has(observation.deviceId)) byDevice.set(observation.deviceId, []);
    byDevice.get(observation.deviceId).push(observation);
  }
  return [...byDevice.entries()]
    .map(([deviceId, deviceObservations]) => {
      const byInstant = new Map();
      for (const observation of deviceObservations) {
        if (!byInstant.has(observation.observedAt)) byInstant.set(observation.observedAt, new Set());
        byInstant.get(observation.observedAt).add(observation.installationInstanceId);
      }
      const instances = new Set();
      for (const ids of byInstant.values()) {
        if (ids.size <= 1) continue;
        for (const id of ids) instances.add(id);
      }
      return instances.size > 1
        ? { deviceId, installationInstanceIds: [...instances].sort(), reason: "identity-collision" }
        : null;
    })
    .filter(Boolean);
}
