import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

async function loadBoardView() {
  const source = await readFile(new URL("../../assets/mini-app/task-board.js", import.meta.url), "utf8");
  const window = {};
  vm.runInNewContext(source, {
    document: { querySelector: () => null },
    window,
  });
  return window.AgentHubTaskBoardView;
}

test("Dashboard switches between current and completed Tasks", async () => {
  const view = await loadBoardView();
  const tasks = [
    { id: "open", status: "open" },
    { id: "done-new", status: "done", completedAt: "2026-08-13T12:00:00.000Z" },
    { id: "started", status: "started" },
    { id: "done-old", status: "done", completedAt: "2026-08-13T10:00:00.000Z" },
  ];

  assert.deepEqual(
    Array.from(view.tasksForMode(tasks), (task) => task.id),
    ["open", "started"],
  );
  assert.deepEqual(
    Array.from(view.tasksForMode(tasks, { completedOnly: true }), (task) => task.id),
    ["done-old", "done-new"],
  );
});

test("a freshly completed Task lands at the bottom of completed Tasks", async () => {
  const view = await loadBoardView();
  const tasks = [
    { id: "done-unknown", status: "done" },
    { id: "done-first", status: "done", completedAt: "2026-08-13T09:00:00.000Z" },
    { id: "done-latest", status: "done", completedAt: "2026-08-13T13:00:00.000Z" },
  ];

  assert.deepEqual(
    Array.from(view.tasksForMode(tasks, { completedOnly: true }), (task) => task.id),
    ["done-unknown", "done-first", "done-latest"],
  );
});
