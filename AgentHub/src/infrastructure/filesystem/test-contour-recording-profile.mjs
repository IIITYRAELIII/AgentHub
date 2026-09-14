import { lstat, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { assertContourOwnedPath } from "./test-contour-external-effects.mjs";
import { readTestContourRecordingConfiguration } from "./test-contour-recording-configuration.mjs";

export const RECORDING_BOOT_GAPS = Object.freeze([
  "verified-prepared-cohort",
]);

// Config parsing is the boot fence. Direct isolated provider tests do not call
// loadConfig and therefore exercise the adapter without authorizing a Hub boot.
export async function recordingContourProfile(raw, { dataDir, environment = process.env } = {}) {
  if (raw == null) return null;
  if (raw.schemaVersion !== 1 || typeof raw.root !== "string" || !path.isAbsolute(raw.root)) throw new Error("Invalid testContourRecording profile");
  const runtimeRoot = environment.AGENT_HUB_RUNTIME_ROOT;
  if (environment.AGENT_HUB_TEST_CONTOUR !== "1" || !runtimeRoot || !path.isAbsolute(runtimeRoot)) throw new Error("Recording profile requires an isolated Test Contour runtime");
  const root = path.resolve(raw.root);
  if (root !== path.join(path.resolve(runtimeRoot), "recording") || path.resolve(dataDir || ".") !== path.join(path.resolve(runtimeRoot), "data")) throw new Error("Recording profile/runtime paths disagree");
  let current = root;
  for (;;) {
    if ((await lstat(current)).isSymbolicLink()) throw new Error("Recording root cannot contain links");
    const parent = path.dirname(current); if (parent === current) break; current = parent;
  }
  const markerFile = path.join(root, "recording-provider.json");
  if ((await lstat(markerFile)).isSymbolicLink()) throw new Error("Recording marker cannot be a link");
  const marker = JSON.parse(await readFile(markerFile, "utf8"));
  if (marker.kind !== "literal-recording-provider" || marker.root !== root || marker.externalEffects !== "deny") throw new Error("Recording profile marker mismatch");
  // Implemented owner adapters enforce effects independently of this manifest.
  // A provider marker alone still cannot boot arbitrary copied runtime data.
  try {
    const runtime = path.resolve(runtimeRoot);
    const file = assertContourOwnedPath(path.join(runtime, "contour-preparation.json"), runtime);
    const prepared = JSON.parse(await readFile(file, "utf8"));
    const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
    if (prepared.schemaVersion !== 1 || prepared.kind !== "owned-contour-preparation"
      || prepared.root !== runtime || prepared.phase !== "prepared" || prepared.bootable !== false
      || prepared.queueFiles?.consistency !== "unchanged-across-sqlite-cohort-window"
      || prepared.recordingMarkerSha256 !== digest(await readFile(markerFile))) throw new Error("Prepared cohort identity mismatch");
    await readTestContourRecordingConfiguration(runtime);
    const config = assertContourOwnedPath(path.join(root, "recording-projects.json"), runtime);
    if (prepared.configSha256 !== digest(await readFile(config))) throw new Error("Prepared project configuration changed");
    for (const name of ["journal.sqlite", "runtime.sqlite", "message-command-ledger.sqlite"]) {
      const db = assertContourOwnedPath(path.join(dataDir, name), runtime);
      if (!(await lstat(db)).isFile()) throw new Error("Prepared SQLite cohort is incomplete");
    }
    return Object.freeze({ schemaVersion: 1, root });
  } catch (cause) {
    const error = new Error(`Recording boot requires a verified prepared cohort: ${cause.message}`, { cause });
    error.code = "CONTOUR_RECORDING_BOOT_NOT_READY";
    error.gaps = [...RECORDING_BOOT_GAPS];
    throw error;
  }
}
