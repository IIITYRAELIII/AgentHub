import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

async function activityRailPreferenceApi() {
  const source = await readFile(
    new URL("../../assets/web-app/activity-rail-preference.js", import.meta.url),
    "utf8",
  );
  const window = {};
  vm.runInNewContext(source, { window });
  return window.AgentHubActivityRailPreference;
}

test("the activity rail is visible by default and when storage is unavailable or invalid", async () => {
  const { stored } = await activityRailPreferenceApi();
  assert.equal(stored({ getItem: () => null }), "visible");
  assert.equal(stored({ getItem: () => "invalid" }), "visible");
  assert.equal(stored({ getItem: () => { throw new Error("blocked"); } }), "visible");
});

test("the activity rail setting restores, applies, and persists both modes", async () => {
  const { STORAGE_KEY, apply, persist, stored } = await activityRailPreferenceApi();
  const values = new Map([[STORAGE_KEY, "visible"]]);
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
  const root = { dataset: {} };
  const toggle = { checked: false };

  assert.equal(apply(root, toggle, stored(storage)), "visible");
  assert.equal(root.dataset.activityRailVisibility, "visible");
  assert.equal(toggle.checked, true);

  assert.equal(persist(storage, "hidden"), "hidden");
  assert.equal(apply(root, toggle, stored(storage)), "hidden");
  assert.equal(root.dataset.activityRailVisibility, "hidden");
  assert.equal(toggle.checked, false);
});
