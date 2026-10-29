import assert from "node:assert/strict";
import test from "node:test";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { claimCustodyFixture } from "../fixtures/claim-custody-public-fixture.mjs";
import { TaskLifecycleService } from "../../src/application/task-lifecycle-service.mjs";
import { importCompositionWithPorts } from "../helpers/composition-ports.fixture.mjs";

function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
async function wiring(f, lifecycle) {
  const { createDesktopRunRouterWiring } = await importCompositionWithPorts(
    new URL("../../src/composition/desktop-run-router-wiring-composition.mjs", import.meta.url), {
      "./desktop-run-input-composition.mjs": { createDesktopRunInputComposition: () => ({ desktopMessageController: { sendMessage() {} } }) },
      "./desktop-router-composition.mjs": { createDesktopRouterComposition: options => ({ handlers: options.handlers }) },
      "../application/task-board-launch-service.mjs": { TaskBoardLaunchService: class {} },
    });
  return createDesktopRunRouterWiring({ config: { dataDir: f.root }, constants: {}, state: {},
    services: { hubMcpService: f.hub, workspaceCatalog: f.catalog, taskBoard: f.tasks, taskLifecycle: lifecycle, taskGitWorkspaces: f.workspaces },
    desktop: { snapshot: async () => ({ boardTasks: f.tasks.snapshot() }) } }).handlers;
}
async function terminal(f, id, hash) {
  for (;;) {
    const value = f.hub.readDesktopTaskOperation({}, id, hash);
    if (value.taskOperation.terminal || value.taskOperation.status === "unknown") return value;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
}

test("actual Desktop factory admits held Test/Await and returns canonical terminal Git/SQL through its read owner", { timeout: 30000 }, async t => {
  const f = await claimCustodyFixture(t), workspace = f.catalog.workspace(f.prior.workspaceId);
  await f.catalog.updateWorkspaceSettings(workspace.id, { ...workspace.settings, releaseWorkflowEnabled: true });
  await writeFile(path.join(f.source.projectRoot, "source.txt"), "functional Test result\n");
  const entered = deferred(), release = deferred(), snapshot = f.workspaces.snapshotAndMergeOwned.bind(f.workspaces);
  f.workspaces.snapshotAndMergeOwned = async (...args) => { entered.resolve(); await release.promise; return snapshot(...args); };
  const lifecycle = new TaskLifecycleService({ taskBoard: f.tasks, workspaceCatalog: f.catalog,
    taskGitWorkspaces: f.workspaces, releasePreflight: { withAwaitTransition: async (_id, work) => work() } });
  const handlers = await wiring(f, lifecycle), id = "desktop-actual-test";
  let admission;
  try {
    admission = await handlers.boardTaskStatus({ id: f.prior.id, status: "testing" }, { commandId: id });
    assert.equal(admission.taskOperation.requestId, id); assert.equal(admission.taskOperation.terminal, false);
    await entered.promise;
    const read = handlers.boardTaskRead({ id: f.prior.id, operationRequestId: id, argumentsHash: admission.taskOperation.argumentsHash });
    assert.equal(read.operation.taskOperation.phase, "pending_git");
    assert.equal(read.operation.taskOperation.actorKind, "authenticated-user");
    assert.equal(read.operation.taskOperation.provider, null);
    assert.equal(f.tasks.task(f.prior.id).workflowStatus, f.prior.workflowStatus);
  } finally { release.resolve(); }
  const result = await terminal(f, id, admission.taskOperation.argumentsHash);
  assert.equal(result.taskOperation.status, "succeeded", JSON.stringify(result));
  assert.equal(result.result.task.workflowStatus, "testing");
  assert.equal(f.tasks.task(f.prior.id).workflowStatus, "testing");
  assert.equal(f.tasks.task(f.prior.id).gitReferences.length, 1);
  const awaitEntered = deferred(), awaitRelease = deferred();
  lifecycle.releasePreflight.prepareAwaitAcceptance = async ({ acceptingTask, commitPrepared }) => {
    awaitEntered.resolve(); await awaitRelease.promise;
    return commitPrepared({ task: { ...acceptingTask, resultCommit: f.tasks.task(f.prior.id).gitReferences[0].resultCommit }, planRevision: "controlled-release-port" });
  };
  let awaiting;
  try {
    awaiting = await handlers.boardTaskStatus({ id: f.prior.id, status: "awaiting_implementation" }, { commandId: "desktop-actual-await" });
    await awaitEntered.promise;
    assert.equal(awaiting.taskOperation.terminal, false);
    assert.equal(f.tasks.task(f.prior.id).workflowStatus, "testing");
    assert.equal(handlers.boardTaskRead({ id: f.prior.id, operationRequestId: "desktop-actual-await", argumentsHash: awaiting.taskOperation.argumentsHash }).operation.taskOperation.phase, "pending_git");
  } finally { awaitRelease.resolve(); }
  const accepted = await terminal(f, "desktop-actual-await", awaiting.taskOperation.argumentsHash);
  assert.equal(accepted.taskOperation.status, "succeeded", JSON.stringify(accepted));
  assert.equal(f.tasks.task(f.prior.id).workflowStatus, "awaiting_implementation");
  assert.equal(f.tasks.task(f.prior.id).gitReferences[0].resultCommit, result.result.task.gitReferences[0].resultCommit);
});

test("actual Desktop create/update keep user identity and one durable operation per real action", async t => {
  const f = await claimCustodyFixture(t), handlers = await wiring(f, {});
  const created = await handlers.boardTaskCreate({ workspaceId: f.prior.workspaceId, text: "Created by the user", operationId: "desktop-create" }, { commandId: "outer-create" });
  const creation = await terminal(f, "desktop-create", created.taskOperation.argumentsHash);
  assert.equal(creation.taskOperation.status, "succeeded");
  const id = creation.result.id, before = f.tasks.task(id);
  const updated = await handlers.boardTaskUpdate({ id, title: "Updated by the user", operationId: "desktop-update" }, { commandId: "outer-update" });
  const update = await terminal(f, "desktop-update", updated.taskOperation.argumentsHash);
  assert.equal(update.taskOperation.status, "succeeded", JSON.stringify(update));
  assert.equal(f.tasks.task(id).title, "Updated by the user");
  assert.equal(f.tasks.task(id).revision, before.revision + 1);
  const repeat = await handlers.boardTaskUpdate({ id, title: "Updated by the user", operationId: "desktop-update" }, { commandId: "different-outer-reply" });
  assert.equal(repeat.taskOperation.status, "succeeded");
  assert.equal(f.tasks.task(id).revision, before.revision + 1);
  assert.equal(f.catalog.mcpOperation("desktop-update").actorKind, "authenticated-user");
});

for (const action of ["Complete", "Remove"]) test(`actual Desktop ${action} preview and confirmation retain separate originals and canonical cleanup result`, async t => {
  const f = await claimCustodyFixture(t);
  const task = await f.tasks.create({ text: "Disposable user card", bucket: "workspace", workspaceId: f.prior.workspaceId });
  const lifecycle = new TaskLifecycleService({ taskBoard: f.tasks, workspaceCatalog: f.catalog, taskGitWorkspaces: f.workspaces });
  const handlers = await wiring(f, lifecycle), method = handlers[`boardTask${action}`];
  const previewId = `desktop-${action}-preview`, confirmId = `desktop-${action}-confirm`;
  const admitted = await method({ id: task.id }, { commandId: previewId });
  const preview = await terminal(f, previewId, admitted.taskOperation.argumentsHash);
  assert.equal(preview.taskOperation.status, "succeeded", JSON.stringify(preview));
  assert.equal(preview.result.confirmationRequired, true); assert.equal(f.tasks.task(task.id).status, task.status);
  const next = await method({ id: task.id, confirmCleanup: true, expectedCleanupToken: preview.result.cleanupToken }, { commandId: confirmId });
  const confirmed = await terminal(f, confirmId, next.taskOperation.argumentsHash);
  assert.equal(confirmed.taskOperation.status, "succeeded", JSON.stringify(confirmed));
  const read = handlers.boardTaskRead({ id: task.id, operationRequestId: confirmId, argumentsHash: next.taskOperation.argumentsHash });
  assert.deepEqual(read.operation.result, confirmed.result);
  assert.equal(f.catalog.mcpOperation(previewId).result.cleanupToken, preview.result.cleanupToken);
  if (action === "Remove") { assert.equal(confirmed.result.deleted, true); assert.throws(() => f.tasks.task(task.id)); }
  else assert.equal(f.tasks.task(task.id).status, "done");
});
