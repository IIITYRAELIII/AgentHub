import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { claimCustodyFixture } from '../fixtures/claim-custody-public-fixture.mjs';
import { createCommandTraceComposition } from '../../src/composition/command-trace-composition.mjs';
import { TaskLifecycleService } from '../../src/application/task-lifecycle-service.mjs';

const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
async function setup(t){
  const traces=[];t.after(async()=>{for(const trace of traces)await trace.close();});
  const f=await claimCustodyFixture(t), done=deferred();
  const trace=createCommandTraceComposition({databaseFile:path.join(f.root,'trace.sqlite')});
  traces.push(trace);await trace.initialize();
  f.hub.recordCommandTrace=span=>{trace.service.recordBestEffort(span);
    if(span.stage==='task-operation-result')done.resolve(span);};
  const args={context_token:f.successorToken,request_id:'completion-claim',task_id:f.prior.id};
  const get=(hub=f.hub,token=f.successorToken)=>hub.call('hub_task_operation_get',{
    context_token:token,operation_request_id:args.request_id});
  return {...f,args,done,trace,traces,get};
}

for(const outerWriteFails of [false,true])test(`Await lifecycle persistence failure survives ${outerWriteFails?'failed':'successful'} outer UNKNOWN write and reopen`,async t=>{
  const f=await setup(t);
  const workspace=f.catalog.workspace(f.prior.workspaceId);
  await f.catalog.updateWorkspaceSettings(workspace.id,{...workspace.settings,releaseWorkflowEnabled:true});
  await f.tasks.setWorkflowStatus({id:f.prior.id,status:'testing'});
  await f.tasks.recordTaskGitReference({taskId:f.prior.id,projectRoot:f.source.repositoryRoot,
    branch:f.source.branch,resultSnapshot:{repoRoot:f.source.repositoryRoot,tree:f.source.headCommit}});
  const task=f.tasks.task(f.prior.id);
  const original=Object.assign(new Error('fixture native merge requires owned resolution'),{code:'RELEASE_NATIVE_MERGE_CONFLICT'});
  const persistence=Object.assign(new Error('fixture lifecycle failure write unavailable'),{code:'FIXTURE_LIFECYCLE_SQL'});
  const outer=Object.assign(new Error('fixture outer UNKNOWN write unavailable'),{code:'FIXTURE_OUTER_SQL'});
  let attempts=0,failWrites=0;
  f.hub.taskLifecycle=new TaskLifecycleService({taskBoard:f.tasks,workspaceCatalog:f.catalog,
    taskGitWorkspaces:f.workspaces,releasePreflight:{
      async withAwaitTransition(_id,operation){return operation();},
      async prepareAwaitAcceptance(){attempts++;throw original;},
    }});
  f.rawTasks.failLifecycleTransition=()=>{failWrites++;throw persistence;};
  if(outerWriteFails)f.rawCatalog.markMcpOperationUnknown=()=>{throw outer;};
  Object.assign(f.args,{request_id:'await-lifecycle-completion',status:'awaiting_implementation',
    expected_task_revision:task.revision,expected_workflow_status:'testing'});
  let caught;
  try{await f.hub.call('hub_task_status_update',f.args);}catch(error){caught=error;}
  const lifecycleError=outerWriteFails?caught.cause:caught;
  assert.equal(lifecycleError.code,'TASK_LIFECYCLE_PERSISTENCE_FAILED');
  assert.equal(lifecycleError.cause.cause,original);
  assert.equal(lifecycleError.errors[1],persistence);
  if(outerWriteFails){assert.equal(caught.code,'MCP_COMPLETION_PERSISTENCE_FAILED');assert.equal(caught.errors[1],outer);}
  assert.equal(attempts,1);assert.equal(failWrites,1);
  assert.equal(f.tasks.lifecycleTransition(f.args.request_id).phase,'pending_git');
  assert.equal(f.tasks.lifecycleOutcome(f.args.request_id),null);
  const value=await f.get();
  assert.equal(value.taskOperation.active,false);
  assert.equal(value.taskOperation.status,outerWriteFails?'pending':'unknown');
  assert.equal(value.taskOperation.execution.state,outerWriteFails?'unresolved':'unknown');
  assert.equal(value.taskOperation.completionFailure.persistenceError.message,persistence.message);
  assert.equal(value.taskOperation.completionFailure.originalError.code,'TASK_AWAIT_INTEGRATION_FAILED');
  assert.equal(value.taskOperation.completionFailure.effects,'retained_unknown');
  const opened=await f.open(),peer=f.service(opened,false);
  const token=peer.contextToken({provider:'codex',threadId:`${f.successor.id}-thread`});
  assert.deepEqual((await f.get(peer,token)).taskOperation.completionFailure,value.taskOperation.completionFailure);
  await peer.submitTaskOperation('hub_task_status_update',{...f.args,context_token:token});
  assert.equal(attempts,1);assert.equal(failWrites,1);
  await f.trace.close();
  const reopened=createCommandTraceComposition({databaseFile:path.join(f.root,'trace.sqlite')});
  f.traces.push(reopened);await reopened.initialize();
  const span=(await reopened.service.readCommandTimeline(f.args.request_id)).find(x=>x.stage==='task-operation-completion-failure');
  assert.equal(span.metadata.persistenceErrorCode,'FIXTURE_LIFECYCLE_SQL');
  assert.equal(span.metadata.originalErrorCode,'TASK_AWAIT_INTEGRATION_FAILED');
  assert.ok(!JSON.stringify(span).includes(persistence.message));
});
test('Await failure after Task lease loss cannot persist lifecycle failure or invent a persistence diagnostic',async t=>{
  const f=await setup(t);
  const workspace=f.catalog.workspace(f.prior.workspaceId);
  await f.catalog.updateWorkspaceSettings(workspace.id,{...workspace.settings,releaseWorkflowEnabled:true});
  await f.tasks.setWorkflowStatus({id:f.prior.id,status:'testing'});
  await f.tasks.recordTaskGitReference({taskId:f.prior.id,projectRoot:f.source.repositoryRoot,
    branch:f.source.branch,resultSnapshot:{repoRoot:f.source.repositoryRoot,tree:f.source.headCommit}});
  const task=f.tasks.task(f.prior.id),withTaskLock=f.workspaces.withTaskLock.bind(f.workspaces);
  const original=Object.assign(new Error('fixture native merge failed before lease loss'),{code:'RELEASE_NATIVE_MERGE_CONFLICT'});
  let lost=false,failWrites=0;
  f.workspaces.withTaskLock=(id,operation,...rest)=>withTaskLock(id,lease=>operation({...lease,
    async assertOwned(){if(lost)throw new Error('fixture Task lease lost');await lease.assertOwned();},
  }),...rest);
  f.rawTasks.failLifecycleTransition=()=>{failWrites++;throw new Error('fenced lifecycle write must not run');};
  f.hub.taskLifecycle=new TaskLifecycleService({taskBoard:f.tasks,workspaceCatalog:f.catalog,
    taskGitWorkspaces:f.workspaces,releasePreflight:{
      async withAwaitTransition(_id,operation){return operation();},
      async prepareAwaitAcceptance(){lost=true;throw original;},
    }});
  Object.assign(f.args,{request_id:'await-fenced-lifecycle-failure',status:'awaiting_implementation',
    expected_task_revision:task.revision,expected_workflow_status:'testing'});
  await assert.rejects(f.hub.call('hub_task_status_update',f.args),error=>{
    assert.equal(error.code,'TASK_AWAIT_INTEGRATION_FAILED');assert.equal(error.cause,original);return true;
  });
  assert.equal(failWrites,0);
  assert.equal(f.tasks.lifecycleTransition(f.args.request_id).phase,'pending_git');
  assert.equal(f.tasks.lifecycleOutcome(f.args.request_id),null);
  const value=await f.get();
  assert.equal(value.taskOperation.active,false);assert.equal(value.taskOperation.status,'unknown');
  assert.equal(value.taskOperation.completionFailure,undefined);
});
test('completion failure preserves both errors across readback and reopen without replay',async t=>{
  const f=await setup(t);let prepares=0;
  f.workspaces.prepareOwned=async()=>{prepares++;throw Object.assign(new Error('original fixture preparation failure'),{code:'PREPARE_FIXTURE'});};
  f.rawCatalog.markMcpOperationUnknown=()=>{throw Object.assign(new Error('fixture UNKNOWN write failed'),{code:'ERR_SQLITE_ERROR'});};
  await f.hub.submitTaskOperation('hub_task_claim',f.args);const event=await f.done.promise;
  const value=await f.get();assert.equal(value.taskOperation.status,'pending');
  assert.equal(value.taskOperation.execution?.state,'unresolved');assert.equal(event.outcome,'unresolved');
  const failure=value.taskOperation.completionFailure;
  assert.equal(failure.originalError.message,'original fixture preparation failure');
  assert.equal(failure.persistenceError.message,'fixture UNKNOWN write failed');
  assert.equal(failure.effects,'retained_unknown');
  const opened=await f.open(),peer=f.service(opened,false);
  const token=peer.contextToken({provider:'codex',threadId:`${f.successor.id}-thread`});
  assert.deepEqual((await f.get(peer,token)).taskOperation.completionFailure,failure);
  await peer.submitTaskOperation('hub_task_claim',{...f.args,context_token:token});assert.equal(prepares,1);
  await f.trace.close();
  const reopened=createCommandTraceComposition({databaseFile:path.join(f.root,'trace.sqlite')});
  f.traces.push(reopened);await reopened.initialize();
  const spans=await reopened.service.readCommandTimeline(f.args.request_id);
  const saved=spans.find(x=>x.stage==='task-operation-completion-failure');
  assert.equal(saved.metadata.persistenceErrorCode,'ERR_SQLITE_ERROR');
  assert.equal(saved.metadata.originalErrorCode,'PREPARE_FIXTURE');
  assert.equal(saved.metadata.originalErrorSha256.length,64);
  assert.ok(!JSON.stringify(spans).includes('original fixture preparation failure'),'trace contains hashes/codes, not arbitrary error text');
});
test('a live invocation stays active and same-original submission cannot reclaim it',async t=>{
  const f=await setup(t),entered=deferred(),release=deferred();let prepares=0;
  f.workspaces.prepareOwned=async()=>{prepares++;entered.resolve();await release.promise;throw new Error('late fixture failure');};
  try {
  await f.hub.submitTaskOperation('hub_task_claim',f.args);await entered.promise;
  const live=await f.get();assert.equal(live.taskOperation.execution?.state,'active');
  assert.equal(live.taskOperation.active,true);
  const again=await f.hub.submitTaskOperation('hub_task_claim',f.args);
  assert.equal(again.taskOperation.execution.state,'active');assert.equal(prepares,1);
  const opened=await f.open(),peer=f.service(opened,false);
  const token=peer.contextToken({provider:'codex',threadId:`${f.successor.id}-thread`});
  const elsewhere=await f.get(peer,token);
  assert.equal(elsewhere.taskOperation.status,'pending');assert.equal(elsewhere.taskOperation.execution.state,'unresolved');
  await peer.submitTaskOperation('hub_task_claim',{...f.args,context_token:token});
  assert.equal(prepares,1);assert.equal((await f.get()).taskOperation.active,true);
  release.resolve();await f.done.promise;
  assert.equal((await f.get()).taskOperation.status,'unknown');
  assert.equal((await f.get()).taskOperation.execution.state,'unknown');
  } finally {release.resolve();await f.done.promise;}
});

for(const committed of [false,true])test(`effect completion lost reply preserves ${committed?'committed success':'unknown outcome'} without repeating effect`,async t=>{
  const f=await setup(t);let effects=0;
  const complete=f.rawCatalog.completeMcpOperation.bind(f.rawCatalog);
  f.rawCatalog.completeMcpOperation=(id,result)=>{
    if(id!==f.args.request_id)return complete(id,result);
    if(committed)complete(id,result);
    throw new Error('fixture completion reply lost');
  };
  const prepare=f.workspaces.prepareOwned.bind(f.workspaces);
  f.workspaces.prepareOwned=async(...args)=>{effects++;return prepare(...args);};
  await f.hub.submitTaskOperation('hub_task_claim',f.args);await f.done.promise;
  const result=await f.get();assert.equal(effects,1);
  assert.equal(result.taskOperation.status,committed?'succeeded':'unknown');
  assert.equal(result.taskOperation.execution.state,committed?'terminal':'unknown');
  const row=f.catalog.mcpOperation(f.args.request_id);
  await f.hub.submitTaskOperation('hub_task_claim',f.args);
  assert.equal(effects,1);assert.deepEqual(f.catalog.mcpOperation(f.args.request_id),row);
});

test('diagnostics cannot mutate STOPPED history or be recorded by a foreign execution owner',async t=>{
  const f=await setup(t);
  f.workspaces.prepareOwned=async()=>{throw new Error('fixture effect uncertainty');};
  await f.hub.submitTaskOperation('hub_task_claim',f.args);await f.done.promise;
  const row=f.catalog.mcpOperation(f.args.request_id);
  const identity={...Object.fromEntries(['workspaceId','streamId','provider','threadId','toolName','argumentsHash','createdAtMs'].map(k=>[k,row[k]])),actorKind:'provider'};
  const diagnostic={version:1,kind:'mcp-completion-failure-v1',effects:'retained_unknown',effectCompleted:false,
    originalError:{name:'Error',code:null,message:'effect'},persistenceError:{name:'Error',code:null,message:'receipt'}};
  await assert.rejects(f.catalog.recordMcpOperationCompletionFailure(row.requestId,{identity,ownerId:'foreign',diagnostic}),/owner differs/);
  assert.deepEqual(f.catalog.mcpOperation(row.requestId),row);
  await f.hub.call('hub_task_operation_cancel',{context_token:f.managerToken,request_id:'stop-completion-original',
    task_id:f.prior.id,operation_request_id:row.requestId,expected_arguments_hash:row.argumentsHash,
    expected_task_revision:f.prior.revision,confirm_cancel:true});
  const stopped=f.catalog.mcpOperation(row.requestId);
  await f.catalog.recordMcpOperationCompletionFailure(row.requestId,{identity,ownerId:row.taskExecution.ownerId,diagnostic});
  assert.deepEqual(f.catalog.mcpOperation(row.requestId),stopped);
});

test('diagnostic-write failure exposes both original exceptions and persists content-free trace fallback',async t=>{
  const f=await setup(t);
  f.workspaces.prepareOwned=async()=>{throw Object.assign(new Error('opaque fixture effect error'),{code:'FIXTURE_EFFECT'});};
  f.rawCatalog.markMcpOperationUnknown=()=>{throw Object.assign(new Error('UNKNOWN fixture write failed'),{code:'ERR_SQLITE_ERROR'});};
  f.rawCatalog.recordMcpOperationCompletionFailure=()=>{throw new Error('diagnostic fixture write also failed');};
  await assert.rejects(f.hub.call('hub_task_claim',f.args),error=>{
    assert.equal(error.code,'MCP_COMPLETION_PERSISTENCE_FAILED');
    assert.equal(error.cause.message,'opaque fixture effect error');
    assert.equal(error.errors[1].message,'UNKNOWN fixture write failed');return true;
  });
  const result=await f.get();assert.equal(result.taskOperation.execution.state,'unresolved');
  assert.equal(result.taskOperation.status,'pending');assert.equal(result.taskOperation.completionFailure,undefined);
  await f.trace.close();
  const reopened=createCommandTraceComposition({databaseFile:path.join(f.root,'trace.sqlite')});
  f.traces.push(reopened);await reopened.initialize();
  const span=(await reopened.service.readCommandTimeline(f.args.request_id)).find(x=>x.stage==='task-operation-completion-failure');
  assert.equal(span.metadata.diagnosticSaved,false);assert.equal(span.metadata.originalErrorCode,'FIXTURE_EFFECT');
  assert.equal(span.metadata.persistenceErrorCode,'ERR_SQLITE_ERROR');
});

test('a canonical success committed before an inner lost reply wins before outer effect flag',async t=>{
  const f=await setup(t);let effects=0;
  const saved={id:f.prior.id,fixtureResult:'canonical committed result'};
  f.workspaces.prepareOwned=async()=>{effects++;f.rawCatalog.completeMcpOperation(f.args.request_id,saved);
    throw new Error('inner fixture reply lost after canonical commit');};
  assert.deepEqual(await f.hub.call('hub_task_claim',f.args),saved);
  const row=f.catalog.mcpOperation(f.args.request_id);
  assert.equal(row.status,'succeeded');assert.equal(row.taskExecution.completionFailure,undefined);
  await f.hub.submitTaskOperation('hub_task_claim',f.args);assert.equal(effects,1);
  assert.deepEqual(f.catalog.mcpOperation(f.args.request_id),row);
});

test('completion diagnostics release the local invocation even when later Task reads fail',async t=>{
  const f=await setup(t),readTask=f.tasks.task.bind(f.tasks);
  f.workspaces.prepareOwned=async()=>{throw new Error('original failed preparation');};
  f.rawCatalog.markMcpOperationUnknown=()=>{
    f.tasks.task=()=>{throw new Error('later fixture Task read failed');};
    throw new Error('original receipt write failed');
  };
  try {
    await assert.rejects(f.hub.call('hub_task_claim',f.args),error=>{
      assert.equal(error.code,'MCP_COMPLETION_PERSISTENCE_FAILED');
      assert.equal(error.cause.message,'original failed preparation');return true;
    });
    assert.equal((await f.get()).taskOperation.active,false);
    assert.equal((await f.get()).taskOperation.completionFailure.persistenceError.message,'original receipt write failed');
  } finally {f.tasks.task=readTask;}
});

test('reviewer completion diagnostic lookup failure cannot retain an active invocation',async t=>{
  const f=await setup(t);
  const original=Object.assign(new Error('reviewer original preparation failure'),{code:'REVIEWER_PREPARE'});
  const persistence=Object.assign(new Error('reviewer UNKNOWN persistence failure'),{code:'ERR_SQLITE_ERROR'});
  const lookup=Object.assign(new Error('reviewer Task read unavailable during completion diagnostics'),{code:'ERR_SQLITE_BUSY'});
  const taskRead=f.tasks.task.bind(f.tasks);
  let diagnosticPhase=false, observed;
  f.workspaces.prepareOwned=async()=>{throw original;};
  f.rawCatalog.markMcpOperationUnknown=()=>{diagnosticPhase=true;throw persistence;};
  // This is the real TaskBoardService port used by interruption.binding(args).
  // Only the extra diagnostic-time lookup fails; original admission and work run.
  f.tasks.task=(...args)=>{if(diagnosticPhase)throw lookup;return taskRead(...args);};
  try {await f.hub.call('hub_task_claim',f.args);}
  catch(error){observed=error;}
  finally {f.tasks.task=taskRead;}
  const result=await f.get();
  console.log(JSON.stringify({reviewerCompletionLookup:{errorCode:observed?.code,
    originalCause:observed?.cause===original,status:result.taskOperation.status,
    active:result.taskOperation.active,execution:result.taskOperation.execution}}));
  assert.equal(result.taskOperation.active,false,'settled invocation must release its local active marker even if diagnostic lookup fails');
  assert.equal(result.taskOperation.execution.state,'unresolved');
  assert.equal(observed?.code,'MCP_COMPLETION_PERSISTENCE_FAILED');
  assert.equal(observed.cause,original);
  assert.equal(observed.errors[1],persistence);
});
