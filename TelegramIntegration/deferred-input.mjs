export function pendingInputKeyboard(id) {
  const value = String(id ?? "").trim();
  if (!/^[0-9a-f-]+$/i.test(value)) throw new Error("invalid pending input id");
  return {
    inline_keyboard: [
      [{ text: "🆕 Отправить в новую задачу", callback_data: `pending:new:${value}` }],
      [{ text: "⏳ Поставить в очередь", callback_data: `pending:queue:${value}` }],
    [{ text: "👀 Показать текущий ход", callback_data: `pending:show:${value}` }],
      [{ text: "❌ Отменить сообщение", callback_data: `pending:cancel:${value}` }],
    ],
  };
}

export function parsePendingInputCallback(value) {
  const match = /^pending:(new|queue|show|cancel):([0-9a-f-]+)$/i.exec(String(value ?? ""));
  if (!match) return null;
  return {
    action: match[1].toLowerCase(),
    id: match[2],
  };
}
