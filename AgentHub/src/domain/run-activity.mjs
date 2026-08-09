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
  let bytes = Buffer.byteLength(JSON.stringify(run.activities), "utf8");
  while (bytes > 2_500_000 && run.activities.length > 1) {
    run.activities.shift();
    bytes = Buffer.byteLength(JSON.stringify(run.activities), "utf8");
  }
}

function codexItemFailed(item) {
  const status = String(item?.status ?? "").toLowerCase();
  return ["failed", "error", "declined", "rejected"].includes(status)
    || (Number.isInteger(item?.exitCode) && item.exitCode !== 0)
    || Boolean(item?.error);
}

function collabAgentDetail(item) {
  if (item?.type === "subAgentActivity") {
    return [item.agentPath, item.agentThreadId].map((value) => String(value ?? "").trim()).filter(Boolean).join(" · ").slice(0, 500);
  }
  const receivers = Array.isArray(item?.receiverThreadIds)
    ? item.receiverThreadIds.map((value) => String(value ?? "").trim()).filter(Boolean)
    : [];
  return [item?.model, item?.reasoningEffort, ...receivers].map((value) => String(value ?? "").trim()).filter(Boolean).join(" · ").slice(0, 500);
}

function completedWaitLabel(item) {
  const states = Object.values(item?.agentsStates ?? {}).map((state) => String(state?.status ?? ""));
  if (!states.length) return "Ожидание субагентов завершено";
  const completedCount = states.filter((status) => status === "completed").length;
  if (completedCount === 1 && states.length === 1) return "Субагент завершил работу";
  if (completedCount === states.length) return "Субагенты завершили работу";
  if (states.some((status) => status === "errored")) return "Субагент завершился с ошибкой";
  if (states.every((status) => ["interrupted", "shutdown", "notFound"].includes(status))) return "Субагенты остановлены";
  return "Ожидание субагентов завершено";
}

export function codexSubagentActivity(item, completed) {
  if (item?.type === "subAgentActivity") {
    const labels = {
      started: "Субагент начал работу",
      interacted: "Субагент взаимодействует",
      interrupted: "Субагент остановлен",
    };
    const label = labels[String(item.kind ?? "")];
    return label ? {
      type: "subagent",
      label,
      detail: collabAgentDetail(item),
      status: item.kind === "started" && !completed ? "running" : "completed",
    } : null;
  }
  if (item?.type !== "collabAgentToolCall") return null;

  const failed = item.status === "failed" || (completed && codexItemFailed(item));
  const finished = completed || item.status === "completed" || failed;
  const labels = {
    spawnAgent: ["Запускается субагент", "Субагент запущен", "Запуск субагента не удался"],
    sendInput: ["Отправляется сообщение субагенту", "Сообщение субагенту отправлено", "Сообщение субагенту не отправлено"],
    resumeAgent: ["Возобновляется субагент", "Субагент возобновлён", "Субагент не возобновлён"],
    wait: ["Ожидание субагентов", "Ожидание субагентов завершено", "Ожидание субагентов завершилось с ошибкой"],
    closeAgent: ["Останавливается субагент", "Субагент остановлен", "Субагент не остановлен"],
  };
  const variants = labels[String(item.tool ?? "")];
  if (!variants) return null;
  const completedLabel = item.tool === "wait" ? completedWaitLabel(item) : variants[1];
  return {
    type: "subagent",
    label: failed ? variants[2] : finished ? completedLabel : variants[0],
    detail: collabAgentDetail(item),
    status: failed ? "failed" : finished ? "completed" : "running",
  };
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
    const command = String(item.command ?? "").replace(/\s+/g, " ").slice(0, 500);
    const output = String(item.aggregatedOutput ?? "").trim().slice(-4_000);
    return {
      ...base,
      type: "command",
      label: failed ? "Команда завершилась с ошибкой" : completed ? "Команда выполнена" : "Выполняется команда",
      detail: [command, output].filter(Boolean).join("\n"),
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
  const subagent = codexSubagentActivity(item, completed);
  if (subagent) return { ...base, ...subagent };
  return null;
}
