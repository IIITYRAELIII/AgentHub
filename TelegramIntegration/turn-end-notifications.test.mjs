import assert from "node:assert/strict";
import test from "node:test";

import {
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
  registry.registerMessage(message());
  const ready = registry.recordCompletion(completion());
  assert.equal(ready.message.text, "Готово");
  assert.equal(ready.message.workLogId, "123e4567-e89b-42d3-a456-426614174000");
  assert.equal(ready.usage.inputTokens, 10);
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
  registry.registerMessage(message({ threadId: "thread-pending" }));
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

test("exact turn messages remain attached during parallel completions", () => {
  const registry = new TurnEndNotificationRegistry();
  registry.registerMessage(message({ turnId: "turn-2", text: "Второй" }));
  registry.registerMessage(message({ turnId: "turn-1", text: "Первый" }));
  assert.equal(registry.recordCompletion(completion({ turnId: "turn-1" })).message.text, "Первый");
  assert.equal(registry.recordCompletion(completion({ turnId: "turn-2" })).message.text, "Второй");
});
