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
  return {
    createDeleteDialog: window.AgentHubTaskDeleteDialog.create,
    cleanupConfirmation: window.AgentHubTaskCleanupConfirmation,
  };
}

test("task deletion requires explicit confirmation and supports cancellation", async () => {
  const { createDeleteDialog: create } = await loadFactory();
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

test("Complete and Delete confirmations render exact server evidence and cancellation performs no mutation", async () => {
  const { cleanupConfirmation } = await loadFactory();
  const base = {
    cleanupToken: "cleanup-token",
    warning: "Destructive lifecycle warning",
    preview: {
      dirty: true,
      workspaces: [{
        branch: "HUB-159",
        projectRoot: "D:/managed/task",
        headCommit: "head-159",
        dirty: true,
        changedPaths: ["AgentHub/src/changed.mjs"],
        untrackedPaths: ["AgentHub/new.mjs"],
      }],
      gitReferences: [{
        projectRoot: "D:/repo",
        branch: "HUB-159",
        resultCommit: "result-159",
        published: false,
        publishedRevision: "main-159",
        publicationGeneration: "generation-159",
      }],
      deleting: [
        { kind: "worktree", path: "D:/managed/task" },
        { kind: "branch", name: "HUB-159", repositoryRoot: "D:/repo" },
        { kind: "result_ref", name: "refs/agent-hub/task-results/task/repo", repositoryRoot: "D:/repo" },
      ],
    },
  };
  for (const [action, label] of [["board-task-complete", "Complete"], ["board-task-remove", "Delete"]]) {
    const confirmations = [];
    const mutations = [];
    const cancelled = await cleanupConfirmation.confirm({
      confirmation: { ...base, warning: `${label}: ${base.warning}` },
      action,
      params: { id: "task-159" },
      confirm: (text) => (confirmations.push(text), false),
      request: (...args) => mutations.push(args),
    });
    assert.equal(cancelled.confirmed, false);
    assert.deepEqual(mutations, []);
    const [text] = confirmations;
    for (const evidence of [
      "HUB-159", "D:/managed/task", "head-159", "dirty",
      "AgentHub/src/changed.mjs", "AgentHub/new.mjs", "result-159",
      "unpublished", "main-159", "generation-159",
      "[worktree] D:/managed/task", "[branch] HUB-159", "[result_ref] refs/agent-hub/task-results/task/repo",
    ]) assert.match(text, new RegExp(evidence.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  }

  const calls = [];
  const accepted = await cleanupConfirmation.confirm({
    confirmation: base,
    action: "board-task-remove",
    params: { id: "task-159" },
    confirm: () => true,
    request: async (...args) => (calls.push(args), { removed: true }),
  });
  assert.equal(accepted.confirmed, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "board-task-remove");
  assert.equal(calls[0][1].id, "task-159");
  assert.equal(calls[0][1].confirmCleanup, true);
  assert.equal(calls[0][1].expectedCleanupToken, "cleanup-token");
});
