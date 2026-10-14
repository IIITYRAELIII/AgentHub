import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { writeTextAtomic } from "../persistence/state-store.mjs";
import { createContourCommandMapping } from "./test-contour-command-mapping.mjs";
import { assertContourOwnedPath } from "./test-contour-external-effects.mjs";
import { prepareContourProjectConfiguration } from "../../domain/test-contour-project-configuration.mjs";

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const descriptorName = "recording-projects.json";

function samePath(left, right) {
  const canonical = (value) => {
    const resolved = path.resolve(value);
    try { return realpathSync.native(resolved); } catch { return resolved; }
  };
  const a = canonical(left);
  const b = canonical(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function canonicalRoot(value) {
  const resolved = path.resolve(value);
  try { return realpathSync.native(resolved); } catch { return resolved; }
}

async function recordingIdentity(root) {
  root = canonicalRoot(root);
  const recordingRoot = path.join(root, "recording");
  const marker = assertContourOwnedPath(path.join(recordingRoot, "recording-provider.json"), root);
  const before = digest(await readFile(marker));
  const mapping = createContourCommandMapping({ root: recordingRoot });
  if (digest(await readFile(marker)) !== before) throw new Error("Recording marker changed during configuration preparation");
  return { root: recordingRoot, markerSha256: before, mapping };
}

// Called by the existing installer after the cohort owner has created its owned
// recording marker. Only project metadata is retained, never source credentials.
export async function prepareTestContourRecordingConfiguration({ root, sourceConfig }) {
  root = canonicalRoot(root);
  const identity = await recordingIdentity(root);
  if (!sourceConfig || !Array.isArray(sourceConfig.projects)) throw new Error("Explicit source projects are required");
  const config = { projectRoot: identity.mapping.canonicalPath(sourceConfig.projectRoot),
    projects: sourceConfig.projects.map((project) => ({ name: String(project.name ?? "").trim(),
      path: identity.mapping.canonicalPath(project.path) })) };
  if (config.projects.some((project) => !project.name)) throw new Error("Source project name is required");
  prepareContourProjectConfiguration({ config, environment: {}, mapping: identity.mapping });
  const value = { schemaVersion: 1, kind: "recording-project-configuration", root: identity.root,
    markerSha256: identity.markerSha256, source: config };
  const file = assertContourOwnedPath(path.join(identity.root, descriptorName), root, { optional: true });
  const bytes = `${JSON.stringify(value, null, 2)}\n`;
  try {
    if (await readFile(file, "utf8") !== bytes) throw new Error("Prepared recording projects differ; prepare a fresh owned cohort");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    await writeTextAtomic(file, bytes);
  }
  return readTestContourRecordingConfiguration(root);
}

export async function readTestContourRecordingConfiguration(root) {
  root = canonicalRoot(root);
  // A partially prepared recording root must not fall back to the destructive
  // legacy fake-contour preparation when its marker/descriptor is missing.
  try { await lstat(path.join(root, "recording")); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
  const identity = await recordingIdentity(root);
  const file = assertContourOwnedPath(path.join(identity.root, descriptorName), root);
  const value = JSON.parse(await readFile(file, "utf8"));
  if (value.schemaVersion !== 1 || value.kind !== "recording-project-configuration"
    || !samePath(value.root, identity.root) || value.markerSha256 !== identity.markerSha256) {
    throw new Error("Prepared recording project identity mismatch");
  }
  const prepared = prepareContourProjectConfiguration({ config: value.source, environment: {}, mapping: identity.mapping });
  return { root: identity.root, projectRoot: prepared.config.projectRoot, projects: prepared.config.projects };
}
