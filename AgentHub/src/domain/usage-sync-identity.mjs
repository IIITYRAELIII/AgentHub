import { createHash } from "node:crypto";

export const USAGE_SYNC_IDENTITY_VERSION = 1;

const DEVICE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const LEGACY_DEVICE_ID_PATTERN = /^agent-hub:[0-9a-f]{16}$/u;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/u;
const MAX_LABEL_LENGTH = 80;

function text(value) {
  return String(value ?? "").trim();
}

/**
 * Device id used before persistent identities existed. It is derived from the
 * host name and the data directory, so it changes whenever the machine is
 * renamed or the data directory moves. Kept only to adopt already recorded
 * local events into the persistent identity.
 */
export function legacyUsageSyncDeviceId({ hostname, dataDir } = {}) {
  const source = `${text(hostname).toLowerCase()}\0${text(dataDir).toLowerCase()}`;
  return `agent-hub:${createHash("sha256").update(source, "utf8").digest("hex").slice(0, 16)}`;
}

export function isUsageSyncDeviceId(value) {
  return DEVICE_ID_PATTERN.test(text(value));
}

export function isLegacyUsageSyncDeviceId(value) {
  return LEGACY_DEVICE_ID_PATTERN.test(text(value));
}

/**
 * Human readable device signature shown in the usage panel. Control characters
 * are removed so a label can never break a rendered row or a log line.
 */
export function normalizeDeviceLabel(value) {
  return text(value)
    .replaceAll(/[\p{Cc}\p{Cf}]/gu, " ")
    .replaceAll(/\s+/gu, " ")
    .trim()
    .slice(0, MAX_LABEL_LENGTH);
}

function normalizeKeyMaterial(value) {
  const key = text(value);
  return key && key.length <= 4096 && BASE64URL_PATTERN.test(key) ? key : "";
}

function normalizeLegacyDeviceIds(value) {
  if (!Array.isArray(value)) return [];
  const unique = new Set();
  for (const item of value) {
    const candidate = text(item);
    if (candidate && candidate.length <= 128) unique.add(candidate);
  }
  return [...unique].sort();
}

function normalizeTimestamp(value, fallback) {
  const candidate = text(value);
  return Number.isFinite(Date.parse(candidate)) ? candidate : fallback;
}

/**
 * Returns a valid identity or null. A null result means the stored file cannot
 * be trusted as an identity and a new one has to be issued; it never means the
 * caller may silently fall back to a derived device id.
 */
export function normalizeUsageSyncIdentity(value, { now = () => new Date() } = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const deviceId = text(value.deviceId).toLowerCase();
  const publicKey = normalizeKeyMaterial(value.publicKey);
  const privateKey = normalizeKeyMaterial(value.privateKey);
  if (!isUsageSyncDeviceId(deviceId) || !publicKey || !privateKey) return null;
  const createdAt = normalizeTimestamp(value.createdAt, now().toISOString());
  return {
    version: USAGE_SYNC_IDENTITY_VERSION,
    deviceId,
    label: normalizeDeviceLabel(value.label),
    platform: text(value.platform).slice(0, 40),
    publicKey,
    privateKey,
    createdAt,
    updatedAt: normalizeTimestamp(value.updatedAt, createdAt),
    labelConfirmedAt: normalizeTimestamp(value.labelConfirmedAt, ""),
    legacyDeviceIds: normalizeLegacyDeviceIds(value.legacyDeviceIds),
  };
}

/** Identity fields that may be shown or sent outside the device. */
export function publicUsageSyncIdentity(identity) {
  if (!identity) return null;
  return {
    deviceId: identity.deviceId,
    label: identity.label,
    platform: identity.platform,
    publicKey: identity.publicKey,
    createdAt: identity.createdAt,
  };
}
