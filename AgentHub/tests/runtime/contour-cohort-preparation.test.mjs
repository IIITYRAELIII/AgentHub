import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { WorkspaceCatalogStore } from "../../src/infrastructure/persistence/workspace-catalog-store.mjs";
import { captureSqliteCohort, COHORT_FILES } from "../../src/runtime/sqlite-cohort-snapshot.mjs";
import { prepareRecordingContourCohort } from "../../src/runtime/test-contour-cohort-preparation.mjs";
import { createContourCommandMapping } from "../../src/infrastructure/filesystem/test-contour-command-mapping.mjs";
import { recordingContourProfile } from "../../src/infrastructure/filesystem/test-contour-recording-profile.mjs";
import { recordingAcceptanceMarker, releaseAcceptanceConfig } from "../../src/runtime/test-contour-release-acceptance.mjs";

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "hub-cohort-prepare-"));
  const writers = [];
  t.after(async () => { writers.forEach((db) => db.close()); await rm(root, { recursive: true, force: true, maxRetries: 100, retryDelay: 50 }); });
  const sourceDataDirectory = path.join(root, "source");
  await mkdir(sourceDataDirectory);
  const projects = ["one", "two"].map((name) => ({ name, path: path.join(root, "canonical", name) }));
  const catalog = new WorkspaceCatalogStore({ databaseFile: path.join(sourceDataDirectory, "journal.sqlite") });
  let binding;
  try {
    await catalog.load();
    const workspace = catalog.createWorkspace({ name: "workspace", settings: { workingDirectory: projects[0].path } });
    const stream = catalog.createStream({ workspaceId: workspace.id, name: "stream" });
    catalog.updateStreamSettings(stream.id, { project: projects[0].path });
    binding = { provider: "codex", threadId: "canonical-thread", streamId: stream.id, projectRoot: projects[0].path };
    catalog.bindThread(binding);
  } finally { catalog.close(); }
  for (const name of COHORT_FILES) {
    const db = new DatabaseSync(path.join(sourceDataDirectory, name));
    writers.push(db);
    db.exec("PRAGMA journal_mode=WAL; CREATE TABLE evidence(value TEXT)");
    db.prepare("INSERT INTO evidence VALUES(?)").run(`literal ${projects[0].path}`);
  }
  await mkdir(path.join(sourceDataDirectory, "delivery-outbox"));
  const queueBytes = Buffer.from('{"deliveryId":"original","idempotencyKey":"unchanged","attempts":2}\n');
  await writeFile(path.join(sourceDataDirectory, "delivery-outbox", "original.json"), queueBytes);
  const raw = await captureSqliteCohort({ sourceDataDirectory, outputDirectory: path.join(root, "raw"), includeQueueFiles: true });
  return { root, raw, projects, queueBytes, binding,
    options: { captureManifestFile: raw.manifestFile, outputDirectory: path.join(root, "prepared"), sourceConfig: { projects, projectRoot: projects[0].path } } };
}

test("preparation keeps raw evidence, queue bytes and canonical identities while mapping only catalog fields", async (t) => {
  const f = await fixture(t);
  const result = await prepareRecordingContourCohort(f.options);
  const mapping = createContourCommandMapping({ root: result.recording.root });
  assert.equal(result.manifest.phase, "prepared");
  assert.equal(result.manifest.bootable, false);
  assert.deepEqual(await readFile(path.join(result.root, "data", "delivery-outbox", "original.json")), f.queueBytes);
  for (const record of f.raw.manifest.databases) {
    assert.equal(digest(await readFile(path.join(f.raw.dataDirectory, record.name))), record.sha256);
    if (record.name !== "journal.sqlite") assert.equal(digest(await readFile(path.join(result.root, "data", record.name))), record.sha256);
  }
  const db = new DatabaseSync(path.join(result.root, "data", "journal.sqlite"), { readOnly: true });
  try {
    const thread = db.prepare("SELECT provider_thread_id, stream_id, project_root FROM hub_threads").get();
    assert.equal(thread.provider_thread_id, f.binding.threadId);
    assert.equal(thread.stream_id, f.binding.streamId);
    assert.equal(thread.project_root, mapping.paths.map(f.projects[0].path, "project"));
    assert.equal(db.prepare("SELECT value FROM evidence").get().value, `literal ${f.projects[0].path}`);
  } finally { db.close(); }
  assert.deepEqual(result.recording.projects, f.projects.map((project) => ({ ...project, path: mapping.paths.map(project.path, "project") })));
  const descriptor = await readFile(path.join(result.recording.root, "recording-projects.json"), "utf8");
  assert.equal(digest(descriptor), result.manifest.configSha256);
  const environment = { AGENT_HUB_TEST_CONTOUR: "1", AGENT_HUB_RUNTIME_ROOT: result.root };
  assert.deepEqual(await recordingContourProfile({ schemaVersion: 1, root: result.recording.root }, {
    dataDir: path.join(result.root, "data"), environment,
  }), { schemaVersion: 1, root: result.recording.root });
  await writeFile(path.join(result.recording.root, "recording-projects.json"), descriptor + " ");
  await assert.rejects(recordingContourProfile({ schemaVersion: 1, root: result.recording.root }, {
    dataDir: path.join(result.root, "data"), environment,
  }), { code: "CONTOUR_RECORDING_BOOT_NOT_READY" });
});

test("preparation refuses changed raw bytes without publishing a prepared cohort", async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.raw.root, "queue-files", "delivery-outbox", "original.json"), "changed");
  let failure;
  await assert.rejects(prepareRecordingContourCohort(f.options), (error) => { failure = error; return /Captured file changed/.test(error.message); });
  const manifest = JSON.parse(await readFile(failure.manifestFile, "utf8"));
  assert.equal(manifest.phase, "failed"); assert.equal(manifest.bootable, false);
});

test("Windows recording marker binds the exact fresh cohort and persistent configuration", async (t) => {
  const f = await fixture(t);
  const prepared = await prepareRecordingContourCohort(f.options);
  const config = releaseAcceptanceConfig({ root: prepared.root, recording: prepared.recording, telegramApiBaseUrl: "http://127.0.0.1:1234" });
  const configBytes = JSON.stringify(config);
  await writeFile(path.join(prepared.root, "config.json"), configBytes);
  const marker = await recordingAcceptanceMarker({ root: prepared.root, id: "exact-acceptance" });
  assert.equal(marker.schemaVersion, 2);
  assert.equal(marker.profile, "recording");
  assert.equal(marker.recordingRoot, prepared.recording.root);
  assert.equal(marker.recordingMarkerSha256, prepared.manifest.recordingMarkerSha256);
  assert.equal(marker.projectConfigurationSha256, prepared.manifest.configSha256);
  assert.equal(marker.preparationSha256, digest(await readFile(prepared.manifestFile)));
  assert.equal(marker.configSha256, digest(configBytes));
  const original = await readFile(path.join(prepared.recording.root, "recording-projects.json"));
  await writeFile(path.join(prepared.recording.root, "recording-projects.json"), Buffer.concat([original, Buffer.from(" ")]));
  await assert.rejects(recordingAcceptanceMarker({ root: prepared.root, id: "changed" }), /configuration changed/);
  for (const record of f.raw.manifest.databases) assert.equal(digest(await readFile(path.join(f.raw.dataDirectory, record.name))), record.sha256);
});

test("missing queue evidence and raw-output overlap fail before preparation", async (t) => {
  const f = await fixture(t);
  await assert.rejects(prepareRecordingContourCohort({ ...f.options, outputDirectory: path.join(f.raw.root, "nested") }), /cannot overlap/);
  const raw = structuredClone(f.raw.manifest); delete raw.queueFiles;
  await writeFile(f.raw.manifestFile, JSON.stringify(raw));
  await assert.rejects(prepareRecordingContourCohort(f.options), /complete raw SQLite and queue cohort/);
});
