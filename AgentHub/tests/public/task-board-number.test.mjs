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

test("Task presentation updates cannot mutate its assigned number", async () => {
  const view = await loadBoardView();
  const update = view.taskPresentationUpdate(
    { id: "task-1", taskNumber: "HUB-40" },
    { title: "  Новый заголовок  ", description: "  Новое описание  " },
  );

  assert.deepEqual({ ...update }, {
    id: "task-1",
    title: "Новый заголовок",
    description: "Новое описание",
  });
  assert.equal(Object.hasOwn(update, "taskNumber"), false);
});

test("Task card executor uses only the Stream name", async () => {
  const view = await loadBoardView();
  const workspaces = [{
    id: "workspace-1",
    name: "Agent HUB",
    streams: [{ id: "stream-1", displayName: "Очень длинный Stream исполнителя" }],
  }];

  assert.equal(
    view.taskExecutorStreamName({ workspaceId: "workspace-1", streamId: "stream-1" }, workspaces),
    "Очень длинный Stream исполнителя",
  );
  assert.equal(view.taskExecutorStreamName({ workspaceId: "workspace-1" }, workspaces), "Не назначен");
});

test("Task summary keeps the status in its third slot when the number is absent", async () => {
  const view = await loadBoardView();
  const workspaces = [{
    id: "workspace-1",
    name: "Agent HUB",
    streams: [{ id: "stream-1", displayName: "Release Manager" }],
  }];
  const task = {
    title: "Исправить геометрию",
    workspaceId: "workspace-1",
    streamId: "stream-1",
    workflowStatus: "testing",
  };

  const withoutNumber = view.taskSummaryItems(task, workspaces, "en");
  const withNumber = view.taskSummaryItems({ ...task, taskNumber: "HUB-103" }, workspaces, "en");

  assert.deepEqual(Array.from(withoutNumber, ({ role }) => role), ["number", "executor", "status"]);
  assert.equal(withoutNumber[0].placeholder, true);
  assert.equal(withoutNumber[0].text, "");
  assert.equal(withoutNumber[2].status, "testing");
  assert.deepEqual(Array.from(withNumber, ({ role }) => role), ["number", "executor", "status"]);
  assert.equal(withNumber[0].placeholder, false);
  assert.equal(withNumber[0].text, "HUB-103");
  assert.equal(withNumber[2].status, "testing");
});
