import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

async function chatSurfacePreferenceApi() {
  const source = await readFile(
    new URL("../../assets/web-app/chat-surface-preference.js", import.meta.url),
    "utf8",
  );
  const window = {};
  vm.runInNewContext(source, { window });
  return window.AgentHubChatSurfacePreference;
}

test("new and storage-restricted clients start with a transparent chat surface", async () => {
  const { stored } = await chatSurfacePreferenceApi();
  assert.equal(stored({ getItem: () => null }), "transparent");
  assert.equal(stored({ getItem: () => { throw new Error("blocked"); } }), "transparent");
});

test("the chat surface setting restores, applies, and persists both modes", async () => {
  const { STORAGE_KEY, apply, persist, stored } = await chatSurfacePreferenceApi();
  const values = new Map([[STORAGE_KEY, "themed"]]);
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
  const root = { dataset: {} };
  const toggle = { checked: true };

  assert.equal(stored(storage), "themed");
  assert.equal(apply(root, toggle, "themed"), "themed");
  assert.equal(root.dataset.chatSurface, "themed");
  assert.equal(toggle.checked, false);

  assert.equal(persist(storage, "transparent"), "transparent");
  assert.equal(stored(storage), "transparent");
  assert.equal(apply(root, toggle, stored(storage)), "transparent");
  assert.equal(root.dataset.chatSurface, "transparent");
  assert.equal(toggle.checked, true);
});
