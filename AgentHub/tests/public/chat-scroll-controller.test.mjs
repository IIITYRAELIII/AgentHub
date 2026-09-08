import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

class FakeTarget {
  constructor() {
    this.listeners = new Map();
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type, listener) {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((item) => item !== listener));
  }

  dispatch(type, event = {}) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

function fakeScrollButton() {
  const nodes = new Map([
    [".chat-scroll-label", { textContent: "" }],
    [".chat-scroll-count", { hidden: true, textContent: "" }],
  ]);
  return Object.assign(new FakeTarget(), {
    hidden: false,
    attributes: new Set(),
    dataset: {},
    querySelector(selector) {
      return nodes.get(selector) ?? null;
    },
    toggleAttribute(name, enabled) {
      if (enabled) this.attributes.add(name);
      else this.attributes.delete(name);
    },
    label: nodes.get(".chat-scroll-label"),
    count: nodes.get(".chat-scroll-count"),
  });
}

async function scrollApi() {
  const source = await readFile(new URL("../../assets/web-app/chat-scroll-controller.js", import.meta.url), "utf8");
  const window = {
    requestAnimationFrame: (callback) => { callback(0); return 1; },
    cancelAnimationFrame: () => {},
    matchMedia: () => ({ matches: true }),
    ResizeObserver: null,
  };
  vm.runInNewContext(source, { window });
  return window.AgentHubChatScroll;
}

test("chat scroll controller follows the bottom until the reader moves away", async () => {
  const { ChatScrollController } = await scrollApi();
  const scroll = Object.assign(new FakeTarget(), {
    scrollHeight: 1_000,
    clientHeight: 200,
    scrollTop: 800,
  });
  const button = Object.assign(new FakeTarget(), { hidden: false });
  const controller = new ChatScrollController(scroll, button, {
    reducedMotion: () => true,
    requestAnimationFrame: (callback) => { callback(0); return 1; },
    cancelAnimationFrame: () => {},
    ResizeObserver: null,
  });
  assert.equal(button.hidden, true);
  scroll.dispatch("wheel");
  scroll.scrollTop = 500;
  scroll.dispatch("scroll");
  assert.equal(button.hidden, false);
  assert.equal(controller.capture().pinned, false);
  button.dispatch("click");
  assert.equal(scroll.scrollTop, 1_000);
  assert.equal(button.hidden, true);
});

test("chat scroll controller restores distance from bottom after DOM replacement", async () => {
  const { ChatScrollController } = await scrollApi();
  const scroll = Object.assign(new FakeTarget(), {
    scrollHeight: 1_000,
    clientHeight: 200,
    scrollTop: 500,
  });
  const controller = new ChatScrollController(scroll, null, {
    requestAnimationFrame: (callback) => { callback(0); return 1; },
    cancelAnimationFrame: () => {},
    ResizeObserver: null,
  });
  const snapshot = controller.capture();
  scroll.scrollHeight = 1_200;
  controller.afterMutation(snapshot, { preserveDistance: true });
  assert.equal(scroll.scrollTop, 700);
});

test("exact navigation suppresses queued resize correction until its target position settles", async () => {
  const { ChatScrollController } = await scrollApi();
  const frames = [];
  const scroll = Object.assign(new FakeTarget(), {
    scrollHeight: 1_000,
    clientHeight: 200,
    scrollTop: 500,
  });
  const controller = new ChatScrollController(scroll, null, {
    requestAnimationFrame: (callback) => { frames.push(callback); return frames.length; },
    cancelAnimationFrame: () => {},
    ResizeObserver: null,
  });
  frames.shift()(0);

  const generation = controller.beginExactNavigation();
  scroll.scrollHeight = 60_000;
  scroll.scrollTop = 3_453;
  scroll.dispatch("scroll");
  controller.completeExactNavigation(generation);
  controller.handleResize();
  assert.equal(scroll.scrollTop, 3_453);

  frames.shift()(16);
  controller.handleResize();
  assert.equal(scroll.scrollTop, 3_453);
  frames.shift()(32);
  assert.equal(controller.exactNavigationActive, false);
  assert.equal(scroll.scrollTop, 3_453);
});

test("chat history requests another page only while older messages can fill the viewport", async () => {
  const { shouldLoadOlderPage } = await scrollApi();
  const shortHistory = { scrollHeight: 200, clientHeight: 240 };
  assert.equal(shouldLoadOlderPage(shortHistory, { hasOlder: true, loading: false }), true);
  assert.equal(shouldLoadOlderPage(shortHistory, { hasOlder: true, loading: true }), false);
  assert.equal(shouldLoadOlderPage(shortHistory, { hasOlder: false, loading: false }), false);
  assert.equal(shouldLoadOlderPage({ scrollHeight: 400, clientHeight: 240 }, {
    hasOlder: true,
    loading: false,
  }), false);
});

test("chat scroll controller requests history near the top and exposes working state", async () => {
  const { ChatScrollController } = await scrollApi();
  const scroll = Object.assign(new FakeTarget(), {
    scrollHeight: 1_000,
    clientHeight: 200,
    scrollTop: 40,
  });
  const button = Object.assign(new FakeTarget(), {
    hidden: false,
    attributes: new Set(),
    toggleAttribute(name, enabled) {
      if (enabled) this.attributes.add(name);
      else this.attributes.delete(name);
    },
  });
  let requests = 0;
  const controller = new ChatScrollController(scroll, button, {
    onNearTop: () => { requests += 1; },
    requestAnimationFrame: (callback) => { callback(0); return 1; },
    cancelAnimationFrame: () => {},
    ResizeObserver: null,
  });
  await Promise.resolve();
  assert.equal(requests, 1);
  controller.setWorking(true);
  assert.equal(button.attributes.has("data-working"), true);
});

test("chat scroll controller shows running label while pinned at the bottom", async () => {
  const { ChatScrollController } = await scrollApi();
  const scroll = Object.assign(new FakeTarget(), {
    scrollHeight: 1_000,
    clientHeight: 200,
    scrollTop: 800,
  });
  const button = fakeScrollButton();
  const controller = new ChatScrollController(scroll, button, {
    requestAnimationFrame: (callback) => { callback(0); return 1; },
    cancelAnimationFrame: () => {},
    ResizeObserver: null,
  });

  assert.equal(button.hidden, true);
  controller.setWorking(true);
  assert.equal(button.hidden, false);
  assert.equal(button.attributes.has("data-working"), true);
  assert.equal(button.label.textContent, "Ход идёт");
});

test("chat scroll controller counts unseen messages and clears them at the bottom", async () => {
  const { ChatScrollController } = await scrollApi();
  const scroll = Object.assign(new FakeTarget(), {
    scrollHeight: 1_000,
    clientHeight: 200,
    scrollTop: 500,
  });
  const button = fakeScrollButton();
  const controller = new ChatScrollController(scroll, button, {
    reducedMotion: () => true,
    requestAnimationFrame: (callback) => { callback(0); return 1; },
    cancelAnimationFrame: () => {},
    ResizeObserver: null,
  });
  const snapshot = controller.capture();
  scroll.scrollHeight = 1_120;
  controller.afterMutation(snapshot, { preserveDistance: true, newItemsCount: 2 });

  assert.equal(button.hidden, false);
  assert.equal(button.attributes.has("data-has-unread"), true);
  assert.equal(button.dataset.unreadCount, "2");
  assert.equal(button.count.hidden, false);
  assert.equal(button.count.textContent, "2");

  button.dispatch("click");
  assert.equal(button.attributes.has("data-has-unread"), false);
  assert.equal(button.dataset.unreadCount, "0");
  assert.equal(button.count.hidden, true);
});
