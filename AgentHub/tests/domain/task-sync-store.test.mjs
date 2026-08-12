import assert from "node:assert/strict";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { TASK_EXECUTION_OWNERS } from "../../src/domain/task-execution-owner.mjs";
import { LocalTaskSyncStore } from "../../src/infrastructure/persistence/task-sync-store.mjs";

const task = {
  provider: "codex",
  threadId: "019f70ed-d8e8-7b21-bcd1-b6f57bcdf013",
  projectRoot: "C:\\Projects\\Main",
  projectName: "Main",
  title: "FB Фаровон обмен1",
};

async function storeFile() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "telegram-task-sync-"));
  return path.join(directory, "task-sync.json");
}

test("local task sync persists catalog, runtime owner, status and history", async () => {
  const filePath = await storeFile();
  const store = new LocalTaskSyncStore({ filePath });
  await store.load();
  store.recordCatalog([{
    ...task,
    running: true,
    executionOwner: TASK_EXECUTION_OWNERS.VSCODE,
    turnId: "turn-vsc",
    updatedAtMs: 100,
    lastActivityAtMs: 1_000,
  }], 1_000);
  store.recordHistory(task, [{
    id: "turn-vsc",
    prompt: "Продолжай",
    answer: "Выполняю",
    status: "inProgress",
    active: true,
    completed: false,
  }], {
    active: true,
    turnId: "turn-vsc",
    executionOwner: TASK_EXECUTION_OWNERS.VSCODE,
    activityAtMs: 1_000,
    stage: "Изменяются файлы",
    answer: "Выполняю",
  }, 1_000);
  await store.save();

  const restored = new LocalTaskSyncStore({ filePath });
  await restored.load();
  assert.deepEqual(restored.catalog({ nowMs: 2_000 }), [{
    ...task,
    model: null,
    updatedAtMs: 100,
    running: true,
    executionOwner: TASK_EXECUTION_OWNERS.VSCODE,
    turnId: "turn-vsc",
    lastActivityAtMs: 1_000,
  }]);
  assert.equal(restored.history(task)[0].answer, "Выполняю");
  assert.equal(restored.snapshot(task).stage, "Изменяются файлы");
});

test("local task sync restores the latest model from the journal projection", async () => {
  const filePath = await storeFile();
  const databaseFile = path.join(path.dirname(filePath), "journal.sqlite");
  let store = new LocalTaskSyncStore({ filePath, databaseFile });
  await store.load();
  store.recordCatalog([{ ...task, updatedAtMs: 100 }], 100);
  store.close();

  const database = new DatabaseSync(databaseFile);
  database.exec(`
    CREATE TABLE IF NOT EXISTS journal_records (
      provider TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      project_root TEXT NOT NULL,
      task_thread_id TEXT NOT NULL,
      completed_at_ms INTEGER NOT NULL,
      record_json TEXT NOT NULL,
      PRIMARY KEY (provider, thread_id, turn_id)
    ) WITHOUT ROWID
  `);
  database.prepare(`
    INSERT INTO journal_records
      (provider, thread_id, turn_id, project_root, task_thread_id, completed_at_ms, record_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    task.provider,
    task.threadId,
    "turn-old",
    task.projectRoot,
    task.threadId,
    1_000,
    JSON.stringify({ model: "gpt-5.6-sol" }),
  );
  database.close();

  store = new LocalTaskSyncStore({ filePath, databaseFile });
  await store.load();
  assert.equal(store.catalog()[0].model, "gpt-5.6-sol");
  store.close();
});

test("local task sync preserves durable message metadata and attachments", async () => {
  const filePath = await storeFile();
  const store = new LocalTaskSyncStore({ filePath });
  await store.load();
  store.recordHistory(task, [{
    id: "turn-with-image",
    prompt: "Посмотри скриншот",
    answer: "Вижу",
    status: "completed",
    completed: true,
    promptAnnotations: [{ text: "Цитата из ответа", annotation: "Почему так?" }],
    promptRequest: "Почему так?",
    startedAt: "2026-07-31T12:00:00.000Z",
    completedAt: "2026-07-31T12:01:00.000Z",
    attachments: [{ id: "screen.png", name: "screen.png", type: "image/png" }],
    activities: [{ id: "tool-1", type: "tool", label: "Проверка", status: "completed" }],
    activityGroups: [{
      id: "reasoning-1",
      reasoning: "Проверяю входные данные.",
      activities: [{ id: "tool-1", type: "tool", label: "Проверка", status: "completed" }],
    }],
    messages: [{
      itemId: "user-1",
      clientUserMessageId: "client-1",
      role: "user",
      text: "Посмотри скриншот",
      author: "Agent Hub - Architect",
      responseAnnotations: [{ text: "Цитата из ответа", annotation: "Почему так?" }],
      responseAnnotationRequest: "Почему так?",
      time: "2026-07-31T12:00:00.000Z",
      attachments: [{ id: "screen.png", name: "screen.png", type: "image/png" }],
    }],
  }]);
  await store.save();

  const restored = new LocalTaskSyncStore({ filePath });
  await restored.load();
  const [entry] = restored.history(task);
  assert.equal(entry.startedAt, "2026-07-31T12:00:00.000Z");
  assert.equal(entry.completedAt, "2026-07-31T12:01:00.000Z");
  assert.equal(entry.messages[0].clientUserMessageId, "client-1");
  assert.equal(entry.messages[0].time, "2026-07-31T12:00:00.000Z");
  assert.equal(entry.messages[0].author, "Agent Hub - Architect");
  assert.deepEqual(entry.promptAnnotations, [
    { text: "Цитата из ответа", annotation: "Почему так?" },
  ]);
  assert.equal(entry.promptRequest, "Почему так?");
  assert.deepEqual(entry.messages[0].responseAnnotations, [
    { text: "Цитата из ответа", annotation: "Почему так?" },
  ]);
  assert.equal(entry.messages[0].responseAnnotationRequest, "Почему так?");
  assert.deepEqual(entry.messages[0].attachments, [
    { id: "screen.png", name: "screen.png", type: "image/png" },
  ]);
  assert.equal(entry.activities[0].label, "Проверка");
  assert.equal(entry.activityGroups[0].reasoning, "Проверяю входные данные.");
  assert.equal(entry.activityGroups[0].activities[0].label, "Проверка");
  const search = restored.searchMessages({
    references: [{ provider: task.provider, threadId: task.threadId }],
    query: "посмотри скриншот",
  });
  assert.equal(search.results[0].author, "Agent Hub - Architect");
});

test("message search keeps every indexed reply beyond the bounded chat read model", async () => {
  const filePath = await storeFile();
  const store = new LocalTaskSyncStore({ filePath, historyLimit: 1 });
  await store.load();
  store.recordHistory(task, [{
    id: "turn-old",
    prompt: "Старый вопрос",
    answer: "Старый точный ответ",
    status: "completed",
    completed: true,
    messages: [
      { itemId: "old-user", role: "user", text: "Старый вопрос" },
      { itemId: "old-agent", role: "agent", text: "Старый точный ответ" },
    ],
  }, {
    id: "turn-new",
    prompt: "Новый вопрос",
    answer: "Новый ответ",
    status: "completed",
    completed: true,
    messages: [
      { itemId: "new-user", role: "user", text: "Новый вопрос" },
      { itemId: "new-agent", role: "agent", text: "Новый ответ" },
    ],
  }]);
  assert.equal(store.history(task).length, 1);
  const result = store.searchMessages({
    references: [{ provider: task.provider, threadId: task.threadId }],
    query: "старый точный",
  });
  assert.equal(result.total, 1);
  assert.equal(result.results[0].itemId, "old-agent");
  assert.equal(store.searchMessage({
    provider: task.provider,
    threadId: task.threadId,
    turnId: "turn-old",
    itemId: "old-agent",
  })?.text, "Старый точный ответ");
  assert.equal(store.messageSearchStatus([task]).completedThreads, 0);
  store.markMessageSearchThread(task, { nowMs: 123 });
  assert.deepEqual(store.messageSearchStatus([task]), {
    totalThreads: 1,
    completedThreads: 1,
    failedThreads: 0,
    threads: [{
      provider: task.provider,
      threadId: task.threadId,
      state: "ready",
      completedAtMs: 123,
      error: "",
    }],
  });
  store.close();
});

test("message search indexes more than one hundred intermediate messages in one turn", async () => {
  const filePath = await storeFile();
  const store = new LocalTaskSyncStore({ filePath });
  await store.load();
  const messages = Array.from({ length: 130 }, (_, index) => ({
    itemId: `agent-${index}`,
    role: "agent",
    text: index === 0 ? "needle at the beginning" : `reply ${index}`,
  }));
  store.recordHistory(task, [{
    id: "long-turn",
    answer: "done",
    completed: true,
    messages,
  }]);
  assert.equal(store.history(task)[0].messages.length, 100);
  assert.equal(store.searchMessages({
    references: [task], query: "needle beginning",
  }).results[0].itemId, "agent-0");
  store.close();
});

test("local task sync migrates annotation columns in an existing SQLite cache", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "task-sync-annotation-schema-"));
  const filePath = path.join(directory, "task-sync.json");
  const databaseFile = path.join(directory, "journal.sqlite");
  let store;
  try {
    const database = new DatabaseSync(databaseFile);
    database.exec(`
      CREATE TABLE task_read_model_turns (
        provider TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        position INTEGER NOT NULL,
        id TEXT NOT NULL,
        prompt TEXT NOT NULL,
        answer TEXT NOT NULL,
        status TEXT NOT NULL,
        active INTEGER NOT NULL,
        completed INTEGER NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        attachments_json TEXT NOT NULL,
        activities_json TEXT NOT NULL,
        PRIMARY KEY (provider, thread_id, position)
      ) WITHOUT ROWID;
      CREATE TABLE task_read_model_messages (
        provider TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        turn_position INTEGER NOT NULL,
        position INTEGER NOT NULL,
        item_id TEXT NOT NULL,
        client_user_message_id TEXT,
        role TEXT NOT NULL,
        text TEXT NOT NULL,
        phase TEXT,
        time TEXT,
        attachments_json TEXT NOT NULL,
        PRIMARY KEY (provider, thread_id, turn_position, position)
      ) WITHOUT ROWID;
    `);
    database.close();

    store = new LocalTaskSyncStore({ filePath, databaseFile });
    await store.load();
    store.close();
    store = null;

    const migrated = new DatabaseSync(databaseFile, { readOnly: true });
    const turnColumns = migrated.prepare("PRAGMA table_info(task_read_model_turns)")
      .all().map((column) => column.name);
    const messageColumns = migrated.prepare("PRAGMA table_info(task_read_model_messages)")
      .all().map((column) => column.name);
    const searchColumns = migrated.prepare("PRAGMA table_info(task_message_search_documents)")
      .all().map((column) => column.name);
    migrated.close();
    assert.ok(turnColumns.includes("prompt_annotations_json"));
    assert.ok(turnColumns.includes("prompt_request"));
    assert.ok(turnColumns.includes("activity_groups_json"));
    assert.ok(messageColumns.includes("response_annotations_json"));
    assert.ok(messageColumns.includes("response_annotation_request"));
    assert.ok(messageColumns.includes("author"));
    assert.ok(searchColumns.includes("author"));
  } finally {
    store?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("local task sync canonicalizes persisted project roots on load", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "task-sync-root-"));
  let store;
  try {
    const filePath = path.join(directory, "task-sync.json");
    await writeFile(filePath, JSON.stringify({
      version: 1,
      tasks: [{
        provider: "codex",
        threadId: "thread-1",
        projectRoot: "C:\\OldWorkspace",
      }],
    }), "utf8");
    store = new LocalTaskSyncStore({
      filePath,
      canonicalizeProjectRoot: () => "D:\\Workspace",
    });
    await store.load();
    await store.save();
    assert.equal(store.catalog()[0].projectRoot, "D:\\Workspace");
    await assert.rejects(access(filePath), { code: "ENOENT" });
  } finally {
    store?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("local task sync canonicalizes project references inside saved history", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "task-sync-history-root-"));
  let store;
  try {
    const filePath = path.join(directory, "task-sync.json");
    await writeFile(filePath, JSON.stringify({
      version: 1,
      tasks: [{
        provider: "codex",
        threadId: "thread-1",
        projectRoot: "C:\\OldWorkspace",
        answer: "See C:\\OldWorkspace\\README.md",
        history: [{ answer: "[file](C:\\OldWorkspace\\file.txt)" }],
      }],
    }), "utf8");
    store = new LocalTaskSyncStore({
      filePath,
      canonicalizeProjectRoot: (value) => (
        value === "C:\\OldWorkspace" ? "D:\\Workspace" : value
      ),
      canonicalizeValue: (value) => JSON.parse(
        JSON.stringify(value).replaceAll("C:\\\\OldWorkspace", "D:\\\\Workspace"),
      ),
    });
    await store.load();
    await store.save();
    assert.equal(store.catalog()[0].projectRoot, "D:\\Workspace");
    assert.equal(store.snapshot({ provider: "codex", threadId: "thread-1" }).answer,
      "See D:\\Workspace\\README.md");
    assert.equal(store.history({ provider: "codex", threadId: "thread-1" })[0].answer,
      "[file](D:\\Workspace\\file.txt)");
    await assert.rejects(access(filePath), { code: "ENOENT" });
  } finally {
    store?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("cached running status expires instead of creating a phantom task", async () => {
  const filePath = await storeFile();
  const store = new LocalTaskSyncStore({ filePath });
  await store.load();
  store.recordCatalog([{
    ...task,
    running: true,
    executionOwner: TASK_EXECUTION_OWNERS.VSCODE,
    lastActivityAtMs: 1_000,
  }], 1_000);
  assert.equal(store.catalog({
    nowMs: 1_000 + 11 * 60 * 1_000,
  })[0].running, false);
});

test("managed Telegram snapshot records Agent Hub ownership", async () => {
  const filePath = await storeFile();
  const store = new LocalTaskSyncStore({ filePath });
  await store.load();
  store.recordSnapshot(task, {
    active: true,
    turnId: "turn-telegram",
    activityAtMs: 5_000,
    stage: "Ответ формируется",
  }, {
    executionOwner: TASK_EXECUTION_OWNERS.HUB,
    nowMs: 5_000,
  });
  const [entry] = store.catalog({ nowMs: 5_500 });
  assert.equal(entry.running, true);
  assert.equal(entry.executionOwner, TASK_EXECUTION_OWNERS.HUB);
  assert.equal(entry.turnId, "turn-telegram");
});

test("Claude session cwd survives the local task catalog cache", async () => {
  const filePath = await storeFile();
  const store = new LocalTaskSyncStore({ filePath });
  await store.load();
  const claudeTask = {
    ...task,
    provider: "claude",
    threadId: "claude-session",
    sessionCwd: "C:\\Projects\\Main\\Utilities\\AgentHub",
  };
  store.recordCatalog([claudeTask], 5_000);
  await store.save();

  const restored = new LocalTaskSyncStore({ filePath });
  await restored.load();
  assert.equal(restored.catalog()[0].sessionCwd, claudeTask.sessionCwd);
});

test("unchanged polling snapshots do not dirty the persistent store", async () => {
  const filePath = await storeFile();
  const store = new LocalTaskSyncStore({ filePath });
  await store.load();
  const snapshot = {
    active: true,
    turnId: "turn-telegram",
    activityAtMs: 5_000,
    stage: "Ответ формируется",
    answer: "Без изменений",
  };
  assert.equal(store.recordSnapshot(task, snapshot, {
    executionOwner: TASK_EXECUTION_OWNERS.HUB,
    nowMs: 5_000,
  }), true);
  await store.save();
  assert.equal(store.recordSnapshot(task, snapshot, {
    executionOwner: TASK_EXECUTION_OWNERS.HUB,
    nowMs: 50_000,
  }), false);
  assert.equal(store.recordCatalog([{
    ...task,
    running: true,
    executionOwner: TASK_EXECUTION_OWNERS.HUB,
    turnId: "turn-telegram",
    updatedAtMs: 0,
    lastActivityAtMs: 5_000,
  }], 60_000), false);
});

test("completed-only history refresh preserves a live cached status", async () => {
  const filePath = await storeFile();
  const store = new LocalTaskSyncStore({ filePath });
  await store.load();
  store.recordSnapshot(task, {
    active: true,
    turnId: "live",
    activityAtMs: 9_000,
  }, {
    executionOwner: TASK_EXECUTION_OWNERS.VSCODE,
    nowMs: 9_000,
  });
  store.recordHistory(task, [{
    id: "old",
    prompt: "Старый вопрос",
    answer: "Старый ответ",
    status: "completed",
    completed: true,
  }], null, 9_500);
  assert.equal(store.catalog({ nowMs: 10_000 })[0].running, true);
  assert.equal(store.snapshot(task, { nowMs: 10_000 }).turnId, "live");
  assert.equal(store.snapshot(task, {
    nowMs: 9_000 + 11 * 60 * 1_000,
  }).active, false);
});

test("task sync evicts oldest completed cache entries but never active ones", async () => {
  const filePath = await storeFile();
  const store = new LocalTaskSyncStore({ filePath, taskLimit: 3 });
  await store.load();
  store.recordCatalog(Array.from({ length: 4 }, (_, index) => ({
    ...task,
    threadId: `completed-${index}`,
    title: `Completed ${index}`,
    running: false,
    updatedAtMs: index,
  })), 100);
  store.recordCatalog([{
    ...task,
    threadId: "active",
    title: "Active",
    running: true,
    lastActivityAtMs: 200,
  }], 200);
  const entries = store.catalog({ nowMs: 200 });
  assert.equal(entries.length, 3);
  assert.equal(entries.some((entry) => entry.threadId === "active" && entry.running), true);
  assert.equal(entries.some((entry) => entry.threadId === "completed-0"), false);
  assert.equal(entries.some((entry) => entry.threadId === "completed-1"), false);
});

test("task sync removes a promptless compaction echo of the previous answer", async () => {
  const filePath = await storeFile();
  const store = new LocalTaskSyncStore({ filePath });
  await store.load();
  store.recordHistory(task, [{
    id: "user-turn",
    prompt: "Вопрос",
    answer: "Готовый ответ",
    status: "completed",
    completed: true,
    messages: [
      { itemId: "user", role: "user", text: "Вопрос" },
      { itemId: "answer", role: "agent", text: "Готовый ответ" },
    ],
  }, {
    id: "compaction-turn",
    prompt: "",
    answer: "Готовый ответ",
    status: "completed",
    completed: true,
    messages: [{ itemId: "echo", role: "agent", text: "Готовый ответ" }],
  }]);

  assert.deepEqual(store.history(task).map((turn) => turn.id), ["user-turn"]);
});
