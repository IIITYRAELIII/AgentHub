import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  resolveExactOrderPreservingUnion,
  resolveExactTaskBaseMerge,
} from "../../../src/infrastructure/filesystem/release-order-preserving-union.mjs";

const exec = promisify(execFile);

test("order-preserving conflict accepts only an exact durable dev merge of both index sides", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hub-release-union-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = async (args) => (await exec("git", args, { cwd: root, windowsHide: true })).stdout.trim();
  await git(["init", "--initial-branch=main"]);
  await git(["config", "user.name", "Test"]);
  await git(["config", "user.email", "test@example.invalid"]);
  await git(["config", "core.autocrlf", "false"]);
  const file = path.join(root, "shared.txt");
  const commit = async (message) => {
    await git(["add", "-A"]);
    await git(["commit", "-m", message]);
    return git(["rev-parse", "HEAD"]);
  };
  await writeFile(file, "anchor\nend\n", "utf8");
  const base = await commit("base");
  await git(["checkout", "-b", "task"]);
  await writeFile(file, "anchor\ntask\nend\n", "utf8");
  const task = await commit("task");
  await git(["checkout", "main"]);
  await writeFile(file, "anchor\nmain\nend\n", "utf8");
  const historicalMain = await commit("main");
  await git(["checkout", "-b", "dev", task]);
  await assert.rejects(git(["merge", "--no-commit", "main"]));
  await writeFile(file, "anchor\nresolved task + main\nend\n", "utf8");
  await git(["add", "shared.txt"]);
  await git(["commit", "--no-edit"]);
  const exact = await git(["rev-parse", "HEAD"]);
  await git(["checkout", "-b", "foreign"]);
  await writeFile(file, "anchor\nresolved task + main\nforeign\nend\n", "utf8");
  const foreign = await commit("foreign baggage after resolution");
  await git(["checkout", "main"]);
  await writeFile(path.join(root, "unrelated.txt"), "new approved base\n", "utf8");
  const approvedMain = await commit("advance approved base outside the conflict path");
  await assert.rejects(git(["merge", "--no-commit", task]));
  assert.match(await git(["diff", "--name-only", "--diff-filter=U"]), /shared\.txt/u);
  assert.equal(await resolveExactOrderPreservingUnion({
    candidateRoot: root, conflicts: ["shared.txt"], approvedBaseCommit: approvedMain,
    devRef: foreign,
  }), false);
  assert.equal(await resolveExactOrderPreservingUnion({
    candidateRoot: root, conflicts: ["shared.txt"], approvedBaseCommit: approvedMain,
    devRef: exact,
  }), true);
  assert.equal(await readFile(file, "utf8"), "anchor\nresolved task + main\nend\n");
  assert.equal(await git(["diff", "--name-only", "--diff-filter=U"]), "");
  assert.equal(await git(["rev-parse", "HEAD"]), await git(["rev-parse", "main"]));
  await git(["reset", "--hard", approvedMain]);
  await writeFile(file, "anchor\nchanged approved base\nend\n", "utf8");
  const changedApprovedMain = await commit("advance approved base on conflict path");
  await assert.rejects(git(["merge", "--no-commit", task]));
  assert.equal(await resolveExactOrderPreservingUnion({
    candidateRoot: root, conflicts: ["shared.txt"], approvedBaseCommit: changedApprovedMain,
    devRef: exact,
  }), false);
  assert.notEqual(base, task);
  assert.notEqual(historicalMain, approvedMain);
});

test("stale reopened integration accepts only one exact Task merge with the approved base", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hub-release-task-base-union-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = async (args) => (await exec("git", args, { cwd: root, windowsHide: true })).stdout.trim();
  const commit = async (message) => {
    await git(["add", "-A"]);
    await git(["commit", "-m", message]);
    return git(["rev-parse", "HEAD"]);
  };
  const file = path.join(root, "shared.txt");
  await git(["init", "--initial-branch=main"]);
  await git(["config", "user.name", "Test"]);
  await git(["config", "user.email", "test@example.invalid"]);
  await git(["config", "core.autocrlf", "false"]);
  await writeFile(file, "setting=base\n", "utf8");
  const base = await commit("base");
  await git(["branch", "dev"]);
  await git(["checkout", "-b", "task"]);
  await writeFile(path.join(root, "owned.txt"), "first revision\n", "utf8");
  const firstResult = await commit("first Task revision");
  await git(["checkout", "dev"]);
  await git(["merge", "--no-ff", "--no-edit", firstResult]);
  const firstIntegration = await git(["rev-parse", "HEAD"]);
  await git(["checkout", "main"]);
  await writeFile(file, "setting=approved-main\n", "utf8");
  const approved = await commit("approved main");
  await git(["checkout", "task"]);
  await writeFile(file, "setting=task\n", "utf8");
  const taskRevision = await commit("reopened Task revision");
  await assert.rejects(git(["merge", "--no-ff", "--no-commit", approved]));
  await writeFile(file, "setting=task+approved-main\n", "utf8");
  await git(["add", "shared.txt"]);
  await git(["commit", "--no-edit"]);
  const taskBaseMerge = await git(["rev-parse", "HEAD"]);
  const acceptedTree = await git(["rev-parse", `${taskBaseMerge}^{tree}`]);
  const acceptedBlob = await git(["rev-parse", `${taskBaseMerge}:shared.txt`]);
  await git(["read-tree", taskBaseMerge]);
  await git(["update-index", "--chmod=+x", "shared.txt"]);
  const executableTree = await git(["write-tree"]);
  const executableResult = await git([
    "commit-tree", executableTree, "-p", taskBaseMerge, "-m", "executable accepted state",
  ]);
  await git(["update-ref", "refs/heads/executable-result", executableResult]);
  await git(["read-tree", taskBaseMerge]);
  await git(["update-index", "--cacheinfo", `120000,${acceptedBlob},shared.txt`]);
  const symlinkTree = await git(["write-tree"]);
  const symlinkResult = await git([
    "commit-tree", symlinkTree, "-p", taskBaseMerge, "-m", "symlink accepted state",
  ]);
  await git(["update-ref", "refs/heads/symlink-result", symlinkResult]);
  const foreignProof = await git([
    "commit-tree", acceptedTree, "-p", taskRevision, "-p", approved, "-m", "foreign matching proof",
  ]);
  const foreignResult = await git([
    "commit-tree", acceptedTree, "-p", taskRevision, "-p", foreignProof, "-m", "imports foreign proof",
  ]);
  await git(["update-ref", "refs/heads/foreign-proof", foreignProof]);
  await git(["reset", "--hard", taskBaseMerge]);
  await git(["checkout", "dev"]);
  const staleParent = await git(["rev-parse", "HEAD"]);
  await git(["merge", "--no-ff", "--no-edit", taskBaseMerge]);
  const integration = await git(["rev-parse", "HEAD"]);
  await git(["update-ref", "refs/remotes/workspace/dev", integration]);
  const patchFile = path.join(root, "stale.patch");
  await writeFile(patchFile, (await exec("git", [
    "diff", "--binary", "--full-index", staleParent, integration, "--", "shared.txt",
  ], { cwd: root, windowsHide: true })).stdout);
  await git(["checkout", "main"]);
  await assert.rejects(git(["apply", "--3way", "--index", patchFile]));
  assert.match(await git(["diff", "--name-only", "--diff-filter=U"]), /shared\.txt/u);

  assert.equal(await resolveExactTaskBaseMerge({
    candidateRoot: root, conflicts: ["shared.txt"], approvedBaseCommit: approved,
    taskResultCommit: taskBaseMerge, integrationCommit: firstIntegration,
  }), false, "a proof outside the replayed integration ancestry is foreign");
  assert.equal(await resolveExactTaskBaseMerge({
    candidateRoot: root, conflicts: ["shared.txt"], approvedBaseCommit: base,
    taskResultCommit: taskBaseMerge, integrationCommit: integration,
  }), false, "the proof must bind the exact approved base");
  assert.equal(await resolveExactTaskBaseMerge({
    candidateRoot: root, conflicts: ["shared.txt"], approvedBaseCommit: approved,
    taskResultCommit: foreignResult, integrationCommit: foreignProof, devRef: "refs/heads/foreign-proof",
  }), false, "a matching proof reachable only through a dev-side parent is not Task-local");
  assert.equal(await resolveExactTaskBaseMerge({
    candidateRoot: root, conflicts: ["shared.txt"], approvedBaseCommit: approved,
    taskResultCommit: executableResult, integrationCommit: executableResult, devRef: "refs/heads/executable-result",
  }), false, "identical bytes cannot change a regular file to executable");
  assert.equal(await resolveExactTaskBaseMerge({
    candidateRoot: root, conflicts: ["shared.txt"], approvedBaseCommit: approved,
    taskResultCommit: symlinkResult, integrationCommit: symlinkResult, devRef: "refs/heads/symlink-result",
  }), false, "identical blob bytes cannot change a regular file to a symlink");

  const duplicate = await git([
    "commit-tree", acceptedTree, "-p", taskBaseMerge, "-p", approved, "-m", "ambiguous duplicate proof",
  ]);
  await git(["update-ref", "refs/heads/ambiguous", duplicate]);
  assert.equal(await resolveExactTaskBaseMerge({
    candidateRoot: root, conflicts: ["shared.txt"], approvedBaseCommit: approved,
    taskResultCommit: duplicate, integrationCommit: duplicate, devRef: "refs/heads/ambiguous",
  }), false, "multiple exact proof merges remain ambiguous");

  assert.equal(await resolveExactTaskBaseMerge({
    candidateRoot: root, conflicts: ["shared.txt"], approvedBaseCommit: approved,
    taskResultCommit: taskBaseMerge, integrationCommit: integration,
  }), true);
  assert.equal(await readFile(file, "utf8"), "setting=task+approved-main\n");
  assert.equal(await git(["diff", "--name-only", "--diff-filter=U"]), "");
});
