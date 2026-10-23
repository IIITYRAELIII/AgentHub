import assert from "node:assert/strict";
import test from "node:test";
import {mkdtemp,rm} from "node:fs/promises";
import os from "node:os";import path from "node:path";
import {launchReplacementAndWait,waitForReplacementLock} from "../../src/runtime/runtime-restart.mjs";
import {createDesktopRunRouterWiring} from "../../src/composition/desktop-run-router-wiring-composition.mjs";
import {restartWaitFailed} from "../../assets/web-app/startup-screen-model.js";

test("one owned slow launcher survives more than the former 15-second window",async()=>{
 let now=0,launches=0;const stages=[];
 const result=await launchReplacementAndWait({invocation:{command:"owned",args:[],options:{}},
 lockFile:"fixture",currentPid:1,expectedReleaseId:"repair",expectedOperationId:"restart-exact",now:()=>now,
 spawnImpl:()=>{launches++;return {pid:2,once(){},unref(){}};},
 delayImpl:async()=>{now+=10000;},isAlive:()=>true,
 measure:async(stage,action)=>{stages.push(stage);return action();},
 readFileImpl:async()=>now<20000?"":JSON.stringify({pid:3,instanceToken:"new",releaseId:"repair",restartOperationId:"restart-exact",ready:now>=30000})});
 assert.equal(launches,1);assert.equal(result.lock.pid,3);assert.equal(now,30000);
 assert.deepEqual(stages,["launcher-to-lock","lock-to-ready"]);
});
test("ownership confirmation rejects another release and another restart operation",async()=>{
 let now=0;const locks=[{releaseId:"old",restartOperationId:"r"},{releaseId:"repair",restartOperationId:"other"},{releaseId:"repair",restartOperationId:"r"}];
 const lock=await waitForReplacementLock({lockFile:"fixture",currentPid:1,expectedReleaseId:"repair",expectedOperationId:"r",now:()=>now,timeoutMs:10,
 readFileImpl:async()=>JSON.stringify({pid:3,instanceToken:"new",ready:true,...locks.shift()}),isAlive:()=>true,delayImpl:async()=>{now++;}});
 assert.equal(now,2);assert.equal(lock.restartOperationId,"r");
});
test("real factory permits pending restart and fences ordinary and deferred admission only at cutover",async t=>{
 const directory=await mkdtemp(path.join(os.tmpdir(),"hub-restart-factory-"));t.after(()=>rm(directory,{recursive:true,force:true}));
 const noop=()=>{};const port=new Proxy(noop,{get:()=>port});let stopping=false;
 const services=new Proxy({attachmentDirectory:directory,isRestartPending:()=>true,isRuntimeStopping:()=>stopping,composerTransfers:port,taskBoard:port,workspaceCatalog:port,taskRuns:port,providers:port},{get:(o,k)=>k in o?o[k]:port});
 const result=createDesktopRunRouterWiring({config:{dataDir:directory},constants:{taskExecutionOwners:{HUB:"hub"}},state:port,services,desktop:port});
 assert.equal(result.runCoordinator.admissionBarrier({}),null);
 stopping=true;assert.equal(result.runCoordinator.admissionBarrier({}),"runtime-restart");
 await assert.rejects(result.runCoordinator.startDeferred({provider:"codex",threadId:"t",streamId:"s",input:"input"}),e=>e.code==="ERR_RUNTIME_RESTART_PENDING");
 stopping=false;assert.equal(result.runCoordinator.admissionBarrier({}),null);
});
test("a terminal restart failure releases only its current overlay wait",()=>{
 const health={ready:true,diagnostics:{restart:{operationId:"r",status:"failed",completedAt:new Date(3000).toISOString()}}};
 assert.equal(restartWaitFailed(health,2000),true);
 assert.equal(restartWaitFailed(health,4000),false);
 assert.equal(restartWaitFailed({ready:true},2000),false);
 assert.equal(restartWaitFailed({diagnostics:{restart:{status:"running"}}},2000),false);
});
