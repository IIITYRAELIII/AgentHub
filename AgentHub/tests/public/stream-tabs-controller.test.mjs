import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

class FakeTarget {
  constructor() {
    this.listeners = new Map();
    this.attributes = new Set();
    this.scrollLeft = 0;
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

  toggleAttribute(name, enabled) {
    if (enabled) this.attributes.add(name);
    else this.attributes.delete(name);
  }
}

async function streamTabsApi() {
  const source = await readFile(new URL("../../assets/mini-app/stream-tabs-controller.js", import.meta.url), "utf8");
  const window = {};
  vm.runInNewContext(source, { window });
  return window.AgentHubStreamTabs;
}

const stream = (id, ordinal, lastActivity) => ({
  id,
  ordinal,
  tasks: [{ lastActivity }],
});

test("activity mode puts the most recently active Stream first", async () => {
  const { orderWorkspaceStreams } = await streamTabsApi();
  const streams = [
    stream("older", 1, "2026-08-10T08:00:00.000Z"),
    stream("latest", 2, "2026-08-10T10:00:00.000Z"),
    stream("middle", 3, "2026-08-10T09:00:00.000Z"),
  ];
  assert.deepEqual(
    Array.from(
      orderWorkspaceStreams(streams, "activity"),
      (item) => item.id,
    ),
    ["latest", "middle", "older"],
  );
});

test("activity direction moves new and active Streams together with the create button", async () => {
  const { orderWorkspaceStreams, streamCreationSide } = await streamTabsApi();
  const streams = [
    stream("older", 1, "2026-08-10T08:00:00.000Z"),
    stream("latest", 2, "2026-08-10T10:00:00.000Z"),
    stream("middle", 3, "2026-08-10T09:00:00.000Z"),
  ];
  assert.deepEqual(
    Array.from(orderWorkspaceStreams(streams, "activity", "end"), (item) => item.id),
    ["older", "middle", "latest"],
  );
  assert.equal(streamCreationSide("activity", "start"), "start");
  assert.equal(streamCreationSide("activity", "end"), "end");
  assert.equal(streamCreationSide("manual", "start"), "end");
});

test("activity rail count excludes merely recent Streams", async () => {
  const { attentionStreamCount } = await streamTabsApi();
  assert.equal(attentionStreamCount([
    { id: "running", running: true, unread: false },
    { id: "unread", running: false, unread: true },
    { id: "both", running: true, unread: true },
    { id: "recent", running: false, unread: false },
  ]), 3);
});

test("manual mode follows the server-synchronized ordinal order", async () => {
  const { orderWorkspaceStreams, streamsAreDraggable } = await streamTabsApi();
  const streams = [
    stream("third", 3, "2026-08-10T10:00:00.000Z"),
    stream("first", 1, "2026-08-10T09:00:00.000Z"),
    stream("second", 2, "2026-08-10T08:00:00.000Z"),
  ];
  assert.deepEqual(
    Array.from(orderWorkspaceStreams(streams, "manual"), (item) => item.id),
    ["first", "second", "third"],
  );
  assert.equal(streamsAreDraggable("manual", "desktop"), true);
  assert.equal(streamsAreDraggable("activity", "desktop"), false);
  assert.equal(streamsAreDraggable("manual", "mobile"), false);
});

test("activity-mode pointer drag scrolls horizontally without native reordering", async () => {
  const { HorizontalPointerScroller } = await streamTabsApi();
  const target = new FakeTarget();
  target.scrollLeft = 120;
  let enabled = true;
  let dragEnds = 0;
  new HorizontalPointerScroller(target, {
    enabled: () => enabled,
    onDragEnd: () => { dragEnds += 1; },
  });
  target.dispatch("pointerdown", { pointerId: 7, pointerType: "mouse", button: 0, clientX: 100 });
  target.dispatch("pointermove", { pointerId: 7, clientX: 70, preventDefault() {} });
  assert.equal(target.scrollLeft, 150);
  assert.equal(target.attributes.has("data-scroll-drag"), true);
  target.dispatch("pointerup", { pointerId: 7 });
  assert.equal(target.attributes.has("data-scroll-drag"), false);
  assert.equal(dragEnds, 1);

  enabled = false;
  target.dispatch("pointerdown", { pointerId: 8, pointerType: "mouse", button: 0, clientX: 100 });
  target.dispatch("pointermove", { pointerId: 8, clientX: 40, preventDefault() {} });
  assert.equal(target.scrollLeft, 150);
});
