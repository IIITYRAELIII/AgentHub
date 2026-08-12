import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

async function loadSizing() {
  const source = await readFile(new URL("../../assets/mini-app/task-board.js", import.meta.url), "utf8");
  const window = {};
  vm.runInNewContext(source, {
    document: { querySelector: () => null },
    window,
  });
  return window.AgentHubTaskCardSizing;
}

test("short task titles keep the base card width", async () => {
  const sizing = await loadSizing();
  const width = sizing.fitWidth({
    baseWidth: 240,
    maxWidth: 640,
    maxHeight: 96,
    measureHeight: () => 54,
  });
  assert.equal(width, 240);
});

test("long task titles receive only the width needed to fit the height limit", async () => {
  const sizing = await loadSizing();
  const width = sizing.fitWidth({
    baseWidth: 240,
    maxWidth: 640,
    maxHeight: 80,
    measureHeight: (candidate) => Math.ceil(24_000 / candidate),
  });
  assert.equal(width, 300);
});

test("extreme task titles stop at the available card width", async () => {
  const sizing = await loadSizing();
  const width = sizing.fitWidth({
    baseWidth: 240,
    maxWidth: 480,
    maxHeight: 80,
    measureHeight: () => 160,
  });
  assert.equal(width, 480);
});
