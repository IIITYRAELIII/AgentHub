import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";

export const TRANSFER_BLOCK_BYTES = 64 * 1024;
export const TRANSFER_TOKEN = /^[A-Za-z0-9_-]{43}$/u;
export const TRANSFER_SESSION_SELECTOR = /^[A-Za-z0-9_-]{43}$/u;
export const TRANSFER_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
export const TRANSFER_TTLS = [3_600_000, 86_400_000, 259_200_000, 604_800_000];
export const transferHash = (value) => createHash("sha256").update(value).digest("hex");
export function transferError(code, statusCode = 410) {
  return Object.assign(new Error(code), { code, statusCode, diagnosticExpected: true });
}

export function fileTransferPolicy(raw = {}) {
  const enabled = raw.enabled === true;
  let publicBaseUrl = "";
  if (enabled) {
    let url;
    try { url = new URL(raw.publicBaseUrl); } catch { throw transferError("transfer-https-origin-required", 503); }
    if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/"
      || url.search || url.hash || ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
      throw transferError("transfer-https-origin-required", 503);
    }
    publicBaseUrl = url.origin;
  }
  const integer = (key, fallback, min, max) => {
    const value = raw[key] ?? fallback;
    if (!Number.isSafeInteger(value) || value < min || value > max) throw transferError(`transfer-invalid-${key}`, 503);
    return value;
  };
  const trustedProxyAddresses = raw.trustedProxyAddresses ?? [];
  if (!Array.isArray(trustedProxyAddresses) || trustedProxyAddresses.length > 16
    || trustedProxyAddresses.some((value) => !isIP(value))) throw transferError("transfer-invalid-proxies", 503);
  return Object.freeze({ enabled, publicBaseUrl, trustedProxyAddresses,
    maxBytes: integer("maxBytes", 2 * 1024 ** 3, 1, 8 * 1024 ** 3),
    storageBytes: integer("storageBytes", 20 * 1024 ** 3, 1, 64 * 1024 ** 3),
    ownerBytes: integer("ownerBytes", 4 * 1024 ** 3, 1, 16 * 1024 ** 3),
    freeBytes: integer("freeBytes", 1024 ** 3, 0, 16 * 1024 ** 3),
    sessionTtlMs: integer("sessionTtlMs", 6 * 3_600_000, 60_000, 6 * 3_600_000),
    idleTtlMs: integer("idleTtlMs", 900_000, 30_000, 900_000),
    preparationTtlMs: 3_600_000,
    maxArtifacts: integer("maxArtifacts", 64, 1, 256),
    maxPreparations: integer("maxPreparations", 2, 1, 4),
    maxStreams: integer("maxStreams", 4, 1, 16),
    maxRequests: 256,
    requestsPerMinute: integer("requestsPerMinute", 60, 1, 600),
  });
}

export function transferFilename(value) {
  const safe = String(value ?? "file").normalize("NFC").replace(/[\x00-\x1f\x7f/\\:]/gu, "_")
    .replace(/[\u202a-\u202e\u2066-\u2069]/gu, "").replace(/[\ud800-\udfff]/gu, "�");
  return [...safe].slice(0, 180).join("") || "file";
}

export function transferSessionSelector(credential) {
  return createHash("sha256")
    .update(JSON.stringify(["agenthub-transfer-session-selector-v1", String(credential)]))
    .digest("base64url");
}

export function transferRange(header, size) {
  if (!Number.isSafeInteger(size) || size < 1) throw transferError("transfer-invalid-size", 416);
  if (!header) return { start: 0, end: size - 1, partial: false };
  const match = /^bytes=(\d*)-(\d*)$/u.exec(String(header));
  if (!match || (!match[1] && !match[2])) throw transferError("transfer-invalid-range", 416);
  const first = match[1] ? Number(match[1]) : null;
  const second = match[2] ? Number(match[2]) : null;
  if ((first !== null && !Number.isSafeInteger(first)) || (second !== null && !Number.isSafeInteger(second))) {
    throw transferError("transfer-invalid-range", 416);
  }
  const start = first === null ? Math.max(0, size - second) : first;
  const end = first === null || second === null ? size - 1 : Math.min(second, size - 1);
  if (start < 0 || start >= size || end < start || (first === null && second === 0)) {
    throw transferError("transfer-invalid-range", 416);
  }
  return { start, end, partial: true };
}

export function transferMac(key, domain, ...values) {
  return createHmac("sha256", key).update(JSON.stringify(["agenthub-transfer-v1", domain, ...values])).digest("hex");
}

export function equalTransferDigest(a, b) {
  return /^[a-f0-9]{64}$/u.test(String(a)) && /^[a-f0-9]{64}$/u.test(String(b))
    && timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}

export function mergeTransferCoverage(previous, start, end) {
  const result = [];
  for (const interval of [...previous, [start, end]].sort((a, b) => a[0] - b[0])) {
    const tail = result.at(-1);
    if (tail && interval[0] <= tail[1] + 1) tail[1] = Math.max(tail[1], interval[1]);
    else result.push([...interval]);
  }
  return result;
}

export function transferClaimPayload(value) {
  return JSON.stringify({
    v: 1,
    purpose: "claim",
    challengeId: String(value.challengeId),
    shareId: String(value.shareId),
    claimId: String(value.claimId),
    jkt: String(value.jkt),
    nonce: String(value.nonce),
    expiresAt: Number(value.expiresAt),
  });
}

export function transferPlanPayload(value) {
  return JSON.stringify({
    v: 1,
    purpose: "download",
    planId: String(value.planId),
    sessionId: String(value.sessionId),
    artifactId: String(value.artifactId),
    generation: Number(value.generation),
    method: "POST",
    path: `/transfer/api/session/${String(value.sessionSelector)}/download`,
    start: Number(value.start),
    end: Number(value.end),
    etag: String(value.etag),
    nonce: String(value.nonce),
    expiresAt: Number(value.expiresAt),
  });
}
