import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { claimCustodyFixture } from "../fixtures/claim-custody-public-fixture.mjs";
import { TaskLifecycleService } from "../../src/application/task-lifecycle-service.mjs";
import { DesktopTaskBoardController } from "../../src/interfaces/desktop/desktop-task-board-controller.mjs";

function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
function cancel(f, id) {
  return f.hub.call("hub_task_operation_cancel", { context_token: f.managerToken, request_id: id,
    task_id: f.prior.id, operation_request_id: f.original.requestId,
    expected_arguments_hash: f.original.argumentsHash, expected_task_revision: f.tasks.task(f.prior.id).revision,
    original_arguments: f.originalArgs, confirm_cancel: true });
}

test("requested stop excludes same-Task admission across reopen until confirmed; other Tasks and dirty bytes survive", async t => {
  const f = await claimCustodyFixture(t);
  const file = path.join(f.source.projectRoot, "source.txt"), dirty = Buffer.from("pending stop dirty work\r\n");
  await writeFile(file, dirty);
  const before = f.tasks.task(f.prior.id), prepares = f.prepares();
  assert.equal((await cancel(f, "request-stop")).phase, "requested");
  const requested = f.catalog.mcpOperation(f.original.requestId);
  const reopened = await f.open(), peer = f.service(reopened);
  const token = peer.contextToken({ provider: "codex", threadId: `${f.successor.id}-thread` });
  for (const [tool, extra] of [["hub_task_claim", { dependency_mode: "skip" }], ["hub_task_status_update", { status: "testing" }]]) {
    const id = `blocked-${tool}`;
    await assert.rejects(peer.call(tool, { context_token: token, request_id: id, task_id: f.prior.id, ...extra }), /stop is not confirmed/);
    assert.equal(reopened.catalog.mcpOperation(id), null);
  }
  assert.equal(f.prepares(), prepares);
  assert.deepEqual(f.tasks.task(f.prior.id), before);
  assert.deepEqual(f.catalog.mcpOperation(f.original.requestId), requested);
  const other = await f.tasks.create({ text: "Independent Task", bucket: "workspace", workspaceId: before.workspaceId });
  const claimedOther = await peer.call("hub_task_claim", { context_token: token, request_id: "independent-claim", task_id: other.id, dependency_mode: "skip" });
  assert.equal(claimedOther.id, other.id);
  f.retire();
  assert.equal((await cancel(f, "confirm-stop")).phase, "stopped");
  const next = await peer.call("hub_task_claim", { context_token: token, request_id: "next-after-stop", task_id: f.prior.id, dependency_mode: "skip" });
  assert.equal(next.id, before.id);
  assert.deepEqual(await readFile(file), dirty);
  assert.deepEqual(f.catalog.mcpOperation(f.original.requestId).taskExecution.cancellation.original, f.original);
});

test("stop admitted during preparation fences its next effect and final SQL assignment", async t => {
  const f = await claimCustodyFixture(t), entered = deferred(), release = deferred();
  const prepare = f.workspaces.prepareOwned.bind(f.workspaces);
  f.workspaces.prepareOwned = async (...args) => { entered.resolve(); await release.promise; return prepare(...args); };
  const before = f.tasks.task(f.prior.id);
  const pending = f.hub.call("hub_task_claim", { context_token: f.successorToken, request_id: "admitted-before-stop", task_id: before.id, dependency_mode: "skip" });
  const rejected = assert.rejects(pending, /stop is not confirmed/);
  await entered.promise;
  try {
    assert.equal((await cancel(f, "racing-stop")).phase, "requested");
    // Direct existing SQL owners also refuse, independent of inherited context.
    await assert.rejects(f.tasks.claim({ id: before.id, workspaceId: before.workspaceId, streamId: f.successor.id,
      provider: "codex", threadId: `${f.successor.id}-thread`, turnId: "late-turn", operationId: "late-sql-claim" }), /stop is not confirmed/);
    await assert.rejects(f.tasks.beginLifecycleTransition({ id: before.id, operationId: "late-sql-workflow", kind: "workflow",
      targetWorkflowStatus: "testing", expectedRevision: before.revision }), /stop is not confirmed/);
  } finally { release.resolve(); await rejected; }
  assert.deepEqual(f.tasks.task(before.id), before);
});

test("pending stop fences already prepared workflow finalization without rewriting its evidence", async t => {
  const f = await claimCustodyFixture(t), before = f.tasks.task(f.prior.id);
  await f.tasks.beginLifecycleTransition({ id: before.id, operationId: "prepared-before-stop", kind: "workflow",
    targetWorkflowStatus: "in_progress", expectedRevision: before.revision });
  const transition = f.tasks.lifecycleTransition("prepared-before-stop");
  await cancel(f, "stop-before-final-sql");
  await assert.rejects(f.tasks.commitWorkflowTransition({ operationId: "prepared-before-stop" }), /stop is not confirmed/);
  assert.deepEqual(f.tasks.lifecycleTransition("prepared-before-stop"), transition);
  assert.deepEqual(f.tasks.task(before.id), before);
});

for (const unassigned of [true, false]) test(`actual Desktop user operation lists, cancels and permits next action (unassigned=${unassigned})`, async t => {
  const f = await claimCustodyFixture(t, { unassigned, prepared: true });
  const workspace = f.catalog.workspace(f.prior.workspaceId);
  await f.catalog.updateWorkspaceSettings(workspace.id, { ...workspace.settings, releaseWorkflowEnabled: true });
  const entered = deferred(), drain = deferred();
  f.workspaces.snapshotAndMergeOwned = async ({ lease }) => {
    entered.resolve();
    await Promise.race([drain.promise.then(() => { throw new Error("fixture drain"); }), new Promise((_, reject) => {
      if (lease.signal.aborted) reject(lease.signal.reason);
      else lease.signal.addEventListener("abort", () => reject(lease.signal.reason), { once: true });
    })]);
  };
  const lifecycle = new TaskLifecycleService({ taskBoard: f.tasks, workspaceCatalog: f.catalog, taskGitWorkspaces: f.workspaces,
    releasePreflight: { withAwaitTransition: async (_id, operation) => operation() } });
  const controller = new DesktopTaskBoardController({ taskBoard: f.tasks, workspaceCatalog: f.catalog,
    hubMcpService: f.hub, taskLifecycle: lifecycle, taskLauncher: {}, snapshot: async () => ({}) });
  const id = `desktop-user-${unassigned}`, pending = controller.status({ id: f.prior.id, status: "testing" }, { commandId: id });
  const outcome = pending.then(value => ({ value }), error => ({ error }));
  t.after(async () => { drain.resolve(); await outcome; });
  await entered.promise;
  const op = controller.read({ id: f.prior.id }).taskOperations.find(row => row.requestId === id);
  assert.ok(op);
  assert.equal(op.actorKind, "authenticated-user");
  assert.equal(op.streamId, null); assert.equal(op.provider, null); assert.equal(op.threadId, null);
  const receipt = f.catalog.mcpOperation(id);
  assert.equal(f.tasks.lifecycleTransition(id).phase, "pending_git");
  const cancelled = await controller.cancelOperation({ id: f.prior.id, operationRequestId: id, argumentsHash: op.argumentsHash,
    expectedRevision: f.tasks.task(f.prior.id).revision, requestId: `cancel-${id}`, confirmCancel: true });
  assert.match((await outcome).error?.message ?? "", /explicitly interrupted/);
  assert.equal(cancelled.cancellation.phase, "stopped");
  assert.deepEqual(f.catalog.mcpOperation(id).taskExecution.cancellation.original, receipt);
  const reopened = await f.open();
  assert.equal(reopened.catalog.mcpOperation(id).actorKind, "authenticated-user");
  assert.equal(reopened.catalog.mcpOperation(id).taskExecution.cancellation.phase, "stopped");
  await controller.status({ id: f.prior.id, status: "in_progress" }, { commandId: `next-${id}` });
  assert.equal(f.tasks.task(f.prior.id).workflowStatus, "in_progress");
  assert.equal(f.tasks.task(f.prior.id).streamId, f.prior.streamId);
});

test("existing Desktop Backlog workflow retains absent Workspace and provider identities", async t => {
  const f = await claimCustodyFixture(t, { unassigned: true, prepared: true });
  f.prior = await f.tasks.create({ text: "Unassigned Backlog", bucket: "backlog" });
  const lifecycle = new TaskLifecycleService({ taskBoard: f.tasks, workspaceCatalog: f.catalog, taskGitWorkspaces: f.workspaces });
  const controller = new DesktopTaskBoardController({ taskBoard: f.tasks, workspaceCatalog: f.catalog,
    hubMcpService: f.hub, taskLifecycle: lifecycle, taskLauncher: {}, snapshot: async () => ({}) });
  await controller.status({ id: f.prior.id, status: "in_progress" }, { commandId: "backlog-user-workflow" });
  const receipt = f.catalog.mcpOperation("backlog-user-workflow");
  assert.equal(receipt.status, "succeeded"); assert.equal(receipt.actorKind, "authenticated-user");
  for (const key of ["workspaceId", "streamId", "provider", "threadId"]) assert.equal(receipt[key], null);
  assert.equal(f.tasks.task(f.prior.id).workspaceId, null);
});
