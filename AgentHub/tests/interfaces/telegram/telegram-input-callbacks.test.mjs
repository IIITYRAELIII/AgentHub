import assert from "node:assert/strict";
import test from "node:test";
import { TelegramInputCallbackService } from "../../../src/interfaces/telegram/telegram-input-callbacks.mjs";

function service(events, overrides = {}) {
  const noop = async () => {};
  return new TelegramInputCallbackService({
    telegram: async (method, body) => events.push({ method, body }),
    sendMessageTo: noop,
    updateDeferredDesktopReceipt: () => {},
    cleanupDeferredFiles: noop,
    saveState: noop,
    updateDeferredMessage: noop,
    scheduleNextForTask: () => {},
    selectTaskFromBinding: async () => ({ selectionChanged: false }),
    callbackContext: () => ({}),
    showTaskMessage: noop,
    scheduleQueuedInput: () => {},
    startTurn: async () => ({}),
    startDeferred: async () => ({}),
    runForTask: () => null,
    describeAttachments: () => [],
    dispatchApplicationCommand: noop,
    selectedTurnTarget: (chatId) => ({ chatId, provider: "codex", threadId: "new-task" }),
    activeThreadTitle: () => "Task",
    selectedTask: () => ({}),
    speechText: () => null,
    sendTaskSwitchNotification: noop,
    forwardBundleController: { bundleById: () => null },
    pendingInputs: new Map(),
    queuedInputs: new Map(),
    backgroundJobs: { enqueue: noop, speechPending: 0 },
    maxSpeechJobs: 4,
    ...overrides,
  });
}

const callback = { id: "cb", message: { chat: { id: 1 }, message_id: 2 } };

function newTaskFixture({ createdStreamId = "stream-new" } = {}) {
  const events = [];
  const item = {
    id: "deferred-1",
    chatId: 1,
    input: "следующее",
    temporaryFiles: [],
    streamId: "stream-1",
    provider: "codex",
    projectRoot: "D:/Work",
    threadId: "thread-old",
    taskTitle: "Old",
    clientUserMessageId: "telegram:1:42",
  };
  const calls = [];
  const pendingInputs = new Map([[item.id, item]]);
  const callbacks = service(events, {
    sendMessageTo: async (chatId, text) => calls.push(["send", chatId, text]),
    selectTaskFromBinding: async (binding) => {
      calls.push(["select", binding]);
      return { selectionChanged: false };
    },
    callbackContext: () => ({ clientId: "telegram:1" }),
    startTurn: async (input, _files, options) => {
      calls.push(["start", input, options.target]);
      return {};
    },
    startDeferred: async (deferredItem) => {
      calls.push([
        "startDeferred",
        deferredItem.input,
        deferredItem.threadId,
        deferredItem.streamId,
        deferredItem.clientUserMessageId,
      ]);
      return {};
    },
    dispatchApplicationCommand: async (command, params) => {
      calls.push(["dispatch", command, params]);
      return {
        createdTask: {
          provider: "codex",
          threadId: "thread-new",
          streamId: createdStreamId,
          projectRoot: "D:/Work",
          taskTitle: "Task",
        },
      };
    },
    selectedTurnTarget: (chatId) => ({
      chatId,
      provider: "codex",
      projectRoot: "D:/Work",
      threadId: "thread-new",
      streamId: createdStreamId,
    }),
    activeThreadTitle: () => "Task",
    selectedTask: () => ({
      provider: "codex",
      threadId: "thread-new",
      streamId: createdStreamId,
    }),
    pendingInputs,
  });
  return { callbacks, calls, events, item, pendingInputs };
}

test("input callback service rejects expired bundles and speech", async () => {
  const events = [];
  const callbacks = service(events);
  assert.equal(await callbacks.handle(callback, { kind: "forward-bundle", id: "old" }), true);
  assert.equal(await callbacks.handle(callback, { kind: "speech", id: "old" }), true);
  assert.deepEqual(events.map((event) => event.body.text), ["Эта пачка уже обработана", "Текст ответа уже недоступен"]);
});

test("input callback service declines task routes", async () => {
  assert.equal(await service([]).handle(callback, { kind: "task-view" }), false);
});

test("input callback cancellation keeps the input and attachments when save fails", async () => {
  const events = [];
  const item = {
    id: "deferred-1", chatId: 1, provider: "codex", threadId: "thread-1",
    temporaryFiles: ["screen.png"],
  };
  const pendingInputs = new Map([[item.id, item]]);
  const cleaned = [];
  const receipts = [];
  const callbacks = new TelegramInputCallbackService({
    telegram: async (method, body) => events.push({ method, body }),
    sendMessageTo: async () => {},
    updateDeferredDesktopReceipt: (...args) => receipts.push(args),
    cleanupDeferredFiles: async (value) => cleaned.push(value),
    saveState: async () => { throw new Error("disk full"); },
    updateDeferredMessage: async () => {},
    scheduleNextForTask: () => {},
    selectTaskFromBinding: async () => ({ selectionChanged: false }),
    callbackContext: () => ({}),
    showTaskMessage: async () => {},
    scheduleQueuedInput: () => {},
    startTurn: async () => ({}),
    startDeferred: async () => ({}),
    runForTask: () => null,
    describeAttachments: () => [],
    dispatchApplicationCommand: async () => {},
    selectedTurnTarget: () => ({ provider: "codex", threadId: "new-task" }),
    activeThreadTitle: () => "Task",
    selectedTask: () => ({}),
    speechText: () => null,
    sendTaskSwitchNotification: async () => {},
    forwardBundleController: { bundleById: () => null },
    pendingInputs,
    queuedInputs: new Map(),
    backgroundJobs: { enqueue: async () => null, speechPending: 0 },
    maxSpeechJobs: 4,
  });

  await callbacks.handle(callback, { kind: "pending-input", id: item.id, action: "cancel" });

  assert.equal(pendingInputs.get(item.id), item);
  assert.deepEqual(receipts, []);
  assert.deepEqual(cleaned, []);
  assert.equal(events.at(-1).body.text, "Сообщение отменено");
});

test("input callback new task starts the deferred message in a sibling Stream", async () => {
  const { callbacks, calls, item, pendingInputs } = newTaskFixture();

  await callbacks.handle(callback, { kind: "pending-input", id: item.id, action: "new" });

  assert.equal(pendingInputs.has(item.id), false);
  assert.deepEqual(calls.find((call) => call[0] === "dispatch"), [
    "dispatch",
    "task.create",
    { provider: "codex", sourceStreamId: "stream-1" },
  ]);
  assert.deepEqual(calls.filter((call) => call[0] === "select").at(-1), [
    "select",
    {
      provider: "codex",
      projectRoot: "D:/Work",
      threadId: "thread-new",
      streamId: "stream-new",
      taskTitle: "Task",
      chatId: 1,
    },
  ]);
  assert.deepEqual(calls.find((call) => call[0] === "startDeferred"), [
    "startDeferred",
    "следующее",
    "thread-new",
    "stream-new",
    "telegram:1:42",
  ]);
  assert.equal(calls.some((call) => call[0] === "start"), false);
});

test("input callback rejects a missing or reused Stream for the new task", async () => {
  for (const createdStreamId of [null, "stream-1"]) {
    const { callbacks, calls, item, pendingInputs } = newTaskFixture({ createdStreamId });

    await callbacks.handle(callback, { kind: "pending-input", id: item.id, action: "new" });

    assert.equal(pendingInputs.has(item.id), true);
    assert.equal(calls.filter(([name]) => name === "select").length, 1);
    assert.equal(calls.some(([name]) => name === "start"), false);
    assert.match(
      calls.find(([name]) => name === "send")[2],
      /новый поток не вернул отдельную Stream-привязку/u,
    );
  }
});
