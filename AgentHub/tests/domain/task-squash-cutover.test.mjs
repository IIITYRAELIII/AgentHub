import assert from "node:assert/strict";
import test from "node:test";

import { normalizedTaskSquashCutover } from "../../src/domain/task-squash-cutover.mjs";
import { normalizedTaskSquashTransfer } from "../../src/domain/task-squash-transfer.mjs";

function fixture() {
  const transfer = normalizedTaskSquashTransfer({
    version: 1, kind: "task-squash-transfer-v1",
    survivor: { taskId: "survivor", revision: 7, releaseRevision: 5,
      resultCommit: "1".repeat(40), baseCommit: "2".repeat(40), branch: "HUB-235" },
    source: { taskId: "source", revision: 4, releaseRevision: 3,
      resultCommit: "3".repeat(40), baseCommit: "4".repeat(40), branch: "HUB-224" },
    projectRoot: process.cwd(), previousResultCommit: "5".repeat(40),
    baselineResultCommit: "6".repeat(40), devBeforeCommit: "7".repeat(40),
    devAfterTree: "8".repeat(40),
    sourceWitnesses: [{ path: "source.mjs", source: { mode: "100644", object: "d".repeat(40) },
      survivor: { mode: "100644", object: "d".repeat(40) } }],
    ownerWitnesses: [{ path: "new.mjs", baseline: null, beforeDev: null,
      newResult: { mode: "100644", object: "e".repeat(40) },
      afterDev: { mode: "100644", object: "e".repeat(40) } }],
    authority: { workspaceId: "workspace", streamId: "stream", provider: "codex",
      threadId: "thread", proofRequestId: "preview-request" },
  });
  return {
    version: 1, kind: "task-squash-cutover-v1", expectedMainCommit: "9".repeat(40),
    expectedDevCommit: "7".repeat(40), expectedPreservedTree: "a".repeat(40),
    reviewedSourceCommit: transfer.survivor.resultCommit, reviewedSourceTree: "b".repeat(40),
    projectorSha256: "c".repeat(64), artifacts: {
      sourceZipSha256: "d".repeat(64), bundleSha256: "e".repeat(64),
      manifestSha256: "f".repeat(64), filesSha256: "0".repeat(64),
    }, squashTransfer: transfer,
  };
}

test("squash cutover hash binds the reviewed source, artifacts and ordinary transfer proof", () => {
  const proof = normalizedTaskSquashCutover(fixture());
  assert.match(proof.cutoverHash, /^[0-9a-f]{64}$/u);
  assert.equal(normalizedTaskSquashCutover(proof).cutoverHash, proof.cutoverHash);
  assert.throws(() => normalizedTaskSquashCutover({
    ...proof, expectedMainCommit: "0".repeat(40), cutoverHash: proof.cutoverHash,
  }), /hash does not match/u);
  assert.throws(() => normalizedTaskSquashCutover({
    ...proof, reviewedSourceCommit: "0".repeat(40), cutoverHash: undefined,
  }), /does not match the squash survivor result/u);
});
