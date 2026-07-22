import assert from "node:assert/strict";
import test from "node:test";
import {
  parsePendingInputCallback,
  pendingInputKeyboard,
  restoreDeferredInput,
} from "./deferred-input.mjs";

test("pendingInputKeyboard preserves every deferred-message action", () => {
  const id = "019f7152-726b-7b62-a595-62a3fccef0bf";
  assert.deepEqual(pendingInputKeyboard(id), {
    inline_keyboard: [
      [{ text: "🆕 Отправить в новую задачу", callback_data: `pending:new:${id}` }],
      [{ text: "⏳ Поставить в очередь", callback_data: `pending:queue:${id}` }],
    [{ text: "👀 Показать текущий ход", callback_data: `pending:show:${id}` }],
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

test("pendingInputKeyboard can explicitly allow a risky same-task launch", () => {
  const id = "019f7152-726b-7b62-a595-62a3fccef0bf";
  const keyboard = pendingInputKeyboard(id, { allowForce: true });
  assert.equal(keyboard.inline_keyboard[2][0].callback_data, `pending:force:${id}`);
  assert.deepEqual(parsePendingInputCallback(`pending:force:${id}`), { action: "force", id });
});

test("legacy repository conflicts resume automatically as queued inputs", () => {
  const item = {
    id: "019f7152-726b-7b62-a595-62a3fccef0bf",
    provider: "codex",
    threadId: "thread-1",
    conflictKind: "repository",
    allowForce: true,
  };
  assert.deepEqual(restoreDeferredInput(item), {
    destination: "queued",
    item: {
      ...item,
      conflictKind: null,
      allowForce: false,
    },
  });
  assert.equal(restoreDeferredInput({ id: "broken" }), null);
});
