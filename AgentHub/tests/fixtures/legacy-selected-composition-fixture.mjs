// Synthetic pre-cutover v1 original, confined to a disposable test repository.
// This builds retained evidence through the existing read-only verifier; it
// does not reopen the current preview API or copy a former composer/writer.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { canonicalPath } from "../../src/infrastructure/filesystem/config.mjs";
import { taskRepositoryKey } from "../../src/domain/task-git-reference.mjs";
import { verifySelectedCompositionObjects } from "../../src/infrastructure/filesystem/selected-composition-proof.mjs";
import { runTaskGitCommand } from "../../src/infrastructure/filesystem/task-git-workspace.mjs";

export async function retainedLegacySelectedPreview(f, { taskId, authority, expectedTaskRevision }) {
  const repositoryRoot = canonicalPath(await realpath(f.root));
  const fixtureRoot = await realpath(path.dirname(repositoryRoot));
  const relative = path.relative(await realpath(os.tmpdir()), fixtureRoot);
  assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
  assert.equal(path.dirname(path.resolve(f.dataDir)), fixtureRoot);
  const git = (args, options = {}) => runTaskGitCommand(args, { ...options, cwd: repositoryRoot });
  const proof = await verifySelectedCompositionObjects({
    git, taskId, repositoryKey: taskRepositoryKey(repositoryRoot),
    taskBaseCommit: f.base, acceptedLocalMainCommit: f.local,
    taskCommit: f.task, devCommit: f.dev, proofCommit: f.proof,
    publishedCommit: f.published, publicationGeneration: "generation-1",
    remoteCommit: f.published, bundleSha256: f.bundleSha256,
  });
  const preview = { ...proof, repositoryRoot,
    taskRoot: f.taskWorkspace.projectRoot, devRoot: f.devWorkspace.projectRoot,
    branch: f.taskWorkspace.branch, remoteUrl: await git(["remote", "get-url", "origin"]),
    bundlePath: path.resolve(f.bundle), resultRefBefore: null, expectedTaskRevision,
    authority: { ...authority } };
  return { ...preview, previewHash: createHash("sha256").update(JSON.stringify(preview)).digest("hex") };
}

export async function retainLegacySelectedOriginal(f, preview, operationId, { version = 1 } = {}) {
  assert.ok([1, 2].includes(version));
  assert.match(operationId, /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/u);
  const fixtureRoot = await realpath(path.dirname(f.root));
  assert.equal(path.dirname(path.resolve(f.dataDir)), fixtureRoot);
  const root = path.join(f.dataDir, "task-selected-compositions", preview.taskId,
    taskRepositoryKey(preview.repositoryRoot), operationId);
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, "intent.json"), `${JSON.stringify({
    version, kind: "selected-task-composition-v1", operationId, preview,
  })}\n`, { encoding: "utf8", flag: "wx" });
}
