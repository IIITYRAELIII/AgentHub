import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
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
  t.after(async () => {
    store.close();
    catalogStore.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  const workspace = await catalogStore.runMutation(() => catalogStore.createWorkspace({ name: "Workspace", settings: {
    workingDirectory: primary, releaseWorkflowEnabled: true,
  } }));
  const workspaceCatalog = {
    hierarchy: () => [workspace], workspace: () => workspace, stream: () => null,
  };
  const taskBoard = new TaskBoardService({ store, workspaceCatalog });
  const taskGitWorkspaces = new TaskGitWorkspaceService({ dataDir, recordTiming: () => {} });
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
  assert.equal(response.releaseCandidate.status, "prepared");
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

test("Task work advances live PreRelease while the prior frozen commit remains immutable", async (t) => {
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
  const frozenTree = await git(candidate.releaseRoot, "rev-parse", `${frozen.preReleaseHead}^{tree}`);
  const next = await f.testedTask("Next", "next.txt", "next\n");
  const acceptedNext = await f.lifecycle.updateWorkflowStatus({
    taskId: next.id, status: "awaiting_implementation", operationId: "accept-next",
  });
  assert.equal(acceptedNext.task.workflowStatus, "awaiting_implementation");
  assert.equal(acceptedNext.releaseCandidate.status, "prepared");
  assert.equal(await git(candidate.releaseRoot, "show", "PreRelease:next.txt"), "next");
  assert.equal(await git(candidate.releaseRoot, "rev-parse", `${frozen.preReleaseHead}^{tree}`), frozenTree);
  await git(candidate.releaseRoot, "push", "origin", "main");
  const returned = await f.lifecycle.updateWorkflowStatus({
    taskId: accepted.id, status: "in_progress", operationId: "return-frozen",
  });
  assert.equal(returned.task.workflowStatus, "in_progress");
  assert.equal(returned.acceptedResultPreserved, true);
  assert.equal(returned.releaseCandidate.status, "preserved");
  assert.notEqual(await readFile(checkpointFile, "utf8"), "");
  assert.equal(await git(candidate.releaseRoot, "show", "PreRelease:next.txt"), "next");
  assert.equal(await git(candidate.releaseRoot, "rev-parse", `${frozen.preReleaseHead}^{tree}`), frozenTree);
});

// Await, return and re-acceptance exercise finite Git/SQLite transitions. Await
// their assertions and cleanup instead of cancelling the scenario by wall time.
test("Await membership prepares the candidate and fences changed agreed-main evidence before acceptance", async (t) => {
  const { root, origin, taskBoard, taskGitWorkspaces, lifecycle, testedTask, primary } = await fixture(t);
  const unaccepted = await testedTask("Unaccepted", "unaccepted.txt", "not accepted\n");
  const accepted = await testedTask("Accepted", "accepted.txt", "accepted\n");
  const response = await lifecycle.updateWorkflowStatus({
    taskId: accepted.id, status: "awaiting_implementation", operationId: "accept-first",
  });
  assert.equal(response.task.workflowStatus, "awaiting_implementation");
  assert.equal(response.releaseCandidate.status, "prepared");
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
  const dev = await taskGitWorkspaces.prepareDev(primary);
  assert.equal(await git(dev.projectRoot, "show", "HEAD:accepted.txt"), "accepted");
  assert.equal(await git(dev.projectRoot, "show", "HEAD:unaccepted.txt"), "not accepted");
  await lifecycle.updateWorkflowStatus({ taskId: accepted.id, status: "testing", operationId: "test-returned" });
  const acceptedAgain = await lifecycle.updateWorkflowStatus({
    taskId: accepted.id, status: "awaiting_implementation", operationId: "accept-again",
  });
  assert.equal(acceptedAgain.releaseCandidate.status, "prepared");
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
  // Conflict preparation starts from agreed local main, not observation of
  // origin alone. Advance this disposable fixture's agreed main explicitly.
  await git(primary, "merge", "--ff-only", "refs/remotes/origin/main");
  lifecycle.releasePreflight.readPublicationState = async () => ({ repositories: [{ root: primary, revision: published }] });
  await assert.rejects(
    lifecycle.updateWorkflowStatus({
      taskId: conflicting.id, status: "awaiting_implementation", operationId: "accept-conflicting",
    }),
    (error) => error?.code === "TASK_AWAIT_INTEGRATION_FAILED"
      && /does not contain accepted local main/u.test(error.message),
  );
  assert.equal(taskBoard.task(conflicting.id).workflowStatus, "testing");
  assert.equal(await readFile(checkpointFile, "utf8"), checkpointBefore);
  assert.equal(await git(candidate.releaseRoot, "rev-parse", "PreRelease"), candidate.preReleaseHead);
  assert.equal(await git(candidate.releaseRoot, "status", "--porcelain=v1"), "");
  assert.equal(taskBoard.lifecycleOutcome("accept-conflicting"), null);
  const failedTransition = taskBoard.lifecycleTransition("accept-conflicting");
  assert.equal(failedTransition.phase, "failed");
  assert.equal(failedTransition.priorTask.workflowStatus, "testing");
});

// Real Test/Await/withdrawal performs repeated native Git proofs; the former
// 90-second budget expired while those proofs were still executing.
test("Await and withdrawal retain the published base despite unreviewed origin movement", async (t) => {
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

test("Await leaves PreRelease unchanged after SQLite rejection and rebuilds it after a lost committed reply", async (t) => {
  const f = await fixture(t);
  f.releaseGitWorkspaces.prepareGeneration = async () => assert.fail("Await must reuse live PreRelease");
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
  assert.equal(recovered.releaseCandidate.status, "prepared");
  assert.equal(recovered.releaseCandidate.planRevision, (await f.releasePlanner.plan(f.workspace.id)).revision);
  assert.equal(await git(candidate.releaseRoot, "show", "PreRelease:next.txt"), "next");
  assert.equal(recovered.cleanupWarnings?.length ?? 0, 0,
    recovered.cleanupWarnings?.map((error) => error.message).join("; "));
  assert.equal(await git(candidate.releaseRoot, "status", "--porcelain"), "");
  assert.deepEqual(await readdir(path.join(f.root, "data", "release-gens")).catch((error) => (
    error.code === "ENOENT" ? [] : Promise.reject(error)
  )), []);
});

test("concurrent Await acceptances serialize in existing PreRelease without cloning a hooked primary", async (t) => {
  const f = await fixture(t);
  const seed = await f.testedTask("Seed", "seed.txt", "seed\n");
  const { candidate } = await acceptAndPrepare(f, seed, "seed");
  const first = await f.testedTask("Concurrent first", "first.txt", "first\n");
  const second = await f.testedTask("Concurrent second", "second.txt", "second\n");
  // Fresh local clone would hit Git protection; reuse the existing repository.
  const hooks = path.join(f.root, "hooks");
  await mkdir(hooks);
  await git(f.primary, "config", "core.hooksPath", hooks);
  const primaryBefore = await git(f.primary, "rev-parse", "HEAD");
  f.releaseGitWorkspaces.prepareGeneration = async () => assert.fail("No Await generation");
  f.releaseGitWorkspaces.promoteGenerationCandidate = async () => assert.fail("No generation promotion");
  const original = f.releaseGitWorkspaces.prepareCandidate.bind(f.releaseGitWorkspaces);
  const roots = [];
  let active = 0;
  let peak = 0;
  f.releaseGitWorkspaces.prepareCandidate = async (options) => {
    active += 1;
    peak = Math.max(peak, active);
    try {
      const result = await original(options);
      roots.push(result.releaseRoot);
      return result;
    } finally { active -= 1; }
  };
  const results = await Promise.all([
    f.lifecycle.updateWorkflowStatus({ taskId: first.id, status: "awaiting_implementation", operationId: "concurrent-first" }),
    f.lifecycle.updateWorkflowStatus({ taskId: second.id, status: "awaiting_implementation", operationId: "concurrent-second" }),
  ]);
  for (const result of results) assert.equal(result.task.workflowStatus, "awaiting_implementation");
  assert.equal(peak, 1);
  assert.deepEqual(roots, [candidate.releaseRoot, candidate.releaseRoot]);
  assert.deepEqual(await readdir(path.join(f.root, "data", "release-gens")).catch((error) => (
    error.code === "ENOENT" ? [] : Promise.reject(error)
  )), []);
  for (const name of ["seed", "first", "second"]) {
    assert.equal(await git(candidate.releaseRoot, "show", `PreRelease:${name}.txt`), name);
  }
  assert.equal(await git(candidate.releaseRoot, "status", "--porcelain"), "");
  assert.equal(await git(f.primary, "rev-parse", "HEAD"), primaryBefore);
  assert.equal(await git(f.primary, "config", "--local", "--get", "core.hooksPath"), hooks);
});

test("ambiguous Await preserves its pending operation and rebuilds the candidate during recovery", async (t) => {
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
  const preserved = await f.releaseGitWorkspaces.frozenCandidate(f.primary);
  assert.equal(preserved.checkpointPhase, "prepared");
  assert.equal(await git(preserved.releaseRoot, "show", "PreRelease:recover.txt"), "recover");
  assert.ok(composed, "the composed candidate state was captured");
  const afterUnknown = await composedState();
  assert.equal(afterUnknown.head, composed.head);
  assert.equal(afterUnknown.checkpoint, composed.checkpoint);
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
  assert.equal(f.taskBoard.lifecycleOutcome("ambiguous").result.evidence.response.releaseCandidate.status, "prepared");
  const candidate = await f.releasePreflight.prepareAwaitSet({ workspaceId: f.workspace.id });
  assert.equal(await git(candidate.releaseCandidates[0].releaseRoot, "show", "PreRelease:recover.txt"), "recover");
});

test("same-status Await refuses an unrecognized native candidate ref rewind", async (t) => {
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
  await assert.rejects(f.lifecycle.updateWorkflowStatus({
    taskId: accepted.id, status: "awaiting_implementation", operationId: "repair-stale-await",
  }), /Native candidate ref changed/u);
  assert.equal(f.taskBoard.task(accepted.id).workflowStatus, "awaiting_implementation");
  assert.equal(f.taskBoard.task(accepted.id).releaseRevision, acceptanceIdentity);
  assert.equal(f.taskBoard.task(accepted.id).gitReferences[0].resultCommit, acceptedTask.gitReferences[0].resultCommit);
  assert.equal(await git(candidate.releaseRoot, "rev-parse", "PreRelease"), candidate.baseCommit);
});

test("a frozen candidate keeps its identity while a later Await enters the next generation", async (t) => {
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
  const checkpointBefore = JSON.parse(await readFile(checkpointFile, "utf8"));
  const frozenManifestFile = path.join(path.dirname(candidate.releaseRoot), "evidence", `${checkpointBefore.manifestHash}.json`);
  const frozenManifestBefore = await readFile(frozenManifestFile, "utf8");

  const acceptedNext = await f.lifecycle.updateWorkflowStatus({
    taskId: next.id, status: "awaiting_implementation", operationId: "accept-into-frozen",
  });
  assert.equal(acceptedNext.task.workflowStatus, "awaiting_implementation");
  assert.equal(acceptedNext.releaseCandidate.status, "prepared");
  const checkpointAfter = JSON.parse(await readFile(checkpointFile, "utf8"));
  assert.equal(checkpointAfter.phase, "prepared");
  assert.notEqual(checkpointAfter.manifestHash, frozen.manifestHash);
  assert.equal(await readFile(frozenManifestFile, "utf8"), frozenManifestBefore);
  assert.equal(await git(candidate.releaseRoot, "show", "PreRelease:next.txt"), "next");
});
