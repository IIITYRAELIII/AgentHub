const MAX_LIVE_ITEMS = 32;
const MAX_COMMAND_OUTPUT_CHARS = 12_000;
const MAX_PROGRESS_MESSAGES = 20;

function normalizedId(value) {
  return String(value ?? "").trim();
}

function tail(value, limit) {
  const text = String(value ?? "");
  return text.length > limit ? text.slice(-limit) : text;
}

function liveItems(run) {
  if (!Array.isArray(run.liveItems)) run.liveItems = [];
  run.liveItems = run.liveItems
    .filter((item) => normalizedId(item?.id))
    .slice(-MAX_LIVE_ITEMS);
  return run.liveItems;
}

function upsert(run, itemId, defaults = {}) {
  const items = liveItems(run);
  const id = normalizedId(itemId);
  if (!id) return null;
  let item = items.find((candidate) => candidate.id === id);
  if (!item) {
    item = { id, type: "unknown", status: "running" };
    items.push(item);
    if (items.length > MAX_LIVE_ITEMS) items.shift();
  }
  Object.assign(item, defaults, { id });
  return item;
}

function changedPaths(changes) {
  return (Array.isArray(changes) ? changes : [])
    .map((change) => String(change?.path ?? change?.filePath ?? "").trim())
    .filter(Boolean);
}

function activity(item) {
  if (!item) return null;
  const base = { id: `item:${item.id}`, status: item.status ?? "running" };
  if (item.type === "commandExecution") {
    const command = String(item.command ?? "").replace(/\s+/gu, " ").trim();
    const output = tail(item.output, 4_000).trim();
    const interaction = tail(item.terminalInput, 1_000).trim();
    return {
      ...base,
      type: "command",
      label: interaction ? "Команда ожидает терминальный ввод" : "Выполняется команда",
      detail: [command, output, interaction ? `Ввод: ${interaction}` : ""].filter(Boolean).join("\n").slice(-4_500),
      status: interaction ? "waiting" : base.status,
    };
  }
  if (item.type === "fileChange") {
    return {
      ...base,
      type: "file",
      label: "Подготавливаются изменения файлов",
      detail: changedPaths(item.changes).join(", ").slice(0, 4_000),
    };
  }
  if (item.type === "mcpToolCall") {
    return {
      ...base,
      type: "tool",
      label: "Используется инструмент",
      detail: [item.tool, ...(item.progress ?? [])].filter(Boolean).join("\n").slice(-4_000),
    };
  }
  return null;
}

export function startCodexLiveItem(run, item) {
  if (!run || !item?.id) return null;
  return activity(upsert(run, item.id, {
    type: String(item.type ?? "unknown"),
    status: "running",
    command: item.command,
    changes: item.changes,
    tool: item.type === "mcpToolCall"
      ? `${item.server ?? "MCP"}/${item.tool ?? ""}`
      : item.tool,
  }));
}

export function completeCodexLiveItem(run, item) {
  if (!run || !item?.id) return null;
  return activity(upsert(run, item.id, {
    type: String(item.type ?? "unknown"),
    status: item.error || (Number.isInteger(item.exitCode) && item.exitCode !== 0) ? "failed" : "completed",
    command: item.command,
    output: item.aggregatedOutput ?? undefined,
    terminalInput: "",
    changes: item.changes,
    tool: item.type === "mcpToolCall"
      ? `${item.server ?? "MCP"}/${item.tool ?? ""}`
      : item.tool,
  }));
}

export function reduceCodexLiveItemEvent(run, method, params = {}) {
  if (!run) return null;
  if (method === "item/commandExecution/outputDelta") {
    const item = upsert(run, params.itemId, { type: "commandExecution", status: "running" });
    if (!item) return null;
    item.output = tail(`${item.output ?? ""}${String(params.delta ?? "")}`, MAX_COMMAND_OUTPUT_CHARS);
    item.terminalInput = "";
    return activity(item);
  }
  if (method === "item/commandExecution/terminalInteraction") {
    return activity(upsert(run, params.itemId, {
      type: "commandExecution",
      status: "waiting",
      processId: normalizedId(params.processId) || null,
      terminalInput: tail(params.stdin, 1_000),
    }));
  }
  if (method === "item/fileChange/outputDelta") {
    const item = upsert(run, params.itemId, { type: "fileChange", status: "running" });
    if (!item) return null;
    item.output = tail(`${item.output ?? ""}${String(params.delta ?? "")}`, MAX_COMMAND_OUTPUT_CHARS);
    return activity(item);
  }
  if (method === "item/fileChange/patchUpdated") {
    return activity(upsert(run, params.itemId, {
      type: "fileChange",
      status: "running",
      changes: Array.isArray(params.changes) ? params.changes : [],
    }));
  }
  if (method === "item/mcpToolCall/progress") {
    const item = upsert(run, params.itemId, { type: "mcpToolCall", status: "running" });
    if (!item) return null;
    const message = String(params.message ?? "").trim();
    if (message && item.progress?.at(-1) !== message) {
      item.progress = [...(item.progress ?? []), message].slice(-MAX_PROGRESS_MESSAGES);
    }
    return activity(item);
  }
  return null;
}
