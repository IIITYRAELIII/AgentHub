export {
  buildLazyJournalPayload,
  extractRateLimitsHtml,
  extractWorkLogHtml,
} from "../../application/journal-projection-data.mjs";

function cleanText(value, limit = 1024) {
  return String(value ?? "").trim().slice(0, limit);
}

export function publicUsageSyncStatus(value = null) {
  if (!value || typeof value !== "object") return { configured: false };
  const lastResult = value.lastResult && typeof value.lastResult === "object"
    ? {
        added: Number(value.lastResult.added) || 0,
        updated: Number(value.lastResult.updated) || 0,
        rejected: Number(value.lastResult.rejected) || 0,
        projected: value.lastResult.projected === true,
        imported: value.lastResult.imported === true,
        before: Number(value.lastResult.before) || 0,
        after: Number(value.lastResult.after) || 0,
      }
    : null;
  const serverUrl = cleanText(value.serverUrl);
  const enrolled = Boolean(serverUrl && cleanText(value.deviceId, 80) && cleanText(value.enrolledAt, 80));
  return {
    configured: enrolled,
    serverUrl,
    deviceId: cleanText(value.deviceId, 80),
    enrolledAt: cleanText(value.enrolledAt, 80),
    lastPushAt: cleanText(value.lastPushAt, 80),
    lastPullAt: cleanText(value.lastPullAt, 80),
    lastResult,
  };
}

export function journalPayloadEtag(payload, usageSync = null) {
  const status = publicUsageSyncStatus(usageSync);
  if (!status.configured) return String(payload?.version ?? "");
  return `${String(payload?.version ?? "")}:${status.lastPushAt || "-"}:${status.lastPullAt || "-"}`;
}

export function publicJournalPayload(payload, { usageSync = null } = {}) {
  return {
    html: String(payload?.html ?? ""),
    updatedAt: String(payload?.updatedAt ?? ""),
    version: String(payload?.version ?? ""),
    usageSync: publicUsageSyncStatus(usageSync),
  };
}
