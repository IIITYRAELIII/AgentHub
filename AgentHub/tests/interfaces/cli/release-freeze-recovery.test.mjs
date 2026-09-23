import assert from "node:assert/strict";
import test from "node:test";

import {
  executeReleaseFreezeRecovery,
  parseReleaseFreezeRecoveryArguments,
} from "../../../release-freeze-recovery.mjs";

const commit = "a".repeat(40);
const digest = "b".repeat(64);
const argumentsFor = (...extra) => [
  "--repository", ".", "--workspace", "workspace", "--request-id", "recovery-op",
  "--expected-source-commit", commit, "--expected-owner-sha256", digest,
  "--expected-plan-revision", digest, "--expected-manifest-hash", digest,
  "--expected-prepared-head", commit, "--expected-frozen-head", commit,
  "--expected-frozen-tree", commit, "--expected-published-revision", commit,
  "--expected-origin-main", commit, ...extra,
];

test("release freeze recovery CLI keeps preview read-only and passes exact identity", async () => {
  const input = parseReleaseFreezeRecoveryArguments(argumentsFor());
  let observed = null;
  const result = await executeReleaseFreezeRecovery(input, {
    inspectSource: async () => ({ head: commit, ownerSha256: digest }),
    load: async () => ({ dataDir: "fixture" }),
    createService: () => ({
      recoverFreezingPublicationCandidate: async (request) => {
        observed = request;
        return { status: "preview", proofHash: digest, effects: [] };
      },
    }),
  });
  assert.equal(result.result.status, "preview");
  assert.equal(observed.confirm, false);
  assert.equal(observed.expected.frozenHead, commit);
  assert.deepEqual(observed.sourceIdentity, { commit, ownerSha256: digest });
});

test("release freeze recovery CLI requires a proof-bound confirmation", () => {
  assert.throws(() => parseReleaseFreezeRecoveryArguments(argumentsFor("--confirm-recovery")),
    /confirmation requires both/u);
  const parsed = parseReleaseFreezeRecoveryArguments(argumentsFor(
    "--confirm-recovery", "--expected-proof", digest,
  ));
  assert.equal(parsed.confirm, true);
  assert.equal(parsed.expectedProofHash, digest);
});

test("release freeze recovery CLI binds terminal frozen publication evidence and imports without execution", async () => {
  const input = parseReleaseFreezeRecoveryArguments(argumentsFor(
    "--recovery-mode", "abandon-failed-frozen-candidate-v1",
    "--expected-publication-run-id", "failed-run",
    "--expected-publication-run-sha256", digest,
    "--expected-publication-checkpoint-sha256", digest,
    "--expected-publication-log-sha256", digest,
  ));
  assert.equal(input.recoveryMode, "abandon-failed-frozen-candidate-v1");
  assert.deepEqual({
    runId: input.expected.publicationRunId,
    run: input.expected.publicationRunSha256,
    checkpoint: input.expected.publicationCheckpointSha256,
    log: input.expected.publicationLogSha256,
  }, { runId: "failed-run", run: digest, checkpoint: digest, log: digest });
  let observed = null;
  await executeReleaseFreezeRecovery(input, {
    inspectSource: async () => ({ head: commit, ownerSha256: digest }),
    load: async () => ({ dataDir: "fixture" }),
    createService: () => ({
      recoverFreezingPublicationCandidate: async (request) => {
        observed = request;
        return { status: "preview", proofHash: digest, effects: [] };
      },
    }),
  });
  assert.equal(observed.recoveryMode, "abandon-failed-frozen-candidate-v1");
  assert.equal(observed.expected.publicationRunId, "failed-run");
});

test("release freeze recovery CLI rejects incomplete failed-frozen identity", () => {
  assert.throws(() => parseReleaseFreezeRecoveryArguments(argumentsFor(
    "--recovery-mode", "abandon-failed-frozen-candidate-v1",
  )), /expected-publication-run-id/u);
  assert.throws(() => parseReleaseFreezeRecoveryArguments(argumentsFor(
    "--recovery-mode", "unknown-recovery-mode",
  )), /recovery-mode is unsupported/u);
});

test("release freeze recovery CLI binds explicit checkpoint absence", () => {
  const input = parseReleaseFreezeRecoveryArguments(argumentsFor(
    "--recovery-mode", "abandon-failed-frozen-candidate-v1",
    "--expected-publication-run-id", "failed-run",
    "--expected-publication-run-sha256", digest,
    "--expected-publication-checkpoint-absent",
    "--expected-publication-log-sha256", digest,
  ));
  assert.equal(input.expected.publicationCheckpointAbsent, true);
  assert.equal(input.expected.publicationCheckpointSha256, undefined);
  assert.throws(() => parseReleaseFreezeRecoveryArguments(argumentsFor(
    "--recovery-mode", "abandon-failed-frozen-candidate-v1",
    "--expected-publication-run-id", "failed-run",
    "--expected-publication-run-sha256", digest,
    "--expected-publication-checkpoint-absent",
    "--expected-publication-checkpoint-sha256", digest,
    "--expected-publication-log-sha256", digest,
  )), /exactly one checkpoint digest or explicit absence/u);
});

test("failed-frozen CLI binds a separately reviewed upstream advance", () => {
  const reviewed = "c".repeat(40);
  const parent = "d".repeat(40);
  const tree = "e".repeat(40);
  const patchId = "f".repeat(40);
  const input = parseReleaseFreezeRecoveryArguments(argumentsFor(
    "--recovery-mode", "abandon-failed-frozen-candidate-v1",
    "--expected-publication-run-id", "failed-run",
    "--expected-publication-run-sha256", digest,
    "--expected-publication-checkpoint-sha256", digest,
    "--expected-publication-log-sha256", digest,
    "--expected-reviewed-origin-main", reviewed,
    "--expected-reviewed-origin-parent", parent,
    "--expected-reviewed-origin-tree", tree,
    "--expected-reviewed-origin-diff-sha256", digest,
    "--expected-reviewed-origin-diff-hash-object", patchId,
    "--expected-reviewed-origin-patch-id", patchId,
    "--expected-release-tracking-origin-main", commit,
    "--expected-origin-url-sha256", digest,
  ));
  assert.deepEqual({
    reviewedOriginMain: input.expected.reviewedOriginMain,
    reviewedOriginParent: input.expected.reviewedOriginParent,
    reviewedOriginTree: input.expected.reviewedOriginTree,
    reviewedOriginDiffSha256: input.expected.reviewedOriginDiffSha256,
    reviewedOriginDiffHashObject: input.expected.reviewedOriginDiffHashObject,
    reviewedOriginPatchId: input.expected.reviewedOriginPatchId,
    releaseTrackingOriginMain: input.expected.releaseTrackingOriginMain,
    originUrlSha256: input.expected.originUrlSha256,
  }, {
    reviewedOriginMain: reviewed, reviewedOriginParent: parent, reviewedOriginTree: tree,
    reviewedOriginDiffSha256: digest, reviewedOriginDiffHashObject: patchId,
    reviewedOriginPatchId: patchId,
    releaseTrackingOriginMain: commit, originUrlSha256: digest,
  });
  assert.throws(() => parseReleaseFreezeRecoveryArguments(argumentsFor(
    "--recovery-mode", "abandon-failed-frozen-candidate-v1",
    "--expected-publication-run-id", "failed-run",
    "--expected-publication-run-sha256", digest,
    "--expected-publication-checkpoint-sha256", digest,
    "--expected-publication-log-sha256", digest,
    "--expected-reviewed-origin-main", reviewed,
  )), /reviewed origin advance identity is incomplete/u);
  assert.throws(() => parseReleaseFreezeRecoveryArguments(argumentsFor(
    "--expected-reviewed-origin-main", reviewed,
  )), /only to failed-frozen recovery/u);
});
