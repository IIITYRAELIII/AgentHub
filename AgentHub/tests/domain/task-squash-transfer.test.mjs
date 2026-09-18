import assert from "node:assert/strict";
import test from "node:test";

import {
  exactCrLfToLfNormalization,
  LF_NORMALIZATION_ALREADY_PRESENT,
  normalizedTaskSquashTransfer,
  taskSquashTransferHash,
} from "../../src/domain/task-squash-transfer.mjs";
import { taskReleasePlanRevision } from "../../src/domain/task-release-snapshot.mjs";

const commit = (digit) => String(digit).repeat(40);
const blob = (digit) => ({ mode: "100644", object: commit(digit) });

function proof(overrides = {}) {
  return {
    version: 1,
    kind: "task-squash-transfer-v1",
    survivor: {
      taskId: "survivor", revision: 7, releaseRevision: 5,
      resultCommit: commit("a"), baseCommit: commit("1"), branch: "HUB-235",
    },
    source: {
      taskId: "source", revision: 4, releaseRevision: 3,
      resultCommit: commit("b"), baseCommit: commit("2"), branch: "HUB-224",
    },
    projectRoot: "D:/repo",
    previousResultCommit: commit("9"),
    baselineResultCommit: commit("3"),
    devBeforeCommit: commit("4"),
    devAfterTree: commit("5"),
    sourceWitnesses: [{ path: "source.mjs", source: blob("6"), survivor: blob("6") }],
    ownerWitnesses: [{
      path: "new.mjs", baseline: null, beforeDev: null, newResult: blob("7"), afterDev: blob("7"),
    }],
    authority: {
      workspaceId: "workspace", streamId: "release", provider: "codex",
      threadId: "thread", proofRequestId: "request",
    },
    ...overrides,
  };
}

test("Task squash transfer binds exact two-Task, result, dev and authority evidence", () => {
  const normalized = normalizedTaskSquashTransfer(proof());
  assert.equal(normalized.transferHash, taskSquashTransferHash(normalized));
  assert.equal(normalized.ownerWitnesses[0].disposition, "applied");
  assert.equal(normalized.previousResultCommit, commit("9"));
  const withReadback = normalizedTaskSquashTransfer({ ...normalized, integrationCommit: commit("8") });
  assert.equal(withReadback.transferHash, normalized.transferHash);
  assert.equal(withReadback.integrationCommit, commit("8"));
  assert.throws(() => normalizedTaskSquashTransfer({ ...normalized, transferHash: "f".repeat(64) }), /hash/);
});

test("Task squash transfer rejects an omitted or emptied source effect", () => {
  assert.throws(() => normalizedTaskSquashTransfer(proof({
    sourceWitnesses: [{ path: "source.mjs", source: blob("6"), survivor: null }],
  })), /cannot delete/);
  assert.throws(() => normalizedTaskSquashTransfer(proof({
    sourceWitnesses: [{
      path: "source.mjs", source: blob("6"),
      survivor: { mode: "100644", object: "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391" },
    }],
  })), /empty blob/);
});

test("Task squash transfer rejects a synthetic no-op that omits the survivor delta", () => {
  assert.throws(() => normalizedTaskSquashTransfer(proof({
    ownerWitnesses: [{
      path: "new.mjs", baseline: null, beforeDev: null, newResult: blob("7"), afterDev: null,
    }],
  })), /missing from dev/);
  assert.throws(() => normalizedTaskSquashTransfer(proof({ ownerWitnesses: [] })), /non-empty owner delta/);
});

test("Task squash transfer permits only an explicitly hash-bound foreign overlap resolution", () => {
  const resolved = normalizedTaskSquashTransfer(proof({
    ownerWitnesses: [{
      path: "shared.mjs", baseline: blob("1"), beforeDev: blob("2"),
      newResult: blob("3"), afterDev: blob("4"),
    }],
  }));
  assert.equal(resolved.ownerWitnesses[0].disposition, "resolved");
  assert.throws(() => normalizedTaskSquashTransfer(proof({
    ownerWitnesses: [{
      path: "shared.mjs", baseline: blob("1"), beforeDev: blob("2"),
      newResult: blob("3"), afterDev: blob("2"),
    }],
  })), /discarded/);
});

test("Task squash transfer preserves the old discard guard and binds the narrow LF disposition", () => {
  const ownerWitness = {
    path: "contract.md", baseline: blob("1"), beforeDev: blob("2"),
    newResult: blob("3"), afterDev: blob("2"),
  };
  assert.throws(() => normalizedTaskSquashTransfer(proof({
    ownerWitnesses: [ownerWitness],
  })), /discarded/);
  const accepted = normalizedTaskSquashTransfer(proof({
    ownerWitnesses: [{ ...ownerWitness, disposition: LF_NORMALIZATION_ALREADY_PRESENT }],
  }));
  assert.equal(accepted.ownerWitnesses[0].disposition, LF_NORMALIZATION_ALREADY_PRESENT);
  assert.equal(
    normalizedTaskSquashTransfer(proof()).transferHash,
    "ae3a0baeb2c66596fb4e369c19e62a32801aa9f5a1844cc3b0fb20bbd6e9cdea",
  );
  for (const invalid of [
    { ...ownerWitness, baseline: null },
    { ...ownerWitness, baseline: { ...ownerWitness.baseline, mode: "120000" } },
    { ...ownerWitness, newResult: { ...ownerWitness.newResult, mode: "100755" } },
  ]) {
    assert.throws(() => normalizedTaskSquashTransfer(proof({
      ownerWitnesses: [{ ...invalid, disposition: LF_NORMALIZATION_ALREADY_PRESENT }],
    })), /discarded/);
  }
});

test("exact CRLF-to-LF proof excludes semantic bytes, lone CR, NUL and mixed dev", () => {
  const valid = {
    baseline: Buffer.from("first\r\nsecond\r\n"),
    newResult: Buffer.from("first\nsecond\n"),
    dev: Buffer.from("first\nsecond\nselected addition\n"),
  };
  assert.equal(exactCrLfToLfNormalization(valid), true);
  assert.equal(exactCrLfToLfNormalization({ ...valid, newResult: Buffer.from("first\nchanged\n") }), false);
  assert.equal(exactCrLfToLfNormalization({ ...valid, baseline: Buffer.from("first\rsecond\r\n") }), false);
  assert.equal(exactCrLfToLfNormalization({ ...valid, baseline: Buffer.from("first\0\r\n") }), false);
  assert.equal(exactCrLfToLfNormalization({ ...valid, dev: Buffer.from("first\r\nsecond\n") }), false);
});

test("release plan identity includes the exact squash transfer hash", () => {
  const transfer = normalizedTaskSquashTransfer(proof());
  const task = {
    id: "survivor", revision: 8, releaseRevision: 6,
    gitReferences: [{ projectRoot: "D:/repo", branch: "HUB-235", resultCommit: commit("a") }],
  };
  assert.notEqual(
    taskReleasePlanRevision("workspace", [task]),
    taskReleasePlanRevision("workspace", [{ ...task, squashTransfer: transfer }]),
  );
});
