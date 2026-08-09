const MAX_RUN_ACTIVITY_BYTES = 2_500_000;

function normalizedRunActivity(activity, fallbackId) {
  const id = String(activity.id ?? "").trim()
    || fallbackId;
  return {
    id,
    type: String(activity.type ?? "stage"),
    label: String(activity.label ?? "Действие"),
    detail: String(activity.detail ?? ""),
    status: String(activity.status ?? "running"),
    time: activity.time ?? new Date().toISOString(),
  };
}

function trimRunActivityCollection(run, key) {
  let bytes = Buffer.byteLength(JSON.stringify(run[key]), "utf8");
  while (bytes > MAX_RUN_ACTIVITY_BYTES && run[key].length > 1) {
    run[key].shift();
    bytes = Buffer.byteLength(JSON.stringify(run[key]), "utf8");
  }
}

function runActivityGroups(run) {
  if (!Array.isArray(run.activityGroups)) run.activityGroups = [];
  return run.activityGroups;
}

function currentRunActivityGroup(run) {
  const groups = runActivityGroups(run);
  const currentId = String(run.currentActivityGroupId ?? "").trim();
  let group = currentId ? groups.find((entry) => entry.id === currentId) : null;
  if (!group) {
    group = {
      id: `activity:${String(run.turnId ?? run.id ?? "current")}`,
      reasoning: "",
      activities: [],
    };
    groups.push(group);
    run.currentActivityGroupId = group.id;
  }
  return group;
}

export function upsertRunReasoningBlock(run, { id, text = "", delta = "" } = {}) {
  if (!run) return null;
  const groupId = `reasoning:${String(id ?? "current").trim() || "current"}`;
  const groups = runActivityGroups(run);
  let group = groups.find((entry) => entry.id === groupId);
  if (!group) {
    group = { id: groupId, reasoning: "", activities: [] };
    groups.push(group);
  }
  if (text) group.reasoning = String(text).trim();
  else if (delta) group.reasoning = `${group.reasoning}${String(delta)}`.slice(-40_000);
  run.currentActivityGroupId = groupId;
  trimRunActivityCollection(run, "activityGroups");
  return group;
}

export function replaceRunActivityGroups(run, groups) {
  if (!run) return [];
  run.activityGroups = (Array.isArray(groups) ? groups : []).map((group, index) => ({
    id: String(group?.id ?? `group:${index}`),
    reasoning: String(group?.reasoning ?? ""),
    activities: (Array.isArray(group?.activities) ? group.activities : []).map((activity, activityIndex) => (
      normalizedRunActivity(activity, `group:${index}:activity:${activityIndex}`)
    )),
  }));
  run.currentActivityGroupId = run.activityGroups.at(-1)?.id ?? null;
  trimRunActivityCollection(run, "activityGroups");
  return run.activityGroups;
}

export function appendRunActivity(run, activity = {}) {
  if (!run) return;
  if (!Array.isArray(run.activities)) run.activities = [];
  const normalized = normalizedRunActivity(
    activity,
    `${activity.type ?? "stage"}:${Date.now()}:${run.activities.length}`,
  );
  const { id } = normalized;
  const existing = run.activities.findIndex((entry) => entry.id === id);
  if (existing >= 0) run.activities[existing] = { ...run.activities[existing], ...normalized };
  else run.activities.push(normalized);
  trimRunActivityCollection(run, "activities");
  if (run.provider === "codex") {
    const groups = runActivityGroups(run);
    let group = groups.find((entry) => entry.activities.some((item) => item.id === id));
    if (!group) group = currentRunActivityGroup(run);
    const groupActivity = group.activities.findIndex((entry) => entry.id === id);
    if (groupActivity >= 0) group.activities[groupActivity] = { ...group.activities[groupActivity], ...normalized };
    else group.activities.push({ ...normalized });
    trimRunActivityCollection(run, "activityGroups");
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
