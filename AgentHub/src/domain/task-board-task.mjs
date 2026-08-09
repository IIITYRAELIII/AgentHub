export const TASK_BUCKETS = Object.freeze(["backlog", "workspace", "notes"]);
export const TASK_STATUSES = Object.freeze(["open", "started", "done"]);
export const TASK_CATEGORIES = Object.freeze(["task", "note", "unknown"]);

export function normalizedTaskText(value, { maximumLength = 20_000 } = {}) {
  const text = String(value ?? "").replace(/\r\n?/g, "\n").trim();
  if (!text) throw new Error("Введите текст Task");
  if (text.length > maximumLength) throw new Error(`Task длиннее ${maximumLength} символов`);
  return text;
}

export function normalizedTaskBucket(value) {
  const bucket = String(value ?? "").trim().toLowerCase();
  if (!TASK_BUCKETS.includes(bucket)) throw new Error("Неизвестная колонка Task");
  return bucket;
}

export function normalizedTaskCategory(value) {
  const category = String(value ?? "").trim().toLowerCase();
  return TASK_CATEGORIES.includes(category) ? category : "unknown";
}

export function taskDisplayText(task) {
  return String(task?.correctedText ?? "").trim() || String(task?.rawText ?? "").trim();
}
