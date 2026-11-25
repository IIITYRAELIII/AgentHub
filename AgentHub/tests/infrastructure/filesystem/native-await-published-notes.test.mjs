import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { TaskIntegrationGitService } from "../../../src/infrastructure/filesystem/task-integration-git.mjs";
import { publicationStateFile } from "../../../src/infrastructure/persistence/publication-state.mjs";
import { mcpArgumentsHash } from "../../../src/domain/mcp-arguments-hash.mjs";
import { WorkspaceCatalogStore } from "../../../src/infrastructure/persistence/workspace-catalog-store.mjs";
import { TaskBoardStore } from "../../../src/infrastructure/persistence/task-board-store.mjs";
import { TaskBoardService } from "../../../src/application/task-board-service.mjs";
import { TaskLifecycleService } from "../../../src/application/task-lifecycle-service.mjs";
import { TaskIntegrationService } from "../../../src/application/task-integration-service.mjs";
import { TaskOperationReconciliationService } from "../../../src/application/task-operation-reconciliation-service.mjs";
import { archivePublishedNotesCheckout } from "../../../src/infrastructure/filesystem/native-await-published-notes-recovery.mjs";

const execute = promisify(execFile);
async function git(root, ...args) {
  return String((await execute("git", args, { cwd: root, windowsHide: true })).stdout).trim();
}
async function commit(root, message) {
  await git(root, "add", "-A");
  await git(root, "-c", "user.name=Fixture", "-c", "user.email=fixture@local.invalid", "commit", "-m", message);
  return git(root, "rev-parse", "HEAD");
}
async function fixture(t, { interrupted = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "await-archive-"));
  const closeOwners = [];
  t.after(async () => {
    for (const close of closeOwners) await close();
    await rm(root, { recursive: true, force: true });
  });
  const primary = path.join(root, "primary"), origin = path.join(root, "origin.git");
  await git(root, "init", "--bare", "--initial-branch=main", origin);
  await git(root, "clone", origin, primary);
  await mkdir(path.join(primary, "AgentHub"));
  await writeFile(path.join(primary, ".gitattributes"), "* text eol=lf\n");
  await writeFile(path.join(primary, ".gitignore"), "private.bin\n");
  await writeFile(path.join(primary, "CHANGELOG.md"), "old\n");
  const packages = version => ({
    "AgentHub/package.json": { name: "fixture", version },
    "AgentHub/package-lock.json": { version, lockfileVersion: 3, packages: { "": { name: "fixture", version } } },
  });
  for (const [file, value] of Object.entries(packages("1.0.0"))) await writeFile(path.join(primary, file), JSON.stringify(value));
  const base = await commit(primary, "main");
  await git(primary, "push", "origin", "main");
  const environment = { ...process.env, LOCALAPPDATA: root, XDG_STATE_HOME: root };
  const service = new TaskIntegrationGitService({ dataDir: path.join(root, "data"), environment });
  async function result(id) {
    const folder = path.join(root, id);
    await git(primary, "worktree", "add", "-b", id, folder, base);
    await writeFile(path.join(folder, id + ".txt"), id + "\n");
    return { taskId: id, taskRevision: 3, baseCommit: base, resultCommit: await commit(folder, id) };
  }
  const oldTask = await result("old"), selected = await result("selected");
  const request = task => ({ projectRoot: primary, workspaceId: "workspace", planRevision: task.taskId,
    approvedBaseCommit: base, frozenTasks: [task] });
  const prior = await service.prepareCandidate(request(oldTask));
  if (interrupted) {
    const publication = publicationStateFile(environment);
    await mkdir(path.dirname(publication), { recursive: true });
    await writeFile(publication, JSON.stringify({ repositories: [{ root: primary, revision: base }] }));
    return { root, primary, base, service, selected, oldTask, prior, request, closeOwners };
  }
  const publishedRoot = path.join(root, "publisher");
  await git(root, "clone", prior.releaseRoot, publishedRoot);
  await git(publishedRoot, "checkout", "--detach", prior.preReleaseHead);
  await writeFile(path.join(publishedRoot, "CHANGELOG.md"), "published\n");
  for (const [file, value] of Object.entries(packages("2.0.0"))) await writeFile(path.join(publishedRoot, file), JSON.stringify(value));
  const published = await commit(publishedRoot, "publish metadata");
  await git(publishedRoot, "push", origin, published + ":refs/heads/main");
  const stateFile = publicationStateFile(environment);
  await mkdir(path.dirname(stateFile), { recursive: true });
  await writeFile(stateFile, JSON.stringify({ repositories: [{ root: primary, revision: published }] }));
  await git(prior.releaseRoot, "fetch", "origin", "main");
  await writeFile(path.join(prior.releaseRoot, "CHANGELOG.md"), "published\n");
  await git(prior.releaseRoot, "add", "CHANGELOG.md");
  const privateBytes = Buffer.from([0, 255, 7, 99]);
  await writeFile(path.join(prior.releaseRoot, "private.bin"), privateBytes);
  const ownerRoot = path.dirname(prior.releaseRoot), checkpointFile = path.join(ownerRoot, "checkpoint.json");
  const checkpoint = await readFile(checkpointFile), index = await readFile(path.join(prior.releaseRoot, ".git/index"));
  const original = { operationId: "original-await", taskId: selected.taskId, taskRevision: 8,
    workspaceId: "workspace", resultCommit: selected.resultCommit, argumentsHash: "a".repeat(64), originMainCommit: published };
  return { root, primary, origin, service, selected, request, prior, published, ownerRoot, checkpointFile,
    checkpoint, index, privateBytes, original, recovery: { ...request(selected), nativeAwaitRecovery: original } };
}

test("same original Await archives published notes and whole prior clone before ordinary sole-result composition", async t => {
  const f = await fixture(t);
  await assert.rejects(f.service.prepareCandidate(f.request(f.selected)), { code: "AWAIT_PREPARATION_UNKNOWN" });
  const retainedIndex = await readFile(path.join(f.prior.releaseRoot, ".git/index"));
  const inspected = await f.service.inspectNativeAwaitRecovery({ projectRoot: f.primary,
    original: f.original, frozenTasks: [f.selected] });
  await assert.rejects(f.service.prepareCandidate({ ...f.recovery, commitPrepared: async () => {
    throw new Error("definite Task CAS rejection");
  } }), /definite Task CAS rejection/u);
  assert.deepEqual(await readFile(path.join(inspected.archiveRoot, "repository/.git/index")), retainedIndex);
  const candidate = await f.service.prepareCandidate(f.recovery);
  assert.equal(candidate.manifest.cutover.originalOperationId, f.original.operationId);
  const archive = inspected.archiveRoot;
  assert.deepEqual(await readFile(path.join(archive, "repository/.git/index")), retainedIndex);
  assert.deepEqual(await readFile(path.join(archive, "checkpoint.json")), f.checkpoint);
  assert.deepEqual(await readFile(path.join(archive, "repository/private.bin")), f.privateBytes);
  assert.equal(await git(path.join(archive, "repository"), "rev-parse", "HEAD"), f.prior.preReleaseHead);
  assert.equal(await git(candidate.releaseRoot, "show", "PreRelease:selected.txt"), "selected");
  await assert.rejects(git(candidate.releaseRoot, "show", "PreRelease:old.txt"));
  assert.equal(await git(f.primary, "rev-parse", "main"), f.selected.baseCommit);
  assert.equal(await git(f.primary, "status", "--porcelain"), "");
  assert.notEqual(candidate.releaseGitCommonDir, candidate.primaryGitCommonDir);
  assert.equal((await f.service.prepareCandidate(f.recovery)).preReleaseHead, candidate.preReleaseHead);
  assert.deepEqual(await readFile(path.join(archive, "repository/.git/index")), retainedIndex);
});

test("archived failure hands exact physical evidence to a new Await and resumes its own journal", async t => {
  const f = await fixture(t);
  const layout = { root: f.ownerRoot, primaryRoot: f.primary, releaseRoot: f.prior.releaseRoot,
    evidenceRoot: path.join(f.ownerRoot, "evidence"), checkpointFile: f.checkpointFile };
  const { assertReleaseCloneForPublication } = await import("../../../src/infrastructure/filesystem/task-integration-git.mjs");
  const archived = await archivePublishedNotesCheckout({ layout, original: f.original, frozenTasks: [f.selected], publishedRevision: f.published,
    gitAt: async (cwd, args, options = {}) => {
      const response = await execute("git", args, { cwd, windowsHide: true, encoding: options.rawOutput ? "buffer" : "utf8" });
      return options.rawOutput ? response.stdout : response.stdout.trim();
    },
    assertClone: repositoryRoot => assertReleaseCloneForPublication({ repositoryRoot }),
    readJson: file => readFile(file, "utf8").then(JSON.parse), validate: async () => {},
    writeJson: (file, value) => writeFile(file, JSON.stringify(value)),
  });
  const evidence = await readFile(path.join(archived.descriptor.archiveRoot, "evidence.json"));
  assert.deepEqual(await f.service.archivedNativeAwaitOriginal({ projectRoot: f.primary }), f.original);
  const successor = { ...f.original, operationId: "new-ordinary-await", argumentsHash: "b".repeat(64), predecessor: f.original };
  await assert.rejects(f.service.prepareCandidate({ ...f.request(f.selected),
    nativeAwaitRecovery: { ...successor, resultCommit: "c".repeat(40) } }), /successor selection/u);
  let callbacks = 0;
  await assert.rejects(f.service.prepareCandidate({ ...f.request(f.selected), nativeAwaitRecovery: successor,
    commitPrepared: async () => { callbacks++; throw Object.assign(new Error("Task terminal unknown"), { code: "AWAIT_ACCEPTANCE_UNKNOWN" }); },
  }), { code: "AWAIT_ACCEPTANCE_UNKNOWN" });
  const journalFile = path.join(f.ownerRoot, "native-preparation.json");
  const pending = JSON.parse(await readFile(journalFile, "utf8"));
  assert.equal(pending.requestId, successor.operationId);
  assert.equal(pending.awaitSuccessor.operationId, successor.operationId);
  assert.equal(pending.publishedNotesArchive.original.operationId, f.original.operationId);
  await assert.rejects(f.service.prepareCandidate({ ...f.request(f.selected),
    nativeAwaitRecovery: { ...successor, operationId: "different-successor" } }), /archive journal owner/u);
  const candidate = await f.service.prepareCandidate({ ...f.request(f.selected), nativeAwaitRecovery: successor,
    commitPrepared: async () => { callbacks++; } });
  assert.equal(callbacks, 2);
  assert.equal(candidate.manifest.cutover.originalOperationId, f.original.operationId);
  assert.equal(JSON.parse(await readFile(journalFile, "utf8")).phase, "completed");
  assert.equal(await f.service.archivedNativeAwaitOriginal({ projectRoot: f.primary, operationId: "later-unrelated-await" }), null);
  assert.equal((await f.service.prepareCandidate({ ...f.request(f.selected), nativeAwaitRecovery: successor })).preReleaseHead, candidate.preReleaseHead);
  assert.deepEqual(await readFile(path.join(archived.descriptor.archiveRoot, "evidence.json")), evidence);
  assert.deepEqual(await readFile(path.join(archived.descriptor.archiveRoot, "repository/.git/index")), f.index);
  assert.equal(await git(f.primary, "status", "--porcelain"), "");
});

test("postarchive origin drift refuses promotion and Task callback while retaining archive", async t => {
  const f = await fixture(t);
  let changed = false, committed = 0;
  const proof = await f.service.inspectNativeAwaitRecovery({ projectRoot: f.primary, original: f.original, frozenTasks: [f.selected] });
  await assert.rejects(f.service.prepareCandidate({ ...f.recovery,
    validateBeforeCommit: async () => {
      if (!changed && await git(f.prior.releaseRoot, "symbolic-ref", "HEAD") === "refs/heads/main") {
        changed = true;
        await git(f.primary, "push", "--force", "origin", f.selected.baseCommit + ":refs/heads/main");
      }
    },
    commitPrepared: async () => { committed++; },
  }), { code: "AWAIT_PREPARATION_UNKNOWN" });
  assert.equal(changed, true); assert.equal(committed, 0);
  assert.deepEqual(await readFile(path.join(proof.archiveRoot, "repository/.git/index")), f.index);
  assert.deepEqual(await readFile(path.join(proof.archiveRoot, "checkpoint.json")), f.checkpoint);
  // Reopen the same archive after restoring only this disposable origin. A
  // drift in the application callback must fail its final authority read too.
  await git(f.primary, "fetch", path.join(proof.archiveRoot, "repository"), f.published);
  await git(f.primary, "push", "--force", "origin", f.published + ":refs/heads/main");
  let callbacks = 0;
  await assert.rejects(f.service.prepareCandidate({ ...f.recovery,
    commitPrepared: async prepared => {
      callbacks++;
      await git(f.primary, "push", "--force", "origin", f.selected.baseCommit + ":refs/heads/main");
      await prepared.verifyNativeAwaitAuthority();
      committed++;
    },
  }), { code: "AWAIT_PREPARATION_UNKNOWN" });
  assert.equal(callbacks, 1); assert.equal(committed, 0);
  assert.deepEqual(await readFile(path.join(proof.archiveRoot, "repository/.git/index")), f.index);
});

test("unpublished/staged/selection/original/publication drift refuse before archiving", async t => {
  const f = await fixture(t);
  const inspect = original => f.service.inspectNativeAwaitRecovery({ projectRoot: f.primary,
    original, frozenTasks: [f.selected] });
  await writeFile(path.join(f.prior.releaseRoot, "CHANGELOG.md"), "foreign\n");
  await assert.rejects(inspect(f.original), /sole staged/u);
  await writeFile(path.join(f.prior.releaseRoot, "CHANGELOG.md"), "published\n");
  await writeFile(path.join(f.prior.releaseRoot, "foreign.txt"), "late\n");
  await assert.rejects(inspect(f.original), /sole staged/u);
  await rm(path.join(f.prior.releaseRoot, "foreign.txt"));
  await assert.rejects(inspect({ ...f.original, resultCommit: "b".repeat(40) }), /single original/u);
  await assert.rejects(f.service.inspectNativeAwaitRecovery({ projectRoot: f.primary,
    original: f.original, frozenTasks: [f.selected, f.selected] }), /single original/u);
  await git(f.primary, "push", "--force", "origin", f.selected.baseCommit + ":refs/heads/main");
  await assert.rejects(inspect(f.original), /origin pin/u);
  assert.equal(await git(f.prior.releaseRoot, "rev-parse", "HEAD"), f.prior.preReleaseHead);
  assert.deepEqual(await readFile(f.checkpointFile), f.checkpoint);
});

test("durable archive intent resumes after checkpoint-move boundary and rejects another original", async t => {
  const f = await fixture(t);
  // Inject failure at the persisted intent boundary, retaining all real Git/filesystem evidence.
  const layout = { root: f.ownerRoot, primaryRoot: f.primary, releaseRoot: f.prior.releaseRoot,
    evidenceRoot: path.join(f.ownerRoot, "evidence"), checkpointFile: f.checkpointFile };
  const { assertReleaseCloneForPublication } = await import("../../../src/infrastructure/filesystem/task-integration-git.mjs");
  const options = { layout, original: f.original, frozenTasks: [f.selected], publishedRevision: f.published,
    gitAt: async (cwd, args, options = {}) => {
      const response = await execute("git", args, { cwd, windowsHide: true, encoding: options.rawOutput ? "buffer" : "utf8" });
      return options.rawOutput ? response.stdout : response.stdout.trim();
    },
    assertClone: repositoryRoot => assertReleaseCloneForPublication({ repositoryRoot }),
    readJson: file => readFile(file, "utf8").then(JSON.parse),
    validate: async () => {},
    writeJson: async (file, value) => {
      await writeFile(file, JSON.stringify(value));
      if (value.phase === "published-notes-archived") throw new Error("crash after move");
    },
  };
  await assert.rejects(archivePublishedNotesCheckout(options), /crash after move/u);
  await assert.rejects(f.service.prepareCandidate({ ...f.recovery,
    nativeAwaitRecovery: { ...f.original, operationId: "another-await" } }), /original or publication/u);
  const candidate = await f.service.prepareCandidate(f.recovery);
  assert.equal(await git(candidate.releaseRoot, "show", "PreRelease:selected.txt"), "selected");
});

test("same original Await continues a clean detached prepared checkout before ref promotion", t => verifyInterruptedAwait(t));
test("durable cancellation immediately before the promotion permit leaves both old pointers", t =>
  verifyInterruptedAwait(t, "before"));
test("durable cancellation after the promotion permit retains the applied effect on the original", t =>
  verifyInterruptedAwait(t, "after"));

async function verifyInterruptedAwait(t, cancellation = null) {
  const f = await fixture(t, { interrupted: true });
  const databaseFile = path.join(f.root, "tasks.sqlite");
  const catalog = new WorkspaceCatalogStore({ databaseFile });
  const store = new TaskBoardStore({ databaseFile });
  f.closeOwners.push(() => { store.close(); catalog.close(); });
  await catalog.load();
  const workspace = await catalog.runMutation(() => catalog.createWorkspace({ name: "Fixture",
    settings: { workingDirectory: f.primary, releaseWorkflowEnabled: true } }));
  const stream = await catalog.runMutation(() => catalog.createStream({ workspaceId: workspace.id, name: "Executor" }));
  const board = new TaskBoardService({ store, workspaceCatalog: catalog });
  const created = store.create({ text: "Fix", bucket: "workspace", workspaceId: workspace.id });
  await board.claim({ id: created.id, workspaceId: workspace.id, streamId: stream.id,
    provider: "codex", threadId: "fixture", turnId: "turn", operationId: "claim" });
  const testTransition = { id: created.id, operationId: "test", kind: "workflow", targetWorkflowStatus: "testing",
    expectedRevision: board.task(created.id).revision };
  await board.beginLifecycleTransition(testTransition);
  await board.commitWorkflowTransition({ operationId: "test", gitReferences: [{
    projectRoot: f.primary, branch: "HUB-1", resultCommit: f.selected.resultCommit,
  }], evidence: { resultCommit: f.selected.resultCommit } });
  const task = board.task(created.id);
  const selected = { ...f.selected, taskId: task.id, taskRevision: task.revision };
  const oldHead = f.prior.preReleaseHead, releaseRoot = f.prior.releaseRoot;
  const journalFile = path.join(path.dirname(releaseRoot), "native-preparation.json");
  const checkpointFile = path.join(path.dirname(releaseRoot), "checkpoint.json");
  const oldCheckpoint = await readFile(checkpointFile);
  const selection = [f.oldTask, selected];
  const request = { ...f.request(selected), workspaceId: workspace.id, frozenTasks: selection,
    baseProvenance: { schemaVersion: 1, kind: "agreed-main-native-git-v1", publishedBaseCommit: f.base,
      agreedMainCommit: f.base, compositionBaseCommit: f.base } };
  const operationId = "interrupted-await";
  const args = { request_id: operationId, task_id: task.id, status: "awaiting_implementation",
    expected_task_revision: task.revision, expected_workflow_status: "testing" };
  const argumentsHash = mcpArgumentsHash(args);
  await catalog.runMutation(() => catalog.beginMcpOperation({ requestId: operationId,
    workspaceId: workspace.id, streamId: stream.id, provider: "codex", threadId: "fixture",
    toolName: "hub_task_status_update", argumentsHash }));
  await board.beginLifecycleTransition({ id: task.id, operationId, kind: "workflow",
    targetWorkflowStatus: "awaiting_implementation", expectedRevision: task.revision, evidence: {} });
  const original = { operationId, taskId: selected.taskId, workspaceId: workspace.id,
    argumentsHash, resultCommit: selected.resultCommit, taskRevision: task.revision };
  const first = new Error("injected authority failure after physical checkout");
  let checks = 0, failure;
  // Omit the newly written requestId to reproduce the installed v1 journal.
  await assert.rejects(f.service.prepareCandidate({ ...request, validateBeforeCommit: async () => {
    if (++checks === 3) {
      assert.equal(await git(releaseRoot, "rev-parse", "refs/heads/PreRelease"), oldHead);
      await assert.rejects(git(releaseRoot, "symbolic-ref", "-q", "HEAD"));
      throw first;
    }
  }, commitPrepared: async () => assert.fail("Task CAS before authority") }), error => {
    assert.equal(error.code, "AWAIT_PREPARATION_UNKNOWN");
    assert.equal(error.cause, first);
    assert.equal(error.phase, "post-checkout authority");
    assert.match(error.message, /injected authority failure.*rollback\/readback:.*checkout changed/u);
    assert.match(error.readbackError.message, /checkout changed/u);
    failure = error;
    return true;
  });
  await catalog.runMutation(() => catalog.markMcpOperationUnknown(operationId, failure));
  const journalBytes = await readFile(journalFile);
  const journal = JSON.parse(journalBytes), target = journal.target;
  assert.equal(journal.phase, "prepared");
  assert.equal(journal.requestId, undefined);
  assert.notEqual(target, oldHead);
  assert.equal(await git(releaseRoot, "rev-parse", "HEAD"), target);
  assert.deepEqual(await readFile(checkpointFile), oldCheckpoint);
  const inspect = source => f.service.inspectNativeAwaitRecovery({ projectRoot: f.primary,
    original: source, frozenTasks: [selected] });
  const proof = await inspect(original);
  assert.equal(proof.original.originMainCommit, f.base);
  assert.deepEqual(await readFile(journalFile), journalBytes);
  const prepare = (requestOverrides, commitPrepared = async () => assert.fail("foreign evidence reached the Task CAS")) =>
    f.service.prepareCandidate({
    ...request, ...requestOverrides, awaitOperationId: original.operationId,
    nativeAwaitRecovery: { ...proof.original, preparedPromotion: proof.preparedPromotion },
    commitPrepared,
  });
  await assert.rejects(prepare({ frozenTasks: [selected] }), /completed native selection|evidence file|ENOENT/u);
  const futureManifest = path.join(path.dirname(releaseRoot), "evidence", journal.manifestHash + ".json");
  await writeFile(futureManifest, "foreign manifest", { flag: "wx" });
  await assert.rejects(prepare({}), /promoted checkpoint or manifest differs/u);
  assert.equal(await readFile(futureManifest, "utf8"), "foreign manifest");
  await rm(futureManifest);
  await assert.rejects(f.service.prepareCandidate({ ...request, awaitOperationId: "new-await",
    commitPrepared: async () => assert.fail("new operation adopted the old preparation") }), /original reconciliation/u);
  assert.deepEqual(await readFile(journalFile), journalBytes);
  assert.deepEqual(await readFile(checkpointFile), oldCheckpoint);
  assert.equal(await git(releaseRoot, "rev-parse", "refs/heads/PreRelease"), oldHead);
  const foreign = path.join(releaseRoot, "foreign.txt");
  await writeFile(foreign, "untouched");
  await assert.rejects(inspect(original), /index or worktree/u);
  assert.equal(await readFile(foreign, "utf8"), "untouched");
  await rm(foreign);
  assert.equal(await git(releaseRoot, "rev-parse", "HEAD"), target);
  const originalFetch = await readFile(path.join(releaseRoot, ".git/FETCH_HEAD"));
  const lease = { async assertOwned() {} };
  let guarded = false;
  const taskGit = {
    withTaskLock: (_id, fn) => fn(lease),
    withTaskRecoveryLock: (_id, fn) => fn(lease),
    withTaskRepositoryRecoveryLock: (_id, _root, _lease, fn) => fn(lease),
    prepareOwned: async () => assert.fail("claim replay"),
    snapshotAndMergeOwned: async () => assert.fail("Test replay"),
    cleanupOwned: async () => assert.fail("cleanup"),
    cleanupPreview: async () => ({}),
    assertNoProcessTreeGuardOwned: async () => { if (guarded) throw new Error("real guard remains"); },
    assertExplicitUpstreamAdoption: async () => assert.fail("unrequested adoption"),
    releaseBaseEvidence: async () => ({ baseCommit: f.base, publishedBaseCommit: f.base }),
    releaseIntegrationEvidence: async ({ tasks }) => ({
      tasks: tasks.map(({ taskId }) => selection.find(value => value.taskId === taskId)),
    }),
  };
  const releasePreflight = new TaskIntegrationService({
    releasePlanner: {
      async planAcceptance(workspaceId, { acceptingTask, ...options }) {
        return { baseline: await this.plan(workspaceId, options),
          prospective: await this.plan(workspaceId, { ...options, acceptingTask }) };
      },
      plan: (_workspaceId, { acceptingTask } = {}) => ({
        revision: acceptingTask ? request.planRevision : "current",
        ready: (acceptingTask ? selection : [f.oldTask]).map(value => ({ ...value, projectRoot: f.primary })),
        blocked: [], conflicts: [],
      }),
    },
    taskGitWorkspaces: taskGit, releaseGitWorkspaces: f.service,
    readPublicationState: () => ({ repositories: [{ root: f.primary, revision: f.base }] }),
  });
  const lifecycle = new TaskLifecycleService({ taskBoard: board, workspaceCatalog: catalog,
    taskGitWorkspaces: taskGit, releasePreflight });
  const reconciliation = new TaskOperationReconciliationService({
    workspaceCatalog: catalog, taskBoard: board, taskLifecycle: lifecycle,
  });
  const recover = () => reconciliation.reconcileUnknownWorkflow({
    workspaceId: workspace.id, taskId: task.id, operationRequestId: operationId,
    projectRoot: f.primary, expectedTaskRevision: task.revision, expectedWorkflowStatus: "testing",
  });
  if (cancellation) {
    const requestCancel = () => catalog.runMutation(() => catalog.requestTaskOperationInterruption(operationId, {
      taskId: task.id, targetWorkspaceId: workspace.id, expectedArgumentsHash: argumentsHash,
      expectedTaskRevision: task.revision, actor: { workspaceId: workspace.id, streamId: stream.id, releaseManager: true },
      arguments: args, cohort: null, cancellationRequestId: "fixture-cancel", requestedAtMs: Date.now(),
    }));
    const admit = board.admitInterruptedAwaitPromotion.bind(board);
    board.admitInterruptedAwaitPromotion = async input => {
      if (cancellation === "before") await requestCancel();
      const permit = await admit(input);
      if (cancellation === "after") await requestCancel();
      return permit;
    };
    const result = await recover();
    assert.equal(result.outcome, "unknown", JSON.stringify(result));
    assert.match(result.error, /Original Await receipt or cancellation changed/u);
    assert.equal(catalog.mcpOperation(operationId).taskExecution.cancellation.phase, "requested");
    assert.equal(board.task(task.id).revision, task.revision);
    assert.equal(board.task(task.id).workflowStatus, "testing");
    const actualRef = await git(releaseRoot, "rev-parse", "refs/heads/PreRelease");
    if (cancellation === "before") {
      assert.equal(actualRef, oldHead);
      assert.deepEqual(await readFile(checkpointFile), oldCheckpoint);
      assert.deepEqual(await readFile(journalFile), journalBytes);
      assert.equal(board.lifecycleTransition(operationId).evidence?.awaitPromotion, undefined);
    } else {
      assert.equal(actualRef, target);
      assert.equal(JSON.parse(await readFile(checkpointFile)).preReleaseHead, target);
      const pending = JSON.parse(await readFile(journalFile));
      assert.equal(pending.phase, "prepared");
      assert.equal(pending.requestId, operationId);
      assert.deepEqual(board.lifecycleTransition(operationId).evidence.awaitPromotion, {
        manifestHash: journal.manifestHash, head: target, tree: journal.targetTree,
      });
      assert.equal(catalog.mcpOperation(operationId).receiptState, "unknown");
    }
    return;
  }
  guarded = true;
  await assert.rejects(recover(), /real guard/u);
  guarded = false;
  const commit = board.commitWorkflowTransition.bind(board);
  board.commitWorkflowTransition = async () => {
    throw Object.assign(new Error("controlled lost Task CAS"), { code: "AWAIT_ACCEPTANCE_UNKNOWN" });
  };
  const lost = await recover();
  assert.equal(lost.outcome, "unknown", JSON.stringify(lost));
  assert.match(lost.error, /controlled lost Task CAS/u);
  assert.equal(catalog.mcpOperation(operationId).receiptState, "unknown");
  assert.equal(board.task(task.id).revision, task.revision);
  assert.equal(await git(releaseRoot, "rev-parse", "refs/heads/PreRelease"), target);
  const promotedCheckpoint = await readFile(checkpointFile);
  assert.equal(JSON.parse(promotedCheckpoint).preReleaseHead, target);
  const promotedRefs = await git(releaseRoot, "for-each-ref");
  const promotedHeadLog = await readFile(path.join(releaseRoot, ".git/logs/HEAD"));
  const beforeJournalCompletion = await readFile(journalFile);
  board.commitWorkflowTransition = commit;
  const settleOriginal = catalog.completeUnknownMcpOperation.bind(catalog);
  catalog.completeUnknownMcpOperation = async () => {
    // Simulate a crash after the Task commit but before the journal and
    // outer receipt finished. Recreate that exact disk state.
    await writeFile(journalFile, beforeJournalCompletion);
    throw new Error("controlled lost outer receipt");
  };
  await assert.rejects(recover(), /controlled lost outer receipt/u);
  catalog.completeUnknownMcpOperation = settleOriginal;
  assert.equal(board.task(task.id).workflowStatus, "awaiting_implementation");
  assert.equal(catalog.mcpOperation(operationId).receiptState, "unknown");
  assert.equal(JSON.parse(await readFile(journalFile)).phase, "prepared");
  const settled = await recover();
  assert.equal(settled.outcome, "succeeded", JSON.stringify(settled));
  assert.equal(board.task(task.id).workflowStatus, "awaiting_implementation");
  assert.equal(board.task(task.id).revision, task.revision + 1);
  assert.equal(catalog.mcpOperation(operationId).receiptState, "succeeded");
  assert.equal(settled.reconciliation.originalPreparationError, failure.message);
  assert.equal(board.lifecycleOutcome(operationId).result.evidence.nativeAwaitRecovery.interruptedError, failure.message);
  assert.equal((await recover()).outcome, "succeeded");
  assert.equal(board.task(task.id).revision, task.revision + 1);
  assert.equal(await git(releaseRoot, "rev-parse", "HEAD^{tree}"), journal.targetTree);
  assert.equal(await git(releaseRoot, "for-each-ref"), promotedRefs);
  assert.deepEqual(await readFile(checkpointFile), promotedCheckpoint);
  assert.deepEqual(await readFile(path.join(releaseRoot, ".git/logs/HEAD")), promotedHeadLog);
  assert.equal(await git(releaseRoot, "rev-parse", "refs/heads/PreRelease"), target);
  assert.equal(await git(releaseRoot, "symbolic-ref", "HEAD"), "refs/heads/PreRelease");
  assert.deepEqual(await readFile(path.join(releaseRoot, ".git/FETCH_HEAD")), originalFetch);
  const done = JSON.parse(await readFile(journalFile));
  assert.equal(done.phase, "completed");
  assert.equal(done.requestId, original.operationId);
  assert.deepEqual(done.before, journal.before);
}
