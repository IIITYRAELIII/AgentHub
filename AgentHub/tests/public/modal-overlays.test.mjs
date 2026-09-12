import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
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
      type,
      target: this,
      clientX: -1,
      clientY: -1,
      button: 0,
      isPrimary: true,
      ...event,
      preventDefault: () => { prevented = true; },
      stopPropagation: () => {},
      stopImmediatePropagation: () => {},
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
  vm.runInNewContext(source, { window, queueMicrotask });
  return window.AgentHubModalOverlays;
}

async function launchDomBrowser(chromium) {
  if (process.platform === "win32") return chromium.launch({ channel: "msedge", headless: true });
  return chromium.launch({ headless: true });
}

test("native dialog dismisses only on a primary pointerdown outside content", async () => {
  const overlays = await overlaysApi();
  const dialog = new ElementDouble({ left: 10, top: 10, right: 110, bottom: 110 });
  const content = new ElementDouble({ left: 20, top: 20, right: 100, bottom: 100 });
  let closeCount = 0;

  overlays.installDismissibleOverlay({ dialog, content, close: () => { closeCount += 1; } });

  dialog.dispatch("pointerdown", { target: content, clientX: 24, clientY: 24 });
  assert.equal(closeCount, 0);

  dialog.dispatch("pointerdown", { target: dialog, clientX: 40, clientY: 40 });
  assert.equal(closeCount, 0);

  dialog.dispatch("click", { target: dialog, clientX: 4, clientY: 4 });
  dialog.dispatch("pointerup", { target: dialog, clientX: 4, clientY: 4 });
  assert.equal(closeCount, 0);

  dialog.dispatch("pointerdown", { target: dialog, clientX: 4, clientY: 4, button: 2 });
  assert.equal(closeCount, 0);

  dialog.dispatch("pointerdown", { target: dialog, clientX: 4, clientY: 4 });
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

test("custom scrim requires a direct primary pointerdown", async () => {
  const overlays = await overlaysApi();
  const scrim = new ElementDouble();
  let result = "untouched";

  overlays.installScrimDismiss({ scrim, close: () => { result = null; } });
  scrim.dispatch("click");
  assert.equal(result, "untouched");

  scrim.dispatch("pointerdown", { target: new ElementDouble() });
  assert.equal(result, "untouched");

  scrim.dispatch("pointerdown");

  assert.equal(result, null);
});

test("pointerdown dismissal absorbs its compatibility click and preserves nested focus on every surface", async () => {
  const { chromium } = await import("playwright");
  const browser = await launchDomBrowser(chromium);
  try {
    for (const [surface, viewport] of [
      ["web", { width: 1280, height: 800 }],
      ["webview", { width: 520, height: 720 }],
      ["mobile", { width: 390, height: 844 }],
    ]) {
      const page = await browser.newPage({ viewport });
      await page.setContent(`<!doctype html><html data-surface="${surface}"><body>
        <button id="underlying">underlying</button>
        <button id="native-opener">native opener</button>
        <dialog id="native"><section id="native-content"><button id="native-close">close</button></section></dialog>
        <div id="sibling-a" hidden><section role="dialog" aria-modal="true"><button id="sibling-a-control">A</button></section></div>
        <div id="sibling-b" hidden><section role="dialog" aria-modal="true"><button id="sibling-b-control">B</button></section></div>
        <div id="parent-scrim" hidden><section id="parent-content" role="dialog" aria-modal="true"><button id="child-opener">child opener</button><button id="parent-control">parent</button>
          <div id="child-scrim" hidden><section id="child-content"><button id="child-control">child</button></section></div>
        </section></div>
      </body></html>`);
      await page.addScriptTag({ path: fileURLToPath(new URL("../../assets/web-app/modal-overlays.js", import.meta.url)) });
      await page.evaluate(() => {
        window.__overlayCounts = {
          native: 0, parent: 0, child: 0, siblingA: 0, siblingB: 0, underlying: 0,
        };
        const native = document.querySelector("#native");
        const nativeContent = document.querySelector("#native-content");
        const parentScrim = document.querySelector("#parent-scrim");
        const childScrim = document.querySelector("#child-scrim");
        const childOpener = document.querySelector("#child-opener");
        const closeNative = () => {
          window.__overlayCounts.native += 1;
          if (native.open) native.close();
        };
        document.querySelector("#underlying").addEventListener("click", () => {
          window.__overlayCounts.underlying += 1;
        });
        document.querySelector("#native-close").addEventListener("click", closeNative);
        window.AgentHubModalOverlays.installDismissibleOverlay({
          dialog: native,
          content: nativeContent,
          close: closeNative,
        });
        window.AgentHubModalOverlays.installScrimDismiss({
          scrim: parentScrim,
          close: () => {
            window.__overlayCounts.parent += 1;
            parentScrim.hidden = true;
          },
        });
        window.AgentHubModalOverlays.installScrimDismiss({
          scrim: childScrim,
          close: () => {
            window.__overlayCounts.child += 1;
            childScrim.hidden = true;
          },
          returnFocus: childOpener,
        });
        for (const [id, key] of [["sibling-a", "siblingA"], ["sibling-b", "siblingB"]]) {
          const scrim = document.querySelector(`#${id}`);
          window.AgentHubModalOverlays.installScrimDismiss({
            scrim,
            close: () => {
              window.__overlayCounts[key] += 1;
              scrim.hidden = true;
            },
          });
        }
      });
      const dispatchPointer = (selector, type, init) => page.locator(selector).evaluate((node, payload) => {
        node.dispatchEvent(new PointerEvent(payload.type, {
          bubbles: true,
          cancelable: true,
          pointerId: payload.pointerId ?? 1,
          pointerType: payload.pointerType ?? "mouse",
          isPrimary: payload.isPrimary ?? true,
          button: payload.button ?? 0,
          detail: payload.detail ?? (payload.type === "click" ? 1 : 0),
          clientX: payload.clientX ?? 1,
          clientY: payload.clientY ?? 1,
        }));
      }, { type, ...init });

      await page.locator("#native-opener").focus();
      await page.evaluate(() => document.querySelector("#native").showModal());
      await dispatchPointer("#native-content", "pointerdown", { clientX: 20, clientY: 20 });
      await dispatchPointer("#native", "pointerup", { clientX: 1, clientY: 1 });
      await page.locator("#native").dispatchEvent("click", { button: 0, clientX: 1, clientY: 1 });
      assert.equal(await page.evaluate(() => window.__overlayCounts.native), 0, surface);
      await dispatchPointer("#native", "pointerdown", { button: 2 });
      await dispatchPointer("#native", "pointerdown", { button: 1 });
      assert.equal(await page.evaluate(() => window.__overlayCounts.native), 0, surface);
      const pointerType = surface === "mobile" ? "touch" : "pen";
      await dispatchPointer("#native", "pointerdown", {
        pointerId: 7, pointerType, clientX: 10, clientY: 10,
      });
      await dispatchPointer("#underlying", "pointerup", {
        pointerId: 7, pointerType, clientX: 44, clientY: 44,
      });
      await dispatchPointer("#underlying", "click", {
        pointerId: 7, pointerType, clientX: 44, clientY: 44,
      });
      assert.equal(await page.evaluate(() => window.__overlayCounts.underlying), 0, surface);
      assert.equal(await page.evaluate(() => window.__overlayCounts.native), 1, surface);
      assert.equal(await page.evaluate(() => document.activeElement?.id), "native-opener", surface);

      await page.evaluate(() => document.querySelector("#native").showModal());
      await page.locator("#native-close").click();
      assert.equal(await page.evaluate(() => document.activeElement?.id), "native-opener", surface);
      await page.evaluate(() => document.querySelector("#native").showModal());
      await page.locator("#native").evaluate((node) => node.dispatchEvent(new Event("cancel", {
        bubbles: false,
        cancelable: true,
      })));
      assert.equal(await page.evaluate(() => window.__overlayCounts.native), 3, surface);
      assert.equal(await page.evaluate(() => document.activeElement?.id), "native-opener", surface);

      await page.evaluate(() => document.querySelector("#native").showModal());
      await dispatchPointer("#native", "pointerdown", { pointerId: 8, pointerType });
      await dispatchPointer("#underlying", "pointercancel", {
        pointerId: 8, pointerType, button: -1, clientX: 80, clientY: 80,
      });
      await dispatchPointer("#underlying", "click", { pointerId: 8, pointerType, detail: 0 });
      assert.equal(await page.evaluate(() => window.__overlayCounts.underlying), 1, surface);

      await page.evaluate(() => document.querySelector("#native").showModal());
      await dispatchPointer("#native", "pointerdown", { pointerId: 9, pointerType });
      await dispatchPointer("#underlying", "pointerup", { pointerId: 9, pointerType, clientX: 70, clientY: 70 });
      await dispatchPointer("#underlying", "pointerdown", { pointerId: 10, pointerType, clientX: 12, clientY: 12 });
      await dispatchPointer("#underlying", "pointerup", { pointerId: 10, pointerType, clientX: 12, clientY: 12 });
      await dispatchPointer("#underlying", "click", { pointerId: 10, pointerType, clientX: 12, clientY: 12 });
      assert.equal(await page.evaluate(() => window.__overlayCounts.underlying), 2, surface);
      await dispatchPointer("#underlying", "click", { pointerId: 9, pointerType, clientX: 70, clientY: 70 });
      assert.equal(await page.evaluate(() => window.__overlayCounts.underlying), 2, surface);

      await dispatchPointer("#underlying", "pointerdown", { pointerId: 9, pointerType, clientX: 12, clientY: 12 });
      await dispatchPointer("#underlying", "pointerup", { pointerId: 9, pointerType, clientX: 12, clientY: 12 });
      await dispatchPointer("#underlying", "click", { pointerId: 9, pointerType, clientX: 12, clientY: 12 });
      assert.equal(await page.evaluate(() => window.__overlayCounts.underlying), 3, surface);

      await page.evaluate(() => {
        const api = window.AgentHubModalOverlays;
        const siblingA = document.querySelector("#sibling-a");
        const siblingB = document.querySelector("#sibling-b");
        siblingA.hidden = false;
        api.activateOverlay(siblingA);
        siblingB.hidden = false;
        api.activateOverlay(siblingB);
      });
      await dispatchPointer("#sibling-a", "pointerdown", { pointerId: 20, pointerType });
      assert.deepEqual(await page.evaluate(() => ({
        a: window.__overlayCounts.siblingA,
        b: window.__overlayCounts.siblingB,
      })), { a: 0, b: 0 }, surface);
      await dispatchPointer("#sibling-b", "pointerdown", { pointerId: 21, pointerType });
      assert.deepEqual(await page.evaluate(() => ({
        a: window.__overlayCounts.siblingA,
        b: window.__overlayCounts.siblingB,
      })), { a: 0, b: 1 }, surface);
      await dispatchPointer("#underlying", "pointercancel", { pointerId: 21, pointerType, button: -1 });
      await dispatchPointer("#sibling-a", "pointerdown", { pointerId: 22, pointerType });
      assert.deepEqual(await page.evaluate(() => ({
        a: window.__overlayCounts.siblingA,
        b: window.__overlayCounts.siblingB,
      })), { a: 1, b: 1 }, surface);
      await dispatchPointer("#underlying", "pointercancel", { pointerId: 22, pointerType, button: -1 });

      await page.evaluate(() => {
        const api = window.AgentHubModalOverlays;
        const parent = document.querySelector("#parent-scrim");
        const child = document.querySelector("#child-scrim");
        parent.hidden = false;
        api.activateOverlay(parent);
        child.hidden = false;
        api.activateOverlay(child);
        document.querySelector("#child-control").focus();
      });
      await dispatchPointer("#child-scrim", "pointerdown", { pointerId: 3, pointerType: "touch" });
      assert.deepEqual(await page.evaluate(() => ({
        parent: window.__overlayCounts.parent,
        child: window.__overlayCounts.child,
        parentHidden: document.querySelector("#parent-scrim").hidden,
        childHidden: document.querySelector("#child-scrim").hidden,
        focus: document.activeElement?.id,
      })), {
        parent: 0,
        child: 1,
        parentHidden: false,
        childHidden: true,
        focus: "child-opener",
      }, surface);
      await page.evaluate(() => {
        const api = window.AgentHubModalOverlays;
        document.querySelector("#child-opener").remove();
        const child = document.querySelector("#child-scrim");
        child.hidden = false;
        api.activateOverlay(child);
        document.querySelector("#child-control").focus();
      });
      await dispatchPointer("#child-scrim", "pointerdown", { pointerId: 4, pointerType: "pen" });
      assert.equal(await page.evaluate(() => document.activeElement?.id), "parent-control", surface);
      await page.close();
    }
  } finally {
    await browser.close();
  }
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
