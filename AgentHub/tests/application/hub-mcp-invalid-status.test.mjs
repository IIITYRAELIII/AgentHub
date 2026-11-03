import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile } from "node:fs/promises";
import { claimCustodyFixture } from "../fixtures/claim-custody-public-fixture.mjs";
import { HubMcpService } from "../../src/application/hub-mcp-service.mjs";
import { HubMcpServer } from "../../src/interfaces/mcp/hub-mcp-server.mjs";
import { mcpArgumentsHash } from "../../src/domain/mcp-arguments-hash.mjs";
import { CommandTraceService } from "../../src/application/command-trace-service.mjs";
import { CommandTraceWorkerStore } from "../../src/infrastructure/persistence/command-trace-worker-store.mjs";
import { CommandTraceSpanStore } from "../../src/infrastructure/persistence/command-trace-span-store.mjs";
import { TaskOperationInterruption } from "../../src/application/task-operation-interruption.mjs";

async function fixture(t, options = {}) {
  let server; const cleanup=[];
  t.after(async()=>{ for(const close of cleanup.reverse()) await close(); await server?.close(); });
  const f=await claimCustodyFixture(t, options);
  const workspace=f.catalog.workspace(f.prior.workspaceId);
  await f.catalog.updateWorkspaceSettings(workspace.id,{...workspace.settings,releaseWorkflowEnabled:true});
  await f.tasks.setWorkflowStatus({id:f.prior.id,status:"testing"});
  const spans=[];
  const hub=new HubMcpService({workspaceCatalog:f.catalog,taskBoard:f.tasks,taskGitWorkspaces:f.workspaces,
    workLog:{threadTurns:async()=>[]},secret:"fixture-secret",attachmentDirectory:f.root,
    reconcilePendingOnStartup:false,recordCommandTrace:s=>spans.push(s),
    releasePlanner:{async plan(){return {ready:[]};}},releaseCompleter:{async completeRelease(){return {};}},
    releasePreflight:{async preflight(){return {};},async prepareAwaitSet(){return {};},
      async withAwaitTransition(_id,operation){return operation();}}});
  const token=hub.contextToken({provider:"codex",threadId:f.manager.id+"-thread"});
  server=new HubMcpServer({service:hub,secret:"fixture-mcp-secret",logger:{log(){},error(){}}});
  await server.start();let sequence=0;
  const call=async(name,args)=>{
    const response=await fetch(server.url,{method:"POST",headers:{"content-type":"application/json"},
      body:JSON.stringify({jsonrpc:"2.0",id:++sequence,method:"tools/call",params:{name,arguments:args}})});
    return response.json();
  };
  const task=f.tasks.task(f.prior.id);
  const args={request_id:"malformed-original",task_id:task.id,status:"await",
    expected_task_revision:task.revision,expected_workflow_status:"testing"};
  const reconcile={context_token:token,request_id:"malformed-reconcile",task_id:task.id,
    operation_request_id:args.request_id,expected_arguments_hash:mcpArgumentsHash(args),project_root:f.source.repositoryRoot,
    expected_task_revision:task.revision,expected_workflow_status:"testing",confirm_reconcile:true};
  const seedLegacy=async()=>{
    const receipt=await f.catalog.beginMcpOperation({requestId:args.request_id,workspaceId:task.workspaceId,
      streamId:f.manager.id,provider:"codex",threadId:f.manager.id+"-thread",toolName:"hub_task_status_update",
      argumentsHash:mcpArgumentsHash(args),taskExecution:hub.taskOperationInterruption.binding(args)});
    // Actual old owner's downstream validation: real lifecycle/store, before
    // any Git preparation or Task transition. Only the disposable original is seeded.
    await assert.rejects(hub.taskOperationInterruption.run(receipt,args,()=>hub.taskLifecycle.updateWorkflowStatus({
      taskId:task.id,status:args.status,operationId:args.request_id,projectRoot:f.source.repositoryRoot,
      expectedRevision:task.revision,expectedWorkflowStatus:"testing",admissionReceipt:receipt})),/Неизвестный статус Task/);
    await f.catalog.markMcpOperationUnknown(args.request_id,new Error("mutation effect is not authoritatively disproved: Неизвестный статус Task"));
    return f.catalog.mcpOperation(args.request_id);
  };
  return {...f,hub,token,call,args,reconcile,task,spans,seedLegacy,onCleanup:fn=>cleanup.push(fn)};
}

test("invalid workflow enum has a terminal failed receipt before the lifecycle owner, not orphan UNKNOWN",async t=>{
  const f=await fixture(t), traceFile=path.join(f.root,"validation-trace.sqlite");
  const store=new CommandTraceWorkerStore({databaseFile:traceFile});f.onCleanup(()=>store.close());await store.initialize();
  const trace=new CommandTraceService({store});const record=f.hub.recordCommandTrace;
  f.hub.recordCommandTrace=s=>{record(s);return trace.recordBestEffort(s);};
  let dispatches=0;const update=f.hub.taskLifecycle.updateWorkflowStatus.bind(f.hub.taskLifecycle);
  f.hub.taskLifecycle.updateWorkflowStatus=(...a)=>{dispatches++;return update(...a);};
  const before=f.tasks.task(f.task.id);
  const response=await f.call("hub_task_status_update",{...f.args,context_token:f.token});
  assert.equal(response.result.isError,false);
  await assert.rejects(f.hub.call("hub_task_status_update",{...f.args,context_token:f.token}),/Неизвестный статус Task/);
  const read=await f.call("hub_task_operation_get",{context_token:f.token,task_id:f.task.id,
    operation_request_id:f.args.request_id,expected_arguments_hash:mcpArgumentsHash(f.args)});
  assert.equal(read.result.structuredContent.taskOperation.status,"failed");
  assert.equal(read.result.structuredContent.taskOperation.terminal,true);
  assert.equal(dispatches,0);
  assert.deepEqual(f.tasks.task(f.task.id),before);
  assert.equal(f.tasks.lifecycleTransition(f.args.request_id),null);
  assert.equal(f.tasks.lifecycleOutcome(f.args.request_id),null);
  await assert.rejects(f.hub.call("hub_task_status_update",{...f.args,context_token:f.token}),/Неизвестный статус Task/);
  assert.equal(dispatches,0);
  await store.close();const reopened=new CommandTraceSpanStore({databaseFile:traceFile});f.onCleanup(()=>reopened.close());
  const saved=await reopened.readCommandTimeline(f.args.request_id);
  assert.ok(saved.some(s=>s.stage==="task-workflow-input-validation"&&s.outcome==="failed"));
  assert.ok(saved.every(s=>!JSON.stringify(s).includes(f.token)));
});

test("same legacy malformed original settles through the existing RM owner and preserves args, Task and lifecycle history",async t=>{
  const f=await fixture(t),before=await f.seedLegacy(), task=f.tasks.task(f.task.id);let result;
  const traceFile=path.join(f.root,"settlement-trace.sqlite"),store=new CommandTraceWorkerStore({databaseFile:traceFile});
  f.onCleanup(()=>store.close());await store.initialize();const trace=new CommandTraceService({store});
  const record=f.hub.recordCommandTrace;f.hub.recordCommandTrace=s=>{record(s);return trace.recordBestEffort(s);};
  await assert.doesNotReject(async()=>{result=await f.hub.call("hub_task_operation_reconcile",f.reconcile);});
  assert.equal(result.resolved,true);
  assert.equal(result.outcome,"failed");
  assert.equal(result.reconciliation.durableState,"workflow_input_validation");
  assert.notEqual(result.reconciliation.outcome,"NO_EFFECT");
  const after=f.catalog.mcpOperation(f.args.request_id);
  assert.equal(after.status,"failed");assert.equal(after.argumentsHash,before.argumentsHash);
  assert.deepEqual(after.taskExecution,before.taskExecution);
  assert.deepEqual(f.tasks.task(f.task.id),task);
  assert.equal(f.tasks.lifecycleTransition(f.args.request_id),null);
  assert.equal(f.tasks.lifecycleOutcome(f.args.request_id),null);
  assert.deepEqual(await f.hub.call("hub_task_operation_reconcile",f.reconcile),result);
  await assert.rejects(f.hub.call("hub_task_status_update",{...f.args,context_token:f.token}),/Неизвестный статус Task/);
  assert.equal(f.prepares(),0);
  assert.ok(f.spans.some(s=>s.commandId===f.args.request_id&&s.stage==="task-workflow-invalid-settlement"&&s.outcome==="failed"));
  await store.close();const reopened=new CommandTraceSpanStore({databaseFile:traceFile});f.onCleanup(()=>reopened.close());
  const saved=await reopened.readCommandTimeline(f.args.request_id);
  for(const stage of ["task-workflow-invalid-validation","task-workflow-invalid-lock-wait","task-workflow-invalid-retirement","task-workflow-invalid-settlement"]){
    assert.ok(saved.some(s=>s.stage===stage&&s.monotonicDurationMs>=0),stage);
  }
});

test("malformed reconciliation refuses foreign actor, changed hash/CAS and a present process guard",async t=>{
  const f=await fixture(t), before=await f.seedLegacy();
  const foreign=f.hub.contextToken({provider:"codex",threadId:f.successor.id+"-thread"});
  const variants=[
    {context_token:foreign},
    {expected_arguments_hash:"f".repeat(64)},
    {expected_task_revision:f.task.revision+1},
    {expected_workflow_status:"in_progress"},
    {project_root:path.join(f.root,"foreign")},
  ];
  for(const [i,changed]of variants.entries()){
    await assert.rejects(f.hub.call("hub_task_operation_reconcile",{...f.reconcile,...changed,request_id:"refusal-"+i}));
    assert.deepEqual(f.catalog.mcpOperation(f.args.request_id),before);
  }
  const guard=f.workspaces.assertNoProcessTreeGuardOwned.bind(f.workspaces);
  f.workspaces.assertNoProcessTreeGuardOwned=async()=>{throw new Error("actual guard still pending");};
  await assert.rejects(f.hub.call("hub_task_operation_reconcile",{...f.reconcile,request_id:"guard-refusal"}),/guard/);
  f.workspaces.assertNoProcessTreeGuardOwned=guard;
  assert.deepEqual(f.catalog.mcpOperation(f.args.request_id),before);
});

test("a validation-looking exception after a valid owner effect stays UNKNOWN and cannot gain malformed authority",async t=>{
  const f=await fixture(t);
  f.hub.taskLifecycle.updateWorkflowStatus=async()=>{await f.tasks.update({id:f.task.id,title:f.task.title,description:"actual synthetic effect"});
    throw Object.assign(new Error("Неизвестный статус Task"),{name:"TaskInputValidationError"});};
  const args={...f.args,status:"blocked"};
  await assert.rejects(f.hub.call("hub_task_status_update",{...args,context_token:f.token}),/Неизвестный/);
  const before=f.catalog.mcpOperation(args.request_id);assert.equal(before.status,"unknown");
  await assert.rejects(f.hub.call("hub_task_operation_reconcile",{...f.reconcile,expected_arguments_hash:mcpArgumentsHash(args)}));
  assert.deepEqual(f.catalog.mcpOperation(args.request_id),before);
  assert.equal(f.tasks.task(f.task.id).description,"actual synthetic effect");
});

test("malformed settlement rechecks Task CAS at the receipt transaction",async t=>{
  const f=await fixture(t),before=await f.seedLegacy();
  const fail=f.rawCatalog.failUnknownMcpOperation.bind(f.rawCatalog);
  f.rawCatalog.failUnknownMcpOperation=(...a)=>{f.rawTasks.setWorkflowStatus(f.task.id,"blocked");return fail(...a);};
  await assert.rejects(f.hub.call("hub_task_operation_reconcile",f.reconcile));
  assert.deepEqual(f.catalog.mcpOperation(f.args.request_id),before);
  assert.equal(f.tasks.task(f.task.id).workflowStatus,"blocked");
});

test("a genuinely undrained local execution refuses until its original invocation joins",async t=>{
  const f=await fixture(t),before=await f.seedLegacy();let release,entered;
  const held=new Promise(r=>{release=r;}),started=new Promise(r=>{entered=r;});
  const run=f.hub.taskOperationInterruption.run(before,f.args,async()=>{entered();await held;});
  await started;
  try {
    await assert.rejects(f.hub.call("hub_task_operation_reconcile",f.reconcile),/drained/);
    assert.deepEqual(f.catalog.mcpOperation(f.args.request_id),before);
  } finally {release();await run;}
  const result=await f.hub.call("hub_task_operation_reconcile",{...f.reconcile,request_id:"after-actual-join"});
  assert.equal(result.outcome,"failed");assert.equal(f.prepares(),0);
});

test("foreign execution requires the existing native retirement port and retained witness, not an operator boolean",async t=>{
  const f=await fixture(t),before=await f.seedLegacy();let retired=false,captures=0;
  const witness={sourcePath:"controlled-retained-witness",rawSha256:"a".repeat(64)};
  const runtime={requiresRetainedWitness:true,
    async capture({original,witness:observed}){assert.equal(original.requestId,f.args.request_id);assert.deepEqual(observed,witness);captures++;return {captured:true};},
    async assertRetired(cohort){assert.equal(cohort.captured,true);if(!retired)throw new Error("native cohort still alive");return {retired:true,kind:"controlled-native-retirement-port"};}};
  f.hub.taskOperationReconciliation.taskExecution=new TaskOperationInterruption({catalog:f.catalog,tasks:f.tasks,taskGit:f.workspaces,runtime});
  await assert.rejects(f.hub.call("hub_task_operation_reconcile",f.reconcile),/witness/);
  assert.equal(captures,0);
  await assert.rejects(f.hub.call("hub_task_operation_reconcile",{...f.reconcile,request_id:"live-foreign",runtime_witness:witness}),/still alive/);
  assert.deepEqual(f.catalog.mcpOperation(f.args.request_id),before);
  retired=true;
  const result=await f.hub.call("hub_task_operation_reconcile",{...f.reconcile,request_id:"retired-foreign",runtime_witness:witness});
  assert.equal(result.outcome,"failed");assert.equal(captures,2);
});

test("receipt persistence failure keeps the malformed original UNKNOWN with unchanged execution/history",async t=>{
  const f=await fixture(t),before=await f.seedLegacy();
  f.rawCatalog.failUnknownMcpOperation=()=>{throw new Error("controlled receipt persistence failure");};
  await assert.rejects(f.hub.call("hub_task_operation_reconcile",f.reconcile),/persistence failure/);
  assert.deepEqual(f.catalog.mcpOperation(f.args.request_id),before);
  assert.equal(f.tasks.lifecycleTransition(f.args.request_id),null);
  assert.equal(f.tasks.lifecycleOutcome(f.args.request_id),null);
  assert.deepEqual(f.tasks.task(f.task.id),f.task);
});

test("lost reconciliation reply leaves the original authoritative failed receipt readable without replay",async t=>{
  const f=await fixture(t),before=await f.seedLegacy();
  const complete=f.rawCatalog.completeMcpOperation.bind(f.rawCatalog);
  f.rawCatalog.completeMcpOperation=(id,...a)=>{if(id===f.reconcile.request_id)throw new Error("lost reconciliation terminal reply");return complete(id,...a);};
  await assert.rejects(f.hub.call("hub_task_operation_reconcile",f.reconcile),/reconciliation is required/);
  const read=await f.call("hub_task_operation_get",{context_token:f.token,task_id:f.task.id,
    operation_request_id:f.args.request_id,expected_arguments_hash:before.argumentsHash});
  assert.equal(read.result.structuredContent.taskOperation.status,"failed");
  assert.deepEqual(f.catalog.mcpOperation(f.args.request_id).taskExecution,before.taskExecution);
  assert.deepEqual(f.tasks.task(f.task.id),f.task);assert.equal(f.prepares(),0);
});

test("actual local reconciliation CLI reaches the RM malformed owner and refuses missing foreign-runtime witness",async t=>{
  const f=await fixture(t,{databaseName:"journal.sqlite"}),before=await f.seedLegacy();
  const configFile=path.join(f.root,"config.json"),argumentsFile=path.join(f.root,"reconcile.json");
  await writeFile(configFile,JSON.stringify({components:{},dataDir:f.root,projectRoot:f.source.repositoryRoot}));
  const args={...f.reconcile,request_id:"actual-cli-malformed"};delete args.context_token;
  await writeFile(argumentsFile,JSON.stringify(args));
  const env=Object.fromEntries(["PATH","Path","SystemRoot","WINDIR","TEMP","TMP","USERPROFILE","USERNAME","USERDOMAIN"]
    .filter(k=>process.env[k]!=null).map(k=>[k,process.env[k]]));
  env.AGENT_HUB_CONFIG=configFile;
  await assert.rejects(promisify(execFile)(process.execPath,[path.resolve("task-operation-reconcile.mjs"),
    "--reconcile-arguments",argumentsFile,"--provider","codex","--thread",f.manager.id+"-thread","--stream",f.manager.id],
    {env,windowsHide:true}),error=>{assert.match(error.stderr,/exact native retirement witness/);return true;});
  assert.deepEqual(f.catalog.mcpOperation(f.args.request_id),before);
  assert.equal(f.catalog.mcpOperation(args.request_id).status,"failed");
  assert.deepEqual(f.tasks.task(f.task.id),f.task);
});

test("an unknown execution extension cannot inherit ordinary malformed-input authority",async t=>{
  const f=await fixture(t);
  await f.catalog.beginMcpOperation({requestId:f.args.request_id,workspaceId:f.task.workspaceId,
    streamId:f.manager.id,provider:"codex",threadId:f.manager.id+"-thread",toolName:"hub_task_status_update",
    argumentsHash:mcpArgumentsHash(f.args),taskExecution:{...f.hub.taskOperationInterruption.binding(f.args),unclassifiedEffect:{observed:true}}});
  await f.catalog.markMcpOperationUnknown(f.args.request_id,new Error("Неизвестный статус Task"));
  const before=f.catalog.mcpOperation(f.args.request_id);
  await assert.rejects(f.hub.call("hub_task_operation_reconcile",f.reconcile));
  assert.deepEqual(f.catalog.mcpOperation(f.args.request_id),before);
  assert.deepEqual(f.tasks.task(f.task.id),f.task);assert.equal(f.prepares(),0);
});
