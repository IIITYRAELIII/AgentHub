export function appendRunActivity(run, activity = {}) {
  if (!run) return;
  if (!Array.isArray(run.activities)) run.activities = [];
  const id = String(activity.id ?? "").trim()
    || `${activity.type ?? "stage"}:${Date.now()}:${run.activities.length}`;
  const normalized = {
    id,
    type: String(activity.type ?? "stage"),
    label: String(activity.label ?? "Действие"),
    detail: String(activity.detail ?? ""),
    status: String(activity.status ?? "running"),
    time: activity.time ?? new Date().toISOString(),
  };
  const existing = run.activities.findIndex((entry) => entry.id === id);
  if (existing >= 0) run.activities[existing] = { ...run.activities[existing], ...normalized };
  else run.activities.push(normalized);
  run.activities = run.activities.slice(-100);
}

function codexItemFailed(item) {
  const status = String(item?.status ?? "").toLowerCase();
  return ["failed", "error", "declined", "rejected"].includes(status)
    || (Number.isInteger(item?.exitCode) && item.exitCode !== 0)
    || Boolean(item?.error);
}

export function codexItemActivity(item, completed) {
  if (!item || typeof item !== "object") return null;
  const itemId = String(item.id ?? item.itemId ?? "").trim();
  const base = {
    id: `item:${itemId || `${item.type ?? "stage"}:${String(item.command ?? item.tool ?? "").slice(0, 80)}`}`,
    status: completed ? "completed" : "running",
  };
  if (item.type === "commandExecution") {
    const failed = completed && codexItemFailed(item);
    return {
      ...base,
      type: "command",
      label: failed ? "Команда завершилась с ошибкой" : completed ? "Команда выполнена" : "Выполняется команда",
      detail: String(item.command ?? "").replace(/\s+/g, " ").slice(0, 500),
      status: failed ? "failed" : base.status,
    };
  }
  if (item.type === "fileChange") {
    const failed = completed && codexItemFailed(item);
    const paths = (item.changes ?? item.files ?? [])
      .map((change) => String(change?.path ?? change ?? "").trim())
      .filter(Boolean);
    return {
      ...base,
      type: "file",
      label: failed ? "Изменение файлов не выполнено" : completed ? "Файлы изменены" : "Изменяются файлы",
      detail: paths.join(", ").slice(0, 500),
      status: failed ? "failed" : base.status,
    };
  }
  if (item.type === "mcpToolCall" || item.type === "dynamicToolCall") {
    const tool = item.type === "mcpToolCall"
      ? `${item.server ?? "MCP"}/${item.tool ?? ""}`
      : String(item.tool ?? "Инструмент");
    return {
      ...base,
      type: "tool",
      label: completed ? "Инструмент завершён" : "Используется инструмент",
      detail: tool,
      status: item.error ? "failed" : base.status,
    };
  }
  if (item.type === "webSearch") {
    return {
      ...base,
      type: "tool",
      label: completed ? "Поиск завершён" : "Поиск в интернете",
      detail: String(item.query ?? "").slice(0, 500),
    };
  }
  if (item.type === "contextCompaction") {
    return {
      ...base,
      type: "compaction",
      label: completed ? "Контекст свёрнут" : "Сворачивается контекст",
    };
  }
  if (/agent|collab|subagent/iu.test(String(item.type ?? ""))) {
    return {
      ...base,
      type: "subagent",
      label: completed ? "Субагент завершён" : "Работает субагент",
      detail: String(item.name ?? item.task ?? "").slice(0, 500),
    };
  }
  return null;
}

