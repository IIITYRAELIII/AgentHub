import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  LF_NORMALIZATION_ALREADY_PRESENT,
  normalizedTaskSquashTransfer,
} from "../../../src/domain/task-squash-transfer.mjs";
import { taskRepositoryKey } from "../../../src/domain/task-git-reference.mjs";
import { ReleaseGitWorkspaceService } from "../../../src/infrastructure/filesystem/release-git-workspace.mjs";
import { releaseTaskNetProjections } from "../../../src/infrastructure/filesystem/release-task-net-projection.mjs";
import { TaskGitWorkspaceService } from "../../../src/infrastructure/filesystem/task-git-workspace.mjs";

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const repositoryRoot = path.dirname(projectRoot);

const MAIN = "19bd6728478413da8b3a8a4eedca52b2058af042";
const DEV = "0b7047c2075fe82367add07540545311fe5d0faa";
const REVIEWED_RESULT = process.env.AGENT_HUB_SELECTED_COMPOSITION_RESULT
  ?? "c64d83f21f17f35e9f008cd170c80daade922389";
const REVIEWED_DEV_AFTER_TREE = process.env.AGENT_HUB_SELECTED_COMPOSITION_DEV_AFTER_TREE ?? null;
const REVIEWED_INTEGRATION = process.env.AGENT_HUB_SELECTED_COMPOSITION_INTEGRATION ?? null;
const PREVIOUS_RESULT = "b717d5db6b8a826007e20bd14afc5da9b3d90042";
const SELECTED_DESCENDANT_NORMALIZATION_PATHS = new Set([
  "AgentHub/docs/contracts/PERF-001-local-latency.md",
  "AgentHub/docs/contracts/RST-001-restart-recovery.md",
]);

async function git(cwd, args, options = {}) {
  return execFileAsync("git", args, {
    cwd,
    encoding: options.encoding ?? "utf8",
    env: options.env == null ? process.env : { ...process.env, ...options.env },
    maxBuffer: 64 * 1024 * 1024,
  });
}

async function value(cwd, args, options = {}) {
  return (await git(cwd, args, options)).stdout.trim();
}

async function changedPaths(cwd, left, right) {
  const { stdout } = await git(cwd, [
    "diff", "--no-renames", "--name-only", "-z", left, right, "--",
    ".", ":(exclude,glob)**/CHANGELOG.md", ":(exclude)CHANGELOG.md",
  ], { encoding: "buffer" });
  return stdout.toString("utf8").split("\0").filter(Boolean).sort();
}

async function treeEntry(cwd, treeish, file) {
  const { stdout } = await git(cwd, ["ls-tree", "-z", treeish, "--", file], { encoding: "buffer" });
  const record = stdout.toString("utf8").replace(/\0$/u, "");
  if (!record) return null;
  const match = /^(\d{6}) blob ([0-9a-f]{40})\t/u.exec(record);
  assert.ok(match, `expected one blob entry for ${treeish}:${file}`);
  return { mode: match[1], object: match[2] };
}

async function canonicalProof(cwd, dataDir, integrationCommit, devAfterTree) {
  const sourceBase = "5c2917340256fae8f67efacf55b6a0aee01085a6";
  const sourceResult = "03d67ba0704cecadd3d4a0eea10ec27a1fe8ba70";
  const sourceId = "66eecccb-69f4-4e2e-b094-01369297f17d";
  const survivorId = "cb6f2929-7b1a-4513-9481-68e39a108480";
  const service = new TaskGitWorkspaceService({ dataDir });
  const sourceWorkspace = await service.prepare({ taskId: sourceId, taskNumber: "HUB-224", projectRoot: cwd });
  const survivorWorkspace = await service.prepare({ taskId: survivorId, taskNumber: "HUB-235", projectRoot: cwd });
  const devWorkspace = await service.prepareDev(cwd);
  await git(sourceWorkspace.projectRoot, ["reset", "--hard", sourceResult]);
  await git(survivorWorkspace.projectRoot, ["reset", "--hard", REVIEWED_RESULT]);
  await git(devWorkspace.projectRoot, ["reset", "--hard", DEV]);
  const repositoryKey = taskRepositoryKey(cwd);
  await git(cwd, ["update-ref", `refs/agent-hub/task-bases/${sourceId}/${repositoryKey}`, sourceBase]);
  await git(cwd, ["update-ref", `refs/agent-hub/task-bases/${survivorId}/${repositoryKey}`, sourceBase]);
  const source = {
    id: sourceId, revision: 13, releaseRevision: 13, workflowStatus: "testing",
    gitReferences: [{ projectRoot: cwd, branch: sourceWorkspace.branch, resultCommit: sourceResult }],
  };
  const survivor = {
    id: survivorId, revision: 164, releaseRevision: 163, workflowStatus: "testing",
    gitReferences: [{ projectRoot: cwd, branch: survivorWorkspace.branch, resultCommit: PREVIOUS_RESULT }],
  };
  return service.withTaskLocks([sourceId, survivorId], async (lease) => {
    const preview = await service.previewSquashTransferOwned({
      source, survivor, projectRoot: cwd,
      baselineResultCommit: PREVIOUS_RESULT,
      newResultCommit: REVIEWED_RESULT,
      devAfterTree,
      authority: {
      workspaceId: "workspace",
      streamId: "release",
      provider: "codex",
      threadId: "thread",
      proofRequestId: "hub-235-selected-composition-regression",
      },
      lease,
    });
    return normalizedTaskSquashTransfer({ ...preview, integrationCommit });
  }, { guardTaskId: survivorId });
}

test("historical five-Task proof retains complete source witnesses without applying dev", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ah-selected-composition-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3 }));
  const primary = path.join(root, "primary");
  await git(root, ["clone", "--no-hardlinks", "--no-checkout", repositoryRoot, primary]);
  await git(primary, ["config", "core.autocrlf", "false"]);
  await git(primary, ["checkout", "--detach", MAIN]);

  let devAfterTree = REVIEWED_DEV_AFTER_TREE;
  let integrationCommit = REVIEWED_INTEGRATION;
  if (Boolean(devAfterTree) !== Boolean(integrationCommit)) {
    throw new Error("exact selected composition override requires both dev-after tree and integration commit");
  }
  if (devAfterTree) {
    assert.equal(await value(primary, ["rev-parse", `${integrationCommit}^{tree}`]), devAfterTree);
    assert.equal(
      await value(primary, ["show", "-s", "--format=%P", integrationCommit]),
      `${DEV} ${REVIEWED_RESULT}`,
    );
  } else {
    const index = path.join(root, "dev-after.index");
    const env = { GIT_INDEX_FILE: index };
    await git(primary, ["read-tree", DEV], { env });
    for (const [position, file] of (await changedPaths(primary, PREVIOUS_RESULT, REVIEWED_RESULT)).entries()) {
    const [before, reviewed] = await Promise.all([
      treeEntry(primary, DEV, file),
      treeEntry(primary, REVIEWED_RESULT, file),
    ]);
    if (!reviewed) {
      await git(primary, ["update-index", "--force-remove", "--", file], { env });
      continue;
    }
    let object = reviewed.object;
    let mode = reviewed.mode;
    if (before && SELECTED_DESCENDANT_NORMALIZATION_PATHS.has(file)) {
      const { stdout } = await git(primary, ["show", `${DEV}:${file}`], { encoding: "buffer" });
      const normalized = Buffer.from(stdout.toString("binary").replace(/\r\n/g, "\n"), "binary");
      const temporary = path.join(root, `normalized-${position}`);
      await writeFile(temporary, normalized);
      object = await value(primary, ["hash-object", "-w", temporary]);
      mode = before.mode;
    }
    await git(primary, ["update-index", "--add", "--cacheinfo", mode, object, file], { env });
    }
    devAfterTree = await value(primary, ["write-tree"], { env });
    integrationCommit = await value(primary, [
      "-c", "user.name=Agent Hub", "-c", "user.email=agent-hub@local.invalid",
      "commit-tree", devAfterTree, "-p", DEV, "-p", REVIEWED_RESULT,
      "-m", "test: exact normalized squash integration",
    ]);
  }
  await git(primary, ["update-ref", "refs/heads/dev", integrationCommit]);
  await git(primary, ["update-ref", "refs/heads/main", MAIN]);
  await git(primary, ["checkout", "main"]);

  const proof = await canonicalProof(primary, path.join(root, "task-data"), integrationCommit, devAfterTree);
  assert.equal(proof.source.resultCommit, "03d67ba0704cecadd3d4a0eea10ec27a1fe8ba70");
  assert.equal(proof.survivor.resultCommit, REVIEWED_RESULT);
  assert.deepEqual(proof.sourceWitnesses.map(witness => witness.path).sort(),
    await changedPaths(primary, proof.source.baseCommit, proof.source.resultCommit));
  assert.ok(proof.sourceWitnesses.every(witness => !witness.source || witness.survivor));
  assert.equal(await value(primary, ["status", "--porcelain"]), "");
  assert.equal(await value(primary, ["rev-parse", "HEAD"]), MAIN);
});

test("release projection rejects a forged LF disposition with real semantic Git entries", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ah-forged-lf-proof-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3 }));
  await git(root, ["init", "--initial-branch=main"]);
  await git(root, ["config", "core.autocrlf", "false"]);
  await writeFile(path.join(root, "seed.txt"), "seed\n");
  await git(root, ["add", "."]);
  await git(root, ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "main"]);
  const main = await value(root, ["rev-parse", "HEAD"]);
  await writeFile(path.join(root, "contract.md"), "first\r\nsecond\r\n");
  await git(root, ["add", "contract.md"]);
  await git(root, ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "baseline"]);
  const baseline = await value(root, ["rev-parse", "HEAD"]);
  await git(root, ["checkout", "-b", "source"]);
  await writeFile(path.join(root, "source.txt"), "source\n");
  await git(root, ["add", "source.txt"]);
  await git(root, ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "source"]);
  const sourceResult = await value(root, ["rev-parse", "HEAD"]);
  await git(root, ["checkout", "-b", "result", baseline]);
  await writeFile(path.join(root, "contract.md"), "first\nchanged\n");
  await writeFile(path.join(root, "source.txt"), "source\n");
  await git(root, ["add", "."]);
  await git(root, ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "result"]);
  const result = await value(root, ["rev-parse", "HEAD"]);
  await git(root, ["checkout", "-b", "dev", main]);
  await writeFile(path.join(root, "contract.md"), "first\nsecond\nselected addition\n");
  await writeFile(path.join(root, "source.txt"), "source\n");
  await git(root, ["add", "."]);
  await git(root, ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "dev"]);
  const dev = await value(root, ["rev-parse", "HEAD"]);
  const devTree = await value(root, ["rev-parse", "HEAD^{tree}"]);
  const integration = await value(root, [
    "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
    "commit-tree", devTree, "-p", dev, "-p", result, "-m", "forged integration",
  ]);
  const sourceEntry = await treeEntry(root, sourceResult, "source.txt");
  const resultSourceEntry = await treeEntry(root, result, "source.txt");
  const devSourceEntry = await treeEntry(root, dev, "source.txt");
  const proof = normalizedTaskSquashTransfer({
    version: 1,
    kind: "task-squash-transfer-v1",
    survivor: {
      taskId: "survivor", revision: 2, releaseRevision: 2,
      resultCommit: result, baseCommit: main, branch: "result",
    },
    source: {
      taskId: "source", revision: 2, releaseRevision: 2,
      resultCommit: sourceResult, baseCommit: baseline, branch: "source",
    },
    projectRoot: root,
    previousResultCommit: baseline,
    baselineResultCommit: baseline,
    devBeforeCommit: dev,
    devAfterTree: devTree,
    sourceWitnesses: [{ path: "source.txt", source: sourceEntry, survivor: resultSourceEntry }],
    ownerWitnesses: [{
      path: "contract.md",
      baseline: await treeEntry(root, baseline, "contract.md"),
      beforeDev: await treeEntry(root, dev, "contract.md"),
      newResult: await treeEntry(root, result, "contract.md"),
      afterDev: await treeEntry(root, devTree, "contract.md"),
      disposition: LF_NORMALIZATION_ALREADY_PRESENT,
    }, {
      path: "source.txt", baseline: null, beforeDev: devSourceEntry,
      newResult: resultSourceEntry, afterDev: devSourceEntry,
    }],
    authority: {
      workspaceId: "workspace", streamId: "release", provider: "codex",
      threadId: "thread", proofRequestId: "forged-lf-proof",
    },
    integrationCommit: integration,
  });
  const projectorGit = async (args, options = {}) => {
    const { stdout } = await git(root, args, { encoding: options.rawOutput ? "buffer" : "utf8" });
    return options.rawOutput ? stdout : stdout.trim();
  };
  await assert.rejects(releaseTaskNetProjections({
    tasks: [{
      taskId: "survivor", baseCommit: main, resultCommit: result,
      integrations: [{ commit: integration, parent: dev, order: 1 }],
      squashTransfer: proof,
    }],
    baseCommit: main,
    git: projectorGit,
  }), /requires the exact squash projection/u);
});

test("mandatory results advance before an earlier ordinary integration and rollback preserves the candidate", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ah-multiple-mandatory-"));
  const origin = `${root}-origin`;
  const releaseData = `${root}-release-data`;
  const index = `${root}-combined.index`;
  t.after(() => Promise.all([
    rm(root, { recursive: true, force: true, maxRetries: 3 }),
    rm(origin, { recursive: true, force: true, maxRetries: 3 }),
    rm(releaseData, { recursive: true, force: true, maxRetries: 3 }),
    rm(index, { force: true }),
  ]));
  await git(root, ["init", "--bare", origin]);
  await git(root, ["init", "--initial-branch=main"]);
  await git(root, ["config", "core.autocrlf", "false"]);
  await writeFile(path.join(root, "seed.txt"), "seed\n");
  await git(root, ["add", "."]);
  await git(root, ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "main"]);
  const main = await value(root, ["rev-parse", "HEAD"]);
  const resultFor = async (branch, file, content) => {
    await git(root, ["checkout", "-B", branch, main]);
    await writeFile(path.join(root, file), content);
    await git(root, ["add", file]);
    await git(root, ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", branch]);
    return value(root, ["rev-parse", "HEAD"]);
  };
  const ordinaryResult = await resultFor("task-ordinary", "ordinary.txt", "ordinary\n");
  const resultA = await resultFor("task-a", "a.txt", "a\n");
  const resultB = await resultFor("task-b", "b.txt", "b\n");
  const resultConflict = await resultFor("task-conflict", "a.txt", "conflict\n");
  const ordinaryTree = await value(root, ["rev-parse", `${ordinaryResult}^{tree}`]);
  const integrationOrdinary = await value(root, [
    "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
    "commit-tree", ordinaryTree, "-p", main, "-p", ordinaryResult, "-m", "integrate ordinary",
  ]);
  const env = { GIT_INDEX_FILE: index };
  await git(root, ["read-tree", integrationOrdinary], { env });
  const aEntry = await treeEntry(root, resultA, "a.txt");
  await git(root, ["update-index", "--add", "--cacheinfo", aEntry.mode, aEntry.object, "a.txt"], { env });
  const treeA = await value(root, ["write-tree"], { env });
  const integrationA = await value(root, [
    "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
    "commit-tree", treeA, "-p", integrationOrdinary, "-p", resultA, "-m", "integrate a",
  ]);
  await git(root, ["read-tree", integrationA], { env });
  const bEntry = await treeEntry(root, resultB, "b.txt");
  await git(root, ["update-index", "--add", "--cacheinfo", bEntry.mode, bEntry.object, "b.txt"], { env });
  const combinedTree = await value(root, ["write-tree"], { env });
  const integrationB = await value(root, [
    "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
    "commit-tree", combinedTree, "-p", integrationA, "-p", resultB, "-m", "integrate b",
  ]);
  await git(root, ["read-tree", integrationOrdinary], { env });
  const conflictEntry = await treeEntry(root, resultConflict, "a.txt");
  await git(root, ["update-index", "--add", "--cacheinfo", conflictEntry.mode, conflictEntry.object, "a.txt"], { env });
  const conflictTree = await value(root, ["write-tree"], { env });
  const integrationConflict = await value(root, [
    "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
    "commit-tree", conflictTree, "-p", integrationA, "-p", resultConflict, "-m", "integrate conflict",
  ]);
  await git(root, ["update-ref", "refs/heads/dev", integrationB]);
  await git(root, ["checkout", "main"]);
  await git(root, ["remote", "add", "origin", origin]);
  await git(root, ["push", "origin", "--all"]);
  const proofFor = async ({ taskId, sourceId, result, file, beforeDev, afterTree, integration }) => {
    const resultEntry = await treeEntry(root, result, file);
    return normalizedTaskSquashTransfer({
      version: 1,
      kind: "task-squash-transfer-v1",
      survivor: {
        taskId, revision: 2, releaseRevision: 2,
        resultCommit: result, baseCommit: main, branch: taskId,
      },
      source: {
        taskId: sourceId, revision: 2, releaseRevision: 2,
        resultCommit: result, baseCommit: main, branch: sourceId,
      },
      projectRoot: root,
      previousResultCommit: main,
      baselineResultCommit: main,
      devBeforeCommit: beforeDev,
      devAfterTree: afterTree,
      sourceWitnesses: [{ path: file, source: resultEntry, survivor: resultEntry }],
      ownerWitnesses: [{
        path: file,
        baseline: null,
        beforeDev: await treeEntry(root, beforeDev, file),
        newResult: resultEntry,
        afterDev: await treeEntry(root, afterTree, file),
      }],
      authority: {
        workspaceId: "workspace", streamId: "release", provider: "codex",
        threadId: "thread", proofRequestId: `proof-${taskId}`,
      },
      integrationCommit: integration,
    });
  };
  const proofA = await proofFor({
    taskId: "task-a", sourceId: "source-a", result: resultA, file: "a.txt",
    beforeDev: integrationOrdinary, afterTree: treeA, integration: integrationA,
  });
  const proofB = await proofFor({
    taskId: "task-b", sourceId: "source-b", result: resultB, file: "b.txt",
    beforeDev: integrationA, afterTree: combinedTree, integration: integrationB,
  });
  const proofConflict = await proofFor({
    taskId: "task-conflict", sourceId: "source-conflict", result: resultConflict, file: "a.txt",
    beforeDev: integrationA, afterTree: conflictTree, integration: integrationConflict,
  });
  const task = (taskId, resultCommit, integration, parent, order, squashTransfer) => ({
    taskId, taskRevision: 3, baseCommit: main, resultCommit,
    integrations: [{ commit: integration, parent, order }], squashTransfer,
  });
  const ordinaryTask = {
    taskId: "task-ordinary", taskRevision: 3, baseCommit: main, resultCommit: ordinaryResult,
    integrations: [{ commit: integrationOrdinary, parent: main, order: 0 }],
  };
  const taskA = task("task-a", resultA, integrationA, integrationOrdinary, 1, proofA);
  const taskB = task("task-b", resultB, integrationB, integrationA, 2, proofB);
  const conflictTask = task(
    "task-conflict", resultConflict, integrationConflict, integrationA, 2, proofConflict,
  );
  const service = new ReleaseGitWorkspaceService({ dataDir: releaseData });
  const accepted = await service.prepareCandidate({
    workspaceId: "workspace", planRevision: "two-mandatory",
    projectRoot: root, approvedBaseCommit: main, frozenTasks: [ordinaryTask, taskA, taskB],
  });
  assert.equal(await value(accepted.releaseRoot, ["rev-parse", `${accepted.preReleaseHead}^{tree}`]), combinedTree);
  assert.deepEqual(accepted.manifest.tasks.map(task => task.taskId).sort(), ["task-a", "task-b", "task-ordinary"]);
  assert.equal(accepted.manifest.compositionPolicy, "main-selected-git-merge-v1");
  await assert.rejects(service.prepareCandidate({
    workspaceId: "workspace", planRevision: "conflicting-mandatory",
    projectRoot: root, approvedBaseCommit: main, frozenTasks: [ordinaryTask, taskA, conflictTask],
  }), { code: "RELEASE_NATIVE_MERGE_CONFLICT" });
  const readback = await service.prepareCandidate({
    workspaceId: "workspace", planRevision: "two-mandatory",
    projectRoot: root, approvedBaseCommit: main, frozenTasks: [ordinaryTask, taskA, taskB],
  });
  assert.equal(readback.preReleaseHead, accepted.preReleaseHead);
  assert.equal(await value(readback.releaseRoot, ["rev-parse", `${readback.preReleaseHead}^{tree}`]), combinedTree);
  assert.equal(await value(root, ["status", "--porcelain"]), "");
  assert.equal(await value(root, ["rev-parse", "--abbrev-ref", "HEAD"]), "main");
});
