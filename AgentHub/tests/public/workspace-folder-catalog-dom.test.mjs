import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { launchBrowser, openFixture } from "./composer-production.fixture.mjs";

import { catalogFixture } from "./workspace-folder.fixture.mjs";

const { loadThemeRegistry } = createRequire(import.meta.url)("../../theme-registry.cjs");
const themeRegistry = loadThemeRegistry(fileURLToPath(new URL("../../assets/web-app/",import.meta.url)));
const runs = fileURLToPath(new URL("../../WIP/folder-catalog-runs/",import.meta.url));
await mkdir(runs,{ recursive: true });
const output = await mkdtemp(path.join(runs,"run-"));
console.info("Folder catalog evidence:",output);

async function capture(page,key,state) {
  await page.screenshot({ path: path.join(output,`${key}-${state}.png`) });
  const metrics = await page.evaluate(() => {
    const dialog = document.querySelector("[data-folder-dialog]");
    const menu = [...document.querySelectorAll(".workspace-context-menu")].find(item => !item.hidden);
    const notice = document.querySelector("[data-folder-notices] section");
    const scope = dialog || menu || notice || document.querySelector("[data-task-list]");
    const canvas = document.createElement("canvas"), ctx = canvas.getContext("2d",{ willReadFrequently: true });
    canvas.width = canvas.height = 1;
    const rgba = color => { ctx.clearRect(0,0,1,1); ctx.fillStyle = color; ctx.fillRect(0,0,1,1); const value = [...ctx.getImageData(0,0,1,1).data]; value[3] /= 255; return value; };
    const over = (a,b) => [...a.slice(0,3).map((v,i)=>v*a[3]+b[i]*(1-a[3])),1];
    const bg = item => {
      if (!item) return rgba(getComputedStyle(document.documentElement).getPropertyValue("--bg"));
      const color = rgba(getComputedStyle(item).backgroundColor); return color[3] === 1 ? color : over(color,bg(item.parentElement));
    };
    const luminance = a => a.slice(0,3).map(v=>v/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4).reduce((sum,v,i)=>sum+v*[.2126,.7152,.0722][i],0);
    const ratio = (a,b) => (Math.max(luminance(a),luminance(b))+.05)/(Math.min(luminance(a),luminance(b))+.05);
    const rect = item => item?.getBoundingClientRect().toJSON() ?? null;
    const visible = item => item.checkVisibility() && item.getBoundingClientRect().width > 0;
    const text = [...scope.querySelectorAll("h2,p,li,button,label,.task-workspace-name,.task-workspace-folder-name,.task-workspace-folder-count")].filter(visible)
      .filter(item=>item.textContent.trim() && (!item.children.length || ["BUTTON","LI"].includes(item.tagName)))
      .map(item=>({ text: item.textContent, disabled: item.disabled || item.getAttribute("aria-disabled") === "true",
        ratio: ratio(over(rgba(getComputedStyle(item).color),bg(item)),bg(item)) }));
    const controls = [...scope.querySelectorAll("button:not([hidden]),summary,[draggable=true]")].filter(visible);
    const focus = controls.filter(item=>item.matches(":focus-visible")).map(item=>({ rect:rect(item), width:getComputedStyle(item).outlineWidth,
      ratio: ratio(rgba(getComputedStyle(item).outlineColor),bg(item.parentElement)) }));
    const danger = [...scope.querySelectorAll(".task-delete-confirm,.folder-catalog-danger")].filter(visible).map(item=>({
      ratio: ratio(rgba(getComputedStyle(item).borderColor),bg(item.parentElement)), color:getComputedStyle(item).color, border:getComputedStyle(item).borderColor,
      width: getComputedStyle(item).borderWidth,
    }));
    const body = dialog?.querySelector(":scope > section"), footer = dialog?.querySelector(":scope > footer");
    return { surface: document.documentElement.dataset.surface, theme: document.documentElement.dataset.theme,
      viewport: { width: innerWidth, height: innerHeight },
      scope:rect(scope), body:rect(body), footer:rect(footer), bodyScroll:body ? { height:body.clientHeight,total:body.scrollHeight,top:body.scrollTop } : null,
      pageOverflow:Math.max(0,document.documentElement.scrollWidth-innerWidth), overflow:Math.max(0,scope.scrollWidth-scope.clientWidth),
      bodyOverflow:body ? Math.max(0,body.scrollWidth-body.clientWidth) : 0,
      text, focus, danger, targets:controls.map(item=>({ text:item.getAttribute("aria-label") || item.textContent,rect:rect(item) })),
      selected:{ tag:document.activeElement?.tagName,id:document.activeElement?.id,label:document.activeElement?.getAttribute("aria-label") },
      editingDashboard:document.querySelectorAll('[data-task-board-scopes] [data-workspace-folder-menu-action], [data-task-board-scopes] [data-folder-drag-source], [data-task-board-scopes] [data-folder-drop-target]').length,
    };
  });
  await writeFile(path.join(output,`${key}-${state}.json`),JSON.stringify(metrics,null,2));
  assert.equal(metrics.pageOverflow,0);
  assert.equal(metrics.overflow,0);
  assert.equal(metrics.bodyOverflow,0);
  assert.equal(metrics.editingDashboard,0);
  assert.ok(metrics.text.filter(item=>!item.disabled).every(item=>item.ratio>=4.5),JSON.stringify(metrics.text.filter(item=>!item.disabled && item.ratio<4.5)));
  assert.ok(metrics.focus.every(item=>item.ratio>=3),JSON.stringify(metrics.focus));
  assert.ok(metrics.danger.filter(item=>parseFloat(item.width)>0).every(item=>item.ratio>=3),JSON.stringify(metrics.danger));
  if (metrics.viewport.width<960) for (const target of metrics.targets) assert.ok(target.rect.height>=44 && target.rect.width>=44,JSON.stringify(target));
  if (metrics.body && metrics.footer) assert.ok(metrics.body.bottom<=metrics.footer.top+1);
  return metrics;
}

for (const actorConfig of [
  { surface:"web",width:1280,height:850,theme:"nebula" },
  { surface:"vscode",width:520,height:850,theme:"nebula" },
  { surface:"web",width:390,height:844,theme:"nebula",mobile:true },
]) test(`two open clients retain empty create, rename and removal: ${actorConfig.surface}${actorConfig.width}`,{ timeout:45_000 },async t=>{
  const server = await catalogFixture(), browser = await launchBrowser();
  t.after(async()=>{ await browser.close(); await server.close(); });
  const observerConfig = actorConfig.surface === "web" && !actorConfig.mobile
    ? { surface:"vscode",width:520,height:850,theme:"orange" }
    : { surface:"web",width:390,height:844,theme:"orange",mobile:true };
  const actor = await browser.newPage({ viewport:{width:actorConfig.width,height:actorConfig.height},isMobile:Boolean(actorConfig.mobile),hasTouch:Boolean(actorConfig.mobile) });
  const observer = await browser.newPage({ viewport:{width:observerConfig.width,height:observerConfig.height},isMobile:Boolean(observerConfig.mobile),hasTouch:Boolean(observerConfig.mobile) });
  actor.setDefaultTimeout(6000); observer.setDefaultTimeout(15000);
  await prepare(actor,actorConfig,server); await prepare(observer,observerConfig,server);
  await openCatalog(actor,actorConfig); await openCatalog(observer,observerConfig);
  if (actorConfig.mobile) await actor.locator('[data-mobile-workspace-action="workspace-folder-new"]').click();
  else await actor.locator('[data-action="workspace-folder-new"]').click();
  await actor.locator("[data-text-dialog-input]").fill("Общая пустая");
  await actor.locator("[data-text-dialog-ok]").click();
  await openCatalog(actor,actorConfig);
  await actor.locator('[data-workspace-folder-name="Общая пустая"]').waitFor();
  await observer.locator('[data-workspace-folder-name="Общая пустая"]').waitFor();
  const id = server.raw.workspaceFolderCatalog().folders.find(folder=>folder.name === "Общая пустая").id;
  const key = `clients-${actorConfig.surface}-${actorConfig.width}`;
  const observedFolder = observer.locator('[data-workspace-folder-name="Общая пустая"] details');
  if (await observedFolder.evaluate(node=>node.open)) await observedFolder.locator("summary").click();
  await capture(observer,key,"created-observed");
  await openFolderMenu(actor,actorConfig,"Общая пустая");
  await actor.getByRole("menuitem",{ name:"Переименовать папку…" }).click();
  await actor.locator("[data-text-dialog-input]").fill("Общая после переименования");
  await actor.locator("[data-text-dialog-ok]").click();
  await actor.locator('[data-workspace-folder-name="Общая после переименования"]').waitFor();
  await observer.locator('[data-workspace-folder-name="Общая после переименования"]').waitFor();
  assert.equal(await observer.locator('[data-workspace-folder-name="Общая пустая"]').count(),0);
  assert.equal(server.raw.workspaceFolderCatalog().folders.find(folder=>folder.name === "Общая после переименования").id,id);
  assert.equal(await observer.locator('[data-workspace-folder-name="Общая после переименования"] details').evaluate(node=>node.open),false);
  await capture(observer,key,"renamed-observed");
  await openFolderMenu(actor,actorConfig,"Общая после переименования");
  await actor.getByRole("menuitem",{ name:"Удалить папку…" }).click();
  await actor.getByText("Папка пуста. Будет удалена только папка.",{ exact:true }).waitFor();
  await actor.locator("[data-folder-dialog]").getByRole("button",{ name:"Удалить папку",exact:true }).click();
  await actor.locator("[data-folder-dialog]").waitFor({ state:"detached" });
  await observer.locator('[data-workspace-folder-name="Общая после переименования"]').waitFor({ state:"detached" });
  await observer.reload(); await openCatalog(observer,observerConfig);
  assert.equal(await observer.locator('[data-workspace-folder-name="Общая после переименования"]').count(),0);
  assert.equal(server.raw.workspaceFolderCatalog().folders.some(folder=>folder.id === id),false);
  await capture(observer,key,"deleted-reloaded");
  await writeFile(path.join(output,`${key}-proof.json`),JSON.stringify({ id,calls:server.calls.filter(call=>call.action.includes("folder")) },null,2));
});

for(const config of [
  {surface:"web",width:1280,height:850,theme:"nebula"},
  {surface:"vscode",width:520,height:850,theme:"orange"},
  {surface:"web",width:390,height:844,theme:"nebula",mobile:true},
]) test(`existing Workspace form retains checked folder movement: ${config.surface}${config.width}`,{timeout:30_000},async t=>{
  const server=await catalogFixture(),browser=await launchBrowser();
  t.after(async()=>{await browser.close();await server.close();});
  const page=await browser.newPage({viewport:{width:config.width,height:config.height},isMobile:Boolean(config.mobile),hasTouch:Boolean(config.mobile)});
  page.setDefaultTimeout(6000);await prepare(page,config,server);await openCatalog(page,config);
  const row=page.locator('[data-workspace-select="workspace-1"]');
  if(config.mobile) await row.locator('[data-mobile-workspace-edit]').click();else await row.press("Shift+F10");
  await page.getByRole("menuitem",{name:"Редактировать…",exact:true}).click();
  await page.locator('[data-workspace-card-folder-field] .themed-select-button').click();
  await page.getByRole("option",{name:"Клиенты",exact:true}).click();
  await page.locator('[data-workspace-card-form]').evaluate(form=>form.requestSubmit());
  await page.waitForFunction(()=>document.querySelector('[data-workspace-select="workspace-1"]')?.hasAttribute("data-folder-member"));
  assert.equal(server.raw.workspace("workspace-1").settings.catalogFolder,"Клиенты");
  const move=server.calls.filter(call=>call.action==="move-workspace-to-folder");
  assert.equal(move.length,1);assert.equal(move[0].params.sourceFolderId,null);
  assert.ok(move[0].params.target.id);assert.ok(Number.isSafeInteger(move[0].params.target.revision));
  await writeFile(path.join(output,`form-${config.surface}-${config.width}-proof.json`),JSON.stringify({calls:server.calls.filter(call=>call.action!=="snapshot")},null,2));
});

async function prepare(page,config,server) {
  const errors = await openFixture(page,{ surface: config.surface, fixtureSnapshot: server.snapshot(), folderControlHandler: server.control, themeRegistry });
  await page.locator("[data-theme-select]").evaluate((item,theme) => { item.value = theme; item.dispatchEvent(new Event("change",{ bubbles: true })); },config.theme);
  if (config.scale) await page.evaluate(() => document.documentElement.style.fontSize = "200%");
  await page.evaluate(async () => { await document.fonts.ready; await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))); });
  return errors;
}

async function openCatalog(page,config) {
  if (!config.mobile) return;
  await page.evaluate(() => window.AgentHub.showSelectedTask());
  if (!await page.locator("[data-mobile-workspace-drawer]").evaluate(node=>node.open)) await page.locator("[data-mobile-workspaces-open]").click();
}
async function openFolderMenu(page,config,name) {
  await openCatalog(page,config);
  const folder = page.locator(`[data-workspace-folder-name="${name}"]`);
  if (config.mobile) await folder.locator("[data-mobile-folder-rename]").click();
  else await folder.locator("summary").press("Shift+F10");
}
async function refreshCatalog(page,server) {
  const value = server.snapshot();
  await page.evaluate(next => {
    window.__agentHubFixture.snapshot = next;
    document.querySelector("[data-provider-connection-retry]")?.click();
  },value);
  await page.waitForFunction(revision=>window.AgentHub.workspaceFolders.revision === revision,value.workspaceFolders.revision);
}
const deferred = () => { let release; return { promise: new Promise(resolve=>{ release=resolve; }),release:()=>release() }; };


for (const config of [
  { surface: "web", width: 1280, height: 850 },
  { surface: "vscode", width: 520, height: 850 }, { surface: "vscode", width: 390, height: 850 },
  ...[320,390,430].map(width=>({ surface: "web", width, height: 844, mobile: true })),
  { surface: "web", width: 320, height: 420, mobile: true, variant: "short" },
  { surface: "web", width: 320, height: 844, mobile: true, scale: true, variant: "text200" },
].flatMap(item=>["nebula","orange"].map(theme=>({ ...item,theme })))) {
  const key = `${config.surface}-${config.width}-${config.variant || "normal"}-${config.theme}`;
  test(`folder keyboard confirmation and chooser retain visible focus: ${key}`,{timeout:20_000},async t=>{
    const server=await catalogFixture(),browser=await launchBrowser();
    t.after(async()=>{await browser.close();await server.close();});
    const page=await browser.newPage({viewport:{width:config.width,height:config.height},isMobile:Boolean(config.mobile),hasTouch:Boolean(config.mobile)});
    page.setDefaultTimeout(6000);await prepare(page,config,server);await openCatalog(page,config);
    const origin=page.locator('[data-workspace-folder-name="Пустая"] summary');
    await origin.press("ContextMenu");await page.keyboard.press("End");await page.keyboard.press("Enter");
    await page.getByText("Папка пуста. Будет удалена только папка.",{exact:true}).waitFor();
    assert.equal(await page.locator('[data-folder-dialog]').getByRole("button",{name:"Отмена",exact:true}).evaluate(node=>node===document.activeElement&&node.matches(":focus-visible")),true);
    await capture(page,key,"keyboard-initial-cancel");
    await page.keyboard.press("Tab");
    assert.equal(await page.locator('[data-folder-dialog]').getByRole("button",{name:"Удалить папку",exact:true}).evaluate(node=>node===document.activeElement&&node.matches(":focus-visible")),true);
    await capture(page,key,"keyboard-delete-focus");
    await page.keyboard.press("Escape");assert.equal(await origin.evaluate(node=>node===document.activeElement),true);
    const source=config.mobile?page.locator('[data-workspace-select="workspace-1"] [data-mobile-workspace-select]'):page.locator('[data-workspace-select="workspace-1"]');
    await source.press("Shift+F10");await page.keyboard.press("End");await page.keyboard.press("Enter");
    await page.getByRole("heading",{name:"Переместить Workspace",exact:true}).waitFor();
    await capture(page,key,"keyboard-move-chooser");
    assert.equal(await page.locator('[data-folder-dialog]').getByRole("button",{name:"Переместить",exact:true}).isDisabled(),true);
    await page.keyboard.press("Escape");assert.equal(await source.evaluate(node=>node===document.activeElement),true);
    assert.equal(server.calls.filter(call=>["mutate-workspace-folder","move-workspace-to-folder"].includes(call.action)).length,0);
  });
  test(`folder delete and accessible move use the canonical owner: ${key}`, { timeout: 30_000 }, async t => {
    const server = await catalogFixture();
    const browser = await launchBrowser();
    t.after(async () => { await browser.close(); await server.close(); });
    const page = await browser.newPage({ viewport: { width: config.width, height: config.height }, isMobile: Boolean(config.mobile), hasTouch: Boolean(config.mobile) });
    page.setDefaultTimeout(6000);
    const errors = await prepare(page,config,server);
    if (config.mobile) {
      await page.evaluate(() => window.AgentHub.showSelectedTask());
      await page.locator("[data-mobile-workspaces-open]").click();
      await page.locator('[data-workspace-folder-name="Пустая"] [data-mobile-folder-rename]').click();
    } else {
      await page.locator('[data-workspace-folder-name="Пустая"] summary').press("Shift+F10");
    }
    await capture(page,key,"menu");
    assert.deepEqual(await page.getByRole("menuitem").allTextContents(),["Переименовать папку…","Удалить папку…"]);
    assert.equal(await page.getByRole("menuitem",{name:"Удалить папку…"}).evaluate(node=>node.previousElementSibling.getAttribute("role")),"separator");
    await page.getByRole("menuitem",{ name: "Удалить папку…" }).click();
    const dialog = page.locator("[data-folder-dialog]");
    await page.getByText("Папка пуста. Будет удалена только папка.",{ exact: true }).waitFor();
    assert.equal(await dialog.getByRole("button",{ name: "Отмена", exact: true }).evaluate(node => node === document.activeElement),true);
    await capture(page,key,"empty-ready");
    assert.equal(server.calls.filter(call => call.action === "mutate-workspace-folder").length,0);
    for (const close of ["cancel","scrim"]) {
      if (close === "cancel") await dialog.getByRole("button",{ name: "Отмена",exact: true }).click();
      else await page.mouse.click(1,1);
      await dialog.waitFor({ state: "detached" });
      assert.equal(server.calls.filter(call=>call.action === "mutate-workspace-folder").length,0);
      assert.equal(await page.evaluate(()=>document.activeElement.closest("[data-workspace-folder-name]")?.dataset.workspaceFolderName),"Пустая");
      await openFolderMenu(page,config,"Пустая"); await page.getByRole("menuitem",{ name: "Удалить папку…" }).click();
      await page.getByText("Папка пуста. Будет удалена только папка.",{ exact: true }).waitFor();
    }
    await dialog.getByRole("button",{ name: "Удалить папку", exact: true }).click();
    await dialog.waitFor({ state: "detached" });
    assert.equal(server.raw.workspaceFolderCatalog().folders.some(folder => folder.name === "Пустая"),false);
    assert.equal(await page.locator('[data-workspace-folder-name="Пустая"]').count(),0);
    assert.equal(server.calls.filter(call => call.action === "mutate-workspace-folder").length,1);
    await capture(page,key,"empty-success");
    if (config.mobile) await page.locator('[data-workspace-select="workspace-1"] [data-mobile-workspace-edit]').click();
    else await page.locator('[data-workspace-select="workspace-1"]').press("Shift+F10");
    await page.getByRole("menuitem",{ name: "Переместить в папку…" }).click();
    await capture(page,key,"move-picker");
    const target = server.raw.workspaceFolderCatalog().folders.find(folder => folder.name === "Клиенты");
    await page.locator("[data-folder-dialog] .themed-select-button").click();
    await page.getByRole("option",{ name: target.name, exact: true }).click();
    await page.locator("[data-folder-dialog]").getByRole("button",{ name: "Переместить", exact: true }).click();
    await page.locator("[data-folder-dialog]").waitFor({ state: "detached" });
    assert.equal(server.raw.workspace("workspace-1").settings.catalogFolder,"Клиенты");
    assert.equal(server.calls.filter(call => call.action === "move-workspace-to-folder").length,1);
    await capture(page,key,"move-success");
    assert.deepEqual(errors,[]);
  });

  if (!config.mobile) test(`native drag keeps collapsed targets closed and cancels a deleted target: ${key}`, { timeout: 30_000 }, async t => {
    const server = await catalogFixture();
    const browser = await launchBrowser();
    t.after(async () => { await browser.close(); await server.close(); });
    const page = await browser.newPage({ viewport: { width: config.width, height: config.height } });
    page.setDefaultTimeout(6000);
    await prepare(page,config,server);
    await page.evaluate(() => {
      window.__folderNativeEvents = [];
      for (const type of ["dragstart","drop"]) document.addEventListener(type,event => {
        window.__folderNativeEvents.push({ type, trusted: event.isTrusted, types: [...event.dataTransfer.types] });
      },true);
    });
    const clients = page.locator('[data-workspace-folder-name="Клиенты"]');
    const cancelSource = await page.locator('[data-workspace-select="workspace-1"]').boundingBox();
    const cancelTarget = await clients.locator("summary").boundingBox();
    await page.mouse.move(cancelSource.x+cancelSource.width/2,cancelSource.y+cancelSource.height/2); await page.mouse.down();
    await page.mouse.move(cancelTarget.x+cancelTarget.width/2,cancelTarget.y+cancelTarget.height/2,{ steps:12 });
    await page.mouse.move(cancelTarget.x+cancelTarget.width/2+1,cancelTarget.y+cancelTarget.height/2);
    await page.locator("[data-folder-drop-target]").waitFor();
    await capture(page,key,"native-drag-source-and-target");
    await page.keyboard.press("Escape"); await page.mouse.up();
    assert.equal(server.calls.filter(call=>call.action === "move-workspace-to-folder").length,0);
    assert.equal(await page.locator("[data-folder-drop-target],[data-folder-drag-source]").count(),0);
    await clients.locator("summary").click();
    assert.equal(await clients.locator("details").evaluate(node => node.open),false);
    await capture(page,key,"collapsed-before-drag");
    await page.locator('[data-workspace-select="workspace-1"]').dragTo(clients.locator("summary"));
    await page.waitForFunction(() => document.querySelector('[data-workspace-select="workspace-1"]')?.hasAttribute("data-folder-member"));
    assert.equal(server.raw.workspace("workspace-1").settings.catalogFolder,"Клиенты");
    assert.equal(await clients.locator("details").evaluate(node => node.open),false);
    await capture(page,key,"collapsed-after-drag");
    const events = await page.evaluate(() => window.__folderNativeEvents);
    assert.ok(events.some(event => event.type === "dragstart" && event.trusted));
    assert.ok(events.some(event => event.type === "drop" && event.trusted));
    assert.equal(server.calls.filter(call => call.action === "move-workspace-to-folder").length,1);
    await page.evaluate(() => {
      const transfer = new DataTransfer(); transfer.setData("application/x-agent-hub-workspace","foreign");
      const target = document.querySelector('[data-workspace-folder-name="Пустая"] summary');
      target.dispatchEvent(new DragEvent("dragover",{ bubbles: true, cancelable: true, dataTransfer: transfer }));
      target.dispatchEvent(new DragEvent("drop",{ bubbles: true, cancelable: true, dataTransfer: transfer }));
    });
    assert.equal(server.calls.filter(call => call.action === "move-workspace-to-folder").length,1);
    await page.reload();
    await page.waitForFunction(revision=>window.AgentHub?.workspaceFolders.revision === revision,server.raw.workspaceFolderCatalog().revision);
    await clients.locator("summary").waitFor();
    assert.equal(await clients.locator("details").evaluate(node=>node.open),false);
    await clients.locator("summary").click();
    const source = page.locator('[data-workspace-select="workspace-1"]');
    await source.dragTo(clients.locator("summary"));
    assert.equal(server.calls.filter(call=>call.action === "move-workspace-to-folder").length,1,
      JSON.stringify(server.calls.filter(call=>call.action === "move-workspace-to-folder")));
    const target = page.locator('[data-workspace-folder-name="Пустая"] summary');
    const a = await source.boundingBox(), b = await target.boundingBox();
    await page.mouse.move(a.x + a.width / 2,a.y + a.height / 2); await page.mouse.down();
    await page.mouse.move(b.x + b.width / 2,b.y + b.height / 2,{ steps: 12 });
    await page.mouse.move(b.x+b.width/2+1,b.y+b.height/2);
    await page.locator("[data-folder-drop-target]").waitFor();
    await capture(page,key,"native-drag-expanded-target");
    const folder = server.raw.workspaceFolderCatalog().folders.find(item => item.name === "Пустая");
    const preview = server.raw.previewWorkspaceFolderDeletion(folder.id);
    server.raw.workspaceFolderCommand({ requestId: "remote-delete-drag-target", action: "remove", payload: { folderId: folder.id, previewToken: preview.token } });
    await page.evaluate(value => {
      window.__agentHubFixture.snapshot = value;
      document.querySelector("[data-provider-connection-retry]")?.click();
    },server.snapshot());
    await page.waitForFunction(() => !document.querySelector('[data-workspace-folder-name="Пустая"]'));
    await page.mouse.up();
    assert.equal(await page.locator("[data-folder-drop-target], [data-folder-drag-source]").count(),0);
    assert.equal(server.calls.filter(call => call.action === "move-workspace-to-folder").length,1);
    assert.equal(server.raw.workspace("workspace-1").settings.catalogFolder,"Клиенты");
    const renamed = server.raw.workspaceFolderCommand({ requestId:"seed-rename-target",action:"create",payload:{name:"Цель"} }).result.folder;
    await refreshCatalog(page,server);
    const begin = async targetName => {
      const a = await source.boundingBox(), b = await page.locator(`[data-workspace-folder-name="${targetName}"] summary`).boundingBox();
      await page.mouse.move(a.x+a.width/2,a.y+a.height/2); await page.mouse.down();
      await page.mouse.move(b.x+b.width/2,b.y+b.height/2,{steps:12});
      await page.mouse.move(b.x+b.width/2+1,b.y+b.height/2); await page.locator("[data-folder-drop-target]").waitFor();
    };
    await begin("Цель");
    server.raw.workspaceFolderCommand({requestId:"remote-rename-target",action:"rename",payload:{folderId:renamed.id,expectedRevision:renamed.revision,name:"Новая цель"}});
    await refreshCatalog(page,server); await page.mouse.up();
    assert.equal(server.calls.filter(call=>call.action === "move-workspace-to-folder").length,1);
    assert.equal(server.raw.workspace("workspace-1").settings.catalogFolder,"Клиенты");
    server.faults.gate=deferred();
    await begin("Новая цель"); await page.mouse.up();
    await page.waitForFunction(()=>document.querySelector('[data-folder-move-busy]'));
    await capture(page,key,"native-move-pending");
    const current=server.raw.workspaceFolderCatalog().folders.find(folder=>folder.id===renamed.id);
    server.raw.workspaceFolderCommand({requestId:"rename-after-drop-before-commit",action:"rename",payload:{folderId:current.id,expectedRevision:current.revision,name:"Цель после отказа"}});
    server.faults.gate.release(); await Promise.allSettled([...server.jobs]);
    await page.getByRole("alert").filter({hasText:"Папка изменилась или удалена. Workspace не перемещён."}).waitFor();
    assert.equal(server.raw.workspace("workspace-1").settings.catalogFolder,"Клиенты");
    await capture(page,key,"native-move-known-error");
    await page.getByRole("alert").getByRole("button",{name:"Закрыть",exact:true}).click();
    server.faults.gate=deferred(); server.faults.lose=true;
    await begin("Цель после отказа"); await page.mouse.up();
    await page.locator("[data-folder-notice-id]").waitFor();
    await capture(page,key,"native-drag-unknown-notice");
    assert.equal(await page.locator("[data-folder-dialog]").count(),0);
    assert.equal(server.calls.filter(call=>call.action === "move-workspace-to-folder").length,3);
    await page.locator('[data-folder-notices] button').click();
    await page.getByText("Результат всё ещё не подтверждён.",{exact:true}).waitFor();
    server.faults.gate.release(); await Promise.allSettled([...server.jobs]);
    await page.locator('[data-folder-notices] button').click();
    await page.locator("[data-folder-notice-id]").waitFor({state:"detached"});
    assert.equal(server.raw.workspace("workspace-1").settings.catalogFolder,"Цель после отказа");
    assert.equal(server.calls.filter(call=>call.action === "move-workspace-to-folder").length,3);
    await writeFile(path.join(output,`${key}-native-proof.json`),JSON.stringify({ events,calls:server.calls },null,2));
  });

  test(`full preview, loading, retry, pending and explicit stale reconfirmation: ${key}`, { timeout: 40_000 }, async t => {
    const server = await catalogFixture();
    const name = "Очень длинное название папки для проверки переноса полного списка воркспейсов";
    const folder = server.raw.workspaceFolderCommand({ requestId: "seed-many",action: "create",payload: { name } }).result.folder;
    const add = index => {
      const id = `many-${index}`;
      const workspace = server.raw.createWorkspace({ id,name: `Воркспейс ${String(index).padStart(3,"0")} с полным длинным названием для проверки многоточия`,settings: { catalogFolder: folder.name, retained: index } });
      server.raw.createStream({ id: `member-stream-${index}`,workspaceId: workspace.id,name: "Member" });
    };
    add(1);
    const browser = await launchBrowser();
    t.after(async () => { await browser.close(); await server.close(); });
    const page = await browser.newPage({ viewport: { width: config.width,height: config.height },isMobile: Boolean(config.mobile),hasTouch: Boolean(config.mobile) });
    page.setDefaultTimeout(6000); await prepare(page,config,server);
    await openFolderMenu(page,config,name);
    await page.getByRole("menuitem",{ name: "Удалить папку…" }).click();
    await page.locator("[data-folder-dialog] .folder-catalog-content li").waitFor();
    assert.equal(await page.locator("[data-folder-dialog] li").count(),1);
    await capture(page,key,"nonempty-one"); await page.keyboard.press("Escape");
    add(2); await refreshCatalog(page,server);
    await openFolderMenu(page,config,name); await page.getByRole("menuitem",{ name: "Удалить папку…" }).click();
    await page.waitForFunction(()=>document.querySelectorAll("[data-folder-dialog] li").length === 2);
    await capture(page,key,"nonempty-two"); await page.keyboard.press("Escape");
    for (let i=3;i<=103;i++) add(i);
    await refreshCatalog(page,server);
    server.faults.previewGate = deferred();
    await openFolderMenu(page,config,name); await page.getByRole("menuitem",{ name: "Удалить папку…" }).click();
    await page.getByText("Проверяем содержимое папки…",{ exact: true }).waitFor();
    assert.equal(await page.locator("[data-folder-dialog]").getByRole("button",{ name: "Удалить папку",exact: true }).isDisabled(),true);
    await capture(page,key,"preview-loading"); await page.keyboard.press("Escape");
    await page.locator("[data-folder-dialog]").waitFor({ state: "detached" });
    server.faults.previewGate.release(); server.faults.previewGate = null;
    assert.equal(server.calls.filter(call=>call.action === "mutate-workspace-folder").length,0);
    server.faults.previewFailure = true;
    await openFolderMenu(page,config,name); await page.getByRole("menuitem",{ name: "Удалить папку…" }).click();
    await page.getByRole("alert").filter({ hasText: "Не удалось проверить содержимое папки." }).waitFor();
    await capture(page,key,"preview-error");
    await page.locator("[data-folder-dialog]").getByRole("button",{ name: "Проверить снова",exact: true }).click();
    await page.waitForFunction(()=>document.querySelectorAll("[data-folder-dialog] li").length === 103);
    const dialog = page.locator("[data-folder-dialog]"), body = dialog.locator(":scope > section"), footer = dialog.locator("footer");
    const before = await footer.boundingBox();
    await capture(page,key,"many-long-top");
    await body.evaluate(node=>node.scrollTop = node.scrollHeight);
    await capture(page,key,"many-long-scrolled");
    const after = await footer.boundingBox(); assert.ok(Math.abs(before.y-after.y)<=1);
    assert.equal(await dialog.locator("li[title][aria-label]").count(),103);
    server.faults.gate = deferred();
    const confirm = dialog.getByRole("button",{ name: "Удалить папку",exact: true });
    await confirm.click();
    await dialog.getByRole("button",{ name: "Удаляем папку…",exact: true }).waitFor();
    await page.keyboard.press("Escape"); assert.equal(await dialog.evaluate(node=>node.open),true);
    await page.mouse.click(1,1); assert.equal(await dialog.evaluate(node=>node.open),true);
    await dialog.getByRole("button",{ name: "Удаляем папку…",exact: true }).click({ force: true });
    assert.equal(server.calls.filter(call=>call.action === "mutate-workspace-folder").length,1);
    await capture(page,key,"remove-pending");
    add(104); server.faults.gate.release();
    await page.getByRole("alert").filter({ hasText: "Состав папки изменился." }).waitFor();
    assert.equal(await dialog.locator("li").count(),104);
    assert.equal(server.calls.filter(call=>call.action === "mutate-workspace-folder").length,1);
    await capture(page,key,"stale-new-preview");
    await dialog.getByRole("button",{ name: "Удалить папку",exact: true }).click();
    await dialog.waitFor({ state: "detached" });
    assert.equal(server.calls.filter(call=>call.action === "mutate-workspace-folder").length,2);
    for (let i=1;i<=104;i++) assert.equal(server.raw.workspace(`many-${i}`).settings.catalogFolder,undefined);
    assert.equal(server.raw.workspaceFolderCatalog().folders.some(item=>item.id === folder.id),false);
    await capture(page,key,"many-success-root");
    await writeFile(path.join(output,`${key}-stale-proof.json`),JSON.stringify({ calls: server.calls.filter(call=>call.action.includes("folder")),
      remainingMembers: server.raw.hierarchy().filter(workspace=>workspace.id.startsWith("many-")).length },null,2));
  });

  test(`move UNKNOWN keeps one request and exposes persistent recovery: ${key}`, { timeout: 30_000 }, async t => {
    const server = await catalogFixture();
    const browser = await launchBrowser();
    t.after(async () => { await browser.close(); await server.close(); });
    const page = await browser.newPage({ viewport: { width:config.width,height:config.height },isMobile:Boolean(config.mobile),hasTouch:Boolean(config.mobile) });
    page.setDefaultTimeout(6000); await prepare(page,config,server); await openCatalog(page,config);
    const source = page.locator('[data-workspace-select="workspace-1"]');
    if (config.mobile) await source.locator("[data-mobile-workspace-edit]").click();
    else await source.press("Shift+F10");
    await page.getByRole("menuitem",{ name:"Переместить в папку…" }).click();
    await page.locator("[data-folder-dialog] .themed-select-button").click();
    await page.getByRole("option",{ name:"Клиенты",exact:true }).click();
    server.faults.gate = deferred(); server.faults.lose = true;
    await page.locator("[data-folder-dialog]").getByRole("button",{ name:"Переместить",exact:true }).click();
    await page.getByRole("heading",{ name:"Результат перемещения пока не подтверждён",exact:true }).waitFor();
    await capture(page,key,"move-unknown-dialog");
    await page.locator("[data-folder-dialog]").getByRole("button",{ name:"Проверить результат",exact:true }).click();
    await page.getByText("Результат всё ещё не подтверждён.",{ exact:true }).waitFor();
    assert.equal(server.raw.workspace("workspace-1").settings.catalogFolder,undefined);
    await page.locator("[data-folder-dialog]").getByRole("button",{ name:"Закрыть",exact:true }).click();
    await capture(page,key,"move-unknown-notice");
    await page.reload(); await openCatalog(page,config);
    await page.locator("[data-folder-notice-id]").waitFor();
    await capture(page,key,"move-unknown-restored");
    server.faults.readFailure=true;
    await page.locator('[data-folder-notices] button').click();
    await page.getByRole("alert").filter({hasText:"Не удалось проверить результат. Повторная команда не отправлена."}).waitFor();
    await page.getByRole("alert").getByRole("button",{name:"Закрыть",exact:true}).click();
    if (config.mobile) await source.locator("[data-mobile-workspace-edit]").click();
    else await source.press("Shift+F10");
    assert.equal(await page.getByRole("menuitem",{ name:"Переместить в папку…" }).isDisabled(),true);
    await page.keyboard.press("Escape");
    assert.equal(server.calls.filter(call=>call.action === "move-workspace-to-folder").length,1);
    server.faults.gate.release(); await Promise.allSettled([...server.jobs]);
    await page.locator("[data-folder-notices]").getByRole("button",{ name:"Проверить результат",exact:true }).click();
    await page.locator("[data-folder-notice-id]").waitFor({ state:"detached" });
    assert.equal(server.raw.workspace("workspace-1").settings.catalogFolder,"Клиенты");
    assert.equal(server.calls.filter(call=>call.action === "move-workspace-to-folder").length,1);
    const input = server.calls.find(call=>call.action === "workspace-folder-result").params;
    assert.equal(server.raw.workspaceFolderCommandResult(input).status,"succeeded");
    await writeFile(path.join(output,`${key}-move-recovery-proof.json`),JSON.stringify({ calls:server.calls.filter(call=>call.action.includes("folder")) },null,2));
  });

  test(`authoritative rejection after UNKNOWN requires a fresh explicit confirmation: ${key}`, {timeout:40_000}, async t=>{
    const server=await catalogFixture(), browser=await launchBrowser();
    t.after(async()=>{await browser.close();await server.close();});
    const page=await browser.newPage({viewport:{width:config.width,height:config.height},isMobile:Boolean(config.mobile),hasTouch:Boolean(config.mobile)});
    page.setDefaultTimeout(6000); await prepare(page,config,server); await openCatalog(page,config);
    const source=page.locator('[data-workspace-select="workspace-1"]');
    const chooser=async name=>{
      if(config.mobile) await source.locator('[data-mobile-workspace-edit]').click();else await source.press("Shift+F10");
      await page.getByRole("menuitem",{name:"Переместить в папку…"}).click();
      await page.locator('[data-folder-dialog] .themed-select-button').click();
      await page.getByRole("option",{name,exact:true}).click();
    };
    await chooser("Клиенты"); server.faults.gate=deferred();server.faults.lose=true;
    await page.locator('[data-folder-dialog]').getByRole("button",{name:"Переместить",exact:true}).click();
    await page.getByRole("heading",{name:"Результат перемещения пока не подтверждён",exact:true}).waitFor();
    const target=server.raw.workspaceFolderCatalog().folders.find(folder=>folder.name==="Клиенты");
    server.raw.workspaceFolderCommand({requestId:"competing-rename",action:"rename",payload:{folderId:target.id,expectedRevision:target.revision,name:"Новые клиенты"}});
    server.faults.gate.release();await Promise.allSettled([...server.jobs]);
    await page.locator('[data-folder-dialog]').getByRole("button",{name:"Проверить результат",exact:true}).click();
    await page.getByRole("alert").filter({hasText:"Папка изменилась или удалена. Workspace не перемещён."}).waitFor();
    assert.equal(server.raw.workspace("workspace-1").settings.catalogFolder,undefined);
    assert.equal(server.calls.filter(call=>call.action==="move-workspace-to-folder").length,1);
    await capture(page,key,"move-known-stale-rejection");
    await page.getByRole("alert").getByRole("button",{name:"Закрыть",exact:true}).click();
    await chooser("Новые клиенты");
    await page.locator('[data-folder-dialog]').getByRole("button",{name:"Переместить",exact:true}).click();
    await page.locator('[data-folder-dialog]').waitFor({state:"detached"});
    const moves=server.calls.filter(call=>call.action==="move-workspace-to-folder");
    assert.equal(moves.length,2);assert.notEqual(moves[0].params.requestId,moves[1].params.requestId);
    assert.equal(server.raw.workspace("workspace-1").settings.catalogFolder,"Новые клиенты");
    await openFolderMenu(page,config,"Пустая");await page.getByRole("menuitem",{name:"Удалить папку…"}).click();
    await page.getByText("Папка пуста. Будет удалена только папка.",{exact:true}).waitFor();
    server.faults.gate=deferred();server.faults.lose=true;
    await page.locator('[data-folder-dialog]').getByRole("button",{name:"Удалить папку",exact:true}).click();
    await page.getByRole("heading",{name:"Результат удаления пока не подтверждён",exact:true}).waitFor();
    const empty=server.raw.workspaceFolderCatalog().folders.find(folder=>folder.name==="Пустая");
    server.raw.workspaceFolderCommand({requestId:"competing-empty-rename",action:"rename",payload:{folderId:empty.id,expectedRevision:empty.revision,name:"Пустая после изменения"}});
    server.faults.gate.release();await Promise.allSettled([...server.jobs]);
    await page.locator('[data-folder-dialog]').getByRole("button",{name:"Проверить результат",exact:true}).click();
    await page.getByRole("alert").filter({hasText:"Состав папки изменился."}).waitFor();
    assert.equal(server.calls.filter(call=>call.action==="mutate-workspace-folder").length,1);
    await capture(page,key,"remove-unknown-known-stale");
    await page.locator('[data-folder-dialog]').getByRole("button",{name:"Удалить папку",exact:true}).click();
    await page.locator('[data-folder-dialog]').waitFor({state:"detached"});
    const removals=server.calls.filter(call=>call.action==="mutate-workspace-folder");
    assert.equal(removals.length,2);assert.notEqual(removals[0].params.requestId,removals[1].params.requestId);
    await writeFile(path.join(output,`${key}-unknown-rejection-proof.json`),JSON.stringify({calls:server.calls.filter(call=>call.action.includes("folder"))},null,2));
  });

  test(`lost admitted folder response is read back without replay: ${key}`, { timeout: 30_000 }, async t => {
    const server = await catalogFixture();
    const browser = await launchBrowser();
    t.after(async () => { await browser.close(); await server.close(); });
    const page = await browser.newPage({ viewport: { width: config.width, height: config.height }, isMobile: Boolean(config.mobile), hasTouch: Boolean(config.mobile) });
    page.setDefaultTimeout(6000);
    await prepare(page,config,server);
    let release;
    server.faults.gate = { promise: new Promise(resolve => { release = resolve; }), release: () => release() };
    server.faults.lose = true;
    if (config.mobile) {
      await page.evaluate(() => window.AgentHub.showSelectedTask());
      await page.locator("[data-mobile-workspaces-open]").click();
      await page.locator('[data-workspace-folder-name="Пустая"] [data-mobile-folder-rename]').click();
    } else await page.locator('[data-workspace-folder-name="Пустая"] summary').press("Shift+F10");
    await page.getByRole("menuitem",{ name: "Удалить папку…" }).click();
    await page.getByText("Папка пуста. Будет удалена только папка.",{ exact: true }).waitFor();
    await page.locator("[data-folder-dialog]").getByRole("button",{ name: "Удалить папку", exact: true }).click();
    await page.getByRole("heading",{ name: "Результат удаления пока не подтверждён", exact: true }).waitFor();
    await capture(page,key,"remove-unknown");
    assert.equal(server.calls.filter(call => call.action === "mutate-workspace-folder").length,1);
    const check = page.locator("[data-folder-dialog]").getByRole("button",{ name: "Проверить результат", exact: true });
    await check.click();
    await page.getByText("Результат всё ещё не подтверждён.",{ exact: true }).waitFor();
    await capture(page,key,"remove-still-unknown");
    assert.equal(await check.evaluate(node => node === document.activeElement),true);
    server.faults.readFailure = true;
    await check.click();
    await page.getByRole("alert").filter({ hasText: "Не удалось проверить результат. Повторная команда не отправлена." }).waitFor();
    await capture(page,key,"readback-error");
    await page.locator("[data-folder-dialog]").getByRole("button",{ name: "Закрыть", exact: true }).click();
    await page.locator("[data-folder-dialog]").waitFor({ state: "detached" });
    await capture(page,key,"unknown-notice");
    await page.reload();
    if (config.mobile) {
      await page.evaluate(() => window.AgentHub.showSelectedTask());
      await page.locator("[data-mobile-workspaces-open]").click();
    }
    const notice = page.locator("[data-folder-notices]").getByRole("button",{ name: "Проверить результат", exact: true });
    await notice.waitFor();
    await capture(page,key,"unknown-restored");
    assert.equal(server.calls.filter(call => call.action === "mutate-workspace-folder").length,1);
    server.faults.gate.release(); await Promise.allSettled([...server.jobs]);
    assert.equal(server.raw.workspaceFolderCatalog().folders.some(folder => folder.name === "Пустая"),false);
    await notice.click();
    await page.locator("[data-folder-notice-id]").waitFor({ state: "detached" });
    assert.equal(server.calls.filter(call => call.action === "mutate-workspace-folder").length,1);
    const mutation = server.calls.find(call => call.action === "mutate-workspace-folder").params;
    const reads = server.calls.filter(call => call.action === "workspace-folder-result");
    assert.ok(reads.length >= 3);
    for (const read of reads) {
      assert.equal(read.params.requestId,mutation.requestId);
      assert.deepEqual(read.params.payload,mutation.payload);
    }
    assert.equal(server.raw.workspaceFolderCommandResult(mutation).status,"succeeded");
    await writeFile(path.join(output,`${key}-recovery-proof.json`),JSON.stringify({ mutation,reads,result:server.raw.workspaceFolderCommandResult(mutation) },null,2));
  });
}
