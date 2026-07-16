import assert from "node:assert/strict";
import test from "node:test";
import { currentThreadBinding, notificationParts, parseArguments, resolveChatId, splitTelegramText } from "./send-message.mjs";

test("parseArguments reads text and options", () => {
  assert.deepEqual(parseArguments(["--silent", "--chat-id", "123", "Готово"]), {
    help: false,
    chatId: "123",
    silent: true,
    bindCurrent: false,
    text: "Готово",
  });
});

test("parseArguments enables current task binding", () => {
  assert.equal(parseArguments(["--bind-current", "Готово"]).bindCurrent, true);
});

test("currentThreadBinding reads the active provider task", () => {
  assert.deepEqual(currentThreadBinding({
    activeProvider: "codex",
    activeProjectRoot: "C:\\Project",
    threadIds: { codex: "thread-1", claude: null },
    activeThreadTitle: "Проверка обмена",
  }), { provider: "codex", threadId: "thread-1", projectRoot: "C:\\Project", taskTitle: "Проверка обмена" });
});

test("notificationParts surrounds a bold title with matching task emojis", () => {
  assert.equal(notificationParts("Задача <1>", "Готово").message, "🧵 <b>Задача &lt;1&gt;</b> 🧵\n\nГотово");
});

test("resolveChatId uses the single configured private recipient", () => {
  assert.equal(resolveChatId({ allowedChatIds: null, allowedUserIds: new Set([123]) }), 123);
  assert.equal(resolveChatId({ allowedChatIds: new Set([456]), allowedUserIds: new Set([123]) }), 456);
});

test("splitTelegramText splits long messages", () => {
  assert.deepEqual(splitTelegramText("123456789", 4), ["1234", "5678", "9"]);
});
