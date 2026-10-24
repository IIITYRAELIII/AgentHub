import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { runTaskGitCommand, TaskGitWorkspaceService } from "../../../src/infrastructure/filesystem/task-git-workspace.mjs";
import { TaskBoardService } from "../../../src/application/task-board-service.mjs";
import { TaskLifecycleService } from "../../../src/application/task-lifecycle-service.mjs";
import { TaskOperationReconciliationService } from "../../../src/application/task-operation-reconciliation-service.mjs";
import { TaskBoardStore } from "../../../src/infrastructure/persistence/task-board-store.mjs";
import { WorkspaceCatalogStore } from "../../../src/infrastructure/persistence/workspace-catalog-store.mjs";

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

async function snapshotTree(cwd) {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "agent-hub-snapshot-index-"));
  const temporaryIndex = path.join(temporaryRoot, "index");
  try {
    const indexPath = path.resolve(cwd, await git(cwd, "rev-parse", "--git-path", "index"));
    await copyFile(indexPath, temporaryIndex);
    const env = { GIT_INDEX_FILE: temporaryIndex };
    await runTaskGitCommand(["add", "-A", "--", "."], { cwd, env });
    return await runTaskGitCommand(["write-tree"], { cwd, env });
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function trackedWorktreeDiff(cwd, treeish) {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "agent-hub-target-index-"));
  const env = { GIT_INDEX_FILE: path.join(temporaryRoot, "index") };
  try {
    await runTaskGitCommand(["read-tree", treeish], { cwd, env });
    await runTaskGitCommand(["update-index", "--refresh"], { cwd, env });
    return await runTaskGitCommand(["diff-files", "--name-only", "-z"], { cwd, env });
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

function argumentsHash(value) {
  const canonical = (input) => Array.isArray(input)
    ? input.map(canonical)
    : input && typeof input === "object"
      ? Object.fromEntries(Object.keys(input).sort().map((key) => [key, canonical(input[key])]))
      : input;
  return createHash("sha256").update(JSON.stringify(canonical(value)), "utf8").digest("hex");
}

test("squash cutover preserves dirty bytes and resumes exact staged Git state", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-squash-cutover-"));
  const dataDir = `${root}-data`;
  const reviewed = `${root}-reviewed`;
  const origin = `${root}-origin`;
  context.after(() => Promise.all([root, dataDir, reviewed, origin]
    .map((item) => rm(item, { recursive: true, force: true }))));
  await git(root, "init", "-b", "main");
  await git(root, "config", "core.autocrlf", "false");
  await git(root, "config", "core.ignorecase", "true");
  await writeFile(path.join(root, ".gitignore"), "combined.txt\nignored-late.txt\nFoo.txt\nDir/\nrename-y069.txt\nrename-z100.txt\n");
  await writeFile(path.join(root, "app.txt"), "main\n");
  await writeFile(path.join(root, "rename-old-069.txt"), Array.from({ length: 100 }, (_value, index) => `line ${index}\n`).join(""));
  await writeFile(path.join(root, "rename-old-100.txt"), "same rename bytes\n");
  const main = await commit(root, "main");
  await mkdir(origin);
  await git(origin, "init", "--bare");
  await git(root, "remote", "add", "origin", origin);
  await git(root, "push", "-u", "origin", "main");

  let interruptBranchCas = false;
  let interruptAfterPreservedRef = false;
  let interruptBeforeSafeMaterialization = false;
  let injectLateIgnoredCollision = false;
  let injectLateRename069Collision = false;
  let injectLateRename100Collision = false;
  let interruptAfterLastCopyBeforeIndex = false;
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
      if (interruptBeforeSafeMaterialization && args[0] === "read-tree"
          && args[1] === "-m" && args[2] === "-u") {
        interruptBeforeSafeMaterialization = false;
        throw new Error("injected crash before safe materialization");
      }
      if (injectLateIgnoredCollision && args[0] === "cat-file"
          && args[1] === "-e" && args[2]?.endsWith(":combined.txt")) {
        injectLateIgnoredCollision = false;
        await writeFile(path.join(options.cwd, "combined.txt"), "late ignored bytes\n");
      }
      if (injectLateRename069Collision && args[0] === "cat-file"
          && args[1] === "-e" && args[2]?.endsWith(":rename-y069.txt")) {
        injectLateRename069Collision = false;
        await writeFile(path.join(options.cwd, "rename-y069.txt"), "late R069 user bytes\n");
      }
      if (injectLateRename100Collision && args[0] === "cat-file"
          && args[1] === "-e" && args[2]?.endsWith(":rename-z100.txt")) {
        injectLateRename100Collision = false;
        await writeFile(path.join(options.cwd, "rename-z100.txt"), "late R100 user bytes\n");
      }
      if (interruptAfterLastCopyBeforeIndex && args[0] === "update-index"
          && args[1] === "--add" && args.at(-1) === "zz-final-copy.txt") {
        interruptAfterLastCopyBeforeIndex = false;
        throw new Error("injected crash after last exclusive copy before cacheinfo");
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

  await git(root, "-c", "core.autocrlf=false", "clone", survivorWorkspace.projectRoot, reviewed);
  await git(reviewed, "config", "core.autocrlf", "false");
  await git(reviewed, "checkout", "--detach", survivorTest.snapshot.headCommit);
  await rm(path.join(reviewed, "residue.txt"));
  await writeFile(path.join(reviewed, "source.txt"), "selected\n");
  const baseline = await commit(reviewed, "reviewed clean baseline");
  await writeFile(path.join(reviewed, "combined.txt"), "clean result\n");
  await writeFile(path.join(reviewed, "foo.txt"), "reviewed file case\n");
  await mkdir(path.join(reviewed, "dir"));
  await writeFile(path.join(reviewed, "dir", "x.txt"), "reviewed directory case\n");
  await git(reviewed, "mv", "rename-old-069.txt", "rename-y069.txt");
  await writeFile(path.join(reviewed, "rename-y069.txt"), `${Array.from({ length: 100 }, (_value, index) => (
    index < 7 ? `replacement content ${index}\n` : `line ${index}\n`
  )).join("")}${Array.from({ length: 20 }, (_value, index) => `added ${index}\n`).join("")}`);
  await git(reviewed, "mv", "rename-old-100.txt", "rename-z100.txt");
  await writeFile(path.join(reviewed, "zz-final-copy.txt"), "last nonignored addition\n");
  await git(reviewed, "add", "-f", "combined.txt", "foo.txt", "dir/x.txt", "rename-y069.txt", "rename-z100.txt");
  const newResult = await commit(reviewed, "reviewed clean result");
  const reviewedTree = await git(reviewed, "rev-parse", "HEAD^{tree}");
  const heuristicDiff = await git(reviewed, "diff", "--name-status", baseline, newResult);
  assert.match(heuristicDiff, /R100\trename-old-100\.txt\trename-z100\.txt/u);
  assert.match(heuristicDiff, /R069\trename-old-069\.txt\trename-y069\.txt/u);
  const noRenameDiff = await git(reviewed, "diff", "--no-renames", "--name-status", baseline, newResult);
  assert.match(noRenameDiff, /A\trename-y069\.txt/u);
  assert.match(noRenameDiff, /A\trename-z100\.txt/u);

  const dev = await service.prepareDev(root);
  const devBefore = await git(dev.projectRoot, "rev-parse", "HEAD");
  await writeFile(path.join(dev.projectRoot, "combined.txt"), "clean result\n");
  await writeFile(path.join(dev.projectRoot, "foo.txt"), "reviewed file case\n");
  await mkdir(path.join(dev.projectRoot, "dir"));
  await writeFile(path.join(dev.projectRoot, "dir", "x.txt"), "reviewed directory case\n");
  await rm(path.join(dev.projectRoot, "rename-old-069.txt"));
  await rm(path.join(dev.projectRoot, "rename-old-100.txt"));
  await writeFile(path.join(dev.projectRoot, "rename-y069.txt"), await readFile(path.join(reviewed, "rename-y069.txt")));
  await writeFile(path.join(dev.projectRoot, "rename-z100.txt"), "same rename bytes\n");
  await writeFile(path.join(dev.projectRoot, "zz-final-copy.txt"), "last nonignored addition\n");
  await git(dev.projectRoot, "add", "-A");
  await git(dev.projectRoot, "add", "-f", "combined.txt", "foo.txt", "dir/x.txt", "rename-y069.txt", "rename-z100.txt");
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
    await writeFile(path.join(survivorWorkspace.projectRoot, "Foo.txt"), "unknown file case bytes\n");
    await assert.rejects(service.applySquashCutoverOwned({ cutover, source: common.source,
      survivor: common.survivor, lease }), /collides with ignored bytes/u);
    assert.equal(await readFile(path.join(survivorWorkspace.projectRoot, "Foo.txt"), "utf8"),
      "unknown file case bytes\n");
    await rm(path.join(survivorWorkspace.projectRoot, "Foo.txt"));
    await mkdir(path.join(survivorWorkspace.projectRoot, "Dir"));
    await writeFile(path.join(survivorWorkspace.projectRoot, "Dir", "x.txt"), "unknown directory case bytes\n");
    await assert.rejects(service.applySquashCutoverOwned({ cutover, source: common.source,
      survivor: common.survivor, lease }), /collides with ignored bytes/u);
    assert.equal(await readFile(path.join(survivorWorkspace.projectRoot, "Dir", "x.txt"), "utf8"),
      "unknown directory case bytes\n");
    await rm(path.join(survivorWorkspace.projectRoot, "Dir"), { recursive: true });
    await writeFile(path.join(survivorWorkspace.projectRoot, "combined.txt"), "unknown ignored bytes\n");
    await assert.rejects(service.applySquashCutoverOwned({ cutover, source: common.source,
      survivor: common.survivor, lease }), /collides with ignored bytes/u);
    assert.equal(await readFile(path.join(survivorWorkspace.projectRoot, "combined.txt"), "utf8"),
      "unknown ignored bytes\n");
    await rm(path.join(survivorWorkspace.projectRoot, "combined.txt"));
    await writeFile(path.join(survivorWorkspace.projectRoot, "app.txt"), "late tracked edit\n");
    await assert.rejects(service.applySquashCutoverOwned({ cutover, source: common.source,
      survivor: common.survivor, lease }), /changed/u);
    assert.equal(await readFile(path.join(survivorWorkspace.projectRoot, "app.txt"), "utf8"),
      "late tracked edit\n");
    await writeFile(path.join(survivorWorkspace.projectRoot, "app.txt"), "main\n");
    await rm(path.join(survivorWorkspace.projectRoot, "app.txt"));
    await assert.rejects(service.applySquashCutoverOwned({ cutover, source: common.source,
      survivor: common.survivor, lease }), /changed/u);
    assert.equal(await readFile(path.join(survivorWorkspace.projectRoot, "app.txt"), "utf8")
      .catch((error) => error.code), "ENOENT");
    await writeFile(path.join(survivorWorkspace.projectRoot, "app.txt"), "main\n");
    await writeFile(path.join(survivorWorkspace.projectRoot, "late.txt"), "late\n");
    await assert.rejects(service.applySquashCutoverOwned({ cutover, source: common.source,
      survivor: common.survivor, lease }), /unknown|partial|changed/u);
    await rm(path.join(survivorWorkspace.projectRoot, "late.txt"));
    await writeFile(path.join(survivorWorkspace.projectRoot, "ignored-late.txt"), "ignored survives\n");
    interruptAfterPreservedRef = true;
    await assert.rejects(service.applySquashCutoverOwned({ cutover, source: common.source,
      survivor: common.survivor, lease }), /after preserved ref/u);
    assert.equal((await service.readSquashCutoverOwned(cutover, { projectRoot: root, lease })).status,
      "pending_survivor_index");
    interruptBeforeSafeMaterialization = true;
    await assert.rejects(service.applySquashCutoverOwned({ cutover, source: common.source,
      survivor: common.survivor, lease }), /before safe materialization/u);
    assert.equal((await service.readSquashCutoverOwned(cutover, { projectRoot: root, lease })).status,
      "pending_survivor_index");
    injectLateIgnoredCollision = true;
    await assert.rejects(service.applySquashCutoverOwned({ cutover, source: common.source,
      survivor: common.survivor, lease }), /collides with unknown bytes/u);
    assert.equal(await readFile(path.join(survivorWorkspace.projectRoot, "combined.txt"), "utf8"),
      "late ignored bytes\n");
    assert.equal((await service.readSquashCutoverOwned(cutover, { projectRoot: root, lease })).status,
      "materializing_additions");
    await rm(path.join(survivorWorkspace.projectRoot, "combined.txt"));
    injectLateRename069Collision = true;
    await assert.rejects(service.applySquashCutoverOwned({ cutover, source: common.source,
      survivor: common.survivor, lease }), /collides with unknown bytes/u);
    assert.equal(await readFile(path.join(survivorWorkspace.projectRoot, "rename-y069.txt"), "utf8"),
      "late R069 user bytes\n");
    assert.equal((await service.readSquashCutoverOwned(cutover, { projectRoot: root, lease })).status,
      "materializing_additions");
    await rm(path.join(survivorWorkspace.projectRoot, "rename-y069.txt"));
    injectLateRename100Collision = true;
    await assert.rejects(service.applySquashCutoverOwned({ cutover, source: common.source,
      survivor: common.survivor, lease }), /collides with unknown bytes/u);
    assert.equal(await readFile(path.join(survivorWorkspace.projectRoot, "rename-z100.txt"), "utf8"),
      "late R100 user bytes\n");
    assert.equal((await service.readSquashCutoverOwned(cutover, { projectRoot: root, lease })).status,
      "materializing_additions");
    await rm(path.join(survivorWorkspace.projectRoot, "rename-z100.txt"));
    interruptAfterLastCopyBeforeIndex = true;
    await assert.rejects(service.applySquashCutoverOwned({ cutover, source: common.source,
      survivor: common.survivor, lease }), /after last exclusive copy/u);
    assert.equal(await readFile(path.join(survivorWorkspace.projectRoot, "rename-z100.txt"), "utf8"),
      "same rename bytes\n");
    assert.equal(await git(survivorWorkspace.projectRoot, "check-ignore", "--no-index", "rename-z100.txt"),
      "rename-z100.txt");
    assert.equal(await snapshotTree(survivorWorkspace.projectRoot), reviewedTree);
    assert.notEqual(await git(survivorWorkspace.projectRoot, "write-tree"), reviewedTree);
    assert.equal((await service.readSquashCutoverOwned(cutover, { projectRoot: root, lease })).status,
      "materializing_additions");
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

test("squash cutover materializes an additions-only reviewed replacement", { timeout: 90_000 }, async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-squash-additions-only-"));
  const dataDir = `${root}-data`;
  const reviewed = `${root}-reviewed`;
  const origin = `${root}-origin`;
  context.after(() => Promise.all([root, dataDir, reviewed, origin]
    .map((item) => rm(item, { recursive: true, force: true }))));
  await git(root, "init", "-b", "main");
  await git(root, "config", "core.autocrlf", "false");
  await writeFile(path.join(root, ".gitignore"), "only-added.txt\nunrelated-ignored.txt\n");
  await writeFile(path.join(root, "app.txt"), "main\n");
  const main = await commit(root, "main");
  await mkdir(origin);
  await git(origin, "init", "--bare");
  await git(root, "remote", "add", "origin", origin);
  await git(root, "push", "-u", "origin", "main");

  let interruptAfterPreservedRef = false;
  const service = new TaskGitWorkspaceService({
    dataDir,
    runCommand: async (args, options) => {
      if (interruptAfterPreservedRef && args[0] === "update-ref"
          && args[1]?.startsWith("refs/agent-hub/task-squash-cutovers/")) {
        interruptAfterPreservedRef = false;
        await runTaskGitCommand(args, options);
        throw new Error("injected additions-only crash after preserved ref");
      }
      return runTaskGitCommand(args, options);
    },
  });
  const sourceWorkspace = await service.prepare({ taskId: SOURCE_ID, taskNumber: "HUB-224", projectRoot: root });
  await writeFile(path.join(sourceWorkspace.projectRoot, "selected.txt"), "selected\n");
  const sourceTest = await service.snapshotAndMerge({
    taskId: SOURCE_ID, taskNumber: "HUB-224", projectRoot: sourceWorkspace.projectRoot,
  });
  const survivorWorkspace = await service.prepare({ taskId: SURVIVOR_ID, taskNumber: "HUB-235", projectRoot: root });
  await writeFile(path.join(survivorWorkspace.projectRoot, "residue.txt"), "excluded\n");
  const survivorTest = await service.snapshotAndMerge({
    taskId: SURVIVOR_ID, taskNumber: "HUB-235", projectRoot: survivorWorkspace.projectRoot,
  });

  await git(root, "-c", "core.autocrlf=false", "clone", survivorWorkspace.projectRoot, reviewed);
  await git(reviewed, "config", "core.autocrlf", "false");
  await git(reviewed, "checkout", "--detach", survivorTest.snapshot.headCommit);
  await rm(path.join(reviewed, "residue.txt"));
  await writeFile(path.join(reviewed, "selected.txt"), "selected\n");
  const baseline = await commit(reviewed, "reviewed preserved baseline");
  await writeFile(path.join(reviewed, "only-added.txt"), "reviewed addition\n");
  await git(reviewed, "add", "-f", "only-added.txt");
  const newResult = await commit(reviewed, "reviewed addition only");
  const reviewedTree = await git(reviewed, "rev-parse", "HEAD^{tree}");

  await rm(path.join(survivorWorkspace.projectRoot, "residue.txt"));
  await writeFile(path.join(survivorWorkspace.projectRoot, "selected.txt"), "selected\n");
  await git(survivorWorkspace.projectRoot, "add", "-A");
  const preservedTree = await git(survivorWorkspace.projectRoot, "write-tree");
  await git(survivorWorkspace.projectRoot, "reset");
  const baselineTree = await git(reviewed, "rev-parse", `${baseline}^{tree}`);
  await git(root, "fetch", "--no-tags", reviewed, baseline);
  assert.equal(preservedTree, baselineTree,
    `preserved/baseline difference: ${await git(root, "diff", "--name-status", preservedTree, baselineTree)}`);
  await writeFile(path.join(survivorWorkspace.projectRoot, "unrelated-ignored.txt"), "keep me\n");

  const dev = await service.prepareDev(root);
  const devBefore = await git(dev.projectRoot, "rev-parse", "HEAD");
  await writeFile(path.join(dev.projectRoot, "only-added.txt"), "reviewed addition\n");
  await git(dev.projectRoot, "add", "-A");
  await git(dev.projectRoot, "add", "-f", "only-added.txt");
  const devAfterTree = await git(dev.projectRoot, "write-tree");
  await git(dev.projectRoot, "reset", "--hard", devBefore);

  const source = { id: SOURCE_ID, revision: 4, releaseRevision: 4, workflowStatus: "testing",
    gitReferences: [{ projectRoot: root, branch: sourceWorkspace.branch, resultCommit: sourceTest.snapshot.headCommit }] };
  const survivor = { id: SURVIVOR_ID, revision: 8, releaseRevision: 6, workflowStatus: "in_progress",
    gitReferences: [{ projectRoot: root, branch: survivorWorkspace.branch, resultCommit: survivorTest.snapshot.headCommit }] };
  await service.withTaskLocks([SOURCE_ID, SURVIVOR_ID], async (lease) => {
    const preview = await service.previewSquashCutoverOwned({
      source, survivor, projectRoot: root, baselineResultCommit: baseline,
      newResultCommit: newResult, devAfterTree,
      authority: { workspaceId: "workspace", streamId: "release", provider: "codex",
        threadId: "thread", proofRequestId: "additions-only-preview" },
      reviewedSourceRoot: reviewed,
      cutover: {
        expectedMainCommit: main, expectedDevCommit: devBefore, expectedPreservedTree: preservedTree,
        reviewedSourceCommit: newResult, reviewedSourceTree: reviewedTree, projectorSha256: "a".repeat(64),
        artifacts: { sourceZipSha256: "b".repeat(64), bundleSha256: "c".repeat(64),
          manifestSha256: "d".repeat(64), filesSha256: "e".repeat(64) },
      },
      lease,
    });
    const cutover = { version: 1, kind: "task-squash-cutover-v1",
      expectedMainCommit: main, expectedDevCommit: devBefore, expectedPreservedTree: preservedTree,
      reviewedSourceCommit: newResult, reviewedSourceTree: reviewedTree, projectorSha256: "a".repeat(64),
      artifacts: { sourceZipSha256: "b".repeat(64), bundleSha256: "c".repeat(64),
        manifestSha256: "d".repeat(64), filesSha256: "e".repeat(64) },
      squashTransfer: preview };
    const oldIndexTree = await git(survivorWorkspace.projectRoot, "write-tree");
    assert.notEqual(oldIndexTree, preservedTree);
    assert.equal(await snapshotTree(survivorWorkspace.projectRoot), preservedTree);
    interruptAfterPreservedRef = true;
    await assert.rejects(service.applySquashCutoverOwned({ cutover, source, survivor, lease }),
      /additions-only crash after preserved ref/u);
    assert.equal(await git(survivorWorkspace.projectRoot, "write-tree"), oldIndexTree);
    assert.equal(await snapshotTree(survivorWorkspace.projectRoot), preservedTree);
    assert.equal((await service.readSquashCutoverOwned(cutover, { projectRoot: root, lease })).status,
      "pending_survivor_index");
    const applied = await service.applySquashCutoverOwned({ cutover, source, survivor, lease });
    assert.equal((await service.readSquashCutoverOwned(cutover, { projectRoot: root, lease })).status, "applied");
    assert.equal(await readFile(path.join(survivorWorkspace.projectRoot, "only-added.txt"), "utf8"), "reviewed addition\n");
    assert.equal(await readFile(path.join(survivorWorkspace.projectRoot, "unrelated-ignored.txt"), "utf8"), "keep me\n");
    assert.match(applied.squashTransfer.integrationCommit, /^[0-9a-f]{40}$/u);
  }, { guardTaskId: SURVIVOR_ID });
});

test("canonical original receipt recovery resumes survivor and dev index materialization", { timeout: 90_000 }, async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-squash-cutover-reconcile-"));
  const dataDir = `${root}-data`;
  const reviewed = `${root}-reviewed`;
  const databaseFile = path.join(dataDir, "journal.sqlite");
  const catalog = new WorkspaceCatalogStore({ databaseFile });
  await catalog.load();
  const store = new TaskBoardStore({ databaseFile });
  context.after(async () => {
    store.close();
    catalog.close();
    await Promise.all([root, dataDir, reviewed]
      .map((item) => rm(item, { recursive: true, force: true })));
  });
  await git(root, "init", "-b", "main");
  await git(root, "config", "core.autocrlf", "false");
  await writeFile(path.join(root, ".gitignore"), "only-added.txt\nunrelated-ignored.txt\n");
  await writeFile(path.join(root, "app.txt"), "v1\n");
  await writeFile(path.join(root, "release.txt"), "before\n");
  const main = await commit(root, "main");
  const workspace = await catalog.runMutation(() => catalog.createWorkspace({
    name: "Workspace", settings: { releaseWorkflowEnabled: true, workingDirectory: root },
  }));
  const stream = await catalog.runMutation(() => catalog.createStream({
    workspaceId: workspace.id, name: "Release Manager",
    settings: { releaseManager: true, workingDirectory: root },
  }));
  const taskBoard = new TaskBoardService({ store, workspaceCatalog: catalog,
    logger: { error() {}, warn() {} } });
  let interruptAfterPreservedRef = false;
  let interruptAfterDevRef = false;
  let interruptBeforeDevIndexPromotion = false;
  const gitService = new TaskGitWorkspaceService({
    dataDir: path.join(dataDir, "git"),
    runCommand: async (args, options) => {
      if (interruptAfterPreservedRef && args[0] === "update-ref"
          && args[1]?.startsWith("refs/agent-hub/task-squash-cutovers/")) {
        interruptAfterPreservedRef = false;
        await runTaskGitCommand(args, options);
        throw new Error("injected canonical crash after preserved ref");
      }
      if (interruptAfterDevRef && args[0] === "update-ref" && args[1] === "refs/heads/dev") {
        interruptAfterDevRef = false;
        await runTaskGitCommand(args, options);
        throw new Error("injected canonical crash after dev ref");
      }
      if (interruptBeforeDevIndexPromotion && args[0] === "read-tree"
          && args[1] === "-i" && args[2] === "-m") {
        interruptBeforeDevIndexPromotion = false;
        throw new Error("injected canonical crash before dev index promotion");
      }
      return runTaskGitCommand(args, options);
    },
  });
  let source = store.create({ text: "Source", bucket: "workspace", workspaceId: workspace.id });
  let survivor = store.create({ text: "Survivor", bucket: "workspace", workspaceId: workspace.id });
  source = store.claim(source.id, { workspaceId: workspace.id, streamId: stream.id,
    provider: "codex", threadId: "source-thread", turnId: "source-turn", operationId: "source-claim" });
  survivor = store.claim(survivor.id, { workspaceId: workspace.id, streamId: stream.id,
    provider: "codex", threadId: "survivor-thread", turnId: "survivor-turn", operationId: "survivor-claim" });
  const sourceWorkspace = await gitService.prepare({
    taskId: source.id, taskNumber: source.taskNumber, projectRoot: root,
  });
  await writeFile(path.join(sourceWorkspace.projectRoot, "selected.txt"), "selected\n");
  const sourceGit = await gitService.snapshotAndMerge({
    taskId: source.id, taskNumber: source.taskNumber, projectRoot: sourceWorkspace.projectRoot,
  });
  store.beginLifecycleTransition(source.id, { operationId: "source-test", kind: "workflow",
    targetWorkflowStatus: "testing", expectedRevision: source.revision });
  source = store.commitWorkflowTransition({ operationId: "source-test", gitReferences: [{
    projectRoot: root, branch: sourceWorkspace.branch, resultCommit: sourceGit.snapshot.headCommit,
  }] });
  const survivorWorkspace = await gitService.prepare({
    taskId: survivor.id, taskNumber: survivor.taskNumber, projectRoot: root,
  });
  await writeFile(path.join(survivorWorkspace.projectRoot, "residue.txt"), "excluded\n");
  const survivorGit = await gitService.snapshotAndMerge({
    taskId: survivor.id, taskNumber: survivor.taskNumber, projectRoot: survivorWorkspace.projectRoot,
  });
  store.beginLifecycleTransition(survivor.id, { operationId: "survivor-test", kind: "workflow",
    targetWorkflowStatus: "testing", expectedRevision: survivor.revision });
  survivor = store.commitWorkflowTransition({ operationId: "survivor-test", gitReferences: [{
    projectRoot: root, branch: survivorWorkspace.branch, resultCommit: survivorGit.snapshot.headCommit,
  }] });
  store.beginLifecycleTransition(survivor.id, { operationId: "survivor-edit", kind: "workflow",
    targetWorkflowStatus: "in_progress", expectedRevision: survivor.revision });
  survivor = store.commitWorkflowTransition({ operationId: "survivor-edit", replaceGitReferences: false });

  await git(root, "-c", "core.autocrlf=false", "clone", survivorWorkspace.projectRoot, reviewed);
  await git(reviewed, "config", "core.autocrlf", "false");
  await git(reviewed, "checkout", "--detach", survivorGit.snapshot.headCommit);
  await rm(path.join(reviewed, "residue.txt"));
  await writeFile(path.join(reviewed, "selected.txt"), "selected\n");
  await writeFile(path.join(reviewed, "app.txt"), "APPROVED DIRTY EDIT\n");
  const baseline = await commit(reviewed, "reviewed preserved baseline");
  await writeFile(path.join(reviewed, "release.txt"), "reviewed target\n");
  await writeFile(path.join(reviewed, "only-added.txt"), "reviewed addition\n");
  await git(reviewed, "add", "-f", "only-added.txt");
  const newResult = await commit(reviewed, "reviewed addition only");
  const reviewedTree = await git(reviewed, "rev-parse", "HEAD^{tree}");

  await rm(path.join(survivorWorkspace.projectRoot, "residue.txt"));
  await writeFile(path.join(survivorWorkspace.projectRoot, "selected.txt"), "selected\n");
  await writeFile(path.join(survivorWorkspace.projectRoot, "app.txt"), "APPROVED DIRTY EDIT\n");
  await git(survivorWorkspace.projectRoot, "add", "-A");
  const preservedTree = await git(survivorWorkspace.projectRoot, "write-tree");
  await git(survivorWorkspace.projectRoot, "reset");
  assert.equal(preservedTree, await git(reviewed, "rev-parse", `${baseline}^{tree}`));
  const oldIndexTree = await git(survivorWorkspace.projectRoot, "write-tree");
  assert.notEqual(oldIndexTree, preservedTree);
  await writeFile(path.join(survivorWorkspace.projectRoot, "unrelated-ignored.txt"), "keep me\n");

  const dev = await gitService.prepareDev(root);
  const devBefore = await git(dev.projectRoot, "rev-parse", "HEAD");
  const devBeforeTree = await git(dev.projectRoot, "rev-parse", `${devBefore}^{tree}`);
  await writeFile(path.join(dev.projectRoot, "release.txt"), "reviewed target\n");
  await writeFile(path.join(dev.projectRoot, "only-added.txt"), "reviewed addition\n");
  await git(dev.projectRoot, "add", "release.txt");
  await git(dev.projectRoot, "add", "-f", "only-added.txt");
  const devAfterTree = await git(dev.projectRoot, "write-tree");
  await git(dev.projectRoot, "reset", "--hard", devBefore);
  const lifecycle = new TaskLifecycleService({
    taskBoard, workspaceCatalog: catalog, taskGitWorkspaces: gitService,
    releasePreflight: { withAwaitTransition: async (_workspaceId, operation) => operation() },
  });
  const authority = { workspaceId: workspace.id, streamId: stream.id, provider: "codex",
    threadId: "release-thread", proofRequestId: "canonical-preview" };
  const identity = {
    taskId: survivor.id, sourceTaskId: source.id,
    expectedTaskRevision: survivor.revision, expectedSourceTaskRevision: source.revision,
    baselineResultCommit: baseline, newResultCommit: newResult, devAfterTree,
    authority, projectRoot: root, reviewedSourceTree: reviewedTree,
    expectedMainCommit: main, expectedDevCommit: devBefore, expectedPreservedTree: preservedTree,
    projectorSha256: "a".repeat(64),
    artifacts: { sourceZipSha256: "b".repeat(64), bundleSha256: "c".repeat(64),
      manifestSha256: "d".repeat(64), filesSha256: "e".repeat(64) },
    verifySource: async () => ({ sourceRoot: reviewed, headCommit: newResult, headTree: reviewedTree,
      projectorSha256: "a".repeat(64), artifacts: { sourceZipSha256: "b".repeat(64),
        bundleSha256: "c".repeat(64), manifestSha256: "d".repeat(64), filesSha256: "e".repeat(64) } }),
  };
  const preview = await lifecycle.squashTransferCutover({ ...identity, operationId: "canonical-preview" });
  const requestId = "canonical-confirm";
  const snake = {
    expected_task_revision: survivor.revision, expected_workflow_status: "in_progress",
    cutover_source_commit: newResult, cutover_projector_sha256: identity.projectorSha256,
    squash_source_task_id: source.id, squash_source_task_revision: source.revision,
    squash_baseline_result_commit: baseline, squash_new_result_commit: newResult,
    squash_dev_after_tree: devAfterTree, squash_proof_request_id: authority.proofRequestId,
    expected_squash_transfer_hash: preview.transferHash,
    squash_cutover_source_tree: reviewedTree, squash_cutover_expected_main_commit: main,
    squash_cutover_expected_dev_commit: devBefore,
    squash_cutover_expected_preserved_tree: preservedTree,
    squash_cutover_source_zip_sha256: identity.artifacts.sourceZipSha256,
    squash_cutover_bundle_sha256: identity.artifacts.bundleSha256,
    squash_cutover_manifest_sha256: identity.artifacts.manifestSha256,
    squash_cutover_files_sha256: identity.artifacts.filesSha256,
    expected_squash_cutover_hash: preview.cutoverHash,
  };
  await catalog.runMutation(() => catalog.beginMcpOperation({
    requestId, workspaceId: workspace.id, streamId: stream.id, provider: "codex",
    threadId: "release-thread", toolName: "hub_task_status_update",
    argumentsHash: argumentsHash({ request_id: requestId, status: "testing", task_id: survivor.id, ...snake }),
  }));
  interruptAfterPreservedRef = true;
  await assert.rejects(lifecycle.squashTransferCutover({ ...identity, operationId: requestId,
    expectedTransferHash: preview.transferHash, expectedCutoverHash: preview.cutoverHash }),
  /outcome is unknown/u);
  await catalog.runMutation(() => catalog.markMcpOperationUnknown(requestId,
    new Error("simulated lost cutover reply")));
  assert.equal(store.lifecycleTransition(requestId)?.phase, "pending_git");
  assert.equal(await git(survivorWorkspace.projectRoot, "write-tree"), oldIndexTree);
  assert.equal(await snapshotTree(survivorWorkspace.projectRoot), preservedTree);
  await gitService.withTaskLocks([source.id, survivor.id], async (lease) => {
    const readback = await gitService.readSquashCutoverOwned(preview.squashCutover, {
      projectRoot: root, lease,
    });
    assert.equal(readback.status, "pending_survivor_index");
    assert.equal(readback.proof, undefined);
  }, { guardTaskId: survivor.id });

  const reconciliation = new TaskOperationReconciliationService({
    workspaceCatalog: catalog, taskBoard, taskLifecycle: lifecycle,
  });
  const reconciliationInput = {
    workspaceId: workspace.id, taskId: survivor.id, operationRequestId: requestId,
    projectRoot: root, confirmed: true,
    expectedTaskRevision: survivor.revision, expectedWorkflowStatus: "in_progress",
    cutoverSourceCommit: newResult, cutoverProjectorSha256: identity.projectorSha256,
    squashSourceTaskId: source.id, squashSourceTaskRevision: source.revision,
    squashBaselineResultCommit: baseline, squashNewResultCommit: newResult,
    squashDevAfterTree: devAfterTree, squashProofRequestId: authority.proofRequestId,
    expectedSquashTransferHash: preview.transferHash,
    squashCutoverSourceTree: reviewedTree, squashCutoverExpectedMainCommit: main,
    squashCutoverExpectedDevCommit: devBefore, squashCutoverExpectedPreservedTree: preservedTree,
    squashCutoverSourceZipSha256: identity.artifacts.sourceZipSha256,
    squashCutoverBundleSha256: identity.artifacts.bundleSha256,
    squashCutoverManifestSha256: identity.artifacts.manifestSha256,
    squashCutoverFilesSha256: identity.artifacts.filesSha256,
    expectedSquashCutoverHash: preview.cutoverHash,
  };
  interruptAfterDevRef = true;
  const interrupted = await reconciliation.reconcileUnknownWorkflow(reconciliationInput);
  assert.equal(interrupted.outcome, "unknown");
  assert.match(interrupted.error, /after dev ref/u);
  assert.equal(catalog.mcpOperation(requestId).receiptState, "unknown");
  assert.equal(taskBoard.task(survivor.id).workflowStatus, "in_progress");
  assert.equal(taskBoard.task(source.id).workflowStatus, "testing");
  const integrationCommit = await git(root, "rev-parse", "refs/heads/dev");
  assert.notEqual(integrationCommit, devBefore);
  assert.equal(await git(root, "rev-parse", `${integrationCommit}^{tree}`), devAfterTree);
  assert.notEqual(await git(dev.projectRoot, "write-tree"), devAfterTree);
  await gitService.withTaskLocks([source.id, survivor.id], async (lease) => {
    const readback = await gitService.readSquashCutoverOwned(preview.squashCutover, {
      projectRoot: root, lease,
    });
    assert.equal(readback.status, "pending_materialization");
    assert.equal(readback.proof.integrationCommit, integrationCommit);
  }, { guardTaskId: survivor.id });
  interruptBeforeDevIndexPromotion = true;
  const indexInterrupted = await reconciliation.reconcileUnknownWorkflow(reconciliationInput);
  assert.equal(indexInterrupted.outcome, "unknown");
  assert.match(indexInterrupted.error, /before dev index promotion/u);
  assert.equal(catalog.mcpOperation(requestId).receiptState, "unknown");
  assert.equal(taskBoard.task(survivor.id).workflowStatus, "in_progress");
  assert.equal(taskBoard.task(source.id).workflowStatus, "testing");
  assert.equal(await git(dev.projectRoot, "write-tree"), devBeforeTree);
  assert.equal(await trackedWorktreeDiff(dev.projectRoot, integrationCommit), "");
  assert.equal(await readFile(path.join(dev.projectRoot, "release.txt"), "utf8"), "reviewed target\n");
  const result = await reconciliation.reconcileUnknownWorkflow(reconciliationInput);
  assert.equal(result.outcome, "succeeded");
  assert.equal(catalog.mcpOperation(requestId).receiptState, "succeeded");
  assert.equal(taskBoard.task(survivor.id).workflowStatus, "testing");
  assert.equal(taskBoard.task(source.id).workflowStatus, "in_progress");
  assert.equal(taskBoard.task(survivor.id).gitReferences[0].resultCommit, newResult);
  assert.equal(await git(survivorWorkspace.projectRoot, "write-tree"), reviewedTree);
  assert.equal(await snapshotTree(survivorWorkspace.projectRoot), reviewedTree);
  assert.equal(await readFile(path.join(survivorWorkspace.projectRoot, "only-added.txt"), "utf8"),
    "reviewed addition\n");
  assert.equal(await readFile(path.join(survivorWorkspace.projectRoot, "unrelated-ignored.txt"), "utf8"),
    "keep me\n");
  assert.equal(await git(dev.projectRoot, "write-tree"), devAfterTree);
  assert.equal(await trackedWorktreeDiff(dev.projectRoot, integrationCommit), "");
});
