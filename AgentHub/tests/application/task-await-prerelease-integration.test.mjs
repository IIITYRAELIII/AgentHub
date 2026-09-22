import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

async function acceptAndPrepare(fixture, task, operationId) {
  const response = await fixture.lifecycle.updateWorkflowStatus({
    taskId: task.id, status: "awaiting_implementation", operationId,
  });
  assert.equal(response.releaseCandidate.status, "invalidated");
  const prepared = await fixture.releasePreflight.prepareAwaitSet({ workspaceId: fixture.workspace.id });
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

test("Task work continues while an immutable frozen generation is unfinished", { timeout: 90000 }, async (t) => {
  const f = await fixture(t);
  const accepted = await f.testedTask("Release", "release.txt", "release\n");
  const { response, prepared, candidate } = await acceptAndPrepare(f, accepted, "accept-release");
  await writeFile(path.join(candidate.releaseRoot, "CHANGELOG.md"), "release\n");
  const frozen = await f.releaseGitWorkspaces.freezePublicationCandidate({
    projectRoot: f.primary, workspaceId: f.workspace.id,
    expectedPlanRevision: prepared.planRevision,
    expectedPreparedHead: candidate.preReleaseHead, changelogContent: Buffer.from("release\n"),
  });
  const checkpointFile = path.join(path.dirname(candidate.releaseRoot), "checkpoint.json");
  const checkpointBefore = await readFile(checkpointFile, "utf8");
  const next = await f.testedTask("Next", "next.txt", "next\n");
  const acceptedNext = await f.lifecycle.updateWorkflowStatus({
    taskId: next.id, status: "awaiting_implementation", operationId: "accept-next",
  });
  assert.equal(acceptedNext.task.workflowStatus, "awaiting_implementation");
  await git(candidate.releaseRoot, "push", "origin", "main");
  const returned = await f.lifecycle.updateWorkflowStatus({
    taskId: accepted.id, status: "in_progress", operationId: "return-frozen",
  });
  assert.equal(returned.task.workflowStatus, "in_progress");
  assert.equal(returned.acceptedResultPreserved, true);
  assert.equal(returned.releaseCandidate.status, "preserved");
  assert.equal(await readFile(checkpointFile, "utf8"), checkpointBefore);
  assert.equal(await git(candidate.releaseRoot, "rev-parse", "PreRelease"), frozen.preReleaseHead);
});

test("Await membership invalidates the candidate and explicit preparation detects conflicts", { timeout: 90000 }, async (t) => {
  const { root, origin, taskBoard, taskGitWorkspaces, lifecycle, testedTask, primary } = await fixture(t);
  const unaccepted = await testedTask("Unaccepted", "unaccepted.txt", "not accepted\n");
  const accepted = await testedTask("Accepted", "accepted.txt", "accepted\n");
  const response = await lifecycle.updateWorkflowStatus({
    taskId: accepted.id, status: "awaiting_implementation", operationId: "accept-first",
  });
  assert.equal(response.task.workflowStatus, "awaiting_implementation");
  assert.equal(response.releaseCandidate.status, "invalidated");
  let prepared = await lifecycle.releasePreflight.prepareAwaitSet({ workspaceId: response.task.workspaceId });
  assert.deepEqual(prepared.taskIds, [accepted.id]);
  let candidate = prepared.releaseCandidates[0];
  assert.equal(await git(candidate.releaseRoot, "show", `${candidate.preReleaseHead}:accepted.txt`), "accepted");
  await assert.rejects(git(candidate.releaseRoot, "show", `${candidate.preReleaseHead}:unaccepted.txt`));
  assert.equal(taskBoard.task(unaccepted.id).workflowStatus, "testing");
  const returned = await lifecycle.updateWorkflowStatus({
    taskId: accepted.id, status: "in_progress", operationId: "return-accepted",
  });
  assert.equal(returned.task.workflowStatus, "in_progress");
  assert.equal(returned.acceptedResultPreserved, true);
  assert.equal(returned.releaseCandidate.status, "preserved");
  prepared = await lifecycle.releasePreflight.prepareAwaitSet({ workspaceId: returned.task.workspaceId });
  assert.deepEqual(prepared.taskIds, []);
  assert.deepEqual(prepared.releaseCandidates, []);
  const dev = await taskGitWorkspaces.prepareDev(primary);
  assert.equal(await git(dev.projectRoot, "show", "HEAD:accepted.txt"), "accepted");
  assert.equal(await git(dev.projectRoot, "show", "HEAD:unaccepted.txt"), "not accepted");
  await lifecycle.updateWorkflowStatus({ taskId: accepted.id, status: "testing", operationId: "test-returned" });
  const acceptedAgain = await lifecycle.updateWorkflowStatus({
    taskId: accepted.id, status: "awaiting_implementation", operationId: "accept-again",
  });
  assert.equal(acceptedAgain.releaseCandidate.status, "invalidated");
  prepared = await lifecycle.releasePreflight.prepareAwaitSet({ workspaceId: acceptedAgain.task.workspaceId });
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
  const conflictingAccepted = await lifecycle.updateWorkflowStatus({
    taskId: conflicting.id, status: "awaiting_implementation", operationId: "accept-conflicting",
  });
  assert.equal(conflictingAccepted.task.workflowStatus, "awaiting_implementation");
  assert.equal(conflictingAccepted.releaseCandidate.status, "invalidated");
  await assert.rejects(
    lifecycle.releasePreflight.prepareAwaitSet({ workspaceId: conflictingAccepted.task.workspaceId }),
    /PreRelease delta .* failed.*app\.txt/u,
  );
  assert.equal(taskBoard.task(conflicting.id).workflowStatus, "awaiting_implementation");
  assert.equal(await readFile(checkpointFile, "utf8"), checkpointBefore);
  assert.equal(await git(candidate.releaseRoot, "rev-parse", "PreRelease"), candidate.preReleaseHead);
  assert.equal(await git(candidate.releaseRoot, "status", "--porcelain=v1"), "");
  const conflictingOutcome = taskBoard.lifecycleOutcome("accept-conflicting");
  assert.equal(conflictingOutcome.result.task.workflowStatus, "awaiting_implementation");
  assert.equal(conflictingOutcome.result.evidence.response.releaseCandidate.status, "invalidated");
  assert.equal(taskBoard.lifecycleTransition("accept-conflicting"), null);
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
  assert.equal(returned.releaseCandidate.status, "preserved", returned.releaseCandidate.reason);
  const candidate = (await f.releasePreflight.prepareAwaitSet({ workspaceId: f.workspace.id })).releaseCandidates[0];
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
    assert.equal(f.taskBoard.task(next.id).workflowStatus, "testing");
    await assert.rejects(git(candidate.releaseRoot, "show", "PreRelease:next.txt"));
    await original(args);
    throw new Error("injected lost SQLite reply");
  };
  const recovered = await f.lifecycle.updateWorkflowStatus({ taskId: next.id, status: "awaiting_implementation", operationId: "lost-reply" });
  assert.equal(recovered.task.workflowStatus, "awaiting_implementation");
  assert.equal(recovered.releaseCandidate.planRevision, (await f.releasePlanner.plan(f.workspace.id)).revision);
  await f.releasePreflight.prepareAwaitSet({ workspaceId: f.workspace.id });
  assert.equal(await git(candidate.releaseRoot, "show", "PreRelease:next.txt"), "next");
});

test("ambiguous Await preserves its pending operation and rebuilds the candidate during recovery", { timeout: 90000 }, async (t) => {
  const f = await fixture(t);
  const task = await f.testedTask("Recover", "recover.txt", "recover\n");
  const commitStatus = f.taskBoard.commitWorkflowTransition.bind(f.taskBoard);
  const readOutcome = f.taskBoard.lifecycleOutcome.bind(f.taskBoard);
  f.taskBoard.commitWorkflowTransition = () => { throw new Error("unknown SQLite transport result"); };
  f.taskBoard.lifecycleOutcome = () => { throw new Error("readback unavailable"); };
  await assert.rejects(f.lifecycle.updateWorkflowStatus({ taskId: task.id, status: "awaiting_implementation", operationId: "ambiguous" }),
    { code: "AWAIT_ACCEPTANCE_UNKNOWN" });
  assert.equal(f.taskBoard.task(task.id).workflowStatus, "testing");
  assert.equal(f.taskBoard.lifecycleTransition("ambiguous").phase, "pending_git");
  await assert.rejects(f.releaseGitWorkspaces.frozenCandidate(f.primary), /checkpoint is incomplete/u);
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
  assert.equal(f.taskBoard.lifecycleOutcome("ambiguous").result.evidence.response.releaseCandidate.status, "invalidated");
  const candidate = await f.releasePreflight.prepareAwaitSet({ workspaceId: f.workspace.id });
  assert.equal(await git(candidate.releaseCandidates[0].releaseRoot, "show", "PreRelease:recover.txt"), "recover");
});
