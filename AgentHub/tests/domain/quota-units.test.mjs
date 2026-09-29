import assert from "node:assert/strict";
import test from "node:test";
import { quotaCapacity, turnQuotaBreakdown } from "../../src/domain/quota-units.mjs";

test("empirical Sol and Astra QU use uncached input, cache and all output exactly once", () => {
  const usage = { inputTokens: 2_000_000, cachedInputTokens: 1_000_000,
    outputTokens: 1_000_000, reasoningOutputTokens: 200_000 };
  assert.deepEqual(turnQuotaBreakdown(usage, { model: "gpt-5.6-sol" }), {
    input: 450, cache: 45, output: 2250, total: 2745,
    apiEstimateCredits: 0, uncalibrated: false,
    calibrationVersion: "preliminary-2026-09-21", basis: "empirical",
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

test("Fast, ImageGen and unknown models mark QU incomplete; only explicit capacities are known", () => {
  const usage = { inputTokens: 1_000_000 };
  assert.equal(turnQuotaBreakdown(usage, { model: "gpt-5.6-sol", serviceTier: "fast" }).basis, "unknown");
  assert.equal(turnQuotaBreakdown(usage, { model: "gpt-6-astra", estimatedCredits: 90 }).uncalibrated, true);
  assert.equal(turnQuotaBreakdown(usage, { model: "gpt-5.6-terra" }).uncalibrated, true);
  assert.deepEqual([1, 5, 20, "pro"].map(quotaCapacity), [10000, 50000, 200000, null]);
});
