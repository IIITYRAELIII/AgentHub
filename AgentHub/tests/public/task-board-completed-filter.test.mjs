import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

async function loadBoardView() {
  const referencesSource = await readFile(new URL("../../assets/web-app/task-references.js", import.meta.url), "utf8");
  const source = await readFile(new URL("../../assets/web-app/task-board.js", import.meta.url), "utf8");
  const window = {};
  const context = {
    document: { querySelector: () => null },
    window,
  };
  vm.runInNewContext(referencesSource, context);
  vm.runInNewContext(source, context);
  return window.AgentHubTaskBoardView;
}

test("Dashboard switches between current and completed Tasks", async () => {
  const view = await loadBoardView();
  const tasks = [
    { id: "open", status: "open" },
    { id: "production-ready", status: "open", workflowStatus: "done" },
    { id: "done-new", status: "done", completedAt: "2026-08-13T12:00:00.000Z" },
    { id: "started", status: "started" },
    { id: "done-old", status: "done", completedAt: "2026-08-13T10:00:00.000Z" },
  ];

  assert.deepEqual(
    Array.from(view.tasksForMode(tasks), (task) => task.id),
    ["open", "production-ready", "started"],
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

test("Dashboard presents every workflow status in the selected language", async () => {
  const view = await loadBoardView();
  const statuses = ["new", "in_progress", "testing", "awaiting_implementation", "done"];

  assert.deepEqual(
    statuses.map((workflowStatus) => view.taskWorkflowPresentation({ workflowStatus }, "en").short),
    ["New", "InProg", "Test", "Await", "Done"],
  );
  assert.deepEqual(
    statuses.map((workflowStatus) => view.taskWorkflowPresentation({ workflowStatus }, "ru").short),
    ["Новая", "ВРаботе", "Тест", "Прим", "Готово"],
  );
  assert.equal(view.taskWorkflowPresentation({ status: "started" }, "ru").status, "in_progress");
  assert.equal(view.normalizedTaskStatusLanguage("unknown"), "en");
});

test("Task release details use the canonical executor and changed-file projection", async () => {
  const view = await loadBoardView();
  const workspaces = [{
    id: "workspace-1",
    name: "Agent HUB",
    streams: [{ id: "stream-1", name: "Dash", displayName: "Dash" }],
  }];
  const task = {
    workspaceId: "workspace-1",
    streamId: "stream-1",
    changedFiles: [
      { projectRoot: "D:/VSC_Tyrael/Utilities", path: "AgentHub/app.js", operation: "modified", turnId: "turn-1" },
      { projectRoot: "D:/VSC_Tyrael/Utilities", path: "AgentHub/new.js", operation: "added", turnId: null },
      { projectRoot: "D:/VSC_Tyrael/FirstBit", path: "old.xml", operation: "deleted", turnId: "turn-2" },
    ],
  };

  assert.equal(view.taskExecutorPresentation(task, workspaces).label, "Agent HUB — Dash");
  assert.equal(
    view.taskExecutorPresentation({ workspaceId: "workspace-1" }, workspaces).label,
    "Agent HUB — Stream не назначен",
  );
  assert.deepEqual(
    Array.from(view.taskChangedFileGroups(task), (group) => ({
      projectRoot: group.projectRoot,
      files: Array.from(group.files, (file) => ({ ...file })),
    })),
    [
      {
        projectRoot: "D:/VSC_Tyrael/Utilities",
        files: [
          { projectRoot: "D:/VSC_Tyrael/Utilities", path: "AgentHub/app.js", operation: "modified", turnId: "turn-1" },
          { projectRoot: "D:/VSC_Tyrael/Utilities", path: "AgentHub/new.js", operation: "added", turnId: null },
        ],
      },
      {
        projectRoot: "D:/VSC_Tyrael/FirstBit",
        files: [
          { projectRoot: "D:/VSC_Tyrael/FirstBit", path: "old.xml", operation: "deleted", turnId: "turn-2" },
        ],
      },
    ],
  );
  assert.deepEqual(
    Array.from(view.taskWorkLogEntries({
      workLog: [{
        provider: "codex",
        turnId: "turn-1",
        status: "interrupted",
        summary: "Изменения сохранены",
        createdAt: "2026-08-29T12:00:00.000Z",
        changedFiles: [{ path: "AgentHub/app.js" }],
      }],
    }), (entry) => ({ ...entry })),
    [{
      provider: "codex",
      turnId: "turn-1",
      status: "interrupted",
      summary: "Изменения сохранены",
      createdAt: "2026-08-29T12:00:00.000Z",
      changedFileCount: 1,
    }],
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

test("workspace side panel separates selected Stream Tasks from remaining Workspace Tasks", async () => {
  const { workspaceTaskSectionsForPanel } = await loadBoardView();
  const tasks = [
    { id: "stream-one", status: "open", bucket: "workspace", workspaceId: "workspace-1", streamId: "stream-1" },
    { id: "workspace-unassigned", status: "open", bucket: "workspace", workspaceId: "workspace-1", streamId: null },
    { id: "workspace-other-stream", status: "open", bucket: "workspace", workspaceId: "workspace-1", streamId: "stream-2" },
    { id: "stream-two", status: "started", bucket: "workspace", workspaceId: "workspace-1", streamId: "stream-1" },
    { id: "completed", status: "done", bucket: "workspace", workspaceId: "workspace-1", streamId: "stream-1" },
    { id: "foreign", status: "open", bucket: "workspace", workspaceId: "workspace-2", streamId: "stream-1" },
  ];

  const sections = workspaceTaskSectionsForPanel(tasks, "workspace-1", "stream-1");

  assert.deepEqual(Array.from(sections.streamTasks, (task) => task.id), ["stream-one", "stream-two"]);
  assert.deepEqual(
    Array.from(sections.workspaceTasks, (task) => task.id),
    ["workspace-unassigned", "workspace-other-stream"],
  );
  assert.equal(sections.total, 4);
});

test("unchanged run snapshots do not rebuild Dashboard columns", async () => {
  const { taskBoardSnapshotChanges } = await loadBoardView();
  const current = {
    tasks: [{ id: "task-1", title: "Task" }],
    workspaces: [{ id: "workspace-1", name: "Workspace" }],
    columnOrder: ["backlog", "workspace:workspace-1"],
    notesComment: "Notes",
    selectedWorkspaceId: "workspace-1",
    selectedStreamId: "stream-1",
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

  const streamSelection = taskBoardSnapshotChanges(current, {
    ...current,
    selectedStreamId: "stream-2",
  });
  assert.equal(streamSelection.boardChanged, false);
  assert.equal(streamSelection.panelChanged, true);
});

test("Dashboard Notes have no default subtitle", async () => {
  const { taskBoardSnapshotChanges } = await loadBoardView();

  const snapshot = taskBoardSnapshotChanges({}, {}, { initialized: false });

  assert.equal(snapshot.next.notesComment, "");
});

test("Task links open the card without requesting Dashboard navigation", async () => {
  const { createTaskReferenceOpenHandler } = await loadBoardView();
  const opened = [];
  const tasks = [{ id: "task-1", title: "Keep current route" }];
  const handler = createTaskReferenceOpenHandler({
    getTasks: () => tasks,
    openTask: (task) => opened.push(task.id),
  });

  assert.equal(handler({ detail: { taskId: "task-1" } }), true);
  assert.deepEqual(opened, ["task-1"]);
  assert.equal(handler({ detail: { taskId: "missing" } }), false);
  assert.deepEqual(opened, ["task-1"]);
});

test("Dashboard pins Backlog first and Notes last regardless of saved order", async () => {
  const { orderedDashboardColumnIds } = await loadBoardView();

  assert.deepEqual(
    Array.from(orderedDashboardColumnIds(
      ["notes", "workspace:two", "backlog", "workspace:one"],
      ["backlog", "workspace:one", "workspace:two", "workspace:new", "notes"],
    )),
    ["backlog", "workspace:two", "workspace:one", "workspace:new", "notes"],
  );
});

test("Dashboard confines Workspace columns between fixed edges and preserves their scroll", async () => {
  const { replaceBoardColumnRegionsPreservingScroll } = await loadBoardView();
  const region = (scrollLeft = 0) => ({
    scrollLeft,
    children: [],
    replaceChildren(...children) {
      this.children = children;
      this.scrollLeft = 0;
    },
  });
  const regions = {
    backlog: region(),
    workspaces: region(480),
    notes: region(),
  };
  const rendered = new Map([
    ["backlog", "backlog-column"],
    ["workspace:one", "workspace-one-column"],
    ["workspace:two", "workspace-two-column"],
    ["notes", "notes-column"],
  ]);

  replaceBoardColumnRegionsPreservingScroll(
    regions,
    ["backlog", "workspace:two", "workspace:one", "notes"],
    rendered,
  );

  assert.deepEqual(regions.backlog.children, ["backlog-column"]);
  assert.deepEqual(regions.workspaces.children, ["workspace-two-column", "workspace-one-column"]);
  assert.deepEqual(regions.notes.children, ["notes-column"]);
  assert.equal(regions.workspaces.scrollLeft, 480);
});

test("Dashboard column replacement preserves horizontal scroll", async () => {
  const { replaceBoardColumnsPreservingScroll } = await loadBoardView();
  const container = {
    scrollLeft: 480,
    children: [],
    replaceChildren(...children) {
      this.children = children;
      this.scrollLeft = 0;
    },
  };

  replaceBoardColumnsPreservingScroll(container, ["backlog", "workspace", "notes"]);

  assert.equal(container.scrollLeft, 480);
  assert.deepEqual(container.children, ["backlog", "workspace", "notes"]);
});
