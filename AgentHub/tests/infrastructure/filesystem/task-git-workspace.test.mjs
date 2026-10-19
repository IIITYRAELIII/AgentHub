import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
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
import { taskRepositoryKey } from "../../../src/domain/task-git-reference.mjs";

const execFileAsync = promisify(execFile);

for (const advancedRemote of [false, true]) test(`combined Tasks accept published ancestry with advanced remote=${advancedRemote} and reject unproven history`, { timeout: 90_000 }, async (context) => {
  const root = await repository(context);
  const originalMain = await git(root, "rev-parse", "main");
  const dataDir = path.join(root, "..", `${path.basename(root)}-published-history`);
  context.after(() => rm(dataDir, { recursive: true, force: true }));
  let publication = null;
  const service = new TaskGitWorkspaceService({ dataDir, readPublication: async () => publication });
  const a = await service.prepare({ taskId: "14141414-1414-4414-8414-141414141414", projectRoot: root });
  const b = await service.prepare({ taskId: "15151515-1515-4515-8515-151515151515", projectRoot: root });
  const commit = async (cwd, message) => {
    await git(cwd, "add", ".");
    await git(cwd, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", message);
  };
  await git(root, "checkout", "-b", "published-feature");
  await writeFile(path.join(root, "published.txt"), "already published\n");
  await commit(root, "published feature");
  await git(root, "checkout", "-b", "publication", "main");
  await git(root, "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
    "merge", "--no-ff", "published-feature", "-m", "publication");
  const published = await git(root, "rev-parse", "HEAD");
  await git(root, "checkout", "main");
  await git(root, "update-ref", "refs/remotes/origin/main", published);
  for (const workspace of [a, b]) await git(workspace.projectRoot, "merge", "--ff-only", published);
  await writeFile(path.join(a.projectRoot, "a.txt"), "A\n");
  await commit(a.projectRoot, "A result");
  await writeFile(path.join(b.projectRoot, "b.txt"), "B\n");
  await commit(b.projectRoot, "B result");
  await git(b.projectRoot, "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
    "merge", "--no-ff", a.branch, "-m", "combine A");
  const snapshot = await service.snapshot({ taskId: b.taskId, projectRoot: b.projectRoot });
  const devBefore = (await service.prepareDev(root)).headCommit;
  for (const invalid of [null, { revision: published },
    { generation: "g", repositories: [{ root: path.join(root, "foreign"), revision: published }] },
    { generation: "g", repositories: [{ root, revision: originalMain }] }]) {
    publication = invalid;
    await assert.rejects(service.mergeIntoDev(snapshot), (error) => error.code === "RELEASE_NATIVE_HISTORY_REQUIRED");
    assert.equal(await git(root, "rev-parse", "dev"), devBefore);
  }
  publication = { generation: "published-generation", repositories: [{ root, revision: published }] };
  await git(root, "update-ref", "refs/remotes/origin/main", originalMain);
  await assert.rejects(service.mergeIntoDev(snapshot), (error) => error.code === "RELEASE_NATIVE_HISTORY_REQUIRED");
  assert.equal(await git(root, "rev-parse", "dev"), devBefore);
  await git(root, "update-ref", "refs/remotes/origin/main", published);
  if (advancedRemote) {
    await git(root, "checkout", "-b", "remote-advance", published);
    await writeFile(path.join(root, "remote-only.txt"), "unapproved newer remote\n");
    await commit(root, "remote advanced after publication");
    await git(root, "update-ref", "refs/remotes/origin/main", "HEAD");
    await git(root, "checkout", "main");
  }
  await assert.rejects(service.mergeIntoDev(snapshot), { code: "RELEASE_NATIVE_HISTORY_REQUIRED" });
  assert.equal(await git(root, "rev-parse", "dev"), devBefore);
  assert.equal(await git(root, "rev-parse", "main"), originalMain);
  assert.equal(await git(root, "status", "--porcelain"), "");
  const acceptedDev = await git(root, "rev-parse", "dev");
  await git(root, "checkout", "-b", "unpublished-foreign", published);
  await writeFile(path.join(root, "foreign.txt"), "not published\n");
  await commit(root, "unpublished foreign change");
  await git(root, "checkout", "main");
  await git(b.projectRoot, "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
    "merge", "--no-ff", "unpublished-foreign", "-m", "unapproved adoption");
  await git(root, "update-ref", "refs/remotes/origin/main", "unpublished-foreign");
  const changed = await service.snapshot({ taskId: b.taskId, projectRoot: b.projectRoot });
  await assert.rejects(service.mergeIntoDev(changed), (error) => error.code === "RELEASE_NATIVE_HISTORY_REQUIRED");
  assert.equal(await git(root, "rev-parse", "dev"), acceptedDev);
  assert.equal(await git(root, "rev-parse", "main"), originalMain);
});

test("combined Task rejects unpublished remote fast-forward inside its first-parent history", { timeout: 90_000 }, async (context) => {
  const root = await repository(context);
  const originalMain = await git(root, "rev-parse", "main");
  const dataDir = path.join(root, "..", `${path.basename(root)}-published-fast-forward`);
  context.after(() => rm(dataDir, { recursive: true, force: true }));
  let publication = null;
  const service = new TaskGitWorkspaceService({ dataDir, readPublication: async () => publication });
  const a = await service.prepare({ taskId: "14141414-1414-4414-8414-141414141414", projectRoot: root });
  const b = await service.prepare({ taskId: "15151515-1515-4515-8515-151515151515", projectRoot: root });
  const commit = async (cwd, message) => {
    await git(cwd, "add", ".");
    await git(cwd, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", message);
  };
  await git(root, "checkout", "-b", "published-feature");
  await writeFile(path.join(root, "published.txt"), "published\n");
  await commit(root, "published feature");
  await git(root, "checkout", "-b", "publication", "main");
  await git(root, "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
    "merge", "--no-ff", "published-feature", "-m", "publication");
  const published = await git(root, "rev-parse", "HEAD");
  await git(root, "checkout", "main");
  await git(root, "checkout", "-b", "remote-advance", published);
  await writeFile(path.join(root, "remote-only.txt"), "unpublished remote\n");
  await commit(root, "remote advance");
  const remote = await git(root, "rev-parse", "HEAD");
  await git(root, "update-ref", "refs/remotes/origin/main", remote);
  await git(root, "checkout", "main");
  await git(a.projectRoot, "merge", "--ff-only", published);
  await git(b.projectRoot, "merge", "--ff-only", remote);
  await writeFile(path.join(a.projectRoot, "a.txt"), "A\n");
  await commit(a.projectRoot, "A result");
  await writeFile(path.join(b.projectRoot, "b.txt"), "B\n");
  await commit(b.projectRoot, "B result");
  await git(b.projectRoot, "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
    "merge", "--no-ff", a.branch, "-m", "combine A");
  const snapshot = await service.snapshot({ taskId: b.taskId, projectRoot: b.projectRoot });
  publication = { generation: "published-generation", repositories: [{ root, revision: published }] };
  const devBefore = (await service.prepareDev(root)).headCommit;
  await assert.rejects(service.mergeIntoDev(snapshot), { code: "RELEASE_NATIVE_HISTORY_REQUIRED" });
  assert.equal(await git(root, "rev-parse", "dev"), devBefore);
  assert.equal(await git(root, "rev-parse", "main"), originalMain);
  await assert.rejects(access(path.join((await service.prepareDev(root)).projectRoot, "remote-only.txt")));
});

for (const coversRemote of [false, true]) test(`published ancestry validates exact receipt coverage of fast-forward remote: ${coversRemote}`, { timeout: 90_000 }, async (context) => {
  const root = await repository(context);
  const originalMain = await git(root, "rev-parse", "main");
  const dataDir = path.join(root, "..", `${path.basename(root)}-receipt-coverage`);
  context.after(() => rm(dataDir, { recursive: true, force: true }));
  let publication = null;
  const service = new TaskGitWorkspaceService({ dataDir, readPublication: async () => publication });
  const b = await service.prepare({ taskId: "16161616-1616-4616-8616-161616161616", projectRoot: root });
  const commit = async (cwd, message) => {
    await git(cwd, "add", ".");
    await git(cwd, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", message);
  };
  await git(root, "checkout", "-b", "published-feature");
  await writeFile(path.join(root, "published.txt"), "published\n");
  await commit(root, "published feature");
  await git(root, "checkout", "-b", "publication", "main");
  await git(root, "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
    "merge", "--no-ff", "published-feature", "-m", "publication");
  const published = await git(root, "rev-parse", "HEAD");
  await git(root, "checkout", "-b", "remote-advance", published);
  await writeFile(path.join(root, "remote-only.txt"), "remote\n");
  await commit(root, "remote advance");
  const remote = await git(root, "rev-parse", "HEAD");
  await git(root, "update-ref", "refs/remotes/origin/main", remote);
  await git(root, "checkout", "-b", "adopted-side", coversRemote ? remote : originalMain);
  await writeFile(path.join(root, "adopted.txt"), "approved side\n");
  await commit(root, "adopted side");
  const adopted = await git(root, "rev-parse", "HEAD");
  await git(root, "checkout", "main");
  await git(b.projectRoot, "merge", "--ff-only", remote);
  await writeFile(path.join(b.projectRoot, "b.txt"), "B\n");
  await commit(b.projectRoot, "B result");
  await git(b.projectRoot, "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
    "merge", "--no-ff", adopted, "-m", "adopt approved side");
  const snapshot = await service.snapshot({ taskId: b.taskId, projectRoot: b.projectRoot });
  const input = { taskId: b.taskId, projectRoot: root, branch: snapshot.branch,
    taskBaseCommit: snapshot.baseCommit, acceptedLocalMainCommit: originalMain,
    adoptedCommit: adopted, snapshotCommit: snapshot.headCommit, requestId: "exact-receipt-coverage" };
  // A previously stored exact receipt must be revalidated when publication is known.
  const receipt = await service.recordExplicitUpstreamAdoption(input);
  publication = { generation: "published-generation", repositories: [{ root, revision: published }] };
  const dev = await service.prepareDev(root);
  if (coversRemote) {
    assert.equal((await service.recordExplicitUpstreamAdoption(input)).recordHash, receipt.recordHash);
    await assert.rejects(service.mergeIntoDev(snapshot), { code: "RELEASE_NATIVE_HISTORY_REQUIRED" });
  } else {
    await assert.rejects(service.recordExplicitUpstreamAdoption(input), /unpublished tracked remote history/u);
    await assert.rejects(service.mergeIntoDev(snapshot), { code: "RELEASE_NATIVE_HISTORY_REQUIRED" });
    assert.equal(await git(root, "rev-parse", "dev"), dev.headCommit);
    await assert.rejects(access(path.join(dev.projectRoot, "remote-only.txt")));
  }
  assert.equal(await git(root, "rev-parse", "main"), originalMain);
});

async function withdrawalFixture(context, { dependent = false } = {}) {
  const root = await repository(context);
  const dataDir = path.join(root, "..", `${path.basename(root)}-withdrawal-data`);
  context.after(() => rm(dataDir, { recursive: true, force: true }));
  let publication = null;
  const service = new TaskGitWorkspaceService({ dataDir, readPublication: async () => publication });
  const a = await service.prepare({ taskId: "abababab-abab-4bab-8bab-abababababab", taskNumber: "HUB-801", projectRoot: root });
  await writeFile(path.join(a.projectRoot, "a.txt"), "first A\n", "utf8");
  const firstA = await service.snapshotAndMerge({ taskId: a.taskId, taskNumber: "HUB-801", projectRoot: a.projectRoot });
  const b = await service.prepare({ taskId: "bcbcbcbc-bcbc-4cbc-8cbc-bcbcbcbcbcbc", taskNumber: "HUB-802", projectRoot: root });
  if (dependent) await git(b.projectRoot, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "merge", dependent === "first-parent" ? "--ff-only" : "--no-ff", firstA.snapshot.headCommit, "-m", "B uses A");
  await writeFile(path.join(b.projectRoot, "b.txt"), "B\n", "utf8");
  const firstB = await service.snapshotAndMerge({ taskId: b.taskId, taskNumber: "HUB-802", projectRoot: b.projectRoot });
  const tasks = [
    { taskId: a.taskId, branch: a.branch, resultCommit: firstA.snapshot.headCommit },
    { taskId: b.taskId, branch: b.branch, resultCommit: firstB.snapshot.headCommit },
  ];
  const withdraw = (workspace, extra = {}) => service.withTaskLock(workspace.taskId, (lease) => service.withdrawResultOwned({
    taskId: workspace.taskId, taskNumber: workspace === a ? "HUB-801" : "HUB-802", projectRoot: root,
    resultCommit: workspace === a ? firstA.snapshot.headCommit : firstB.snapshot.headCommit,
    operationId: `withdraw-${workspace.taskId}`, tasks, lease,
    readWorkflowOutcome: async () => ({ status: "not_committed" }),
    commitWorkflow: async (evidence) => ({ workflowStatus: "in_progress", evidence }),
    ...extra,
  }));
  return { root, service, a, b, firstA, firstB, tasks, withdraw, publish(value) { publication = value; } };
}

test("withdrawal removes only its Task and ordinary Test reintegrates its full result", { timeout: 90_000 }, async (context) => {
  const { root, service, a, b, firstA, firstB, withdraw } = await withdrawalFixture(context);
  await writeFile(path.join(a.projectRoot, "unfinished.txt"), "keep my edits\n", "utf8");
  const result = await withdraw(a);
  assert.equal(result.withdrawal.outcome, "withdrawn");
  assert.equal(result.withdrawal.removedIntegrations.length, 1);
  const dev = await service.prepareDev(root);
  await assert.rejects(access(path.join(dev.projectRoot, "a.txt")));
  assert.equal(await readFile(path.join(dev.projectRoot, "b.txt"), "utf8"), "B\n");
  await assert.rejects(git(root, "merge-base", "--is-ancestor", firstA.snapshot.headCommit, "dev"));
  await git(root, "merge-base", "--is-ancestor", firstB.snapshot.headCommit, "dev");
  assert.equal(await readFile(path.join(a.projectRoot, "unfinished.txt"), "utf8"), "keep my edits\n");
  assert.equal(await git(a.projectRoot, "rev-parse", "HEAD"), firstA.snapshot.headCommit);
  assert.equal(await git(b.projectRoot, "rev-parse", "HEAD"), firstB.snapshot.headCommit);
  const tested = await service.snapshotAndMerge({ taskId: a.taskId, taskNumber: "HUB-801", projectRoot: a.projectRoot });
  assert.equal(tested.integration.integrated, true);
  assert.equal(await readFile(path.join(dev.projectRoot, "a.txt"), "utf8"), "first A\n");
  assert.equal(await readFile(path.join(dev.projectRoot, "unfinished.txt"), "utf8"), "keep my edits\n");
  assert.equal(await git(root, "symbolic-ref", "HEAD"), "refs/heads/main");
});

test("withdrawal proves rollback after a rejected lifecycle commit", { timeout: 90_000 }, async (context) => {
  const { root, service, a, b, firstA, withdraw } = await withdrawalFixture(context);
  const before = await git(root, "rev-parse", "dev");
  await assert.rejects(withdraw(a, { commitWorkflow: async () => { throw new Error("CAS rejected"); } }), /CAS rejected/u);
  const dev = await service.prepareDev(root);
  assert.equal(dev.headCommit, before);
  assert.equal(await readFile(path.join(dev.projectRoot, "a.txt"), "utf8"), "first A\n");
  await assert.rejects(withdraw(b, {
    blockedBy: { taskId: a.taskId, resultCommit: firstA.snapshot.headCommit },
    commitWorkflow: async () => { throw new Error("wait CAS rejected"); },
  }), /wait CAS rejected/u);
  await service.prepare({ taskId: b.taskId, taskNumber: "HUB-802", projectRoot: root });
  await withdraw(a);
  const repeated = await service.snapshotAndMerge({ taskId: a.taskId, taskNumber: "HUB-801", projectRoot: a.projectRoot, operationId: "test-after-acknowledged-withdrawal" });
  assert.equal(repeated.snapshot.headCommit, firstA.snapshot.headCommit);
  assert.equal(repeated.integration.integrated, true);
});

test("withdrawal retains ambiguous intent and resumes the same lifecycle without replaying Git", { timeout: 90_000 }, async (context) => {
  const { root, service, a, withdraw } = await withdrawalFixture(context);
  let unknown = false;
  await assert.rejects(withdraw(a, {
    readWorkflowOutcome: async () => ({ status: unknown ? "unknown" : "not_committed" }),
    commitWorkflow: async () => { unknown = true; throw new Error("lost database reply"); },
  }), (error) => error.code === "TASK_WITHDRAWAL_UNKNOWN");
  const changed = await git(root, "rev-parse", "dev");
  assert.equal(await service.pendingWithdrawal({ projectRoot: root, taskId: a.taskId, operationId: `withdraw-${a.taskId}` }), true);
  await assert.rejects(service.pendingWithdrawal({ projectRoot: root, taskId: a.taskId, operationId: "foreign-operation" }), /identity does not match/u);
  await assert.rejects(service.prepareDev(root), /withdrawal .* requires exact lifecycle reconciliation/u);
  const resumed = await withdraw(a, {
    readWorkflowOutcome: async () => ({ status: "committed", result: { workflowStatus: "in_progress" } }),
    commitWorkflow: async () => { throw new Error("must not replay committed lifecycle"); },
  });
  assert.equal(resumed.workflow.workflowStatus, "in_progress");
  assert.equal((await service.prepareDev(root)).headCommit, changed);
  assert.equal(await service.pendingWithdrawal({ projectRoot: root, taskId: a.taskId, operationId: `withdraw-${a.taskId}` }), false);
});

test("withdrawal does not discard unidentified dev contributions", { timeout: 90_000 }, async (context) => {
  const { root, service, a, withdraw } = await withdrawalFixture(context);
  const before = await git(root, "rev-parse", "dev");
  await assert.rejects(withdraw(a, { tasks: [] }), /no unique Task owner/u);
  assert.equal(await git(root, "rev-parse", "dev"), before);
  const dev = await service.prepareDev(root);
  await writeFile(path.join(dev.projectRoot, "unknown.txt"), "unknown contribution\n", "utf8");
  await git(dev.projectRoot, "add", "unknown.txt");
  await git(dev.projectRoot, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "unowned direct change");
  const unknownHead = await git(root, "rev-parse", "dev");
  await assert.rejects(withdraw(a), /cannot attribute non-Task integration/u);
  assert.equal(await git(root, "rev-parse", "dev"), unknownHead);
  assert.equal(await readFile(path.join(dev.projectRoot, "unknown.txt"), "utf8"), "unknown contribution\n");
});

test("an unseparable manual integration is not misreported as a dependent Task to withdraw", { timeout: 90_000 }, async (context) => {
  const { root, service, a, withdraw } = await withdrawalFixture(context);
  const dev = await service.prepareDev(root);
  await writeFile(path.join(dev.projectRoot, "manual.txt"), "preserve manual resolution\n", "utf8");
  await git(dev.projectRoot, "add", "manual.txt");
  await git(dev.projectRoot, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--amend", "--no-edit");
  const before = await git(root, "rev-parse", "dev");
  await assert.rejects(withdraw(a), (error) => /manual dev resolution/u.test(error.message)
    && error.code !== "TASK_WITHDRAWAL_DEPENDENCY");
  assert.equal(await git(root, "rev-parse", "dev"), before);
  assert.equal(await readFile(path.join(dev.projectRoot, "manual.txt"), "utf8"), "preserve manual resolution\n");
});

test("withdrawing a Task based on another result preserves that ancestor Task", { timeout: 90_000 }, async (context) => {
  const { root, service, a, b, firstA, withdraw } = await withdrawalFixture(context, { dependent: "first-parent" });
  await withdraw(b, { blockedBy: { taskId: a.taskId, resultCommit: firstA.snapshot.headCommit } });
  const dev = await service.prepareDev(root);
  assert.equal(await readFile(path.join(dev.projectRoot, "a.txt"), "utf8"), "first A\n");
  await assert.rejects(access(path.join(dev.projectRoot, "b.txt")));
  await git(root, "merge-base", "--is-ancestor", firstA.snapshot.headCommit, "dev");
});

test("dependent Task withdraws first and waits for proven publication before claim or Test", { timeout: 90_000 }, async (context) => {
  const { root, service, a, b, firstA, tasks, withdraw, publish } = await withdrawalFixture(context, { dependent: "first-parent" });
  const before = await git(root, "rev-parse", "dev");
  await assert.rejects(withdraw(a), (error) => error.code === "TASK_WITHDRAWAL_DEPENDENCY" && error.blockedTaskIds[0] === b.taskId);
  assert.equal(await git(root, "rev-parse", "dev"), before);
  await withdraw(b, { blockedBy: { taskId: a.taskId, resultCommit: firstA.snapshot.headCommit } });
  await withdraw(a, { tasks: tasks.filter((item) => item.taskId !== b.taskId) });
  await assert.rejects(service.prepare({ taskId: b.taskId, taskNumber: "HUB-802", projectRoot: root }), (error) => error.code === "TASK_AWAITING_DEPENDENCY_RELEASE");
  await assert.rejects(service.snapshotAndMerge({ taskId: b.taskId, taskNumber: "HUB-802", projectRoot: b.projectRoot }), (error) => error.code === "TASK_AWAITING_DEPENDENCY_RELEASE");
  await git(root, "update-ref", "refs/remotes/origin/main", firstA.snapshot.headCommit);
  await assert.rejects(service.prepare({ taskId: b.taskId, taskNumber: "HUB-802", projectRoot: root }), (error) => error.code === "TASK_AWAITING_DEPENDENCY_RELEASE");
  publish({ generation: "publication-A", revision: firstA.snapshot.headCommit });
  await assert.rejects(service.prepare({ taskId: b.taskId, taskNumber: "HUB-802", projectRoot: root }), (error) => error.code === "TASK_AWAITING_DEPENDENCY_RELEASE");
  publish({ generation: "publication-A", revision: firstA.snapshot.headCommit, repositories: [{ root, revision: firstA.snapshot.headCommit }] });
  const prepared = await service.prepare({ taskId: b.taskId, taskNumber: "HUB-802", projectRoot: root });
  assert.equal(prepared.taskId, b.taskId);
  const preview = await service.cleanupPreview(b.taskId);
  assert.equal(preview.deleting.some((item) => item.kind === "release_wait_ref"), true);
  await service.cleanup(b.taskId);
  assert.equal(await git(root, "for-each-ref", "--format=%(refname)", `refs/agent-hub/task-release-waits/${b.taskId}`), "");
});

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

test("Task Git preview includes committed, staged and untracked work without changing refs or index", { timeout: 60_000 }, async (context) => {
  const root = await repository(context);
  const dataDir = path.join(root, "..", path.basename(root) + "-review-data");
  context.after(() => rm(dataDir, { recursive: true, force: true }));
  const service = new TaskGitWorkspaceService({ dataDir });
  const taskId = "bcbcbcbc-bcbc-4cbc-8cbc-bcbcbcbcbcbc";
  const taskNumber = "HUB-955";
  const workspace = await service.prepare({ taskId, taskNumber, projectRoot: root });
  await writeFile(path.join(workspace.projectRoot, "committed.txt"), "committed\n");
  await git(workspace.projectRoot, "add", "committed.txt");
  await git(workspace.projectRoot, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "work");
  await writeFile(path.join(workspace.projectRoot, "app.txt"), "staged\n");
  await git(workspace.projectRoot, "add", "app.txt");
  await writeFile(path.join(workspace.projectRoot, "new file.txt"), "untracked\n");
  const before = await git(root, "show-ref");
  const index = await git(workspace.projectRoot, "write-tree");
  const preview = await service.reviewDiff({ taskId, taskNumber });
  assert.equal(preview.truncated, false);
  const text = preview.repositories[0].text;
  assert.match(text, /committed\.txt/u);
  assert.match(text, /\+staged/u);
  assert.match(text, /new file\.txt/u);
  assert.match(text, /\+untracked/u);
  assert.equal(await git(root, "show-ref"), before);
  assert.equal(await git(workspace.projectRoot, "write-tree"), index);
  await assert.rejects(service.reviewDiff({ taskId, taskNumber: "HUB-999" }), /не принадлежит/u);
  await writeFile(path.join(workspace.projectRoot, "app.txt"), "x".repeat(100_000));
  const large = await service.reviewDiff({ taskId, taskNumber });
  assert.equal(large.truncated, true);
  assert.ok(Buffer.byteLength(large.repositories[0].text) <= 64 * 1024);
});

test("release service closure proves exact published manifest and Done result without deleting its worktree", { timeout: 90_000 }, async (context) => {
  const { root } = await repositoryWithOrigin(context);
  const dataDir = path.join(root, "..", `${path.basename(root)}-release-service-data`);
  context.after(() => rm(dataDir, { recursive: true, force: true }));
  let publication = null;
  const service = new TaskGitWorkspaceService({ dataDir, readPublication: async () => publication });
  const source = await service.prepare({
    taskId: "11111111-1111-4111-8111-111111111111", taskNumber: "HUB-252", projectRoot: root,
  });
  const selectedWorkspace = await service.prepare({
    taskId: "22222222-2222-4222-8222-222222222222", taskNumber: "HUB-245", projectRoot: root,
  });
  await writeFile(path.join(selectedWorkspace.projectRoot, "release.txt"), "published\n", "utf8");
  const selectedResult = await service.snapshotAndMerge({ taskId: selectedWorkspace.taskId,
    taskNumber: "HUB-245", projectRoot: selectedWorkspace.projectRoot });
  await git(root, "merge", "--ff-only", selectedResult.snapshot.headCommit);
  await git(root, "push", "origin", "main");
  await git(root, "update-ref", "refs/remotes/origin/main", selectedResult.snapshot.headCommit);
  const repositoryKey = taskRepositoryKey(root);
  const manifest = { workspaceId: "workspace-1", planRevision: "plan-1", tasks: [{
    taskId: selectedWorkspace.taskId, resultCommit: selectedResult.snapshot.headCommit,
  }] };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest)}\n`);
  const manifestHash = createHash("sha256").update(manifestBytes).digest("hex");
  const evidenceRoot = path.join(dataDir, "release-repositories", repositoryKey, "evidence");
  await mkdir(evidenceRoot, { recursive: true });
  await writeFile(path.join(evidenceRoot, `${manifestHash}.json`), manifestBytes);
  publication = { generation: "published-generation", repositories: [{ root,
    revision: selectedResult.snapshot.headCommit, planRevision: "plan-1", manifestHash }] };
  const sourceTask = { id: source.taskId, taskNumber: "HUB-252", revision: 4,
    workspaceId: "workspace-1", gitReferences: [] };
  const selectedTask = { id: selectedWorkspace.taskId, revision: 5, workspaceId: "workspace-1",
    status: "done", workflowStatus: "done", gitReferences: [{ projectRoot: root,
      resultCommit: selectedResult.snapshot.headCommit }] };
  const proof = await service.withTaskLock(source.taskId, (lease) => (
    service.publishedReleaseServiceEvidenceOwned({ source: sourceTask, selectedTasks: [selectedTask], lease })
  ));
  assert.equal(proof.publishedRevision, selectedResult.snapshot.headCommit);
  assert.equal(proof.manifestHash, manifestHash);
  assert.deepEqual(proof.cleanupPlan.deleting, []);
  assert.equal((await service.describe(source.taskId)).length, 1);

  await assert.rejects(service.withTaskLock(source.taskId, (lease) => (
    service.publishedReleaseServiceEvidenceOwned({ source: sourceTask,
      selectedTasks: [{ ...selectedTask, gitReferences: [{ projectRoot: root,
        resultCommit: "f".repeat(40) }] }], lease })
  )), /does not match exact published Done results/u);
  await writeFile(path.join(source.projectRoot, "valuable.txt"), "preserve\n", "utf8");
  await assert.rejects(service.withTaskLock(source.taskId, (lease) => (
    service.publishedReleaseServiceEvidenceOwned({ source: sourceTask, selectedTasks: [selectedTask], lease })
  )), /clean managed worktree/u);
});

test("published duplicate proof requires exact clean published main and survivor lineage", { timeout: 90_000 }, async (context) => {
  const { root } = await repositoryWithOrigin(context);
  const dataDir = path.join(root, "..", `${path.basename(root)}-published-duplicate-data`);
  context.after(() => rm(dataDir, { recursive: true, force: true }));
  let publication = null;
  const service = new TaskGitWorkspaceService({ dataDir, readPublication: async () => publication });
  const source = await service.prepare({
    taskId: "11111111-1111-4111-8111-111111111111", taskNumber: "HUB-241", projectRoot: root,
  });
  const survivorWorkspace = await service.prepare({
    taskId: "22222222-2222-4222-8222-222222222222", taskNumber: "HUB-217", projectRoot: root,
  });
  await writeFile(path.join(survivorWorkspace.projectRoot, "published.txt"), "published fix\n", "utf8");
  const tested = await service.snapshotAndMerge({
    taskId: survivorWorkspace.taskId, taskNumber: "HUB-217", projectRoot: survivorWorkspace.projectRoot,
  });
  await git(root, "merge", "--ff-only", tested.snapshot.headCommit);
  await git(root, "push", "origin", "main");
  await git(root, "update-ref", "refs/remotes/origin/main", tested.snapshot.headCommit);
  await git(source.projectRoot, "merge", "--ff-only", tested.snapshot.headCommit);
  publication = {
    generation: "release-published-duplicate",
    repositories: [{ root, revision: tested.snapshot.headCommit }],
  };
  const sourceTask = {
    id: source.taskId, taskNumber: "HUB-241", revision: 6,
    gitReferences: [], gitAdoptions: [],
  };
  const targetTask = {
    id: survivorWorkspace.taskId, taskNumber: "HUB-217", revision: 93,
    gitReferences: [{
      projectRoot: root,
      branch: survivorWorkspace.branch,
      resultCommit: tested.snapshot.headCommit,
    }],
  };
  const proof = await service.withTaskLocks([source.taskId, survivorWorkspace.taskId], (lease) => (
    service.withPublishedDuplicateEvidenceOwned({ source: sourceTask, target: targetTask, lease },
      async (evidence) => evidence)
  ));
  assert.equal(proof.mode, "published_duplicate");
  assert.equal(proof.repositories[0].sourceHead, tested.snapshot.headCommit);
  assert.equal(proof.repositories[0].survivorResult, tested.snapshot.headCommit);
  assert.deepEqual(proof.cleanupPlan, { strategy: "preserve_managed_source", deleting: [] });

  await writeFile(path.join(source.projectRoot, "valuable-untracked.txt"), "preserve\n", "utf8");
  await assert.rejects(service.withTaskLocks([source.taskId, survivorWorkspace.taskId], (lease) => (
    service.withPublishedDuplicateEvidenceOwned({ source: sourceTask, target: targetTask, lease }, async () => null)
  )), /clean source Task worktree/u);
  await rm(path.join(source.projectRoot, "valuable-untracked.txt"));

  const unpublishedTarget = { ...targetTask, gitReferences: [{
    ...targetTask.gitReferences[0], resultCommit: "f".repeat(40),
  }] };
  await assert.rejects(service.withTaskLocks([source.taskId, survivorWorkspace.taskId], (lease) => (
    service.withPublishedDuplicateEvidenceOwned({ source: sourceTask, target: unpublishedTarget, lease }, async () => null)
  )), /not contained in published main/u);

  await writeFile(path.join(source.projectRoot, "unique.txt"), "unique\n", "utf8");
  await git(source.projectRoot, "add", "unique.txt");
  await git(source.projectRoot, "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
    "commit", "-m", "unique source work");
  await assert.rejects(service.withTaskLocks([source.taskId, survivorWorkspace.taskId], (lease) => (
    service.withPublishedDuplicateEvidenceOwned({ source: sourceTask, target: targetTask, lease }, async () => null)
  )), /HEAD must equal exact durable local and origin published main/u);
});

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

async function reviewedDevBootstrapFixture(context, {
  ambiguousProof = false,
  missingProof = false,
  modeMismatch = false,
  authorize = true,
} = {}) {
  const { root, origin } = await repositoryWithOrigin(context);
  await writeFile(path.join(root, "CHANGELOG.md"), "base entry\n", "utf8");
  await git(root, "add", "CHANGELOG.md");
  await git(root, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "base changelog");
  await git(root, "push", "origin", "main");
  const dataDir = path.join(root, "..", `${path.basename(root)}-bootstrap-data`);
  context.after(() => rm(dataDir, { recursive: true, force: true }));
  const service = new TaskGitWorkspaceService({ dataDir });
  const workspace = await service.prepare({
    taskId: "51515151-5151-4151-8151-515151515151",
    projectRoot: root,
  });
  const dev = await service.prepareDev(root);
  await writeFile(path.join(dev.projectRoot, "app.txt"), "dev accepted\n", "utf8");
  await writeFile(path.join(dev.projectRoot, "dev-only.txt"), "dev only\n", "utf8");
  await writeFile(path.join(dev.projectRoot, "CHANGELOG.md"), "base entry\ndev entry\n", "utf8");
  await git(dev.projectRoot, "add", "app.txt", "dev-only.txt", "CHANGELOG.md");
  await git(dev.projectRoot, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "accepted dev");
  const oldDev = await git(dev.projectRoot, "rev-parse", "HEAD^{commit}");
  const mainCommit = await advanceOriginMain(context, origin, {
    "app.txt": "published main\n",
    "main-only.txt": "main only\n",
    "CHANGELOG.md": "base entry\nmain entry\n",
  });
  await git(workspace.projectRoot, "fetch", "--no-tags", "origin", "main");
  await writeFile(path.join(workspace.projectRoot, "app.txt"), "dev accepted\n", "utf8");
  await writeFile(path.join(workspace.projectRoot, "dev-only.txt"), "dev only\n", "utf8");
  await writeFile(path.join(workspace.projectRoot, "task-only.txt"), "task only\n", "utf8");
  await writeFile(path.join(workspace.projectRoot, "CHANGELOG.md"), "base entry\ndev entry\n", "utf8");
  await git(workspace.projectRoot, "add", "--sparse", "app.txt", "dev-only.txt", "task-only.txt", "CHANGELOG.md");
  if (modeMismatch) await git(workspace.projectRoot, "update-index", "--chmod=+x", "app.txt");
  await git(workspace.projectRoot, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "Task union basis");
  const taskParent = await git(workspace.projectRoot, "rev-parse", "HEAD^{commit}");
  await assert.rejects(git(workspace.projectRoot, "merge", "--no-ff", "--no-commit", mainCommit));
  await writeFile(path.join(workspace.projectRoot, "app.txt"), ambiguousProof ? "dev accepted\n" : "reviewed union\n", "utf8");
  await writeFile(
    path.join(workspace.projectRoot, "CHANGELOG.md"),
    "base entry\ndev entry\nmain entry\n",
    "utf8",
  );
  await git(workspace.projectRoot, "add", "--sparse", "app.txt", "CHANGELOG.md");
  if (modeMismatch) await git(workspace.projectRoot, "update-index", "--chmod=-x", "app.txt");
  const reviewedTree = await git(workspace.projectRoot, "write-tree");
  await git(workspace.projectRoot, "merge", "--abort");
  let proofCommit = null;
  if (!missingProof) {
    proofCommit = await git(
      workspace.projectRoot,
      "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
      "commit-tree", reviewedTree, "-p", taskParent, "-p", mainCommit, "-m", "reviewed main proof",
    );
    if (ambiguousProof) {
      proofCommit = await git(
        workspace.projectRoot,
        "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
        "commit-tree", reviewedTree, "-p", proofCommit, "-p", mainCommit, "-m", "duplicate main proof",
      );
    }
  }
  const snapshotParents = missingProof ? [taskParent, mainCommit, oldDev] : [proofCommit, oldDev];
  const snapshotCommit = await git(
    workspace.projectRoot,
    "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
    "commit-tree", reviewedTree,
    ...snapshotParents.flatMap((parent) => ["-p", parent]),
    "-m", "reviewed Task snapshot",
  );
  await git(workspace.projectRoot, "update-ref", "HEAD", snapshotCommit, taskParent);
  await git(workspace.projectRoot, "reset", "--hard", snapshotCommit);
  const snapshot = await service.snapshot({ taskId: workspace.taskId, projectRoot: workspace.projectRoot });
  const localMain = await git(root, "rev-parse", "refs/heads/main^{commit}");
  const adoption = authorize && !missingProof && !ambiguousProof
    ? await service.recordExplicitUpstreamAdoption({
      taskId: workspace.taskId,
      projectRoot: root,
      branch: snapshot.branch,
      taskBaseCommit: snapshot.baseCommit,
      acceptedLocalMainCommit: localMain,
      adoptedCommit: mainCommit,
      snapshotCommit: snapshot.headCommit,
      requestId: "test-reviewed-upstream-adoption",
    })
    : null;
  return {
    root, dataDir, service, workspace, snapshot, oldDev, mainCommit, proofCommit, reviewedTree, adoption,
    devRoot: dev.projectRoot,
  };
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

test("repeated Test reuses only the clean exact result still integrated into dev", async (context) => {
  const root = await repository(context);
  const dataDir = path.join(root, "..", `${path.basename(root)}-repeat-data`);
  context.after(() => rm(dataDir, { recursive: true, force: true }));
  const service = new TaskGitWorkspaceService({ dataDir });
  const taskId = "31313131-3131-4131-8131-313131313131";
  const workspace = await service.prepare({ taskId, projectRoot: root });
  await writeFile(path.join(workspace.projectRoot, "app.txt"), "tested\n", "utf8");
  const firstStarted = performance.now();
  const first = await service.snapshotAndMerge({ taskId, projectRoot: workspace.projectRoot });
  const firstDuration = performance.now() - firstStarted;
  let snapshots = 0;
  let merges = 0;
  const snapshotOwned = service.snapshotOwned.bind(service);
  const mergeIntoDevOwned = service.mergeIntoDevOwned.bind(service);
  service.snapshotOwned = (...args) => { snapshots += 1; return snapshotOwned(...args); };
  service.mergeIntoDevOwned = (...args) => { merges += 1; return mergeIntoDevOwned(...args); };
  const nestedRoot = path.join(workspace.projectRoot, "nested");
  await mkdir(nestedRoot);
  const repeatInput = { taskId, projectRoot: nestedRoot,
    expectedResultReferences: [{ projectRoot: root, resultCommit: first.snapshot.headCommit }] };

  const repeatStarted = performance.now();
  const repeated = await service.snapshotAndMerge(repeatInput);
  context.diagnostic(`First Test ${Math.round(firstDuration)} ms; unchanged repeat ${Math.round(performance.now() - repeatStarted)} ms`);
  assert.equal(repeated.integration.reusedResult, true);
  assert.equal(repeated.integration.resultProved, true);
  assert.deepEqual(repeated.snapshot, { ...first.snapshot, projectRoot: nestedRoot });
  assert.equal(repeated.integration.dev.headCommit, first.integration.dev.headCommit);
  assert.equal(snapshots, 0);
  assert.equal(merges, 0);

  // A lost dev integration cannot be reused merely because the Task's HEAD is unchanged.
  await git(first.integration.dev.projectRoot, "reset", "--hard", workspace.baseCommit);
  const restored = await service.snapshotAndMerge(repeatInput);
  assert.notEqual(restored.integration.reusedResult, true);
  assert.equal(restored.integration.integrated, true);
  assert.equal(snapshots, 1);
  assert.equal(merges, 1);
  assert.equal(await readFile(path.join(restored.integration.dev.projectRoot, "app.txt"), "utf8"), "tested\n");
});

test("repeated Test snapshots new staged, unstaged, untracked and committed work", async (context) => {
  const root = await repository(context);
  const dataDir = path.join(root, "..", `${path.basename(root)}-repeat-dirty-data`);
  context.after(() => rm(dataDir, { recursive: true, force: true }));
  const service = new TaskGitWorkspaceService({ dataDir });
  const taskId = "32323232-3232-4232-8232-323232323232";
  const workspace = await service.prepare({ taskId, projectRoot: root });
  await writeFile(path.join(workspace.projectRoot, "app.txt"), "tested\n", "utf8");
  let prior = await service.snapshotAndMerge({ taskId, projectRoot: workspace.projectRoot });
  for (const kind of ["unstaged", "staged", "untracked", "committed"]) {
    const file = kind === "untracked" ? "new.txt" : "app.txt";
    await writeFile(path.join(workspace.projectRoot, file), `${kind}\n`, "utf8");
    if (kind === "staged" || kind === "committed") await git(workspace.projectRoot, "add", file);
    if (kind === "committed") {
      await git(workspace.projectRoot, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", kind);
    }
    const result = await service.snapshotAndMerge({
      taskId, projectRoot: workspace.projectRoot, expectedResultCommit: prior.snapshot.headCommit,
    });
    assert.notEqual(result.integration.reusedResult, true, kind);
    assert.notEqual(result.snapshot.headCommit, prior.snapshot.headCommit, kind);
    assert.equal(result.integration.integrated, true, kind);
    assert.equal(await readFile(path.join(result.integration.dev.projectRoot, file), "utf8"), `${kind}\n`, kind);
    prior = result;
  }
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
    baseCommit: result.snapshot.baseCommit,
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

test("a foreign live repository guard waits for the shared dev lock and then admits", async (context) => {
  const root = await repository(context);
  const dataDir = path.join(root, "..", `${path.basename(root)}-live-guard-data`);
  context.after(() => rm(dataDir, { recursive: true, force: true }));
  let releaseOwner;
  const ownerReleased = new Promise((resolve) => { releaseOwner = resolve; });
  let reportOwnerEntered;
  const ownerEntered = new Promise((resolve) => { reportOwnerEntered = resolve; });
  let held = false;
  const owner = new TaskGitWorkspaceService({
    dataDir,
    runCommand: async (args, options) => {
      if (!held && args[0] === "update-ref" && args[1] === "--stdin") {
        held = true;
        reportOwnerEntered();
        await ownerReleased;
      }
      return runTaskGitCommand(args, options);
    },
  });
  const contender = new TaskGitWorkspaceService({ dataDir });
  const ownerTaskId = "31313131-3131-4131-8131-313131313131";
  const contenderTaskId = "32323232-3232-4232-8232-323232323232";
  const ownerPrepare = owner.prepare({ taskId: ownerTaskId, projectRoot: root });
  await ownerEntered;
  const guardDirectory = path.join(dataDir, "task-process-tree-guards", ownerTaskId);
  assert.equal((await readdir(guardDirectory)).length, 1);

  let contenderSettled = false;
  const contenderPrepare = contender.prepare({ taskId: contenderTaskId, projectRoot: root })
    .finally(() => { contenderSettled = true; });
  await wait(100);
  assert.equal(contenderSettled, false);

  releaseOwner();
  const [first, second] = await Promise.all([ownerPrepare, contenderPrepare]);
  assert.equal(first.repositoryRoot, canonicalPath(root));
  assert.equal(second.repositoryRoot, canonicalPath(root));
  assert.equal(await access(guardDirectory).then(() => true, () => false), true);
  assert.deepEqual(await readdir(guardDirectory), []);
});

test("an orphan foreign repository guard remains blocked and yields bounded claim no-effect evidence", async (context) => {
  const root = await repository(context);
  const otherRoot = await repository(context);
  const dataDir = path.join(root, "..", `${path.basename(root)}-orphan-guard-data`);
  context.after(() => rm(dataDir, { recursive: true, force: true }));
  const taskId = "41414141-4141-4141-8141-414141414141";
  const foreignTaskId = "42424242-4242-4242-8242-424242424242";
  const repositoryKey = taskRepositoryKey(root);
  const guardPath = path.join(
    dataDir, "task-process-tree-guards", foreignTaskId, `${repositoryKey}.json`,
  );
  await mkdir(path.dirname(guardPath), { recursive: true });
  await writeFile(guardPath, `${JSON.stringify({ version: 1, repositoryRoot: canonicalPath(root) })}\n`, "utf8");
  const service = new TaskGitWorkspaceService({ dataDir });
  let admissionError;
  await assert.rejects(
    service.prepare({ taskId, projectRoot: root }),
    (error) => {
      admissionError = error;
      assert.equal(error.code, "TASK_GIT_REPOSITORY_GUARD_ADMISSION_NO_EFFECT");
      return /unresolved process-tree guard requires operator proof/u.test(error.message);
    },
  );
  const currentEvidence = await service.claimAdmissionNoEffectEvidence({
    taskId, projectRoot: root, error: admissionError,
  });
  assert.equal(currentEvidence.version, "task-git-repository-guard-under-dev-lock-v2");
  assert.equal(currentEvidence.guardTaskId, foreignTaskId);
  const legacyEvidence = await service.claimAdmissionNoEffectEvidence({
    taskId,
    projectRoot: root,
    error: `mutation effect is not authoritatively disproved: ${admissionError.message}`,
  });
  assert.deepEqual(legacyEvidence, {
    ...currentEvidence,
    version: "task-git-repository-guard-before-dev-lock-v1",
  });
  assert.equal(await service.claimAdmissionNoEffectEvidence({
    taskId, projectRoot: otherRoot, error: `mutation effect is not authoritatively disproved: ${admissionError.message}`,
  }), null);
  assert.equal(await service.claimAdmissionNoEffectEvidence({
    taskId, projectRoot: root, error: admissionError.message,
  }), null);
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

for (const keepWorktree of [true, false]) test(`published cleanup preserves a later branch commit with worktree=${keepWorktree}`, async (context) => {
  const root = await repository(context);
  const published = await git(root, "rev-parse", "HEAD");
  const dataDir = path.join(root, "..", `${path.basename(root)}-cleanup-data`);
  context.after(() => rm(dataDir, { recursive: true, force: true }));
  const service = new TaskGitWorkspaceService({ dataDir,
    readPublication: async () => ({ revision: published, generation: "published" }) });
  const taskId = "30303030-3030-4030-8030-303030303031";
  const workspace = await service.prepare({ taskId, taskNumber: "HUB-903", projectRoot: root });
  await git(root, "update-ref", "refs/remotes/origin/main", published);
  await writeFile(path.join(workspace.projectRoot, "later.txt"), "retain this later commit\n", "utf8");
  await git(workspace.projectRoot, "add", "later.txt");
  await git(workspace.projectRoot, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "Later unpublished work");
  const later = await git(workspace.projectRoot, "rev-parse", "HEAD");
  if (!keepWorktree) await git(root, "worktree", "remove", workspace.projectRoot);
  const references = [{ projectRoot: root, branch: workspace.branch, resultCommit: published }];
  await assert.rejects(service.cleanup(taskId, { requirePublished: true, gitReferences: references }), /not contained in published main/u);
  assert.equal(await git(root, "rev-parse", `refs/heads/${workspace.branch}`), later);
  if (keepWorktree) assert.equal(await readFile(path.join(workspace.projectRoot, "later.txt"), "utf8"), "retain this later commit\n");
});

for (const race of ["none", "branch", "files"]) test(`published cleanup rechecks Git deletion boundaries: ${race}`, async (context) => {
  const root = await repository(context);
  const published = await git(root, "rev-parse", "HEAD");
  const dataDir = path.join(root, "..", `${path.basename(root)}-cleanup-race-data`);
  context.after(() => rm(dataDir, { recursive: true, force: true }));
  let workspace;
  let injected = false;
  let later = null;
  const service = new TaskGitWorkspaceService({ dataDir,
    readPublication: async () => ({ revision: published, generation: "published" }),
    runCommand: async (args, options) => {
      if (!injected && workspace && args[0] === "worktree" && args[1] === "remove" && race !== "none") {
        injected = true;
        await writeFile(path.join(workspace.projectRoot, "late.txt"), "preserve external edit\n", "utf8");
        if (race === "branch") {
          await git(workspace.projectRoot, "add", "late.txt");
          await git(workspace.projectRoot, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "Late commit");
          later = await git(workspace.projectRoot, "rev-parse", "HEAD");
        }
      }
      return runTaskGitCommand(args, options);
    } });
  const taskId = "30303030-3030-4030-8030-303030303032";
  workspace = await service.prepare({ taskId, taskNumber: "HUB-904", projectRoot: root });
  await git(root, "update-ref", "refs/remotes/origin/main", published);
  const references = [{ projectRoot: root, branch: workspace.branch, resultCommit: published }];
  const preview = await service.cleanupPreview(taskId, { gitReferences: references });
  const cleanup = () => service.cleanup(taskId, { requirePublished: true, gitReferences: references, expectedPreview: preview });
  if (race === "none") {
    await cleanup();
    await assert.rejects(access(workspace.projectRoot));
    await assert.rejects(git(root, "rev-parse", "--verify", `refs/heads/${workspace.branch}`));
  } else {
    await assert.rejects(cleanup());
    assert.equal(await git(root, "rev-parse", `refs/heads/${workspace.branch}`), later ?? published);
    if (race === "files") assert.equal(await readFile(path.join(workspace.projectRoot, "late.txt"), "utf8"), "preserve external edit\n");
    else assert.equal(await git(root, "show", `${later}:late.txt`), "preserve external edit");
  }
});

test("cleanup preserves unrecognized files in the managed Task parent", async (context) => {
  const root = await repository(context);
  const dataDir = path.join(root, "..", `${path.basename(root)}-cleanup-parent-data`);
  context.after(() => rm(dataDir, { recursive: true, force: true }));
  const service = new TaskGitWorkspaceService({ dataDir, readPublication: async () => null });
  const taskId = "30303030-3030-4030-8030-303030303033";
  const parent = path.join(service.taskWorktreesRoot, taskId);
  await mkdir(parent, { recursive: true });
  const file = path.join(parent, "unexpected.txt");
  await writeFile(file, "keep", "utf8");
  await assert.rejects(service.cleanup(taskId), /ENOTEMPTY/u);
  assert.equal(await readFile(file, "utf8"), "keep");
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
  let bootTime = new Date("2000-01-01T00:00:00.000Z");
  let removeFailure = true;
  const service = new TaskGitWorkspaceService({
    dataDir,
    readSystemBootIdentity: () => ({
      source: "Win32_OperatingSystem.LastBootUpTime",
      executablePath: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      bootTime: bootTime.toISOString(),
    }),
    removeProcessGuard: async (file) => {
      if (removeFailure) {
        removeFailure = false;
        throw new Error("injected crash after recovery evidence write");
      }
      return unlink(file);
    },
  });
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

  const guardDirectory = path.join(dataDir, "task-process-tree-guards", taskId);
  const guard = JSON.parse(await readFile(path.join(guardDirectory, (await readdir(guardDirectory))[0]), "utf8"));
  await assert.rejects(service.recoverProcessTreeGuard(taskId, {
    repositoryRoot: root,
    guardId: guard.guardId,
    proof: {
      kind: "system-restart-after-guard",
      confirmed: true,
      summary: "boot still predates the guard",
    },
  }), /system boot does not postdate/u);

  process.kill(descendantPid, "SIGKILL");
  descendantPid = null;
  await wait(100);
  bootTime = new Date("2100-01-01T00:00:00.000Z");
  await assert.rejects(service.recoverProcessTreeGuard(taskId, {
    repositoryRoot: root,
    guardId: "wrong-guard",
    proof: {
      kind: "system-restart-after-guard",
      confirmed: true,
      summary: "mismatched guard",
    },
  }), /guard identity does not match/u);
  await assert.rejects(service.recoverProcessTreeGuard(taskId, {
    repositoryRoot: root,
    guardId: guard.guardId,
    proof: {
      kind: "system-restart-after-guard",
      confirmed: true,
      summary: "test fixture boot boundary",
    },
  }), /injected crash after recovery evidence write/u);
  const recoveryDirectory = path.join(dataDir, "task-process-tree-recoveries", taskId);
  const writtenRecovery = JSON.parse(await readFile(
    path.join(recoveryDirectory, (await readdir(recoveryDirectory))[0]), "utf8",
  ));
  bootTime = new Date("2101-01-01T00:00:00.000Z");
  const recovered = await service.recoverProcessTreeGuard(taskId, {
    repositoryRoot: root,
    guardId: guard.guardId,
    proof: {
      kind: "system-restart-after-guard",
      confirmed: true,
      summary: "different retry summary must not replace evidence",
    },
  });
  assert.equal(recovered.reused, true);
  assert.deepEqual(recovered.proof, writtenRecovery.proof);
  const replayedRecovery = await service.recoverProcessTreeGuard(taskId, {
    repositoryRoot: root,
    guardId: guard.guardId,
    proof: {
      kind: "system-restart-after-guard",
      confirmed: true,
      summary: "same exact test fixture boot boundary",
    },
  });
  assert.equal(replayedRecovery.reused, true);
  assert.deepEqual(replayedRecovery.proof, writtenRecovery.proof);
  assert.equal(replayedRecovery.proof.source, "Win32_OperatingSystem.LastBootUpTime");
  await service.withTaskLock(taskId, async () => { replacementMutation = true; });
  assert.equal(replacementMutation, true);
});

test("repository recovery lease is reused by nested Task Git preparation", async (context) => {
  const { root } = await repositoryWithOrigin(context);
  const dataDir = path.join(root, "..", `${path.basename(root)}-recovery-lock-data`);
  context.after(() => rm(dataDir, { recursive: true, force: true }));
  const service = new TaskGitWorkspaceService({ dataDir });
  const taskId = "16161616-1616-4616-8616-161616161616";
  let repositoryLease = null;

  const workspace = await service.withTaskRecoveryLock(taskId, (taskLease) => (
    service.withTaskRepositoryRecoveryLock(taskId, root, taskLease, async (lease) => {
      repositoryLease = lease;
      return service.prepareOwned({
        taskId,
        taskNumber: "HUB-216",
        projectRoot: root,
        lease,
      });
    })
  ));

  assert.equal(workspace.taskId, taskId);
  assert.ok(repositoryLease?.repositoryLockKeys?.size > 0);
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

test("Task result merge rejects a supplied snapshot that no longer matches its exact branch", async (context) => {
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
    (error) => error.code === "RELEASE_NATIVE_HISTORY_REQUIRED",
  );
  assert.equal(await git(dev.projectRoot, "rev-parse", "HEAD^{commit}"), dev.headCommit);
  assert.equal(
    await git(dev.projectRoot, "status", "--porcelain=v1", "--untracked-files=all"),
    statusBefore,
  );
});

test("isolated native merge does not inherit a primary custom merge driver", async (context) => {
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

  const conflict = await service.mergeIntoDev(secondSnapshot);
  assert.equal(conflict.integrated, false);
  assert.deepEqual(conflict.conflicts, ["app.txt"]);
  assert.equal(conflict.devRestored, true);
  assert.equal(await git(firstResult.integration.dev.projectRoot, "rev-parse", "HEAD"),
    firstResult.integration.dev.headCommit);
  assert.equal(await git(firstResult.integration.dev.projectRoot, "status", "--porcelain"), "");
  await assert.rejects(access(path.join(conflict.nativeConflictRoot, "abort-survivor.txt")));
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

test("observed external main does not change a new Task base or managed dev", async (context) => {
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
  await git(root, "fetch", "--no-tags", "origin", "+refs/heads/main:refs/remotes/origin/main");
  await git(origin, "update-ref", "refs/heads/dev", externalMain);
  await git(origin, "update-ref", "refs/tags/remote-only-tag", externalMain);
  const second = await service.prepare({
    taskId: "46464646-4646-4646-8646-464646464646",
    projectRoot: root,
  });

  assert.equal(second.baseCommit, primaryHead);
  await assert.rejects(() => readFile(path.join(second.projectRoot, "external.txt"), "utf8"), /ENOENT/u);
  await assert.rejects(() => readFile(path.join(second.projectRoot, "test-only.txt"), "utf8"), /ENOENT/u);
  const dev = await service.prepareDev(root);
  await assert.rejects(() => readFile(path.join(dev.projectRoot, "external.txt"), "utf8"), /ENOENT/u);
  assert.equal(await readFile(path.join(dev.projectRoot, "test-only.txt"), "utf8"), "test-only\n");
  await assert.rejects(git(dev.projectRoot, "merge-base", "--is-ancestor", externalMain, dev.headCommit));
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

test("Task integration ignores an observed external main until a Task adopts it", async (context) => {
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
  await git(root, "fetch", "--no-tags", "origin", "+refs/heads/main:refs/remotes/origin/main");

  const integration = await service.mergeIntoDev(snapshot);

  assert.equal(integration.integrated, true);
  await assert.rejects(() => readFile(path.join(integration.dev.projectRoot, "external.txt"), "utf8"), /ENOENT/u);
  assert.equal(await readFile(path.join(integration.dev.projectRoot, "task.txt"), "utf8"), "task\n");
  await assert.rejects(git(integration.dev.projectRoot, "merge-base", "--is-ancestor", externalMain, integration.dev.headCommit));
  await git(integration.dev.projectRoot, "merge-base", "--is-ancestor", snapshot.headCommit, integration.dev.headCommit);
});

test("release adoption requires a selected Task result and stays pinned when origin advances again", async (context) => {
  const fixture = await reviewedDevBootstrapFixture(context, { authorize: false });
  const localMain = await git(fixture.root, "rev-parse", "refs/heads/main^{commit}");
  await assert.rejects(fixture.service.assertExplicitUpstreamAdoption({
    projectRoot: fixture.root,
    acceptedLocalMainCommit: localMain,
    approvedUpstreamCommit: fixture.mainCommit,
    frozenTasks: [{
      taskId: fixture.snapshot.taskId,
      branch: fixture.snapshot.branch,
      resultCommit: fixture.snapshot.headCommit,
    }],
  }), /requires explicit adoption/u);

  await assert.rejects(fixture.service.mergeIntoDev(fixture.snapshot), { code: "RELEASE_NATIVE_HISTORY_REQUIRED" });
  // Materialize retained historical dev data for the adoption readback, not fresh native admission.
  await git(fixture.devRoot, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
    "merge", "--no-ff", "--no-edit", fixture.snapshot.headCommit);
  const baseRequest = { projectRoot: fixture.root, publishedBaseCommit: localMain,
    tasks: [{ taskId: fixture.snapshot.taskId, resultCommit: fixture.snapshot.headCommit }] };
  assert.equal((await fixture.service.releaseBaseEvidence(baseRequest)).baseCommit, localMain);
  const input = {
    taskId: fixture.snapshot.taskId,
    projectRoot: fixture.root,
    branch: fixture.snapshot.branch,
    taskBaseCommit: fixture.snapshot.baseCommit,
    acceptedLocalMainCommit: localMain,
    adoptedCommit: fixture.mainCommit,
    snapshotCommit: fixture.snapshot.headCommit,
    requestId: "explicit-review-request-1",
  };
  const preview = await fixture.service.previewExplicitUpstreamAdoption(input);
  await assert.rejects(git(fixture.root, "rev-parse", "--verify", preview.recordRef));
  const recorded = await fixture.service.recordExplicitUpstreamAdoption(input);
  assert.equal(recorded.recordHash, preview.recordHash);
  assert.equal(await git(fixture.root, "rev-parse", "--verify", recorded.recordRef), recorded.recordHash);
  const retried = await fixture.service.recordExplicitUpstreamAdoption(input);
  assert.equal(retried.recordHash, recorded.recordHash);
  await assert.rejects(
    fixture.service.recordExplicitUpstreamAdoption({ ...input, requestId: "different-review-request" }),
    /already has different content/u,
  );

  await assert.rejects(fixture.service.mergeIntoDev(fixture.snapshot), { code: "RELEASE_NATIVE_HISTORY_REQUIRED" });
  const adopted = await fixture.service.assertExplicitUpstreamAdoption({
    projectRoot: fixture.root,
    acceptedLocalMainCommit: localMain,
    approvedUpstreamCommit: fixture.mainCommit,
    frozenTasks: [{
      taskId: fixture.snapshot.taskId,
      branch: fixture.snapshot.branch,
      resultCommit: fixture.snapshot.headCommit,
    }],
  });
  assert.equal(adopted.approvedUpstream, fixture.mainCommit);
  assert.equal(adopted.adoptedByResultCommit, fixture.snapshot.headCommit);
  const acceptedBase = await fixture.service.releaseBaseEvidence(baseRequest);
  assert.equal(acceptedBase.baseCommit, localMain);
  assert.deepEqual(acceptedBase.adoptions, [{ taskId: fixture.snapshot.taskId,
    resultCommit: fixture.snapshot.headCommit, recordRef: recorded.recordRef, recordHash: recorded.recordHash,
    adoptedCommit: fixture.mainCommit, acceptedLocalMainCommit: localMain }]);
  assert.equal(acceptedBase.compositionPolicy, "main-selected-git-merge-v1");
  assert.equal(await git(fixture.root, "rev-parse", recorded.recordRef), recorded.recordHash);
  assert.equal((await fixture.service.releaseBaseEvidence({ ...baseRequest, tasks: [] })).baseCommit, localMain);

  const origin = await git(fixture.root, "remote", "get-url", "origin");
  const nextOrigin = await advanceOriginMain(context, origin, { "later-origin.txt": "later\n" });
  await git(fixture.root, "fetch", "--no-tags", "origin", "+refs/heads/main:refs/remotes/origin/main");
  assert.deepEqual(await fixture.service.releaseBaseEvidence(baseRequest), acceptedBase);
  await assert.rejects(fixture.service.assertExplicitUpstreamAdoption({
    projectRoot: fixture.root,
    acceptedLocalMainCommit: localMain,
    approvedUpstreamCommit: nextOrigin,
    frozenTasks: [{
      taskId: fixture.snapshot.taskId,
      branch: fixture.snapshot.branch,
      resultCommit: fixture.snapshot.headCommit,
    }],
  }), /requires explicit adoption/u);
  const cleanupPreview = await fixture.service.cleanupPreview(fixture.snapshot.taskId);
  await git(fixture.root, "merge", "--ff-only", fixture.mainCommit);
  const publishedBase = await fixture.service.releaseBaseEvidence({ ...baseRequest, publishedBaseCommit: fixture.mainCommit });
  assert.equal(publishedBase.baseCommit, fixture.mainCommit);
  assert.deepEqual(publishedBase.adoptions, []);
  assert.equal(cleanupPreview.deleting.some((item) => (
    item.kind === "upstream_adoption_ref" && item.name === recorded.recordRef
  )), true);
  await fixture.service.cleanup(fixture.snapshot.taskId, { allowDirty: true });
  await assert.rejects(git(fixture.root, "rev-parse", "--verify", recorded.recordRef));
});

test("explicit upstream adoption fences Task snapshot and local-main drift before dev publication", async (context) => {
  await context.test("Task snapshot drift", async (child) => {
    const fixture = await reviewedDevBootstrapFixture(child);
    const movedSnapshot = await git(
      fixture.root,
      "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
      "commit-tree", fixture.reviewedTree, "-p", fixture.snapshot.headCommit, "-m", "moved snapshot",
    );
    await git(fixture.root, "update-ref", `refs/heads/${fixture.snapshot.branch}`, movedSnapshot,
      fixture.snapshot.headCommit);

    await assert.rejects(fixture.service.mergeIntoDev(fixture.snapshot),
      /Native upstream adoption receipt or current Git identity changed/u);
    assert.equal(await git(fixture.root, "rev-parse", "refs/heads/dev^{commit}"), fixture.oldDev);
  });

  await context.test("local main drift", async (child) => {
    const fixture = await reviewedDevBootstrapFixture(child);
    const localMain = await git(fixture.root, "rev-parse", "refs/heads/main^{commit}");
    const localTree = await git(fixture.root, "rev-parse", `${localMain}^{tree}`);
    const movedMain = await git(
      fixture.root,
      "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
      "commit-tree", localTree, "-p", localMain, "-m", "moved local main",
    );
    await git(fixture.root, "update-ref", "refs/heads/main", movedMain, localMain);

    await assert.rejects(fixture.service.mergeIntoDev(fixture.snapshot), /does not contain accepted local main/u);
    assert.equal(await git(fixture.root, "rev-parse", "refs/heads/dev^{commit}"), fixture.oldDev);
  });
});

test("missing local main and zero-argument synchronization fail closed", async (context) => {
  const root = await repository(context);
  const dataDir = path.join(root, "..", `${path.basename(root)}-data`);
  context.after(() => rm(dataDir, { recursive: true, force: true }));
  const service = new TaskGitWorkspaceService({ dataDir });
  await assert.rejects(service.synchronizeMainIntoDev({ projectRoot: root }), /published revision must be a full Git commit id/u);
  await git(root, "update-ref", "-d", "refs/heads/main");
  await assert.rejects(service.prepare({
    taskId: "47777777-4777-4777-8777-477777777777",
    projectRoot: root,
  }), /refs\/heads\/main/u);
});

test("a historical Task union cannot bootstrap divergent main and managed dev implicitly", async (context) => {
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
  await writeFile(path.join(workspace.projectRoot, "accepted-test.txt"), "accepted Test work\n", "utf8");
  await writeFile(path.join(workspace.projectRoot, "task-only.txt"), "Task-only work\n", "utf8");
  await git(workspace.projectRoot, "add", "accepted-test.txt", "task-only.txt");
  await git(
    workspace.projectRoot,
    "-c", "user.name=Test",
    "-c", "user.email=test@example.invalid",
    "commit", "-m", "reviewed Task union",
  );
  const reviewedTaskCommit = await git(workspace.projectRoot, "rev-parse", "HEAD^{commit}");
  const reviewedTree = await git(workspace.projectRoot, "rev-parse", "HEAD^{tree}");
  const proofCommit = await git(
    workspace.projectRoot,
    "-c", "user.name=Test",
    "-c", "user.email=test@example.invalid",
    "commit-tree", reviewedTree, "-p", reviewedTaskCommit, "-p", mainHead, "-m", "reviewed main union",
  );
  const reviewedSnapshot = await git(
    workspace.projectRoot,
    "-c", "user.name=Test",
    "-c", "user.email=test@example.invalid",
    "commit-tree", reviewedTree, "-p", proofCommit, "-p", devHead, "-m", "reviewed dev ancestry",
  );
  await git(workspace.projectRoot, "update-ref", "HEAD", reviewedSnapshot, reviewedTaskCommit);
  await git(workspace.projectRoot, "reset", "--hard", reviewedSnapshot);

  const snapshot = await service.snapshot({
    taskId: workspace.taskId,
    projectRoot: workspace.projectRoot,
  });
  const parents = (await git(
    workspace.projectRoot,
    "rev-list", "--parents", "-n", "1", snapshot.headCommit,
  )).split(/\s+/u);
  assert.deepEqual(parents, [snapshot.headCommit, proofCommit, devHead]);

  await assert.rejects(service.mergeIntoDev(snapshot), /does not contain accepted local main/u);
  assert.equal(await git(root, "rev-parse", "dev"), devHead);
  assert.equal(await git(root, "rev-parse", "HEAD"), mainHead);
  assert.equal(await git(root, "status", "--porcelain=v1", "--untracked-files=all"), primaryStatus);
});

test("ordinary Task integration cannot bypass a divergent accepted local-main baseline", async (context) => {
  const root = await repository(context);
  const dataDir = path.join(root, "..", `${path.basename(root)}-data`);
  context.after(() => rm(dataDir, { recursive: true, force: true }));
  const service = new TaskGitWorkspaceService({ dataDir });
  const workspace = await service.prepare({
    taskId: "50606060-5060-4060-8060-506060506060",
    projectRoot: root,
  });
  const dev = await service.prepareDev(root);
  await writeFile(path.join(dev.projectRoot, "dev-only.txt"), "dev only\n", "utf8");
  await git(dev.projectRoot, "add", "dev-only.txt");
  await git(
    dev.projectRoot,
    "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
    "commit", "-m", "accepted dev",
  );
  const devHeadBefore = await git(dev.projectRoot, "rev-parse", "HEAD^{commit}");

  await writeFile(path.join(root, "main-only.txt"), "accepted main\n", "utf8");
  await git(root, "add", "main-only.txt");
  await git(
    root,
    "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
    "commit", "-m", "advance accepted local main",
  );
  const localMain = await git(root, "rev-parse", "refs/heads/main^{commit}");
  await writeFile(path.join(workspace.projectRoot, "task-only.txt"), "task only\n", "utf8");
  const snapshot = await service.snapshot({ taskId: workspace.taskId, projectRoot: workspace.projectRoot });

  await assert.rejects(
    service.mergeIntoDev(snapshot),
    /does not contain accepted local main.*explicit adoption required/u,
  );
  assert.equal(await git(root, "rev-parse", "refs/heads/dev^{commit}"), devHeadBefore);
  await assert.rejects(git(root, "merge-base", "--is-ancestor", localMain, devHeadBefore));
  await assert.rejects(git(root, "merge-base", "--is-ancestor", snapshot.headCommit, devHeadBefore));
  assert.equal(await git(dev.projectRoot, "status", "--porcelain=v1", "--untracked-files=all"), "");
});

test("historical reviewed bootstrap does not authorize a fresh native result", async (context) => {
  for (const variant of [{}, { missingProof: true }, { ambiguousProof: true }, { modeMismatch: true }]) {
    await context.test(JSON.stringify(variant), async (child) => {
      const fixture = await reviewedDevBootstrapFixture(child, variant);
      await assert.rejects(fixture.service.mergeIntoDev(fixture.snapshot), {
        code: "RELEASE_NATIVE_HISTORY_REQUIRED",
      });
      assert.equal(await git(fixture.root, "rev-parse", "dev"), fixture.oldDev);
      assert.equal(await git(fixture.devRoot, "status", "--porcelain"), "");
    });
  }
});

test("native Test retains its original across interrupted dev CAS", { timeout: 120_000 }, async (context) => {
  for (const interruption of ["before CAS", "after CAS", "merge"]) {
    await context.test(interruption, async (child) => {
      const root = await repository(child);
      const dataDir = path.join(root, "..", `${path.basename(root)}-native-cas`);
      child.after(() => rm(dataDir, { recursive: true, force: true }));
      const setup = new TaskGitWorkspaceService({ dataDir });
      const task = await setup.prepare({ taskId: "51515151-5151-4151-8151-515151515151", projectRoot: root });
      await writeFile(path.join(task.projectRoot, "task-only.txt"), "exact Task\n");
      const snapshot = await setup.snapshot({ taskId: task.taskId, projectRoot: task.projectRoot });
      const before = (await setup.prepareDev(root)).headCommit;
      let injected = false;
      const service = new TaskGitWorkspaceService({ dataDir, runCommand: async (args, options) => {
        if (!injected && ((interruption === "before CAS" && args[0] === "update-ref" && args[1] === "refs/heads/dev")
            || (interruption === "after CAS" && args[0] === "symbolic-ref" && args[1] === "HEAD")
            || (interruption === "merge" && args.includes("merge") && args.includes("--no-ff")))) {
          injected = true;
          throw new Error(`injected ${interruption}`);
        }
        return runTaskGitCommand(args, options);
      } });
      const params = { operationId: `native-interruption-${interruption}` };
      const merge = owner => owner.withTaskLock(task.taskId,
        lease => owner.mergeIntoDevOwned(snapshot, { ...params, lease }));
      await assert.rejects(merge(service), /injected/u);
      assert.equal(injected, true);
      if (interruption !== "after CAS") assert.equal(await git(root, "rev-parse", "dev"), before);
      const repeated = await merge(setup);
      assert.equal(repeated.integrated, true);
      assert.equal(await readFile(path.join(repeated.dev.projectRoot, "task-only.txt"), "utf8"), "exact Task\n");
      const head = repeated.dev.headCommit;
      assert.equal((await merge(setup)).dev.headCommit, head);
      assert.equal(await git(repeated.dev.projectRoot, "status", "--porcelain"), "");
    });
  }
});

test("explicit published main to dev conflict aborts exactly while new Task creation stays independent", async (context) => {
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
  await git(root, "fetch", "--no-tags", "origin", "+refs/heads/main:refs/remotes/origin/main");
  await git(root, "reset", "--hard", externalMain);

  const synchronization = await service.synchronizeMainIntoDev({
    projectRoot: root,
    publishedRevision: externalMain,
  });

  assert.equal(synchronization.status, "conflict");
  assert.equal(synchronization.integrated, false);
  assert.equal(synchronization.mainCommit, externalMain);
  assert.equal(synchronization.devHeadBefore, devHeadBefore);
  assert.equal(synchronization.headCommit, devHeadBefore);
  assert.deepEqual(synchronization.conflicts, ["app.txt"]);
  assert.equal(await git(synchronization.projectRoot, "status", "--porcelain=v1", "--untracked-files=all"), "");
  assert.equal(await git(synchronization.projectRoot, "rev-parse", "dev^{commit}"), devHeadBefore);
  assert.equal(await git(root, "rev-parse", "refs/remotes/origin/main^{commit}"), externalMain);
  assert.notEqual(await git(root, "rev-parse", "HEAD^{commit}"), primaryHeadBefore);
  const next = await service.prepare({
    taskId: "49494949-4949-4949-8949-494949494949", projectRoot: root,
  });
  assert.equal(next.baseCommit, externalMain);
  assert.equal(await readFile(path.join(next.projectRoot, "app.txt"), "utf8"), "external\n");
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
  await writeFile(path.join(root, "CHANGELOG.md"), "root release history\n", "utf8");
  await writeFile(path.join(root, "AgentHub", "CHANGELOG.md"), "project release history\n", "utf8");
  await git(root, "add", "AgentHub/package.json", "Other/clean.txt", "CHANGELOG.md", "AgentHub/CHANGELOG.md");
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
  assert.equal(await git(taskRoot, "sparse-checkout", "list"), "/*\n!/*/\n/AgentHub/\n!CHANGELOG.md");
  assert.equal(await readFile(path.join(workspace.projectRoot, "package.json"), "utf8"), "{}\n");
  assert.equal(await readFile(path.join(taskRoot, "app.txt"), "utf8"), "main\n");
  await assert.rejects(readFile(path.join(taskRoot, "CHANGELOG.md")), /ENOENT/u);
  await assert.rejects(readFile(path.join(workspace.projectRoot, "CHANGELOG.md")), /ENOENT/u);
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
  assert.equal(await git(taskRoot, "sparse-checkout", "list"), "/*\n!/*/\n/AgentHub/\n!CHANGELOG.md");
});

test("a legacy cone Task can finish an existing dev merge before sparse migration", { timeout: 90000 }, async (context) => {
  const root = await repository(context);
  await mkdir(path.join(root, "AgentHub"));
  await writeFile(path.join(root, "AgentHub", "app.txt"), "base\n");
  await git(root, "add", ".");
  await git(root, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "project");
  const dataDir = path.join(root, "..", `${path.basename(root)}-legacy-merge`);
  context.after(() => rm(dataDir, { recursive: true, force: true }));
  const service = new TaskGitWorkspaceService({ dataDir });
  const options = { taskId: "91919191-9191-4191-8191-919191919191", taskNumber: "HUB-901", projectRoot: path.join(root, "AgentHub") };
  const workspace = await service.prepare(options);
  await git(path.dirname(workspace.projectRoot), "sparse-checkout", "set", "--cone", "AgentHub");
  const dev = await service.prepareDev(root);
  await writeFile(path.join(dev.projectRoot, "AgentHub", "dev.txt"), "dev\n");
  await git(dev.projectRoot, "add", ".");
  await git(dev.projectRoot, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "dev change");
  await git(workspace.projectRoot, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "merge", "--no-ff", "--no-commit", "dev");
  const statusBefore = await git(workspace.projectRoot, "status", "--porcelain=v1");
  const headBefore = await git(workspace.projectRoot, "rev-parse", "HEAD");
  await service.prepare(options);
  assert.equal(await git(workspace.projectRoot, "status", "--porcelain=v1"), statusBefore);
  assert.equal(await git(workspace.projectRoot, "rev-parse", "HEAD"), headBefore);
  assert.equal(await git(workspace.projectRoot, "sparse-checkout", "list"), "AgentHub");
  await git(workspace.projectRoot, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "finish merge");
  await service.prepare(options);
  assert.equal(await git(workspace.projectRoot, "config", "--bool", "core.sparseCheckoutCone"), "false");
  assert.equal(await readFile(path.join(workspace.projectRoot, "dev.txt"), "utf8"), "dev\n");
});

test("ordinary repeated preparation skips dependencies and sparse mutations while preserving edits", async (context) => {
  const root = await repository(context);
  await writeFile(path.join(root, "package.json"), "{}\n");
  await writeFile(path.join(root, "package-lock.json"), "{}\n");
  await git(root, "add", "package.json", "package-lock.json");
  await git(root, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "manifest");
  const dataDir = path.join(root, "..", `${path.basename(root)}-data`);
  context.after(() => rm(dataDir, { recursive: true, force: true }));
  let sparseWrites = 0;
  let dependencyCalls = 0;
  const service = new TaskGitWorkspaceService({
    dataDir,
    prepareDependencies: async () => { dependencyCalls += 1; throw new Error("unexpected installation"); },
    runCommand: async (args, options) => {
      if (args[0] === "sparse-checkout" && args[1] === "set") sparseWrites += 1;
      return runTaskGitCommand(args, options);
    },
  });
  const input = { taskId: "93939393-9393-4393-8393-939393939393", projectRoot: root };
  const first = await service.prepare(input);
  await writeFile(path.join(first.projectRoot, "app.txt"), "unfinished edit\n", "utf8");
  const repeated = await service.prepare({ ...input, projectRoot: first.projectRoot });
  assert.equal(dependencyCalls, 0);
  assert.equal(sparseWrites, 1);
  assert.equal(repeated.projectRoot, first.projectRoot);
  assert.equal(await readFile(path.join(first.projectRoot, "app.txt"), "utf8"), "unfinished edit\n");
});

test("an unreviewed sibling Task merge is refused while unrelated dev work is preserved", { timeout: 90000 }, async (context) => {
  const root = await repository(context);
  const dataDir = path.join(root, "..", `${path.basename(root)}-conflict-data`);
  context.after(() => rm(dataDir, { recursive: true, force: true }));
  const service = new TaskGitWorkspaceService({ dataDir });
  const a = await service.prepare({ taskId: "11111111-1111-4111-8111-111111111111", projectRoot: root });
  const b = await service.prepare({ taskId: "22222222-2222-4222-8222-222222222222", projectRoot: root });
  await writeFile(path.join(a.projectRoot, "app.txt"), "A\n");
  await writeFile(path.join(b.projectRoot, "app.txt"), "B\n");
  const testedA = await service.snapshotAndMerge({ taskId: a.taskId, projectRoot: root });
  const conflict = await service.snapshotAndMerge({ taskId: b.taskId, projectRoot: root });
  assert.equal(conflict.integration.devRestored, true);
  assert.deepEqual(conflict.integration.conflicts, ["app.txt"]);
  await assert.rejects(git(b.projectRoot, "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
    "merge", "--no-commit", testedA.snapshot.headCommit));
  await writeFile(path.join(b.projectRoot, "app.txt"), "A and B\n");
  await git(b.projectRoot, "add", "app.txt");
  await git(b.projectRoot, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "Combine A and B");
  const combined = await git(b.projectRoot, "rev-parse", "HEAD");
  const c = await service.prepare({ taskId: "33333333-3333-4333-8333-333333333333", projectRoot: root });
  await writeFile(path.join(c.projectRoot, "c.txt"), "C\n");
  await service.snapshotAndMerge({ taskId: c.taskId, projectRoot: root });
  const before = await git(root, "rev-parse", "dev");
  await assert.rejects(service.snapshotAndMerge({ taskId: b.taskId, projectRoot: root }), {
    code: "RELEASE_NATIVE_HISTORY_REQUIRED",
  });
  assert.equal(await git(root, "rev-parse", "dev"), before);
  const currentDev = await service.prepareDev(root);
  assert.equal(await readFile(path.join(currentDev.projectRoot, "app.txt"), "utf8"), "A\n");
  assert.equal(await readFile(path.join(currentDev.projectRoot, "c.txt"), "utf8"), "C\n");
  const parents = (await git(root, "show", "-s", "--format=%P", combined)).split(" ");
  assert.equal(parents[1], testedA.snapshot.headCommit);
});

test("npm holds its Task while another Task can integrate into dev", { timeout: 30_000 }, async (context) => {
  const root = await repository(context);
  await writeFile(path.join(root, "package.json"), '{"name":"parallel","private":true}\n');
  await writeFile(path.join(root, "package-lock.json"), '{"lockfileVersion":3,"packages":{}}\n');
  await git(root, "add", "package.json", "package-lock.json");
  await git(root, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "manifest");
  const dataDir = path.join(root, "..", `${path.basename(root)}-data`);
  context.after(() => rm(dataDir, { recursive: true, force: true }));
  let enteredNpm;
  let releaseNpm;
  const entered = new Promise((resolve) => { enteredNpm = resolve; });
  const released = new Promise((resolve) => { releaseNpm = resolve; });
  const service = new TaskGitWorkspaceService({
    dataDir,
    runCommand: async (args, options) => {
      if (options.commandLabel === "npm") {
        enteredNpm();
        await released;
        await mkdir(path.join(options.cwd, "node_modules"), { recursive: true });
        await writeFile(path.join(options.cwd, "node_modules", ".package-lock.json"), '{"lockfileVersion":3,"packages":{}}');
        return "";
      }
      return runTaskGitCommand(args, options);
    },
  });
  const firstInput = { taskId: "94949494-9494-4494-8494-949494949494", projectRoot: root };
  const secondInput = { taskId: "95959595-9595-4595-8595-959595959595", projectRoot: root };
  const second = await service.prepare(secondInput);
  const first = service.prepare({ ...firstInput, dependencyMode: "ensure" });
  await entered;
  let sameTaskReturned = false;
  const sameTask = service.prepare(firstInput).then((result) => { sameTaskReturned = true; return result; });
  try {
    await writeFile(path.join(second.projectRoot, "second.txt"), "independent change\n", "utf8");
    const integration = await service.snapshotAndMerge({ ...secondInput, projectRoot: second.projectRoot });
    assert.equal(integration.integration.integrated, true);
    assert.equal(sameTaskReturned, false);
  } finally {
    releaseNpm();
    await Promise.all([first, sameTask]);
  }
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
    dependencyMode: "ensure",
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
    dependencyMode: "ensure",
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
    dependencyMode: "ensure",
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
    dependencyMode: "ensure",
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
  await writeFile(path.join(root, "CHANGELOG.md"), "root release history\n", "utf8");
  await writeFile(path.join(root, "AgentHub", "CHANGELOG.md"), "project release history\n", "utf8");
  await git(root, "add", "AgentHub/package.json", "CHANGELOG.md", "AgentHub/CHANGELOG.md");
  await git(root, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "project");
  const dataDir = path.join(root, "..", `${path.basename(root)}-data`);
  context.after(() => rm(dataDir, { recursive: true, force: true }));
  const service = new TaskGitWorkspaceService({ dataDir });

  const workspace = await service.prepare({
    taskId: "99999999-9999-4999-8999-999999999999",
    projectRoot: root,
  });

  assert.equal(workspace.projectRoot, canonicalPath(await git(workspace.projectRoot, "rev-parse", "--show-toplevel")));
  assert.equal(await git(workspace.projectRoot, "sparse-checkout", "list"), "/*\n!CHANGELOG.md");
  assert.equal(await readFile(path.join(workspace.projectRoot, "AgentHub", "package.json"), "utf8"), "{}\n");
  await assert.rejects(readFile(path.join(workspace.projectRoot, "CHANGELOG.md")), /ENOENT/u);
  await assert.rejects(readFile(path.join(workspace.projectRoot, "AgentHub", "CHANGELOG.md")), /ENOENT/u);
  await git(workspace.projectRoot, "sparse-checkout", "disable");
  await service.prepare({ taskId: workspace.taskId, projectRoot: workspace.projectRoot });
  await assert.rejects(readFile(path.join(workspace.projectRoot, "CHANGELOG.md")), /ENOENT/u);
  await writeFile(path.join(workspace.projectRoot, "CHANGELOG.md"), "root release history\n", "utf8");
  await service.prepare({ taskId: workspace.taskId, projectRoot: workspace.projectRoot });
  await assert.rejects(readFile(path.join(workspace.projectRoot, "CHANGELOG.md")), /ENOENT/u);
});

test("Task changelog exclusion preserves dirty files and rejects recreated changelog snapshots", async (context) => {
  const root = await repository(context);
  await writeFile(path.join(root, "CHANGELOG.md"), "published history\n", "utf8");
  await git(root, "add", "CHANGELOG.md");
  await git(root, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "release history");
  const dataDir = path.join(root, "..", `${path.basename(root)}-changelog-data`);
  context.after(() => rm(dataDir, { recursive: true, force: true }));
  const service = new TaskGitWorkspaceService({ dataDir });
  const taskId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const workspace = await service.prepare({ taskId, projectRoot: root });
  const input = { taskId, projectRoot: workspace.projectRoot };
  const changelog = path.join(workspace.projectRoot, "CHANGELOG.md");
  await mkdir(path.join(workspace.projectRoot, "new-directory"));
  const untrackedChangelog = path.join(workspace.projectRoot, "new-directory", "CHANGELOG.md");
  await writeFile(untrackedChangelog, "untracked release history\n", "utf8");
  await assert.rejects(service.snapshot(input), /exclude CHANGELOG.md/u);
  assert.equal(await readFile(untrackedChangelog, "utf8"), "untracked release history\n");
  await unlink(untrackedChangelog);
  await git(workspace.projectRoot, "sparse-checkout", "disable");
  await writeFile(changelog, "preserve existing edits\n", "utf8");
  await assert.rejects(service.prepare(input), /exclude CHANGELOG.md/u);
  assert.equal(await readFile(changelog, "utf8"), "preserve existing edits\n");
  await assert.rejects(git(workspace.projectRoot, "sparse-checkout", "list"), /not sparse/u);

  await writeFile(changelog, "published history\n", "utf8");
  await service.prepare(input);
  await assert.rejects(readFile(changelog), /ENOENT/u);
  await writeFile(changelog, "recreated edits\n", "utf8");
  await writeFile(path.join(workspace.projectRoot, "app.txt"), "new task work\n", "utf8");
  await git(workspace.projectRoot, "add", "--sparse", "CHANGELOG.md");
  const priorStatus = await git(workspace.projectRoot, "status", "--porcelain=v1", "--untracked-files=all");
  await assert.rejects(service.snapshot(input), /exclude CHANGELOG.md/u);
  assert.equal(await git(workspace.projectRoot, "rev-parse", "HEAD^{commit}"), workspace.headCommit);
  assert.equal(await git(workspace.projectRoot, "status", "--porcelain=v1", "--untracked-files=all"), priorStatus);
  assert.equal(await readFile(changelog, "utf8"), "recreated edits\n");
  assert.equal(await readFile(path.join(workspace.projectRoot, "app.txt"), "utf8"), "new task work\n");
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
  assert.equal(await git(taskRoot, "sparse-checkout", "list"), "/*\n!/*/\n/AgentHub/\n!CHANGELOG.md");
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
    cone: false,
    relativePath: path.join("AgentHub", "src"),
    scope: "AgentHub/src",
    patterns: ["/*", "!/*/", "/AgentHub/", "!/AgentHub/*/", "/AgentHub/src/", "!CHANGELOG.md"],
  });
  assert.deepEqual(taskSparseCheckoutSelection(root, root), {
    cone: false,
    relativePath: "",
    scope: "/*",
    patterns: ["/*", "!CHANGELOG.md"],
  });
  assert.throws(
    () => taskSparseCheckoutSelection(root, path.resolve(root, "..", "escape")),
    /outside its Git worktree/u,
  );
});
