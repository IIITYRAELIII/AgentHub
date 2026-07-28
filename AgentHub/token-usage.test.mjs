import assert from "node:assert/strict";
import test from "node:test";
import {
  addTokenUsage,
  emptyTokenUsage,
  formatConditionalUnits,
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

  assert.match(formatted, /За задачу: 108 кТЭ/);
  assert.doesNotMatch(formatted, /743.169/);
  assert.match(formatted, /Вход: 18 кТЭ \(16,3%\)/);
  assert.match(formatted, /Кэш: 72 кТЭ \(66,7%\)/);
  assert.match(formatted, /Выход: 13 кТЭ \(11,6%\)/);
  assert.match(formatted, /Думы: 6 кТЭ \(5,4%\)/);
  assert.equal(formatted.split("\n").length, 5);
  assert.doesNotMatch(formatted, /\|/);
});

test("formatTaskTokenUsage renders whole kilo units and one decimal for larger scales", () => {
  const formatted = formatTaskTokenUsage({
    inputTokens: 1,
    cachedInputTokens: 1,
    outputTokens: 0,
    reasoningOutputTokens: 0,
  });

  assert.match(formatted, /За задачу: 0 кТЭ/);
  assert.match(formatted, /Вход: 0 кТЭ \(90,9%\)/);
  assert.match(formatted, /Кэш: 0 кТЭ \(9,1%\)/);
  assert.equal(formatConditionalUnits(999_000), "999 кТЭ");
  assert.equal(formatConditionalUnits(1_000_000), "1,0 МТЭ");
  assert.equal(formatConditionalUnits(1_756_500), "1,8 МТЭ");
  assert.equal(formatConditionalUnits(1_000_000_000), "1,0 ГТЭ");
  assert.equal(formatConditionalUnits(1_000_000_000_000), "1,0 ТТЭ");
  assert.equal(formatConditionalUnits(1e30), "1,0 КвТЭ");
});

test("formatTaskTokenUsage labels every category and percentages total exactly 100%", () => {
  const formatted = formatTaskTokenUsage({
    totalTokens: 198093,
    inputTokens: 667,
    cachedInputTokens: 197376,
    outputTokens: 50,
    reasoningOutputTokens: 15,
  });

  assert.match(formatted, /За задачу: 21 кТЭ/);
  assert.match(formatted, /Вход: 1 кТЭ \(3,2%\)/);
  assert.match(formatted, /Кэш: 20 кТЭ \(95,3%\)/);
  assert.match(formatted, /Выход: 0 кТЭ \(1%\)/);
  assert.match(formatted, /Думы: 0 кТЭ \(0,5%\)/);
  assert.doesNotMatch(formatted, /у\.е\./);
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
  assert.match(formatted, /Вход: 0 кТЭ /);
  assert.match(formatted, /Кэш: 0 кТЭ /);
  assert.equal(turnConditionalUnits({
    inputTokens: 100,
    cachedInputTokens: 80,
    outputTokens: 2,
  }), 40);
  assert.equal(formatTurnTokenUsage(null), "📊 Токены за задачу: нет данных.");
});

test("formatTurnTokenUsage includes image generation estimate without marking aggregate values approximate", () => {
  const formatted = formatTurnTokenUsage({
    reported: false,
    usage: emptyTokenUsage(),
    estimatedUnits: 720_000,
  });
  assert.match(formatted, /За задачу: 720 кТЭ/);
  assert.match(formatted, /ImageGen: 720 кТЭ \(100%\)/);
  assert.doesNotMatch(formatted, /≈/);
  assert.doesNotMatch(formatted, /нет данных/);
});

test("formatTurnTokenUsage sums ordinary Codex usage and imagegen estimate", () => {
  const formatted = formatTurnTokenUsage({
    reported: true,
    usage: normalizeTokenUsage({
      inputTokens: 100_000,
      outputTokens: 10_000,
      reasoningOutputTokens: 4_000,
    }),
    estimatedUnits: 720_000,
  });
  assert.match(formatted, /За задачу: 880 кТЭ/);
  assert.match(formatted, /ImageGen: 720 кТЭ \(81,8%\)/);
  assert.doesNotMatch(formatted, /≈/);
});
