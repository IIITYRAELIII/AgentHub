import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ReleaseOperationStore } from "../../../src/infrastructure/persistence/release-operation-store.mjs";

function input(overrides = {}) {
  return {
    operationId: "release-1",
    requestId: "request-1",
    workspaceId: "workspace-1",
    streamId: "stream-1",
    threadId: "thread-1",
    authorization: {
      taskIds: ["task-1"],
      approvedTargets: [{ id: "production", kind: "git-runtime" }],
      validationMode: "full",
    },
    runnerVersion: "runner-1",
    ...overrides,
  };
}

test("release operation store persists one owner, immutable generations, receipts and outbox", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-release-operation-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  let clock = Date.parse("2026-09-22T00:00:00.000Z");
  const store = new ReleaseOperationStore({
    dataDir: directory,
    now: () => new Date(clock += 1_000).toISOString(),
  });
  const created = store.create(input());
  assert.equal(created.created, true);
  assert.equal(store.create(input()).created, false);
  assert.throws(() => store.create(input({ runnerVersion: "runner-2" })), /identity conflict/u);

  const acquired = store.acquire("release-1", "worker-1", { leaseMs: 5_000 });
  assert.equal(acquired.acquired, true);
  assert.equal(store.acquire("release-1", "worker-2", { leaseMs: 5_000 }).reason, "owned");
  store.heartbeat("release-1", "worker-1", { leaseMs: 5_000 });
  store.release("release-1", "worker-1");
  assert.equal(store.pendingEvents().length, 1, "lease bookkeeping does not create user-facing outbox events");
  assert.equal(store.acquire("release-1", "worker-1", { leaseMs: 5_000 }).acquired, true);
  const generation = store.putGeneration({
    operationId: "release-1", generation: 1,
    repositoryBases: [{ repositoryRoot: "C:/repo", baseCommit: "a".repeat(40) }],
    selectedResults: [{ taskId: "task-1", resultCommit: "b".repeat(40), tree: "c".repeat(40), acceptanceRevision: 2 }],
    candidates: [{ repositoryRoot: "C:/repo", releaseRoot: "C:/release/g1", commit: "d".repeat(40), tree: "e".repeat(40), manifestHash: "f".repeat(64) }],
    runnerVersion: "runner-1",
  }).generation;
  assert.equal(store.putGeneration(generation).created, false);
  assert.throws(() => store.putGeneration({ ...generation, candidates: [{ ...generation.candidates[0], tree: "0".repeat(40) }] }), /immutable/u);

  const intent = store.beginStep({ operationId: "release-1", generation: 1, stepId: "publish", input: { target: "production" } }).receipt;
  assert.equal(store.beginStep({ operationId: "release-1", generation: 1, stepId: "publish", input: { target: "production" } }).created, false);
  store.finishStep(intent, { status: "unknown", reconcileCursor: { revision: "d".repeat(40) } });
  assert.equal(store.latestStep("release-1", 1, "publish").status, "unknown");

  const current = store.get("release-1");
  const transitioned = store.transition("release-1", {
    state: "waiting", currentStep: "publish", resumeState: "publish",
    waitReason: { code: "effect_readback", retryAt: "2026-09-22T00:00:02.000Z" },
  }, { expectedRevision: current.revision, eventKind: "operation.waiting" });
  assert.equal(transitioned.applied, true);
  assert.equal(store.snapshot("release-1").generations.length, 1);
  assert.equal(store.snapshot("release-1").receipts.length, 1);
  assert.ok(store.pendingEvents().some((event) => event.eventKind === "operation.waiting"));
  assert.equal(store.forTask("task-1")[0].operationId, "release-1");
});

test("legacy states import once into finite operation outcomes without becoming writers", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-release-import-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const store = new ReleaseOperationStore({ dataDir: directory });
  const common = {
    workspaceId: "workspace-1", streamId: "stream-1", threadId: "thread-1",
    sourceKind: "publication-status-v2",
    authorization: {
      taskIds: ["task-1"], approvedTargets: [{ id: "production", kind: "git-runtime" }], validationMode: "full",
    },
    runnerVersion: "runner-1",
  };
  const frozen = store.importLegacy({ ...common, sourceIdentity: "frozen-1", evidence: { phase: "frozen" } });
  assert.equal(frozen.operation.state, "validate");
  const published = store.importLegacy({ ...common, sourceIdentity: "published-1", evidence: { status: "published" } });
  assert.equal(published.operation.state, "finalize");
  const unknown = store.importLegacy({ ...common, sourceIdentity: "unknown-1", evidence: { status: "unknown" } });
  assert.equal(unknown.operation.waitReason.code, "external_effect_readback");
  assert.equal(store.importLegacy({ ...common, sourceIdentity: "unknown-1", evidence: { status: "unknown" } }).created, false);
  assert.throws(() => store.importLegacy({ ...common, sourceIdentity: "unknown-1", evidence: { status: "published" } }), /evidence changed|identity conflict/u);
});
