import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const window = {};
vm.runInNewContext(await readFile(new URL("../../assets/web-app/composer-shortcuts.js", import.meta.url), "utf8"), { window });
const api = window.AgentHubComposerShortcuts;
const plain = (value) => JSON.parse(JSON.stringify(value));
const defaults = { enter: "queue", ctrlEnter: "newline", shiftEnter: "newline" };
const storage = () => {
  const values = new Map();
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
};

test("composer shortcuts retain generic defaults for absent, malformed and restricted storage", () => {
  for (const target of [null, storage(), { getItem: () => "{" }, { getItem: () => "[]" }, { getItem: () => { throw Error("blocked"); } }]) {
    assert.deepEqual(plain(api.stored(target)), { mapping: defaults, configured: false });
  }
  assert.deepEqual(plain(api.normalize({ enter: "invalid", ctrlEnter: "steer", shiftEnter: "queue" })), { enter: "queue", ctrlEnter: "steer", shiftEnter: "queue" });
});
test("a personal override and repeated actions stay isolated to one client storage", () => {
  const author = storage(), otherBrowser = storage(), webviewA = storage(), webviewB = storage();
  assert.equal(api.persist(author, { ...defaults, ctrlEnter: "steer" }).ok, true);
  assert.deepEqual(plain(api.stored(author).mapping), { ...defaults, ctrlEnter: "steer" });
  for (const target of [otherBrowser, webviewA, webviewB]) assert.deepEqual(plain(api.stored(target).mapping), defaults);
  assert.equal(api.persist(webviewA, { enter: "steer", ctrlEnter: "steer", shiftEnter: "steer" }).ok, true);
  assert.deepEqual(plain(api.stored(webviewA).mapping), { enter: "steer", ctrlEnter: "steer", shiftEnter: "steer" });
  assert.deepEqual(plain(api.stored(webviewB).mapping), defaults);
  assert.equal(api.isDefault(api.stored(author).mapping), false);
  assert.equal(api.isDefault(defaults), true);
});
test("local save is one atomic storage write and failure applies no partial mapping", () => {
  const prior = { ...defaults }; let saved = JSON.stringify(prior); let writes = 0;
  const target = { getItem: () => saved, setItem: (_key, value) => { writes++; throw Error("quota"); } };
  assert.deepEqual(plain(api.persist(target, { enter: "steer", ctrlEnter: "queue", shiftEnter: "newline" })), { ok: false });
  assert.equal(writes, 1); assert.deepEqual(plain(api.stored(target).mapping), prior);
});
test("only the three exact chords match; IME/229 and unlisted modifiers stay untouched", () => {
  const enter = { key: "Enter", ctrlKey: false, shiftKey: false, altKey: false, metaKey: false };
  assert.equal(api.chord(enter), "enter");
  assert.equal(api.chord({ ...enter, ctrlKey: true }), "ctrlEnter");
  assert.equal(api.chord({ ...enter, shiftKey: true }), "shiftEnter");
  for (const extra of [{ key: "a" }, { isComposing: true }, { keyCode: 229 }, { ctrlKey: true, shiftKey: true }, { altKey: true }, { metaKey: true }]) {
    assert.equal(api.chord({ ...enter, ...extra }), null);
  }
});
