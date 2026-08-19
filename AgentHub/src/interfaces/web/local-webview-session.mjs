import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const SESSION_VERSION = "v1";
const SESSION_AUDIENCE = "agent-hub-vscode-webview";
const DEFAULT_TTL_SECONDS = 5 * 60;
const MAX_TTL_SECONDS = 15 * 60;

function safeEqual(left, right) {
  const leftBytes = Buffer.from(String(left ?? ""), "utf8");
  const rightBytes = Buffer.from(String(right ?? ""), "utf8");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function signature(secret, payload) {
  return createHmac("sha256", secret)
    .update(`${SESSION_AUDIENCE}\n${payload}`)
    .digest("base64url");
}

export function createLocalWebviewSession(secret, {
  now = Date.now(),
  ttlSeconds = DEFAULT_TTL_SECONDS,
} = {}) {
  const key = String(secret ?? "").trim();
  const ttl = Math.min(MAX_TTL_SECONDS, Math.max(30, Number(ttlSeconds) || DEFAULT_TTL_SECONDS));
  if (key.length < 32) throw new Error("Локальный секрет Agent Hub недействителен");
  const issuedAt = Math.floor(Number(now) / 1_000);
  const expiresAt = issuedAt + Math.floor(ttl);
  const nonce = randomBytes(18).toString("base64url");
  const payload = `${SESSION_VERSION}.${issuedAt}.${expiresAt}.${nonce}`;
  return {
    token: `${payload}.${signature(key, payload)}`,
    expiresAt: expiresAt * 1_000,
  };
}

export function validLocalWebviewSession(value, secret, { now = Date.now() } = {}) {
  const match = /^(v1)\.(\d{10,12})\.(\d{10,12})\.([A-Za-z0-9_-]{24})\.([A-Za-z0-9_-]{43})$/u
    .exec(String(value ?? ""));
  const key = String(secret ?? "").trim();
  if (!match || key.length < 32) return false;
  const issuedAt = Number(match[2]);
  const expiresAt = Number(match[3]);
  const current = Math.floor(Number(now) / 1_000);
  if (
    !Number.isSafeInteger(issuedAt)
    || !Number.isSafeInteger(expiresAt)
    || issuedAt > current + 30
    || expiresAt < current
    || expiresAt <= issuedAt
    || expiresAt - issuedAt > MAX_TTL_SECONDS
  ) return false;
  const payload = `${match[1]}.${match[2]}.${match[3]}.${match[4]}`;
  return safeEqual(match[5], signature(key, payload));
}
