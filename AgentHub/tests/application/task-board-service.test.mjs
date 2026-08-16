import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { BugReportTaskCapture } from "../../src/application/bug-report-task-capture.mjs";
import { TaskBoardService } from "../../src/application/task-board-service.mjs";
import { TaskBoardStore } from "../../src/infrastructure/persistence/task-board-store.mjs";

async function fixture(t, classify) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-task-service-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new TaskBoardStore({ databaseFile: path.join(directory, "journal.sqlite") });
  const workspaces = [
    { id: "agent-hub", name: "Agent Hub", systemKey: null, streams: [] },
    { id: "other", name: "Other", systemKey: "experiments", streams: [] },
  ];
  const workspaceCatalog = {
    hierarchy: () => workspaces,
    workspace: (id) => workspaces.find((item) => item.id === id) ?? null,
    stream: () => null,
  };
  return new TaskBoardService({ store, workspaceCatalog, classify, autoPlaceConfidence: 0.82 });
}

test("snapshot revision reads owner revisions without building hierarchy or board", () => {
  let hierarchyCalls = 0;
  const store = {
    revision: 7,
    create: () => null,
    task: () => null,
    list: () => { throw new Error("board snapshot must not be built"); },
    move: () => null,
    markStarted: () => null,
    orderedColumnIds: () => { throw new Error("board layout must not be built"); },
    moveColumn: () => null,
    reassignWorkspace: () => 0,
    notesComment: () => { throw new Error("board layout must not be built"); },
    setNotesComment: () => "",
  };
  const service = new TaskBoardService({
    store,
    workspaceCatalog: {
      revision: 11,
      hierarchy: () => {
        hierarchyCalls += 1;
        return [];
      },
    },
  });

  assert.equal(service.snapshotRevision, "7:11");
  assert.equal(hierarchyCalls, 0);
});

test("Spark correction and confident Workspace suggestion place a Task automatically", async (t) => {
  const service = await fixture(t, async () => ({
    title: "Исправить дашборд",
    description: "Нужно исправить дашборд Agent Hub.",
    correctedText: "Исправить дашборд Agent Hub",
    category: "task",
    workspaceId: "agent-hub",
    confidence: 0.94,
    reason: "Упомянут Agent Hub",
  }));
  const created = service.create({ text: "исправить дашборд агент хаб", source: "telegram" });
  await service.waitForTriage();
  const task = service.task(created.id);
  assert.equal(task.correctedText, "Исправить дашборд Agent Hub");
  assert.equal(task.title, "Исправить дашборд Agent Hub");
  assert.equal(task.description, "");
  assert.equal(task.bucket, "workspace");
  assert.equal(task.workspaceId, "agent-hub");
});

test("uncertain Spark suggestion leaves a Task in the backlog", async (t) => {
  const service = await fixture(t, async () => ({
    title: "Что-то проверить",
    description: "",
    correctedText: "Что-то проверить",
    category: "unknown",
    workspaceId: null,
    confidence: 0.31,
    reason: "Не хватает контекста",
  }));
  const created = service.create({ text: "чтото проверить", source: "telegram" });
  await service.waitForTriage();
  const task = service.task(created.id);
  assert.equal(task.bucket, "backlog");
  assert.equal(task.triageStatus, "completed");
});

test("Telegram bundle rules are passed to Spark outside the Task text", async (t) => {
  let classifierInput;
  const service = await fixture(t, async (input) => {
    classifierInput = input;
    return {
      title: "Исправить дату документа",
      description: "Пересланный контекст и уточнение пользователя.",
      correctedText: input.text,
      category: "task",
      workspaceId: null,
      confidence: 0.4,
      reason: "Workspace не определён",
    };
  });
  const text = "--- Сообщение 1 · Переслано · Клиент ---\nИсправить дату документа";
  service.create({ text, source: "telegram", sourceDetails: { bundleId: "bundle-1" } });
  await service.waitForTriage();
  assert.equal(classifierInput.text, text);
  assert.equal(classifierInput.inputKind, "telegram-forward-bundle");
  assert.doesNotMatch(classifierInput.text, /Ниже пакет сообщений/u);
});

test("a following forward retriages the preceding Telegram Task instead of creating another", async (t) => {
  const classifierInputs = [];
  const service = await fixture(t, async (input) => {
    classifierInputs.push(input.text);
    return {
      title: input.text.includes("Переслано") ? "КЭМЗ: изменить механизм отчёта" : "КЭМЗ",
      description: "",
      correctedText: input.text,
      category: "task",
      workspaceId: null,
      confidence: 0.4,
      reason: "Workspace не определён",
    };
  });
  const task = service.create({
    text: "КЭМЗ",
    source: "telegram",
    sourceDetails: { updateId: 798, chatId: 42, userId: 42, messageId: 18 },
  });
  await service.waitForTriage();
  const mergedText = "--- Сообщение 1 · Вы ---\nКЭМЗ\n\n--- Сообщение 2 · Переслано · Иван ---\nКонтекст";
  const merged = service.mergeSourceMessage({
    source: "telegram",
    chatId: 42,
    userId: 42,
    messageId: 18,
    text: mergedText,
    sourceDetails: { bundleId: "bundle-1", chatId: 42, userId: 42 },
  });
  assert.equal(merged.id, task.id);
  await service.waitForTriage();
  assert.equal(service.task(task.id).title, "КЭМЗ: изменить механизм отчёта");
  assert.deepEqual(classifierInputs, ["КЭМЗ", mergedText]);
  assert.equal(service.snapshot().length, 1);
});

test("a Telegram text reply retriages the same Task with the clarification", async (t) => {
  const classifierInputs = [];
  const service = await fixture(t, async (input) => {
    classifierInputs.push(input.text);
    return {
      title: input.text.includes("надо сдать") ? "Экзамены: надо сдать" : "Экзамены",
      description: "",
      correctedText: input.text,
      category: "task",
      workspaceId: null,
      confidence: 0.4,
      reason: "Workspace не определён",
    };
  });
  const task = service.create({
    text: "ЭКЗАМЕНЫ",
    source: "telegram",
    sourceDetails: { chatId: 42, userId: 42, messageId: 2 },
  });
  await service.waitForTriage();
  const clarified = service.appendSourceMessage({
    source: "telegram",
    chatId: 42,
    userId: 42,
    messageId: 2,
    text: "надо сдать..",
    sourceDetails: { chatId: 42, userId: 42, messageId: 3, replyToMessageId: 2 },
  });
  await service.waitForTriage();

  assert.equal(clarified.id, task.id);
  assert.equal(service.task(task.id).title, "Экзамены: надо сдать");
  assert.equal(classifierInputs.length, 2);
  assert.match(classifierInputs[1], /ЭКЗАМЕНЫ[\s\S]*надо сдать/u);
  assert.equal(service.snapshot().length, 1);
});

test("disabled Spark leaves new Tasks idle and clears recovered triage", () => {
  let disabled = 0;
  const created = [];
  const service = new TaskBoardService({
    store: {
      create: (value) => {
        created.push(value);
        return { id: "task-disabled", triageStatus: value.triageStatus };
      },
      task: () => null,
      list: () => [],
      move: () => null,
      markStarted: () => null,
      orderedColumnIds: (ids) => [...ids, "notes"],
      moveColumn: () => null,
      reassignWorkspace: () => 0,
      notesComment: () => "",
      setNotesComment: () => "",
      disablePendingTriage: () => { disabled += 1; },
    },
    workspaceCatalog: { hierarchy: () => [] },
    autoPlaceConfidence: 0,
  });
  const task = service.create({ text: "Без классификации" });
  service.recoverPendingTriage();
  assert.equal(task.triageStatus, "disabled");
  assert.equal(created[0].triageStatus, "disabled");
  assert.equal(service.autoPlaceConfidence, 0);
  assert.equal(disabled, 1);
});

test("manual dashboard creation never starts Spark triage", async (t) => {
  let classifyCalls = 0;
  const service = await fixture(t, async () => { classifyCalls += 1; return {}; });
  const task = service.create({ text: "Создано вручную", source: "hub" });
  await service.waitForTriage();
  assert.equal(task.triageStatus, "disabled");
  assert.equal(classifyCalls, 0);
});

test("Dashboard snapshot exposes attachment descriptors without local paths", async (t) => {
  const service = await fixture(t);
  service.create({
    text: "Проверить скриншот",
    source: "hub",
    sourceDetails: { attachments: ["D:/runtime/attachments/screenshot.jpg"] },
  });
  const [task] = service.snapshot();
  assert.deepEqual(task.attachments, [{
    id: "screenshot.jpg",
    name: "screenshot.jpg",
    type: "image/jpeg",
    isImage: true,
  }]);
  assert.equal(Object.hasOwn(task.sourceDetails, "attachments"), false);
  assert.doesNotMatch(JSON.stringify(task), /D:\/runtime/u);
});

test("personal bug report capture bypasses Spark and resolves Agent HUB by name", async (t) => {
  let classifyCalls = 0;
  const service = await fixture(t, async () => { classifyCalls += 1; return {}; });
  const task = new BugReportTaskCapture({
    taskBoard: service,
    workspaceName: "Agent HUB",
  }).capture({
    id: "12345678-1234-4234-8234-123456789abc",
    folder: "AgentHub/Bugs/bug-12345678-1234-4234-8234-123456789abc",
    screenshots: 1,
  }, { text: "Не открывается карточка" });
  await service.waitForTriage();

  assert.equal(task.bucket, "workspace");
  assert.equal(task.workspaceId, "agent-hub");
  assert.equal(task.triageStatus, "disabled");
  assert.equal(classifyCalls, 0);
});

test("dashboard updates a Task title and description", async (t) => {
  const service = await fixture(t);
  const task = service.create({ text: "Черновик", source: "hub" });
  const updated = service.update({
    id: task.id,
    title: "Готовый заголовок",
    description: "Подробное описание",
  });
  assert.equal(updated.title, "Готовый заголовок");
  assert.equal(updated.description, "Подробное описание");
});

test("dashboard keeps Other last while the remaining columns stay movable", async (t) => {
  const service = await fixture(t);
  assert.deepEqual(service.layout().columnOrder, ["workspace:agent-hub", "notes", "workspace:other"]);
  assert.deepEqual(service.workspaces().map((workspace) => workspace.name), ["Agent Hub", "Other"]);
  service.moveColumn({ columnId: "notes", beforeColumnId: "workspace:agent-hub" });
  assert.deepEqual(service.layout().columnOrder, ["notes", "workspace:agent-hub", "workspace:other"]);
  service.moveColumn({ columnId: "workspace:agent-hub" });
  assert.deepEqual(service.layout().columnOrder, ["notes", "workspace:agent-hub", "workspace:other"]);
  service.workspaceCatalog.hierarchy().push({ id: "new", name: "New", systemKey: null, streams: [] });
  assert.deepEqual(
    service.layout().columnOrder,
    ["notes", "workspace:agent-hub", "workspace:new", "workspace:other"],
  );
  assert.throws(
    () => service.moveColumn({ columnId: "workspace:other", beforeColumnId: "workspace:agent-hub" }),
    /всегда остаётся последним/u,
  );
});
