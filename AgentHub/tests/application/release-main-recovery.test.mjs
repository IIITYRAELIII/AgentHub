import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { runtimeDatabasePath } from "../../src/infrastructure/persistence/runtime-state-store.mjs";
import { ReleaseOperationService } from "../../src/application/release-operation-service.mjs";
import { ReleaseOperationStore } from "../../src/infrastructure/persistence/release-operation-store.mjs";
import { releaseIdentitySha256 } from "../../src/domain/release-operation.mjs";

const oldMain="1".repeat(40), currentMain="7".repeat(40), result="2".repeat(40);
const repositories=[{projectRoot:path.resolve("reviewed-repository"),approvedLocalMainCommit:currentMain,approvedOriginMainCommit:currentMain}];
async function fixture(t, status="not_applied") {
  const root=await mkdtemp(path.join(os.tmpdir(),"reviewed-main-"));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const store=new ReleaseOperationStore({dataDir:root,idFactory:()=>"original"});
  const target={targetId:"product",kind:"agent-hub-publication",repositoryRoot:repositories[0].projectRoot,approvedLocalMainCommit:oldMain,approvedOriginMainCommit:oldMain};
  const created=store.create({requestId:"original-go",workspaceId:"workspace",streamId:"stream",threadId:"thread",runnerVersion:"original-runner",authorization:{taskIds:["selected"],approvedTargets:[target],validationMode:"full"}}).operation;
  const first=store.putGeneration({operationId:created.operationId,generation:1,runnerVersion:"original-runner",repositoryBases:[{repositoryRoot:target.repositoryRoot,baseCommit:oldMain}],selectedResults:[{taskId:"selected",resultCommit:result,acceptanceRevision:2}],candidates:[{repositoryRoot:target.repositoryRoot,releaseRoot:root,commit:result,tree:result,manifestHash:"a".repeat(64)}],sourceFingerprint:"old"}).generation;
  store.transition(created.operationId,{state:"validate",currentGeneration:1});
  store.transition(created.operationId,{state:"publish",publicationEffects:{generation:1,publishStarted:{generation:1,candidate:first.identitySha256}}});
  const publication=store.beginStep({operationId:created.operationId,generation:1,stepId:"publish:product",input:{candidate:first.identitySha256}}).receipt;
  store.finishStep(publication,{status:"failed",effect:{status:"not_applied"},error:"validation failed before publication"});
  store.transition(created.operationId,{state:"compose"});
  const composition=store.beginStep({operationId:created.operationId,generation:2,stepId:"compose",input:{authorization:created.authorization,priorGeneration:1}}).receipt;
  store.finishStep(composition,{status:"failed",error:"explicit reviewed-main approval is stale for "+target.repositoryRoot});
  const current=store.transition(created.operationId,{state:"failed",lastError:{message:"explicit reviewed-main approval is stale for "+target.repositoryRoot,step:"compose"}}).operation;
  const calls=[],scheduled=[];
  const selection=[{taskId:"selected",resultCommit:result,acceptanceRevision:3}];
  const authority={approvedRepositories:repositories,planRevision:"current-plan",selectedResults:selection,preparedCandidates:[{repositoryRoot:target.repositoryRoot,commit:result,manifestHash:"b".repeat(64)}]};
  const service=new ReleaseOperationService({store,processAlive:()=>false,schedule:cb=>scheduled.push(cb),
    compose:async({operation})=>{calls.push(["compose",operation.reviewedMain]);return {repositoryBases:[{repositoryRoot:target.repositoryRoot,baseCommit:currentMain}],selectedResults:selection,candidates:first.candidates,sourceFingerprint:"current"};},
    validate:async()=>({status:"passed"}),publishTarget:async()=>{calls.push(["publish"]);return {status:"applied"};},
    readTarget:async(input)=>{calls.push(["readback",input.reviewedMain]);return {status};},finalize:async()=>({status:"completed"}),
    withReviewedMainRecovery:async({commit})=>{calls.push(["verify"]);return commit(authority,async()=>{calls.push(["recheck"]);});},
  });
  return {store,service,calls,scheduled,current,authority,first,root};
}

test("original failed stale-main release accepts a separately verified binding without changing historical authorization",async t=>{
  const f=await fixture(t),before=f.store.snapshot("original");
  const r=await f.service.continue("original",{requestId:"same-original-rebind",reviewedMain:{expectedRevision:f.current.revision,approvedRepositories:repositories}});
  assert.equal(r.accepted,true);
  const after=f.store.snapshot("original");
  assert.equal(after.operation.operationId,before.operation.operationId);
  assert.equal(after.operation.requestId,"original-go");
  assert.equal(after.operation.state,"compose");
  assert.deepEqual(after.operation.authorization,before.operation.authorization);
  assert.deepEqual(after.generations,before.generations);
  assert.deepEqual(after.receipts,before.receipts);
  assert.equal(after.operation.reviewedMain.priorRevision,f.current.revision);
  assert.equal(after.operation.reviewedMain.priorFailure.completedAt,f.current.completedAt);
  assert.equal(after.operation.reviewedMain.authorizationFingerprint,before.operation.authorization.fingerprint);
  assert.equal(after.operation.reviewedMain.approvedRepositories[0].approvedLocalMainCommit,currentMain);
  assert.equal(after.operation.reviewedMain.identitySha256,releaseIdentitySha256(Object.fromEntries(Object.entries(after.operation.reviewedMain).filter(([k])=>k!=="identitySha256"))));
  assert.equal(f.scheduled.length,1);
  assert.deepEqual(f.calls.map(x=>x[0]),["verify","readback","recheck"]);
  assert.equal(f.store.generation("original",2),null,"rebind itself does not compose/build or publish");
  const repeat=await f.service.continue("original",{requestId:"same-original-rebind",reviewedMain:{expectedRevision:f.current.revision,approvedRepositories:repositories}});
  assert.equal(repeat.accepted,false);assert.equal(f.scheduled.length,1,"stale CAS does not duplicate scheduling");
  f.scheduled.shift()();
  await f.service.drain("original");
  const completed=f.store.snapshot("original");
  assert.equal(completed.operation.state,"done");
  assert.deepEqual(completed.operation.authorization,before.operation.authorization);
  assert.equal(completed.operation.reviewedMain.priorGeneration,1);
  assert.equal(completed.generations.length,2);
  assert.equal(f.store.latestStep("original",2,"compose").attempt,2);
  assert.deepEqual(completed.receipts.filter(r=>r.generation===1),before.receipts.filter(r=>r.generation===1));
});

for (const conflict of ["next-generation", "pending-compose", "pending-publication", "source-owner"]) {
  test(`recovery transaction refuses ${conflict} without changing original operation`, async t => {
    const f=await fixture(t);
    if(conflict==="next-generation") f.store.putGeneration({...f.first,generation:2,createdAt:new Date().toISOString()});
    if(conflict==="pending-compose") f.store.beginStep({operationId:"original",generation:2,stepId:"compose",input:{other:true}});
    if(conflict==="pending-publication") f.store.beginStep({operationId:"original",generation:1,stepId:"publish:product",input:{other:true}});
    if(conflict==="source-owner") {
      const db=new DatabaseSync(runtimeDatabasePath(f.root));
      try {
        const row=db.prepare("SELECT operation_json FROM release_operations WHERE operation_id='original'").get();
        const raw=JSON.parse(row.operation_json);raw.nativeOwnerRecovery={kind:"native-owner"};
        db.prepare("UPDATE release_operations SET operation_json=? WHERE operation_id='original'").run(JSON.stringify(raw));
      }finally{db.close();}
    }
    const before=f.store.snapshot("original");
    await assert.rejects(()=>f.service.continue("original",{requestId:"refuse-conflict",reviewedMain:{expectedRevision:f.current.revision,approvedRepositories:repositories}}),/generation|receipt|not-applied|source-owner/u);
    assert.deepEqual(f.store.snapshot("original"),before);assert.equal(f.scheduled.length,0);
  });
}

test("exact operation CAS is repeated after awaited original readback", async t=>{
  const f=await fixture(t);
  let first=true;
  const owner=f.service.withReviewedMainRecovery;
  f.service.withReviewedMainRecovery=async input=>owner({...input,commit:async(authority,validate)=>{
    if(first){first=false;await input.commit(authority,validate);}
    return input.commit(authority,validate);
  }});
  const result=await f.service.continue("original",{requestId:"one-recovery",reviewedMain:{expectedRevision:f.current.revision,approvedRepositories:repositories}});
  assert.equal(result.accepted,false);assert.equal(result.reason,"stale-revision");assert.equal(f.scheduled.length,1);
});

for(const status of ["unknown","partial","applied"]){
  test(`original ${status} effect refuses main rebind and preserves every receipt`,async t=>{
    const f=await fixture(t,status),before=f.store.snapshot("original");
    await assert.rejects(async()=>f.service.continue("original",{requestId:"refuse",reviewedMain:{expectedRevision:f.current.revision,approvedRepositories:repositories}}),/effect|readback|applied/u);
    assert.deepEqual(f.store.snapshot("original"),before);assert.equal(f.scheduled.length,0);
  });
}

test("typed binding and exact revision fail before approval inspection or state change",async t=>{
  const f=await fixture(t),before=f.store.snapshot("original");
  for(const bad of [{expectedRevision:f.current.revision,approvedRepositories:[{...repositories[0],approvedLocalMainCommit:[currentMain]}]},{expectedRevision:f.current.revision,approvedRepositories:[{...repositories[0],projectRoot:"foreign"}]}]){
    await assert.rejects(async()=>f.service.continue("original",{requestId:"invalid",reviewedMain:bad}),/binding|repository|commit|primitive/u);
  }
  const stale=await f.service.continue("original",{requestId:"stale",reviewedMain:{expectedRevision:f.current.revision-1,approvedRepositories:repositories}});
  assert.equal(stale.accepted,false);assert.deepEqual(f.calls,[]);assert.deepEqual(f.store.snapshot("original"),before);
  assert.equal(f.service.continue("original").reason,"terminal","ordinary continue cannot revive a terminal operation");
});
