import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { runtimeLayout, runtimeReleaseDirectory } from "../infrastructure/filesystem/runtime-layout.mjs";
import { verifyRuntimeManifest } from "../infrastructure/filesystem/runtime-manifest-verifier.mjs";
import { runtimeStatus } from "./runtime-manager.mjs";

export async function publicationRuntimeStatus({ runtimeRoot } = {}) {
  // The display-oriented status tolerates lock read failures and missing PIDs. A
  // cold-start decision must preserve those failures as unknown, not absence.
  return runtimeStatus({ runtimeRoot, requireProcessEvidence: true });
}

// Publication owns only this one cold start. A failed/ambiguous restart RPC is
// never a reason to launch a second process; the existing runtime owns cutover.
export async function startInstalledPublicationRuntime({
  runtimeRoot,
  expectedReleaseId,
  readStatus = publicationRuntimeStatus,
  verifyManifest = verifyRuntimeManifest,
  execute = promisify(execFile),
  spawnImpl = spawn,
  platform = process.platform,
} = {}) {
  const layout = runtimeLayout(runtimeRoot);
  const releaseRoot = runtimeReleaseDirectory(runtimeRoot, expectedReleaseId);
  await verifyManifest(releaseRoot, expectedReleaseId);
  const manifest = JSON.parse(await readFile(path.join(releaseRoot, "runtime-manifest.json"), "utf8"));
  const name = platform === "win32" ? "AgentHub.RuntimeHost.exe" : "runtime-launch.sh";
  const expected = manifest.files.find((entry) => entry.path === name);
  const info = await lstat(layout.launcherFile);
  if (!expected || !info.isFile() || info.isSymbolicLink()
    || info.size !== Number(expected.bytes)
    || createHash("sha256").update(await readFile(layout.launcherFile)).digest("hex") !== expected.sha256) {
    throw new Error("Installed Agent Hub launcher does not match the published runtime manifest");
  }
  const current = await readStatus({ runtimeRoot });
  if (current.current !== expectedReleaseId) throw new Error("Published runtime changed before cold start");
  if (current.running === true) return { started: false };
  if (current.running !== false) throw new Error("Agent Hub process absence is not confirmed");
  if (platform === "win32") {
    await execute(layout.launcherFile, ["--spawn-independent"], {
      cwd: layout.root, windowsHide: true, timeout: 30_000, maxBuffer: 128 * 1024,
    });
  } else {
    const child = spawnImpl(layout.launcherFile, [], {
      cwd: layout.root, detached: true, stdio: "ignore",
    });
    await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("spawn", resolve);
    });
    child.unref();
  }
  return { started: true };
}
