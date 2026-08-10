export const TASK_BUCKETS = Object.freeze(["backlog", "workspace", "notes"]);
export const TASK_STATUSES = Object.freeze(["open", "started", "done"]);
export const TASK_CATEGORIES = Object.freeze(["task", "note", "unknown"]);
export const TASK_SHORT_TITLE_MAX_LENGTH = 100;
export const TASK_TITLE_MAX_LENGTH = 160;
export const TELEGRAM_BUNDLE_TRIAGE_INSTRUCTIONS = Object.freeze([
  "Ниже пакет сообщений, собранный пользователем в Telegram.",
  "Сохраняй порядок и авторов. Пересланные реплики — контекст третьих лиц; не путай их с прямыми комментариями пользователя, отмеченными «Вы».",
]);
export const LEGACY_TELEGRAM_BUNDLE_PREFIX = `${TELEGRAM_BUNDLE_TRIAGE_INSTRUCTIONS.join("\n")}\n\n`;

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

function clippedTitle(value) {
  const title = String(value ?? "").replace(/\s+/gu, " ").trim();
  if (title.length <= TASK_TITLE_MAX_LENGTH) return title;
  return `${title.slice(0, TASK_TITLE_MAX_LENGTH - 1).trimEnd()}…`;
}

export function taskPresentation(text, { title, description } = {}) {
  const normalizedText = normalizedTaskText(text);
  if (!normalizedText.includes("\n") && normalizedText.length <= TASK_SHORT_TITLE_MAX_LENGTH) {
    return { title: normalizedText, description: "" };
  }
  const lines = normalizedText.split("\n").map((line) => line.trim()).filter(Boolean);
  const fallbackTitle = lines.find((line) => (
    !/^--- Сообщение \d+ · .+ ---$/u.test(line)
    && !/^\[Изображение \d+ приложено/u.test(line)
  )) ?? lines[0] ?? normalizedText;
  const normalizedTitle = clippedTitle(title) || clippedTitle(fallbackTitle);
  const normalizedDescription = description == null
    ? normalizedText
    : String(description).replace(/\r\n?/gu, "\n").trim();
  return { title: normalizedTitle, description: normalizedDescription };
}

export function taskDisplayText(task) {
  return String(task?.correctedText ?? "").trim() || String(task?.rawText ?? "").trim();
}

export function taskDisplayTitle(task) {
  return String(task?.title ?? "").trim() || taskPresentation(taskDisplayText(task)).title;
}

export function taskDescription(task) {
  if (String(task?.title ?? "").trim()) return String(task?.description ?? "").trim();
  return taskPresentation(taskDisplayText(task)).description;
}
