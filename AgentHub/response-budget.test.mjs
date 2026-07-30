import assert from "node:assert/strict";
import test from "node:test";

import {
  fitTaskHistoryPayload,
  truncateUtf8,
  utf8ByteLength,
} from "./response-budget.mjs";

test("truncateUtf8 preserves valid Russian UTF-8", () => {
  const value = truncateUtf8("Привет 🌧️".repeat(1_000), 257);
  assert.ok(utf8ByteLength(value) <= 257);
  assert.doesNotMatch(value, /\uFFFD/u);
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
});
