import assert from "node:assert/strict";
import test from "node:test";
import { TelegramInputCallbackService } from "./telegram-input-callbacks.mjs";

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
