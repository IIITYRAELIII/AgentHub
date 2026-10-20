import assert from 'node:assert/strict'; import test from 'node:test';
import {readFile,mkdtemp,rm} from 'node:fs/promises'; import vm from 'node:vm'; import os from 'node:os'; import path from 'node:path';
import {MessageCommandLedgerStore} from '../../src/infrastructure/persistence/message-command-ledger-store.mjs';
import {messageCommandFixture} from '../fixtures/message-command-ledger.mjs';
const context=vm.createContext({});context.window=context;
for(const name of ['disclosure','lifecycle','projection'])vm.runInContext(await readFile(new URL(`../../assets/web-app/messages/${name}.js`,import.meta.url),'utf8'),context);
const project=context.AgentHubMessageLifecycle.queueHistoryReceiptProjection;
test('durable failed overrides stale accepted before and after reload without replay',async t=>{
 const dataDir=await mkdtemp(path.join(os.tmpdir(),'hub-terminal-visible-'));let store=new MessageCommandLedgerStore({dataDir});
 t.after(async()=>{store.close();await rm(dataDir,{recursive:true,force:true});});
 const fixture=messageCommandFixture({receipt:{result:{accepted:true,providerAccepted:true,turnId:'t',runId:'r',deliveredAt:'2026-08-24T06:00:01Z',displayText:'original'}}});
 store.accept({...fixture,destination:'queued'});store.transition({clientUserMessageId:fixture.item.clientUserMessageId,expectedStates:['queued'],state:'started',result:fixture.receipt.result});
 assert.equal(project(store.projectReceipt(fixture.receipt).result).deliveryState,'running');
 store.transition({clientUserMessageId:fixture.item.clientUserMessageId,state:'failed',authoritativeTerminal:true,result:{accepted:true,failed:true,terminalRevision:1,turnId:'t'}});
 for(let pass=0;pass<2;pass++){
  const receipt=store.projectReceipt(fixture.receipt),view=project(receipt.result);
  assert.equal(view.deliveryState,'failed');assert.equal(view.projectionState,'failed');assert.equal(view.ownsDeferredQueue,false);assert.equal(view.failed,true);
  assert.match(view.delivery,/Ошибка Codex/);assert.ok(receipt.result.completedAt);assert.equal(receipt.result.turnId,'t');
  assert.equal(store.get(fixture.item.clientUserMessageId).state,'failed');if(!pass){store.close();store=new MessageCommandLedgerStore({dataDir});}
 }
});
test('structured retry and terminal override acceptance; delayed active cannot regress terminal',()=>{
 const accepted={accepted:true,providerAccepted:true,turnId:'t',runId:'r',startedAt:'2026-10-15T20:00:00Z'};
 assert.equal(project(accepted).deliveryState,'running');
 assert.equal(project({...accepted,providerConnection:{state:'retrying',sinceAt:accepted.startedAt}}).deliveryState,'retrying');
 assert.equal(project({...accepted,unknown:true}).deliveryState,'unconfirmed');
 assert.equal(project({...accepted,failed:true,providerConnection:{state:'retrying'}}).deliveryState,'failed');
 const terminal={role:'user',clientUserMessageId:'m',projectionState:'failed',projectionAuthority:'canonical',terminalRevision:1};
 assert.equal(context.AgentHubMessageProjection.reduceProjectionEntity(terminal,{...terminal,projectionState:'active',terminalRevision:0}).projectionState,'failed');
});

test('unknown retained occupancy stays visible in activity rail and keeps Stop without claiming running',async()=>{
 vm.runInContext(await readFile(new URL('../../assets/web-app/stream-tabs-controller.js',import.meta.url),'utf8'),context);
 const run={operationKind:'user-turn',projectionState:'unknown',activityUnknown:true,status:'running'};
 const activity=context.AgentHubMessageProjection.userRunActivity(run);
 assert.equal(activity.running,false);assert.equal(activity.canStop,true);assert.equal(activity.unknown,true);
 const task={id:'retained',running:false,activityUnknown:true};
 const sections=context.AgentHubStreamTabs.activityStreamSections([task]);
 assert.equal(sections.active[0].id,'retained');assert.equal(sections.recent.length,0);
 assert.equal(context.AgentHubStreamTabs.includeTaskInActivityRail({workspaceName:'Other'},'unknown'),true);
 assert.match(context.AgentHubStreamTabs.streamStatusPresentation(task).statusLabel,/Состояние уточняется/);
 const contradictory=context.AgentHubStreamTabs.streamStatusPresentation({...task,running:true});
 assert.equal(contradictory.running,false);
 assert.equal(contradictory.statusLabel.includes('Ход выполняется'),false);
});
