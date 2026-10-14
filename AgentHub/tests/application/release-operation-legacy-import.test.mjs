import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { importLegacyReleaseOperations } from "../../src/infrastructure/persistence/release-operation-legacy-import.mjs";
import { ReleaseOperationStore } from "../../src/infrastructure/persistence/release-operation-store.mjs";
import { DatabaseSync } from "node:sqlite";

async function fixture(context) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "release-operation-legacy-import-"));
  context.after(() => rm(dataDir, { recursive: true, force: true }));
  const repositoryKey = "repository-a";
  const root = path.join(dataDir, "release-repositories", repositoryKey);
  const releaseRoot = path.join(root, "repository");
  const evidenceRoot = path.join(root, "evidence");
  await mkdir(evidenceRoot, { recursive: true });
  const manifest = {
    schemaVersion: 2,
    workspaceId: "workspace-a",
    primaryRoot: path.join(dataDir, "primary"),
    releaseRoot,
    baseCommit: "a".repeat(40),
    tasks: [
      { taskId: "task-a", resultCommit: "b".repeat(40), resultReleaseRevision: 7 },
      { taskId: "task-b", resultCommit: "c".repeat(40), resultReleaseRevision: 9 },
    ],
  };
  const bytes = Buffer.from(JSON.stringify(manifest));
  const manifestHash = createHash("sha256").update(bytes).digest("hex");
  await writeFile(path.join(evidenceRoot, `${manifestHash}.json`), bytes);
  const checkpoint = {
    schemaVersion: 2,
    phase: "frozen",
    manifestHash,
    baseCommit: manifest.baseCommit,
    preReleaseHead: "d".repeat(40),
  };
  await writeFile(path.join(root, "checkpoint.json"), JSON.stringify(checkpoint));
  return { dataDir, releaseRoot, checkpoint, manifest, manifestHash };
}

test("post-import primary proof preserves orphan evidence, generation and events byte-for-byte", async (context) => {
  const setup = await fixture(context);
  const store = new ReleaseOperationStore({ dataDir: setup.dataDir });
  const options = { store, dataDir: setup.dataDir, runnerVersion: "runner-n",
    readStatus: async () => null, resolveTree: async () => "e".repeat(40) };
  const first = await importLegacyReleaseOperations(options);
  const operationId = first.imported[0].operationId;
  const original = store.snapshot(operationId);
  const rows = () => {
    const db = new DatabaseSync(path.join(setup.dataDir, "runtime.sqlite"), { readOnly: true });
    try { return ["release_operations", "release_candidate_generations", "release_legacy_evidence", "release_operation_events"]
      .map((table) => db.prepare(`SELECT * FROM ${table}`).all()); } finally { db.close(); }
  };
  const before = rows();
  const checkpointFile = path.join(setup.releaseRoot, "..", "checkpoint.json");
  const changed = JSON.stringify({ ...setup.checkpoint,
    primarySynchronizationProof: { operationId: "sync-exact", proofHash: "f".repeat(64) } });
  await writeFile(checkpointFile, changed);
  const replay = await importLegacyReleaseOperations({ ...options, runnerVersion: "runner-new" });
  assert.equal(replay.imported[0].created, false);
  assert.deepEqual(store.snapshot(operationId), original);
  assert.deepEqual(rows(), before);
  assert.equal(await readFile(checkpointFile, "utf8"), changed);
  assert.equal(original.operation.resumeState, null);
  assert.equal(original.operation.waitReason.retryAt, undefined);
  await writeFile(checkpointFile, JSON.stringify({ ...JSON.parse(changed), phase: "changed" }));
  assert.equal((await importLegacyReleaseOperations(options)).skipped[0].code, "RELEASE_LEGACY_EVIDENCE_CHANGED");
  assert.deepEqual(rows(), before);
});

test("proof already present at first import remains exact evidence on replay", async (context) => {
  const setup = await fixture(context);
  const checkpointFile = path.join(setup.releaseRoot, "..", "checkpoint.json");
  const checkpoint = { ...setup.checkpoint, primarySynchronizationProof: { proofHash: "a".repeat(64) } };
  await writeFile(checkpointFile, JSON.stringify(checkpoint));
  const store = new ReleaseOperationStore({ dataDir: setup.dataDir });
  const options = { store, dataDir: setup.dataDir, runnerVersion: "runner-n",
    readStatus: async () => null, resolveTree: async () => "e".repeat(40) };
  const first = await importLegacyReleaseOperations(options);
  const original = store.snapshot(first.imported[0].operationId);
  await importLegacyReleaseOperations(options);
  assert.deepEqual(store.snapshot(first.imported[0].operationId), original);
  await writeFile(checkpointFile, JSON.stringify({ ...checkpoint,
    primarySynchronizationProof: { proofHash: "b".repeat(64) } }));
  assert.equal((await importLegacyReleaseOperations(options)).skipped[0].code, "RELEASE_LEGACY_EVIDENCE_CHANGED");
});

test("primary proof cannot relax an authoritative publication evidence guard", async (context) => {
  const setup = await fixture(context);
  const store = new ReleaseOperationStore({ dataDir: setup.dataDir });
  const status = { version: 2, runId: "publication", status: "awaiting_finalization",
    identity: { revision: setup.checkpoint.preReleaseHead, worktreeRoot: setup.releaseRoot } };
  const options = { store, dataDir: setup.dataDir, runnerVersion: "runner-n",
    readStatus: async () => status, resolveTree: async () => "e".repeat(40) };
  const first = await importLegacyReleaseOperations(options);
  const original = store.snapshot(first.imported[0].operationId);
  await writeFile(path.join(setup.releaseRoot, "..", "checkpoint.json"), JSON.stringify({
    ...setup.checkpoint, primarySynchronizationProof: { proofHash: "f".repeat(64) } }));
  assert.equal((await importLegacyReleaseOperations(options)).skipped[0].code, "RELEASE_LEGACY_EVIDENCE_CHANGED");
  assert.deepEqual(store.snapshot(first.imported[0].operationId), original);
});

test("startup migration activates only a matching publication and preserves exact generation evidence", async (context) => {
  const setup = await fixture(context);
  const store = new ReleaseOperationStore({ dataDir: setup.dataDir });
  const status = {
    version: 2,
    runId: "legacy-run",
    status: "awaiting_finalization",
    identity: {
      revision: setup.checkpoint.preReleaseHead,
      worktreeRoot: setup.releaseRoot,
      release: { workspaceId: "workspace-a" },
    },
  };
  const first = await importLegacyReleaseOperations({
    store,
    dataDir: setup.dataDir,
    runnerVersion: "runner-n",
    readStatus: async () => status,
    resolveTree: async () => "e".repeat(40),
  });
  const originalSnapshot = store.snapshot(first.imported[0].operationId);
  const replay = await importLegacyReleaseOperations({
    store,
    dataDir: setup.dataDir,
    runnerVersion: "runner-n-plus-one",
    readStatus: async () => status,
    resolveTree: async () => "e".repeat(40),
  });
  assert.equal(first.imported[0].created, true);
  assert.equal(replay.imported[0].created, false);
  const snapshot = store.snapshot(first.imported[0].operationId);
  assert.deepEqual(snapshot, originalSnapshot, "a newer runtime does not rewrite imported operation or generation identity");
  assert.equal(snapshot.operation.runnerVersion, "runner-n");
  assert.equal(snapshot.generations[0].runnerVersion, "runner-n");
  assert.equal(snapshot.operation.state, "finalize");
  assert.equal(snapshot.operation.currentGeneration, 1);
  assert.deepEqual(snapshot.generations[0].selectedResults.map((item) => item.taskId), ["task-a", "task-b"]);
  assert.equal(snapshot.generations[0].candidates[0].manifestHash, setup.manifestHash);
});

test("orphan legacy checkpoint is evidence-only and cannot publish on recovery", async (context) => {
  const setup = await fixture(context);
  const store = new ReleaseOperationStore({ dataDir: setup.dataDir });
  const result = await importLegacyReleaseOperations({
    store,
    dataDir: setup.dataDir,
    runnerVersion: "runner-n",
    readStatus: async () => null,
    resolveTree: async () => "e".repeat(40),
  });
  const snapshot = store.snapshot(result.imported[0].operationId);
  assert.equal(snapshot.operation.state, "waiting");
  assert.equal(snapshot.operation.waitReason.code, "legacy_snapshot_evidence");
  assert.equal(snapshot.operation.waitReason.retryAt, undefined);
  assert.equal(snapshot.generations.length, 1);
});

test("matching succeeded publication imports as terminal history", async (context) => {
  const setup = await fixture(context);
  const store = new ReleaseOperationStore({ dataDir: setup.dataDir });
  const status = {
    version: 2,
    runId: "legacy-complete",
    status: "succeeded",
    identity: {
      revision: setup.checkpoint.preReleaseHead,
      worktreeRoot: setup.releaseRoot,
      release: { workspaceId: "workspace-a" },
    },
  };
  const result = await importLegacyReleaseOperations({
    store,
    dataDir: setup.dataDir,
    runnerVersion: "runner-n",
    readStatus: async () => status,
    resolveTree: async () => "e".repeat(40),
  });
  const snapshot = store.snapshot(result.imported[0].operationId);
  assert.equal(snapshot.operation.state, "done");
  assert.equal(snapshot.operation.migration.evidenceOnly, false);
});

test("unavailable historical entries are diagnosed separately and a valid entry still imports", async t => {
  const f = await fixture(t), diagnostics = [];
  const badRoot = path.join(f.dataDir, "release-repositories", "bad-json");
  await mkdir(badRoot, { recursive: true });
  await writeFile(path.join(badRoot, "checkpoint.json"), "{broken");
  const store = new ReleaseOperationStore({ dataDir: f.dataDir });
  const options = { store, dataDir: f.dataDir, runnerVersion: "runner", readStatus: async () => null,
    resolveTree: async () => "e".repeat(40), reportDiagnostic: diagnostic => diagnostics.push(diagnostic) };
  const result = await importLegacyReleaseOperations(options);
  assert.equal(result.imported.length, 1);
  assert.equal(diagnostics[0].repositoryKey, "bad-json");
  assert.equal(diagnostics[0].code, "INVALID_JSON");
  const original = store.snapshot(result.imported[0].operationId);
  const missing = await importLegacyReleaseOperations({ ...options, resolveTree: async () => { throw new Error("old Git object absent"); } });
  assert.equal(missing.imported.length, 0);
  assert.equal(missing.skipped.find(entry => entry.repositoryKey === "repository-a").code, "RELEASE_LEGACY_GIT_UNAVAILABLE");
  assert.deepEqual(store.snapshot(original.operation.operationId), original);
  assert.equal(original.operation.waitReason.code, "legacy_snapshot_evidence");
  await assert.rejects(importLegacyReleaseOperations({ ...options,
    store: { importLegacy: () => { throw Object.assign(new Error("database unavailable"), { code: "SQLITE_BUSY" }); } } }),
    { code: "SQLITE_BUSY" });
});
