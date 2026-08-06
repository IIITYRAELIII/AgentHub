import assert from "node:assert/strict";
import test from "node:test";
import { TelegramMessageController } from "../../../src/interfaces/telegram/telegram-message-controller.mjs";

function fixture(overrides = {}) {
  const events = [];
  const controller = new TelegramMessageController({
    config: {
      allowedUserIds: new Set([7]),
      allowedChatIds: new Set([9]),
      privateChatsOnly: true,
    },
    menuCommands: new Map([["Кнопка", "/status"]]),
    setChatId: (id) => events.push(["chat", id]),
    findReplyBinding: async () => null,
    activateBinding: async () => ({ changed: false }),
    notifyTaskSwitch: async () => events.push(["switch"]),
    selectedTurnTarget: (chatId) => ({ chatId }),
    bindIncomingMessage: async (_message, text) => events.push(["bind", text]),
    enqueueMedia: async (kind) => events.push(["media", kind]),
    commandHandlers: {
      status: async ({ argument }) => events.push(["status", argument]),
      rename: async ({ argument }) => events.push(["rename", argument]),
    },
    handleText: async (_message, text) => events.push(["text", text]),
    sendMessage: async (text) => events.push(["send", text]),
    logger: { warn: (text) => events.push(["warn", text]) },
    ...overrides,
  });
  return { controller, events };
}

const baseMessage = { from: { id: 7 }, chat: { id: 9, type: "private" } };

test("routes menu aliases and command arguments", async () => {
  const { controller, events } = fixture();
  await controller.handle({ ...baseMessage, text: "Кнопка" });
  await controller.handle({ ...baseMessage, text: "/rename Новое имя" });
  assert.deepEqual(events.filter(([kind]) => kind === "status" || kind === "rename"), [
    ["status", ""],
    ["rename", "Новое имя"],
  ]);
});

test("routes image before text and binds it to selected task", async () => {
  const { controller, events } = fixture();
  await controller.handle({ ...baseMessage, photo: [{ file_id: "x" }], caption: "Смотри" });
  assert.deepEqual(events.slice(-2), [["bind", "Смотри"], ["media", "image"]]);
});

test("forwarded image is collected before the ordinary media queue", async () => {
  const { controller, events } = fixture({
    handleBundleMedia: async (_message, options) => {
      events.push(["bundle-media", options?.forwardedOnly === true]);
      return options?.forwardedOnly === true;
    },
  });
  await controller.handle({
    ...baseMessage,
    message_id: 13,
    photo: [{ file_id: "x" }],
    forward_origin: {
      type: "hidden_user",
      sender_user_name: "Клиент",
    },
  });
  assert.deepEqual(events.filter(([kind]) => ["bundle-media", "media"].includes(kind)), [
    ["bundle-media", true],
  ]);
});

test("own image joins an already open forwarded bundle", async () => {
  const { controller, events } = fixture({
    handleBundleMedia: async (_message, options) => {
      events.push(["bundle-media", options?.forwardedOnly === true]);
      return options?.forwardedOnly !== true;
    },
  });
  await controller.handle({
    ...baseMessage,
    message_id: 14,
    photo: [{ file_id: "x" }],
  });
  assert.deepEqual(events.filter(([kind]) => ["bundle-media", "media"].includes(kind)), [
    ["bundle-media", true],
    ["bundle-media", false],
  ]);
});

test("rejects unauthorized senders before changing chat state", async () => {
  const { controller, events } = fixture();
  await controller.handle({ ...baseMessage, from: { id: 8 }, text: "/status" });
  assert.equal(events.some(([kind]) => kind === "chat"), false);
  assert.equal(events[0][0], "warn");
});

test("reply binding switches context before dispatch", async () => {
  const { controller, events } = fixture({
    findReplyBinding: async () => ({ threadId: "task" }),
    activateBinding: async () => ({ changed: true }),
  });
  await controller.handle({
    ...baseMessage,
    text: "/status",
    reply_to_message: { message_id: 10 },
  });
  assert.equal(events.some(([kind]) => kind === "switch"), true);
  assert.equal(events.some(([kind]) => kind === "status"), true);
});

test("bundle handler intercepts collected text before ordinary binding and turn start", async () => {
  const { controller, events } = fixture({
    handleBundleText: async (_message, text, options) => {
      events.push(["bundle", text, options?.forwardedOnly === true]);
      return options?.forwardedOnly !== true;
    },
  });
  await controller.handle({ ...baseMessage, message_id: 11, text: "Пересланная реплика" });
  assert.deepEqual(events.filter(([kind]) => ["bundle", "bind", "text"].includes(kind)), [
    ["bundle", "Пересланная реплика", true],
    ["bundle", "Пересланная реплика", false],
  ]);
});

test("forwarded command-looking text is offered to the bundle before command parsing", async () => {
  const { controller, events } = fixture({
    handleBundleText: async (_message, text, options) => {
      events.push(["bundle", text, options?.forwardedOnly === true]);
      return options?.forwardedOnly === true;
    },
  });
  await controller.handle({
    ...baseMessage,
    message_id: 12,
    text: "/status",
    forward_origin: {
      type: "hidden_user",
      sender_user_name: "Клиент",
    },
  });
  assert.deepEqual(events.filter(([kind]) => ["bundle", "status"].includes(kind)), [
    ["bundle", "/status", true],
  ]);
});
