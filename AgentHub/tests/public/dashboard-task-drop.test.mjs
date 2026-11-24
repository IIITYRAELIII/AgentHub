import assert from "node:assert/strict";
import test from "node:test";
import { openBoard } from "./dashboard-task-drop.fixture.mjs";

const workspace = (id, folder = "") => ({ id, name: id, settings: { catalogFolder: folder }, streams: [] });
const task = (id, bucket = "backlog", workspaceId = null) => ({ id, title: id, bucket, workspaceId, status: "open", workflowStatus: "new", revision: 1 });
const workspaces = [workspace("alpha", "Папка"), workspace("beta", "Папка"), workspace("root")];
const snapshot = (tasks, extra = {}) => ({ tasks, workspaces, folderNames: ["Папка", "Пустая"], ...extra });
const count = (h, scope) => Number(h.row(scope).querySelector(".task-workspace-folder-count").textContent);
const dialog = h => h.document.querySelector("[data-task-move-modal]");
const button = (h, label) => dialog(h)?.querySelectorAll("button").find(node => node.textContent === label);
const tick = () => Promise.resolve();

test("wide workspace row restores the Task destination and one drop emits one exact move", async () => {
  const h = await openBoard(); const input = task("incoming");
  h.api.setSnapshot(snapshot([input]));
  const row = h.row("workspace:alpha");
  assert.equal(row.dataset.boardDestination, "workspace:alpha");
  const dataTransfer = h.transfer(input, { protectedData: true });
  const over = h.dispatch(row.children[0], "dragover", { dataTransfer });
  assert.equal(over.defaultPrevented, true);
  assert.equal(row.classList.contains("is-dragover"), true);
  const drop = h.dispatch(row.children[0], "drop", { dataTransfer });
  assert.equal(drop.defaultPrevented, true); assert.equal(drop.stopped, true);
  assert.equal(row.classList.contains("is-dragover"), false);
  assert.deepEqual(h.actions, [{ type: "move", id: "incoming", bucket: "workspace", workspaceId: "alpha", beforeId: null, requestId: "board-move:incoming:test-command-1" }]);
  h.dispatch(row, "drop", { dataTransfer });
  assert.equal(h.actions.length, 1, "pending owner blocks a second submit");
  assert.equal(count(h, "workspace:alpha"), 0, "no optimistic count mutation");
  assert.equal(dialog(h), null, "backlog uses the existing direct path");
});

test("folder/global/background/foreign/column/completed/same-workspace drops stay invalid", async () => {
  const h = await openBoard(); const input = task("placed", "workspace", "alpha");
  h.api.setSnapshot(snapshot([input, { ...task("closed"), status: "done" }]));
  const dataTransfer = h.transfer(input);
  const targets = [h.row("workspace:alpha"), h.row("folder:Папка"), ...["all", "backlog", "notes"].map(h.row), h.scopes];
  for (const target of targets) {
    assert.equal(h.dispatch(target, "dragover", { dataTransfer }).defaultPrevented, false);
    h.dispatch(target, "drop", { dataTransfer });
    assert.equal(target.classList.contains("is-dragover"), false);
  }
  h.window.AgentHubTaskReferences.endDrag();
  for (const value of [null, task("missing"), { ...task("closed"), status: "done" }]) {
    h.window.AgentHubTaskReferences.endDrag();
    const transfer = h.transfer(value);
    h.dispatch(h.row("workspace:beta"), "dragover", { dataTransfer: transfer });
    h.dispatch(h.row("workspace:beta"), "drop", { dataTransfer: transfer });
    assert.equal(h.row("workspace:beta").classList.contains("is-dragover"), false);
  }
  const columnTransfer = h.transfer(input);
  columnTransfer.setData("application/x-agent-hub-board-column", "workspace:root");
  h.dispatch(h.row("workspace:beta"), "drop", { dataTransfer: columnTransfer });
  assert.deepEqual(h.actions, []); assert.equal(dialog(h), null);
});

for (const outcome of ["cancel", "escape", "accept", "stale"]) test(`workspace drop preserves the existing confirmation owner: ${outcome}`, async () => {
  const h = await openBoard(); const input = task("placed", "workspace", "alpha");
  h.api.setSnapshot(snapshot([input])); const dataTransfer = h.transfer(input);
  h.dispatch(h.row("workspace:beta"), "drop", { dataTransfer });
  h.dispatch(h.row("workspace:beta"), "drop", { dataTransfer });
  assert.equal(h.document.querySelectorAll("[data-task-move-modal]").length, 1);
  assert.deepEqual(h.actions, []);
  if (outcome === "cancel") button(h, "Отмена").click();
  else if (outcome === "escape") h.dispatch(dialog(h), "cancel");
  else {
    if (outcome === "stale") h.api.setSnapshot(snapshot([{ ...input, revision: 2 }]));
    button(h, "Перенести").click();
  }
  await tick();
  assert.equal(dialog(h), null);
  assert.equal(h.actions.length, outcome === "accept" ? 1 : 0);
  if (outcome === "accept") assert.deepEqual(h.actions[0], { type: "move", id: "placed", bucket: "workspace", workspaceId: "beta", beforeId: null, requestId: "board-move:placed:test-command-1" });
});

test("nested-safe highlight clears on leave, dragend, Escape, blur, resize and snapshot", async () => {
  const h = await openBoard(); const input = task("incoming"); h.api.setSnapshot(snapshot([input]));
  const dataTransfer = h.transfer(input);
  let row = h.row("workspace:alpha");
  h.dispatch(row.children[0], "dragover", { dataTransfer });
  h.dispatch(row.children[0], "dragleave", { relatedTarget: row.children[1] });
  assert.equal(row.classList.contains("is-dragover"), true);
  h.dispatch(row, "dragleave", { relatedTarget: h.scopes });
  assert.equal(row.classList.contains("is-dragover"), false);
  for (const clear of [
    () => h.dispatch(h.window, "dragend"),
    () => h.dispatch(h.document, "keydown", { key: "Escape" }),
    () => h.dispatch(h.window, "blur"),
    () => h.resize(520),
    () => h.api.setSnapshot(snapshot([{ ...input, revision: 2 }])),
  ]) {
    h.resize(1280); row = h.row("workspace:alpha");
    h.dispatch(row, "dragover", { dataTransfer });
    assert.equal(row.classList.contains("is-dragover"), true);
    clear(); assert.equal(row.classList.contains("is-dragover"), false);
  }
  assert.deepEqual(h.actions, []);
});

test("column drop still uses its previous command and is not intercepted by sidebar", async () => {
  const h = await openBoard(); const input = task("incoming"); h.api.setSnapshot(snapshot([input]));
  const column = h.document.querySelector('.task-board-column[data-board-destination="workspace:beta"]');
  h.dispatch(column, "drop", { dataTransfer: h.transfer(input) });
  assert.equal(h.actions.length, 1);
  assert.equal(h.actions[0].workspaceId, "beta"); assert.equal(h.actions[0].type, "move");
});

for (const width of [320, 390, 430, 520, 959]) test(`narrow ${width} keeps one navigation tree with no Task-drop targets`, async () => {
  const h = await openBoard({ width }); const input = task("incoming"); h.api.setSnapshot(snapshot([input]));
  assert.equal(h.scopes.parentElement, h.popover);
  assert.equal(h.scopes.querySelectorAll("[data-board-destination]").length, 0);
  const row = h.row("workspace:beta");
  h.dispatch(row, "drop", { dataTransfer: h.transfer(input) });
  assert.deepEqual(h.actions, []);
  row.click();
  assert.equal(h.row("workspace:beta").getAttribute("aria-current"), "page");
  assert.equal(h.scopes.querySelectorAll("[data-board-destination]").length, 0);
});

test("authoritative mode-relative counters and canonical hierarchy survive a Task move", async () => {
  const h = await openBoard(); const input = task("incoming");
  const closed = { ...task("closed", "workspace", "alpha"), status: "done", workflowStatus: "done" };
  h.api.setSnapshot(snapshot([input, closed]));
  const order = () => h.scopes.querySelectorAll("[data-board-scope]").map(node => node.dataset.boardScope);
  const originalOrder = order();
  h.dispatch(h.row("workspace:beta"), "drop", { dataTransfer: h.transfer(input) });
  assert.equal(count(h, "folder:Папка"), 0);
  h.api.setSnapshot(snapshot([{ ...input, bucket: "workspace", workspaceId: "beta", revision: 2 }, closed]));
  h.api.finishAction({ type: "move", id: input.id, succeeded: true, requestId: h.actions[0].requestId });
  assert.equal(count(h, "workspace:beta"), 1); assert.equal(count(h, "folder:Папка"), 1);
  const toggle = h.scopes.querySelector('[data-board-folder-toggle="folder:Папка"]'); toggle.click();
  assert.equal(count(h, "folder:Папка"), 1);
  h.completed.click();
  assert.equal(count(h, "workspace:alpha"), 1); assert.equal(count(h, "workspace:beta"), 0);
  assert.equal(count(h, "folder:Папка"), 1);
  assert.equal(h.scopes.querySelectorAll("[data-board-destination]").length, 0);
  h.dispatch(h.row("workspace:beta"), "drop", { dataTransfer: h.transfer(closed) });
  assert.equal(h.actions.length, 1);
  assert.deepEqual(order(), originalOrder);
});

for (const width of [390, 520]) test(`keyboard/touch alternative at ${width} still reaches the existing move owner`, async () => {
  const h = await openBoard({ width, withCard: true }); const input = task("incoming");
  h.api.setSnapshot(snapshot([input]));
  const card = h.document.querySelector('[data-board-task-id="incoming"]');
  if (width === 390) card.click();
  else h.dispatch(card, "keydown", { key: "Enter" });
  const select = h.document.querySelector(".board-task-destination");
  assert.ok(select, "existing card destination control stays available");
  select.value = "workspace:alpha"; h.dispatch(select, "change");
  assert.equal(h.actions.length, 1);
  assert.equal(h.actions[0].type, "move"); assert.equal(h.actions[0].workspaceId, "alpha");
  assert.equal(h.scopes.querySelectorAll("[data-board-destination]").length, 0);
});

for (const outcome of ["valid", "same", "escape", "narrow"]) test(`pointer fallback shares sidebar eligibility: ${outcome}`, async () => {
  const h = await openBoard(); const input = task("placed", "workspace", "alpha");
  h.api.setSnapshot(snapshot([input]));
  const card = h.document.querySelector('[data-board-task-id="placed"]');
  const row = h.row(`workspace:${outcome === "same" ? "alpha" : "beta"}`);
  h.document.elementFromPoint = () => row.children[0];
  const pointer = { pointerId: 1, pointerType: "mouse", isPrimary: true, button: 0, buttons: 1, clientX: 0, clientY: 0 };
  h.dispatch(card, "pointerdown", pointer);
  if (outcome === "narrow") h.resize(520);
  h.dispatch(card, "pointermove", { ...pointer, clientX: 20 });
  assert.equal(row.classList.contains("is-dragover"), outcome === "valid" || outcome === "escape");
  if (outcome === "escape") h.dispatch(h.document, "keydown", { key: "Escape" });
  h.dispatch(card, "pointerup", { ...pointer, clientX: 20, buttons: 0 });
  assert.deepEqual(h.actions, []);
  assert.equal(Boolean(dialog(h)), outcome === "valid");
  if (dialog(h)) { button(h, "Перенести").click(); await tick(); }
  assert.equal(h.actions.length, outcome === "valid" ? 1 : 0);
});

test("known failure keeps canonical counters and UNKNOWN cannot admit another move", async () => {
  const h = await openBoard(); const input = task("incoming"); h.api.setSnapshot(snapshot([input]));
  const dataTransfer = h.transfer(input);
  h.dispatch(h.row("workspace:alpha"), "drop", { dataTransfer });
  const original = h.actions[0];
  h.dispatch(h.row("workspace:beta"), "drop", { dataTransfer });
  assert.equal(h.actions.length, 1, "unresolved outcome retains original pending owner");
  assert.equal(count(h, "folder:Папка"), 0);
  h.api.finishAction({ type: "move", id: input.id, requestId: original.requestId, succeeded: false });
  assert.equal(count(h, "folder:Папка"), 0);
  assert.equal(h.actions.length, 1, "known failure does not auto-retry");
});

test("catalog create/rename/remove projection and collapsed mode-relative sums stay independent of Task drop", async () => {
  const h = await openBoard();
  let tasks = [task("one", "workspace", "alpha"), task("two", "workspace", "beta")];
  const apply = () => h.api.setSnapshot(snapshot(tasks));
  apply();
  h.api.setWorkspaceFolderCatalog(["Папка", "Пустая", "Создана"]);
  assert.equal(count(h, "folder:Создана"), 0);
  h.api.setWorkspaceFolderCatalog(["Папка", "Пустая", "Переименована"]);
  assert.equal(h.row("folder:Создана"), null); assert.equal(count(h, "folder:Переименована"), 0);
  h.api.setWorkspaceFolderCatalog(["Папка", "Пустая"]);
  assert.equal(h.row("folder:Переименована"), null);
  h.scopes.querySelector('[data-board-folder-toggle="folder:Папка"]').click();
  for (const next of [
    [...tasks, task("created", "workspace", "alpha")],
    [tasks[0], { ...tasks[1], workspaceId: "alpha" }],
    [{ ...tasks[0], status: "done" }, tasks[1]],
    [tasks[1]],
  ]) {
    tasks = next; apply();
    for (const closed of [false, true]) {
      if (closed) h.completed.click();
      assert.equal(count(h, "folder:Папка"), count(h, "workspace:alpha") + count(h, "workspace:beta"));
      assert.equal(count(h, "folder:Папка"), tasks.filter(item => (item.status === "done") === closed).length);
      assert.equal(h.scopes.querySelector('[data-board-folder-toggle="folder:Папка"]').getAttribute("aria-expanded"), "false");
    }
    h.completed.click();
  }
  assert.deepEqual(h.actions, []);
});
