import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

async function placementView() {
  const source = await readFile(
    new URL("../../assets/web-app/themed-select-placement.js", import.meta.url),
    "utf8",
  );
  const window = {};
  vm.runInNewContext(source, { document: { body: "body" }, window });
  return window.AgentHubThemedSelectPlacement;
}

test("themed select keeps modal options inside their owning dialog top layer", async () => {
  const { resolve } = await placementView();
  const dialog = { kind: "dialog" };
  const menu = { showPopover() {} };

  assert.deepEqual(
    { ...resolve({ closest: () => dialog }, menu) },
    { host: dialog, usePopover: true },
  );
  assert.deepEqual(
    { ...resolve({ closest: () => dialog }, {}) },
    { host: dialog, usePopover: false },
  );
  assert.deepEqual(
    { ...resolve({ closest: () => null }, menu, { documentRoot: { body: "body" } }) },
    { host: "body", usePopover: true },
  );
});
