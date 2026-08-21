import assert from "node:assert/strict";
import test from "node:test";
import { TelegramTaskCallbackService } from "../../../src/interfaces/telegram/telegram-task-callbacks.mjs";

function callbacks(events, entries = [], overrides = {}) {
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
    createCurrentTask: async () => ({}),
    activeProvider: () => "codex",
    sendMessage: noop,
    providerTitle: () => "Codex",
    archiveBlockedReason: () => null,
    archiveCurrentThread: async () => ({ archived: true }),
    sendArchiveMessage: noop,
    dismissCallbackMenu: noop,
    ...overrides,
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
  assert.ok(events.some((event) => event.body?.text === "Поток больше не найден" && event.body.show_alert));
});

test("task callback service selects a Workspace and Stream title", async () => {
  const events = [];
  const selected = [];
  const entry = {
    provider: "codex",
    threadId: "thread-1",
    projectRoot: "C:/repo",
    workspaceName: "Agent HUB",
    streamName: "Themes",
    title: "Internal Thread title",
  };
  await callbacks(events, [entry], {
    selectTaskFromBinding: async (binding) => {
      selected.push(binding);
      return { selectionChanged: true };
    },
  }).handle(callback, {
    kind: "catalog-task",
    catalogTask: { provider: "codex", threadId: "thread-1" },
  });
  assert.equal(selected[0].taskTitle, "Agent HUB - Themes");
});

test("task callback service declines settings routes", async () => {
  assert.equal(await callbacks([]).handle(callback, { kind: "codex-model" }), false);
});
