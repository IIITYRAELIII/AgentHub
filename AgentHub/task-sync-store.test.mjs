import assert from "node:assert/strict";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { TASK_EXECUTION_OWNERS } from "./task-catalog.mjs";
import { LocalTaskSyncStore } from "./task-sync-store.mjs";

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
    updatedAtMs: 100,
    running: true,
    executionOwner: TASK_EXECUTION_OWNERS.VSCODE,
    turnId: "turn-vsc",
    lastActivityAtMs: 1_000,
  }]);
  assert.equal(restored.history(task)[0].answer, "Выполняю");
  assert.equal(restored.snapshot(task).stage, "Изменяются файлы");
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
    startedAt: "2026-07-31T12:00:00.000Z",
    completedAt: "2026-07-31T12:01:00.000Z",
    attachments: [{ id: "screen.png", name: "screen.png", type: "image/png" }],
    activities: [{ id: "tool-1", type: "tool", label: "Проверка", status: "completed" }],
    messages: [{
      itemId: "user-1",
      clientUserMessageId: "client-1",
      role: "user",
      text: "Посмотри скриншот",
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
  assert.deepEqual(entry.messages[0].attachments, [
    { id: "screen.png", name: "screen.png", type: "image/png" },
  ]);
  assert.equal(entry.activities[0].label, "Проверка");
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
