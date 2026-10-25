import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
import { TaskGitHistoryRejectedError } from "../../src/domain/task-git-reference.mjs";
import { TaskIntegrationRejectedError } from "../../src/application/task-lifecycle-service.mjs";

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
  t.after(async () => {
    store.close();
    catalog.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  const workspace = await catalog.runMutation(() => catalog.createWorkspace({
    name: "Workspace", settings: { workingDirectory: primary, releaseWorkflowEnabled: true },
  }));
  const workspaceCatalog = { workspace: () => workspace, stream: () => null, hierarchy: () => [workspace] };
  const taskBoard = new TaskBoardService({ store, workspaceCatalog });
  let publication = null;
  const timings = [];
  const taskGitWorkspaces = new TaskGitWorkspaceService({
    dataDir: path.join(root, "data"), readPublication: async () => publication,
    recordTiming: event => timings.push(event),
  });
  const lifecycle = new TaskLifecycleService({ taskBoard, workspaceCatalog, taskGitWorkspaces,
    releasePreflight: {
      withAwaitTransition: (_id, op) => op(),
      validateAwaitAcceptance: async ({ acceptingTask }) => {
        const current = taskBoard.task(acceptingTask.id);
        return {
          planRevision: `plan-${current.revision}`,
          task: { taskId: current.id, resultCommit: current.gitReferences[0].resultCommit },
        };
      },
      prepareAwaitSet: async (options) => { const result = { releaseCandidates: [] }; if (options.commitPrepared) await options.commitPrepared(result); return result; },
    },
  });
  async function create(name) {
    const task = store.create({ text: name, bucket: "workspace", workspaceId: workspace.id });
    const prepared = await taskGitWorkspaces.prepare({ taskId: task.id, taskNumber: task.taskNumber, projectRoot: primary });
    return { task, root: prepared.projectRoot };
  }
  const status = (id, value, operationId) => lifecycle.updateWorkflowStatus({ taskId: id, status: value, operationId });
  return { root, primary, workspace, store, taskBoard, taskGitWorkspaces, lifecycle, create, status, timings,
    publish: (value) => { publication = value; } };
}

for (const durableFailure of [true, false]) test(`history refusal becomes terminal only with durable failure=${durableFailure}`, async (t) => {
  const f = await fixture(t);
  const a = await f.create("Validation");
  f.taskGitWorkspaces.snapshotAndMergeOwned = async () => {
    throw new TaskGitHistoryRejectedError("Sibling Task exact parent is not approved");
  };
  if (!durableFailure) f.taskBoard.failLifecycleTransition = () => { throw new Error("database unavailable"); };
  await assert.rejects(f.status(a.task.id, "testing", "history-refusal"), error => {
    assert.equal(error instanceof TaskIntegrationRejectedError, durableFailure);
    return true;
  });
  assert.equal(f.taskBoard.task(a.task.id).workflowStatus, "new");
  assert.equal(f.taskBoard.lifecycleTransition("history-refusal").phase, durableFailure ? "failed" : "pending_git");
});

test("Test prepares the Task once before snapshot and merge", async (t) => {
  const f = await fixture(t);
  const a = await f.create("One preparation");
  let calls = 0;
  const prepare = f.taskGitWorkspaces.prepareOwned.bind(f.taskGitWorkspaces);
  f.taskGitWorkspaces.prepareOwned = async (...args) => { calls += 1; return prepare(...args); };
  await writeFile(path.join(a.root, "result.txt"), "result\n");
  await f.status(a.task.id, "testing", "single-preparation");
  assert.equal(calls, 1);
  assert.equal(f.taskBoard.task(a.task.id).workflowStatus, "testing");
  for (const stage of ["workflow", "await-transition", "await-admitted", "prepare-task", "snapshot", "integrate-dev", "persistence", "git-child"]) {
    assert.ok(f.timings.some(event => event.operationId === "single-preparation" && event.stage === stage && event.phase === "end"), stage);
  }
});

test("a separate Task Test history refusal is durably failed before dev mutation", async (t) => {
  const f = await fixture(t);
  const task = await f.create("Separate Task");
  const dev = await f.taskGitWorkspaces.prepareDev(f.primary);
  const devBefore = dev.headCommit;
  await writeFile(path.join(f.primary, "reviewed-main.txt"), "reviewed main\n");
  await git(f.primary, "add", "reviewed-main.txt");
  await git(f.primary, "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
    "commit", "-m", "reviewed main advance");
  await writeFile(path.join(task.root, "task.txt"), "separate result\n");
  await assert.rejects(f.status(task.task.id, "testing", "separate-task-history-refusal"),
    (error) => /does not contain accepted local main.*explicit adoption required/u.test(error.message));
  assert.equal(f.taskBoard.lifecycleTransition("separate-task-history-refusal").phase, "failed");
  assert.equal(f.taskBoard.task(task.task.id).workflowStatus, "new");
  assert.equal(await git(f.primary, "rev-parse", "dev"), devBefore);
  assert.equal(await git(dev.projectRoot, "status", "--porcelain"), "");
});

test("real conflict saves a terminal failed lifecycle with file and revision evidence", async (t) => {
  const f = await fixture(t);
  const a = await f.create("A"), b = await f.create("B");
  await writeFile(path.join(a.root, "app.txt"), "A\n");
  await f.status(a.task.id, "testing", "test-a");
  const devBefore = await git(f.primary, "rev-parse", "dev");
  let conflictRoot;
  await writeFile(path.join(b.root, "app.txt"), "B\n");
  await assert.rejects(f.status(b.task.id, "testing", "test-b"), (error) => {
    assert.ok(error instanceof TaskIntegrationConflictError);
    assert.deepEqual(error.details.conflicts, ["app.txt"]);
    assert.equal(error.details.devRestored, true);
    assert.equal(error.details.taskId, b.task.id);
    conflictRoot = error.details.nativeConflictRoot;
    return true;
  });
  assert.equal(f.taskBoard.lifecycleTransition("test-b").phase, "failed");
  assert.equal(f.taskBoard.task(b.task.id).workflowStatus, "new");
  assert.equal(await git(f.primary, "status", "--porcelain"), "");
  assert.equal(await git(f.primary, "rev-parse", "dev"), devBefore);
  assert.equal(await git(conflictRoot, "rev-parse", "MERGE_HEAD"), await git(b.root, "rev-parse", "HEAD"));
  assert.equal(f.timings.find(event => event.operationId === "test-b" && event.stage === "workflow" && event.phase === "end").outcome, "error");
});

test("correction preserves its accepted result without touching another pending withdrawal", async (t) => {
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
  const corrected = await f.status(b.task.id, "in_progress", "other-correction");
  assert.equal(corrected.task.workflowStatus, "in_progress");
  assert.equal(corrected.acceptedResultPreserved, true);
  assert.equal(f.taskBoard.lifecycleTransition("other-correction"), null);
  assert.equal(await git(f.primary, "rev-parse", "dev"), before);
  assert.equal(await f.taskGitWorkspaces.pendingWithdrawal({
    projectRoot: f.primary, taskId: a.task.id, operationId: "original-withdrawal",
  }), true);
});

test("native consolidation without an authenticated handoff refuses Test and preserves source archive", async (t) => {
  const f = await fixture(t);
  const origin = path.join(f.root, "origin.git");
  await git(f.root, "init", "--bare", "--initial-branch=main", origin);
  await git(f.primary, "remote", "add", "origin", origin);
  await git(f.primary, "push", "-u", "origin", "main");
  const a = await f.create("Absorbed"), b = await f.create("Survivor");
  await writeFile(path.join(a.root, "a.txt"), "source work\n");
  await git(a.root, "add", "a.txt");
  await git(a.root, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "Save source");
  const sourceHead = await git(a.root, "rev-parse", "HEAD");
  const sourceBranch = await git(a.root, "branch", "--show-current");
  await writeFile(path.join(b.root, "b.txt"), "surviving work\n");
  await git(b.root, "add", "b.txt");
  await git(b.root, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "Save survivor");
  await git(b.root, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "merge", "--no-ff", "--no-edit", sourceHead);
  const devBefore = (await f.taskGitWorkspaces.prepareDev(f.primary)).headCommit;
  await assert.rejects(f.status(b.task.id, "testing", "combined-test"), {
    code: "RELEASE_NATIVE_HISTORY_REQUIRED",
  });
  assert.equal(f.taskBoard.lifecycleTransition("combined-test").phase, "failed");
  assert.equal(await git(f.primary, "rev-parse", "dev"), devBefore);
  await assert.rejects(f.lifecycle.complete({ taskId: a.task.id, absorbedIntoTaskId: b.task.id,
    operationId: "unreviewed-combined-close" }), /Surviving Task must be open and tested/u);
  assert.notEqual(f.taskBoard.task(a.task.id).status, "done");
  assert.equal(await git(f.primary, "rev-parse", sourceBranch), sourceHead);
  assert.equal(await git(a.root, "rev-parse", "HEAD"), sourceHead);
  assert.equal(await readFile(path.join(a.root, "a.txt"), "utf8"), "source work\n");
});

test("combined closure rejects missing source commits, dirty work and a separate source integration", async (t) => {
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
  const sourceHead = await git(a.root, "rev-parse", "HEAD");
  const targetBefore = await git(b.root, "rev-parse", "HEAD");
  const sourceBefore = f.taskBoard.task(a.task.id);
  await git(b.root, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "merge", "--no-ff", "--no-edit", sourceHead);
  const combinedHead = await git(b.root, "rev-parse", "HEAD");
  await assert.rejects(f.lifecycle.complete(options), /Surviving Task changed after Test/u);
  // Known managed dev ancestry is valid for Test preview, but does not prove absorption.
  const tested = await f.status(b.task.id, "testing", "test-combined");
  assert.equal(tested.task.gitReferences[0].resultCommit, combinedHead);
  assert.equal(await git(b.root, "show", "-s", "--format=%P", combinedHead), `${targetBefore} ${sourceHead}`);
  assert.equal(await git(b.root, "show", `${combinedHead}:a.txt`), "A");
  assert.equal(await git(b.root, "show", `${combinedHead}:b.txt`), "B");
  await assert.rejects(f.lifecycle.complete(options), /Source Task still has a separate dev integration/u);
  assert.deepEqual(f.taskBoard.task(a.task.id), sourceBefore);
  assert.equal(f.taskBoard.lifecycleOutcome(options.operationId), null);
  await writeFile(path.join(a.root, "unfinished.txt"), "unsaved\n");
  await assert.rejects(f.lifecycle.complete(options), /Save the source/);
  assert.notEqual(f.taskBoard.task(a.task.id).status, "done");
});

for (const [owner, change] of [["source", "dirty"], ["source", "commit"],
  ["survivor", "dirty"], ["survivor", "commit"]]) {
  test(`unreviewed absorption preserves ${owner} ${change} work`, async t => {
    const f = await fixture(t), source = await f.create("Source"), survivor = await f.create("Survivor");
    for (const [task, file] of [[source, "source.txt"], [survivor, "survivor.txt"]]) {
      await writeFile(path.join(task.root, file), "saved work\n");
      await git(task.root, "add", file);
      await git(task.root, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "Save work");
    }
    await git(survivor.root, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "merge", "--no-ff", "--no-edit",
      await git(source.root, "rev-parse", "HEAD"));
    const changed = owner === "source" ? source : survivor;
    await writeFile(path.join(changed.root, "late.txt"), "late work\n");
    if (change === "commit") {
      await git(changed.root, "add", "late.txt");
      await git(changed.root, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "Late work");
    }
    const sourceBefore = f.taskBoard.task(source.task.id);
    const head = await git(changed.root, "rev-parse", "HEAD");
    const dev = await f.taskGitWorkspaces.prepareDev(f.primary);
    await assert.rejects(f.status(survivor.task.id, "testing", "unreviewed-survivor"), { code: "RELEASE_NATIVE_HISTORY_REQUIRED" });
    await assert.rejects(f.lifecycle.complete({ taskId: source.task.id, absorbedIntoTaskId: survivor.task.id,
      operationId: "unreviewed-close" }), /Surviving Task must be open and tested/u);
    assert.deepEqual(f.taskBoard.task(source.task.id), sourceBefore);
    assert.equal(f.taskBoard.lifecycleTransition("unreviewed-survivor").phase, "failed");
    assert.equal(f.taskBoard.lifecycleOutcome("unreviewed-close"), null);
    assert.equal(await git(f.primary, "rev-parse", "dev"), dev.headCommit);
    const currentHead = await git(changed.root, "rev-parse", "HEAD");
    if (owner === "survivor" && change === "dirty") {
      // Ordinary Test saves the owned Task snapshot before refusing its foreign merge history.
      await git(changed.root, "merge-base", "--is-ancestor", head, currentHead);
    } else assert.equal(currentHead, head);
    assert.equal(await readFile(path.join(changed.root, "late.txt"), "utf8"), "late work\n");
  });
}

test("a sibling branch cannot hide an unapproved upstream merge", async (t) => {
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
  await assert.rejects(f.status(b.task.id, "testing", "unapproved-combined"), { code: "RELEASE_NATIVE_HISTORY_REQUIRED" });
  assert.equal(await git(f.primary, "rev-parse", "dev"), before);
});

test("an accepted prerequisite remains available to its dependent during correction", async (t) => {
  const f = await fixture(t);
  const a = await f.create("Prerequisite"), b = await f.create("Dependent");
  await writeFile(path.join(a.root, "a.txt"), "A\n");
  const tested = await f.status(a.task.id, "testing", "test-a");
  await git(b.root, "merge", "--ff-only", tested.task.gitReferences[0].resultCommit);
  await writeFile(path.join(b.root, "b.txt"), "B\n");
  await f.status(b.task.id, "testing", "test-b");
  await f.lifecycle.updateWorkflowStatus({ taskId: b.task.id, status: "blocked", operationId: "block-b",
    operationEvidence: { blockedBy: { taskId: a.task.id, resultCommit: tested.task.gitReferences[0].resultCommit } } });
  await f.taskGitWorkspaces.prepare({ taskId: b.task.id, taskNumber: b.task.taskNumber, projectRoot: f.primary });
  await f.status(b.task.id, "in_progress", "resume-b");
  await f.taskGitWorkspaces.prepare({ taskId: b.task.id, taskNumber: b.task.taskNumber, projectRoot: f.primary });
  assert.equal(f.taskBoard.task(b.task.id).workflowStatus, "in_progress");
});

test("a corrected prerequisite remains accepted so its dependent can resume immediately", async (t) => {
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
  await f.status(b.task.id, "in_progress", "early-resume");
  assert.equal(f.taskBoard.task(b.task.id).workflowStatus, "in_progress");
  await git(f.primary, "update-ref", "refs/remotes/origin/main", aCommit);
  f.publish({ generation: "published", revision: aCommit, repositories: [{ root: f.primary, revision: aCommit }] });
  assert.equal(f.taskBoard.task(b.task.id).workflowStatus, "in_progress");
  assert.equal(f.taskBoard.task(b.task.id).blockedBy, undefined);
  const tree = await git(f.primary, "rev-parse", `${aCommit}^{tree}`);
  const laterMain = await git(f.primary, "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
    "commit-tree", tree, "-p", aCommit, "-m", "Later published main");
  await git(f.primary, "update-ref", "refs/remotes/origin/main", laterMain);
  await f.taskGitWorkspaces.prepare({ taskId: b.task.id, taskNumber: b.task.taskNumber, projectRoot: f.primary });
});

test("correction does not cascade into a dependent accepted Task", async (t) => {
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
  const returnedA = await f.status(a.task.id, "in_progress", "return-a");
  assert.equal(returnedA.acceptedResultPreserved, true);
  assert.equal(f.taskBoard.lifecycleTransition("return-a"), null);
  assert.equal(await git(f.primary, "rev-parse", "dev"), before);
  assert.deepEqual(f.taskBoard.task(b.task.id), bBefore);
  await f.status(b.task.id, "in_progress", "return-b");
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

for (const committed of [false, true]) test(`old conflict keeps immutable accepted code (committed=${committed})`, async (t) => {
  const f = await fixture(t);
  const a = await f.create("A"), b = await f.create("B");
  await writeFile(path.join(a.root, "app.txt"), "A\n");
  const testedA = await f.status(a.task.id, "testing", "test-a");
  await writeFile(path.join(b.root, "app.txt"), "B\n");
  await assert.rejects(f.status(b.task.id, "testing", "conflict-b"), TaskIntegrationConflictError);
  const d1 = await git(f.primary, "rev-parse", "dev");
  const bBefore = await git(b.root, "rev-parse", "HEAD");
  await assert.rejects(git(b.root, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "merge", "--no-commit", d1));
  await writeFile(path.join(b.root, "app.txt"), "A and B\n");
  if (committed) {
    await git(b.root, "add", "app.txt");
    await git(b.root, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "Resolve B");
  }
  await f.status(a.task.id, "in_progress", "return-a");
  const before = await git(f.primary, "rev-parse", "dev");
  assert.equal(before, d1);
  const acceptedA = f.taskBoard.task(a.task.id).gitReferences;
  const resolved = await f.status(b.task.id, "testing", "finish-b");
  const result = resolved.task.gitReferences[0].resultCommit;
  assert.equal(await git(b.root, "show", "-s", "--format=%P", result), `${bBefore} ${d1}`);
  assert.equal(await git(b.root, "show", `${result}:app.txt`), "A and B");
  assert.equal(await git(f.primary, "show", `${testedA.task.gitReferences[0].resultCommit}:app.txt`), "A");
  assert.deepEqual(f.taskBoard.task(a.task.id).gitReferences, acceptedA);
  await git(f.primary, "merge-base", "--is-ancestor", before, "dev");
  await git(f.primary, "merge-base", "--is-ancestor", testedA.task.gitReferences[0].resultCommit, "dev");
});

test("correction leaves another Task pending operation untouched", async (t) => {
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
  const returned = await f.status(a.task.id, "in_progress", "return-a");
  assert.equal(returned.acceptedResultPreserved, true);
  assert.equal(f.taskBoard.lifecycleTransition("return-a"), null);
  assert.equal(f.taskBoard.lifecycleTransition("foreign-b").phase, "pending_git");
  assert.equal(await git(f.primary, "rev-parse", "dev"), before);
});
