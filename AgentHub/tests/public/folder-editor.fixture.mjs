import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import vm from "node:vm";
import { Document, Target, DomEvent } from "../helpers/layout-free-dom.fixture.mjs";
import { catalogFixture } from "./workspace-folder.fixture.mjs";

export async function backendFixture(t) {
  const fixture = await catalogFixture({ baseSnapshot: { tasks: [], boardTasks: [] }, initialize(store) {
    store.workspaceFolderCommand({ requestId: "editor-seed", action: "create", payload: { name: "Папка" } });
    store.createWorkspace({ id: "member", name: "Member", settings: { catalogFolder: "Папка", retained: true } });
    store.createStream({ id: "stream", workspaceId: "member", name: "Stream" });
    store.bindThread({ streamId: "stream", provider: "codex", threadId: "retained-thread" });
    store.workspaceFolderCommand({ requestId: "editor-empty", action: "create", payload: { name: "Другая" } });
  } });
  t.after(fixture.close); return fixture;
}

const source = async name => process.env.AGENT_HUB_TEST_GIT_TREE
  ? execFileSync("git", ["show", `${process.env.AGENT_HUB_TEST_GIT_TREE}:AgentHub/assets/web-app/${name}`], { encoding: "utf8" })
  : readFile(new URL(`../../assets/web-app/${name}`, import.meta.url), "utf8");

// Parse static HTML into the same layout-free DOM double for structural shell
// comparison. This runs no scripts and supplies no paint/focus-trap evidence.
export function parseHtml(document, html) {
  const root = document.createElement("div"), stack = [root];
  const voids = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
  for (const token of html.match(/<!--[\s\S]*?-->|<[^>]+>|[^<]+/g) ?? []) {
    if (token.startsWith("<!")) continue;
    if (token.startsWith("</")) { if (stack.length > 1) stack.pop(); continue; }
    if (!token.startsWith("<")) continue;
    const tag = token.match(/^<([\w-]+)/)?.[1]; if (!tag) continue;
    const element = document.createElement(tag);
    for (const [, key, double, single, plain] of token.slice(tag.length + 1, -1).matchAll(/([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
      element.setAttribute(key, double ?? single ?? plain ?? "");
    }
    stack.at(-1).append(element);
    if (!voids.has(tag) && !token.endsWith("/>")) stack.push(element);
  }
  return root;
}

export async function clientFixture(backend, { width = 1280, host = "web", mobile = false, storage = new Map() } = {}) {
  const document = new Document(), window = new Target(); document.eventParent = window;
  document.documentElement.dataset.surface = mobile ? "mobile" : host;
  const parent = document.createElement("aside"), rail = document.createElement("nav");
  parent.append(rail); document.body.append(parent);
  const localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) };
  Object.assign(window, { document, localStorage });
  const context = vm.createContext({ window, document, localStorage, crypto: { randomUUID }, CSS: { escape: value => value } });
  for (const name of ["stream-tabs-controller.js", "modal-overlays.js", "workspace-folder-controller.js"]) vm.runInContext(await source(name), context, { filename: name });
  let workspaces = backend.snapshot().workspaces;
  const toasts = [], focusEvents = [];
  const controller = window.AgentHubWorkspaceFolders.create({ rail, getWorkspaces: () => workspaces,
    isMobile: () => mobile, storageKey: `folder-editor-test:${host}`, toast: text => toasts.push(text), focusResult: event => focusEvents.push(event) });
  const sync = (snapshot = backend.snapshot()) => {
    workspaces = snapshot.workspaces;
    const saved = controller.beforeRender(); controller.setCatalog(snapshot.workspaceFolders);
    rail.replaceChildren();
    for (const folder of snapshot.workspaceFolders.folders) {
      const row = document.createElement("section");
      row.dataset.workspaceFolderKind = "folder"; row.dataset.workspaceFolderName = folder.name; row.dataset.workspaceFolderId = folder.id;
      const summary = document.createElement("summary"), edit = document.createElement("button");
      edit.dataset.mobileFolderRename = ""; summary.textContent = folder.name;
      row.append(summary); if (mobile) row.append(edit); rail.append(row);
    }
    controller.decorate(); controller.afterRender(saved);
  };
  const requests=[],faults={readGate:null,catalogResponse:null};
  controller.configure({ applySnapshot: sync, control: (action, params) => {
    const promise=backend.control({ action, params, transport: host === "vscode" ? "bridge" : "http", id: randomUUID() }).then(async result=>{
      if(action==="workspace-folder-result" && faults.readGate)await faults.readGate.promise;
      if(action==="workspace-folder-catalog" && faults.catalogResponse)return faults.catalogResponse;
      return result;
    });
    requests.push({action,promise});return promise;
  } });
  sync();
  const row = id => rail.querySelectorAll("[data-workspace-folder-id]").find(item => item.dataset.workspaceFolderId === id);
  const open = (id = controller.folder("Папка")?.id) => {
    const opener = row(id)?.querySelector(mobile ? "button" : "summary"); opener?.focus();
    controller.openFolderEditor(id,opener); return opener;
  };
  const modal = () => document.querySelector('[data-folder-dialog="edit"]');
  const field = name => modal()?.querySelector(`[data-folder-edit-${name}]`);
  const submit = () => modal()?.querySelector("form").dispatchEvent(new DomEvent("submit"));
  return { window,document,rail,controller,sync,row,open,modal,field,submit,toasts,focusEvents,storage,width,host,mobile,requests,faults,
    async reference() { return parseHtml(document, await source("index.html")).querySelector("[data-workspace-card-modal]"); },
  };
}

export async function drain(backend) {
  while (backend.jobs.size) await Promise.allSettled([...backend.jobs]);
  await new Promise(resolve => setImmediate(resolve));
  if (backend.jobs.size) await drain(backend);
}
export const mutations = backend => backend.calls.filter(call => ["mutate-workspace-folder", "rename-workspace-folder", "move-workspace-to-folder"].includes(call.action));
export const cancel = client => client.modal().querySelector("footer button").click();
export const save = client => client.modal().querySelectorAll("footer button")[1].click();
export { DomEvent };
