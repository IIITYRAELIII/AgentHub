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
      attachToSourceMessage: (value) => {
        calls.push(["attach", value]);
        return { id: "board-1", rawText: task.rawText };
      },
      appendSourceMessage: (value) => {
        calls.push(["append", value]);
        return { id: "board-1", rawText: `${task.rawText}\n${value.text}` };
      },
      mergeSourceMessage: (value) => {
        calls.push(["merge", value]);
        return { id: "board-1", rawText: value.text };
      },
      update: (value) => calls.push(["update", value]),
      setWorkflowStatus: (value) => calls.push(["status", value]),
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

test("a screenshot reply augments the existing dashboard Task", async () => {
  const { controller, calls } = fixture();
  await controller.ingest({
    replyMessageId: 7,
    sourceDetails: { chatId: 42, userId: 42, messageId: 8 },
    attachments: ["D:/runtime/attachments/screenshot.jpg"],
  });
  assert.deepEqual(calls[0], ["attach", {
    source: "telegram",
    chatId: 42,
    userId: 42,
    messageId: 7,
    attachments: ["D:/runtime/attachments/screenshot.jpg"],
  }]);
  assert.equal(calls.some(([name]) => name === "create"), false);
});

test("a text reply to an own Telegram message clarifies the existing dashboard Task", async () => {
  const { controller, calls } = fixture();
  await controller.ingest({
    replyMessageId: 7,
    text: "надо сдать..",
    sourceDetails: { chatId: 42, userId: 42, messageId: 8, replyToMessageId: 7 },
  });
  assert.deepEqual(calls[0], ["append", {
    source: "telegram",
    chatId: 42,
    userId: 42,
    messageId: 7,
    text: "надо сдать..",
    sourceDetails: { chatId: 42, userId: 42, messageId: 8, replyToMessageId: 7 },
    attachments: [],
  }]);
  assert.equal(calls.some(([name]) => name === "create"), false);
});

test("a forward following a short comment expands the existing dashboard Task", async () => {
  const { controller, calls } = fixture();
  await controller.ingest({
    mergeMessageId: 18,
    text: "--- Сообщение 1 · Вы ---\nКЭМЗ\n\n--- Сообщение 2 · Переслано · Иван ---\nКонтекст",
    sourceDetails: { chatId: 42, userId: 42, bundleId: "bundle-1" },
  });
  assert.deepEqual(calls[0], ["merge", {
    source: "telegram",
    chatId: 42,
    userId: 42,
    messageId: 18,
    text: "--- Сообщение 1 · Вы ---\nКЭМЗ\n\n--- Сообщение 2 · Переслано · Иван ---\nКонтекст",
    sourceDetails: { chatId: 42, userId: 42, bundleId: "bundle-1" },
  }]);
  assert.equal(calls.some(([name]) => name === "create"), false);
});

test("dashboard persists column reordering", async () => {
  const { controller, calls } = fixture();
  await controller.moveColumn({ columnId: "notes", beforeColumnId: "workspace:workspace-1" });
  assert.deepEqual(calls[0], ["move-column", {
    columnId: "notes", beforeColumnId: "workspace:workspace-1",
  }]);
});

test("dashboard saves edited Task fields", async () => {
  const { controller, calls } = fixture();
  await controller.update({ id: "board-1", title: "Новый заголовок", description: "Описание" });
  assert.deepEqual(calls[0], ["update", {
    id: "board-1", title: "Новый заголовок", description: "Описание",
  }]);
  assert.deepEqual(calls[1], ["snapshot", { refresh: true }]);
});

test("dashboard changes a Task workflow status manually", async () => {
  const { controller, calls } = fixture();
  await controller.status({ id: "board-1", status: "testing" });
  assert.deepEqual(calls[0], ["status", { id: "board-1", status: "testing" }]);
  assert.deepEqual(calls[1], ["snapshot", { refresh: true }]);
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

test("starting a Task in an existing Stream sends a uniquely identified reference instead of its raw text", async () => {
  const { controller, calls } = fixture({
    activeThread: { provider: "codex", threadId: "thread-1", projectRoot: "D:/work" },
    sourceDetails: { attachments: ["D:/runtime/attachments/screenshot.jpg"] },
  });
  await controller.start({
    id: "board-1",
    workspaceId: "workspace-1",
    streamId: "stream-1",
    clientUserMessageId: "board-task:board-1:launch-2",
  });
  assert.equal(calls[0][1], "task.select");
  assert.equal(calls[1][0], "message");
  assert.equal(calls[1][1].text, "");
  assert.equal(calls[1][1].clientUserMessageId, "board-task:board-1:launch-2");
  assert.deepEqual(calls[1][1].taskReferences, [{ taskId: "board-1", intent: "start" }]);
  assert.equal("attachments" in calls[1][1], false);
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
