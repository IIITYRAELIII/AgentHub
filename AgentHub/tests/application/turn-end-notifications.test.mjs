import assert from "node:assert/strict";
import test from "node:test";

import {
  TURN_END_TITLE_LIMIT,
  TurnEndNotificationRegistry,
  turnEndKey,
} from "../../src/application/turn-end-notifications.mjs";

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
    model: "gpt-5.6-sol",
    serviceTier: "default",
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
  const ready = registry.recordCompletion(completion({
    taskTitle: "Старое название",
    diff: "diff --git a/a.mjs b/a.mjs\n+const ready = true;",
  }));
  assert.equal(ready.message.text, "Готово");
  assert.equal(ready.message.title, "Краткий итог");
  assert.equal(ready.message.workLogId, "123e4567-e89b-42d3-a456-426614174000");
  assert.equal(ready.taskTitle, "Новое название");
  assert.equal(ready.usage.inputTokens, 10);
  assert.equal(ready.prompt, "Сделай задачу");
  assert.match(ready.diff, /const ready = true/u);
});

test("turn-end registry preserves every prompt while merging repeated completion data", () => {
  const registry = new TurnEndNotificationRegistry();
  registry.recordCompletion(completion({
    prompt: "Изначальный запрос",
    prompts: ["Изначальный запрос", "Первое уточнение"],
  }));
  const ready = registry.recordCompletion(completion({
    prompt: "Второе уточнение",
    prompts: ["Изначальный запрос", "Первое уточнение", "Второе уточнение"],
  }));
  assert.equal(ready.prompt, "Изначальный запрос");
  assert.deepEqual(ready.prompts, [
    "Изначальный запрос",
    "Первое уточнение",
    "Второе уточнение",
  ]);
});

test("turn-end registry preserves generated response attachments through restore", () => {
  const registry = new TurnEndNotificationRegistry();
  registry.recordCompletion(completion({
    responseAttachments: [
      { id: "codex-generated-one.png", name: "Изображение", type: "image/png" },
      { id: "codex-generated-two.png", name: "Изображение", type: "image/png" },
      { id: "codex-generated-three.png", name: "Изображение", type: "image/png" },
    ],
  }));

  const restored = new TurnEndNotificationRegistry(registry.snapshot()).get(completion());
  assert.deepEqual(restored.responseAttachments.map((attachment) => attachment.id), [
    "codex-generated-one.png",
    "codex-generated-two.png",
    "codex-generated-three.png",
  ]);
});

test("turn-end registry preserves the Git baseline through merge and restore", () => {
  const registry = new TurnEndNotificationRegistry();
  const gitBaseline = { repoRoot: process.cwd(), tree: "a".repeat(40) };
  registry.recordCompletion(completion({ gitBaseline }));
  registry.recordCompletion(completion({ finalAnswer: "Готово" }));

  const restored = new TurnEndNotificationRegistry(registry.snapshot());
  assert.deepEqual(restored.get(completion()).gitBaseline, gitBaseline);
});

test("late deferred message refreshes the completed task title", () => {
  const registry = new TurnEndNotificationRegistry();
  registry.recordCompletion(completion({ taskTitle: "Старое название" }));
  registry.registerMessage(message({ turnId: "turn-1", taskTitle: "Новое название" }));
  assert.equal(registry.get(completion()).taskTitle, "Новое название");
});

test("a late completion without pricing metadata preserves an exact Fast tier", () => {
  const registry = new TurnEndNotificationRegistry();
  registry.recordCompletion(completion({
    model: "gpt-5.4",
    serviceTier: "fast",
  }));
  const ready = registry.recordCompletion(completion({
    model: "",
    serviceTier: undefined,
    usage: { inputTokens: 20 },
  }));
  assert.equal(ready.model, "gpt-5.4");
  assert.equal(ready.serviceTier, "fast");
});

test("completed Codex image generation without token events receives a rough estimate", () => {
  const registry = new TurnEndNotificationRegistry();
  const ready = registry.recordCompletion(completion({
    usageReported: false,
    usage: {},
    prompt: "Нарисуй чёрную дыру — это будет фон журнала",
  }));
  assert.equal(ready.usageReported, false);
  assert.equal(ready.estimatedCredits, 90);
  assert.equal(ready.estimateKind, "imagegen-default");
});

test("completed imagegen estimate is added when ordinary Codex usage is reported", () => {
  const registry = new TurnEndNotificationRegistry();
  const ready = registry.recordCompletion(completion({
    imageGenerationCount: 2,
  }));
  assert.equal(ready.usageReported, true);
  assert.equal(ready.usage.inputTokens, 10);
  assert.equal(ready.estimatedCredits, 180);
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

test("Codex completion hides its service marker across durable restore without touching prompts", () => {
  const annotationPrompt = [
    "# Response annotations:",
    "<response-annotations>",
    '[{"text":"Старый ответ","annotation":"как так?"}]',
    "</response-annotations>",
    "",
    "## My request for Codex:",
  ].join("\n");
  const userLiteral = ':codex-annotation{index="1"} — пользовательский literal-текст';
  const registry = new TurnEndNotificationRegistry();
  registry.recordCompletion(completion({
    prompt: annotationPrompt,
    prompts: [annotationPrompt, userLiteral],
    finalAnswer: ':codex-annotation{index="1"} Причина найдена',
  }));

  const restored = new TurnEndNotificationRegistry(registry.snapshot()).get(completion());
  assert.equal(restored.finalAnswer, "Причина найдена");
  assert.deepEqual(restored.prompts, [annotationPrompt, userLiteral]);
});
