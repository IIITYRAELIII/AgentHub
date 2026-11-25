import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, readdir, rm } from "node:fs/promises";

import path from "node:path";
import os from "node:os";


import { guardedPreparationGit } from "../../../src/infrastructure/filesystem/preparation-git-isolation.mjs";
import { TaskGitWorkspaceService, runTaskGitCommand } from "../../../src/infrastructure/filesystem/task-git-workspace.mjs";

const git = (cwd, ...args) => runTaskGitCommand(args, { cwd });




test("invocation math retains unknown child and fences the same shared object pool", async context => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hub-input-math-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const primary = path.join(root, "primary"), dataDir = path.join(root, "data");
  await mkdir(primary); await git(primary, "init", "-b", "main");
  await writeFile(path.join(primary, "input.txt"), "exact input"); await git(primary, "add", ".");
  await git(primary, "-c", "user.name=Fixture", "-c", "user.email=fixture@invalid", "commit", "-m", "input");
  const commit = await git(primary, "rev-parse", "HEAD");
  const owner = new TaskGitWorkspaceService({ dataDir });
  let invoked = 0;
  const run = () => owner.withNativeRepositoryOwner({ sourceRoot: primary,
    repositoryRoot: path.join(root, "verification") }, ({ objects }) =>
    objects.withInputMath({ sourceRoot: primary, inputs: [commit] }, ({ repository }) =>
      guardedPreparationGit(async lease => {
        invoked++;
        const guard = await lease.beginProcessTreeGuard({ args: ["fixture-unproven-child"], cwd: repository });
        const error = Object.assign(new Error("controlled math child unknown"), { processTreeStopped: false });
        guard.markUnresolved(error);
        throw error;
      })));
  await assert.rejects(run(), /controlled math child unknown/u);
  assert.equal((await readdir(path.join(dataDir, "native-git-objects/math"))).some(name => name.startsWith("owned-")), true,
    "unproven child retains invocation input namespace");
  await assert.rejects(run()); assert.equal(invoked, 1);
});
