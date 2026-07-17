import test from "node:test";
import assert from "node:assert/strict";
import {
  formatArchiveMessage,
  formatClaudeRateLimits,
  formatCodexRateLimits,
  formatProgressHeading,
  formatRestartCompleteMessage,
  formatStatusMessage,
  formatTaskSwitchMessage,
  showLastMessageReplyMarkup,
  statusHeaderFileName,
} from "./status.mjs";

test("formatCodexRateLimits shows one weekly line per limit", () => {
  const nowMs = new Date(2026, 6, 10, 15, 0).getTime();
  const result = {
    rateLimitsByLimitId: {
      codex: {
        limitId: "codex",
        primary: { usedPercent: 0, resetsAt: (nowMs + 5 * 3600000) / 1000 },
        secondary: { usedPercent: 6, resetsAt: (nowMs + 151 * 3600000) / 1000 },
      },
      spark: {
        limitId: "spark",
        limitName: "GPT 5.3 CODEX-Spark",
        primary: { usedPercent: 0, resetsAt: (nowMs + 5 * 3600000) / 1000 },
        secondary: { usedPercent: 0, resetsAt: (nowMs + 7 * 86400000) / 1000 },
      },
    },
    rateLimitResetCredits: { availableCount: 0 },
  };

  assert.equal(formatCodexRateLimits(result, nowMs), [
    "CODEX - 94.0% - 6 дн. 7 ч.",
    "Spark - 100.0% - 7 дн.",
    "Доступно сбросов: 0",
  ].join("\n"));
});

test("formatClaudeRateLimits shows weekly Claude and model limits on separate lines", () => {
  const nowMs = new Date(2026, 6, 10, 15, 0).getTime();
  const usage = [
    "Current session: 0% used · resets Jul 10, 08:00pm",
    "Current week (all models): 6% used · resets Jul 16, 10:00pm",
    "Current week (Sonnet): 10% used · resets Jul 17, 03:00pm",
  ].join("\n");

  assert.equal(formatClaudeRateLimits(usage, nowMs), [
    "CLAUDE - 94.0% - 6 дн. 7 ч.",
    "Sonnet - 90.0% - 7 дн.",
  ].join("\n"));
});

test("formatClaudeRateLimits inherits the weekly reset for an unused Fable limit", () => {
  const nowMs = new Date(2026, 6, 10, 15, 0).getTime();
  const usage = [
    "Current week (all models): 6% used · resets Jul 16, 10:00pm",
    "Current week (Fable): 0% used",
  ].join("\n");

  assert.equal(formatClaudeRateLimits(usage, nowMs), [
    "CLAUDE - 94.0% - 6 дн. 7 ч.",
    "Fable - 100.0% - 6 дн. 7 ч.",
  ].join("\n"));
});

test("formatStatusMessage matches Telegram status layout", () => {
  assert.equal(formatStatusMessage({
    provider: "CODEX",
    busy: false,
    runningTasks: 2,
    model: "GPT-5.3 Codex Spark",
    reasoning: "High",
    mode: "Work",
    task: "Обсуждения",
    project: "VSC_Tyrael",
    limits: "CODEX - 94.0% - 6 дн. 7 ч.\nSpark - 100.0% - 7 дн.",
  }), [
    "CODEX: GPT-5.3 Codex Spark - High",
    "Work | Готов",
    "",
    "Текущая задача: Обсуждения",
    "Каталог: VSC_Tyrael",
    "",
    "Выполняется задач: 2",
    "",
    "Лимиты:",
    "CODEX - 94.0% - 6 дн. 7 ч.",
    "Spark - 100.0% - 7 дн.",
    "",
    "<b>🧵АКТИВНЫЕ ЗАДАЧИ🧵</b>",
  ].join("\n"));
});

test("formatStatusMessage shows Claude model, reasoning, and Plan mode", () => {
  assert.equal(formatStatusMessage({
    provider: "CLAUDE",
    busy: true,
    runningTasks: 1,
    model: "Sonnet",
    reasoning: "XHigh",
    mode: "Plan",
    task: "Проверка",
    project: "VSC_Tyrael",
    limits: "CLAUDE\n100.0% - 5 ч.",
  }), [
    "CLAUDE: Sonnet - XHigh",
    "Plan | Выполняет выбранную задачу",
    "",
    "Текущая задача: Проверка",
    "Каталог: VSC_Tyrael",
    "",
    "Выполняется задач: 1",
    "",
    "Лимиты:",
    "CLAUDE",
    "100.0% - 5 ч.",
    "",
    "<b>🧵АКТИВНЫЕ ЗАДАЧИ🧵</b>",
  ].join("\n"));
});

test("formatStatusMessage keeps task details in buttons and adds the active heading", () => {
  const result = formatStatusMessage({
    provider: "CODEX",
    busy: true,
    runningTasks: [
      "Codex · VSC_Tyrael · Перенос файлов",
      "Claude · Utilities · Проверка инструментов",
    ],
    model: "GPT-5.6-Sol",
    reasoning: "High",
    mode: "Work",
    task: "Перенос файлов",
    project: "VSC_Tyrael",
    limits: "CODEX\n80.0% - 5 дн.",
  });
  assert.match(result, /Выполняется задач: 2/);
  assert.doesNotMatch(result, /• Codex/);
  assert.doesNotMatch(result, /Всего найдено задач/);
  assert.match(result, /<b>🧵АКТИВНЫЕ ЗАДАЧИ🧵<\/b>$/);
});

test("formatStatusMessage omits the active heading when nothing runs", () => {
  const result = formatStatusMessage({
    provider: "CODEX",
    busy: false,
    runningTasks: [],
    model: "GPT-5.6-Sol",
    reasoning: "High",
    mode: "Work",
    task: "Задача <1>",
    project: "VSC & Main",
    limits: "CODEX\n100%",
  });
  assert.doesNotMatch(result, /АКТИВНЫЕ ЗАДАЧИ/);
  assert.match(result, /Задача &lt;1&gt;/);
  assert.match(result, /VSC &amp; Main/);
});

test("formatStatusMessage omits the project when the project button is hidden", () => {
  const result = formatStatusMessage({
    provider: "CODEX",
    busy: true,
    runningTasks: 2,
    model: "GPT-5.6-Sol",
    reasoning: "High",
    mode: "Work",
    task: "Telegram · 17.07.2026, 22:39",
    project: null,
    limits: "CODEX - 78.0% - 5 дн. 10 ч.",
  });

  assert.match(result, /^CODEX: GPT-5\.6-Sol - High\nWork \| Выполняет выбранную задачу/);
  assert.doesNotMatch(result, /Каталог:/);
});

test("formatProgressHeading keeps optional project on the compact first line", () => {
  assert.equal(formatProgressHeading({
    provider: "Codex",
    model: "GPT-5.6-Sol",
    reasoning: "High",
    task: "Telegram · 17.07.2026, 22:39",
    project: "VSC_Tyrael",
  }), [
    "⏳ Codex · GPT-5.6-Sol - High VSC_Tyrael",
    "🧵 Telegram · 17.07.2026, 22:39",
  ].join("\n"));

  assert.equal(formatProgressHeading({
    done: true,
    provider: "Claude Code",
    model: "Sonnet",
    reasoning: "XHigh",
    task: "Проверка",
  }), [
    "✅ Claude Code · Sonnet - XHigh",
    "🧵 Проверка",
  ].join("\n"));
});

test("statusHeaderFileName selects the current agent artwork", () => {
  assert.equal(statusHeaderFileName("codex"), "codex-header.png");
  assert.equal(statusHeaderFileName("claude"), "claude-header.png");
});

test("formatRestartCompleteMessage renders a safe final restart card", () => {
  assert.equal(formatRestartCompleteMessage({
    provider: "Codex",
    task: "Задача <1>",
    runningTasks: 2,
  }), [
    "✅ <b>БОТ ПЕРЕЗАПУЩЕН</b>",
    "",
    "Агент: Codex",
    "Текущая задача: Задача &lt;1&gt;",
    "Активных задач восстановлено: 2",
  ].join("\n"));
});

test("formatArchiveMessage names archived and newly active tasks", () => {
  assert.equal(formatArchiveMessage({
    archivedTask: "Такая-то",
    activeTask: "Такая-то2",
  }), [
    "❌ Задача \"Такая-то\" архивирована.",
    "🟢 Задача \"Такая-то2\" активна.",
  ].join("\n"));
});

test("formatArchiveMessage reports when no active task remains", () => {
  assert.equal(formatArchiveMessage({
    archivedTask: "Последняя",
    activeTask: null,
  }), [
    "❌ Задача \"Последняя\" архивирована.",
    "⚪ Активных задач нет.",
  ].join("\n"));
});

test("formatTaskSwitchMessage shows project and italic task when project button is enabled", () => {
  assert.equal(formatTaskSwitchMessage({
    task: "Задача <1>",
    project: "Проект & тест",
    showProject: true,
    model: "GPT-5.6-Sol",
    reasoning: "Medium",
  }), "🔄 Текущая задача изменена.\n\n<b>Проект &amp; тест</b>\n<i>Задача &lt;1&gt;</i>\nGPT-5.6-Sol - Medium");
});

test("formatTaskSwitchMessage shows only bold task when project button is disabled", () => {
  assert.equal(formatTaskSwitchMessage({
    task: "Задача <1>",
    project: "Скрытый проект",
    showProject: false,
    model: "GPT-5.6-Sol",
    reasoning: "Medium",
  }), "🔄 Текущая задача изменена.\n\n<b>Задача &lt;1&gt;</b>\nGPT-5.6-Sol - Medium");
});

test("task switch messages expose the show-last callback", () => {
  assert.deepEqual(showLastMessageReplyMarkup(), {
    inline_keyboard: [[{
      text: "👁 Показать последнее сообщение",
      callback_data: "show-last-message",
    }]],
  });
});
