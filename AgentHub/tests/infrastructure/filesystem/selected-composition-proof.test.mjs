import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { runTaskGitCommand } from "../../../src/infrastructure/filesystem/task-git-workspace.mjs";
import { verifySelectedCompositionObjects } from "../../../src/infrastructure/filesystem/selected-composition-proof.mjs";

const exec = promisify(execFile);

async function repository(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "selected-proof-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (args, options = {}) => runTaskGitCommand(args, { ...options, cwd: root });
  const command = async (...args) => (await exec("git", args, { cwd: root })).stdout.trim();
  const commit = async (message) => {
    await command("add", "-A");
    await command("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", message);
    return command("rev-parse", "HEAD");
  };
  await command("init", "-q");
  await writeFile(path.join(root, "conflict.txt"), "base\n");
  await writeFile(path.join(root, "CHANGELOG.md"), "base\n");
  const base = await commit("base");
  await command("switch", "-q", "-c", "published");
  await writeFile(path.join(root, "conflict.txt"), "published\n");
  const published = await commit("published");
  await command("switch", "-q", "-c", "local", base);
  await writeFile(path.join(root, "local.txt"), "accepted local\n");
  const local = await commit("local");
  await command("switch", "-q", "-c", "task");
  await writeFile(path.join(root, "feature.txt"), "selected feature\n");
  await commit("task feature");
  await command("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "merge", "--no-ff", "-m", "approved published side", published);
  await writeFile(path.join(root, "task-later.txt"), "later selected feature\n");
  const task = await commit("task later");
  await command("switch", "-q", "-c", "dev", local);
  await writeFile(path.join(root, "conflict.txt"), "dev\n");
  await writeFile(path.join(root, "unselected.txt"), "unselected dev\n");
  const dev = await commit("unselected dev");
  let baseline;
  try {
    await command("merge-tree", "--write-tree", dev, task);
    throw new Error("fixture unexpectedly has no conflict");
  } catch (error) {
    baseline = String(error.stdout ?? "").split(/\r?\n/u)[0];
  }
  assert.match(baseline, /^[0-9a-f]{40}$/u);
  const index = path.join(root, "selected.index");
  const indexCommand = async (...args) => (await exec("git", args, {
    cwd: root, env: { ...process.env, GIT_INDEX_FILE: index },
  })).stdout.trim();
  await indexCommand("read-tree", baseline);
  await writeFile(path.join(root, "resolved.txt"), "reviewed resolution\n");
  const resolvedBlob = await command("hash-object", "-w", "resolved.txt");
  await indexCommand("update-index", "--add", "--cacheinfo", "100644", resolvedBlob, "conflict.txt");
  const resolvedTree = await indexCommand("write-tree");
  const proof = (await exec("git", ["commit-tree", resolvedTree, "-p", dev, "-p", task,
    "-m", "reviewed conflict resolution"], {
    cwd: root,
    env: { ...process.env, GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.invalid",
      GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.invalid" },
  })).stdout.trim();
  return { root, git, base, local, published, task, dev, proof, resolvedTree };
}

function inputs(f) {
  return { git: f.git, taskId: "test-task", repositoryKey: "repo", taskBaseCommit: f.local,
    acceptedLocalMainCommit: f.local, taskCommit: f.task, devCommit: f.dev,
    proofCommit: f.proof, publishedCommit: f.published, publicationGeneration: "generation-1",
    remoteCommit: f.published, bundleSha256: "a".repeat(64) };
}

test("selected proof binds one published Task side and only reviewed conflict entries", async (t) => {
  const f = await repository(t);
  const proof = await verifySelectedCompositionObjects(inputs(f));
  assert.equal(proof.releaseParent, f.published);
  assert.equal(proof.conflictWitnesses.length, 1);
  assert.deepEqual(proof.conflictWitnesses.map((item) => item.path), ["conflict.txt"]);
  assert.ok(proof.worktreePlan.some((item) => item.path === "feature.txt"));
  assert.ok(!proof.worktreePlan.some((item) => item.path === "unselected.txt"));
  const selectedPaths = await f.git(["diff", "--name-only", proof.releaseParent, f.task]);
  assert.ok(!selectedPaths.split(/\r?\n/u).includes("unselected.txt"));
  assert.equal((await readFile(path.join(f.root, "unselected.txt"), "utf8")), "unselected dev\n");
});

test("selected proof rejects wrong review parent, remote and publication identity", async (t) => {
  const f = await repository(t);
  await assert.rejects(verifySelectedCompositionObjects({ ...inputs(f), taskCommit: f.published }), /ancestry changed/u);
  await assert.rejects(verifySelectedCompositionObjects({ ...inputs(f), remoteCommit: f.local }), /publication, bundle or Task identity/u);
  await assert.rejects(verifySelectedCompositionObjects({ ...inputs(f), publishedCommit: f.local,
    remoteCommit: f.local }), /divergent published-main case/u);
});
