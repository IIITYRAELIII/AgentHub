import assert from "node:assert/strict";
import test from "node:test";

import { TelegramTaskActionService } from "./src/interfaces/telegram/telegram-task-action-service.mjs";

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

test("status snapshot and callback dismissal use current state only", async () => {
  const setup = fixture();
  assert.equal(setup.value.statusSnapshot(7).taskTitle, "Task");
  await setup.value.dismissMenu({ chat: { id: 7 }, message_id: 8 });
  assert.equal(setup.events.at(-1)[0], "deleteMessage");
});
