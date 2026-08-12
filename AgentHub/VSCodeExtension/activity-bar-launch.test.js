"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  CLOSE_PRIMARY_SIDEBAR,
  openEditorFromActivityBar,
} = require("./activity-bar-launch.js");

test("Activity Bar opens Agent Hub in the editor and immediately closes the sidebar", async () => {
  const events = [];
  let finishOpening;
  const opening = new Promise((resolve) => {
    finishOpening = resolve;
  });
  const result = openEditorFromActivityBar({
    openEditor() {
      events.push("editor-opened");
      return opening.then(() => {
        events.push("editor-ready");
        return "ready";
      });
    },
    async executeCommand(command) {
      events.push(command);
    },
  });
  await Promise.resolve();
  assert.deepEqual(events, ["editor-opened", CLOSE_PRIMARY_SIDEBAR]);
  finishOpening();
  assert.equal(await result, "ready");
});

test("Activity Bar closes the sidebar even when editor creation fails", async () => {
  const commands = [];
  await assert.rejects(openEditorFromActivityBar({
    openEditor() {
      throw new Error("cannot open");
    },
    async executeCommand(command) {
      commands.push(command);
    },
  }), /cannot open/u);
  assert.deepEqual(commands, [CLOSE_PRIMARY_SIDEBAR]);
});
