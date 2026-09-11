import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, mkdtemp, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { readContourQueueFiles, verifyContourQueueFiles, writeContourQueueFiles } from "./contour-sidecar-snapshot.mjs";

export const COHORT_FILES = Object.freeze(["journal.sqlite", "runtime.sqlite", "message-command-ledger.sqlite"]);
const inside = (file, root) => {
  const relative = path.relative(path.resolve(root), path.resolve(file));
  return !relative || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
};
const dataVersion = (db) => Number(db.prepare("PRAGMA data_version").get().data_version);
const fileIdentity = async (file) => { const info = await stat(file); return `${info.dev}:${info.ino}`; };

async function rejectReparseAncestors(file) {
  let current = path.resolve(file);
  for (;;) {
    if ((await lstat(current)).isSymbolicLink()) throw new Error(`Snapshot paths cannot contain links or junctions: ${current}`);
    const parent = path.dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

async function sha256(file) {
  const digest = createHash("sha256");
  for await (const bytes of createReadStream(file)) digest.update(bytes);
  return digest.digest("hex");
}

function closePins(pins) {
  for (const pin of pins) {
    try { pin.reader.exec("ROLLBACK"); } catch {}
    try { pin.reader.close(); } catch {}
    try { pin.observer.close(); } catch {}
  }
}

async function pinCohort(sourceDirectory, { attempts, onPinnedDatabase }) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const pins = [];
    let accepted = false;
    try {
      for (const name of COHORT_FILES) {
        const file = path.join(sourceDirectory, name);
        const identity = await fileIdentity(file);
        const observer = new DatabaseSync(file, { readOnly: true });
        let reader;
        try {
          if (observer.prepare("PRAGMA journal_mode").get().journal_mode !== "wal") throw new Error(`Source ${name} is not WAL; read pin could block writers`);
          reader = new DatabaseSync(file, { readOnly: true });
          if (identity !== await fileIdentity(file)) throw new Error(`Source database identity changed while opening ${name}`);
          pins.push({ name, file, observer, reader, identity });
        } catch (error) { observer.close(); reader?.close(); throw error; }
      }
      // Compare each observer only with itself. data_version values from
      // different connections are not a shared/global revision number.
      const before = pins.map((pin) => dataVersion(pin.observer));
      const startedAt = new Date().toISOString();
      for (const [index, pin] of pins.entries()) {
        pin.reader.exec("BEGIN");
        pin.reader.prepare("SELECT rootpage FROM sqlite_schema LIMIT 1").get();
        await onPinnedDatabase?.({ index, attempt });
      }
      const after = pins.map((pin) => dataVersion(pin.observer));
      const identities = await Promise.all(pins.map((pin) => fileIdentity(pin.file)));
      if (pins.some((pin, index) => pin.identity !== identities[index])) throw new Error("Source database identity changed during snapshot pinning");
      if (before.some((value, index) => value !== after[index])) {
        if (attempt < attempts) continue;
        throw new Error("No coherent SQLite read window: source commits overlapped every pin attempt");
      }
      accepted = true;
      return { pins, evidence: { attempt, startedAt, pinnedAt: new Date().toISOString(),
        versions: Object.fromEntries(pins.map((pin, index) => [pin.name, { before: before[index], after: after[index] }])) } };
    } finally {
      if (!accepted) closePins(pins);
    }
  }
  throw new Error("No snapshot pin attempt was permitted");
}

export async function captureSqliteCohort({ sourceDataDirectory, outputDirectory,
  attempts = 3, onPinnedDatabase, onCohortPinned, backupImpl = backup, onProgress, includeQueueFiles = false,
} = {}) {
  if (!sourceDataDirectory || !outputDirectory) throw new Error("Explicit source and output directories are required");
  const source = path.resolve(sourceDataDirectory);
  const output = path.resolve(outputDirectory);
  if (inside(output, source) || inside(source, output)) throw new Error("Snapshot source and output cannot overlap");
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 3) throw new Error("Pin attempts must be between 1 and 3");
  for (const name of COHORT_FILES) await rejectReparseAncestors(path.join(source, name));
  await mkdir(output, { recursive: true });
  await rejectReparseAncestors(output);
  const root = await mkdtemp(path.join(output, "captured-"));
  const dataDirectory = path.join(root, "databases");
  await mkdir(dataDirectory);
  const manifestFile = path.join(root, "snapshot-manifest.json");
  const manifest = { schemaVersion: 1, id: randomUUID(), phase: "capturing", bootable: false,
    cohortConsistency: "unverified", runtimeRecoveryParity: false,
    createdAt: new Date().toISOString(), databases: [],
    exclusions: ["not a persistence drain fence", "no production config/secrets copied", "external queue files and attachments are not captured", "not sanitized or boot-authorized"] };
  const save = () => writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await save();
  let pinned;
  try {
    await onProgress?.({ phase: "initialized", root, manifestFile });
    const queueFiles = includeQueueFiles ? await readContourQueueFiles(source) : null;
    pinned = await pinCohort(source, { attempts, onPinnedDatabase });
    manifest.pin = pinned.evidence;
    await onProgress?.({ phase: "pinned", root, manifestFile });
    await onCohortPinned?.();
    for (const pin of pinned.pins) {
      const target = path.join(dataDirectory, pin.name);
      // A retained read transaction fixes the source WAL end mark. Concurrent
      // commits cannot move this backup to another logical generation.
      await onProgress?.({ phase: "copying", database: pin.name, root, manifestFile });
      const pages = await backupImpl(pin.reader, target, { rate: 256 });
      manifest.databases.push({ name: pin.name, pages });
    }
    if (queueFiles) {
      await verifyContourQueueFiles(source, queueFiles);
      manifest.queueFiles = await writeContourQueueFiles(root, queueFiles);
      manifest.exclusions = manifest.exclusions.map((item) => item === "external queue files and attachments are not captured"
        ? "queue files are inert evidence; attachments are not captured" : item);
    }
    closePins(pinned.pins);
    pinned = null;
    for (const record of manifest.databases) {
      const file = path.join(dataDirectory, record.name);
      await onProgress?.({ phase: "hashing", database: record.name, root, manifestFile });
      record.bytes = (await stat(file)).size;
      record.sha256 = await sha256(file);
    }
    manifest.cohortConsistency = "simultaneously-pinned-read-transactions";
    manifest.phase = "captured-raw";
    manifest.finishedAt = new Date().toISOString();
    await save();
    return { root, dataDirectory, manifestFile, manifest };
  } catch (error) {
    manifest.phase = "failed";
    manifest.error = error.message;
    manifest.finishedAt = new Date().toISOString();
    await save();
    throw Object.assign(error, { manifestFile });
  } finally {
    if (pinned) closePins(pinned.pins);
  }
}
