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
  entryAttributes = "",
} = {}) {
  const identity = provider && threadId
    ? ` data-work-log-turn-provider="${provider}" data-work-log-turn-thread-id="${threadId}"`
    : "";
  return [
    "<details data-work-log-day-section>",
    `<summary data-work-log-day><strong>${date}</strong><span>Итого 1 kcr</span></summary>`,
    `<div data-work-log-row><div data-work-log-turn-entry${identity}${entryAttributes} data-work-log-turn-id="${turnId}">`,
    "<details data-work-log-turn-details>",
    `<summary><span data-work-log-turn-title>Ход ${turnId}</span></summary>`,
    `<div data-work-log-turn-expanded><div data-work-log-turn-prompt>Запрос ${turnId}</div>`,
    `<div data-work-log-turn-body>Ответ ${turnId}</div></div>`,
    "</details></div></div></details>",
  ].join("");
}

test("Mini App includes five recent day shells and lazily splits every turn body", () => {
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

  assert.match(payload.html, /Ход turn-1/u);
  assert.match(payload.html, /Ход turn-5/u);
  assert.doesNotMatch(payload.html, /Запрос turn-[1-6]|Ответ turn-[1-6]/u);
  assert.match(payload.html, /data-lazy-turn-id="turn-1"/u);
  assert.match(payload.html, /data-lazy-turn-id="turn-5"/u);
  assert.match(payload.html, /data-lazy-day="01\.07\.2026"/u);
  assert.match(payload.days["01.07.2026"], /Ход turn-6/u);
  assert.doesNotMatch(payload.days["01.07.2026"], /Запрос turn-6|Ответ turn-6/u);
  assert.match(payload.days["01.07.2026"], /data-lazy-turn-id="turn-6"/u);
  assert.match(payload.turns["turn-1"], /Запрос turn-1/u);
  assert.match(payload.turns["turn-1"], /Ответ turn-1/u);
  assert.match(payload.turns["turn-5"], /Ответ turn-5/u);
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
  const sameTurnReferences = references.filter((reference) => (
    /Ответ same-turn/u.test(payload.turns[reference])
  ));
  assert.equal(references.length, 7);
  assert.equal(sameTurnReferences.length, 3);
  assert.equal(new Set(sameTurnReferences).size, 3);
});

test("Mini App lazily extracts a turn whose entry attributes exceed the old scan window", () => {
  const payload = buildLazyJournalPayload(journalDay("06.07.2026", "turn-wide", {
    entryAttributes: ` data-work-log-turn-skills="${"skill".repeat(400)}"`,
  }));

  assert.doesNotMatch(payload.html, /Ответ turn-wide/u);
  assert.match(payload.html, /data-lazy-turn-id="turn-wide"/u);
  assert.match(payload.turns["turn-wide"], /Ответ turn-wide/u);
});

test("упоминание data-lazy-day в теле хода не делает весь день ленивой оболочкой", () => {
  const markdown = journalDay("06.07.2026", "turn-content")
    .replace("Ответ turn-content", "В ответе обсуждается data-lazy-day");
  const payload = buildLazyJournalPayload(markdown);

  assert.match(payload.html, /data-lazy-turn-id="turn-content"/u);
  assert.doesNotMatch(payload.html, /В ответе обсуждается data-lazy-day/u);
  assert.match(payload.turns["turn-content"], /В ответе обсуждается data-lazy-day/u);
});

test("повторная проекция не превращает свёрнутый день в пустую оболочку", () => {
  const day = (date, title) => `<details data-work-log-day-section><summary data-work-log-day>`
    + `<strong>${date}</strong></summary><div data-work-log-row>${title}</div></details>`;
  const markdown = `# Глобальный журнал работ
${day("08.08.2026", "Свежий")}
${day("01.07.2026", "Старый")}
`;
  const first = buildLazyJournalPayload(markdown, { eagerDayCount: 1 });
  assert.match(first.days["01.07.2026"], /data-work-log-row/u);

  /* Запись лимитов проецирует уже свёрнутую разметку заново. Старый день в ней
     представлен оболочкой, и вернуть его в days нельзя: содержимое живёт в базе,
     а пустая оболочка перезаписала бы фрагмент и день перестал бы открываться. */
  const again = buildLazyJournalPayload(first.html, { eagerDayCount: 1 });
  assert.equal(Object.hasOwn(again.days, "01.07.2026"), false);
  assert.match(again.html, /data-lazy-day="01\.07\.2026"/u);
});
