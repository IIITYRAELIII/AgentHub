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
