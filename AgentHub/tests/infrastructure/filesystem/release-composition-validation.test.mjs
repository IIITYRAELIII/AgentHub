import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { ReleaseGitWorkspaceService } from "../../../src/infrastructure/filesystem/release-git-workspace.mjs";

const exec = promisify(execFile);
async function git(cwd, ...args) {
  return (await exec("git", args, { cwd, windowsHide: true })).stdout.trim();
}
async function commit(cwd, name) {
  await git(cwd, "add", "-A");
  await git(cwd, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", name);
  return git(cwd, "rev-parse", "HEAD");
}
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ah-comp-test-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3 }));
  const origin = path.join(root, "origin.git");
  const primary = path.join(root, "primary");
  await git(root, "init", "--bare", "--initial-branch=main", origin);
  await git(root, "clone", origin, primary);
  await writeFile(path.join(primary, ".gitattributes"), "* text eol=lf\n");
  await writeFile(path.join(primary, "app.txt"), "base\n");
  const base = await commit(primary, "base");
  await git(primary, "push", "origin", "main");
  const dataDir = path.join(root, "data");
  const service = new ReleaseGitWorkspaceService({ dataDir });
  async function result(branch, content) {
    const worktree = path.join(root, branch);
    await git(primary, "worktree", "add", "-b", branch, worktree, base);
    await writeFile(path.join(worktree, "app.txt"), content);
    return commit(worktree, branch);
  }
  const left = await result("left", "left\n");
  const request = {
    workspaceId: "workspace", projectRoot: primary, approvedBaseCommit: base, planRevision: "plan-left",
    frozenTasks: [{ taskId: "left", taskRevision: 1, baseCommit: base, resultCommit: left }],
  };
  return { root, primary, dataDir, service, result, request, left };
}
async function snapshot(directory) {
  const files = {};
  async function visit(current) {
    for (const entry of await readdir(current, { withFileTypes: true }).catch((error) => {
      if (error.code === "ENOENT") return [];
      throw error;
    })) {
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(file);
      else files[path.relative(directory, file)] = (await readFile(file)).toString("base64");
    }
  }
  await visit(directory);
  return files;
}

test("composition validation uses canonical selected bytes without changing a prepared or frozen holder", async (t) => {
  const f = await fixture(t);
  const existing = await f.service.prepareCandidate(f.request);
  const checkpointFile = path.join(path.dirname(existing.releaseRoot), "checkpoint.json");
  for (const phase of ["prepared", "frozen"]) {
    const checkpoint = JSON.parse(await readFile(checkpointFile, "utf8"));
    await writeFile(checkpointFile, JSON.stringify({ ...checkpoint, phase }));
    const before = await snapshot(f.dataDir);
    let validations = 0;
    const proof = await f.service.validateCandidate({ ...f.request, validateBeforeCommit: async () => { validations++; } });
    assert.equal(proof.status, "validated");
    assert.equal(proof.tree, await git(f.primary, "rev-parse", `${f.left}^{tree}`));
    assert.deepEqual(proof.taskIds, ["left"]);
    assert.equal(proof.releaseRoot, undefined);
    assert.equal(proof.manifestFile, undefined);
    assert.ok(validations >= 1);
    assert.deepEqual(await snapshot(f.dataDir), before);
    assert.equal(await git(f.primary, "symbolic-ref", "HEAD"), "refs/heads/main");
    assert.equal(await git(f.primary, "status", "--porcelain"), "");
  }
});

test("composition conflict leaves last good candidate and primary untouched", async (t) => {
  const f = await fixture(t);
  await f.service.prepareCandidate(f.request);
  const right = await f.result("right", "right\n");
  const before = await snapshot(f.dataDir);
  await assert.rejects(f.service.validateCandidate({
    ...f.request, planRevision: "conflicting-plan",
    frozenTasks: [...f.request.frozenTasks, { taskId: "right", taskRevision: 1, baseCommit: f.request.approvedBaseCommit, resultCommit: right }],
  }), { code: "RELEASE_NATIVE_MERGE_CONFLICT" });
  assert.deepEqual(await snapshot(f.dataDir), before);
  assert.equal(await git(f.primary, "status", "--porcelain"), "");
});

test("changed authority and acceptance callbacks cannot yield a successful composition proof", async (t) => {
  const f = await fixture(t);
  await mkdir(f.dataDir, { recursive: true });
  const before = await snapshot(f.dataDir);
  await assert.rejects(f.service.validateCandidate({ ...f.request, validateBeforeCommit: async () => {
    throw new Error("approved base changed");
  } }), /approved base changed/u);
  await assert.rejects(f.service.validateCandidate({ ...f.request, commitPrepared: async () => {} }), /cannot commit Task acceptance/u);
  assert.deepEqual(await snapshot(f.dataDir), before);
});

test("composition validation supports a primary with installed repository hooks", async (t) => {
  const f = await fixture(t);
  const hooks = path.join(f.root, "shared-hooks");
  await mkdir(hooks);
  await git(f.primary, "config", "core.hooksPath", hooks);
  const proof = await f.service.validateCandidate(f.request);
  assert.equal(proof.tree, await git(f.primary, "rev-parse", `${f.left}^{tree}`));
  assert.equal(await git(f.primary, "config", "core.hooksPath"), hooks);
});
