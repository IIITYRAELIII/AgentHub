import assert from "node:assert/strict";
import test from "node:test";
import {
  codexThreadTitleFromIndex,
  currentCallerBinding,
  currentThreadBinding,
  notificationParts,
  parseArguments,
  resolveNotificationCategory,
  resolveChatId,
  splitTelegramText,
} from "./send-message.mjs";
import { findContainingProject } from "./config.mjs";

test("parseArguments reads text and options", () => {
  assert.deepEqual(parseArguments(["--silent", "--chat-id", "123", "Готово"]), {
    help: false,
    chatId: "123",
    silent: true,
    bindCurrent: false,
    bindActive: false,
    category: "info",
    text: "Готово",
  });
});

test("parseArguments enables current task binding", () => {
  assert.equal(parseArguments(["--bind-current", "Готово"]).bindCurrent, true);
});

test("parseArguments keeps active bot task binding explicit", () => {
  assert.equal(parseArguments(["--bind-active", "Готово"]).bindActive, true);
  assert.throws(
    () => parseArguments(["--bind-current", "--bind-active", "Готово"]),
    /either --bind-current or --bind-active/,
  );
});

test("parseArguments reads and validates the notification category", () => {
  assert.equal(parseArguments(["--category", "done", "Готово"]).category, "done");
  assert.equal(parseArguments(["--category=action", "Нужен ответ"]).category, "action");
  assert.throws(() => parseArguments(["--category", "unknown", "Текст"]), /Unknown --category value/);
});

test("currentThreadBinding reads the active provider task", () => {
  assert.deepEqual(currentThreadBinding({
    activeProvider: "codex",
    activeProjectRoot: "C:\\Project",
    threadIds: { codex: "thread-1", claude: null },
    activeThreadTitle: "Проверка обмена",
  }), { provider: "codex", threadId: "thread-1", projectRoot: "C:\\Project", taskTitle: "Проверка обмена" });
});

test("codexThreadTitleFromIndex reads the latest matching title", () => {
  const index = [
    JSON.stringify({ id: "thread-1", thread_name: "Старое название" }),
    "{incomplete",
    JSON.stringify({ id: "thread-1", thread_name: "Продолжить копирование томов RDP" }),
  ].join("\n");
  assert.equal(codexThreadTitleFromIndex(index, "thread-1"), "Продолжить копирование томов RDP");
});

test("currentCallerBinding prefers the calling Codex thread over bot state", async () => {
  const binding = await currentCallerBinding({
    activeProvider: "codex",
    activeProjectRoot: "C:\\Wrong",
    threadIds: { codex: "wrong-thread" },
    activeThreadTitle: "Чужая задача",
  }, {
    CODEX_THREAD_ID: "caller-thread",
    CODEX_HOME: "Z:\\missing-codex-home",
    CODEX_PROJECT_ROOT: "C:\\Current",
  }, "C:\\Fallback");
  assert.deepEqual(binding, {
    provider: "codex",
    threadId: "caller-thread",
    projectRoot: "C:\\Current",
    taskTitle: "Codex · caller-t",
  });
});

test("currentCallerBinding selects the exact Claude session despite stale Codex state", async () => {
  const binding = await currentCallerBinding({
    activeProvider: "codex",
    activeProjectRoot: "C:\\Wrong",
    threadIds: { codex: "wrong-thread", claude: "another-claude-thread" },
    activeThreadTitle: "Продолжить копирование томов RDP",
  }, {
    CLAUDECODE: "1",
    CLAUDE_CODE_SESSION_ID: "claude-caller-session",
    CLAUDE_PROJECT_DIR: "C:\\ClaudeProject",
  }, "C:\\Fallback");
  assert.deepEqual(binding, {
    provider: "claude",
    threadId: "claude-caller-session",
    projectRoot: "C:\\ClaudeProject",
    taskTitle: "Claude · claude-c",
  });
});

test("currentCallerBinding reuses a title only for the same active Claude session", async () => {
  const binding = await currentCallerBinding({
    activeProvider: "claude",
    activeProjectRoot: "C:\\Project",
    threadIds: { codex: null, claude: "claude-caller-session" },
    activeThreadTitle: "Универсализация инструментов",
  }, {
    CLAUDE_CODE_SESSION_ID: "claude-caller-session",
  }, "C:\\Project");
  assert.equal(binding.taskTitle, "Универсализация инструментов");
});

test("currentCallerBinding never falls back to an unrelated active bot task", async () => {
  const staleState = {
    activeProvider: "codex",
    activeProjectRoot: "C:\\Wrong",
    threadIds: { codex: "wrong-thread", claude: "another-claude-thread" },
    activeThreadTitle: "Чужая задача",
  };
  await assert.rejects(
    currentCallerBinding(staleState, {}, "C:\\Current"),
    /neither CODEX_THREAD_ID nor CLAUDE_CODE_SESSION_ID is set/,
  );
  await assert.rejects(
    currentCallerBinding(staleState, { CLAUDECODE: "1" }, "C:\\Current"),
    /CLAUDE_CODE_SESSION_ID is missing/,
  );
});

test("currentCallerBinding rejects ambiguous caller environments", async () => {
  await assert.rejects(
    currentCallerBinding({}, { CODEX_THREAD_ID: "codex-1", CLAUDE_CODE_SESSION_ID: "claude-1" }),
    /both CODEX_THREAD_ID and CLAUDE_CODE_SESSION_ID are set/,
  );
});

test("findContainingProject maps a nested caller directory to the configured project root", () => {
  const projects = [
    { name: "Workspace", path: "C:\\Workspace" },
    { name: "Nested repo", path: "C:\\Workspace\\Repo" },
  ];
  assert.deepEqual(
    findContainingProject(projects, "C:\\Workspace\\Repo\\src"),
    projects[1],
  );
  assert.equal(findContainingProject(projects, "C:\\Outside"), undefined);
});

test("notificationParts adds a bold underlined category above the task title", () => {
  assert.equal(
    notificationParts("Задача <1>", "Готово", "done").message,
    "✅ <b><u>ЗАДАЧА ВЫПОЛНЕНА</u></b> ✅\n\n🧵 <b>Задача &lt;1&gt;</b>\n\nГотово",
  );
});

test("resolveNotificationCategory defaults to information", () => {
  assert.deepEqual(resolveNotificationCategory(), { key: "info", emoji: "ℹ️", title: "ИНФОРМАЦИЯ" });
});

test("resolveChatId uses the single configured private recipient", () => {
  assert.equal(resolveChatId({ allowedChatIds: null, allowedUserIds: new Set([123]) }), 123);
  assert.equal(resolveChatId({ allowedChatIds: new Set([456]), allowedUserIds: new Set([123]) }), 456);
});

test("splitTelegramText splits long messages", () => {
  assert.deepEqual(splitTelegramText("123456789", 4), ["1234", "5678", "9"]);
});
