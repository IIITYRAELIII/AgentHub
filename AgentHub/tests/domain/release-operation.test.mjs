import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  createCandidateGeneration,
  createReleaseOperation,
  RELEASE_OPERATION_STATES,
  restoreReleaseOperation,
  reviewedMainBinding,
  transitionReleaseOperation,
} from "../../src/domain/release-operation.mjs";

function operation(overrides = {}) {
  return createReleaseOperation({
    operationId: "release-1",
    requestId: "request-1",
    workspaceId: "workspace-1",
    streamId: "stream-1",
    threadId: "thread-1",
    authorization: {
      taskIds: ["task-2", "task-1"],
      approvedTargets: [{ id: "production", kind: "git-runtime" }],
      validationMode: "full",
    },
    runnerVersion: "runner-1",
    createdAt: "2026-09-22T00:00:00.000Z",
    ...overrides,
  });
}

test("reviewed main accepts complete large repository membership and refuses foreign or duplicate inputs", () => {
  const targets = Array.from({ length: 33 }, (_, index) => ({
    targetId: `original-${index}`, kind: "agent-hub-publication", repositoryRoot: `/synthetic-original-${index}`,
  }));
  const approvedRepositories = targets.map(target => ({ projectRoot: target.repositoryRoot,
    approvedLocalMainCommit: "a".repeat(40), approvedOriginMainCommit: "b".repeat(40) }));
  const original = { authorization: { approvedTargets: targets } };
  const before = structuredClone(original);
  const input = { expectedRevision: 735, approvedRepositories };
  assert.equal(reviewedMainBinding(original, input).approvedRepositories.length, 33);
  assert.throws(() => reviewedMainBinding(original, { ...input,
    approvedRepositories: approvedRepositories.slice(1) }), /cover every original repository/u);
  assert.throws(() => reviewedMainBinding(original, { ...input,
    approvedRepositories: [...approvedRepositories.slice(1), approvedRepositories[1]] }), /foreign or duplicated/u);
  assert.throws(() => reviewedMainBinding(original, { ...input,
    approvedRepositories: [{ ...approvedRepositories[0], projectRoot: "/foreign" }, ...approvedRepositories.slice(1)] }), /foreign or duplicated/u);
  assert.throws(() => reviewedMainBinding(original, { ...input,
    approvedRepositories: [{ ...approvedRepositories[0], approvedLocalMainCommit: "bad" }, ...approvedRepositories.slice(1)] }), /commit/u);
  assert.deepEqual(original, before);
});

test("release operation keeps authorization immutable and uses explicit waiting resume state", () => {
  const created = operation();
  assert.deepEqual(created.authorization.taskIds, ["task-1", "task-2"]);
  const waiting = transitionReleaseOperation(created, {
    state: RELEASE_OPERATION_STATES.WAITING,
    currentStep: "validate",
    resumeState: "compose",
    waitReason: { code: "validation_failed", message: "contract failed" },
    nextAction: "accept a corrected selected result",
  }, { updatedAt: "2026-09-22T00:00:01.000Z" });
  assert.equal(waiting.applied, true);
  assert.equal(waiting.operation.waitReason.code, "validation_failed");
  const resumed = transitionReleaseOperation(waiting.operation, {
    state: RELEASE_OPERATION_STATES.COMPOSE,
    currentStep: "compose",
  }, { updatedAt: "2026-09-22T00:00:02.000Z" });
  assert.equal(resumed.applied, true);
  assert.equal(resumed.operation.waitReason, null);
  assert.equal(resumed.operation.resumeState, null);
  assert.throws(() => transitionReleaseOperation(resumed.operation, {
    authorization: { ...resumed.operation.authorization, taskIds: ["task-3"] },
  }), /authorization is immutable/u);
});

test("release operation preserves repository-scale release metadata bytes and exact digests", () => {
  const bytes = Buffer.alloc(9 * 1024 * 1024, 0x61);
  const rawSha256 = createHash("sha256").update(bytes).digest("hex");
  const created = operation({
    authorization: {
      taskIds: ["task-1"],
      approvedTargets: [{ id: "production", kind: "git-runtime" }],
      validationMode: "full",
      releaseMetadata: {
        sourcePath: "C:/owned/release/CHANGELOG.md",
        byteLength: bytes.length,
        rawSha256,
        canonicalSha256: rawSha256,
      },
    },
  });
  assert.equal(created.authorization.releaseMetadata.byteLength, bytes.length);
  assert.equal(created.authorization.releaseMetadata.sourcePath, "C:/owned/release/CHANGELOG.md");
  assert.equal(created.authorization.releaseMetadata.rawSha256, rawSha256);
  assert.ok(bytes.length > 8 * 1024 * 1024);
});

test("reviewed native transport remains bound to original release authorization across persistence", () => {
  const nativeResolutionReview = { bundlePath: "C:/owned/reviewed.bundle", bundleSha256: "a".repeat(64),
    reviews: [{ requestId: "authenticated-review", text: "exact retained reviewer message" }] };
  const authorization = { taskIds: ["task-1"], validationMode: "full", approvedTargets: [{
    targetId: "git", kind: "git", repositoryRoot: "C:/primary", nativeResolutionReview }] };
  const created = operation({ authorization });
  const reopened = restoreReleaseOperation(JSON.parse(JSON.stringify(created)));
  assert.deepEqual(reopened.authorization.approvedTargets[0].nativeResolutionReview, nativeResolutionReview);
  assert.equal(reopened.authorization.fingerprint, created.authorization.fingerprint);
  const changed = structuredClone(authorization);
  changed.approvedTargets[0].nativeResolutionReview.bundleSha256 = "b".repeat(64);
  assert.notEqual(operation({ authorization: changed }).authorization.fingerprint, created.authorization.fingerprint);
  assert.throws(() => transitionReleaseOperation(created, { authorization: changed }), /immutable/u);
  const malformed = structuredClone(authorization);
  malformed.approvedTargets[0].nativeResolutionReview = Object.assign([], nativeResolutionReview);
  assert.throws(() => operation({ authorization: malformed }), /Invalid exact native resolution bundle/u);
});

test("release operation rejects invalid regressions and terminal replay", () => {
  const created = operation();
  const invalid = transitionReleaseOperation(created, { state: "publish" });
  assert.deepEqual({ applied: invalid.applied, reason: invalid.reason }, { applied: false, reason: "invalid-transition" });
  const validated = transitionReleaseOperation(created, { state: "validate" }).operation;
  const publishing = transitionReleaseOperation(validated, { state: "publish" }).operation;
  const finalizing = transitionReleaseOperation(publishing, { state: "finalize" }).operation;
  const done = transitionReleaseOperation(finalizing, { state: "done" }).operation;
  assert.ok(done.completedAt);
  assert.equal(transitionReleaseOperation(done, { state: "failed" }).reason, "terminal");
  assert.deepEqual(restoreReleaseOperation(JSON.parse(JSON.stringify(done))), done);
});

test("candidate generation identity is immutable and repository scoped", () => {
  const generation = createCandidateGeneration({
    operationId: "release-1",
    generation: 2,
    supersedesGeneration: 1,
    repositoryBases: [{ repositoryRoot: "C:/repo", baseCommit: "a".repeat(40) }],
    selectedResults: [{ taskId: "task-1", resultCommit: "b".repeat(40), tree: "c".repeat(40), acceptanceRevision: 4 }],
    candidates: [{ repositoryRoot: "C:/repo", releaseRoot: "C:/owned/g2", commit: "d".repeat(40), tree: "e".repeat(40), manifestHash: "f".repeat(64) }],
    runnerVersion: "runner-1",
    createdAt: "2026-09-22T00:00:00.000Z",
  });
  assert.equal(generation.generation, 2);
  assert.equal(generation.supersedesGeneration, 1);
  assert.match(generation.identitySha256, /^[a-f0-9]{64}$/u);
  assert.equal(createCandidateGeneration({ ...generation }).identitySha256, generation.identitySha256);
});
