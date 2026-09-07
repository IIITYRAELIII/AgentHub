import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { access, mkdir, mkdtemp, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as wait } from "node:timers/promises";
import { promisify } from "node:util";

import {
  prepareTaskContourSource,
  runOwnedGit,
  runTaskGitCommand,
  stopTaskProcessTree,
  taskSparseCheckoutSelection,
  TaskGitWorkspaceService,
} from "../../../src/infrastructure/filesystem/task-git-workspace.mjs";
import { prepareTaskWorktreeDependencies } from "../../../src/infrastructure/filesystem/task-worktree-dependencies.mjs";
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

async function repositoryWithOrigin(context) {
  const root = await repository(context);
  const origin = await mkdtemp(path.join(os.tmpdir(), "agent-hub-task-origin-"));
  context.after(() => rm(origin, { recursive: true, force: true }));
  await git(origin, "init", "--bare");
  await git(root, "remote", "add", "origin", origin);
  await git(root, "push", "-u", "origin", "main");
  await git(origin, "symbolic-ref", "HEAD", "refs/heads/main");
  return { root, origin };
}

async function advanceOriginMain(context, origin, files) {
  const clone = await mkdtemp(path.join(os.tmpdir(), "agent-hub-task-origin-clone-"));
  context.after(() => rm(clone, { recursive: true, force: true }));
  await git(clone, "clone", origin, ".");
  await git(clone, "config", "core.autocrlf", "false");
  for (const [relativePath, content] of Object.entries(files)) {
    await writeFile(path.join(clone, relativePath), content, "utf8");
  }
  await git(clone, "add", "--all");
  await git(clone, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "external main");
  await git(clone, "push", "origin", "main");
  return git(clone, "rev-parse", "HEAD^{commit}");
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

test("timed-out Task Git commands terminate their Windows process tree before rejection", {
  skip: process.platform !== "win32",
}, async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-task-git-timeout-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const script = path.join(directory, "parent.mjs");
  const marker = path.join(directory, "descendant-survived.txt");
  await writeFile(script, `
    import { spawn } from "node:child_process";
    const marker = process.argv[2];
    spawn(process.execPath, ["-e", "setTimeout(() => require('node:fs').writeFileSync(process.argv[1], 'survived'), 700)", marker], {
      stdio: "ignore",
    });
    setInterval(() => {}, 1_000);
  `, "utf8");

  await assert.rejects(
    runTaskGitCommand([script, marker], {
      executable: process.execPath,
      cwd: directory,
      timeoutMs: 100,
    }),
    /timed out.*process tree stopped/u,
  );
  await wait(900);
  assert.equal(await access(marker).then(() => true, () => false), false);
});

test("Windows failed taskkill reports unproven tree stop while a real descendant survives root fallback", {
  skip: process.platform !== "win32",
}, async (context) => {
  const { EventEmitter } = await import("node:events");
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-task-git-survivor-"));
  const script = path.join(directory, "parent.mjs");
  const descendantScript = path.join(directory, "descendant.mjs");
  const pidFile = path.join(directory, "descendant.pid");
  const marker = path.join(directory, "descendant-survived.txt");
  const ready = path.join(directory, "descendant.ready");
  await writeFile(descendantScript, `
    import { writeFileSync } from "node:fs";
    writeFileSync(process.argv[3], "ready");
    setTimeout(() => writeFileSync(process.argv[2], "survived"), 500);
    setInterval(() => {}, 1000);
  `, "utf8");
  await writeFile(script, `
    import { spawn } from "node:child_process";
    import { writeFileSync } from "node:fs";
    const child = spawn(process.execPath, [process.argv[3], process.argv[4], process.argv[5]], {
      stdio: "ignore", detached: true,
    });
    child.unref();
    writeFileSync(process.argv[2], String(child.pid));
    setInterval(() => {}, 1000);
  `, "utf8");
  const parent = spawn(process.execPath, [script, pidFile, descendantScript, marker, ready], { cwd: directory, windowsHide: true });
  while (!await access(ready).then(() => true, () => false)) await wait(5);
  const descendantPid = Number(await readFile(pidFile, "utf8"));
  context.after(async () => {
    try { process.kill(descendantPid, "SIGKILL"); } catch {}
    await wait(100);
    await rm(directory, { recursive: true, force: true });
  });
  const failingTaskkill = () => {
    const killer = new EventEmitter();
    killer.kill = () => {};
    queueMicrotask(() => killer.emit("close", 1));
    return killer;
  };

  assert.equal(await stopTaskProcessTree(parent, { spawnProcess: failingTaskkill, timeoutMs: 20 }), false);
  await wait(700);
  assert.equal(await readFile(marker, "utf8"), "survived");
  process.kill(descendantPid, "SIGKILL");
});

test("an empty Task diff is explicit no_result even when its HEAD is already ancestral to dev", async (context) => {
  const root = await repository(context);
  const dataDir = path.join(root, "..", `${path.basename(root)}-data`);
  context.after(() => rm(dataDir, { recursive: true, force: true }));
  const service = new TaskGitWorkspaceService({ dataDir });
  const workspace = await service.prepare({
    taskId: "10101010-1010-4010-8010-101010101010",
    projectRoot: root,
  });

  const result = await service.snapshotAndMerge({ taskId: workspace.taskId, projectRoot: workspace.projectRoot });

  assert.equal(result.snapshot.changedFiles.length, 0);
  assert.equal(result.integration.alreadyIntegrated, true);
  assert.equal(result.integration.integrated, false);
  assert.equal(result.integration.resultProved, false);
  assert.equal(result.integration.outcome, "no_result");
});

test("a non-ancestral add-and-revert Task is rejected before dev integration", async (context) => {
  const root = await repository(context);
  const dataDir = path.join(root, "..", `${path.basename(root)}-data`);
  context.after(() => rm(dataDir, { recursive: true, force: true }));
  const service = new TaskGitWorkspaceService({ dataDir });
  const workspace = await service.prepare({
    taskId: "20202020-2020-4020-8020-202020202020", projectRoot: root,
  });
  const devBefore = (await service.prepareDev(root)).headCommit;
  await writeFile(path.join(workspace.projectRoot, "temporary.txt"), "temporary\n", "utf8");
  await git(workspace.projectRoot, "add", "temporary.txt");
  await git(workspace.projectRoot, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "add temporary");
  await git(workspace.projectRoot, "rm", "temporary.txt");
  await git(workspace.projectRoot, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "revert temporary");

  const result = await service.snapshotAndMerge({ taskId: workspace.taskId, projectRoot: workspace.projectRoot });
  const devAfter = (await service.prepareDev(root)).headCommit;
  assert.equal(result.integration.outcome, "no_result");
  assert.equal(result.integration.alreadyIntegrated, false);
  assert.equal(devAfter, devBefore);
});

test("cleanup publication authority requires durable evidence matching origin main", async (context) => {
  const root = await repository(context);
  const revision = await git(root, "rev-parse", "HEAD");
  const dataDir = path.join(root, "..", `${path.basename(root)}-data`);
  context.after(() => rm(dataDir, { recursive: true, force: true }));
  let publication = { revision, generation: "published-generation" };
  const service = new TaskGitWorkspaceService({ dataDir, readPublication: async () => publication });
  const taskId = "30303030-3030-4030-8030-303030303030";
  const reference = { projectRoot: root, branch: "HUB-159", resultCommit: revision };

  let preview = await service.cleanupPreview(taskId, { gitReferences: [reference] });
  assert.equal(preview.gitReferences[0].published, false);
  await git(root, "update-ref", "refs/remotes/origin/main", revision);
  preview = await service.cleanupPreview(taskId, { gitReferences: [reference] });
  assert.equal(preview.gitReferences[0].published, true);
  const confirmedPreview = preview;
  publication = { revision, generation: "replacement-generation-same-revision" };
  await assert.rejects(
    service.cleanup(taskId, {
      allowDirty: false,
      requirePublished: true,
      gitReferences: [reference],
      expectedPreview: confirmedPreview,
    }),
    /publication generation changed/u,
  );
  publication = { revision: "f".repeat(40), generation: "other-generation" };
  preview = await service.cleanupPreview(taskId, { gitReferences: [reference] });
  assert.equal(preview.gitReferences[0].published, false);
  assert.ok(preview.deleting.some((item) => item.kind === "branch" && item.name === "HUB-159"));
});

test("unproven merge process-tree termination persistently blocks the integration root", async (context) => {
  const root = await repository(context);
  const dataDir = path.join(root, "..", `${path.basename(root)}-data`);
  context.after(() => rm(dataDir, { recursive: true, force: true }));
  const service = new TaskGitWorkspaceService({
    dataDir,
    runCommand: async (args, options) => {
      if (args.includes("merge") && args.includes("--no-ff")) {
        const error = new Error("merge process tree stop is unproven");
        error.processTreeStopped = false;
        error.code = "TASK_GIT_TREE_UNPROVEN";
        throw error;
      }
      return runTaskGitCommand(args, options);
    },
  });
  const workspace = await service.prepare({
    taskId: "31313131-3131-4131-8131-313131313131", projectRoot: root,
  });
  await writeFile(path.join(workspace.projectRoot, "blocked.txt"), "blocked\n", "utf8");
  const snapshot = await service.snapshot({
    taskId: workspace.taskId, projectRoot: workspace.projectRoot,
  });

  await assert.rejects(service.mergeIntoDev(snapshot), /tree stop is unproven/u);
  await assert.rejects(service.prepareDev(root), /operator proof/u);
});

test("durable process-tree guard rejects replacement admission until operator proof", {
  skip: process.platform !== "win32" ? "Windows taskkill contract" : false,
}, async (context) => {
  const root = await repository(context);
  const dataDir = path.join(root, "..", `${path.basename(root)}-guard-data`);
  const taskId = "32323232-3232-4232-8232-323232323232";
  const parentScript = path.join(root, "guard-parent.mjs");
  const childScript = path.join(root, "guard-child.mjs");
  const pidFile = path.join(root, "guard-child.pid");
  const staleMutation = path.join(root, "stale-descendant-mutation.txt");
  await writeFile(childScript, `
    import { writeFileSync } from "node:fs";
    setTimeout(() => writeFileSync(process.argv[2], "stale mutation attempted"), 350);
    setInterval(() => {}, 1000);
  `, "utf8");
  await writeFile(parentScript, `
    import { spawn } from "node:child_process";
    import { writeFileSync } from "node:fs";
    const child = spawn(process.execPath, [process.argv[2], process.argv[4]], {
      detached: true, stdio: "ignore",
    });
    child.unref();
    writeFileSync(process.argv[3], String(child.pid));
    setInterval(() => {}, 1000);
  `, "utf8");
  const failingTaskkillSpawn = (executable, args, options) => {
    if (String(executable).toLowerCase() === "taskkill") {
      const killer = new EventEmitter();
      killer.kill = () => {};
      queueMicrotask(() => killer.emit("close", 1));
      return killer;
    }
    return spawn(executable, args, options);
  };
  let descendantPid = null;
  let replacementMutation = false;
  const service = new TaskGitWorkspaceService({ dataDir });
  context.after(async () => {
    if (descendantPid) try { process.kill(descendantPid, "SIGKILL"); } catch {}
    await rm(dataDir, { recursive: true, force: true });
  });

  await assert.rejects(service.withTaskLock(taskId, async (lease) => {
    await runOwnedGit([parentScript, childScript, pidFile, staleMutation], {
      lease,
      executable: process.execPath,
      cwd: root,
      timeoutMs: 5_000,
      spawnProcess: failingTaskkillSpawn,
    });
  }, {
    staleMs: 180,
    retryDelayMs: 2,
    renewLease: async () => false,
  }), /process-tree completion is unproven|process tree stop is unproven/u);
  descendantPid = Number(await readFile(pidFile, "utf8"));

  await assert.rejects(
    service.withTaskLock(taskId, async () => { replacementMutation = true; }),
    /unresolved process-tree guard requires operator proof/u,
  );
  assert.equal(replacementMutation, false);
  await wait(500);
  assert.equal(await readFile(staleMutation, "utf8"), "stale mutation attempted");

  process.kill(descendantPid, "SIGKILL");
  descendantPid = null;
  await wait(100);
  await service.recoverProcessTreeGuard(taskId, {
    repositoryRoot: root,
    operatorProof: "confirmed-no-descendants",
  });
  await service.withTaskLock(taskId, async () => { replacementMutation = true; });
  assert.equal(replacementMutation, true);
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

  const firstResult = await service.snapshotAndMerge({
    taskId: first.taskId,
    projectRoot: first.projectRoot,
  });
  assert.equal(firstResult.integration.integrated, true);
  const devHeadBefore = firstResult.integration.dev.headCommit;
  const statusBefore = await git(
    firstResult.integration.dev.projectRoot,
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
  );
  const conflict = await service.snapshotAndMerge({ taskId: second.taskId, projectRoot: second.projectRoot });
  assert.equal(conflict.integration.integrated, false);
  assert.deepEqual(conflict.integration.conflicts, ["app.txt"]);
  assert.equal(conflict.integration.dev.headCommit, devHeadBefore);
  assert.equal(
    await git(conflict.integration.dev.projectRoot, "rev-parse", "HEAD^{commit}"),
    devHeadBefore,
  );
  assert.equal(
    await git(
      conflict.integration.dev.projectRoot,
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
    ),
    statusBefore,
  );
});

test("Task result merge throws when no abortable merge state was created", async (context) => {
  const root = await repository(context);
  const dataDir = path.join(root, "..", `${path.basename(root)}-data`);
  context.after(() => rm(dataDir, { recursive: true, force: true }));
  const service = new TaskGitWorkspaceService({ dataDir });
  const workspace = await service.prepare({
    taskId: "34343434-3434-4434-8434-343434343434",
    projectRoot: root,
  });
  const dev = await service.prepareDev(root);
  const statusBefore = await git(dev.projectRoot, "status", "--porcelain=v1", "--untracked-files=all");

  await assert.rejects(
    service.mergeIntoDev({
      ...workspace,
      headCommit: "1111111111111111111111111111111111111111",
    }),
    new RegExp(`could not restore managed dev ${dev.headCommit}`, "u"),
  );
  assert.equal(await git(dev.projectRoot, "rev-parse", "HEAD^{commit}"), dev.headCommit);
  assert.equal(
    await git(dev.projectRoot, "status", "--porcelain=v1", "--untracked-files=all"),
    statusBefore,
  );
});

test("Task result merge throws when abort leaves partial worktree state", async (context) => {
  const root = await repository(context);
  const dataDir = path.join(root, "..", `${path.basename(root)}-data`);
  context.after(() => rm(dataDir, { recursive: true, force: true }));
  await writeFile(path.join(root, ".gitattributes"), "app.txt merge=agentHubPartial\n", "utf8");
  await writeFile(path.join(root, "merge-driver.mjs"), [
    'import { writeFileSync } from "node:fs";',
    'writeFileSync("abort-survivor.txt", "partial\\n", "utf8");',
    "process.exit(1);",
    "",
  ].join("\n"), "utf8");
  await git(root, "add", ".gitattributes", "merge-driver.mjs");
  await git(
    root,
    "-c", "user.name=Test",
    "-c", "user.email=test@example.invalid",
    "commit", "-m", "partial merge driver",
  );
  const nodeExecutable = process.execPath.replaceAll("\\", "/");
  await git(
    root,
    "config",
    "merge.agentHubPartial.driver",
    `"${nodeExecutable}" merge-driver.mjs %O %A %B`,
  );
  const service = new TaskGitWorkspaceService({ dataDir });
  const first = await service.prepare({
    taskId: "35353535-3535-4535-8535-353535353535",
    projectRoot: root,
  });
  const second = await service.prepare({
    taskId: "36363636-3636-4636-8636-363636363636",
    projectRoot: root,
  });
  await writeFile(path.join(first.projectRoot, "app.txt"), "first\n", "utf8");
  await writeFile(path.join(second.projectRoot, "app.txt"), "second\n", "utf8");
  const firstResult = await service.snapshotAndMerge({
    taskId: first.taskId,
    projectRoot: first.projectRoot,
  });
  const secondSnapshot = await service.snapshot({
    taskId: second.taskId,
    projectRoot: second.projectRoot,
  });

  await assert.rejects(
    service.mergeIntoDev(secondSnapshot),
    new RegExp(`could not restore managed dev ${firstResult.integration.dev.headCommit}`, "u"),
  );
  assert.equal(
    await git(firstResult.integration.dev.projectRoot, "rev-parse", "HEAD^{commit}"),
    firstResult.integration.dev.headCommit,
  );
  assert.match(
    await git(
      firstResult.integration.dev.projectRoot,
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
    ),
    /abort-survivor\.txt/u,
  );
});

test("startup reconciles MERGE_HEAD, blocks index.lock and clears the block only after repair", async (context) => {
  const root = await repository(context);
  const dataDir = path.join(root, "..", `${path.basename(root)}-data`);
  context.after(() => rm(dataDir, { recursive: true, force: true }));
  const service = new TaskGitWorkspaceService({ dataDir });
  const dev = await service.prepareDev(root);
  const mergeHead = await git(dev.projectRoot, "rev-parse", "--git-path", "MERGE_HEAD");
  const indexLock = await git(dev.projectRoot, "rev-parse", "--git-path", "index.lock");
  await writeFile(mergeHead, `${"f".repeat(40)}\n`, "utf8");
  await writeFile(indexLock, "locked\n", "utf8");

  const blocked = await service.reconcile({ projectRoots: [{ projectRoot: root }] });
  assert.equal(blocked.repositories[0].status, "blocked");
  assert.match(blocked.repositories[0].reason, /merge --abort failed/u);
  const blockFile = path.join(dataDir, "integration-blocks", `${path.basename(dev.repositoryRoot).toLowerCase()}.json`);
  const blocks = await access(path.dirname(blockFile)).then(() => true, () => false);
  assert.equal(blocks, true);

  await unlink(mergeHead).catch(() => {});
  await unlink(indexLock);
  const recovered = await service.reconcile({ projectRoots: [{ projectRoot: root }] });
  assert.equal(recovered.repositories[0].status, "ready");
  assert.equal(canonicalPath(recovered.repositories[0].devRoot), canonicalPath(dev.projectRoot));
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

test("external main is merged into managed dev before new Task creation without changing primary", async (context) => {
  const { root, origin } = await repositoryWithOrigin(context);
  const dataDir = path.join(root, "..", `${path.basename(root)}-data`);
  context.after(() => rm(dataDir, { recursive: true, force: true }));
  const service = new TaskGitWorkspaceService({ dataDir });
  const first = await service.prepare({
    taskId: "45454545-4545-4545-8545-454545454545",
    projectRoot: root,
  });
  await writeFile(path.join(first.projectRoot, "test-only.txt"), "test-only\n", "utf8");
  const firstResult = await service.snapshotAndMerge({ taskId: first.taskId, projectRoot: first.projectRoot });
  const primaryHead = await git(root, "rev-parse", "HEAD^{commit}");
  const primaryStatus = await git(root, "status", "--porcelain=v1", "--untracked-files=all");
  const protectedDevCommit = firstResult.integration.dev.headCommit;
  await git(root, "update-ref", "refs/remotes/origin/dev", protectedDevCommit);
  await git(root, "update-ref", "refs/heads/dev-before-merge", protectedDevCommit);
  await git(root, "tag", "local-preserved-tag", protectedDevCommit);
  await git(root, "config", "remote.origin.tagOpt", "--tags");
  const protectedTags = await git(
    root,
    "for-each-ref",
    "--format=%(refname)%00%(objectname)",
    "refs/tags",
  );

  const externalMain = await advanceOriginMain(context, origin, { "external.txt": "external\n" });
  await git(origin, "update-ref", "refs/heads/dev", externalMain);
  await git(origin, "update-ref", "refs/tags/remote-only-tag", externalMain);
  const second = await service.prepare({
    taskId: "46464646-4646-4646-8646-464646464646",
    projectRoot: root,
  });

  assert.equal(second.baseCommit, externalMain);
  assert.equal(await readFile(path.join(second.projectRoot, "external.txt"), "utf8"), "external\n");
  await assert.rejects(() => readFile(path.join(second.projectRoot, "test-only.txt"), "utf8"), /ENOENT/u);
  const dev = await service.prepareDev(root);
  assert.equal(await readFile(path.join(dev.projectRoot, "external.txt"), "utf8"), "external\n");
  assert.equal(await readFile(path.join(dev.projectRoot, "test-only.txt"), "utf8"), "test-only\n");
  await git(dev.projectRoot, "merge-base", "--is-ancestor", externalMain, dev.headCommit);
  await git(dev.projectRoot, "merge-base", "--is-ancestor", firstResult.snapshot.headCommit, dev.headCommit);
  assert.equal(await git(root, "rev-parse", "HEAD^{commit}"), primaryHead);
  assert.equal(await git(root, "status", "--porcelain=v1", "--untracked-files=all"), primaryStatus);
  assert.equal(await git(root, "rev-parse", "refs/heads/main^{commit}"), primaryHead);
  assert.equal(
    await git(root, "rev-parse", "refs/remotes/origin/dev^{commit}"),
    protectedDevCommit,
  );
  assert.equal(
    await git(root, "rev-parse", "refs/heads/dev-before-merge^{commit}"),
    protectedDevCommit,
  );
  assert.equal(
    await git(root, "for-each-ref", "--format=%(refname)%00%(objectname)", "refs/tags"),
    protectedTags,
  );
  assert.equal(await git(root, "rev-parse", "refs/remotes/origin/main^{commit}"), externalMain);
});

test("Task integration incorporates external main first and preserves both histories", async (context) => {
  const { root, origin } = await repositoryWithOrigin(context);
  const dataDir = path.join(root, "..", `${path.basename(root)}-data`);
  context.after(() => rm(dataDir, { recursive: true, force: true }));
  const service = new TaskGitWorkspaceService({ dataDir });
  const workspace = await service.prepare({
    taskId: "47474747-4747-4747-8747-474747474747",
    projectRoot: root,
  });
  await writeFile(path.join(workspace.projectRoot, "task.txt"), "task\n", "utf8");
  const snapshot = await service.snapshot({ taskId: workspace.taskId, projectRoot: workspace.projectRoot });
  const externalMain = await advanceOriginMain(context, origin, { "external.txt": "external\n" });

  const integration = await service.mergeIntoDev(snapshot);

  assert.equal(integration.integrated, true);
  assert.equal(await readFile(path.join(integration.dev.projectRoot, "external.txt"), "utf8"), "external\n");
  assert.equal(await readFile(path.join(integration.dev.projectRoot, "task.txt"), "utf8"), "task\n");
  await git(integration.dev.projectRoot, "merge-base", "--is-ancestor", externalMain, integration.dev.headCommit);
  await git(integration.dev.projectRoot, "merge-base", "--is-ancestor", snapshot.headCommit, integration.dev.headCommit);
});

test("a Task merge snapshot bootstraps divergent main and managed dev without mutating primary", async (context) => {
  const root = await repository(context);
  const dataDir = path.join(root, "..", `${path.basename(root)}-data`);
  context.after(() => rm(dataDir, { recursive: true, force: true }));
  const service = new TaskGitWorkspaceService({ dataDir });
  const workspace = await service.prepare({
    taskId: "50505050-5050-4050-8050-505050505050",
    projectRoot: root,
  });
  const dev = await service.prepareDev(root);
  await writeFile(path.join(dev.projectRoot, "accepted-test.txt"), "accepted Test work\n", "utf8");
  await git(dev.projectRoot, "add", "accepted-test.txt");
  await git(
    dev.projectRoot,
    "-c", "user.name=Test",
    "-c", "user.email=test@example.invalid",
    "commit", "-m", "accepted Test work",
  );
  const devHead = await git(dev.projectRoot, "rev-parse", "HEAD^{commit}");

  await writeFile(path.join(root, "published-main.txt"), "published main\n", "utf8");
  await git(root, "add", "published-main.txt");
  await git(
    root,
    "-c", "user.name=Test",
    "-c", "user.email=test@example.invalid",
    "commit", "-m", "published main",
  );
  const mainHead = await git(root, "rev-parse", "HEAD^{commit}");
  const primaryStatus = await git(root, "status", "--porcelain=v1", "--untracked-files=all");
  await git(workspace.projectRoot, "merge", "--ff-only", mainHead);
  await git(workspace.projectRoot, "merge", "--no-commit", "--no-ff", devHead);

  const snapshot = await service.snapshot({
    taskId: workspace.taskId,
    projectRoot: workspace.projectRoot,
  });
  const parents = (await git(
    workspace.projectRoot,
    "rev-list", "--parents", "-n", "1", snapshot.headCommit,
  )).split(/\s+/u);
  assert.deepEqual(parents, [snapshot.headCommit, mainHead, devHead]);

  const integration = await service.mergeIntoDev(snapshot);
  assert.equal(integration.integrated, true);
  await git(integration.dev.projectRoot, "merge-base", "--is-ancestor", mainHead, integration.dev.headCommit);
  await git(integration.dev.projectRoot, "merge-base", "--is-ancestor", devHead, integration.dev.headCommit);
  await git(
    integration.dev.projectRoot,
    "merge-base", "--is-ancestor", snapshot.headCommit, integration.dev.headCommit,
  );
  assert.equal(await git(root, "rev-parse", "HEAD^{commit}"), mainHead);
  assert.equal(await git(root, "status", "--porcelain=v1", "--untracked-files=all"), primaryStatus);
});

test("main to dev conflict aborts exactly and reports recoverable refs", async (context) => {
  const { root, origin } = await repositoryWithOrigin(context);
  const dataDir = path.join(root, "..", `${path.basename(root)}-data`);
  context.after(() => rm(dataDir, { recursive: true, force: true }));
  const service = new TaskGitWorkspaceService({ dataDir });
  const workspace = await service.prepare({
    taskId: "48484848-4848-4848-8848-484848484848",
    projectRoot: root,
  });
  await writeFile(path.join(workspace.projectRoot, "app.txt"), "dev-only\n", "utf8");
  const integrated = await service.snapshotAndMerge({ taskId: workspace.taskId, projectRoot: workspace.projectRoot });
  const devHeadBefore = integrated.integration.dev.headCommit;
  const primaryHeadBefore = await git(root, "rev-parse", "HEAD^{commit}");
  const externalMain = await advanceOriginMain(context, origin, { "app.txt": "external\n" });

  const synchronization = await service.synchronizeMainIntoDev({ projectRoot: root });

  assert.equal(synchronization.status, "conflict");
  assert.equal(synchronization.integrated, false);
  assert.equal(synchronization.mainCommit, externalMain);
  assert.equal(synchronization.devHeadBefore, devHeadBefore);
  assert.equal(synchronization.headCommit, devHeadBefore);
  assert.deepEqual(synchronization.conflicts, ["app.txt"]);
  assert.equal(await git(synchronization.projectRoot, "status", "--porcelain=v1", "--untracked-files=all"), "");
  assert.equal(await git(synchronization.projectRoot, "rev-parse", "dev^{commit}"), devHeadBefore);
  assert.equal(await git(root, "rev-parse", "refs/remotes/origin/main^{commit}"), externalMain);
  assert.equal(await git(root, "rev-parse", "HEAD^{commit}"), primaryHeadBefore);
  await assert.rejects(
    service.prepare({ taskId: "49494949-4949-4949-8949-494949494949", projectRoot: root }),
    /main to dev synchronization requires manual resolution.*app\.txt/u,
  );
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

test("a clean managed Task worktree resolves its declared test dependency locally", async (context) => {
  const root = await repository(context);
  const agentHubRoot = path.join(root, "AgentHub");
  const publicTests = path.join(agentHubRoot, "tests", "public");
  const nestedRoot = path.join(agentHubRoot, "tools", "nested");
  await mkdir(publicTests, { recursive: true });
  await mkdir(nestedRoot, { recursive: true });
  const packageJson = {
    name: "managed-worktree-fixture",
    private: true,
    type: "module",
    devDependencies: { playwright: "1.62.1" },
  };
  const lock = {
    name: "managed-worktree-fixture",
    lockfileVersion: 3,
    packages: {
      "": packageJson,
      "node_modules/playwright": { version: "1.62.1", dev: true },
    },
  };
  await writeFile(path.join(agentHubRoot, "package.json"), `${JSON.stringify(packageJson, null, 2)}\n`, "utf8");
  await writeFile(path.join(agentHubRoot, "package-lock.json"), `${JSON.stringify(lock, null, 2)}\n`, "utf8");
  await writeFile(path.join(nestedRoot, "package.json"), "{\"name\":\"nested\",\"private\":true}\n", "utf8");
  await writeFile(path.join(nestedRoot, "package-lock.json"), "{\"name\":\"nested\",\"lockfileVersion\":3,\"packages\":{\"\":{\"name\":\"nested\",\"private\":true}}}\n", "utf8");
  await writeFile(path.join(publicTests, "stream-tabs-controller.test.mjs"), [
    "import assert from \"node:assert/strict\";",
    "import test from \"node:test\";",
    "test(\"declared browser dependency resolves\", async () => {",
    "  const dependency = await import(\"playwright\");",
    "  assert.equal(dependency.available, true);",
    "});",
    "",
  ].join("\n"), "utf8");
  await git(root, "add", "AgentHub/package.json", "AgentHub/package-lock.json", "AgentHub/tests/public/stream-tabs-controller.test.mjs", "AgentHub/tools/nested/package.json", "AgentHub/tools/nested/package-lock.json");
  await git(root, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "dom test fixture");
  const dataDir = path.join(root, "..", `${path.basename(root)}-data`);
  context.after(() => rm(dataDir, { recursive: true, force: true }));
  let installCount = 0;
  const service = new TaskGitWorkspaceService({
    dataDir,
    prepareDependencies: (input) => prepareTaskWorktreeDependencies({
      ...input,
      runNpm: async (args, { cwd }) => {
        installCount += 1;
        assert.deepEqual(args, ["ci", "--include=dev", "--include=optional", "--no-audit", "--no-fund"]);
        if (path.basename(cwd) === "nested") {
          await mkdir(path.join(cwd, "node_modules"), { recursive: true });
          await writeFile(path.join(cwd, "node_modules", ".package-lock.json"), "{\"lockfileVersion\":3,\"packages\":{}}\n", "utf8");
          return;
        }
        await mkdir(path.join(cwd, "node_modules", "playwright"), { recursive: true });
        await writeFile(path.join(cwd, "node_modules", "playwright", "package.json"), [
          "{",
          "  \"name\": \"playwright\",",
          "  \"version\": \"1.62.1\",",
          "  \"type\": \"module\",",
          "  \"exports\": \"./index.mjs\"",
          "}",
          "",
        ].join("\n"), "utf8");
        await writeFile(path.join(cwd, "node_modules", "playwright", "index.mjs"), "export const available = true;\n", "utf8");
        await writeFile(path.join(cwd, "node_modules", ".package-lock.json"), `${JSON.stringify({
          lockfileVersion: 3,
          packages: { "node_modules/playwright": { version: "1.62.1", dev: true } },
        }, null, 2)}\n`, "utf8");
      },
    }),
  });

  const workspace = await service.prepare({
    taskId: "89898989-8989-4989-8989-898989898989",
    taskNumber: "HUB-163",
    projectRoot: agentHubRoot,
  });
  assert.equal(installCount, 2);
  await assert.rejects(() => readFile(path.join(agentHubRoot, "node_modules", "playwright", "package.json"), "utf8"), /ENOENT/u);
  await execFileAsync(process.execPath, ["--test", "tests/public/stream-tabs-controller.test.mjs"], {
    cwd: workspace.projectRoot,
    windowsHide: true,
  });
  const untrackedRoot = path.join(workspace.projectRoot, "tools", "untracked");
  await mkdir(untrackedRoot, { recursive: true });
  await writeFile(path.join(untrackedRoot, "package.json"), "{\"name\":\"untracked\",\"private\":true}\n", "utf8");
  await writeFile(path.join(untrackedRoot, "package-lock.json"), "{\"name\":\"untracked\",\"lockfileVersion\":3,\"packages\":{\"\":{\"name\":\"untracked\",\"private\":true}}}\n", "utf8");

  const repeated = await service.prepare({
    taskId: workspace.taskId,
    taskNumber: "HUB-163",
    projectRoot: workspace.projectRoot,
  });
  assert.equal(repeated.projectRoot, workspace.projectRoot);
  assert.equal(installCount, 2);
});

test("Task worktree preparation does not return when dependency bounds fail", async (context) => {
  const root = await repository(context);
  const agentHubRoot = path.join(root, "AgentHub");
  await mkdir(agentHubRoot);
  const packageJson = { name: "bounded", private: true, dependencies: { first: "1.0.0", second: "1.0.0" } };
  const lock = {
    name: "bounded",
    lockfileVersion: 3,
    packages: {
      "": packageJson,
      "node_modules/first": { version: "1.0.0" },
      "node_modules/second": { version: "1.0.0" },
    },
  };
  await writeFile(path.join(agentHubRoot, "package.json"), `${JSON.stringify(packageJson, null, 2)}\n`, "utf8");
  await writeFile(path.join(agentHubRoot, "package-lock.json"), `${JSON.stringify(lock, null, 2)}\n`, "utf8");
  await git(root, "add", "AgentHub/package.json", "AgentHub/package-lock.json");
  await git(root, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "bounded dependencies");
  const dataDir = path.join(root, "..", `${path.basename(root)}-data`);
  context.after(() => rm(dataDir, { recursive: true, force: true }));
  let npmInvoked = false;
  const service = new TaskGitWorkspaceService({
    dataDir,
    prepareDependencies: (input) => prepareTaskWorktreeDependencies({
      ...input,
      limits: { maxPackageRoots: 1 },
      runNpm: async () => { npmInvoked = true; },
    }),
  });

  await assert.rejects(() => service.prepare({
    taskId: "90909090-9090-4090-8090-909090909090",
    taskNumber: "HUB-163",
    projectRoot: agentHubRoot,
  }), /maxPackageRoots=1/u);
  assert.equal(npmInvoked, false);
});

test("unproven owned npm tree stop fences dependency preparation and the next owner", async (context) => {
  const root = await repository(context);
  const agentHubRoot = path.join(root, "AgentHub");
  await mkdir(agentHubRoot);
  const packageJson = { name: "owned-npm", private: true, devDependencies: { browser: "1.0.0" } };
  const lock = {
    name: "owned-npm",
    lockfileVersion: 3,
    packages: {
      "": packageJson,
      "node_modules/browser": { version: "1.0.0" },
    },
  };
  await writeFile(path.join(agentHubRoot, "package.json"), `${JSON.stringify(packageJson, null, 2)}\n`, "utf8");
  await writeFile(path.join(agentHubRoot, "package-lock.json"), `${JSON.stringify(lock, null, 2)}\n`, "utf8");
  await git(root, "add", "AgentHub/package.json", "AgentHub/package-lock.json");
  await git(root, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "owned npm");
  const dataDir = path.join(root, "..", `${path.basename(root)}-data`);
  context.after(() => rm(dataDir, { recursive: true, force: true }));
  let npmCalls = 0;
  const service = new TaskGitWorkspaceService({
    dataDir,
    runCommand: async (args, options) => {
      if (options.commandLabel === "npm") {
        npmCalls += 1;
        assert.equal(options.signal instanceof AbortSignal, true);
        const error = new Error("npm ci timed out; descendant survived because tree stop is unproven");
        error.code = "TASK_EXTERNAL_PROCESS_TREE_UNPROVEN";
        error.processTreeStopped = false;
        throw error;
      }
      return runTaskGitCommand(args, options);
    },
  });
  const taskId = "91919191-9191-4191-8191-919191919191";

  await assert.rejects(() => service.prepare({
    taskId,
    taskNumber: "HUB-163",
    projectRoot: agentHubRoot,
  }), /descendant survived.*unproven/u);
  const guardDirectory = path.join(dataDir, "task-process-tree-guards", taskId);
  const guardFiles = await readdir(guardDirectory);
  assert.equal(guardFiles.length, 1);
  const guard = JSON.parse(await readFile(path.join(guardDirectory, guardFiles[0]), "utf8"));
  assert.deepEqual(guard.command, [
    "npm", "ci", "--include=dev", "--include=optional", "--no-audit", "--no-fund",
  ]);
  await assert.rejects(() => service.prepare({
    taskId,
    taskNumber: "HUB-163",
    projectRoot: agentHubRoot,
  }), /unresolved process-tree guard requires operator proof/u);
  assert.equal(npmCalls, 1);
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
