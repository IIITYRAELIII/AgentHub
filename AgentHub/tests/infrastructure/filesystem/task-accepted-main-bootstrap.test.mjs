import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { runTaskGitCommand, TaskGitWorkspaceService } from "../../../src/infrastructure/filesystem/task-git-workspace.mjs";

const execFileAsync = promisify(execFile);
const git = async (cwd, ...args) => String((await execFileAsync("git", args, {
  cwd, windowsHide: true,
})).stdout).trim();
const commit = async (cwd, message) => {
  await git(cwd, "add", "-A");
  await git(cwd, "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
    "commit", "-m", message);
  return git(cwd, "rev-parse", "HEAD");
};

async function fixture(context, { divergedPublication = false } = {}) {
  const parent = await mkdtemp(path.join(os.tmpdir(), "hub-accepted-main-bootstrap-"));
  context.after(() => rm(parent, { recursive: true, force: true }));
  const root = path.join(parent, "repo");
  await mkdir(root);
  await git(root, "init", "-b", "main");
  await git(root, "config", "core.autocrlf", "false");
  await writeFile(path.join(root, "app.txt"), "base\n");
  const base = await commit(root, "shared base");
  let published = base;
  if (divergedPublication) {
    await git(root, "checkout", "-b", "publication", base);
    await writeFile(path.join(root, "published.txt"), "published side\n");
    published = await commit(root, "published side");
    await git(root, "checkout", "main");
  }
  const publication = { generation: "g1", repositories: [{ root, revision: published }] };
  const service = new TaskGitWorkspaceService({ dataDir: path.join(parent, "data"),
    readPublication: async () => publication });
  const task = await service.prepare({ taskId: "11111111-1111-4111-8111-111111111111", projectRoot: root });
  await writeFile(path.join(task.projectRoot, "task.txt"), "selected task\n");
  const taskResult = await commit(task.projectRoot, "task result");
  const dev = await service.prepareDev(root);
  await writeFile(path.join(dev.projectRoot, "dev.txt"), "unrelated dev\n");
  const oldDev = await commit(dev.projectRoot, "unrelated dev result");
  await writeFile(path.join(root, "main.txt"), "accepted local main\n");
  const main = await commit(root, "accepted main advance");
  return { root, service, base, published, main, oldDev, devRoot: dev.projectRoot,
    taskRoot: task.projectRoot, taskResult };
}

function input(f, requestId = "accepted-main-bootstrap-one") {
  return { projectRoot: f.root, acceptedMainCommit: f.main,
    expectedDevCommit: f.oldDev, publishedRevision: f.published,
    expectedPublicationGeneration: "g1", expectedMergeBaseCommit: f.base, requestId };
}

test("accepted main bootstraps managed dev without changing a separate Task result", { timeout: 90_000 }, async (context) => {
  const f = await fixture(context);
  const result = await f.service.bootstrapAcceptedMainIntoDev(input(f));
  assert.equal(result.status, "merged");
  assert.equal(await git(f.root, "rev-parse", "dev"), result.headCommit);
  assert.equal(await git(f.devRoot, "status", "--porcelain"), "");
  assert.equal(await readFile(path.join(f.devRoot, "dev.txt"), "utf8"), "unrelated dev\n");
  assert.equal(await readFile(path.join(f.devRoot, "main.txt"), "utf8"), "accepted local main\n");
  assert.equal(await git(f.taskRoot, "rev-parse", "HEAD"), f.taskResult);
  assert.equal(await git(f.root, "rev-parse", "main"), f.main);
  const replay = await f.service.bootstrapAcceptedMainIntoDev(input(f));
  assert.equal(replay.status, "completed_replay");
  assert.equal(replay.headCommit, result.headCommit);
  await assert.rejects(f.service.bootstrapAcceptedMainIntoDev({ ...input(f), expectedDevCommit: f.main }),
    /request identity changed/u);
});

test("accepted main bootstrap keeps divergent published history out of dev", { timeout: 90_000 }, async (context) => {
  const f = await fixture(context, { divergedPublication: true });
  const result = await f.service.bootstrapAcceptedMainIntoDev(input(f, "divergent-published-side"));
  assert.equal(result.status, "merged");
  assert.equal(await git(f.root, "merge-base", f.main, f.published), f.base);
  assert.equal(await readFile(path.join(f.devRoot, "main.txt"), "utf8"), "accepted local main\n");
  await assert.rejects(readFile(path.join(f.devRoot, "published.txt"), "utf8"), { code: "ENOENT" });
  assert.equal(await git(f.taskRoot, "rev-parse", "HEAD"), f.taskResult);
});

test("accepted main bootstrap rejects stale CAS and dirty managed dev before effects", { timeout: 90_000 }, async (context) => {
  const f = await fixture(context);
  await assert.rejects(f.service.bootstrapAcceptedMainIntoDev({
    ...input(f), expectedPublicationGeneration: "stale",
  }), /publication provenance changed/u);
  await assert.rejects(f.service.bootstrapAcceptedMainIntoDev({
    ...input(f), acceptedMainCommit: f.published,
  }), /local main identity changed/u);
  await assert.rejects(f.service.bootstrapAcceptedMainIntoDev({
    ...input(f), expectedMergeBaseCommit: f.main,
  }), /ancestry proof changed/u);
  await assert.rejects(f.service.bootstrapAcceptedMainIntoDev({ ...input(f), expectedDevCommit: f.published }),
    /CAS changed/u);
  assert.equal(await git(f.root, "rev-parse", "dev"), f.oldDev);
  await writeFile(path.join(f.devRoot, "untracked.txt"), "dirty\n");
  await assert.rejects(f.service.bootstrapAcceptedMainIntoDev(input(f)), /dirty index\/worktree|clean managed dev/u);
  assert.equal(await git(f.root, "rev-parse", "dev"), f.oldDev);
  assert.equal(await readFile(path.join(f.devRoot, "untracked.txt"), "utf8"), "dirty\n");
});

test("accepted main bootstrap conflict restores exact managed dev", { timeout: 90_000 }, async (context) => {
  const f = await fixture(context);
  await writeFile(path.join(f.devRoot, "app.txt"), "dev edit\n");
  f.oldDev = await commit(f.devRoot, "dev conflict");
  await writeFile(path.join(f.root, "app.txt"), "main edit\n");
  f.main = await commit(f.root, "main conflict");
  const result = await f.service.bootstrapAcceptedMainIntoDev(input(f, "conflict-one"));
  assert.equal(result.status, "conflict");
  assert.deepEqual(result.conflicts, ["app.txt"]);
  assert.equal(await git(f.root, "rev-parse", "dev"), f.oldDev);
  assert.equal(await git(f.devRoot, "status", "--porcelain"), "");
  assert.equal(await readFile(path.join(f.devRoot, "app.txt"), "utf8"), "dev edit\n");
});

test("accepted main bootstrap recovers one exact CAS after interrupted materialization", { timeout: 90_000 }, async (context) => {
  const f = await fixture(context);
  let interrupted = false;
  f.service.runCommand = async (args, options) => {
    if (!interrupted && args[0] === "reset" && args[1] === "--hard") {
      interrupted = true;
      const error = new Error("injected pre-reset interruption");
      error.processTreeStopped = true;
      throw error;
    }
    return runTaskGitCommand(args, options);
  };
  await assert.rejects(f.service.bootstrapAcceptedMainIntoDev(input(f, "interrupted-once")),
    /injected pre-reset interruption/u);
  assert.equal(interrupted, true);
  const advanced = await git(f.root, "rev-parse", "dev");
  assert.notEqual(advanced, f.oldDev);
  assert.equal(await readFile(path.join(f.devRoot, "dev.txt"), "utf8"), "unrelated dev\n");
  const recovered = await f.service.bootstrapAcceptedMainIntoDev(input(f, "interrupted-once"));
  assert.equal(recovered.status, "completed_replay");
  assert.equal(recovered.headCommit, advanced);
  assert.equal(await readFile(path.join(f.devRoot, "main.txt"), "utf8"), "accepted local main\n");
});
