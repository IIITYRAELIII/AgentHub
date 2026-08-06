import assert from "node:assert/strict";
import test from "node:test";

import { DesktopTaskService } from "../../../src/interfaces/desktop/desktop-task-service.mjs";

function fixture() {
  const entry = {
    streamId: "stream-1",
    provider: "codex",
    projectRoot: "C:\\repo",
    threadId: "thread-1",
    title: "Task",
  };
  const calls = [];
  const service = new DesktopTaskService({
    catalog: () => [entry],
    refreshCatalog: async () => [entry],
    activateBinding: async (binding) => {
      calls.push(["activate", binding]);
      return { changed: true };
    },
    markRead: (...args) => calls.push(["read", ...args]),
    snapshot: async () => ({ selected: true }),
    taskHistory: async (params) => ({ params }),
    dispatchCommand: async (...args) => {
      calls.push(["dispatch", ...args]);
      return { selected: true };
    },
    commandTaskTarget: (params) => ({ ...params }),
    readTurn: async () => ({
      taskThreadId: "thread-1",
      projectRoot: "C:\\repo",
      body: "answer",
      title: "Turn",
    }),
    samePath: (left, right) => left.toLowerCase() === right.toLowerCase(),
    chatId: () => 101,
  });
  return { service, calls };
}

test("Desktop task service resolves streamId before provider references", async () => {
  const { service } = fixture();
  const target = await service.resolveTarget(
    { streamId: "stream-1" },
    { source: "vscode-extension" },
  );
  assert.equal(target.threadId, "thread-1");
  assert.equal(target.streamId, "stream-1");
  assert.equal(target.chatId, 101);
  assert.equal(target.telegramDeliveryRequested, false);
  assert.equal(target.clientSource, "vscode-extension");
});

test("Desktop task selection activates and marks one exact task", async () => {
  const { service, calls } = fixture();
  const result = await service.select({ provider: "codex", threadId: "thread-1" });
  assert.equal(result.selectionChanged, true);
  assert.equal(calls[0][0], "activate");
  assert.equal(calls[1][0], "read");
});

test("Desktop turn open verifies task ownership before returning the body", async () => {
  const { service, calls } = fixture();
  const result = await service.openTurn({
    provider: "codex",
    taskThreadId: "thread-1",
    turnThreadId: "thread-1",
    turnId: "turn-1",
  });
  assert.equal(result.focusedTurn.answer, "answer");
  assert.equal(calls.some(([name]) => name === "dispatch"), true);
});
