// A deliberately layout-free DOM double. Full production modules run in Node;
// these checks do not launch a browser or certify native drag/paint geometry.
export class Target {
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
      if (!capture && typeof target[`on${event.type}`] === "function") target[`on${event.type}`](event);
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
  get parentNode() { return this.parentElement; }
  get type() { return this.getAttribute("type") ?? ""; }
  get maxLength() { return Number(this.getAttribute("maxlength")); }
  get rows() { return Number(this.getAttribute("rows")); }
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
  toggleAttribute(name, enabled) { if (enabled) this.setAttribute(name, ""); else this.removeAttribute(name); }
  before(...nodes) { for (const node of nodes) this.parentElement.insertBefore(node, this); }
  insertBefore(node, anchor) {
    node.remove(); node.parentElement = this;
    const index = this.children.indexOf(anchor);
    if (index < 0) this.children.push(node); else this.children.splice(index, 0, node);
  }
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
    if (selector.includes(",")) return selector.split(",").some(value => this.matches(value.trim()));
    const parts = selector.match(/(?:\[[^\]]*\]|[^\s])+/g) ?? [];
    if (parts.length > 1) {
      if (!this.matches(parts.pop())) return false;
      let ancestor = this.parentElement;
      while (parts.length) {
        const direct = parts.at(-1) === ">";
        if (direct) parts.pop();
        const expected = parts.pop();
        if (!direct) while (ancestor && !ancestor.matches(expected)) ancestor = ancestor.parentElement;
        if (!ancestor || !ancestor.matches(expected)) return false;
        ancestor = ancestor.parentElement;
      }
      return true;
    }
    if (selector === "*" || selector === ":scope") return true;
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
  getBoundingClientRect() { return { left: 10, right: 400, top: 10, bottom: 400 }; }
  getClientRects() { return this.checkVisibility() ? [this.getBoundingClientRect()] : []; }
  scrollIntoView() {}
  setPointerCapture() {}
  releasePointerCapture() {}
  showModal() { this.dispatchEvent(new DomEvent("beforetoggle", { newState: "open", bubbles: false })); this.setAttribute("open", ""); }
  close() { this.removeAttribute("open"); this.dispatchEvent(new DomEvent("close", { bubbles: false })); }
  click() {
    if (this.disabled) return;
    const event = new DomEvent("click", { detail: 0 }); this.dispatchEvent(event);
    if (!event.defaultPrevented && this.type === "submit") this.closest("form")?.dispatchEvent(new DomEvent("submit"));
  }
}

export class Document extends Target {
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
