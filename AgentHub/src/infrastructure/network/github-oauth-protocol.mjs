export const GITHUB_OAUTH_ORIGIN = "https://auth.darksanctuary.ru";
export const GITHUB_OAUTH_CALLBACK = GITHUB_OAUTH_ORIGIN + "/github/callback";
export const GITHUB_OAUTH_CLIENT_ID = "Ov23litiqd3yqUSamgYd";
export const GITHUB_OAUTH_SCOPES = "gist read:org repo workflow";
export const GITHUB_OAUTH_LIFETIME_MS = 5 * 60_000;
export const GITHUB_OAUTH_REFRESH_MAX_MS = 15_897_600_000;
export const GITHUB_OAUTH_POLL_MS = 2500;
export const githubOAuthOpaque = value => typeof value === "string" && /^[A-Za-z0-9_-]{43}$/u.test(value);
export const githubOAuthToken = value => typeof value === "string" && /^[A-Za-z0-9_]{20,255}$/u.test(value);
export const githubOAuthExpiry = value => Number.isSafeInteger(value) && value > 0;

export function githubOAuthRefreshPair(value) {
  return githubOAuthToken(value?.refreshToken) && githubOAuthExpiry(value.refreshExpiresAt)
    && githubOAuthExpiry(value.expiresAt);
}

// Node and Workers both expose Web Crypto and the standard body stream API.
export function githubOAuthRandom() {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

function base64url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

export async function githubOAuthChallenge(verifier) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

async function refreshResultKey(verifier) {
  const bytes = new TextEncoder().encode("AgentHub GitHub refresh result\0" + verifier);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function sealGitHubRefreshResult(pair, verifier) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const bytes = new TextEncoder().encode(JSON.stringify(pair));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await refreshResultKey(verifier), bytes);
  return { iv: btoa(String.fromCharCode(...iv)), ciphertext: btoa(String.fromCharCode(...new Uint8Array(ciphertext))) };
}

export async function unsealGitHubRefreshResult(sealed, verifier) {
  const bytes = value => Uint8Array.from(atob(value), character => character.charCodeAt(0));
  const iv = bytes(sealed.iv);
  if (iv.length !== 12) throw new Error("Invalid GitHub refresh result");
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, await refreshResultKey(verifier), bytes(sealed.ciphertext));
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plain));
}

export async function readGitHubOAuthJson(message, limit) {
  const reader = message.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let text = "", length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) { await reader.cancel(); throw new Error("Oversize OAuth body"); }
      text += decoder.decode(value, { stream: true });
    }
    const value = JSON.parse(text + decoder.decode());
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid OAuth object");
    return value;
  } finally { reader.releaseLock(); }
}
