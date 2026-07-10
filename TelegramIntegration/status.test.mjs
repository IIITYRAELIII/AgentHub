import test from "node:test";
import assert from "node:assert/strict";
import { formatClaudeRateLimits, formatCodexRateLimits, formatStatusMessage } from "./status.mjs";

test("formatCodexRateLimits puts both windows on one line", () => {
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
    "CODEX",
    "100.0% - 5 ч. | 94.0% - 6 дн. 7 ч.",
    "",
    "GPT 5.3 CODEX-Spark",
    "100.0% - 5 ч. | 100.0% - 7 дн.",
    "",
    "Доступно сбросов: 0",
  ].join("\n"));
});

test("formatClaudeRateLimits uses the same compact layout", () => {
  const nowMs = new Date(2026, 6, 10, 15, 0).getTime();
  const usage = [
    "Current session: 0% used · resets Jul 10, 08:00pm",
    "Current week (all models): 6% used · resets Jul 16, 10:00pm",
    "Current week (Sonnet): 10% used · resets Jul 17, 03:00pm",
  ].join("\n");

  assert.equal(formatClaudeRateLimits(usage, nowMs), [
    "CLAUDE",
    "100.0% - 5 ч. | 94.0% - 6 дн. 7 ч.",
    "",
    "CLAUDE Sonnet",
    "90.0% - 7 дн.",
  ].join("\n"));
});

test("formatStatusMessage matches Telegram status layout", () => {
  assert.equal(formatStatusMessage({
    provider: "CODEX",
    busy: false,
    task: "Обсуждения",
    project: "VSC_Tyrael",
    limits: "CODEX\n100.0% - 5 ч. | 94.0% - 6 дн. 7 ч.",
  }), [
    "CODEX: Готов",
    "",
    "Текущая задача: Обсуждения",
    "Каталог: VSC_Tyrael",
    "",
    "Лимиты:",
    "CODEX",
    "100.0% - 5 ч. | 94.0% - 6 дн. 7 ч.",
  ].join("\n"));
});
