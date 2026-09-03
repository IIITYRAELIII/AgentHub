import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

class ElementDouble {
  constructor(rect = null) {
    this.listeners = new Map();
    this.rect = rect;
    this.children = [];
    this.attributes = new Map();
    this.localName = "";
    this.namespaceURI = "";
    this.textContent = "";
  }

  addEventListener(type, listener) {
    this.listeners.set(type, listener);
  }

  removeEventListener(type, listener) {
    if (this.listeners.get(type) === listener) this.listeners.delete(type);
  }

  dispatch(type, event = {}) {
    let prevented = false;
    this.listeners.get(type)?.({
      target: this,
      clientX: -1,
      clientY: -1,
      ...event,
      preventDefault: () => { prevented = true; },
    });
    return prevented;
  }

  getBoundingClientRect() {
    return this.rect ?? { left: 0, top: 0, right: 100, bottom: 100 };
  }

  append(...children) {
    this.children.push(...children);
  }

  replaceChildren(...children) {
    this.children = children;
    this.textContent = "";
  }

  querySelector(selector) {
    if (selector !== 'svg[data-phosphor-icon="x"]') return null;
    return this.children.find((child) => child.attributes?.get("data-phosphor-icon") === "x") ?? null;
  }

  setAttribute(name, value) {
    this.attributes.set(name, value);
  }
}

async function overlaysApi() {
  const source = await readFile(new URL("../../assets/web-app/modal-overlays.js", import.meta.url), "utf8");
  const window = {};
  vm.runInNewContext(source, { window });
  return window.AgentHubModalOverlays;
}

test("native dialog backdrop click closes but content click does not", async () => {
  const overlays = await overlaysApi();
  const dialog = new ElementDouble({ left: 10, top: 10, right: 110, bottom: 110 });
  const content = new ElementDouble({ left: 20, top: 20, right: 100, bottom: 100 });
  let closeCount = 0;

  overlays.installDismissibleOverlay({ dialog, content, close: () => { closeCount += 1; } });

  dialog.dispatch("click", { target: content, clientX: 24, clientY: 24 });
  assert.equal(closeCount, 0);

  dialog.dispatch("click", { target: dialog, clientX: 40, clientY: 40 });
  assert.equal(closeCount, 0);

  dialog.dispatch("click", { target: dialog, clientX: 4, clientY: 4 });
  assert.equal(closeCount, 1);
});

test("native dialog Escape follows the explicit close path", async () => {
  const overlays = await overlaysApi();
  const dialog = new ElementDouble();
  let closeCount = 0;

  overlays.installDismissibleOverlay({ dialog, close: () => { closeCount += 1; } });

  assert.equal(dialog.dispatch("cancel"), true);
  assert.equal(closeCount, 1);
});

test("custom scrim click invokes the same cancel callback", async () => {
  const overlays = await overlaysApi();
  const scrim = new ElementDouble();
  let result = "untouched";

  overlays.installScrimDismiss({ scrim, close: () => { result = null; } });
  scrim.dispatch("click");

  assert.equal(result, null);
});

test("modal close controls normalize raw glyphs to namespaced SVG icons", async () => {
  const overlays = await overlaysApi();
  const buttons = overlays.modalCloseIconSelectors.map(() => {
    const button = new ElementDouble();
    button.textContent = "×";
    return button;
  });
  const document = {
    querySelectorAll: (selector) => buttons.filter((_, index) => overlays.modalCloseIconSelectors[index] === selector),
    createElementNS: (namespaceURI, localName) => {
      const element = new ElementDouble();
      element.namespaceURI = namespaceURI;
      element.localName = localName;
      return element;
    },
  };

  assert.equal(overlays.installModalCloseIcons(document).length, overlays.modalCloseIconSelectors.length);

  for (const button of buttons) {
    assert.equal(button.textContent, "");
    assert.equal(button.children.length, 1);
    assert.equal(button.children[0].namespaceURI, "http://www.w3.org/2000/svg");
    assert.equal(button.children[0].localName, "svg");
    assert.equal(button.children[0].attributes.get("data-phosphor-icon"), "x");
    assert.equal(button.children[0].children.length, 2);
  }
});
