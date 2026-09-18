import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  resolveExactDirectTaskSideMerge,
  resolveExactOrderPreservingUnion,
  resolveExactTaskBaseMerge,
} from "../../../src/infrastructure/filesystem/release-order-preserving-union.mjs";

const exec = promisify(execFile);

async function gitInput(cwd, args, input) {
  await new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    const stderr = [];
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => code === 0
      ? resolve()
      : reject(new Error(`git ${args.join(" ")} exited ${code}: ${Buffer.concat(stderr).toString("utf8")}`)));
    child.stdin.end(input);
  });
}

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

test("stale raw integration accepts only its exact approved-main and Task-side auto-merge", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hub-release-direct-task-side-"));
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
  await writeFile(file, "anchor\n", "utf8");
  const base = await commit("base");
  await writeFile(file, "anchor\npublished-main\n", "utf8");
  const approved = await commit("approved main");
  await git(["checkout", "-b", "task"]);
  await writeFile(file, "anchor\npublished-main\ntask-owned\n", "utf8");
  const taskSide = await commit("Task side contains approved main plus owned change");
  await git(["checkout", "-b", "dev", base]);
  await git(["merge", "--no-ff", "--no-edit", taskSide]);
  const integration = await git(["rev-parse", "HEAD"]);
  await git(["update-ref", "refs/remotes/workspace/dev", integration]);
  await git(["checkout", "main"]);

  const conflict = async (ours = approved) => {
    await git(["reset", "--hard", ours]);
    const [baseBlob, oursBlob, theirsBlob] = await Promise.all([
      git(["rev-parse", `${base}:shared.txt`]),
      git(["rev-parse", `${ours}:shared.txt`]),
      git(["rev-parse", `${integration}:shared.txt`]),
    ]);
    await git(["read-tree", "--empty"]);
    await gitInput(root, ["update-index", "--index-info"], [
      `100644 ${baseBlob} 1\tshared.txt`,
      `100644 ${oursBlob} 2\tshared.txt`,
      `100644 ${theirsBlob} 3\tshared.txt`,
      "",
    ].join("\n"));
    assert.match(await git(["diff", "--name-only", "--diff-filter=U"]), /shared\.txt/u);
  };
  await conflict();
  assert.equal(await resolveExactDirectTaskSideMerge({
    candidateRoot: root, conflicts: ["shared.txt"], approvedBaseCommit: approved,
    integrationCommit: integration, integrationTaskCommit: taskSide,
    taskBaseCommit: approved, taskResultCommit: taskSide,
    uniqueSelectedOwner: false,
  }), false, "shared or missing ownership never authorizes the proof");
  assert.equal(await resolveExactDirectTaskSideMerge({
    candidateRoot: root, conflicts: ["shared.txt"], approvedBaseCommit: approved,
    integrationCommit: integration, integrationTaskCommit: base,
    taskBaseCommit: approved, taskResultCommit: taskSide,
    uniqueSelectedOwner: true,
  }), false, "the supplied Task-side parent must be exact");

  await conflict();
  assert.equal(await resolveExactDirectTaskSideMerge({
    candidateRoot: root, conflicts: ["shared.txt"], approvedBaseCommit: base,
    integrationCommit: integration, integrationTaskCommit: taskSide,
    taskBaseCommit: approved, taskResultCommit: taskSide,
    uniqueSelectedOwner: true,
  }), false, "index ours must be the exact approved main entry");

  await git(["reset", "--hard", approved]);
  await git(["checkout", "-B", "foreign-dev", integration]);
  await writeFile(file, "anchor\npublished-main\ntask-owned\nforeign\n", "utf8");
  const foreignDev = await commit("foreign accepted dev bytes");
  await conflict();
  assert.equal(await resolveExactDirectTaskSideMerge({
    candidateRoot: root, conflicts: ["shared.txt"], approvedBaseCommit: approved,
    integrationCommit: integration, integrationTaskCommit: taskSide,
    taskBaseCommit: approved, taskResultCommit: taskSide,
    uniqueSelectedOwner: true, devRef: foreignDev,
  }), false, "current accepted dev must match the direct merge entry");

  await git(["reset", "--hard", integration]);
  await git(["update-index", "--chmod=+x", "shared.txt"]);
  const executableTree = await git(["write-tree"]);
  const executableDev = await git([
    "commit-tree", executableTree, "-p", integration, "-m", "accepted dev mode drift",
  ]);
  await conflict();
  assert.equal(await resolveExactDirectTaskSideMerge({
    candidateRoot: root, conflicts: ["shared.txt"], approvedBaseCommit: approved,
    integrationCommit: integration, integrationTaskCommit: taskSide,
    taskBaseCommit: approved, taskResultCommit: taskSide,
    uniqueSelectedOwner: true, devRef: executableDev,
  }), false, "matching bytes cannot hide an accepted-dev mode change");

  await git(["reset", "--hard", integration]);
  const acceptedBlob = await git(["rev-parse", `${integration}:shared.txt`]);
  await git(["read-tree", integration]);
  await git(["update-index", "--cacheinfo", `120000,${acceptedBlob},shared.txt`]);
  const symlinkTree = await git(["write-tree"]);
  const symlinkDev = await git([
    "commit-tree", symlinkTree, "-p", integration, "-m", "accepted dev type drift",
  ]);
  await conflict();
  assert.equal(await resolveExactDirectTaskSideMerge({
    candidateRoot: root, conflicts: ["shared.txt"], approvedBaseCommit: approved,
    integrationCommit: integration, integrationTaskCommit: taskSide,
    taskBaseCommit: approved, taskResultCommit: taskSide,
    uniqueSelectedOwner: true, devRef: symlinkDev,
  }), false, "matching blob identity cannot change a regular file into a symlink");

  await git(["reset", "--hard", integration]);
  await writeFile(file, "anchor\npublished-main\ntask-owned\nmanual\n", "utf8");
  const manualTree = await git(["add", "shared.txt"]).then(() => git(["write-tree"]));
  const manualIntegration = await git([
    "commit-tree", manualTree, "-p", base, "-p", taskSide, "-m", "manual integration tree",
  ]);
  await git(["update-ref", "refs/heads/manual-dev", manualIntegration]);
  await conflict();
  assert.equal(await resolveExactDirectTaskSideMerge({
    candidateRoot: root, conflicts: ["shared.txt"], approvedBaseCommit: approved,
    integrationCommit: manualIntegration, integrationTaskCommit: taskSide,
    taskBaseCommit: approved, taskResultCommit: taskSide,
    uniqueSelectedOwner: true, devRef: "refs/heads/manual-dev",
  }), false, "a non-automatic integration cannot authorize direct resolution");

  await conflict();
  assert.equal(await resolveExactDirectTaskSideMerge({
    candidateRoot: root, conflicts: ["shared.txt"], approvedBaseCommit: approved,
    integrationCommit: integration, integrationTaskCommit: taskSide,
    taskBaseCommit: approved, taskResultCommit: taskSide,
    uniqueSelectedOwner: true,
  }), true);
  assert.equal(await readFile(file, "utf8"), "anchor\npublished-main\ntask-owned\n");
  assert.equal(await git(["diff", "--name-only", "--diff-filter=U"]), "");

  const approvedTree = await git(["rev-parse", `${approved}^{tree}`]);
  const foreignTaskResult = await git([
    "commit-tree", approvedTree, "-p", approved, "-m", "foreign Task lineage",
  ]);
  await conflict();
  assert.equal(await resolveExactDirectTaskSideMerge({
    candidateRoot: root, conflicts: ["shared.txt"], approvedBaseCommit: approved,
    integrationCommit: integration, integrationTaskCommit: taskSide,
    taskBaseCommit: approved, taskResultCommit: foreignTaskResult,
    uniqueSelectedOwner: true,
  }), false, "a foreign integration p2 outside the frozen Task lineage is rejected");

  const taskSideTree = await git(["rev-parse", `${taskSide}^{tree}`]);
  const laterChange = await git([
    "commit-tree", manualTree, "-p", taskSide, "-m", "later Task change",
  ]);
  const laterRevert = await git([
    "commit-tree", taskSideTree, "-p", laterChange, "-m", "later Task revert",
  ]);
  await conflict();
  assert.equal(await resolveExactDirectTaskSideMerge({
    candidateRoot: root, conflicts: ["shared.txt"], approvedBaseCommit: approved,
    integrationCommit: integration, integrationTaskCommit: taskSide,
    taskBaseCommit: approved, taskResultCommit: laterRevert,
    uniqueSelectedOwner: true,
  }), true, "later Task change and revert does not erase temporal p2 provenance");

  await git(["reset", "--hard", base]);
  await writeFile(file, "anchor\nconflicting-main\n", "utf8");
  const conflictingMain = await commit("conflicting approved main");
  await conflict(conflictingMain);
  assert.equal(await resolveExactDirectTaskSideMerge({
    candidateRoot: root, conflicts: ["shared.txt"], approvedBaseCommit: conflictingMain,
    integrationCommit: integration, integrationTaskCommit: taskSide,
    taskBaseCommit: approved, taskResultCommit: taskSide,
    uniqueSelectedOwner: true,
  }), false, "a direct approved-main and Task-side conflict remains unresolved");
});
