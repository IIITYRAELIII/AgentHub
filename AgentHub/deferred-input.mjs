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
  const restoredItem = item.persistentFiles === true
    || !item.clientUserMessageId
    || temporaryFiles.length === 0
    || !temporaryFiles.every((file) => persistentFile(file))
    ? item
    : { ...item, persistentFiles: true };
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
