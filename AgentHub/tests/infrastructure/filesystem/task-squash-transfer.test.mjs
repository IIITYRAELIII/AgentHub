import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { promisify } from "node:util";

import {
  runTaskGitCommand,
  TaskGitWorkspaceService,
} from "../../../src/infrastructure/filesystem/task-git-workspace.mjs";
import { ReleaseGitWorkspaceService } from "../../../src/infrastructure/filesystem/release-git-workspace.mjs";
import { releaseTaskNetProjections } from "../../../src/infrastructure/filesystem/release-task-net-projection.mjs";
import { TaskBoardService } from "../../../src/application/task-board-service.mjs";
import { TaskLifecycleService } from "../../../src/application/task-lifecycle-service.mjs";
import { TaskReleasePlanService } from "../../../src/application/task-release-plan-service.mjs";
import { WorkspaceReleasePreflightService } from "../../../src/application/workspace-release-preflight-service.mjs";
import { TaskOperationReconciliationService } from "../../../src/application/task-operation-reconciliation-service.mjs";
import { normalizedTaskSquashTransfer } from "../../../src/domain/task-squash-transfer.mjs";
import { TaskBoardStore } from "../../../src/infrastructure/persistence/task-board-store.mjs";
import { WorkspaceCatalogStore } from "../../../src/infrastructure/persistence/workspace-catalog-store.mjs";

const execFileAsync = promisify(execFile);
const SOURCE_ID = "11111111-1111-4111-8111-111111111111";
const SURVIVOR_ID = "22222222-2222-4222-8222-222222222222";

async function git(cwd, ...args) {
  return String((await execFileAsync("git", args, { cwd, windowsHide: true })).stdout).trim();
}

async function commit(cwd, message) {
  await git(cwd, "add", "-A");
  await git(cwd, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", message);
  return git(cwd, "rev-parse", "HEAD");
}

function argumentsHash(value) {
  const canonical = (input) => Array.isArray(input)
    ? input.map(canonical)
    : input && typeof input === "object"
      ? Object.fromEntries(Object.keys(input).sort().map((key) => [key, canonical(input[key])]))
      : input;
  return createHash("sha256").update(JSON.stringify(canonical(value)), "utf8").digest("hex");
}

test("exact squash transfer adds the selected delta once and preserves foreign dev bytes", { timeout: 180_000 }, async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-squash-"));
  const dataDir = `${root}-data`;
  const releaseDataDir = `${root}-release-data`;
  const invalidWitnessReleaseDataDir = `${root}-release-invalid-witness`;
  const missingIntegrationReleaseDataDir = `${root}-release-missing-integration`;
  const unavailableProofReleaseDataDir = `${root}-release-unavailable-proof`;
  const publishedReleaseDataDir = `${root}-release-published`;
  const origin = `${root}-origin`;
  context.after(() => Promise.all([
    rm(root, { recursive: true, force: true }),
    rm(dataDir, { recursive: true, force: true }),
    rm(releaseDataDir, { recursive: true, force: true }),
    rm(invalidWitnessReleaseDataDir, { recursive: true, force: true }),
    rm(missingIntegrationReleaseDataDir, { recursive: true, force: true }),
    rm(unavailableProofReleaseDataDir, { recursive: true, force: true }),
    rm(publishedReleaseDataDir, { recursive: true, force: true }),
    rm(origin, { recursive: true, force: true }),
  ]));
  await git(root, "init", "-b", "main");
  await git(root, "config", "core.autocrlf", "false");
  await writeFile(path.join(root, "app.txt"), "main\n");
  await commit(root, "main");
  await mkdir(origin, { recursive: true });
  await git(origin, "init", "--bare");
  await git(root, "remote", "add", "origin", origin);
  await git(root, "push", "-u", "origin", "main");
  let publication = null;
  let injectIgnoredCollision = false;
  let failRealIndexPromotion = false;
  let devRootForInjection = null;
  const lateUntracked = "late-untracked.txt";
  const service = new TaskGitWorkspaceService({
    dataDir,
    readPublication: async () => publication,
    runCommand: async (args, options) => {
      if (failRealIndexPromotion && args[0] === "read-tree"
          && args[1] === "-i" && args[2] === "-m") {
        failRealIndexPromotion = false;
        throw new Error("injected interruption before real index promotion");
      }
      const result = await runTaskGitCommand(args, options);
      if (injectIgnoredCollision && args[0] === "update-ref" && args[1] === "refs/heads/dev") {
        injectIgnoredCollision = false;
        const commonDir = await git(devRootForInjection, "rev-parse", "--git-common-dir");
        await writeFile(path.resolve(devRootForInjection, commonDir, "info", "exclude"), "unique.txt\n");
        await writeFile(path.join(devRootForInjection, "unique.txt"), "late ignored bytes must survive\n");
      }
      return result;
    },
  });

  const sourceWorkspace = await service.prepare({ taskId: SOURCE_ID, taskNumber: "HUB-224", projectRoot: root });
  await writeFile(path.join(sourceWorkspace.projectRoot, "source.txt"), "source-result\n");
  const sourceTest = await service.snapshotAndMerge({
    taskId: SOURCE_ID, taskNumber: "HUB-224", projectRoot: sourceWorkspace.projectRoot,
  });
  const survivorWorkspace = await service.prepare({ taskId: SURVIVOR_ID, taskNumber: "HUB-235", projectRoot: root });
  await writeFile(path.join(survivorWorkspace.projectRoot, "survivor.txt"), "baseline\n");
  await writeFile(path.join(survivorWorkspace.projectRoot, "excluded.txt"), "foreign-survivor-residue\n");
  const survivorTest = await service.snapshotAndMerge({
    taskId: SURVIVOR_ID, taskNumber: "HUB-235", projectRoot: survivorWorkspace.projectRoot,
  });
  const baseline = survivorTest.snapshot.headCommit;

  await rm(path.join(survivorWorkspace.projectRoot, "excluded.txt"));
  const cleanBaseline = await commit(survivorWorkspace.projectRoot, "reviewed clean baseline");
  await writeFile(path.join(survivorWorkspace.projectRoot, "source.txt"), "source-result\n");
  await writeFile(path.join(survivorWorkspace.projectRoot, "unique.txt"), "new-survivor-effect\n");
  const newResult = await commit(survivorWorkspace.projectRoot, "clean combined result");
  const dev = await service.prepareDev(root);
  devRootForInjection = dev.projectRoot;
  await writeFile(path.join(dev.projectRoot, "foreign.txt"), "unselected-dev-byte\n");
  await commit(dev.projectRoot, "foreign dev work");
  const devBefore = await git(dev.projectRoot, "rev-parse", "HEAD");
  await writeFile(path.join(dev.projectRoot, "unique.txt"), "new-survivor-effect\n");
  await git(dev.projectRoot, "add", "unique.txt");
  const devAfterTree = await git(dev.projectRoot, "write-tree");
  await git(dev.projectRoot, "reset", "--hard", devBefore);

  const source = {
    id: SOURCE_ID, revision: 4, releaseRevision: 4, workflowStatus: "testing",
    gitReferences: [{ projectRoot: root, branch: sourceWorkspace.branch, resultCommit: sourceTest.snapshot.headCommit }],
  };
  const survivor = {
    id: SURVIVOR_ID, revision: 8, releaseRevision: 6, workflowStatus: "testing",
    gitReferences: [{ projectRoot: root, branch: survivorWorkspace.branch, resultCommit: baseline }],
  };
  const authority = {
    workspaceId: "workspace", streamId: "release", provider: "codex",
    threadId: "thread", proofRequestId: "request",
  };
  let applied;
  await service.withTaskLocks([SOURCE_ID, SURVIVOR_ID], async (lease) => {
    await writeFile(path.join(survivorWorkspace.projectRoot, "source.txt"), "");
    const emptySourceResult = await commit(survivorWorkspace.projectRoot, "invalid empty source result");
    await assert.rejects(service.previewSquashTransferOwned({
      source, survivor, projectRoot: root, baselineResultCommit: cleanBaseline,
      newResultCommit: emptySourceResult, devAfterTree, authority, lease,
    }), /empty blob/);
    await git(survivorWorkspace.projectRoot, "reset", "--hard", newResult);
    await assert.rejects(service.previewSquashTransferOwned({
      source, survivor, projectRoot: root,
      baselineResultCommit: sourceTest.snapshot.headCommit,
      newResultCommit: newResult, devAfterTree, authority, lease,
    }), /clean baseline must be an ancestor/);
    const preview = await service.previewSquashTransferOwned({
      source, survivor, projectRoot: root, baselineResultCommit: cleanBaseline,
      newResultCommit: newResult, devAfterTree, authority, lease,
    });
    assert.equal(preview.devBeforeCommit, devBefore);
    assert.equal(preview.previousResultCommit, baseline);
    assert.equal(preview.baselineResultCommit, cleanBaseline);
    assert.equal(preview.ownerWitnesses.find((item) => item.path === "unique.txt")?.disposition, "applied");
    assert.equal(preview.ownerWitnesses.find((item) => item.path === "source.txt")?.disposition, "already-present");
    await assert.rejects(service.previewSquashTransferOwned({
      source, survivor, projectRoot: root, baselineResultCommit: cleanBaseline,
      newResultCommit: newResult, devAfterTree: await git(root, "rev-parse", `${devBefore}^{tree}`),
      authority, lease,
    }), /missing from dev/);
    injectIgnoredCollision = true;
    await assert.rejects(service.applySquashTransferOwned({
      source, survivor, projectRoot: root, baselineResultCommit: cleanBaseline,
      newResultCommit: newResult, devAfterTree, authority,
      expectedTransferHash: preview.transferHash, lease,
    }), /would be overwritten|materialization/u);
    assert.equal(await readFile(path.join(dev.projectRoot, "unique.txt"), "utf8"), "late ignored bytes must survive\n");
    let readback = await service.readSquashTransferOwned(preview, { projectRoot: root, lease });
    assert.equal(readback.status, "pending_materialization");
    assert.match(readback.proof.integrationCommit, /^[0-9a-f]{40}$/u);

    await rm(path.join(dev.projectRoot, "unique.txt"));
    await mkdir(path.join(dev.projectRoot, "unique.txt"));
    await writeFile(path.join(dev.projectRoot, "unique.txt", "child.txt"), "late ignored directory bytes must survive\n");
    await assert.rejects(service.materializeSquashTransferOwned(readback.proof, {
      projectRoot: root, lease,
    }), /would be overwritten|materialization|lose untracked files/u);
    assert.equal(
      await readFile(path.join(dev.projectRoot, "unique.txt", "child.txt"), "utf8"),
      "late ignored directory bytes must survive\n",
    );
    await rm(path.join(dev.projectRoot, "unique.txt"), { recursive: true });

    failRealIndexPromotion = true;
    await assert.rejects(service.materializeSquashTransferOwned(readback.proof, {
      projectRoot: root, lease,
    }), /injected interruption/u);
    assert.equal(await readFile(path.join(dev.projectRoot, "unique.txt"), "utf8"), "new-survivor-effect\n");
    assert.equal(
      (await service.readSquashTransferOwned(readback.proof, { projectRoot: root, lease })).status,
      "pending_materialization",
    );
    await writeFile(path.join(dev.projectRoot, "unique.txt"), "changed after interrupted checkout\n");
    await assert.rejects(service.materializeSquashTransferOwned(readback.proof, {
      projectRoot: root, lease,
    }), /would be overwritten|materialization/u);
    assert.equal(
      await readFile(path.join(dev.projectRoot, "unique.txt"), "utf8"),
      "changed after interrupted checkout\n",
    );
    await writeFile(path.join(dev.projectRoot, "unique.txt"), "new-survivor-effect\n");
    await service.materializeSquashTransferOwned(readback.proof, {
      projectRoot: root, lease,
    });
    assert.equal(
      (await service.readSquashTransferOwned(readback.proof, { projectRoot: root, lease })).status,
      "applied",
    );

    await writeFile(path.join(dev.projectRoot, "app.txt"), "late tracked edit must survive\n");
    await writeFile(path.join(dev.projectRoot, lateUntracked), "late untracked edit must survive\n");
    await assert.rejects(service.materializeSquashTransferOwned(readback.proof, {
      projectRoot: root, lease,
    }), /would be overwritten|materialization/u);
    assert.equal(await readFile(path.join(dev.projectRoot, "app.txt"), "utf8"), "late tracked edit must survive\n");
    assert.equal(await readFile(path.join(dev.projectRoot, lateUntracked), "utf8"), "late untracked edit must survive\n");
    await writeFile(path.join(dev.projectRoot, "app.txt"), "main\n");
    await assert.rejects(service.materializeSquashTransferOwned(readback.proof, {
      projectRoot: root, lease,
    }), /materialization remains incomplete/u);
    assert.equal(await readFile(path.join(dev.projectRoot, lateUntracked), "utf8"), "late untracked edit must survive\n");
    await rm(path.join(dev.projectRoot, lateUntracked));
    applied = await service.materializeSquashTransferOwned(readback.proof, {
      projectRoot: root, lease,
    });
    assert.match(applied.integrationCommit, /^[0-9a-f]{40}$/u);
    readback = await service.readSquashTransferOwned(preview, { projectRoot: root, lease });
    assert.equal(readback.status, "applied");
  }, { guardTaskId: SURVIVOR_ID });
  assert.equal(await readFile(path.join(dev.projectRoot, "foreign.txt"), "utf8"), "unselected-dev-byte\n");
  assert.equal(await readFile(path.join(dev.projectRoot, "excluded.txt"), "utf8"), "foreign-survivor-residue\n");
  assert.equal(await readFile(path.join(dev.projectRoot, "source.txt"), "utf8"), "source-result\n");
  assert.equal(await readFile(path.join(dev.projectRoot, "unique.txt"), "utf8"), "new-survivor-effect\n");
  const releaseTask = {
    taskId: SURVIVOR_ID,
    baseCommit: survivorTest.snapshot.baseCommit,
    resultCommit: newResult,
    integrations: [{ commit: applied.integrationCommit, parent: devBefore, order: 1 }],
    squashTransfer: applied,
  };
  const projectorGit = (args) => git(root, ...args);
  const projections = await releaseTaskNetProjections({
    tasks: [releaseTask], baseCommit: await git(root, "rev-parse", "main"), git: projectorGit,
  });
  assert.equal(projections.get(SURVIVOR_ID)?.squashTransferHash, applied.transferHash);
  assert.equal(projections.get(SURVIVOR_ID)?.directResultMerge, true);
  const prospectiveAwaitTask = {
    taskId: SURVIVOR_ID,
    taskNumber: "HUB-235",
    taskRevision: applied.survivor.releaseRevision + 2,
    resultReleaseRevision: applied.survivor.releaseRevision + 1,
    projectRoot: root,
    branch: survivorWorkspace.branch,
    resultCommit: newResult,
    squashTransfer: applied,
  };
  const prospectiveEvidence = await service.releaseIntegrationEvidence({
    projectRoot: root, tasks: [prospectiveAwaitTask],
  });
  assert.equal(prospectiveEvidence.tasks[0].taskRevision, prospectiveAwaitTask.taskRevision);
  assert.equal(prospectiveEvidence.tasks[0].resultCommit, newResult);
  assert.equal(prospectiveEvidence.tasks[0].resultReleaseRevision,
    prospectiveAwaitTask.resultReleaseRevision);
  assert.deepEqual(prospectiveEvidence.tasks[0].squashTransfer, applied);
  await assert.rejects(service.releaseIntegrationEvidence({
    projectRoot: root,
    tasks: [{ ...prospectiveAwaitTask, resultReleaseRevision: prospectiveAwaitTask.taskRevision }],
  }), /squash transfer does not match its frozen result/u);
  await assert.rejects(service.releaseIntegrationEvidence({
    projectRoot: root,
    tasks: [{ ...prospectiveAwaitTask, resultCommit: baseline }],
  }), /changed|does not match/u);
  const ordinaryFallback = await releaseTaskNetProjections({
    tasks: [{ ...releaseTask, baseCommit: "9".repeat(40), squashTransfer: undefined }],
    baseCommit: await git(root, "rev-parse", "main"), git: projectorGit,
  });
  assert.equal(ordinaryFallback.size, 0);

  const assertNoAcceptedCheckpoint = async (dataDir) => {
    const names = await readdir(dataDir, { recursive: true }).catch((error) => {
      if (error?.code === "ENOENT") return [];
      throw error;
    });
    assert.equal(names.some((name) => path.basename(String(name)) === "checkpoint.json"), false);
    for (const name of names.filter((item) => path.basename(String(item)) === "repository")) {
      const releaseRoot = path.join(dataDir, String(name));
      const accepted = await git(releaseRoot, "rev-parse", "--verify", "refs/heads/PreRelease")
        .then(() => true, () => false);
      assert.equal(accepted, false);
    }
  };
  const damaged = structuredClone(applied);
  damaged.sourceWitnesses[0].source.object = "9".repeat(40);
  damaged.sourceWitnesses[0].survivor.object = "9".repeat(40);
  damaged.transferHash = undefined;
  await assert.rejects(new ReleaseGitWorkspaceService({
    dataDir: invalidWitnessReleaseDataDir,
  }).prepareCandidate({
    planRevision: "squash-invalid-witness",
    workspaceId: "workspace",
    projectRoot: root,
    approvedBaseCommit: await git(root, "rev-parse", "main"),
    frozenTasks: [{ ...releaseTask, squashTransfer: damaged, taskRevision: applied.survivor.releaseRevision + 1 }],
  }), /requires the exact squash projection/u);
  await assertNoAcceptedCheckpoint(invalidWitnessReleaseDataDir);

  await assert.rejects(new ReleaseGitWorkspaceService({
    dataDir: missingIntegrationReleaseDataDir,
  }).prepareCandidate({
    planRevision: "squash-missing-integration",
    workspaceId: "workspace",
    projectRoot: root,
    approvedBaseCommit: await git(root, "rev-parse", "main"),
    frozenTasks: [{ ...releaseTask, integrations: [], taskRevision: applied.survivor.releaseRevision + 1 }],
  }), /requires the exact squash projection/u);
  await assertNoAcceptedCheckpoint(missingIntegrationReleaseDataDir);

  const unavailable = structuredClone(applied);
  unavailable.source.baseCommit = "8".repeat(40);
  unavailable.transferHash = undefined;
  await assert.rejects(new ReleaseGitWorkspaceService({
    dataDir: unavailableProofReleaseDataDir,
  }).prepareCandidate({
    planRevision: "squash-unavailable-proof",
    workspaceId: "workspace",
    projectRoot: root,
    approvedBaseCommit: await git(root, "rev-parse", "main"),
    frozenTasks: [{ ...releaseTask, squashTransfer: unavailable, taskRevision: applied.survivor.releaseRevision + 1 }],
  }));
  await assertNoAcceptedCheckpoint(unavailableProofReleaseDataDir);

  const release = new ReleaseGitWorkspaceService({ dataDir: releaseDataDir });
  const prepared = await release.prepareCandidate({
    planRevision: "squash-direct-result",
    workspaceId: "workspace",
    projectRoot: root,
    approvedBaseCommit: await git(root, "rev-parse", "main"),
    frozenTasks: [{ ...releaseTask, taskRevision: applied.survivor.releaseRevision + 1 }],
  });
  assert.deepEqual(prepared.netProjectedTaskIds, [SURVIVOR_ID]);
  assert.equal(
    await git(prepared.releaseRoot, "rev-parse", `${prepared.preReleaseHead}^{tree}`),
    await git(root, "rev-parse", `${newResult}^{tree}`),
  );
  assert.equal(await git(prepared.releaseRoot, "show", `${prepared.preReleaseHead}:source.txt`), "source-result");
  const checkpointFile = (await readdir(releaseDataDir, { recursive: true }))
    .map((name) => path.join(releaseDataDir, name))
    .find((name) => path.basename(name) === "checkpoint.json");
  assert.ok(checkpointFile);
  const incompleteCheckpoint = JSON.parse(await readFile(checkpointFile, "utf8"));
  incompleteCheckpoint.netProjectedTaskIds = [];
  await writeFile(checkpointFile, `${JSON.stringify(incompleteCheckpoint, null, 2)}\n`);
  const rebuilt = await release.prepareCandidate({
    planRevision: "squash-direct-result",
    workspaceId: "workspace",
    projectRoot: root,
    approvedBaseCommit: await git(root, "rev-parse", "main"),
    frozenTasks: [{ ...releaseTask, taskRevision: applied.survivor.releaseRevision + 1 }],
  });
  assert.equal(rebuilt.reused, false);
  assert.deepEqual(rebuilt.netProjectedTaskIds, [SURVIVOR_ID]);
  const laterRoot = `${root}-later`;
  context.after(() => rm(laterRoot, { recursive: true, force: true }));
  await git(root, "worktree", "add", "-b", "later-selected", laterRoot, newResult);
  await writeFile(path.join(laterRoot, "unique.txt"), "later-selected-edit\n");
  const laterResult = await commit(laterRoot, "later selected edit");
  const beforeLaterIntegration = await git(dev.projectRoot, "rev-parse", "HEAD");
  await git(dev.projectRoot, "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
    "merge", "--no-ff", laterResult, "-m", "integrate later selected edit");
  const laterIntegration = await git(dev.projectRoot, "rev-parse", "HEAD");
  const ordered = await releaseTaskNetProjections({
    tasks: [releaseTask, {
      taskId: "33333333-3333-4333-8333-333333333333",
      baseCommit: newResult,
      resultCommit: laterResult,
      integrations: [{ commit: laterIntegration, parent: beforeLaterIntegration, order: 2 }],
    }],
    baseCommit: await git(root, "rev-parse", "main"),
    git: projectorGit,
  });
  assert.equal(ordered.get(SURVIVOR_ID)?.squashTransferHash, applied.transferHash);
  await assert.rejects(releaseTaskNetProjections({
    tasks: [{ ...releaseTask, squashTransfer: damaged }],
    baseCommit: await git(root, "rev-parse", "main"), git: projectorGit,
  }), /requires the exact squash projection/u);

  // A later ordinary result can contain adopted dev context. Release only the
  // immutable clean squash plus the subsequent exact integration deltas.
  await git(survivorWorkspace.projectRoot, "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
    "merge", "--no-ff", laterIntegration, "-m", "adopt dev context after squash");
  await writeFile(path.join(survivorWorkspace.projectRoot, "first-followup.txt"), "first owned fix\n");
  const firstDescendant = await commit(survivorWorkspace.projectRoot, "first ordinary follow-up");
  await git(dev.projectRoot, "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
    "merge", "--no-ff", firstDescendant, "-m", "Test first descendant");
  const firstDescendantIntegration = await git(dev.projectRoot, "rev-parse", "HEAD");
  await writeFile(path.join(survivorWorkspace.projectRoot, "followup.txt"), "SQL fix\n");
  const descendant = await commit(survivorWorkspace.projectRoot, "ordinary survivor follow-up");
  const beforeDescendant = await git(dev.projectRoot, "rev-parse", "HEAD");
  await git(dev.projectRoot, "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
    "merge", "--no-ff", descendant, "-m", "Test descendant");
  const descendantIntegration = await git(dev.projectRoot, "rev-parse", "HEAD");
  const descendantEvidence = await service.releaseIntegrationEvidence({
    projectRoot: root, tasks: [{ ...prospectiveAwaitTask, resultCommit: descendant }],
  });
  const descendantTask = descendantEvidence.tasks[0];
  assert.deepEqual(descendantTask.squashTransfer, applied);
  const descendantProjection = (await releaseTaskNetProjections({
    tasks: [descendantTask], baseCommit: await git(root, "rev-parse", "main"), git: projectorGit,
  })).get(SURVIVOR_ID);
  assert.equal(descendantProjection.commit, newResult);
  assert.deepEqual(descendantProjection.subsequentIntegrations.map((entry) => entry.commit), [firstDescendantIntegration, descendantIntegration]);
  const descendantPrepared = await release.prepareCandidate({
    planRevision: "squash-descendant", workspaceId: "workspace", projectRoot: root,
    approvedBaseCommit: await git(root, "rev-parse", "main"), frozenTasks: [descendantTask],
  });
  assert.equal(await git(descendantPrepared.releaseRoot, "show", `${descendantPrepared.preReleaseHead}:source.txt`), "source-result");
  assert.equal(await git(descendantPrepared.releaseRoot, "show", `${descendantPrepared.preReleaseHead}:followup.txt`), "SQL fix");
  assert.equal(await git(descendantPrepared.releaseRoot, "show", `${descendantPrepared.preReleaseHead}:first-followup.txt`), "first owned fix");
  assert.equal(await git(descendantPrepared.releaseRoot, "show", `${descendantPrepared.preReleaseHead}:unique.txt`), "new-survivor-effect");
  for (const name of ["foreign.txt", "excluded.txt"]) {
    await assert.rejects(git(descendantPrepared.releaseRoot, "show", `${descendantPrepared.preReleaseHead}:${name}`));
    assert.ok(await readFile(path.join(survivorWorkspace.projectRoot, name), "utf8"));
  }
  const latestDelta = descendantTask.integrations.find((entry) => entry.commit === descendantIntegration);
  await assert.rejects(releaseTaskNetProjections({
    tasks: [{ ...descendantTask, integrations: descendantTask.integrations.filter((entry) => entry.commit !== firstDescendantIntegration) }],
    baseCommit: await git(root, "rev-parse", "main"), git: projectorGit,
  }), /omits an owned integration/u);
  await assert.rejects(releaseTaskNetProjections({
    tasks: [{ ...descendantTask, integrations: descendantTask.integrations.filter((entry) => entry !== latestDelta) }],
    baseCommit: await git(root, "rev-parse", "main"), git: projectorGit,
  }), /latest squash descendant is not covered/u);
  await assert.rejects(releaseTaskNetProjections({
    tasks: [descendantTask, { ...descendantTask, taskId: "foreign-owner", squashTransfer: undefined, integrations: [latestDelta] }],
    baseCommit: await git(root, "rev-parse", "main"), git: projectorGit,
  }), /uniquely owned integration/u);
  const undeclared = await git(root, "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
    "commit-tree", `${newResult}^{tree}`, "-p", beforeDescendant, "-p", descendant, "-m", "unproved integration tree");
  await assert.rejects(releaseTaskNetProjections({
    tasks: [{ ...descendantTask, integrations: descendantTask.integrations.map((entry) => (
      entry === latestDelta ? { ...entry, commit: undeclared } : entry
    )) }], baseCommit: await git(root, "rev-parse", "main"), git: projectorGit,
  }), /exact automatic uniquely owned integration/u);

  // Selected overlapping work remains at its original integration position;
  // the descendant must neither import nor swallow the other Task's update.
  const orderedPrepared = await release.prepareCandidate({
    planRevision: "squash-descendant-selected-overlap", workspaceId: "workspace", projectRoot: root,
    approvedBaseCommit: await git(root, "rev-parse", "main"),
    frozenTasks: [descendantTask, {
      taskId: "33333333-3333-4333-8333-333333333333", taskRevision: 1,
      baseCommit: newResult, resultCommit: laterResult,
      integrations: [{ commit: laterIntegration, parent: beforeLaterIntegration, order: latestDelta.order - 2 }],
    }],
  });
  assert.equal(await git(orderedPrepared.releaseRoot, "show", `${orderedPrepared.preReleaseHead}:unique.txt`), "later-selected-edit");
  assert.equal(await git(orderedPrepared.releaseRoot, "show", `${orderedPrepared.preReleaseHead}:followup.txt`), "SQL fix");
  const partialBaseProjection = (await releaseTaskNetProjections({
    tasks: [descendantTask], baseCommit: firstDescendant, git: projectorGit,
  })).get(SURVIVOR_ID);
  assert.deepEqual(partialBaseProjection.subsequentIntegrations.map((entry) => entry.commit), [descendantIntegration]);
  const partialBasePrepared = await release.prepareCandidate({
    planRevision: "squash-partially-published-descendant", workspaceId: "workspace", projectRoot: root,
    approvedBaseCommit: firstDescendant, frozenTasks: [descendantTask],
  });
  assert.equal(await git(partialBasePrepared.releaseRoot, "show", `${partialBasePrepared.preReleaseHead}:first-followup.txt`), "first owned fix");
  assert.equal(await git(partialBasePrepared.releaseRoot, "show", `${partialBasePrepared.preReleaseHead}:followup.txt`), "SQL fix");
  await git(root, "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
    "merge", "--no-ff", newResult, "-m", "publish clean survivor");
  await git(root, "push", "origin", "main");
  const published = await git(root, "rev-parse", "main");
  publication = {
    generation: "publication-1", revision: published,
    repositories: [{ root, revision: published }],
  };
  const alreadyPublished = await new ReleaseGitWorkspaceService({
    dataDir: publishedReleaseDataDir,
  }).prepareCandidate({
    planRevision: "squash-already-published",
    workspaceId: "workspace",
    projectRoot: root,
    approvedBaseCommit: published,
    frozenTasks: [{ ...releaseTask, squashTransfer: damaged, taskRevision: applied.survivor.releaseRevision + 1 }],
  });
  assert.deepEqual(alreadyPublished.netProjectedTaskIds, []);
  assert.equal(alreadyPublished.preReleaseHead, published);
  assert.equal(await git(alreadyPublished.releaseRoot, "show", `${published}:source.txt`), "source-result");
  await service.withTaskLock(SOURCE_ID, async (lease) => {
    const cleanup = await service.cleanupPreview(SOURCE_ID, {
      gitReferences: source.gitReferences,
      squashAbsorbedBy: applied,
    });
    assert.equal(cleanup.unpublished.length, 0);
    assert.equal(cleanup.gitReferences[0].publishedBySquashTransfer, applied.transferHash);
    await service.cleanupOwned(SOURCE_ID, {
      requirePublished: true,
      gitReferences: source.gitReferences,
      squashAbsorbedBy: applied,
      expectedPreview: cleanup,
      lease,
    });
  });
  assert.equal(await git(root, "for-each-ref", "--format=%(refname)", `refs/heads/${sourceWorkspace.branch}`), "");
});

test("Git-applied squash reconciles its real SQLite transition without an invented process guard", { timeout: 90_000 }, async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-squash-reconcile-"));
  const dataDir = `${root}-data`;
  const databaseFile = path.join(dataDir, "tasks.sqlite");
  context.after(async () => {
    store.close();
    catalog.close();
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(dataDir, { recursive: true, force: true }),
    ]);
  });
  await git(root, "init", "-b", "main");
  await git(root, "config", "core.autocrlf", "false");
  await writeFile(path.join(root, "app.txt"), "main\n");
  await commit(root, "main");
  const publishedRevision = await git(root, "rev-parse", "main");
  const catalog = new WorkspaceCatalogStore({ databaseFile });
  await catalog.load();
  const workspace = await catalog.runMutation(() => catalog.createWorkspace({
    name: "Workspace", settings: { releaseWorkflowEnabled: true, workingDirectory: root },
  }));
  const stream = await catalog.runMutation(() => catalog.createStream({
    workspaceId: workspace.id, name: "Release Manager",
    settings: { releaseManager: true, workingDirectory: root },
  }));
  const receipt = {
    requestId: "squash-confirm", workspaceId: workspace.id, toolName: "hub_task_status_update",
    status: "unknown", operationStatus: "pending", receiptState: "unknown",
  };
  const workspaceCatalog = {
    hierarchy: () => catalog.hierarchy(),
    workspace: (id) => catalog.workspace(id),
    stream: (id) => catalog.stream(id),
    mcpOperation: (id) => id === receipt.requestId ? receipt : null,
    completeUnknownMcpOperation: (id, { result }) => {
      assert.equal(id, receipt.requestId);
      Object.assign(receipt, {
        status: "succeeded", operationStatus: "succeeded", receiptState: "succeeded", result,
      });
      return receipt;
    },
    failUnknownMcpOperation: () => { throw new Error("unexpected failed reconciliation"); },
  };
  const store = new TaskBoardStore({ databaseFile });
  const taskBoard = new TaskBoardService({ store, workspaceCatalog, logger: { error() {}, warn() {} } });
  const gitService = new TaskGitWorkspaceService({ dataDir: path.join(dataDir, "git") });
  let sourceCreated = store.create({ text: "Source", bucket: "workspace", workspaceId: workspace.id });
  let survivorCreated = store.create({ text: "Survivor", bucket: "workspace", workspaceId: workspace.id });
  sourceCreated = store.claim(sourceCreated.id, {
    workspaceId: workspace.id, streamId: stream.id, provider: "codex", threadId: "source-thread",
    turnId: "source-turn", operationId: "source-claim",
  });
  survivorCreated = store.claim(survivorCreated.id, {
    workspaceId: workspace.id, streamId: stream.id, provider: "codex", threadId: "survivor-thread",
    turnId: "survivor-turn", operationId: "survivor-claim",
  });
  const sourceWorkspace = await gitService.prepare({
    taskId: sourceCreated.id, taskNumber: sourceCreated.taskNumber, projectRoot: root,
  });
  await writeFile(path.join(sourceWorkspace.projectRoot, "source.txt"), "source\n");
  const sourceGit = await gitService.snapshotAndMerge({
    taskId: sourceCreated.id, taskNumber: sourceCreated.taskNumber, projectRoot: sourceWorkspace.projectRoot,
  });
  store.beginLifecycleTransition(sourceCreated.id, {
    operationId: "source-test", kind: "workflow", targetWorkflowStatus: "testing",
    expectedRevision: sourceCreated.revision,
  });
  const source = store.commitWorkflowTransition({
    operationId: "source-test",
    gitReferences: [{
      projectRoot: root, branch: sourceWorkspace.branch, resultCommit: sourceGit.snapshot.headCommit,
    }],
  });
  const survivorWorkspace = await gitService.prepare({
    taskId: survivorCreated.id, taskNumber: survivorCreated.taskNumber, projectRoot: root,
  });
  await writeFile(path.join(survivorWorkspace.projectRoot, "baseline.txt"), "baseline\n");
  const survivorGit = await gitService.snapshotAndMerge({
    taskId: survivorCreated.id, taskNumber: survivorCreated.taskNumber, projectRoot: survivorWorkspace.projectRoot,
  });
  store.beginLifecycleTransition(survivorCreated.id, {
    operationId: "survivor-test", kind: "workflow", targetWorkflowStatus: "testing",
    expectedRevision: survivorCreated.revision,
  });
  const survivor = store.commitWorkflowTransition({
    operationId: "survivor-test",
    gitReferences: [{
      projectRoot: root, branch: survivorWorkspace.branch, resultCommit: survivorGit.snapshot.headCommit,
    }],
  });
  const baselineResultCommit = survivorGit.snapshot.headCommit;
  await writeFile(path.join(survivorWorkspace.projectRoot, "source.txt"), "source\n");
  await writeFile(path.join(survivorWorkspace.projectRoot, "unique.txt"), "combined\n");
  const newResultCommit = await commit(survivorWorkspace.projectRoot, "combined result");
  const dev = await gitService.prepareDev(root);
  const devBefore = await git(dev.projectRoot, "rev-parse", "HEAD");
  await writeFile(path.join(dev.projectRoot, "unique.txt"), "combined\n");
  await git(dev.projectRoot, "add", "unique.txt");
  const devAfterTree = await git(dev.projectRoot, "write-tree");
  await git(dev.projectRoot, "reset", "--hard", devBefore);
  const squashReleasePreflight = { withAwaitTransition: async (_id, operation) => operation() };
  const lifecycle = new TaskLifecycleService({
    taskBoard, workspaceCatalog, taskGitWorkspaces: gitService, releasePreflight: squashReleasePreflight,
  });
  const authority = {
    workspaceId: workspace.id, streamId: stream.id, provider: "codex",
    threadId: "thread", proofRequestId: "squash-preview",
  };
  const common = {
    taskId: survivor.id, sourceTaskId: source.id,
    expectedTaskRevision: survivor.revision, expectedSourceTaskRevision: source.revision,
    baselineResultCommit, newResultCommit, devAfterTree, authority, projectRoot: root,
  };
  const preview = await lifecycle.squashTransfer({ ...common, operationId: "squash-preview" });
  const originalCommit = taskBoard.commitSquashTransferTransition.bind(taskBoard);
  let rejectCommit = true;
  taskBoard.commitSquashTransferTransition = (payload) => {
    if (rejectCommit) {
      rejectCommit = false;
      throw new Error("simulated SQLite reply failure after Git effect");
    }
    return originalCommit(payload);
  };
  await assert.rejects(lifecycle.squashTransfer({
    ...common, operationId: receipt.requestId, expectedTransferHash: preview.transferHash,
  }), /durable outcome is unknown/u);
  const squashArguments = {
    expected_task_revision: survivor.revision,
    squash_source_task_id: source.id,
    squash_source_task_revision: source.revision,
    squash_baseline_result_commit: baselineResultCommit,
    squash_new_result_commit: newResultCommit,
    squash_dev_after_tree: devAfterTree,
    squash_proof_request_id: authority.proofRequestId,
    expected_squash_transfer_hash: preview.transferHash,
  };
  receipt.argumentsHash = argumentsHash({
    request_id: receipt.requestId, task_id: survivor.id, status: "testing", ...squashArguments,
  });
  const reconciliation = new TaskOperationReconciliationService({
    workspaceCatalog, taskBoard, taskLifecycle: lifecycle,
  });
  const reconcileInput = {
    workspaceId: workspace.id,
    taskId: survivor.id,
    operationRequestId: receipt.requestId,
    projectRoot: root,
    expectedTaskRevision: survivor.revision,
    squashSourceTaskId: source.id,
    squashSourceTaskRevision: source.revision,
    squashBaselineResultCommit: baselineResultCommit,
    squashNewResultCommit: newResultCommit,
    squashDevAfterTree: devAfterTree,
    squashProofRequestId: authority.proofRequestId,
    expectedSquashTransferHash: preview.transferHash,
    confirmed: true,
  };
  let unresolvedGuard;
  await gitService.withTaskRecoveryLock(survivor.id, async (lease) => {
    unresolvedGuard = await lease.beginProcessTreeGuard({
      args: ["git", "read-tree"], cwd: root, scope: "repository",
    });
    unresolvedGuard.markUnresolved(new Error("simulated unproven child completion"));
  });
  const blocked = await reconciliation.reconcileUnknownWorkflow(reconcileInput);
  assert.equal(blocked.outcome, "unknown");
  assert.match(blocked.error, /process-tree guard/u);
  assert.equal(taskBoard.task(source.id).workflowStatus, "testing");
  await unresolvedGuard.clear({ proof: "disposable test cleanup" });
  const resolved = await reconciliation.reconcileUnknownWorkflow(reconcileInput);
  assert.equal(resolved.outcome, "succeeded");
  assert.equal(receipt.receiptState, "succeeded");
  assert.equal(taskBoard.task(source.id).workflowStatus, "in_progress");
  assert.equal(taskBoard.task(survivor.id).gitReferences[0].resultCommit, newResultCommit);
  assert.equal(await readFile(path.join(dev.projectRoot, "unique.txt"), "utf8"), "combined\n");

  const releasePlanner = new TaskReleasePlanService({ taskBoard, taskGitWorkspaces: gitService });
  let candidateBuilds = 0;
  const releasePreflight = new WorkspaceReleasePreflightService({
    releasePlanner,
    taskGitWorkspaces: gitService,
    releaseGitWorkspaces: {
      withAwaitTransition: async (_workspaceId, operation) => operation(),
      assertAwaitChangesAllowed: async () => {},
      assertPrimaryInvariant: async () => ({ projectRoot: root, headCommit: await git(root, "rev-parse", "main") }),
      inspectMainChanges: async () => ({}),
      prepareCandidate: async (request) => {
        candidateBuilds += 1;
        const prepared = {
          repositoryRoot: request.projectRoot,
          preReleaseHead: request.frozenTasks.at(-1).resultCommit,
          frozenTasks: request.frozenTasks,
        };
        if (request.commitPrepared) await request.commitPrepared(prepared);
        return prepared;
      },
    },
    resolveReleaseValidationSource: async () => null,
    readPublicationState: async () => ({ repositories: [{ root, revision: publishedRevision }] }),
  });
  const current = taskBoard.task(survivor.id);
  assert.equal(current.resultReleaseRevision, current.releaseRevision);
  const outcomeDatabase = new DatabaseSync(databaseFile);
  const exactOutcome = outcomeDatabase.prepare(
    "SELECT result_json FROM hub_task_lifecycle_outcomes WHERE operation_id = ?",
  ).get(receipt.requestId).result_json;
  const uncorroboratedOutcomes = [
    ["missing outcome Task", (result) => { delete result.task; }],
    ["stale outcome revision", (result) => { result.task.releaseRevision += 1; }],
    ["foreign outcome reference", (result) => { result.task.gitReferences[0].projectRoot = `${root}-foreign`; }],
  ];
  for (const [label, corrupt] of uncorroboratedOutcomes) {
    const result = JSON.parse(exactOutcome);
    corrupt(result);
    outcomeDatabase.prepare(
      "UPDATE hub_task_lifecycle_outcomes SET result_json = ? WHERE operation_id = ?",
    ).run(JSON.stringify(result), receipt.requestId);
    const projected = taskBoard.task(survivor.id);
    assert.equal(projected.squashTransfer.survivor.taskId, survivor.id, label);
    assert.equal(projected.resultReleaseRevision, undefined, label);
    await assert.rejects(releasePreflight.validateAwaitAcceptance({
      workspaceId: workspace.id,
      acceptingTask: { id: projected.id, revision: projected.revision },
      projectRoot: root,
    }), /squash transfer does not match its frozen result/u, label);
  }
  outcomeDatabase.prepare(
    "UPDATE hub_task_lifecycle_outcomes SET result_json = ? WHERE operation_id = ?",
  ).run(exactOutcome, receipt.requestId);
  outcomeDatabase.close();
  const originalReleaseTasks = taskBoard.releaseTasks.bind(taskBoard);
  const tamperedProof = normalizedTaskSquashTransfer({
    ...current.squashTransfer,
    transferHash: undefined,
    survivor: {
      ...current.squashTransfer.survivor,
      releaseRevision: current.squashTransfer.survivor.releaseRevision + 1,
    },
  });
  taskBoard.releaseTasks = (workspaceId) => originalReleaseTasks(workspaceId).map((entry) => (
    entry.id === current.id ? { ...entry, squashTransfer: tamperedProof } : entry
  ));
  await assert.rejects(releasePreflight.validateAwaitAcceptance({
    workspaceId: workspace.id,
    acceptingTask: { id: current.id, revision: current.revision },
    projectRoot: root,
  }), /squash transfer does not match its frozen result/u);
  taskBoard.releaseTasks = originalReleaseTasks;

  const planBefore = await releasePlanner.plan(workspace.id);
  const acceptanceLifecycle = new TaskLifecycleService({
    taskBoard, workspaceCatalog, taskGitWorkspaces: gitService, releasePreflight,
  });
  await writeFile(path.join(survivorWorkspace.projectRoot, "after-squash.txt"), "ordinary Test child\n");
  const childTest = await acceptanceLifecycle.updateWorkflowStatus({
    taskId: current.id, status: "testing", operationId: "survivor-child-test",
    projectRoot: root, expectedRevision: current.revision, expectedWorkflowStatus: "testing",
  });
  const testedChild = taskBoard.task(current.id);
  assert.equal(childTest.task.workflowStatus, "testing");
  assert.equal(testedChild.releaseRevision, current.releaseRevision);
  assert.equal(testedChild.resultReleaseRevision, current.resultReleaseRevision);
  assert.deepEqual(testedChild.squashTransfer, current.squashTransfer);
  assert.notEqual(testedChild.gitReferences[0].resultCommit, newResultCommit);
  const accepted = await acceptanceLifecycle.updateWorkflowStatus({
    taskId: current.id,
    status: "awaiting_implementation",
    operationId: "survivor-await",
    projectRoot: root,
    expectedRevision: testedChild.revision,
    expectedWorkflowStatus: "testing",
  });
  const planAfter = await releasePlanner.plan(workspace.id);
  assert.equal(accepted.task.workflowStatus, "awaiting_implementation");
  assert.ok(accepted.task.releaseRevision > testedChild.releaseRevision);
  assert.equal(accepted.task.resultReleaseRevision, current.resultReleaseRevision);
  assert.equal(accepted.releaseIntegration.resultCommit, testedChild.gitReferences[0].resultCommit);
  assert.equal(accepted.releaseCandidate.status, "ready");
  assert.notEqual(planAfter.revision, planBefore.revision);
  assert.equal(accepted.releaseCandidate.planRevision, planAfter.revision);
  assert.deepEqual(accepted.releaseCandidate.taskIds, [current.id]);
  assert.equal(accepted.releaseCandidate.releaseCandidates.length, 1);
  assert.equal(
    accepted.releaseCandidate.releaseCandidates[0].preReleaseHead,
    testedChild.gitReferences[0].resultCommit,
  );
  assert.equal(candidateBuilds, 1);
});
