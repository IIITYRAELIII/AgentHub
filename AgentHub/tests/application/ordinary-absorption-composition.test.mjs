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
import { createPersistenceMutationCapabilities } from "../../src/composition/persistence-mutation-composition.mjs";
import { mcpArgumentsHash } from "../../src/domain/mcp-arguments-hash.mjs";
import { readCandidatePublicationReleasePlan } from "../../src/composition/publication-release-plan-composition.mjs";

const exec = promisify(execFile);
const git = async (cwd, ...args) => String((await exec("git", args, { cwd, windowsHide: true })).stdout).trim();
async function commit(root, name, body = name) {
  await writeFile(path.join(root, name), `${body}\n`);
  await git(root, "add", ".");
  await git(root, "-c", "user.name=Fixture", "-c", "user.email=fixture@local.invalid", "commit", "-m", name);
  return git(root, "rev-parse", "HEAD");
}

// The composition ports here are the real owners, including native history,
// immutable object materialization, isolated candidate verification and readback.
async function fixture(t, { omit = null, foreignSide = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ah-ordinary-absorption-"));
  const primary = path.join(root, "primary"), origin = path.join(root, "origin.git"), dataDir = path.join(root, "data");
  await mkdir(primary);
  await git(primary, "init", "--initial-branch=main");
  const base = await commit(primary, "base.txt");
  await git(root, "init", "--bare", "--initial-branch=main", origin);
  await git(primary, "remote", "add", "origin", origin);
  await git(primary, "push", "origin", "main");
  await mkdir(dataDir);
  const databaseFile = path.join(dataDir, "journal.sqlite");
  const rawCatalog = new WorkspaceCatalogStore({ databaseFile });
  await rawCatalog.load();
  const rawStore = new TaskBoardStore({ databaseFile });
  t.after(async () => { rawStore.close(); rawCatalog.close(); await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); });
  const caps = createPersistenceMutationCapabilities({ rawWorkspaceCatalogStore: rawCatalog, rawTaskBoardStore: rawStore });
  const catalog = caps.workspaceCatalogStore;
  const workspace = await catalog.createWorkspace({ name: "Ordinary transfer", settings: {
    workingDirectory: primary, releaseWorkflowEnabled: true, taskPrefix: "ORD" } });
  const stream = await catalog.createStream({ workspaceId: workspace.id, name: "Original executor", settings: {
    workingDirectory: primary, releaseManager: true } });
  await catalog.bindThread({ provider: "codex", threadId: "ordinary-actor", streamId: stream.id });
  const board = new TaskBoardService({ store: caps.taskBoardStore, workspaceCatalog: catalog });
  const publication = { generation: "fixture", repositories: [{ root: primary, revision: base }] };
  const taskGit = new TaskGitWorkspaceService({ dataDir, readPublication: async () => publication, recordTiming: () => {} });
  const releaseGit = new ReleaseGitWorkspaceService({ dataDir });
  const planner = new TaskReleasePlanService({ taskBoard: board, taskGitWorkspaces: taskGit });
  const preflight = new WorkspaceReleasePreflightService({ releasePlanner: planner, taskGitWorkspaces: taskGit,
    releaseGitWorkspaces: releaseGit, readPublicationState: async () => publication,
    resolveReleaseValidationSource: () => assert.fail("Closure/Await does not run release validation"),
    validateProductionCandidate: () => assert.fail("No publication") });
  const lifecycle = new TaskLifecycleService({ taskBoard: board, workspaceCatalog: catalog,
    taskGitWorkspaces: taskGit, releasePreflight: preflight });
  const hub = new HubMcpService({ workspaceCatalog: catalog, taskBoard: board, taskGitWorkspaces: taskGit,
    taskLifecycle: lifecycle, releasePreflight: preflight, releasePlanner: planner,
    releaseCompleter: { completeRelease: () => assert.fail("No publication") },
    workLog: { threadTurns: () => [] }, attachmentDirectory: path.join(root, "attachments"),
    secret: "synthetic-ordinary-transfer", reconcilePendingOnStartup: false });
  const token = hub.contextToken({ provider: "codex", threadId: "ordinary-actor" });
  const call = (name, args) => hub.call(name, { context_token: token, ...args });
  const status = (task, state, request_id) => call("hub_task_status_update", { request_id, task_id: task.id, status: state,
    expected_task_revision: board.task(task.id).revision, expected_workflow_status: board.task(task.id).workflowStatus });
  const create = async title => {
    const task = await call("hub_task_create", { request_id: `create-${title}`, workspace_id: workspace.id, title, description: `${title} requirements` });
    hub.setActiveRuns(() => [{ id: `run-${title}`, provider: "codex", threadId: "ordinary-actor", streamId: stream.id,
      workspaceId: workspace.id, turnId: `turn-${title}`, status: "running" }]);
    const claimed = await call("hub_task_claim", { request_id: `claim-${title}`, task_id: task.id });
    hub.setActiveRuns(() => []);
    return { ...task, root: claimed.gitWorkspace.projectRoot };
  };
  const source = await create("Source"), target = await create("Survivor");
  await board.updateChecklist({ id: target.id, operation: "add", text: "Finish source transfer", expectedRevision: board.task(target.id).revision, requestId: "transfer-add" });
  const item = board.task(target.id).checklist[0];
  await board.updateChecklist({ id: target.id, operation: "link", itemId: item.id, linkedTaskId: source.id,
    expectedRevision: board.task(target.id).revision, requestId: "transfer-link" });
  await commit(source.root, "early.txt", "earlier source work");
  const sourceCommit = await commit(source.root, "new.txt", "new source work");
  await status(source, "testing", "source-test");
  const returnResult = await status(source, "in_progress", "source-return");
  assert.equal(returnResult.acceptedResultPreserved, true);
  await commit(target.root, "survivor.txt");
  await git(target.root, "-c", "user.name=Fixture", "-c", "user.email=fixture@local.invalid", "merge", "--no-ff", "--no-edit", sourceCommit);
  if (omit) { await git(target.root, "rm", omit); await git(target.root, "-c", "user.name=Fixture", "-c", "user.email=fixture@local.invalid", "commit", "-m", "lost source content"); }
  if (foreignSide) {
    const foreign = await create("Foreign");
    const foreignCommit = await commit(foreign.root, "foreign.txt");
    await status(foreign, "testing", "foreign-test");
    await status(foreign, "in_progress", "foreign-return");
    await git(target.root, "-c", "user.name=Fixture", "-c", "user.email=fixture@local.invalid", "merge", "--no-ff", "--no-edit", foreignCommit);
  }
  await status(target, "testing", "survivor-test");
  const args = { request_id: "retained-ordinary-preview", task_id: source.id, absorbed_into_task_id: target.id };
  await catalog.beginMcpOperation({ requestId: args.request_id, toolName: "hub_task_complete", workspaceId: workspace.id,
    streamId: stream.id, provider: "codex", threadId: "ordinary-actor", argumentsHash: mcpArgumentsHash(args),
    taskExecution: hub.taskOperationInterruption.binding(args) });
  await catalog.markMcpOperationUnknown(args.request_id, new Error("Historical retained preview refusal"));
  const old = catalog.mcpOperation(args.request_id);
  const preview = async () => {
    const input = { ...args, context_token: token };
    try { await hub.submitTaskOperation("hub_task_complete", input); }
    finally { await hub.joinSubmittedTaskOperation(input); }
    return (await call("hub_task_operation_get", { operation_request_id: args.request_id,
      task_id: source.id, expected_arguments_hash: mcpArgumentsHash(args) })).result;
  };
  return { root, primary, base, source, target, workspace, board, catalog, rawCatalog, rawStore,
    planner, preflight, releaseGit, taskGit, call, status, preview, old, args };
}

test("PUBLIC SAME UNKNOWN ordinary return/merge/Test uses real composer, then confirm and later Await readback", async t => {
  const f = await fixture(t);
  const before = f.board.task(f.source.id), target = f.board.task(f.target.id);
  const dev = await git(f.primary, "rev-parse", "dev");
  const preview = await f.preview();
  assert.deepEqual(preview.previewRecovery.previousReceipt, f.old);
  assert.deepEqual(preview.preview.deleting, []);
  assert.match(preview.cleanupToken, /^[a-f0-9]{64}$/u);
  assert.deepEqual(f.board.task(f.source.id), before);
  assert.deepEqual(f.board.task(f.target.id), target);
  const closed = await f.call("hub_task_complete", { ...f.args, request_id: "separate-confirm",
    confirm_cleanup: true, expected_cleanup_token: preview.cleanupToken });
  assert.equal(closed.status, "done");
  assert.equal(closed.revision, before.revision + 1);
  assert.equal(closed.workflowStatus, before.workflowStatus, "archive is not publication");
  assert.equal(f.board.task(f.target.id).workflowStatus, "testing");
  await f.status(f.target, "awaiting_implementation", "survivor-await-after-close");
  const plan = await f.planner.plan(f.workspace.id);
  assert.deepEqual(plan.ready.map(task => task.taskId), [f.target.id]);
  assert.equal(plan.blocked.length, 0);
  const prepared = await f.preflight.prepareAwaitSet({ workspaceId: f.workspace.id });
  assert.deepEqual(prepared.taskIds, [f.target.id]);
  const frozen = await f.releaseGit.frozenCandidate(f.primary);
  const manifest = JSON.parse(await readFile(frozen.manifestFile, "utf8"));
  assert.equal(manifest.tasks.length, 1);
  assert.equal(manifest.tasks[0].taskId, f.target.id);
  const history = manifest.tasks[0].ordinaryAbsorptions;
  assert.equal(history.length, 1);
  assert.equal(history[0].sourceTaskId, f.source.id);
  assert.equal(history[0].testedCommit, target.gitReferences[0].resultCommit);
  assert.equal(manifest.tasks[0].selectedComposition, undefined, "an old Test is not retrofitted with a native descriptor");
  const publicationPlan = await readCandidatePublicationReleasePlan(f.workspace.id, {
    load: async () => ({ dataDir: path.join(f.root, "data") }),
  });
  assert.deepEqual(publicationPlan.ready.map(task => task.taskId), [f.target.id]);
  assert.deepEqual(publicationPlan.ready[0].ordinaryAbsorptions, history);
  assert.equal(await git(f.primary, "rev-parse", "dev"), dev);
  assert.equal(await git(f.primary, "rev-parse", "main"), f.base);
  for (const [name, body] of [["early.txt", "earlier source work\n"], ["new.txt", "new source work\n"]]) {
    assert.equal(await readFile(path.join(f.source.root, name), "utf8"), body);
    assert.equal(await git(prepared.releaseCandidates[0].releaseRoot, "show", `HEAD:${name}`), body.trimEnd());
  }
});

for (const omit of ["early.txt", "new.txt"]) test(`ordinary composition refuses lost ${omit} and preserves old UNKNOWN`, async t => {
  const f = await fixture(t, { omit });
  const before = f.board.task(f.source.id);
  await assert.rejects(f.preview(), /missing|preserv|source work|source contribution/iu);
  assert.deepEqual(f.catalog.mcpOperation(f.args.request_id), f.old);
  assert.deepEqual(f.board.task(f.source.id), before);
});

test("ordinary composition refuses a foreign unselected merge side", async t => {
  const f = await fixture(t, { foreignSide: true });
  const before = f.board.task(f.source.id);
  await assert.rejects(f.preview(), /unselected merge side/u);
  assert.deepEqual(f.catalog.mcpOperation(f.args.request_id), f.old);
  assert.deepEqual(f.board.task(f.source.id), before);
});

test("ordinary composition refuses newer source work absent from tested survivor", async t => {
  const f = await fixture(t);
  await commit(f.source.root, "late.txt", "late untransferred work");
  const before = f.board.task(f.source.id);
  await assert.rejects(f.preview());
  assert.deepEqual(f.catalog.mcpOperation(f.args.request_id), f.old);
  assert.deepEqual(f.board.task(f.source.id), before);
  assert.equal(await readFile(path.join(f.source.root, "late.txt"), "utf8"), "late untransferred work\n");
});

test("real ordinary composer rechecks late canonical return authority at SAME receipt CAS", async t => {
  const f = await fixture(t);
  const before = f.board.task(f.source.id);
  const read = f.rawStore.returnedNativeTestPriorResult.bind(f.rawStore);
  const recover = f.rawCatalog.recoverCompactedCleanupPreview.bind(f.rawCatalog);
  let atCas = false;
  f.rawStore.returnedNativeTestPriorResult = (...args) => {
    const proof = read(...args);
    return atCas ? { ...proof, returnOutcomeHash: proof.returnOutcomeHash.replace(/^./u, c => c === "0" ? "1" : "0") } : proof;
  };
  f.rawCatalog.recoverCompactedCleanupPreview = (...args) => { atCas = true; return recover(...args); };
  await assert.rejects(f.preview(), /authority changed|returned source changed|Task drift/u);
  assert.equal(atCas, true, "the real prospective composer finished before this controlled CAS mutation");
  assert.deepEqual(f.catalog.mcpOperation(f.args.request_id), f.old);
  assert.deepEqual(f.board.task(f.source.id), before);
});
