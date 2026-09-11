import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, lstat, mkdir, readFile, readdir, rename } from "node:fs/promises";
import path from "node:path";
import { recordingContourProfile } from "../infrastructure/filesystem/test-contour-recording-profile.mjs";
import { assertContourOwnedPath } from "../infrastructure/filesystem/test-contour-external-effects.mjs";
import { createContourCommandMapping } from "../infrastructure/filesystem/test-contour-command-mapping.mjs";
import { createContourOperationalPaths } from "../domain/test-contour-operational-paths.mjs";
import { prepareContourCatalog } from "./test-contour-catalog-preparation.mjs";
import { writeTextAtomic } from "../infrastructure/persistence/state-store.mjs";

const components = ["data", "recording", "contour-preparation.json"];
const retained = [...components, "config.json", "current.json", "test-contour-source.json", "test-contour-state.json"];
const documentName = "test-contour-adoption.json";
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const json = async (file) => JSON.parse(await readFile(file, "utf8"));
const save = (file, value) => writeTextAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
async function exists(file) { try { await lstat(file); return true; } catch (e) { if (e.code === "ENOENT") return false; throw e; } }
async function hash(file) { const h = createHash("sha256"); for await (const b of createReadStream(file)) h.update(b); return h.digest("hex"); }

async function inventory(root, relative = "") {
  const file = assertContourOwnedPath(path.join(root, relative), root);
  const info = await lstat(file);
  if (info.isFile()) return [[relative, await hash(file)]];
  if (!info.isDirectory()) throw new Error("Adoption accepts only regular owned files and directories");
  const result = [];
  for (const entry of (await readdir(file)).sort()) result.push(...await inventory(root, path.join(relative, entry)));
  return result;
}
async function copyTree(source, destination, sourceRoot) {
  assertContourOwnedPath(source, sourceRoot);
  const info = await lstat(source);
  if (info.isFile()) return copyFile(source, destination);
  if (!info.isDirectory()) throw new Error("Non-regular adoption source");
  await mkdir(destination);
  for (const name of await readdir(source)) await copyTree(path.join(source, name), path.join(destination, name), sourceRoot);
}
function location(root, document) {
  if (document?.schemaVersion !== 1 || document.kind !== "recording-cohort-adoption" || document.root !== root
      || !/^[a-f0-9-]{36}$/.test(document.id)) throw new Error("Invalid contour adoption ownership");
  const transactionRoot = assertContourOwnedPath(path.join(root, "cohort-adoptions", document.id), root);
  const child = (name) => assertContourOwnedPath(path.join(transactionRoot, name), root, { optional: true });
  return { transactionRoot, stage: child("stage"), backup: child("backup"), displaced: child("displaced") };
}
export async function readContourAdoption(root) {
  root = path.resolve(root);
  const file = assertContourOwnedPath(path.join(root, documentName), root, { optional: true });
  if (!await exists(file)) return null;
  const document = await json(file); location(root, document); return document;
}
export async function writeContourAdoption(root, document, patch) {
  location(root, document);
  Object.assign(document, patch);
  await save(path.join(root, documentName), document);
  return document;
}

// Called only while the canonical contour operation lease is held. The source
// is never renamed or edited; only the three prepared components are copied.
export async function stageContourAdoption({ root, preparedRoot }) {
  root = path.resolve(root); preparedRoot = path.resolve(preparedRoot);
  const contourMarker = await json(assertContourOwnedPath(path.join(root, ".agent-hub-test-contour.json"), root));
  if (contourMarker.kind !== "agent-hub-test-contour" || !contourMarker.id) throw new Error("Adoption requires the existing canonical contour marker");
  for (const [a, b] of [[root, preparedRoot], [preparedRoot, root]]) {
    const relative = path.relative(a, b);
    if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) throw new Error("Prepared and canonical contour roots overlap");
  }
  await recordingContourProfile({ schemaVersion: 1, root: path.join(preparedRoot, "recording") }, {
    dataDir: path.join(preparedRoot, "data"), environment: { AGENT_HUB_TEST_CONTOUR: "1", AGENT_HUB_RUNTIME_ROOT: preparedRoot },
  });
  // A previously booted recording provider is not an immutable preparation input.
  const recordingFiles = await inventory(path.join(preparedRoot, "recording"));
  if (recordingFiles.some(([name]) => !["recording-provider.json", "recording-projects.json"].includes(name))) throw new Error("Adopt only a pristine prepared recording cohort");
  const preparedDataNames = new Set(["journal.sqlite", "runtime.sqlite", "message-command-ledger.sqlite", "background-jobs", "delivery-outbox"]);
  // Read-only SQLite inspection can create empty WAL/SHM sidecars. A nonempty
  // WAL would make a plain component copy a second, unpinned capture: refuse it.
  for (const database of ["journal.sqlite", "runtime.sqlite", "message-command-ledger.sqlite"]) {
    const wal = path.join(preparedRoot, "data", `${database}-wal`);
    if (await exists(wal) && (await lstat(wal)).size !== 0) throw new Error("Prepared cohort has uncheckpointed SQLite writes");
    preparedDataNames.add(`${database}-wal`); preparedDataNames.add(`${database}-shm`);
  }
  const unexpected = (await readdir(path.join(preparedRoot, "data"))).filter((name) => !preparedDataNames.has(name));
  if (unexpected.length) throw new Error(`Prepared data contains runtime execution state; adoption refused: ${unexpected.join(", ")}`);
  const document = { schemaVersion: 1, kind: "recording-cohort-adoption", id: randomUUID(), root, contourId: contourMarker.id, preparedRoot, phase: "staging", operationId: null };
  const parent = assertContourOwnedPath(path.join(root, "cohort-adoptions"), root, { optional: true });
  await mkdir(parent, { recursive: true });
  const transactionRoot = path.join(parent, document.id); await mkdir(transactionRoot);
  const { stage, backup, displaced } = location(root, document);
  await mkdir(stage); await mkdir(backup); await mkdir(displaced);
  for (const name of components) {
    const source = path.join(preparedRoot, name);
    const before = await inventory(preparedRoot, name);
    await copyTree(source, path.join(stage, name), preparedRoot);
    if (JSON.stringify(before) !== JSON.stringify(await inventory(preparedRoot, name))
        || JSON.stringify(before) !== JSON.stringify(await inventory(stage, name))) throw new Error("Prepared cohort changed while staging");
  }
  const markerFile = path.join(stage, "recording", "recording-provider.json");
  const marker = await json(markerFile);
  const oldMapping = createContourCommandMapping({ root: path.join(preparedRoot, "recording") });
  const targetPaths = createContourOperationalPaths({ root: path.join(root, "recording"), sources: marker.sources });
  const preparationFile = path.join(stage, "contour-preparation.json");
  const preparation = await json(preparationFile);
  preparation.root = stage;
  await save(preparationFile, preparation);
  prepareContourCatalog({ databaseFile: path.join(stage, "data", "journal.sqlite"), preparedRoot: stage,
    paths: { map: (value, kind) => targetPaths.map(oldMapping.canonicalPath(value, kind), kind) } });
  marker.root = path.join(root, "recording"); await save(markerFile, marker);
  const configFile = path.join(stage, "recording", "recording-projects.json");
  const config = await json(configFile);
  config.root = marker.root; config.markerSha256 = digest(await readFile(markerFile));
  await save(configFile, config);
  preparation.root = root; preparation.recordingMarkerSha256 = config.markerSha256;
  preparation.configSha256 = digest(await readFile(configFile));
  await save(preparationFile, preparation);
  document.files = await inventory(stage);
  document.phase = "staged";
  await save(path.join(root, documentName), document);
  return document;
}

export async function activateContourAdoption(root, document, { afterRename = async () => {} } = {}) {
  const { stage, backup } = location(root, document);
  if (!["staged", "stopping"].includes(document.phase) || JSON.stringify(await inventory(stage)) !== JSON.stringify(document.files)) throw new Error("Staged cohort identity changed");
  document.old ??= {};
  for (const name of retained) {
    const source = assertContourOwnedPath(path.join(root, name), root, { optional: true });
    if (!Object.hasOwn(document.old, name) || components.includes(name)) document.old[name] = await exists(source);
    if (await exists(source)) await inventory(root, name); // Validate all sidecars and links before the first rename.
  }
  await writeContourAdoption(root, document, { phase: "switching" });
  for (const name of retained) {
    if (document.old[name]) {
      if (components.includes(name)) await rename(path.join(root, name), path.join(backup, name));
      else if (!await exists(path.join(backup, name))) await copyFile(path.join(root, name), path.join(backup, name));
      await afterRename(`backup:${name}`);
    }
    if (components.includes(name)) {
      await rename(path.join(stage, name), path.join(root, name));
      await afterRename(`install:${name}`);
    }
  }
  await writeContourAdoption(root, document, { phase: "activated" });
}

// stopRuntime removes its old state file. Snapshot these small control documents
// before stopping; SQLite/sidecars are moved only after confirmed process exit.
export async function snapshotContourAdoptionControl(root, document) {
  const { stage, backup } = location(root, document);
  if (document.phase !== "staged" || JSON.stringify(await inventory(stage)) !== JSON.stringify(document.files)) throw new Error("Staged cohort identity changed");
  document.old ??= {};
  for (const name of components) document.old[name] = await exists(assertContourOwnedPath(path.join(root, name), root, { optional: true }));
  for (const name of retained.filter((name) => !components.includes(name))) {
    const file = assertContourOwnedPath(path.join(root, name), root, { optional: true });
    document.old[name] = await exists(file);
    if (document.old[name]) {
      if (!(await lstat(file)).isFile()) throw new Error("Contour control document must be a regular file");
      await copyFile(file, path.join(backup, name));
    }
  }
  return writeContourAdoption(root, document, { phase: "stopping" });
}

// No deletion: interrupted candidate bytes and complete old components remain
// inspectable. Call only after the owner has proved its processes stopped.
export async function rollbackContourAdoption(root, document) {
  const { backup, displaced } = location(root, document);
  if (!["stopping", "switching", "rolling-back"].includes(document.phase)) throw new Error("Ambiguous launched adoption requires readiness reconciliation; rollback refused");
  if (retained.some((name) => typeof document.old?.[name] !== "boolean")) throw new Error("Incomplete adoption rollback identity");
  await writeContourAdoption(root, document, { phase: "rolling-back" });
  for (const name of retained) {
    const old = path.join(backup, name), current = path.join(root, name), saved = path.join(displaced, name);
    for (const file of [old, current, saved]) assertContourOwnedPath(file, root, { optional: true });
    if (await exists(old)) {
      if (await exists(current)) { assertContourOwnedPath(current, root); await rename(current, saved); }
      await rename(old, current);
    } else if (!document.old[name] && await exists(current)) {
      assertContourOwnedPath(current, root); await rename(current, saved);
    }
  }
  return writeContourAdoption(root, document, { phase: "rolled-back" });
}
