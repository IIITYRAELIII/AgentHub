import test, {after} from 'node:test';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {launchBrowser as launchNativeBrowser,openFixture,snapshot} from './composer-production.fixture.mjs';
async function launchBrowser(){
 const browser=await launchNativeBrowser();
 const close=browser.close.bind(browser);
 const newPage=browser.newPage.bind(browser);
 const pages=[];
 browser.newPage=async options=>{const page=await newPage(options);pages.push(page);return page;};
 browser.close=async()=>{
  for(const page of pages) if(!page.isClosed()) await drainFixtureReads(page);
  await close();
 };
 return browser;
}
async function drainFixtureReads(page){
 await page.evaluate(()=>{
  const p=window.__scrollCase??window.__anchorControl;
  if(!p) return;
  p.hold=false;
  for(const m of p.held.splice(0)) p.respond(m,p.histories[m.params.streamId]);
 });
 await page.unrouteAll({behavior:'wait'});
}
const A=process.env.AGENT_HUB_UI_EVIDENCE_DIR || await mkdtemp(path.join(os.tmpdir(),'hub-retained-anchor-'));
after(async()=>{if(!process.env.AGENT_HUB_UI_EVIDENCE_DIR) await rm(A,{recursive:true,force:true});});
const assetOverrides=process.env.AGENT_HUB_TEST_OVERRIDE_WEB_APP_ROOT ? Object.fromEntries(await Promise.all(['app.js','hub-client.js'].map(async n=>[n,await readFile(path.join(process.env.AGENT_HUB_TEST_OVERRIDE_WEB_APP_ROOT,n))]))) : {};
const history=(suffix,count=4)=>({streamId:'stream-'+suffix,provider:'codex',threadId:'thread-'+suffix,start:0,end:count,total:count,messageTotal:count*2,nextBefore:null,version:suffix+'-'+count,items:Array.from({length:count},(_,i)=>({id:'turn-'+suffix+'-'+i,completed:true,terminalRevision:1,messages:[{role:'user',itemId:'u-'+suffix+'-'+i,text:'Question '+suffix+'/'+i},{role:'agent',itemId:'f-'+suffix+'-'+i,phase:'final',text:'Answer '+suffix+'/'+i+'\n\n'+'Retained existing visible paragraph. '.repeat(120)}]}))});
test('return preserves the same visible text when a retained inactive page receives a new final', {timeout:30000},async()=>{
 const browser=await launchBrowser();
 try{
  const page=await browser.newPage({viewport:{width:1280,height:900}});page.setDefaultTimeout(5000);
  const errors=await openFixture(page,{surface:'web',fixtureSnapshot:snapshot(),fixtureHistory:history('a'),assetOverrides});
  await page.evaluate(histories=>{
   const bridge=window.__fixtureBridge,old=bridge.postMessage.bind(bridge);
   const p=window.__scrollCase={histories,hold:false,held:[]};
   p.respond=(m,result)=>window.dispatchEvent(new MessageEvent('message',{data:{type:'agenthub:control-result',id:m.id,ok:true,result}}));
   bridge.postMessage=m=>{
    if(['open-task','task-history','select-task'].includes(m.action)){
     if(p.hold&&m.params.streamId==='stream-b'&&m.action==='task-history'){p.held.push(m);return;}
     if(m.action==='select-task'){queueMicrotask(()=>p.respond(m,window.__agentHubFixture.snapshot));return;}
     window.__agentHubFixture.history=p.histories[m.params.streamId];
    }
    return old(m);
   };
  },{'stream-a':history('a'),'stream-b':history('b')});
  const click=s=>page.locator('.stream-tabs-track [data-stream-tab-id="stream-'+s+'"]').click();
  await click('b');await page.getByText('Answer b/3',{exact:false}).first().waitFor();
  await page.locator('[data-chat-scroll]').evaluate(n=>{n.dispatchEvent(new WheelEvent('wheel',{deltaY:-100,bubbles:true}));n.scrollTop=650;});
  await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
  const before=await page.locator('[data-chat-scroll]').evaluate(n=>({top:n.scrollTop,height:n.scrollHeight,viewport:n.clientHeight}));
  await click('a');await page.getByText('Answer a/3',{exact:false}).first().waitFor();
  await page.evaluate(()=>{window.__scrollCase.hold=true;});
  await click('b');await page.waitForFunction(()=>window.__scrollCase.held.length>0);
  await click('a');await page.getByText('Answer a/3',{exact:false}).first().waitFor();
  await page.evaluate(h=>{const p=window.__scrollCase;p.histories['stream-b']=h;p.respond(p.held[0],h);},history('b',5));
  await page.waitForFunction(()=>window.AgentHubCommandTrace.diagnostics().pending>0);
  // The existing app setter is an observation port only; no private cache or
  // render implementation is replaced. Wait for the inactive page projection.
  await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
  await click('b');await page.getByText('Answer b/4',{exact:false}).first().waitFor();
  await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
  const after=await page.locator('[data-chat-scroll]').evaluate(n=>({top:n.scrollTop,height:n.scrollHeight,viewport:n.clientHeight}));
  const result={before,after,errors,url:page.url(),title:await page.title()};
  await writeFile(A+'/background-scroll.json',JSON.stringify(result,null,2));
  await page.screenshot({path:A+'/background-scroll.png'});
  assert.deepEqual(errors,[]);
  assert.ok(Math.abs(after.top-before.top)<=2,'appending an inactive final must not move the returning reader away from the same existing text: '+JSON.stringify(result));
 }finally{await browser.close();}
});

test('inactive prepend preserves the visible message; a pinned reader still follows appended finals', {timeout:30000},async()=>{
 const browser=await launchBrowser();
 try{
  for(const pinned of [false,true]){
   const page=await browser.newPage({viewport:{width:1280,height:900}});page.setDefaultTimeout(5000);
   const errors=await openFixture(page,{surface:'web',fixtureSnapshot:snapshot(),fixtureHistory:history('a'),assetOverrides});
   await page.evaluate(histories=>{
    const bridge=window.__fixtureBridge,old=bridge.postMessage.bind(bridge);
    const p=window.__anchorControl={histories,hold:false,held:[]};
    p.respond=(m,result)=>window.dispatchEvent(new MessageEvent('message',{data:{type:'agenthub:control-result',id:m.id,ok:true,result}}));
    bridge.postMessage=m=>{
     if(['open-task','task-history','select-task'].includes(m.action)){
      if(p.hold&&m.params.streamId==='stream-b'&&m.action==='task-history'){p.held.push(m);return;}
      if(m.action==='select-task'){queueMicrotask(()=>p.respond(m,window.__agentHubFixture.snapshot));return;}
      window.__agentHubFixture.history=p.histories[m.params.streamId];
     }
     return old(m);
    };
   },{'stream-a':history('a'),'stream-b':history('b')});
   const click=s=>page.locator('.stream-tabs-track [data-stream-tab-id="stream-'+s+'"]').click();
   await click('b');await page.getByText('Answer b/3',{exact:false}).first().waitFor();
   await page.locator('[data-chat-scroll]').evaluate((n,pinned)=>{
    n.dispatchEvent(new WheelEvent('wheel',{deltaY:pinned?100:-100,bubbles:true}));
    n.scrollTop=pinned?n.scrollHeight:650;
   },pinned);
   await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
   const before=await page.locator('[data-chat-scroll]').evaluate(n=>{
    const viewport=n.getBoundingClientRect().top;
    const message=[...document.querySelectorAll('[data-chat-log] [data-message-id]')].find(m=>m.getBoundingClientRect().bottom>=viewport);
    return {top:n.scrollTop,id:message.dataset.messageId,offset:message.getBoundingClientRect().top-viewport};
   });
   await click('a');await page.getByText('Answer a/3',{exact:false}).first().waitFor();
   await page.evaluate(()=>{window.__anchorControl.hold=true;});
   await click('b');await page.waitForFunction(()=>window.__anchorControl.held.length>0);
   await click('a');await page.getByText('Answer a/3',{exact:false}).first().waitFor();
   const next=history('b',5);
   if(!pinned){next.items=[next.items[4],...next.items.slice(0,4)];next.version='b-prepend';}
   await page.evaluate(h=>{const p=window.__anchorControl;p.histories['stream-b']=h;p.respond(p.held[0],h);},next);
   await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
   await click('b');await page.getByText('Answer b/4',{exact:false}).first().waitFor();
   await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
   const after=await page.locator('[data-chat-scroll]').evaluate((n,id)=>{
    const message=[...document.querySelectorAll('[data-chat-log] [data-message-id]')].find(m=>m.dataset.messageId===id);
    return {top:n.scrollTop,distance:n.scrollHeight-n.clientHeight-n.scrollTop,offset:message.getBoundingClientRect().top-n.getBoundingClientRect().top};
   },before.id);
   if(pinned) assert.ok(after.distance<=2,'a previously pinned reader follows the new bottom');
   else assert.ok(Math.abs(after.offset-before.offset)<=2,'prepend preserves the original visible message offset: '+JSON.stringify({before,after}));
   if(!pinned){
    await click('a');
    await page.getByText('Answer a/3',{exact:false}).first().waitFor();
    await page.evaluate(()=>{
     document.querySelector('.stream-tabs-track [data-stream-tab-id="stream-b"]').click();
     const n=document.querySelector('[data-chat-scroll]');
     n.dispatchEvent(new WheelEvent('wheel',{deltaY:100,bubbles:true}));
     n.scrollTop=900;
    });
    await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
    assert.equal(await page.locator('[data-chat-scroll]').evaluate(n=>n.scrollTop),900,'queued restoration cannot override newer user scroll intent');
   }
   assert.deepEqual(errors,[]);
   await drainFixtureReads(page);
   await page.close();
  }
 }finally{await browser.close();}
});
