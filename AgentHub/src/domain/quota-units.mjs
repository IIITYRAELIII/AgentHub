import { modelCreditRates, normalizeTokenUsage, normalizeServiceTier, turnCreditBreakdown,
  WORK_LOG_PRICING_PROJECTION_VERSION } from "./token-usage.mjs";

export const QUOTA_CALIBRATION_VERSION = "preliminary-2026-09-29-api-estimates";
export const WORK_LOG_ACCOUNTING_PROJECTION_VERSION =
  `${WORK_LOG_PRICING_PROJECTION_VERSION}+qu:${QUOTA_CALIBRATION_VERSION}`;

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
    || tokens.cachedInputTokens > 0 || tokens.reasoningOutputTokens > 0 || tokens.totalTokens > 0;
  const inferredBreakdown = tokens.totalTokens > 0 && tokens.inputTokens === 0
    && tokens.cachedInputTokens === 0 && tokens.outputTokens === 0;
  const pricingTokens = inferredBreakdown
    ? { ...tokens, inputTokens: tokens.totalTokens }
    : tokens.reasoningOutputTokens > tokens.outputTokens
      ? { ...tokens, outputTokens: tokens.reasoningOutputTokens }
      : tokens;
  const imageEstimate = Math.max(0, Number(estimatedCredits) || 0);
  const rates = normalizeServiceTier(serviceTier) === "default" ? QUOTA_RATES[id] : null;
  if (rates) {
    const input = Math.max(0, pricingTokens.inputTokens - pricingTokens.cachedInputTokens)
      * rates.input / 1_000_000;
    const cache = pricingTokens.cachedInputTokens * rates.cachedInput / 1_000_000;
    const output = pricingTokens.outputTokens * rates.output / 1_000_000;
    return {
      input, cache, output: output + imageEstimate,
      total: input + cache + output + imageEstimate,
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
      // A known API tariff gives a numerical provisional QU estimate for every
      // model/tier. It is not a calibrated subscription-quota conversion.
      input: priced.input, cache: priced.cache,
      output: priced.output + priced.reasoning + priced.estimate,
      total: priced.total,
      apiEstimateCredits: priced.total,
      uncalibrated: !zeroPriced,
      calibrationVersion: QUOTA_CALIBRATION_VERSION,
      basis: zeroPriced ? "api-zero" : "api-estimate",
    };
  }
  if (imageEstimate > 0) {
    return {
      input: 0, cache: 0, output: imageEstimate, total: imageEstimate,
      apiEstimateCredits: imageEstimate, uncalibrated: true,
      calibrationVersion: QUOTA_CALIBRATION_VERSION, basis: "estimate-only",
    };
  }
  return {
    input: 0, cache: 0, output: 0, total: 0,
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
