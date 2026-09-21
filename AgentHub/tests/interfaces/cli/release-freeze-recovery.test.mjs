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
