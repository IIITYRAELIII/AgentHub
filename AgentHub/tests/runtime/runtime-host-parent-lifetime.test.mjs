import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import os from 'node:os'; import path from 'node:path'; import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process'; import {promisify} from 'node:util';
import {buildWindowsRuntimeHost} from '../../src/infrastructure/process/runtime-host-builder.mjs';
const exec=promisify(execFile);
test('real compiled cold and controlled hosts survive submitting Node exit',{skip:process.platform!=='win32'},async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'hub-parent-exit-'));
 t.after(()=>rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100}));
 const host=path.join(root,'AgentHub.RuntimeHost.exe');
 await buildWindowsRuntimeHost({sourceRoot:path.resolve(import.meta.dirname,'../..'),outputFile:host});
 for(const mode of ['cold','controlled','inherited']){
  const releaseId='fixture-'+mode,release=path.join(root,'releases',releaseId),record=path.join(root,mode+'.json'); await mkdir(release,{recursive:true});
  const files={'package.json':JSON.stringify({version:'2026.10.12',type:'module'}),'agent-hub-main.mjs':`import fs from 'node:fs';await new Promise(r=>setTimeout(r,700));fs.writeFileSync(${JSON.stringify(record)},JSON.stringify({pid:process.pid,parentPid:process.ppid}));`};
  const manifest={releaseId,version:'2026.10.12',files:[]};
  for(const [name,body] of Object.entries(files)){await writeFile(path.join(release,name),body);manifest.files.push({path:name,bytes:Buffer.byteLength(body),sha256:createHash('sha256').update(body).digest('hex')});}
  await writeFile(path.join(root,'current.json'),JSON.stringify({current:releaseId}));await writeFile(path.join(release,'runtime-manifest.json'),JSON.stringify(manifest));
  const parent=path.join(root,mode+'.cjs');
  await writeFile(parent,`const {spawn}=require('node:child_process');const c=spawn(${JSON.stringify(host)},${JSON.stringify(mode==='cold'?['--spawn-independent']:[])},{stdio:'ignore',windowsHide:true,detached:${mode==='controlled'}});c.on('error',()=>process.exit(9));${mode==='cold'?"c.on('exit',code=>process.exit(code));":"c.unref();setTimeout(()=>process.exit(0),100);"}`);
  await exec(process.execPath,[parent],{windowsHide:true,timeout:30000});
  let child;const deadline=Date.now()+(mode==='inherited'?1800:10000);
  while(Date.now()<deadline&&!child){child=await readFile(record,'utf8').then(JSON.parse,()=>null);if(!child)await new Promise(r=>setTimeout(r,50));}
  if(mode==='inherited'){
   assert.equal(child, null, 'synchronous inherited launch reproduces lost child after submitting Node exits');
   continue;
  }
  assert.ok(child?.pid>0,mode+': child must actually execute after parent exit');
  const events=(await readFile(path.join(root,'data/runtime-host-lifetime.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
  assert.ok(events.some(e=>e.stage==='node-start'&&e.childPid===child.pid));
 }
});
