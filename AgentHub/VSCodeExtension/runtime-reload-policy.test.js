"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { runtimeReloadAction } = require("./runtime-reload-policy");

test("runtime publication asks the webview to prepare before replacing its shell", () => {
  assert.equal(runtimeReloadAction({ currentRoot: "old", targetRoot: "old" }), "none");
  assert.equal(runtimeReloadAction({ currentRoot: "old", targetRoot: "new" }), "prepare");
  assert.equal(runtimeReloadAction({
    currentRoot: "old",
    targetRoot: "new",
    clientReady: true,
  }), "apply");
});
