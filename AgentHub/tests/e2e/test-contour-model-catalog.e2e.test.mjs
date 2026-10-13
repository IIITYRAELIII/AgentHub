import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp, copyFile, writeFile, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createInterface} from 'node:readline';
import {once} from 'node:events';
import {ProviderModelCatalogService} from '../../src/application/provider-model-catalog-service.mjs';
const sourceRoot=path.resolve(import.meta.dirname,'../..');

test('Test Contour exposes its synthetic model through provider catalog discovery and preserves real paging',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'agent-hub-contour-models-'));
  const fake=path.join(root,'fake.mjs'), real=path.join(root,'real.mjs');
  await copyFile(path.join(sourceRoot,'e2e/fake-codex-app-server.mjs'),fake);
  await writeFile(real,`import {createInterface} from 'node:readline';
createInterface({input:process.stdin}).on('line', line=>{
 const {id,method,params={}}=JSON.parse(line); if(id===undefined)return;
 const result=method==='model/list' ? params.invalid ? {bad:true,nextCursor:null}
 : {data:params.cursor ? [{model:'real-second',displayName:'Second'}]
 : [{model:'real-first',displayName:'First'},...(params.duplicate ? [{model:'fake-codex',displayName:'Wrong'}] : [])],
 nextCursor:params.cursor ? null : 'next-page',hasMore:!params.cursor,echo:params.limit}
 : method==='thread/list' ? {data:[],nextCursor:null} : {};
 process.stdout.write(JSON.stringify({id,result})+'\\n');
});`);
  const child=spawn(process.execPath,[path.join(sourceRoot,'e2e/test-contour-codex-multiplexer.mjs'),
    '--real-executable',process.execPath,'--fake-executable',fake,
    '--fake-state',path.join(root,'state.json'),'--routing-state',path.join(root,'routing.json'),real],
    {cwd:root,env:{...process.env,AGENT_HUB_TEST_CONTOUR:'1',AGENT_HUB_RUNTIME_ROOT:root},windowsHide:true,stdio:['pipe','pipe','pipe']});
  let stderr=''; child.stderr.on('data',data=>{stderr+=data});
  const pending=new Map(); let sequence=0;
  createInterface({input:child.stdout}).on('line', line=>{
    const reply=JSON.parse(line); const resolve=pending.get(reply.id);
    if(resolve){pending.delete(reply.id);resolve(reply);}
  });
  const rpc=(method,params={})=>new Promise((resolve,reject)=>{
    const id=++sequence; const timer=setTimeout(()=>reject(Error('RPC timeout '+method+' '+stderr)),15000);
    pending.set(id,reply=>{clearTimeout(timer);reply.error?reject(Error(reply.error.message)):resolve(reply.result)});
    child.stdin.write(JSON.stringify({id,method,params})+'\n');
  });
  try {
    await rpc('initialize');
    const first=await rpc('model/list',{limit:10,includeHidden:false});
    assert.equal(first.echo,10); assert.equal(first.nextCursor,'next-page');
    assert.equal(first.hasMore,true); assert.equal(first.data[0].model,'real-first');
    assert.equal(first.data.filter(x=>x.model==='fake-codex').length,1);
    assert.equal(first.data[1].displayName,'Fake Codex · Принято');
    const duplicate=await rpc('model/list',{duplicate:true});
    assert.equal(duplicate.data.filter(x=>x.model==='fake-codex').length,1);
    assert.equal(duplicate.data[1].displayName,'Fake Codex · Принято');
    const second=await rpc('model/list',{limit:10,cursor:first.nextCursor});
    assert.deepEqual(second.data,[{model:'real-second',displayName:'Second'}]);
    assert.equal(second.nextCursor,null); assert.equal(second.hasMore,false);
    assert.deepEqual(await rpc('model/list',{invalid:true}),{bad:true,nextCursor:null});
    const codexModels=[{value:'obsolete',label:'Obsolete'}];
    const preferences={codexModels:new Set(['obsolete']),recordCodexCatalog:()=>[]};
    const catalog=new ProviderModelCatalogService({codexModels,claudeModels:[],agentPreferences:preferences,
      logger:{info(){},warn(message){assert.fail(message)}}});
    assert.equal(await catalog.refreshCodex(rpc),true);
    assert.deepEqual(new Set(codexModels.map(item=>item.value)),new Set(['fake-codex','real-first','real-second']));
    assert.equal(preferences.codexModels.has('fake-codex'),true);
    assert.equal(preferences.codexModels.has('obsolete'),false);
    const started=await rpc('thread/start',{model:'fake-codex',cwd:'.'});
    const fakeState=JSON.parse(await readFile(path.join(root,'state.json'),'utf8'));
    assert.equal(fakeState.requestCounts['thread/start'],1);
    assert.equal(fakeState.threads.find(x=>x.id===started.thread.id).model,'fake-codex');
  } finally {
    const exited=once(child,'exit'); child.stdin.end();
    const [code]=await exited; assert.equal(code,0,stderr);
    await rm(root,{recursive:true,force:true});
  }
});
