import assert from "node:assert/strict";
import test from "node:test";

import { TelegramTaskActionService } from "../../../src/interfaces/telegram/telegram-task-action-service.mjs";

function fixture(overrides = {}) {
  const events = [];
  const task = { provider: "codex", projectRoot: "D:/repo", threadId: "thread-1", taskTitle: "Task" };
  const value = new TelegramTaskActionService({
    selectedTask: () => task,
    activeProvider: () => "codex",
    activeProjectRoot: () => "D:/repo",
    activeTaskTitle: () => "Task",
    currentThreadId: () => "thread-1",
    preferencesSnapshot: () => ({ codexModel: "gpt" }),
    selectedRun: () => null,
    selectTaskFromBinding: async () => ({ selectionChanged: true }),
    clearTaskSelection: async () => events.push("clear"),
    sendTaskSwitchNotification: async () => events.push("switch"),
    sendTaskAlreadySelectedNotification: async () => events.push("current"),
    dispatchCommand: async (type) => type === "task.rename"
      ? { renamedTitle: "Renamed" }
      : { archivedThread: { title: "Old" }, nextThread: { title: "Next" } },
    commandTaskTarget: (target) => target,
    isCodex: () => true,
    threadTitle: (thread) => thread.title,
    formatArchiveMessage: ({ archivedTask, activeTask }) => `${archivedTask} -> ${activeTask}`,
    sendMessage: async (...args) => { events.push(["send", ...args]); return { message_id: 8 }; },
    showLastMessageReplyMarkup: () => ({ inline_keyboard: [] }),
    bindRunMessage: async () => events.push("bind"),
    telegram: async (...args) => events.push(args),
    logger: { error() {} },
    ...overrides,
  });
  return { value, events, task };
}

test("resume notifies whether the selection really changed", async () => {
  const changed = fixture();
  await changed.value.resume("thread-2");
  assert.deepEqual(changed.events, ["switch"]);
  const current = fixture({ selectTaskFromBinding: async () => ({ selectionChanged: false }) });
  await current.value.resume("thread-1");
  assert.deepEqual(current.events, ["current"]);
});

test("archive policy blocks a live task and addresses an idle task explicitly", async () => {
  const blocked = fixture({ selectedRun: () => ({ id: "run" }) });
  assert.deepEqual(await blocked.value.archive(), { archived: false, reason: "active-turn" });
  const ready = fixture();
  const result = await ready.value.archive({ clientId: "telegram:7" });
  assert.equal(result.archived, true);
  await ready.value.sendArchive(result, 7);
  assert.ok(ready.events.includes("bind"));
});

test("create, rename and archive keep the Telegram client selection current", async () => {
  const selected = [];
  const setup = fixture({
    selectTaskFromBinding: async (binding, context) => selected.push([binding, context]),
    dispatchCommand: async (type) => {
      if (type === "task.create") return {
        createdTask: {
          provider: "codex", projectRoot: "D:/repo", threadId: "thread-2", taskTitle: "New",
        },
      };
      if (type === "task.rename") return { renamedTitle: "Renamed" };
      return { archivedThread: { title: "Old" }, nextThread: { id: "thread-3", title: "Next" } };
    },
  });
  const context = { clientId: "telegram:7" };
  await setup.value.create(context);
  await setup.value.rename("Renamed", context);
  await setup.value.archive(context);
  assert.deepEqual(selected.map(([binding]) => [binding.threadId, binding.taskTitle]), [
    ["thread-2", "New"],
    ["thread-1", "Renamed"],
    ["thread-3", "Next"],
  ]);
});

test("status snapshot and callback dismissal use current state only", async () => {
  const setup = fixture();
  assert.equal(setup.value.statusSnapshot(7).taskTitle, "Task");
  await setup.value.dismissMenu({ chat: { id: 7 }, message_id: 8 });
  assert.equal(setup.events.at(-1)[0], "deleteMessage");
});
