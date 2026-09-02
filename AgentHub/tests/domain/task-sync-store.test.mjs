import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

test("local task sync fails closed on a corrupt shared database", async () => {
  const filePath = await storeFile();
  const databaseFile = path.join(path.dirname(filePath), "journal.sqlite");
  await writeFile(databaseFile, "not a sqlite database", "utf8");
  try {
    const store = new LocalTaskSyncStore({ filePath, databaseFile });
    await assert.rejects(store.load(), /not a database/iu);
    assert.equal(await readFile(databaseFile, "utf8"), "not a sqlite database");
  } finally {
    await rm(path.dirname(filePath), { recursive: true, force: true });
  }
});

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

test("history page keeps legacy undated turns in durable provider sequence", async () => {
  const filePath = await storeFile();
  const databaseFile = path.join(path.dirname(filePath), "journal.sqlite");
  const store = new LocalTaskSyncStore({ filePath, databaseFile });
  await store.load();
  const legacyThread = { ...task, threadId: "legacy-vsc-thread" };
  const modernThread = { ...task, threadId: "modern-codex-thread" };
  try {
    store.recordHistory(legacyThread, [{
      id: "legacy-vsc-1",
      prompt: "Старый VSC-запрос",
      answer: "Старый VSC-ответ",
      completed: true,
      messages: [
        { itemId: "legacy-vsc-user-1", role: "user", text: "Старый VSC-запрос" },
        { itemId: "legacy-vsc-agent-1", role: "agent", text: "Старый VSC-ответ" },
      ],
    }, {
      id: "legacy-vsc-2",
      prompt: "Ещё один старый VSC-запрос",
      answer: "Ещё один старый VSC-ответ",
      completed: true,
      messages: [
        { itemId: "legacy-vsc-user-2", role: "user", text: "Ещё один старый VSC-запрос" },
        { itemId: "legacy-vsc-agent-2", role: "agent", text: "Ещё один старый VSC-ответ" },
      ],
    }]);
    store.recordHistory(modernThread, [{
      id: "modern-codex-1",
      prompt: "Современный запрос",
      answer: "Современный ответ",
      completed: true,
      startedAt: "2026-09-01T20:00:00.000Z",
      completedAt: "2026-09-01T20:01:00.000Z",
      messages: [
        {
          itemId: "modern-codex-user-1",
          role: "user",
          text: "Современный запрос",
          time: "2026-09-01T20:00:00.000Z",
        },
        {
          itemId: "modern-codex-agent-1",
          role: "agent",
          text: "Современный ответ",
          time: "2026-09-01T20:01:00.000Z",
        },
      ],
    }]);

    const page = store.historyPage([legacyThread, modernThread], { limit: 10 });

    assert.deepEqual(page.items.map(({ turn }) => turn.id), [
      "legacy-vsc-1",
      "legacy-vsc-2",
      "modern-codex-1",
    ]);
    assert.equal(page.items[0].turn.startedAt ?? null, null);
    assert.equal(page.items[0].turn.messages[0].time ?? null, null);
  } finally {
    store.close();
    await rm(path.dirname(filePath), { recursive: true, force: true });
  }
});

test("Claude transcript attachment turn cannot duplicate its managed terminal command", async () => {
  const filePath = await storeFile();
  const store = new LocalTaskSyncStore({ filePath });
  await store.load();
  const claudeTask = { ...task, provider: "claude", threadId: "claude-thread" };
  const attachment = { id: "image-1.png", name: "image.png", type: "image/png" };
  const managed = {
    id: "managed-turn",
    prompt: "Проанализируй приложенные изображения.",
    answer: "Ошибка Claude Code: лимит исчерпан",
    status: "failed",
    active: false,
    completed: true,
    attachments: [attachment],
    messages: [
      {
        itemId: "managed-user",
        clientUserMessageId: "client-command-1",
        role: "user",
        text: "Проанализируй приложенные изображения.",
        attachments: [attachment],
      },
      { itemId: "managed-final", role: "agent", text: "Ошибка Claude Code: лимит исчерпан" },
    ],
  };
  const transcript = {
    id: "provider-user-uuid",
    prompt: "Проанализируй приложенные изображения.\n\nПроанализируй также изображение по абсолютному пути: C:\\AgentHub\\attachments\\image-1.png",
    answer: "лимит исчерпан",
    status: "completed",
    active: false,
    completed: true,
    messages: [
      {
        itemId: "provider-user-uuid",
        role: "user",
        text: "Проанализируй приложенные изображения.\n\nПроанализируй также изображение по абсолютному пути: C:\\AgentHub\\attachments\\image-1.png",
      },
      { itemId: "provider-agent-uuid", role: "agent", text: "лимит исчерпан" },
    ],
  };

  store.recordHistory(claudeTask, [managed, transcript]);

  const history = store.history(claudeTask);
  assert.equal(history.length, 1);
  assert.equal(history[0].id, "managed-turn");
  assert.equal(history[0].messages[0].clientUserMessageId, "client-command-1");
  assert.equal(history[0].answer, "Ошибка Claude Code: лимит исчерпан");
});

test("Claude transcript plain turn reuses its managed provider user identity", async () => {
  const filePath = await storeFile();
  const store = new LocalTaskSyncStore({ filePath });
  await store.load();
  const claudeTask = { ...task, provider: "claude", threadId: "claude-thread" };
  const managed = {
    id: "managed-turn",
    prompt: "123",
    answer: "Получил «123». Что нужно сделать?",
    status: "completed",
    active: false,
    completed: true,
    messages: [
      {
        itemId: "provider-user-uuid",
        clientUserMessageId: "client-command-123",
        role: "user",
        text: "123",
      },
      {
        itemId: "managed-turn:agent:final",
        role: "agent",
        text: "Получил «123». Что нужно сделать?",
      },
    ],
  };
  const transcript = {
    id: "provider-user-uuid",
    prompt: "123",
    answer: "Получил «123». Что нужно сделать?",
    status: "completed",
    active: false,
    completed: true,
    messages: [
      { itemId: "provider-user-uuid", role: "user", text: "123" },
      {
        itemId: "provider-agent-uuid",
        role: "agent",
        text: "Получил «123». Что нужно сделать?",
      },
    ],
  };

  store.recordHistory(claudeTask, [managed, transcript]);

  const history = store.history(claudeTask);
  assert.equal(history.length, 1);
  assert.equal(history[0].id, "managed-turn");
  assert.equal(history[0].messages[0].clientUserMessageId, "client-command-123");
  assert.equal(history[0].answer, "Получил «123». Что нужно сделать?");
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
      attachments: [
        { id: "screen.png", name: "screen.png", type: "image/png" },
        {
          kind: "task",
          taskId: "board-1",
          title: "Исправить Dashboard",
          workflowStatus: "testing",
          workspaceId: "workspace-1",
          intent: "context",
          description: "не должно сохраняться во вложении",
        },
      ],
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
    {
      kind: "task",
      taskId: "board-1",
      title: "Исправить Dashboard",
      workflowStatus: "testing",
      workspaceId: "workspace-1",
      intent: "context",
    },
  ]);
  assert.equal(entry.activities[0].label, "Проверка");
  assert.equal(entry.activityGroups[0].reasoning, "Проверяю входные данные.");
  assert.equal(entry.activityGroups[0].activities[0].label, "Проверка");
  const search = restored.searchMessages({
    references: [{ provider: task.provider, threadId: task.threadId }],
    query: "посмотри скриншот",
  });
  assert.equal(search.results[0].author, "Agent Hub - Architect");

  restored.recordHistory(task, [{
    ...entry,
    attachments: [],
    messages: entry.messages.map((message) => ({ ...message, attachments: [] })),
  }]);
  const [refreshed] = restored.history(task);
  assert.deepEqual(refreshed.attachments, [
    { id: "screen.png", name: "screen.png", type: "image/png" },
  ]);
  assert.deepEqual(refreshed.messages[0].attachments, [
    { id: "screen.png", name: "screen.png", type: "image/png" },
    {
      kind: "task",
      taskId: "board-1",
      title: "Исправить Dashboard",
      workflowStatus: "testing",
      workspaceId: "workspace-1",
      intent: "context",
    },
  ]);
  restored.close();
});

test("local task sync preserves interstream origin through SQLite", async () => {
  const filePath = await storeFile();
  const origin = {
    kind: "interstream",
    workspaceId: "workspace-agent-hub",
    workspaceName: "Agent HUB",
    streamId: "stream-themes",
    streamName: "Themes",
    provider: "codex",
    model: "gpt-5.6-sol",
    sourceThreadId: "thread-themes",
    requestId: "message-origin-1",
  };
  let store = new LocalTaskSyncStore({ filePath });
  await store.load();
  store.recordHistory(task, [{
    id: "turn-interstream",
    prompt: "Проверь доставку",
    promptAuthor: "неверная временная подпись",
    promptOrigin: origin,
    answer: "Готово",
    status: "completed",
    completed: true,
    messages: [{
      itemId: "turn-interstream:user",
      clientUserMessageId: "mcp:message-origin-1",
      role: "user",
      kind: "interstream",
      origin,
      author: "Вы",
      text: "Проверь доставку",
    }],
  }]);
  store.close();

  store = new LocalTaskSyncStore({ filePath });
  await store.load();
  const [restored] = store.history(task);
  assert.equal(restored.promptAuthor, "Agent HUB - Themes (Sol)");
  assert.deepEqual(restored.promptOrigin, origin);
  assert.equal(restored.messages[0].author, "Agent HUB - Themes (Sol)");
  assert.equal(restored.messages[0].kind, "interstream");
  assert.deepEqual(restored.messages[0].origin, origin);
  store.close();
});

test("local task sync repairs parent finals misattributed as subagents", async () => {
  const filePath = await storeFile();
  const databaseFile = path.join(path.dirname(filePath), "journal.sqlite");
  const store = new LocalTaskSyncStore({ filePath, databaseFile });
  await store.load();
  store.recordHistory(task, [{
    id: "turn-attribution",
    prompt: "Проверь",
    answer: "Общий итог",
    status: "completed",
    completed: true,
    messages: [{
      itemId: "turn-attribution:rollout-agent:final",
      role: "agent",
      text: "Общий итог",
      author: "Субагент (модель неизвестна)",
    }, {
      itemId: "turn-attribution:subagent:child-1",
      role: "agent",
      text: "Отчёт",
      author: "Субагент (Terra)",
      kind: "subagent",
      agentThreadId: "child-1",
      model: "gpt-5.6-terra",
    }],
  }]);
  assert.equal(store.history(task)[0].messages[0].author, undefined);
  store.close();

  const database = new DatabaseSync(databaseFile);
  database.prepare(`
    UPDATE task_read_model_messages
    SET author = 'Субагент (модель неизвестна)', kind = '', model = 'gpt-5.6-terra'
    WHERE item_id = ?
  `).run("turn-attribution:rollout-agent:final");
  database.close();

  const restored = new LocalTaskSyncStore({ filePath, databaseFile });
  await restored.load();
  const messages = restored.history(task)[0].messages;
  assert.equal(messages[0].author, undefined);
  assert.equal(messages[0].kind, undefined);
  assert.equal(messages[0].model, undefined);
  assert.equal(messages[1].author, "Субагент (Terra)");
  assert.equal(messages[1].kind, "subagent");
  assert.equal(messages[1].agentThreadId, "child-1");
  restored.close();
});

test("local task sync restores subagent models from their exact journal threads", async () => {
  const filePath = await storeFile();
  const databaseFile = path.join(path.dirname(filePath), "journal.sqlite");
  let store = new LocalTaskSyncStore({ filePath, databaseFile });
  await store.load();
  store.recordHistory(task, [{
    id: "turn-parent-model",
    prompt: "Проверь",
    answer: "Готово",
    completed: true,
    messages: [{
      itemId: "turn-parent-model:subagent:child-sol",
      role: "agent",
      kind: "subagent",
      agentThreadId: "child-sol",
      author: "Субагент (модель неизвестна)",
      text: "Отчёт Sol",
    }],
  }]);
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
    "child-sol",
    "child-turn",
    task.projectRoot,
    task.threadId,
    1_000,
    JSON.stringify({ model: "gpt-5.6-sol", parentThreadId: task.threadId }),
  );
  database.close();

  store = new LocalTaskSyncStore({ filePath, databaseFile });
  await store.load();
  const message = store.history(task)[0].messages[0];
  assert.equal(message.model, "gpt-5.6-sol");
  assert.equal(message.author, "Субагент (Sol)");
  assert.equal(store.searchMessages({
    references: [task],
    query: "отчёт sol",
  }).results[0].author, "Субагент (Sol)");
  store.close();
});

test("local task sync preserves subagent identity through SQLite", async () => {
  const filePath = await storeFile();
  let store = new LocalTaskSyncStore({ filePath });
  await store.load();
  store.recordHistory(task, [{
    id: "turn-parent",
    prompt: "Проверь двумя субагентами",
    answer: "Сверил результаты",
    status: "completed",
    completed: true,
    messages: [{
      itemId: "turn-parent:subagent:child-terra",
      role: "agent",
      kind: "subagent",
      agentThreadId: "child-terra",
      model: "gpt-5.6-terra",
      author: "Субагент (Terra)",
      text: "Независимый отчёт",
    }],
  }]);
  store.close();

  store = new LocalTaskSyncStore({ filePath });
  await store.load();
  assert.deepEqual(store.history(task)[0].messages[0], {
    itemId: "turn-parent:subagent:child-terra",
    role: "agent",
    text: "Независимый отчёт",
    author: "Субагент (Terra)",
    kind: "subagent",
    agentThreadId: "child-terra",
    model: "gpt-5.6-terra",
    responseAnnotations: [],
    attachments: [],
  });
  store.close();
});

test("local task sync rejects a legacy writer that stores a subagent as user", async () => {
  const filePath = await storeFile();
  const databaseFile = path.join(path.dirname(filePath), "journal.sqlite");
  let store = new LocalTaskSyncStore({ filePath, databaseFile });
  await store.load();
  store.recordHistory(task, [{
    id: "turn-parent",
    prompt: "Проверь",
    answer: "Готово",
    status: "completed",
    completed: true,
    messages: [{
      itemId: "turn-parent:subagent:child-sol",
      role: "agent",
      kind: "subagent",
      agentThreadId: "child-sol",
      author: "Субагент (Sol)",
      text: "Отчёт Sol",
    }],
  }]);
  store.close();

  const database = new DatabaseSync(databaseFile);
  database.prepare(`
    UPDATE task_read_model_messages
    SET role = 'user', author = '', kind = '', agent_thread_id = '', model = ''
    WHERE item_id = ?
  `).run("turn-parent:subagent:child-sol");
  database.prepare(`
    UPDATE task_message_search_documents
    SET role = 'user', author = ''
    WHERE item_id = ?
  `).run("turn-parent:subagent:child-sol");
  assert.deepEqual({ ...database.prepare(`
    SELECT role, author, kind, agent_thread_id FROM task_read_model_messages
    WHERE item_id = ?
  `).get("turn-parent:subagent:child-sol") }, {
    role: "agent",
    author: "Субагент (модель неизвестна)",
    kind: "subagent",
    agent_thread_id: "child-sol",
  });
  assert.deepEqual({ ...database.prepare(`
    SELECT role, author FROM task_message_search_documents WHERE item_id = ?
  `).get("turn-parent:subagent:child-sol") }, {
    role: "agent",
    author: "Субагент (модель неизвестна)",
  });
  database.close();

  store = new LocalTaskSyncStore({ filePath, databaseFile });
  await store.load();
  const message = store.history(task)[0].messages[0];
  assert.equal(message.role, "agent");
  assert.equal(message.kind, "subagent");
  assert.equal(message.agentThreadId, "child-sol");
  assert.equal(message.author, "Субагент (модель неизвестна)");
  store.close();
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

test("recordHistory no-op leaves the existing search projection untouched", async () => {
  const filePath = await storeFile();
  const databaseFile = path.join(path.dirname(filePath), "journal.sqlite");
  const store = new LocalTaskSyncStore({ filePath, databaseFile });
  const history = [{
    id: "stable-turn",
    prompt: "Стабильный вопрос",
    answer: "Стабильный ответ",
    completed: true,
  }];
  await store.load();
  assert.equal(store.recordHistory(task, history, null, 1_000), true);

  const database = new DatabaseSync(databaseFile);
  database.prepare(`
    INSERT INTO task_message_search_documents (
      document_key, provider, thread_id, turn_thread_id, turn_id, item_id,
      role, message_text, author, annotation_text, attachment_names,
      occurred_at, occurred_at_ms, source
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    JSON.stringify([task.provider, task.threadId, "stable-turn", "journal-extra", "agent"]),
    task.provider,
    task.threadId,
    task.threadId,
    "stable-turn",
    "journal-extra",
    "agent",
    "durable search sentinel",
    "",
    "",
    "",
    "2026-08-14T12:00:00.000Z",
    1_000,
    "journal",
  );
  database.close();

  assert.equal(store.recordHistory(task, history, null, 1_000), false);
  assert.equal(store.searchMessages({
    references: [task],
    query: "durable search sentinel",
  }).total, 1);
  store.close();
});

test("search projection can grow beyond an unchanged bounded history", async () => {
  const filePath = await storeFile();
  const store = new LocalTaskSyncStore({ filePath, historyLimit: 1 });
  const latest = {
    id: "latest-turn",
    prompt: "Последний вопрос",
    answer: "Последний ответ",
    completed: true,
  };
  await store.load();
  assert.equal(store.recordHistory(task, [latest], null, 1_000), true);
  assert.equal(store.recordHistory(task, [{
    id: "older-turn",
    prompt: "Скрытый старый вопрос",
    answer: "Скрытый старый ответ",
    completed: true,
  }, latest], null, 1_000), false);
  assert.equal(store.history(task).length, 1);
  assert.equal(store.searchMessages({
    references: [task],
    query: "скрытый старый ответ",
  }).total, 1);
  store.close();
});

test("startup backfills run once per version and commit their marker atomically", async () => {
  const filePath = await storeFile();
  const databaseFile = path.join(path.dirname(filePath), "journal.sqlite");
  const history = [{
    id: "recoverable-turn",
    prompt: "Восстанови поисковый индекс",
    answer: "Индекс восстановлен",
    completed: true,
  }];
  let store = new LocalTaskSyncStore({ filePath, databaseFile });
  await store.load();
  store.recordHistory(task, history, null, 1_000);
  store.close();

  let database = new DatabaseSync(databaseFile);
  assert.deepEqual(database.prepare(`
    SELECT key, value FROM task_read_model_meta
    WHERE key LIKE 'backfill_%_version'
    ORDER BY key
  `).all().map((row) => ({ key: row.key, value: row.value })), [
    { key: "backfill_task_message_search_version", value: "3" },
  ]);
  database.exec(`
    CREATE TABLE backfill_write_audit (operation TEXT NOT NULL);
    CREATE TRIGGER audit_search_insert AFTER INSERT ON task_message_search_documents BEGIN
      INSERT INTO backfill_write_audit VALUES ('insert');
    END;
    CREATE TRIGGER audit_search_delete AFTER DELETE ON task_message_search_documents BEGIN
      INSERT INTO backfill_write_audit VALUES ('delete');
    END;
  `);
  database.close();

  store = new LocalTaskSyncStore({ filePath, databaseFile });
  await store.load();
  store.close();
  database = new DatabaseSync(databaseFile);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM backfill_write_audit").get().count, 0);
  database.exec(`
    CREATE TABLE journal_records (
      provider TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      project_root TEXT NOT NULL,
      task_thread_id TEXT NOT NULL,
      completed_at_ms INTEGER,
      record_json TEXT NOT NULL,
      PRIMARY KEY (provider, thread_id, turn_id)
    ) WITHOUT ROWID;
  `);
  database.prepare(`
    INSERT INTO journal_records VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    task.provider,
    task.threadId,
    "journal-turn",
    task.projectRoot,
    task.threadId,
    2_000,
    JSON.stringify({ prompt: "Журнал появился позже", body: "Поздняя запись найдена" }),
  );
  database.close();

  store = new LocalTaskSyncStore({ filePath, databaseFile });
  await store.load();
  assert.equal(store.searchMessages({
    references: [task],
    query: "поздняя запись найдена",
  }).total, 1);
  store.close();
  database = new DatabaseSync(databaseFile);
  assert.equal(database.prepare(`
    SELECT COUNT(*) AS count FROM task_read_model_meta
    WHERE key IN ('backfill_models_from_journal_version', 'backfill_journal_message_search_version')
  `).get().count, 2);
  database.exec(`
    DELETE FROM task_message_search_documents;
    DELETE FROM task_read_model_meta WHERE key = 'backfill_task_message_search_version';
    CREATE TRIGGER fail_search_backfill BEFORE INSERT ON task_message_search_documents BEGIN
      SELECT RAISE(ABORT, 'simulated backfill crash');
    END;
  `);
  database.close();

  store = new LocalTaskSyncStore({ filePath, databaseFile });
  await assert.rejects(() => store.load(), /simulated backfill crash/u);
  store.close();
  database = new DatabaseSync(databaseFile);
  assert.equal(database.prepare(`
    SELECT value FROM task_read_model_meta WHERE key = 'backfill_task_message_search_version'
  `).get(), undefined);
  database.exec("DROP TRIGGER fail_search_backfill");
  database.close();

  store = new LocalTaskSyncStore({ filePath, databaseFile });
  await store.load();
  assert.equal(store.searchMessages({
    references: [task],
    query: "индекс восстановлен",
  }).total, 1);
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
    assert.ok(messageColumns.includes("kind"));
    assert.ok(messageColumns.includes("agent_thread_id"));
    assert.ok(messageColumns.includes("model"));
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

test("terminal recovered turns remain terminal when a stale Codex live projection reconnects", async () => {
  const filePath = await storeFile();
  const databaseFile = path.join(path.dirname(filePath), "journal.sqlite");
  const store = new LocalTaskSyncStore({ filePath, databaseFile });
  await store.load();
  const priorTurns = Array.from({ length: 47 }, (_, index) => ({
    id: `turn-${index}`,
    prompt: `Вопрос ${index}`,
    answer: `Ответ ${index}`,
    status: "completed",
    active: false,
    completed: true,
  }));
  const recoveredTurnIds = ["turn-47", "turn-48"];
  const terminalHistory = [
    ...priorTurns,
    ...recoveredTurnIds.map((id) => ({
      id,
      prompt: `Вопрос ${id}`,
      answer: `Финальный ответ ${id}`,
      status: "completed",
      active: false,
      completed: true,
      completedAt: "2026-08-15T15:00:00.000Z",
      messages: [{ itemId: `${id}:final`, role: "agent", text: `Финальный ответ ${id}` }],
    })),
    {
      id: "turn-49",
      prompt: "Текущий вопрос",
      answer: "Текущий ответ",
      status: "inProgress",
      active: true,
      completed: false,
    },
  ];
  store.recordHistory(task, terminalHistory, {
    active: true,
    turnId: "turn-49",
    executionOwner: TASK_EXECUTION_OWNERS.VSCODE,
    activityAtMs: 10_000,
  }, 10_000);

  const staleProjection = terminalHistory.map((turn) => (
    recoveredTurnIds.includes(turn.id)
      ? {
        ...turn,
        answer: "Старый промежуточный ответ",
        status: "inProgress",
        active: true,
        completed: false,
      }
      : turn
  ));
  store.recordHistory(task, staleProjection, {
    active: true,
    turnId: "turn-47",
    executionOwner: TASK_EXECUTION_OWNERS.VSCODE,
    activityAtMs: 9_000,
  }, 11_000);

  assert.deepEqual(store.history(task).slice(-3).map((turn) => ({
    id: turn.id,
    answer: turn.answer,
    status: turn.status,
    active: turn.active,
    completed: turn.completed,
  })), [
    { id: "turn-47", answer: "Финальный ответ turn-47", status: "completed", active: false, completed: true },
    { id: "turn-48", answer: "Финальный ответ turn-48", status: "completed", active: false, completed: true },
    { id: "turn-49", answer: "Текущий ответ", status: "inProgress", active: true, completed: false },
  ]);
  assert.deepEqual(store.snapshot(task, { nowMs: 11_000 }), {
    active: true,
    completed: false,
    turnId: "turn-49",
    activityAtMs: 10_000,
    executionOwner: TASK_EXECUTION_OWNERS.VSCODE,
    stage: "",
    answer: "",
  });

  const database = new DatabaseSync(databaseFile);
  assert.deepEqual(database.prepare(`
    SELECT position, id, status, active, completed
    FROM task_read_model_turns
    WHERE provider = ? AND thread_id = ? AND position >= 47
    ORDER BY position
  `).all(task.provider, task.threadId).map((row) => ({ ...row })), [
    { position: 47, id: "turn-47", status: "completed", active: 0, completed: 1 },
    { position: 48, id: "turn-48", status: "completed", active: 0, completed: 1 },
    { position: 49, id: "turn-49", status: "inProgress", active: 1, completed: 0 },
  ]);
  database.close();
  store.close();
});

test("cached history reads only the requested newest turns and their messages", async () => {
  const filePath = await storeFile();
  const store = new LocalTaskSyncStore({ filePath });
  await store.load();
  store.recordHistory(task, Array.from({ length: 6 }, (_, index) => ({
    id: `turn-${index}`,
    prompt: `prompt ${index}`,
    answer: `answer ${index}`,
    completed: true,
    messages: [{ itemId: `message-${index}`, role: "agent", text: `message ${index}` }],
  })));

  const history = store.history(task, { limit: 2 });

  assert.deepEqual(history.map((turn) => turn.id), ["turn-4", "turn-5"]);
  assert.deepEqual(history.flatMap((turn) => turn.messages.map((message) => message.itemId)), [
    "message-4",
    "message-5",
  ]);
  store.close();
});

test("a stale live snapshot cannot reactivate a recovered terminal task", async () => {
  const filePath = await storeFile();
  const databaseFile = path.join(path.dirname(filePath), "journal.sqlite");
  const store = new LocalTaskSyncStore({ filePath, databaseFile });
  await store.load();
  const recovered = {
    id: "recovered-turn",
    prompt: "Завершённый вопрос",
    answer: "Финальный ответ",
    status: "completed",
    active: false,
    completed: true,
  };
  store.recordHistory(task, [recovered], { active: false, turnId: "recovered-turn" }, 10_000);
  store.recordHistory(task, [{
    ...recovered,
    answer: "Старый промежуточный ответ",
    status: "inProgress",
    active: true,
    completed: false,
  }], {
    active: true,
    turnId: "recovered-turn",
    executionOwner: TASK_EXECUTION_OWNERS.VSCODE,
    activityAtMs: 9_000,
  }, 11_000);

  assert.equal(store.history(task)[0].status, "completed");
  assert.equal(store.history(task)[0].active, false);
  assert.equal(store.catalog({ nowMs: 11_000 })[0].running, false);
  assert.equal(store.snapshot(task, { nowMs: 11_000 }).turnId, null);

  const database = new DatabaseSync(databaseFile);
  assert.equal(database.prepare(`
    SELECT turn_id FROM task_read_model_tasks WHERE provider = ? AND thread_id = ?
  `).get(task.provider, task.threadId)?.turn_id, null);
  database.close();
  store.close();
});

test("startup repairs already corrupted terminal rows and synthetic root duplicates", async () => {
  const filePath = await storeFile();
  const databaseFile = path.join(path.dirname(filePath), "journal.sqlite");
  let store = new LocalTaskSyncStore({ filePath, databaseFile });
  await store.load();
  store.recordHistory(task, [
    {
      id: "turn-aborted",
      prompt: "Старый общий prompt",
      status: "inProgress",
      active: true,
      completed: false,
      messages: [
        {
          itemId: "official-root",
          clientUserMessageId: "client-root",
          role: "user",
          text: "Старый общий prompt",
          attachments: [{ id: "screen.png", name: "screen.png", type: "image/png" }],
        },
        {
          itemId: "turn-aborted:rollout-user:0",
          role: "user",
          text: "Старый общий prompt",
        },
      ],
    },
    {
      id: "turn-completed",
      prompt: "Неверный prompt",
      status: "inProgress",
      active: true,
      completed: false,
      messages: [
        {
          itemId: "replayed-root",
          clientUserMessageId: "client-root",
          role: "user",
          text: "Старый общий prompt",
        },
        {
          itemId: "turn-completed:rollout-user:1",
          role: "user",
          text: "Фактический вопрос",
        },
      ],
    },
    {
      id: "turn-current",
      prompt: "Текущий вопрос",
      answer: "Работаю",
      status: "inProgress",
      active: true,
      completed: false,
    },
    {
      id: "internal-goal",
      prompt: '<codex_internal_context source="goal">служебное</codex_internal_context>',
      answer: "Служебное продолжение",
      status: "completed",
      active: false,
      completed: true,
    },
  ], {
    active: true,
    turnId: "turn-current",
    executionOwner: TASK_EXECUTION_OWNERS.DESKTOP,
    activityAtMs: 20_000,
  }, 20_000);
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
  const insert = database.prepare(`
    INSERT INTO journal_records
      (provider, thread_id, turn_id, project_root, task_thread_id, completed_at_ms, record_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  insert.run(task.provider, task.threadId, "turn-aborted", task.projectRoot, task.threadId, 21_000,
    JSON.stringify({
      status: "aborted",
      prompt: "Вопрос со скриншотом",
      body: "Ход остановлен пользователем.",
      startedAt: "2026-08-15T15:00:00.000Z",
      completedAt: "2026-08-15T15:00:01.000Z",
    }));
  insert.run(task.provider, task.threadId, "turn-completed", task.projectRoot, task.threadId, 22_000,
    JSON.stringify({
      status: "completed",
      prompt: "Фактический вопрос",
      body: "Ход завершён.",
      startedAt: "2026-08-15T15:01:00.000Z",
      completedAt: "2026-08-15T15:02:00.000Z",
    }));
  database.close();

  store = new LocalTaskSyncStore({
    filePath,
    databaseFile,
    canonicalizeProjectRoot: () => {
      throw new Error("task state wiring is not bound");
    },
  });
  await store.load();
  const history = store.history(task);
  assert.deepEqual(history.map((turn) => ({
    id: turn.id,
    prompt: turn.prompt,
    status: turn.status,
    active: turn.active,
    completed: turn.completed,
  })), [
    { id: "turn-aborted", prompt: "Вопрос со скриншотом", status: "aborted", active: false, completed: true },
    { id: "turn-completed", prompt: "Фактический вопрос", status: "completed", active: false, completed: true },
    { id: "turn-current", prompt: "Текущий вопрос", status: "inProgress", active: true, completed: false },
  ]);
  assert.equal(history[0].messages.length, 1);
  assert.equal(history[0].messages[0].clientUserMessageId, "client-root");
  assert.deepEqual(history[0].messages[0].attachments, [
    { id: "screen.png", name: "screen.png", type: "image/png" },
  ]);
  assert.deepEqual(history[1].messages.map((message) => message.itemId), [
    "turn-completed:rollout-user:1",
  ]);
  assert.deepEqual(store.snapshot(task, { nowMs: 20_000 }), {
    active: true,
    completed: false,
    turnId: "turn-current",
    activityAtMs: 20_000,
    executionOwner: TASK_EXECUTION_OWNERS.DESKTOP,
    stage: "",
    answer: "",
  });
  store.close();
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

test("task sync pages multiple Thread histories directly in SQLite", async () => {
  const filePath = await storeFile();
  const store = new LocalTaskSyncStore({ filePath, historyLimit: 100 });
  await store.load();
  const references = [
    { provider: "codex", threadId: "thread-old" },
    { provider: "claude", threadId: "thread-current" },
  ];
  for (const reference of references) {
    const currentTask = { ...task, ...reference };
    store.recordCatalog([currentTask]);
    store.recordHistory(currentTask, Array.from({ length: 4 }, (_, index) => ({
      id: `${reference.threadId}-turn-${index}`,
      prompt: `Вопрос ${reference.threadId} ${index}`,
      answer: `Ответ ${reference.threadId} ${index}`,
      status: "completed",
      completed: true,
      startedAt: `2026-08-28T0${index + (reference.provider === "claude" ? 4 : 0)}:00:00.000Z`,
      messages: [
        { itemId: `${reference.threadId}-user-${index}`, role: "user", text: `Вопрос ${index}` },
        { itemId: `${reference.threadId}-agent-${index}`, role: "agent", phase: "final", text: `Ответ ${index}` },
      ],
    })));
  }
  const hiddenTask = { ...task, provider: "codex", threadId: "thread-old" };
  store.recordHistory(hiddenTask, [
    ...store.history(hiddenTask),
    {
      id: "auto-compact-hidden",
      prompt: "Служебный перенос",
      answer: "Скрыто",
      status: "completed",
      completed: true,
      startedAt: "2026-08-28T09:00:00.000Z",
      messages: [{ itemId: "hidden-agent", role: "agent", text: "Скрыто" }],
    },
  ]);

  const page = store.historyPage(references, {
    before: 7,
    limit: 3,
    hiddenProvider: "codex",
    hiddenTurnIdPrefixes: ["auto-compact-"],
  });

  assert.equal(page.total, 8);
  assert.equal(page.messageTotal, 16);
  assert.equal(page.start, 4);
  assert.equal(page.end, 7);
  assert.deepEqual(page.items.map(({ provider, threadId, turn }) => ({
    provider,
    threadId,
    id: turn.id,
  })), [
    { provider: "claude", threadId: "thread-current", id: "thread-current-turn-0" },
    { provider: "claude", threadId: "thread-current", id: "thread-current-turn-1" },
    { provider: "claude", threadId: "thread-current", id: "thread-current-turn-2" },
  ]);
});
