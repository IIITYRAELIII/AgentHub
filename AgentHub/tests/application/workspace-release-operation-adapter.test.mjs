import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { WorkspaceReleaseOperationAdapter } from "../../src/application/workspace-release-operation-adapter.mjs";

function fixture(selection) {
  const calls = [];
  const adapter = new WorkspaceReleaseOperationAdapter({
    releasePreflight: {
      prepareOperationGeneration: async () => ({ releaseCandidates: [], planRevision: "plan" }),
      discardOperationGeneration: async (generation) => { calls.push(["cleanup", generation]); return []; },
      validateOperationGeneration: async () => ({ status: "ready" }),
      operationSelection: async (input) => { calls.push(["selection", input]); return selection; },
      withAwaitTransition: async (workspaceId, operation) => {
        calls.push(["lock", workspaceId]);
        return operation();
      },
    },
    publication: { publish: async () => null, readback: async () => null },
    finalization: { finalize: async () => null },
  });
  return { adapter, calls };
}

test("publication reservation uses the Workspace Await boundary for the exact generation", async () => {
  const selectedResults = [
    { taskId: "task-b", resultCommit: "result-b", acceptanceRevision: 3 },
    { taskId: "task-a", resultCommit: "result-a", acceptanceRevision: 2 },
  ];
  const f = fixture(selectedResults.toReversed());
  const effects = [];
  const result = await f.adapter.reservePublication({
    operation: {
      workspaceId: "workspace-1",
      authorization: { taskIds: ["task-a", "task-b"] },
    },
    generation: { selectedResults },
    reserve: () => { effects.push("reserve"); return { applied: true }; },
    recompose: () => { effects.push("recompose"); return { applied: true }; },
  });
  assert.equal(result.applied, true);
  assert.deepEqual(effects, ["reserve"]);
  assert.deepEqual(f.calls, [
    ["lock", "workspace-1"],
    ["selection", { workspaceId: "workspace-1", taskIds: ["task-a", "task-b"] }],
  ]);
});

test("terminal operation cleanup delegates only the persisted immutable generation", async () => {
  const f = fixture([]);
  const generation = { operationId: "operation-1", generation: 2, candidates: [] };
  assert.deepEqual(await f.adapter.cleanupGeneration({ generation }), []);
  assert.deepEqual(f.calls, [["cleanup", generation]]);
});

test("publication reservation recomposes when accepted result identity changed", async () => {
  const f = fixture([{ taskId: "task-a", resultCommit: "result-2", acceptanceRevision: 3 }]);
  const effects = [];
  await f.adapter.reservePublication({
    operation: { workspaceId: "workspace-1", authorization: { taskIds: ["task-a"] } },
    generation: {
      selectedResults: [{ taskId: "task-a", resultCommit: "result-1", acceptanceRevision: 2 }],
    },
    reserve: () => { effects.push("reserve"); return { applied: true }; },
    recompose: () => { effects.push("recompose"); return { applied: true }; },
  });
  assert.deepEqual(effects, ["recompose"]);
});

test("composition replays exact referenced release metadata and rejects changed bytes", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "release-operation-metadata-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourcePath = path.join(root, "CHANGELOG.md");
  const bytes = Buffer.from("release notes\r\n", "utf8");
  await writeFile(sourcePath, bytes);
  const releaseMetadata = {
    sourcePath,
    byteLength: bytes.length,
    rawSha256: createHash("sha256").update(bytes).digest("hex"),
    canonicalSha256: createHash("sha256").update("release notes\n").digest("hex"),
  };
  const calls = [];
  const adapter = new WorkspaceReleaseOperationAdapter({
    releasePreflight: {
      prepareOperationGeneration: async (input) => {
        calls.push(input);
        return { releaseCandidates: [], planRevision: "plan" };
      },
      validateOperationGeneration: async () => ({ status: "ready" }),
      operationSelection: async () => [],
      withAwaitTransition: async (_workspaceId, operation) => operation(),
    },
    publication: { publish: async () => null, readback: async () => null },
    finalization: { finalize: async () => null },
  });
  const operation = {
    operationId: "operation-metadata",
    workspaceId: "workspace",
    selectedResults: [],
    authorization: {
      taskIds: ["task-a"], approvedTargets: [], fingerprint: "fingerprint", releaseMetadata,
    },
  };
  await adapter.compose({ operation, generation: 1 });
  assert.deepEqual(calls[0].changelogContent, bytes);
  await writeFile(sourcePath, "changed\n", "utf8");
  await assert.rejects(adapter.compose({ operation, generation: 2 }), /metadata artifact identity changed/u);
});

test("composition reads only the effective amended release notes and detects byte drift before preparing", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "release-amended-metadata-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const originalFile = path.join(root, "original.md"), amendedFile = path.join(root, "amended.md");
  const original = Buffer.from("original notes\r\n"), amended = Buffer.from("notes for all selected Tasks\r\n");
  await writeFile(originalFile, original); await writeFile(amendedFile, amended);
  const metadata = (sourcePath, bytes) => ({ sourcePath, byteLength: bytes.length,
    rawSha256: createHash("sha256").update(bytes).digest("hex"),
    canonicalSha256: createHash("sha256").update(bytes.toString("utf8").replace(/\r\n/gu, "\n")).digest("hex") });
  const calls = [];
  const adapter = fixture([]).adapter;
  adapter.releasePreflight.prepareOperationGeneration = async input => { calls.push(input); return { releaseCandidates: [], planRevision: "plan" }; };
  const operation = { operationId: "same-original", workspaceId: "workspace", selectedResults: [],
    authorization: { taskIds: ["task-a"], approvedTargets: [], fingerprint: "original", releaseMetadata: metadata(originalFile, original) },
    testSelectionAmendments: [{ taskIds: ["task-a", "task-b"], releaseMetadata: metadata(amendedFile, amended) }, { taskIds: ["task-a", "task-b"] }] };
  const authorization = structuredClone(operation.authorization);
  await adapter.compose({ operation, generation: 2 });
  assert.deepEqual(calls[0].changelogContent, amended);
  assert.deepEqual(calls[0].taskIds, ["task-a", "task-b"]);
  assert.deepEqual(operation.authorization, authorization);
  await writeFile(amendedFile, "different bytes");
  await assert.rejects(adapter.compose({ operation, generation: 3 }), /metadata artifact identity changed/);
  assert.equal(calls.length, 1, "no preparation after a changed payload");
});
