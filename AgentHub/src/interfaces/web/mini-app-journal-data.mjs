export {
  buildLazyJournalPayload,
  extractRateLimitsHtml,
  extractWorkLogHtml,
} from "../../application/journal-projection-data.mjs";

export function publicJournalPayload(payload) {
  return {
    html: String(payload?.html ?? ""),
    updatedAt: String(payload?.updatedAt ?? ""),
    version: String(payload?.version ?? ""),
  };
}
