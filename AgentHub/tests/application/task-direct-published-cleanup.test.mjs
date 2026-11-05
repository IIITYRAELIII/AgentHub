import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { HubMcpService } from "../../src/application/hub-mcp-service.mjs";
import { TaskBoardService } from "../../src/application/task-board-service.mjs";
import { TaskLifecycleService } from "../../src/application/task-lifecycle-service.mjs";
import { createTaskBoardMutationOwner } from "../../src/application/sqlite-mutation-owner.mjs";
import { TaskBoardStore } from "../../src/infrastructure/persistence/task-board-store.mjs";
import { WorkspaceCatalogStore } from "../../src/infrastructure/persistence/workspace-catalog-store.mjs";
import { TaskGitWorkspaceService, runTaskGitCommand } from "../../src/infrastructure/filesystem/task-git-workspace.mjs";

const exec = promisify(execFile);
const sha = raw => createHash("sha256").update(raw).digest("hex");
async function git(cwd, ...args) {
  return String((await exec("git", args, { cwd, windowsHide: true })).stdout).trim();
}
async function commit(cwd, message) {
  await git(cwd, "add", ".");
  await git(cwd, "-c", "user.name=Fixture", "-c", "user.email=fixture@local.invalid", "commit", "-m", message);
  return git(cwd, "rev-parse", "HEAD");
}
async function fixture(t, { operational = false, contained = false, ambiguous = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "hub-direct-clean-"));
  const primary = path.join(root, "repository"), runtimeRoot = path.join(root, "historical-runtime");
  await mkdir(primary); await mkdir(runtimeRoot);
  const catalog = new WorkspaceCatalogStore({ databaseFile: path.join(root, "journal.sqlite") });
  await catalog.load();
  const store = new TaskBoardStore({ databaseFile: path.join(root, "journal.sqlite") });
  t.after(async () => { store.close(); catalog.close(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  await git(primary, "init", "--initial-branch=main");
  await git(primary, "config", "core.autocrlf", "false");
  const repeated = "pad1\npad2\npad3\noriginal\npad4\npad5\npad6\n";
  const originalText = ambiguous ? repeated + "separator\n" + repeated : "original\n";
  await writeFile(path.join(primary, "feature.txt"), originalText);
  await writeFile(path.join(primary, ".gitignore"), "ignored/\n");
  const base = await commit(primary, "original");
  await git(primary, "update-ref", "refs/remotes/origin/main", base);
  const workspace = await catalog.runMutation(() => catalog.createWorkspace({ name: "Historical", settings: {
    workingDirectory: primary, releaseWorkflowEnabled: true, taskPrefix: "HIST",
  } }));
  const stream = await catalog.runMutation(() => catalog.createStream({ workspaceId: workspace.id, name: "RM",
    settings: { releaseManager: true, workingDirectory: primary } }));
  await catalog.runMutation(() => catalog.bindThread({ provider: "codex", threadId: "rm", streamId: stream.id }));
  const board = new TaskBoardService({ store: createTaskBoardMutationOwner(store), workspaceCatalog: catalog });
  const task = store.create({ text: "Exact delivered source", bucket: "workspace", workspaceId: workspace.id });
  await board.assignWorkspaceTaskNumbers(workspace.id);
  await board.setWorkflowStatus({ id: task.id, status: "blocked" });
  let fault = false, removals = 0;
  let durablePublication = null;
  const taskGit = new TaskGitWorkspaceService({ dataDir: path.join(root, "data"), readPublication: async () => durablePublication,
    prepareDependencies: async () => ({}), recordTiming: () => {}, runCommand: async (args, options) => {
      if (args[0] === "worktree" && args[1] === "remove") removals++;
      if (fault && args[0] === "update-ref" && args[1] === "-d" && args[2].startsWith("refs/heads/")) {
        fault = false; throw Error("controlled branch deletion transport failure");
      }
      return runTaskGitCommand(args, options);
    } });
  const managed = await taskGit.prepare({ taskId: task.id, taskNumber: board.task(task.id).taskNumber, projectRoot: primary });
  if (!operational) await writeFile(path.join(managed.projectRoot, "feature.txt"), originalText.replace("original\n", "delivered\n"));
  const sourceCommit = operational ? base : await commit(managed.projectRoot, "source result without a Test ref");
  // A separate published commit contains the exact port after unrelated history.
  const publicationRoot = path.join(root, "publication");
  await git(primary, "worktree", "add", "-b", "publication", publicationRoot, contained ? sourceCommit : base);
  await writeFile(path.join(publicationRoot, "other.txt"), "another published Task\n");
  const publicationBaseCommit = await commit(publicationRoot, "other delivered work");
  const position = originalText.lastIndexOf("original\n");
  await writeFile(path.join(publicationRoot, "feature.txt"), ambiguous
    ? originalText.slice(0, position) + originalText.slice(position).replace("original\n", "delivered\n") : "delivered\n");
  await writeFile(path.join(publicationRoot, "CHANGELOG.md"), "Original release-owned consolidated notes\n");
  const revision = await commit(publicationRoot, "exact direct publication port");
  await git(primary, "update-ref", "refs/remotes/origin/main", revision);
  durablePublication = { revision, generation: "existing-publication", repositories: [{ root: primary, revision }] };
  const artifact = path.join(runtimeRoot, "prepared.json");
  const prepared = { revision, base, releaseId: "original-direct", prepared: { releaseId: "original-direct" },
    tree: await git(primary, "rev-parse", `${revision}^{tree}`), newManifestSha256: "a".repeat(64) };
  await writeFile(artifact, JSON.stringify(prepared));
  const run = { version: 2, runId: "original-run", status: "published", finishedAt: "2026-10-05T09:30:51Z",
    currentStep: null, error: null, identity: { mode: "direct-user-override", revision, from: base, runtimeRoot, artifact },
    progress: { expectedReleaseId: "original-direct", publicationState: { mode: "direct-user-override", revision,
      generation: "original-generation", tasks: [task.id], repositories: [{ root: primary, revision, baseCommit: base }], artifact } },
    steps: [{ id: "ready", status: "completed" }, { id: "published", status: "completed" }] };
  const runFile = path.join(runtimeRoot, "publication-status.json");
  await writeFile(runFile, JSON.stringify(run));
  const input = { runtimeRoot, publicationRunSha256: sha(await readFile(runFile)), preparedSha256: sha(await readFile(artifact)),
    sourceBaseCommit: base, sourceCommit, publicationBaseCommit };
  const lifecycle = new TaskLifecycleService({ taskBoard: board, workspaceCatalog: catalog, taskGitWorkspaces: taskGit });
  const hub = new HubMcpService({ workspaceCatalog: catalog, taskBoard: board, taskGitWorkspaces: taskGit, taskLifecycle: lifecycle,
    releasePreflight: { preflight: () => assert.fail("cleanup cannot prepare a release") },
    releasePlanner: { plan: () => assert.fail("cleanup cannot select Tasks") },
    releaseCompleter: { completeRelease: () => assert.fail("cleanup cannot publish") },
    workLog: { threadTurns: () => [] }, attachmentDirectory: root, secret: "fixture", reconcilePendingOnStartup: false });
  const token = hub.contextToken({ provider: "codex", threadId: "rm" });
  const call = (name, args) => hub.call(name, { context_token: token, ...args });
  let serial = 0;
  const envelope = operational ? { completion_mode: "operational" }
    : { completion_mode: "published_delivery", published_delivery: input };
  const preview = (extra = {}) => call("hub_task_complete", { request_id: `preview-${++serial}`, task_id: task.id,
    ...envelope, ...extra });
  const confirm = (p, id = "confirmed-original") => call("hub_task_complete", { request_id: id, task_id: task.id,
    ...envelope, confirm_cleanup: true, expected_cleanup_token: p.cleanupToken });
  return { root, primary, runtimeRoot, store, board, catalog, task, managed, taskGit, hub, token, call, preview, confirm,
    run, runFile, artifact, input, base, revision, sourceCommit,
    fault: () => { fault = true; }, get removals() { return removals; } };
}

test("direct published cleanup closes Blocked and deletes only exact published managed artifacts without a Test ref", { timeout: 45_000 }, async t => {
  const f = await fixture(t);
  const run = await readFile(f.runFile), prepared = await readFile(f.artifact);
  const ordinary = await f.call("hub_task_complete", { request_id: "ordinary-preview", task_id: f.task.id });
  assert.ok(ordinary.preview.unpublished.length);
  const p = await f.preview();
  assert.equal(p.confirmationRequired, true);
  assert.equal(p.preview.unpublished.length, 0);
  assert.deepEqual(p.preview.gitReferences, []);
  assert.ok(p.preview.deleting.some(d => d.kind === "branch" && d.name === f.managed.branch));
  const result = await f.confirm(p);
  assert.equal(result.status, "done"); assert.equal(result.workflowStatus, "blocked");
  assert.deepEqual(result.gitReferences, []);
  await assert.rejects(access(f.managed.projectRoot), { code: "ENOENT" });
  await assert.rejects(git(f.primary, "rev-parse", "--verify", `refs/heads/${f.managed.branch}`));
  assert.equal(await git(f.primary, "for-each-ref", "--format=%(refname)", `refs/agent-hub/task-bases/${f.task.id}`), "");
  assert.equal(await git(f.primary, "rev-parse", "main"), f.base);
  assert.equal(await git(f.primary, "rev-parse", "origin/main"), f.revision);
  assert.equal(await git(f.primary, "status", "--porcelain"), "");
  assert.deepEqual(await readFile(f.runFile), run); assert.deepEqual(await readFile(f.artifact), prepared);
  assert.equal((await f.confirm(p)).id, f.task.id); assert.equal(f.removals, 1);
});

test("direct publication cleanup refuses stale evidence, wrong membership, later data and stale preview before deletion", { timeout: 45_000 }, async t => {
  const f = await fixture(t), original = await readFile(f.runFile);
  const worker = await f.catalog.runMutation(() => f.catalog.createStream({ workspaceId: f.board.task(f.task.id).workspaceId,
    name: "Worker", settings: { workingDirectory: f.primary } }));
  await f.catalog.runMutation(() => f.catalog.bindThread({ provider: "codex", threadId: "worker", streamId: worker.id }));
  await assert.rejects(f.preview({ context_token: f.hub.contextToken({ provider: "codex", threadId: "worker" }) }), /Release Manager/);
  await assert.rejects(f.preview({ published_delivery: { ...f.input, publicationRunSha256: "b".repeat(64) } }), /journal changed/);
  f.run.progress.publicationState.tasks = ["foreign-task"];
  await writeFile(f.runFile, JSON.stringify(f.run));
  await assert.rejects(f.preview({ published_delivery: { ...f.input, publicationRunSha256: sha(await readFile(f.runFile)) } }), /membership/);
  await writeFile(f.runFile, original);
  await assert.rejects(f.preview({ published_delivery: { ...f.input, sourceBaseCommit: f.sourceCommit } }), /baseline/);
  const p = await f.preview();
  await writeFile(path.join(f.managed.projectRoot, "feature.txt"), "later dirty work\n");
  await assert.rejects(f.confirm(p, "dirty-confirm"), /changed|later work/);
  await writeFile(path.join(f.managed.projectRoot, "feature.txt"), "delivered\n");
  await mkdir(path.join(f.managed.projectRoot, "ignored"));
  await writeFile(path.join(f.managed.projectRoot, "ignored/evidence.txt"), "useful WIP\n");
  await assert.rejects(f.confirm(p, "ignored-confirm"), /stale|local data|ignored/);
  await rm(path.join(f.managed.projectRoot, "ignored"), { recursive: true });
  await f.board.update({ id: f.task.id, title: "Later metadata" });
  await assert.rejects(f.confirm(p, "stale-confirm"), /stale/);
  await writeFile(path.join(f.managed.projectRoot, "feature.txt"), "later committed work\n");
  await commit(f.managed.projectRoot, "not in the old publication");
  await assert.rejects(f.preview(), /HEAD changed/);
  assert.equal(f.removals, 0); assert.equal(f.board.task(f.task.id).status, "open");
  assert.deepEqual(f.board.task(f.task.id).gitReferences, []);
  assert.equal(await readFile(path.join(f.managed.projectRoot, "feature.txt"), "utf8"), "later committed work\n");
});

test("direct cleanup refuses an unsealed historical Complete without settling it or deleting source", { timeout: 45_000 }, async t => {
  const f = await fixture(t);
  const ordinary = await f.call("hub_task_complete", { request_id: "old-preview", task_id: f.task.id });
  await assert.rejects(f.call("hub_task_complete", { request_id: "old-unsealed-complete", task_id: f.task.id,
    confirm_cleanup: true, expected_cleanup_token: ordinary.cleanupToken }), /before Test|workflow|published|release|Complete/i);
  const old = JSON.stringify(f.catalog.mcpOperation("old-unsealed-complete"));
  await assert.rejects(f.call("hub_task_operation_reconcile", { request_id: "unsealed", task_id: f.task.id,
    operation_request_id: "old-unsealed-complete", confirm_reconcile: true }), /unsealed originals remain unknown/);
  assert.equal(JSON.stringify(f.catalog.mcpOperation("old-unsealed-complete")), old);
  assert.equal(f.removals, 0);
  assert.equal(f.board.task(f.task.id).status, "open");
  assert.equal(await git(f.managed.projectRoot, "rev-parse", "HEAD"), f.sourceCommit);
});

test("direct cleanup reconciles its admitted original after partial deletion", { timeout: 45_000 }, async t => {
  const f = await fixture(t), p = await f.preview(); f.fault();
  await assert.rejects(f.confirm(p), /controlled branch deletion/);
  assert.equal(f.board.task(f.task.id).status, "open");
  assert.equal(f.board.lifecycleTransition("confirmed-original").phase, "cleanup");
  const original = f.catalog.mcpOperation("confirmed-original");
  assert.ok(["unknown", "pending"].includes(original.status));
  const done = await f.call("hub_task_operation_reconcile", { request_id: "original-reconcile", task_id: f.task.id,
    operation_request_id: "confirmed-original", confirm_reconcile: true, project_root: f.primary });
  assert.equal(done.outcome, "COMPLETED"); assert.equal(done.result.status, "done");
  assert.equal(f.catalog.mcpOperation("confirmed-original").status, "succeeded");
  assert.equal(f.removals, 1);
  await assert.rejects(git(f.primary, "rev-parse", "--verify", `refs/heads/${f.managed.branch}`));
  const again = await f.call("hub_task_operation_reconcile", { request_id: "original-readback", task_id: f.task.id,
    operation_request_id: "confirmed-original", confirm_reconcile: true });
  assert.equal(again.result.id, f.task.id); assert.equal(f.removals, 1);
  assert.deepEqual(again.result, done.result);
});

test("direct cleanup recovers an already committed original outcome after a lost MCP reply without replaying Git", { timeout: 45_000 }, async t => {
  const f = await fixture(t), p = await f.preview();
  const complete = f.catalog.completeMcpOperation.bind(f.catalog);
  let lost = false;
  f.catalog.completeMcpOperation = (id, ...args) => {
    if (id === "confirmed-original" && !lost) { lost = true; throw Error("controlled lost terminal MCP write"); }
    return complete(id, ...args);
  };
  await assert.rejects(f.confirm(p), /effect completed but receipt reconciliation is required/);
  assert.equal(f.board.task(f.task.id).status, "done");
  assert.equal(f.board.lifecycleOutcome("confirmed-original").kind, "complete");
  const recovered = await f.call("hub_task_operation_reconcile", { request_id: "lost-reply-reconcile", task_id: f.task.id,
    operation_request_id: "confirmed-original", confirm_reconcile: true });
  assert.equal(recovered.result.id, f.task.id); assert.equal(f.removals, 1);
  assert.equal(f.catalog.mcpOperation("confirmed-original").status, "succeeded");
});

test("completed operational Task deletes zero-own-delta artifacts and resumes its exact partial cleanup without fake Test", { timeout: 45_000 }, async t => {
  const f = await fixture(t, { operational: true }), p = await f.preview();
  assert.equal(p.preview.publishedDelivery.kind, "operational-zero-own-cleanup-v1");
  assert.equal(p.preview.unpublished.length, 0); assert.deepEqual(p.preview.gitReferences, []);
  f.fault(); await assert.rejects(f.confirm(p), /controlled branch deletion/);
  const done = await f.call("hub_task_operation_reconcile", { request_id: "operational-original-reconcile", task_id: f.task.id,
    operation_request_id: "confirmed-original", confirm_reconcile: true });
  assert.equal(done.result.status, "done"); assert.equal(done.result.workflowStatus, "blocked");
  assert.deepEqual(done.result.gitReferences, []); assert.equal(f.removals, 1);
  await assert.rejects(access(f.managed.projectRoot), { code: "ENOENT" });
  await assert.rejects(git(f.primary, "rev-parse", "--verify", `refs/heads/${f.managed.branch}`));
  assert.equal(await git(f.primary, "rev-parse", "main"), f.base);
});

test("operational completion preserves ignored artifacts and refuses any own source commit", { timeout: 45_000 }, async t => {
  const f = await fixture(t, { operational: true }), p = await f.preview();
  await mkdir(path.join(f.managed.projectRoot, "ignored"));
  await writeFile(path.join(f.managed.projectRoot, "ignored/result.txt"), "valuable operational evidence\n");
  await assert.rejects(f.confirm(p, "operational-ignored"), /stale|local data/);
  assert.equal(await readFile(path.join(f.managed.projectRoot, "ignored/result.txt"), "utf8"), "valuable operational evidence\n");
  await rm(path.join(f.managed.projectRoot, "ignored"), { recursive: true });
  await writeFile(path.join(f.managed.projectRoot, "feature.txt"), "unpublished implementation\n");
  await commit(f.managed.projectRoot, "not operational");
  await assert.rejects(f.preview(), /zero own source commits/);
  assert.equal(f.removals, 0); assert.equal(f.board.task(f.task.id).status, "open");
});

test("operational cleanup of an already closed service preserves the complete card and original completion time", { timeout: 45_000 }, async t => {
  const f = await fixture(t, { operational: true });
  await f.board.complete({ id: f.task.id });
  const before = f.board.task(f.task.id), p = await f.preview();
  await f.confirm(p);
  assert.deepEqual(f.board.task(f.task.id), before);
  await assert.rejects(access(f.managed.projectRoot), { code: "ENOENT" });
  assert.equal(f.removals, 1);
});

test("direct delivery membership permits an entire source result actually contained in the original publication", { timeout: 45_000 }, async t => {
  const f = await fixture(t, { contained: true }), p = await f.preview();
  assert.equal(p.preview.publishedDelivery.projection, "published-ancestry");
  assert.equal((await f.confirm(p)).status, "done");
  assert.equal(f.removals, 1); assert.deepEqual(f.board.task(f.task.id).gitReferences, []);
});

test("original confirmed Delete resumes after artifact retirement with preserved dirty bytes and keeps its failed history", { timeout: 60_000 }, async t => {
  const f = await fixture(t, { operational: true });
  const relativePath = "feature.txt", retainedPath = path.join(f.root, "retained-original.txt");
  const value = "original saved useful edit\n";
  await writeFile(path.join(f.managed.projectRoot, relativePath), value);
  await writeFile(retainedPath, value);
  await mkdir(path.join(f.managed.projectRoot, "ignored"));
  await writeFile(path.join(f.managed.projectRoot, "ignored/reproducible.txt"), "owned temporary artifact\n");
  const p = await f.call("hub_task_delete", { request_id: "delete-preview", task_id: f.task.id });
  await assert.rejects(f.call("hub_task_delete", { request_id: "delete-original", task_id: f.task.id,
    confirm_cleanup: true, expected_cleanup_token: p.cleanupToken }), /ignored local data/);
  assert.equal(f.board.lifecycleTransition("delete-original").phase, "failed");
  const original = JSON.stringify(f.catalog.mcpOperation("delete-original"));
  await rm(path.join(f.managed.projectRoot, "ignored"), { recursive: true });
  const files = [{ projectRoot: f.managed.projectRoot, relativePath, retainedPath, sha256: sha(value) }];
  const reconcile = (id, extra = {}) => f.call("hub_task_operation_reconcile", { request_id: id, task_id: f.task.id,
    operation_request_id: "delete-original", cleanup_preview_request_id: "delete-preview", cleanup_preserved_files: files,
    confirm_reconcile: true, ...extra });
  await assert.rejects(reconcile("missing-copy", { cleanup_preserved_files: [] }), /no exact preserved copy/);
  assert.equal(f.catalog.mcpOperation("missing-copy").status, "failed");
  await writeFile(retainedPath, "changed retained file\n");
  await assert.rejects(reconcile("changed-copy"), /hash changed/);
  await writeFile(retainedPath, value);
  await writeFile(path.join(f.managed.projectRoot, relativePath), "new unsaved edit\n");
  await assert.rejects(reconcile("changed-source"), /differs from its preserved file/);
  await writeFile(path.join(f.managed.projectRoot, relativePath), value);
  assert.equal(JSON.stringify(f.catalog.mcpOperation("delete-original")), original); assert.equal(f.removals, 0);
  f.fault(); await assert.rejects(reconcile("partial-cleanup"), /controlled branch deletion/);
  assert.equal(f.board.lifecycleTransition("delete-original").phase, "cleanup");
  const completed = await reconcile("finish-original");
  assert.equal(completed.outcome, "COMPLETED"); assert.equal(completed.result.deleted, true);
  assert.equal("rawText" in completed.result.task, false);
  assert.equal(f.catalog.mcpOperation("delete-original").status, "succeeded"); assert.equal(f.removals, 1);
  assert.equal(f.board.lifecycleOutcome("delete-original").result.evidence.cleanupForward.originalFailure.phase, "failed");
  assert.match(f.board.lifecycleOutcome("delete-original").result.evidence.cleanupForward.originalFailure.error, /ignored local data/);
  assert.equal(await readFile(retainedPath, "utf8"), value);
  assert.deepEqual((await reconcile("original-readback")).result, completed.result); assert.equal(f.removals, 1);
});

test("original Delete continuation rejects Task drift and a different successful preview", { timeout: 45_000 }, async t => {
  const f = await fixture(t, { operational: true });
  await mkdir(path.join(f.managed.projectRoot, "ignored"));
  await writeFile(path.join(f.managed.projectRoot, "ignored/temp.txt"), "owned artifact\n");
  const p = await f.call("hub_task_delete", { request_id: "preview-one", task_id: f.task.id });
  await assert.rejects(f.call("hub_task_delete", { request_id: "original-delete", task_id: f.task.id,
    confirm_cleanup: true, expected_cleanup_token: p.cleanupToken }), /ignored local data/);
  const original = JSON.stringify(f.catalog.mcpOperation("original-delete"));
  await rm(path.join(f.managed.projectRoot, "ignored"), { recursive: true });
  await f.call("hub_task_delete", { request_id: "preview-two", task_id: f.task.id });
  const reconcile = (id, preview) => f.call("hub_task_operation_reconcile", { request_id: id, task_id: f.task.id,
    operation_request_id: "original-delete", cleanup_preview_request_id: preview, confirm_reconcile: true });
  await assert.rejects(reconcile("wrong-preview", "preview-two"), /argument hash/);
  await f.board.update({ id: f.task.id, title: "changed after original admission" });
  await assert.rejects(reconcile("task-drift", "preview-one"), /Task\/CAS changed/);
  assert.equal(JSON.stringify(f.catalog.mcpOperation("original-delete")), original);
  assert.equal(f.removals, 0); await access(f.managed.projectRoot);
});

test("confirmed Delete continuation completes the same original after its sole ignored artifact is retired", { timeout: 45_000 }, async t => {
  const f = await fixture(t, { operational: true });
  await mkdir(path.join(f.managed.projectRoot, "ignored"));
  await writeFile(path.join(f.managed.projectRoot, "ignored/temporary.txt"), "reproducible fixture artifact\n");
  const p = await f.call("hub_task_delete", { request_id: "legacy-preview", task_id: f.task.id });
  await assert.rejects(f.call("hub_task_delete", { request_id: "legacy-delete", task_id: f.task.id,
    confirm_cleanup: true, expected_cleanup_token: p.cleanupToken }), /ignored local data/);
  await rm(path.join(f.managed.projectRoot, "ignored"), { recursive: true });
  const result = await f.call("hub_task_operation_reconcile", { request_id: "legacy-original-reconcile", task_id: f.task.id,
    operation_request_id: "legacy-delete", cleanup_preview_request_id: "legacy-preview", project_root: f.primary, confirm_reconcile: true });
  assert.equal(result.outcome, "COMPLETED"); assert.equal(result.result.deleted, true);
  assert.equal(f.catalog.mcpOperation("legacy-delete").status, "succeeded"); assert.equal(f.removals, 1);
});

test("closed service cleanup reuses its canonical closure for a historical repository instead of today's publication", { timeout: 45_000 }, async t => {
  const f = await fixture(t, { operational: true });
  const child = f.store.create({ text: "Published fixture result", bucket: "workspace", workspaceId: f.board.task(f.task.id).workspaceId });
  await f.board.setWorkflowStatus({ id: child.id, status: "done" }); await f.board.complete({ id: child.id });
  await f.board.updateChecklist({ id: f.task.id, operation: "add", text: "Published fixture child", expectedRevision: f.board.task(f.task.id).revision, requestId: "add-child" });
  await f.board.updateChecklist({ id: f.task.id, operation: "link", itemId: f.board.task(f.task.id).checklist[0].id,
    linkedTaskId: child.id, expectedRevision: f.board.task(f.task.id).revision, requestId: "link-child" });
  const actual = f.taskGit.publishedReleaseServiceEvidenceOwned;
  // Controlled existing reader port: this test covers consumption of its
  // canonical lifecycle outcome. Actual archived-manifest verification is the
  // separately maintained HUB-360 owner coverage, not simulated publication.
  f.taskGit.publishedReleaseServiceEvidenceOwned = async ({ source }) => ({ version: 1, mode: "published_release_service",
    source: { taskId: source.id, taskRevision: source.revision }, publicationGeneration: "original-published-generation",
    publishedRevision: f.revision, preserving: [{ projectRoot: f.primary, branch: f.managed.branch, headCommit: f.base }] });
  const args = { task_id: f.task.id, completion_mode: "published_release_service" };
  const p = await f.call("hub_task_complete", { ...args, request_id: "service-close-preview" });
  await f.call("hub_task_complete", { ...args, request_id: "service-close-original", confirm_cleanup: true, expected_cleanup_token: p.cleanupToken });
  f.taskGit.publishedReleaseServiceEvidenceOwned = actual;
  f.taskGit.readPublication = async () => null;
  const before = f.board.task(f.task.id);
  await assert.rejects(f.preview({ completed_operation_request_id: "not-its-closure" }), /canonical closed outcome/);
  const cleanup = await f.preview({ completed_operation_request_id: "service-close-original" });
  await f.call("hub_task_complete", { task_id: f.task.id, completion_mode: "operational",
    completed_operation_request_id: "service-close-original", request_id: "closed-source-cleanup",
    confirm_cleanup: true, expected_cleanup_token: cleanup.cleanupToken });
  assert.deepEqual(f.board.task(f.task.id), before); assert.equal(f.removals, 1);
});

test("direct cleanup refuses identical patch lines applied to a different repeated source context", { timeout: 45_000 }, async t => {
  const f = await fixture(t, { ambiguous: true });
  await assert.rejects(f.preview(), /Ambiguous publication projection context/);
  assert.equal(f.removals, 0); assert.equal(f.board.task(f.task.id).status, "open");
  await access(f.managed.projectRoot);
});

for (const distinctWorking of [false, true]) test(`original Delete preserves every staged and working version (distinctWorking=${distinctWorking})`, { timeout: 45_000 }, async t => {
  const f = await fixture(t, { operational: true });
  const staged = Buffer.from("unpublished staged bytes\n"), working = distinctWorking ? Buffer.from("different working bytes\n") : staged;
  const relativePath = "feature.txt", file = path.join(f.managed.projectRoot, relativePath);
  await writeFile(file, staged); await git(f.managed.projectRoot, "add", relativePath);
  await writeFile(file, working);
  const index = await git(f.managed.projectRoot, "ls-files", "--stage");
  await mkdir(path.join(f.managed.projectRoot, "ignored"));
  await writeFile(path.join(f.managed.projectRoot, "ignored/temporary.txt"), "owned fixture artifact\n");
  const p = await f.call("hub_task_delete", { request_id: "versions-preview", task_id: f.task.id });
  await assert.rejects(f.call("hub_task_delete", { request_id: "versions-original", task_id: f.task.id,
    confirm_cleanup: true, expected_cleanup_token: p.cleanupToken }), /ignored local data/);
  await rm(path.join(f.managed.projectRoot, "ignored"), { recursive: true });
  const original = f.catalog.mcpOperation("versions-original"), before = f.board.task(f.task.id);
  const copy = async (name, value) => {
    const retainedPath = path.join(f.root, name); await writeFile(retainedPath, value);
    return { projectRoot: f.managed.projectRoot, relativePath, retainedPath, sha256: sha(value) };
  };
  const workingCopy = await copy("working-copy.txt", working);
  const reconcile = (id, files) => f.call("hub_task_operation_reconcile", { request_id: id, task_id: f.task.id,
    operation_request_id: "versions-original", cleanup_preview_request_id: "versions-preview",
    cleanup_preserved_files: files, confirm_reconcile: true });
  await assert.rejects(reconcile("incomplete-versions", distinctWorking ? [workingCopy] : []), /preserved (?:copy|file)/);
  assert.equal(f.removals, 0); assert.deepEqual(f.catalog.mcpOperation("versions-original"), original);
  assert.deepEqual(f.board.task(f.task.id), before); assert.deepEqual(await readFile(file), working);
  assert.equal(await git(f.managed.projectRoot, "ls-files", "--stage"), index);
  const files = distinctWorking ? [workingCopy, await copy("staged-copy.txt", staged)] : [workingCopy];
  const completed = await reconcile("all-versions", files);
  assert.equal(completed.result.deleted, true); assert.equal(f.removals, 1);
  for (const item of files) assert.equal(sha(await readFile(item.retainedPath)), item.sha256);
  assert.deepEqual((await reconcile("versions-readback", files)).result, completed.result);
  assert.equal(f.removals, 1);
});

async function publishedHead(f, message) {
  const root = path.join(f.root, "publication"), revision = message ? await commit(root, message) : await git(root, "rev-parse", "HEAD");
  await git(f.primary, "update-ref", "refs/remotes/origin/main", revision);
  f.run.identity.revision = revision;
  f.run.progress.publicationState.revision = revision;
  f.run.progress.publicationState.repositories[0].revision = revision;
  const prepared = JSON.parse(await readFile(f.artifact, "utf8"));
  prepared.revision = revision; prepared.tree = await git(root, "rev-parse", `${revision}^{tree}`);
  await writeFile(f.artifact, JSON.stringify(prepared));
  await writeFile(f.runFile, JSON.stringify(f.run));
  f.input.publicationRunSha256 = sha(await readFile(f.runFile));
  f.input.preparedSha256 = sha(await readFile(f.artifact));
  f.taskGit.readPublication = async () => ({ revision, generation: "existing-publication", repositories: [{ root: f.primary, revision }] });
  return revision;
}

async function combinedFixture(t) {
  const f = await fixture(t), root = path.join(f.root, "publication");
  const middle = f.input.publicationBaseCommit;
  // The own port shares one commit with another Task; another port follows it.
  await writeFile(path.join(root, "other.txt"), "different Task in the same commit\n");
  await git(root, "add", ".");
  await git(root, "-c", "user.name=Fixture", "-c", "user.email=fixture@local.invalid", "commit", "--amend", "--no-edit");
  await writeFile(path.join(root, "feature.txt"), "delivered\n\nindependent later tail\n");
  await publishedHead(f, "later independent contribution");
  f.input.publicationBaseCommit = f.base;
  f.middle = middle;
  return f;
}

test("combined original delivery preserves a complete earlier Task port and other later bytes", { timeout: 45_000 }, async t => {
  const f = await combinedFixture(t), file = path.join(f.root, "publication", "feature.txt");
  const before = await readFile(file), journal = await readFile(f.runFile);
  const p = await f.preview();
  const result = await f.confirm(p);
  assert.equal(result.status, "done");
  assert.equal(f.board.task(f.task.id).status, "done");
  assert.deepEqual(await readFile(file), before); assert.deepEqual(await readFile(f.runFile), journal);
  assert.equal(f.removals, 1);
});

test("combined original delivery reads an explicitly retained journal without changing its current pointer", { timeout: 45_000 }, async t => {
  const f = await combinedFixture(t), raw = await readFile(f.runFile);
  const archive = path.join(f.root, "original-publication.json"); await writeFile(archive, raw);
  await writeFile(f.runFile, JSON.stringify({ ...f.run, runId: "later-current-run" }));
  await assert.rejects(f.preview(), /journal changed/);
  f.input.publicationJournalPath = archive;
  await assert.rejects(f.preview({ published_delivery: { ...f.input, publicationRunSha256: "f".repeat(64) } }), /journal changed/);
  const current = await readFile(f.runFile), p = await f.preview();
  await f.confirm(p);
  assert.deepEqual(await readFile(f.runFile), current); assert.deepEqual(await readFile(archive), raw);
  assert.equal(f.removals, 1);
});

test("combined original delivery refuses arbitrary ranges, incomplete survival, duplicate contexts and mode drift", { timeout: 45_000 }, async t => {
  const f = await combinedFixture(t), root = path.join(f.root, "publication"), file = path.join(root, "feature.txt");
  await f.preview();
  await assert.rejects(f.preview({ published_delivery: { ...f.input, publicationBaseCommit: f.middle } }), /projection parent/);
  await writeFile(file, "original\n\nindependent later tail\n"); await publishedHead(f, "own contribution missing");
  await assert.rejects(f.preview(), /projection context/);
  await writeFile(file, "delivered\n\ndelivered\n"); await publishedHead(f, "ambiguous repeated contribution");
  await assert.rejects(f.preview(), /projection context/);
  await writeFile(file, "delivered\n\nindependent later tail\n"); await publishedHead(f, "restore complete contribution");
  await git(root, "update-index", "--chmod=+x", "feature.txt");
  await git(root, "-c", "user.name=Fixture", "-c", "user.email=fixture@local.invalid", "commit", "-m", "different published mode");
  await publishedHead(f, null);
  await assert.rejects(f.preview(), /path or mode/);
  assert.equal(f.removals, 0); assert.equal(f.board.task(f.task.id).status, "open");
  await access(f.managed.projectRoot);
});

test("combined original delivery requires whole binary identity in its final composition", { timeout: 45_000 }, async t => {
  const f = await combinedFixture(t), root = path.join(f.root, "publication");
  const value = Buffer.from([0, 1, 2, 10]);
  await writeFile(path.join(f.managed.projectRoot, "feature.txt"), value);
  f.input.sourceCommit = await commit(f.managed.projectRoot, "own binary result");
  await writeFile(path.join(root, "feature.txt"), value); await publishedHead(f, "complete binary contribution");
  await f.preview();
  await writeFile(path.join(root, "feature.txt"), Buffer.from([0, 1, 3, 10])); await publishedHead(f, "different final binary");
  await assert.rejects(f.preview(), /Binary publication projection differs/);
  assert.equal(f.removals, 0); assert.deepEqual(await readFile(path.join(f.managed.projectRoot, "feature.txt")), value);
});

test("combined original delivery refuses after-text elsewhere when the original replacement is missing", { timeout: 45_000 }, async t => {
  const f = await combinedFixture(t), root = path.join(f.root, "publication");
  await writeFile(path.join(root, "feature.txt"),
    "original\n\nunrelated other contribution\n\ndelivered\n\nindependent later tail\n");
  await publishedHead(f, "retain original while appending after-text elsewhere");
  const before = f.board.task(f.task.id), journal = await readFile(f.runFile);
  const index = await git(f.managed.projectRoot, "ls-files", "--stage");
  await assert.rejects(f.preview(), /complete Task delta|composition|projection/);
  assert.deepEqual(f.board.task(f.task.id), before); assert.equal(f.removals, 0);
  assert.equal(await readFile(path.join(f.managed.projectRoot, "feature.txt"), "utf8"), "delivered\n");
  assert.equal(await git(f.managed.projectRoot, "ls-files", "--stage"), index);
  assert.deepEqual(await readFile(f.runFile), journal); await access(f.managed.projectRoot);
});
