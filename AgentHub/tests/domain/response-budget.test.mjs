import assert from "node:assert/strict";
import test from "node:test";

import {
  fitTaskHistoryPayload,
  truncateUtf8,
  utf8ByteLength,
  TaskHistoryResponseBudgetError,
} from "../../src/domain/response-budget.mjs";

test("truncateUtf8 preserves valid Russian UTF-8", () => {
  const value = truncateUtf8("Привет 🌧️".repeat(1_000), 257);
  assert.ok(utf8ByteLength(value) <= 257);
  assert.doesNotMatch(value, /\uFFFD/u);
});

test("an oversized complete annotation reports a typed budget failure without altering quote or locator", () => {
  const payload = { items: [{ id: "turn", messages: [{ itemId: "item", role: "user", text: "comment",
    responseAnnotations: [{ text: "quote".repeat(20_000), source: { messageKey: "exact-source", contentHash: "retained-hash" } }],
  }] }] };
  const original = structuredClone(payload);
  assert.throws(() => fitTaskHistoryPayload(payload, { maxBytes: 65_536 }), (error) => (
    error instanceof TaskHistoryResponseBudgetError
    && error.code === "TASK_HISTORY_RESPONSE_BUDGET_EXCEEDED"
    && error.maxBytes === 65_536
  ));
  assert.deepEqual(payload, original);
});

test("task history is fitted by bytes and keeps the newest identity", () => {
  const payload = {
    provider: "codex",
    threadId: "thread",
    title: "Задача",
    total: 10,
    start: 8,
    end: 10,
    nextBefore: 8,
    items: [8, 9].map((index) => ({
      id: `turn-${index}`,
      prompt: "Запрос ".repeat(20_000),
      answer: "Ответ ".repeat(20_000),
      activities: Array.from({ length: 100 }, () => ({ detail: "Действие".repeat(100) })),
      activityGroups: [{
        id: `reasoning-${index}`,
        reasoning: "Рассуждение ".repeat(20_000),
        activities: Array.from({ length: 105 }, (_, activityIndex) => ({
          id: `call-${activityIndex}`,
          label: "Вызов инструмента",
          detail: "Действие".repeat(100),
        })),
      }],
      messages: [
        { itemId: `u-${index}`, role: "user", text: "Запрос ".repeat(20_000) },
        { itemId: `a-${index}`, role: "agent", text: "Ответ ".repeat(20_000) },
      ],
    })),
  };
  const result = fitTaskHistoryPayload(payload, { maxBytes: 96 * 1_024 });
  assert.ok(utf8ByteLength(JSON.stringify(result)) <= 96 * 1_024);
  assert.equal(result.provider, "codex");
  assert.equal(result.threadId, "thread");
  assert.equal(result.items.at(-1).id, "turn-9");
  assert.equal(result.transportTruncated, true);
  assert.ok(result.items.at(-1).activityGroups.length > 0);
});
