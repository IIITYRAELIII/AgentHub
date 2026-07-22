import assert from "node:assert/strict";
import test from "node:test";
import { TelegramPollingController } from "./telegram-polling-controller.mjs";

test("polling controller advances offset after a handled update", async () => {
  let offset = 0;
  let processing = null;
  const seen = [];
  const controller = new TelegramPollingController({
    telegram: async () => [],
    config: { allowedUserIds: new Set([7]), allowedChatIds: null, privateChatsOnly: true },
    getOffset: () => offset,
    setOffset: (value) => { offset = value; },
    setProcessingUpdateId: (value) => { processing = value; },
    handleMessage: async (message) => seen.push(message.text),
    handleCallback: async () => {},
    sendMessage: async () => {},
    saveState: async () => seen.push("saved"),
    afterUpdate: async () => seen.push("after"),
    stopping: () => false,
  });
  await controller.process({ update_id: 12, message: { text: "hello", chat: { id: 9 } } });
  assert.equal(offset, 13);
  assert.equal(processing, null);
  assert.deepEqual(seen, ["hello", "saved", "after"]);
});

test("polling controller ignores unauthorized callbacks", async () => {
  let callbacks = 0;
  const controller = new TelegramPollingController({
    telegram: async () => [],
    config: { allowedUserIds: new Set([7]), allowedChatIds: null, privateChatsOnly: true },
    getOffset: () => 0,
    setOffset: () => {},
    setProcessingUpdateId: () => {},
    handleMessage: async () => {},
    handleCallback: async () => { callbacks += 1; },
    sendMessage: async () => {},
    saveState: async () => {},
    afterUpdate: async () => {},
    stopping: () => false,
  });
  await controller.process({
    update_id: 1,
    callback_query: { from: { id: 8 }, message: { chat: { id: 9, type: "private" } } },
  });
  assert.equal(callbacks, 0);
});
