export const TASK_CHECKLIST_OPERATIONS = Object.freeze([
  "add", "edit", "remove", "toggle", "move", "link", "unlink", "extract",
]);

export const TASK_CHECKLIST_TEXT_MAX_LENGTH = 1_000;
export const TASK_CHECKLIST_ITEMS_MAX = 500;

export function normalizedTaskChecklistText(value) {
  const text = String(value ?? "").replace(/\r\n?/gu, "\n").trim();
  if (!text) throw new Error("Введите текст пункта чек-листа");
  if (text.length > TASK_CHECKLIST_TEXT_MAX_LENGTH) {
    throw new Error(`Пункт чек-листа длиннее ${TASK_CHECKLIST_TEXT_MAX_LENGTH} символов`);
  }
  return text;
}

export function normalizedTaskChecklistOperation(value) {
  const operation = String(value ?? "").trim().toLowerCase();
  if (!TASK_CHECKLIST_OPERATIONS.includes(operation)) {
    throw new Error("Неизвестная операция чек-листа");
  }
  return operation;
}
