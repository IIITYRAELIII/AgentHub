import assert from "node:assert/strict";
import test from "node:test";
import {
  parsePendingInputCallback,
  pendingInputKeyboard,
} from "./deferred-input.mjs";

test("pendingInputKeyboard preserves every deferred-message action", () => {
  const id = "019f7152-726b-7b62-a595-62a3fccef0bf";
  assert.deepEqual(pendingInputKeyboard(id), {
    inline_keyboard: [
      [{ text: "🆕 Отправить в новую задачу", callback_data: `pending:new:${id}` }],
      [{ text: "⏳ Поставить в очередь", callback_data: `pending:queue:${id}` }],
      [{ text: "👁 Показать текущий ход", callback_data: `pending:show:${id}` }],
      [{ text: "❌ Отменить сообщение", callback_data: `pending:cancel:${id}` }],
    ],
  });
});

test("parsePendingInputCallback accepts only known actions and ids", () => {
  assert.deepEqual(
    parsePendingInputCallback("pending:queue:019f7152-726b-7b62-a595-62a3fccef0bf"),
    { action: "queue", id: "019f7152-726b-7b62-a595-62a3fccef0bf" },
  );
  assert.equal(parsePendingInputCallback("pending:drop:nope"), null);
});
