import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { normalizeUsageSyncServerUrl } from "../../domain/default-usage-sync-server.mjs";
import { runtimeReleaseDirectory } from "./runtime-layout.mjs";
import { protectRuntimeConfig } from "./runtime-security.mjs";
import { writeTextAtomic } from "../persistence/state-store.mjs";

async function optionalJson(file) {
  try {
    const value = JSON.parse(await readFile(file, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    // JSON parser errors may include config secrets. Do not expose their cause.
    throw new Error("Cannot read usage sync migration settings");
  }
}

async function previousDefault(runtimeRoot, releaseId) {
  if (!releaseId) return "";
  const root = runtimeReleaseDirectory(runtimeRoot, releaseId);
  const relative = "src/domain/default-usage-sync-server.mjs";
  const manifest = await optionalJson(path.join(root, "runtime-manifest.json"));
  if (!manifest || manifest.releaseId !== releaseId || !Array.isArray(manifest.files)) {
    throw new Error("Previous usage sync source identity is unavailable");
  }
  const entries = manifest.files.filter(entry => entry.path === relative);
  if (!entries.length) return ""; // Releases before this setting's owner existed.
  if (entries.length !== 1 || entries[0].bytes > 16 * 1024) throw new Error("Previous usage sync source is invalid");
  const file = path.join(root, relative);
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size !== entries[0].bytes) {
    throw new Error("Previous usage sync source changed");
  }
  const bytes = await readFile(file);
  if (createHash("sha256").update(bytes).digest("hex") !== entries[0].sha256) {
    throw new Error("Previous usage sync source changed");
  }
  // Read the old module's bounded JSON string literal. Never execute old code.
  const match = bytes.toString("utf8").match(/^export const DEFAULT_USAGE_SYNC_SERVER_URL = ("(?:[^"\\\r\n]|\\.)*");$/mu);
  if (!match) throw new Error("Previous usage sync default requires explicit configuration");
  let value;
  try { value = JSON.parse(match[1]); }
  catch { throw new Error("Previous usage sync default requires explicit configuration"); }
  return normalizeUsageSyncServerUrl(value);
}

/** The existing installer seeds one missing private config key before cutover.
 * It never rewrites enrollment credentials, journal facts, cursors or receipts.
 * A failed install may retain the new key; old releases ignore that key safely.
 */
export async function migrateUsageSyncServerSetting({ layout, previousReleaseId, environment = process.env }) {
  const rawText = await readFile(layout.configFile, "utf8").catch(error => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (rawText === null) return { migrated: false, reason: "no-config" };
  const raw = await optionalJson(layout.configFile);
  if (Object.hasOwn(raw, "usageSyncServerUrl")) return { migrated: false, reason: "configured" };
  const dataDir = path.resolve(path.dirname(layout.configFile), raw.dataDir ?? "data");
  const remote = await optionalJson(path.join(dataDir, "usage-sync-remote.json"));
  const identity = await optionalJson(path.join(dataDir, "usage-sync-identity.json"));
  // Preserve the OLD effective precedence, including an enrolled/custom URL.
  const selected = remote?.serverUrl
    || String(environment.AGENT_HUB_USAGE_SYNC_SERVER_URL ?? "").trim()
    || await previousDefault(layout.root, previousReleaseId);
  const serverUrl = normalizeUsageSyncServerUrl(selected);
  if (!serverUrl && (remote?.deviceId || identity?.deviceId)) {
    throw new Error("Existing usage sync enrollment requires its previous server setting");
  }
  // Do not overwrite a concurrent explicit edit or any unrelated config change.
  if (await readFile(layout.configFile, "utf8") !== rawText) throw new Error("Configuration changed during usage sync migration");
  await writeTextAtomic(layout.configFile, `${JSON.stringify({ ...raw, usageSyncServerUrl: serverUrl }, null, 2)}\n`);
  await protectRuntimeConfig(layout.configFile, { environment });
  return { migrated: true, reason: serverUrl ? "preserved-previous-address" : "unconfigured" };
}
