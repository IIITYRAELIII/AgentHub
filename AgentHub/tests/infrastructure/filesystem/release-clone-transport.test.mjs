import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { ReleaseGitWorkspaceService } from "../../../src/infrastructure/filesystem/release-git-workspace.mjs";

const execute = promisify(execFile);
const git = async (cwd, ...args) => String((await execute("git", args, { cwd, windowsHide: true })).stdout).trim();
async function commit(cwd) {
  await git(cwd, "add", "-A");
  await git(cwd, "-c", "user.name=Fixture", "-c", "user.email=fixture@local.invalid", "commit", "-m", "fixture");
  return git(cwd, "rev-parse", "HEAD");
}

test("ordinary release clone preserves source hooks and clone protection through bundle transport", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "release-clone-transport-"));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  const primary = path.join(root, "primary"), origin = path.join(root, "origin.git"), selected = path.join(root, "selected");
  await git(root, "init", "--bare", "--initial-branch=main", origin);
  await git(root, "clone", origin, primary);
  await writeFile(path.join(primary, "base.txt"), "base\n");
  const base = await commit(primary);
  await git(primary, "push", "origin", "main");
  await git(primary, "worktree", "add", "-b", "selected", selected, base);
  await writeFile(path.join(selected, "selected.txt"), "selected\n");
  const resultCommit = await commit(selected);
  const hooks = path.join(root, "hooks"), marker = path.join(root, "hook-executed");
  await mkdir(hooks);
  await writeFile(path.join(hooks, "post-checkout"), '#!/bin/sh\nprintf triggered > "' + marker.replaceAll("\\", "/") + '"\n');
  await git(primary, "config", "core.hooksPath", hooks);
  // The unchanged Git executable refuses a direct local clone. Do not turn
  // protection off to make the product path pass this regression.
  await assert.rejects(git(root, "clone", "--no-local", "--no-checkout", primary, path.join(root, "direct")), /core\.hooksPath/u);
  const service = new ReleaseGitWorkspaceService({ dataDir: path.join(root, "data"),
    environment: { ...process.env, LOCALAPPDATA: root, XDG_STATE_HOME: root } });
  const input = { projectRoot: primary, planRevision: "fixture", workspaceId: "fixture", approvedBaseCommit: base,
    frozenTasks: [{ taskId: "selected", taskRevision: 1, baseCommit: base, resultCommit }] };
  const prepared = await service.prepareCandidate(input);
  assert.equal(await git(prepared.releaseRoot, "show", "HEAD:selected.txt"), "selected");
  assert.equal(await git(prepared.releaseRoot, "remote", "get-url", "workspace"), primary);
  assert.equal(await git(primary, "config", "--local", "core.hooksPath"), hooks);
  assert.equal(await git(primary, "rev-parse", "main"), base);
  assert.equal(await git(primary, "--no-optional-locks", "status", "--porcelain"), "");
  assert.equal(await readFile(marker).then(() => true, error => { if (error.code === "ENOENT") return false; throw error; }), false);
  assert.deepEqual((await readdir(path.dirname(prepared.releaseRoot))).filter(name => name.startsWith("clone-source-")), []);
  assert.equal((await service.prepareCandidate(input)).preReleaseHead, prepared.preReleaseHead);
});
