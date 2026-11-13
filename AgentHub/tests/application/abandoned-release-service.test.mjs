import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { promisify } from "node:util";
import { HubMcpService } from "../../src/application/hub-mcp-service.mjs";
import { TaskBoardService } from "../../src/application/task-board-service.mjs";
import { TaskLifecycleService } from "../../src/application/task-lifecycle-service.mjs";
import { createTaskBoardMutationOwner } from "../../src/application/sqlite-mutation-owner.mjs";
import { TaskBoardStore } from "../../src/infrastructure/persistence/task-board-store.mjs";
import { WorkspaceCatalogStore } from "../../src/infrastructure/persistence/workspace-catalog-store.mjs";
import { ReleaseOperationStore } from "../../src/infrastructure/persistence/release-operation-store.mjs";
import { TaskGitWorkspaceService } from "../../src/infrastructure/filesystem/task-git-workspace.mjs";
import { ReleaseGitWorkspaceService } from "../../src/infrastructure/filesystem/release-git-workspace.mjs";

const exec = promisify(execFile);
const git = async (cwd, ...args) => String((await exec("git", args, { cwd, windowsHide: true })).stdout).trim();

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "hub-abandoned-release-"));
  const primary = path.join(root, "repository"), dataDir = path.join(root, "data");
  await mkdir(primary); await mkdir(dataDir);
  await git(primary, "init", "--initial-branch=main");
  await writeFile(path.join(primary, "source.txt"), "retained source\n");
  await git(primary, "add", ".");
  await git(primary, "-c", "user.name=Fixture", "-c", "user.email=fixture@local.invalid", "commit", "-m", "source");
  const commit = await git(primary, "rev-parse", "HEAD"), tree = await git(primary, "rev-parse", "HEAD^{tree}");
  const databaseFile = path.join(dataDir, "runtime.sqlite");
  const catalog = new WorkspaceCatalogStore({ databaseFile }); await catalog.load();
  const store = new TaskBoardStore({ databaseFile });
  t.after(async () => { store.close(); catalog.close(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  const workspace = await catalog.runMutation(() => catalog.createWorkspace({ name: "Release", settings: {
    workingDirectory: primary, releaseWorkflowEnabled: true, taskPrefix: "HUB",
  } }));
  const stream = await catalog.runMutation(() => catalog.createStream({ workspaceId: workspace.id, name: "RM",
    settings: { releaseManager: true, workingDirectory: primary } }));
  await catalog.runMutation(() => catalog.bindThread({ provider: "codex", threadId: "rm", streamId: stream.id }));
  const board = new TaskBoardService({ store: createTaskBoardMutationOwner(store), workspaceCatalog: catalog });
  const child = store.create({ text: "Selected source", bucket: "workspace", workspaceId: workspace.id, taskPrefix: "HUB", triageStatus: "disabled" });
  const task = store.create({ text: "Abandoned release", bucket: "workspace", workspaceId: workspace.id, taskPrefix: "HUB", triageStatus: "disabled" });
  // Seed a historical accepted reference in this disposable SQLite fixture only.
  const db = new DatabaseSync(databaseFile);
  db.prepare("UPDATE hub_board_tasks SET stream_id=? WHERE id=?").run(stream.id, task.id);
  db.prepare("UPDATE hub_board_tasks SET workflow_status='awaiting_implementation' WHERE id=?").run(child.id);
  db.prepare("INSERT INTO hub_task_git_references (task_id,project_root,branch,result_commit,updated_at_ms) VALUES (?,?,?,?,1)")
    .run(child.id, primary, child.taskNumber, commit);
  db.close();
  let current = store.task(task.id);
  const added = store.updateChecklist({ id: task.id, operation: "add", text: "Selected", expectedRevision: current.revision, requestId: "add" });
  store.updateChecklist({ id: task.id, operation: "link", itemId: added.itemId, linkedTaskId: child.id,
    releaseReference: { taskRevision: store.task(child.id).revision, gitReferences: store.task(child.id).gitReferences },
    expectedRevision: added.task.revision, requestId: "link" });
  const releases = new ReleaseOperationStore({ dataDir });
  const operation = releases.create({ operationId: "failed-release", requestId: "original-release", workspaceId: workspace.id,
    streamId: stream.id, threadId: "rm", runnerVersion: "fixture", authorization: {
      taskIds: [child.id], approvedTargets: [{ id: "production", kind: "git-runtime" }], validationMode: "full",
    } }).operation;
  releases.putGeneration({ operationId: operation.operationId, generation: 1,
    repositoryBases: [{ repositoryRoot: primary, baseCommit: commit }],
    selectedResults: [{ taskId: child.id, resultCommit: commit, acceptanceRevision: 1 }],
    candidates: [{ repositoryRoot: primary, releaseRoot: path.join(root, "frozen"), commit, tree, manifestHash: "f".repeat(64) }], runnerVersion: "fixture" });
  releases.transition(operation.operationId, { state: "compose", currentGeneration: 1,
    selectedResults: [{ taskId: child.id, resultCommit: commit, acceptanceRevision: 1 }] }, { expectedRevision: operation.revision });
  releases.transition(operation.operationId, { state: "failed", lastError: { step: "compose", message: "retained failure" } },
    { expectedRevision: releases.get(operation.operationId).revision });
  const taskGit = new TaskGitWorkspaceService({ dataDir, prepareDependencies: async () => ({}), recordTiming: () => {} });
  const releaseGit = new ReleaseGitWorkspaceService({ dataDir });
  const preflight = { withAwaitTransition: (id, fn) => releaseGit.withAwaitTransition(id, fn), preflight: () => assert.fail("no publication preparation") };
  const lifecycle = new TaskLifecycleService({ taskBoard: board, workspaceCatalog: catalog, taskGitWorkspaces: taskGit, releasePreflight: preflight });
  const execution = { active: false };
  const hub = new HubMcpService({ workspaceCatalog: catalog, taskBoard: board, taskGitWorkspaces: taskGit, taskLifecycle: lifecycle,
    releasePreflight: preflight, releasePlanner: { plan: () => assert.fail("no selection") },
    releaseCompleter: { completeRelease: () => assert.fail("no publication") },
    releaseOperations: { setEventDelivery() {}, hasLocalWork: () => execution.active },
    workLog: { threadTurns: () => [] }, attachmentDirectory: root, secret: "fixture", reconcilePendingOnStartup: false });
  const token = hub.contextToken({ provider: "codex", threadId: "rm" });
  const call = (name, args) => hub.call(name, { context_token: token, ...args });
  const failed = releases.get(operation.operationId);
  const input = { operationId: failed.operationId, expectedRevision: failed.revision, expectedGeneration: failed.currentGeneration };
  const args = { task_id: task.id, completion_mode: "abandoned_release_service", abandoned_release: input };
  return { root, primary, dataDir, store, board, catalog, task, child, releases, taskGit, lifecycle, hub, call, args, failed, execution,
    preview: () => call("hub_task_complete", { ...args, request_id: "preview" }),
    confirm: p => call("hub_task_complete", { ...args, request_id: "confirmed", confirm_cleanup: true, expected_cleanup_token: p.cleanupToken }) };
}

test("abandoned metadata-only release archives with FAILED and unfinished members preserved", async t => {
  const f = await fixture(t), before = f.releases.snapshot(f.failed.operationId), child = f.store.task(f.child.id);
  const p = await f.preview();
  assert.equal(p.confirmationRequired, true);
  assert.equal(p.preview.releaseService.disposition, "abandoned");
  assert.deepEqual(p.preview.deleting, []);
  const result = await f.confirm(p);
  assert.equal(result.status, "done");
  assert.equal(result.workflowStatus, "new", "archive is not workflow Done/publication");
  assert.deepEqual(f.releases.snapshot(f.failed.operationId), before);
  assert.deepEqual(f.store.task(f.child.id), child);
  assert.equal(await readFile(path.join(f.primary, "source.txt"), "utf8"), "retained source\n");
  assert.deepEqual(f.store.task(f.task.id).gitReferences, []);
});

test("abandoned closure refuses stale/foreign originals and a running worker before intake", async t => {
  const f = await fixture(t), before = f.releases.snapshot(f.failed.operationId);
  for (const [name, patch] of Object.entries({ missing: { operationId: "missing" }, stale: { expectedRevision: f.failed.revision + 1 },
    generation: { expectedGeneration: 2 } })) {
    await assert.rejects(f.call("hub_task_complete", { ...f.args, request_id: name,
      abandoned_release: { ...f.args.abandoned_release, ...patch } }), /exact idle FAILED/);
  }
  f.execution.active = true;
  await assert.rejects(f.preview(), /active worker/);
  assert.equal(f.board.task(f.task.id).status, "open");
  assert.deepEqual(f.releases.snapshot(f.failed.operationId), before);
  assert.equal(f.board.lifecycleTransition("confirmed"), null);
});

test("abandoned closure refuses changed checklist, source refs, and stale confirmation", async t => {
  const f = await fixture(t), p = await f.preview();
  await git(f.primary, "branch", f.task.taskNumber);
  await assert.rejects(f.confirm(p), /unregistered source references/);
  await git(f.primary, "branch", "-D", f.task.taskNumber);
  const current = f.board.task(f.task.id);
  f.store.updateChecklist({ id: f.task.id, operation: "add", text: "Unbound selection", expectedRevision: current.revision, requestId: "changed-list" });
  await assert.rejects(f.call("hub_task_complete", { ...f.args, request_id: "changed-confirm", confirm_cleanup: true,
    expected_cleanup_token: p.cleanupToken }), /reference is not exact/);
  assert.equal(f.board.task(f.task.id).status, "open");
  assert.equal(f.board.lifecycleTransition("changed-confirm"), null);
});

test("abandoned closure resumes its exact admitted original after pre-finalization failure", async t => {
  const f = await fixture(t), p = await f.preview(), finalize = f.board.finalizeCleanupTransition.bind(f.board);
  let fail = true;
  f.board.finalizeCleanupTransition = (...args) => { if (fail) { fail = false; throw Error("controlled archive refusal"); } return finalize(...args); };
  await assert.rejects(f.confirm(p), /controlled archive refusal/);
  assert.equal(f.board.task(f.task.id).status, "open");
  assert.equal(f.board.lifecycleTransition("confirmed").phase, "cleanup");
  const done = await f.call("hub_task_operation_reconcile", { request_id: "reconcile", task_id: f.task.id,
    operation_request_id: "confirmed", confirm_reconcile: true });
  assert.equal(done.result.status, "done");
  assert.equal(done.result.workflowStatus, "new");
  assert.equal(f.releases.get(f.failed.operationId).state, "failed");
  assert.equal(f.catalog.mcpOperation("confirmed").status, "succeeded");
});

test("abandoned closure recovers a lost terminal reply without replaying archive", async t => {
  const f = await fixture(t), p = await f.preview(), complete = f.catalog.completeMcpOperation.bind(f.catalog);
  let lost = false;
  f.catalog.completeMcpOperation = (id, ...args) => {
    if (id === "confirmed" && !lost) { lost = true; throw Error("controlled lost reply"); }
    return complete(id, ...args);
  };
  await assert.rejects(f.confirm(p), /effect completed but receipt reconciliation is required/);
  const archived = f.board.task(f.task.id), release = f.releases.snapshot(f.failed.operationId);
  const done = await f.call("hub_task_operation_reconcile", { request_id: "lost-reconcile", task_id: f.task.id,
    operation_request_id: "confirmed", confirm_reconcile: true });
  assert.equal(done.result.id, archived.id);
  assert.deepEqual(f.board.task(f.task.id), archived);
  assert.deepEqual(f.releases.snapshot(f.failed.operationId), release);
});

test("unsealed old operational UNKNOWN cannot be adopted by abandoned closure", async t => {
  const f = await fixture(t);
  await assert.rejects(f.call("hub_task_complete", { request_id: "old-operational", task_id: f.task.id,
    completion_mode: "operational" }), /one exact managed source/);
  const original = f.catalog.mcpOperation("old-operational");
  await assert.rejects(f.call("hub_task_operation_reconcile", { request_id: "old-reconcile", task_id: f.task.id,
    operation_request_id: "old-operational", confirm_reconcile: true }), /unsealed originals remain unknown/);
  assert.deepEqual(f.catalog.mcpOperation("old-operational"), original);
  assert.equal(f.board.task(f.task.id).status, "open");
});

test("base-only managed service custody is preserved and local source changes refuse archive", async t => {
  const f = await fixture(t);
  const managed = await f.taskGit.prepare({ taskId: f.task.id, taskNumber: f.task.taskNumber, projectRoot: f.primary });
  const bytes = await readFile(path.join(managed.projectRoot, "source.txt"));
  const p = await f.preview();
  assert.equal(p.preview.preserving[0].projectRoot, managed.projectRoot);
  await writeFile(path.join(managed.projectRoot, "local.txt"), "unfinished work\n");
  await assert.rejects(f.confirm(p), /custody is not clean/);
  assert.equal(f.board.task(f.task.id).status, "open");
  await rm(path.join(managed.projectRoot, "local.txt"));
  const fresh = await f.call("hub_task_complete", { ...f.args, request_id: "clean-preview" });
  await assert.rejects(f.call("hub_task_complete", { ...f.args, request_id: "wrong-token", confirm_cleanup: true,
    expected_cleanup_token: "stale" }), /confirmation is stale/);
  const done = await f.call("hub_task_complete", { ...f.args, request_id: "clean-confirm", confirm_cleanup: true,
    expected_cleanup_token: fresh.cleanupToken });
  assert.equal(done.status, "done");
  assert.deepEqual(await readFile(path.join(managed.projectRoot, "source.txt")), bytes);
  assert.equal(await git(managed.projectRoot, "rev-parse", "HEAD"), managed.baseCommit);
});
