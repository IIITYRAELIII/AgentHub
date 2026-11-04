import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { claimCustodyFixture } from '../fixtures/claim-custody-public-fixture.mjs';
import { TaskLifecycleService } from '../../src/application/task-lifecycle-service.mjs';
import { TaskOperationReconciliationService } from '../../src/application/task-operation-reconciliation-service.mjs';

function wire(f, hub = f.hub, stores = f) {
  hub.taskLifecycle = new TaskLifecycleService({ taskBoard: stores.tasks, workspaceCatalog: stores.catalog,
    taskGitWorkspaces: f.workspaces, releasePreflight: {
      withAwaitTransition: async (_id, action) => action(),
      prepareAwaitAcceptance: async () => { throw Object.assign(new Error('historical opaque preparation failure'),
        { code: 'AWAIT_PREPARATION_UNKNOWN' }); },
    } });
  hub.taskOperationReconciliation = new TaskOperationReconciliationService({
    workspaceCatalog: stores.catalog, taskBoard: stores.tasks, taskLifecycle: hub.taskLifecycle,
    taskExecution: hub.taskOperationInterruption,
  });
}

async function fixture(t, status) {
  // Existing fixture initializes only a two-file synthetic Git repository and
  // real schema stores; no application checkout/dependencies/runtime are copied.
  const f = await claimCustodyFixture(t);
  const ws = f.catalog.workspace(f.original.workspaceId);
  await f.catalog.updateWorkspaceSettings(ws.id, { ...ws.settings, releaseWorkflowEnabled: true });
  if (status === 'awaiting_implementation') {
    await f.tasks.setWorkflowStatus({ id: f.prior.id, status: 'testing' });
    await f.tasks.recordTaskGitReference({ taskId: f.prior.id, projectRoot: ws.settings.workingDirectory,
      branch: f.source.branch, resultSnapshot: { repoRoot: ws.settings.workingDirectory, tree: f.source.headCommit } });
  }
  let gitCalls = 0;
  f.workspaces.snapshotAndMergeOwned = async () => { gitCalls++; throw new Error('historical opaque preparation failure'); };
  wire(f);
  const before = f.tasks.task(f.prior.id);
  const args = { context_token: f.managerToken, request_id: `original-${status}`, task_id: before.id, status,
    expected_task_revision: before.revision, expected_workflow_status: before.workflowStatus };
  await assert.rejects(f.hub.call('hub_task_status_update', args), /historical opaque/);
  const original = f.catalog.mcpOperation(args.request_id);
  assert.equal(original.status, 'unknown');
  assert.equal(f.tasks.lifecycleTransition(args.request_id).phase,
    status === 'awaiting_implementation' ? 'pending_git' : 'failed');
  const input = { context_token: f.managerToken, request_id: `reconcile-${status}`, task_id: before.id,
    operation_request_id: args.request_id, confirm_reconcile: true, project_root: ws.settings.workingDirectory,
    expected_task_revision: args.expected_task_revision, expected_workflow_status: args.expected_workflow_status };
  const stop = () => f.hub.call('hub_task_operation_cancel', { context_token: f.managerToken,
    request_id: `stop-${status}`, task_id: before.id, operation_request_id: args.request_id,
    expected_arguments_hash: original.argumentsHash, expected_task_revision: before.revision, confirm_cancel: true });
  function raw() {
    const db = new DatabaseSync(path.join(f.root, 'hub.sqlite'), { readOnly: true });
    try { return db.prepare('SELECT * FROM hub_mcp_operations WHERE request_id=?').get(args.request_id); }
    finally { db.close(); }
  }
  return { ...f, args, original, input, before, stop, raw, gitCalls: () => gitCalls };
}

for (const status of ['testing', 'awaiting_implementation']) test(`stopped UNKNOWN ${status} has read-only canonical disposition and exact replay/reopen`, async t => {
  const f = await fixture(t, status);
  assert.equal((await f.stop()).phase, 'stopped');
  const receipt = f.catalog.mcpOperation(f.args.request_id), raw = f.raw();
  const transition = f.tasks.lifecycleTransition(f.args.request_id), calls = f.gitCalls();
  const result = await f.hub.call('hub_task_operation_reconcile', f.input);
  assert.equal(result.resolved, true);
  assert.equal(result.outcome, 'stopped');
  assert.equal(result.reconciliation.durableState, 'stopped_failed_transition');
  assert.equal(result.reconciliation.effects, 'retained_unknown');
  assert.equal(result.reconciliation.workflowOutcome, 'failed');
  assert.equal(result.reconciliation.originalReceiptPreserved, true);
  assert.deepEqual(result.receipt, receipt);
  assert.deepEqual(f.raw(), raw, 'all original SQLite columns, including retained stop history, stay exact');
  assert.deepEqual(f.tasks.lifecycleTransition(f.args.request_id), transition);
  assert.deepEqual(f.tasks.task(f.before.id), f.before);
  assert.equal(f.gitCalls(), calls);
  assert.deepEqual(await f.hub.call('hub_task_operation_reconcile', f.input), result);
  const reopened = await f.open(), peer = f.service(reopened); wire(f, peer, reopened);
  const token = peer.contextToken({ provider: 'codex', threadId: `${f.manager.id}-thread` });
  const replay = await peer.call('hub_task_operation_reconcile', { ...f.input, context_token: token });
  assert.deepEqual(replay, result);
  // The underlying generic mutation is STILL prohibited by the actual trigger.
  await assert.rejects(reopened.catalog.failUnknownMcpOperation(f.args.request_id, {
    workspaceId: receipt.workspaceId, toolName: receipt.toolName, error: new Error('rewrite'), reconciliation: {},
  }), /Interrupted operation history is immutable/);
  assert.deepEqual(f.raw(), raw);
  const next = await peer.call('hub_task_status_update', { context_token: token, request_id: `next-${status}`,
    task_id: f.before.id, status: 'blocked', expected_task_revision: f.before.revision,
    expected_workflow_status: f.before.workflowStatus });
  assert.equal(next.workflowStatus, 'blocked');
  assert.deepEqual(f.raw(), raw);
});

for (const change of ['requested', 'foreign-actor', 'cas', 'task-state', 'retirement', 'process-guard']) test(`stopped workflow reconciliation refuses ${change} without rewriting original`, async t => {
  const f = await fixture(t, 'testing');
  if (change === 'requested') {
    await f.catalog.requestTaskOperationInterruption(f.args.request_id, { taskId: f.before.id,
      targetWorkspaceId: f.before.workspaceId, expectedArgumentsHash: f.original.argumentsHash,
      expectedTaskRevision: f.before.revision, requestedAtMs: Date.now(), cancellationRequestId: 'unconfirmed-stop',
      actor: { releaseManager: true }, arguments: f.original.taskExecution.arguments, cohort: null });
  } else if (change === 'retirement') {
    await f.catalog.requestTaskOperationInterruption(f.args.request_id, { taskId: f.before.id,
      targetWorkspaceId: f.before.workspaceId, expectedArgumentsHash: f.original.argumentsHash,
      expectedTaskRevision: f.before.revision, requestedAtMs: Date.now(), cancellationRequestId: 'bad-retirement',
      actor: { releaseManager: true }, arguments: f.original.taskExecution.arguments, cohort: null });
    await f.catalog.finishTaskOperationInterruption(f.args.request_id,
      { kind: 'joined-local-worker', ownerId: 'different-execution' });
  } else await f.stop();
  if (change === 'process-guard') await f.workspaces.withTaskLock(f.before.id, async lease => {
    const guard = await lease.beginProcessTreeGuard({ args: ['fixture'], cwd: f.source.projectRoot });
    guard.markUnresolved(new Error('Unproven prior child tree'));
  });
  const raw = f.raw(), input = { ...f.input };
  if (change === 'foreign-actor') input.context_token = f.successorToken;
  if (change === 'cas') input.expected_task_revision++;
  if (change === 'task-state') await f.tasks.setWorkflowStatus({ id: f.before.id, status: 'blocked' });
  await assert.rejects(f.hub.call('hub_task_operation_reconcile', input));
  assert.deepEqual(f.raw(), raw);
});
