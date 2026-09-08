import assert from "node:assert/strict";
import { access, appendFile, copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { codexAssistantResponseProjection } from "../../src/domain/codex-response-annotation.mjs";
import { mergeCanonicalUserMessages } from "../../src/domain/canonical-user-messages.mjs";
import { TASK_EXECUTION_OWNERS } from "../../src/domain/task-execution-owner.mjs";
import { LocalTaskSyncStore } from "../../src/infrastructure/persistence/task-sync-store.mjs";
import { mergeDurableTaskHistory } from "../../src/interfaces/desktop/desktop-task-history.mjs";
import { readCodexRolloutActivity } from "../../src/providers/codex/codex-rollout-activity.mjs";

const task = {
  provider: "codex",
  threadId: "019f70ed-d8e8-7b21-bcd1-b6f57bcdf013",
  projectRoot: "C:\\Projects\\Main",
  projectName: "Main",
  title: "FB Фаровон обмен1",
};

const ANNOTATION_SOURCE = {
  version: 1,
  provider: "codex",
  threadId: "source-thread",
  turnId: "source-turn",
  itemId: "source-item",
  role: "agent",
  messageKey: "provider\u001fcodex\u001fsource-thread\u001fsource-turn\u001fsource-item\u001fagent",
  surfaceKind: "trace-reasoning",
  surfaceIndex: 1,
  start: 2,
  end: 19,
  contentHash: `sha256:${"a".repeat(64)}`,
  surfaceHash: `sha256:${"b".repeat(64)}`,
  selectionHash: `sha256:${"c".repeat(64)}`,
};
const USER_ANNOTATION_SOURCE = {
  ...ANNOTATION_SOURCE,
  turnId: "source-user-turn",
  itemId: "source-user-item",
  role: "user",
  messageKey: "provider\u001fcodex\u001fsource-thread\u001fsource-user-turn\u001fsource-user-item\u001fuser",
  surfaceKind: "message-body",
  surfaceIndex: 0,
};

test("task read model resolves exact durable pin candidates", async (t) => {
  const filePath = await storeFile();
  const store = new LocalTaskSyncStore({ filePath });
  await store.load();
  t.after(async () => {
    store.close();
    await rm(path.dirname(filePath), { recursive: true, force: true });
  });
  store.recordHistory(task, [{
    id: "turn-pinned",
    status: "completed",
    completed: true,
    startedAt: "2026-09-06T10:00:00.000Z",
    completedAt: "2026-09-06T10:01:00.000Z",
    messages: [
      { itemId: "user-pinned", role: "user", clientUserMessageId: "command-pinned", text: "Сделай" },
      { itemId: "agent-progress", role: "agent", text: "Делаю" },
      { itemId: "agent-pinned", role: "agent", text: "Готово" },
    ],
  }], {}, Date.now());

  const user = store.durableMessageCandidate({
    provider: task.provider,
    threadId: task.threadId,
    turnId: "turn-pinned",
    itemId: "user-pinned",
    role: "user",
  });
  const progress = store.durableMessageCandidate({
    provider: task.provider,
    threadId: task.threadId,
    turnId: "turn-pinned",
    itemId: "agent-progress",
    role: "agent",
  });
  const answer = store.durableMessageCandidate({
    provider: task.provider,
    threadId: task.threadId,
    turnId: "turn-pinned",
    itemId: "agent-pinned",
    role: "agent",
  });
  assert.equal(user.pinEligible, true);
  assert.equal(progress.pinEligible, false);
  assert.equal(answer.pinEligible, true);
  assert.notEqual(user.messageKey, answer.messageKey);
});

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
    userMessageSnapshotAuthority: "complete",
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
  assert.equal(restored.history(task)[0].userMessageSnapshotAuthority, "complete");
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

test("history refresh preserves exact backfilled chronology without identity heuristics", async () => {
  const filePath = await storeFile();
  const store = new LocalTaskSyncStore({ filePath });
  await store.load();
  try {
    store.recordHistory(task, [{
      id: "legacy-turn",
      prompt: "Старый запрос",
      answer: "Старый ответ",
      completed: true,
      startedAt: "2026-08-05T17:03:22.000Z",
      completedAt: "2026-08-05T17:10:41.000Z",
      messages: [
        { itemId: "legacy-user", role: "user", text: "Старый запрос", time: "2026-08-05T17:03:22.000Z" },
        { itemId: "legacy-agent", role: "agent", text: "Старый ответ", time: "2026-08-05T17:10:41.000Z" },
      ],
    }]);

    store.recordHistory(task, [{
      id: "legacy-turn",
      prompt: "Старый запрос",
      answer: "Старый ответ",
      completed: true,
      messages: [
        { itemId: "legacy-user", role: "user", text: "Старый запрос" },
        { itemId: "legacy-agent", role: "agent", text: "Старый ответ" },
      ],
    }, {
      id: "different-turn",
      prompt: "Старый запрос",
      answer: "Старый ответ",
      completed: true,
      messages: [
        { itemId: "different-user", role: "user", text: "Старый запрос" },
        { itemId: "different-agent", role: "agent", text: "Старый ответ" },
      ],
    }]);

    const [legacy, different] = store.history(task);
    assert.equal(legacy.startedAt, "2026-08-05T17:03:22.000Z");
    assert.equal(legacy.completedAt, "2026-08-05T17:10:41.000Z");
    assert.deepEqual(legacy.messages.map((message) => message.time), [
      "2026-08-05T17:03:22.000Z",
      "2026-08-05T17:10:41.000Z",
    ]);
    assert.equal(different.startedAt ?? null, null);
    assert.deepEqual(different.messages.map((message) => message.time ?? null), [null, null]);
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
    promptAnnotations: [
      { text: "Цитата из ответа", annotation: "Почему так?", source: ANNOTATION_SOURCE },
      { text: "Цитата пользователя", annotation: "Сверить", source: USER_ANNOTATION_SOURCE },
    ],
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
      responseAnnotations: [
        { text: "Цитата из ответа", annotation: "Почему так?", source: ANNOTATION_SOURCE },
        { text: "Цитата пользователя", annotation: "Сверить", source: USER_ANNOTATION_SOURCE },
      ],
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
    }, {
      itemId: "agent-1",
      role: "agent",
      text: "Цитата 1\nВижу",
      responseAnnotationReferences: [
        { index: 1 },
        { index: 1 },
        { index: 21 },
        { index: Number.MAX_SAFE_INTEGER + 1 },
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
    { text: "Цитата из ответа", annotation: "Почему так?", source: ANNOTATION_SOURCE },
    { text: "Цитата пользователя", annotation: "Сверить", source: USER_ANNOTATION_SOURCE },
  ]);
  assert.equal(entry.promptRequest, "Почему так?");
  assert.deepEqual(entry.messages[0].responseAnnotations, [
    { text: "Цитата из ответа", annotation: "Почему так?", source: ANNOTATION_SOURCE },
    { text: "Цитата пользователя", annotation: "Сверить", source: USER_ANNOTATION_SOURCE },
  ]);
  assert.equal(entry.messages[0].responseAnnotationRequest, "Почему так?");
  assert.deepEqual(entry.messages[1].responseAnnotationReferences, [{ index: 1 }]);
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

test("terminal citation coalescing survives SQLite reopen", async () => {
  const filePath = await storeFile();
  const turnId = "turn-terminal-citation";
  const [turn] = mergeDurableTaskHistory([{
    id: turnId,
    messages: [{
      itemId: "provider-final-item",
      role: "agent",
      phase: "final_answer",
      text: "Цитата 1\nГотово",
      responseAnnotationReferences: [{ index: 1 }],
    }],
  }], [{
    id: turnId,
    messages: [{
      itemId: `${turnId}:rollout-agent:final`,
      role: "agent",
      text: "Цитата 1\nГотово",
    }],
  }]);
  const store = new LocalTaskSyncStore({ filePath });
  await store.load();
  store.recordHistory(task, [turn]);
  await store.save();
  store.close();

  const restored = new LocalTaskSyncStore({ filePath });
  await restored.load();
  const [persisted] = restored.history(task);
  const agentMessages = persisted.messages.filter((message) => message.role === "agent");
  assert.equal(agentMessages.length, 1);
  assert.equal(agentMessages[0].itemId, `${turnId}:rollout-agent:final`);
  assert.deepEqual(agentMessages[0].responseAnnotationReferences, [{ index: 1 }]);
  restored.close();
});

test("canonical terminal overlay preserves provider citation refs through SQLite reopen", async () => {
  const filePath = await storeFile();
  const turnId = "turn-terminal-overlay";
  const store = new LocalTaskSyncStore({ filePath });
  await store.load();
  store.recordHistory(task, [{
    id: turnId,
    status: "completed",
    completed: true,
    messages: [{
      itemId: "msg_provider_final",
      role: "agent",
      text: "Цитата 1\nГотово",
      responseAnnotationReferences: [{ index: 1 }],
    }],
  }]);
  store.recordHistory(task, [{
    id: turnId,
    status: "completed",
    completed: true,
    messages: [{
      itemId: `${turnId}:rollout-agent:final`,
      role: "agent",
      phase: "final_answer",
      text: "Цитата 1\nГотово",
    }],
  }]);
  await store.save();
  store.close();

  const restored = new LocalTaskSyncStore({ filePath });
  await restored.load();
  const [persisted] = restored.history(task);
  const agentMessages = persisted.messages.filter((message) => message.role === "agent");
  assert.equal(agentMessages.length, 1);
  assert.equal(agentMessages[0].itemId, `${turnId}:rollout-agent:final`);
  assert.deepEqual(agentMessages[0].responseAnnotationReferences, [{ index: 1 }]);
  restored.close();
});

test("terminal citation metadata is not transferred to a wrong or ambiguous identity", async () => {
  const filePath = await storeFile();
  const store = new LocalTaskSyncStore({ filePath });
  await store.load();
  store.recordHistory(task, [{
    id: "turn-wrong-terminal-identity",
    status: "completed",
    completed: true,
    messages: [{
      itemId: "msg_wrong_identity_source",
      role: "agent",
      text: "Цитата 1",
      responseAnnotationReferences: [{ index: 1 }],
    }],
  }, {
    id: "turn-ambiguous-terminal-identity",
    status: "completed",
    completed: true,
    messages: [{
      itemId: "msg_ambiguous_source_1",
      role: "agent",
      text: "Цитата 1",
      responseAnnotationReferences: [{ index: 1 }],
    }, {
      itemId: "msg_ambiguous_source_2",
      role: "agent",
      text: "Цитата 2",
      responseAnnotationReferences: [{ index: 2 }],
    }],
  }]);
  store.recordHistory(task, [{
    id: "turn-wrong-terminal-identity",
    status: "completed",
    completed: true,
    messages: [{
      itemId: "untrusted-final-item",
      role: "agent",
      text: "Цитата 1",
    }],
  }, {
    id: "turn-ambiguous-terminal-identity",
    status: "completed",
    completed: true,
    messages: [{
      itemId: "turn-ambiguous-terminal-identity:rollout-agent:final",
      role: "agent",
      text: "Цитата 1",
    }],
  }]);

  const wrongIdentity = store.history(task).find((turn) => turn.id === "turn-wrong-terminal-identity");
  const ambiguousIdentity = store.history(task).find((turn) => turn.id === "turn-ambiguous-terminal-identity");
  assert.deepEqual(wrongIdentity.messages[0].responseAnnotationReferences ?? [], []);
  assert.deepEqual(ambiguousIdentity.messages[0].responseAnnotationReferences ?? [], []);
  store.close();
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

test("SQLite history preserves the provider projection of malformed citation markers", async () => {
  const filePath = await storeFile();
  const projection = codexAssistantResponseProjection(
    ':codex-annotation{index="abc"} Nonnumeric\n:codex-annotation{index=""} Empty',
  );
  const store = new LocalTaskSyncStore({ filePath });
  await store.load();
  store.recordHistory(task, [{
    id: "turn-malformed-citation",
    prompt: "Проверь",
    answer: projection.text,
    status: "completed",
    completed: true,
    messages: [{ itemId: "user-1", role: "user", text: "Проверь" }, {
      itemId: "agent-1",
      role: "agent",
      text: projection.text,
      responseAnnotationReferences: projection.responseAnnotationReferences,
    }],
  }]);
  await store.save();

  const restored = new LocalTaskSyncStore({ filePath });
  await restored.load();
  const [entry] = restored.history(task);
  assert.equal(entry.messages[1].text, "Цитата\nNonnumeric\nЦитата\nEmpty");
  assert.deepEqual(entry.messages[1].responseAnnotationReferences ?? [], []);
  assert.equal(entry.messages[1].text.includes(":codex-annotation"), false);
  restored.close();
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
    { key: "backfill_task_message_search_version", value: "4" },
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

test("startup terminal backfill never erases a provider item based on its id shape", async () => {
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
  assert.equal(history[0].messages.length, 2);
  assert.equal(history[0].messages[0].clientUserMessageId, "client-root");
  assert.deepEqual(history[0].messages[0].attachments, [
    { id: "screen.png", name: "screen.png", type: "image/png" },
  ]);
  assert.equal(history[0].messages[1].itemId, "turn-aborted:rollout-user:0");
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

test("startup reprojects a corrupted terminal read model from exact terminal and ledger identities", async () => {
  const filePath = await storeFile();
  const directory = path.dirname(filePath);
  const databaseFile = path.join(directory, "journal.sqlite");
  const terminalDatabaseFile = path.join(directory, "runtime.sqlite");
  const messageCommandDatabaseFile = path.join(directory, "message-command-ledger.sqlite");
  const recoveryTask = { ...task, threadId: "production-corrupted-thread" };
  const conflictTask = { ...task, threadId: "conflicting-terminal-thread" };
  const duplicateTask = { ...task, threadId: "duplicate-terminal-thread" };
  const oversizedTask = { ...task, threadId: "oversized-terminal-thread" };
  const turnId = "production-corrupted-turn";
  const runId = "production-run";
  const conflictTurnId = "conflicting-terminal-turn";
  const conflictRunId = "conflicting-run";
  const duplicateTurnId = "duplicate-terminal-turn";
  const duplicateRunId = "duplicate-run";
  const oversizedTurnId = "oversized-terminal-turn";
  const oversizedRunId = "oversized-run";
  const oversizedClientUserMessageId = "oversized-client";
  const exactOrigin = {
    kind: "interstream",
    workspaceId: "source-workspace",
    workspaceName: "Source",
    streamId: "source-stream",
    streamName: "Review",
    provider: "codex",
    requestId: "source-request",
  };
  const canonicalUsers = Array.from({ length: 6 }, (_, index) => ({
    itemId: `owned-${index}`,
    clientUserMessageId: `accepted-${index}`,
    role: "user",
    text: index < 2 ? "Одинаковый текст" : `Сообщение ${index}`,
    submittedAt: `2026-09-03T20:0${index}:00.000Z`,
    ...(index === 2 ? { origin: exactOrigin } : {}),
  }));
  const authoritativeUsers = [
    ...canonicalUsers,
    { itemId: "provider-collision", role: "user", text: "External occurrence one" },
    { itemId: "provider-collision", role: "user", text: "External occurrence two" },
    { itemId: `${turnId}:rollout-user:0`, role: "user", text: "External without identity" },
  ];
  const invalidEvidence = ["runId", "provider", "threadId", "turnId"].map((field) => ({
    field,
    task: { ...task, threadId: `missing-${field}-thread` },
    turnId: `missing-${field}-turn`,
    runId: `missing-${field}-run`,
    clientUserMessageId: `missing-${field}-client`,
  }));
  let store = new LocalTaskSyncStore({
    filePath,
    databaseFile,
    terminalDatabaseFile,
    messageCommandDatabaseFile,
  });
  await store.load();
  store.recordHistory(recoveryTask, [{
    id: turnId,
    prompt: "Повреждённый tail",
    answer: "Финал",
    status: "completed",
    active: false,
    completed: true,
    messages: [
      { itemId: `${turnId}:rollout-user:0`, role: "user", text: "Сообщение 5" },
      { itemId: "provider-final", role: "agent", text: "Финал" },
    ],
  }]);
  store.recordHistory(conflictTask, [{
    id: conflictTurnId,
    prompt: "Нельзя угадывать",
    answer: "Финал",
    status: "completed",
    active: false,
    completed: true,
    messages: [{ itemId: "conflict-tail", role: "user", text: "Tail" }],
  }]);
  store.recordHistory(duplicateTask, [{
    id: duplicateTurnId,
    prompt: "Нельзя принимать duplicate identity",
    answer: "Финал",
    status: "completed",
    active: false,
    completed: true,
    messages: [{ itemId: "duplicate-tail", role: "user", text: "Tail" }],
  }]);
  store.recordHistory(oversizedTask, [{
    id: oversizedTurnId,
    prompt: "Oversized terminal must not repair",
    answer: "Финал",
    status: "completed",
    active: false,
    completed: true,
    messages: [{ itemId: "oversized-tail", role: "user", text: "Tail" }],
  }]);
  for (const invalid of invalidEvidence) {
    store.recordHistory(invalid.task, [{
      id: invalid.turnId,
      prompt: `Не применять без ${invalid.field}`,
      answer: "Финал",
      status: "completed",
      active: false,
      completed: true,
      messages: [{ itemId: `${invalid.field}-tail`, role: "user", text: "Tail" }],
    }]);
  }
  store.close();

  const searchDatabase = new DatabaseSync(databaseFile);
  searchDatabase.prepare(`
    INSERT INTO task_message_search_documents (
      document_key, provider, thread_id, turn_thread_id, turn_id, item_id,
      role, message_text, author, annotation_text, attachment_names,
      occurred_at, occurred_at_ms, source
    ) VALUES (?, ?, ?, ?, ?, ?, 'agent', 'Journal evidence', '', '', '', NULL, 0, 'journal')
  `).run(
    JSON.stringify(["codex", recoveryTask.threadId, turnId, `${turnId}:journal`, "agent", "journal", ""]),
    "codex",
    recoveryTask.threadId,
    recoveryTask.threadId,
    turnId,
    `${turnId}:journal`,
  );
  searchDatabase.close();

  const terminalDatabase = new DatabaseSync(terminalDatabaseFile);
  terminalDatabase.exec(`
    CREATE TABLE provider_turn_terminals (
      provider TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      payload_bytes INTEGER NOT NULL,
      committed_at TEXT NOT NULL,
      PRIMARY KEY (provider, thread_id, turn_id)
    ) WITHOUT ROWID;
    CREATE INDEX provider_turn_terminals_recovery_idx
      ON provider_turn_terminals(committed_at DESC, provider, thread_id, turn_id, payload_bytes)
  `);
  const insertTerminalRow = terminalDatabase.prepare(`
    INSERT INTO provider_turn_terminals (
      provider, thread_id, turn_id, payload_json, payload_bytes, committed_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `);
  const addTerminalRow = (threadId, exactTurnId, payload, committedAt) => {
    const payloadJson = JSON.stringify(payload);
    insertTerminalRow.run(
      "codex",
      threadId,
      exactTurnId,
      payloadJson,
      Buffer.byteLength(payloadJson, "utf8"),
      committedAt,
    );
  };
  addTerminalRow(recoveryTask.threadId, turnId, {
    history: {
      id: runId,
      provider: "codex",
      threadId: recoveryTask.threadId,
      turnId,
      promptPreview: "Канонический root",
      userMessages: authoritativeUsers,
    },
  }, "2026-09-03T21:35:11.402Z");
  addTerminalRow(conflictTask.threadId, conflictTurnId, {
    history: {
      id: conflictRunId,
      provider: "codex",
      threadId: conflictTask.threadId,
      turnId: conflictTurnId,
      promptPreview: "Не применять",
      userMessages: [
        { itemId: "conflict-0", clientUserMessageId: "conflict-0", role: "user", text: "Первое" },
        { itemId: "conflict-1", clientUserMessageId: "conflict-1", role: "user", text: "Второе" },
      ],
    },
  }, "2026-09-03T21:35:12.402Z");
  addTerminalRow(duplicateTask.threadId, duplicateTurnId, {
    history: {
      id: duplicateRunId,
      provider: "codex",
      threadId: duplicateTask.threadId,
      turnId: duplicateTurnId,
      promptPreview: "Не применять duplicate",
      userMessages: [
        { itemId: "duplicate-a", clientUserMessageId: "duplicate-client", role: "user", text: "Первое" },
        { itemId: "duplicate-b", clientUserMessageId: "duplicate-client", role: "user", text: "Второе" },
      ],
    },
  }, "2026-09-03T21:35:12.902Z");
  for (const invalid of invalidEvidence) {
    addTerminalRow(invalid.task.threadId, invalid.turnId, {
      history: {
        id: invalid.runId,
        provider: "codex",
        threadId: invalid.task.threadId,
        turnId: invalid.turnId,
        promptPreview: "Не применять",
        userMessages: [{
          itemId: invalid.clientUserMessageId,
          clientUserMessageId: invalid.clientUserMessageId,
          role: "user",
          text: "Недоказанное сообщение",
        }],
      },
    }, "2026-09-03T21:35:13.402Z");
  }
  addTerminalRow(oversizedTask.threadId, oversizedTurnId, {
    history: {
      id: oversizedRunId,
      provider: "codex",
      threadId: oversizedTask.threadId,
      turnId: oversizedTurnId,
      promptPreview: "Must be skipped before parse",
      userMessages: [{
        itemId: oversizedClientUserMessageId,
        clientUserMessageId: oversizedClientUserMessageId,
        role: "user",
        text: "Oversized authoritative candidate",
      }],
    },
    hostilePadding: "x".repeat(2 * 1024 * 1024),
  }, "2026-09-03T21:35:13.402Z");
  terminalDatabase.close();

  const ledgerDatabase = new DatabaseSync(messageCommandDatabaseFile);
  ledgerDatabase.exec(`
    CREATE TABLE message_commands (
      client_user_message_id TEXT PRIMARY KEY,
      state TEXT NOT NULL,
      item_json TEXT,
      receipt_json TEXT,
      result_json TEXT
    ) WITHOUT ROWID
  `);
  const insertLedger = ledgerDatabase.prepare(`
    INSERT INTO message_commands (
      client_user_message_id, state, item_json, receipt_json, result_json
    ) VALUES (?, 'completed', ?, ?, ?)
  `);
  for (const user of canonicalUsers) {
    const exact = {
      provider: "codex",
      threadId: recoveryTask.threadId,
      turnId,
      runId,
      clientUserMessageId: user.clientUserMessageId,
    };
    insertLedger.run(
      user.clientUserMessageId,
      JSON.stringify(exact),
      JSON.stringify({ ...exact, result: exact }),
      JSON.stringify(exact),
    );
  }
  for (const clientUserMessageId of ["conflict-0", "conflict-1"]) {
    const exact = {
      provider: "codex",
      threadId: conflictTask.threadId,
      turnId: conflictTurnId,
      runId: conflictRunId,
      clientUserMessageId,
    };
    const result = clientUserMessageId === "conflict-1"
      ? { ...exact, turnId: "wrong-turn" }
      : exact;
    insertLedger.run(
      clientUserMessageId,
      JSON.stringify(exact),
      JSON.stringify({ ...exact, result }),
      JSON.stringify(result),
    );
  }
  for (const invalid of invalidEvidence) {
    const exact = {
      provider: "codex",
      threadId: invalid.task.threadId,
      turnId: invalid.turnId,
      runId: invalid.runId,
      clientUserMessageId: invalid.clientUserMessageId,
    };
    const incomplete = { ...exact };
    delete incomplete[invalid.field];
    insertLedger.run(
      invalid.clientUserMessageId,
      JSON.stringify(incomplete),
      JSON.stringify({ ...incomplete, result: incomplete }),
      JSON.stringify(incomplete),
    );
  }
  const duplicateExact = {
    provider: "codex",
    threadId: duplicateTask.threadId,
    turnId: duplicateTurnId,
    runId: duplicateRunId,
    clientUserMessageId: "duplicate-client",
  };
  insertLedger.run(
    "duplicate-client",
    JSON.stringify(duplicateExact),
    JSON.stringify({ ...duplicateExact, result: duplicateExact }),
    JSON.stringify(duplicateExact),
  );
  const oversizedExact = {
    provider: "codex",
    threadId: oversizedTask.threadId,
    turnId: oversizedTurnId,
    runId: oversizedRunId,
    clientUserMessageId: oversizedClientUserMessageId,
  };
  insertLedger.run(
    oversizedClientUserMessageId,
    JSON.stringify(oversizedExact),
    JSON.stringify({ ...oversizedExact, result: oversizedExact }),
    JSON.stringify(oversizedExact),
  );
  ledgerDatabase.close();

  const assertRecovered = (recoveredStore) => {
    const history = recoveredStore.history(recoveryTask);
    assert.equal(history.length, 1);
    assert.equal(history[0].prompt, "Канонический root");
    assert.equal(history[0].status, "completed");
    assert.equal(history[0].active, false);
    assert.equal(history[0].completed, true);
    assert.equal(history[0].userMessageAuthority, "terminal-ledger");
    assert.deepEqual(
      history[0].messages.filter((message) => message.role === "user")
        .map((message) => message.clientUserMessageId)
        .filter(Boolean),
      canonicalUsers.map((message) => message.clientUserMessageId),
    );
    assert.deepEqual(
      history[0].messages.filter((message) => message.role === "user")
        .map((message) => message.text),
      authoritativeUsers.map((message) => message.text),
    );
    assert.deepEqual(history[0].messages[2].origin, exactOrigin);
    assert.equal(history[0].messages.filter((message) => message.role === "agent").length, 1);
    const page = recoveredStore.historyPage([recoveryTask], { limit: 10 });
    assert.equal(page.items.length, 1);
    assert.equal(page.items[0].turn.messages.length, 10);
    const conflict = recoveredStore.history(conflictTask)[0];
    assert.equal("userMessageAuthority" in conflict, false);
    assert.equal(conflict.prompt, "Нельзя угадывать");
    assert.deepEqual(conflict.messages, [{
      itemId: "conflict-tail",
      role: "user",
      text: "Tail",
      responseAnnotations: [],
      attachments: [],
    }]);
    assert.deepEqual(recoveredStore.history(duplicateTask)[0].messages, [{
      itemId: "duplicate-tail",
      role: "user",
      text: "Tail",
      responseAnnotations: [],
      attachments: [],
    }]);
    assert.equal(
      "userMessageAuthority" in recoveredStore.history(duplicateTask)[0],
      false,
    );
    const oversized = recoveredStore.history(oversizedTask)[0];
    assert.equal("userMessageAuthority" in oversized, false);
    assert.equal(oversized.prompt, "Oversized terminal must not repair");
    assert.deepEqual(oversized.messages, [{
      itemId: "oversized-tail",
      role: "user",
      text: "Tail",
      responseAnnotations: [],
      attachments: [],
    }]);
    for (const invalid of invalidEvidence) {
      const retained = recoveredStore.history(invalid.task)[0];
      assert.equal("userMessageAuthority" in retained, false);
      assert.equal(retained.prompt, `Не применять без ${invalid.field}`);
      assert.deepEqual(retained.messages, [{
        itemId: `${invalid.field}-tail`,
        role: "user",
        text: "Tail",
        responseAnnotations: [],
        attachments: [],
      }]);
    }
    const searchVerification = new DatabaseSync(databaseFile, { readOnly: true });
    assert.deepEqual(searchVerification.prepare(`
      SELECT source, COUNT(*) AS count
      FROM task_message_search_documents
      WHERE provider = ? AND thread_id = ? AND turn_id = ?
      GROUP BY source ORDER BY source
    `).all("codex", recoveryTask.threadId, turnId).map((row) => ({
      source: row.source,
      count: Number(row.count),
    })), [
      { source: "history", count: 10 },
      { source: "journal", count: 1 },
    ]);
    searchVerification.close();
  };

  store = new LocalTaskSyncStore({
    filePath,
    databaseFile,
    terminalDatabaseFile,
    messageCommandDatabaseFile,
  });
  await store.load();
  assertRecovered(store);
  store.recordHistory(recoveryTask, [{
    id: turnId,
    prompt: "Устаревший terminal provider tail",
    answer: "Финал после hydration",
    status: "completed",
    active: false,
    completed: true,
    messages: [
      { itemId: `${turnId}:rollout-user:0`, role: "user", text: "Сообщение 5" },
      { itemId: "provider-final", role: "agent", text: "Финал после hydration" },
    ],
  }]);
  assertRecovered(store);
  store.close();

  store = new LocalTaskSyncStore({
    filePath,
    databaseFile,
    terminalDatabaseFile,
    messageCommandDatabaseFile,
  });
  await store.load();
  assertRecovered(store);
  store.close();

  store = new LocalTaskSyncStore({
    filePath,
    databaseFile,
    terminalDatabaseFile,
    messageCommandDatabaseFile,
  });
  await store.load();
  assertRecovered(store);
  store.close();

  const verification = new DatabaseSync(messageCommandDatabaseFile, { readOnly: true });
  assert.equal(verification.prepare("SELECT COUNT(*) AS count FROM message_commands").get().count, 14);
  verification.close();
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

test("task sync store preserves source occurrence identity across restart", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-source-occurrence-"));
  const filePath = path.join(root, "task-sync.json");
  const databaseFile = path.join(root, "journal.sqlite");
  const task = {
    provider: "codex",
    threadId: "source-occurrence-thread",
    projectRoot: root,
    projectName: "repo",
    title: "Source occurrence",
    updatedAtMs: 1,
  };
  const sourceOccurrenceId = `codex-rollout:${"9".repeat(64)}`;
  const origin = {
    kind: "interstream",
    workspaceId: "workspace-1",
    workspaceName: "Workspace",
    streamId: "persisted-owner",
    streamName: "Owner",
  };
  let store = new LocalTaskSyncStore({ filePath, databaseFile });
  await store.load();
  store.recordCatalog([task], 1);
  store.recordHistory(task, [{
    id: "source-occurrence-turn",
    userMessageSnapshotAuthority: "incremental",
    messages: [{ role: "user", text: "External", sourceOccurrenceId }],
  }]);
  store.recordHistory(task, [{
    id: "source-occurrence-turn",
    userMessageSnapshotAuthority: "incremental",
    messages: [{
      role: "user",
      text: "Accepted external",
      sourceOccurrenceId,
      clientUserMessageId: "accepted-source-occurrence",
      origin,
    }],
  }]);
  store.close();

  store = new LocalTaskSyncStore({ filePath, databaseFile });
  await store.load();
  assert.equal(store.history(task)[0].messages.length, 1);
  assert.equal(store.history(task)[0].messages[0].sourceOccurrenceId, sourceOccurrenceId);
  assert.equal(
    store.history(task)[0].messages[0].clientUserMessageId,
    "accepted-source-occurrence",
  );
  assert.deepEqual(store.history(task)[0].messages[0].origin, origin);
  assert.equal(store.history(task)[0].userMessageSnapshotAuthority, undefined);
  store.close();
});

test("task sync store preserves a third identical occurrence after the rollout tail moves", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-moving-tail-persistence-"));
  const filePath = path.join(root, "task-sync.json");
  const databaseFile = path.join(root, "journal.sqlite");
  const rollout = path.join(root, "rollout.jsonl");
  const task = {
    provider: "codex",
    threadId: "moving-tail-thread",
    projectRoot: root,
    projectName: "repo",
    title: "Moving tail",
    updatedAtMs: 1,
  };
  const session = JSON.stringify({
    type: "session_meta",
    payload: { id: "persisted-moving-tail", originator: "codex_vscode" },
  });
  const prefix = JSON.stringify({
    type: "event_msg",
    payload: { type: "agent_message", message: "p".repeat(2_048) },
  });
  const identical = JSON.stringify({
    type: "response_item",
    payload: {
      id: "colliding-provider-id",
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "Тот же prompt" }],
      internal_chat_message_metadata_passthrough: { turn_id: "moving-tail-turn" },
    },
  });
  const between = JSON.stringify({
    type: "event_msg",
    payload: { type: "agent_message", message: "b".repeat(80) },
  });
  const appendedGap = JSON.stringify({
    type: "event_msg",
    payload: { type: "agent_message", message: "n".repeat(40) },
  });
  const tailBytes = Buffer.byteLength(`${identical}\n${between}\n${identical}\n`, "utf8") + 32;
  await writeFile(
    rollout,
    `${session}\n${prefix}\n${identical}\n${between}\n${identical}\n`,
    "utf8",
  );
  const readMessages = async () => (
    (await readCodexRolloutActivity(rollout, { tailBytes, reparseTail: true }))
      .userMessages["moving-tail-turn"]
  );

  let store = new LocalTaskSyncStore({ filePath, databaseFile });
  await store.load();
  store.recordCatalog([task], 1);
  let projection = mergeCanonicalUserMessages([], await readMessages());
  store.recordHistory(task, [{
    id: "moving-tail-turn",
    userMessageSnapshotAuthority: "incremental",
    messages: projection,
  }]);
  assert.equal(store.history(task)[0].messages.length, 2);

  await appendFile(rollout, `${appendedGap}\n${identical}\n`, "utf8");
  const shiftedMessages = await readMessages();
  projection = mergeCanonicalUserMessages(projection, shiftedMessages);
  store.recordHistory(task, [{
    id: "moving-tail-turn",
    userMessageSnapshotAuthority: "incremental",
    messages: projection,
  }]);
  projection = mergeCanonicalUserMessages(projection, await readMessages());
  store.recordHistory(task, [{
    id: "moving-tail-turn",
    userMessageSnapshotAuthority: "incremental",
    messages: projection,
  }]);
  assert.equal(store.history(task)[0].messages.length, 3);
  assert.equal(new Set(
    store.history(task)[0].messages.map((message) => message.sourceOccurrenceId),
  ).size, 3);
  store.close();

  const coldRollout = path.join(root, "cold-rollout.jsonl");
  await copyFile(rollout, coldRollout);
  const coldMessages = (
    await readCodexRolloutActivity(coldRollout, { tailBytes, reparseTail: true })
  ).userMessages["moving-tail-turn"];
  assert.deepEqual(
    coldMessages.map((message) => message.sourceOccurrenceId),
    shiftedMessages.map((message) => message.sourceOccurrenceId),
    "a cold reader derives the same surviving raw occurrence identities",
  );
  store = new LocalTaskSyncStore({ filePath, databaseFile });
  await store.load();
  projection = mergeCanonicalUserMessages(store.history(task)[0].messages, coldMessages);
  store.recordHistory(task, [{
    id: "moving-tail-turn",
    userMessageSnapshotAuthority: "incremental",
    messages: projection,
  }]);
  assert.equal(store.history(task)[0].messages.length, 3);
  assert.equal(new Set(
    store.history(task)[0].messages.map((message) => message.sourceOccurrenceId),
  ).size, 3);
  store.close();
});

test("terminal identity recovery skips malformed newest rows within hard aggregate bounds", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-recovery-total-bound-"));
  const filePath = path.join(root, "task-sync.json");
  const databaseFile = path.join(root, "journal.sqlite");
  const terminalDatabaseFile = path.join(root, "runtime.sqlite");
  const messageCommandDatabaseFile = path.join(root, "message-command-ledger.sqlite");
  const tasks = Array.from({ length: 5 }, (_, index) => ({
    provider: "codex",
    threadId: `aggregate-thread-${index}`,
    projectRoot: root,
    projectName: "repo",
    title: `Aggregate ${index}`,
    updatedAtMs: index + 1,
    turnId: `aggregate-turn-${index}`,
    runId: `aggregate-run-${index}`,
    clientUserMessageId: `aggregate-client-${index}`,
  }));

  let store = new LocalTaskSyncStore({
    filePath,
    databaseFile,
    terminalDatabaseFile,
    messageCommandDatabaseFile,
  });
  await store.load();
  store.recordCatalog(tasks, 1);
  for (const task of tasks) {
    store.recordHistory(task, [{
      id: task.turnId,
      prompt: "Corrupted",
      status: "completed",
      completed: true,
      messages: [{ role: "user", text: "Unkeyed tail" }],
    }]);
  }
  store.close();

  const terminalDatabase = new DatabaseSync(terminalDatabaseFile);
  terminalDatabase.exec(`
    CREATE TABLE provider_turn_terminals (
      provider TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      payload_bytes INTEGER NOT NULL,
      committed_at INTEGER NOT NULL
    );
    CREATE INDEX provider_turn_terminals_recovery_idx
      ON provider_turn_terminals(committed_at DESC, provider, thread_id, turn_id, payload_bytes)
  `);
  const insertTerminal = terminalDatabase.prepare(`
    INSERT INTO provider_turn_terminals (
      provider, thread_id, turn_id, payload_json, payload_bytes, committed_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `);
  for (const [index, task] of tasks.entries()) {
    const validPayload = JSON.stringify({
      history: {
        id: task.runId,
        provider: "codex",
        threadId: task.threadId,
        turnId: task.turnId,
        userMessages: [{
          role: "user",
          text: "Canonical",
          clientUserMessageId: task.clientUserMessageId,
        }],
      },
      padding: "x".repeat(index < 3 ? 900_000 : 1_450_000),
    });
    insertTerminal.run(
      "codex",
      task.threadId,
      task.turnId,
      index >= 3 ? `{${"x".repeat(1_449_998)}` : validPayload,
      Buffer.byteLength(index >= 3 ? `{${"x".repeat(1_449_998)}` : validPayload, "utf8"),
      index + 1,
    );
  }
  terminalDatabase.close();

  const ledgerDatabase = new DatabaseSync(messageCommandDatabaseFile);
  ledgerDatabase.exec(`
    CREATE TABLE message_commands (
      client_user_message_id TEXT PRIMARY KEY,
      state TEXT NOT NULL,
      item_json TEXT,
      receipt_json TEXT,
      result_json TEXT
    ) WITHOUT ROWID
  `);
  const insertLedger = ledgerDatabase.prepare(`
    INSERT INTO message_commands (
      client_user_message_id, state, item_json, receipt_json, result_json
    ) VALUES (?, 'completed', ?, ?, ?)
  `);
  for (const task of tasks) {
    const exact = {
      provider: "codex",
      threadId: task.threadId,
      turnId: task.turnId,
      runId: task.runId,
      clientUserMessageId: task.clientUserMessageId,
    };
    insertLedger.run(
      task.clientUserMessageId,
      JSON.stringify(exact),
      JSON.stringify({ ...exact, result: exact }),
      JSON.stringify(exact),
    );
  }
  ledgerDatabase.close();

  const heartbeatGaps = [];
  let previousBeat = performance.now();
  const heartbeat = setInterval(() => {
    const now = performance.now();
    heartbeatGaps.push(now - previousBeat);
    previousBeat = now;
  }, 5);
  await new Promise((resolve) => setTimeout(resolve, 15));
  const startedAt = performance.now();
  store = new LocalTaskSyncStore({
    filePath,
    databaseFile,
    terminalDatabaseFile,
    messageCommandDatabaseFile,
  });
  await store.load();
  const elapsedMs = performance.now() - startedAt;
  await new Promise((resolve) => setTimeout(resolve, 15));
  clearInterval(heartbeat);

  assert.equal(store.history(tasks[4])[0].userMessageAuthority, undefined);
  assert.equal(store.history(tasks[3])[0].userMessageAuthority, undefined);
  assert.equal(store.history(tasks[2])[0].userMessageAuthority, "terminal-ledger");
  assert.equal(store.history(tasks[1])[0].userMessageAuthority, "terminal-ledger");
  assert.equal(store.history(tasks[0])[0].userMessageAuthority, "terminal-ledger");
  assert.ok(elapsedMs < 1_000, `bounded recovery took ${elapsedMs.toFixed(1)}ms`);
  assert.ok(Math.max(...heartbeatGaps) < 1_000, "bounded recovery must not starve heartbeat for 1s");
  store.close();

  store = new LocalTaskSyncStore({
    filePath,
    databaseFile,
    terminalDatabaseFile,
    messageCommandDatabaseFile,
  });
  await store.load();
  assert.deepEqual(
    tasks.map((item) => store.history(item)[0].userMessageAuthority ?? null),
    ["terminal-ledger", "terminal-ledger", "terminal-ledger", null, null],
    "reopen must stay idempotent while malformed newest rows remain present",
  );
  store.close();
});
