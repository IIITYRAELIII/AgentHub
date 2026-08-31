import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  prepareTaskContourSource,
  TaskGitWorkspaceService,
} from "../../../src/infrastructure/filesystem/task-git-workspace.mjs";

const execFileAsync = promisify(execFile);

async function git(cwd, ...args) {
  return String((await execFileAsync("git", args, { cwd, windowsHide: true })).stdout).trim();
}

async function repository(context) {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-task-git-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await git(root, "init", "-b", "main");
  await git(root, "config", "core.autocrlf", "false");
  await writeFile(path.join(root, "app.txt"), "main\n", "utf8");
  await git(root, "add", "app.txt");
  await git(root, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "main");
  return root;
}

test("Task Git workspace commits one Task branch and merges it into dev", async (context) => {
  const root = await repository(context);
  const agentHubRoot = path.join(root, "AgentHub");
  await mkdir(agentHubRoot);
  await writeFile(path.join(agentHubRoot, "package.json"), "{}\n", "utf8");
  await git(root, "add", "AgentHub/package.json");
  await git(root, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "agent hub");
  const dataDir = path.join(root, "..", `${path.basename(root)}-data`);
  context.after(() => rm(dataDir, { recursive: true, force: true }));
  const service = new TaskGitWorkspaceService({ dataDir });
  const taskId = "11111111-1111-1111-1111-111111111111";

  const workspace = await service.prepare({ taskId, projectRoot: root });
  assert.match(workspace.branch, /^agenthub\/task\/11111111-/u);
  assert.notEqual(workspace.projectRoot, root);
  assert.equal(await service.managedRepositoryRoot(workspace.projectRoot, { taskId }), path.resolve(root));
  assert.equal(await service.managedRepositoryRoot(workspace.projectRoot), null);
  assert.equal(await service.managedRepositoryRoot(root), null);
  await writeFile(path.join(workspace.projectRoot, "app.txt"), "task\n", "utf8");

  const result = await service.snapshotAndMerge({ taskId, projectRoot: workspace.projectRoot });
  assert.equal(result.integration.integrated, true);
  assert.deepEqual(result.snapshot.changedFiles.map((file) => file.path), ["app.txt"]);
  assert.equal(await readFile(path.join(result.integration.dev.projectRoot, "app.txt"), "utf8"), "task\n");
  const evidence = await service.releaseEvidence({
    taskId,
    projectRoot: root,
    branch: result.snapshot.branch,
    resultCommit: result.snapshot.headCommit,
  });
  assert.equal(evidence.resultCommit, result.snapshot.headCommit);
  assert.deepEqual(evidence.changedFiles.map((file) => file.path), ["app.txt"]);
  await assert.rejects(() => service.releaseEvidence({
    taskId,
    projectRoot: root,
    branch: "agenthub/task/another-task/repository",
    resultCommit: result.snapshot.headCommit,
  }), /branch does not match/u);

  const contour = await prepareTaskContourSource({ sourceRoot: agentHubRoot, integrationRoot: dataDir });
  assert.equal(contour.branch, "dev");
  assert.equal(contour.headCommit, result.integration.dev.headCommit);
  assert.equal(contour.sourceRoot, path.join(result.integration.dev.projectRoot, "AgentHub"));
  assert.equal(await readFile(path.join(contour.sourceRoot, "package.json"), "utf8"), "{}\n");

  const releaseRoot = path.join(root, "..", `${path.basename(root)}-release`);
  await git(root, "worktree", "add", "-b", "release-fixture", releaseRoot, "HEAD");
  try {
    const linkedContour = await prepareTaskContourSource({
      sourceRoot: path.join(releaseRoot, "AgentHub"),
      integrationRoot: dataDir,
    });
    assert.equal(linkedContour.sourceRoot, path.join(result.integration.dev.projectRoot, "AgentHub"));
    assert.equal(await readFile(path.join(linkedContour.sourceRoot, "package.json"), "utf8"), "{}\n");
  } finally {
    await git(root, "worktree", "remove", "--force", releaseRoot);
  }
});

test("managed Task admission rejects another Task owner and numbered branch", async (context) => {
  const root = await repository(context);
  const dataDir = path.join(root, "..", `${path.basename(root)}-data`);
  context.after(() => rm(dataDir, { recursive: true, force: true }));
  const service = new TaskGitWorkspaceService({ dataDir });
  const firstTaskId = "66666666-6666-4666-8666-666666666666";
  const secondTaskId = "77777777-7777-4777-8777-777777777777";
  const first = await service.prepare({ taskId: firstTaskId, projectRoot: root });
  await service.prepare({ taskId: secondTaskId, projectRoot: root });

  assert.equal(await service.managedRepositoryRoot(first.projectRoot, { taskId: secondTaskId }), null);
  assert.equal(await service.managedRepositoryRoot(first.projectRoot, { taskId: firstTaskId }), path.resolve(root));

  await git(first.projectRoot, "branch", "-m", "AH-42");
  assert.equal(await service.managedRepositoryRoot(first.projectRoot, {
    taskId: firstTaskId,
    taskNumber: "AH-7",
  }), null);
  assert.equal(await service.managedRepositoryRoot(first.projectRoot, {
    taskId: secondTaskId,
    taskNumber: "AH-42",
  }), null);
  assert.equal(await service.managedRepositoryRoot(first.projectRoot, {
    taskId: firstTaskId,
    taskNumber: "AH-42",
  }), path.resolve(root));
});

test("Task Git workspace aborts a conflicting dev merge without deleting either branch", async (context) => {
  const root = await repository(context);
  const dataDir = path.join(root, "..", `${path.basename(root)}-data`);
  context.after(() => rm(dataDir, { recursive: true, force: true }));
  const service = new TaskGitWorkspaceService({ dataDir });
  const first = await service.prepare({
    taskId: "22222222-2222-2222-2222-222222222222",
    projectRoot: root,
  });
  const second = await service.prepare({
    taskId: "33333333-3333-3333-3333-333333333333",
    projectRoot: root,
  });
  await writeFile(path.join(first.projectRoot, "app.txt"), "first\n", "utf8");
  await writeFile(path.join(second.projectRoot, "app.txt"), "second\n", "utf8");

  assert.equal((await service.snapshotAndMerge({ taskId: first.taskId, projectRoot: first.projectRoot })).integration.integrated, true);
  const conflict = await service.snapshotAndMerge({ taskId: second.taskId, projectRoot: second.projectRoot });
  assert.equal(conflict.integration.integrated, false);
  assert.deepEqual(conflict.integration.conflicts, ["app.txt"]);
  assert.equal(await git(conflict.integration.dev.projectRoot, "status", "--porcelain"), "");
});

test("a new Task branch starts from main and never inherits earlier dev-only work", async (context) => {
  const root = await repository(context);
  const dataDir = path.join(root, "..", `${path.basename(root)}-data`);
  context.after(() => rm(dataDir, { recursive: true, force: true }));
  const service = new TaskGitWorkspaceService({ dataDir });
  const first = await service.prepare({
    taskId: "44444444-4444-4444-4444-444444444444",
    projectRoot: root,
  });
  await writeFile(path.join(first.projectRoot, "first.txt"), "first\n", "utf8");
  assert.equal((await service.snapshotAndMerge({
    taskId: first.taskId,
    projectRoot: first.projectRoot,
  })).integration.integrated, true);

  const second = await service.prepare({
    taskId: "55555555-5555-5555-5555-555555555555",
    projectRoot: root,
  });
  assert.equal(await readFile(path.join(second.projectRoot, "app.txt"), "utf8"), "main\n");
  await assert.rejects(() => readFile(path.join(second.projectRoot, "first.txt"), "utf8"), /ENOENT/u);
  await writeFile(path.join(second.projectRoot, "second.txt"), "second\n", "utf8");
  const snapshot = await service.snapshot({ taskId: second.taskId, projectRoot: second.projectRoot });
  assert.deepEqual(snapshot.changedFiles.map((file) => file.path), ["second.txt"]);
});
