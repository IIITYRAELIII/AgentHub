import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { TaskBoardService } from "../../src/application/task-board-service.mjs";
import { TaskLifecycleService } from "../../src/application/task-lifecycle-service.mjs";
import { TaskGitWorkspaceService } from "../../src/infrastructure/filesystem/task-git-workspace.mjs";
import { TaskBoardStore } from "../../src/infrastructure/persistence/task-board-store.mjs";
import { WorkspaceCatalogStore } from "../../src/infrastructure/persistence/workspace-catalog-store.mjs";
import { createPersistenceMutationCapabilities } from "../../src/composition/persistence-mutation-composition.mjs";

const exec = promisify(execFile);
const git = async (cwd, ...args) => String((await exec("git", args, { cwd, windowsHide: true })).stdout).trim();
const commit = async (cwd, file, body) => {
  await writeFile(path.join(cwd, file), body);
  await git(cwd, "add", file);
  await git(cwd, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", file);
  return git(cwd, "rev-parse", "HEAD");
};

async function fixture(t, { claimAuthority = true } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "hub-retained-absorption-"));
  const old = path.join(root, "old"), current = path.join(root, "current");
  for (const repo of [old, current]) {
    await mkdir(repo);
    await git(repo, "init", "--initial-branch=main");
    await commit(repo, "base.txt", "base\n");
  }
  const databaseFile = path.join(root, "journal.sqlite");
  const rawCatalog = new WorkspaceCatalogStore({ databaseFile }); await rawCatalog.load();
  const rawTasks = new TaskBoardStore({ databaseFile });
  const caps = createPersistenceMutationCapabilities({ rawWorkspaceCatalogStore: rawCatalog, rawTaskBoardStore: rawTasks });
  const catalog = caps.workspaceCatalogStore;
  const workspace = await catalog.createWorkspace({ name: "Absorption", settings: { workingDirectory: current, releaseWorkflowEnabled: true } });
  const stream = await catalog.createStream({ workspaceId: workspace.id, name: "Owner" });
  const board = new TaskBoardService({ store: caps.taskBoardStore, workspaceCatalog: catalog });
  const owner = new TaskGitWorkspaceService({ dataDir: path.join(root, "data"), recordTiming() {} });
  const source = await board.create({ text: "Source", bucket: "workspace", workspaceId: workspace.id });
  const target = await board.create({ text: "Survivor", bucket: "workspace", workspaceId: workspace.id });
  t.after(async () => { rawTasks.close(); rawCatalog.close(); await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); });
  const saveTest = async (task, repo, head, request) => {
    const w = (await owner.describe(task.id)).find(w => w.repositoryRoot === repo);
    await git(repo, "update-ref", `refs/agent-hub/task-results/${task.id}/${w.repositoryKey}`, head);
    const before = board.task(task.id);
    await board.beginLifecycleTransition({ id: task.id, operationId: request, kind: "workflow",
      targetWorkflowStatus: "testing", expectedRevision: before.revision });
    await board.commitWorkflowTransition({ operationId: request, gitReferences: [{ projectRoot: repo, branch: w.branch, resultCommit: head }],
      evidence: { outcome: "integrated", resultCommit: head, response: { gitWorkspace: {
        projectRoot: (await owner.describe(task.id)).find(w => w.repositoryRoot === repo).projectRoot,
        branch: w.branch, headCommit: head,
        baseCommit: await git(repo, "rev-parse", `refs/agent-hub/task-bases/${task.id}/${w.repositoryKey}`) } } } });
  };
  const oldWorkspace = await owner.prepare({ taskId: source.id, taskNumber: source.taskNumber, projectRoot: old });
  const oldHead = await commit(oldWorkspace.projectRoot, "unique.txt", "unique old work remains\n");
  await saveTest(source, old, oldHead, "old-test");
  await board.beginLifecycleTransition({ id: source.id, operationId: "return-old", kind: "workflow",
    targetWorkflowStatus: "in_progress", expectedRevision: board.task(source.id).revision });
  await board.commitWorkflowTransition({ operationId: "return-old", replaceGitReferences: false,
    evidence: { outcome: "returned_for_correction", response: { acceptedResultPreserved: true } } });
  const currentWorkspace = await owner.prepare({ taskId: source.id, taskNumber: source.taskNumber, projectRoot: current });
  const claim = { requestId: "new-repository-claim", toolName: "hub_task_claim", workspaceId: workspace.id,
    streamId: stream.id, provider: "codex", threadId: "fixture-thread", argumentsHash: "1".repeat(64) };
  if (claimAuthority) await catalog.beginMcpOperation(claim);
  await board.claim({ id: source.id, workspaceId: workspace.id, streamId: stream.id, provider: claim.provider,
    threadId: claim.threadId, turnId: "turn", operationId: claim.requestId, gitBaseline: currentWorkspace.gitBaseline });
  if (claimAuthority) await catalog.completeMcpOperation(claim.requestId, { ...board.task(source.id), gitWorkspace: currentWorkspace });
  const sourceHead = await commit(currentWorkspace.projectRoot, "source.txt", "current contribution\n");
  await saveTest(source, current, sourceHead, "current-test");
  await board.beginLifecycleTransition({ id: source.id, operationId: "return-source", kind: "workflow",
    targetWorkflowStatus: "in_progress", expectedRevision: board.task(source.id).revision });
  await board.commitWorkflowTransition({ operationId: "return-source", replaceGitReferences: false });
  const targetWorkspace = await owner.prepare({ taskId: target.id, taskNumber: target.taskNumber, projectRoot: current });
  await git(targetWorkspace.projectRoot, "merge", "--ff-only", sourceHead);
  await git(current, "update-ref", "refs/heads/dev", sourceHead);
  await saveTest(target, current, sourceHead, "target-test");
  let afterComposition = null;
  const lifecycle = new TaskLifecycleService({ taskBoard: board, workspaceCatalog: catalog, taskGitWorkspaces: owner,
    releasePreflight: { withAwaitTransition: (_id, op) => op(), async prepareAwaitSet() {
      await afterComposition?.(); return { taskIds: [target.id], planRevision: "plan" };
    } } });
  return { root, old, current, board, catalog, rawTasks, owner, lifecycle, source, target,
    oldWorkspace, oldHead, currentWorkspace, sourceHead, targetWorkspace,
    afterComposition: fn => { afterComposition = fn; },
    preview: () => lifecycle.complete({ taskId: source.id, absorbedIntoTaskId: target.id, operationId: "closure-preview" }) };
}

test("combined owner retains exact superseded workspace without inventing survivor result", async t => {
  const f = await fixture(t), before = f.board.task(f.source.id);
  assert.ok(f.board.absorptionRetainedSource({ taskId: f.source.id, projectRoot: f.current }));
  const preview = await f.preview();
  assert.match(preview.cleanupToken, /^[a-f0-9]{64}$/u);
  assert.deepEqual(preview.preview.deleting, []);
  assert.equal(preview.preview.absorbedInto.repositories.length, 1);
  assert.equal(preview.preview.absorbedInto.retainedRepositories[0].sourceHead, f.oldHead);
  assert.equal(await readFile(path.join(f.oldWorkspace.projectRoot, "unique.txt"), "utf8"), "unique old work remains\n");
  assert.deepEqual(f.board.task(f.source.id), before);
  assert.equal(f.board.task(f.target.id).gitReferences.length, 1);
});

test("a prior reference and clean folder without successful canonical claim grant no history exemption", async t => {
  const f = await fixture(t, { claimAuthority: false });
  assert.equal(f.board.absorptionRetainedSource({ taskId: f.source.id, projectRoot: f.current }), null);
  await assert.rejects(f.preview(), /one exact Test result per repository/u);
});

test("ordinary multiple current repositories still require every survivor result", async t => {
  const f = await fixture(t);
  await f.rawTasks.runMutation(() => f.rawTasks.recordTaskGitReference({ taskId: f.source.id, projectRoot: f.old,
    branch: f.oldWorkspace.branch, resultSnapshot: { repoRoot: f.old, tree: f.oldHead } }));
  await assert.rejects(f.preview(), /one exact Test result per repository/u);
  const targetOld = await f.owner.prepare({ taskId: f.target.id, taskNumber: f.target.taskNumber, projectRoot: f.old });
  await git(targetOld.projectRoot, "merge", "--ff-only", f.oldHead);
  await git(f.old, "update-ref", "refs/heads/dev", f.oldHead);
  await f.rawTasks.runMutation(() => f.rawTasks.recordTaskGitReference({ taskId: f.target.id, projectRoot: f.old,
    branch: targetOld.branch, resultSnapshot: { repoRoot: f.old, tree: f.oldHead } }));
  const result = await f.preview();
  assert.equal(result.preview.absorbedInto.repositories.length, 2);
  assert.equal(result.preview.absorbedInto.retainedRepositories, undefined);
});

for (const change of ["dirty", "commit", "unknown", "late-drift"]) test(`retained workspace refuses ${change}`, async t => {
  const f = await fixture(t);
  if (change === "dirty") await writeFile(path.join(f.oldWorkspace.projectRoot, "pending.txt"), "unsaved\n");
  if (change === "commit") await commit(f.oldWorkspace.projectRoot, "later.txt", "new old-repository work\n");
  if (change === "unknown") {
    // An extra managed repository with no canonical replacement/claim cannot be hidden.
    const extra = path.join(f.root, "extra"); await mkdir(extra); await git(extra, "init", "--initial-branch=main");
    await commit(extra, "base.txt", "unclassified\n");
    await f.owner.prepare({ taskId: f.source.id, taskNumber: f.source.taskNumber, projectRoot: extra });
  }
  if (change === "late-drift") f.afterComposition(() => commit(f.oldWorkspace.projectRoot, "late.txt", "late work\n"));
  await assert.rejects(f.preview());
  assert.notEqual(f.board.task(f.source.id).status, "done");
  assert.equal(f.board.lifecycleOutcome("closure-preview"), null);
});
