// Ordering is not an allowlist. Availability comes only from a complete provider catalog.
const PRIORITY = [
  "gpt-6-astra",
  "gpt-6.1-sol",
  "gpt-6-sol",
  "gpt-6-luna",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
];
const priorityIndex = new Map(PRIORITY.map((value, index) => [value, index]));

export function isCodexPriorityModel(value) {
  return priorityIndex.has(value);
}

export function orderCodexModels(models, novelIds = []) {
  const novelIndex = new Map(novelIds.map((value, index) => [value, index]));
  return models.map((model, index) => ({ model, index })).sort((left, right) => {
    const leftNovel = novelIndex.get(left.model.value);
    const rightNovel = novelIndex.get(right.model.value);
    if (leftNovel !== undefined || rightNovel !== undefined) {
      if (leftNovel === undefined) return 1;
      if (rightNovel === undefined) return -1;
      return leftNovel - rightNovel;
    }
    const leftPriority = priorityIndex.get(left.model.value) ?? Infinity;
    const rightPriority = priorityIndex.get(right.model.value) ?? Infinity;
    return leftPriority - rightPriority || left.index - right.index;
  }).map(({ model }) => model);
}
