import { normalizeTokenUsage, normalizeServiceTier, turnCreditBreakdown,
  WORK_LOG_PRICING_PROJECTION_VERSION } from "./token-usage.mjs";

export const QUOTA_CALIBRATION_VERSION = "preliminary-2026-09-21";
export const WORK_LOG_ACCOUNTING_PROJECTION_VERSION =
  `${WORK_LOG_PRICING_PROJECTION_VERSION}+qu:${QUOTA_CALIBRATION_VERSION}`;

// Empirical subscription estimates. These are independent of API price history.
const QUOTA_RATES = Object.freeze({
  "gpt-5.6-sol": Object.freeze({ input: 450, cachedInput: 45, output: 2250 }),
  "gpt-6-astra": Object.freeze({ input: 1650, cachedInput: 165, output: 8250 }),
});
const API_ESTIMATE_MODELS = new Set(["gpt-6-sol", "gpt-6-luna"]);

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
    || tokens.cachedInputTokens > 0 || tokens.reasoningOutputTokens > 0;
  const imageEstimate = Math.max(0, Number(estimatedCredits) || 0);
  const rates = normalizeServiceTier(serviceTier) === "default" ? QUOTA_RATES[id] : null;
  if (rates) {
    const input = Math.max(0, tokens.inputTokens - tokens.cachedInputTokens) * rates.input / 1_000_000;
    const cache = tokens.cachedInputTokens * rates.cachedInput / 1_000_000;
    const output = tokens.outputTokens * rates.output / 1_000_000;
    return {
      input, cache, output, total: input + cache + output,
      apiEstimateCredits: 0,
      uncalibrated: imageEstimate > 0,
      calibrationVersion: QUOTA_CALIBRATION_VERSION,
      basis: "empirical",
    };
  }
  if (API_ESTIMATE_MODELS.has(id) && hasTokens) {
    const priced = turnCreditBreakdown(tokens, { model: id, serviceTier, completedAt });
    return {
      // The user requested an immediate unweighted estimate. Treat one API-
      // equivalent credit as one provisional QU, without a subscription factor.
      input: priced.input, cache: priced.cache,
      output: priced.output + priced.reasoning, total: priced.total,
      apiEstimateCredits: priced.total,
      uncalibrated: true,
      calibrationVersion: QUOTA_CALIBRATION_VERSION,
      basis: "api-estimate",
    };
  }
  return {
    input: 0, cache: 0, output: 0, total: 0,
    apiEstimateCredits: 0,
    uncalibrated: hasTokens || imageEstimate > 0,
    calibrationVersion: QUOTA_CALIBRATION_VERSION,
    basis: hasTokens || imageEstimate > 0 ? "unknown" : "zero",
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
