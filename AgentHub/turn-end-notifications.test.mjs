import assert from "node:assert/strict";
import test from "node:test";

import {
  TURN_END_TITLE_LIMIT,
  TurnEndNotificationRegistry,
  turnEndKey,
} from "./turn-end-notifications.mjs";

function message(overrides = {}) {
  return {
    provider: "codex",
    threadId: "thread-1",
    projectRoot: process.cwd(),
    taskTitle: "Задача",
    chatId: 42,
    category: "done",
    title: "Краткий итог",
    text: "Готово",
    workLogId: "123e4567-e89b-42d3-a456-426614174000",
    ...overrides,
  };
}

function completion(overrides = {}) {
  return {
    provider: "codex",
    threadId: "thread-1",
    turnId: "turn-1",
    projectRoot: process.cwd(),
    taskTitle: "Задача",
    chatId: 42,
    status: "completed",
    startedAt: "2026-07-27T00:00:00.000Z",
    prompt: "Сделай задачу",
    usageReported: true,
    usage: {
      inputTokens: 10,
      cachedInputTokens: 8,
      outputTokens: 2,
      reasoningOutputTokens: 1,
      totalTokens: 12,
    },
    ...overrides,
  };
}

test("turn-end registry binds a deferred message to the completed turn", () => {
  const registry = new TurnEndNotificationRegistry();
  registry.registerMessage(message({ turnId: "turn-1", taskTitle: "Новое название" }));
  const ready = registry.recordCompletion(completion({ taskTitle: "Старое название" }));
  assert.equal(ready.message.text, "Готово");
  assert.equal(ready.message.title, "Краткий итог");
  assert.equal(ready.message.workLogId, "123e4567-e89b-42d3-a456-426614174000");
  assert.equal(ready.taskTitle, "Новое название");
  assert.equal(ready.usage.inputTokens, 10);
  assert.equal(ready.prompt, "Сделай задачу");
});

test("late deferred message refreshes the completed task title", () => {
  const registry = new TurnEndNotificationRegistry();
  registry.recordCompletion(completion({ taskTitle: "Старое название" }));
  registry.registerMessage(message({ turnId: "turn-1", taskTitle: "Новое название" }));
  assert.equal(registry.get(completion()).taskTitle, "Новое название");
});

test("completed Codex image generation without token events receives a rough estimate", () => {
  const registry = new TurnEndNotificationRegistry();
  const ready = registry.recordCompletion(completion({
    usageReported: false,
    usage: {},
    prompt: "Нарисуй чёрную дыру — это будет фон журнала",
  }));
  assert.equal(ready.usageReported, false);
  assert.equal(ready.estimatedUnits, 720_000);
  assert.equal(ready.estimateKind, "imagegen-default");
});

test("turn-end titles retain up to 100 characters", () => {
  const registry = new TurnEndNotificationRegistry();
  registry.registerMessage(message({
    threadId: "thread-title",
    turnId: "turn-title",
    title: "Т".repeat(200),
  }));
  const ready = registry.recordCompletion(completion({
    threadId: "thread-title",
    turnId: "turn-title",
  }));
  assert.equal(TURN_END_TITLE_LIMIT, 100);
  assert.equal(ready.message.title.length, 100);
});

test("turn-end registry deduplicates a delivered turn", () => {
  const registry = new TurnEndNotificationRegistry();
  const value = completion();
  registry.recordCompletion(value);
  registry.markDelivered(value);
  assert.equal(registry.hasDelivered(value), true);
  assert.equal(registry.recordCompletion(value), null);
});

test("turn-end registry persists pending, completed and delivered state", () => {
  const registry = new TurnEndNotificationRegistry();
  registry.registerMessage(message({ threadId: "thread-pending", turnId: "turn-pending" }));
  registry.recordCompletion(completion());
  const delivered = completion({ threadId: "thread-delivered", turnId: "turn-delivered" });
  registry.recordCompletion(delivered);
  registry.markDelivered(delivered);

  const restored = new TurnEndNotificationRegistry(registry.snapshot());
  assert.equal(restored.get(turnEndKey(completion())).turnId, "turn-1");
  assert.equal(restored.hasDelivered(delivered), true);
  const pendingReady = restored.recordCompletion(completion({
    threadId: "thread-pending",
    turnId: "turn-pending",
  }));
  assert.equal(pendingReady.message.text, "Готово");
});

test("turn-end registry rejects ambiguous messages and removes legacy FIFO entries on restore", () => {
  const registry = new TurnEndNotificationRegistry({
    pending: [message({ text: "Старая запись без turn ID" })],
  });
  assert.throws(
    () => registry.registerMessage(message()),
    /exact turn ID/,
  );
  assert.equal(registry.recordCompletion(completion()).message, null);
  assert.deepEqual(registry.snapshot().pending, []);
});

test("turn-end registry removes expired exact pending messages", () => {
  const now = Date.parse("2026-07-27T00:00:00.000Z");
  const registry = new TurnEndNotificationRegistry({
    pending: [message({
      turnId: "turn-old",
      createdAt: "2026-07-19T00:00:00.000Z",
    })],
  }, { now: () => now });
  assert.deepEqual(registry.snapshot().pending, []);
});

test("exact turn messages remain attached during parallel completions", () => {
  const registry = new TurnEndNotificationRegistry();
  registry.registerMessage(message({ turnId: "turn-2", text: "Второй" }));
  registry.registerMessage(message({ turnId: "turn-1", text: "Первый" }));
  assert.equal(registry.recordCompletion(completion({ turnId: "turn-1" })).message.text, "Первый");
  assert.equal(registry.recordCompletion(completion({ turnId: "turn-2" })).message.text, "Второй");
});

test("a delivered turn can consume a late exact message for journal correction", () => {
  const registry = new TurnEndNotificationRegistry();
  const identity = { provider: "codex", threadId: "thread-1", turnId: "turn-1" };
  registry.recordCompletion(completion({ ...identity, usageReported: true }));
  registry.markDelivered(identity);
  registry.registerMessage(message({
    ...identity,
    title: "Правильный итог",
    text: "Ход завершён штатно.",
  }));
  const [pending] = registry.snapshot().pending;

  assert.deepEqual(registry.takePendingMessage(identity), {
    provider: "codex",
    threadId: "thread-1",
    id: pending.id,
    turnId: "turn-1",
    projectRoot: pending.projectRoot,
    taskTitle: pending.taskTitle,
    chatId: pending.chatId,
    category: "done",
    silent: false,
    workLogId: pending.workLogId,
    title: "Правильный итог",
    text: "Ход завершён штатно.",
    createdAt: pending.createdAt,
  });
  assert.equal(registry.snapshot().pending.length, 0);
});

test("a provisional delivered turn can be retracted before its real terminal", () => {
  const registry = new TurnEndNotificationRegistry();
  const value = completion({ provisional: true });
  registry.recordCompletion(value);
  registry.markDelivered(value);
  registry.retract(value);

  assert.equal(registry.hasDelivered(value), false);
  assert.equal(registry.get(value), null);
  assert.notEqual(registry.recordCompletion(completion()), null);
});
