import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

class Control {
  constructor() {
    this.listeners = new Map();
    this.open = false;
  }

  addEventListener(type, listener) {
    this.listeners.set(type, listener);
  }

  dispatch(type, event = {}) {
    let prevented = false;
    this.listeners.get(type)?.({
      target: this,
      clientX: -1,
      clientY: -1,
      ...event,
      preventDefault: () => { prevented = true; },
    });
    return prevented;
  }

  showModal() {
    this.open = true;
  }

  close() {
    this.open = false;
  }

  setAttribute(name) {
    if (name === "open") this.open = true;
  }

  removeAttribute(name) {
    if (name === "open") this.open = false;
  }
}

async function loadFactory() {
  const [overlaySource, source] = await Promise.all([
    readFile(new URL("../../assets/web-app/modal-overlays.js", import.meta.url), "utf8"),
    readFile(new URL("../../assets/web-app/task-board.js", import.meta.url), "utf8"),
  ]);
  const window = {};
  const context = {
    document: { querySelector: () => null },
    window,
  };
  vm.runInNewContext(overlaySource, context);
  vm.runInNewContext(source, context);
  return window.AgentHubTaskDeleteDialog.create;
}

test("task deletion requires explicit confirmation and supports cancellation", async () => {
  const create = await loadFactory();
  const dialog = new Control();
  const cancelButton = new Control();
  const confirmButton = new Control();
  const confirmed = [];
  const controller = create({
    dialog,
    cancelButton,
    confirmButton,
    onConfirm: (id) => confirmed.push(id),
  });

  controller.request("task-1");
  assert.equal(dialog.open, true);
  cancelButton.dispatch("click");
  assert.equal(dialog.open, false);
  assert.deepEqual(confirmed, []);

  controller.request("task-1");
  assert.equal(dialog.dispatch("cancel"), true);
  assert.equal(dialog.open, false);
  assert.deepEqual(confirmed, []);

  controller.request("task-1");
  assert.equal(dialog.dispatch("click"), false);
  assert.equal(dialog.open, false);
  assert.deepEqual(confirmed, []);

  controller.request("task-1");
  confirmButton.dispatch("click");
  assert.equal(dialog.open, false);
  assert.deepEqual(confirmed, ["task-1"]);

  confirmButton.dispatch("click");
  assert.deepEqual(confirmed, ["task-1"]);
});
