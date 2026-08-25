import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { agentHubReleaseSequence } from "./agent-hub-package.mjs";

export async function nextRuntimeReleaseVersion({
  releasesDir,
  packageVersion,
  readDirectoryImpl = readdir,
  readFileImpl = readFile,
} = {}) {
  const entries = await readDirectoryImpl(releasesDir, { withFileTypes: true }).catch((error) => {
    if (error?.code === "ENOENT") return [];
    throw error;
  });
  let maximumSequence = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.includes(".staging-")) continue;
    const manifestFile = path.join(releasesDir, entry.name, "runtime-manifest.json");
    const manifest = await readFileImpl(manifestFile, "utf8")
      .then((value) => JSON.parse(value), (error) => {
        if (error?.code === "ENOENT") return null;
        throw error;
      });
    if (!manifest || manifest.version !== packageVersion) continue;
    const sequence = manifest.releaseVersion == null
      ? 1
      : agentHubReleaseSequence(packageVersion, manifest.releaseVersion);
    maximumSequence = Math.max(maximumSequence, sequence);
  }
  return `${packageVersion}.${maximumSequence + 1}`;
}
