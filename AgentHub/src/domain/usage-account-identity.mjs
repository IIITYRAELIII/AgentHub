import { createHash, createHmac } from "node:crypto";

/**
 * Credential class names that the previous implementation used as account keys.
 * They identify a kind of credential, not an account: two unrelated API keys or
 * Bedrock profiles collapse into one billing identity under them. USG-001
 * forbids them as `accountKey` values.
 */
const CREDENTIAL_CLASS_KEYS = new Set(["api-key", "amazon-bedrock"]);

const SCOPED_CREDENTIAL_PREFIXES = new Map([
  ["apikey", "api-key"],
  ["amazonbedrock", "amazon-bedrock"],
]);

function text(value) {
  return String(value ?? "").trim();
}

function canonical(parts) {
  return JSON.stringify(parts);
}

function sha256(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}

function hmac(salt, message) {
  const key = text(salt);
  if (!key) throw new TypeError("A device-local salt is required");
  return createHmac("sha256", key).update(message, "utf8").digest("hex");
}

function normalizedPath(value) {
  return text(value).replaceAll("\\", "/").replace(/\/+$/u, "").toLowerCase();
}

/**
 * Device-local pseudonym of an auth store directory. The raw path never crosses
 * the wire: it leaks the user and the machine layout, and it is a poor
 * cross-machine key. The salt is required because `deviceId` is public within
 * the team and auth store paths are guessable, so an unsalted hash would be
 * reversible by enumeration.
 *
 * The result is comparable only within one device. Testing it across devices is
 * meaningless and USG-001 forbids it.
 */
export function usageRuntimeHomeId(homeSalt, absolutePath) {
  const home = normalizedPath(absolutePath);
  return home ? hmac(homeSalt, canonical(["runtime-home", home])) : "";
}

/**
 * Detects that an auth store changed between two observations on one device.
 * Derived only from non-secret account fields: token material, raw or hashed,
 * must never contribute, because a hash of a secret is still a verifier for
 * guessing it.
 */
export function usageAuthFingerprint(homeSalt, { accountKey, accountPlan } = {}) {
  const key = text(accountKey);
  if (!key) return "";
  return hmac(homeSalt, canonical(["auth-fingerprint", key, text(accountPlan)]));
}

export function isCredentialClassAccountKey(value) {
  return CREDENTIAL_CLASS_KEYS.has(text(value).toLowerCase());
}

function scopedCredentialAccount(type, value) {
  const prefix = SCOPED_CREDENTIAL_PREFIXES.get(type.toLowerCase());
  if (!prefix) return null;
  // Only a stable, non-secret identifier of the individual credential may scope
  // the key. The credential material itself is never an input.
  const identifier = text(value?.credentialId ?? value?.keyId ?? value?.profile);
  if (!identifier) return null;
  return {
    key: `${prefix}:${sha256(canonical([prefix, identifier.toLowerCase()]))}`,
    label: identifier,
    type: prefix,
    planType: text(value?.planType),
  };
}

const CLAUDE_PLAN_TIERS = new Set(["free", "pro", "max", "team", "enterprise"]);

function normalizedClaudePlanTier(value) {
  const normalized = text(value).toLowerCase().replace(/[\s-]+/gu, "_");
  const tier = normalized.startsWith("claude_") ? normalized.slice("claude_".length) : normalized;
  if (/^max(?:_\d+x)?$/u.test(tier)) return "max";
  return CLAUDE_PLAN_TIERS.has(tier) ? tier : "";
}

function claudePlanType(account) {
  return normalizedClaudePlanTier(account?.seatTier)
    || normalizedClaudePlanTier(account?.organizationType);
}

/**
 * Account dimension for a Codex auth store. Returns null when the store exposes
 * no stable identifier of a specific account — a device then publishes no
 * observation at all rather than a placeholder.
 */
export function codexUsageAccount(value) {
  const account = value?.account && typeof value.account === "object" ? value.account : value;
  const type = text(account?.type);
  const email = text(account?.email).toLowerCase();
  if (type === "chatgpt") {
    if (!email) return null;
    return {
      key: `chatgpt:${sha256(email)}`,
      label: email,
      type: "chatgpt",
      planType: text(account?.planType),
    };
  }
  return scopedCredentialAccount(type, account);
}

/** Account dimension for a Claude auth store (`~/.claude.json` oauthAccount). */
export function claudeUsageAccount(value) {
  const account = value?.oauthAccount && typeof value.oauthAccount === "object"
    ? value.oauthAccount
    : value;
  const accountUuid = text(account?.accountUuid);
  if (!accountUuid) return null;
  return {
    key: `anthropic:${accountUuid}`,
    label: text(account?.emailAddress).toLowerCase(),
    type: "oauth",
    planType: claudePlanType(account),
  };
}

export { canonical as canonicalUsageIdentityValue, sha256 as usageIdentityHash };
