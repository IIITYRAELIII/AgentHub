import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

async function loadBoardExports() {
  const source = await readFile(new URL("../../assets/mini-app/task-board.js", import.meta.url), "utf8");
  const window = {};
  vm.runInNewContext(source, {
    document: { querySelector: () => null },
    window,
  });
  return window;
}

test("short task titles keep the base card width", async () => {
  const sizing = (await loadBoardExports()).AgentHubTaskCardSizing;
  const width = sizing.fitWidth({
    baseWidth: 240,
    maxWidth: 640,
    maxHeight: 96,
    measureHeight: () => 54,
  });
  assert.equal(width, 240);
});

test("long task titles receive only the width needed to fit the height limit", async () => {
  const sizing = (await loadBoardExports()).AgentHubTaskCardSizing;
  const width = sizing.fitWidth({
    baseWidth: 240,
    maxWidth: 640,
    maxHeight: 80,
    measureHeight: (candidate) => Math.ceil(24_000 / candidate),
  });
  assert.equal(width, 300);
});

test("extreme task titles stop at the available card width", async () => {
  const sizing = (await loadBoardExports()).AgentHubTaskCardSizing;
  const width = sizing.fitWidth({
    baseWidth: 240,
    maxWidth: 480,
    maxHeight: 80,
    measureHeight: () => 160,
  });
  assert.equal(width, 480);
});

test("task title editor grows to its wrapped content height", async () => {
  const editor = (await loadBoardExports()).AgentHubTaskCardEditor;
  const listeners = new Map();
  let contentHeight = 42;
  const textarea = {
    style: { height: "" },
    addEventListener: (type, listener) => listeners.set(type, listener),
    get scrollHeight() {
      assert.equal(this.style.height, "auto");
      return contentHeight;
    },
  };
  const sizer = editor.createAutoGrowTextarea({
    textarea,
    getStyle: () => ({ borderTopWidth: "1px", borderBottomWidth: "2px" }),
  });

  assert.equal(textarea.style.height, "45px");
  contentHeight = 96;
  listeners.get("input")();
  assert.equal(textarea.style.height, "99px");
  assert.equal(sizer.resize(), 99);
});
