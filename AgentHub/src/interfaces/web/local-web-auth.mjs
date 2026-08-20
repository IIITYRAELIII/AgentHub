import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { protectRuntimeConfig } from "../../infrastructure/filesystem/runtime-security.mjs";
import {
  LOCAL_WEB_SECRET_PATTERN,
  localWebAccessUrl,
} from "../../infrastructure/network/loopback-web-access.mjs";

export { localWebAccessUrl };

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
  if (!LOCAL_WEB_SECRET_PATTERN.test(secret)) {
    secret = randomBytes(32).toString("base64url");
    await mkdir(path.dirname(target), { recursive: true });
    try {
      await writeFile(target, `${secret}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      secret = String(await readFile(target, "utf8")).trim();
      if (!LOCAL_WEB_SECRET_PATTERN.test(secret)) {
        throw new Error("Existing local Web secret is invalid");
      }
    }
  }
  await protect(target);
  return secret;
}
