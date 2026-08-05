import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { protectRuntimeConfig } from "../../infrastructure/filesystem/runtime-security.mjs";

const SECRET_PATTERN = /^[A-Za-z0-9_-]{43,128}$/u;

export async function ensureLocalWebSecret(filePath, {
  protect = protectRuntimeConfig,
} = {}) {
  const target = path.resolve(filePath);
  let secret = "";
  try {
    secret = String(await readFile(target, "utf8")).trim();
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (!SECRET_PATTERN.test(secret)) {
    secret = randomBytes(32).toString("base64url");
    await mkdir(path.dirname(target), { recursive: true });
    try {
      await writeFile(target, `${secret}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      secret = String(await readFile(target, "utf8")).trim();
      if (!SECRET_PATTERN.test(secret)) {
        throw new Error("Existing local Web secret is invalid");
      }
    }
  }
  await protect(target);
  return secret;
}

export function localWebAccessUrl(baseUrl, secret) {
  if (!SECRET_PATTERN.test(String(secret ?? ""))) {
    throw new Error("Local Web secret is invalid");
  }
  const url = new URL(String(baseUrl));
  if (!["127.0.0.1", "localhost", "::1"].includes(url.hostname)) {
    throw new Error("Local Web access URL must use a loopback host");
  }
  url.hash = `access=${encodeURIComponent(secret)}`;
  return url.toString();
}
