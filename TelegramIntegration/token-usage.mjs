const CACHE_UNIT_DIVISOR = 10;
const OUTPUT_UNIT_MULTIPLIER = 6;
const TOKEN_USAGE_FIELDS = [
  "inputTokens",
  "cachedInputTokens",
  "outputTokens",
  "reasoningOutputTokens",
  "totalTokens",
];

function tokenCount(value) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) && number > 0 ? Math.trunc(number) : 0;
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

export function formatConditionalUnits(value) {
  const units = Number(value ?? 0);
  const thousands = Number.isFinite(units) ? Math.round(units / 1000) : 0;
  return `${thousands.toLocaleString("ru-RU")} К`;
}

export function formatTaskTokenUsage(usage) {
  const input = tokenCount(usage?.inputTokens);
  const cache = tokenCount(usage?.cachedInputTokens);
  const outputWithReasoning = tokenCount(usage?.outputTokens);
  const reasoning = Math.min(outputWithReasoning, tokenCount(usage?.reasoningOutputTokens));
  const output = outputWithReasoning - reasoning;
  const unitInput = input;
  const unitCache = cache / CACHE_UNIT_DIVISOR;
  const unitOutput = output * OUTPUT_UNIT_MULTIPLIER;
  const unitReasoning = reasoning * OUTPUT_UNIT_MULTIPLIER;
  const unitTotal = unitInput + unitCache + unitOutput + unitReasoning;
  const number = (value) => value.toLocaleString("ru-RU", { maximumFractionDigits: 1 });
  const [inputPercent, cachePercent, outputPercent, reasoningPercent] = percentagesAddingUpToHundred([
    unitInput,
    unitCache,
    unitOutput,
    unitReasoning,
  ]);
  const unitWithPercent = (value, percent) => `${formatConditionalUnits(value)} (${number(percent)}%)`;
  return [
    `📊 За задачу: ${formatConditionalUnits(unitTotal)} у.е.`,
    `Вход: ${unitWithPercent(unitInput, inputPercent)}`,
    `Кэш: ${unitWithPercent(unitCache, cachePercent)}`,
    `Выход: ${unitWithPercent(unitOutput, outputPercent)}`,
    `Думы: ${unitWithPercent(unitReasoning, reasoningPercent)}`,
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

export function turnConditionalUnits(usage) {
  const normalized = normalizeTokenUsage(usage);
  const uncachedInput = Math.max(0, normalized.inputTokens - normalized.cachedInputTokens);
  const reasoning = Math.min(normalized.outputTokens, normalized.reasoningOutputTokens);
  const output = normalized.outputTokens - reasoning;
  return uncachedInput
    + normalized.cachedInputTokens / CACHE_UNIT_DIVISOR
    + output * OUTPUT_UNIT_MULTIPLIER
    + reasoning * OUTPUT_UNIT_MULTIPLIER;
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
  if (!tracker?.reported) return "📊 Токены за задачу: нет данных.";
  const { inputTokens, cachedInputTokens, outputTokens, reasoningOutputTokens, totalTokens } = tracker.usage;
  const uncachedInputTokens = Math.max(0, inputTokens - cachedInputTokens);
  return formatTaskTokenUsage({
    totalTokens,
    inputTokens: uncachedInputTokens,
    cachedInputTokens,
    outputTokens,
    reasoningOutputTokens,
  });
}
