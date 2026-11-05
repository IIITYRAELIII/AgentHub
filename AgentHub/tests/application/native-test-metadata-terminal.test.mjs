import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, rm, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WorkspaceCatalogStore } from "../../src/infrastructure/persistence/workspace-catalog-store.mjs";
import { TaskBoardStore } from "../../src/infrastructure/persistence/task-board-store.mjs";
import { TaskBoardService } from "../../src/application/task-board-service.mjs";
import { TaskGitWorkspaceService, runTaskGitCommand } from "../../src/infrastructure/filesystem/task-git-workspace.mjs";
import { TaskLifecycleService } from "../../src/application/task-lifecycle-service.mjs";
import { TaskOperationReconciliationService } from "../../src/application/task-operation-reconciliation-service.mjs";
import { mcpArgumentsHash } from "../../src/domain/mcp-arguments-hash.mjs";

const exec = promisify(execFile);
const git = async (cwd, ...args) => String((await exec("git", args, { cwd, windowsHide: true })).stdout).trim();
test("original native Test metadata recovery is terminal-only, fenced and idempotent", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hub-native-metadata-"));
  const primary = path.join(root, "primary"), dataDir = path.join(root, "data");
  await mkdir(primary); await git(primary, "init", "--initial-branch=main");
  await writeFile(path.join(primary, "main.txt"), "main\n"); await git(primary, "add", ".");
  await git(primary, "-c", "user.name=Fixture", "-c", "user.email=fixture@local.invalid", "commit", "-m", "main");
  const databaseFile = path.join(root, "tasks.sqlite");
  const catalog = new WorkspaceCatalogStore({ databaseFile }); await catalog.load();
  const store = new TaskBoardStore({ databaseFile });
  t.after(async () => { store.close(); catalog.close();
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
  const workspace = await catalog.runMutation(() => catalog.createWorkspace({ name: "Fixture",
    settings: { workingDirectory: primary, releaseWorkflowEnabled: true } }));
  const stream = await catalog.runMutation(() => catalog.createStream({ workspaceId: workspace.id, name: "RM" }));
  const board = new TaskBoardService({ store, workspaceCatalog: catalog });
  const taskGit = new TaskGitWorkspaceService({ dataDir, readPublication: async () => null, recordTiming: () => {} });
  const lifecycle = new TaskLifecycleService({ taskBoard: board, workspaceCatalog: catalog, taskGitWorkspaces: taskGit,
    releasePreflight: { withAwaitTransition: (_id, op) => op() } });
  const task = store.create({ text: "Fix", bucket: "workspace", workspaceId: workspace.id });
  await board.claim({ id: task.id, workspaceId: workspace.id, streamId: stream.id,
    provider: "codex", threadId: "fixture", turnId: "turn", operationId: "claim" });
  const source = await taskGit.prepare({ taskId: task.id, projectRoot: primary });
  await writeFile(path.join(source.projectRoot, "fix.txt"), "fixed\n"); await git(source.projectRoot, "add", ".");
  await git(source.projectRoot, "-c", "user.name=Fixture", "-c", "user.email=fixture@local.invalid", "commit", "-m", "fix");
  const operationId = "original-native-test";
  const args = { request_id: operationId, status: "testing", task_id: task.id };
  await catalog.runMutation(() => catalog.beginMcpOperation({ requestId: operationId, workspaceId: workspace.id,
    streamId: stream.id, provider: "codex", threadId: "fixture", toolName: "hub_task_status_update",
    argumentsHash: createHash("sha256").update(JSON.stringify(args)).digest("hex") }));
  const commit = board.commitWorkflowTransition.bind(board);
  let inject = true;
  board.commitWorkflowTransition = (payload) => {
    if (inject) { inject = false; store.updatePresentation(task.id, { title: "Fix", description: "keep newest description" }); }
    return commit(payload);
  };
  await assert.rejects(lifecycle.updateWorkflowStatus({ taskId: task.id, status: "testing", operationId }), /original readback/u);
  board.commitWorkflowTransition = commit;
  await catalog.runMutation(() => catalog.markMcpOperationUnknown(operationId, new Error("lost terminal")));
  const before = await git(primary, "rev-parse", "dev");
  const sourceHead = await git(source.projectRoot, "rev-parse", "HEAD");
  assert.equal(board.lifecycleTransition(operationId).phase, "pending_git");
  assert.equal(board.task(task.id).workflowStatus, "in_progress");
  // A recovery must never enter any preparation, snapshot or merge path.
  for (const method of ["prepareOwned", "snapshotAndMergeOwned"]) taskGit[method] = () => assert.fail(method + " replayed");
  const reconciliation = new TaskOperationReconciliationService({ workspaceCatalog: catalog, taskBoard: board, taskLifecycle: lifecycle });
  const recover = () => reconciliation.reconcileUnknownWorkflow({ workspaceId: workspace.id,
    taskId: task.id, operationRequestId: operationId, projectRoot: primary });
  const observe = board.task.bind(board);
  for (const [name, delta] of [["workflow", { workflowStatus: "blocked" }], ["executor", { streamId: "foreign" }],
    ["references", { gitReferences: [{ projectRoot: primary, branch: "foreign", resultCommit: "a".repeat(40) }] }]]) {
    await t.test("reject changed " + name, async () => {
      board.task = (id) => id === task.id ? { ...observe(id), ...delta } : observe(id);
      await assert.rejects(recover()); board.task = observe;
      assert.equal(await git(primary, "rev-parse", "dev"), before);
    });
  }
  // Use the original journal's exact dev path rather than guessing its key.
  const { readdir } = await import("node:fs/promises");
  const key = (await readdir(path.join(dataDir, "task-native-integrations", task.id)))[0];
  const nativeFile = path.join(dataDir, "task-native-integrations", task.id, key,
    createHash("sha256").update(operationId).digest("hex") + ".json");
  const nativeBytes = await readFile(nativeFile);
  const native = JSON.parse(nativeBytes);
  for (const [name, dir] of [["source", source.projectRoot], ["dev", native.devRoot]]) {
    await t.test("reject changed " + name, async () => {
      const file = path.join(dir, "unexpected.txt"); await writeFile(file, "drift");
      const result = await recover(); assert.equal(result.resolved, false);
      await unlink(file); assert.equal(await git(primary, "rev-parse", "dev"), before);
    });
  }
  await t.test("reject a real retained process guard without inventing recovery proof", async () => {
    const dir = path.join(dataDir, "task-process-tree-guards", task.id); await mkdir(dir, { recursive: true });
    const file = path.join(dir, "synthetic-test-guard.json"); await writeFile(file, JSON.stringify({ guardId: "fixture", processId: process.pid }));
    try { const result = await recover(); assert.equal(result.resolved, false); assert.match(result.error, /guard/u); }
    finally { await unlink(file); }
  });
  await t.test("CAS race preserves later metadata and the original pending outcome", async () => {
    board.commitWorkflowTransition = (payload) => {
      store.updatePresentation(task.id, { title: "Fix", description: "race description retained" });
      return commit(payload);
    };
    const result = await recover(); assert.equal(result.resolved, false);
    board.commitWorkflowTransition = commit;
    assert.equal(board.lifecycleOutcome(operationId), null);
    assert.equal(board.task(task.id).description, "race description retained");
  });
  const result = await recover(); assert.equal(result.resolved, true); assert.equal(result.outcome, "succeeded");
  assert.equal(board.task(task.id).description, "race description retained");
  assert.equal(board.task(task.id).workflowStatus, "testing");
  assert.equal(board.task(task.id).gitReferences[0].resultCommit, sourceHead);
  const outcome = JSON.stringify(board.lifecycleOutcome(operationId));
  store.updatePresentation(task.id, { title: "Fix", description: "later metadata stays current" });
  const revision = board.task(task.id).revision;
  const repeated = await recover(); assert.equal(repeated.resolved, true);
  assert.equal(board.task(task.id).description, "later metadata stays current");
  assert.equal(board.task(task.id).revision, revision);
  assert.equal(JSON.stringify(board.lifecycleOutcome(operationId)), outcome);
  assert.equal(await git(primary, "rev-parse", "dev"), before);
  assert.deepEqual(await readFile(nativeFile), nativeBytes);
});

test("CAS-bound ordinary native Test recovers its original terminal without review after presentation edits", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hub-reviewed-terminal-"));
  const primary = path.join(root, "primary"), dataDir = path.join(root, "data");
  await mkdir(primary); await git(primary, "init", "--initial-branch=main");
  await writeFile(path.join(primary, "CHANGELOG.md"), "older published notes\n");
  await writeFile(path.join(primary, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0" }) + "\n");
  await writeFile(path.join(primary, "main.txt"), "main\n"); await git(primary, "add", ".");
  await git(primary, "-c", "user.name=Fixture", "-c", "user.email=fixture@local.invalid", "commit", "-m", "main");
  const agreedMain = await git(primary, "rev-parse", "HEAD");
  // Release metadata is genuine committed publication history, ahead of the
  // agreed main. The remote identity/read port is controlled and never online.
  await git(primary, "checkout", "-b", "fixture-publication");
  await writeFile(path.join(primary, "CHANGELOG.md"), "already published notes\n");
  await writeFile(path.join(primary, "package.json"), JSON.stringify({ name: "fixture", version: "2.0.0" }) + "\n");
  await git(primary, "add", ".");
  await git(primary, "-c", "user.name=Fixture", "-c", "user.email=fixture@local.invalid", "commit", "-m", "published metadata");
  const published = await git(primary, "rev-parse", "HEAD");
  await git(primary, "checkout", "main");
  await git(primary, "remote", "add", "origin", "https://github.com/IIITYRAELIII/AgentHub.git");
  await git(primary, "update-ref", "refs/remotes/origin/main", published);
  let publication = { generation: "fixture-published-generation", repositories: [{ root: primary,
    revision: published, deploymentProfile: "github-release", planRevision: "fixture-published-plan",
    manifestHash: "a".repeat(64), preReleaseHead: published, baseCommit: agreedMain }] };
  const databaseFile = path.join(root, "tasks.sqlite");
  let catalog, store, board, taskGit, lifecycle;
  const open = async () => {
    catalog = new WorkspaceCatalogStore({ databaseFile }); await catalog.load();
    store = new TaskBoardStore({ databaseFile });
    board = new TaskBoardService({ store, workspaceCatalog: catalog });
    taskGit = new TaskGitWorkspaceService({ dataDir, readPublication: async () => publication, recordTiming: () => {},
      runCommand: (args, options) => args[0] === "ls-remote"
        ? Promise.resolve(`${published}\trefs/heads/main`) : runTaskGitCommand(args, options),
    });
    lifecycle = new TaskLifecycleService({ taskBoard: board, workspaceCatalog: catalog, taskGitWorkspaces: taskGit,
      releasePreflight: { withAwaitTransition: (_id, op) => op() } });
  };
  await open();
  t.after(async () => { store.close(); catalog.close();
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
  const workspace = await catalog.runMutation(() => catalog.createWorkspace({ name: "Fixture",
    settings: { workingDirectory: primary, releaseWorkflowEnabled: true } }));
  const rmStream = await catalog.runMutation(() => catalog.createStream({ workspaceId: workspace.id, name: "RM",
    settings: { releaseManager: true } }));
  const reviewer = await catalog.runMutation(() => catalog.createStream({ workspaceId: workspace.id, name: "Reviewer",
    settings: { model: "gpt-6.1-sol" } }));
  await catalog.runMutation(() => catalog.bindThread({ provider: "codex", threadId: "rm-fixture", streamId: rmStream.id }));
  await catalog.runMutation(() => catalog.bindThread({ provider: "codex", threadId: "review-fixture", streamId: reviewer.id }));
  assert.equal((await taskGit.synchronizeMainIntoDev({ projectRoot: primary, publishedRevision: published })).integrated, true);
  const create = async (text, content, filename = "main.txt") => {
    const task = store.create({ text, bucket: "workspace", workspaceId: workspace.id });
    await board.claim({ id: task.id, workspaceId: workspace.id, streamId: rmStream.id,
      provider: "codex", threadId: "rm-fixture", turnId: text, operationId: "claim-" + text });
    const source = await taskGit.prepare({ taskId: task.id, projectRoot: primary });
    await writeFile(path.join(source.projectRoot, filename), content);
    await git(source.projectRoot, "add", ".");
    await git(source.projectRoot, "-c", "user.name=Fixture", "-c", "user.email=fixture@local.invalid", "commit", "-m", text);
    return { task, source };
  };
  const left = await create("Left", "left\n"), right = await create("Right", "right\n");
  await lifecycle.updateWorkflowStatus({ taskId: left.task.id, status: "testing", operationId: "test-left" });
  const task = right.task, source = right.source;
  let stage;
  await assert.rejects(lifecycle.updateWorkflowStatus({ taskId: task.id, status: "testing", operationId: "capture-conflict" }), error => {
    assert.equal(error.code, "TASK_INTEGRATION_CONFLICT"); stage = error.details.nativeConflictRoot; return true;
  });
  await writeFile(path.join(stage, "main.txt"), "left+right\n");
  await writeFile(path.join(stage, "compatibility.txt"), "independently reviewed correction\n");
  await git(stage, "add", ".");
  await git(stage, "-c", "user.name=Fixture", "-c", "user.email=fixture@local.invalid", "commit", "-m", "resolve with compatibility correction");
  const resolutionHead = await git(stage, "rev-parse", "HEAD");
  const resultCommit = await git(source.projectRoot, "rev-parse", "HEAD");
  const operationId = "original-cas-owned-test", originalRevision = board.task(task.id).revision;
  const args = { request_id: operationId, status: "testing", task_id: task.id,
    expected_task_revision: originalRevision, expected_workflow_status: "in_progress" };
  await catalog.runMutation(() => catalog.beginMcpOperation({ requestId: operationId, workspaceId: workspace.id, streamId: rmStream.id,
    provider: "codex", threadId: "rm-fixture", toolName: "hub_task_status_update", argumentsHash: mcpArgumentsHash(args) }));
  const commit = board.commitWorkflowTransition.bind(board);
  board.commitWorkflowTransition = payload => {
    store.updatePresentation(task.id, { title: "Newest title", description: "keep newest description" });
    return commit(payload);
  };
  await assert.rejects(lifecycle.updateWorkflowStatus({ taskId: task.id, status: "testing", operationId,
    expectedRevision: originalRevision, expectedWorkflowStatus: "in_progress" }), /original readback/u);
  board.commitWorkflowTransition = commit;
  await catalog.runMutation(() => catalog.markMcpOperationUnknown(operationId, new Error("lost terminal after metadata CAS")));
  const devHead = await git(primary, "rev-parse", "dev");
  assert.equal(devHead, resolutionHead);
  const { readdir } = await import("node:fs/promises");
  const key = (await readdir(path.join(dataDir, "task-native-integrations", task.id)))[0];
  const nativeFile = path.join(dataDir, "task-native-integrations", task.id, key, createHash("sha256").update(operationId).digest("hex") + ".json");
  const nativeBytes = await readFile(nativeFile), captureBytes = await readFile(path.join(path.dirname(stage), "merge.json"));
  // A later, independently admitted ordinary Test can advance dev while this
  // original awaits terminal persistence. Its canonical outcome and native
  // intent, not ancestry alone, must justify preserving that descendant.
  const later = await create("Later", "later accepted Test\n", "later.txt");
  await git(later.source.projectRoot, "-c", "user.name=Fixture", "-c", "user.email=fixture@local.invalid", "merge", "--no-edit", published);
  const laterId = "test-later", laterArgs = { request_id: laterId, status: "testing", task_id: later.task.id };
  await catalog.runMutation(() => catalog.beginMcpOperation({ requestId: laterId, workspaceId: workspace.id, streamId: rmStream.id,
    provider: "codex", threadId: "rm-fixture", toolName: "hub_task_status_update", argumentsHash: mcpArgumentsHash(laterArgs) }));
  const laterResult = await lifecycle.updateWorkflowStatus({ taskId: later.task.id, status: "testing", operationId: laterId });
  await catalog.runMutation(() => catalog.completeMcpOperation(laterId, laterResult));
  const laterHead = await git(primary, "rev-parse", "dev");
  assert.notEqual(laterHead, devHead);
  assert.equal(await git(primary, "merge-base", "--is-ancestor", devHead, laterHead), "");
  assert.equal(await git(primary, "show", "dev:CHANGELOG.md"), "already published notes");
  // Inheriting publication is not permission for Task-authored notes/version.
  for (const [name, filename, content, message] of [
    ["UnpublishedNotes", "CHANGELOG.md", "unaccepted Task notes\n", /changes release-owned CHANGELOG/u],
    ["UnpublishedVersion", "package.json", '{"name":"fixture","version":"3.0.0"}\n', /changes release-owned package-version/u],
  ]) {
    const rejected = await create(name, "rejected metadata\n", `${name}.txt`);
    await git(rejected.source.projectRoot, "-c", "user.name=Fixture", "-c", "user.email=fixture@local.invalid", "merge", "--no-edit", published);
    await writeFile(path.join(rejected.source.projectRoot, filename), content);
    await git(rejected.source.projectRoot, "add", "--sparse", "--force", "--", filename);
    await git(rejected.source.projectRoot, "-c", "user.name=Fixture", "-c", "user.email=fixture@local.invalid", "commit", "-m", name);
    await assert.rejects(lifecycle.updateWorkflowStatus({ taskId: rejected.task.id, status: "testing", operationId: name }), message);
    assert.equal(await git(primary, "rev-parse", "dev"), laterHead);
  }
  // Reopen the durable stores before recovery; an in-memory success cannot
  // substitute for the original lifecycle/receipt and exact applied Git state.
  store.close(); catalog.close(); await open();
  for (const method of ["prepareOwned", "snapshotAndMergeOwned"]) taskGit[method] = () => assert.fail(method + " replayed");
  const reconciliation = new TaskOperationReconciliationService({ workspaceCatalog: catalog, taskBoard: board, taskLifecycle: lifecycle });
  const input = { workspaceId: workspace.id, taskId: task.id, operationRequestId: operationId, projectRoot: primary,
    expectedTaskRevision: originalRevision, expectedWorkflowStatus: "in_progress" };
  const publishedContext = publication;
  publication = { ...publication, generation: "foreign-publication-generation" };
  assert.equal((await reconciliation.reconcileUnknownWorkflow(input)).resolved, false);
  publication = publishedContext;
  for (const delta of [{ expectedTaskRevision: originalRevision + 1 }, { expectedWorkflowStatus: "testing" },
    { nativeResolutionReview: { requestId: "not-original", text: "inert extra argument" } }]) {
    await assert.rejects(reconciliation.reconcileUnknownWorkflow({ ...input, ...delta }));
    assert.equal(board.lifecycleOutcome(operationId), null);
  }
  const observe = board.task.bind(board);
  for (const delta of [{ streamId: "foreign" }, { workflowStatus: "blocked" }, { checklist: [{ id: "new-selection" }] },
    { gitAdoptions: [{ sourceCommit: "a".repeat(40) }] }, { gitReferences: [{ projectRoot: primary, branch: "foreign", resultCommit: "a".repeat(40) }] }]) {
    board.task = id => id === task.id ? { ...observe(id), ...delta } : observe(id);
    await assert.rejects(reconciliation.reconcileUnknownWorkflow(input));
    board.task = observe;
    assert.equal(board.lifecycleOutcome(operationId), null);
  }
  const readOutcome = board.committedNativeTestForDev.bind(board);
  board.committedNativeTestForDev = () => { throw new Error("no canonical descendant"); };
  assert.equal((await reconciliation.reconcileUnknownWorkflow(input)).resolved, false);
  board.committedNativeTestForDev = readOutcome;
  const receiptRead = catalog.mcpOperation.bind(catalog);
  catalog.mcpOperation = id => id === laterId ? { ...receiptRead(id), receiptState: "unknown" } : receiptRead(id);
  assert.equal((await reconciliation.reconcileUnknownWorkflow(input)).resolved, false);
  catalog.mcpOperation = receiptRead;
  const savedCommit = board.commitWorkflowTransition.bind(board);
  board.commitWorkflowTransition = payload => {
    store.updatePresentation(task.id, { title: "Newest title", description: "racing description preserved" });
    return savedCommit(payload);
  };
  assert.equal((await reconciliation.reconcileUnknownWorkflow(input)).resolved, false);
  board.commitWorkflowTransition = savedCommit;
  assert.equal(board.lifecycleOutcome(operationId), null);
  const result = await reconciliation.reconcileUnknownWorkflow(input);
  assert.equal(result.resolved, true, result.error); assert.equal(result.outcome, "succeeded");
  assert.equal(board.task(task.id).title, "Newest title");
  assert.equal(board.task(task.id).description, "racing description preserved");
  assert.equal(board.task(task.id).workflowStatus, "testing");
  assert.equal(board.task(task.id).gitReferences[0].resultCommit, resultCommit);
  const outcome = JSON.stringify(board.lifecycleOutcome(operationId));
  const revision = board.task(task.id).revision;
  assert.equal((await reconciliation.reconcileUnknownWorkflow(input)).outcome, "succeeded");
  assert.equal(board.task(task.id).revision, revision);
  assert.equal(JSON.stringify(board.lifecycleOutcome(operationId)), outcome);
  assert.equal(catalog.mcpOperation(operationId).status, "succeeded");
  assert.equal(catalog.mcpOperation(operationId).argumentsHash, mcpArgumentsHash(args));
  assert.equal(await git(primary, "rev-parse", "dev"), laterHead);
  assert.equal(await git(primary, "show", "dev:later.txt"), "later accepted Test");
  assert.equal(board.lifecycleOutcome(operationId).result.evidence.nativeTerminalRecovery.preservedDevCommit, laterHead);
  assert.deepEqual(await readFile(nativeFile), nativeBytes);
  assert.deepEqual(await readFile(path.join(path.dirname(stage), "merge.json")), captureBytes);

});
