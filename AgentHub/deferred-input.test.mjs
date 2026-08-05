import assert from "node:assert/strict";
import test from "node:test";

import {
  deferredEditableText,
  deferredInputMatchesRun,
  deferredResponseAnnotations,
  replaceDeferredInputText,
} from "./src/domain/deferred-input.mjs";

test("a dispatching Telegram input reattaches to its exact restored run", () => {
  const item = {
    dispatchingRunId: "run-telegram-1",
    clientUserMessageId: null,
  };
  assert.equal(deferredInputMatchesRun(item, {
    id: "run-telegram-1",
    clientUserMessageId: null,
  }), true);
  assert.equal(deferredInputMatchesRun(item, {
    id: "unrelated-run",
    clientUserMessageId: null,
  }), false);
});

test("editing a queued message preserves its response annotations and image input", () => {
  const input = [
    {
      type: "text",
      text: "# Response annotations:\n"
        + "<response-annotations>\n"
        + "[{\"text\":\"важный фрагмент\",\"annotation\":\"проверь\"}]\n"
        + "</response-annotations>\n\n"
        + "## My request for Codex:\nстарый текст",
    },
    { type: "localImage", path: "C:\\runtime\\message.png" },
  ];

  const edited = replaceDeferredInputText(input, "новый текст");
  assert.equal(deferredEditableText(edited), "новый текст");
  assert.deepEqual(deferredResponseAnnotations(edited)?.annotations, [
    { text: "важный фрагмент", annotation: "проверь" },
  ]);
  assert.deepEqual(edited[1], input[1]);
});

test("editing an image-only queued message can add text", () => {
  const image = { type: "localImage", path: "C:\\runtime\\message.png" };
  const edited = replaceDeferredInputText([image], "добавленный текст");
  assert.deepEqual(edited, [
    { type: "text", text: "добавленный текст" },
    image,
  ]);
});
import {
  parsePendingInputCallback,
  pendingInputKeyboard,
  restoreDeferredInput,
} from "./src/domain/deferred-input.mjs";

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

test("repository conflicts remain pending when the optional guard is enabled", () => {
  const item = {
    id: "019f7152-726b-7b62-a595-62a3fccef0bf",
    provider: "codex",
    threadId: "thread-1",
    conflictKind: "repository",
    allowForce: true,
  };
  assert.deepEqual(
    restoreDeferredInput(item, { guardConcurrentRepositoryWrites: true }),
    { destination: "pending", item },
  );
});

test("restart turns an interrupted manual steer back into an actionable pending message", () => {
  const item = {
    id: "019f7152-726b-7b62-a595-62a3fccef0bf",
    provider: "codex",
    threadId: "thread-1",
    input: "Не потерять сообщение",
    manualAction: "steer",
  };
  assert.deepEqual(restoreDeferredInput(item), {
    destination: "pending",
    item: {
      id: item.id,
      provider: item.provider,
      threadId: item.threadId,
      input: item.input,
    },
  });
});

test("legacy Desktop attachments become persistent while other temporary files stay temporary", () => {
  const desktopItem = {
    id: "019f7152-726b-7b62-a595-62a3fccef0bf",
    provider: "codex",
    threadId: "thread-1",
    clientUserMessageId: "desktop-message-1",
    temporaryFiles: ["desktop/attachments/image.png"],
  };
  assert.deepEqual(
    restoreDeferredInput(desktopItem, {
      persistentFile: (file) => String(file).startsWith("desktop/attachments/"),
    }),
    {
      destination: "pending",
      item: { ...desktopItem, persistentFiles: true },
    },
  );

  const telegramItem = {
    ...desktopItem,
    clientUserMessageId: null,
    temporaryFiles: ["telegram/temp/image.png"],
  };
  assert.deepEqual(
    restoreDeferredInput(telegramItem, {
      persistentFile: (file) => String(file).startsWith("desktop/attachments/"),
    }),
    { destination: "pending", item: telegramItem },
  );
});
