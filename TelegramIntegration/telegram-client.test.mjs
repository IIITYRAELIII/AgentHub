import assert from "node:assert/strict";
import test from "node:test";

import { TelegramClient } from "./telegram-client.mjs";

function client(overrides = {}) {
  const requests = [];
  const result = new TelegramClient({
    token: "test-token",
    apiBaseUrl: "http://telegram.test",
    menu: { keyboard: [[{ text: "Меню" }]] },
    statusHeaderDirectory: "headers",
    selectStatusHeader: () => "codex.png",
    getDefaultChatId: () => 42,
    getDefaultProvider: () => "codex",
    rememberSpeechText: () => null,
    fetchImpl: async (url, options) => {
      requests.push({ url: String(url), options });
      return new Response(JSON.stringify({ ok: true, result: { message_id: requests.length } }));
    },
    ...overrides,
  });
  return { result, requests };
}

test("TelegramClient attaches the persistent menu only when reply markup is omitted", async () => {
  const { result, requests } = client();
  await result.sendMessage("one");
  await result.sendMessage("two", { reply_markup: { inline_keyboard: [] } });

  const first = JSON.parse(requests[0].options.body);
  const second = JSON.parse(requests[1].options.body);
  assert.deepEqual(first.reply_markup, { keyboard: [[{ text: "Меню" }]] });
  assert.deepEqual(second.reply_markup, { inline_keyboard: [] });
});

test("TelegramClient sends a short status as one media caption", async () => {
  const { result, requests } = client({
    fileExists: () => true,
    readFileImpl: async () => Buffer.from("image"),
  });
  await result.sendStatusCard("status", { parse_mode: "HTML" }, ["codex"]);

  assert.equal(requests.length, 1);
  assert.match(requests[0].url, /sendPhoto$/);
  assert.equal(requests[0].options.body.get("caption"), "status");
  assert.equal(requests[0].options.body.get("parse_mode"), "HTML");
});

test("TelegramClient splits long output and puts speech action on the last part", async () => {
  const { result, requests } = client({
    messageLimit: 10,
    rememberSpeechText: () => "abc",
  });
  await result.sendLongMessage("1234567890ABCDE", { speechText: "spoken" });

  assert.equal(requests.length, 2);
  const first = JSON.parse(requests[0].options.body);
  const second = JSON.parse(requests[1].options.body);
  assert.equal(first.text, "1234567890");
  assert.equal(second.text, "ABCDE");
  assert.deepEqual(second.reply_markup.inline_keyboard[0][0], {
    text: "🔊 Озвучить",
    callback_data: "speech:abc",
  });
});

test("TelegramClient typing lifecycle owns a single interval", async () => {
  const ticks = [];
  const cleared = [];
  const { result, requests } = client({
    setIntervalImpl: (callback, delay) => {
      ticks.push({ callback, delay });
      return 17;
    },
    clearIntervalImpl: (id) => cleared.push(id),
  });

  result.startTyping();
  result.startTyping();
  await Promise.resolve();
  assert.equal(requests.length, 1);
  assert.equal(ticks.length, 1);
  assert.equal(ticks[0].delay, 4000);
  result.stopTyping();
  assert.deepEqual(cleared, [17]);
});
