import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

import { agentHubReleaseSequence } from "./agent-hub-package.mjs";
import { artifactVersion, calendarVersion, manifestVersionIdentity, buildNumber } from "../../domain/agent-hub-version.mjs";

export async function nextRuntimeReleaseVersion({
  releasesDir,
  packageVersion,
  readDirectoryImpl = readdir,
  readFileImpl = readFile,
  // On a new freeze use the existing Android epoch-minute floor. An original
  // frozen N carries that floor on preparation/retry, never the current clock.
  allocationFloor = Math.floor(Date.now() / 60_000),
} = {}) {
  const entries = await readDirectoryImpl(releasesDir, { withFileTypes: true }).catch((error) => {
    if (error?.code === "ENOENT") return [];
    throw error;
  });
  let maximumSequence = 0;
  const mobileGroups = new Map();
  const semantic = !calendarVersion(packageVersion);
  if (semantic) {
    if (!Number.isSafeInteger(allocationFloor) || allocationFloor < 0) throw new Error("Invalid allocation floor");
    maximumSequence = allocationFloor;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.includes(".staging-")) {
      if (semantic) throw new Error("Partial runtime allocation requires original-owner reconciliation");
      continue;
    }
    const manifestFile = path.join(releasesDir, entry.name, "runtime-manifest.json");
    const manifest = await readFileImpl(manifestFile, "utf8")
      .then((value) => JSON.parse(value), (error) => {
        if (error?.code === "ENOENT") return null;
        throw error;
      });
    if (!manifest) {
      if (semantic) throw new Error("Unknown retained runtime allocation");
      continue;
    }
    if (semantic) {
      if (manifest.releaseId !== entry.name || !Array.isArray(manifest.files)) throw new Error("Foreign retained runtime allocation");
      maximumSequence = Math.max(maximumSequence, manifestVersionIdentity(manifest).buildNumber);
      const mobileEntry = manifest.files.filter(item => item.path === "assets/mobile/update.json");
      if (mobileEntry.length > 1) throw new Error("Ambiguous retained Android metadata");
      if (mobileEntry.length) {
        const metadata = mobileEntry[0];
        const key = `${metadata.sha256}:${metadata.bytes}`;
        if (!mobileGroups.has(key)) mobileGroups.set(key, { metadata, files: [] });
        mobileGroups.get(key).files.push(path.join(releasesDir, entry.name, "assets", "mobile", "update.json"));
      }
      continue;
    }
    if (manifest.version !== packageVersion) continue;
    const sequence = manifest.releaseVersion == null
      ? 1
      : agentHubReleaseSequence(packageVersion, manifest.releaseVersion);
    maximumSequence = Math.max(maximumSequence, sequence);
  }
  for (const { metadata, files } of mobileGroups.values()) {
    let verified = false, missing = null;
    for (const file of files) {
      const raw = await readFileImpl(file).catch(error => {
        if (error.code !== "ENOENT") throw error;
        missing ??= error;
        return null;
      });
      if (raw === null) continue;
      if (raw.length !== metadata.bytes || createHash("sha256").update(raw).digest("hex") !== metadata.sha256) {
        throw new Error("Retained Android metadata integrity mismatch");
      }
      maximumSequence = Math.max(maximumSequence, buildNumber(JSON.parse(raw).versionCode));
      verified = true;
    }
    // Allocation needs the exact declared metadata content once, not every
    // duplicate physical copy. Missing unique content still refuses. This is
    // not a certificate of completeness/installation for any retained body.
    if (!verified) throw missing ?? new Error("Retained Android metadata is unavailable");
  }
  return semantic ? artifactVersion(packageVersion, maximumSequence + 1) : `${packageVersion}.${maximumSequence + 1}`;
}
