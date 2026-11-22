export const GITHUB_OAUTH_ORIGIN = "https://auth.darksanctuary.ru";
export const GITHUB_OAUTH_CALLBACK = GITHUB_OAUTH_ORIGIN + "/github/callback";
export const GITHUB_OAUTH_CLIENT_ID = "Ov23litiqd3yqUSamgYd";
export const GITHUB_OAUTH_SCOPES = "gist read:org repo workflow";
export const GITHUB_OAUTH_LIFETIME_MS = 5 * 60_000;
export const GITHUB_OAUTH_POLL_MS = 2500;
export const githubOAuthOpaque = value => typeof value === "string" && /^[A-Za-z0-9_-]{43}$/u.test(value);
export const githubOAuthToken = value => typeof value === "string" && /^[A-Za-z0-9_]{20,255}$/u.test(value);

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
