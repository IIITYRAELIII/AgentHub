import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { WorkspaceCatalogStore } from "../../src/infrastructure/persistence/workspace-catalog-store.mjs";
import { captureSqliteCohort, COHORT_FILES } from "../../src/runtime/sqlite-cohort-snapshot.mjs";
import { prepareRecordingContourCohort } from "../../src/runtime/test-contour-cohort-preparation.mjs";
import { activateContourAdoption, readContourAdoption, rollbackContourAdoption, snapshotContourAdoptionControl, stageContourAdoption, writeContourAdoption } from "../../src/runtime/test-contour-cohort-adoption.mjs";
import { beginTestContourOperation, transitionTestContourOperation } from "../../src/runtime/test-contour-operation-state.mjs";
import { recordingContourProfile } from "../../src/infrastructure/filesystem/test-contour-recording-profile.mjs";
import { createContourCommandMapping } from "../../src/infrastructure/filesystem/test-contour-command-mapping.mjs";
import { adoptRecordingTestContour, startTestContour } from "../../src/runtime/test-contour-manager.mjs";

const hash = async (file) => createHash("sha256").update(await readFile(file)).digest("hex");
async function fixture(t) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "hub-adoption-"));
  t.after(() => rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const source = path.join(temporary, "source"); await mkdir(source);
  const project = path.join(temporary, "original-project");
  const catalog = new WorkspaceCatalogStore({ databaseFile: path.join(source, "journal.sqlite") });
  try {
    await catalog.load();
    const workspace = catalog.createWorkspace({ name: "Original", settings: { workingDirectory: project } });
    const stream = catalog.createStream({ workspaceId: workspace.id, name: "Original stream" });
    catalog.updateStreamSettings(stream.id, { project });
    catalog.bindThread({ provider: "codex", threadId: "original-thread", streamId: stream.id, projectRoot: project });
  } finally { await catalog.close(); }
  for (const name of COHORT_FILES) {
    const db = new DatabaseSync(path.join(source, name));
    db.exec("PRAGMA journal_mode=WAL; CREATE TABLE evidence(value TEXT)");
    db.prepare("INSERT INTO evidence VALUES(?)").run(`message mentions ${project}`); db.close();
  }
  const raw = await captureSqliteCohort({ sourceDataDirectory: source, outputDirectory: path.join(temporary, "raw"), includeQueueFiles: true });
  const prepared = await prepareRecordingContourCohort({ captureManifestFile: raw.manifestFile,
    outputDirectory: path.join(temporary, "prepared"), sourceConfig: { projectRoot: project, projects: [{ name: "Original", path: project }] } });
  return { temporary, raw, prepared, project };
}
async function oldRoot(f, label, full = true) {
  const root = path.join(f.temporary, label); await mkdir(root); await mkdir(path.join(root, "data"));
  await writeFile(path.join(root, ".agent-hub-test-contour.json"), JSON.stringify({ kind: "agent-hub-test-contour", id: "stable-contour" }));
  const files = { "data/old.sqlite": "old database", "data/old.sqlite-wal": "old WAL", "data/old.sqlite-shm": "old SHM", "config.json": "{}", "current.json": '{"current":"old-release"}' };
  if (full) {
    await mkdir(path.join(root, "recording"));
    Object.assign(files, { "recording/old-profile.json": "old profile", "contour-preparation.json": "old preparation", "test-contour-source.json": "{}", "test-contour-state.json": "{}" });
  }
  for (const [file, value] of Object.entries(files)) await writeFile(path.join(root, file), value);
  return { root, files };
}

test("adoption rebase preserves source and canonical bytes, with old cohort retained", {  }, async (t) => {
  const f = await fixture(t), old = await oldRoot(f, "canonical");
  const before = await Promise.all(COHORT_FILES.map((name) => hash(path.join(f.prepared.root, "data", name))));
  const staged = await stageContourAdoption({ root: old.root, preparedRoot: f.prepared.root });
  for (const [name, value] of Object.entries(old.files)) assert.equal(await readFile(path.join(old.root, name), "utf8"), value);
  await activateContourAdoption(old.root, staged);
  await recordingContourProfile({ schemaVersion: 1, root: path.join(old.root, "recording") }, { dataDir: path.join(old.root, "data"),
    environment: { AGENT_HUB_TEST_CONTOUR: "1", AGENT_HUB_RUNTIME_ROOT: old.root } });
  const mapping = createContourCommandMapping({ root: path.join(old.root, "recording") });
  const db = new DatabaseSync(path.join(old.root, "data", "journal.sqlite"), { readOnly: true });
  try {
    assert.equal(db.prepare("SELECT project_root FROM hub_threads").get().project_root, mapping.paths.map(f.project, "project"));
    assert.equal(db.prepare("SELECT value FROM evidence").get().value, `message mentions ${f.project}`);
  } finally { db.close(); }
  assert.deepEqual(await Promise.all(COHORT_FILES.map((name) => hash(path.join(f.prepared.root, "data", name)))), before);
  for (const record of f.raw.manifest.databases) assert.equal(await hash(path.join(f.raw.dataDirectory, record.name)), record.sha256);
  for (const [name, value] of Object.entries(old.files)) assert.equal(await readFile(path.join(old.root, "cohort-adoptions", staged.id, "backup", name), "utf8"), value);
  await assert.rejects(rollbackContourAdoption(old.root, staged), /Ambiguous launched adoption/);
  await assert.rejects(startTestContour({ root: old.root }), /manual reconciliation/);
  assert.equal((await readContourAdoption(old.root)).phase, "activated");
});

test("every interrupted component rename restores old profile and DB sidecars without deleting candidate evidence", {  }, async (t) => {
  const f = await fixture(t);
  for (let stop = 1; stop <= 10; stop++) {
    const old = await oldRoot(f, `crash-${stop}`);
    const staged = await stageContourAdoption({ root: old.root, preparedRoot: f.prepared.root });
    let count = 0;
    await assert.rejects(activateContourAdoption(old.root, staged, { afterRename: async () => {
      if (++count === stop) throw new Error("simulated owner death");
    } }), /simulated owner death/);
    await rollbackContourAdoption(old.root, await readContourAdoption(old.root));
    for (const [name, value] of Object.entries(old.files)) assert.equal(await readFile(path.join(old.root, name), "utf8"), value, `${stop}: ${name}`);
    assert.equal((await readContourAdoption(old.root)).phase, "rolled-back");
    assert.equal(JSON.parse(await readFile(path.join(old.root, ".agent-hub-test-contour.json"))).id, "stable-contour");
  }
});

test("candidate preparation failure leaves canonical cohort untouched and never stops its runtime", {  }, async (t) => {
  const f = await fixture(t), old = await oldRoot(f, "preparation-failure", false);
  let stops = 0;
  await assert.rejects(adoptRecordingTestContour({ root: old.root, preparedRoot: f.prepared.root,
    prepareSource: async () => ({ sourceRoot: path.resolve(import.meta.dirname, "../.."), branch: "dev", headCommit: "new-head" }),
    prepareCandidate: async () => { throw new Error("synthetic build failed"); }, stopRuntime: async () => { stops++; },
  }), /synthetic build failed/);
  assert.equal(stops, 0);
  for (const [name, value] of Object.entries(old.files)) assert.equal(await readFile(path.join(old.root, name), "utf8"), value);
});

test("interruption after stop preserves the removed old runtime state and untouched data", {  }, async (t) => {
  const f = await fixture(t), old = await oldRoot(f, "stopped");
  const staged = await stageContourAdoption({ root: old.root, preparedRoot: f.prepared.root });
  await snapshotContourAdoptionControl(old.root, staged);
  await rm(path.join(old.root, "test-contour-state.json"));
  await rollbackContourAdoption(old.root, await readContourAdoption(old.root));
  for (const [name, value] of Object.entries(old.files)) assert.equal(await readFile(path.join(old.root, name), "utf8"), value);
});

test("an old candidate manager is rejected before any legacy contour stop", {  }, async (t) => {
  const f = await fixture(t), old = await oldRoot(f, "old-manager", false);
  const candidateSource = path.join(f.temporary, "old-source");
  await mkdir(path.join(candidateSource, "src/runtime"), { recursive: true });
  await writeFile(path.join(candidateSource, "test-contour.mjs"), "throw new Error('legacy entry must not execute');");
  await writeFile(path.join(candidateSource, "src/runtime/test-contour-manager.mjs"), "export const LEGACY = true;");
  let stops = 0;
  await assert.rejects(adoptRecordingTestContour({ root: old.root, preparedRoot: f.prepared.root,
    prepareSource: async () => ({ sourceRoot: candidateSource, branch: "dev", headCommit: "old-manager" }),
    prepareCandidate: async ({ source }) => ({ ...source, releaseId: "old-manager-release" }),
    stopRuntime: async () => { stops++; },
  }), /Candidate manager does not support/);
  assert.equal(stops, 0);
  for (const [name, value] of Object.entries(old.files)) assert.equal(await readFile(path.join(old.root, name), "utf8"), value);
});

async function bindOperation(root, adoption) {
  const operation = await beginTestContourOperation(root, { kind: "refresh",
    source: { branch: "dev", sourceRoot: path.resolve(import.meta.dirname, "../.."), headCommit: "adoption-A" },
    target: { root, contourId: "stable-contour", port: 8877, model: "fake-codex" } });
  await transitionTestContourOperation(root, { ...operation, phase: "prepared", patch: { releaseId: "release-A" } });
  await writeContourAdoption(root, adoption, { operationId: operation.operationId, releaseId: "release-A" });
  return operation;
}

test("same-operation stop interruption recovers before resolving a new source", {  }, async (t) => {
  const f = await fixture(t), old = await oldRoot(f, "same-operation", false);
  await writeFile(path.join(old.root, "test-contour-state.json"), "{}");
  const adoption = await stageContourAdoption({ root: old.root, preparedRoot: f.prepared.root });
  await bindOperation(old.root, adoption);
  await snapshotContourAdoptionControl(old.root, adoption);
  await rm(path.join(old.root, "test-contour-state.json"));
  await assert.rejects(startTestContour({ root: old.root, prepareSource: async () => { throw new Error("reached source after recovery"); } }), /reached source after recovery/);
  assert.equal((await readContourAdoption(old.root)).phase, "rolled-back");
  assert.equal(await readFile(path.join(old.root, "test-contour-state.json"), "utf8"), "{}");
  for (const [name, value] of Object.entries(old.files)) assert.equal(await readFile(path.join(old.root, name), "utf8"), value);
});

test("stale adoption A cannot stop a live later operation B or rename its data", {  }, async (t) => {
  const f = await fixture(t), old = await oldRoot(f, "superseded", false);
  const adoption = await stageContourAdoption({ root: old.root, preparedRoot: f.prepared.root });
  const a = await bindOperation(old.root, adoption);
  await snapshotContourAdoptionControl(old.root, adoption);
  await transitionTestContourOperation(old.root, { ...a, phase: "failed", status: "failed" });
  const b = await beginTestContourOperation(old.root, { kind: "refresh",
    source: { branch: "dev", sourceRoot: path.resolve(import.meta.dirname, "../.."), headCommit: "later-B" },
    target: { root: old.root, contourId: "stable-contour", port: 8877, model: "fake-codex" } });
  await transitionTestContourOperation(old.root, { ...b, phase: "ready", status: "ready", patch: { releaseId: "release-B" } });
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true });
  await once(child, "spawn");
  try {
    await writeFile(path.join(old.root, "test-contour-state.json"), JSON.stringify({ managerPid: child.pid, runtimePid: child.pid, operationId: b.operationId, releaseId: "release-B" }));
    await writeFile(path.join(old.root, "data", "later-B"), "B owns this cohort");
    const files = ["test-contour-state.json", "test-contour-operation.json", "test-contour-adoption.json", "current.json", "data/later-B", "data/old.sqlite"];
    const operationFile = path.join(old.root, "test-contour-operation.json");
    const journal = JSON.parse(await readFile(operationFile));
    for (const mismatch of ["operation", "root", "contour"]) {
      const changed = structuredClone(journal);
      if (mismatch !== "operation") {
        changed.current.operationId = a.operationId;
        changed.current.phase = "stopping"; changed.current.status = "running";
        if (mismatch === "root") changed.current.target.root = path.join(f.temporary, "different-root");
        else changed.current.target.contourId = "different-contour";
      }
      await writeFile(operationFile, JSON.stringify(changed));
      const hashes = await Promise.all(files.map((name) => hash(path.join(old.root, name))));
      await assert.rejects(startTestContour({ root: old.root, refresh: true }), /operation identity was superseded/);
      assert.equal(child.exitCode, null); assert.equal(child.signalCode, null);
      assert.deepEqual(await Promise.all(files.map((name) => hash(path.join(old.root, name)))), hashes);
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) { const exit = once(child, "exit"); child.kill(); await exit; }
  }
});
