import assert from "node:assert/strict";
import test from "node:test";
import {
  addCreditBreakdown,
  addTokenUsage,
  creditsFromUsd,
  emptyCreditBreakdown,
  emptyTokenUsage,
  fastModeCreditMultiplier,
  formatCredits,
  formatTaskTokenUsage,
  formatTurnTokenUsage,
  MODEL_PRICE_CHANGE_EFFECTIVE_FROM,
  modelCreditRates,
  modelPriceRates,
  normalizeServiceTier,
  normalizeTokenUsage,
  tokenUsageDelta,
  turnCreditBreakdown,
  turnCredits,
} from "../../src/domain/token-usage.mjs";

const SOL = "gpt-5.6-sol";
const ASTRA = "gpt-6-astra";
const BEFORE_PRICE_CHANGE = "2026-09-07T23:59:59.999Z";
const AFTER_PRICE_CHANGE = "2026-09-08T00:00:00.001Z";

test("model rates and Fast multipliers are explicit", () => {
  assert.deepEqual(modelCreditRates(SOL), {
    input: 125,
    cachedInput: 12.5,
    output: 750,
  });
  assert.deepEqual(modelCreditRates(ASTRA), {
    input: 250,
    cachedInput: 25,
    output: 1_250,
  });
  assert.deepEqual(modelCreditRates("gpt-5.6-terra"), {
    input: 62.5,
    cachedInput: 6.25,
    output: 375,
  });
  assert.deepEqual(modelCreditRates("codex-auto-review"), {
    input: 62.5,
    cachedInput: 6.25,
    output: 375,
  });
  assert.deepEqual(modelCreditRates("gpt-5.6-luna"), {
    input: 25,
    cachedInput: 2.5,
    output: 150,
  });
  assert.deepEqual(modelCreditRates("gpt-5.3-codex-spark"), {
    input: 0,
    cachedInput: 0,
    output: 0,
  });
  assert.deepEqual(modelCreditRates("gpt-5.5-codex"), modelCreditRates(SOL));
  assert.deepEqual(modelCreditRates("gpt-5.4-codex"), modelCreditRates("gpt-5.6-terra"));
  assert.equal(fastModeCreditMultiplier(SOL, "fast"), 2.5);
  assert.equal(normalizeServiceTier("priority"), "fast");
  assert.equal(fastModeCreditMultiplier(SOL, "priority"), 2.5);
  assert.equal(fastModeCreditMultiplier("gpt-5.5", "fast"), 2.5);
  assert.equal(fastModeCreditMultiplier("gpt-5.4", "fast"), 2);
  assert.equal(fastModeCreditMultiplier(SOL, "default"), 1);
});

test("versioned model prices switch exactly at the verified boundary", () => {
  const current = { completedAt: MODEL_PRICE_CHANGE_EFFECTIVE_FROM };
  assert.deepEqual(modelPriceRates(ASTRA, current), {
    input: 10,
    cachedInput: 1,
    output: 50,
  });
  assert.deepEqual(modelPriceRates(SOL, current), {
    input: 4,
    cachedInput: 0.4,
    output: 20,
  });
  assert.deepEqual(modelCreditRates(SOL, { completedAt: BEFORE_PRICE_CHANGE }), {
    input: 125,
    cachedInput: 12.5,
    output: 750,
  });
  assert.deepEqual(modelCreditRates(SOL, current), {
    input: 100,
    cachedInput: 10,
    output: 500,
  });
  assert.deepEqual(modelCreditRates(SOL, { completedAt: AFTER_PRICE_CHANGE }), {
    input: 100,
    cachedInput: 10,
    output: 500,
  });
  assert.deepEqual(modelCreditRates("gpt-5.6-terra", current), {
    input: 50,
    cachedInput: 5,
    output: 300,
  });
  assert.deepEqual(modelCreditRates("codex-auto-review", current), {
    input: 50,
    cachedInput: 5,
    output: 300,
  });
  assert.deepEqual(modelCreditRates("gpt-5.6-luna", current), {
    input: 5,
    cachedInput: 0.5,
    output: 30,
  });
});

test("missing or malformed completion time keeps the oldest retained tariff", () => {
  const oldest = { input: 125, cachedInput: 12.5, output: 750 };
  assert.deepEqual(modelCreditRates(SOL), oldest);
  assert.deepEqual(modelCreditRates(SOL, { completedAt: "not-a-date" }), oldest);

  const returned = modelCreditRates(SOL);
  returned.input = 0;
  assert.deepEqual(modelCreditRates(SOL), oldest);
});

test("current Astra usage is calculated from its exact category prices", () => {
  const usage = {
    inputTokens: 2_000_000,
    cachedInputTokens: 1_000_000,
    outputTokens: 1_000_000,
  };
  const completedAt = MODEL_PRICE_CHANGE_EFFECTIVE_FROM;
  assert.deepEqual(turnCreditBreakdown(usage, { model: ASTRA, completedAt }), {
    input: 250,
    cache: 25,
    output: 1_250,
    reasoning: 0,
    estimate: 0,
    total: 1_525,
    priced: true,
  });
});

test("credit calculation separates uncached input, cache, output and reasoning", () => {
  const breakdown = turnCreditBreakdown({
    inputTokens: 740_110,
    cachedInputTokens: 722_432,
    outputTokens: 3_059,
    reasoningOutputTokens: 974,
  }, { model: SOL });

  assert.deepEqual(breakdown, {
    input: 2.20975,
    cache: 9.0304,
    output: 1.56375,
    reasoning: 0.7305,
    estimate: 0,
    total: 13.5344,
    priced: true,
  });
  const formatted = formatTaskTokenUsage({
    inputTokens: 740_110,
    cachedInputTokens: 722_432,
    outputTokens: 3_059,
    reasoningOutputTokens: 974,
  }, { model: SOL });
  assert.match(formatted, /За поток: 13,5 cr/);
  assert.match(formatted, /Вход: 2,2 cr \(16,3%\)/);
  assert.match(formatted, /Кэш: 9,0 cr \(66,7%\)/);
  assert.match(formatted, /Выход: 1,6 cr \(11,6%\)/);
  assert.match(formatted, /Думы: 0,7 cr \(5,4%\)/);
  assert.equal(formatted.split("\n").length, 5);
});

test("credits use SI scales with one decimal", () => {
  assert.equal(formatCredits(999), "999 cr");
  assert.equal(formatCredits(1_000), "1,0 kcr");
  assert.equal(formatCredits(1_756_500), "1,8 Mcr");
  assert.equal(formatCredits(1_000_000_000), "1,0 Gcr");
  assert.equal(creditsFromUsd(4.5783), 114.4575);
  assert.equal(creditsFromUsd("0.04"), 1);
  assert.equal(creditsFromUsd(null), null);
  assert.equal(creditsFromUsd(-1), null);
});

test("Fast mode multiplies all priced token categories", () => {
  const usage = {
    inputTokens: 100_000,
    cachedInputTokens: 80_000,
    outputTokens: 10_000,
    reasoningOutputTokens: 4_000,
  };
  assert.equal(
    turnCredits(usage, { model: SOL, serviceTier: "fast" }),
    turnCredits(usage, { model: SOL }) * 2.5,
  );
  assert.equal(
    turnCredits(usage, { model: "gpt-5.4", serviceTier: "fast" }),
    turnCredits(usage, { model: "gpt-5.4" }) * 2,
  );
});

test("Spark is accounted as zero credits and unknown models stay unpriced", () => {
  const usage = { inputTokens: 1_000_000, outputTokens: 1_000_000 };
  assert.deepEqual(turnCreditBreakdown(usage, {
    model: "gpt-5.3-codex-spark",
  }), {
    input: 0,
    cache: 0,
    output: 0,
    reasoning: 0,
    estimate: 0,
    total: 0,
    priced: true,
  });
  assert.match(
    formatTaskTokenUsage(usage, { model: "future-model" }),
    /нет тарифа для future-model/,
  );
  assert.deepEqual(turnCreditBreakdown(emptyTokenUsage(), {
    model: "<synthetic>",
  }), {
    input: 0,
    cache: 0,
    output: 0,
    reasoning: 0,
    estimate: 0,
    total: 0,
    priced: true,
  });
});

test("credit breakdowns and token counters add without losing fields", () => {
  assert.deepEqual(addCreditBreakdown(
    { ...emptyCreditBreakdown(), input: 1, total: 1 },
    { ...emptyCreditBreakdown(), cache: 2, total: 2 },
  ), {
    input: 1,
    cache: 2,
    output: 0,
    reasoning: 0,
    estimate: 0,
    total: 3,
    priced: true,
  });
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

test("turn formatting includes a fixed image generation credit estimate", () => {
  const estimateOnly = formatTurnTokenUsage({
    reported: false,
    usage: emptyTokenUsage(),
    estimatedCredits: 90,
  });
  assert.match(estimateOnly, /За поток: 90 cr/);
  assert.match(estimateOnly, /ImageGen: 90 cr \(100%\)/);
  assert.doesNotMatch(estimateOnly, /нет данных/);

  const combined = formatTurnTokenUsage({
    reported: true,
    model: SOL,
    usage: normalizeTokenUsage({
      inputTokens: 100_000,
      outputTokens: 10_000,
      reasoningOutputTokens: 4_000,
    }),
    estimatedCredits: 90,
  });
  assert.match(combined, /За поток: 110 cr/);
  assert.match(combined, /ImageGen: 90 cr \(81,8%\)/);
  assert.equal(formatTurnTokenUsage(null), "📊 Кредиты за поток: нет данных.");
});
