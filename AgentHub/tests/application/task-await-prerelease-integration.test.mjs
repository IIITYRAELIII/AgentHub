import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { TaskBoardService } from "../../src/application/task-board-service.mjs";
import { TaskLifecycleService } from "../../src/application/task-lifecycle-service.mjs";
import { TaskReleasePlanService } from "../../src/application/task-release-plan-service.mjs";
import { WorkspaceReleasePreflightService } from "../../src/application/workspace-release-preflight-service.mjs";
import { TaskBoardStore } from "../../src/infrastructure/persistence/task-board-store.mjs";
import { WorkspaceCatalogStore } from "../../src/infrastructure/persistence/workspace-catalog-store.mjs";
import { TaskGitWorkspaceService } from "../../src/infrastructure/filesystem/task-git-workspace.mjs";
import { ReleaseGitWorkspaceService } from "../../src/infrastructure/filesystem/release-git-workspace.mjs";

const exec = promisify(execFile);
async function git(cwd, ...args) {
  return String((await exec("git", args, { cwd, windowsHide: true })).stdout).trim();
}
async function commit(cwd, message) {
  await git(cwd, "add", "--all");
  await git(cwd, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", message);
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "hub-await-integration-"));
  const primary = path.join(root, "primary");
  const origin = path.join(root, "origin.git");
  const dataDir = path.join(root, "data");
  await mkdir(primary);
  await git(root, "init", "--bare", "--initial-branch=main", origin);
  await git(primary, "init", "--initial-branch=main");
  await git(primary, "config", "core.autocrlf", "false");
  await writeFile(path.join(primary, ".gitattributes"), "* text eol=lf\n");
  await writeFile(path.join(primary, "app.txt"), "main\n");
  await mkdir(path.join(primary, "AgentHub"));
  const packageMetadata = { name: "agent-hub", version: "2026.9.15" };
  await writeFile(path.join(primary, "AgentHub", "package.json"), JSON.stringify(packageMetadata));
  await writeFile(path.join(primary, "AgentHub", "package-lock.json"), JSON.stringify({
    ...packageMetadata, packages: { "": packageMetadata },
  }));
  await commit(primary, "main");
  const publication = { repositories: [{ root: primary, revision: await git(primary, "rev-parse", "HEAD") }] };
  await git(primary, "remote", "add", "origin", origin);
  await git(primary, "push", "-u", "origin", "main");
  const databaseFile = path.join(root, "tasks.sqlite");
  const catalogStore = new WorkspaceCatalogStore({ databaseFile });
  await catalogStore.load();
  const store = new TaskBoardStore({ databaseFile });
  t.after(async () => { store.close(); catalogStore.close(); await rm(root, { recursive: true, force: true }); });
  const workspace = await catalogStore.runMutation(() => catalogStore.createWorkspace({ name: "Workspace", settings: {
    workingDirectory: primary, releaseWorkflowEnabled: true,
  } }));
  const workspaceCatalog = {
    hierarchy: () => [workspace], workspace: () => workspace, stream: () => null,
  };
  const taskBoard = new TaskBoardService({ store, workspaceCatalog });
  const taskGitWorkspaces = new TaskGitWorkspaceService({ dataDir });
  const releaseGitWorkspaces = new ReleaseGitWorkspaceService({ dataDir });
  const releasePlanner = new TaskReleasePlanService({ taskBoard, taskGitWorkspaces });
  const forbidden = () => assert.fail("Await must not start publication, production validation or the test contour");
  const releasePreflight = new WorkspaceReleasePreflightService({
    releasePlanner, taskGitWorkspaces, releaseGitWorkspaces,
    resolveReleaseValidationSource: forbidden, refreshTestContour: forbidden,
    readTestContourStatus: forbidden, validateProductionCandidate: forbidden,
    readPublicationState: async () => publication,
  });
  const lifecycle = new TaskLifecycleService({ taskBoard, workspaceCatalog, taskGitWorkspaces, releasePreflight });
  async function testedTask(name, file, content) {
    const task = store.create({ text: name, bucket: "workspace", workspaceId: workspace.id });
    const prepared = await taskGitWorkspaces.prepare({ taskId: task.id, taskNumber: task.taskNumber, projectRoot: primary });
    await writeFile(path.join(prepared.projectRoot, file), content);
    const result = await lifecycle.updateWorkflowStatus({ taskId: task.id, status: "testing", operationId: `test-${task.id}` });
    assert.equal(result.task.workflowStatus, "testing");
    return task;
  }
  return { root, primary, origin, store, taskBoard, taskGitWorkspaces, releaseGitWorkspaces, releasePlanner, releasePreflight, lifecycle, testedTask, workspace, publication };
}

// A successful Await already carries its prepared candidate: the accepted
// result is composed into PreRelease before the lifecycle CAS.
async function acceptAndPrepare(fixture, task, operationId) {
  const response = await fixture.lifecycle.updateWorkflowStatus({
    taskId: task.id, status: "awaiting_implementation", operationId,
  });
  assert.equal(response.releaseCandidate.status, "ready", JSON.stringify(response.releaseCandidate));
  const prepared = response.releaseCandidate;
  assert.ok(prepared.releaseCandidates?.length, JSON.stringify(prepared));
  return { response, prepared, candidate: prepared.releaseCandidates[0] };
}

test("editorial Task changes reuse prepared and frozen candidate identities", { timeout: 90000 }, async (t) => {
  const f = await fixture(t);
  const task = await f.testedTask("Accepted", "accepted.txt", "accepted\n");
  const { candidate } = await acceptAndPrepare(f, task, "accept-editorial");
  const plan = await f.releasePlanner.plan(f.workspace.id);
  f.store.updatePresentation(task.id, { title: "Clarified accepted Task", description: "More detail" });
  await f.store.updateChecklist({ id: task.id, operation: "add", text: "Checked",
    expectedRevision: f.store.task(task.id).revision, requestId: "editorial-checklist" });
  const retry = await f.releasePreflight.prepareAwaitSet({ workspaceId: f.workspace.id });
  assert.equal(retry.planRevision, plan.revision);
  assert.equal(retry.releaseCandidates[0].reused, true);
  assert.equal(retry.releaseCandidates[0].preReleaseHead, candidate.preReleaseHead);
  assert.equal(retry.releaseCandidates[0].manifestHash, candidate.manifestHash);
  await writeFile(path.join(candidate.releaseRoot, "CHANGELOG.md"), "release\n");
  const frozen = await f.releaseGitWorkspaces.freezePublicationCandidate({
    projectRoot: f.primary, workspaceId: f.workspace.id, expectedPlanRevision: plan.revision,
    expectedPreparedHead: candidate.preReleaseHead, changelogContent: Buffer.from("release\n") });
  f.store.updatePresentation(task.id, { title: "Edited during frozen release" });
  assert.equal((await f.releasePlanner.plan(f.workspace.id)).revision, plan.revision);
  const readback = await f.releaseGitWorkspaces.frozenCandidate(f.primary);
  assert.equal(readback.preReleaseHead, frozen.preReleaseHead);
  assert.equal(readback.manifestHash, frozen.manifestHash);
  f.store.completeRelease(f.workspace.id, { expectedPlanRevision: plan.revision, plan,
    verificationEvidence: { publishedRevision: frozen.preReleaseHead },
    awaitRebuild: { planRevision: plan.revision, fallbackProjectRoots: [f.primary] } });
  assert.equal(f.store.task(task.id).workflowStatus, "done");
});

test("Await requests stay in Test throughout freeze and unfinished finalization", { timeout: 90000 }, async (t) => {
  const f = await fixture(t);
  const accepted = await f.testedTask("Release", "release.txt", "release\n");
  const { response, prepared, candidate } = await acceptAndPrepare(f, accepted, "accept-release");
  await writeFile(path.join(candidate.releaseRoot, "CHANGELOG.md"), "release\n");
  const frozen = await f.releaseGitWorkspaces.freezePublicationCandidate({
    projectRoot: f.primary, workspaceId: f.workspace.id,
    expectedPlanRevision: prepared.planRevision,
    expectedPreparedHead: candidate.preReleaseHead, changelogContent: Buffer.from("release\n"),
  });
  const next = await f.testedTask("Next", "next.txt", "next\n");
  const checkpointFile = path.join(path.dirname(candidate.releaseRoot), "checkpoint.json");
  const checkpointBefore = await readFile(checkpointFile, "utf8");
  for (const afterPush of [false, true]) {
    if (afterPush) await git(candidate.releaseRoot, "push", "origin", "main");
    await assert.rejects(f.lifecycle.updateWorkflowStatus({
      taskId: next.id, status: "awaiting_implementation", operationId: `accept-next-${afterPush}`,
    }), { code: "RELEASE_CANDIDATE_FROZEN" });
    await assert.rejects(f.lifecycle.updateWorkflowStatus({
      taskId: accepted.id, status: "in_progress", operationId: `return-frozen-${afterPush}`,
    }), { code: "RELEASE_CANDIDATE_FROZEN" });
    assert.equal(f.taskBoard.task(next.id).workflowStatus, "testing");
    assert.equal(f.taskBoard.task(accepted.id).workflowStatus, "awaiting_implementation");
    assert.equal(f.taskBoard.lifecycleTransition(`accept-next-${afterPush}`), null);
    assert.equal(await readFile(checkpointFile, "utf8"), checkpointBefore);
    assert.equal(await git(candidate.releaseRoot, "rev-parse", "PreRelease"), frozen.preReleaseHead);
  }
  const plan = await f.releasePlanner.plan(f.workspace.id);
  const repositories = [{ projectRoot: f.primary, publishedRevision: frozen.preReleaseHead }];
  await f.store.completeRelease(f.workspace.id, {
    expectedPlanRevision: plan.revision, plan,
    verificationEvidence: { publication: { repositories: [{ root: f.primary, revision: frozen.preReleaseHead }] } },
    awaitRebuild: { version: 2, planRevision: plan.revision, fallbackProjectRoots: [f.primary], repositories },
  });
  const primaryResult = await f.releaseGitWorkspaces.synchronizePublishedPrimary({
    projectRoot: f.primary, publishedRevision: frozen.preReleaseHead,
    planRevision: prepared.planRevision,
  });
  await assert.rejects(f.lifecycle.updateWorkflowStatus({
    taskId: next.id, status: "awaiting_implementation", operationId: "accept-during-finalization",
  }), { code: "RELEASE_CANDIDATE_FROZEN" });
  assert.equal(f.taskBoard.task(next.id).workflowStatus, "testing");
  const devResult = await f.taskGitWorkspaces.synchronizeMainIntoDev({
    projectRoot: f.primary, publishedRevision: frozen.preReleaseHead,
  });
  assert.equal(devResult.integrated, true);
  for (const [stage, result] of [["primary", primaryResult], ["dev", devResult], ["await", { status: "invalidated" }]]) {
    await f.store.recordReleaseFinalizationStage(f.workspace.id, {
      planRevision: plan.revision, projectRoot: f.primary, stage, receipt: { completed: true, result },
    });
  }
  await f.store.clearAwaitRebuildPending(f.workspace.id, plan.revision);
  f.publication.repositories[0].revision = frozen.preReleaseHead;
  const resumed = await f.lifecycle.updateWorkflowStatus({
    taskId: next.id, status: "awaiting_implementation", operationId: "accept-after-release",
  });
  assert.equal(resumed.task.workflowStatus, "awaiting_implementation");
  assert.equal(resumed.releaseCandidate.status, "ready", JSON.stringify(resumed.releaseCandidate));
  assert.ok(resumed.releaseCandidate.releaseCandidates.length > 0, JSON.stringify(resumed.releaseCandidate));
});

test("Await composes PreRelease before acceptance and a conflict keeps the Task in Test", { timeout: 90000 }, async (t) => {
  const { root, origin, taskBoard, taskGitWorkspaces, lifecycle, testedTask, primary } = await fixture(t);
  const unaccepted = await testedTask("Unaccepted", "unaccepted.txt", "not accepted\n");
  const accepted = await testedTask("Accepted", "accepted.txt", "accepted\n");
  const response = await lifecycle.updateWorkflowStatus({
    taskId: accepted.id, status: "awaiting_implementation", operationId: "accept-first",
  });
  assert.equal(response.task.workflowStatus, "awaiting_implementation");
  assert.equal(response.releaseCandidate.status, "ready", JSON.stringify(response.releaseCandidate));
  let prepared = response.releaseCandidate;
  assert.deepEqual(prepared.taskIds, [accepted.id]);
  let candidate = prepared.releaseCandidates[0];
  assert.equal(await git(candidate.releaseRoot, "show", `${candidate.preReleaseHead}:accepted.txt`), "accepted");
  await assert.rejects(git(candidate.releaseRoot, "show", `${candidate.preReleaseHead}:unaccepted.txt`));
  assert.equal(taskBoard.task(unaccepted.id).workflowStatus, "testing");
  const returned = await lifecycle.updateWorkflowStatus({
    taskId: accepted.id, status: "in_progress", operationId: "return-accepted",
  });
  assert.equal(returned.task.workflowStatus, "in_progress");
  assert.equal(returned.gitWithdrawal.outcome, "withdrawn");
  // The withdrawal owner recomposes the remaining accepted membership itself,
  // so the withdrawn result leaves PreRelease without a separate operation.
  assert.equal(returned.releaseCandidate.status, "ready", JSON.stringify(returned.releaseCandidate));
  assert.deepEqual(returned.releaseCandidate.taskIds, []);
  const emptied = returned.releaseCandidate.releaseCandidates[0];
  assert.deepEqual(emptied.frozenTasks, []);
  assert.equal(emptied.preReleaseHead, emptied.baseCommit);
  await assert.rejects(git(emptied.releaseRoot, "show", "PreRelease:accepted.txt"));
  prepared = await lifecycle.releasePreflight.prepareAwaitSet({ workspaceId: returned.task.workspaceId });
  assert.deepEqual(prepared.taskIds, []);
  const dev = await taskGitWorkspaces.prepareDev(primary);
  await assert.rejects(git(dev.projectRoot, "show", "HEAD:accepted.txt"));
  assert.equal(await git(dev.projectRoot, "show", "HEAD:unaccepted.txt"), "not accepted");
  await lifecycle.updateWorkflowStatus({ taskId: accepted.id, status: "testing", operationId: "test-returned" });
  const acceptedAgain = await lifecycle.updateWorkflowStatus({
    taskId: accepted.id, status: "awaiting_implementation", operationId: "accept-again",
  });
  assert.equal(acceptedAgain.releaseCandidate.status, "ready", JSON.stringify(acceptedAgain.releaseCandidate));
  prepared = acceptedAgain.releaseCandidate;
  candidate = prepared.releaseCandidates[0];
  assert.equal(await git(candidate.releaseRoot, "show", "PreRelease:accepted.txt"), "accepted");
  const checkpointFile = path.join(path.dirname(candidate.releaseRoot), "checkpoint.json");
  const checkpointBefore = await readFile(checkpointFile, "utf8");

  const conflicting = await testedTask("Accepted with conflict", "app.txt", "task change\n");
  const publisher = path.join(root, "publisher");
  await git(root, "clone", origin, publisher);
  await writeFile(path.join(publisher, "app.txt"), "external main change\n");
  await commit(publisher, "external main change");
  await git(publisher, "push", "origin", "main");
  // Simulate confirmed publication authority; observation alone is no longer
  // allowed to move the candidate base or introduce this conflict.
  const published = await git(publisher, "rev-parse", "HEAD");
  await git(primary, "fetch", "origin", "main");
  lifecycle.releasePreflight.readPublicationState = async () => ({ repositories: [{ root: primary, revision: published }] });
  // The composition conflict is detected before the lifecycle CAS, so the Task
  // never leaves Test and the last good candidate keeps its exact bytes.
  await assert.rejects(lifecycle.updateWorkflowStatus({
    taskId: conflicting.id, status: "awaiting_implementation", operationId: "accept-conflicting",
  }), /PreRelease delta .* failed.*app\.txt/u);
  assert.equal(taskBoard.task(conflicting.id).workflowStatus, "testing");
  assert.equal(await readFile(checkpointFile, "utf8"), checkpointBefore);
  assert.equal(await git(candidate.releaseRoot, "rev-parse", "PreRelease"), candidate.preReleaseHead);
  assert.equal(await git(candidate.releaseRoot, "status", "--porcelain=v1"), "");
  assert.equal(taskBoard.lifecycleOutcome("accept-conflicting"), null);
  // A known composition failure terminalizes the original request instead of
  // leaving it pending, so the same id keeps refusing.
  assert.equal(taskBoard.lifecycleTransition("accept-conflicting").phase, "failed");
  // The same request id keeps refusing instead of silently accepting later.
  await assert.rejects(lifecycle.updateWorkflowStatus({
    taskId: conflicting.id, status: "awaiting_implementation", operationId: "accept-conflicting",
  }), /PreRelease delta .* failed.*app\.txt/u);
  assert.equal(taskBoard.task(conflicting.id).workflowStatus, "testing");
});

test("Await and withdrawal retain the published base despite unreviewed origin movement", { timeout: 90000 }, async (t) => {
  const f = await fixture(t);
  const published = f.publication.repositories[0].revision;
  await f.testedTask("Unaccepted", "unaccepted.txt", "unaccepted\n");
  const first = await f.testedTask("First", "first.txt", "first\n");
  const second = await f.testedTask("Second", "second.txt", "second\n");
  const publisher = path.join(f.root, "publisher");
  await git(f.root, "clone", f.origin, publisher);
  await writeFile(path.join(publisher, "external.txt"), "unreviewed\n");
  await commit(publisher, "unreviewed external change");
  await git(publisher, "push", "origin", "main");
  const originHead = await git(publisher, "rev-parse", "HEAD");
  for (const task of [first, second]) {
    const { candidate } = await acceptAndPrepare(f, task, `accept-${task.id}`);
    assert.equal(candidate.baseCommit, published);
    assert.equal(await git(candidate.releaseRoot, "rev-parse", "refs/remotes/origin/main"), originHead);
    await assert.rejects(git(candidate.releaseRoot, "show", "PreRelease:external.txt"));
    await assert.rejects(git(candidate.releaseRoot, "show", "PreRelease:unaccepted.txt"));
  }
  const returned = await f.lifecycle.updateWorkflowStatus({
    taskId: first.id, status: "in_progress", operationId: "return-first-pinned-base",
  });
  assert.equal(returned.releaseCandidate.status, "ready", returned.releaseCandidate.reason);
  const candidate = returned.releaseCandidate.releaseCandidates[0];
  assert.equal(candidate.baseCommit, published);
  assert.equal(await git(candidate.releaseRoot, "show", "PreRelease:second.txt"), "second");
  for (const file of ["first.txt", "external.txt", "unaccepted.txt"]) {
    await assert.rejects(git(candidate.releaseRoot, "show", `PreRelease:${file}`));
  }
  assert.equal(await git(f.primary, "rev-parse", "main"), published);
  assert.equal(f.taskBoard.task(second.id).workflowStatus, "awaiting_implementation");
});

test("Await leaves PreRelease unchanged after SQLite rejection and rebuilds it after a lost committed reply", { timeout: 90000 }, async (t) => {
  const f = await fixture(t);
  const first = await f.testedTask("First", "first.txt", "first\n");
  const { candidate } = await acceptAndPrepare(f, first, "first");
  const checkpoint = path.join(path.dirname(candidate.releaseRoot), "checkpoint.json");
  const before = await readFile(checkpoint, "utf8");
  const next = await f.testedTask("Next", "next.txt", "next\n");
  const original = f.taskBoard.commitWorkflowTransition.bind(f.taskBoard);
  f.taskBoard.commitWorkflowTransition = () => { throw new Error("injected SQLite rejection"); };
  await assert.rejects(f.lifecycle.updateWorkflowStatus({ taskId: next.id, status: "awaiting_implementation", operationId: "rejected" }),
    { code: "TASK_AWAIT_INTEGRATION_FAILED" });
  assert.equal(f.taskBoard.task(next.id).workflowStatus, "testing");
  assert.equal(await readFile(checkpoint, "utf8"), before);
  assert.equal(await git(candidate.releaseRoot, "rev-parse", "PreRelease"), candidate.preReleaseHead);
  assert.equal(await git(candidate.releaseRoot, "symbolic-ref", "--short", "HEAD"), "PreRelease");
  f.taskBoard.commitWorkflowTransition = async (args) => {
    // The accepted result is already composed when the CAS runs.
    assert.equal(f.taskBoard.task(next.id).workflowStatus, "testing");
    assert.equal(await git(candidate.releaseRoot, "show", "PreRelease:next.txt"), "next");
    await original(args);
    throw new Error("injected lost SQLite reply");
  };
  const recovered = await f.lifecycle.updateWorkflowStatus({ taskId: next.id, status: "awaiting_implementation", operationId: "lost-reply" });
  assert.equal(recovered.task.workflowStatus, "awaiting_implementation");
  assert.equal(recovered.releaseCandidate.status, "ready", JSON.stringify(recovered.releaseCandidate));
  assert.equal(recovered.releaseCandidate.planRevision, (await f.releasePlanner.plan(f.workspace.id)).revision);
  // A lost reply keeps the composed candidate; no extra preparation is needed.
  assert.equal(await git(candidate.releaseRoot, "show", "PreRelease:next.txt"), "next");
});

test("ambiguous Await preserves its pending operation and rebuilds the candidate during recovery", { timeout: 90000 }, async (t) => {
  const f = await fixture(t);
  const task = await f.testedTask("Recover", "recover.txt", "recover\n");
  const commitStatus = f.taskBoard.commitWorkflowTransition.bind(f.taskBoard);
  const readOutcome = f.taskBoard.lifecycleOutcome.bind(f.taskBoard);
  // Capture the exact composed bytes at the moment the CAS outcome becomes
  // unknown, so the assertions below prove they were not rolled back.
  let composed = null;
  f.taskBoard.commitWorkflowTransition = async () => {
    // Captured before the failure so the assertions below cannot pass by timing.
    composed = await composedState();
    throw new Error("unknown SQLite transport result");
  };
  async function composedState() {
    const releaseRoot = path.join(f.root, "data", "release-repositories");
    const [entry] = await readdir(releaseRoot);
    const repository = path.join(releaseRoot, entry, "repository");
    return {
      repository,
      head: await git(repository, "rev-parse", "refs/heads/PreRelease"),
      recover: await git(repository, "show", "PreRelease:recover.txt"),
      checkpoint: await readFile(path.join(releaseRoot, entry, "checkpoint.json"), "utf8"),
    };
  }
  f.taskBoard.lifecycleOutcome = () => { throw new Error("readback unavailable"); };
  await assert.rejects(f.lifecycle.updateWorkflowStatus({ taskId: task.id, status: "awaiting_implementation", operationId: "ambiguous" }),
    { code: "AWAIT_ACCEPTANCE_UNKNOWN" });
  assert.equal(f.taskBoard.task(task.id).workflowStatus, "testing");
  assert.equal(f.taskBoard.lifecycleTransition("ambiguous").phase, "pending_git");
  // An unknown acceptance outcome must not roll the composed candidate back:
  // the Task transition may already be durable.
  assert.ok(composed, "the composed candidate state was captured");
  assert.equal(composed.recover, "recover");
  const afterUnknown = await composedState();
  assert.equal(afterUnknown.head, composed.head);
  assert.equal(afterUnknown.recover, "recover");
  assert.equal(afterUnknown.checkpoint, composed.checkpoint);
  assert.equal(await git(f.primary, "rev-parse", "main"), f.publication.repositories[0].revision);
  f.taskBoard.commitWorkflowTransition = commitStatus;
  f.taskBoard.lifecycleOutcome = readOutcome;
  // Guard proof itself has separate process-owner tests. Exercise the real Task
  // and dev locks here: preparation must reuse the held repository lease.
  f.taskGitWorkspaces.recoverProcessTreeGuard = async () => ({ recovered: true });
  const recovered = await f.lifecycle.reconcileUnknownWorkflowStatus({
    taskId: task.id, operationId: "ambiguous", projectRoot: f.primary,
    guardId: "test-exact-guard", proof: { confirmed: true },
  });
  assert.equal(recovered.result.task.workflowStatus, "awaiting_implementation");
  assert.equal(f.taskBoard.lifecycleTransition("ambiguous"), null);
  assert.equal(f.taskBoard.lifecycleOutcome("ambiguous").result.evidence.response.releaseCandidate.status, "ready");
  const candidate = await f.releasePreflight.prepareAwaitSet({ workspaceId: f.workspace.id });
  assert.equal(await git(candidate.releaseCandidates[0].releaseRoot, "show", "PreRelease:recover.txt"), "recover");
});

test("a stale accepted set is repaired by an explicit same-status Await", { timeout: 90000 }, async (t) => {
  const f = await fixture(t);
  const accepted = await f.testedTask("Accepted", "accepted.txt", "accepted\n");
  const { candidate } = await acceptAndPrepare(f, accepted, "accept-stale");
  const acceptedTask = f.taskBoard.task(accepted.id);
  const acceptanceIdentity = acceptedTask.releaseRevision;
  assert.equal(acceptedTask.workflowStatus, "awaiting_implementation");

  // Reproduce the acceptance-only defect shape: the Task is accepted while the
  // candidate does not contain its result.
  await git(candidate.releaseRoot, "update-ref", "refs/heads/PreRelease", candidate.baseCommit);
  await git(candidate.releaseRoot, "reset", "--hard", candidate.baseCommit);
  await assert.rejects(git(candidate.releaseRoot, "show", "PreRelease:accepted.txt"));

  f.taskGitWorkspaces.snapshotAndMergeOwned = async () => {
    throw new Error("repair must not ingest a new result");
  };
  const repaired = await f.lifecycle.updateWorkflowStatus({
    taskId: accepted.id, status: "awaiting_implementation", operationId: "repair-stale-await",
  });

  assert.equal(repaired.task.workflowStatus, "awaiting_implementation");
  assert.equal(repaired.releaseCandidate.status, "ready", JSON.stringify(repaired.releaseCandidate));
  assert.deepEqual(repaired.releaseCandidate.taskIds, [accepted.id]);
  const repairedCandidate = repaired.releaseCandidate.releaseCandidates[0];
  assert.equal(await git(repairedCandidate.releaseRoot, "show", "PreRelease:accepted.txt"), "accepted");
  // The acceptance identity is stable: only the row revision moves.
  assert.equal(f.taskBoard.task(accepted.id).releaseRevision, acceptanceIdentity);
  assert.equal(repaired.releaseIntegration.resultCommit, acceptedTask.gitReferences[0].resultCommit);
});

test("a frozen candidate keeps its identity through a refused same-id Await retry", { timeout: 90000 }, async (t) => {
  const f = await fixture(t);
  const accepted = await f.testedTask("Accepted", "accepted.txt", "accepted\n");
  const { prepared, candidate } = await acceptAndPrepare(f, accepted, "accept-freeze-retry");
  await writeFile(path.join(candidate.releaseRoot, "CHANGELOG.md"), "release\n");
  const frozen = await f.releaseGitWorkspaces.freezePublicationCandidate({
    projectRoot: f.primary, workspaceId: f.workspace.id,
    expectedPlanRevision: prepared.planRevision,
    expectedPreparedHead: candidate.preReleaseHead, changelogContent: Buffer.from("release\n"),
  });
  const next = await f.testedTask("Next", "next.txt", "next\n");
  const checkpointFile = path.join(path.dirname(candidate.releaseRoot), "checkpoint.json");
  const checkpointBefore = await readFile(checkpointFile, "utf8");

  for (const attempt of [1, 2]) {
    await assert.rejects(f.lifecycle.updateWorkflowStatus({
      taskId: next.id, status: "awaiting_implementation", operationId: "accept-into-frozen",
    }), { code: "RELEASE_CANDIDATE_FROZEN" }, `attempt ${attempt}`);
    assert.equal(f.taskBoard.task(next.id).workflowStatus, "testing");
    assert.equal(await readFile(checkpointFile, "utf8"), checkpointBefore);
    const readback = await f.releaseGitWorkspaces.frozenCandidate(f.primary);
    assert.equal(readback.preReleaseHead, frozen.preReleaseHead);
    assert.equal(readback.manifestHash, frozen.manifestHash);
    await assert.rejects(git(candidate.releaseRoot, "show", "PreRelease:next.txt"));
  }
});
