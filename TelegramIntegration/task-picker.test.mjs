import assert from "node:assert/strict";
import test from "node:test";
import { buildTaskPicker, taskPickerButtonText } from "./task-picker.mjs";

const task = {
  provider: "codex",
  threadId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  projectRoot: "C:/repo",
  projectName: "Repo",
  title: "Задача",
  running: true,
  executionOwner: "vscode",
};

test("task picker marks selected running task and optional project", () => {
  const text = taskPickerButtonText(task, task, { showProject: true });
  assert.match(text, /^✓ ⏳ VSC · Codex · Repo · Задача$/);
});

test("task picker distinguishes a running Integration task", () => {
  const text = taskPickerButtonText({
    ...task,
    executionOwner: "telegram",
  }, null);
  assert.equal(text, "⚡ INT · Codex · Задача");
});

test("task picker paginates and keeps new/archive actions last", () => {
  const catalog = Array.from({ length: 9 }, (_, index) => ({
    ...task,
    threadId: `${String(index).padStart(8, "0")}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`,
    title: `Task ${index}`,
    running: false,
  }));
  const view = buildTaskPicker({
    catalog,
    selectedTask: null,
    page: 1,
    pageSize: 8,
    providerTitle: "Codex",
    projectName: "Repo",
    newTaskCallback: "new",
    archiveCallback: "archive",
  });
  assert.equal(view.page, 1);
  assert.equal(view.replyMarkup.inline_keyboard.at(-2)[0].callback_data, "new");
  assert.equal(view.replyMarkup.inline_keyboard.at(-1)[0].callback_data, "archive");
});
