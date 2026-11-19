import { createHash, randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { assertPlainIsolationPath } from "./preparation-git-isolation.mjs";

export const PREPARED_EVIDENCE_RECOVERY = "restore-prepared-evidence-v1";
const digest = value => createHash("sha256").update(value).digest("hex");
const serialize = value => `${JSON.stringify(value, null, 2)}\n`;
const samePath = (a, b) => path.resolve(a) === path.resolve(b);
const absent = error => { if (error.code === "ENOENT") return null; throw error; };
const equal = (a, b, label) => {
  if (a !== b) throw new Error(`Prepared evidence recovery ${label} changed`);
};

async function plainFile(file, { optional = false } = {}) {
  await assertPlainIsolationPath(path.dirname(file));
  const entry = await lstat(file).catch(absent);
  if (!entry && optional) return null;
  if (!entry?.isFile() || entry.isSymbolicLink() || entry.nlink !== 1) {
    throw new Error("Prepared evidence recovery requires a plain single-link metadata file");
  }
  return readFile(file);
}

async function physicalRoot(root) {
  await assertPlainIsolationPath(root);
  const info = await lstat(root);
  return { root: path.resolve(root), dev: info.dev, ino: info.ino, birthtimeMs: info.birthtimeMs };
}

// Called only inside the release owner's publication/Await/generation/repository
// leases. This is metadata reconciliation, not preparation or publication.
export async function recoverPreparedEvidenceOwned({
  layout, generationLayout, generationRoot, generationOperationId, generation,
  workspaceId, requestId, sourceIdentity, expected, confirm, expectedProofHash,
}, { readCurrent, phase = async () => {}, write = (handle, bytes) => handle.writeFile(bytes) }) {
  for (const key of ["checkpointSha256", "manifestHash", "planRevision", "generationOwnerSha256",
    "captureManifestHash", "frozenManifestHash"]) {
    if (!/^[a-f0-9]{64}$/u.test(expected[key] ?? "")) throw new Error(`Exact ${key} is required`);
  }
  for (const key of ["preparedHead", "preparedTree", "frozenHead", "frozenTree"]) {
    if (!/^[a-f0-9]{40}$/u.test(expected[key] ?? "")) throw new Error(`Exact ${key} is required`);
  }
  const target = path.join(layout.evidenceRoot, `${expected.manifestHash}.json`);
  const receiptFile = path.join(layout.evidenceRoot, `prepared-recovery-${expected.checkpointSha256}.json`);
  const snapshot = async () => {
    const checkpointBytes = await plainFile(layout.checkpointFile);
    equal(digest(checkpointBytes), expected.checkpointSha256, "checkpoint digest");
    const checkpoint = JSON.parse(checkpointBytes);
    if (checkpoint.phase !== "prepared" || checkpoint.publicationFreeze) {
      throw new Error("Prepared evidence recovery requires the unchanged prepared checkpoint");
    }
    for (const [key, value] of Object.entries({ manifestHash: expected.manifestHash,
      planRevision: expected.planRevision, preReleaseHead: expected.preparedHead })) {
      equal(checkpoint[key], value, key);
    }
    if (!samePath(checkpoint.manifestFile, target)) throw new Error("Prepared evidence recovery target changed");
    const ownerBytes = await plainFile(path.join(generationRoot, "identity.json"));
    equal(digest(ownerBytes), expected.generationOwnerSha256, "generation owner digest");
    const owner = JSON.parse(ownerBytes);
    if (owner.schemaVersion !== 1 || owner.operationId !== generationOperationId || owner.generation !== generation
        || owner.identitySha256 !== digest(`${generationOperationId}:${generation}:${owner.repositoryRoot}`)
        || !samePath(owner.repositoryRoot, layout.primaryRoot)) throw new Error("Prepared evidence recovery generation identity changed");
    const binding = owner.preparedCandidate;
    if (binding?.kind !== "native-prepared-release-v1" || !samePath(binding.releaseRoot, layout.releaseRoot)) {
      throw new Error("Prepared evidence recovery capture belongs to another prepared repository");
    }
    for (const [key, value] of Object.entries({ checkpointSha256: expected.checkpointSha256,
      manifestHash: expected.manifestHash, commit: expected.preparedHead, tree: expected.preparedTree })) {
      equal(binding[key], value, `capture ${key}`);
    }
    const captureBytes = await plainFile(path.join(generationLayout.evidenceRoot, `${expected.captureManifestHash}.json`));
    equal(digest(captureBytes), expected.captureManifestHash, "capture digest");
    const captured = JSON.parse(captureBytes);
    if (serialize(captured.preparedCandidate) !== serialize(binding)
        || captured.workspaceId !== workspaceId || captured.planRevision !== expected.planRevision
        || !samePath(captured.releaseRoot, generationLayout.releaseRoot)
        || !samePath(captured.releaseGitCommonDir, path.join(generationLayout.releaseRoot, ".git"))) {
      throw new Error("Prepared evidence recovery immutable capture binding changed");
    }
    const frozenCheckpointBytes = await plainFile(generationLayout.checkpointFile);
    const frozenCheckpoint = JSON.parse(frozenCheckpointBytes);
    if (frozenCheckpoint.phase !== "frozen" || frozenCheckpoint.manifestHash !== expected.frozenManifestHash
        || frozenCheckpoint.planRevision !== expected.planRevision || frozenCheckpoint.preReleaseHead !== expected.frozenHead
        || frozenCheckpoint.publicationFreeze?.preparedHead !== expected.preparedHead) {
      throw new Error("Prepared evidence recovery frozen checkpoint changed");
    }
    const frozenBytes = await plainFile(path.join(generationLayout.evidenceRoot, `${expected.frozenManifestHash}.json`));
    equal(digest(frozenBytes), expected.frozenManifestHash, "frozen manifest digest");
    const frozen = JSON.parse(frozenBytes);
    const { publication, ...frozenPrepared } = frozen;
    equal(serialize(frozenPrepared), serialize(captured), "frozen prepared capture");
    if (publication?.head !== expected.frozenHead || publication.preparedHead !== expected.preparedHead) {
      throw new Error("Prepared evidence recovery frozen publication binding changed");
    }
    // Reverse only the capture owner's relocation and its explicit binding.
    // The existing active checkpoint remains the authority for the exact bytes.
    const { preparedCandidate, ...restored } = captured;
    restored.releaseRoot = binding.releaseRoot;
    restored.releaseGitCommonDir = path.join(binding.releaseRoot, ".git");
    const restoredBytes = Buffer.from(serialize(restored));
    equal(digest(restoredBytes), expected.manifestHash, "reconstructed manifest digest");
    if (restored.schemaVersion !== 2 || restored.compositionPolicy !== "main-selected-git-merge-v1"
        || !samePath(restored.primaryRoot, layout.primaryRoot)
        || restored.baseCommit !== checkpoint.baseCommit
        || serialize(restored.baseProvenance) !== serialize(checkpoint.baseProvenance)) {
      throw new Error("Prepared evidence recovery reconstructed identity changed");
    }
    const nativeBytes = await plainFile(path.join(layout.root, "native-preparation.json"));
    const native = JSON.parse(nativeBytes);
    if (native.phase !== "completed" || native.manifestHash !== expected.manifestHash
        || native.target !== expected.preparedHead || native.targetTree !== expected.preparedTree) {
      throw new Error("Prepared evidence recovery native preparation changed");
    }
    const current = await readCurrent();
    if (!samePath(restored.primaryGitCommonDir, current.marker.primaryGitCommonDir)
        || !samePath(restored.releaseGitCommonDir, current.marker.releaseGitCommonDir)) {
      throw new Error("Prepared evidence recovery physical Git custody changed");
    }
    const identity = { mode: PREPARED_EVIDENCE_RECOVERY, requestId, sourceIdentity, workspaceId,
      generationOperationId, generation, expected, current,
      roots: await Promise.all([layout.root, layout.releaseRoot, path.join(layout.releaseRoot, ".git"),
        generationRoot, generationLayout.releaseRoot, path.join(generationLayout.releaseRoot, ".git")].map(physicalRoot)),
      checkpointSha256: digest(checkpointBytes), nativeSha256: digest(nativeBytes),
      ownerSha256: digest(ownerBytes), frozenCheckpointSha256: digest(frozenCheckpointBytes),
      captureSha256: digest(captureBytes), frozenSha256: digest(frozenBytes) };
    return { identity, restoredBytes, checkpointBytes, captureBytes };
  };
  let state = await snapshot();
  const proofHash = digest(serialize(state.identity));
  const existing = await plainFile(target, { optional: true });
  if (existing && !existing.equals(state.restoredBytes)) throw new Error("Prepared evidence recovery target is occupied by different bytes");
  if (!confirm) return { status: "preview", proofHash, identity: state.identity,
    alreadyPresent: existing !== null, effects: existing ? [] : [target] };
  equal(expectedProofHash, proofHash, "confirmation proof");

  const atomicCreate = async (file, bytes, beforeLink) => {
    const temporary = path.join(layout.evidenceRoot, `.prepared-recovery-${randomUUID()}.tmp`);
    let handle;
    try {
      handle = await open(temporary, "wx");
      await write(handle, bytes);
      await handle.sync();
      await handle.close(); handle = null;
      await beforeLink();
      // link is exclusive: an existing destination is never overwritten.
      await link(temporary, file).catch(error => { if (error.code !== "EEXIST") throw error; });
    } finally {
      await handle?.close();
      await rm(temporary, { force: true });
    }
    const actual = await plainFile(file);
    if (!actual.equals(bytes)) throw new Error("Prepared evidence recovery atomic destination conflicts");
  };
  const revalidate = async () => {
    state = await snapshot();
    equal(digest(serialize(state.identity)), proofHash, "admitted current proof");
    await assertPlainIsolationPath(layout.evidenceRoot);
  };
  await revalidate();
  const receipt = await plainFile(receiptFile, { optional: true });
  if (existing && !receipt) return { status: "already-present", proofHash, effects: [] };
  await mkdir(layout.evidenceRoot, { recursive: true });
  const receiptBytes = Buffer.from(serialize({ identity: state.identity, proofHash,
    checkpointBytesBase64: state.checkpointBytes.toString("base64"), captureBytesBase64: state.captureBytes.toString("base64") }));
  if (receipt) {
    if (!receipt.equals(receiptBytes)) throw new Error("Prepared evidence recovery is admitted to another identity");
  } else await atomicCreate(receiptFile, receiptBytes, revalidate);
  await phase("prepared-evidence-admitted");
  await revalidate();
  if (!existing) await atomicCreate(target, state.restoredBytes, revalidate);
  await phase("prepared-evidence-restored");
  await revalidate();
  equal(digest(await plainFile(target)), expected.manifestHash, "restored readback");
  return { status: "restored", proofHash, manifestHash: expected.manifestHash,
    receiptFile, receiptSha256: digest(receiptBytes), reused: Boolean(receipt), effects: existing ? [] : [target] };
}
