import assert from "node:assert/strict";
import test from "node:test";

import { ClientTaskSelectionService } from "../../src/application/client-task-selection-service.mjs";
import { HubSessionState } from "../../src/runtime/hub-session-state.mjs";

function fixture() {
  const sessionState = new HubSessionState();
  sessionState.setChatId(42);
  let fallback = {
    streamId: "desktop-stream",
    provider: "codex",
    projectRoot: "D:/Work",
    threadId: "desktop-thread",
  };
  let saves = 0;
  const catalog = [{
    streamId: "telegram-stream",
    provider: "codex",
    projectRoot: "D:/Work",
    sessionCwd: "D:/Work/Utilities",
    threadId: "telegram-thread",
    title: "DevOps",
    model: "gpt-5.6-sol",
    reasoning: "high",
  }];
  const service = new ClientTaskSelectionService({
    sessionState,
    fallbackSelection: () => fallback,
    fallbackTitle: () => "Desktop task",
    findProject: (root) => root === "D:/Work" ? { path: root } : null,
    catalogEntries: () => catalog,
    catalogEntryIsSelected: (entry, task) => (
      entry.provider === task.provider && entry.threadId === task.threadId
    ),
    preferences: {
      current: () => ({ model: "fallback", reasoningEffort: "medium", collaborationMode: "work" }),
    },
    samePath: (left, right) => left.toLowerCase() === right.toLowerCase(),
    save: async () => { saves += 1; },
  });
  return { service, sessionState, saves: () => saves, setFallback: (value) => { fallback = value; } };
}

test("Telegram selection remains stable when the shared fallback selection changes", async () => {
  const f = fixture();
  await f.service.select({
    streamId: "telegram-stream",
    provider: "codex",
    projectRoot: "D:/Work",
    threadId: "telegram-thread",
    taskTitle: "DevOps",
  }, { clientId: "telegram:42" });

  f.setFallback({
    streamId: "other-stream",
    provider: "codex",
    projectRoot: "D:/Work",
    threadId: "other-desktop-thread",
  });

  assert.equal(f.service.selectedTask(42).threadId, "telegram-thread");
  assert.equal(f.service.title(42), "DevOps");
  assert.deepEqual(f.service.turnTarget(42), {
    streamId: "telegram-stream",
    provider: "codex",
    projectRoot: "D:/Work",
    sessionCwd: "D:/Work/Utilities",
    threadId: "telegram-thread",
    taskTitle: "DevOps",
    chatId: 42,
    modelId: "gpt-5.6-sol",
    reasoningId: "high",
    collaborationMode: "work",
  });
  assert.equal(f.saves(), 1);
});

test("Telegram selection is isolated by chat and keeps its startup fallback", async () => {
  const f = fixture();
  assert.equal(f.service.selectedTask(99).threadId, "desktop-thread");
  f.setFallback({
    streamId: "other-stream",
    provider: "codex",
    projectRoot: "D:/Work",
    threadId: "other-desktop-thread",
  });
  assert.equal(f.service.selectedTask(99).threadId, "desktop-thread");
  await f.service.select({
    provider: "codex",
    projectRoot: "D:/Work",
    threadId: "telegram-thread",
  }, { clientId: "telegram:42" });
  assert.equal(f.service.selectedTask(42).threadId, "telegram-thread");
  assert.equal(f.service.selectedTask(42).streamId, "telegram-stream");
  assert.equal(f.service.title(42), "DevOps");
  assert.equal(f.service.selectedTask(99).threadId, "desktop-thread");
  assert.equal(await f.service.clear({ clientId: "telegram:42" }), true);
  assert.equal(f.service.selectedTask(42).threadId, "desktop-thread");
});
