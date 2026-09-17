import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { TaskBoardService } from "../../src/application/task-board-service.mjs";
import { TaskLifecycleService, TaskIntegrationConflictError } from "../../src/application/task-lifecycle-service.mjs";
import { TaskBoardStore } from "../../src/infrastructure/persistence/task-board-store.mjs";
import { WorkspaceCatalogStore } from "../../src/infrastructure/persistence/workspace-catalog-store.mjs";
import { TaskGitWorkspaceService } from "../../src/infrastructure/filesystem/task-git-workspace.mjs";
import { TaskReleasePlanService } from "../../src/application/task-release-plan-service.mjs";
import { WorkspaceReleasePreflightService } from "../../src/application/workspace-release-preflight-service.mjs";
import { ReleaseGitWorkspaceService } from "../../src/infrastructure/filesystem/release-git-workspace.mjs";

const exec = promisify(execFile);
async function git(cwd, ...args) {
  return String((await exec("git", args, { cwd, windowsHide: true })).stdout).trim();
}
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "hub-conflict-lifecycle-"));
  const primary = path.join(root, "primary");
  await mkdir(primary);
  await git(primary, "init", "--initial-branch=main");
  await writeFile(path.join(primary, "app.txt"), "main\n");
  await git(primary, "add", ".");
  await git(primary, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "main");
  const databaseFile = path.join(root, "tasks.sqlite");
  const catalog = new WorkspaceCatalogStore({ databaseFile });
  await catalog.load();
  const store = new TaskBoardStore({ databaseFile });
  t.after(async () => { store.close(); catalog.close(); await rm(root, { recursive: true, force: true }); });
  const workspace = await catalog.runMutation(() => catalog.createWorkspace({
    name: "Workspace", settings: { workingDirectory: primary, releaseWorkflowEnabled: true },
  }));
  const workspaceCatalog = { workspace: () => workspace, stream: () => null, hierarchy: () => [workspace] };
  const taskBoard = new TaskBoardService({ store, workspaceCatalog });
  let publication = null;
  const taskGitWorkspaces = new TaskGitWorkspaceService({
    dataDir: path.join(root, "data"), readPublication: async () => publication,
  });
  const lifecycle = new TaskLifecycleService({ taskBoard, workspaceCatalog, taskGitWorkspaces,
    releasePreflight: { withAwaitTransition: (_id, op) => op(), prepareAwaitSet: async (options) => { const result = { releaseCandidates: [] }; if (options.commitPrepared) await options.commitPrepared(result); return result; } },
  });
  async function create(name) {
    const task = store.create({ text: name, bucket: "workspace", workspaceId: workspace.id });
    const prepared = await taskGitWorkspaces.prepare({ taskId: task.id, taskNumber: task.taskNumber, projectRoot: primary });
    return { task, root: prepared.projectRoot };
  }
  const status = (id, value, operationId) => lifecycle.updateWorkflowStatus({ taskId: id, status: value, operationId });
  return { root, primary, workspace, store, taskBoard, taskGitWorkspaces, lifecycle, create, status,
    publish: (value) => { publication = value; } };
}

test("real conflict saves a terminal failed lifecycle with file and revision evidence", { timeout: 90000 }, async (t) => {
  const f = await fixture(t);
  const a = await f.create("A"), b = await f.create("B");
  await writeFile(path.join(a.root, "app.txt"), "A\n");
  await f.status(a.task.id, "testing", "test-a");
  await writeFile(path.join(b.root, "app.txt"), "B\n");
  await assert.rejects(f.status(b.task.id, "testing", "test-b"), (error) => {
    assert.ok(error instanceof TaskIntegrationConflictError);
    assert.deepEqual(error.details.conflicts, ["app.txt"]);
    assert.equal(error.details.devRestored, true);
    assert.equal(error.details.taskId, b.task.id);
    return true;
  });
  assert.equal(f.taskBoard.lifecycleTransition("test-b").phase, "failed");
  assert.equal(f.taskBoard.task(b.task.id).workflowStatus, "new");
  assert.equal(await git(f.primary, "status", "--porcelain"), "");
});

test("another Task pending withdrawal gives a terminal refusal without touching its recovery", { timeout: 90000 }, async (t) => {
  const f = await fixture(t);
  const a = await f.create("A"), b = await f.create("B");
  await writeFile(path.join(a.root, "a.txt"), "A\n");
  await writeFile(path.join(b.root, "b.txt"), "B\n");
  await f.status(a.task.id, "testing", "test-owner");
  await f.status(b.task.id, "testing", "test-other");
  const tasks = f.taskBoard.releaseTasks(f.workspace.id).flatMap((task) => (
    task.gitReferences.map((ref) => ({ taskId: task.id, ...ref }))
  ));
  const resultCommit = f.taskBoard.task(a.task.id).gitReferences[0].resultCommit;
  let ambiguous = false;
  await assert.rejects(f.taskGitWorkspaces.withTaskLock(a.task.id, (lease) => (
    f.taskGitWorkspaces.withdrawResultOwned({
      taskId: a.task.id, taskNumber: a.task.taskNumber, projectRoot: f.primary,
      operationId: "original-withdrawal", resultCommit, tasks, lease,
      readWorkflowOutcome: async () => ({ status: ambiguous ? "unknown" : "not_committed" }),
      commitWorkflow: async () => { ambiguous = true; throw new Error("lost commit reply"); },
    })
  )), { code: "TASK_WITHDRAWAL_UNKNOWN" });
  const before = await git(f.primary, "rev-parse", "dev");
  await assert.rejects(f.status(b.task.id, "in_progress", "other-withdrawal"), { code: "TASK_WITHDRAWAL_BUSY" });
  assert.equal(f.taskBoard.lifecycleTransition("other-withdrawal").phase, "failed");
  assert.equal(f.taskBoard.task(b.task.id).workflowStatus, "testing");
  assert.equal(await git(f.primary, "rev-parse", "dev"), before);
  assert.equal(await f.taskGitWorkspaces.pendingWithdrawal({
    projectRoot: f.primary, taskId: a.task.id, operationId: "original-withdrawal",
  }), true);
});

for (const previouslyTested of [false, true]) test(`agent consolidation preserves source archive and releases all combined code (previouslyTested=${previouslyTested})`, { timeout: 120000 }, async (t) => {
  const f = await fixture(t);
  const origin = path.join(f.root, "origin.git");
  await git(f.root, "init", "--bare", "--initial-branch=main", origin);
  await git(f.primary, "remote", "add", "origin", origin);
  await git(f.primary, "push", "-u", "origin", "main");
  const a = await f.create("Absorbed"), b = await f.create("Survivor");
  await writeFile(path.join(a.root, "a.txt"), "source work\n");
  if (previouslyTested) {
    await f.status(a.task.id, "testing", "a-test");
    await f.status(a.task.id, "in_progress", "a-return");
    await writeFile(path.join(a.root, "a.txt"), "source work revised\n");
  }
  await git(a.root, "add", "a.txt");
  await git(a.root, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "Save source");
  const sourceHead = await git(a.root, "rev-parse", "HEAD");
  const sourceBranch = await git(a.root, "branch", "--show-current");
  await writeFile(path.join(b.root, "b.txt"), "surviving work\n");
  await git(b.root, "add", "b.txt");
  await git(b.root, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "Save survivor");
  await git(b.root, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "merge", "--no-ff", "--no-edit", sourceHead);
  await f.status(b.task.id, "testing", "combined-test");
  const preview = await f.lifecycle.complete({ taskId: a.task.id, absorbedIntoTaskId: b.task.id, operationId: "preview" });
  await assert.rejects(f.lifecycle.complete({ taskId: a.task.id, absorbedIntoTaskId: b.task.id,
    operationId: "stale-close", confirmCleanup: true, expectedCleanupToken: "stale" }), /stale/);
  const closed = await f.lifecycle.complete({ taskId: a.task.id, absorbedIntoTaskId: b.task.id,
    operationId: "close-combined", confirmCleanup: true, expectedCleanupToken: preview.cleanupToken });
  assert.equal(closed.status, "done");
  assert.notEqual(closed.workflowStatus, "done");
  assert.equal(await git(f.primary, "rev-parse", sourceBranch), sourceHead);
  assert.equal(await git(a.root, "rev-parse", "HEAD"), sourceHead);
  assert.equal(f.taskBoard.lifecycleOutcome("close-combined").result.evidence.absorbedInto.taskId, b.task.id);
  assert.throws(() => f.store.claim(a.task.id, { workspaceId: f.workspace.id, streamId: "s", provider: "codex",
    threadId: "thread", turnId: "turn", operationId: "reopen" }), /archive/);
  f.lifecycle.releasePreflight = new WorkspaceReleasePreflightService({
    releasePlanner: new TaskReleasePlanService({ taskBoard: f.taskBoard, taskGitWorkspaces: f.taskGitWorkspaces }),
    taskGitWorkspaces: f.taskGitWorkspaces,
    releaseGitWorkspaces: new ReleaseGitWorkspaceService({ dataDir: path.join(f.root, "data") }),
    resolveReleaseValidationSource: () => assert.fail("Consolidation must not access Test Contour"),
    refreshTestContour: () => assert.fail("Consolidation must not refresh Test Contour"),
    readTestContourStatus: () => assert.fail("Consolidation must not inspect Test Contour"),
    readPublicationState: async () => ({ repositories: [{ root: f.primary,
      revision: await git(f.primary, "rev-parse", "main") }] }),
    validateProductionCandidate: () => assert.fail("Await must not run release validation"),
  });
  const accepted = await f.status(b.task.id, "awaiting_implementation", "accept-combined");
  assert.equal(accepted.releaseCandidate.status, "ready", accepted.releaseCandidate.reason);
  assert.deepEqual(accepted.releaseCandidate.taskIds, [b.task.id]);
  const candidate = accepted.releaseCandidate.releaseCandidates[0];
  assert.equal(await git(candidate.releaseRoot, "show", "PreRelease:a.txt"), previouslyTested ? "source work revised" : "source work");
  assert.equal(await git(candidate.releaseRoot, "show", "PreRelease:b.txt"), "surviving work");
  const plan = await new TaskReleasePlanService({ taskBoard: f.taskBoard, taskGitWorkspaces: f.taskGitWorkspaces }).plan(f.workspace.id);
  assert.ok(!plan.candidates.some((task) => task.id === a.task.id));
});

test("combined closure rejects missing source commits, dirty work and a separate source integration", { timeout: 90000 }, async (t) => {
  const f = await fixture(t);
  const a = await f.create("Source"), b = await f.create("Target");
  await writeFile(path.join(a.root, "a.txt"), "A\n");
  await f.status(a.task.id, "testing", "test-a");
  await writeFile(path.join(b.root, "b.txt"), "B\n");
  await f.status(b.task.id, "testing", "test-b");
  const options = { taskId: a.task.id, absorbedIntoTaskId: b.task.id, operationId: "preview-absorb" };
  await assert.rejects(f.lifecycle.complete(options), /Return the source/);
  // Simulate an old direct-claim status change that omitted withdrawal.
  f.taskBoard.beginLifecycleTransition({ id: a.task.id, operationId: "legacy-claim", kind: "workflow",
    targetWorkflowStatus: "in_progress", expectedRevision: f.taskBoard.task(a.task.id).revision });
  f.taskBoard.commitWorkflowTransition({ operationId: "legacy-claim", replaceGitReferences: false });
  await assert.rejects(f.lifecycle.complete(options), /does not contain all source/);
  await git(b.root, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "merge", "--no-ff", "--no-edit", await git(a.root, "rev-parse", "HEAD"));
  await f.status(b.task.id, "testing", "test-combined");
  await assert.rejects(f.lifecycle.complete(options), /separate dev integration/);
  await writeFile(path.join(a.root, "unfinished.txt"), "unsaved\n");
  await assert.rejects(f.lifecycle.complete(options), /Save the source/);
  assert.notEqual(f.taskBoard.task(a.task.id).status, "done");
});

test("a sibling branch cannot hide an unapproved upstream merge", { timeout: 90000 }, async (t) => {
  const f = await fixture(t);
  const a = await f.create("Source"), b = await f.create("Target");
  await writeFile(path.join(a.root, "a.txt"), "A\n");
  await git(a.root, "add", "a.txt");
  await git(a.root, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "A");
  const tree = await git(f.primary, "rev-parse", "main^{tree}");
  const upstream = await git(f.primary, "-c", "user.name=Other", "-c", "user.email=other@example.invalid", "commit-tree", tree, "-p", "main", "-m", "Unapproved upstream");
  await git(a.root, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "merge", "--no-ff", "--no-edit", upstream);
  await writeFile(path.join(b.root, "b.txt"), "B\n");
  await git(b.root, "add", "b.txt");
  await git(b.root, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "B");
  await git(b.root, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "merge", "--no-ff", "--no-edit", await git(a.root, "rev-parse", "HEAD"));
  await f.taskGitWorkspaces.prepareDev(f.primary);
  const before = await git(f.primary, "rev-parse", "dev");
  await assert.rejects(f.status(b.task.id, "testing", "unapproved-combined"), /unapproved upstream/);
  assert.equal(await git(f.primary, "rev-parse", "dev"), before);
});

test("an explicit user exception permits consolidation before prerequisite publication", { timeout: 90000 }, async (t) => {
  const f = await fixture(t);
  const a = await f.create("Prerequisite"), b = await f.create("Dependent");
  await writeFile(path.join(a.root, "a.txt"), "A\n");
  const tested = await f.status(a.task.id, "testing", "test-a");
  await git(b.root, "merge", "--ff-only", tested.task.gitReferences[0].resultCommit);
  await writeFile(path.join(b.root, "b.txt"), "B\n");
  await f.status(b.task.id, "testing", "test-b");
  await f.lifecycle.updateWorkflowStatus({ taskId: b.task.id, status: "blocked", operationId: "block-b",
    operationEvidence: { blockedBy: { taskId: a.task.id, resultCommit: tested.task.gitReferences[0].resultCommit } } });
  await assert.rejects(f.taskGitWorkspaces.prepare({ taskId: b.task.id, taskNumber: b.task.taskNumber, projectRoot: f.primary }),
    { code: "TASK_AWAITING_DEPENDENCY_RELEASE" });
  await f.taskGitWorkspaces.prepare({ taskId: b.task.id, taskNumber: b.task.taskNumber, projectRoot: f.primary,
    dependencyOverrideReason: "User explicitly requested consolidation without waiting for A release" });
  await f.status(b.task.id, "in_progress", "resume-b");
  await f.taskGitWorkspaces.prepare({ taskId: b.task.id, taskNumber: b.task.taskNumber, projectRoot: f.primary });
  assert.equal(f.taskBoard.task(b.task.id).workflowStatus, "in_progress");
});

test("explicit dependent return persists Blocked and survives later publication advancement", { timeout: 90000 }, async (t) => {
  const f = await fixture(t);
  const a = await f.create("A");
  await writeFile(path.join(a.root, "a.txt"), "A\n");
  const testedA = await f.status(a.task.id, "testing", "test-a");
  const aCommit = testedA.task.gitReferences[0].resultCommit;
  const b = await f.create("B");
  await git(b.root, "merge", "--ff-only", aCommit);
  await writeFile(path.join(b.root, "b.txt"), "B\n");
  await f.status(b.task.id, "testing", "test-b");
  await f.lifecycle.updateWorkflowStatus({ taskId: b.task.id, status: "blocked", operationId: "block-b",
    operationEvidence: { blockedBy: { taskId: a.task.id, taskNumber: a.task.taskNumber, resultCommit: aCommit } } });
  await f.status(a.task.id, "in_progress", "return-a");
  const blocked = f.taskBoard.task(b.task.id);
  assert.equal(blocked.workflowStatus, "blocked");
  assert.equal(blocked.blockedBy.taskId, a.task.id);
  await f.status(b.task.id, "blocked", "repeat-blocked");
  assert.equal(f.taskBoard.task(b.task.id).blockedBy.taskId, a.task.id);
  await assert.rejects(f.status(b.task.id, "in_progress", "early-resume"), { code: "TASK_AWAITING_DEPENDENCY_RELEASE" });
  assert.equal(f.taskBoard.task(b.task.id).workflowStatus, "blocked");
  await git(f.primary, "update-ref", "refs/remotes/origin/main", aCommit);
  f.publish({ generation: "published", revision: aCommit, repositories: [{ root: f.primary, revision: aCommit }] });
  await f.status(b.task.id, "in_progress", "resume-b");
  assert.equal(f.taskBoard.task(b.task.id).workflowStatus, "in_progress");
  assert.equal(f.taskBoard.task(b.task.id).blockedBy, undefined);
  const tree = await git(f.primary, "rev-parse", `${aCommit}^{tree}`);
  const laterMain = await git(f.primary, "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
    "commit-tree", tree, "-p", aCommit, "-m", "Later published main");
  await git(f.primary, "update-ref", "refs/remotes/origin/main", laterMain);
  await f.taskGitWorkspaces.prepare({ taskId: b.task.id, taskNumber: b.task.taskNumber, projectRoot: f.primary });
});

test("dependent return refuses without changing B, then succeeds after the agent explicitly returns B", { timeout: 90000 }, async (t) => {
  const f = await fixture(t);
  const a = await f.create("A");
  await writeFile(path.join(a.root, "a.txt"), "A\n");
  const testedA = await f.status(a.task.id, "testing", "test-a");
  const b = await f.create("B");
  await git(b.root, "merge", "--ff-only", testedA.task.gitReferences[0].resultCommit);
  await writeFile(path.join(b.root, "b.txt"), "B\n");
  await f.status(b.task.id, "testing", "test-b");
  const before = await git(f.primary, "rev-parse", "dev");
  const bBefore = f.taskBoard.task(b.task.id);
  await assert.rejects(f.status(a.task.id, "in_progress", "return-a-refused"), (error) => {
    assert.equal(error.code, "TASK_WITHDRAWAL_DEPENDENCY");
    assert.deepEqual(error.details.blockedTaskIds, [b.task.id]);
    return true;
  });
  assert.equal(f.taskBoard.lifecycleTransition("return-a-refused").phase, "failed");
  assert.equal(await git(f.primary, "rev-parse", "dev"), before);
  assert.deepEqual(f.taskBoard.task(b.task.id), bBefore);
  await f.status(b.task.id, "in_progress", "return-b");
  await f.status(a.task.id, "in_progress", "return-a-corrected");
  assert.equal(f.taskBoard.task(a.task.id).workflowStatus, "in_progress");
  assert.equal(f.taskBoard.task(b.task.id).workflowStatus, "in_progress");
});

test("a conflict diagnostic longer than 4000 characters still has a confirmed terminal outcome", async (t) => {
  const f = await fixture(t);
  const a = await f.create("Large conflict");
  f.taskGitWorkspaces.snapshotAndMergeOwned = async () => ({
    snapshot: { projectRoot: a.root, headCommit: "a".repeat(40) },
    integration: { integrated: false, devRestored: true,
      conflicts: Array.from({ length: 90 }, (_, i) => `src/long-directory-name/module-${i}.mjs`),
      dev: { headCommit: "b".repeat(40) } },
  });
  await assert.rejects(f.status(a.task.id, "testing", "large-conflict"), (error) => {
    assert.ok(error instanceof TaskIntegrationConflictError);
    assert.ok(error.message.length > 4000);
    return true;
  });
  assert.equal(f.taskBoard.lifecycleTransition("large-conflict").phase, "failed");
});

for (const committed of [false, true]) test(`old conflict cannot restore withdrawn code (committed=${committed})`, { timeout: 90000 }, async (t) => {
  const f = await fixture(t);
  const a = await f.create("A"), b = await f.create("B");
  await writeFile(path.join(a.root, "app.txt"), "A\n");
  const testedA = await f.status(a.task.id, "testing", "test-a");
  await writeFile(path.join(b.root, "app.txt"), "B\n");
  await assert.rejects(f.status(b.task.id, "testing", "conflict-b"), TaskIntegrationConflictError);
  const d1 = await git(f.primary, "rev-parse", "dev");
  await assert.rejects(git(b.root, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "merge", "--no-commit", d1));
  await writeFile(path.join(b.root, "app.txt"), "A and B\n");
  if (committed) {
    await git(b.root, "add", "app.txt");
    await git(b.root, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "Resolve B");
  }
  await f.status(a.task.id, "in_progress", "return-a");
  const before = await git(f.primary, "rev-parse", "dev");
  await assert.rejects(f.status(b.task.id, "testing", "finish-b"), (error) => {
    t.diagnostic(error.message);
    return true;
  });
  assert.equal(await git(f.primary, "rev-parse", "dev"), before);
  await assert.rejects(git(f.primary, "merge-base", "--is-ancestor", testedA.task.gitReferences[0].resultCommit, "dev"));
});

test("a dependency refusal leaves the other Task pending operation untouched", { timeout: 90000 }, async (t) => {
  const f = await fixture(t);
  const a = await f.create("A");
  await writeFile(path.join(a.root, "a.txt"), "A\n");
  const testedA = await f.status(a.task.id, "testing", "test-a");
  const b = await f.create("B");
  await git(b.root, "merge", "--ff-only", testedA.task.gitReferences[0].resultCommit);
  await writeFile(path.join(b.root, "b.txt"), "B\n");
  await f.status(b.task.id, "testing", "test-b");
  f.taskBoard.beginLifecycleTransition({ id: b.task.id, operationId: "foreign-b", kind: "workflow",
    targetWorkflowStatus: "in_progress", expectedRevision: f.taskBoard.task(b.task.id).revision });
  const before = await git(f.primary, "rev-parse", "dev");
  await assert.rejects(f.status(a.task.id, "in_progress", "return-a-busy"), { code: "TASK_WITHDRAWAL_DEPENDENCY" });
  assert.equal(f.taskBoard.lifecycleTransition("return-a-busy").phase, "failed");
  assert.equal(f.taskBoard.lifecycleTransition("foreign-b").phase, "pending_git");
  assert.equal(await git(f.primary, "rev-parse", "dev"), before);
});
