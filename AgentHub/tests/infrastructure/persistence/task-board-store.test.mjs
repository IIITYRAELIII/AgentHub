import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { taskBranchName } from "../../../src/domain/task-git-reference.mjs";
import { taskReleasePlanRevision } from "../../../src/domain/task-release-snapshot.mjs";
import { TaskBoardStore } from "../../../src/infrastructure/persistence/task-board-store.mjs";

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-task-board-"));
  let sequence = 0;
  const store = new TaskBoardStore({
    databaseFile: path.join(directory, "journal.sqlite"),
    now: () => 1_700_000_000_000 + sequence,
    idFactory: () => `task-${++sequence}`,
  });
  t.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  return store;
}

test("Task store revision changes on writes but not reads", async (t) => {
  const store = await fixture(t);
  const initial = store.revision;

  store.list();
  assert.equal(store.revision, initial);
  store.create({ text: "Revision boundary" });
  assert.equal(store.revision, initial + 1);
  store.list();
  assert.equal(store.revision, initial + 1);
});

test("status integration records a Git result without fabricating a provider turn", async (t) => {
  const store = await fixture(t);
  const task = store.create({ text: "Integrate Task status" });
  const projectRoot = path.resolve("D:/repo");
  const resultCommit = "b".repeat(40);

  const recorded = store.recordTaskGitReference({
    taskId: task.id,
    projectRoot,
    branch: taskBranchName(task.id, projectRoot),
    resultSnapshot: { repoRoot: projectRoot, tree: resultCommit },
  });

  assert.deepEqual(recorded.gitReferences, [{
    projectRoot,
    branch: taskBranchName(task.id, projectRoot),
    resultCommit,
  }]);
  assert.deepEqual(recorded.workLog, []);
});

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

test("restarting a closed Task clears its completion timestamp", async (t) => {
  const store = await fixture(t);
  const task = store.create({ text: "Исправить запуск" });
  const completed = store.complete(task.id);
  const restarted = store.markStarted(task.id, { workspaceId: "workspace-1", streamId: "stream-1" });

  assert.equal(completed.status, "done");
  assert.equal(completed.workflowStatus, "new");
  assert.notEqual(completed.completedAt, null);
  assert.equal(restarted.status, "started");
  assert.equal(restarted.workflowStatus, "in_progress");
  assert.equal(restarted.completedAt, null);
});

test("generic Task statuses remain directly editable", async (t) => {
  const store = await fixture(t);
  const created = store.create({ text: "Провести задачу по статусам" });
  assert.equal(created.workflowStatus, "new");

  const started = store.markStarted(created.id, { workspaceId: "workspace-1", streamId: "stream-1" });
  assert.equal(started.workflowStatus, "in_progress");
  assert.equal(store.setWorkflowStatus(created.id, "testing").workflowStatus, "testing");
  assert.equal(
    store.setWorkflowStatus(created.id, "awaiting_implementation").workflowStatus,
    "awaiting_implementation",
  );

  const completed = store.complete(created.id);
  assert.equal(completed.status, "done");
  assert.equal(completed.workflowStatus, "awaiting_implementation");
  assert.notEqual(completed.completedAt, null);

  const reopened = store.setWorkflowStatus(created.id, "testing");
  assert.equal(reopened.status, "started");
  assert.equal(reopened.workflowStatus, "testing");
  assert.equal(reopened.completedAt, null);
  assert.throws(() => store.setWorkflowStatus(created.id, "unknown"), /Неизвестный статус/u);
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
  reopened.close();
  assert.deepEqual(
    tasks.filter((task) => task.workspaceId === "workspace-1").map((task) => task.id),
    [third.id, first.id],
  );
  assert.deepEqual(tasks.filter((task) => task.bucket === "notes").map((task) => task.id), [second.id]);
});

test("Workspace and Notes column order persists after reordering", async (t) => {
  const store = await fixture(t);
  assert.equal(store.notesComment(), "");
  assert.deepEqual(store.orderedColumnIds(["one", "two", "three"]), ["one", "two", "three", "notes"]);
  store.moveColumn(["one", "two", "three"], { columnId: "notes", beforeColumnId: "two" });
  store.setNotesComment("Книги и фильмы");

  const reopened = new TaskBoardStore({ databaseFile: store.databaseFile });
  const columnIds = reopened.orderedColumnIds(["one", "two", "three"]);
  const notesComment = reopened.notesComment();
  reopened.close();
  assert.deepEqual(columnIds, ["one", "notes", "two", "three"]);
  assert.equal(notesComment, "Книги и фильмы");
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

test("repeated Task claim backfills a baseline captured after the first claim", async (t) => {
  const store = await fixture(t);
  const projectRoot = path.resolve("D:/repo");
  const task = store.create({ text: "Claim baseline" });
  store.move(task.id, { bucket: "workspace", workspaceId: "workspace-1" });
  const claim = {
    workspaceId: "workspace-1", streamId: "stream-1",
    provider: "codex", threadId: "thread-1", turnId: "turn-1",
  };
  store.claim(task.id, claim);
  store.claim(task.id, {
    ...claim,
    gitBaseline: { repoRoot: projectRoot, tree: "a".repeat(40) },
  });

  assert.deepEqual(store.claimedTaskForTurn(claim).gitBaseline, {
    repoRoot: projectRoot,
    tree: "a".repeat(40),
  });
});

test("terminal Task evidence backfills a claim baseline captured after claim", async (t) => {
  const store = await fixture(t);
  const projectRoot = path.resolve("D:/repo");
  const task = store.create({ text: "Interrupted evidence" });
  store.move(task.id, { bucket: "workspace", workspaceId: "workspace-1" });
  store.claim(task.id, {
    workspaceId: "workspace-1", streamId: "stream-1",
    provider: "codex", threadId: "thread-1", turnId: "turn-1",
  });

  const recorded = store.recordTaskTurn({
    taskId: task.id, provider: "codex", threadId: "thread-1", turnId: "turn-1",
    projectRoot, summary: "Interrupted after edit", status: "interrupted",
    changedFiles: [{ projectRoot, path: "src/app.mjs", operation: "modified", turnId: "turn-1" }],
    gitBaseline: { repoRoot: projectRoot, tree: "a".repeat(40) },
    resultSnapshot: { repoRoot: projectRoot, tree: "b".repeat(40) },
  });

  assert.equal(recorded.workLog[0].changedFiles.length, 1);
  assert.deepEqual(recorded.gitReferences, [{
    projectRoot,
    branch: taskBranchName(task.id, projectRoot),
    resultCommit: "b".repeat(40),
  }]);
});

test("Await Tasks expose only their immutable Git references to the release planner", async (t) => {
  const store = await fixture(t);
  const projectRoot = path.resolve("D:/repo");
  const ready = store.create({ text: "Ready Task" });
  const blocked = store.create({ text: "Blocked Task" });
  for (const task of [ready, blocked]) {
    store.move(task.id, { bucket: "workspace", workspaceId: "workspace-1" });
  }
  store.claim(ready.id, {
    workspaceId: "workspace-1", streamId: "stream-1",
    provider: "codex", threadId: "thread-1", turnId: "turn-1",
    gitBaseline: { repoRoot: projectRoot, tree: "a".repeat(40) },
  });
  store.recordTaskTurn({
    taskId: ready.id, provider: "codex", threadId: "thread-1", turnId: "turn-1",
    projectRoot, status: "completed",
    changedFiles: [{ projectRoot, path: "src/app.mjs", operation: "modified" }],
    resultSnapshot: { repoRoot: projectRoot, tree: "b".repeat(40) },
  });
  store.setWorkflowStatus(ready.id, "awaiting_implementation");
  store.setWorkflowStatus(blocked.id, "awaiting_implementation");

  const releaseTasks = store.releaseTasks("workspace-1");
  assert.equal(releaseTasks.find((task) => task.id === ready.id).gitReferences.length, 1);
  assert.deepEqual(releaseTasks.find((task) => task.id === blocked.id).gitReferences, []);
});

test("a new Await request clears stale evidence until the Task branch is integrated again", async (t) => {
  const store = await fixture(t);
  const projectRoot = path.resolve("D:/repo");
  const task = store.create({ text: "Retry integration" });
  const identity = {
    workspaceId: "workspace-1", streamId: "stream-1",
    provider: "codex", threadId: "thread-1", turnId: "turn-1",
  };
  store.move(task.id, { bucket: "workspace", workspaceId: "workspace-1" });
  store.claim(task.id, {
    ...identity,
    gitBaseline: { repoRoot: projectRoot, tree: "a".repeat(40) },
  });
  store.recordTaskTurn({
    taskId: task.id, provider: identity.provider, threadId: identity.threadId, turnId: identity.turnId,
    projectRoot, status: "completed",
    changedFiles: [{ projectRoot, path: "src/app.mjs", operation: "modified" }],
    resultSnapshot: { repoRoot: projectRoot, tree: "b".repeat(40) },
  });
  store.setWorkflowStatus(task.id, "awaiting_implementation");
  assert.equal(store.task(task.id).gitReferences.length, 1);

  store.requestWorkflowStatus(task.id, {
    status: "awaiting_implementation",
    provider: identity.provider,
    threadId: identity.threadId,
    turnId: identity.turnId,
  });

  assert.deepEqual(store.task(task.id).gitReferences, []);
});

test("rolling a Task back clears its pending awaiting intent", async (t) => {
  const store = await fixture(t);
  const task = store.create({ text: "Rollback awaiting" });
  const identity = {
    workspaceId: "workspace-1", streamId: "stream-1",
    provider: "codex", threadId: "thread-1", turnId: "turn-1",
  };
  store.move(task.id, { bucket: "workspace", workspaceId: "workspace-1" });
  store.claim(task.id, identity);
  assert.equal(store.requestWorkflowStatus(task.id, {
    status: "awaiting_implementation",
    provider: identity.provider,
    threadId: identity.threadId,
    turnId: identity.turnId,
  }).workflowStatus, "awaiting_implementation");
  assert.equal(store.claimedTaskForTurn(identity).requestedWorkflowStatus, "awaiting_implementation");

  assert.equal(store.setWorkflowStatus(task.id, "testing").workflowStatus, "testing");
  assert.equal(store.claimedTaskForTurn(identity).requestedWorkflowStatus, null);
});

test("recording evidence never overrides a user-selected workflow status", async (t) => {
  const store = await fixture(t);
  const projectRoot = path.resolve("D:/repo");
  const task = store.create({ text: "Preserve status" });
  const identity = {
    workspaceId: "workspace-1", streamId: "stream-1",
    provider: "codex", threadId: "thread-1", turnId: "turn-1",
  };
  store.move(task.id, { bucket: "workspace", workspaceId: "workspace-1" });
  store.claim(task.id, {
    ...identity,
    gitBaseline: { repoRoot: projectRoot, tree: "a".repeat(40) },
  });
  store.setWorkflowStatus(task.id, "done");
  const recorded = store.recordTaskTurn({
    taskId: task.id,
    provider: identity.provider,
    threadId: identity.threadId,
    turnId: identity.turnId,
    projectRoot,
    summary: "Evidence captured",
    changedFiles: [{ projectRoot, path: "src/app.mjs", operation: "modified" }],
    resultSnapshot: { repoRoot: projectRoot, tree: "b".repeat(40) },
  });

  assert.equal(recorded.workflowStatus, "done");
  assert.equal(recorded.workLog[0].changedFiles.length, 1);
  assert.equal(recorded.workLog.length, 1);
  assert.equal(recorded.gitReferences.length, 1);
});

test("legacy Task evidence tables migrate atomically to one Git reference", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-task-evidence-migration-"));
  const databaseFile = path.join(directory, "journal.sqlite");
  t.after(() => rm(directory, { recursive: true, force: true }));
  const initial = new TaskBoardStore({ databaseFile });
  const task = initial.create({ text: "Migrate evidence" });
  initial.close();

  const projectRoot = path.resolve("D:/repo");
  const database = new DatabaseSync(databaseFile);
  database.exec(`
    CREATE TABLE hub_task_repository_revisions (
      task_id TEXT NOT NULL, project_root TEXT NOT NULL,
      baseline_revision TEXT NOT NULL, result_revision TEXT NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      PRIMARY KEY (task_id, project_root)
    ) WITHOUT ROWID;
    CREATE TABLE hub_task_changed_files (
      task_id TEXT NOT NULL, project_root TEXT NOT NULL, file_path TEXT NOT NULL,
      operation TEXT NOT NULL, turn_id TEXT, updated_at_ms INTEGER NOT NULL,
      PRIMARY KEY (task_id, project_root, file_path)
    ) WITHOUT ROWID;
  `);
  database.prepare("INSERT INTO hub_task_repository_revisions VALUES (?, ?, ?, ?, ?)").run(
    task.id, projectRoot, "a".repeat(40), "b".repeat(40), 123,
  );
  database.prepare("INSERT INTO hub_task_changed_files VALUES (?, ?, ?, 'modified', NULL, ?)").run(
    task.id, projectRoot, "src/app.mjs", 123,
  );
  database.close();

  const migrated = new TaskBoardStore({ databaseFile });
  assert.deepEqual(migrated.task(task.id).gitReferences, [{
    projectRoot,
    branch: taskBranchName(task.id, projectRoot),
    resultCommit: "b".repeat(40),
  }]);
  migrated.close();

  const inspected = new DatabaseSync(databaseFile);
  assert.equal(inspected.prepare(`
    SELECT COUNT(*) AS value FROM sqlite_master
    WHERE type = 'table' AND name IN ('hub_task_repository_revisions', 'hub_task_changed_files')
  `).get().value, 0);
  const history = inspected.prepare(`
    SELECT source_kind, payload_json, payload_sha256 FROM hub_release_registry_history
    WHERE source_kind IN ('task-repository-revision-v3', 'task-changed-file-v3')
    ORDER BY source_kind
  `).all();
  assert.equal(history.length, 2);
  for (const row of history) {
    assert.equal(row.payload_sha256, createHash("sha256").update(row.payload_json, "utf8").digest("hex"));
  }
  inspected.close();
});

test("release completion CAS-checks the exact Task Git reference", async (t) => {
  const store = await fixture(t);
  const projectRoot = path.resolve("D:/repo");
  const task = store.create({ text: "Publish commit" });
  const identity = {
    workspaceId: "workspace-1", streamId: "stream-1",
    provider: "codex", threadId: "thread-1", turnId: "turn-1",
  };
  store.move(task.id, { bucket: "workspace", workspaceId: identity.workspaceId });
  store.claim(task.id, identity);
  store.recordTaskTurn({
    taskId: task.id,
    provider: identity.provider,
    threadId: identity.threadId,
    turnId: identity.turnId,
    projectRoot,
    changedFiles: [{ projectRoot, path: "src/app.mjs", operation: "modified" }],
    resultSnapshot: { repoRoot: projectRoot, tree: "b".repeat(40) },
  });
  store.setWorkflowStatus(task.id, "awaiting_implementation");
  const candidate = store.task(task.id);
  const plan = {
    revision: taskReleasePlanRevision(identity.workspaceId, [candidate]),
    candidates: [{
      ...candidate,
      changedFiles: [{ projectRoot, path: "src/app.mjs", operation: "modified" }],
    }],
  };

  const result = store.completeRelease(identity.workspaceId, {
    expectedPlanRevision: plan.revision,
    plan,
    verificationEvidence: { publishedRevision: "c".repeat(40) },
  });
  assert.deepEqual(result.released[0].gitReferences, candidate.gitReferences);
  assert.equal(store.task(task.id).workflowStatus, "done");
});

function createLegacyReleaseSchema(database) {
  database.exec(`
    CREATE TABLE hub_release_changes (
      id TEXT PRIMARY KEY, workspace_id TEXT, stream_id TEXT, provider TEXT,
      provider_thread_id TEXT, turn_id TEXT, project_root TEXT, summary TEXT,
      status TEXT, files_json TEXT, observed_files_json TEXT, revision INTEGER, created_at_ms INTEGER
    );
    CREATE TABLE hub_release_batches (id TEXT PRIMARY KEY, status TEXT, created_at_ms INTEGER);
    CREATE TABLE hub_release_change_sets (
      id TEXT PRIMARY KEY, task_id TEXT, workspace_id TEXT, owner_stream_id TEXT,
      title TEXT, status TEXT, revision INTEGER, manifest_hash TEXT,
      repository_evidence_json TEXT, created_at_ms INTEGER
    );
    CREATE TABLE hub_release_turn_observations (
      id TEXT PRIMARY KEY, change_set_id TEXT, legacy_release_change_id TEXT,
      provider TEXT, provider_thread_id TEXT, turn_id TEXT, project_root TEXT,
      summary TEXT, files_json TEXT, created_at_ms INTEGER
    );
    CREATE TABLE hub_release_change_set_files (
      change_set_id TEXT, project_root TEXT, file_path TEXT, operation TEXT,
      base_blob TEXT, result_blob TEXT, patch_hash TEXT,
      PRIMARY KEY (change_set_id, project_root, file_path)
    );
    CREATE TABLE hub_release_change_set_bindings (stream_id TEXT PRIMARY KEY, change_set_id TEXT);
    CREATE TABLE hub_release_change_set_events (
      id TEXT PRIMARY KEY, change_set_id TEXT, event_type TEXT, payload_json TEXT, created_at_ms INTEGER
    );
  `);
}

function seedProductionShapeLegacyRelease(database) {
  createLegacyReleaseSchema(database);
  const insertChangeSet = database.prepare(`
    INSERT INTO hub_release_change_sets VALUES (?, NULL, 'workspace-1', ?, ?, ?, 2, ?, ?, ?)
  `);
  for (let index = 0; index < 11; index += 1) {
    const verified = index < 2;
    insertChangeSet.run(
      `changeset-${index}`, `stream-${index}`, `ChangeSet ${index}`,
      verified ? "ready" : "draft",
      verified ? String(index + 1).repeat(64).slice(0, 64) : "",
      verified ? JSON.stringify([{
        projectRoot: "D:/repo", baseRevision: "a".repeat(40), resultRevision: "b".repeat(40),
      }]) : "[]",
      100 + index,
    );
  }
  const insertLegacy = database.prepare(`
    INSERT INTO hub_release_changes VALUES (?, 'workspace-1', ?, 'codex', ?, ?, 'D:/repo', ?, ?, ?, ?, 1, ?)
  `);
  const insertObservation = database.prepare(`
    INSERT INTO hub_release_turn_observations VALUES (?, ?, ?, 'codex', ?, ?, 'D:/repo', ?, ?, ?)
  `);
  for (let index = 0; index < 13; index += 1) {
    const files = index < 3 ? JSON.stringify([`legacy/path-${index}.mjs`]) : "[]";
    insertLegacy.run(
      `legacy-${index}`, `stream-${index % 7}`, `thread-${index}`, `turn-${index}`,
      `Legacy ${index}`, index < 3 ? "ready" : "draft", files, files, 200 + index,
    );
    insertObservation.run(
      `observation-${index}`, `changeset-${index % 7}`, `legacy-${index}`,
      `thread-${index}`, `turn-${index}`, `Observed ${index}`,
      JSON.stringify([`observed/path-${index}.mjs`]), 300 + index,
    );
  }
  const insertFile = database.prepare("INSERT INTO hub_release_change_set_files VALUES (?, 'D:/repo', ?, ?, ?, ?, ?)");
  for (let index = 0; index < 2; index += 1) {
    insertFile.run(
      `changeset-${index}`, `src/verified-${index}.mjs`, "modified",
      "c".repeat(40), "d".repeat(40), "e".repeat(64),
    );
    database.prepare("INSERT INTO hub_release_change_set_events VALUES (?, ?, 'changeset.frozen', ?, ?)").run(
      `event-${index}`, `changeset-${index}`,
      JSON.stringify({ verification: { verifier: { name: "git", version: "1" } } }), 400 + index,
    );
  }
  insertFile.run("changeset-2", "src/observed-only.mjs", "observed", "", "", "");
  database.prepare("INSERT INTO hub_release_change_set_bindings VALUES ('stream-0', 'changeset-0')").run();
  database.prepare("INSERT INTO hub_release_batches VALUES ('batch-1', 'released', 500)").run();
}

test("Legacy cutover maps production union to Tasks and retains verified immutable history", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-task-release-migration-"));
  const databaseFile = path.join(directory, "journal.sqlite");
  t.after(() => rm(directory, { recursive: true, force: true }));
  const database = new DatabaseSync(databaseFile);
  seedProductionShapeLegacyRelease(database);
  database.close();

  const store = new TaskBoardStore({ databaseFile });
  const migrated = store.list().filter((task) => task.source === "release-registry-migration");
  assert.equal(migrated.length, 11);
  assert.equal(migrated.filter((task) => task.workflowStatus === "awaiting_implementation").length, 2);
  assert.equal(migrated.filter((task) => task.workflowStatus === "in_progress").length, 9);
  assert.deepEqual(
    migrated.find((task) => task.sourceKey === "release-migration:changeset:changeset-2").gitReferences,
    [],
  );
  assert.equal(
    migrated.find((task) => task.sourceKey === "release-migration:changeset:changeset-0").workLog.length,
    2,
  );
  store.close();

  const inspected = new DatabaseSync(databaseFile);
  assert.equal(inspected.prepare(`
    SELECT COUNT(*) AS value FROM sqlite_master
    WHERE type = 'table' AND name IN (
      'hub_release_changes', 'hub_release_batches', 'hub_release_change_sets',
      'hub_release_turn_observations', 'hub_release_change_set_files',
      'hub_release_change_set_bindings', 'hub_release_change_set_events',
      'hub_task_release_state', 'hub_task_release_revisions',
      'hub_task_release_revision_files', 'hub_task_release_completions'
    )
  `).get().value, 0);
  const history = inspected.prepare(`
    SELECT source_kind, source_id, payload_json, payload_sha256
    FROM hub_release_registry_history ORDER BY source_kind, source_id
  `).all();
  assert.equal(history.length, 59);
  for (const row of history) {
    assert.equal(
      row.payload_sha256,
      createHash("sha256").update(row.payload_json, "utf8").digest("hex"),
    );
  }
  inspected.close();

  const reopened = new TaskBoardStore({ databaseFile });
  assert.equal(reopened.list().filter((task) => task.source === "release-registry-migration").length, 11);
  reopened.close();

  const reinspected = new DatabaseSync(databaseFile);
  assert.equal(reinspected.prepare(`
    SELECT COUNT(*) AS value FROM sqlite_master
    WHERE type = 'table' AND name IN (
      'hub_release_changes', 'hub_release_batches', 'hub_release_change_sets',
      'hub_release_turn_observations', 'hub_release_change_set_files',
      'hub_release_change_set_bindings', 'hub_release_change_set_events',
      'hub_task_release_state', 'hub_task_release_revisions',
      'hub_task_release_revision_files', 'hub_task_release_completions'
    )
  `).get().value, 0);
  assert.throws(
    () => reinspected.prepare("DELETE FROM hub_release_registry_history").run(),
    /release history is immutable/,
  );
  reinspected.close();
});

test("Legacy archive checksum mismatch rolls back Task import", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-task-release-rollback-"));
  const databaseFile = path.join(directory, "journal.sqlite");
  t.after(() => rm(directory, { recursive: true, force: true }));
  const database = new DatabaseSync(databaseFile);
  seedProductionShapeLegacyRelease(database);
  database.exec(`
    CREATE TABLE hub_release_registry_history (
      source_kind TEXT NOT NULL, source_id TEXT NOT NULL, status TEXT NOT NULL,
      payload_json TEXT NOT NULL, payload_sha256 TEXT NOT NULL, migrated_task_id TEXT,
      archived_at_ms INTEGER NOT NULL, PRIMARY KEY (source_kind, source_id)
    ) WITHOUT ROWID;
  `);
  database.prepare("INSERT INTO hub_release_registry_history VALUES ('legacy', 'legacy-0', 'draft', '{}', ?, NULL, 1)")
    .run("0".repeat(64));
  database.close();

  assert.throws(() => new TaskBoardStore({ databaseFile }), /archive checksum mismatch/u);
  const inspected = new DatabaseSync(databaseFile);
  assert.equal(inspected.prepare("SELECT COUNT(*) AS value FROM hub_board_tasks").get().value, 0);
  assert.equal(inspected.prepare("SELECT COUNT(*) AS value FROM hub_board_settings WHERE key = 'task_release_registry_migrated_v1'").get().value, 0);
  inspected.close();
});
