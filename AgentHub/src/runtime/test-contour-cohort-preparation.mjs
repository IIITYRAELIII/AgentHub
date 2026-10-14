import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { COHORT_FILES } from "./sqlite-cohort-snapshot.mjs";
import { assertContourOwnedPath } from "../infrastructure/filesystem/test-contour-external-effects.mjs";
import { createContourCommandMapping } from "../infrastructure/filesystem/test-contour-command-mapping.mjs";
import { prepareContourCatalog } from "./test-contour-catalog-preparation.mjs";
import { prepareTestContourRecordingConfiguration } from "../infrastructure/filesystem/test-contour-recording-configuration.mjs";

async function hash(file) {
  const digest = createHash("sha256");
  for await (const bytes of createReadStream(file)) digest.update(bytes);
  return digest.digest("hex");
}
const save = (file, value) => writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
function uniqueRoots(values) {
  const roots = new Map();
  for (const value of values) {
    if (typeof value !== "string") throw new Error("Expected a canonical path string");
    const windows = /^[a-z]:[\\/]/i.test(value) || value.startsWith("\\\\");
    const normalized = windows ? path.win32.normalize(value).toLowerCase() : path.posix.normalize(value);
    const key = normalized.replace(/[\\/]$/, "");
    if (!roots.has(key)) roots.set(key, value);
  }
  return [...roots.values()];
}
function disjoint(left, right) {
  const inside = (a, b) => { const r = path.relative(a, b); return !r || (!path.isAbsolute(r) && r !== ".." && !r.startsWith(`..${path.sep}`)); };
  if (inside(left, right) || inside(right, left)) throw new Error("Raw and prepared contour roots cannot overlap");
}
function validRecord(record) {
  if (!record || typeof record.name !== "string" || path.basename(record.name) !== record.name
    || !Number.isSafeInteger(record.bytes) || record.bytes < 0 || !/^[a-f0-9]{64}$/.test(record.sha256)) {
    throw new Error("Invalid captured file identity");
  }
}
async function copyVerified(record, source, destination, sourceRoot) {
  validRecord(record);
  assertContourOwnedPath(source, sourceRoot);
  const info = await stat(source);
  if (!info.isFile() || info.size !== record.bytes || await hash(source) !== record.sha256) throw new Error(`Captured file changed: ${record.name}`);
  await copyFile(source, destination, constants.COPYFILE_EXCL);
  if ((await stat(destination)).size !== record.bytes || await hash(destination) !== record.sha256) throw new Error(`Copied file identity mismatch: ${record.name}`);
}

// Raw evidence is immutable. This creates a separate writable runtime copy and
// changes only catalog operational fields; runtime queues and receipts remain
// canonical. It does not launch a Hub or grant boot authorization.
export async function prepareRecordingContourCohort({ captureManifestFile, outputDirectory,
  sourceConfig, attachmentRoots = [],
} = {}) {
  if (!captureManifestFile || !outputDirectory || !path.isAbsolute(captureManifestFile)
    || !path.isAbsolute(outputDirectory)) throw new Error("Explicit absolute preparation paths required");
  const rawRoot = path.dirname(captureManifestFile);
  assertContourOwnedPath(captureManifestFile, rawRoot);
  const rawBytes = await readFile(captureManifestFile);
  const raw = JSON.parse(rawBytes);
  if (raw.schemaVersion !== 1 || raw.phase !== "captured-raw" || raw.bootable !== false
    || raw.cohortConsistency !== "simultaneously-pinned-read-transactions"
    || JSON.stringify(raw.databases?.map((entry) => entry.name).sort()) !== JSON.stringify([...COHORT_FILES].sort())
    || raw.queueFiles?.consistency !== "unchanged-across-sqlite-cohort-window") throw new Error("A complete raw SQLite and queue cohort is required");
  const queues = raw.queueFiles.directories;
  if (!Array.isArray(queues) || JSON.stringify(queues.map((entry) => entry.name).sort()) !== JSON.stringify(["background-jobs", "delivery-outbox"])) throw new Error("Both queue owners require explicit capture evidence");
  for (const queue of queues) {
    if (typeof queue.absent !== "boolean" || !Array.isArray(queue.files) || (queue.absent && queue.files.length)) throw new Error("Invalid queue capture evidence");
    if (new Set(queue.files.map((entry) => entry.name)).size !== queue.files.length) throw new Error("Duplicate queue capture entry");
    for (const record of queue.files) { validRecord(record); if (!record.name.endsWith(".json")) throw new Error("Unexpected queue record"); }
  }
  const output = path.resolve(outputDirectory);
  disjoint(rawRoot, output);
  assertContourOwnedPath(output, output, { optional: true });
  try { await mkdir(output); } catch (error) { if (error.code !== "EEXIST") throw error; }
  assertContourOwnedPath(output, output);
  const root = await realpath(await mkdtemp(path.join(output, "prepared-")));
  const manifestFile = path.join(root, "contour-preparation.json");
  const manifest = { schemaVersion: 1, kind: "owned-contour-preparation", root, phase: "preparing", bootable: false,
    sourceCaptureId: raw.id, sourceManifestSha256: createHash("sha256").update(rawBytes).digest("hex"),
    exclusions: ["attachment bodies not copied", "captured live provider processes are not adopted", "captured-rollout-accounting-and-attachments", "interactive Task/Release Git requires an owned Git cohort", "media jobs remain inert", "no shared cross-store business transaction asserted"],
  };
  await save(manifestFile, manifest);
  try {
    const data = path.join(root, "data");
    const recordingRoot = path.join(root, "recording");
    await mkdir(data); await mkdir(recordingRoot);
    for (const record of raw.databases) await copyVerified(record, path.join(rawRoot, "databases", record.name), path.join(data, record.name), rawRoot);
    for (const queue of queues) {
      const destination = path.join(data, queue.name);
      await mkdir(destination);
      for (const record of queue.files) await copyVerified(record, path.join(rawRoot, "queue-files", queue.name, record.name), path.join(destination, record.name), rawRoot);
    }
    const databaseFile = path.join(data, "journal.sqlite");
    const db = new DatabaseSync(databaseFile, { readOnly: true });
    let threads, projectRoots;
    try {
      threads = db.prepare("SELECT provider, provider_thread_id AS id, stream_id AS streamId, project_root AS cwd FROM hub_threads").all();
      projectRoots = [sourceConfig?.projectRoot, ...(sourceConfig?.projects ?? []).map((entry) => entry.path),
        ...threads.map((entry) => entry.cwd),
        ...db.prepare("SELECT settings_json FROM hub_workspaces").all().map((row) => JSON.parse(row.settings_json).workingDirectory),
        ...db.prepare("SELECT settings_json FROM hub_streams").all().map((row) => JSON.parse(row.settings_json).project)].filter(Boolean);
    } finally { db.close(); }
    const sources = uniqueRoots(projectRoots).map((source) => ({ source, kind: "project" }));
    sources.push(...uniqueRoots(attachmentRoots).map((source) => ({ source, kind: "attachment" })));
    await save(path.join(recordingRoot, "recording-provider.json"), { schemaVersion: 1, kind: "literal-recording-provider",
      root: recordingRoot, externalEffects: "deny", sources, threads });
    const mapping = createContourCommandMapping({ root: recordingRoot });
    for (const entry of mapping.paths.manifest()) await mkdir(entry.target, { recursive: true });
    manifest.catalog = prepareContourCatalog({ databaseFile, preparedRoot: root, paths: mapping.paths });
    const recording = await prepareTestContourRecordingConfiguration({ root, sourceConfig });
    if (!rawBytes.equals(await readFile(captureManifestFile))) throw new Error("Raw capture manifest changed during preparation");
    manifest.phase = "prepared";
    manifest.queueFiles = raw.queueFiles;
    manifest.recordingMarkerSha256 = await hash(path.join(recordingRoot, "recording-provider.json"));
    manifest.configSha256 = await hash(path.join(recordingRoot, "recording-projects.json"));
    await save(manifestFile, manifest);
    return { root, manifestFile, manifest, recording };
  } catch (error) {
    manifest.phase = "failed"; manifest.error = error.message;
    await save(manifestFile, manifest);
    throw Object.assign(error, { manifestFile });
  }
}
