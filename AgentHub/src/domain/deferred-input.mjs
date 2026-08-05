export function deferredInputText(input) {
  return typeof input === "string"
    ? input
    : (Array.isArray(input) ? input : [])
      .filter((part) => part?.type === "text")
      .map((part) => String(part.text ?? ""))
      .join("\n");
}

export function deferredInputMatchesRun(item, run) {
  if (!item || !run) return false;
  const dispatchingRunId = String(item.dispatchingRunId ?? "").trim();
  if (dispatchingRunId && dispatchingRunId === String(run.id ?? "").trim()) return true;
  const clientUserMessageId = String(item.clientUserMessageId ?? "").trim();
  return Boolean(clientUserMessageId
    && clientUserMessageId === String(run.clientUserMessageId ?? "").trim());
}

export function deferredResponseAnnotations(input) {
  const text = deferredInputText(input);
  const block = text.match(/<response-annotations>\s*([\s\S]*?)\s*<\/response-annotations>/iu);
  const marker = /^##\s*My request for Codex:\s*$/imu;
  if (!block || !marker.test(text)) return null;
  try {
    const annotations = JSON.parse(block[1]);
    if (!Array.isArray(annotations)) return null;
    return {
      annotations,
      request: text.split(marker).slice(1).join("\n").trim(),
    };
  } catch {
    return null;
  }
}

export function deferredEditableText(input) {
  return deferredResponseAnnotations(input)?.request ?? deferredInputText(input).trim();
}

export function replaceDeferredInputText(input, text) {
  const replacement = String(text ?? "").trim();
  const replace = (value) => {
    const source = String(value ?? "");
    const marker = /^##\s*My request for Codex:\s*$/imu;
    if (!deferredResponseAnnotations(source) || !marker.test(source)) return replacement;
    const match = marker.exec(source);
    return `${source.slice(0, match.index + match[0].length)}\n${replacement}`;
  };
  if (typeof input === "string") return replace(input);
  let replaced = false;
  const parts = (Array.isArray(input) ? input : []).map((part) => {
    if (replaced || part?.type !== "text") return part;
    replaced = true;
    return { ...part, text: replace(part.text) };
  });
  return !replaced && replacement
    ? [{ type: "text", text: replacement }, ...parts]
    : parts;
}

export function pendingInputKeyboard(id, { allowForce = false } = {}) {
  const value = String(id ?? "").trim();
  if (!/^[0-9a-f-]+$/i.test(value)) throw new Error("invalid pending input id");
  const forceRows = allowForce
    ? [[{ text: "⚠️ Всё равно запустить здесь", callback_data: `pending:force:${value}` }]]
    : [];
  return {
    inline_keyboard: [
      [{ text: "🆕 Отправить в новую задачу", callback_data: `pending:new:${value}` }],
      [{ text: "⏳ Поставить в очередь", callback_data: `pending:queue:${value}` }],
      ...forceRows,
      [{ text: "👀 Показать текущий ход", callback_data: `pending:show:${value}` }],
      [{ text: "❌ Отменить сообщение", callback_data: `pending:cancel:${value}` }],
    ],
  };
}

export function parsePendingInputCallback(value) {
  const match = /^pending:(new|queue|force|show|cancel):([0-9a-f-]+)$/i.exec(String(value ?? ""));
  if (!match) return null;
  return {
    action: match[1].toLowerCase(),
    id: match[2],
  };
}

export function restoreDeferredInput(item, {
  guardConcurrentRepositoryWrites = false,
  persistentFile = () => false,
} = {}) {
  if (!item?.id || !item?.threadId || !item?.provider) return null;
  const temporaryFiles = Array.isArray(item.temporaryFiles) ? item.temporaryFiles : [];
  const candidate = item.persistentFiles === true
    || !item.clientUserMessageId
    || temporaryFiles.length === 0
    || !temporaryFiles.every((file) => persistentFile(file))
    ? item
    : { ...item, persistentFiles: true };
  // An interrupted manual steer has an unknown external outcome. Keep the
  // durable input for an explicit retry, but never restore a transient UI
  // "sending" state after the process that owned it has gone away.
  const { manualAction: _manualAction, ...restoredItem } = candidate;
  if (restoredItem.conflictKind !== "repository") {
    return { destination: "pending", item: restoredItem };
  }
  if (guardConcurrentRepositoryWrites) {
    return { destination: "pending", item: restoredItem };
  }
  return {
    destination: "queued",
    item: {
      ...restoredItem,
      allowForce: false,
      conflictKind: null,
    },
  };
}
