import assert from "node:assert/strict";
import test from "node:test";

import { DesktopTaskBoardController } from "../../../src/interfaces/desktop/desktop-task-board-controller.mjs";

function fixture({ activeThread = null } = {}) {
  const calls = [];
  const task = {
    id: "board-1",
    rawText: "Исправить Task dashboard",
    correctedText: "",
    workspaceId: "workspace-1",
  };
  const controller = new DesktopTaskBoardController({
    taskBoard: {
      task: () => task,
      markStarted: (value) => calls.push(["started", value]),
    },
    workspaceCatalog: {
      workspace: (id) => id === "workspace-1" ? { id, name: "Agent Hub" } : null,
      stream: (id) => id === "stream-1" ? { id, workspaceId: "workspace-1" } : null,
      activeThread: () => activeThread,
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
    snapshot: async () => ({ boardTasks: [] }),
  });
  return { controller, calls };
}

test("starting a Task in an existing Stream selects it and sends the Task text", async () => {
  const { controller, calls } = fixture({
    activeThread: { provider: "codex", threadId: "thread-1", projectRoot: "D:/work" },
  });
  await controller.start({ id: "board-1", workspaceId: "workspace-1", streamId: "stream-1" });
  assert.equal(calls[0][1], "task.select");
  assert.equal(calls[1][0], "message");
  assert.equal(calls[1][1].text, "Исправить Task dashboard");
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
