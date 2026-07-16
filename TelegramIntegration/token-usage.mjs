const NBSP = "\u00a0";
const CACHE_UNIT_DIVISOR = 10;
const OUTPUT_UNIT_MULTIPLIER = 6;

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
  const unitWithPercent = (value, percent) => `${number(value)} (${number(percent)}%)`;
  const left = [
    `Вход: ${unitWithPercent(unitInput, inputPercent)}`,
    `Выход: ${unitWithPercent(unitOutput, outputPercent)}`,
  ];
  const width = Math.max(...left.map((value) => value.length));

  return `📊 За задачу: ${number(unitTotal)} у.е.\n` +
    `${left[0].padEnd(width, NBSP)} | Кэш: ${unitWithPercent(unitCache, cachePercent)}\n` +
    `${left[1].padEnd(width, NBSP)} | Думы: ${unitWithPercent(unitReasoning, reasoningPercent)}`;
}
