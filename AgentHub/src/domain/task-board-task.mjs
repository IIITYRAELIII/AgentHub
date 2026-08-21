export const TASK_BUCKETS = Object.freeze(["backlog", "workspace", "notes"]);
export const TASK_STATUSES = Object.freeze(["open", "started", "done"]);
export const TASK_WORKFLOW_STATUSES = Object.freeze([
  "new", "in_progress", "testing", "awaiting_implementation", "done",
]);
export const TASK_REFERENCE_INTENTS = Object.freeze(["context", "start"]);
export const TASK_REFERENCE_CONTEXT_REQUEST = "Учти прикреплённые Dashboard Task как контекст; само прикрепление не является просьбой выполнять их.";
export const TASK_REFERENCE_START_REQUEST = "Начни работу над прикреплённой Dashboard Task.";
export const TASK_CATEGORIES = Object.freeze(["task", "note", "unknown"]);
export const TASK_SHORT_TITLE_MAX_LENGTH = 100;
export const TASK_TITLE_MAX_LENGTH = 160;
export const TASK_DESCRIPTION_MAX_LENGTH = 20_000;
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

export function normalizedTaskTitle(value) {
  const title = String(value ?? "").replace(/\s+/gu, " ").trim();
  if (!title) throw new Error("Введите заголовок Task");
  if (title.length > TASK_TITLE_MAX_LENGTH) {
    throw new Error(`Заголовок Task длиннее ${TASK_TITLE_MAX_LENGTH} символов`);
  }
  return title;
}

export function normalizedTaskDescription(value) {
  const description = String(value ?? "").replace(/\r\n?/gu, "\n").trim();
  if (description.length > TASK_DESCRIPTION_MAX_LENGTH) {
    throw new Error(`Описание Task длиннее ${TASK_DESCRIPTION_MAX_LENGTH} символов`);
  }
  return description;
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

export function normalizedTaskWorkflowStatus(value) {
  const status = String(value ?? "").trim().toLowerCase();
  if (!TASK_WORKFLOW_STATUSES.includes(status)) throw new Error("Неизвестный статус Task");
  return status;
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

export function taskReferenceDescriptor(task, { intent = "context" } = {}) {
  const taskId = String(task?.id ?? "").trim();
  if (!taskId) throw new Error("Task reference does not contain an id");
  const normalizedIntent = String(intent ?? "").trim().toLowerCase();
  if (!TASK_REFERENCE_INTENTS.includes(normalizedIntent)) {
    throw new Error("Unknown Task reference intent");
  }
  const workflowStatus = TASK_WORKFLOW_STATUSES.includes(task?.workflowStatus)
    ? task.workflowStatus
    : (task?.status === "done" ? "done" : (task?.status === "started" ? "in_progress" : "new"));
  return {
    kind: "task",
    taskId,
    title: taskDisplayTitle(task),
    workflowStatus,
    workspaceId: String(task?.workspaceId ?? "").trim() || null,
    intent: normalizedIntent,
  };
}

function taskReferenceLink(reference) {
  const title = String(reference?.title ?? "Task").replace(/\r|\n|\[|\]/gu, " ").trim() || "Task";
  return `[Dashboard Task: ${title}](agent-hub://task/${encodeURIComponent(reference.taskId)})`;
}

export function taskReferencePromptDetails(value) {
  const text = String(value ?? "").replace(/\r\n?/gu, "\n").trim();
  if (!text.startsWith("# Attached Agent Hub Tasks\n")) return null;
  const requestMarker = /^# My request\s*$/mu;
  const marker = requestMarker.exec(text);
  if (!marker) return null;
  const request = text.slice(marker.index + marker[0].length).trim();
  const generated = request === TASK_REFERENCE_CONTEXT_REQUEST
    || request === TASK_REFERENCE_START_REQUEST;
  const references = text.slice("# Attached Agent Hub Tasks\n".length, marker.index)
    .split("\n")
    .flatMap((line) => {
      const match = /^- \[Dashboard Task: ([^\]]+)\]\(agent-hub:\/\/task\/([^\s)]+)\) · status: ([a-z_]+) · intent: (context|start)$/u
        .exec(line.trim());
      if (!match) return [];
      let taskId;
      try {
        taskId = decodeURIComponent(match[2]);
      } catch {
        return [];
      }
      const workflowStatus = TASK_WORKFLOW_STATUSES.includes(match[3]) ? match[3] : "new";
      return [{
        kind: "task",
        taskId,
        title: match[1].trim() || "Task",
        workflowStatus,
        workspaceId: null,
        intent: match[4],
      }];
    });
  return {
    request,
    displayText: generated ? "" : request,
    generated,
    references,
  };
}

export function messageWithTaskReferences(text, references = []) {
  const values = Array.isArray(references) ? references : [];
  if (!values.length) return String(text ?? "").trim();
  const startsWork = values.some((reference) => reference.intent === "start");
  const request = String(text ?? "").trim() || (startsWork
    ? TASK_REFERENCE_START_REQUEST
    : TASK_REFERENCE_CONTEXT_REQUEST);
  return [
    "# Attached Agent Hub Tasks",
    "",
    ...values.map((reference) => (
      `- ${taskReferenceLink(reference)} · status: ${reference.workflowStatus} · intent: ${reference.intent}`
    )),
    "",
    "Открой актуальное содержимое Task командой MCP `hub_task_get` по `taskId` из ссылки. "
      + "Для intent=context не начинай работу без явной просьбы пользователя.",
    "",
    "# My request",
    "",
    request,
  ].join("\n");
}
