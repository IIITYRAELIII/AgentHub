import assert from "node:assert/strict";
import test from "node:test";
import {
  addTokenUsage,
  emptyTokenUsage,
  formatTaskTokenUsage,
  formatTurnTokenUsage,
  normalizeTokenUsage,
  tokenUsageDelta,
  turnConditionalUnits,
} from "./token-usage.mjs";

test("formatTaskTokenUsage converts token categories to conditional units", () => {
  const formatted = formatTaskTokenUsage({
    totalTokens: 743169,
    inputTokens: 17678,
    cachedInputTokens: 722432,
    outputTokens: 3059,
    reasoningOutputTokens: 974,
  });

  assert.match(formatted, /За задачу: 108.275,2 у\.е\./);
  assert.doesNotMatch(formatted, /743.169/);
  assert.match(formatted, /Вход: 17.678 \(16,3%\)/);
  assert.match(formatted, /Кэш: 72.243,2 \(66,7%\)/);
  assert.match(formatted, /Выход: 12.510 \(11,6%\)/);
  assert.match(formatted, /Думы: 5.844 \(5,4%\)/);
  assert.equal(formatted.split("\n").length, 5);
  assert.doesNotMatch(formatted, /\|/);
});

test("formatTaskTokenUsage keeps one decimal for cache units when needed", () => {
  const formatted = formatTaskTokenUsage({
    inputTokens: 1,
    cachedInputTokens: 1,
    outputTokens: 0,
    reasoningOutputTokens: 0,
  });

  assert.match(formatted, /За задачу: 1,1 у\.е\./);
  assert.match(formatted, /Вход: 1 \(90,9%\)/);
  assert.match(formatted, /Кэш: 0,1 \(9,1%\)/);
});

test("formatTaskTokenUsage labels every category and percentages total exactly 100%", () => {
  const formatted = formatTaskTokenUsage({
    totalTokens: 198093,
    inputTokens: 667,
    cachedInputTokens: 197376,
    outputTokens: 50,
    reasoningOutputTokens: 15,
  });

  assert.match(formatted, /За задачу: 20.704,6 у\.е\./);
  assert.match(formatted, /Вход: 667 \(3,2%\)/);
  assert.match(formatted, /Кэш: 19.737,6 \(95,3%\)/);
  assert.match(formatted, /Выход: 210 \(1%\)/);
  assert.match(formatted, /Думы: 90 \(0,5%\)/);
  assert.equal((formatted.match(/у\.е\./g) ?? []).length, 1);
});

test("turn token helpers normalize counters and handle counter resets", () => {
  assert.deepEqual(emptyTokenUsage(), {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
  });
  assert.deepEqual(normalizeTokenUsage({ inputTokens: 12.9, outputTokens: -1 }), {
    inputTokens: 12,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
  });
  assert.equal(tokenUsageDelta(
    normalizeTokenUsage({ inputTokens: 5 }),
    normalizeTokenUsage({ inputTokens: 10 }),
    { inputTokens: 3 },
  ).inputTokens, 3);
  assert.equal(addTokenUsage(
    normalizeTokenUsage({ inputTokens: 2 }),
    normalizeTokenUsage({ inputTokens: 4 }),
  ).inputTokens, 6);
});

test("formatTurnTokenUsage excludes cached tokens from uncached input", () => {
  const formatted = formatTurnTokenUsage({
    reported: true,
    usage: normalizeTokenUsage({
      inputTokens: 100,
      cachedInputTokens: 80,
      outputTokens: 2,
      totalTokens: 102,
    }),
  });
  assert.match(formatted, /Вход: 20 /);
  assert.match(formatted, /Кэш: 8 /);
  assert.equal(turnConditionalUnits({
    inputTokens: 100,
    cachedInputTokens: 80,
    outputTokens: 2,
  }), 40);
  assert.equal(formatTurnTokenUsage(null), "📊 Токены за задачу: нет данных.");
});
