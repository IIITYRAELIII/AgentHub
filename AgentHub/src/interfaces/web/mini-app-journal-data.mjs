export {
  buildLazyJournalPayload,
  extractRateLimitsHtml,
  extractWorkLogHtml,
} from "../../application/journal-projection-data.mjs";
import { resourceVirtualJournalSummary } from "../../domain/journal-virtual-projection.mjs";

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
    deviceLabel: cleanText(value.deviceLabel, 80),
    suggestedDeviceLabel: cleanText(value.suggestedDeviceLabel, 80),
    deviceLabelConfirmed: value.deviceLabelConfirmed === true,
    deviceLabelConfirmedAt: cleanText(value.deviceLabelConfirmedAt, 80),
    deviceLabelPromptRequired: value.deviceLabelPromptRequired === true,
    enrolledAt: cleanText(value.enrolledAt, 80),
    lastPushAt: cleanText(value.lastPushAt, 80),
    lastPullAt: cleanText(value.lastPullAt, 80),
    lastResult,
  };
}

export function journalPayloadEtag(payload, usageSync = null) {
  const status = publicUsageSyncStatus(usageSync);
  const hasLabelState = Boolean(
    status.deviceLabel
    || status.suggestedDeviceLabel
    || status.deviceLabelConfirmedAt
    || status.deviceLabelPromptRequired,
  );
  const labelState = hasLabelState
    ? [
        status.deviceLabel || "-",
        status.suggestedDeviceLabel || "-",
        status.deviceLabelConfirmedAt || "-",
        status.deviceLabelPromptRequired ? "prompt" : "ok",
      ].join(":")
    : "";
  if (!status.configured) {
    return hasLabelState ? `${String(payload?.version ?? "")}:${labelState}` : String(payload?.version ?? "");
  }
  return [
    String(payload?.version ?? ""),
    status.lastPushAt || "-",
    status.lastPullAt || "-",
    labelState,
  ].filter(Boolean).join(":");
}

export function publicJournalPayload(payload, { usageSync = null } = {}) {
  return {
    html: String(payload?.html ?? ""),
    summary: resourceVirtualJournalSummary(payload?.summary),
    updatedAt: String(payload?.updatedAt ?? ""),
    version: String(payload?.version ?? ""),
    usageSync: publicUsageSyncStatus(usageSync),
  };
}
