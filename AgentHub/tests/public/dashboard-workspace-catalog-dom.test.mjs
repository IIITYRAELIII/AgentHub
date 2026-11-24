import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
const { loadThemeRegistry } = createRequire(import.meta.url)("../../theme-registry.cjs");
const themeRegistry = loadThemeRegistry(fileURLToPath(new URL("../../assets/web-app/", import.meta.url)));
const base = fileURLToPath(new URL("../../WIP/dashboard-catalog-runs/", import.meta.url));
await mkdir(base, { recursive: true });
const output = await mkdtemp(path.join(base, "run-"));
console.log("Catalog evidence:", output);
import { launchBrowser, openFixture, snapshot } from "./composer-production.fixture.mjs";

test("Dashboard uses the Dialogs catalog order instead of the board column order", async () => {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await openFixture(page);
    await page.evaluate(() => {
      const workspaces = [
        { id: "z", name: "Янтарь", settings: { catalogFolder: "Команда" }, streams: [] },
        { id: "a", name: "Альфа", settings: { catalogFolder: "Команда" }, streams: [] },
        { id: "free", name: "Без папки", settings: {}, streams: [] },
      ];
      document.documentElement.dataset.view = "dashboard";
      window.AgentHubTaskBoard.setSnapshot({ workspaces, tasks: [], columnOrder: ["workspace:z", "workspace:free", "workspace:a"] });
    });
    assert.deepEqual(await page.locator('[data-task-board-scopes] [data-board-scope^="workspace:"]').evaluateAll(
      nodes => nodes.map(node => node.dataset.boardScope)), ["workspace:a", "workspace:z", "workspace:free"]);
  } finally { await browser.close(); }
});

function catalogSeedData() {
    const longName = "Очень длинное имя воркспейса для проверки полного названия и многоточия";
    const workspaces = [
      { id: "z", name: "Янтарь", settings: { catalogFolder: "Команда" }, streams: [] },
      { id: "a", name: "Альфа", settings: { catalogFolder: "Команда" }, streams: [] },
      { id: "long", name: longName, settings: { catalogFolder: "Другие проекты с длинным названием" }, streams: [] },
      { id: "active", name: "Активный", settings: {}, streams: [] },
      { id: "zero", name: "Нулевой", settings: {}, streams: [] },
    ];
    const navigation = workspaces.map(w => ({ id: `nav-${w.id}`, workspaceId: w.id,
      workspaceName: w.name, workspaceSettings: w.settings, provider: "codex", threadId: `thread-${w.id}`,
      streamId: `stream-${w.id}`, streamName: "Поток", title: w.name,
      lastActivity: w.id === "active" ? new Date().toISOString() : "2020-01-01T00:00:00Z", running: false }));
    const card = (id, workspaceId, status = "open", bucket = "workspace") => ({ id,
      taskNumber: `QA-${id}`, title: `Задача ${id}`, description: "", bucket, workspaceId,
      workflowStatus: "new", status, revision: 1, attachments: [], checklist: [] });
    Object.assign(navigation.find(n=>n.workspaceId==='active'),{id:'stream-a',streamId:'stream-a',threadId:'thread-a'});
    const tasks = [card("a1", "a"), card("z1", "z"), card("z2", "z"),
      card("closed", "a", "done"), ...Array.from({ length: 100 }, (_, n) => card(`long${n}`, "long"))];
    return { workspaces, tasks, workspaceNavigation: navigation,
      folderNames: ["Пустая", "Команда", "Другие проекты с длинным названием"],
      columnOrder: ["workspace:z", "workspace:a", "workspace:long"] };
}
function catalogFixture() {
  const data=snapshot(), d=catalogSeedData();
  const active=d.workspaceNavigation.find(n=>n.workspaceId==='active');
  Object.assign(active,{id:'stream-a',streamId:'stream-a',threadId:'thread-a'});
  data.workspaces=d.workspaces; data.boardTasks=d.tasks; data.tasks=d.workspaceNavigation;
  return data;
}
async function seed(page) {
  await page.waitForFunction(()=>window.AgentHubTaskBoard && document.querySelector('[data-board-scope="workspace:a"]'));
  await page.evaluate(data => {
    window.__catalogData=data;
    window.__applyCatalog = () => {
      const d = window.__catalogData;
      window.__agentHubFixture.snapshot.workspaces = d.workspaces;
      window.__agentHubFixture.snapshot.boardTasks = d.tasks;
      window.__agentHubFixture.snapshot.tasks = d.workspaceNavigation;
      window.__agentHubFixture.snapshot.version = crypto.randomUUID();
      window.AgentHub.setWorkspaces(d.workspaces);
      window.AgentHub.setTasks(d.workspaceNavigation);
      window.AgentHubTaskBoard.setSnapshot(structuredClone(d));
    };
    window.__applyCatalog();
    document.querySelector('[data-view-button="dashboard"]').click();
    window.__catalogActions = [];
    document.addEventListener("agenthub:board-action", e => window.__catalogActions.push(e.detail));
  }, catalogSeedData());
}

async function openCatalog(page, width) {
  if (width < 960 && !await page.locator('[data-task-board-scope-popover]').evaluate(n => n.matches(':popover-open'))) {
    await page.locator('[data-task-board-scope-trigger]').click();
    await page.waitForFunction(() => document.querySelector('[data-task-board-scope-trigger]').getAttribute('aria-expanded') === 'true');
  }
}

async function counts(page) {
  return page.locator('[data-task-board-scopes] [data-board-scope]').evaluateAll(nodes => Object.fromEntries(nodes.map(n => [n.dataset.boardScope, Number(n.querySelector('.task-workspace-folder-count').textContent)])));
}

async function checkCounts(page) {
  const actual = await counts(page);
  const expected = await page.evaluate(() => {
    const closed = document.querySelector('[data-task-board-completed-toggle]').getAttribute('aria-pressed') === 'true';
    const d = window.__catalogData;
    const source = d.tasks.filter(t => (t.status === 'done') === closed);
    return Object.fromEntries(d.workspaces.map(w => [`workspace:${w.id}`, source.filter(t => t.bucket === 'workspace' && t.workspaceId === w.id).length]));
  });
  for (const [key, value] of Object.entries(expected)) assert.equal(actual[key], value, key);
  assert.equal(actual['folder:Команда'], actual['workspace:a'] + actual['workspace:z']);
  assert.equal(actual['folder:Другие проекты с длинным названием'], actual['workspace:long']);
  assert.equal(actual['folder:Пустая'], 0);
}

async function metrics(page) {
  return page.evaluate(() => {
    const nav = document.querySelector('[data-task-board-scopes]');
    const rect = n => n?.getBoundingClientRect().toJSON();
    const canvas = document.createElement('canvas'), ctx = canvas.getContext('2d', { willReadFrequently: true });
    canvas.width = canvas.height = 1;
    const rgba = c => { ctx.clearRect(0,0,1,1); ctx.fillStyle=c; ctx.fillRect(0,0,1,1); const v=[...ctx.getImageData(0,0,1,1).data]; v[3]/=255; return v; };
    const over = (a,b) => [...a.slice(0,3).map((v,i) => v*a[3]+b[i]*(1-a[3])),1];
    const bg = n => { if (!n) return rgba(getComputedStyle(document.documentElement).getPropertyValue('--bg')); const c=rgba(getComputedStyle(n).backgroundColor); return c[3]===1?c:over(c,bg(n.parentElement)); };
    const lum = a => a.slice(0,3).map(v => v/255).map(v => v<=.04045?v/12.92:((v+.055)/1.055)**2.4).reduce((s,v,i)=>s+v*[.2126,.7152,.0722][i],0);
    const ratio = (a,b) => (Math.max(lum(a),lum(b))+.05)/(Math.min(lum(a),lum(b))+.05);
    const sample = n => { const s=getComputedStyle(n); const c=rgba(s.color); c[3]*=Number(s.opacity); return { text: n.textContent, foreground:s.color, background:bg(n), ratio: ratio(over(c,bg(n)),bg(n)) }; };
    const nodes = [...nav.querySelectorAll('button')].filter(n=>n.checkVisibility());
    return { surface:document.documentElement.dataset.surface, nav: rect(nav),
      overflow: Math.max(0,nav.scrollWidth-nav.clientWidth), pageOverflow: Math.max(0,document.documentElement.scrollWidth-innerWidth),
      targets:nodes.map(n=>({ key:n.dataset.boardScope??n.dataset.boardFolderToggle, rect:rect(n) })),
      text:[...nav.querySelectorAll('.task-workspace-name,.task-workspace-folder-name,.task-workspace-folder-count')].filter(n=>n.checkVisibility()).map(sample),
      icons: [...nav.querySelectorAll('svg')].filter(n=>n.checkVisibility()).map(sample),
      focus: nodes.filter(n=>n.matches(':focus-visible')).map(n=>({ color:getComputedStyle(n).outlineColor, ratio:ratio(rgba(getComputedStyle(n).outlineColor),bg(n)), width:getComputedStyle(n).outlineWidth })),
      rows: [...nav.querySelectorAll('.task-workspace-item,.task-workspace-folder-summary')].filter(n=>n.checkVisibility()).map(n=>({ rect:rect(n), padding:getComputedStyle(n).padding,
        name:rect(n.querySelector('.task-workspace-name,.task-workspace-folder-name')), badge:rect(n.querySelector('.task-workspace-folder-count')),
        caret:rect(n.querySelector('.task-workspace-folder-icon')), icon:rect(n.querySelector('.task-workspace-folder-glyph')) })),
    };
  });
}

async function canonicalGeometry(page) {
  await page.evaluate(() => document.querySelector('[data-view-button="chat"]').click());
  const drawerButton=page.locator('[data-mobile-workspaces-open]');
  if(await drawerButton.isVisible()) await drawerButton.click();
  const data=await page.evaluate(()=>{
    const list=document.querySelector('[data-task-list]');
    const rect=n=>n?.getBoundingClientRect().toJSON();
    const row=[...list.querySelectorAll('.task-workspace-folder-summary')].find(n=>n.querySelector('.task-workspace-folder-name').textContent==='Команда');
    const workspace=list.querySelector('[data-workspace-id="a"]');
    const sample=n=>n?{rect:rect(n),padding:getComputedStyle(n).padding,font:getComputedStyle(n).font,
      name:rect(n.querySelector('.task-workspace-folder-name,.task-workspace-name')),
      badge:rect(n.querySelector('.task-workspace-folder-count')),
      caret:rect(n.querySelector('.task-workspace-folder-icon')),glyph:rect(n.querySelector('.task-workspace-folder-glyph'))}:null;
    return {folder:sample(row),workspace:sample(workspace),nested:rect(workspace?.parentElement),
      tokens:[...list.children].flatMap(n=>n.dataset.workspaceFolder?[n.dataset.workspaceFolder,...[...n.querySelectorAll('[data-workspace-id]')].map(w=>`workspace:${w.dataset.workspaceId}`)]:n.dataset.workspaceId?[`workspace:${n.dataset.workspaceId}`]:[])};
  });
  if(await page.locator('[data-mobile-workspace-drawer]').evaluate(n=>n.open)) await page.keyboard.press('Escape');
  await page.evaluate(()=>document.querySelector('[data-view-button="dashboard"]').click());
  return data;
}

for (const surface of [
  { name:'web-1280', width:1280, host:'web' },
  { name:'webview-520', width:520, host:'vscode' }, { name:'webview-390', width:390, host:'vscode' },
  ...[430,390,320].map(width=>({ name:`mobile-${width}`, width, host:'web', touch:true })),
]) test(`read-only catalog, counts, keyboard and captures: ${surface.name}`, { timeout:120000 }, async () => {
  const browser=await launchBrowser();
  try {
    const page=await browser.newPage({ viewport:{width:surface.width,height:900},hasTouch:Boolean(surface.touch),isMobile:Boolean(surface.touch) });
    page.setDefaultTimeout(5000);
    await page.addInitScript(()=>{for(const host of ['web','vscode']) localStorage.setItem(`agent-hub:workspace-folders:v1:${host}`,JSON.stringify(['Пустая']));});
    await openFixture(page,{surface:surface.host,themeRegistry,fixtureSnapshot:catalogFixture(),expectedTaskId:null});
    await seed(page);
    for (const theme of ['nebula','orange']) {
      await page.locator('[data-theme-select]').evaluate((n,id)=>{n.value=id;n.dispatchEvent(new Event('change',{bubbles:true}));},theme);
      const canonical=await canonicalGeometry(page);
      await openCatalog(page,surface.width);
      const nav=page.locator('[data-task-board-scopes]');
      assert.equal(await nav.count(),1);
      assert.equal(await page.locator('[data-task-board-scope-select]').count(),0);
      assert.equal(await nav.locator('[draggable], [data-board-destination], [data-workspace-select], [data-workspace-menu], input, select').count(),0);
      const order=await nav.locator('[data-board-scope^="workspace:"]').evaluateAll(nodes=>nodes.map(n=>n.dataset.boardScope));
      assert.deepEqual(order,['workspace:active','workspace:long','workspace:a','workspace:z','workspace:zero']);
      await checkCounts(page);
      const shot=async label=>page.screenshot({path:path.join(output,`${surface.name}-${theme}-${label}.png`),animations:'disabled',caret:'hide'});
      await shot('expanded');
      const comparison=await page.evaluate(canonical=>{
        const nav=document.querySelector('[data-task-board-scopes]');
        const row=nav.querySelector('[data-board-folder="folder:Команда"] .task-workspace-folder-summary');
        const workspace=nav.querySelector('[data-board-scope="workspace:a"]');
        const rect=n=>n?.getBoundingClientRect().toJSON();
        const sample=n=>({rect:rect(n),padding:getComputedStyle(n).padding,font:getComputedStyle(n).font,
          name:rect(n.querySelector('.task-workspace-folder-name,.task-workspace-name')),badge:rect(n.querySelector('.task-workspace-folder-count')),
          caret:rect(n.querySelector('.task-workspace-folder-icon')),glyph:rect(n.querySelector('.task-workspace-folder-glyph'))});
        const toggle=row.querySelector('[data-board-folder-toggle]'), navigation=row.querySelector('[data-board-scope]');
        const t=rect(toggle), n=rect(navigation);
        const at=(x,y)=>document.elementFromPoint(x,y)?.closest('button')?.dataset;
        return {canonical,dashboard:{folder:sample(row),workspace:sample(workspace),nested:rect(workspace.parentElement.parentElement)},
          split:{toggle:t,navigation:n,gap:n.left-t.right,
            disclosureHit:at(t.x+t.width/2,t.y+t.height/2)?.boardFolderToggle,
            navigationHit:at(n.x+n.width/2,n.y+n.height/2)?.boardScope,
            seamHit:at(t.right+(n.left-t.right)/2,t.y+t.height/2)?.boardScope??null,
            rightRegionHit:[8,24,44].map(inset=>at(n.right-inset,n.y+n.height/2)?.boardScope)},
          projection:(()=>{
            const d=window.__catalogData;
            const groups=window.AgentHubStreamTabs.workspaceCatalogGroups(d.workspaces,d.workspaceNavigation);
            const projection=window.AgentHubStreamTabs.workspaceSections(groups,{nowMs:Date.parse(d.workspaceNavigation.find(g=>g.workspaceId==='active').lastActivity)+60000,folderNames:d.folderNames});
            const tokens=[...projection.active.map(g=>`workspace:${g.id}`),...projection.catalog.flatMap(e=>e.type==='workspace'?[`workspace:${e.group.id}`]:[e.key,...e.items.map(g=>`workspace:${g.id}`)])];
            const actual=[...nav.querySelector('.task-board-workspace-catalog').children].flatMap(e=>e.dataset.boardFolder?[e.dataset.boardFolder,...[...e.querySelectorAll('[data-board-scope^="workspace:"]')].map(w=>w.dataset.boardScope)]:[e.querySelector('[data-board-scope]').dataset.boardScope]);
            return {tokens,actual};
          })()};
      },canonical);
      assert.deepEqual(comparison.projection.actual,comparison.projection.tokens);
      assert.deepEqual(comparison.canonical.tokens,comparison.projection.tokens);
      assert.equal(comparison.split.disclosureHit,'folder:Команда');
      assert.equal(comparison.split.navigationHit,'folder:Команда');
      assert.equal(comparison.split.seamHit,null);
      assert.deepEqual(comparison.split.rightRegionHit,['folder:Команда','folder:Команда','folder:Команда']);
      const c=comparison.canonical, d=comparison.dashboard;
      assert.ok(Math.abs(c.workspace.rect.height-d.workspace.rect.height)<1 || surface.host==='vscode' && surface.width<960);
      assert.ok(Math.abs((c.workspace.rect.left-c.folder.rect.left)-(d.workspace.rect.left-d.folder.rect.left))<1);
      if(surface.width>=960) assert.ok(Math.abs(c.folder.rect.height-d.folder.rect.height)<1);
      if(surface.touch) {
        const delta=(c.folder.rect.right-c.folder.badge.right)-(d.folder.rect.right-d.folder.badge.right);
        assert.ok(Math.abs(delta-48)<1); comparison.folderCountRightDelta=delta;
      }
      if(surface.width<960) {
        assert.equal(comparison.split.toggle.width,44); assert.equal(comparison.split.toggle.height,44);
        assert.equal(comparison.split.gap,4); assert.equal(comparison.dashboard.folder.rect.height,44);
      } else assert.ok(comparison.split.toggle.width>=24&&comparison.split.toggle.height>=24);
      await writeFile(path.join(output,`${surface.name}-${theme}-comparison.json`),JSON.stringify(comparison,null,2));

      const toggle=nav.locator('[data-board-folder-toggle="folder:Команда"]');
      await toggle.focus(); await page.keyboard.press('Enter');
      assert.equal(await toggle.getAttribute('aria-expanded'),'false');
      await shot('collapsed');
      const focusBefore=await page.evaluate(()=>document.activeElement.dataset.boardFolderToggle);
      const scrollBefore=await nav.evaluate(n=>n.scrollTop);
      for (const mutation of ['create','same-folder','cross-folder','to-backlog','from-backlog','to-notes','from-notes','close','delete','delete-closed']) {
        await page.evaluate(m=>{
          const d=window.__catalogData;
          if(m==='create') d.tasks.push({ ...d.tasks[0],id:'created',status:'open' });
          if(m==='same-folder') d.tasks.find(t=>t.id==='created').workspaceId='z';
          if(m==='cross-folder') d.tasks.find(t=>t.id==='created').workspaceId='long';
          if(m==='to-backlog'||m==='to-notes') Object.assign(d.tasks.find(t=>t.id==='created'),{bucket:m==='to-backlog'?'backlog':'notes',workspaceId:null});
          if(m==='from-backlog'||m==='from-notes') Object.assign(d.tasks.find(t=>t.id==='created'),{bucket:'workspace',workspaceId:'a'});
          if(m==='close') d.tasks.find(t=>t.id==='created').status='done';
          if(m==='delete') d.tasks=d.tasks.filter(t=>t.id!=='z2');
          if(m==='delete-closed') d.tasks=d.tasks.filter(t=>t.id!=='closed');
          window.__applyCatalog();
        },mutation);
        await checkCounts(page);
        assert.equal(await toggle.getAttribute('aria-expanded'),'false',mutation);
        assert.equal(await page.evaluate(()=>document.activeElement.dataset.boardFolderToggle),focusBefore,mutation);
        assert.equal(await nav.evaluate(n=>n.scrollTop),scrollBefore,mutation);
      }
      if(surface.width<960) await page.keyboard.press('Escape');
      await page.locator('[data-task-board-completed-toggle]').click();
      await openCatalog(page,surface.width);
      await checkCounts(page);
      assert.match(await nav.locator('[data-board-scope="workspace:a"]').getAttribute('aria-label'),/закрыт/);
      if(surface.width<960) await page.keyboard.press('Escape');
      await page.locator('[data-task-board-completed-toggle]').click();
      await openCatalog(page,surface.width);
      await toggle.focus(); await page.keyboard.press('Space');
      assert.equal(await toggle.getAttribute('aria-expanded'),'true');
      await nav.locator('[data-board-scope="workspace:a"]').click();
      if(surface.width<960) {
        assert.equal(await page.locator('[data-task-board-scope-trigger]').evaluate(n=>n===document.activeElement),true);
        assert.equal(await page.locator('[data-task-board-scope-popover]').evaluate(n=>n.matches(':popover-open')),false);
        await shot('closed'); await openCatalog(page,surface.width);
      }
      assert.equal(await nav.locator('[data-board-scope="workspace:a"]').getAttribute('aria-current'),'page');
      assert.equal(await toggle.getAttribute('aria-expanded'),'true');
      await shot('selected');
      await toggle.focus(); await page.keyboard.press('Tab');
      await shot('focus');
      const data=await metrics(page);
      await writeFile(path.join(output,`${surface.name}-${theme}-metrics.json`),JSON.stringify(data,null,2));
      assert.equal(data.overflow,0); assert.equal(data.pageOverflow,0);
      assert.ok(data.text.every(n=>n.ratio>=4.5),JSON.stringify(data.text.filter(n=>n.ratio<4.5)));
      if(surface.width<960) for(const target of data.targets) assert.ok(target.rect.height>=44&&target.rect.width>=44,JSON.stringify(target));
      assert.ok(data.icons.every(n=>n.ratio>=3),JSON.stringify(data.icons));
      assert.ok(data.focus.length>0);
      assert.ok(data.focus.every(n=>n.ratio>=3&&parseFloat(n.width)>=2));
      await writeFile(path.join(output,`${surface.name}-${theme}-metrics.json`),JSON.stringify(data,null,2));
      if(surface.width<960) {
        await page.keyboard.press('Escape');
        await page.waitForFunction(()=>document.querySelector('[data-task-board-scope-trigger]')===document.activeElement);
        await openCatalog(page,surface.width);
        await page.mouse.click(2,2);
        await page.waitForFunction(()=>!document.querySelector('[data-task-board-scope-popover]').matches(':popover-open'));
      }
      // Reset data and scope for the other theme without replacing the page/host.
      await openCatalog(page,surface.width); await nav.locator('[data-board-scope="all"]').click();
      await seed(page);
    }
  } finally { await browser.close(); }
});



test("both count modes follow immutable canonical create/move/close/delete snapshots", async () => {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await openFixture(page, { themeRegistry,fixtureSnapshot:catalogFixture(),expectedTaskId:null });
    for (const completedOnly of [false, true]) {
      await seed(page);
      if (completedOnly) await page.locator('[data-task-board-completed-toggle]').click();
      const toggle = page.locator('[data-board-folder-toggle="folder:Команда"]');
      if (await toggle.getAttribute('aria-expanded') === 'true') await toggle.click();
      const transitions = [];
      for (const step of ['create-open','create-closed','move-same','move-cross','to-backlog','from-backlog','to-notes','from-notes','close','delete-open','delete-closed']) {
        await page.evaluate(step => {
          const d=window.__catalogData;
          if(step.startsWith('create-')) d.tasks.push({...d.tasks[0],id:step,status:step==='create-closed'?'done':'open'});
          const moving = d.tasks.find(t=>t.id==='create-closed');
          if(step==='move-same') moving.workspaceId='z';
          if(step==='move-cross') moving.workspaceId='long';
          if(step==='to-backlog'||step==='to-notes') Object.assign(moving,{bucket:step==='to-backlog'?'backlog':'notes',workspaceId:null});
          if(step==='from-backlog'||step==='from-notes') Object.assign(moving,{bucket:'workspace',workspaceId:'a'});
          if(step==='close') d.tasks.find(t=>t.id==='create-open').status='done';
          if(step==='delete-open') d.tasks=d.tasks.filter(t=>t.id!=='z1');
          if(step==='delete-closed') d.tasks=d.tasks.filter(t=>t.id!=='create-closed');
          window.__applyCatalog();
        },step);
        await checkCounts(page);
        assert.equal(await toggle.getAttribute('aria-expanded'),'false');
        transitions.push({step,counts:await counts(page)});
      }
      await writeFile(path.join(output,`count-transitions-${completedOnly?'closed':'current'}.json`),JSON.stringify(transitions,null,2));
      const before = await counts(page);
      await page.locator('[data-task-board-status-filter]').selectOption('testing', { force: true });
      assert.deepEqual(await counts(page),before);
      await page.locator('[data-task-board-view="list"]').click();
      assert.deepEqual(await counts(page),before);
      // Selecting a folder aggregate must not expand its disclosure.
      await page.locator('[data-board-scope="folder:Команда"]').click();
      assert.equal(await toggle.getAttribute('aria-expanded'),'false');
      assert.equal(await page.locator('[data-board-scope="folder:Команда"]').getAttribute('aria-current'),'page');
    }
  } finally { await browser.close(); }
});

test("catalog focus falls to a surviving sibling when the focused Workspace disappears", async () => {
  const browser=await launchBrowser();
  try {
    const page=await browser.newPage({viewport:{width:1280,height:900}});
    await openFixture(page,{fixtureSnapshot:catalogFixture(),expectedTaskId:null}); await seed(page);
    await page.locator('[data-board-scope="workspace:z"]').focus();
    assert.equal(await page.evaluate(()=>document.activeElement.dataset.boardScope),'workspace:z');
    await page.evaluate(()=>{
      const d=window.__catalogData;
      d.workspaces=d.workspaces.filter(w=>w.id!=='z');
      d.workspaceNavigation=d.workspaceNavigation.filter(w=>w.workspaceId!=='z');
      window.__applyCatalog();
    });
    assert.equal(await page.evaluate(()=>document.activeElement.dataset.boardScope),'workspace:a');
  } finally { await browser.close(); }
});

test("narrow catalog stays inside a short viewport and 200 percent text", async () => {
  const browser=await launchBrowser();
  try {
    const page=await browser.newPage({viewport:{width:320,height:420},hasTouch:true,isMobile:true});
    await openFixture(page,{surface:'web',themeRegistry,fixtureSnapshot:catalogFixture(),expectedTaskId:null}); await seed(page);
    const samples=[];
    for (const theme of ['nebula','orange']) for(const zoom of [false,true]) {
      await page.locator('[data-theme-select]').evaluate((n,id)=>{n.value=id;n.dispatchEvent(new Event('change',{bubbles:true}));},theme);
      await page.evaluate(zoom=>document.documentElement.style.fontSize=zoom?'200%':'',zoom);
      await openCatalog(page,320);
      const box=await page.locator('[data-task-board-scope-popover]').boundingBox();
      assert.ok(box.x>=8&&box.x+box.width<=312&&box.y>=8&&box.y+box.height<=412,JSON.stringify(box));
      const data=await metrics(page); assert.equal(data.overflow,0); assert.equal(data.pageOverflow,0);
      samples.push({theme,zoom,box,data});
      await page.screenshot({path:path.join(output,`short-${theme}-${zoom?'zoom':'normal'}.png`),animations:'disabled'});
      await page.keyboard.press('Escape');
    }
    await writeFile(path.join(output,'short-zoom-metrics.json'),JSON.stringify(samples,null,2));
  } finally { await browser.close(); }
});


for (const host of ['web','vscode']) test(`canonical ${host} snapshot refresh updates catalog counts and hierarchy`, async () => {
  const browser=await launchBrowser();
  try {
    const page=await browser.newPage({viewport:{width:1280,height:900}});
    page.setDefaultTimeout(5000);
    const data=snapshot();
    data.workspaces[0].settings={catalogFolder:'Команда'};
    data.workspaces.push({id:'other',name:'Альфа',settings:{catalogFolder:'Команда'},streams:[]});
    data.boardTasks=[{id:'real-card',title:'Снимок',status:'open',workflowStatus:'new',bucket:'workspace',workspaceId:'workspace-1',revision:1,attachments:[],checklist:[]}];
    await openFixture(page,{surface:host,fixtureSnapshot:data});
    await page.locator('[data-view-button="dashboard"]').click();
    const badge=page.locator('[data-board-scope="folder:Команда"] .task-workspace-folder-count');
    assert.equal(await badge.textContent(),'1');
    await page.locator('[data-board-folder-toggle="folder:Команда"]').click();
    await page.evaluate(()=>{
      const f=window.__agentHubFixture;
      f.snapshot=structuredClone(f.snapshot);
      f.snapshot.version='updated-catalog-snapshot';
      f.snapshot.boardTasks[0].status='done';
      f.snapshot.boardTasks.push({...f.snapshot.boardTasks[0],id:'new',status:'open',workspaceId:'other'});
      localStorage.setItem('fixture:snapshot',JSON.stringify(f.snapshot));
    });
    // The existing client refresh owner reads the next immutable snapshot.
    await page.waitForFunction(()=>document.querySelector('[data-board-scope="workspace:other"] .task-workspace-folder-count')?.textContent==='1',null,{timeout:10000});
    assert.equal(await badge.textContent(),'1');
    assert.equal(await page.locator('[data-board-scope="workspace:workspace-1"] .task-workspace-folder-count').textContent(),'0');
    assert.equal(await page.locator('[data-board-folder-toggle="folder:Команда"]').getAttribute('aria-expanded'),'false');
    await page.reload();
    await page.waitForFunction(()=>document.querySelector('[data-board-scope="workspace:other"] .task-workspace-folder-count')?.textContent==='1');
    assert.equal(await badge.textContent(),'1');
    await page.locator('[data-task-board-completed-toggle]').click();
    assert.equal(await page.locator('[data-board-scope="workspace:workspace-1"] .task-workspace-folder-count').textContent(),'1');
  } finally { await browser.close(); }
});


for (const scenario of [{host:'web',width:1280},{host:'vscode',width:520}]) {
  test(`local empty folder creation and rename reach Dashboard without a server snapshot: ${scenario.host}`, {timeout:20000}, async()=>{
    const browser=await launchBrowser();
    try {
      const page=await browser.newPage({viewport:{width:scenario.width,height:900}});
      page.setDefaultTimeout(4000);
      const server=snapshot();
      server.workspaces[0].settings={catalogFolder:'Серверная'};
      await openFixture(page,{surface:scenario.host,themeRegistry,fixtureSnapshot:server});
      await page.waitForFunction(()=>document.querySelector('[data-board-scope="workspace:workspace-1"]'));
      // Freeze delivery, not catalog behavior: no later snapshot can rescue the
      // projection. Both actual client transports remain otherwise installed.
      await page.route('**/api/snapshot', route=>route.abort('blockedbyclient'));
      await page.evaluate(()=>{
        window.__catalogSnapshotBefore=JSON.stringify(window.__agentHubFixture.snapshot);
        window.__catalogLogStart=window.__agentHubFixture.log.length;
        const original=window.__fixtureBridge.postMessage.bind(window.__fixtureBridge);
        window.__fixtureBridge.postMessage=message=>{if(message.action!=='snapshot') original(message);};
      });
      const chat=async()=>{
        await page.locator(scenario.width<960?'[data-mobile-button="tasks"]':'[data-view-button="chat"]').click();
      };
      const dashboard=async()=>{
        await page.locator(scenario.width<960?'[data-mobile-button="dashboard"]':'[data-view-button="dashboard"]').click();
        await openCatalog(page,scenario.width);
      };
      await chat();
      await page.locator('[data-action="workspace-folder-new"]').click();
      await page.locator('[data-text-dialog-input]').fill('Локальная пустая');
      await page.locator('[data-text-dialog-ok]').click();
      const local=page.locator('[data-task-list] [data-workspace-folder-name="Локальная пустая"]');
      assert.equal(await local.count(),1);
      await dashboard();
      const created=page.locator('[data-task-board-scopes] [data-board-scope="folder:Локальная пустая"]');
      assert.equal(await created.count(),1,'local catalog mutation reaches Dashboard synchronously');
      assert.equal(await created.locator('.task-workspace-folder-count').textContent(),'0');
      await page.screenshot({path:path.join(output,`${scenario.host}-local-empty-created.png`),animations:'disabled'});
      if(scenario.width<960) await page.keyboard.press('Escape');
      await chat();
      await local.dispatchEvent('contextmenu',{clientX:80,clientY:150});
      await page.locator('[data-workspace-folder-menu-action="rename"]').click();
      await page.locator('[data-text-dialog-input]').fill('Переименованная пустая');
      await page.locator('[data-text-dialog-ok]').click();
      assert.equal(await page.locator('[data-task-list] [data-workspace-folder-name="Переименованная пустая"]').count(),1);
      await dashboard();
      assert.equal(await created.count(),0);
      const renamed=page.locator('[data-task-board-scopes] [data-board-scope="folder:Переименованная пустая"]');
      assert.equal(await renamed.count(),1);
      assert.equal(await renamed.locator('.task-workspace-folder-count').textContent(),'0');
      await page.screenshot({path:path.join(output,`${scenario.host}-local-empty-renamed.png`),animations:'disabled'});
      const proof=await page.evaluate(()=>({snapshotUnchanged:JSON.stringify(window.__agentHubFixture.snapshot)===window.__catalogSnapshotBefore,
        actions:window.__agentHubFixture.log.slice(window.__catalogLogStart).map(e=>e.action)}));
      assert.equal(proof.snapshotUnchanged,true);
      assert.equal(proof.actions.some(action=>['rename-workspace-folder','create-workspace','move-workspace-to-folder','create-workspace-folder'].includes(action)),false);
      if(scenario.width<960) await page.keyboard.press('Escape');
      await chat();
      await page.locator('[data-task-list] [data-workspace-folder-name="Серверная"]').dispatchEvent('contextmenu',{clientX:80,clientY:150});
      await page.locator('[data-workspace-folder-menu-action="rename"]').click();
      await page.locator('[data-text-dialog-input]').fill('Серверное переименование');
      await page.locator('[data-text-dialog-ok]').click();
      await page.waitForFunction(()=>window.__agentHubFixture.log.some(e=>e.action==='rename-workspace-folder'));
      const serverRename=await page.evaluate(()=>window.__agentHubFixture.log.find(e=>e.action==='rename-workspace-folder'));
      assert.equal(serverRename.params.fromFolderName,'Серверная');
      assert.equal(serverRename.params.toFolderName,'Серверное переименование');
      proof.nonemptyServerOwner={fromFolderName:serverRename.params.fromFolderName,toFolderName:serverRename.params.toFolderName};
      await writeFile(path.join(output,`${scenario.host}-local-catalog-proof.json`),JSON.stringify(proof,null,2));
    } finally {await browser.close();}
  });
}
