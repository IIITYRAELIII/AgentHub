import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { TaskBoardStore } from "../../../src/infrastructure/persistence/task-board-store.mjs";

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-task-board-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let sequence = 0;
  return new TaskBoardStore({
    databaseFile: path.join(directory, "journal.sqlite"),
    now: () => 1_700_000_000_000 + sequence,
    idFactory: () => `task-${++sequence}`,
  });
}

test("Task store deduplicates Telegram updates and persists capture mode", async (t) => {
  const store = await fixture(t);
  const first = store.create({ text: "  Купить молоко ", source: "telegram", sourceKey: "telegram:1:2" });
  const duplicate = store.create({ text: "Другой текст", source: "telegram", sourceKey: "telegram:1:2" });
  assert.equal(duplicate.id, first.id);
  assert.equal(duplicate.rawText, "Купить молоко");
  assert.equal(duplicate.title, "Купить молоко");
  assert.equal(duplicate.description, "");
  assert.equal(store.captureEnabled(1), false);
  store.setCaptureEnabled(1, true);
  assert.equal(store.captureEnabled(1), true);
});

test("Task store can persist disabled Spark triage", async (t) => {
  const store = await fixture(t);
  const task = store.create({ text: "Сохранить без Spark", triageStatus: "disabled" });
  assert.equal(task.triageStatus, "disabled");
  assert.equal(store.pendingTriage().length, 0);
});

test("Task store attaches a screenshot to the Task addressed by a Telegram reply", async (t) => {
  const store = await fixture(t);
  const task = store.create({
    text: "FB Миллениум",
    source: "telegram",
    sourceDetails: { chatId: 42, userId: 42, messageId: 7 },
  });
  const attached = store.attachToSourceMessage({
    source: "telegram",
    chatId: 42,
    userId: 42,
    messageId: 7,
    attachments: ["D:/attachments/screenshot.jpg", "D:/attachments/screenshot.jpg"],
  });
  assert.equal(attached.id, task.id);
  assert.deepEqual(attached.sourceDetails.attachments, ["D:/attachments/screenshot.jpg"]);
  assert.equal(store.list().length, 1);
});

test("Task store appends Telegram reply clarifications to one Task, including reply chains", async (t) => {
  const store = await fixture(t);
  const task = store.create({
    text: "ЭКЗАМЕНЫ",
    source: "telegram",
    sourceKey: "shared-dashboard:101",
    sourceDetails: { chatId: 42, userId: 42, messageId: 2 },
  });
  const firstReply = store.appendSourceMessage({
    source: "telegram",
    chatId: 42,
    userId: 42,
    messageId: 2,
    text: "надо сдать..",
    sourceDetails: { chatId: 42, userId: 42, messageId: 3, replyToMessageId: 2 },
  });
  const secondReply = store.appendSourceMessage({
    source: "telegram",
    chatId: 42,
    userId: 42,
    messageId: 3,
    text: "до пятницы",
    sourceDetails: { chatId: 42, userId: 42, messageId: 4, replyToMessageId: 3 },
  });

  assert.equal(firstReply.id, task.id);
  assert.equal(secondReply.id, task.id);
  assert.equal(store.list().length, 1);
  assert.match(secondReply.rawText, /Сообщение 1 · Вы[\s\S]*ЭКЗАМЕНЫ/u);
  assert.match(secondReply.rawText, /Сообщение 2 · Вы[\s\S]*надо сдать/u);
  assert.match(secondReply.rawText, /Сообщение 3 · Вы[\s\S]*до пятницы/u);
  assert.deepEqual(secondReply.sourceDetails.messageIds, [2, 3, 4]);
});

test("Task store merges a following forward into the preceding Telegram Task", async (t) => {
  const store = await fixture(t);
  const task = store.create({
    text: "КЭМЗ",
    source: "telegram",
    sourceKey: "shared-dashboard:798",
    sourceDetails: { updateId: 798, chatId: 42, userId: 42, messageId: 18 },
  });
  const text = "--- Сообщение 1 · Вы ---\nКЭМЗ\n\n--- Сообщение 2 · Переслано · Иван ---\nКонтекст";
  const merged = store.mergeSourceMessage({
    source: "telegram",
    chatId: 42,
    userId: 42,
    messageId: 18,
    text,
    sourceDetails: { bundleId: "bundle-1", chatId: 42, userId: 42, messageCount: 2 },
  });
  assert.equal(merged.id, task.id);
  assert.equal(merged.rawText, text);
  assert.equal(merged.sourceKey, "shared-dashboard:798");
  assert.equal(merged.sourceDetails.messageId, 18);
  assert.equal(merged.sourceDetails.bundleId, "bundle-1");
  assert.equal(merged.triageStatus, "pending");
  assert.equal(store.list().length, 1);
});

test("manual Task placement is not overwritten by a late Spark result", async (t) => {
  const store = await fixture(t);
  const task = store.create({ text: "посмотреть дюну" });
  store.move(task.id, { bucket: "workspace", workspaceId: "workspace-manual" });
  const triaged = store.applyTriage(task.id, {
    title: "Посмотреть «Дюну»",
    description: "",
    correctedText: "Посмотреть «Дюну»",
    category: "note",
    confidence: 0.98,
    bucket: "notes",
    autoPlace: true,
  });
  assert.equal(triaged.correctedText, "Посмотреть «Дюну»");
  assert.equal(triaged.title, "Посмотреть «Дюну»");
  assert.equal(triaged.description, "");
  assert.equal(triaged.bucket, "workspace");
  assert.equal(triaged.workspaceId, "workspace-manual");
  assert.equal(triaged.placementSource, "manual");
});

test("Task store removes legacy bundle instructions and schedules open Tasks for new triage", async (t) => {
  const store = await fixture(t);
  const prefix = [
    "Ниже пакет сообщений, собранный пользователем в Telegram.",
    "Сохраняй порядок и авторов. Пересланные реплики — контекст третьих лиц; не путай их с прямыми комментариями пользователя, отмеченными «Вы».",
    "",
  ].join("\n");
  const created = store.create({
    text: `${prefix}\n--- Сообщение 1 · Переслано · Клиент ---\nИсправить дату`,
    source: "telegram",
    sourceKey: "shared-dashboard:legacy",
    triageStatus: "disabled",
  });
  const migrated = store.task(created.id);
  assert.equal(migrated.rawText, "--- Сообщение 1 · Переслано · Клиент ---\nИсправить дату");
  assert.equal(migrated.title, "Исправить дату");
  assert.equal(migrated.triageStatus, "pending");
});

test("long Tasks persist a separate Spark title and description", async (t) => {
  const store = await fixture(t);
  const text = "Первая строка с контекстом\nВторая строка с подробностями задачи";
  const task = store.create({ text });
  assert.equal(task.title, "Первая строка с контекстом");
  assert.equal(task.description, text);
  const triaged = store.applyTriage(task.id, {
    title: "Проверить многострочную задачу",
    description: "Полное уточнённое описание задачи",
    correctedText: text,
    category: "task",
    confidence: 0.9,
  });
  assert.equal(triaged.rawText, text);
  assert.equal(triaged.title, "Проверить многострочную задачу");
  assert.equal(triaged.description, "Полное уточнённое описание задачи");
});

test("manual Task edits persist and win over a late Spark result", async (t) => {
  const store = await fixture(t);
  const task = store.create({ text: "исходная задача" });
  const edited = store.updatePresentation(task.id, {
    title: "Исправить дату документа",
    description: "Дата должна совпадать с моментом проведения.",
  });
  assert.equal(edited.rawText, "исходная задача");
  assert.equal(edited.title, "Исправить дату документа");
  assert.equal(edited.description, "Дата должна совпадать с моментом проведения.");
  assert.equal(edited.correctedText, "Исправить дату документа\n\nДата должна совпадать с моментом проведения.");

  const triaged = store.applyTriage(task.id, {
    title: "Запоздалый заголовок Spark",
    description: "Запоздалое описание Spark",
    correctedText: "Запоздалый текст Spark",
    category: "task",
    confidence: 0.9,
  });
  assert.equal(triaged.rawText, "исходная задача");
  assert.equal(triaged.title, edited.title);
  assert.equal(triaged.description, edited.description);
  assert.equal(triaged.correctedText, edited.correctedText);
});

test("Task card order persists within and between columns", async (t) => {
  const store = await fixture(t);
  const first = store.create({ text: "Первая" });
  const second = store.create({ text: "Вторая" });
  const third = store.create({ text: "Третья" });
  for (const task of [first, second, third]) {
    store.move(task.id, { bucket: "workspace", workspaceId: "workspace-1" });
  }
  store.move(third.id, {
    bucket: "workspace", workspaceId: "workspace-1", beforeId: first.id,
  });
  store.move(second.id, { bucket: "notes" });

  const reopened = new TaskBoardStore({ databaseFile: store.databaseFile });
  const tasks = reopened.list({ includeDone: false });
  assert.deepEqual(
    tasks.filter((task) => task.workspaceId === "workspace-1").map((task) => task.id),
    [third.id, first.id],
  );
  assert.deepEqual(tasks.filter((task) => task.bucket === "notes").map((task) => task.id), [second.id]);
});

test("Workspace and Notes column order persists after reordering", async (t) => {
  const store = await fixture(t);
  assert.deepEqual(store.orderedColumnIds(["one", "two", "three"]), ["one", "two", "three", "notes"]);
  store.moveColumn(["one", "two", "three"], { columnId: "notes", beforeColumnId: "two" });
  store.setNotesComment("Книги и фильмы");

  const reopened = new TaskBoardStore({ databaseFile: store.databaseFile });
  assert.deepEqual(reopened.orderedColumnIds(["one", "two", "three"]), ["one", "notes", "two", "three"]);
  assert.equal(reopened.notesComment(), "Книги и фильмы");
});

test("Workspace removal reassigns its cards and preserves their order", async (t) => {
  const store = await fixture(t);
  const target = store.create({ text: "Target" });
  const first = store.create({ text: "First" });
  const second = store.create({ text: "Second" });
  store.move(target.id, { bucket: "workspace", workspaceId: "workspace-2" });
  store.move(first.id, { bucket: "workspace", workspaceId: "workspace-1" });
  store.move(second.id, { bucket: "workspace", workspaceId: "workspace-1" });
  store.moveColumn(["workspace-1", "workspace-2"], {
    columnId: "workspace-1",
    beforeColumnId: "workspace-2",
  });

  assert.equal(store.reassignWorkspace("workspace-1", "workspace-2"), 2);
  assert.deepEqual(
    store.list({ includeDone: false })
      .filter((task) => task.workspaceId === "workspace-2")
      .map((task) => task.id),
    [target.id, first.id, second.id],
  );
  assert.deepEqual(store.orderedColumnIds(["workspace-2"]), ["workspace-2", "notes"]);
});
