import assert from "node:assert/strict";
import test from "node:test";
import { TelegramCommandService } from "./telegram-command-service.mjs";

function service(overrides = {}) {
  const calls = [];
  const noop = async (...args) => { calls.push(args); return {}; };
  const dependencies = {
    sendMessage: noop, providerTitle: () => "Codex", sendAgentPicker: noop,
    sendModelPicker: noop, sendReasoningPicker: noop, sendModePicker: noop,
    sendProjectPicker: noop, dispatchCommand: noop, messageContext: () => ({ clientId: "tg:1" }),
    activeProvider: () => "codex", statusSnapshot: () => ({}), scheduleInteractiveJob: (_l, _c, op) => op(),
    sendStatus: noop, approvalModeText: () => "Auto", approvalModeKeyboard: () => ({}), restart: noop,
    sendTaskPicker: noop, resumeThread: noop, renameCurrentTask: async () => "Renamed",
    archiveCurrentTask: async () => ({ archived: false }), sendArchiveMessage: noop,
    selectedTask: () => ({ provider: "codex", threadId: "t1" }), runForTask: () => null,
    refreshTaskDiff: async () => "diff", storedTaskDiff: () => "", taskKey: () => "codex:t1",
    sendLongMessage: noop, sendRunMessage: noop, bindIncomingMessage: noop, startTurn: noop,
    prompt: (_message, text) => `prompt:${text}`, commandTaskTarget: (target) => target,
    menu: {}, ...overrides,
  };
  return { instance: new TelegramCommandService(dependencies), calls };
}

test("Telegram command service dispatches task creation with client context", async () => {
  const dispatched = [];
  const { instance } = service({
    dispatchCommand: async (...args) => dispatched.push(args),
  });
  await instance.handle({ chat: { id: 1 } }, "/new");
  assert.deepEqual(dispatched[0], ["task.create", { provider: "codex" }, { clientId: "tg:1" }]);
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
  assert.deepEqual(bound, [[message, "hello"]]);
  assert.deepEqual(started, [["prompt:hello"]]);
});

