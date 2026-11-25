import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {promisify} from 'node:util';
import test from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {releaseIdentitySha256} from '../../src/domain/legacy-task-publication-proof.mjs';
import {runtimeDatabasePath} from '../../src/infrastructure/persistence/runtime-state-store.mjs';
import {openTaskAwaitCutoverRuntime} from '../../task-await-cutover.mjs';
import {WorkspaceCatalogStore} from '../../src/infrastructure/persistence/workspace-catalog-store.mjs';
import {TaskBoardStore} from '../../src/infrastructure/persistence/task-board-store.mjs';
import {effectiveWorkspaceDeveloperRules,effectiveStreamDeveloperRules} from '../../src/domain/workspace-task-workflow.mjs';
const execute=promisify(execFile);
async function git(root,...args){return (await execute('git',args,{cwd:root,windowsHide:true})).stdout.trim();}

test('Manual process instructions retain authored content without a release mechanism',()=>{
 const authored='authored rules remain byte exact';
 assert.ok(effectiveWorkspaceDeveloperRules(authored,{releaseWorkflowEnabled:true}).endsWith(authored));
 assert.ok(effectiveStreamDeveloperRules(authored,{releaseManager:true}).endsWith(authored));
 assert.match(effectiveWorkspaceDeveloperRules(authored,{autoReviewEnabled:true}),/independent review/u);
});

test('Tasks keep CRUD, checklist, managed claim, native Test and Await without a release owner',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'tasks-without-release-'));
 const primary=path.join(root,'primary'),dataDir=path.join(root,'data');
 await mkdir(primary);await mkdir(dataDir);
 const previous={LOCALAPPDATA:process.env.LOCALAPPDATA,XDG_STATE_HOME:process.env.XDG_STATE_HOME};
 process.env.LOCALAPPDATA=path.join(root,'state');process.env.XDG_STATE_HOME=process.env.LOCALAPPDATA;
 let runtime,catalog,store;
 t.after(async()=>{await runtime?.close();store?.close();catalog?.close();
  for(const [k,v] of Object.entries(previous)){if(v===undefined)delete process.env[k];else process.env[k]=v;}
  await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:50});});
 await git(primary,'init','--initial-branch=main');
 await writeFile(path.join(primary,'base.txt'),'base\n');await git(primary,'add','.');
 await git(primary,'-c','user.name=Fixture','-c','user.email=fixture@local.invalid','commit','-m','base');
 const base=await git(primary,'rev-parse','HEAD');
 await git(root,'init','--bare','--initial-branch=main',path.join(root,'origin.git'));
 await git(primary,'remote','add','origin',path.join(root,'origin.git'));await git(primary,'push','origin','main');
 await mkdir(path.join(process.env.LOCALAPPDATA,'AgentHub'),{recursive:true});
 await writeFile(path.join(process.env.LOCALAPPDATA,'AgentHub/publication-state.json'),JSON.stringify({generation:'fixture',repositories:[{root:primary,revision:base}]}));
 const databaseFile=path.join(dataDir,'journal.sqlite');
 catalog=new WorkspaceCatalogStore({databaseFile});await catalog.load();store=new TaskBoardStore({databaseFile});
 const workspace=catalog.createWorkspace({name:'Task fixture',settings:{workingDirectory:primary,releaseWorkflowEnabled:true}});
 const stream=catalog.createStream({workspaceId:workspace.id,name:'Task acceptance',settings:{workingDirectory:primary,releaseManager:true}});
 catalog.bindThread({provider:'codex',threadId:'fixture',streamId:stream.id});
 runtime=await openTaskAwaitCutoverRuntime({config:{dataDir,taskBoard:{autoPlaceConfidence:0.8}}});
 const {service,taskBoard}=runtime;
 service.setActiveRuns(()=>[{id:'fixture-run',provider:'codex',threadId:'fixture',turnId:'fixture-turn',streamId:stream.id,status:'running',projectRoot:primary}]);
 const token=service.contextToken({provider:'codex',threadId:'fixture',streamId:stream.id});
 const call=(name,args)=>service.call(name,{context_token:token,...args});
 assert.equal(service.tools().some(tool=>tool.name.startsWith('hub_release_')),false);
 assert.equal(Object.hasOwn(service,'releaseOperations'),false);
 await assert.rejects(call('hub_release_run',{request_id:'removed-release'}),/unknown|unsupported/iu);
 const created=await call('hub_task_create',{request_id:'create',title:'Task result',description:'retained user requirements'});
 assert.deepEqual(await call('hub_task_create',{request_id:'create',title:'Task result',description:'retained user requirements'}),JSON.parse(JSON.stringify(created)));
 await call('hub_task_update',{request_id:'edit',task_id:created.id,title:'Task result edited'});
 let current=taskBoard.task(created.id);
 await call('hub_task_checklist_update',{request_id:'checklist',task_id:created.id,expected_task_revision:current.revision,operation:'add',text:'retained item'});
 const claimed=await call('hub_task_claim',{request_id:'claim',task_id:created.id,dependency_mode:'skip'});
 const managed=claimed.gitWorkspace.projectRoot;
 await writeFile(path.join(managed,'task.txt'),'own task result\n');await git(managed,'add','.');
 await git(managed,'-c','user.name=Fixture','-c','user.email=fixture@local.invalid','commit','-m','task result');
 const result=await git(managed,'rev-parse','HEAD');
 current=taskBoard.task(created.id);
 await call('hub_task_status_update',{request_id:'test',task_id:created.id,status:'testing',expected_task_revision:current.revision,expected_workflow_status:current.workflowStatus});
 current=taskBoard.task(created.id);assert.equal(current.gitReferences[0].resultCommit,result);
 assert.equal(await git(primary,'show','dev:task.txt'),'own task result');
 await call('hub_task_status_update',{request_id:'await',task_id:created.id,status:'awaiting_implementation',expected_task_revision:current.revision,expected_workflow_status:'testing'});
 const accepted=taskBoard.task(created.id);assert.equal(accepted.workflowStatus,'awaiting_implementation');
 assert.equal(accepted.checklist[0].text,'retained item');assert.match(accepted.description,/retained user requirements/u);
 const candidate=await service.releasePreflight.releaseGitWorkspaces.frozenCandidate(primary);
 assert.equal(candidate.manifest.tasks[0].resultCommit,result);
 assert.equal(await readFile(path.join(candidate.releaseRoot,'task.txt'),'utf8'),'own task result\n');
 const serviceCard=await call('hub_task_create',{request_id:'create-service',title:'Stopped release'});
 const checklist=await call('hub_task_checklist_update',{request_id:'add-service-item',task_id:serviceCard.id,
  expected_task_revision:serviceCard.revision,operation:'add',text:'Retained original selection'});
 await call('hub_task_checklist_update',{request_id:'link-service-item',task_id:serviceCard.id,
  expected_task_revision:checklist.task.revision,operation:'link',item_id:checklist.itemId,
  linked_task_id:accepted.id,release_reference:{taskRevision:accepted.revision,gitReferences:accepted.gitReferences}});
 const originalTask=taskBoard.task(serviceCard.id);
 const args={task_id:serviceCard.id,completion_mode:'abandoned_release_service',
  abandoned_release:{operationId:'original-failed',expectedRevision:4,expectedGeneration:1}};
 await assert.rejects(call('hub_task_complete',{...args,request_id:'absent-history'}),/history is absent/u);
 const facts=new DatabaseSync(runtimeDatabasePath(dataDir));
 t.after(()=>{if(facts.isOpen)facts.close();});
 facts.exec(`CREATE TABLE release_operations (operation_id TEXT PRIMARY KEY, workspace_id TEXT, state TEXT, operation_json TEXT);
  CREATE TABLE release_candidate_generations (operation_id TEXT, generation INTEGER, generation_json TEXT, identity_sha256 TEXT)`);
 const selectedResults=[{taskId:accepted.id,resultCommit:result}];
 const authorization={taskIds:[accepted.id]};
 const failed={operationId:'original-failed',workspaceId:workspace.id,streamId:stream.id,
  revision:4,currentGeneration:1,state:'failed',owner:null,completedAt:'2026-10-01T00:00:00Z',
  lastError:'original failure',selectedResults,authorization:{...authorization,fingerprint:releaseIdentitySha256(authorization)}};
 const generation={operationId:failed.operationId,generation:1,selectedResults,candidates:[{repositoryRoot:primary}]};
 const identity=releaseIdentitySha256(generation);
 const operationJson=JSON.stringify(failed), generationJson=JSON.stringify({...generation,identitySha256:identity});
 facts.prepare('INSERT INTO release_operations VALUES (?,?,?,?)').run(failed.operationId,workspace.id,failed.state,operationJson);
 facts.prepare('INSERT INTO release_candidate_generations VALUES (?,?,?,?)').run(failed.operationId,1,generationJson,identity);
 await assert.rejects(call('hub_task_complete',{...args,request_id:'stale-archive',
  abandoned_release:{...args.abandoned_release,expectedRevision:3}}),/exact idle FAILED/u);
 facts.prepare('UPDATE release_candidate_generations SET identity_sha256=?').run('f'.repeat(64));
 await assert.rejects(call('hub_task_complete',{...args,request_id:'changed-generation'}),/immutable generation changed/u);
 facts.prepare('UPDATE release_candidate_generations SET identity_sha256=?').run(identity);
 const archivePreview=await call('hub_task_complete',{...args,request_id:'archive-preview'});
 assert.equal(archivePreview.confirmationRequired,true);
 assert.equal(archivePreview.preview.releaseService.actor.streamId,stream.id);
 assert.equal(archivePreview.preview.releaseService.source.streamId,null);
 assert.equal(archivePreview.preview.releaseService.original.effectsDisposition,'retained_without_settlement');
 assert.deepEqual(archivePreview.preview.deleting,[]);
 assert.equal(taskBoard.task(serviceCard.id).status,originalTask.status);
 const archived=await call('hub_task_complete',{...args,request_id:'archive-confirm',confirm_cleanup:true,
  expected_cleanup_token:archivePreview.cleanupToken});
 assert.equal(archived.status,'done');
 assert.equal(archived.workflowStatus,originalTask.workflowStatus);
 assert.deepEqual(taskBoard.task(serviceCard.id).checklist,originalTask.checklist);
 assert.deepEqual(taskBoard.task(accepted.id),accepted);
 assert.equal(facts.prepare('SELECT operation_json FROM release_operations').get().operation_json,operationJson);
 assert.equal(facts.prepare('SELECT generation_json FROM release_candidate_generations').get().generation_json,generationJson);
 facts.close();
 assert.equal(await git(primary,'rev-parse','HEAD'),base);
 assert.equal(await git(primary,'status','--porcelain=v1','--untracked-files=all'),'');
});
