import assert from 'node:assert/strict';
import test from 'node:test';
import {launchBrowser,openFixture,submit,setSelectedTask,bridgeCalls} from './composer-production.fixture.mjs';

test('paused upload in A does not disable B; A stays fenced until its own completion',async()=>{
  const browser=await launchBrowser();
  try{
    const page=await browser.newPage({viewport:{width:1280,height:800}});
    const failed=[];
    page.on('requestfailed',r=>failed.push({url:r.url(),failure:r.failure()}));
    const issues=await openFixture(page,{chunkedUpload:true});
    await page.evaluate(()=>{localStorage.setItem('fixture:send-mode','accept');localStorage.setItem('fixture:upload-mode','fail-once');});
    await submit(page,{text:'A original',attachment:{name:'owned.png',mimeType:'image/png',buffer:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j2iUAAAAASUVORK5CYII=','base64')}});
    await page.waitForFunction(()=>document.querySelector('[data-message-upload-actions][data-upload-state="paused"]'));
    await setSelectedTask(page,'stream-b');
    await page.locator('[data-composer-input]').fill('Independent B');
    assert.ok((await page.screenshot()).length > 1000);
    assert.equal(await page.locator('[data-composer-send]').isEnabled(),true,'an unrelated paused upload cannot own B admission');
    await page.locator('[data-composer-send]').click();
    await page.waitForFunction(()=>JSON.parse(localStorage.getItem('fixture:bridge-log')??'[]').some(x=>x.action==='send-message'&&x.params.streamId==='stream-b'));
    const sends=await bridgeCalls(page,'send-message');
    assert.equal(sends.length,1);assert.equal(sends[0].params.streamId,'stream-b');
    await setSelectedTask(page,'stream-a');
    await page.locator('[data-composer-input]').fill('A later draft');
    assert.equal(await page.locator('[data-composer-send]').isDisabled(),true,'same Stream retains the original fence');
    assert.equal(await page.locator('[data-message-upload-actions][data-upload-state="paused"]').count(),1);
    console.log(JSON.stringify({fixtureResourceIssues:issues,failed}));
    assert.deepEqual(issues.filter(message=>message!=='Failed to load resource: the server responded with a status of 503 (Service Unavailable)'),[]);
  }finally{await browser.close();}
});

test('out-of-order independent sends keep exact completion and draft ownership',async()=>{
  const browser=await launchBrowser();
  try{
    const page=await browser.newPage({viewport:{width:1280,height:800}});
    const issues=await openFixture(page,{});
    await page.evaluate(()=>{
      const original=window.__agentHubVscode.postMessage.bind(window.__agentHubVscode);
      window.__isolationHeld=[];
      window.__agentHubVscode.postMessage=(message)=>{
        if(message.action==='send-message'){window.__isolationHeld.push(structuredClone(message));return;}
        return original(message);
      };
    });
    await submit(page,{text:'A pending'});
    await page.waitForFunction(()=>window.__isolationHeld.length===1);
    await setSelectedTask(page,'stream-b');
    await page.locator('[data-composer-input]').fill('B pending');
    assert.equal(await page.locator('[data-composer-send]').isEnabled(),true);
    await page.locator('[data-composer-send]').click();
    await page.waitForFunction(()=>window.__isolationHeld.length===2);
    await page.locator('[data-composer-input]').fill('B edited while pending');
    await page.evaluate(()=>{
      const a=window.__isolationHeld[0];
      window.dispatchEvent(new MessageEvent('message',{data:{type:'agenthub:control-result',id:a.id,ok:false,error:'Введите сообщение'}}));
    });
    await page.waitForFunction(()=>window.AgentHub.prepareForRuntimeReload()===false);
    assert.equal(await page.locator('[data-composer-send]').isDisabled(),true,'A completion cannot release B');
    assert.equal(await page.locator('[data-composer-input]').inputValue(),'B edited while pending');
    await setSelectedTask(page,'stream-a');
    await page.waitForFunction(()=>document.querySelector('[data-composer-input]')?.value==='A pending');
    assert.equal(await page.locator('[data-composer-send]').isEnabled(),true);
    await page.evaluate(()=>{
      const b=window.__isolationHeld[1];
      window.dispatchEvent(new MessageEvent('message',{data:{type:'agenthub:control-result',id:b.id,ok:true,result:{accepted:true,provider:'codex',threadId:'thread-b',streamId:'stream-b',clientUserMessageId:b.params.clientUserMessageId,itemId:'b-receipt'}}}));
    });
    await setSelectedTask(page,'stream-b');
    await page.waitForFunction(()=>!document.querySelector('[data-composer-send]').disabled);
    assert.equal(await page.locator('[data-composer-input]').inputValue(),'B edited while pending');
    assert.equal((await page.evaluate(()=>window.__isolationHeld)).length,2,'no automatic resubmission');
    assert.deepEqual(issues,[]);
  }finally{await browser.close();}
});
