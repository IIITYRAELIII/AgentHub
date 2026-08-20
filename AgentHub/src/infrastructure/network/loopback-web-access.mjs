export const LOCAL_WEB_SECRET_PATTERN = /^[A-Za-z0-9_-]{43,128}$/u;

export function localWebAccessUrl(baseUrl, secret) {
  if (!LOCAL_WEB_SECRET_PATTERN.test(String(secret ?? ""))) {
    throw new Error("Local Web secret is invalid");
  }
  const url = new URL(String(baseUrl));
  if (!["127.0.0.1", "localhost", "::1"].includes(url.hostname)) {
    throw new Error("Local Web access URL must use a loopback host");
  }
  url.hash = `access=${encodeURIComponent(secret)}`;
  return url.toString();
}
