import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

async function focusModeApi() {
  const source = await readFile(
    new URL("../../assets/web-app/focus-mode-controller.js", import.meta.url),
    "utf8",
  );
  const window = {};
  const document = {
    documentElement: { dataset: {} },
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  const localStorage = { getItem: () => null, setItem() {} };
  const MutationObserver = class { observe() {} };
  vm.runInNewContext(source, { document, localStorage, MutationObserver, window });
  return window.AgentHubFocusMode;
}

test("focus mode applies independently from the selected theme", async () => {
  const { apply } = await focusModeApi();
  const root = { dataset: { theme: "gothic" } };
  const attributes = new Map();
  const toggle = { setAttribute: (name, value) => attributes.set(name, value) };

  assert.equal(apply(root, toggle, true), true);
  assert.equal(root.dataset.focusMode, "true");
  assert.equal(attributes.get("aria-pressed"), "true");
  assert.equal(apply(root, toggle, false), false);
  assert.equal(root.dataset.focusMode, undefined);
  assert.equal(attributes.get("aria-pressed"), "false");
});

test("focus mode migrates the previous Orange preference", async () => {
  const { LEGACY_ORANGE_STORAGE_KEY, STORAGE_KEY, persist, stored } = await focusModeApi();
  const values = new Map([[LEGACY_ORANGE_STORAGE_KEY, "true"]]);
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };

  assert.equal(stored(storage, "gothic"), true);
  assert.equal(persist(storage, false), false);
  assert.equal(values.get(STORAGE_KEY), "false");
  assert.equal(stored(storage, "orange"), false);
});

test("focus mode preserves the previous Orange default", async () => {
  const { stored } = await focusModeApi();
  const storage = { getItem: () => null };
  assert.equal(stored(storage, "orange"), true);
  assert.equal(stored(storage, "gothic"), false);
});
