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

  dispatch(type) {
    let prevented = false;
    this.listeners.get(type)?.({ preventDefault: () => { prevented = true; } });
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
  const source = await readFile(new URL("../../assets/web-app/task-board.js", import.meta.url), "utf8");
  const window = {};
  vm.runInNewContext(source, {
    document: { querySelector: () => null },
    window,
  });
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
  confirmButton.dispatch("click");
  assert.equal(dialog.open, false);
  assert.deepEqual(confirmed, ["task-1"]);

  confirmButton.dispatch("click");
  assert.deepEqual(confirmed, ["task-1"]);
});
