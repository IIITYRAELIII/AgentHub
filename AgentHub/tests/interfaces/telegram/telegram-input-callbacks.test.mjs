import assert from "node:assert/strict";
import test from "node:test";
import { TelegramInputCallbackService } from "../../../src/interfaces/telegram/telegram-input-callbacks.mjs";

function service(events) {
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
    runForTask: () => null,
    describeAttachments: () => [],
    dispatchApplicationCommand: noop,
    createCurrentTask: noop,
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
  });
}

const callback = { id: "cb", message: { chat: { id: 1 }, message_id: 2 } };

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
    runForTask: () => null,
    describeAttachments: () => [],
    dispatchApplicationCommand: async () => {},
    createCurrentTask: async () => {},
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
