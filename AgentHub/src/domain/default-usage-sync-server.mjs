// Public installations have no project-specific endpoint. Existing installed
// clients retain their effective address through the installer migration.
export const DEFAULT_USAGE_SYNC_SERVER_URL = "";

export function normalizeUsageSyncServerUrl(value) {
  if (typeof value !== "string") throw new TypeError("Usage sync server must be a URL string");
  const candidate = value.trim();
  if (!candidate) return "";
  if (candidate.length > 2048 || /[\\\r\n\0]/u.test(candidate)) throw new Error("Invalid usage sync server URL");
  let url;
  try { url = new URL(candidate); } catch { throw new Error("Invalid usage sync server URL"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("Usage sync server must use HTTP(S) without credentials, query or fragment");
  }
  const normalized = url.toString().replace(/\/$/u, "");
  if (normalized.length > 2048) throw new Error("Invalid usage sync server URL");
  return normalized;
}

export function defaultUsageSyncServerUrl(environment = process.env) {
  return normalizeUsageSyncServerUrl(environment?.AGENT_HUB_USAGE_SYNC_SERVER_URL ?? DEFAULT_USAGE_SYNC_SERVER_URL);
}
