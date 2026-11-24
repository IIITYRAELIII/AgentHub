import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { WorkspaceCatalogStore } from "../../../src/infrastructure/persistence/workspace-catalog-store.mjs";
import { TaskBoardStore } from "../../../src/infrastructure/persistence/task-board-store.mjs";

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-folder-catalog-"));
  const databaseFile = path.join(root, "journal.sqlite");
  const stores = [];
  const open = async () => {
    const store = new WorkspaceCatalogStore({ databaseFile });
    await store.load();
    stores.push(store);
    return store;
  };
  t.after(async () => {
    for (const store of stores) store.close();
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });
  return { store: await open(), open, databaseFile, root };
}

let sequence = 0;
function command(store, action, payload, requestId = `folder-test-${++sequence}`) {
  const input = { requestId, action, payload };
  const receipt = store.workspaceFolderCommand(input);
  assert.equal(receipt.requestId, requestId);
  return { input, receipt };
}

function create(store, name) {
  const { receipt } = command(store, "create", { name });
  assert.equal(receipt.status, "succeeded");
  return receipt.result.folder;
}

test("folder removal moves every member to root, preserves data and replays after restart", async t => {
  const { store, open } = await fixture(t);
  const folder = create(store, "Клиенты");
  const a = store.createWorkspace({ name: "Один", settings: { catalogFolder: folder.name, marker: "retained" } });
  const b = store.createWorkspace({ name: "Два", settings: { catalogFolder: folder.name } });
  const stream = store.createStream({ workspaceId: a.id, name: "История" });
  store.bindThread({ streamId: stream.id, provider: "codex", threadId: "retained-thread", projectRoot: "test" });
  store.archiveWorkspace(b.id);
  const preview = store.previewWorkspaceFolderDeletion(folder.id);
  assert.equal(preview.childFolders, 0);
  assert.deepEqual(new Set(preview.members.map(x => x.id)), new Set([a.id, b.id]));
  const { input, receipt } = command(store, "remove", { folderId: folder.id, previewToken: preview.token });
  assert.equal(receipt.status, "succeeded");
  assert.equal(receipt.result.members.length, 2);
  assert.equal(store.workspace(a.id).settings.catalogFolder, undefined);
  assert.equal(store.workspace(a.id).settings.marker, "retained");
  assert.equal(store.workspace(b.id).settings.catalogFolder, undefined);
  assert.ok(store.workspace(b.id).archivedAtMs);
  assert.equal(store.activeThread(stream.id).threadId, "retained-thread");
  const restarted = await open();
  assert.equal(restarted.workspaceFolderCatalog().folders.length, 0);
  assert.deepEqual(restarted.workspaceFolderCommand(input), receipt);
  assert.deepEqual(restarted.workspaceFolderCommandResult(input), receipt);
  assert.throws(() => restarted.workspaceFolderCommand({ ...input, payload: { folderId: folder.id, previewToken: "changed" } }), /identity|binding/i);
});

test("stale preview requires a second explicit command, including rename and same-name replacement", async t => {
  const { store, open } = await fixture(t);
  const folder = create(store, "Пустая");
  const preview = store.previewWorkspaceFolderDeletion(folder.id);
  const other = await open();
  other.createWorkspace({ name: "Поздний", settings: { catalogFolder: folder.name } });
  const stale = command(store, "remove", { folderId: folder.id, previewToken: preview.token });
  assert.equal(stale.receipt.status, "rejected");
  assert.equal(stale.receipt.error.code, "FOLDER_STALE");
  assert.equal(stale.receipt.error.preview.members.length, 1);
  assert.equal(store.workspaceFolderCatalog().folders.length, 1);
  const fresh = store.previewWorkspaceFolderDeletion(folder.id);
  assert.equal(command(store, "remove", { folderId: folder.id, previewToken: fresh.token }).receipt.status, "succeeded");
  const replacement = create(store, "Пустая");
  assert.notEqual(replacement.id, folder.id);
  assert.equal(command(store, "remove", { folderId: folder.id, previewToken: fresh.token }).receipt.error.code, "FOLDER_ABSENT");
  assert.equal(store.workspaceFolderCatalog().folders[0].id, replacement.id);
});

test("checked move rejects renamed targets, foreign identities and stale source membership", async t => {
  const { store } = await fixture(t);
  const first = create(store, "Первая");
  const second = create(store, "Вторая");
  const workspace = store.createWorkspace({ name: "Workspace", settings: { marker: 1 } });
  const target = { id: first.id, revision: first.revision };
  assert.equal(command(store, "rename", { folderId: first.id, expectedRevision: first.revision, name: "Новое имя" }).receipt.status, "succeeded");
  const before = structuredClone(store.workspace(workspace.id));
  const rejected = command(store, "move", { workspaceId: workspace.id, sourceFolderId: null, target });
  assert.equal(rejected.receipt.error.code, "FOLDER_STALE");
  assert.deepEqual(store.workspace(workspace.id), before);
  const moved = command(store, "move", { workspaceId: workspace.id, sourceFolderId: null, target: { id: second.id, revision: second.revision } });
  assert.equal(moved.receipt.status, "succeeded");
  assert.deepEqual(store.workspaceFolderCommand(moved.input), moved.receipt);
  assert.equal(store.workspace(workspace.id).settings.marker, 1);
  assert.equal(command(store, "move", { workspaceId: workspace.id, sourceFolderId: null, target: null }).receipt.error.code, "WORKSPACE_FOLDER_STALE");
  assert.equal(command(store, "move", { workspaceId: workspace.id, sourceFolderId: second.id, target: null }).receipt.status, "succeeded");
  assert.equal(store.workspace(workspace.id).settings.catalogFolder, undefined);
});

test("legacy empty-folder intake is idempotent and cannot resurrect deleted or renamed names", async t => {
  const { store, open } = await fixture(t);
  const first = command(store, "import", { names: ["Пустая", "Пустая", "Другая"] });
  assert.equal(first.receipt.status, "succeeded");
  const folder = store.workspaceFolderCatalog().folders.find(x => x.name === "Пустая");
  const preview = store.previewWorkspaceFolderDeletion(folder.id);
  command(store, "remove", { folderId: folder.id, previewToken: preview.token });
  command(store, "import", { names: ["Пустая", "Другая"] });
  assert.deepEqual(store.workspaceFolderCatalog().folders.map(x => x.name), ["Другая"]);
  const current = store.workspaceFolderCatalog().folders[0];
  command(store, "rename", { folderId: current.id, expectedRevision: current.revision, name: "Переименована" });
  command(store, "import", { names: ["Другая"] });
  assert.deepEqual((await open()).workspaceFolderCatalog().folders.map(x => x.name), ["Переименована"]);
});

test("receipt persistence failure rolls back all member moves and the folder deletion", async t => {
  const { store, databaseFile } = await fixture(t);
  const folder = create(store,"Atomic");
  store.createWorkspace({ id: "atomic-a", name: "A", settings: { catalogFolder: folder.name, retained: "A" } });
  store.createWorkspace({ id: "atomic-b", name: "B", settings: { catalogFolder: folder.name, retained: "B" } });
  const before = [store.workspace("atomic-a"),store.workspace("atomic-b"),store.workspaceFolderCatalog()];
  const db = new DatabaseSync(databaseFile);
  try {
    db.exec("CREATE TRIGGER reject_folder_receipt BEFORE INSERT ON hub_workspace_folder_operations WHEN NEW.request_id='atomic-refusal' BEGIN SELECT RAISE(ABORT,'injected receipt write failure'); END");
    const preview = store.previewWorkspaceFolderDeletion(folder.id);
    const input = { requestId: "atomic-refusal", action: "remove", payload: { folderId: folder.id, previewToken: preview.token } };
    assert.throws(() => store.workspaceFolderCommand(input),/injected receipt write failure/);
    assert.deepEqual([store.workspace("atomic-a"),store.workspace("atomic-b"),store.workspaceFolderCatalog()],before);
    assert.equal(store.workspaceFolderCommandResult(input).status,"unknown");
  } finally { db.close(); }
});

test("a stale full-settings writer cannot restore a deleted or renamed folder", async t => {
  const { store, databaseFile } = await fixture(t);
  const folder = create(store,"Old");
  const workspace = store.createWorkspace({ name: "Data", settings: { catalogFolder: folder.name, retained: 1 } });
  command(store,"rename",{ folderId: folder.id, expectedRevision: store.workspaceFolderCatalog().folders[0].revision, name: "Renamed" });
  assert.throws(() => store.updateWorkspaceSettings(workspace.id,workspace.settings),/membership changed/);
  const db = new DatabaseSync(databaseFile);
  try {
    assert.throws(() => db.prepare("UPDATE hub_workspaces SET settings_json=? WHERE id=?").run(JSON.stringify(workspace.settings),workspace.id),/folder identity is absent/i);
    assert.equal(store.workspace(workspace.id).settings.catalogFolder,"Renamed");
  } finally { db.close(); }
});

test("workspace name changes invalidate exact preview and another SQLite owner observes each transition", async t => {
  const { store, open } = await fixture(t);
  const folder = create(store,"Names");
  const workspace = store.createWorkspace({ name: "Before", settings: { catalogFolder: folder.name } });
  const observer = await open();
  const preview = store.previewWorkspaceFolderDeletion(folder.id);
  observer.renameWorkspace(workspace.id,"After");
  const result = command(store,"remove",{ folderId: folder.id, previewToken: preview.token });
  assert.equal(result.receipt.status,"rejected");
  assert.equal(result.receipt.error.preview.members[0].name,"After");
  assert.equal(observer.workspaceFolderCatalog().folders[0].id,folder.id);
  const next = store.previewWorkspaceFolderDeletion(folder.id);
  command(store,"remove",{ folderId: folder.id, previewToken: next.token });
  assert.equal(observer.workspaceFolderCatalog().folders.length,0);
  assert.equal(observer.workspace(workspace.id).settings.catalogFolder,undefined);
});

test("folder removal preserves Task cards, attachments, Streams and exact Thread history bindings", async t => {
  const { store, databaseFile, root } = await fixture(t);
  const folder = create(store,"Preserved");
  const workspace = store.createWorkspace({ name: "Content", settings: { catalogFolder: folder.name, workingDirectory: root } });
  const stream = store.createStream({ workspaceId: workspace.id, name: "Stream", settings: { retained: true } });
  store.bindThread({ streamId: stream.id, provider: "codex", threadId: "original-history", projectRoot: root });
  const taskBoard = new TaskBoardStore({ databaseFile });
  try {
    const file = path.join(root,"retained.txt"); await writeFile(file,"retained data\n");
    const task = taskBoard.create({ text: "Card and history", bucket: "workspace", workspaceId: workspace.id });
    taskBoard.addAttachment(task.id,file);
    const before = { task: taskBoard.task(task.id), stream: store.stream(stream.id), thread: store.activeThread(stream.id) };
    const preview = store.previewWorkspaceFolderDeletion(folder.id);
    assert.equal(command(store,"remove",{ folderId: folder.id, previewToken: preview.token }).receipt.status,"succeeded");
    assert.deepEqual({ task: taskBoard.task(task.id), stream: store.stream(stream.id), thread: store.activeThread(stream.id) },before);
    assert.equal(await readFile(file,"utf8"),"retained data\n");
    assert.equal(store.workspace(workspace.id).settings.workingDirectory,root);
  } finally { taskBoard.close(); }
});

test("legacy settings folders migrate once under the schema transaction and keep stable identities", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(),"agent-hub-folder-schema15-"));
  const databaseFile = path.join(root,"journal.sqlite");
  const legacy = new DatabaseSync(databaseFile);
  legacy.exec(`CREATE TABLE hub_workspaces (
    id TEXT PRIMARY KEY,name TEXT NOT NULL,comment TEXT NOT NULL DEFAULT '',kind TEXT NOT NULL,system_key TEXT UNIQUE,
    created_at_ms INTEGER NOT NULL,updated_at_ms INTEGER NOT NULL,settings_json TEXT NOT NULL DEFAULT '{}',archived_at_ms INTEGER,purge_after_ms INTEGER
  ); CREATE TABLE hub_workspace_catalog_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
  INSERT INTO hub_workspace_catalog_meta VALUES('schema_version','15');`);
  legacy.prepare("INSERT INTO hub_workspaces(id,name,kind,created_at_ms,updated_at_ms,settings_json) VALUES(?,?, 'user',1,1,?)")
    .run("legacy-a","A",JSON.stringify({ catalogFolder: " Клиенты ", marker: "preserved" }));
  legacy.close();
  let current = new WorkspaceCatalogStore({ databaseFile });
  t.after(async () => { current.close(); await rm(root,{ recursive: true,force: true,maxRetries: 3,retryDelay: 100 }); });
  await current.load();
  const first = current.workspaceFolderCatalog();
  assert.equal(first.folders.length,1); assert.equal(first.folders[0].name,"Клиенты");
  assert.equal(current.workspace("legacy-a").settings.marker,"preserved");
  assert.equal(current.meta("schema_version"),"16");
  current.close(); current = new WorkspaceCatalogStore({ databaseFile }); await current.load();
  assert.deepEqual(current.workspaceFolderCatalog(),first);
});

test("Workspace creation with a selected folder rejects a deleted same-name replacement", async t => {
  const { store } = await fixture(t);
  const folder = create(store,"Choice");
  const preview = store.previewWorkspaceFolderDeletion(folder.id);
  command(store,"remove",{ folderId: folder.id,previewToken: preview.token });
  create(store,"Choice");
  assert.throws(() => store.createWorkspaceWithStream({ name: "Must not appear",settings: { catalogFolder: "Choice" },folderTarget: { id: folder.id,revision: folder.revision } }),error=>error.code === "FOLDER_ABSENT");
  assert.equal(store.hierarchy().some(workspace=>workspace.name === "Must not appear"),false);
});


test("a known stale rejection remains the same receipt after restart and needs a new explicit identity", async t=>{
  const {store,open}=await fixture(t);
  const folder=create(store,"Original");
  const workspace=store.createWorkspace({name:"Root"});
  const input={requestId:"stale-original",action:"move",payload:{workspaceId:workspace.id,sourceFolderId:null,target:{id:folder.id,revision:folder.revision}}};
  command(store,"rename",{folderId:folder.id,expectedRevision:folder.revision,name:"Changed"});
  const rejected=store.workspaceFolderCommand(input);
  assert.equal(rejected.status,"rejected");assert.equal(rejected.error.code,"FOLDER_STALE");
  const restarted=await open();
  assert.deepEqual(restarted.workspaceFolderCommandResult(input),rejected);
  assert.deepEqual(restarted.workspaceFolderCommand(input),rejected);
  assert.equal(restarted.workspace(workspace.id).settings.catalogFolder,undefined);
  const current=restarted.workspaceFolderCatalog().folders[0];
  assert.equal(command(restarted,"move",{...input.payload,target:{id:current.id,revision:current.revision}},"explicit-second").receipt.status,"succeeded");
  assert.equal(restarted.workspace(workspace.id).settings.catalogFolder,"Changed");
});
