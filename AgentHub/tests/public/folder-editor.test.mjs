import assert from "node:assert/strict";
import test from "node:test";
import { backendFixture,clientFixture,drain,mutations,cancel,save,DomEvent } from "./folder-editor.fixture.mjs";

const surfaces = [{ width:1280,host:"web" },{ width:390,host:"vscode" },{ width:520,host:"vscode" },
  ...[320,390,430].map(width => ({ width,host:"web",mobile:true }))];

for (const surface of surfaces) test(`folder editor shared shell and atomic comment-only/clear: ${JSON.stringify(surface)}`, async t => {
  const backend = await backendFixture(t), h = await clientFixture(backend,surface);
  const id = h.controller.folder("Папка").id;
  h.open(id);
  assert.ok(h.field("comment"), "the old rename dialog cannot edit a folder comment");
  assert.equal(h.document.activeElement,h.field("name"));
  const reference = await h.reference();
  assert.equal(h.modal().className,reference.className);
  assert.deepEqual(h.modal().querySelector("form").children.map(node=>node.tagName),reference.querySelector("form").children.map(node=>node.tagName));
  assert.equal(h.modal().querySelector("section").className,reference.querySelector(".workspace-card-fields").className);
  assert.equal(h.field("name").maxLength,80); assert.equal(h.field("comment").maxLength,1000);
  assert.equal(h.field("comment").rows,reference.querySelector("[data-workspace-card-comment]").rows);
  assert.deepEqual(h.modal().querySelectorAll("button,input,textarea").map(node=>node.tagName),["BUTTON","INPUT","TEXTAREA","BUTTON","BUTTON"]);
  assert.equal(h.field("comment").value,"");
  assert.equal(h.modal().querySelectorAll("label").length,2);
  assert.equal(h.modal().querySelectorAll("input,textarea").length,2);
  assert.equal(h.modal().getAttribute("aria-labelledby"),h.modal().querySelector("h2").id);
  assert.deepEqual(h.modal().querySelectorAll("label").map(label=>label.querySelector("span").textContent),["Наименование","Комментарий"]);
  h.field("comment").value = "Комментарий папки"; save(h); await drain(backend);
  assert.equal(h.modal()===null,true);
  assert.equal(backend.raw.workspaceFolderCatalog().folders.find(folder=>folder.id===id).comment,"Комментарий папки");
  assert.equal(mutations(backend).length,1); assert.equal(mutations(backend)[0].params.action,"update");
  assert.equal(mutations(backend)[0].params.payload.name,"Папка");
  assert.equal(h.document.activeElement,h.row(id).querySelector(surface.mobile?"button":"summary"));
  h.open(id); assert.equal(h.field("comment").value,"Комментарий папки");
  h.field("comment").value=""; save(h); await drain(backend);
  h.open(id); assert.equal(h.field("comment").value,"");
  const before=mutations(backend).length; save(h); await drain(backend);
  assert.equal(h.modal()===null,true); assert.equal(mutations(backend).length,before,"unchanged editor closes without mutation");
});

for (const surface of surfaces) {
  const testCase=(name,run)=>test(`${name} / ${JSON.stringify(surface)}`,run);
for (const kind of ["cancel","escape","scrim","x"]) testCase(`editor dismissal retains exact opener and has no effect: ${kind}`, async t => {
  const backend=await backendFixture(t),h=await clientFixture(backend,surface); const opener=h.open();
  h.field("name").value="Несохранённое";h.field("comment").value="Черновик";
  if(kind==="cancel") cancel(h);
  if(kind==="escape") h.modal().dispatchEvent(new DomEvent("cancel"));
  if(kind==="scrim") h.modal().dispatchEvent(new DomEvent("click",{clientX:0,clientY:0}));
  if(kind==="x") h.modal().querySelector("[data-folder-edit-close]").click();
  assert.equal(h.modal()===null,true);assert.equal(h.document.activeElement,opener);assert.deepEqual(mutations(backend),[]);
  h.open();assert.equal(h.field("name").value,"Папка");assert.equal(h.field("comment").value,"");
});

testCase("pending is one checked operation, locks fields and cannot be dismissed or submitted twice", async t => {
  const backend=await backendFixture(t),h=await clientFixture(backend,surface);h.open();
  let release;backend.faults.gate={promise:new Promise(resolve=>{release=resolve;}),release};
  h.field("name").value="Переименована";h.field("comment").value="Вместе";
  save(h);save(h);h.submit();
  assert.equal(mutations(backend).length,1);assert.equal(h.modal().getAttribute("aria-busy"),"true");
  assert.equal(h.field("name").disabled,true);assert.equal(h.field("comment").disabled,true);
  cancel(h);h.modal().dispatchEvent(new DomEvent("cancel"));assert.ok(h.modal());
  release();await drain(backend);
  const folder=backend.raw.workspaceFolderCatalog().folders.find(folder=>folder.name==="Переименована");
  assert.equal(folder.comment,"Вместе");assert.equal(h.modal()===null,true);assert.equal(h.toasts.length,1);
});

for (const changed of ["name","comment","both"]) testCase(`stale ${changed} retains the draft and requires a second explicit save`, async t => {
  const backend=await backendFixture(t),h=await clientFixture(backend,surface);const id=h.controller.folder("Папка").id;h.open(id);
  h.field("name").value="Мой черновик";h.field("comment").value="Мой комментарий";
  const original=backend.raw.workspaceFolderCatalog().folders.find(folder=>folder.id===id);
  backend.raw.workspaceFolderCommand({requestId:"other-client",action:"update",payload:{folderId:id,expectedRevision:original.revision,
    name:changed==="comment"?original.name:"Чужое имя",comment:changed==="name"?"":"Чужой комментарий"}});
  h.field("comment").focus();const focused=h.document.activeElement;
  h.sync();assert.equal(h.field("name").value,"Мой черновик","snapshot cannot overwrite an open draft");
  assert.equal(h.document.activeElement===focused,true,"snapshot cannot steal focus from a draft");
  save(h);await drain(backend);
  assert.equal(mutations(backend).length,1);assert.equal(h.field("name").value,"Мой черновик");assert.equal(h.field("comment").value,"Мой комментарий");
  assert.match(h.modal().querySelector('[role="alert"]').textContent,/Ваши значения сохранены/u);
  assert.equal(h.modal().querySelectorAll("footer button")[1].textContent,"Сохранить изменения");
  save(h);await drain(backend);
  assert.equal(mutations(backend).length,2);assert.notEqual(mutations(backend)[0].params.requestId,mutations(backend)[1].params.requestId);
  const folder=backend.raw.workspaceFolderCatalog().folders.find(folder=>folder.id===id);
  assert.equal(folder.name,"Мой черновик");assert.equal(folder.comment,"Мой комментарий");
});

testCase("duplicate and deleted folder refusals preserve inputs without creating or replacing an identity", async t => {
  const backend=await backendFixture(t),h=await clientFixture(backend,surface);const id=h.controller.folder("Папка").id;h.open(id);
  h.field("name").value="Другая";h.field("comment").value="Мой текст";save(h);await drain(backend);
  assert.ok(h.modal());assert.equal(h.field("comment").value,"Мой текст");assert.equal(h.document.activeElement,h.field("name"));
  const preview=backend.raw.previewWorkspaceFolderDeletion(id);
  backend.raw.workspaceFolderCommand({requestId:"other-remove",action:"remove",payload:{folderId:id,previewToken:preview.token}});
  h.field("name").value="Новое имя";save(h);await drain(backend);
  assert.equal(h.modal().querySelectorAll("footer button")[1].disabled,true);
  assert.match(h.modal().querySelector('[role="alert"]').textContent,/больше не существует/u);
  assert.equal(h.field("comment").value,"Мой текст");
  assert.equal(backend.raw.workspaceFolderCatalog().folders.length,1);
});

for(const terminal of ["success","rejection"]) testCase(`UNKNOWN retains request and draft through readback: ${terminal}`,async t=>{
  const backend=await backendFixture(t),h=await clientFixture(backend,surface);const id=h.controller.folder("Папка").id;h.open(id);
  h.field("name").value=terminal==="success"?"Новое имя":"Другая";h.field("comment").value="Черновик";
  backend.faults.lose=true;save(h);await drain(backend);
  assert.match(h.modal().querySelector("h2").textContent,/не подтверждён/u);assert.equal(h.field("comment").value,"Черновик");
  const read=()=>h.modal().querySelectorAll("footer button")[1].click();
  backend.faults.readFailure=true;read();await drain(backend);
  assert.match(h.modal().querySelector('[role="alert"]').textContent,/Повторная команда не отправлена/u);
  assert.equal(mutations(backend).length,1);
  read();await drain(backend);
  assert.equal(mutations(backend).length,1);
  const requests=backend.calls.filter(call=>call.action==="workspace-folder-result");
  assert.ok(requests.length>=2);for(const call of requests)assert.equal(call.params.requestId,mutations(backend)[0].params.requestId);
  if(terminal==="success")assert.equal(h.modal()===null,true);
  else{assert.ok(h.modal());assert.equal(h.field("comment").value,"Черновик");assert.equal(h.field("name").disabled,false);assert.equal(h.modal().querySelector("h2").textContent,"Редактирование папки");}
});

testCase("UNKNOWN close/reload restores only a persistent notice and explicit read recovers a rejected draft",async t=>{
  const backend=await backendFixture(t),h=await clientFixture(backend,surface);h.open();h.field("name").value="Другая";h.field("comment").value="Сохранённый черновик";
  backend.faults.lose=true;save(h);await drain(backend);cancel(h);
  assert.equal(h.modal()===null,true);assert.ok(h.document.querySelector("[data-folder-notice-id]"));
  const next=await clientFixture(backend,{...surface,storage:h.storage});assert.equal(next.modal()===null,true);
  next.document.querySelector("[data-folder-notice-id]").querySelector("button").click();await drain(backend);
  assert.equal(next.modal()===null,true,"terminal rejection projects a draft notice without auto-open");
  next.document.querySelector("[data-folder-notice-id]").querySelector("button").click();await drain(backend);
  assert.equal(mutations(backend).length,1);assert.equal(next.field("comment").value,"Сохранённый черновик");
});

testCase("two clients observe the same renamed folder/comment and deletion preserves members",async t=>{
  const backend=await backendFixture(t),a=await clientFixture(backend,surface),b=await clientFixture(backend,{host:"vscode",width:520});
  const id=a.controller.folder("Папка").id;a.open(id);a.field("name").value="Общая";a.field("comment").value="Для обоих";save(a);await drain(backend);b.sync();b.open(id);
  assert.equal(b.field("name").value,"Общая");assert.equal(b.field("comment").value,"Для обоих");cancel(b);
  await a.controller.openRemove(id,a.row(id).querySelector("summary"));
  a.modal();const removal=a.document.querySelector('[data-folder-dialog="remove"]');removal.querySelectorAll("footer button")[1].click();await drain(backend);b.sync();
  assert.equal(b.controller.folderById(id),undefined);assert.equal(backend.raw.workspace("member").settings.catalogFolder,undefined);
  assert.equal(backend.raw.activeThread("stream").threadId,"retained-thread");
});

testCase("still-UNKNOWN checks never replay a gated admitted update",async t=>{
  const backend=await backendFixture(t),h=await clientFixture(backend,surface);h.open();h.field("comment").value="Gated";
  let release;backend.faults.gate={promise:new Promise(resolve=>{release=resolve;}),release};backend.faults.lose=true;
  save(h);await new Promise(resolve=>setImmediate(resolve));
  assert.match(h.modal().querySelector("h2").textContent,/не подтверждён/u);
  const primary=h.modal().querySelectorAll("footer button")[1];primary.focus();primary.click();
  await h.requests.at(-1).promise;await new Promise(resolve=>setImmediate(resolve));
  assert.equal(mutations(backend).length,1);assert.equal(h.document.activeElement===primary,true);
  assert.equal(h.field("comment").disabled,true);assert.match(h.modal().querySelector("h2").textContent,/не подтверждён/u);
  release();await drain(backend);primary.click();await drain(backend);
  assert.equal(mutations(backend).length,1);assert.equal(h.modal()===null,true);
});

testCase("rejection after close retains a named draft and never replaces another editor",async t=>{
  const backend=await backendFixture(t),h=await clientFixture(backend,surface);const id=h.controller.folder("Папка").id;
  h.open(id);h.field("name").value="Другая";h.field("comment").value="Не потерять";backend.faults.lose=true;save(h);await drain(backend);
  let release;h.faults.readGate={promise:new Promise(resolve=>{release=resolve;})};
  h.modal().querySelectorAll("footer button")[1].click();cancel(h);
  const other=h.controller.folder("Другая").id;h.open(other);h.field("comment").value="Другая форма";const editor=h.modal(),focus=h.document.activeElement;
  release();await h.requests.at(-1).promise;await drain(backend);
  assert.equal(h.modal()===editor,true);assert.equal(h.document.activeElement===focus,true);assert.equal(h.field("comment").value,"Другая форма");
  assert.equal(h.controller.blocked({folderId:id}),false);
  const notice=h.document.querySelector("[data-folder-notice-id]");assert.match(notice.getAttribute("aria-label"),/Папка/u);
  notice.querySelector("button").click();assert.equal(h.modal()===editor,true,"notice does not replace an active editor");
  cancel(h);notice.querySelector("button").click();await drain(backend);
  assert.equal(h.field("comment").value,"Не потерять");assert.ok(h.document.querySelector("[data-folder-notice-id]"),"opening alone retains the draft");
  assert.equal(mutations(backend).length,1);cancel(h);
  assert.equal(h.document.querySelector("[data-folder-notice-id]"),null,"explicit cancellation discards the retained draft");
});

testCase("success after UNKNOWN close updates canonical state without reopening a dialog",async t=>{
  const backend=await backendFixture(t),h=await clientFixture(backend,surface);h.open();h.field("comment").value="Done";backend.faults.lose=true;save(h);await drain(backend);cancel(h);
  h.document.querySelector("[data-folder-notice-id]").querySelector("button").click();await drain(backend);
  assert.equal(h.modal()===null,true);assert.equal(h.document.querySelector("[data-folder-notice-id]"),null);assert.equal(mutations(backend).length,1);assert.equal(h.toasts.length,1);
});

testCase("late success preserves another open editor and its focus",async t=>{
  const backend=await backendFixture(t),h=await clientFixture(backend,surface);h.open();h.field("comment").value="Saved";backend.faults.lose=true;save(h);await drain(backend);cancel(h);
  let release;h.faults.readGate={promise:new Promise(resolve=>{release=resolve;})};
  h.document.querySelector("[data-folder-notice-id]").querySelector("button").click();
  h.open(h.controller.folder("Другая").id);h.field("comment").value="Active draft";h.field("comment").focus();
  const editor=h.modal(),focused=h.document.activeElement;
  release();await h.requests.at(-1).promise;await drain(backend);
  assert.equal(h.modal()===editor,true);assert.equal(h.document.activeElement===focused,true);
  assert.equal(h.field("comment").value,"Active draft");assert.equal(mutations(backend).length,1);assert.equal(h.toasts.length,1);
});

for(const origin of ["notice","modal"]) testCase(`readback failure stays with its original operation: ${origin}`,async t=>{
  const backend=await backendFixture(t),h=await clientFixture(backend,surface);h.open();h.field("comment").value="Original";
  backend.faults.lose=true;save(h);await drain(backend);
  const original=mutations(backend)[0].params;
  let fail;h.faults.readGate={promise:new Promise((resolve,reject)=>{fail=reject;})};
  if(origin==="notice")cancel(h);
  const readButton=origin==="notice"?h.document.querySelector("[data-folder-notice-id] button"):h.modal().querySelectorAll("footer button")[1];
  readButton.click();const request=h.requests.at(-1).promise;
  if(origin==="modal")cancel(h);
  h.open(h.controller.folder("Другая").id);h.field("name").value="";h.submit();
  h.field("name").value="Active name";h.field("comment").value="Active comment";h.field("comment").focus();
  const editor=h.modal(),focused=h.document.activeElement,alert=editor.querySelector('[role="alert"]'),priorAlert=alert.textContent;
  fail(new Error("late addressed read failed"));await assert.rejects(request,/late addressed read failed/u);await drain(backend);
  assert.equal(h.modal()===editor,true);assert.equal(h.document.activeElement===focused,true);
  assert.equal(h.field("name").value,"Active name");assert.equal(h.field("comment").value,"Active comment");
  assert.equal(alert.textContent,priorAlert,"another editor keeps its own alert");assert.equal(alert.hidden,false);
  const notice=h.document.querySelector("[data-folder-notice-id]");
  assert.match(notice.querySelector('[role="alert"]').textContent,/Не удалось проверить результат/u);
  assert.equal(mutations(backend).length,1);
  const reads=backend.calls.filter(call=>call.action==="workspace-folder-result");assert.equal(reads.length,1);
  assert.equal(reads[0].params.requestId,original.requestId);assert.deepEqual(reads[0].params.payload,original.payload);
  cancel(h);assert.match(h.document.querySelector('[data-folder-notice-id] [role="alert"]').textContent,/Повторная команда не отправлена/u);
  h.faults.readGate=null;h.document.querySelector("[data-folder-notice-id] button").click();await drain(backend);
  assert.equal(h.document.querySelector("[data-folder-notice-id]"),null);assert.equal(h.modal()===null,true);assert.equal(mutations(backend).length,1);
  assert.equal(backend.calls.filter(call=>call.action==="workspace-folder-result").length,2);
  assert.equal(backend.calls.filter(call=>call.action==="workspace-folder-result")[1].params.requestId,original.requestId);
});

testCase("draft CTA safely reads a deleted identity and never recreates the folder",async t=>{
  const backend=await backendFixture(t),h=await clientFixture(backend,surface);const id=h.controller.folder("Папка").id;
  h.open(id);h.field("name").value="Другая";h.field("comment").value="Draft";backend.faults.lose=true;save(h);await drain(backend);cancel(h);
  h.document.querySelector("[data-folder-notice-id]").querySelector("button").click();await drain(backend);
  const preview=backend.raw.previewWorkspaceFolderDeletion(id);
  backend.raw.workspaceFolderCommand({requestId:"delete-before-draft",action:"remove",payload:{folderId:id,previewToken:preview.token}});h.sync();
  h.document.querySelector("[data-folder-notice-id]").querySelector("button").click();await drain(backend);
  assert.equal(h.field("comment").value,"Draft");assert.equal(h.modal().querySelectorAll("footer button")[1].disabled,true);
  assert.match(h.modal().querySelector('[role="alert"]').textContent,/больше не существует/u);
  assert.equal(mutations(backend).length,1);assert.equal(backend.raw.workspaceFolderCatalog().folders.some(folder=>folder.id===id),false);
});

testCase("an incomplete stale read cannot declare deletion or admit a save",async t=>{
  const backend=await backendFixture(t),h=await clientFixture(backend,surface);const base=h.controller.folder("Папка");h.open(base.id);h.field("comment").value="Draft";
  backend.raw.workspaceFolderCommand({requestId:"before-incomplete-read",action:"update",payload:{folderId:base.id,expectedRevision:base.revision,name:base.name,comment:"Other"}});
  h.faults.catalogResponse={};save(h);await drain(backend);
  assert.equal(h.modal().querySelectorAll("footer button")[1].disabled,true);assert.equal(h.field("comment").value,"Draft");
  assert.match(h.modal().querySelector('[role="alert"]').textContent,/Не удалось обновить сведения/u);
  assert.equal(mutations(backend).length,1);h.faults.catalogResponse=null;
  h.modal().querySelectorAll(".board-task-quiet").find(node=>node.textContent==="Проверить снова").click();await drain(backend);
  assert.equal(mutations(backend).length,1);save(h);await drain(backend);assert.equal(mutations(backend).length,2);
});

}
