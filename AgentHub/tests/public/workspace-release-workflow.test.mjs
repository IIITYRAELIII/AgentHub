import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

async function workflowApi() {
  const source = await readFile(
    new URL("../../assets/web-app/workspace-release-workflow.js", import.meta.url),
    "utf8",
  );
  const window = {};
  vm.runInNewContext(source, { window });
  return window.AgentHubWorkspaceReleaseWorkflow;
}

class Control {
  constructor() {
    this.listeners = new Map();
    this.open = false;
    this.textContent = "";
  }

  addEventListener(type, listener) {
    this.listeners.set(type, listener);
  }

  dispatch(type) {
    let prevented = false;
    this.listeners.get(type)?.({ preventDefault: () => { prevented = true; } });
    return prevented;
  }

  showModal() { this.open = true; }
  close() { this.open = false; }
  focus() { this.focused = true; }
  setAttribute(name) { if (name === "open") this.open = true; }
  removeAttribute(name) { if (name === "open") this.open = false; }
}

test("turning release workflow off asks before discarding registered changes", async () => {
  const workflow = await workflowApi();
  const registry = { total: 3, changeSetTotal: 1, pendingTotal: 4 };
  assert.equal(workflow.requiresDiscardConfirmation({ enabled: false, registry }), true);
  assert.equal(workflow.requiresDiscardConfirmation({ enabled: true, registry }), false);
  assert.equal(workflow.requiresDiscardConfirmation({
    enabled: false,
    registry,
    discardConfirmed: true,
  }), false);
  assert.match(workflow.discardConfirmationText(registry), /удалить все зарегистрированные изменения/u);
  assert.equal(workflow.tooltip.length, 4);
});

test("discard confirmation uses an in-app dialog and resolves once", async () => {
  const workflow = await workflowApi();
  const dialog = new Control();
  const cancelButton = new Control();
  const confirmButton = new Control();
  const message = new Control();
  const controller = workflow.createDiscardConfirmation({
    dialog, cancelButton, confirmButton, message,
  });

  const cancelled = controller.request({ text: "Удалить изменения?" });
  assert.equal(dialog.open, true);
  assert.equal(cancelButton.focused, true);
  assert.equal(message.textContent, "Удалить изменения?");
  assert.equal(dialog.dispatch("cancel"), true);
  assert.equal(await cancelled, false);

  const confirmed = controller.request();
  const repeated = controller.request();
  assert.equal(confirmed, repeated);
  confirmButton.dispatch("click");
  assert.equal(await confirmed, true);
  assert.equal(dialog.open, false);
});
