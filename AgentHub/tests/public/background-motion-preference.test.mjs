import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

async function backgroundMotionPreferenceApi() {
  const source = await readFile(
    new URL("../../assets/mini-app/background-motion-preference.js", import.meta.url),
    "utf8",
  );
  const window = {};
  vm.runInNewContext(source, { window });
  return window.AgentHubBackgroundMotionPreference;
}

test("background motion is enabled by default and when storage is unavailable", async () => {
  const { stored } = await backgroundMotionPreferenceApi();
  assert.equal(stored({ getItem: () => null }), "on");
  assert.equal(stored({ getItem: () => { throw new Error("blocked"); } }), "on");
});

test("background motion restores, applies, persists, and respects reduced motion", async () => {
  const { STORAGE_KEY, apply, enabled, persist, stored } = await backgroundMotionPreferenceApi();
  const values = new Map([[STORAGE_KEY, "off"]]);
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
  const root = { dataset: {} };
  const toggle = { checked: true };

  assert.equal(apply(root, toggle, stored(storage)), "off");
  assert.equal(root.dataset.backgroundMotion, "off");
  assert.equal(toggle.checked, false);
  assert.equal(enabled(root, { matches: false }), false);

  assert.equal(persist(storage, "on"), "on");
  assert.equal(apply(root, toggle, stored(storage)), "on");
  assert.equal(toggle.checked, true);
  assert.equal(enabled(root, { matches: false }), true);
  assert.equal(enabled(root, { matches: true }), false);
});
