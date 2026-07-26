import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  captureTaskGitBaseline,
  cleanupTaskGitIndexes,
  resolveTaskGitRepoRoots,
  taskGitDiff,
} from "./task-git-diff.mjs";

const execFileAsync = promisify(execFile);

async function git(cwd, ...args) {
  return execFileAsync("git", args, { cwd, encoding: "utf8" });
}

test("repository discovery finds nested repos in a multi-repository workspace", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "telegram-repo-roots-"));
  const first = path.join(root, "First");
  const second = path.join(root, "Nested", "Second");
  await Promise.all([mkdir(first, { recursive: true }), mkdir(second, { recursive: true })]);
  try {
    await Promise.all([git(first, "init"), git(second, "init")]);
    assert.deepEqual(await resolveTaskGitRepoRoots(root), [
      path.resolve(first),
      path.resolve(second),
    ].sort((left, right) => left.localeCompare(right)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("task Git diff uses the real repository and excludes pre-existing dirt", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "telegram-task-diff-"));
  const dataDir = path.join(root, "runtime");
  const project = path.join(root, "repo", "nested", "project");
  const repo = path.join(root, "repo");
  await mkdir(project, { recursive: true });
  try {
    await git(repo, "init");
    await git(repo, "config", "user.email", "test@example.invalid");
    await git(repo, "config", "user.name", "Test");
    await writeFile(path.join(repo, "tracked.txt"), "base\n", "utf8");
    await writeFile(path.join(repo, "staged.txt"), "base\n", "utf8");
    await git(repo, "add", ".");
    await git(repo, "commit", "-m", "base");

    await writeFile(path.join(repo, "tracked.txt"), "base\npre-existing\n", "utf8");
    await writeFile(path.join(repo, "old-untracked.txt"), "untouched\n", "utf8");
    const baseline = await captureTaskGitBaseline(project, dataDir, "test");
    assert.equal(baseline.repoRoot, path.resolve(repo));

    await writeFile(path.join(repo, "tracked.txt"), "base\npre-existing\ntask change\n", "utf8");
    await writeFile(path.join(repo, "staged.txt"), "staged by task\n", "utf8");
    await git(repo, "add", "staged.txt");
    await writeFile(path.join(repo, "new-untracked.txt"), "created by task\n", "utf8");

    const diff = await taskGitDiff(baseline, dataDir, "test");
    assert.match(diff, /\+task change/);
    assert.match(diff, /staged by task/);
    assert.match(diff, /Изменения индекса \(staged\):\nM\s+staged\.txt/);
    assert.match(diff, /new-untracked\.txt/);
    assert.doesNotMatch(diff, /^\+pre-existing$/m);
    assert.doesNotMatch(diff, /old-untracked\.txt/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("task Git baseline captures and prefixes every repository in a workspace", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "telegram-task-diff-workspace-"));
  const dataDir = path.join(root, "runtime");
  const first = path.join(root, "First");
  const second = path.join(root, "Second");
  try {
    for (const repo of [first, second]) {
      await mkdir(repo, { recursive: true });
      await git(repo, "init");
      await git(repo, "config", "user.email", "test@example.invalid");
      await git(repo, "config", "user.name", "Test");
      await writeFile(path.join(repo, "file.txt"), "base\n", "utf8");
      await git(repo, "add", ".");
      await git(repo, "commit", "-m", "base");
    }
    const baseline = await captureTaskGitBaseline(root, dataDir, "workspace");
    assert.equal(baseline.repositories.length, 2);

    await writeFile(path.join(first, "file.txt"), "first change\n", "utf8");
    await writeFile(path.join(second, "file.txt"), "second change\n", "utf8");
    await writeFile(path.join(second, "файл с пробелом.txt"), "новый\n", "utf8");
    const diff = await taskGitDiff(baseline, dataDir, "workspace");

    assert.match(diff, /diff --git a\/First\/file\.txt b\/First\/file\.txt/);
    assert.match(diff, /diff --git a\/Second\/file\.txt b\/Second\/file\.txt/);
    assert.match(diff, /\+\+\+ "b\/Second\/файл с пробелом\.txt"/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("staged-only task changes remain visible when the worktree matches its baseline", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "telegram-task-diff-staged-"));
  const dataDir = path.join(root, "runtime");
  try {
    await git(root, "init");
    await git(root, "config", "user.email", "test@example.invalid");
    await git(root, "config", "user.name", "Test");
    await writeFile(path.join(root, "file.txt"), "base\n", "utf8");
    await git(root, "add", ".");
    await git(root, "commit", "-m", "base");
    const baseline = await captureTaskGitBaseline(root, dataDir, "staged");
    await writeFile(path.join(root, "file.txt"), "staged\n", "utf8");
    await git(root, "add", "file.txt");
    await writeFile(path.join(root, "file.txt"), "base\n", "utf8");
    const diff = await taskGitDiff(baseline, dataDir, "staged");
    assert.match(diff, /-base/);
    assert.match(diff, /\+staged/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("orphaned temporary indexes are cleaned after an interrupted snapshot", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "telegram-task-diff-cleanup-"));
  const indexDir = path.join(root, "task-diff-indexes");
  await mkdir(indexDir, { recursive: true });
  await writeFile(path.join(indexDir, "stale.index"), "stale", "utf8");
  await writeFile(path.join(indexDir, "keep.txt"), "keep", "utf8");
  try {
    assert.equal(await cleanupTaskGitIndexes(root), 1);
    assert.equal(await cleanupTaskGitIndexes(root), 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("truncated task diff includes a changed-file fallback", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "telegram-task-diff-limit-"));
  const dataDir = path.join(root, "runtime");
  try {
    await git(root, "init");
    await git(root, "config", "user.email", "test@example.invalid");
    await git(root, "config", "user.name", "Test");
    await writeFile(path.join(root, "large.txt"), "base\n", "utf8");
    await git(root, "add", ".");
    await git(root, "commit", "-m", "base");
    const baseline = await captureTaskGitBaseline(root, dataDir, "limit");
    await writeFile(path.join(root, "large.txt"), "x".repeat(10_000), "utf8");
    const diff = await taskGitDiff(baseline, dataDir, "limit", { maxOutputBytes: 512 });
    assert.match(diff, /diff усечён/);
    assert.match(diff, /Изменённые файлы:\nM\s+large\.txt/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
