import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { frozenTaskReleaseManifest } from "../../../src/domain/task-release-snapshot.mjs";
import {
  canonicalReleaseChangeSetDiffHash,
  verifyReleaseChangeSetGitEvidence,
} from "../../../src/infrastructure/filesystem/release-change-set-git-verifier.mjs";

const execFileAsync = promisify(execFile);

async function git(repository, ...args) {
  const { stdout } = await execFileAsync("git", ["-C", repository, ...args], {
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  });
  return String(stdout).trim();
}

async function repositoryFixture(context) {
  const repository = await mkdtemp(path.join(os.tmpdir(), "agent-hub-freeze-git-"));
  context.after(() => rm(repository, { recursive: true, force: true }));
  await git(repository, "init", "--quiet");
  await git(repository, "config", "user.email", "agent-hub@example.invalid");
  await git(repository, "config", "user.name", "Agent Hub Test");
  await mkdir(path.join(repository, "src"));
  await writeFile(path.join(repository, "src", "app.mjs"), "export const value = 1;\n", "utf8");
  await writeFile(path.join(repository, "src", "other.mjs"), "export const other = 1;\n", "utf8");
  await writeFile(path.join(repository, "src", "deleted.mjs"), "export const deleted = true;\n", "utf8");
  await git(repository, "add", "--", "src/app.mjs", "src/other.mjs", "src/deleted.mjs");
  await git(repository, "commit", "--quiet", "-m", "base");
  const baseRevision = await git(repository, "rev-parse", "HEAD");
  const baseBlob = await git(repository, "rev-parse", "HEAD:src/app.mjs");
  const deletedBaseBlob = await git(repository, "rev-parse", "HEAD:src/deleted.mjs");
  await writeFile(path.join(repository, "src", "app.mjs"), "export const value = 2;\n", "utf8");
  await writeFile(path.join(repository, "src", "other.mjs"), "export const other = 2;\n", "utf8");
  await writeFile(path.join(repository, "src", "added.mjs"), "export const added = true;\n", "utf8");
  await unlink(path.join(repository, "src", "deleted.mjs"));
  await git(repository, "add", "--all", "--", "src");
  await git(repository, "commit", "--quiet", "-m", "result");
  const resultRevision = await git(repository, "rev-parse", "HEAD");
  const resultBlob = await git(repository, "rev-parse", "HEAD:src/app.mjs");
  const otherBlob = await git(repository, "rev-parse", "HEAD:src/other.mjs");
  const addedResultBlob = await git(repository, "rev-parse", "HEAD:src/added.mjs");
  const patch = await canonicalReleaseChangeSetDiffHash({
    projectRoot: repository,
    baseRevision,
    resultRevision,
    filePath: "src/app.mjs",
  });
  return {
    repository, baseRevision, resultRevision, baseBlob, resultBlob, otherBlob,
    deletedBaseBlob, addedResultBlob, patch,
  };
}

function manifest(fixture, overrides = {}) {
  return frozenTaskReleaseManifest({
    revision: 1,
    repositories: [{
      projectRoot: fixture.repository,
      baseRevision: fixture.baseRevision,
      resultRevision: fixture.resultRevision,
    }],
    files: [{
      projectRoot: fixture.repository,
      path: "src/app.mjs",
      operation: "modified",
      baseBlob: fixture.baseBlob,
      resultBlob: fixture.resultBlob,
      patchHash: fixture.patch.hash,
      ...overrides,
    }],
  });
}

test("Git verifier proves revisions, path blobs and canonical patch hash", async (context) => {
  const fixture = await repositoryFixture(context);
  const verification = await verifyReleaseChangeSetGitEvidence(manifest(fixture));

  assert.equal(verification.verifier.name, "agent-hub-release-changeset-git-verifier");
  assert.equal(verification.verifier.version, "1");
  assert.match(verification.verifier.gitVersion, /^git version /u);
  assert.equal(verification.repositories[0].baseRevision, fixture.baseRevision);
  assert.equal(verification.files[0].base.blob, fixture.baseBlob);
  assert.equal(verification.files[0].result.blob, fixture.resultBlob);
  assert.equal(verification.files[0].canonicalDiff.hash, fixture.patch.hash);
});

test("Git verifier rejects existing but fabricated path blobs and patch hashes", async (context) => {
  const fixture = await repositoryFixture(context);

  await assert.rejects(
    () => verifyReleaseChangeSetGitEvidence(manifest(fixture, { resultBlob: fixture.otherBlob })),
    /does not resolve to the claimed blob/u,
  );
  await assert.rejects(
    () => verifyReleaseChangeSetGitEvidence(manifest(fixture, { patchHash: "0".repeat(64) })),
    /patch hash does not match canonical Git diff/u,
  );
});

test("Git verifier accepts absent only on the missing side of add and delete", async (context) => {
  const fixture = await repositoryFixture(context);
  const evidence = frozenTaskReleaseManifest({
    revision: 1,
    repositories: [{
      projectRoot: fixture.repository,
      baseRevision: fixture.baseRevision,
      resultRevision: fixture.resultRevision,
    }],
    files: [{
      projectRoot: fixture.repository,
      path: "src/added.mjs",
      operation: "added",
      baseBlob: "absent",
      resultBlob: fixture.addedResultBlob,
    }, {
      projectRoot: fixture.repository,
      path: "src/deleted.mjs",
      operation: "deleted",
      baseBlob: fixture.deletedBaseBlob,
      resultBlob: "absent",
    }],
  });

  const verification = await verifyReleaseChangeSetGitEvidence(evidence);

  assert.equal(verification.files[0].base.state, "absent");
  assert.equal(verification.files[0].result.blob, fixture.addedResultBlob);
  assert.equal(verification.files[1].base.blob, fixture.deletedBaseBlob);
  assert.equal(verification.files[1].result.state, "absent");
});
