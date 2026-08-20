import assert from "node:assert/strict";
import test from "node:test";
import { TelegramCommandService } from "../../../src/interfaces/telegram/telegram-command-service.mjs";

function service(overrides = {}) {
  const calls = [];
  const noop = async (...args) => { calls.push(args); return {}; };
  const dependencies = {
    sendMessage: noop, providerTitle: () => "Codex", sendAgentPicker: noop,
    sendModelPicker: noop, sendReasoningPicker: noop, sendModePicker: noop,
    sendProjectPicker: noop, dispatchCommand: noop, createCurrentTask: noop,
    messageContext: () => ({ clientId: "telegram:1" }),
    activeProvider: () => "codex", statusSnapshot: () => ({}), scheduleInteractiveJob: (_l, _c, op) => op(),
    sendStatus: noop, approvalModeText: () => "Auto", approvalModeKeyboard: () => ({}), restart: noop,
    sendTaskPicker: noop, resumeThread: noop, renameCurrentTask: async () => "Renamed",
    archiveCurrentTask: async () => ({ archived: false }), sendArchiveMessage: noop,
    selectedTask: () => ({ provider: "codex", threadId: "t1" }), runForTask: () => null,
    refreshTaskDiff: async () => "diff", storedTaskDiff: () => "", taskKey: () => "codex:t1",
    sendLongMessage: noop, sendRunMessage: noop, bindIncomingMessage: noop, startTurn: noop,
    prompt: (_message, text) => `prompt:${text}`, commandTaskTarget: (target) => target,
    selectedTurnTarget: (chatId) => ({ provider: "codex", threadId: "t1", chatId }),
    selectTaskFromBinding: noop,
    menu: {}, ...overrides,
  };
  return { instance: new TelegramCommandService(dependencies), calls };
}

test("Telegram command service dispatches task creation with client context", async () => {
  const created = [];
  const { instance } = service({
    createCurrentTask: async (...args) => created.push(args),
  });
  await instance.handle({ chat: { id: 1 } }, "/new");
  assert.deepEqual(created[0], [{ clientId: "telegram:1" }]);
});

test("Telegram command service sends ordinary text through the task lane", async () => {
  const bound = [];
  const started = [];
  const { instance } = service({
    bindIncomingMessage: async (...args) => bound.push(args),
    startTurn: async (...args) => started.push(args),
  });
  const message = { chat: { id: 1 } };
  await instance.handle(message, "hello");
  const target = { provider: "codex", threadId: "t1", chatId: 1 };
  assert.deepEqual(bound, [[message, "hello", target]]);
  assert.deepEqual(started, [["prompt:hello", [], { target }]]);
});

test("Telegram command service cancels the chat-scoped selected task", async () => {
  const dispatched = [];
  const globalTask = { provider: "claude", threadId: "global-thread", streamId: "stream-1" };
  const scopedTask = { provider: "claude", threadId: "chat-thread", streamId: "stream-1", chatId: 1 };
  const run = { id: "run-1" };
  const { instance } = service({
    selectedTask: () => globalTask,
    selectedTurnTarget: () => scopedTask,
    runForTask: (target) => (target.threadId === scopedTask.threadId ? run : null),
    dispatchCommand: async (...args) => {
      dispatched.push(args);
      return { message: "Запрошена остановка этой задачи" };
    },
  });

  await instance.handle({ chat: { id: 1 } }, "/cancel");

  assert.equal(dispatched[0][3].target.threadId, "chat-thread");
});

test("Telegram command service renames the chat-scoped selected task", async () => {
  const dispatched = [];
  const selected = [];
  const scopedTask = { provider: "codex", threadId: "chat-thread", streamId: "stream-1", chatId: 1 };
  const { instance } = service({
    selectedTask: () => ({ provider: "codex", threadId: "global-thread", streamId: "stream-1" }),
    selectedTurnTarget: () => scopedTask,
    dispatchCommand: async (...args) => {
      dispatched.push(args);
      return { renamedTitle: "Scoped" };
    },
    selectTaskFromBinding: async (...args) => selected.push(args),
  });

  await instance.handle({ chat: { id: 1 } }, "/rename Scoped");

  assert.equal(dispatched[0][0], "task.rename");
  assert.equal(dispatched[0][3].target.threadId, "chat-thread");
  assert.equal(selected[0][0].taskTitle, "Scoped");
});
