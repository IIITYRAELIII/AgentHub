import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import vm from "node:vm";

// A deliberately layout-free DOM double. Full production modules run in Node;
// these checks do not launch a browser or certify native drag/paint geometry.
class Target {
  listeners = new Map();
  addEventListener(type, fn, options) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push({ fn, capture: options === true || options?.capture === true });
    this.listeners.set(type, listeners);
  }
  removeEventListener(type, fn) {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter(entry => entry.fn !== fn));
  }
  dispatchEvent(event) {
    event.target ??= this;
    const path = [];
    for (let target = this; target; target = target.parentElement ?? target.eventParent) path.push(target);
    const call = (target, capture) => {
      event.currentTarget = target;
      for (const entry of target.listeners.get(event.type) ?? []) {
        if (entry.capture === capture) entry.fn(event);
        if (event.immediateStopped) break;
      }
    };
    for (const target of [...path].reverse()) { call(target, true); if (event.stopped) break; }
    if (!event.stopped) for (const target of path) {
      call(target, false);
      if (event.stopped || !event.bubbles) break;
    }
    return !event.defaultPrevented;
  }
}

export class DomEvent {
  constructor(type, values = {}) { Object.assign(this, { type, bubbles: true, defaultPrevented: false }, values); }
  preventDefault() { this.defaultPrevented = true; }
  stopPropagation() { this.stopped = true; }
  stopImmediatePropagation() { this.immediateStopped = this.stopped = true; }
}

class Element extends Target {
  constructor(tag, document) {
    super();
    this.tagName = tag.toUpperCase();
    this.ownerDocument = document;
    this.attributes = new Map();
    this.children = [];
    this.value = "";
    this.scrollTop = this.scrollLeft = 0;
    this.style = { setProperty() {}, removeProperty() {} };
    this.dataset = new Proxy({}, {
      get: (_target, key) => this.getAttribute(`data-${String(key).replace(/[A-Z]/g, c => `-${c.toLowerCase()}`)}`) ?? undefined,
      set: (_target, key, value) => { this.setAttribute(`data-${String(key).replace(/[A-Z]/g, c => `-${c.toLowerCase()}`)}`, value); return true; },
    });
    this.classList = {
      contains: value => this.className.split(/\s+/).includes(value),
      add: value => { this.className = [...new Set([...this.className.split(/\s+/).filter(Boolean), value])].join(" "); },
      remove: value => { this.className = this.className.split(/\s+/).filter(item => item !== value).join(" "); },
      toggle: (value, force) => {
        const enabled = force ?? !this.classList.contains(value);
        this.classList[enabled ? "add" : "remove"](value); return enabled;
      },
    };
  }
  get className() { return this.getAttribute("class") ?? ""; }
  set className(value) { this.setAttribute("class", value); }
  get id() { return this.getAttribute("id") ?? ""; }
  get hidden() { return this.attributes.has("hidden"); }
  set hidden(value) { if (value) this.setAttribute("hidden", ""); else this.removeAttribute("hidden"); }
  get disabled() { return this.attributes.has("disabled"); }
  set disabled(value) { if (value) this.setAttribute("disabled", ""); else this.removeAttribute("disabled"); }
  get open() { return this.attributes.has("open"); }
  get options() { return this.children; }
  get isConnected() { return this.ownerDocument.documentElement.contains(this); }
  get textContent() { return this.ownText ?? this.children.map(child => child.textContent).join(""); }
  set textContent(value) { this.ownText = String(value); this.replaceChildren(); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  removeAttribute(name) { this.attributes.delete(name); }
  hasAttribute(name) { return this.attributes.has(name); }
  append(...children) {
    for (const child of children) { child.remove(); child.parentElement = this; this.children.push(child); }
  }
  prepend(child) { this.append(child); this.children.unshift(this.children.pop()); }
  replaceChildren(...children) {
    for (const child of this.children) child.parentElement = null;
    this.children = []; this.append(...children);
  }
  remove() {
    if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this);
    this.parentElement = null;
  }
  contains(node) { return this === node || this.children.some(child => child.contains(node)); }
  matches(selector) {
    if (selector === ":popover-open") return this.popoverOpen === true;
    if (selector === "dialog:modal") return this.tagName === "DIALOG" && this.open;
    const attributes = [...selector.matchAll(/\[([^\s\]=]+)(?:=['"]?([^'"\]]*)['"]?)?\]/g)];
    for (const [, name, value] of attributes) if (!this.hasAttribute(name) || (value !== undefined && this.getAttribute(name) !== value)) return false;
    const rest = selector.replace(/\[[^\]]+\]/g, "");
    const tag = rest.match(/^[a-z][\w-]*/i)?.[0];
    if (tag && this.tagName !== tag.toUpperCase()) return false;
    const id = rest.match(/#([\w-]+)/)?.[1];
    if (id && this.id !== id) return false;
    return [...rest.matchAll(/\.([\w-]+)/g)].every(([, name]) => this.classList.contains(name));
  }
  closest(selector) { for (let node = this; node; node = node.parentElement) if (node.matches(selector)) return node; return null; }
  querySelectorAll(selector) {
    const selectors = selector.split(",").map(item => item.trim());
    const result = [];
    const visit = node => { for (const child of node.children) {
      if (selectors.some(item => child.matches(item))) result.push(child);
      visit(child);
    } };
    visit(this); return result;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  checkVisibility() { return this.isConnected && !this.closest("[hidden]"); }
  focus() { this.ownerDocument.activeElement = this; }
  scrollIntoView() {}
  setPointerCapture() {}
  releasePointerCapture() {}
  showModal() { this.dispatchEvent(new DomEvent("beforetoggle", { newState: "open", bubbles: false })); this.setAttribute("open", ""); }
  close() { this.removeAttribute("open"); this.dispatchEvent(new DomEvent("close", { bubbles: false })); }
  click() { if (!this.disabled) this.dispatchEvent(new DomEvent("click", { detail: 0 })); }
}

class Document extends Target {
  constructor() {
    super(); this.readyState = "loading";
    this.documentElement = new Element("html", this);
    this.documentElement.eventParent = this;
    this.body = this.createElement("body"); this.documentElement.append(this.body);
  }
  createElement(tag) { return new Element(tag, this); }
  createElementNS(_namespace, tag) { return this.createElement(tag); }
  querySelector(selector) { return this.documentElement.querySelector(selector); }
  querySelectorAll(selector) { return this.documentElement.querySelectorAll(selector); }
}

export async function openBoard({ width = 1280, withCard = false } = {}) {
  const document = new Document();
  const window = new Target(); document.eventParent = window;
  let viewportWidth = width;
  let uuid = 0;
  Object.assign(window, {
    document, setTimeout, clearTimeout,
    crypto: { randomUUID: () => `test-command-${++uuid}` },
    matchMedia: query => ({ matches: query.includes("min-width") ? viewportWidth >= 960 : viewportWidth <= 959 }),
    localStorage: { getItem: key => key.endsWith(".view") ? "workspaces" : key.endsWith(".task-open") ? "modal" : null, setItem() {} },
    getComputedStyle: () => ({ borderTopWidth: "0", borderBottomWidth: "0" }),
    AgentHub: { toast() {} },
    AgentHubCommandTrace: { measure: (_kind, _name, action) => action() },
    requestAnimationFrame: () => 1, cancelAnimationFrame() {},
    AgentHubActivityRailLayout: { countedActivityHeading: (label, count) => `${label} ${count}` },
  });
  const add = (parent, tag, attrs) => {
    const element = document.createElement(tag);
    for (const [name, value] of Object.entries(attrs)) element.setAttribute(name, value);
    parent.append(element); return element;
  };
  const board = add(document.body, "section", { "data-task-board": "" });
  const sidebar = add(board, "aside", { class: "task-board-sidebar" });
  const scopes = add(sidebar, "nav", { "data-task-board-scopes": "" });
  const popover = add(board, "div", { "data-task-board-scope-popover": "" });
  add(board, "div", { "data-task-board-columns": "" });
  const completed = add(board, "button", { "data-task-board-completed-toggle": "" });
  const statusFilter = add(board, "select", { "data-task-board-status-filter": "" });
  add(board, "div", { "data-workspace-task-panel": "" });
  add(board, "div", { "data-stream-task-list": "" });
  add(board, "div", { "data-workspace-task-list": "" });
  add(board, "form", { "data-task-start-new": "" });
  if (withCard) {
    const card = add(board, "dialog", { "data-task-card-modal": "" });
    for (const key of ["source", "number", "original", "original-text", "attachments", "actions"]) add(card, "div", { [`data-task-card-${key}`]: "" });
    add(card, "textarea", { "data-task-card-title": "" });
    add(card, "textarea", { "data-task-card-description": "" });
    const status = add(card, "div", { class: "task-card-status-field" });
    add(status, "select", { "data-task-card-status": "" });
    add(card, "div", { class: "task-card-content" });
  }
  const context = vm.createContext({ window, document, CustomEvent: DomEvent, setTimeout, clearTimeout });
  for (const name of ["task-references.js", "stream-tabs-controller.js", "modal-overlays.js", "task-board.js"]) {
    const file = `AgentHub/assets/web-app/${name}`;
    const source = process.env.AGENT_HUB_TEST_GIT_TREE
      ? execFileSync("git", ["show", `${process.env.AGENT_HUB_TEST_GIT_TREE}:${file}`], { encoding: "utf8" })
      : await readFile(new URL(`../../assets/web-app/${name}`, import.meta.url), "utf8");
    vm.runInContext(source, context, { filename: name });
  }
  const actions = [];
  document.addEventListener("agenthub:board-action", event => actions.push(structuredClone(event.detail)));
  const row = scope => scopes.querySelector(`[data-board-scope="${scope}"]`);
  const transfer = (task, { protectedData = false } = {}) => {
    const values = new Map();
    const data = { types: [], getData: type => protectedData ? "" : values.get(type) ?? "",
      setData(type, value) { values.set(type, value); this.types = [...values.keys()]; } };
    if (task) window.AgentHubTaskReferences.beginDrag(data, task);
    return data;
  };
  const dispatch = (target, type, values) => { const event = new DomEvent(type, values); target.dispatchEvent(event); return event; };
  return { window, document, board, scopes, popover, completed, statusFilter, row, actions, transfer, dispatch,
    api: window.AgentHubTaskBoard,
    resize(value) { viewportWidth = value; window.dispatchEvent(new DomEvent("resize")); },
  };
}
