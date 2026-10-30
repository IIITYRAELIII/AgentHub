import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { TaskGitWorkspaceService, runOwnedGit } from "../../../src/infrastructure/filesystem/task-git-workspace.mjs";

test("ordinary guarded Task Git handles long worktree paths without preparation isolation or persistent configuration", {
  skip: process.platform !== "win32",
}, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hub-owned-longpath-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
  const repository = path.join(root, "repository");
  await mkdir(repository);
  const workspace = new TaskGitWorkspaceService({ dataDir: path.join(root, "owner"), recordTiming: () => {} });
  await workspace.withTaskLock("ordinary-longpath-regression", async lease => {
    // Do not enter withPreparationGitIsolation: this is the additional uncovered owner.
    const git = (args, options = {}) => runOwnedGit(args, { ...options, cwd: repository, lease,
      env: { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: path.join(root, "empty-config"),
        GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.longpaths", GIT_CONFIG_VALUE_0: "false" } });
    await writeFile(path.join(root, "empty-config"), "");
    await git(["init", "--initial-branch=main"]);
    const directory = path.join(repository, "a".repeat(110));
    await mkdir(directory);
    const file = path.join(directory, "b".repeat(280 - directory.length - 1));
    assert.equal(file.length, 280);
    await writeFile(file, "synthetic guarded long path\n");
    const relative = path.relative(repository, file).replaceAll("\\", "/");
    await git(["add", "--", relative]);
    await git(["-c", "user.name=Fixture", "-c", "user.email=fixture@local.invalid", "commit", "-m", "long path"]);
    assert.equal(await git(["show", `HEAD:${relative}`]), "synthetic guarded long path");
    assert.equal(await git(["config", "--get", "core.longpaths"]), "true");
    assert.equal(await git(["config", "--local", "--get", "core.longpaths"], { acceptableExitCodes: [1] }), "");
    assert.equal(await git(["status", "--porcelain=v1"]), "");
    assert.equal(await readFile(file, "utf8"), "synthetic guarded long path\n");
    t.diagnostic(JSON.stringify({ pathLength: file.length, ordinaryGuardedTaskOwner: true,
      persistentLongpathsConfig: false, inheritedFalseOverriddenForOwnedCommandOnly: true }));
  });
});
