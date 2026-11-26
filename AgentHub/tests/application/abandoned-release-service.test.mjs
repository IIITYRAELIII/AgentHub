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
import { TaskIntegrationService } from "../../src/application/task-integration-service.mjs";
import { TaskBoardStore } from "../../src/infrastructure/persistence/task-board-store.mjs";
import { WorkspaceCatalogStore } from "../../src/infrastructure/persistence/workspace-catalog-store.mjs";
import { releaseIdentitySha256 } from "../../src/domain/legacy-task-publication-proof.mjs";
import { TaskGitWorkspaceService } from "../../src/infrastructure/filesystem/task-git-workspace.mjs";
import { TaskIntegrationGitService } from "../../src/infrastructure/filesystem/task-integration-git.mjs";
import { openTaskAwaitCutoverRuntime } from "../../task-await-cutover.mjs";
import { createPersistenceMutationCapabilities } from "../../src/composition/persistence-mutation-composition.mjs";

const exec = promisify(execFile);
const git = async (cwd, ...args) => String((await exec("git", args, { cwd, windowsHide: true })).stdout).trim();

async function fixture(t, { assignedStream = true, canonicalRuntime = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "hub-abandoned-release-"));
  const primary = path.join(root, "repository"), dataDir = path.join(root, "data");
  await mkdir(primary); await mkdir(dataDir);
  await git(primary, "init", "--initial-branch=main");
  await writeFile(path.join(primary, "source.txt"), "retained source\n");
  await git(primary, "add", ".");
  await git(primary, "-c", "user.name=Fixture", "-c", "user.email=fixture@local.invalid", "commit", "-m", "source");
  const commit = await git(primary, "rev-parse", "HEAD"), tree = await git(primary, "rev-parse", "HEAD^{tree}");
  const databaseFile = path.join(dataDir, "journal.sqlite");
  const catalog = new WorkspaceCatalogStore({ databaseFile }); await catalog.load();
  const store = new TaskBoardStore({ databaseFile });
  t.after(async () => { store.close(); catalog.close(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  const workspace = await catalog.runMutation(() => catalog.createWorkspace({ name: "Release", settings: {
    workingDirectory: primary, releaseWorkflowEnabled: true, taskPrefix: "HUB",
  } }));
  const stream = await catalog.runMutation(() => catalog.createStream({ workspaceId: workspace.id, name: "RM",
    settings: { releaseManager: true, workingDirectory: primary } }));
  await catalog.runMutation(() => catalog.bindThread({ provider: "codex", threadId: "rm", streamId: stream.id }));
  const capabilities = createPersistenceMutationCapabilities({ rawWorkspaceCatalogStore: catalog, rawTaskBoardStore: store });
  const board = new TaskBoardService({ store: capabilities.taskBoardStore, workspaceCatalog: capabilities.workspaceCatalogStore });
  const child = store.create({ text: "Selected source", bucket: "workspace", workspaceId: workspace.id, taskPrefix: "HUB", triageStatus: "disabled" });
  const task = store.create({ text: "Abandoned release", bucket: "workspace", workspaceId: workspace.id, taskPrefix: "HUB", triageStatus: "disabled" });
  // Seed a historical accepted reference in this disposable SQLite fixture only.
  const db = new DatabaseSync(databaseFile);
  if (assignedStream) db.prepare("UPDATE hub_board_tasks SET stream_id=? WHERE id=?").run(stream.id, task.id);
  db.prepare("UPDATE hub_board_tasks SET workflow_status='awaiting_implementation' WHERE id=?").run(child.id);
  db.prepare("INSERT INTO hub_task_git_references (task_id,project_root,branch,result_commit,updated_at_ms) VALUES (?,?,?,?,1)")
    .run(child.id, primary, child.taskNumber, commit);
  db.close();
  let current = store.task(task.id);
  const added = store.updateChecklist({ id: task.id, operation: "add", text: "Selected", expectedRevision: current.revision, requestId: "add" });
  store.updateChecklist({ id: task.id, operation: "link", itemId: added.itemId, linkedTaskId: child.id,
    releaseReference: { taskRevision: store.task(child.id).revision, gitReferences: store.task(child.id).gitReferences },
    expectedRevision: added.task.revision, requestId: "link" });
  // Historical rows in disposable SQLite only: no removed release writer/runtime.
  const historicalFile = path.join(dataDir, "runtime.sqlite");
  const historical = new DatabaseSync(historicalFile);
  historical.exec(`CREATE TABLE IF NOT EXISTS release_operations(operation_id TEXT PRIMARY KEY, workspace_id TEXT, state TEXT, operation_json TEXT);
    CREATE TABLE IF NOT EXISTS release_candidate_generations(operation_id TEXT,generation INTEGER,identity_sha256 TEXT,generation_json TEXT,PRIMARY KEY(operation_id,generation));`);
  const digest = releaseIdentitySha256;
  const authorization = { taskIds: [child.id], approvedTargets: [{ id: "production", kind: "git-runtime" }], validationMode: "full" };
  const generationBody = { operationId: "failed-release", generation: 1,
    repositoryBases: [{ repositoryRoot: primary, baseCommit: commit }],
    selectedResults: [{ taskId: child.id, resultCommit: commit, acceptanceRevision: 1 }],
    candidates: [{ repositoryRoot: primary, releaseRoot: path.join(root, "frozen"), commit, tree, manifestHash: "f".repeat(64) }], runnerVersion: "fixture" };
  const operation = { operationId: "failed-release", requestId: "original-release", workspaceId: workspace.id,
    streamId: stream.id, threadId: "rm", revision: 3, currentGeneration: 1, owner: null,
    state: "failed", completedAt: "2026-11-18T00:00:00.000Z", lastError: { step: "compose", message: "retained failure" },
    authorization: { ...authorization, fingerprint: digest(authorization) }, selectedResults: generationBody.selectedResults };
  historical.prepare("INSERT INTO release_operations VALUES (?,?,?,?)")
    .run(operation.operationId, operation.workspaceId, operation.state, JSON.stringify(operation));
  historical.prepare("INSERT INTO release_candidate_generations VALUES (?,?,?,?)").run(operation.operationId, 1,
    digest(generationBody), JSON.stringify({ ...generationBody, identitySha256: digest(generationBody) }));
  historical.close();
  const releases = {
    get(id) { const db = new DatabaseSync(historicalFile, { readOnly: true });
      try { const row = db.prepare("SELECT operation_json FROM release_operations WHERE operation_id=?").get(id);
        return row && JSON.parse(row.operation_json); } finally { db.close(); } },
    snapshot(id) { return this.get(id); },
  };
  const taskGit = new TaskGitWorkspaceService({ dataDir, prepareDependencies: async () => ({}), recordTiming: () => {} });
  const releaseGit = new TaskIntegrationGitService({ dataDir });
  const preflight = new TaskIntegrationService({ releasePlanner: { plan: () => assert.fail("no publication selection") },
    taskGitWorkspaces: taskGit, releaseGitWorkspaces: releaseGit,
    resolveReleaseValidationSource: () => assert.fail("no validation source"),
    readPublicationState: () => assert.fail("no publication read"),
    validateProductionCandidate: () => assert.fail("no publication validation") });
  const lifecycle = new TaskLifecycleService({ taskBoard: board, workspaceCatalog: catalog, taskGitWorkspaces: taskGit, releasePreflight: preflight });

  let hub = new HubMcpService({ workspaceCatalog: catalog, taskBoard: board, taskGitWorkspaces: taskGit, taskLifecycle: lifecycle,
    releasePreflight: preflight, releasePlanner: { plan: () => assert.fail("no selection") },
    releaseCompleter: { completeRelease: () => assert.fail("no publication") },
    workLog: { threadTurns: () => [] }, attachmentDirectory: root, secret: "fixture", reconcilePendingOnStartup: false });
  if (canonicalRuntime) {
    const runtime = await openTaskAwaitCutoverRuntime({ config: { dataDir, taskBoard: { autoPlaceConfidence: 0.9 } },
      openStores: async () => ({ workspaceCatalogStore: catalog, taskBoardStore: store }),
      taskGitWorkspaces: taskGit, releaseGitWorkspaces: releaseGit, releasePreflight: preflight });
    hub = runtime.service;
  }
  const token = hub.contextToken({ provider: "codex", threadId: "rm" });
  const call = (name, args) => hub.call(name, { context_token: token, ...args });
  const failed = releases.get(operation.operationId);
  const input = { operationId: failed.operationId, expectedRevision: failed.revision, expectedGeneration: failed.currentGeneration };
  const args = { task_id: task.id, completion_mode: "abandoned_release_service", abandoned_release: input };
  return { root, primary, dataDir, store, board, catalog, task, child, releases, taskGit, lifecycle, hub, call, args, failed, stream,
    preview: () => call("hub_task_complete", { ...args, request_id: "preview" }),
    confirm: p => call("hub_task_complete", { ...args, request_id: "confirmed", confirm_cleanup: true, expected_cleanup_token: p.cleanupToken }) };
}

async function retainUnknownPreview(f) {
  const owner = f.taskGit.abandonedReleaseServiceEvidenceOwned.bind(f.taskGit);
  f.taskGit.abandonedReleaseServiceEvidenceOwned = async input => {
    await owner(input);
    throw new Error("controlled lost preview reply");
  };
  try { await assert.rejects(f.preview(), /controlled lost preview reply/); }
  finally { f.taskGit.abandonedReleaseServiceEvidenceOwned = owner; }
  const receipt = f.catalog.mcpOperation("preview");
  assert.equal(receipt.status, "unknown");
  assert.equal(f.board.lifecycleOutcome("preview"), null);
  return receipt;
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

test("unassigned workspace service retains the recorded release actor without assigning a Stream", async t => {
  const f = await fixture(t, { assignedStream: false, canonicalRuntime: true });
  assert.equal(f.board.task(f.task.id).streamId, null);
  const before = f.releases.snapshot(f.failed.operationId), p = await f.preview();
  assert.equal(p.preview.releaseService.actor.streamId, f.stream.id);
  const result = await f.confirm(p);
  assert.equal(result.status, "done");
  assert.equal(result.workflowStatus, "new");
  assert.equal(f.board.task(f.task.id).streamId, null);
  assert.deepEqual(f.releases.snapshot(f.failed.operationId), before);
});

test("same UNKNOWN abandoned preview recovers its exact readonly intent with a null-Stream card", async t => {
  const f = await fixture(t, { assignedStream: false, canonicalRuntime: true });
  const original = await retainUnknownPreview(f), before = f.releases.snapshot(f.failed.operationId);
  assert.equal(original.status, "unknown");
  assert.equal(f.board.lifecycleTransition("preview"), null);
  await assert.rejects(f.call("hub_task_operation_reconcile", { request_id: "bad-preview-hash", task_id: f.task.id,
    operation_request_id: "preview", expected_arguments_hash: "0".repeat(64), confirm_reconcile: true }), /original operation arguments differ/i);
  const recovered = await f.call("hub_task_operation_reconcile", { request_id: "recover-preview", task_id: f.task.id,
    operation_request_id: "preview", expected_arguments_hash: original.argumentsHash, confirm_reconcile: true });
  assert.equal(recovered.outcome, "PREVIEW_RECOVERED");
  assert.equal(recovered.result.confirmationRequired, true);
  assert.equal(f.board.task(f.task.id).status, "open");
  assert.equal(f.board.lifecycleOutcome("preview"), null);
  const readback = await f.call("hub_task_operation_get", { operation_request_id: "preview", task_id: f.task.id,
    expected_arguments_hash: original.argumentsHash });
  assert.equal(readback.taskOperation.status, "succeeded");
  assert.equal(readback.result.cleanupToken, recovered.result.cleanupToken);
  assert.equal(readback.result.operatorReconciliation.priorReceipt.error, original.error);
  assert.equal((await f.confirm(recovered.result)).status, "done");
  assert.deepEqual(f.releases.snapshot(f.failed.operationId), before);
});

test("a different ordinary Stream reconciles the preview by ID and keeps the original release actor", async t => {
  const f = await fixture(t, { assignedStream: false, canonicalRuntime: true }), original = await retainUnknownPreview(f);
  const other = await f.catalog.runMutation(() => f.catalog.createStream({ workspaceId: f.stream.workspaceId, name: "Ordinary" }));
  await f.catalog.runMutation(() => f.catalog.bindThread({ provider: "claude", threadId: "ordinary", streamId: other.id }));
  const token = f.hub.contextToken({ provider: "claude", threadId: "ordinary" });
  const recovered = await f.hub.call("hub_task_operation_reconcile", { context_token: token, operation_request_id: "preview" });
  assert.equal(recovered.outcome, "PREVIEW_RECOVERED");
  assert.equal(recovered.result.preview.releaseService.actor.streamId, f.stream.id);
  const control = f.catalog.mcpOperations(f.stream.workspaceId).find(item => item.toolName === "hub_task_operation_reconcile");
  assert.equal(control.streamId, other.id);
  const stored = f.catalog.mcpOperation("preview");
  assert.equal(stored.streamId, original.streamId);
  assert.equal(stored.result.operatorReconciliation.priorReceipt.error, original.error);
  await assert.rejects(f.hub.call("hub_task_complete", { context_token: token, ...f.args,
    abandoned_release: { ...f.args.abandoned_release, expectedRevision: f.failed.revision + 1 },
    request_id: "ordinary-stale-release-preview" }), /exact idle FAILED/);
  assert.equal(f.board.task(f.task.id).status, "open");
  assert.equal(f.releases.get(f.failed.operationId).state, "failed");
});

test("lost preview-reconciliation reply reads the same completed preview without archiving twice", async t => {
  const f = await fixture(t, { assignedStream: false, canonicalRuntime: true }), original = await retainUnknownPreview(f);
  const complete = f.catalog.completeMcpOperation.bind(f.catalog); let lost = false;
  f.catalog.completeMcpOperation = (id, ...args) => {
    if (id === "recover-preview" && !lost) { lost = true; throw Error("controlled lost reconciliation reply"); }
    return complete(id, ...args);
  };
  await assert.rejects(f.call("hub_task_operation_reconcile", { request_id: "recover-preview", task_id: f.task.id,
    operation_request_id: "preview", expected_arguments_hash: original.argumentsHash, confirm_reconcile: true }), /effect completed but receipt reconciliation is required/);
  const stored = f.catalog.mcpOperation("preview");
  assert.equal(stored.status, "succeeded");
  assert.equal(f.board.task(f.task.id).status, "open");
  assert.equal(f.board.lifecycleOutcome("preview"), null);
  const readback = await f.call("hub_task_operation_get", { operation_request_id: "preview", task_id: f.task.id,
    expected_arguments_hash: original.argumentsHash });
  assert.equal(readback.result.cleanupToken, stored.result.cleanupToken);
  const again = await f.call("hub_task_operation_reconcile", { request_id: "recover-preview", task_id: f.task.id,
    operation_request_id: "preview", expected_arguments_hash: original.argumentsHash, confirm_reconcile: true });
  assert.equal(again.result.cleanupToken, stored.result.cleanupToken);
  assert.deepEqual(f.catalog.mcpOperation("preview"), stored);
  assert.equal((await f.confirm(readback.result)).status, "done");
  assert.equal(f.releases.get(f.failed.operationId).state, "failed");
});

test("an unresolved ID-only retry preserves its control receipt until the same ID recovers the original", async t => {
  const f = await fixture(t, { assignedStream: false, canonicalRuntime: true });
  const original = await retainUnknownPreview(f);
  const stream = await f.catalog.runMutation(() => f.catalog.createStream({
    workspaceId: f.stream.workspaceId, name: "Ordinary",
  }));
  await f.catalog.runMutation(() => f.catalog.bindThread({ provider: "claude", threadId: "ordinary", streamId: stream.id }));
  const args = { context_token: f.hub.contextToken({ provider: "claude", threadId: "ordinary" }),
    request_id: "recover-preview", operation_request_id: "preview" };
  const reconcile = "hub_task_operation_reconcile";
  const evidenceOwned = f.taskGit.abandonedReleaseServiceEvidenceOwned.bind(f.taskGit);
  const complete = f.catalog.completeMcpOperation.bind(f.catalog);
  let refuse = true;
  f.taskGit.abandonedReleaseServiceEvidenceOwned = async input => {
    if (refuse) throw new Error("controlled temporary refusal");
    return evidenceOwned(input);
  };
  f.catalog.completeMcpOperation = (id, ...rest) => {
    if (id === args.request_id) throw new Error("controlled first receipt write loss");
    return complete(id, ...rest);
  };
  await assert.rejects(f.hub.call(reconcile, args), /receipt reconciliation is required/);
  f.catalog.completeMcpOperation = complete;
  const control = f.catalog.mcpOperation(args.request_id);
  assert.equal(control.status, "unknown");
  assert.equal((await f.hub.call(reconcile, { ...args, request_id: "fresh-refused" })).outcome, "unknown");
  assert.equal(f.catalog.mcpOperation("fresh-refused").status, "succeeded");

  await f.hub.submitTaskOperation(reconcile, args);
  const refused = await f.hub.joinSubmittedTaskOperation(args);
  assert.equal(refused.taskOperation.status, "unknown");
  assert.equal(refused.taskOperation.active, false);
  assert.deepEqual(f.catalog.mcpOperation(args.request_id), control);
  assert.deepEqual(f.catalog.mcpOperation("preview"), original);

  refuse = false;
  await f.hub.submitTaskOperation(reconcile, args);
  const recovered = await f.hub.joinSubmittedTaskOperation(args);
  assert.equal(recovered.taskOperation.status, "succeeded");
  assert.equal(recovered.result.outcome, "PREVIEW_RECOVERED");
  assert.equal(recovered.result.result.preview.releaseService.actor.streamId, f.stream.id);
  const stored = f.catalog.mcpOperation("preview");
  assert.equal(stored.status, "succeeded");
  assert.equal(stored.argumentsHash, original.argumentsHash);
  assert.equal(stored.result.operatorReconciliation.priorReceipt.error, original.error);
  assert.equal(f.board.lifecycleOutcome("preview"), null);
  assert.equal(f.board.task(f.task.id).status, "open");
  assert.equal((await f.hub.call(reconcile, args)).outcome, "PREVIEW_RECOVERED");
  assert.deepEqual(f.catalog.mcpOperation("preview"), stored);
});

test("abandoned closure refuses stale/foreign originals and a running worker before intake", async t => {
  const f = await fixture(t), before = f.releases.snapshot(f.failed.operationId);
  for (const [name, patch] of Object.entries({ missing: { operationId: "missing" }, stale: { expectedRevision: f.failed.revision + 1 },
    generation: { expectedGeneration: 2 } })) {
    await assert.rejects(f.call("hub_task_complete", { ...f.args, request_id: name,
      abandoned_release: { ...f.args.abandoned_release, ...patch } }), /exact idle FAILED/);
  }
  const db = new DatabaseSync(path.join(f.dataDir, "runtime.sqlite"));
  db.prepare("UPDATE release_operations SET operation_json=? WHERE operation_id=?")
    .run(JSON.stringify({ ...f.failed, owner: { ownerId: "still-active" } }), f.failed.operationId); db.close();
  await assert.rejects(f.preview(), /active worker|exact idle FAILED/);
  const restore = new DatabaseSync(path.join(f.dataDir, "runtime.sqlite"));
  assert.deepEqual(JSON.parse(restore.prepare("SELECT operation_json FROM release_operations WHERE operation_id=?").get(f.failed.operationId).operation_json),
    { ...f.failed, owner: { ownerId: "still-active" } }, "refusal preserves the active original");
  restore.prepare("UPDATE release_operations SET operation_json=? WHERE operation_id=?").run(JSON.stringify(f.failed), f.failed.operationId); restore.close();
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
  const preview = await f.preview();
  assert.equal((await f.confirm(preview)).status, "done");
  assert.deepEqual(f.catalog.mcpOperation("old-operational"), original, "fresh archive cannot settle the old UNKNOWN");
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
