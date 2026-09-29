import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { importLegacyReleaseOperations } from "../../src/infrastructure/persistence/release-operation-legacy-import.mjs";
import { ReleaseOperationStore } from "../../src/infrastructure/persistence/release-operation-store.mjs";

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
