import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  applyWorkLogUsage,
  normalizeWorkLogId,
  projectWorkLogUsage,
  restoreLegacyOutcomes,
  WorkLogUsageStore,
} from "./work-log-usage.mjs";

const WORK_ID = "123e4567-e89b-42d3-a456-426614174000";
const SECOND_WORK_ID = "223e4567-e89b-42d3-a456-426614174000";
const GIGA_WORK_ID = "323e4567-e89b-42d3-a456-426614174001";

test("work-log ids are normalized and validated", () => {
  assert.equal(normalizeWorkLogId(WORK_ID.toUpperCase()), WORK_ID);
  assert.throws(() => normalizeWorkLogId("not-a-guid"), /UUID/);
});

test("applyWorkLogUsage replaces only the matching per-turn placeholder", () => {
  const source = [
    "<tr><td>",
    `<span data-usage-id="${WORK_ID}">${WORK_ID}</span> + `,
    `<span data-usage-id="${SECOND_WORK_ID}">${SECOND_WORK_ID}</span>`,
    "</td></tr>",
  ].join("");
  assert.equal(
    applyWorkLogUsage(source, WORK_ID, {
      inputTokens: 356_973,
      cachedInputTokens: 348_672,
      outputTokens: 894,
      reasoningOutputTokens: 672,
    }),
    [
      "<tr><td>",
      `<span data-usage-id="${WORK_ID}">Итого 49 кТЭ<br>Вход: 8 кТЭ (17,1%)<br>Кэш: 35 кТЭ (71,8%)<br>Выход: 1 кТЭ (2,8%)<br>Думы: 4 кТЭ (8,3%)</span> + `,
      `<span data-usage-id="${SECOND_WORK_ID}">${SECOND_WORK_ID}</span>`,
      "</td></tr>",
    ].join(""),
  );
  assert.throws(() => applyWorkLogUsage("<table></table>", WORK_ID, 10), /found 0/);
});

test("projectWorkLogUsage renders turn tables, preserves legacy outcomes and calculates shares", () => {
  const firstCompletedAt = new Date(2026, 6, 25, 12, 34).toISOString();
  const secondCompletedAt = new Date(2026, 6, 25, 13, 45).toISOString();
  const firstStartedAt = new Date(2026, 6, 25, 12, 30, 30).toISOString();
  const source = [
    "<details open>",
    "<summary><strong>25.07.2026</strong></summary>",
    "<table><colgroup><col><col><col></colgroup><thead>",
    "<tr><th>Задача</th><th>Итог</th><th>Расход</th></tr></thead><tbody>",
    `<tr><td>Task A</td><td>Outcome A<details><summary>Изменённые файлы</summary>a.mjs</details></td><td data-work-log-usage><span data-usage-id="${WORK_ID}">${WORK_ID}</span><br>`,
    `<span data-usage-id="${SECOND_WORK_ID}">${SECOND_WORK_ID}</span></td>`,
    "<td data-work-log-turns>legacy</td></tr>",
    `<tr><td>Task B</td><td>Outcome B</td><td><span data-usage-id="323e4567-e89b-42d3-a456-426614174000">pending</span></td></tr>`,
    `<tr><td>Task C</td><td>Outcome C</td><td><span data-usage-id="423e4567-e89b-42d3-a456-426614174000">recorded</span></td></tr>`,
    "</tbody></table>",
    "</details>",
  ].join("");
  const turns = {
    first: {
      workLogId: WORK_ID,
      usage: { inputTokens: 50, cachedInputTokens: 0, outputTokens: 0 },
      startedAt: firstStartedAt,
      completedAt: firstCompletedAt,
      text: "Первый <ход>\nСтрока",
      prompt: [
        "# Response annotations:",
        "<response-annotations>",
        '[{"text":"Старый ответ","annotation":"Короткий вопрос"}]',
        "</response-annotations>",
        "## My request for Codex:",
      ].join("\n"),
    },
    second: {
      workLogId: SECOND_WORK_ID,
      usage: { inputTokens: 50, cachedInputTokens: 0, outputTokens: 0 },
      completedAt: secondCompletedAt,
      text: "Второй & ход",
    },
    third: {
      workLogId: "423e4567-e89b-42d3-a456-426614174000",
      usage: { inputTokens: 100, cachedInputTokens: 0, outputTokens: 0 },
    },
  };
  const projected = projectWorkLogUsage(source, turns);
  assert.match(projected, /^<details data-work-log-day-section open>/);
  assert.match(projected, /<div data-work-log-table>/);
  assert.equal((projected.match(/<table\b/g) ?? []).length, 0);
  assert.equal((projected.match(/<div data-work-log-row/g) ?? []).length, 3);
  assert.doesNotMatch(projected, /data-work-log-previous-turn-table/);
  assert.match(
    projected,
    /<div data-work-log-header><strong>Задача<\/strong><strong>Ходы<\/strong><\/div>/,
  );
  assert.doesNotMatch(projected, /<strong>Расход<\/strong>/);
  assert.match(
    projected,
    /data-work-log-task-content>Task A<\/div><div data-work-log-usage><details data-task-usage-details>/,
  );
  assert.match(projected, /data-work-log-legacy-outcome>Outcome A<\/div>/);
  assert.match(projected, /data-work-log-legacy-outcome>Outcome B<\/div>/);
  assert.match(
    projected,
    /<div data-work-log-turn-table>[\s\S]*?data-work-log-turn-measure>12:34 — <span data-kilo-usage>0 кТЭ<\/span><\/span><span data-work-log-turn-share>\(50%\)<\/span>[\s\S]*?data-work-log-turn-title>Первый &lt;ход&gt; Строка<\/span>[\s\S]*?data-work-log-turn-measure>13:45 — <span data-kilo-usage>0 кТЭ<\/span><\/span><span data-work-log-turn-share>\(50%\)<\/span>[\s\S]*?data-work-log-turn-title>Второй &amp; ход<\/span>[\s\S]*?data-work-log-turn-files[^>]*>a\.mjs<\/div>/,
  );
  assert.match(
    projected,
    /<details data-work-log-previous-turns><summary><span data-work-log-previous-turns-closed>Показать предыдущие ходы \(1\)<\/span><span data-work-log-previous-turns-open>Свернуть<\/span><\/summary>/,
  );
  assert.doesNotMatch(projected, /<details data-work-log-previous-turns open>/);
  assert.match(
    projected,
    /data-work-log-previous-turn-list>[\s\S]*?Первый &lt;ход&gt; Строка[\s\S]*?<\/div><\/details>[\s\S]*?Второй &amp; ход/,
  );
  assert.match(projected, /<strong>Длит\.:<\/strong> 3 мин 30 с/);
  assert.match(projected, /<strong>Запрос:<\/strong> Короткий вопрос/);
  assert.doesNotMatch(projected, /Response annotations|response-annotations|Старый ответ/);
  assert.doesNotMatch(projected, /data-work-log-legacy-files/);
  assert.match(projected, /data-day-usage>Итого <span data-kilo-usage>0 кТЭ<\/span>/);
  assert.doesNotMatch(projected, /За день:/);
  assert.match(
    projected,
    /<summary data-work-log-day><strong>25\.07\.2026<\/strong> <span data-day-usage-table>[\s\S]*?<\/summary>/,
  );
  assert.doesNotMatch(projected, /data-day-usage-details/);
  assert.doesNotMatch(
    projected.match(/<span data-day-usage-breakdown>[\s\S]*?<\/span>/)?.[0] ?? "",
    /<br>/,
  );
  assert.equal((projected.match(/data-day-usage-part/g) ?? []).length, 4);
  assert.match(projected, /Task A[\s\S]*?Итого <span data-kilo-usage>0 кТЭ<\/span> <span data-usage-percent>\(50%\)<\/span>/);
  assert.match(projected, /Task C[\s\S]*?Итого <span data-kilo-usage>0 кТЭ<\/span> <span data-usage-percent>\(50%\)<\/span>/);
  assert.match(
    projected,
    /<details data-task-usage-details><summary data-task-usage>Итого <span data-kilo-usage>0 кТЭ<\/span> <span data-usage-percent>\(50%\)<\/span><\/summary><span data-task-usage-breakdown><span data-task-usage-part>Вход:/,
  );
  assert.doesNotMatch(projected, /<details data-task-usage-details open>/);
  assert.match(
    projected,
    /data-work-log-task-content>Task B<\/div><div data-work-log-usage><span data-usage-id="323e4567-e89b-42d3-a456-426614174000" hidden>[\s\S]*?data-work-log-legacy-outcome>Outcome B<\/div>/,
  );
  assert.equal((projected.match(/data-task-usage>/g) ?? []).length, 2);
  assert.equal((projected.match(/data-task-usage-details/g) ?? []).length, 2);
  assert.equal((projected.match(/data-task-usage-part/g) ?? []).length, 8);
  assert.equal((projected.match(/data-usage-id=/g) ?? []).length, 4);
  assert.equal((projected.match(/data-usage-id=[^>]+hidden/g) ?? []).length, 4);
  const reprojected = projectWorkLogUsage(projected, turns);
  assert.equal((reprojected.match(/data-work-log-day-section/g) ?? []).length, 1);
  assert.equal(reprojected, projected);
});

test("projectWorkLogUsage marks every day as an independent layout section", () => {
  const source = [
    "<details open><summary><strong>25.07.2026</strong></summary></details>",
    "<details><summary><strong>24.07.2026</strong></summary></details>",
  ].join("\n");
  const projected = projectWorkLogUsage(source);

  assert.match(projected, /^<details data-work-log-day-section open>/);
  assert.match(projected, /\n<details data-work-log-day-section>/);
  assert.equal((projected.match(/data-work-log-day-section/g) ?? []).length, 2);
  assert.equal((projected.match(/summary data-work-log-day/g) ?? []).length, 2);
});

test("projectWorkLogUsage removes stale table fragments from a partially migrated day", () => {
  const source = [
    '<details open><summary><strong>27.07.2026</strong></summary>',
    '<div data-work-log-table><div data-work-log-body>',
    '<div data-work-log-row><div data-work-log-task-cell>',
    `<div data-work-log-task-content>Task</div><div data-work-log-usage><span data-usage-id="${WORK_ID}" hidden></span></div>`,
    '</div><div data-work-log-turn-list></div></div></div></div>',
    '<tr><td>stale task</td><td>stale turn</td></tr></tbody></table>',
    "</details>",
  ].join("");
  const turns = {
    turn: {
      workLogId: WORK_ID,
      turnId: "turn",
      usage: { inputTokens: 100 },
      completedAt: new Date(2026, 6, 27, 10, 0).toISOString(),
    },
  };

  const projected = projectWorkLogUsage(source, turns);

  assert.equal((projected.match(/<div data-work-log-row/g) ?? []).length, 1);
  assert.doesNotMatch(projected, /<(?:table|tr|td)\b|stale task|stale turn/);
  assert.equal(projectWorkLogUsage(projected, turns), projected);
});

test("projectWorkLogUsage canonicalizes a unique legacy row and refreshes its task title", () => {
  const workLogId = "823e4567-e89b-42d3-a456-426614174000";
  const completedAt = new Date(2026, 6, 27, 10, 0).toISOString();
  const source = "<details open><summary><strong>27.07.2026</strong></summary><table><tbody>"
    + '<tr><td><a href="vscode://openai.chatgpt/local/thread-legacy">Codex - Старое имя</a></td>'
    + `<td></td><td><span data-usage-id="${workLogId}" hidden></span></td></tr>`
    + "</tbody></table></details>";
  const turns = {
    "codex\0thread-legacy\0turn-legacy": {
      provider: "codex",
      threadId: "thread-legacy",
      turnId: "turn-legacy",
      workLogId,
      taskTitle: "Название из Agent Hub",
      completedAt,
      usageReported: true,
      usage: { inputTokens: 100 },
    },
  };

  const projected = projectWorkLogUsage(source, turns);

  assert.match(
    projected,
    /<div data-work-log-row data-work-log-provider="codex" data-work-log-thread-id="thread-legacy">/,
  );
  assert.match(projected, />Codex - Название из Agent Hub<\/a>/);
  assert.doesNotMatch(projected, />Codex - Старое имя<\/a>/);
});

test("projectWorkLogUsage keeps ambiguous legacy rows with one thread separate", () => {
  const firstId = "923e4567-e89b-42d3-a456-426614174000";
  const secondId = "a23e4567-e89b-42d3-a456-426614174000";
  const completedAt = new Date(2026, 6, 26, 10, 0).toISOString();
  const source = "<details><summary><strong>26.07.2026</strong></summary><table><tbody>"
    + '<tr><td><a href="vscode://openai.chatgpt/local/thread-shared">Codex - Первая работа</a></td>'
    + `<td></td><td><span data-usage-id="${firstId}" hidden></span></td></tr>`
    + '<tr><td><a href="vscode://openai.chatgpt/local/thread-shared">Codex - Вторая работа</a></td>'
    + `<td></td><td><span data-usage-id="${secondId}" hidden></span></td></tr>`
    + "</tbody></table></details>";
  const turns = Object.fromEntries([
    ["turn-first", firstId],
    ["turn-second", secondId],
  ].map(([turnId, workLogId]) => [
    `codex\0thread-shared\0${turnId}`,
    {
      provider: "codex",
      threadId: "thread-shared",
      turnId,
      workLogId,
      taskTitle: "Общее имя",
      completedAt,
      usageReported: true,
      usage: { inputTokens: 100 },
    },
  ]));

  const projected = projectWorkLogUsage(source, turns);

  assert.equal((projected.match(/data-work-log-thread-id="thread-shared"/g) ?? []).length, 0);
  assert.match(projected, />Codex - Первая работа<\/a>/);
  assert.match(projected, />Codex - Вторая работа<\/a>/);
});

test("work log colors kilo, mega and giga-or-higher usage independently", () => {
  const source = `<details><summary><strong>25.07.2026</strong></summary><table><tbody>`
    + `<tr><td>Task</td><td></td><td><span data-usage-id="${GIGA_WORK_ID}" hidden></span></td></tr>`
    + "</tbody></table></details>";
  const projected = projectWorkLogUsage(source, {
    turn: {
      workLogId: GIGA_WORK_ID,
      usage: { inputTokens: 1_000_000_000 },
      completedAt: "2026-07-25T00:00:00.000Z",
      text: "Большой ход",
    },
  });
  assert.match(projected, /data-high-usage>1 ГТЭ<\/span>/);
});

test("work log CSS keeps dates equal and shows a compact always-visible turn list", async () => {
  const css = await readFile(new URL("./work-log.css", import.meta.url), "utf8");
  assert.match(
    css,
    /details\[data-work-log-day-section\][\s\S]*?background-color:[\s\S]*?border-radius:[\s\S]*?padding:/,
  );
  assert.match(
    css,
    /details\[data-work-log-day-section\]\[open\][\s\S]*?background-color:/,
  );
  assert.match(css, /summary\[data-work-log-day\][\s\S]*?font-size:\s*1em/);
  assert.match(
    css,
    /div\[data-work-log-header\],[\s\S]*?div\[data-work-log-row\][\s\S]*?grid-template-columns:\s*28ch minmax\(0, 1fr\)/,
  );
  assert.match(css, /--work-log-task-card-width:\s*26ch/);
  assert.match(
    css,
    /div\[data-work-log-turn-table\][\s\S]*?width:\s*100%[\s\S]*?data-work-log-turn-entry\] \+ div\[data-work-log-turn-entry\][\s\S]*?margin-top:\s*0\.35em/,
  );
  assert.match(
    css,
    /div\[data-work-log-task-cell\] > div\[data-work-log-task-content\][\s\S]*?border:[\s\S]*?padding:\s*0\.3em 0\.45em[\s\S]*?width:\s*var\(--work-log-task-card-width\)/,
  );
  assert.match(
    css,
    /summary\[data-task-usage\][\s\S]*?padding:\s*0\.3em 0\.45em[\s\S]*?width:\s*var\(--work-log-task-card-width\)/,
  );
  assert.doesNotMatch(css, /table\[data-work-log-table\]/);
  assert.match(css, /details\[data-work-log-turn-details\] > summary[\s\S]*?display:\s*grid/);
  assert.match(
    css,
    /span\[data-work-log-turn-meta\][\s\S]*?display:\s*flex[\s\S]*?justify-content:\s*space-between/,
  );
  assert.match(css, /summary::-webkit-details-marker[\s\S]*?display:\s*none/);
  assert.match(
    css,
    /details\[data-work-log-turn-details\]\s*\{[\s\S]*?border:\s*1px solid[\s\S]*?border-radius:\s*4px/,
  );
  assert.match(
    css,
    /details\[data-work-log-turn-details\]\[open\]\s*\{[\s\S]*?border:\s*2px solid var\(--vscode-focusBorder/,
  );
  assert.match(
    css,
    /div\[data-work-log-turn-table\]\s*\{[\s\S]*?border:\s*1px solid[\s\S]*?border-radius:\s*4px[\s\S]*?overflow:\s*hidden/,
  );
  assert.match(
    css,
    /details\[data-work-log-previous-turns\]\s*\{[\s\S]*?border-bottom:\s*1px solid/,
  );
  assert.match(
    css,
    /data-work-log-previous-turns\]\[open\][\s\S]*?data-work-log-previous-turns-closed[\s\S]*?display:\s*none/,
  );
  assert.match(
    css,
    /data-work-log-previous-turns\]\[open\][\s\S]*?data-work-log-previous-turns-open[\s\S]*?display:\s*inline/,
  );
  assert.doesNotMatch(css, /data-work-log-turns-toggle/);
  assert.match(
    css,
    /span\[data-kilo-usage\][\s\S]*?#e5c07b[\s\S]*?span\[data-mega-usage\][\s\S]*?#ff9d00[\s\S]*?span\[data-high-usage\][\s\S]*?#f14c4c/,
  );
});

test("work log limits visible turn titles to 100 characters", () => {
  const source = "<details open><summary><strong>27.07.2026</strong></summary>"
    + "<table><tbody><tr><td>Task</td><td></td><td></td></tr></tbody></table></details>";
  const projected = projectWorkLogUsage(source, {
    turn: {
      provider: "codex",
      threadId: "thread-title",
      turnId: "turn-title",
      taskTitle: "Title",
      title: "Т".repeat(120),
      usageReported: true,
      usage: { inputTokens: 100 },
      completedAt: "2026-07-27T00:00:00.000Z",
    },
  });
  assert.match(projected, new RegExp(`data-work-log-turn-title>${"Т".repeat(100)}<\\/span>`));
  assert.doesNotMatch(projected, new RegExp("Т{101}"));
});

test("collapsed previous turns remain idempotent without a legacy outcome", () => {
  const source = "<details open><summary><strong>27.07.2026</strong></summary>"
    + '<table><tbody><tr data-work-log-provider="codex" data-work-log-thread-id="thread-idempotent">'
    + "<td>Task</td><td></td></tr></tbody></table></details>";
  const turns = Object.fromEntries(["first", "second"].map((turnId, index) => [
    `codex\0thread-idempotent\0${turnId}`,
    {
      provider: "codex",
      threadId: "thread-idempotent",
      turnId,
      taskTitle: "Title",
      title: `Ход ${index + 1}`,
      usageReported: true,
      usage: { inputTokens: 100 },
      completedAt: `2026-07-27T00:0${index}:00.000Z`,
    },
  ]));
  const projected = projectWorkLogUsage(source, turns);
  const reprojected = projectWorkLogUsage(projected, turns);
  assert.equal(reprojected, projected);
  assert.equal((reprojected.match(/data-work-log-turn-id=/g) ?? []).length, 2);
  assert.equal((reprojected.match(/data-work-log-legacy-outcome/g) ?? []).length, 0);
});

test("subagent usage is summed into its root task without a visible child turn", () => {
  const projected = projectWorkLogUsage("# Глобальный журнал работ\n", {
    "codex\0root\0root-turn": {
      provider: "codex",
      threadId: "root",
      turnId: "root-turn",
      taskTitle: "Root task",
      title: "Основной результат",
      usageReported: true,
      usage: { inputTokens: 100_000 },
      completedAt: "2026-07-27T00:01:00.000Z",
    },
    "codex\0child\0child-turn": {
      provider: "codex",
      threadId: "child",
      taskThreadId: "root",
      parentThreadId: "root",
      aggregateOnly: true,
      turnId: "child-turn",
      taskTitle: "Root task",
      title: "Скрытый результат субагента",
      usageReported: true,
      usage: { inputTokens: 50_000 },
      completedAt: "2026-07-27T00:02:00.000Z",
    },
    "codex\0child-2\0child-turn-2": {
      provider: "codex",
      threadId: "child-2",
      taskThreadId: "root",
      parentThreadId: "root",
      aggregateOnly: true,
      turnId: "child-turn-2",
      taskTitle: "Root task",
      title: "Прерванный скрытый результат субагента",
      status: "aborted",
      usageReported: true,
      usage: { inputTokens: 25_000 },
      completedAt: "2026-07-27T00:03:00.000Z",
    },
  });

  assert.match(projected, /data-work-log-thread-id="root"/);
  assert.match(projected, /Итого <span data-kilo-usage>175 кТЭ<\/span>/);
  assert.equal((projected.match(/data-work-log-turn-id=/g) ?? []).length, 1);
  assert.match(projected, /Основной результат/);
  assert.doesNotMatch(projected, /Скрытый результат субагента/);
  assert.doesNotMatch(projected, /Прерванный скрытый результат субагента/);
  assert.doesNotMatch(projected, /data-work-log-thread-id="child"/);
});

test("usage store projects each turn into its own placeholder and deduplicates retries", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "work-log-usage-"));
  try {
    const ledgerFile = path.join(root, "data", "work-log-usage.json");
    const workLogFile = path.join(root, "WORK_LOG.md");
    await writeFile(
      workLogFile,
      [
        "<details open><summary><strong>25.07.2026</strong></summary><table><tbody><tr><td>Task</td><td>Outcome</td><td>",
        `<span data-usage-id="${WORK_ID}">${WORK_ID}</span> + `,
        `<span data-usage-id="${SECOND_WORK_ID}">${SECOND_WORK_ID}</span>`,
        "</td></tr></tbody></table></details>",
      ].join(""),
      "utf8",
    );
    const store = new WorkLogUsageStore({ ledgerFile });
    const base = {
      provider: "codex",
      threadId: "thread-1",
      workLogId: WORK_ID,
      usageReported: true,
      workLogFile,
      usage: {
        inputTokens: 110,
        cachedInputTokens: 100,
        outputTokens: 2,
        reasoningOutputTokens: 1,
      },
      text: "Первый результат",
    };
    await store.recordAndProject({ ...base, turnId: "turn-1" });
    await store.recordAndProject({ ...base, turnId: "turn-1" });
    await store.recordAndProject({
      ...base,
      turnId: "turn-2",
      workLogId: SECOND_WORK_ID,
      text: "Второй результат",
    });
    const projected = await readFile(workLogFile, "utf8");
    assert.match(projected, /data-day-usage>Итого <span data-kilo-usage>0 кТЭ<\/span>/);
    assert.equal((projected.match(/data-day-usage-breakdown/g) ?? []).length, 1);
    assert.match(
      projected,
      /<details data-task-usage-details><summary data-task-usage>Итого <span data-kilo-usage>0 кТЭ<\/span> <span data-usage-percent>\(100%\)<\/span><\/summary><span data-task-usage-breakdown><span data-task-usage-part>Вход:/,
    );
    assert.match(projected, new RegExp(`data-usage-id="${WORK_ID}" hidden>`));
    assert.match(projected, new RegExp(`data-usage-id="${SECOND_WORK_ID}" hidden>`));
    const ledger = JSON.parse(await readFile(ledgerFile, "utf8"));
    assert.equal(Object.keys(ledger.turns).length, 2);
    assert.deepEqual(
      Object.values(ledger.turns).map((record) => record.body),
      ["Первый результат", "Второй результат"],
    );
    const restored = new WorkLogUsageStore({ ledgerFile });
    assert.deepEqual(await restored.project(workLogFile), {
      projected: false,
      reason: "unchanged",
    });
    assert.deepEqual(await restored.project(path.join(root, "MISSING.md")), {
      projected: false,
      reason: "unchanged",
    });
    await assert.rejects(
      store.recordAndProject({ ...base, turnId: "turn-3" }),
      /already assigned to another turn/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a fresh usage store reprojects an existing work log with its persisted ledger", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "work-log-reproject-"));
  try {
    const ledgerFile = path.join(root, "work-log-usage.json");
    const workLogFile = path.join(root, "WORK_LOG.md");
    await writeFile(ledgerFile, `${JSON.stringify({
      version: 1,
      turns: {
        turn: {
          workLogId: WORK_ID,
          usage: { inputTokens: 1_756_500 },
          completedAt: "2026-07-25T00:00:00.000Z",
          text: "Сохранённый результат",
          prompt: [
            "# Response annotations:",
            "<response-annotations>",
            '[{"text":"Старый ответ","annotation":"Сохранённый вопрос"}]',
            "</response-annotations>",
            "## My request for Codex:",
          ].join("\n"),
        },
      },
    })}\n`, "utf8");
    await writeFile(
      workLogFile,
      `<details open><summary><strong>25.07.2026</strong></summary><table><tbody>`
        + `<tr><td>Task</td><td>Outcome</td><td><span data-usage-id="${WORK_ID}" hidden></span></td></tr>`
        + "</tbody></table></details>",
      "utf8",
    );

    const store = new WorkLogUsageStore({ ledgerFile });
    assert.deepEqual(await store.project(workLogFile), { projected: true });
    const projected = await readFile(workLogFile, "utf8");
    assert.match(projected, /data-task-usage>Итого <span data-mega-usage>1,757 МТЭ<\/span> <span data-usage-percent>\(100%\)<\/span>/);
    assert.match(projected, /data-work-log-turn-body>Сохранённый результат<\/div>/);
    assert.match(projected, /<strong>Запрос:<\/strong> Сохранённый вопрос/);
    assert.doesNotMatch(projected, /response-annotations|Старый ответ/);
    assert.doesNotMatch(projected, /data-mega-usage>[^<]*кТЭ/);
    const persisted = JSON.parse(await readFile(ledgerFile, "utf8"));
    assert.equal(persisted.turns.turn.prompt, "Сохранённый вопрос");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("usage store restores exact turn texts from deferred notification state", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "work-log-text-restore-"));
  try {
    const ledgerFile = path.join(root, "work-log-usage.json");
    await writeFile(ledgerFile, `${JSON.stringify({
      version: 1,
      turns: {
        turn: {
          workLogId: WORK_ID,
          usage: { inputTokens: 100 },
          completedAt: "2026-07-25T00:00:00.000Z",
        },
      },
    })}\n`, "utf8");
    const store = new WorkLogUsageStore({ ledgerFile });
    assert.deepEqual(await store.mergeTurnTexts([
      { workLogId: WORK_ID, text: "Точный текст из Telegram" },
      { workLogId: "invalid", text: "Не попадёт" },
    ]), { updated: 1 });
    assert.deepEqual(await store.mergeTurnTexts([
      { workLogId: WORK_ID, text: "Точный текст из Telegram" },
    ]), { updated: 0 });
    const ledger = JSON.parse(await readFile(ledgerFile, "utf8"));
    assert.equal(ledger.turns.turn.body, "Точный текст из Telegram");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("automatic usage attaches to the only row for the thread and is idempotent", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "work-log-automatic-exact-"));
  try {
    const ledgerFile = path.join(root, "work-log-usage.json");
    const workLogFile = path.join(root, "WORK_LOG.md");
    const completedAt = new Date(2026, 6, 25, 12, 34).toISOString();
    await writeFile(
      workLogFile,
      `<details><summary><strong>25.07.2026</strong></summary><table><tbody>`
        + `<tr><td><a href="vscode://openai.chatgpt/local/thread-1">Task</a></td>`
        + "<td>Outcome</td><td></td></tr></tbody></table></details>",
      "utf8",
    );
    const store = new WorkLogUsageStore({
      ledgerFile,
      randomUUID: () => WORK_ID,
    });
    const input = {
      threadId: "thread-1",
      turnId: "turn-aborted",
      usageReported: true,
      usage: { inputTokens: 1_756_500 },
      completedAt,
      text: "Остановленный ход",
      workLogFile,
    };
    assert.deepEqual(await store.recordAutomaticAndProject(input), {
      recorded: true,
      usage: {
        inputTokens: 1_756_500,
        cachedInputTokens: 0,
        outputTokens: 0,
        reasoningOutputTokens: 0,
        totalTokens: 0,
      },
      workLogId: null,
      target: "thread-day-row",
      projected: true,
    });
    assert.equal((await readFile(workLogFile, "utf8")).match(/data-usage-id=/g)?.length ?? 0, 0);
    assert.match(await readFile(workLogFile, "utf8"), /data-work-log-thread-id="thread-1"/);
    assert.match(await readFile(workLogFile, "utf8"), /data-work-log-turn-id="turn-aborted"/);
    assert.match(await readFile(workLogFile, "utf8"), /Остановленный ход/);
    assert.equal((await store.recordAutomaticAndProject(input)).recorded, false);
    assert.equal((await readFile(workLogFile, "utf8")).match(/data-usage-id=/g)?.length ?? 0, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("automatic ledger survives a projection failure and reprojects later", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "work-log-durable-"));
  try {
    const ledgerFile = path.join(root, "data", "work-log-usage.json");
    const blockedWorkLog = path.join(root, "directory-instead-of-file");
    await mkdir(blockedWorkLog);
    const store = new WorkLogUsageStore({
      ledgerFile,
      defaultProjectRoot: root,
    });
    const result = await store.recordAutomaticAndProject({
      threadId: "thread-durable",
      turnId: "turn-durable",
      projectRoot: root,
      usageReported: true,
      usage: { inputTokens: 100 },
      completedAt: "2026-07-27T00:00:00.000Z",
      text: "Сохранено до проекции",
      workLogFile: blockedWorkLog,
    });
    assert.equal(result.recorded, true);
    assert.equal(result.projected, false);
    assert.match(result.projectionError, /directory|EISDIR/i);
    const ledger = JSON.parse(await readFile(ledgerFile, "utf8"));
    assert.equal(Object.keys(ledger.turns).length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a late unknown Stop result cannot overwrite an exact terminal status", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "work-log-status-"));
  try {
    const ledgerFile = path.join(root, "work-log-usage.json");
    const workLogFile = path.join(root, "WORK_LOG.md");
    const store = new WorkLogUsageStore({ ledgerFile, defaultProjectRoot: root });
    const input = {
      threadId: "thread-status",
      turnId: "turn-status",
      projectRoot: root,
      usageReported: false,
      usage: {},
      completedAt: "2026-07-27T00:00:00.000Z",
      text: "Статус",
      workLogFile,
    };
    await store.recordAutomaticAndProject({ ...input, status: "aborted" });
    await store.recordAutomaticAndProject({ ...input, status: "unknown" });
    const ledger = JSON.parse(await readFile(ledgerFile, "utf8"));
    assert.equal(Object.values(ledger.turns)[0].status, "aborted");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("usage store recovers a damaged primary ledger from its backup", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "work-log-recovery-"));
  try {
    const ledgerFile = path.join(root, "work-log-usage.json");
    const workLogFile = path.join(root, "WORK_LOG.md");
    const seed = new WorkLogUsageStore({ ledgerFile, defaultProjectRoot: root });
    await seed.recordAutomaticAndProject({
      threadId: "thread-recovery",
      turnId: "turn-recovery",
      projectRoot: root,
      usageReported: true,
      usage: { inputTokens: 100 },
      completedAt: "2026-07-27T00:00:00.000Z",
      text: "Восстановлено",
      workLogFile,
    });
    await writeFile(ledgerFile, "{damaged", "utf8");
    const recovered = new WorkLogUsageStore({ ledgerFile, defaultProjectRoot: root });
    await recovered.project(workLogFile, { projectRoot: root });
    const ledger = JSON.parse(await readFile(ledgerFile, "utf8"));
    assert.equal(Object.keys(ledger.turns).length, 1);
    assert.equal(ledger.version, 4);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("one ledger projects only turns belonging to the requested project", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "work-log-projects-"));
  try {
    const firstRoot = path.join(root, "first");
    const secondRoot = path.join(root, "second");
    const firstLog = path.join(firstRoot, "WORK_LOG.md");
    const secondLog = path.join(secondRoot, "WORK_LOG.md");
    const ledgerFile = path.join(root, "work-log-usage.json");
    await mkdir(firstRoot);
    await mkdir(secondRoot);
    const store = new WorkLogUsageStore({ ledgerFile, defaultProjectRoot: firstRoot });
    await store.recordAutomaticAndProject({
      threadId: "thread-first",
      turnId: "turn-first",
      projectRoot: firstRoot,
      usageReported: true,
      usage: { inputTokens: 100 },
      completedAt: "2026-07-27T00:00:00.000Z",
      taskTitle: "Первая задача",
      text: "Первый проект",
      workLogFile: firstLog,
    });
    await store.recordAutomaticAndProject({
      threadId: "thread-second",
      turnId: "turn-second",
      projectRoot: secondRoot,
      usageReported: true,
      usage: { inputTokens: 200 },
      completedAt: "2026-07-27T00:01:00.000Z",
      taskTitle: "Вторая задача",
      text: "Второй проект",
      workLogFile: secondLog,
    });
    const first = await readFile(firstLog, "utf8");
    const second = await readFile(secondLog, "utf8");
    assert.match(first, /Первый проект/);
    assert.doesNotMatch(first, /Второй проект/);
    assert.match(second, /Второй проект/);
    assert.doesNotMatch(second, /Первый проект/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("automatic usage creates an explicit fallback row for an ambiguous thread", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "work-log-automatic-fallback-"));
  try {
    const ledgerFile = path.join(root, "work-log-usage.json");
    const workLogFile = path.join(root, "WORK_LOG.md");
    const completedAt = new Date(2026, 6, 25, 13, 45).toISOString();
    const linkedRow = (title) => (
      `<tr><td><a href="vscode://openai.chatgpt/local/thread-1">${title}</a></td>`
      + "<td>Outcome</td><td></td></tr>"
    );
    await writeFile(
      workLogFile,
      `<details><summary><strong>25.07.2026</strong></summary><table><tbody>`
        + linkedRow("Task A") + linkedRow("Task B")
        + "</tbody></table></details>",
      "utf8",
    );
    const store = new WorkLogUsageStore({
      ledgerFile,
      randomUUID: () => SECOND_WORK_ID,
    });
    const result = await store.recordAutomaticAndProject({
      threadId: "thread-1",
      turnId: "turn-aborted",
      usageReported: true,
      usage: { inputTokens: 100 },
      completedAt,
      text: "Автоматически учтённый ход",
      workLogFile,
    });
    assert.equal(result.target, "thread-day-row");
    const projected = await readFile(workLogFile, "utf8");
    assert.match(projected, /data-work-log-thread-id="thread-1"/);
    assert.match(projected, /Codex - Без названия/);
    assert.doesNotMatch(projected, /data-usage-id=/);
    assert.match(projected, /data-task-usage>Итого <span data-kilo-usage>0 кТЭ<\/span> <span data-usage-percent>\(100%\)<\/span>/);
    assert.match(projected, /13:45 — <span data-kilo-usage>0 кТЭ<\/span>/);
    assert.match(projected, /Автоматически учтённый ход/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("automatic journal records a stopped turn even when usage is unavailable", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "work-log-no-usage-"));
  try {
    const ledgerFile = path.join(root, "work-log-usage.json");
    const workLogFile = path.join(root, "WORK_LOG.md");
    await writeFile(
      workLogFile,
      "<details open><summary><strong>25.07.2026</strong></summary><table><tbody></tbody></table></details>",
      "utf8",
    );
    const store = new WorkLogUsageStore({ ledgerFile });
    await store.recordAutomaticAndProject({
      provider: "codex",
      threadId: "thread-stopped",
      turnId: "turn-stopped",
      taskTitle: "Остановленная задача",
      status: "aborted",
      title: "Ход остановлен",
      body: "Промежуточный результат сохранён.",
      prompt: "Сделай работу",
      startedAt: new Date(2026, 6, 25, 12, 0).toISOString(),
      completedAt: new Date(2026, 6, 25, 12, 1).toISOString(),
      usageReported: false,
      workLogFile,
    });
    const projected = await readFile(workLogFile, "utf8");
    assert.match(projected, /Codex - Остановленная задача/);
    assert.match(projected, /12:01 — нет данных/);
    assert.match(projected, /data-work-log-turn-title>Ход остановлен<\/span>/);
    assert.match(projected, /data-work-log-turn-prompt><strong>Запрос:<\/strong> Сделай работу<\/div>/);
    const ledger = JSON.parse(await readFile(ledgerFile, "utf8"));
    assert.equal(Object.values(ledger.turns)[0].usageReported, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("automatic journal creates the missing local-date section", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "work-log-new-day-"));
  try {
    const ledgerFile = path.join(root, "work-log-usage.json");
    const workLogFile = path.join(root, "WORK_LOG.md");
    await writeFile(
      workLogFile,
      "# Глобальный журнал работ\n\n"
        + "<details><summary><strong>24.07.2026</strong></summary>"
        + "<table><tbody></tbody></table></details>\n",
      "utf8",
    );
    const completedAt = new Date(2026, 6, 25, 15, 30).toISOString();
    const store = new WorkLogUsageStore({ ledgerFile });
    await store.recordAutomaticAndProject({
      provider: "codex",
      threadId: "thread-new-day",
      turnId: "turn-new-day",
      taskTitle: "Новая дата",
      title: "Автоматически создана строка",
      completedAt,
      usageReported: true,
      usage: { inputTokens: 1_000 },
      workLogFile,
    });
    const projected = await readFile(workLogFile, "utf8");
    assert.match(projected, /<summary data-work-log-day><strong>25\.07\.2026<\/strong>/);
    assert.match(projected, /data-work-log-thread-id="thread-new-day"/);
    assert.match(projected, /data-work-log-turn-id="turn-new-day"/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy outcome restoration matches rows by date and task title", () => {
  const previous = "<details><summary><strong>24.07.2026</strong></summary><table><tbody>"
    + "<tr><td>Codex - Task</td><td>Старый итог</td><td></td></tr>"
    + "</tbody></table></details>";
  const current = "<details><summary><strong>24.07.2026</strong></summary><table><tbody>"
    + "<tr><td>Codex - Task</td><td data-work-log-turn-list></td><td></td></tr>"
    + "</tbody></table></details>";
  const restored = restoreLegacyOutcomes(current, previous);
  assert.match(restored, /data-work-log-restored-outcome>Старый итог<\/div>/);
  assert.match(projectWorkLogUsage(restored), /data-work-log-legacy-outcome>Старый итог<\/div>/);
});
