import assert from "node:assert/strict";
import test from "node:test";

import {
  formatForwardBundlePrompt,
  forwardedMessageSource,
  parseForwardBundleCallback,
  restoreForwardBundle,
  TelegramForwardBundleController,
} from "./telegram-forward-bundle.mjs";

const TARGET = {
  provider: "codex",
  projectRoot: "C:\\Project",
  threadId: "thread-1",
  taskTitle: "Задача",
  modelId: "gpt-test",
  reasoningId: "high",
  collaborationMode: "default",
};

function forwarded(messageId, text, origin) {
  return {
    message_id: messageId,
    from: { id: 7, first_name: "Владелец" },
    chat: { id: 9, type: "private" },
    date: 1_000 + messageId,
    text,
    forward_origin: origin,
  };
}

function fixture() {
  const bundles = new Map();
  const cards = [];
  const bindings = [];
  const turns = [];
  const imageJobs = [];
  const removedFiles = [];
  let messageSequence = 100;
  let saves = 0;
  const controller = new TelegramForwardBundleController({
    bundles,
    selectedTarget: () => TARGET,
    bindIncomingMessage: async (message, text, target) => bindings.push({ message, text, target }),
    sendCard: async (chatId, text, replyMarkup) => {
      const message = { message_id: messageSequence++, chat: { id: chatId }, text };
      cards.push({ kind: "send", chatId, text, replyMarkup, message });
      return message;
    },
    editCard: async (chatId, messageId, text, replyMarkup) => {
      cards.push({ kind: "edit", chatId, messageId, text, replyMarkup });
    },
    save: async () => { saves += 1; },
    startTurn: async (...args) => {
      turns.push(args);
      return { started: true };
    },
    enqueueImage: async (payload, dedupeKey) => {
      imageJobs.push({ payload, dedupeKey });
      return { id: `job-${imageJobs.length}` };
    },
    removeFile: async (file) => { removedFiles.push(file); },
    now: () => 2_000_000,
    createId: () => "11111111-1111-4111-8111-111111111111",
  });
  return {
    controller,
    bundles,
    cards,
    bindings,
    turns,
    imageJobs,
    removedFiles,
    saves: () => saves,
  };
}

test("forward source preserves visible, hidden, channel and own authors", () => {
  assert.deepEqual(forwardedMessageSource(forwarded(1, "a", {
    type: "user",
    sender_user: { id: 8, first_name: "Иван", last_name: "Петров" },
  })), { type: "user", label: "Иван Петров" });
  assert.deepEqual(forwardedMessageSource(forwarded(2, "b", {
    type: "hidden_user",
    sender_user_name: "Скрытый Иван",
  })), { type: "hidden-user", label: "Скрытый Иван" });
  assert.deepEqual(forwardedMessageSource(forwarded(3, "c", {
    type: "channel",
    chat: { title: "Новости" },
    author_signature: "Редактор",
  })), { type: "channel", label: "Новости · Редактор" });
  assert.deepEqual(forwardedMessageSource(forwarded(4, "d", {
    type: "user",
    sender_user: { id: 7, first_name: "Владелец" },
  })), { type: "user", label: "Вы (переслано)" });
  assert.equal(forwardedMessageSource({ text: "обычное" }), null);
});

test("bundle collects forwarded messages and own comments before one turn", async () => {
  const state = fixture();
  assert.equal(await state.controller.handleText(forwarded(1, "Первая реплика", {
    type: "user",
    sender_user: { id: 8, first_name: "Иван" },
  }), "Первая реплика"), true);
  assert.equal(await state.controller.handleText(forwarded(2, "Вторая реплика", {
    type: "hidden_user",
    sender_user_name: "Мария",
  }), "Вторая реплика"), true);
  assert.equal(await state.controller.handleText({
    message_id: 3,
    from: { id: 7 },
    chat: { id: 9, type: "private" },
    text: "Мой комментарий",
  }, "Мой комментарий"), true);

  assert.equal(state.bundles.get("9").items.length, 3);
  assert.equal(state.turns.length, 0);
  assert.match(state.cards.at(-1).text, /Сообщений: 3 · переслано: 2 · ваших: 1/);

  const result = await state.controller.submit("11111111-1111-4111-8111-111111111111");
  assert.equal(result.status, "started");
  assert.equal(state.turns.length, 1);
  assert.equal(state.bundles.size, 0);
  const prompt = state.turns[0][0];
  assert.match(prompt, /Сообщение 1 · Переслано · Иван/);
  assert.match(prompt, /Сообщение 2 · Переслано · Мария/);
  assert.match(prompt, /Сообщение 3 · Вы/);
  assert.ok(prompt.indexOf("Первая реплика") < prompt.indexOf("Вторая реплика"));
  assert.ok(prompt.indexOf("Вторая реплика") < prompt.indexOf("Мой комментарий"));
  assert.deepEqual(state.turns[0][2].target, { ...TARGET, chatId: 9 });
});

test("ordinary text starts a bundle only after a forwarded message", async () => {
  const state = fixture();
  assert.equal(await state.controller.handleText({
    message_id: 1,
    from: { id: 7 },
    chat: { id: 9, type: "private" },
    text: "Обычный запрос",
  }, "Обычный запрос"), false);
  assert.equal(state.bundles.size, 0);
  assert.equal(await state.controller.handleText({
    message_id: 2,
    from: { id: 7 },
    chat: { id: 9, type: "private" },
    text: "/status",
  }, "/status", { forwardedOnly: true }), false);
});

test("undo, cancellation, callback parsing and restore are deterministic", async () => {
  const state = fixture();
  await state.controller.handleText(forwarded(1, "Первая", {
    type: "user",
    sender_user: { id: 8, first_name: "Иван" },
  }), "Первая");
  await state.controller.handleText(forwarded(2, "Вторая", {
    type: "user",
    sender_user: { id: 9, first_name: "Мария" },
  }), "Вторая");
  const id = state.bundles.get("9").id;
  assert.deepEqual(parseForwardBundleCallback(`forward-bundle:undo:${id}`), { action: "undo", id });
  assert.equal((await state.controller.undo(id)).count, 1);
  const restored = restoreForwardBundle(structuredClone(state.bundles.get("9")), {
    now: 2_000_000,
  });
  assert.equal(restored.items.length, 1);
  assert.equal(restored.submitting, false);
  assert.equal((await state.controller.cancel(id)).status, "cancelled");
  assert.equal(state.bundles.size, 0);
});

test("formatted prompt keeps interleaved authors", () => {
  const prompt = formatForwardBundlePrompt({
    items: [
      { kind: "forward", source: { label: "Клиент" }, text: "Нужно исправить" },
      { kind: "comment", text: "Сделай аккуратно" },
    ],
  });
  assert.match(prompt, /Переслано · Клиент/);
  assert.match(prompt, /Сообщение 2 · Вы/);
});

test("forwarded Telegram album stays in one bundle and starts one turn with all images", async () => {
  const state = fixture();
  const origin = {
    type: "user",
    sender_user: { id: 8, first_name: "Клиент" },
  };
  for (let index = 1; index <= 3; index += 1) {
    assert.equal(await state.controller.handleImage({
      ...forwarded(index, index === 1 ? "Описание проблемы" : null, origin),
      text: undefined,
      caption: index === 1 ? "Описание проблемы" : undefined,
      media_group_id: "album-1",
      photo: [{ file_id: `photo-${index}`, file_size: 128 }],
    }), true);
  }
  const bundle = state.bundles.get("9");
  assert.equal(bundle.items.length, 3);
  assert.equal(state.imageJobs.length, 3);
  assert.equal(state.turns.length, 0);
  assert.match(state.cards.at(-1).text, /изображений: 3/);
  assert.match(state.cards.at(-1).text, /Загружается изображений: 3/);

  for (let index = 1; index <= 3; index += 1) {
    await state.controller.completeImage(bundle.id, index, `C:\\images\\${index}.jpg`);
  }
  const result = await state.controller.submit(bundle.id);
  assert.equal(result.status, "started");
  assert.equal(state.turns.length, 1);
  assert.deepEqual(state.turns[0][1], [
    "C:\\images\\1.jpg",
    "C:\\images\\2.jpg",
    "C:\\images\\3.jpg",
  ]);
  const input = state.turns[0][0];
  assert.equal(input.filter((item) => item.type === "localImage").length, 3);
  assert.match(input.map((item) => item.text ?? "").join("\n"), /Описание проблемы/);
});

test("bundle submit waits while album images are still loading", async () => {
  const state = fixture();
  await state.controller.handleImage({
    ...forwarded(1, null, {
      type: "hidden_user",
      sender_user_name: "Клиент",
    }),
    text: undefined,
    photo: [{ file_id: "photo-1", file_size: 128 }],
  });
  const bundle = state.bundles.get("9");
  assert.equal((await state.controller.submit(bundle.id)).status, "waiting");
  assert.equal(state.turns.length, 0);
  assert.match(state.cards.at(-1).text, /Дождитесь загрузки/);
});
