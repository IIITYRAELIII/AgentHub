import assert from 'node:assert/strict';
import test from 'node:test';
import { claimCustodyFixture } from '../fixtures/claim-custody-public-fixture.mjs';
import { TaskLifecycleService } from '../../src/application/task-lifecycle-service.mjs';

for (const failSettlementRead of [false, true]) test(`lifecycle begin failure retains its original through ${failSettlementRead ? 'failed' : 'successful'} completion read`, async t => {
  const f = await claimCustodyFixture(t);
  const workspace = f.catalog.workspace(f.prior.workspaceId);
  await f.catalog.updateWorkspaceSettings(workspace.id, { ...workspace.settings, releaseWorkflowEnabled: true });
  await f.tasks.setWorkflowStatus({ id: f.prior.id, status: 'testing' });
  await f.tasks.recordTaskGitReference({ taskId: f.prior.id, projectRoot: f.source.repositoryRoot,
    branch: f.source.branch, resultSnapshot: { repoRoot: f.source.repositoryRoot, tree: f.source.headCommit } });
  const task = f.tasks.task(f.prior.id);
  let effects = 0, begins = 0, readFailed = false, beginFailed = false;
  const original = Object.assign(new Error('fixture lifecycle BEGIN write unavailable'), { code: 'FIXTURE_BEGIN_SQL' });
  const readFailure = Object.assign(new Error('fixture completion custody read unavailable'), { code: 'FIXTURE_READ_SQL' });
  const laterTaskRead = new Error('fixture follow-up Task read unavailable');
  const taskRead = f.tasks.task.bind(f.tasks);
  const custodyRead = f.rawCatalog.claimCustodyForOriginal.bind(f.rawCatalog);
  f.hub.taskLifecycle = new TaskLifecycleService({ taskBoard: f.tasks, workspaceCatalog: f.catalog,
    taskGitWorkspaces: f.workspaces, releasePreflight: {
      async withAwaitTransition(_id, operation) { return operation(); },
      async prepareAwaitAcceptance() { effects++; throw new Error('integration must not start'); },
    } });
  f.rawTasks.beginLifecycleTransition = () => { begins++; beginFailed = true; throw original; };
  f.tasks.task = (...args) => { if (beginFailed) throw laterTaskRead; return taskRead(...args); };
  f.rawCatalog.claimCustodyForOriginal = (...args) => {
    if (failSettlementRead && beginFailed && !readFailed) { readFailed = true; throw readFailure; }
    return custodyRead(...args);
  };
  const args = { context_token: f.successorToken, request_id: 'lifecycle-begin-failure', task_id: task.id,
    status: 'awaiting_implementation', expected_task_revision: task.revision, expected_workflow_status: 'testing' };
  let caught;
  try { await f.hub.call('hub_task_status_update', args); }
  catch (error) { caught = error; }
  finally { f.tasks.task = taskRead; f.rawCatalog.claimCustodyForOriginal = custodyRead; }
  assert.equal(effects, 0); assert.equal(begins, 1);
  if (failSettlementRead) {
    assert.equal(caught?.code, 'MCP_COMPLETION_PERSISTENCE_FAILED');
    assert.equal(caught.cause, original); assert.equal(caught.errors[1], readFailure);
  } else assert.equal(caught, original, 'a failed follow-up Task read must not replace the original BEGIN error');
  assert.equal(f.tasks.lifecycleTransition(args.request_id), null);
  assert.equal(f.tasks.lifecycleOutcome(args.request_id), null);
  const get = (hub, token) => hub.call('hub_task_operation_get', { context_token: token,
    operation_request_id: args.request_id });
  const result = await get(f.hub, f.successorToken);
  assert.equal(result.taskOperation.active, false);
  assert.equal(result.taskOperation.status, failSettlementRead ? 'pending' : 'unknown');
  if (failSettlementRead) {
    assert.equal(result.taskOperation.completionFailure.originalError.code, original.code);
    assert.equal(result.taskOperation.completionFailure.persistenceError.code, readFailure.code);
  }
  const opened = await f.open(), peer = f.service(opened, false);
  const token = peer.contextToken({ provider: 'codex', threadId: `${f.successor.id}-thread` });
  assert.deepEqual((await get(peer, token)).taskOperation.completionFailure, result.taskOperation.completionFailure);
  await peer.submitTaskOperation('hub_task_status_update', { ...args, context_token: token });
  assert.equal(begins, 1); assert.equal(effects, 0);
  if (failSettlementRead) {
    const row = f.catalog.mcpOperation(args.request_id);
    await f.hub.call('hub_task_operation_cancel', { context_token: f.managerToken,
      request_id: 'stop-original-begin-failure', task_id: task.id, operation_request_id: args.request_id,
      expected_arguments_hash: row.argumentsHash, expected_task_revision: task.revision, confirm_cancel: true });
    const stopped = await get(f.hub, f.successorToken);
    assert.equal(stopped.taskOperation.cancellation.phase, 'stopped');
    assert.equal(stopped.taskOperation.cancellation.effects, 'retained_unknown');
    assert.equal(stopped.taskOperation.status, 'failed');
    assert.equal(f.tasks.lifecycleTransition(args.request_id), null);
  }
});
