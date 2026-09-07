import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  prepareTaskContourSource,
  taskSparseCheckoutSelection,
  TaskGitWorkspaceService,
} from "../../../src/infrastructure/filesystem/task-git-workspace.mjs";
import { canonicalPath } from "../../../src/infrastructure/filesystem/config.mjs";

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

test("Test Contour source refuses a repository without dev", async (context) => {
  const root = await repository(context);
  const agentHubRoot = path.join(root, "AgentHub");
  await mkdir(agentHubRoot);
  await writeFile(path.join(agentHubRoot, "package.json"), "{}\n", "utf8");
  await git(root, "add", "AgentHub/package.json");
  await git(root, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "agent hub");

  await assert.rejects(
    prepareTaskContourSource({ sourceRoot: agentHubRoot, integrationRoot: path.join(root, "data") }),
    /requires branch dev/u,
  );
});

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
  assert.equal(await service.managedRepositoryRoot(workspace.projectRoot, { taskId }), canonicalPath(root));
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
  const integrationEvidence = await service.releaseIntegrationEvidence({
    projectRoot: root,
    tasks: [{
      taskId,
      taskRevision: 1,
      projectRoot: root,
      branch: result.snapshot.branch,
      resultCommit: result.snapshot.headCommit,
    }],
  });
  assert.deepEqual(integrationEvidence.tasks, [{
    taskId,
    taskRevision: 1,
    resultCommit: result.snapshot.headCommit,
    integrations: [{
      commit: result.integration.dev.headCommit,
      parent: result.integration.dev.headCommit === result.snapshot.headCommit
        ? result.snapshot.baseCommit
        : await git(result.integration.dev.projectRoot, "rev-parse", `${result.integration.dev.headCommit}^1`),
      order: 2,
    }],
  }]);
  const devEvidence = await service.verifyReleaseResultsInDev({
    projectRoot: root,
    resultCommits: [result.snapshot.headCommit],
  });
  assert.equal(devEvidence.headCommit, result.integration.dev.headCommit);
  assert.deepEqual(devEvidence.resultCommits, [result.snapshot.headCommit]);

  const pendingTaskId = "22222222-2222-2222-2222-222222222222";
  const pendingWorkspace = await service.prepare({ taskId: pendingTaskId, projectRoot: root });
  await writeFile(path.join(pendingWorkspace.projectRoot, "pending.txt"), "pending\n", "utf8");
  const pendingSnapshot = await service.snapshot({ taskId: pendingTaskId, projectRoot: pendingWorkspace.projectRoot });
  await assert.rejects(() => service.verifyReleaseResultsInDev({
    projectRoot: root,
    resultCommits: [pendingSnapshot.headCommit],
  }), /not integrated into dev/u);
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

test("legacy adoption records only an exact equivalent commit already in main", async (context) => {
  const root = await repository(context);
  const dataDir = path.join(root, "..", `${path.basename(root)}-data`);
  context.after(() => rm(dataDir, { recursive: true, force: true }));
  const service = new TaskGitWorkspaceService({ dataDir });
  const taskId = "12121212-1212-4212-8212-121212121212";
  const baseCommit = await git(root, "rev-parse", "HEAD^{commit}");

  await git(root, "checkout", "-b", "legacy-source");
  await writeFile(path.join(root, "app.txt"), "legacy result\n", "utf8");
  await writeFile(path.join(root, "CHANGELOG.md"), "legacy wording\n", "utf8");
  await git(root, "add", "app.txt", "CHANGELOG.md");
  await git(root, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "legacy result");
  const reportedResultCommit = await git(root, "rev-parse", "HEAD^{commit}");
  await git(root, "checkout", "main");
  await writeFile(path.join(root, "app.txt"), "legacy result\n", "utf8");
  await writeFile(path.join(root, "CHANGELOG.md"), "consolidated release wording\n", "utf8");
  await git(root, "add", "app.txt", "CHANGELOG.md");
  await git(root, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "integrated result");
  const mainResultCommit = await git(root, "rev-parse", "HEAD^{commit}");
  await writeFile(path.join(root, "later.txt"), "later main work\n", "utf8");
  await git(root, "add", "later.txt");
  await git(root, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "later main work");
  const mainHeadBefore = await git(root, "rev-parse", "main^{commit}");
  const statusBefore = await git(root, "status", "--porcelain=v1", "--untracked-files=all");
  const prepared = await service.prepare({ taskId, taskNumber: "HUB-98", projectRoot: root });
  assert.equal(prepared.headCommit, mainHeadBefore);

  const adopted = await service.adoptLegacyResult({
    taskId,
    taskNumber: "HUB-98",
    projectRoot: root,
    reportedResultCommit,
    mainResultCommit,
  });

  assert.equal(adopted.branch, "HUB-98");
  assert.equal(adopted.baseCommit, baseCommit);
  assert.equal(adopted.resultCommit, mainResultCommit);
  assert.deepEqual(adopted.changedFiles.map((file) => file.path), ["app.txt"]);
  assert.equal(await git(root, "rev-parse", "HUB-98^{commit}"), mainResultCommit);
  assert.equal(await git(prepared.projectRoot, "rev-parse", "HEAD^{commit}"), mainResultCommit);
  assert.equal(await git(root, "rev-parse", "main^{commit}"), mainHeadBefore);
  assert.equal(await git(root, "status", "--porcelain=v1", "--untracked-files=all"), statusBefore);
  const evidence = await service.releaseEvidence({
    taskId,
    taskNumber: "HUB-98",
    projectRoot: root,
    branch: adopted.branch,
    resultCommit: adopted.resultCommit,
  });
  assert.deepEqual(evidence.changedFiles.map((file) => file.path), ["app.txt"]);

  await assert.rejects(() => service.adoptLegacyResult({
    taskId: "14141414-1414-4414-8414-141414141414",
    taskNumber: "HUB-101",
    projectRoot: root,
    reportedResultCommit: "HEAD",
    mainResultCommit,
  }), /full Git commit id/u);

  await git(root, "checkout", "-b", "different-source", baseCommit);
  await writeFile(path.join(root, "app.txt"), "different result\n", "utf8");
  await git(root, "add", "app.txt");
  await git(root, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "different result");
  const differentCommit = await git(root, "rev-parse", "HEAD^{commit}");
  await git(root, "checkout", "main");
  await assert.rejects(() => service.adoptLegacyResult({
    taskId: "13131313-1313-4313-8313-131313131313",
    taskNumber: "HUB-100",
    projectRoot: root,
    reportedResultCommit: differentCommit,
    mainResultCommit,
  }), /does not match/u);
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
  assert.equal(await service.managedRepositoryRoot(first.projectRoot, { taskId: firstTaskId }), canonicalPath(root));

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
  }), canonicalPath(root));
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

test("a numbered Task uses its number as the exact Git branch name", async (context) => {
  const root = await repository(context);
  const dataDir = path.join(root, "..", `${path.basename(root)}-data`);
  context.after(() => rm(dataDir, { recursive: true, force: true }));
  const service = new TaskGitWorkspaceService({ dataDir });
  const taskId = "66666666-6666-6666-6666-666666666666";

  const legacy = await service.prepare({ taskId, projectRoot: root });
  assert.match(legacy.branch, /^agenthub\/task\//u);
  const numbered = await service.prepare({ taskId, taskNumber: "HUB-11", projectRoot: root });

  assert.equal(numbered.branch, "HUB-11");
  assert.equal(await git(numbered.projectRoot, "branch", "--show-current"), "HUB-11");
});

test("a new Task worktree sparsely materializes only its selected project subtree", async (context) => {
  const root = await repository(context);
  await mkdir(path.join(root, "AgentHub"));
  await mkdir(path.join(root, "Other"));
  await writeFile(path.join(root, "AgentHub", "package.json"), "{}\n", "utf8");
  await writeFile(path.join(root, "Other", "clean.txt"), "other\n", "utf8");
  await git(root, "add", "AgentHub/package.json", "Other/clean.txt");
  await git(root, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "projects");
  const dataDir = path.join(root, "..", `${path.basename(root)}-data`);
  context.after(() => rm(dataDir, { recursive: true, force: true }));
  const service = new TaskGitWorkspaceService({ dataDir });
  const selectedRoot = path.join(root, "AgentHub");

  const workspace = await service.prepare({
    taskId: "88888888-8888-4888-8888-888888888888",
    taskNumber: "HUB-142",
    projectRoot: selectedRoot,
  });
  const taskRoot = await git(workspace.projectRoot, "rev-parse", "--show-toplevel");
  assert.equal(workspace.projectRoot, canonicalPath(path.join(taskRoot, "AgentHub")));
  assert.equal(
    await service.managedRepositoryRoot(workspace.projectRoot, {
      taskId: workspace.taskId,
      taskNumber: "HUB-142",
    }),
    canonicalPath(root),
  );
  assert.equal(await git(taskRoot, "sparse-checkout", "list"), "AgentHub");
  assert.equal(await readFile(path.join(workspace.projectRoot, "package.json"), "utf8"), "{}\n");
  await assert.rejects(() => readFile(path.join(taskRoot, "Other", "clean.txt"), "utf8"), /ENOENT/u);
  await assert.rejects(() => git(root, "sparse-checkout", "list"), /not sparse/u);
  const dev = await service.prepareDev(root);
  await assert.rejects(() => git(dev.projectRoot, "sparse-checkout", "list"), /not sparse/u);

  const repeated = await service.prepare({
    taskId: workspace.taskId,
    taskNumber: "HUB-142",
    projectRoot: workspace.projectRoot,
  });
  assert.equal(repeated.projectRoot, workspace.projectRoot);
  assert.equal(repeated.branch, workspace.branch);
  assert.equal(await git(taskRoot, "sparse-checkout", "list"), "AgentHub");
});

test("repository-root Tasks use explicit all-path scope without guessing a project subtree", async (context) => {
  const root = await repository(context);
  await mkdir(path.join(root, "AgentHub"));
  await writeFile(path.join(root, "AgentHub", "package.json"), "{}\n", "utf8");
  await git(root, "add", "AgentHub/package.json");
  await git(root, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "project");
  const dataDir = path.join(root, "..", `${path.basename(root)}-data`);
  context.after(() => rm(dataDir, { recursive: true, force: true }));
  const service = new TaskGitWorkspaceService({ dataDir });

  const workspace = await service.prepare({
    taskId: "99999999-9999-4999-8999-999999999999",
    projectRoot: root,
  });

  assert.equal(workspace.projectRoot, canonicalPath(await git(workspace.projectRoot, "rev-parse", "--show-toplevel")));
  assert.equal(await git(workspace.projectRoot, "sparse-checkout", "list"), "/*");
  assert.equal(await readFile(path.join(workspace.projectRoot, "AgentHub", "package.json"), "utf8"), "{}\n");
});

test("existing managed worktree migration preserves dirty paths branch base and repeatability", async (context) => {
  const root = await repository(context);
  await mkdir(path.join(root, "AgentHub"));
  await mkdir(path.join(root, "Other"));
  await writeFile(path.join(root, "AgentHub", "package.json"), "{}\n", "utf8");
  await writeFile(path.join(root, "Other", "dirty.txt"), "clean\n", "utf8");
  await writeFile(path.join(root, "Other", "excluded.txt"), "excluded\n", "utf8");
  await git(root, "add", "AgentHub/package.json", "Other/dirty.txt", "Other/excluded.txt");
  await git(root, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "projects");
  const dataDir = path.join(root, "..", `${path.basename(root)}-data`);
  context.after(() => rm(dataDir, { recursive: true, force: true }));
  const service = new TaskGitWorkspaceService({ dataDir });
  const taskId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const legacy = await service.prepare({ taskId, taskNumber: "HUB-142", projectRoot: root });
  const taskRoot = await git(legacy.projectRoot, "rev-parse", "--show-toplevel");
  await git(taskRoot, "sparse-checkout", "disable");
  await writeFile(path.join(taskRoot, "AgentHub", "package.json"), "{\"dirty\":true}\n", "utf8");
  await writeFile(path.join(taskRoot, "Other", "dirty.txt"), "dirty outside scope\n", "utf8");
  await writeFile(path.join(taskRoot, "Other", "untracked.txt"), "untracked outside scope\n", "utf8");
  const statusBefore = await git(taskRoot, "status", "--porcelain=v1", "--untracked-files=all");
  const branchBefore = await git(taskRoot, "branch", "--show-current");
  const headBefore = await git(taskRoot, "rev-parse", "HEAD^{commit}");
  const baseBefore = legacy.baseCommit;

  const migrated = await service.prepare({
    taskId,
    taskNumber: "HUB-142",
    projectRoot: path.join(root, "AgentHub"),
  });
  assert.equal(await git(taskRoot, "sparse-checkout", "list"), "AgentHub");
  assert.equal(await git(taskRoot, "status", "--porcelain=v1", "--untracked-files=all"), statusBefore);
  assert.equal(await git(taskRoot, "branch", "--show-current"), branchBefore);
  assert.equal(await git(taskRoot, "rev-parse", "HEAD^{commit}"), headBefore);
  assert.equal(migrated.baseCommit, baseBefore);
  assert.equal(await readFile(path.join(taskRoot, "AgentHub", "package.json"), "utf8"), "{\"dirty\":true}\n");
  assert.equal(await readFile(path.join(taskRoot, "Other", "dirty.txt"), "utf8"), "dirty outside scope\n");
  assert.equal(await readFile(path.join(taskRoot, "Other", "untracked.txt"), "utf8"), "untracked outside scope\n");
  await assert.rejects(() => readFile(path.join(taskRoot, "Other", "excluded.txt"), "utf8"), /ENOENT/u);

  const repeated = await service.prepare({
    taskId,
    taskNumber: "HUB-142",
    projectRoot: migrated.projectRoot,
  });
  assert.equal(repeated.projectRoot, migrated.projectRoot);
  assert.equal(await git(taskRoot, "status", "--porcelain=v1", "--untracked-files=all"), statusBefore);

  const snapshot = await service.snapshot({
    taskId,
    taskNumber: "HUB-142",
    projectRoot: migrated.projectRoot,
  });
  assert.deepEqual(snapshot.changedFiles.map((item) => item.path).sort(), [
    "AgentHub/package.json",
    "Other/dirty.txt",
    "Other/untracked.txt",
  ]);
});

test("sparse scope normalizes Windows paths and rejects repository escape", () => {
  const root = process.platform === "win32" ? "C:\\work\\repo" : "/work/repo";
  const child = path.join(root, "AgentHub", "src");
  assert.deepEqual(taskSparseCheckoutSelection(root, child), {
    cone: true,
    relativePath: path.join("AgentHub", "src"),
    scope: "AgentHub/src",
  });
  assert.deepEqual(taskSparseCheckoutSelection(root, root), {
    cone: false,
    relativePath: "",
    scope: "/*",
  });
  assert.throws(
    () => taskSparseCheckoutSelection(root, path.resolve(root, "..", "escape")),
    /outside its Git worktree/u,
  );
});
