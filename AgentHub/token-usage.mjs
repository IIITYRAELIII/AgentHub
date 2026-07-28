const TOKEN_USAGE_FIELDS = [
  "inputTokens",
  "cachedInputTokens",
  "outputTokens",
  "reasoningOutputTokens",
  "totalTokens",
];

const MODEL_CREDIT_RATES = new Map([
  ["gpt-5.6-sol", { input: 125, cachedInput: 12.5, output: 750 }],
  ["gpt-5.6-terra", { input: 62.5, cachedInput: 6.25, output: 375 }],
  ["gpt-5.6-luna", { input: 25, cachedInput: 2.5, output: 150 }],
  ["gpt-5.5", { input: 125, cachedInput: 12.5, output: 750 }],
  ["gpt-5.4", { input: 62.5, cachedInput: 6.25, output: 375 }],
  ["gpt-5.4-mini", { input: 18.75, cachedInput: 1.875, output: 113 }],
  ["gpt-5.3-codex-spark", { input: 0, cachedInput: 0, output: 0 }],
]);

const CREDIT_FIELDS = ["input", "cache", "output", "reasoning", "estimate", "total"];

function tokenCount(value) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) && number > 0 ? Math.trunc(number) : 0;
}

function normalizedModel(value) {
  return String(value ?? "").trim().toLowerCase();
}

export function normalizeServiceTier(value) {
  const tier = String(value ?? "").trim().toLowerCase();
  return tier === "fast" ? "fast" : "default";
}

export function modelCreditRates(model) {
  const id = normalizedModel(model);
  const canonical = MODEL_CREDIT_RATES.has(id)
    ? id
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
  const rates = MODEL_CREDIT_RATES.get(canonical);
  return rates ? { ...rates } : null;
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
    return `${(normalized / scale[0]).toLocaleString("ru-RU", {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    })} ${scale[1]}`;
  }
  return `${normalized.toLocaleString("ru-RU", {
    minimumFractionDigits: Number.isInteger(normalized) ? 0 : 1,
    maximumFractionDigits: 1,
  })} cr`;
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
} = {}) {
  const normalized = normalizeTokenUsage(usage);
  const rates = modelCreditRates(model);
  const estimate = Math.max(0, Number(estimatedCredits) || 0);
  if (!rates) {
    return {
      ...emptyCreditBreakdown(),
      estimate,
      total: estimate,
      priced: false,
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
    `📊 За задачу: ${formatCredits(breakdown.total)}`,
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
    return `📊 Кредиты за задачу: нет тарифа${model ? ` для ${model}` : ""}.`;
  }
  return formatCreditBreakdown(breakdown);
}

export function formatTaskCreditBreakdown(breakdown) {
  return formatCreditBreakdown(addCreditBreakdown(emptyCreditBreakdown(), breakdown));
}

// Claude does not expose OpenAI Codex credit rates. Keep its existing
// token-equivalent formatter separate until Claude accounting is integrated.
export function formatLegacyTokenEquivalents(usage) {
  const input = tokenCount(usage?.inputTokens);
  const cache = tokenCount(usage?.cachedInputTokens);
  const outputWithReasoning = tokenCount(usage?.outputTokens);
  const reasoning = Math.min(outputWithReasoning, tokenCount(usage?.reasoningOutputTokens));
  const output = outputWithReasoning - reasoning;
  const values = [input, cache / 10, output * 6, reasoning * 6];
  const total = values.reduce((sum, value) => sum + value, 0);
  const percentages = percentagesAddingUpToHundred(values);
  const format = (value) => `${Math.round(value / 1_000).toLocaleString("ru-RU")} кТЭ`;
  return [
    `📊 За задачу: ${format(total)}`,
    `Вход: ${format(values[0])} (${percentages[0].toLocaleString("ru-RU")}%)`,
    `Кэш: ${format(values[1])} (${percentages[1].toLocaleString("ru-RU")}%)`,
    `Выход: ${format(values[2])} (${percentages[2].toLocaleString("ru-RU")}%)`,
    `Думы: ${format(values[3])} (${percentages[3].toLocaleString("ru-RU")}%)`,
  ].join("\n");
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
  if (!tracker?.reported && estimatedCredits <= 0) return "📊 Кредиты за задачу: нет данных.";
  return formatTaskTokenUsage(tracker?.usage, {
    model: tracker?.model,
    serviceTier: tracker?.serviceTier,
    estimatedCredits,
  });
}
