import { createHash } from "node:crypto";

import { normalizedTaskSquashTransfer } from "./task-squash-transfer.mjs";

const COMMIT = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;

function exact(value, pattern, name) {
  const text = String(value ?? "").trim().toLowerCase();
  if (!pattern.test(text)) throw new Error(`invalid ${name}`);
  return text;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

function withoutHash(value) {
  if (Number(value?.version) !== 1 || value?.kind !== "task-squash-cutover-v1") {
    throw new Error("unsupported Task squash cutover proof");
  }
  const squashTransfer = normalizedTaskSquashTransfer(value.squashTransfer);
  if (squashTransfer.integrationCommit) throw new Error("squash cutover preview cannot contain an integration commit");
  const reviewedSourceCommit = exact(value.reviewedSourceCommit, COMMIT, "reviewed source commit");
  if (reviewedSourceCommit !== squashTransfer.survivor.resultCommit) {
    throw new Error("reviewed source commit does not match the squash survivor result");
  }
  return {
    version: 1,
    kind: "task-squash-cutover-v1",
    expectedMainCommit: exact(value.expectedMainCommit, COMMIT, "cutover main commit"),
    expectedDevCommit: exact(value.expectedDevCommit, COMMIT, "cutover dev commit"),
    expectedPreservedTree: exact(value.expectedPreservedTree, COMMIT, "preserved worktree tree"),
    reviewedSourceCommit,
    reviewedSourceTree: exact(value.reviewedSourceTree, COMMIT, "reviewed source tree"),
    projectorSha256: exact(value.projectorSha256, SHA256, "projector SHA-256"),
    artifacts: {
      sourceZipSha256: exact(value.artifacts?.sourceZipSha256, SHA256, "source ZIP SHA-256"),
      bundleSha256: exact(value.artifacts?.bundleSha256, SHA256, "bundle SHA-256"),
      manifestSha256: exact(value.artifacts?.manifestSha256, SHA256, "manifest SHA-256"),
      filesSha256: exact(value.artifacts?.filesSha256, SHA256, "files inventory SHA-256"),
    },
    squashTransfer,
  };
}

export function taskSquashCutoverHash(value) {
  return createHash("sha256").update(JSON.stringify(canonical(withoutHash(value))), "utf8").digest("hex");
}

export function normalizedTaskSquashCutover(value) {
  const proof = withoutHash(value);
  const cutoverHash = taskSquashCutoverHash(proof);
  const supplied = String(value?.cutoverHash ?? "").trim().toLowerCase();
  if (supplied && supplied !== cutoverHash) throw new Error("Task squash cutover hash does not match its evidence");
  return { ...proof, cutoverHash };
}
