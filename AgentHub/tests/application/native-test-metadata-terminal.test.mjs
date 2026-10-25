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
import { TaskGitWorkspaceService } from "../../src/infrastructure/filesystem/task-git-workspace.mjs";
import { TaskLifecycleService } from "../../src/application/task-lifecycle-service.mjs";
import { TaskOperationReconciliationService } from "../../src/application/task-operation-reconciliation-service.mjs";

const exec = promisify(execFile);
const git = async (cwd, ...args) => String((await exec("git", args, { cwd, windowsHide: true })).stdout).trim();
test("original native Test metadata recovery is terminal-only, fenced and idempotent", { timeout: 180_000 }, async (t) => {
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
