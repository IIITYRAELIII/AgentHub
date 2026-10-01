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

async function fixture(context, { divergedPublication = false, withTrackedDirectory = false } = {}) {
  const parent = await mkdtemp(path.join(os.tmpdir(), "hub-accepted-main-bootstrap-"));
  context.after(() => rm(parent, { recursive: true, force: true }));
  const root = path.join(parent, "repo");
  await mkdir(root);
  await git(root, "init", "-b", "main");
  await git(root, "config", "core.autocrlf", "false");
  await writeFile(path.join(root, "app.txt"), "base\n");
  await writeFile(path.join(root, "CHANGELOG.md"), "base\n");
  if (withTrackedDirectory) {
    await mkdir(path.join(root, "tracked-directory"));
    await writeFile(path.join(root, "tracked-directory", "child.txt"), "base child\n");
  }
  const base = await commit(root, "shared base");
  let published = base;
  if (divergedPublication) {
    await git(root, "checkout", "-b", "publication", base);
    await writeFile(path.join(root, "published.txt"), "published side\n");
    published = await commit(root, "published side");
    await git(root, "checkout", "main");
  }
  let publication = { generation: "g1", repositories: [{ root, revision: published }] };
  const service = new TaskGitWorkspaceService({ dataDir: path.join(parent, "data"),
    readPublication: async () => publication });
  const task = await service.prepare({ taskId: "11111111-1111-4111-8111-111111111111", projectRoot: root });
  await writeFile(path.join(task.projectRoot, "task.txt"), "selected task\n");
  const taskResult = await commit(task.projectRoot, "task result");
  const dev = await service.prepareDev(root);
  await writeFile(path.join(dev.projectRoot, "dev.txt"), "unrelated dev\n");
  const oldDev = await commit(dev.projectRoot, "unrelated dev result");
  await writeFile(path.join(root, "app.txt"), "accepted local main\n");
  const main = await commit(root, "accepted main advance");
  return { root, service, base, published, main, oldDev, devRoot: dev.projectRoot,
    setGeneration: (generation) => { publication = { ...publication, generation }; },
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
  assert.equal(await readFile(path.join(f.devRoot, "app.txt"), "utf8"), "accepted local main\n");
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
  assert.equal(await readFile(path.join(f.devRoot, "app.txt"), "utf8"), "accepted local main\n");
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

test("reviewed CHANGELOG-only conflict requires exact resolved tree and preserves dev", { timeout: 90_000 }, async (context) => {
  const f = await fixture(context);
  await writeFile(path.join(f.devRoot, "CHANGELOG.md"), "base\ndev entry\n");
  f.oldDev = await commit(f.devRoot, "dev changelog");
  await writeFile(path.join(f.root, "CHANGELOG.md"), "base\nmain entry\n");
  f.main = await commit(f.root, "main changelog");
  const resolution = "base\nmain entry\ndev entry\n";
  const reviewedChangelogFile = path.join(path.dirname(f.root), "reviewed-changelog.md");
  await writeFile(reviewedChangelogFile, resolution);

  await assert.rejects(git(f.devRoot, "merge", "--no-ff", "--no-commit", f.main));
  await writeFile(path.join(f.devRoot, "CHANGELOG.md"), resolution);
  await git(f.devRoot, "add", "--", "CHANGELOG.md");
  const expectedResolvedTree = await git(f.devRoot, "write-tree");
  await git(f.devRoot, "merge", "--abort");
  assert.equal(await git(f.devRoot, "status", "--porcelain"), "");

  await assert.rejects(f.service.bootstrapAcceptedMainIntoDev({
    ...input(f, "wrong-reviewed-tree"), reviewedChangelogFile,
    expectedResolvedTree: f.base,
  }), /reviewed resolution tree changed/u);
  assert.equal(await git(f.root, "rev-parse", "dev"), f.oldDev);
  assert.equal(await git(f.devRoot, "status", "--porcelain"), "");
  assert.equal(await readFile(path.join(f.devRoot, "CHANGELOG.md"), "utf8"), "base\ndev entry\n");

  const exact = { ...input(f, "reviewed-changelog"), reviewedChangelogFile, expectedResolvedTree };
  const result = await f.service.bootstrapAcceptedMainIntoDev(exact);
  assert.equal(result.status, "merged");
  assert.equal(result.resultTree, expectedResolvedTree);
  assert.equal(result.reviewedResolvedTree, expectedResolvedTree);
  assert.equal(await readFile(path.join(f.devRoot, "CHANGELOG.md"), "utf8"), resolution);
  assert.equal(await readFile(path.join(f.devRoot, "dev.txt"), "utf8"), "unrelated dev\n");
  assert.equal(await git(f.taskRoot, "rev-parse", "HEAD"), f.taskResult);
  assert.equal(await git(f.root, "rev-parse", "main"), f.main);
  assert.equal((await f.service.bootstrapAcceptedMainIntoDev(exact)).status, "completed_replay");
  await assert.rejects(f.service.bootstrapAcceptedMainIntoDev({
    ...exact, expectedResolvedTree: f.base,
  }), /request identity changed/u);
});

test("accepted main bootstrap recovers one exact CAS after interrupted materialization", { timeout: 90_000 }, async (context) => {
  const f = await fixture(context);
  await writeFile(path.join(f.devRoot, ".gitignore"), "WIP/\n");
  f.oldDev = await commit(f.devRoot, "ignore local WIP");
  await mkdir(path.join(f.devRoot, "WIP"));
  await writeFile(path.join(f.devRoot, "WIP", "keep.txt"), "private WIP\n");
  let interrupted = false;
  f.service.runCommand = async (args, options) => {
    if (!interrupted && args[0] === "read-tree" && args[1] === "-m" && args[2] === "-u") {
      interrupted = true;
      const error = new Error("injected pre-materialization interruption");
      error.processTreeStopped = true;
      throw error;
    }
    return runTaskGitCommand(args, options);
  };
  await assert.rejects(f.service.bootstrapAcceptedMainIntoDev(input(f, "interrupted-once")),
    /injected pre-materialization interruption/u);
  assert.equal(interrupted, true);
  const advanced = await git(f.root, "rev-parse", "dev");
  assert.notEqual(advanced, f.oldDev);
  assert.equal(await readFile(path.join(f.devRoot, "dev.txt"), "utf8"), "unrelated dev\n");
  const recovered = await f.service.bootstrapAcceptedMainIntoDev(input(f, "interrupted-once"));
  assert.equal(recovered.status, "completed_replay");
  assert.equal(recovered.headCommit, advanced);
  assert.equal(await readFile(path.join(f.devRoot, "app.txt"), "utf8"), "accepted local main\n");
  assert.equal(await readFile(path.join(f.devRoot, "WIP", "keep.txt"), "utf8"), "private WIP\n");
});

test("ignored dependency and WIP files survive exact post-CAS recovery", { timeout: 90_000 }, async (context) => {
  const f = await fixture(context);
  await writeFile(path.join(f.devRoot, ".gitignore"), "node_modules/\nWIP/\n");
  f.oldDev = await commit(f.devRoot, "ignore local dependencies and WIP");
  await mkdir(path.join(f.devRoot, "node_modules"));
  await mkdir(path.join(f.devRoot, "WIP"));
  await writeFile(path.join(f.devRoot, "node_modules", "cache.bin"), "private dependency\n");
  await writeFile(path.join(f.devRoot, "WIP", "note.txt"), "private note\n");
  assert.equal(await git(f.devRoot, "status", "--porcelain=v1", "--untracked-files=all"), "");
  assert.notEqual(await git(f.devRoot, "ls-files", "--others"), "");
  const request = input(f, "ignored-files-after-cas");
  const result = await f.service.bootstrapAcceptedMainIntoDev(request);
  assert.equal(result.status, "merged");
  assert.equal(await git(f.root, "rev-parse", "dev"), result.headCommit);
  assert.equal(await readFile(path.join(f.devRoot, "node_modules", "cache.bin"), "utf8"), "private dependency\n");
  assert.equal(await readFile(path.join(f.devRoot, "WIP", "note.txt"), "utf8"), "private note\n");
  assert.equal((await f.service.bootstrapAcceptedMainIntoDev(request)).status, "completed_replay");
});

test("nonignored untracked file still refuses exact post-CAS recovery", { timeout: 90_000 }, async (context) => {
  const f = await fixture(context);
  let injected = false;
  f.service.runCommand = async (args, options) => {
    if (!injected && args[0] === "read-tree" && args[1] === "-m" && args[2] === "-u") {
      injected = true;
      await writeFile(path.join(f.devRoot, "private-untracked.txt"), "private\n");
    }
    return runTaskGitCommand(args, options);
  };
  const request = input(f, "untracked-after-cas");
  await assert.rejects(f.service.bootstrapAcceptedMainIntoDev(request),
    /did not restore a clean worktree/u);
  assert.equal(injected, true);
  const advanced = await git(f.root, "rev-parse", "dev");
  assert.notEqual(advanced, f.oldDev);
  assert.equal(await readFile(path.join(f.devRoot, "private-untracked.txt"), "utf8"), "private\n");
  await assert.rejects(f.service.bootstrapAcceptedMainIntoDev(request),
    /recovery proof changed/u);
  assert.equal(await git(f.root, "rev-parse", "dev"), advanced);
  assert.equal(await readFile(path.join(f.devRoot, "private-untracked.txt"), "utf8"), "private\n");
});

test("ignored file colliding with incoming tracked path is never overwritten", { timeout: 90_000 }, async (context) => {
  const f = await fixture(context);
  await writeFile(path.join(f.devRoot, ".gitignore"), "vendor-private/\n");
  f.oldDev = await commit(f.devRoot, "ignore private vendor directory");
  await mkdir(path.join(f.root, "vendor-private"));
  await writeFile(path.join(f.root, "vendor-private", "owned.txt"), "incoming tracked\n");
  f.main = await commit(f.root, "incoming vendor path");
  await mkdir(path.join(f.devRoot, "vendor-private"));
  await writeFile(path.join(f.devRoot, "vendor-private", "owned.txt"), "private ignored\n");
  assert.equal(await git(f.devRoot, "status", "--porcelain=v1", "--untracked-files=all"), "");
  await assert.rejects(f.service.bootstrapAcceptedMainIntoDev(input(f, "ignored-target-collision")),
    /supports only existing regular-file content edits/u);
  assert.equal(await git(f.root, "rev-parse", "dev"), f.oldDev);
  assert.equal(await readFile(path.join(f.devRoot, "vendor-private", "owned.txt"), "utf8"), "private ignored\n");
  assert.equal(await git(f.devRoot, "status", "--porcelain=v1", "--untracked-files=all"), "");
});

test("late ignored collision on an added path is rejected before merge or CAS", { timeout: 90_000 }, async (context) => {
  const f = await fixture(context);
  await writeFile(path.join(f.devRoot, ".gitignore"), "vendor-private/\n");
  f.oldDev = await commit(f.devRoot, "ignore private vendor directory");
  await mkdir(path.join(f.root, "vendor-private"));
  await writeFile(path.join(f.root, "vendor-private", "owned.txt"), "incoming tracked\n");
  f.main = await commit(f.root, "incoming vendor path");
  let injected = false;
  f.service.runCommand = async (args, options) => {
    if (!injected && args[0] === "diff" && args.includes("--raw")) {
      injected = true;
      await mkdir(path.join(f.devRoot, "vendor-private"));
      await writeFile(path.join(f.devRoot, "vendor-private", "owned.txt"), "late private\n");
      assert.equal(await git(f.devRoot, "check-ignore", "vendor-private/owned.txt"), "vendor-private/owned.txt");
    }
    return runTaskGitCommand(args, options);
  };
  await assert.rejects(f.service.bootstrapAcceptedMainIntoDev(input(f, "late-before-merge")),
    /supports only existing regular-file content edits/u);
  assert.equal(injected, true);
  assert.equal(await readFile(path.join(f.devRoot, "vendor-private", "owned.txt"), "utf8"), "late private\n");
  assert.equal(await git(f.root, "rev-parse", "dev"), f.oldDev);
});

test("late unrelated ignored file survives post-CAS materialization and replay", { timeout: 90_000 }, async (context) => {
  const f = await fixture(context);
  await writeFile(path.join(f.devRoot, ".gitignore"), "vendor-private/\n");
  f.oldDev = await commit(f.devRoot, "ignore private vendor directory");
  let injected = false;
  f.service.runCommand = async (args, options) => {
    if (!injected && args[0] === "read-tree" && args[1] === "-m" && args[2] === "-u") {
      injected = true;
      await mkdir(path.join(f.devRoot, "vendor-private"), { recursive: true });
      await writeFile(path.join(f.devRoot, "vendor-private", "owned.txt"), "late private\n");
      assert.equal(await git(f.devRoot, "check-ignore", "vendor-private/owned.txt"), "vendor-private/owned.txt");
    }
    return runTaskGitCommand(args, options);
  };
  const result = await f.service.bootstrapAcceptedMainIntoDev(input(f, "late-after-cas"));
  assert.equal(injected, true);
  assert.equal(await readFile(path.join(f.devRoot, "vendor-private", "owned.txt"), "utf8"), "late private\n");
  assert.equal(result.status, "merged");
  assert.equal((await f.service.bootstrapAcceptedMainIntoDev(input(f, "late-after-cas"))).status,
    "completed_replay");
  assert.equal(await readFile(path.join(f.devRoot, "vendor-private", "owned.txt"), "utf8"), "late private\n");
});

test("bootstrap refuses rename destinations, file-directory replacements and type changes before effects", { timeout: 90_000 }, async (context) => {
  for (const change of ["rename", "file-to-directory", "directory-to-file", "symlink", "mode"]) {
    const f = await fixture(context, { withTrackedDirectory: change === "directory-to-file" });
    if (change === "rename") {
      await git(f.root, "mv", "app.txt", "renamed.txt");
      f.main = await commit(f.root, "rename accepted path");
    } else if (change === "file-to-directory") {
      await rm(path.join(f.root, "app.txt"));
      await mkdir(path.join(f.root, "app.txt"));
      await writeFile(path.join(f.root, "app.txt", "child.txt"), "replacement\n");
      f.main = await commit(f.root, "replace file with directory");
    } else if (change === "directory-to-file") {
      await rm(path.join(f.root, "tracked-directory"), { recursive: true });
      await writeFile(path.join(f.root, "tracked-directory"), "replacement\n");
      f.main = await commit(f.root, "replace directory with file");
    } else {
      if (change === "symlink") {
        const blob = await git(f.root, "rev-parse", "HEAD:app.txt");
        await git(f.root, "update-index", "--cacheinfo", `120000,${blob},app.txt`);
      } else {
        await git(f.root, "update-index", "--chmod=+x", "--", "app.txt");
      }
      await git(f.root, "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
        "commit", "-m", `${change} accepted path`);
      f.main = await git(f.root, "rev-parse", "HEAD");
    }
    await assert.rejects(f.service.bootstrapAcceptedMainIntoDev(input(f, `reject-${change}`)),
      /supports only existing regular-file content edits/u, change);
    assert.equal(await git(f.root, "rev-parse", "dev"), f.oldDev);
    assert.equal(await git(f.devRoot, "status", "--porcelain=v1", "--untracked-files=all"), "");
  }
});

test("main content edit cannot re-add a path deleted from dev over an ignored file", { timeout: 90_000 }, async (context) => {
  const f = await fixture(context);
  await rm(path.join(f.devRoot, "app.txt"));
  await writeFile(path.join(f.devRoot, ".gitignore"), "app.txt\n");
  f.oldDev = await commit(f.devRoot, "delete app in dev and ignore private replacement");
  await writeFile(path.join(f.devRoot, "app.txt"), "private ignored replacement\n");
  assert.equal(await git(f.devRoot, "status", "--porcelain=v1", "--untracked-files=all"), "");
  await assert.rejects(f.service.bootstrapAcceptedMainIntoDev(input(f, "deleted-in-dev")),
    /supports only existing regular-file content edits: app.txt/u);
  assert.equal(await git(f.root, "rev-parse", "dev"), f.oldDev);
  assert.equal(await readFile(path.join(f.devRoot, "app.txt"), "utf8"), "private ignored replacement\n");
});

test("publication advance at dev CAS still receipts exact effect and replays it", { timeout: 90_000 }, async (context) => {
  const f = await fixture(context);
  let advanced = false;
  let casCount = 0;
  f.service.runCommand = async (args, options) => {
    if (!advanced && args[0] === "update-ref" && args[1] === "--stdin") {
      advanced = true;
      casCount += 1;
      f.setGeneration("g2");
    }
    return runTaskGitCommand(args, options);
  };
  const result = await f.service.bootstrapAcceptedMainIntoDev(input(f, "generation-race"));
  assert.equal(advanced, true);
  assert.equal(result.status, "merged_publication_advanced");
  assert.equal(result.publicationCurrent, false);
  assert.equal(await git(f.root, "rev-parse", "dev"), result.headCommit);
  assert.equal(await git(f.devRoot, "status", "--porcelain"), "");
  const replay = await f.service.bootstrapAcceptedMainIntoDev(input(f, "generation-race"));
  assert.equal(replay.status, "completed_replay");
  assert.equal(replay.headCommit, result.headCommit);
  assert.equal(casCount, 1);
  await assert.rejects(f.service.bootstrapAcceptedMainIntoDev(input(f, "new-after-generation-change")),
    /publication provenance changed/u);
});

test("publication advance plus interrupted post-CAS materialization reconciles original receipt", { timeout: 90_000 }, async (context) => {
  const f = await fixture(context);
  let casCount = 0;
  let resetInterrupted = false;
  f.service.runCommand = async (args, options) => {
    if (args[0] === "update-ref" && args[1] === "--stdin") {
      casCount += 1;
      f.setGeneration("g2");
    }
    if (!resetInterrupted && args[0] === "read-tree" && args[1] === "-m" && args[2] === "-u") {
      resetInterrupted = true;
      const error = new Error("materialization interrupted after exact CAS");
      error.processTreeStopped = true;
      throw error;
    }
    return runTaskGitCommand(args, options);
  };
  await assert.rejects(f.service.bootstrapAcceptedMainIntoDev(input(f, "generation-and-reset-race")),
    /materialization interrupted after exact CAS/u);
  const exactEffect = await git(f.root, "rev-parse", "dev");
  assert.notEqual(exactEffect, f.oldDev);
  const replay = await f.service.bootstrapAcceptedMainIntoDev(input(f, "generation-and-reset-race"));
  assert.equal(replay.status, "completed_replay");
  assert.equal(replay.headCommit, exactEffect);
  assert.equal(casCount, 1);
  assert.equal(await git(f.devRoot, "status", "--porcelain"), "");
});
