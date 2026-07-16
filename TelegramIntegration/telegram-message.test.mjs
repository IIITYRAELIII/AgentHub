import assert from "node:assert/strict";
import test from "node:test";
import { telegramPrompt } from "./telegram-message.mjs";

test("telegramPrompt preserves ordinary messages", () => {
  assert.equal(telegramPrompt({ text: "Продолжай" }), "Продолжай");
});

test("telegramPrompt includes replied-to Telegram text", () => {
  assert.equal(telegramPrompt({
    text: "Что ты об этом думаешь?",
    reply_to_message: { text: "Тест принят" },
  }), "Пользователь отвечает на сообщение:\n> Тест принят\n\nТекст пользователя:\nЧто ты об этом думаешь?");
});

test("telegramPrompt supports quoted captions", () => {
  assert.match(telegramPrompt({ text: "Проверь", reply_to_message: { caption: "Описание файла" } }), /> Описание файла/);
});
