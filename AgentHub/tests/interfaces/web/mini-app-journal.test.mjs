import assert from "node:assert/strict";
import test from "node:test";

import { buildLazyJournalPayload } from "../../../src/interfaces/web/mini-app-journal-data.mjs";
import { extractWorkLogHtml } from "../../../src/interfaces/web/mini-app-server.mjs";

test("Mini App keeps the fresh rate-limit summary above projected days", () => {
  const html = extractWorkLogHtml([
    "# Глобальный журнал работ",
    "",
    '<div data-work-log-rate-limits data-sampled-at="2026-07-29T13:33:33.061Z">'
      + "<strong>Лимиты:</strong> CODEX - 89.0%</div>",
    "",
    "<details data-work-log-day-section>",
    "<summary data-work-log-day><strong>29.07.2026</strong></summary>",
    "</details>",
  ].join("\n"));
  assert.match(html, /^<div data-work-log-rate-limits/u);
  assert.match(html, /CODEX - 89\.0%/u);
  assert.match(html, /data-work-log-day-section/u);
  assert.doesNotMatch(html, /Глобальный журнал работ/u);
});

function journalDay(date, turnId, {
  provider = "",
  threadId = "",
} = {}) {
  const identity = provider && threadId
    ? ` data-work-log-turn-provider="${provider}" data-work-log-turn-thread-id="${threadId}"`
    : "";
  return [
    "<details data-work-log-day-section>",
    `<summary data-work-log-day><strong>${date}</strong><span>Итого 1 kcr</span></summary>`,
    `<div data-work-log-row><div data-work-log-turn-entry${identity} data-work-log-turn-id="${turnId}">`,
    "<details data-work-log-turn-details>",
    `<summary><span data-work-log-turn-title>Ход ${turnId}</span></summary>`,
    `<div data-work-log-turn-expanded><div data-work-log-turn-prompt>Запрос ${turnId}</div>`,
    `<div data-work-log-turn-body>Ответ ${turnId}</div></div>`,
    "</details></div></div></details>",
  ].join("");
}

test("Mini App initially includes five recent days and lazily splits older details", () => {
  const dates = [
    "06.07.2026",
    "05.07.2026",
    "04.07.2026",
    "03.07.2026",
    "02.07.2026",
    "01.07.2026",
  ];
  const payload = buildLazyJournalPayload([
    "# Глобальный журнал работ",
    ...dates.map((date, index) => journalDay(date, `turn-${index + 1}`)),
  ].join("\n"));

  assert.match(payload.html, /Ответ turn-1/u);
  assert.match(payload.html, /Ответ turn-5/u);
  assert.doesNotMatch(payload.html, /Ответ turn-6/u);
  assert.match(payload.html, /data-lazy-day="01\.07\.2026"/u);
  assert.match(payload.days["01.07.2026"], /Ход turn-6/u);
  assert.doesNotMatch(payload.days["01.07.2026"], /Запрос turn-6|Ответ turn-6/u);
  assert.match(payload.days["01.07.2026"], /data-lazy-turn-id="turn-6"/u);
  assert.match(payload.turns["turn-6"], /Запрос turn-6/u);
  assert.match(payload.turns["turn-6"], /Ответ turn-6/u);
});

test("Mini App lazy turn references stay unique across tasks and providers", () => {
  const payload = buildLazyJournalPayload([
    "# Глобальный журнал работ",
    journalDay("06.07.2026", "same-turn", { provider: "codex", threadId: "thread-a" }),
    journalDay("05.07.2026", "turn-2"),
    journalDay("04.07.2026", "turn-3"),
    journalDay("03.07.2026", "turn-4"),
    journalDay("02.07.2026", "turn-5"),
    journalDay("01.07.2026", "same-turn", { provider: "claude", threadId: "thread-b" }),
    journalDay("30.06.2026", "same-turn", { provider: "codex", threadId: "thread-c" }),
  ].join("\n"));

  const references = Object.keys(payload.turns);
  assert.equal(references.length, 2);
  assert.notEqual(references[0], references[1]);
  assert.match(payload.turns[references[0]], /Ответ same-turn/u);
  assert.match(payload.turns[references[1]], /Ответ same-turn/u);
});
