import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { runTaskGitCommand, TaskGitWorkspaceService } from "../../../src/infrastructure/filesystem/task-git-workspace.mjs";

const execFileAsync = promisify(execFile);
const SOURCE_ID = "11111111-1111-4111-8111-111111111111";
const SURVIVOR_ID = "22222222-2222-4222-8222-222222222222";

async function git(cwd, ...args) {
  return String((await execFileAsync("git", args, { cwd, windowsHide: true })).stdout).trim();
}

async function commit(cwd, message) {
  await git(cwd, "add", "-A");
  await git(cwd, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", message);
  return git(cwd, "rev-parse", "HEAD");
}

test("squash cutover preserves dirty bytes and resumes exact staged Git state", { timeout: 90_000 }, async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-squash-cutover-"));
  const dataDir = `${root}-data`;
  const reviewed = `${root}-reviewed`;
  const origin = `${root}-origin`;
  context.after(() => Promise.all([root, dataDir, reviewed, origin]
    .map((item) => rm(item, { recursive: true, force: true }))));
  await git(root, "init", "-b", "main");
  await git(root, "config", "core.autocrlf", "false");
  await writeFile(path.join(root, "app.txt"), "main\n");
  const main = await commit(root, "main");
  await mkdir(origin);
  await git(origin, "init", "--bare");
  await git(root, "remote", "add", "origin", origin);
  await git(root, "push", "-u", "origin", "main");

  let interruptBranchCas = false;
  let interruptAfterPreservedRef = false;
  const service = new TaskGitWorkspaceService({
    dataDir,
    runCommand: async (args, options) => {
      if (interruptAfterPreservedRef && args[0] === "update-ref"
          && args[1]?.startsWith("refs/agent-hub/task-squash-cutovers/")) {
        interruptAfterPreservedRef = false;
        await runTaskGitCommand(args, options);
        throw new Error("injected crash after preserved ref");
      }
      if (interruptBranchCas && args[0] === "update-ref" && args[1]?.startsWith("refs/heads/HUB-235")) {
        interruptBranchCas = false;
        throw new Error("injected crash before survivor branch CAS");
      }
      return runTaskGitCommand(args, options);
    },
  });
  const sourceWorkspace = await service.prepare({ taskId: SOURCE_ID, taskNumber: "HUB-224", projectRoot: root });
  await writeFile(path.join(sourceWorkspace.projectRoot, "source.txt"), "selected\n");
  const sourceTest = await service.snapshotAndMerge({ taskId: SOURCE_ID, taskNumber: "HUB-224", projectRoot: sourceWorkspace.projectRoot });
  const survivorWorkspace = await service.prepare({ taskId: SURVIVOR_ID, taskNumber: "HUB-235", projectRoot: root });
  await writeFile(path.join(survivorWorkspace.projectRoot, "residue.txt"), "excluded\n");
  const survivorTest = await service.snapshotAndMerge({ taskId: SURVIVOR_ID, taskNumber: "HUB-235", projectRoot: survivorWorkspace.projectRoot });

  await git(root, "clone", survivorWorkspace.projectRoot, reviewed);
  await git(reviewed, "config", "core.autocrlf", "false");
  await git(reviewed, "checkout", "--detach", survivorTest.snapshot.headCommit);
  await rm(path.join(reviewed, "residue.txt"));
  await writeFile(path.join(reviewed, "source.txt"), "selected\n");
  const baseline = await commit(reviewed, "reviewed clean baseline");
  await writeFile(path.join(reviewed, "combined.txt"), "clean result\n");
  const newResult = await commit(reviewed, "reviewed clean result");
  const reviewedTree = await git(reviewed, "rev-parse", "HEAD^{tree}");

  const dev = await service.prepareDev(root);
  const devBefore = await git(dev.projectRoot, "rev-parse", "HEAD");
  await writeFile(path.join(dev.projectRoot, "combined.txt"), "clean result\n");
  await git(dev.projectRoot, "add", "combined.txt");
  const devAfterTree = await git(dev.projectRoot, "write-tree");
  await git(dev.projectRoot, "reset", "--hard", devBefore);

  await writeFile(path.join(survivorWorkspace.projectRoot, "approved-dirty.txt"), "preserve me\n");
  await git(survivorWorkspace.projectRoot, "add", "-A");
  const preservedTree = await git(survivorWorkspace.projectRoot, "write-tree");
  await git(survivorWorkspace.projectRoot, "reset");
  const common = {
    source: { id: SOURCE_ID, revision: 4, releaseRevision: 4, workflowStatus: "testing",
      gitReferences: [{ projectRoot: root, branch: sourceWorkspace.branch, resultCommit: sourceTest.snapshot.headCommit }] },
    survivor: { id: SURVIVOR_ID, revision: 8, releaseRevision: 6, workflowStatus: "in_progress",
      gitReferences: [{ projectRoot: root, branch: survivorWorkspace.branch, resultCommit: survivorTest.snapshot.headCommit }] },
    projectRoot: root, baselineResultCommit: baseline, newResultCommit: newResult, devAfterTree,
    authority: { workspaceId: "workspace", streamId: "release", provider: "codex",
      threadId: "thread", proofRequestId: "preview" }, reviewedSourceRoot: reviewed,
  };
  const cutoverIdentity = {
    expectedMainCommit: main, expectedDevCommit: devBefore, expectedPreservedTree: preservedTree,
    reviewedSourceCommit: newResult, reviewedSourceTree: reviewedTree, projectorSha256: "a".repeat(64),
    artifacts: { sourceZipSha256: "b".repeat(64), bundleSha256: "c".repeat(64),
      manifestSha256: "d".repeat(64), filesSha256: "e".repeat(64) },
  };

  await service.withTaskLocks([SOURCE_ID, SURVIVOR_ID], async (lease) => {
    const preview = await service.previewSquashCutoverOwned({ ...common, cutover: cutoverIdentity, lease });
    const cutover = { version: 1, kind: "task-squash-cutover-v1", ...cutoverIdentity, squashTransfer: preview };
    await writeFile(path.join(survivorWorkspace.projectRoot, "late.txt"), "late\n");
    await assert.rejects(service.applySquashCutoverOwned({ cutover, source: common.source,
      survivor: common.survivor, lease }), /unknown|partial|changed/u);
    await rm(path.join(survivorWorkspace.projectRoot, "late.txt"));
    const commonDir = await git(survivorWorkspace.projectRoot, "rev-parse", "--git-common-dir");
    await writeFile(path.resolve(survivorWorkspace.projectRoot, commonDir, "info", "exclude"), "ignored-late.txt\n");
    await writeFile(path.join(survivorWorkspace.projectRoot, "ignored-late.txt"), "ignored survives\n");
    interruptAfterPreservedRef = true;
    await assert.rejects(service.applySquashCutoverOwned({ cutover, source: common.source,
      survivor: common.survivor, lease }), /after preserved ref/u);
    assert.equal((await service.readSquashCutoverOwned(cutover, { projectRoot: root, lease })).status,
      "not_staged");
    interruptBranchCas = true;
    await assert.rejects(service.applySquashCutoverOwned({ cutover, source: common.source,
      survivor: common.survivor, lease }), /injected crash/u);
    assert.equal((await service.readSquashCutoverOwned(cutover, { projectRoot: root, lease })).status,
      "staged_before_ref");
    const applied = await service.applySquashCutoverOwned({ cutover, source: common.source,
      survivor: common.survivor, lease });
    assert.equal((await service.readSquashCutoverOwned(cutover, { projectRoot: root, lease })).status, "applied");
    assert.match(applied.squashTransfer.integrationCommit, /^[0-9a-f]{40}$/u);
    assert.equal(await readFile(path.join(survivorWorkspace.projectRoot, "ignored-late.txt"), "utf8"), "ignored survives\n");
    const preservedRef = `refs/agent-hub/task-squash-cutovers/${applied.cutover.cutoverHash}/preserved^{tree}`;
    assert.equal(await git(root, "rev-parse", preservedRef), preservedTree);
  }, { guardTaskId: SURVIVOR_ID });
});
