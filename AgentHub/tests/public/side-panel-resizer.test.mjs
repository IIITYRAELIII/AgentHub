import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

async function sidePanelResizerApi() {
  const source = await readFile(new URL("../../assets/web-app/side-panel-resizer.js", import.meta.url), "utf8");
  const window = {};
  vm.runInNewContext(source, { window });
  return window.AgentHubSidePanelResizer;
}

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return { getItem: (key) => values.get(key) ?? null, removeItem: (key) => values.delete(key), setItem: (key, value) => values.set(key, value), values };
}

test("side panel widths persist independently and reset independently", async () => {
  const { STORAGE_KEY, forgetWidth, persistWidth, storedWidths } = await sidePanelResizerApi();
  const storage = memoryStorage();
  persistWidth(storage, "task", 318.6);
  persistWidth(storage, "activity", 402.2);
  assert.deepEqual({ ...storedWidths(storage) }, { task: 319, activity: 402 });
  forgetWidth(storage, "task");
  assert.deepEqual({ ...storedWidths(storage) }, { activity: 402 });
  forgetWidth(storage, "activity");
  assert.equal(storage.values.has(STORAGE_KEY), false);
});

test("invalid or unavailable local storage falls back to theme defaults", async () => {
  const { STORAGE_KEY, storedWidths } = await sidePanelResizerApi();
  const invalid = memoryStorage({ [STORAGE_KEY]: JSON.stringify({ task: -10, activity: "wide", unknown: 900 }) });
  assert.deepEqual({ ...storedWidths(invalid) }, {});
  assert.deepEqual({ ...storedWidths({ getItem: () => { throw new Error("blocked"); } }) }, {});
});

test("pointer movement changes the matching side and clamps its width", async () => {
  const { baseWidthFromVisible, normalizedWidthScale, widthFromPointer } = await sidePanelResizerApi();
  assert.equal(widthFromPointer({ side: "task", startWidth: 280, startX: 280, pointerX: 350, maximumWidth: 500 }), 350);
  assert.equal(widthFromPointer({ side: "activity", startWidth: 340, startX: 900, pointerX: 840, maximumWidth: 420 }), 400);
  assert.equal(widthFromPointer({ side: "activity", startWidth: 340, startX: 900, pointerX: 100, maximumWidth: 420 }), 420);
  assert.equal(normalizedWidthScale("0.4"), 0.4);
  assert.equal(normalizedWidthScale("invalid"), 1);
  assert.equal(baseWidthFromVisible(320, 0.4), 800);
});

test("saved widths keep the center and both panels readable", async () => {
  const { fitPanelWidths } = await sidePanelResizerApi();
  assert.deepEqual({ ...fitPanelWidths({ taskWidth: 500, activityWidth: 400, availableWidth: 700, customTask: true, customActivity: false }) }, { task: 300, activity: 400 });
  const both = fitPanelWidths({ taskWidth: 500, activityWidth: 500, availableWidth: 700, customTask: true, customActivity: true });
  assert.equal(both.task + both.activity, 700);
  assert.ok(both.task >= 180);
  assert.ok(both.activity >= 220);
});

test("inline widths override theme variables and reset cleanly", async () => {
  const { applyWidth, clearWidth } = await sidePanelResizerApi();
  const values = new Map();
  const workspace = { style: { removeProperty: (property) => values.delete(property), setProperty: (property, value) => values.set(property, value) } };
  assert.equal(applyWidth(workspace, "task", 320), 320);
  assert.equal(values.get("--task-rail-width"), "320px");
  clearWidth(workspace, "task");
  assert.equal(values.has("--task-rail-width"), false);
});
