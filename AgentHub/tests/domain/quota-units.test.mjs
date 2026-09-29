import assert from "node:assert/strict";
import test from "node:test";
import { quotaCapacity, turnQuotaBreakdown } from "../../src/domain/quota-units.mjs";

test("empirical Sol and Astra QU use uncached input, cache and all output exactly once", () => {
  const usage = { inputTokens: 2_000_000, cachedInputTokens: 1_000_000,
    outputTokens: 1_000_000, reasoningOutputTokens: 200_000 };
  assert.deepEqual(turnQuotaBreakdown(usage, { model: "gpt-5.6-sol" }), {
    input: 450, cache: 45, output: 2250, total: 2745,
    apiEstimateCredits: 0, uncalibrated: false,
    calibrationVersion: "preliminary-2026-09-29-api-estimates", basis: "empirical",
  });
  assert.equal(turnQuotaBreakdown(usage, { model: "gpt-6-astra" }).total, 10065);
  assert.deepEqual(usage, { inputTokens: 2_000_000, cachedInputTokens: 1_000_000,
    outputTokens: 1_000_000, reasoningOutputTokens: 200_000 });
});

test("new Sol and Luna use unweighted API estimates as provisional QU", () => {
  const usage = { inputTokens: 2_000_000, cachedInputTokens: 1_000_000,
    outputTokens: 1_000_000 };
  assert.equal(turnQuotaBreakdown(usage, { model: "gpt-6-sol" }).apiEstimateCredits, 305);
  assert.equal(turnQuotaBreakdown(usage, { model: "gpt-6-luna" }).apiEstimateCredits, 15.25);
  assert.equal(turnQuotaBreakdown(usage, { model: "gpt-6-sol" }).total, 305);
  assert.equal(turnQuotaBreakdown(usage, { model: "gpt-6-luna" }).total, 15.25);
  assert.equal(turnQuotaBreakdown(usage, { model: "gpt-6-sol" }).uncalibrated, true);
});

test("other priced models and Fast get provisional numerical QU without subscription factors", () => {
  const usage = { inputTokens: 1_000_000 };
  const fast = turnQuotaBreakdown(usage, {
    model: "gpt-5.6-sol", serviceTier: "fast", completedAt: "2026-09-29T00:00:00Z",
  });
  assert.equal(fast.total, 250);
  assert.equal(fast.basis, "api-estimate");
  for (const model of ["gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5", "gpt-5.4", "gpt-5.4-mini"]) {
    const quota = turnQuotaBreakdown(usage, { model, completedAt: "2026-09-29T00:00:00Z" });
    assert.ok(quota.total > 0, model);
    assert.equal(quota.uncalibrated, true, model);
  }
  const image = turnQuotaBreakdown(usage, { model: "gpt-6-astra", estimatedCredits: 90 });
  assert.equal(image.total, 1740);
  assert.equal(image.apiEstimateCredits, 90);
  assert.equal(image.uncalibrated, true);
  assert.deepEqual([1, 5, 20, "pro"].map(quotaCapacity), [10000, 50000, 200000, null]);
});

test("Spark's zero API price stays zero and a missing model is not invented", () => {
  const spark = turnQuotaBreakdown({ inputTokens: 1_000_000 }, {
    model: "gpt-5.3-codex-spark", completedAt: "2026-09-29T00:00:00Z",
  });
  assert.equal(spark.total, 0);
  assert.equal(spark.basis, "api-zero");
  assert.equal(spark.uncalibrated, false);
  const missing = turnQuotaBreakdown({ inputTokens: 1_000_000 }, { model: "" });
  assert.equal(missing.total, 0);
  assert.equal(missing.uncalibrated, true);
  assert.equal(turnQuotaBreakdown({ totalTokens: 1_000_000 }, {
    model: "gpt-5.6-terra", completedAt: "2026-09-29T00:00:00Z",
  }).total, 50);
});
