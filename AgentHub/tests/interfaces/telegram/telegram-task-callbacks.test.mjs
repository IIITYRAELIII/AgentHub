import assert from "node:assert/strict";
import test from "node:test";
import { TelegramTaskCallbackService } from "../../../src/interfaces/telegram/telegram-task-callbacks.mjs";

function callbacks(events, entries = []) {
  const noop = async () => {};
  return new TelegramTaskCallbackService({
    telegram: async (method, body) => events.push({ method, body }),
    resolveTaskViewBinding: async () => null,
    runForTask: () => null,
    refreshTaskDiff: noop,
    storedTaskDiff: () => "",
    taskRunKey: () => "key",
    sendLongMessage: noop,
    selectTaskFromBinding: async () => ({ selectionChanged: true }),
    callbackContext: () => ({ clientId: "telegram:1" }),
    showLastTaskMessage: noop,
    showTaskMessage: noop,
    sendMessageTo: noop,
    sendTaskSwitchNotification: noop,
    sendTaskAlreadySelectedNotification: noop,
    scheduleInteractiveJob: (_label, _chatId, operation) => void operation(),
    sendThreadPicker: async (params) => events.push({ picker: params }),
    taskCatalog: () => entries,
    refreshTaskCatalog: async () => entries,
    dispatchApplicationCommand: async () => ({}),
    activeProvider: () => "codex",
    sendMessage: noop,
    providerTitle: () => "Codex",
    archiveBlockedReason: () => null,
    archiveCurrentThread: async () => ({ archived: true }),
    sendArchiveMessage: noop,
    dismissCallbackMenu: noop,
  });
}

const callback = { id: "cb", message: { chat: { id: 1 }, message_id: 2 } };

test("task callback service owns task paging", async () => {
  const events = [];
  assert.equal(await callbacks(events).handle(callback, { kind: "task-page", page: 3 }), true);
  assert.ok(events.some((event) => event.picker?.page === 3));
});

test("task callback service reports a missing catalog task", async () => {
  const events = [];
  await callbacks(events).handle(callback, {
    kind: "catalog-task",
    catalogTask: { provider: "codex", threadId: "missing" },
  });
  assert.ok(events.some((event) => event.body?.text === "Задача больше не найдена" && event.body.show_alert));
});

test("task callback service declines settings routes", async () => {
  assert.equal(await callbacks([]).handle(callback, { kind: "codex-model" }), false);
});
