import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

async function loadBoardView() {
  const source = await readFile(new URL("../../assets/web-app/task-board.js", import.meta.url), "utf8");
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

test("workspace side panel keeps every current Task available for scrolling", async () => {
  const { workspaceTasksForPanel } = await loadBoardView();
  const tasks = [
    ...Array.from({ length: 8 }, (_, index) => ({
      id: `current-${index + 1}`,
      status: "open",
      bucket: "workspace",
      workspaceId: "workspace-1",
    })),
    { id: "completed", status: "done", bucket: "workspace", workspaceId: "workspace-1" },
    { id: "foreign", status: "open", bucket: "workspace", workspaceId: "workspace-2" },
  ];

  assert.deepEqual(
    Array.from(workspaceTasksForPanel(tasks, "workspace-1"), (task) => task.id),
    Array.from({ length: 8 }, (_, index) => `current-${index + 1}`),
  );
});

test("unchanged run snapshots do not rebuild Dashboard columns", async () => {
  const { taskBoardSnapshotChanges } = await loadBoardView();
  const current = {
    tasks: [{ id: "task-1", title: "Task" }],
    workspaces: [{ id: "workspace-1", name: "Workspace" }],
    columnOrder: ["backlog", "workspace:workspace-1"],
    notesComment: "Notes",
    selectedWorkspaceId: "workspace-1",
    provider: "codex",
  };

  const unchanged = taskBoardSnapshotChanges(current, current);
  assert.equal(unchanged.boardChanged, false);
  assert.equal(unchanged.panelChanged, false);
  assert.equal(unchanged.openTaskChanged, false);

  const selection = taskBoardSnapshotChanges(current, {
    ...current,
    selectedWorkspaceId: "workspace-2",
  });
  assert.equal(selection.boardChanged, false);
  assert.equal(selection.panelChanged, true);
});
