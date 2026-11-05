import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { claimCustodyFixture } from '../fixtures/claim-custody-public-fixture.mjs';
import { createCommandTraceComposition } from '../../src/composition/command-trace-composition.mjs';

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
