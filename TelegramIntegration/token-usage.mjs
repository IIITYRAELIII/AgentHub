const NBSP = "\u00a0";

function tokenCount(value) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) && number > 0 ? Math.trunc(number) : 0;
}

export function formatTaskTokenUsage(usage) {
  const input = tokenCount(usage?.inputTokens);
  const cache = tokenCount(usage?.cachedInputTokens);
  const outputWithReasoning = tokenCount(usage?.outputTokens);
  const reasoning = Math.min(outputWithReasoning, tokenCount(usage?.reasoningOutputTokens));
  const output = outputWithReasoning - reasoning;
  const total = tokenCount(usage?.totalTokens) || input + cache + outputWithReasoning;
  const number = (value) => value.toLocaleString("ru-RU");
  const left = [`Вход: ${number(input)}`, `Выход: ${number(output)}`];
  const width = Math.max(...left.map((value) => value.length));

  return `📊 Токены за задачу: ${number(total)}\n` +
    `${left[0].padEnd(width, NBSP)} | Кэш: ${number(cache)}\n` +
    `${left[1].padEnd(width, NBSP)} | Думы: ${number(reasoning)}`;
}
