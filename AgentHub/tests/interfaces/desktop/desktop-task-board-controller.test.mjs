import assert from "node:assert/strict";
import test from "node:test";

import { DesktopTaskBoardController } from "../../../src/interfaces/desktop/desktop-task-board-controller.mjs";

function fixture({ activeThread = null, sourceDetails = undefined } = {}) {
  const calls = [];
  const task = {
    id: "board-1",
    rawText: "Исправить Task dashboard",
    correctedText: "",
    workspaceId: "workspace-1",
    sourceDetails,
  };
  const controller = new DesktopTaskBoardController({
    taskBoard: {
      task: () => task,
      create: (value) => { calls.push(["create", value]); return { id: "board-created", rawText: value.text }; },
      move: (value) => calls.push(["move", value]),
      moveColumn: (value) => calls.push(["move-column", value]),
      setNotesComment: (value) => calls.push(["notes-comment", value]),
      markStarted: (value) => calls.push(["started", value]),
    },
    workspaceCatalog: {
      workspace: (id) => id === "workspace-1" ? { id, name: "Agent Hub" } : null,
      stream: (id) => id === "stream-1" ? { id, workspaceId: "workspace-1" } : null,
      activeThread: () => activeThread,
      updateWorkspaceComment: (...value) => calls.push(["workspace-comment", ...value]),
    },
    dispatchCommand: async (...args) => {
      calls.push(["command", ...args]);
      return {
        createdTask: {
          streamId: "stream-new",
          provider: "codex",
          threadId: "thread-new",
          projectRoot: "D:/work",
        },
      };
    },
    sendMessage: async (params) => calls.push(["message", params]),
    snapshot: async (value) => { calls.push(["snapshot", value]); return { boardTasks: [] }; },
  });
  return { controller, calls };
}

test("dashboard creation adds a manual task directly to its Workspace", async () => {
  const { controller, calls } = fixture();
  await controller.create({ text: "Новая задача", workspaceId: "workspace-1" });
  assert.deepEqual(calls[0], ["create", { text: "Новая задача", source: "hub" }]);
  assert.deepEqual(calls[1], ["move", {
    id: "board-created", bucket: "workspace", workspaceId: "workspace-1",
  }]);
});

test("shared Telegram bot ingestion preserves its source and refreshes the dashboard", async () => {
  const { controller, calls } = fixture();
  assert.deepEqual(await controller.ingest({
    text: "Проверить общий бот",
    sourceKey: "shared-dashboard:123",
    sourceDetails: { chatId: "42", messageId: "7" },
  }), {
    taskId: "board-created",
    rawText: "Проверить общий бот",
  });
  assert.deepEqual(calls[0], ["create", {
    text: "Проверить общий бот",
    source: "telegram",
    sourceKey: "shared-dashboard:123",
    sourceDetails: { chatId: "42", messageId: "7" },
  }]);
  assert.deepEqual(calls[1], ["snapshot", { refresh: true }]);
});

test("shared Telegram bot persists downloaded images with the dashboard Task", async () => {
  const { controller, calls } = fixture();
  await controller.ingest({
    text: "Проверить скриншот",
    sourceKey: "shared-dashboard:bundle",
    sourceDetails: { imageCount: 1 },
    attachments: ["D:/runtime/attachments/screenshot.jpg"],
  });
  assert.deepEqual(calls[0][1].sourceDetails, {
    imageCount: 1,
    attachments: ["D:/runtime/attachments/screenshot.jpg"],
  });
});

test("dashboard persists column reordering", async () => {
  const { controller, calls } = fixture();
  await controller.moveColumn({ columnId: "notes", beforeColumnId: "workspace:workspace-1" });
  assert.deepEqual(calls[0], ["move-column", {
    columnId: "notes", beforeColumnId: "workspace:workspace-1",
  }]);
});

test("legacy Workspace move adapts to the shared column contract", async () => {
  const { controller, calls } = fixture();
  await controller.moveWorkspace({ workspaceId: "workspace-2", beforeWorkspaceId: "workspace-1" });
  assert.deepEqual(calls[0], ["move-column", {
    columnId: "workspace:workspace-2", beforeColumnId: "workspace:workspace-1",
  }]);
});

test("dashboard updates Notes and Workspace comments", async () => {
  const { controller, calls } = fixture();
  await controller.updateColumnComment({ columnId: "notes", comment: "Фильмы" });
  await controller.updateColumnComment({ columnId: "workspace:workspace-1", comment: "Разработка" });
  assert.deepEqual(calls.filter(([name]) => name !== "snapshot"), [
    ["notes-comment", { columnId: "notes", comment: "Фильмы" }],
    ["workspace-comment", "workspace-1", "Разработка"],
  ]);
});

test("starting a Task in an existing Stream selects it and sends the Task text", async () => {
  const { controller, calls } = fixture({
    activeThread: { provider: "codex", threadId: "thread-1", projectRoot: "D:/work" },
    sourceDetails: { attachments: ["D:/runtime/attachments/screenshot.jpg"] },
  });
  await controller.start({ id: "board-1", workspaceId: "workspace-1", streamId: "stream-1" });
  assert.equal(calls[0][1], "task.select");
  assert.equal(calls[1][0], "message");
  assert.equal(calls[1][1].text, "Исправить Task dashboard");
  assert.deepEqual(calls[1][1].attachments, ["D:/runtime/attachments/screenshot.jpg"]);
  assert.deepEqual(calls[2], ["started", {
    id: "board-1", workspaceId: "workspace-1", streamId: "stream-1",
  }]);
});

test("starting a Task can create a new Stream before sending", async () => {
  const { controller, calls } = fixture();
  await controller.start({
    id: "board-1", workspaceId: "workspace-1", streamName: "Dashboard", provider: "codex",
  });
  assert.equal(calls[0][1], "task.create");
  assert.equal(calls[0][2].streamName, "Dashboard");
  assert.equal(calls[1][1].streamId, "stream-new");
});
