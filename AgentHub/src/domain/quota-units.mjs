import { modelCreditRates, normalizeTokenUsage, normalizeServiceTier, turnCreditBreakdown,
  WORK_LOG_PRICING_PROJECTION_VERSION } from "./token-usage.mjs";

export const QUOTA_CALIBRATION_VERSION = "preliminary-2026-09-29-gpt6sol-reference-v1";
export const WORK_LOG_ACCOUNTING_PROJECTION_VERSION =
  `${WORK_LOG_PRICING_PROJECTION_VERSION}+qu:${QUOTA_CALIBRATION_VERSION}`;

// The GPT-6 Sol reference is a provisional QU estimate, rounded from a mixed
// quota-observation window. It is not an official subscription tariff. Freeze
// this reference ratio; model credit prices retain their own versioned history.
const GPT_6_SOL_REFERENCE = Object.freeze({
  credits: Object.freeze({ input: 50, cachedInput: 5, output: 250 }),
  quota: Object.freeze({ input: 400, cachedInput: 40, output: 2000 }),
});
export const PROVISIONAL_QU_PER_API_CREDIT =
  GPT_6_SOL_REFERENCE.quota.input / GPT_6_SOL_REFERENCE.credits.input;

// Empirical subscription estimates. These are independent of API price history.
const QUOTA_RATES = Object.freeze({
  "gpt-5.6-sol": Object.freeze({ input: 450, cachedInput: 45, output: 2250 }),
  "gpt-6-astra": Object.freeze({ input: 1650, cachedInput: 165, output: 8250 }),
});

export function quotaCapacity(multiplier) {
  const value = Number(multiplier);
  return [1, 5, 20].includes(value) ? value * 10_000 : null;
}

export function turnQuotaBreakdown(usage, {
  model, serviceTier = "default", estimatedCredits = 0, completedAt,
} = {}) {
  const tokens = normalizeTokenUsage(usage);
  const id = String(model ?? "").trim().toLowerCase();
  const hasTokens = tokens.inputTokens > 0 || tokens.outputTokens > 0
    || tokens.cachedInputTokens > 0 || (tokens.cacheWriteInputTokens ?? 0) > 0
    || tokens.reasoningOutputTokens > 0 || tokens.totalTokens > 0;
  const inferredBreakdown = tokens.totalTokens > 0 && tokens.inputTokens === 0
    && tokens.cachedInputTokens === 0 && (tokens.cacheWriteInputTokens ?? 0) === 0
    && tokens.outputTokens === 0;
  const pricingTokens = inferredBreakdown
    ? { ...tokens, inputTokens: tokens.totalTokens }
    : tokens.reasoningOutputTokens > tokens.outputTokens
      ? { ...tokens, outputTokens: tokens.reasoningOutputTokens }
      : tokens;
  const imageEstimate = Math.max(0, Number(estimatedCredits) || 0);
  const provisionalImageQuota = imageEstimate * PROVISIONAL_QU_PER_API_CREDIT;
  const rates = normalizeServiceTier(serviceTier) === "default" ? QUOTA_RATES[id] : null;
  if (rates) {
    const cacheReadTokens = Math.min(pricingTokens.inputTokens, pricingTokens.cachedInputTokens);
    const cacheWriteTokens = Math.min(
      Math.max(0, pricingTokens.inputTokens - cacheReadTokens),
      pricingTokens.cacheWriteInputTokens ?? 0,
    );
    const input = Math.max(0, pricingTokens.inputTokens - cacheReadTokens - cacheWriteTokens)
      * rates.input / 1_000_000;
    const cache = cacheReadTokens * rates.cachedInput / 1_000_000;
    // Empirical totals already include writes within uncached input. Keep the
    // calibrated total but expose those observed tokens as their own category.
    const cacheWrite = cacheWriteTokens * rates.input / 1_000_000;
    const output = pricingTokens.outputTokens * rates.output / 1_000_000;
    return {
      input, cache, cacheWrite, output: output + provisionalImageQuota,
      total: input + cache + cacheWrite + output + provisionalImageQuota,
      apiEstimateCredits: imageEstimate,
      uncalibrated: imageEstimate > 0 || inferredBreakdown,
      calibrationVersion: QUOTA_CALIBRATION_VERSION,
      basis: inferredBreakdown ? "empirical-inferred" : "empirical",
    };
  }
  const tariff = modelCreditRates(id, { completedAt });
  const priced = turnCreditBreakdown(pricingTokens, {
    model: id, serviceTier, estimatedCredits: imageEstimate, completedAt,
  });
  if (tariff && (hasTokens || imageEstimate > 0)) {
    const zeroPriced = priced.total === 0 && imageEstimate === 0;
    return {
      // Preserve the API-credit breakdown and project it onto the frozen
      // GPT-6 Sol QU reference. Other models have no measured QU coefficient.
      input: priced.input * PROVISIONAL_QU_PER_API_CREDIT,
      cache: priced.cache * PROVISIONAL_QU_PER_API_CREDIT,
      cacheWrite: priced.cacheWrite * PROVISIONAL_QU_PER_API_CREDIT,
      output: (priced.output + priced.reasoning + priced.estimate)
        * PROVISIONAL_QU_PER_API_CREDIT,
      total: priced.total * PROVISIONAL_QU_PER_API_CREDIT,
      apiEstimateCredits: priced.total,
      uncalibrated: !zeroPriced,
      calibrationVersion: QUOTA_CALIBRATION_VERSION,
      basis: zeroPriced ? "api-zero" : "api-estimate",
    };
  }
  if (imageEstimate > 0) {
    return {
      input: 0, cache: 0, cacheWrite: 0,
      output: provisionalImageQuota, total: provisionalImageQuota,
      apiEstimateCredits: imageEstimate, uncalibrated: true,
      calibrationVersion: QUOTA_CALIBRATION_VERSION, basis: "estimate-only",
    };
  }
  return {
    input: 0, cache: 0, cacheWrite: 0, output: 0, total: 0,
    apiEstimateCredits: 0,
    uncalibrated: hasTokens,
    calibrationVersion: QUOTA_CALIBRATION_VERSION,
    basis: hasTokens ? "unknown" : "zero",
  };
}

export function formatQuotaUnits(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) return "— QU";
  const scale = amount >= 1_000_000 ? [1_000_000, "MQU"]
    : amount >= 1_000 ? [1_000, "kQU"] : [1, "QU"];
  return `${(amount / scale[0]).toLocaleString("ru-RU", {
    maximumFractionDigits: 1,
  })} ${scale[1]}`;
}
