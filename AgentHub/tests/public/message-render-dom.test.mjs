import assert from "node:assert/strict";
import { mkdir, readFile, mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import { LocalTaskSyncStore } from "../../src/infrastructure/persistence/task-sync-store.mjs";
import { readCodexTracePageInWorker } from "../../src/providers/codex/codex-rollout-activity-worker-client.mjs";
import path from "node:path";
import test from "node:test";
import { codexAssistantResponseProjection } from "../../src/domain/codex-response-annotation.mjs";
import { claudeTranscriptHistory } from "../../src/application/task-history.mjs";
import { PreTurnInstructionStore } from "../../src/infrastructure/persistence/pre-turn-instruction-store.mjs";
import { fileURLToPath } from "node:url";
import { codexTraceEntry } from "../../src/providers/codex/codex-rollout-activity.mjs";
import { clientPerformanceTraceSpans } from "../../src/application/client-performance-trace.mjs";

const WEB_APP_ROOT = new URL("../../assets/web-app/", import.meta.url);
const TEST_THEME_CATALOG = JSON.stringify([{
  id: "orbit",
  name: "Orbit",
  color: "#080b11",
  aliases: [],
  assets: {},
  backgrounds: [{ id: "none", name: "Нет", assetUrl: "", preload: false }],
}]);

let browser;

function webAssetContentType(pathname) {
  if (/\.css$/u.test(pathname)) return "text/css; charset=utf-8";
  if (/\.(?:js|mjs)$/u.test(pathname)) return "text/javascript; charset=utf-8";
  if (/\.png$/u.test(pathname)) return "image/png";
  return "application/octet-stream";
}

async function openWebApp(page) {
  await page.route("**/*", async (route) => {
    const requestUrl = new URL(route.request().url());
    if (requestUrl.hostname !== "127.0.0.1") {
      await route.abort();
      return;
    }
    if (requestUrl.pathname === "/") {
      const source = await readFile(new URL("index.html", WEB_APP_ROOT), "utf8");
      const body = source
        .replace(/\s*<script src="https:\/\/telegram\.org\/[^>]+><\/script>/u, "")
        .replace(/\s*<script src="\/browser-device-auth\.js" defer><\/script>/u, "")
        .replace(/\s*<script src="\/hub-client\.js" defer><\/script>/u, "")
        .replace("</head>", `<script type="application/json" data-theme-catalog>${TEST_THEME_CATALOG}</script></head>`);
      await route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body });
      return;
    }
    if (requestUrl.pathname === "/work-log.css") {
      await route.fulfill({
        status: 200,
        contentType: "text/css; charset=utf-8",
        body: await readFile(new URL("../../work-log.css", import.meta.url)),
      });
      return;
    }
    const relative = decodeURIComponent(requestUrl.pathname).replace(/^\/+/, "");
    if (!relative || relative.split("/").some((segment) => !segment || segment === "." || segment === "..")) {
      await route.fulfill({ status: 404, body: "Not found" });
      return;
    }
    try {
      await route.fulfill({
        status: 200,
        contentType: webAssetContentType(relative),
        body: await readFile(new URL(relative, WEB_APP_ROOT)),
      });
    } catch {
      await route.fulfill({ status: 404, body: "Not found" });
    }
  });
  await page.goto("http://127.0.0.1/", { waitUntil: "load" });
  await page.waitForFunction(() => typeof window.AgentHub === "object");
}

async function seedMessages(page, messages, taskPatch = {}) {
  await page.evaluate(({ values, taskPatch }) => {
    window.AgentHub.setWorkspaces([{ id: "workspace-1", name: "Agent HUB", title: "Agent HUB" }]);
    window.AgentHub.setTasks([{
      id: "task-1",
      threadId: "thread-1",
      workspaceId: "workspace-1",
      workspaceName: "Agent HUB",
      streamId: "stream-1",
      streamName: "Chat",
      streamOrdinal: 1,
      title: "Chat",
      provider: "codex",
      agentLabel: "Codex",
      modelLabel: "Sol",
      status: "ready",
      statusLabel: "Готов",
      unread: false,
      running: false,
      selected: true,
      ...taskPatch,
    }]);
    window.AgentHub.setMessages("task-1", values);
  }, { values: messages, taskPatch });
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

test.before(async () => {
  const { chromium } = await import("playwright");
  browser = process.platform === "win32"
    ? await chromium.launch({ channel: "msedge", headless: true })
    : await chromium.launch({ headless: true });
});

test.after(async () => {
  await browser?.close();
});

test("positioned annotations interleave four nonsorted answers through stream history and reload", {timeout:45000}, async()=>{
  const raw='# Зачем нужна история Git\n\nИстория Git сохраняет изменения. 🦊 :agent-annotation{index="2"}\n\nЗависимости можно переиспользовать. :codex-annotation{index="1"}\n\nВременные копии удаляются после проверки. :agent-annotation{index="3"}\n\nМедиа принадлежит открытой задаче. :codex-annotation{index="4"}';
  for(const width of [1366,390]) for(const provider of ['codex','claude']) {
    const page=await browser.newPage({viewport:{width,height:1000}}); const diagnostics=[];
    page.setDefaultTimeout(3000);
    page.on('pageerror',e=>diagnostics.push(e.message));
    page.on('console',m=>{
      if(m.type()==='error' && m.text().includes('404 (Not Found)')
        && ['http://127.0.0.1/health','http://127.0.0.1/events'].includes(m.location().url)) return;
      if(['error','warning'].includes(m.type())) diagnostics.push(m.text());
    });
    try {
      await openWebApp(page);
      const source={id:'placement-source',provider,threadId:'thread-1',turnId:'original',itemId:'original-item',role:'agent',text:'Dependencies; Git; Cleanup; Media.'};
      await seedMessages(page,[source],{provider,agentLabel:provider});
      const annotations=await page.evaluate(async(source)=>{
        const api=window.AgentHubMessageDisclosure, surface=document.querySelector('[data-message-id="placement-source"] .msg-body');
        const text=surface.textContent;
        return Promise.all(['Dependencies','Git','Cleanup','Media'].map(async(word)=>{
          const start=text.indexOf(word),end=start+word.length;
          return {text:word,annotation:'Question '+word,source:{version:1,...api.responseAnnotationSourceIdentity(source),surfaceKind:'message-body',surfaceIndex:0,start,end,
            contentHash:await api.responseAnnotationSha256(api.responseAnnotationSourceContent(source)),surfaceHash:await api.responseAnnotationSha256(text),selectionHash:await api.responseAnnotationSha256(word)}};
        }));
      },source);
      const user={id:'placement-user',provider,threadId:'thread-1',turnId:'reply',itemId:'user',role:'user',text:'User :agent-annotation{index="4"}',responseAnnotationRequest:'User :agent-annotation{index="4"}',responseAnnotations:annotations};
      const project=(answer)=>provider==='codex'?codexAssistantResponseProjection(answer):(()=>{
        const h=claudeTranscriptHistory([{type:'user',uuid:'u',message:{role:'user',content:'Check'}},{type:'assistant',uuid:'a',message:{role:'assistant',content:[{type:'text',text:answer}]}}].map(JSON.stringify).join('\n'))[0];
        return {text:h.answer,responseAnnotationReferences:h.messages[1].responseAnnotationReferences};
      })();
      const answer=(value)=>({id:'placement-answer',provider,threadId:'thread-1',turnId:'reply',itemId:'answer',role:'agent',...project(value)});
      const sequence=(selector='[data-message-id="placement-answer"] .msg-body')=>page.locator(selector).evaluate(body=>Array.from(body.querySelectorAll('h1,p,[data-response-citation-index]')).map(n=>n.dataset.responseCitationIndex?'quote'+n.dataset.responseCitationIndex:n.textContent.trim()));
      const expected=['Зачем нужна история Git','История Git сохраняет изменения. 🦊','quote2','Зависимости можно переиспользовать.','quote1','Временные копии удаляются после проверки.','quote3','Медиа принадлежит открытой задаче.','quote4'];
      // Stream a complete first card, then an incomplete next marker: no all-top relocation or raw prefix.
      const boundary=raw.indexOf(':codex-annotation');
      await seedMessages(page,[source,user],{provider,agentLabel:provider,running:true});
      if(width===390) await page.evaluate(()=>window.AgentHub.showSelectedTask());
      for(const partial of [raw.slice(0,boundary),raw.slice(0,boundary+':codex-annotation{index="'.length),raw]) {
        await page.evaluate(value=>window.AgentHub.setLive('task-1',value),answer(partial));
        const values=await sequence('[data-live-body]');
        assert.deepEqual(values.slice(0,3),expected.slice(0,3));
        assert.doesNotMatch(await page.locator('[data-live-body]').textContent(),/:agent-annotation|:codex-annotation/u);
      }
      assert.deepEqual(await sequence('[data-live-body]'),expected);
      await page.evaluate(()=>window.AgentHub.setLive('task-1',null));
      await seedMessages(page,[source,user,answer(raw)],{provider,agentLabel:provider});
      assert.deepEqual(await sequence(),expected);
      assert.equal(await page.locator('[data-message-id="placement-answer"] .msg-body').evaluate(n=>Array.from(n.childNodes).filter(c=>c.nodeType===Node.TEXT_NODE).map(c=>c.textContent).join('').trim()),'');
      const retained=JSON.parse(JSON.stringify([source,user,answer(raw)]));
      // Reload/reconnect from retained structured message metadata, with no original marker parser in the browser.
      await page.reload({waitUntil:'load'}); await page.waitForFunction(()=>typeof window.AgentHub==='object');
      await seedMessages(page,retained,{provider,agentLabel:provider});
      if(width===390) await page.evaluate(()=>window.AgentHub.showSelectedTask());
      assert.deepEqual(await sequence(),expected);
      assert.ok((await page.locator('[data-message-id="placement-user"]').textContent()).includes(user.text));
      for(const index of [2,1,3,4]) {
        await page.locator(`[data-message-id="placement-answer"] [data-response-citation-index="${index}"]`).click();
        const target=page.locator('[data-message-id="placement-user"] .msg-annotation-content').nth(index-1);
        assert.equal(await target.getAttribute('data-response-annotation-source')!==null,true);
        await target.click();
        assert.equal((await page.locator('[data-message-id="placement-source"] .msg-source-citation-highlight').allTextContents()).join(''),annotations[index-1].text);
      }
      assert.match(await page.title(),/Agent Hub/iu); assert.equal(page.url(),'http://127.0.0.1/');
      if(process.env.AGENT_HUB_QA_SCREENSHOT) {
        await page.locator('[data-message-id="placement-answer"]').scrollIntoViewIfNeeded();
        await page.screenshot({path:`${process.env.AGENT_HUB_QA_SCREENSHOT}-placement-${provider}-${width}.png`});
      }
      assert.deepEqual(diagnostics,[]);
    } finally {await page.close();}
  }
});

test("generic annotation aliases render one exact source link for each provider on desktop and mobile", {timeout:30000}, async()=>{
  for(const width of [1366,390]) for(const provider of ['codex','claude']) {
    const page=await browser.newPage({viewport:{width,height:850}}); const diagnostics=[];
    page.setDefaultTimeout(3000);
    page.on('pageerror',e=>diagnostics.push(e.message));
    page.on('console',m=>{
      // This existing routed harness has no runtime health/SSE server.
      if(m.type()==='error' && m.text().includes('404 (Not Found)')
        && ['http://127.0.0.1/health','http://127.0.0.1/events'].includes(m.location().url)) return;
      if(['error','warning'].includes(m.type())) diagnostics.push({text:m.text(),location:m.location()});
    });
    try {
      await openWebApp(page);
      const raw=':agent-annotation{index="1"} Checked :codex-annotation{index="1"} once.\n`literal :agent-annotation{index="2"}`';
      const projected=provider==='codex'?codexAssistantResponseProjection(raw):(()=>{
        const history=claudeTranscriptHistory([
          {type:'user',uuid:'u',message:{role:'user',content:'Check'}},
          {type:'assistant',uuid:'a',message:{role:'assistant',content:[{type:'text',text:raw}]}}
        ].map(JSON.stringify).join('\n'));
        return {text:history[0].answer,responseAnnotationReferences:history[0].messages[1].responseAnnotationReferences};
      })();
      const source={id:'generic-source',provider,threadId:'thread-1',turnId:'original-turn',itemId:'original-item',role:'agent',text:'Original **exact** selection 🦊.'};
      await seedMessages(page,[source],{provider,agentLabel:provider});
      const locator=await page.evaluate(async(source)=>{
        const api=window.AgentHubMessageDisclosure;
        const surface=document.querySelector('[data-message-id="generic-source"] .msg-body');
        const text=surface.textContent; const start=text.indexOf('exact'); const end=start+'exact selection 🦊.'.length;
        return {version:1,...api.responseAnnotationSourceIdentity(source),surfaceKind:'message-body',surfaceIndex:0,start,end,
          contentHash:await api.responseAnnotationSha256(api.responseAnnotationSourceContent(source)),surfaceHash:await api.responseAnnotationSha256(text),selectionHash:await api.responseAnnotationSha256(text.slice(start,end))};
      },source);
      const user={id:'generic-user',provider,threadId:'thread-1',turnId:'reply-turn',itemId:'user-item',role:'user',text:'Literal :agent-annotation{index="2"}',responseAnnotationRequest:'Literal :agent-annotation{index="2"}',responseAnnotations:[{text:'exact selection 🦊.',annotation:'Check this comment',source:locator}]};
      const answer={id:'generic-answer',provider,threadId:'thread-1',turnId:'reply-turn',itemId:'answer-item',role:'agent',...projected};
      await seedMessages(page,[source,user,answer],{provider,agentLabel:provider});
      if(width===390) await page.evaluate(()=>window.AgentHub.showSelectedTask());
      const article=page.locator('[data-message-id="generic-answer"]');
      assert.equal(await article.locator('[data-response-citation-index="1"]').count(),1);
      assert.equal(await article.locator('[data-response-citation-index="2"]').count(),0);
      assert.ok((await article.textContent()).includes('literal :agent-annotation{index="2"}'));
      assert.ok((await page.locator('[data-message-id="generic-user"]').textContent()).includes(user.text));
      await article.locator('[data-response-citation-index="1"]').click();
      await page.locator('[data-message-id="generic-user"] .msg-annotation-content.is-citation-target').waitFor();
      assert.equal(await page.locator('[data-message-id="generic-user"] .msg-annotation-content').evaluate(n=>n.classList.contains('is-citation-target')),true);
      await page.locator('[data-message-id="generic-user"] [data-response-annotation-source]').click();
      assert.equal((await page.locator('[data-message-id="generic-source"] .msg-source-citation-highlight').allTextContents()).join(''),'exact selection 🦊.');
      assert.match(await page.title(),/Agent Hub/iu); assert.equal(new URL(page.url()).hostname,'127.0.0.1');
      if(process.env.AGENT_HUB_QA_SCREENSHOT) await page.screenshot({path:`${process.env.AGENT_HUB_QA_SCREENSHOT}-generic-${provider}-${width}.png`});
      assert.deepEqual(diagnostics,[]);
    } finally {await page.close();}
  }
});

test("generic annotation canonical Guide reaches the read-only rendered editor and neutral prompt roundtrip",{timeout:15000},async()=>{
  const page=await browser.newPage();
  const temp=await mkdtemp(path.join(os.tmpdir(),'guide-editor-'));
  try {
    const store=new PreTurnInstructionStore({guideFile:fileURLToPath(new URL('../../AGENT_HUB_GUIDE.md',import.meta.url)),globalFile:path.join(temp,'global.md')});
    await store.loadGuide(); const snapshot=await store.snapshot();
    await openWebApp(page);
    const observed=await page.evaluate(snapshot=>{
      window.AgentHubPreTurnInstructionsEditor.setSnapshot(snapshot);
      const input=document.querySelector('[data-agent-hub-guide-input]');
      const api=window.AgentHubMessageLifecycle;
      const prompt=api.responseAnnotationPrompt('Check',[{text:'Exact quote',annotation:'Exact comment'}]);
      return {guide:input.value,readOnly:input.readOnly,prompt,
        modern:api.embeddedResponseAnnotations(prompt),legacy:api.embeddedResponseAnnotations(prompt.replace('## My request:','## My request for Codex:'))};
    },snapshot);
    assert.equal(observed.guide,snapshot.guide.content); assert.equal(observed.readOnly,true);
    assert.equal(observed.guide.split('Reuse installed dependencies when the lockfile, runtime and platform requirements match; do not create a copy per Task. After successful transfer and verification, remove temporary Git bundles and copies through their owning cleanup mechanism; preserve unique work and required evidence.').length,2);
    assert.ok(observed.prompt.includes('earlier assistant response')); assert.ok(observed.prompt.includes('## My request:\nCheck'));
    assert.deepEqual(observed.modern,observed.legacy); assert.equal(observed.modern.request,'Check');
    assert.deepEqual(observed.modern.annotations,[{text:'Exact quote',annotation:'Exact comment'}]);
  } finally {await page.close();await rm(temp,{recursive:true,force:true});}
});



test("bounded trace archive loads only on demand and citations recover an evicted exact group", { timeout: 20_000 }, async () => {
  const page = await browser.newPage();
  try {
    await openWebApp(page);
    const message = { id: "trace-source", provider: "codex", threadId: "thread-1",
      turnId: "turn-trace", itemId: "item-trace", role: "agent", text: "Answer",
      activityGroups: [{ id: "reasoning:last", reasoning: "Последний этап", activities: [], omittedGroupsBefore: 600 }] };
    await seedMessages(page, [message]);
    await page.evaluate(() => {
      window.__traceRequests = [];
      window.AgentHub.on("history:trace-page", ({ identity, tracePage, resolve }) => {
        window.__traceRequests.push({ identity, tracePage });
        const first = !tracePage.offset;
        resolve({ turnId: tracePage.turnId, offset: tracePage.offset || 0,
          nextOffset: first ? 50 : null, sourceSize: 12345, generation: "generation", sourceHash: "hash",
          groups: [{ id: first ? "reasoning:first" : "reasoning:last",
            reasoning: first ? "Ранний точный фрагмент" : "Последний этап", activities: [] }] });
      });
    });
    const article = page.locator('[data-message-id="trace-source"]');
    await article.locator("details.turn-trace > summary").click();
    assert.equal(await page.evaluate(() => window.__traceRequests.length), 0);
    const archive = article.locator(".turn-trace-archive");
    await archive.locator("summary").click();
    await archive.getByText("Ранний точный фрагмент", { exact: true }).waitFor();
    await archive.getByRole("button", { name: "Далее", exact: true }).click();
    await archive.getByText("Последний этап", { exact: true }).waitFor();
    assert.equal(await archive.getByText("Ранний точный фрагмент", { exact: true }).count(), 0);
    const requests = await page.evaluate(() => window.__traceRequests);
    assert.equal(requests[0].identity.streamId, "stream-1");
    assert.equal(requests[1].tracePage.sourceHash, "hash");
    assert.equal(requests[1].tracePage.sourceSize, 12345);

    // Build a real locator for an early block which is absent from the preview.
    const annotation = await page.evaluate(async (message) => {
      const api = window.AgentHubMessageDisclosure;
      const text = "Ранний точный фрагмент";
      const group = { id: "reasoning:first", reasoning: text, activities: [] };
      const source = { version: 1, ...api.responseAnnotationSourceIdentity(message),
        surfaceKind: "trace-reasoning", surfaceIndex: 0, traceGroupId: group.id, start: 0, end: text.length };
      source.contentHash = await api.responseAnnotationSha256(api.responseAnnotationSourceContent(
        { ...message, activityGroups: [group] }, source));
      source.surfaceHash = source.selectionHash = await api.responseAnnotationSha256(text);
      return { text, annotation: "Источник", source };
    }, message);
    await seedMessages(page, [message, { id: "trace-quote", role: "user", text: "Проверить",
      responseAnnotations: [annotation], responseAnnotationRequest: "Проверить" }]);
    await page.locator('[data-message-id="trace-quote"] [data-response-annotation-source]').click();
    await article.locator(".msg-source-citation-highlight").waitFor();
    assert.equal(await article.locator(".msg-source-citation-highlight").textContent(), annotation.text);
    assert.equal((await page.evaluate(() => window.__traceRequests)).at(-1).tracePage.groupId, "reasoning:first");
  } finally { await page.close(); }
});

test("long trace citations survive persistence reload, shortened preview and omission", { timeout: 40_000 }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hub239-citation-"));
  const page = await browser.newPage();
  let store;
  try {
    const reasoning = "Selected exact text. " + "x".repeat(100_000);
    const group = { id: "commentary:long-analysis", reasoning, activities: [] };
    const task = { provider: "codex", threadId: "thread-1", projectRoot: directory };
    const filePath = path.join(directory, "task-sync.json");
    store = new LocalTaskSyncStore({ filePath });
    await store.load();
    await store.recordHistory(task, [{ id: "turn-long", answer: "Answer", completed: true,
      status: "completed", activityGroups: [group] }], {}, Date.now());
    store.close();
    store = new LocalTaskSyncStore({ filePath });
    await store.load();
    const preview = store.history(task)[0].activityGroups[0];
    assert.equal(preview.reasoning.length, 40_000);
    assert.equal(preview.id, group.id);
    const rollout = path.join(directory, "rollout.jsonl");
    const raw = [
      { type: "session_meta", payload: { id: "thread-1" } },
      { type: "response_item", payload: { type: "message", id: "long-analysis", role: "assistant",
        phase: "analysis", content: [{ type: "output_text", text: reasoning }],
        internal_chat_message_metadata_passthrough: { turn_id: "turn-long" } } },
    ].map(value => JSON.stringify(value)).join("\n") + "\n";
    await writeFile(rollout, raw, "utf8");
    await page.exposeFunction("readExactTrace", params => readCodexTracePageInWorker(rollout, params));
    await openWebApp(page);
    await page.evaluate(() => {
      window.__traceReads = 0;
      window.AgentHub.on("history:trace-page", ({ tracePage, resolve, reject }) => {
        window.__traceReads += 1;
        window.readExactTrace(tracePage).then(resolve, reject);
      });
    });
    const message = { id: "long-source", ...task, turnId: "turn-long", itemId: "long-item",
      role: "agent", text: "Answer", activityGroups: [preview] };
    await seedMessages(page, [message]);
    await page.locator('[data-message-id="long-source"] details.turn-trace > summary').click();
    await page.locator('[data-message-id="long-source"] .turn-trace-reasoning').waitFor();
    // Execute the actual composer quote path against the persisted DOM preview.
    const annotation = await page.evaluate(async () => {
      const article = document.querySelector('[data-message-id="long-source"]');
      const surface = article.querySelector(".turn-trace-reasoning");
      return responseAnnotationFromSelection({ message: article, surface,
        quote: "Selected exact text.", offsets: { start: 0, end: 20 } });
    });
    assert.ok(annotation?.source);
    assert.equal(await page.evaluate(() => window.__traceReads), 1);
    const quote = { id: "long-quote", role: "user", text: "Check",
      responseAnnotations: [{ ...annotation, text: annotation.quote }] };
    for (const activityGroups of [[preview], []]) {
      await seedMessages(page, [{ ...message, activityGroups }, quote]);
      const readsBefore = await page.evaluate(() => window.__traceReads);
      await page.locator('[data-message-id="long-quote"] [data-response-annotation-source]').click();
      const highlighted = page.locator('[data-message-id="long-source"] .msg-source-citation-highlight');
      await highlighted.waitFor();
      assert.equal(await highlighted.textContent(), annotation.quote);
      assert.equal(await page.evaluate(() => window.__traceReads), readsBefore + 1);
      assert.ok((await page.locator('[data-citation-trace] .turn-trace-reasoning').textContent()).length > 100_000);
    }
    // Same exact ID but changed content cannot be highlighted or silently rebound.
    await writeFile(rollout, raw.replace("Selected exact text.", "Changed exact text."), "utf8");
    await seedMessages(page, [{ ...message, activityGroups: [] }, quote]);
    await page.locator('[data-message-id="long-source"]').evaluate(article => {
      article.querySelector("[data-citation-trace]")?.remove();
    });
    const changedSourceAccepted = await page.locator('[data-message-id="long-quote"] [data-response-annotation-source]')
      .evaluate(button => focusResponseCitationSource(button));
    assert.equal(changedSourceAccepted, false);
    assert.equal(await page.locator(".msg-source-citation-highlight").count(), 0);
    await seedMessages(page, [message]);
    await page.locator('[data-message-id="long-source"] details.turn-trace > summary').click();
    await page.locator('[data-message-id="long-source"] .turn-trace-reasoning').waitFor();
    const changedSelection = await page.evaluate(() => {
      const article = document.querySelector('[data-message-id="long-source"]');
      return responseAnnotationFromSelection({ message: article,
        surface: article.querySelector(".turn-trace-reasoning"),
        quote: "Selected exact text.", offsets: { start: 0, end: 20 } });
    });
    assert.equal(changedSelection, null);
  } finally {
    store?.close();
    await page.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Markdown details safely render historical and new messages with native disclosure and contained JSON", { timeout: 20_000 }, async () => {
  const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    // The routed DOM fixture intentionally has no runtime health/SSE server.
    if (message.text().includes("404 (Not Found)")
      && ["http://127.0.0.1/health", "http://127.0.0.1/events"].includes(message.location().url)) return;
    if (["error", "warning"].includes(message.type())) errors.push(`${message.text()} ${message.location().url}`);
  });
  try {
    await openWebApp(page);
    const json = JSON.stringify({ payload: "x".repeat(360), literal: "</details><script>bad()</script>" }, null, 2);
    const text = [
      "Ответ с подробностями",
      "<details open onclick=bad()>",
      '<summary onmouseover="bad()">Данные **JSON**</summary>',
      "", "Пояснение внутри блока.", "", "- Первый пункт", "- Второй пункт", "",
      "```json", json, "</details>", "```", "",
      "[Опасная ссылка](javascript:bad)", '<img src=x onerror="bad()">',
      "<script>bad()</script>", "</details>", "Текст после блока.",
      "", "```html", "<details><summary>Literal</summary></details>", "```",
    ].join("\n");
    const historical = { id: "details-history", role: "agent", provider: "codex", threadId: "thread-1",
      turnId: "history-turn", itemId: "history-item", text };
    await seedMessages(page, [historical]);
    const details = page.locator('.msg-agent .markdown-details').first();
    assert.equal(await details.count(), 1);
    assert.equal(await details.evaluate((node) => node.open), false);
    assert.equal(await details.locator("summary").textContent(), "Данные JSON");
    assert.equal(await details.locator("summary strong").textContent(), "JSON");
    assert.equal(await details.locator("p").first().isVisible(), false);
    await details.locator("summary").click();
    assert.equal(await details.evaluate((node) => node.open), true);
    assert.equal(await details.locator("li").count(), 2);
    assert.equal(await details.locator("code.language-json").textContent(), `${json}\n</details>`);
    assert.equal(await details.locator("script, img, [onclick], [onmouseover], [onerror], a[href^='javascript:']").count(), 0);
    assert.equal(await page.locator('.msg-agent code.language-html').textContent(), '<details><summary>Literal</summary></details>');
    assert.equal(await page.locator('.msg-agent .msg-body > p').last().textContent(), 'Текст после блока.');
    const next = { ...historical, id: "details-new", turnId: "new-turn", itemId: "new-item", text: '<details><summary>Новый ответ</summary>\nАбзац нового ответа.\n</details>' };
    await seedMessages(page, [historical, next]);
    assert.equal(await details.evaluate((node) => node.open), true);
    assert.equal(await page.locator('.msg-agent .markdown-details').last().evaluate((node) => node.open), false);
    await seedMessages(page, [{ ...historical, text: `${text}\nДополнение того же сообщения.` }, next]);
    assert.equal(await details.evaluate((node) => node.open), true);
    await details.locator("summary").focus();
    await page.keyboard.press("Enter");
    assert.equal(await details.evaluate((node) => node.open), false);
    await page.keyboard.press("Space");
    assert.equal(await details.evaluate((node) => node.open), true);
    for (const width of [1366, 390]) {
      await page.setViewportSize({ width, height: 900 });
      if (width === 390) await page.evaluate(() => window.AgentHub.showSelectedTask());
      // Measure the completed responsive layout, after resize/view paint work.
      await page.evaluate(() => new Promise((resolve) => (
        requestAnimationFrame(() => requestAnimationFrame(resolve))
      )));
      const geometry = await details.locator("pre").evaluate((node) => ({
        wide: node.scrollWidth > node.clientWidth,
        outside: node.getBoundingClientRect().right > innerWidth + 1,
        pageOverflow: document.documentElement.scrollWidth > innerWidth + 1,
      }));
      if (process.env.AGENT_HUB_QA_SCREENSHOT) await page.screenshot({
        path: `${process.env.AGENT_HUB_QA_SCREENSHOT}-details-${width}.png`, fullPage: false,
      });
      const overflow = await page.evaluate(() => ({
        viewport: innerWidth,
        clientWidth: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
        elements: [...document.querySelectorAll("body *")]
          .filter((node) => node.getBoundingClientRect().right > innerWidth + 1)
          .slice(0, 16).map((node) => ({
            tag: node.tagName, classes: String(node.className).slice(0, 160),
            left: node.getBoundingClientRect().left,
            right: node.getBoundingClientRect().right,
            width: node.getBoundingClientRect().width,
          })),
      }));
      assert.deepEqual(geometry, { wide: true, outside: false, pageOverflow: false },
        JSON.stringify({ width, ...overflow }));
    }
    assert.equal(new URL(page.url()).hostname, "127.0.0.1");
    assert.match(await page.title(), /Agent Hub/iu);
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

test("Markdown details nesting and code literals do not consume later ordinary text", { timeout: 20_000 }, async () => {
  const page = await browser.newPage();
  try {
    await openWebApp(page);
    const text = [
      '`<details><summary>inline literal</summary></details>`', '',
      '````html', '<details>', '<summary>fenced literal</summary>', '```', '</details>', '````', '',
      '<details><summary>Внешний</summary>', 'Абзац.',
      '<details>', '<summary>', 'Внутренний', '**блок**', '</summary>', '- Пункт', '</details>',
      'Ещё абзац.', '</details>', 'Обычный текст после обоих блоков.',
    ].join('\n');
    await seedMessages(page, [{ id: 'nested', role: 'agent', text }]);
    const details = page.locator('.msg-agent .markdown-details');
    assert.equal(await details.count(), 2);
    assert.equal(await page.locator('.msg-agent code').first().textContent(), '<details><summary>inline literal</summary></details>');
    assert.equal(await page.locator('.msg-agent code.language-html').textContent(), '<details>\n<summary>fenced literal</summary>\n```\n</details>');
    await details.first().locator(':scope > summary').click();
    assert.equal(await details.last().evaluate((node) => node.open), false);
    await details.last().locator('summary').click();
    assert.match(await details.last().locator('summary').textContent(), /Внутренний\s+блок/u);
    assert.equal(await details.last().locator('li').textContent(), 'Пункт');
    assert.equal(await page.locator('.msg-agent .msg-body > p').last().textContent(), 'Обычный текст после обоих блоков.');
    const deeplyNested = Array(40).fill('<details><summary>Вложенный</summary>').join('\n')
      + '\nСодержимое\n' + Array(40).fill('</details>').join('\n') + '\nПосле глубокой вложенности.';
    await seedMessages(page, [{ id: 'bounded', role: 'agent', text: deeplyNested }]);
    assert.equal(await page.locator('.msg-agent .markdown-details').count(), 32);
    assert.equal(await page.locator('.msg-agent .msg-body > p').last().textContent(), 'После глубокой вложенности.');
  } finally {
    await page.close();
  }
});

test("persisted rotation renders once after missed snapshots and page reload", async () => {
  const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const sourceTask = {
    provider: "codex", streamId: "stream-1", threadId: "thread-old", threadPosition: 37,
    context: { compaction: {
      operationId: "rotation-source-operation", status: "completed", rotated: true,
      beforePercent: 78.408282, afterPercent: 25.770898,
      completedAt: "2026-09-10T20:53:46.990Z",
    } },
  };
  const currentTask = {
    provider: "codex", streamId: "stream-1", threadId: "thread-new", threadPosition: 38,
    context: { percent: 61 },
  };
  const olderTask = {
    ...sourceTask, threadId: "thread-older", threadPosition: 36,
    context: { compaction: {
      ...sourceTask.context.compaction, operationId: "earlier-rotation",
      completedAt: "2026-09-09T20:00:00.000Z",
    } },
  };
  const source = await readFile(new URL("hub-client.js", WEB_APP_ROOT), "utf8");
  const clientFunction = (name, next) => {
    const start = source.indexOf(`function ${name}(`);
    return source.slice(start, source.indexOf(`function ${next}`, start));
  };
  const installProjection = () => page.addScriptTag({ content: `(() => {
    const taskId = () => "task-1";
    const maintenanceEventStorageKey = "rotation-dom-maintenance";
    const { latestMaintenanceMessages } = window.AgentHubMessageLifecycle;
    ${clientFunction("readMaintenanceEvents", "persistMaintenanceEvents")}
    const maintenanceEventsByTask = readMaintenanceEvents();
    let writes = 0;
    const persistMaintenanceEvents = () => {
      writes += 1;
      localStorage.setItem(maintenanceEventStorageKey, JSON.stringify(
        [...maintenanceEventsByTask].flatMap(([taskId, messages]) => (
          messages.map((message) => ({ taskId, message }))
        )),
      ));
    };
    const pendingStreamRotations = new Map();
    const observedContextCompactions = new Map();
    const requestedContextCompactions = new Set();
    const contextPercent = (value) => value == null ? null : Math.round(Number(value));
    const storedMaintenancePercent = () => null;
    const agentHub = { toast: () => {} };
    ${clientFunction("rotationMaintenanceActive", "syncActiveMaintenanceMessages")}
    ${clientFunction("rememberMaintenanceEvent", "taskIdentity")}
    ${clientFunction("observeContextCompactions", "representativeSnapshotTasks")}
    window.rotationProjection = {
      observe: (tasks, previous = []) => {
        observeContextCompactions(tasks);
        observeStreamRotations(previous, tasks);
        return { messages: maintenanceEventsByTask.get("task-1") ?? [], writes };
      },
    };
  })();` });
  try {
    await openWebApp(page);
    const title = await page.title();
    assert.ok(title.trim());
    assert.equal(page.url(), "http://127.0.0.1/");
    for (const reload of [false, true]) {
      if (reload) await page.reload({ waitUntil: "load" });
      await installProjection();
      const snapshotTasks = [sourceTask, currentTask, olderTask];
      const first = await page.evaluate((tasks) => window.rotationProjection.observe(tasks), snapshotTasks);
      const repeated = await page.evaluate((tasks) => window.rotationProjection.observe(tasks, tasks), snapshotTasks);
      assert.equal(first.messages.length, 1);
      assert.deepEqual(repeated.messages, first.messages);
      assert.equal(repeated.writes, first.writes, "unchanged polling does not rewrite the notice");
      if (reload) assert.equal(first.writes, 0, "saved projection retains the same exact event on reload");
      assert.equal(Object.hasOwn(first.messages[0], "afterPercent"), false);
      for (const viewport of [{ width: 1366, height: 900 }, { width: 390, height: 844 }]) {
        await page.setViewportSize(viewport);
        await seedMessages(page, [
          { id: "before", role: "agent", threadId: "thread-old", turnId: "turn-before",
            text: "Ответ до ротации", time: "2026-09-10T20:53:50.000Z" },
          ...first.messages,
          { id: "after", role: "user", threadId: "thread-new", turnId: "turn-after",
            text: "Сообщение после ротации", time: "2026-09-10T20:56:00.000Z" },
        ], currentTask);
        if (viewport.width < 600) await page.evaluate(() => window.AgentHub.showSelectedTask());
        assert.equal(await page.locator(".msg-maintenance").count(), 1);
        assert.match(await page.locator(".msg-maintenance").textContent(), /Ротация завершена/u);
        assert.equal(await page.locator(".msg-agent").count(), 1, "rotation is not a second agent turn");
        const positions = await page.evaluate(() => {
          const marker = document.querySelector(".msg-maintenance");
          const before = document.querySelector(".msg-agent");
          const after = document.querySelector(".msg-user");
          return {
            afterSource: Boolean(before.compareDocumentPosition(marker) & Node.DOCUMENT_POSITION_FOLLOWING),
            beforeTarget: Boolean(marker.compareDocumentPosition(after) & Node.DOCUMENT_POSITION_FOLLOWING),
            visible: marker.getBoundingClientRect().height > 0,
          };
        });
        assert.deepEqual(positions, { afterSource: true, beforeTarget: true, visible: true });
        if (reload && process.env.AGENT_HUB_ROTATION_QA_DIR) {
          await mkdir(process.env.AGENT_HUB_ROTATION_QA_DIR, { recursive: true });
          await page.screenshot({ path: path.join(process.env.AGENT_HUB_ROTATION_QA_DIR, `rotation-${viewport.width}.png`) });
        }
      }
    }
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

test("compaction without provider turn renders a system marker and unknown completion stays explicit", async () => {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await openWebApp(page);
    const source = await readFile(new URL("hub-client.js", WEB_APP_ROOT), "utf8");
    const clientFunction = (name, next) => {
      const start = source.indexOf(`function ${name}(`);
      return source.slice(start, source.indexOf(`function ${next}`, start));
    };
    await page.addScriptTag({ content: `(() => {
      const taskId = () => "task-1";
      const maintenanceEventsByTask = new Map();
      const observedContextCompactions = new Map();
      const requestedContextCompactions = new Set();
      const latestMaintenanceMessages = (values) => values;
      const persistMaintenanceEvents = () => {};
      const contextPercent = (value) => value == null ? null : Number(value);
      const storedMaintenancePercent = () => null;
      const agentHub = { toast: () => {} };
      ${clientFunction("rotationMaintenanceActive", "syncActiveMaintenanceMessages")}
      ${clientFunction("rememberMaintenanceEvent", "taskIdentity")}
      ${clientFunction("observeContextCompactions", "observeStreamRotations")}
      window.compactionProjection = {
        active: activeMaintenanceMessage,
        observe: (task) => {
          observeContextCompactions([task]);
          return maintenanceEventsByTask.get("task-1");
        },
      };
    })();` });
    const marker = await page.evaluate(() => window.compactionProjection.active({
      provider: "codex", threadId: "thread-1",
      context: { compaction: { operationId: "operation-1", status: "running", turnId: null, origin: "automatic" } },
    }));
    await seedMessages(page, [marker]);
    assert.equal(await page.locator(".msg-maintenance").count(), 1);
    assert.match(await page.locator(".msg-maintenance").textContent(), /Автосвёртка контекста/u);
    assert.equal(await page.locator(".msg-agent").count(), 0);
    const preparation = {
      maintenance: { reason: "automatic-post-turn", phase: "preparing", reservationId: "reservation-new" },
      context: { usedTokens: 75.04, modelContextWindow: 100, percent: 75.04, compacting: false,
        compaction: { id: "older", status: "completed", measurementStatus: "completed", afterPercent: 14 } },
    };
    const preparationMarker = await page.evaluate((details) => window.compactionProjection.active({
      provider: "codex", threadId: "thread-1", ...details,
    }), preparation);
    await page.evaluate(() => {
      window.__stops = [];
      window.AgentHub.on("task:stop", (value) => window.__stops.push(value));
    });
    for (const viewport of [{ width: 1366, height: 900 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport);
      await seedMessages(page, [preparationMarker], preparation);
      if (viewport.width < 600) await page.evaluate(() => window.AgentHub.showSelectedTask());
      assert.match(await page.locator(".msg-maintenance").textContent(), /Подготовка обслуживания контекста/u);
      assert.equal(await page.locator(".msg-agent").count(), 0);
      assert.equal(await page.locator("[data-context-label]").textContent(), "подготовка…");
      assert.equal(await page.locator("[data-context-usage]").getAttribute("data-compacting"), null);
      const stop = page.locator("[data-chat-stop]:visible");
      assert.equal(await stop.count(), 1);
      await stop.click();
      await page.locator("[data-context-usage]").click();
      assert.equal(await page.locator("[data-context-usage-compact]").isDisabled(), true);
      await page.locator('[data-context-usage-modal] [data-action="context-usage-close"]').first().click();
      if (process.env.AGENT_HUB_QA_SCREENSHOT) await page.screenshot({
        path: `${process.env.AGENT_HUB_QA_SCREENSHOT}-${viewport.width}.png`, fullPage: true,
      });
    }
    assert.deepEqual(await page.evaluate(() => window.__stops), [{ id: "task-1" }, { id: "task-1" }]);
    await seedMessages(page, [], { ...preparation,
      maintenance: { ...preparation.maintenance, phase: "starting" },
    });
    assert.equal(await page.locator("[data-context-label]").textContent(), "запуск…");
    assert.equal(await page.locator("[data-chat-stop]:visible").count(), 0);
    for (const [compacting, usagePending, expectedLabel] of [
      [true, false, "свёртка…"],
      [true, true, "свёртка…"],
      [false, true, "обновление…"],
    ]) {
      await seedMessages(page, [], { ...preparation, maintenance: null,
        context: { ...preparation.context, compacting, usagePending },
      });
      assert.equal(await page.locator("[data-context-label]").textContent(), expectedLabel);
      assert.equal(await page.locator("[data-context-usage]").getAttribute("data-compacting"), compacting ? "" : null);
    }
    await seedMessages(page, [], { ...preparation, maintenance: null });
    assert.equal(await page.locator("[data-context-label]").textContent(), "75% контекста");
    assert.equal(await page.locator("[data-chat-stop]:visible").count(), 0);
    for (const [status, expectedText] of [
      ["failed", "Автосвёртка контекста не завершилась"],
      ["unknown", "Статус свёртки неизвестен"],
      ["completed", "Свёртка контекста"],
    ]) {
      const messages = await page.evaluate((status) => window.compactionProjection.observe({
        provider: "codex", threadId: "thread-1",
        context: { compaction: {
          operationId: "operation-1", status, turnId: null, origin: "automatic",
          beforePercent: 77, afterPercent: status === "completed" ? 14 : null,
          measurementStatus: status === "completed" ? "completed" : null,
          measurementKind: status === "completed" ? "estimated" : null,
        } },
      }), status);
      await seedMessages(page, messages);
      assert.equal(await page.locator(".msg-maintenance").count(), 1);
      assert.ok((await page.locator(".msg-maintenance").textContent()).includes(expectedText));
      assert.equal(await page.locator(".msg-agent").count(), 0);
      if (status === "completed") {
        for (const viewport of [{ width: 1366, height: 900 }, { width: 390, height: 844 }]) {
          await page.setViewportSize(viewport);
          assert.match(await page.locator(".msg-maintenance").textContent(), /77% → ≈14%/u);
          assert.match(await page.locator(".msg-maintenance").getAttribute("title"), /Предварительная оценка провайдера/u);
        }
        await seedMessages(page, [{ id: "answer-after-compaction", role: "agent", text: "Ответ",
          activities: [{ id: "compaction", type: "compaction", status: "completed",
            label: messages[0].maintenanceLabel, detail: messages[0].maintenanceDetail }],
        }]);
        await page.locator('.msg-agent .activity-feed > summary').click();
        const activity = page.locator('.activity-item[data-type="compaction"]');
        assert.match(await activity.getAttribute("title"), /≈14%.*Предварительная оценка провайдера/u);
      }
    }
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

test("long annotated message mounts full Markdown only while expanded and actions keep original text", async () => {
  const page = await browser.newPage();
  try {
    await openWebApp(page);
    const fullText = `${"Большой пользовательский отчёт без потерь. ".repeat(140)}\n\n[Полный Markdown](https://example.test/full)`;
    await page.evaluate(() => {
      window.__messageEvents = { copies: [], sends: [] };
      window.AgentHub.on("clipboard:write", (detail) => window.__messageEvents.copies.push(detail));
      window.AgentHub.on("message:send", (detail) => window.__messageEvents.sends.push(detail));
    });
    await seedMessages(page, [{
      id: "long-user",
      role: "user",
      author: "Вы",
      text: fullText,
      responseAnnotations: [{ text: "Фрагмент", annotation: "Проверь внимательно" }],
      responseAnnotationRequest: fullText,
    }, {
      id: "agent-answer",
      role: "agent",
      author: "Codex",
      text: "Ответ готов",
    }]);

    const article = page.locator('[data-message-id="long-user"]');
    const disclosure = article.locator("[data-message-disclosure]");
    assert.equal(await article.locator(".msg-deferred-preview").count(), 1);
    assert.ok((await article.locator(".msg-deferred-preview").textContent()).length <= 1_602);
    assert.equal(await article.locator(".msg-annotations").count(), 0);
    assert.equal(await article.locator('a[href="https://example.test/full"]').count(), 0);

    await disclosure.click();
    assert.equal(await article.locator(".msg-deferred-preview").count(), 0);
    assert.equal(await article.locator(".msg-annotations").count(), 1);
    assert.equal(await article.locator('a[href="https://example.test/full"]').count(), 1);

    await disclosure.click();
    assert.equal(await article.locator(".msg-deferred-preview").count(), 1);
    assert.equal(await article.locator(".msg-annotations").count(), 0);
    assert.equal(await article.locator('a[href="https://example.test/full"]').count(), 0);

    await page.locator('.msg-stack:has([data-message-id="long-user"]) [data-message-copy]').click();
    await page.locator('.msg-stack:has([data-message-id="agent-answer"]) [data-message-repeat]').dispatchEvent("click");
    await page.locator('.msg-stack:has([data-message-id="long-user"]) [data-message-edit]').click();
    assert.equal(await page.locator("[data-composer-input]").inputValue(), fullText);
    const events = await page.evaluate(() => window.__messageEvents);
    assert.equal(events.copies[0].text, fullText);
    assert.equal(events.sends[0].text, fullText.trim());
  } finally {
    await page.close();
  }
});

test("completed reasoning and tools exist only while their disclosure is open", async () => {
  const page = await browser.newPage();
  try {
    await openWebApp(page);
    await seedMessages(page, [{
      id: "agent-trace",
      role: "agent",
      author: "Codex",
      text: "Итог",
      activityGroups: [{
        id: "trace-1",
        reasoning: "# Скрытое рассуждение",
        activities: [{
          id: "tool-1",
          type: "tool",
          status: "completed",
          label: "Скрытый инструмент",
          detail: "Результат инструмента",
        }],
      }],
    }]);

    const trace = page.locator('[data-message-id="agent-trace"] details.turn-trace');
    assert.equal(await trace.getAttribute("open"), null);
    assert.equal(await trace.locator(".turn-trace-reasoning").count(), 0);
    assert.equal(await trace.locator(".activity-item").count(), 0);

    await trace.locator(":scope > summary").click();
    await trace.locator(".turn-trace-reasoning").waitFor();
    assert.equal(await trace.locator(".turn-trace-reasoning").textContent(), "Скрытое рассуждение");
    assert.equal(await trace.locator(".activity-item").count(), 1);
    assert.match(await trace.locator(".activity-item").textContent(), /Скрытый инструмент/u);

    await trace.locator(":scope > summary").click();
    await page.waitForFunction(() => !document.querySelector('[data-message-id="agent-trace"] .turn-trace-reasoning'));
    assert.equal(await trace.locator(".turn-trace-reasoning").count(), 0);
    assert.equal(await trace.locator(".activity-item").count(), 0);
    assert.equal(await trace.locator("[data-deferred-disclosure-content]").evaluate((node) => node.childElementCount), 0);
  } finally {
    await page.close();
  }
});

test("triple-click quotes the last paragraph with exact source and rejects foreign selected text", { timeout: 25_000 }, async () => {
  const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await openWebApp(page);
    const message = {
      id: "triple-source", provider: "codex", threadId: "thread-1",
      turnId: "triple-turn", itemId: "triple-item", role: "agent",
      text: "Заголовок\n\nСредний **абзац** сообщения.\n\nПоследний **абзац** с emoji 🦊.",
    };
    await seedMessages(page, [message, {
      ...message, id: "triple-other", turnId: "other-turn", itemId: "other-item", text: "Чужой текст.",
    }]);
    await page.evaluate(() => {
      window.__quoteSends = [];
      window.AgentHub.on("message:send", (detail) => window.__quoteSends.push(detail));
    });
    const body = page.locator('[data-message-id="triple-source"] .msg-body');
    const menu = page.locator("[data-annotation-context-menu]");
    for (const [index, expected] of [[1, "Средний абзац сообщения."], [2, "Последний абзац с emoji 🦊."]]) {
      const paragraph = body.locator("p").nth(index);
      await paragraph.click({ clickCount: 3, position: { x: 20, y: 8 } });
      assert.equal((await page.evaluate(() => getSelection().toString())).trim(), expected);
      if (index === 2) assert.equal(await body.evaluate((node) => (
        node.contains(getSelection().getRangeAt(0).endContainer)
      )), false, "exercise the native paragraph boundary outside the source");
      await paragraph.click({ button: "right", position: { x: 20, y: 8 } });
      await menu.waitFor({ state: "visible" });
      if (index === 2 && process.env.AGENT_HUB_QA_SCREENSHOT) await page.screenshot({
        path: `${process.env.AGENT_HUB_QA_SCREENSHOT}-triple-click.png`, fullPage: false,
      });
      await menu.locator('[data-action="annotate-selection"]').click();
      await page.waitForFunction((count) => document.querySelectorAll("[data-annotations] .annotation-quote").length === count, index);
      assert.equal(await page.locator("[data-annotations] .annotation-quote").last().textContent(), expected);
    }
    // Neither a second source nor selected action labels may be clipped away.
    for (const endKind of ["message", "control"]) {
      await page.evaluate((endKind) => {
        const start = document.querySelector('[data-message-id="triple-source"] .msg-body p:last-child');
        const end = endKind === "message"
          ? document.querySelector('[data-message-id="triple-other"] .msg-body p')
          : document.querySelector('.msg-stack:has([data-message-id="triple-source"]) [data-message-copy]');
        const range = document.createRange();
        range.setStart(start.firstChild, 0);
        range.setEnd(end, end.childNodes.length);
        getSelection().removeAllRanges();
        getSelection().addRange(range);
      }, endKind);
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await body.dispatchEvent("contextmenu", { button: 2 });
      assert.equal(await menu.isVisible(), false);
      assert.equal(await page.locator("[data-annotations] .annotation-quote").count(), 2);
    }
    await page.locator("[data-composer-input]").fill("Проверь цитаты");
    await page.locator("[data-composer-input]").press("Enter");
    await page.waitForFunction(() => window.__quoteSends.length === 1);
    const verified = await page.evaluate(async (message) => {
      const api = window.AgentHubMessageDisclosure;
      const surface = document.querySelector('[data-message-id="triple-source"] .msg-body');
      return Promise.all(window.__quoteSends[0].annotations.map(async ({ quote, source }) => {
        const range = api.domRangeFromOffsets(surface, source.start, source.end);
        return {
          quote, exact: range.toString() === quote,
          identity: source.messageKey === api.responseAnnotationSourceIdentity(message).messageKey,
          hashes: api.responseAnnotationSourceHashesMatch(source, {
            contentHash: await api.responseAnnotationSha256(api.responseAnnotationSourceContent(message)),
            surfaceHash: await api.responseAnnotationSha256(surface.textContent),
            selectionHash: await api.responseAnnotationSha256(quote),
          }),
        };
      }));
    }, message);
    assert.deepEqual(verified, ["Средний абзац сообщения.", "Последний абзац с emoji 🦊."].map((quote) => (
      { quote, exact: true, identity: true, hashes: true }
    )));
    assert.match(await page.title(), /Agent Hub/iu);
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

test("citation navigation materializes a deferred source before range lookup", async () => {
  const page = await browser.newPage();
  try {
    await openWebApp(page);
    const selectedText = "ЦЕЛЕВОЙ ФРАГМЕНТ В КОНЦЕ";
    const sourceText = `${"Длинный исходный текст. ".repeat(220)}${selectedText}`;
    await page.evaluate(async ({ selectedText, sourceText }) => {
      const message = {
        id: "source-user",
        provider: "codex",
        threadId: "thread-1",
        turnId: "turn-source",
        itemId: "item-source",
        role: "user",
        author: "Вы",
        text: sourceText,
      };
      const disclosure = window.AgentHubMessageDisclosure;
      const identity = disclosure.responseAnnotationSourceIdentity(message);
      const start = sourceText.indexOf(selectedText);
      const source = {
        version: 1,
        ...identity,
        surfaceKind: "message-body",
        surfaceIndex: 0,
        start,
        end: start + selectedText.length,
        contentHash: await disclosure.responseAnnotationSha256(
          disclosure.responseAnnotationSourceContent(message),
        ),
        surfaceHash: await disclosure.responseAnnotationSha256(sourceText),
        selectionHash: await disclosure.responseAnnotationSha256(selectedText),
      };
      window.AgentHub.setWorkspaces([{ id: "workspace-1", name: "Agent HUB", title: "Agent HUB" }]);
      window.AgentHub.setTasks([{
        id: "task-1",
        threadId: "thread-1",
        workspaceId: "workspace-1",
        workspaceName: "Agent HUB",
        streamId: "stream-1",
        streamName: "Chat",
        streamOrdinal: 1,
        title: "Chat",
        provider: "codex",
        agentLabel: "Codex",
        modelLabel: "Sol",
        status: "ready",
        statusLabel: "Готов",
        selected: true,
      }]);
      window.AgentHub.setMessages("task-1", [message, {
        id: "annotation-user",
        role: "user",
        author: "Вы",
        text: "Проверь источник",
        responseAnnotations: [{
          text: selectedText,
          annotation: "Проверить точный источник",
          source,
        }],
        responseAnnotationRequest: "Проверь источник",
      }]);
    }, { selectedText, sourceText });
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));

    const sourceArticle = page.locator('[data-message-id="source-user"]');
    assert.equal(await sourceArticle.locator(".msg-deferred-preview").count(), 1);
    assert.equal((await sourceArticle.locator(".msg-body").textContent()).includes(selectedText), false);
    await page.locator('[data-message-id="annotation-user"] [data-response-annotation-source]').click();
    await sourceArticle.locator(".msg-source-citation-highlight").waitFor();
    assert.equal(await sourceArticle.locator(".msg-deferred-preview").count(), 0);
    assert.equal(await sourceArticle.locator(".msg-body").getAttribute("data-response-citation-source-focus"), "");
    assert.equal(await sourceArticle.locator(".msg-source-citation-highlight").textContent(), selectedText);
  } finally {
    await page.close();
  }
});

test("active commentary quote survives an exact group rerender while full source read is pending",{timeout:25000},async()=>{
  const page=await browser.newPage({viewport:{width:1366,height:850}});
  try {
    await openWebApp(page); await seedMessages(page,[],{running:true,status:'running'});
    const live={provider:'codex',threadId:'thread-1',turnId:'active-turn',itemId:'active-item',author:'Agent',text:'',
      activityGroups:[{id:'commentary:1',reasoning:'Сервисные карточки релизов остались открыты с устаревшими записями.',activities:[]}]};
    await page.evaluate(live=>{
      window.__activeQuoteLive=live;
      window.AgentHub.on('history:trace-page',({resolve})=>{window.__resolveActiveQuote=resolve;});
      window.AgentHub.setLive('task-1',live);
    },live);
    await page.locator('[data-live-trace] .turn-trace-reasoning').waitFor();
    await page.evaluate(()=>{
      const surface=document.querySelector('[data-live-trace] .turn-trace-reasoning');
      const message=surface.closest('[data-role]');
      window.__activeQuoteResult=responseAnnotationFromSelection({message,surface,quote:surface.textContent.trim(),offsets:{start:0,end:surface.textContent.trim().length}});
    });
    assert.equal(await page.evaluate(()=>typeof window.__resolveActiveQuote),'function');
    await page.evaluate(()=>{
      window.AgentHub.setLive('task-1',{...window.__activeQuoteLive,activityGroups:[...window.__activeQuoteLive.activityGroups,{id:'commentary:2',reasoning:'Next stage',activities:[]}]});
      window.__resolveActiveQuote({groups:window.__activeQuoteLive.activityGroups});
    });
    const result=await page.evaluate(()=>window.__activeQuoteResult);
    assert.ok(result?.source,'unchanged exact commentary must remain quotable after a neighboring group rerender');
    assert.equal(result.source.traceGroupId,'commentary:1'); assert.equal(result.source.itemId,'active-item');
    assert.equal(result.quote,live.activityGroups[0].reasoning);
  } finally {await page.close();}
});

test("active quote binds native reasoning before response item and survives draft send completed history and reload",{timeout:25000},async()=>{
  const group=codexTraceEntry({type:'response_item',payload:{type:'reasoning',id:'native-reasoning-source',summary:[{type:'summary_text',text:'Current **exact** commentary 🦊.'}]}});
  for(const width of [1366,390]) {
    const page=await browser.newPage({viewport:{width,height:850}}); page.setDefaultTimeout(4000);
    try {
      await openWebApp(page);await seedMessages(page,[],{running:true,status:'running'});
      if(width===390) await page.evaluate(()=>window.AgentHub.showSelectedTask());
      const live={provider:'codex',threadId:'thread-1',turnId:'quote-turn',itemId:null,author:'Agent',text:'',activityGroups:[group]};
      await page.evaluate(live=>{
        window.__quoteLive=live;window.__quoteSends=[];
        window.AgentHub.on('message:send',detail=>window.__quoteSends.push(detail));
        window.AgentHub.on('history:trace-page',({identity,tracePage,resolve})=>{window.__nativeQuoteRequest={identity,tracePage};window.__nativeQuoteResolve=resolve;});
        window.AgentHub.setLive('task-1',live);
      },live);
      await page.locator('[data-live-trace] .turn-trace-reasoning').waitFor();
      await page.evaluate(()=>{
        const surface=document.querySelector('[data-live-trace] .turn-trace-reasoning');
        const api=window.AgentHubMessageDisclosure;const range=api.domRangeFromOffsets(surface,0,surface.textContent.length);
        getSelection().removeAllRanges();getSelection().addRange(range);
        window.__nativeQuotePending=addAnnotation(selectedQuotableSelection());
      });
      assert.equal(await page.evaluate(()=>typeof window.__nativeQuoteResolve),'function');
      await page.evaluate(()=>{
        window.AgentHub.setLive('task-1',{...window.__quoteLive,itemId:'later-answer-item',text:'Later answer',activityGroups:[...window.__quoteLive.activityGroups,{id:'reasoning:next',sourceItemId:'next',reasoning:'Next stage',activities:[]}]});
        window.__nativeQuoteResolve({groups:window.__quoteLive.activityGroups});
      });
      assert.equal(await page.evaluate(()=>window.__nativeQuotePending),true);
      assert.equal(await page.locator('[data-annotations] .annotation-quote').textContent(),'Current exact commentary 🦊.');
      await page.locator('[data-annotation-comment-index="0"]').fill('Verify this exact source');
      await page.locator('[data-composer-input]').fill('Check'); await page.locator('[data-composer-input]').press('Enter');
      await page.waitForFunction(()=>window.__quoteSends.length===1);
      const sent=await page.evaluate(()=>window.__quoteSends[0]);const annotation=sent.annotations[0];
      assert.equal(annotation.source.itemId,'native-reasoning-source');assert.equal(annotation.source.traceGroupId,group.id);
      assert.equal(annotation.source.turnId,'quote-turn');assert.equal(annotation.source.provider,'codex');
      const verified=await page.evaluate(async({group,annotation})=>{
        const api=window.AgentHubMessageDisclosure;const message={provider:'codex',threadId:'thread-1',turnId:'quote-turn',itemId:'later-answer-item',role:'agent',activityGroups:[group]};
        const surface=document.querySelector('[data-live-trace] .turn-trace-reasoning');
        return api.responseAnnotationSourceHashesMatch(annotation.source,{contentHash:await api.responseAnnotationSha256(api.responseAnnotationSourceContent(message,annotation.source)),surfaceHash:await api.responseAnnotationSha256(surface.textContent),selectionHash:await api.responseAnnotationSha256(annotation.quote)});
      },{group,annotation});assert.equal(verified,true);
      const source={id:'completed-source',provider:'codex',threadId:'thread-1',turnId:'quote-turn',itemId:'later-answer-item',role:'agent',text:'Completed',activityGroups:[group]};
      const user={id:'quoted-user',role:'user',provider:'codex',threadId:'thread-1',turnId:'next-turn',itemId:'user-item',text:'Check',responseAnnotations:[{text:annotation.quote,annotation:annotation.annotation,source:annotation.source}]};
      const projection=codexAssistantResponseProjection(':codex-annotation{index="1"} Verified');
      const answer={id:'linked-answer',role:'agent',provider:'codex',threadId:'thread-1',turnId:'next-turn',itemId:'answer-item',...projection};
      await page.reload();await page.waitForFunction(()=>window.AgentHub);
      await seedMessages(page,[source,user,answer]);if(width===390) await page.evaluate(()=>window.AgentHub.showSelectedTask());
      await page.evaluate(group=>window.AgentHub.on('history:trace-page',({resolve})=>resolve({groups:[group]})),group);
      await page.locator('[data-message-id="linked-answer"] [data-response-citation-index="1"]').click();
      await page.locator('[data-message-id="quoted-user"] .is-citation-target').waitFor();
      await page.locator('[data-message-id="quoted-user"] [data-response-annotation-source]').click();
      await page.locator('[data-message-id="completed-source"] .msg-source-citation-highlight').first().waitFor();
      assert.equal((await page.locator('[data-message-id="completed-source"] .msg-source-citation-highlight').allTextContents()).join(''),annotation.quote);
      if(process.env.AGENT_HUB_QA_SCREENSHOT) await page.screenshot({path:`${process.env.AGENT_HUB_QA_SCREENSHOT}-active-quote-${width}.png`});
    } finally {await page.close();}
  }
});

test("active quote refuses missing foreign changed and mismatched sources with bounded payload-free reasons",{timeout:20000},async()=>{
  const page=await browser.newPage();
  try {
    await openWebApp(page);await seedMessages(page,[],{running:true,status:'running'});
    const results=await page.evaluate(async()=>{
      const events=[];window.AgentHubCommandTrace.bindReporter(async({events:batch})=>events.push(...batch));
      const group={id:'reasoning:native',sourceItemId:'native',reasoning:'Private selected content',activities:[]};
      const original={provider:'codex',threadId:'thread-1',turnId:'active-turn',itemId:null,text:'',activityGroups:[group]};
      let resolve,reject;window.AgentHub.on('history:trace-page',p=>{resolve=p.resolve;reject=p.reject;});
      const refusals=[];
      for(const kind of ['missing','foreign','changed-surface','new-native-item','wrong-page-item','wrong-group','wrong-range','read-failed']) {
        resolve=reject=null;
        const live=kind==='missing'?{...original,activityGroups:[{id:group.id,reasoning:group.reasoning,activities:[]}]}:original;
        window.AgentHub.setLive('task-1',live);
        const surface=document.querySelector('[data-live-trace] .turn-trace-reasoning');
        const promise=responseAnnotationFromSelection({message:surface.closest('[data-role]'),surface,quote:group.reasoning,offsets:{start:0,end:group.reasoning.length-(kind==='wrong-range'?1:0)}});
        if(resolve) {
          if(kind==='foreign')window.AgentHub.setLive('task-1',{...live,turnId:'foreign-turn'});
          if(kind==='changed-surface')window.AgentHub.setLive('task-1',{...live,activityGroups:[{...group,reasoning:'Changed private content'}]});
          if(kind==='new-native-item')window.AgentHub.setLive('task-1',{...live,activityGroups:[{...group,sourceItemId:'replacement'}]});
          if(kind==='read-failed')reject(new Error('private dependency details'));
          else resolve({groups:[{...group,...(kind==='wrong-page-item'?{sourceItemId:'foreign'}:{}),...(kind==='wrong-group'?{id:'foreign-group'}:{})}]});
        }
        refusals.push({kind,result:await promise});
      }
      for(let batch=0;batch<16;batch++) {
        await window.AgentHubCommandTrace.flush();
        const state=window.AgentHubCommandTrace.diagnostics();
        if(!state.pending&&!state.flushing)break;
      }
      return {refusals,events:events.filter(e=>e.metadata?.action==='annotation-source'),draftCount:document.querySelectorAll('[data-annotations] .annotation-quote').length};
    });
    assert.equal(results.draftCount,0);assert.ok(results.refusals.every(x=>x.result===null));
    assert.equal(results.events.length,8);
    const spans=clientPerformanceTraceSpans({events:results.events});
    assert.deepEqual(spans.map(x=>x.metadata.decision),['source-unavailable','source-replaced','source-replaced','source-replaced','source-item-mismatch','source-group-mismatch','selected-range-mismatch','source-read-failed']);
    assert.ok(spans.every(x=>x.outcome==='failed'));
    assert.doesNotMatch(JSON.stringify(results.events),/Private selected|Changed private|dependency details/u);
  } finally {await page.close();}
});
