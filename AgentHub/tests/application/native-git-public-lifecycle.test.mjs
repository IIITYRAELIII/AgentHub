import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { HubMcpService } from "../../src/application/hub-mcp-service.mjs";
import { TaskBoardService } from "../../src/application/task-board-service.mjs";
import { TaskLifecycleService } from "../../src/application/task-lifecycle-service.mjs";
import { TaskReleasePlanService } from "../../src/application/task-release-plan-service.mjs";
import { WorkspaceReleasePreflightService } from "../../src/application/workspace-release-preflight-service.mjs";
import { TaskBoardStore } from "../../src/infrastructure/persistence/task-board-store.mjs";
import { WorkspaceCatalogStore } from "../../src/infrastructure/persistence/workspace-catalog-store.mjs";
import { TaskGitWorkspaceService } from "../../src/infrastructure/filesystem/task-git-workspace.mjs";
import { ReleaseGitWorkspaceService } from "../../src/infrastructure/filesystem/release-git-workspace.mjs";
import { ReleaseOperationService } from "../../src/application/release-operation-service.mjs";
import { WorkspaceReleaseOperationAdapter } from "../../src/application/workspace-release-operation-adapter.mjs";
import { ReleaseOperationStore } from "../../src/infrastructure/persistence/release-operation-store.mjs";

const exec = promisify(execFile);
async function git(cwd, ...args) {
  return String((await exec("git", args, { cwd, windowsHide: true })).stdout).trim();
}
async function commit(root, message) {
  await git(root, "add", ".");
  return git(root, "-c", "user.name=Fixture", "-c", "user.email=fixture@local.invalid", "commit", "-m", message);
}
async function fixture(t, { releaseMetadata = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "hub-native-public-"));
  const primary = path.join(root, "primary"), origin = path.join(root, "origin.git");
  await mkdir(primary);
  await git(primary, "init", "--initial-branch=main");
  await writeFile(path.join(primary, "shared.txt"), "main\n");
  if (releaseMetadata) {
    await mkdir(path.join(primary, "AgentHub"));
    const pkg = { name: "agent-hub", version: "2026.9.25", type: "module" };
    await writeFile(path.join(primary, "AgentHub", "package.json"), JSON.stringify(pkg));
    await writeFile(path.join(primary, "AgentHub", "package-lock.json"), JSON.stringify({
      ...pkg, lockfileVersion: 3, packages: { "": pkg },
    }));
  }
  await commit(primary, "main");
  const base = await git(primary, "rev-parse", "HEAD");
  await git(root, "init", "--bare", "--initial-branch=main", origin);
  await git(primary, "remote", "add", "origin", origin);
  await git(primary, "push", "origin", "main");
  const databaseFile = path.join(root, "hub.sqlite"), dataDir = path.join(root, "data");
  let catalog, store, board, taskGit, releaseGit, preflight, lifecycle, service, token;
  let releaseStore, releaseOperations;
  let workspace, stream;
  const publication = { generation: "fixture", repositories: [{ root: primary, revision: base }] };
  const open = async () => {
    catalog = new WorkspaceCatalogStore({ databaseFile }); await catalog.load();
    store = new TaskBoardStore({ databaseFile });
    if (!workspace) {
      workspace = await catalog.runMutation(() => catalog.createWorkspace({ name: "Native", settings: {
        workingDirectory: primary, releaseWorkflowEnabled: true,
      } }));
      stream = await catalog.runMutation(() => catalog.createStream({ workspaceId: workspace.id,
        name: "RM", settings: { releaseManager: true, workingDirectory: primary } }));
      await catalog.runMutation(() => catalog.bindThread({ provider: "codex", threadId: "fixture-thread", streamId: stream.id }));
    }
    board = new TaskBoardService({ store, workspaceCatalog: catalog });
    taskGit = new TaskGitWorkspaceService({ dataDir, readPublication: async () => publication, recordTiming: () => {} });
    releaseGit = new ReleaseGitWorkspaceService({ dataDir });
    preflight = new WorkspaceReleasePreflightService({
      releasePlanner: new TaskReleasePlanService({ taskBoard: board, taskGitWorkspaces: taskGit }),
      taskGitWorkspaces: taskGit, releaseGitWorkspaces: releaseGit,
      readPublicationState: async () => publication,
      resolveReleaseValidationSource: () => assert.fail("Await must not refresh a shared Contour"),
      validateProductionCandidate: () => assert.fail("Await must not publish or run broad validation"),
    });
    lifecycle = new TaskLifecycleService({ taskBoard: board, workspaceCatalog: catalog, taskGitWorkspaces: taskGit, releasePreflight: preflight });
    await mkdir(path.join(root, "release-operations"), { recursive: true });
    releaseStore = new ReleaseOperationStore({ dataDir: path.join(root, "release-operations") });
    const adapter = new WorkspaceReleaseOperationAdapter({ releasePreflight: preflight,
      publication: { publish: () => assert.fail("Fixture never publishes"), readback: () => assert.fail("Fixture never reads production") },
      finalization: { finalize: () => assert.fail("Fixture never finalizes publication") } });
    releaseOperations = new ReleaseOperationService({ store: releaseStore,
      processAlive: pid => pid === process.pid, compose: input => adapter.compose(input),
      validate: async () => { throw Object.assign(new Error("Fixture stops at validation boundary"), { code: "RELEASE_VALIDATION_FAILED" }); },
      publishTarget: input => adapter.publishTarget(input), readTarget: input => adapter.readTarget(input),
      finalize: input => adapter.finalize(input) });
    service = new HubMcpService({ workspaceCatalog: catalog, taskBoard: board, workLog: { threadTurns: () => [] },
      taskGitWorkspaces: taskGit, taskLifecycle: lifecycle, releasePreflight: preflight,
      releaseOperations,
      releaseCompleter: { completeRelease: () => assert.fail("No publication") },
      attachmentDirectory: path.join(root, "attachments"), secret: "synthetic-native-fixture", reconcilePendingOnStartup: false });
    token = service.contextToken({ provider: "codex", threadId: "fixture-thread" });
  };
  await open();
  t.after(async () => { store.close(); catalog.close(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
  return {
    root, primary, base, workspace,
    get board() { return board; }, get taskGit() { return taskGit; }, get lifecycle() { return lifecycle; }, get catalog() { return catalog; },
    get preflight() { return preflight; },
    get publication() { return publication; },
    get releaseGit() { return releaseGit; },
    async release(task, originMain = base) {
      const args = { context_token: token, request_id: "native-release-original", task_ids: [task.id],
        validation_mode: "focused", approved_targets: [{ targetId: "fixture", kind: "git", repositoryRoot: primary,
          approvedLocalMainCommit: base, approvedOriginMainCommit: originMain }] };
      const ack = await service.call("hub_release_run", args);
      const snapshot = await releaseOperations.drain(ack.operationId);
      const replay = await service.call("hub_release_run", args);
      assert.equal(replay.operationId, ack.operationId);
      const read = await service.call("hub_release_get", { context_token: token, operation_id: ack.operationId });
      assert.equal(read.operation.operationId, ack.operationId);
      return snapshot;
    },
    async reopen() { store.close(); catalog.close(); await open(); },
    async create(name) {
      const task = store.create({ text: name, bucket: "workspace", workspaceId: workspace.id });
      const prepared = await taskGit.prepare({ taskId: task.id, taskNumber: task.taskNumber, projectRoot: primary });
      return { id: task.id, root: prepared.projectRoot };
    },
    async status(task, status, request, overrides = {}) {
      const current = board.task(task.id);
      return service.call("hub_task_status_update", { context_token: token, request_id: request,
        task_id: task.id, status, expected_task_revision: current.revision,
        expected_workflow_status: current.workflowStatus, ...overrides });
    },
    async reconcile(task, request, original, revision, workflowStatus) {
      return service.call("hub_task_operation_reconcile", { context_token: token, request_id: request,
        task_id: task.id, operation_request_id: original, project_root: primary,
        confirm_reconcile: true,
        expected_task_revision: revision, expected_workflow_status: workflowStatus });
    },
  };
}

test("public real SQLite Test and Await merge exact full branches and exclude Test-only", { timeout: 180_000 }, async t => {
  const f = await fixture(t), a = await f.create("A"), b = await f.create("Test only");
  await assert.rejects(f.status(a, "testing", "closed-legacy-preview", { selected_proof_bundle_path: "unused.bundle" }),
    { code: "TASK_NATIVE_GIT_REQUIRED" });
  assert.equal(f.catalog.mcpOperation("closed-legacy-preview").status, "failed");
  assert.equal(f.board.lifecycleTransition("closed-legacy-preview"), null);
  assert.equal(await git(f.primary, "rev-parse", "main"), f.base);
  await writeFile(path.join(a.root, "first.txt"), "first\n"); await commit(a.root, "first");
  await writeFile(path.join(a.root, "second.txt"), "second\n"); await commit(a.root, "second");
  const aResult = await git(a.root, "rev-parse", "HEAD");
  await writeFile(path.join(b.root, "excluded.txt"), "not selected\n");
  assert.equal((await f.status(a, "testing", "test-a")).workflowStatus, "testing");
  assert.equal((await f.status(b, "testing", "test-b")).workflowStatus, "testing");
  const accepted = await f.status(a, "awaiting_implementation", "await-a");
  assert.equal(accepted.workflowStatus, "awaiting_implementation");
  assert.equal(accepted.releaseCandidate.status, "prepared", accepted.releaseCandidate.reason);
  const candidate = (await f.preflight.prepareAwaitSet({ workspaceId: f.workspace.id })).releaseCandidates[0];
  assert.equal(await git(candidate.releaseRoot, "show", "PreRelease:first.txt"), "first");
  assert.equal(await git(candidate.releaseRoot, "show", "PreRelease:second.txt"), "second");
  await assert.rejects(git(candidate.releaseRoot, "show", "PreRelease:excluded.txt"));
  assert.equal(await git(candidate.releaseRoot, "merge-base", "--is-ancestor", aResult, "PreRelease"), "");
  await writeFile(path.join(a.root, "first.txt"), "corrected\n");
  assert.equal((await f.status(a, "testing", "test-a-correction")).workflowStatus, "testing");
  const correctedSource = f.board.task(a.id).gitReferences[0].resultCommit;
  assert.notEqual(correctedSource, aResult);
  assert.equal((await f.status(a, "awaiting_implementation", "await-a-correction")).workflowStatus, "awaiting_implementation");
  const corrected = (await f.preflight.prepareAwaitSet({ workspaceId: f.workspace.id })).releaseCandidates[0];
  assert.equal(await git(corrected.releaseRoot, "show", "PreRelease:first.txt"), "corrected");
  assert.equal(await git(corrected.releaseRoot, "show", "PreRelease:second.txt"), "second");
  await assert.rejects(git(corrected.releaseRoot, "show", "PreRelease:excluded.txt"));
  assert.equal(await git(corrected.releaseRoot, "merge-base", "--is-ancestor", correctedSource, "PreRelease"), "");
  assert.equal(await git(f.primary, "rev-parse", "main"), f.base);
});

test("public native conflict keeps dev and resumes the ordinary resolution commit", { timeout: 180_000 }, async t => {
  const f = await fixture(t), a = await f.create("A"), b = await f.create("B");
  await writeFile(path.join(a.root, "shared.txt"), "A\n"); await f.status(a, "testing", "test-a");
  const dev = await git(f.primary, "rev-parse", "dev");
  await writeFile(path.join(b.root, "shared.txt"), "B\n");
  let conflict;
  await assert.rejects(f.status(b, "testing", "test-b-conflict"), error => {
    assert.equal(error.code, "TASK_INTEGRATION_CONFLICT"); conflict = error.details; return true;
  });
  assert.equal(await git(f.primary, "rev-parse", "dev"), dev);
  assert.equal(f.board.lifecycleTransition("test-b-conflict").phase, "failed");
  const source = await git(b.root, "rev-parse", "HEAD");
  assert.equal(await git(conflict.nativeConflictRoot, "rev-parse", "MERGE_HEAD"), source);
  await writeFile(path.join(conflict.nativeConflictRoot, "shared.txt"), "A+B\n");
  await commit(conflict.nativeConflictRoot, "resolve shared file");
  const resolution = await git(conflict.nativeConflictRoot, "rev-parse", "HEAD");
  assert.equal((await f.status(b, "testing", "test-b-resolved")).workflowStatus, "testing");
  assert.equal(await git(f.primary, "rev-parse", "dev"), resolution);
  assert.equal(await git(f.primary, "show", "dev:shared.txt"), "A+B");
});

test("public native lost terminal and source drift retain UNKNOWN through SQLite reopen", { timeout: 180_000 }, async t => {
  const f = await fixture(t), a = await f.create("A");
  await writeFile(path.join(a.root, "a.txt"), "result\n");
  const before = f.board.task(a.id), original = "test-a-lost-terminal";
  const terminal = f.board.commitWorkflowTransition.bind(f.board);
  f.board.commitWorkflowTransition = () => { throw new Error("fixture lost terminal before SQL commit"); };
  await assert.rejects(f.status(a, "testing", original));
  const dev = await git(f.primary, "rev-parse", "dev");
  assert.equal(f.board.lifecycleTransition(original).phase, "pending_git");
  f.board.commitWorkflowTransition = terminal;
  await writeFile(path.join(a.root, "a.txt"), "foreign resumed work\n");
  await f.reopen();
  const refused = await f.reconcile(a, "reconcile-dirty", original, before.revision, before.workflowStatus);
  assert.equal(refused.outcome, "unknown");
  assert.equal(f.board.task(a.id).workflowStatus, before.workflowStatus);
  assert.equal(await readFile(path.join(a.root, "a.txt"), "utf8"), "foreign resumed work\n");
  await git(a.root, "restore", "a.txt");
  const restored = await f.reconcile(a, "reconcile-restored", original, before.revision, before.workflowStatus);
  assert.equal(restored.outcome, "succeeded");
  assert.equal(f.board.task(a.id).workflowStatus, "testing");
  assert.equal(await git(f.primary, "rev-parse", "dev"), dev);
});

test("public durable release composes native immutable generation with separately approved main history", { timeout: 180000 }, async t => {
  const f = await fixture(t, { releaseMetadata: true }), a = await f.create("A");
  await writeFile(path.join(a.root, "a.txt"), "selected\n");
  await f.status(a, "testing", "test-a");
  await f.status(a, "awaiting_implementation", "await-a");
  const source = f.board.task(a.id).gitReferences[0].resultCommit;
  const publishedRoot = path.join(f.root, "published-history");
  await git(f.primary, "worktree", "add", "-b", "published-history", publishedRoot, f.base);
  await writeFile(path.join(publishedRoot, "published-context.txt"), "separate approved history\n");
  await commit(publishedRoot, "published history");
  const published = await git(publishedRoot, "rev-parse", "HEAD");
  await git(publishedRoot, "push", "origin", `${published}:refs/heads/main`);
  f.publication.repositories[0].revision = published;
  const snapshot = await f.release(a, published);
  assert.equal(snapshot.operation.state, "waiting", JSON.stringify(snapshot.operation.lastError));
  assert.equal(snapshot.operation.waitReason.code, "validation_failed");
  assert.equal(snapshot.generations.length, 1);
  const generation = snapshot.generations[0];
  assert.equal(generation.selectedResults[0].resultCommit, source);
  const candidate = generation.candidates[0];
  assert.equal(candidate.baseCommit, f.base);
  assert.equal(candidate.manifest.compositionPolicy, "main-selected-git-merge-v1");
  assert.equal(candidate.manifest.baseProvenance.approvedOriginMainCommit, published);
  assert.equal(candidate.manifest.baseProvenance.agreedMainCommit, f.base);
  assert.equal(await git(candidate.releaseRoot, "merge-base", "--is-ancestor", source, candidate.commit), "");
  await assert.rejects(git(candidate.releaseRoot, "show", `${candidate.commit}:published-context.txt`));
  assert.equal(await git(candidate.releaseRoot, "show", `${candidate.commit}:a.txt`), "selected");
  assert.equal(await git(f.primary, "rev-parse", "main"), f.base);
  // Frozen operation bytes coexist with continued Task work. No Task freeze.
  assert.equal((await f.status(a, "in_progress", "return-a")).workflowStatus, "in_progress");
  assert.equal(await git(candidate.releaseRoot, "rev-parse", "HEAD"), candidate.commit);
});
