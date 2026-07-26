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

test("polling controller preserves a failed update before advancing offset", async () => {
  let offset = 0;
  const events = [];
  const controller = new TelegramPollingController({
    telegram: async () => [],
    config: { allowedUserIds: new Set([7]), allowedChatIds: null, privateChatsOnly: true },
    getOffset: () => offset,
    setOffset: (value) => { offset = value; },
    setProcessingUpdateId: () => {},
    handleMessage: async () => { throw new Error("boom"); },
    handleCallback: async () => {},
    preserveFailedUpdate: async (update) => events.push(`stored:${update.update_id}`),
    sendMessage: async () => events.push("notified"),
    saveState: async () => events.push("saved"),
    afterUpdate: async () => {},
    stopping: () => false,
    logger: { error: () => {} },
  });
  await controller.process({ update_id: 12, message: { text: "hello", chat: { id: 9 } } });
  assert.equal(offset, 13);
  assert.deepEqual(events, ["stored:12", "notified", "saved"]);
});

test("polling controller does not acknowledge a failure that could not be preserved", async () => {
  let offset = 0;
  const controller = new TelegramPollingController({
    telegram: async () => [],
    config: { allowedUserIds: new Set([7]), allowedChatIds: null, privateChatsOnly: true },
    getOffset: () => offset,
    setOffset: (value) => { offset = value; },
    setProcessingUpdateId: () => {},
    handleMessage: async () => { throw new Error("handler"); },
    handleCallback: async () => {},
    preserveFailedUpdate: async () => { throw new Error("disk"); },
    sendMessage: async () => {},
    saveState: async () => {},
    afterUpdate: async () => {},
    stopping: () => false,
    logger: { error: () => {} },
  });
  await assert.rejects(
    controller.process({ update_id: 12, message: { text: "hello", chat: { id: 9 } } }),
    /disk/,
  );
  assert.equal(offset, 0);
});

test("polling controller rolls its in-memory offset back when state persistence fails", async () => {
  let offset = 4;
  const controller = new TelegramPollingController({
    telegram: async () => [],
    config: { allowedUserIds: new Set([7]), allowedChatIds: null, privateChatsOnly: true },
    getOffset: () => offset,
    setOffset: (value) => { offset = value; },
    setProcessingUpdateId: () => {},
    handleMessage: async () => {},
    handleCallback: async () => {},
    preserveFailedUpdate: async () => {},
    sendMessage: async () => {},
    saveState: async () => { throw new Error("disk"); },
    afterUpdate: async () => {},
    stopping: () => false,
  });
  await assert.rejects(
    controller.process({ update_id: 12, message: { text: "hello", chat: { id: 9 } } }),
    /disk/,
  );
  assert.equal(offset, 4);
});

test("polling controller records slow handler and state phases", async () => {
  let offset = 0;
  const warnings = [];
  const times = [10_000, 10_080, 10_125];
  const controller = new TelegramPollingController({
    telegram: async () => [],
    config: { allowedUserIds: new Set([7]), allowedChatIds: null, privateChatsOnly: true },
    getOffset: () => offset,
    setOffset: (value) => { offset = value; },
    setProcessingUpdateId: () => {},
    handleMessage: async () => {},
    handleCallback: async () => {},
    sendMessage: async () => {},
    saveState: async () => {},
    afterUpdate: async () => {},
    stopping: () => false,
    now: () => times.shift(),
    slowUpdateThresholdMs: 100,
    logger: { error: () => {}, warn: (message) => warnings.push(message) },
  });
  await controller.process({ update_id: 12, message: { date: 9, text: "hello", chat: { id: 9 } } });
  assert.equal(offset, 13);
  assert.match(warnings[0], /handler=80 ms, state=45 ms, transport<=1000 ms/);
});
