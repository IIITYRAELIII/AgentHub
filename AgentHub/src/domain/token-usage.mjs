const TOKEN_USAGE_FIELDS = [
  "inputTokens",
  "cachedInputTokens",
  "outputTokens",
  "reasoningOutputTokens",
  "totalTokens",
];

export const MODEL_PRICE_CHANGE_EFFECTIVE_FROM = "2026-09-08T00:00:00.000Z";
export const CREDITS_PER_USD = 25;

function priceVersion(effectiveFrom, usdPerMillion) {
  return Object.freeze({
    effectiveFrom,
    usdPerMillion: Object.freeze({ ...usdPerMillion }),
  });
}

function priceHistory(...versions) {
  return Object.freeze(versions);
}

// USD per 1M tokens. Historical versions remain immutable so rebuilding an old
// turn never applies today's price. Astra has one verified price; no earlier
// official tariff is known.
const MODEL_PRICE_REGISTRY = new Map([
  ["gpt-6-astra", priceHistory(
    priceVersion(null, { input: 10, cachedInput: 1, output: 50 }),
  )],
  ["gpt-5.6-sol", priceHistory(
    priceVersion(null, { input: 5, cachedInput: 0.5, output: 30 }),
    priceVersion(MODEL_PRICE_CHANGE_EFFECTIVE_FROM, { input: 4, cachedInput: 0.4, output: 20 }),
  )],
  ["gpt-5.6-terra", priceHistory(
    priceVersion(null, { input: 2.5, cachedInput: 0.25, output: 15 }),
    priceVersion(MODEL_PRICE_CHANGE_EFFECTIVE_FROM, { input: 2, cachedInput: 0.2, output: 12 }),
  )],
  ["gpt-5.6-luna", priceHistory(
    priceVersion(null, { input: 1, cachedInput: 0.1, output: 6 }),
    priceVersion(MODEL_PRICE_CHANGE_EFFECTIVE_FROM, { input: 0.2, cachedInput: 0.02, output: 1.2 }),
  )],
  ["gpt-5.5", priceHistory(
    priceVersion(null, { input: 5, cachedInput: 0.5, output: 30 }),
  )],
  ["gpt-5.4", priceHistory(
    priceVersion(null, { input: 2.5, cachedInput: 0.25, output: 15 }),
  )],
  ["gpt-5.4-mini", priceHistory(
    priceVersion(null, { input: 0.75, cachedInput: 0.075, output: 4.52 }),
  )],
  ["gpt-5.3-codex-spark", priceHistory(
    priceVersion(null, { input: 0, cachedInput: 0, output: 0 }),
  )],
]);

const CREDIT_FIELDS = ["input", "cache", "output", "reasoning", "estimate", "total"];
const SCALED_CREDIT_FORMATTER = new Intl.NumberFormat("ru-RU", {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});
const INTEGER_CREDIT_FORMATTER = new Intl.NumberFormat("ru-RU", {
  minimumFractionDigits: 0,
  maximumFractionDigits: 1,
});
const FRACTIONAL_CREDIT_FORMATTER = new Intl.NumberFormat("ru-RU", {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

function normalizedModel(value) {
  return String(value ?? "").trim().toLowerCase();
}

export function normalizeServiceTier(value) {
  const tier = String(value ?? "").trim().toLowerCase();
  return ["fast", "priority"].includes(tier) ? "fast" : "default";
}

function canonicalPricedModel(model) {
  const id = normalizedModel(model);
  return MODEL_PRICE_REGISTRY.has(id)
    ? id
    : id === "codex-auto-review"
      ? "gpt-5.6-terra"
      : id.includes("spark")
        ? "gpt-5.3-codex-spark"
        : id.startsWith("gpt-5.6")
          ? "gpt-5.6-sol"
          : id.startsWith("gpt-5.5")
            ? "gpt-5.5"
            : id.startsWith("gpt-5.4-mini")
              ? "gpt-5.4-mini"
              : id.startsWith("gpt-5.4")
                ? "gpt-5.4"
                : id;
}

function completedAtMilliseconds(value) {
  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isFinite(time) ? time : null;
  }
  const text = String(value ?? "").trim();
  if (!text) return null;
  const time = Date.parse(text);
  return Number.isFinite(time) ? time : null;
}

export function modelPriceRates(model, { completedAt } = {}) {
  const versions = MODEL_PRICE_REGISTRY.get(canonicalPricedModel(model));
  if (!versions?.length) return null;
  const completedAtMs = completedAtMilliseconds(completedAt);
  // Missing or malformed legacy timestamps deliberately select the oldest
  // retained version. That is the only fail-safe choice that cannot reprice
  // historical data merely because it was reopened by newer software.
  const selected = completedAtMs == null
    ? versions[0]
    : versions.reduce((match, version) => {
      if (version.effectiveFrom == null) return version;
      return Date.parse(version.effectiveFrom) <= completedAtMs ? version : match;
    }, versions[0]);
  return { ...selected.usdPerMillion };
}

export function modelCreditRates(model, options = {}) {
  const prices = modelPriceRates(model, options);
  if (!prices) return null;
  return Object.fromEntries(Object.entries(prices).map(([category, usd]) => [
    category,
    Number((usd * CREDITS_PER_USD).toFixed(12)),
  ]));
}

export function fastModeCreditMultiplier(model, serviceTier) {
  if (normalizeServiceTier(serviceTier) !== "fast") return 1;
  const id = normalizedModel(model);
  if (id.startsWith("gpt-5.5") || id.startsWith("gpt-5.6")) return 2.5;
  if (id.startsWith("gpt-5.4") && !id.startsWith("gpt-5.4-mini")) return 2;
  return 1;
}

function percentagesAddingUpToHundred(values) {
  const total = values.reduce((sum, value) => sum + value, 0);
  if (total <= 0) return values.map(() => 0);

  const exactTenths = values.map((value) => value / total * 1000);
  const tenths = exactTenths.map(Math.floor);
  let undistributed = 1000 - tenths.reduce((sum, value) => sum + value, 0);
  const indicesByRemainder = exactTenths
    .map((value, index) => ({ index, remainder: value - tenths[index] }))
    .sort((left, right) => right.remainder - left.remainder || left.index - right.index);

  for (let index = 0; index < undistributed; index += 1) {
    tenths[indicesByRemainder[index].index] += 1;
  }
  return tenths.map((value) => value / 10);
}

export function formatCredits(value) {
  const credits = Number(value ?? 0);
  const normalized = Number.isFinite(credits) ? credits : 0;
  const scales = [
    [1e9, "Gcr"],
    [1e6, "Mcr"],
    [1e3, "kcr"],
  ];
  const scale = scales.find(([divisor]) => Math.abs(normalized) >= divisor);
  if (scale) {
    return `${SCALED_CREDIT_FORMATTER.format(normalized / scale[0])} ${scale[1]}`;
  }
  const formatter = Number.isInteger(normalized) ? INTEGER_CREDIT_FORMATTER : FRACTIONAL_CREDIT_FORMATTER;
  return `${formatter.format(normalized)} cr`;
}

export function creditsFromUsd(value) {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const usd = Number(value);
  return Number.isFinite(usd) && usd >= 0 ? usd * CREDITS_PER_USD : null;
}

export function emptyCreditBreakdown() {
  return {
    input: 0,
    cache: 0,
    output: 0,
    reasoning: 0,
    estimate: 0,
    total: 0,
    priced: true,
  };
}

export function addCreditBreakdown(total, addition) {
  const result = emptyCreditBreakdown();
  for (const field of CREDIT_FIELDS) {
    result[field] = Number(total?.[field] ?? 0) + Number(addition?.[field] ?? 0);
  }
  result.priced = total?.priced !== false && addition?.priced !== false;
  return result;
}

export function turnCreditBreakdown(usage, {
  model,
  serviceTier = "default",
  estimatedCredits = 0,
  completedAt,
} = {}) {
  const normalized = normalizeTokenUsage(usage);
  const rates = modelCreditRates(model, { completedAt });
  const estimate = Math.max(0, Number(estimatedCredits) || 0);
  if (!rates) {
    const hasTokenUsage = TOKEN_USAGE_FIELDS.some((field) => normalized[field] > 0);
    return {
      ...emptyCreditBreakdown(),
      estimate,
      total: estimate,
      // Claude emits local <synthetic> turns for authentication failures,
      // limits and no-response continuations. Reported zero tokens mean a
      // known zero charge even though that synthetic model has no tariff.
      priced: !hasTokenUsage,
    };
  }
  const multiplier = fastModeCreditMultiplier(model, serviceTier);
  const uncachedInput = Math.max(0, normalized.inputTokens - normalized.cachedInputTokens);
  const reasoningTokens = Math.min(normalized.outputTokens, normalized.reasoningOutputTokens);
  const outputTokens = normalized.outputTokens - reasoningTokens;
  const perMillion = 1_000_000;
  const input = uncachedInput * rates.input / perMillion * multiplier;
  const cache = normalized.cachedInputTokens * rates.cachedInput / perMillion * multiplier;
  const output = outputTokens * rates.output / perMillion * multiplier;
  const reasoning = reasoningTokens * rates.output / perMillion * multiplier;
  return {
    input,
    cache,
    output,
    reasoning,
    estimate,
    total: input + cache + output + reasoning + estimate,
    priced: true,
  };
}

export function turnCredits(usage, options = {}) {
  return turnCreditBreakdown(usage, options).total;
}

function formatCreditBreakdown(breakdown) {
  const number = (value) => value.toLocaleString("ru-RU", { maximumFractionDigits: 1 });
  const [
    inputPercent,
    cachePercent,
    outputPercent,
    reasoningPercent,
    estimatePercent,
  ] = percentagesAddingUpToHundred([
    breakdown.input,
    breakdown.cache,
    breakdown.output,
    breakdown.reasoning,
    breakdown.estimate,
  ]);
  const creditWithPercent = (value, percent) => `${formatCredits(value)} (${number(percent)}%)`;
  const lines = [
    `📊 За поток: ${formatCredits(breakdown.total)}`,
    `Вход: ${creditWithPercent(breakdown.input, inputPercent)}`,
    `Кэш: ${creditWithPercent(breakdown.cache, cachePercent)}`,
    `Выход: ${creditWithPercent(breakdown.output, outputPercent)}`,
    `Думы: ${creditWithPercent(breakdown.reasoning, reasoningPercent)}`,
  ];
  if (breakdown.estimate > 0) {
    lines.push(`ImageGen: ${creditWithPercent(breakdown.estimate, estimatePercent)}`);
  }
  return lines.join("\n");
}

export function formatTaskTokenUsage(usage, options = {}) {
  const breakdown = turnCreditBreakdown(usage, options);
  if (!breakdown.priced && breakdown.estimate <= 0) {
    const model = String(options?.model ?? "").trim();
    return `📊 Кредиты за поток: нет тарифа${model ? ` для ${model}` : ""}.`;
  }
  return formatCreditBreakdown(breakdown);
}

export function formatTaskCreditBreakdown(breakdown) {
  return formatCreditBreakdown(addCreditBreakdown(emptyCreditBreakdown(), breakdown));
}

export function emptyTokenUsage() {
  return Object.fromEntries(TOKEN_USAGE_FIELDS.map((field) => [field, 0]));
}

export function normalizeTokenUsage(usage) {
  const normalized = emptyTokenUsage();
  for (const field of TOKEN_USAGE_FIELDS) {
    const value = Number(usage?.[field]);
    if (Number.isFinite(value) && value >= 0) normalized[field] = Math.trunc(value);
  }
  return normalized;
}

export function tokenUsageDelta(current, previous, fallback) {
  if (!previous || TOKEN_USAGE_FIELDS.some((field) => current[field] < previous[field])) {
    return normalizeTokenUsage(fallback);
  }
  return Object.fromEntries(TOKEN_USAGE_FIELDS.map((field) => [field, current[field] - previous[field]]));
}

export function addTokenUsage(total, addition) {
  return Object.fromEntries(TOKEN_USAGE_FIELDS.map((field) => [field, total[field] + addition[field]]));
}

export function formatTurnTokenUsage(tracker) {
  const estimatedCredits = Math.max(0, Number(tracker?.estimatedCredits) || 0);
  if (!tracker?.reported && estimatedCredits <= 0) return "📊 Кредиты за поток: нет данных.";
  return formatTaskTokenUsage(tracker?.usage, {
    model: tracker?.model,
    serviceTier: tracker?.serviceTier,
    estimatedCredits,
    completedAt: tracker?.completedAt,
  });
}
