import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
      completedAt: firstCompletedAt,
      text: "Первый <ход>\nСтрока",
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
  assert.match(projected, /<table data-work-log-table>/);
  assert.match(projected, /<col data-work-log-turn-list-column>/);
  assert.doesNotMatch(projected, /data-work-log-turns-column/);
  assert.match(
    projected,
    /<th>Задача<\/th><th>Ходы<\/th><th>Расход<\/th>/,
  );
  assert.match(projected, /data-work-log-legacy-outcome><td colspan="2">Outcome A<\/td>/);
  assert.match(projected, /data-work-log-legacy-outcome><td colspan="2">Outcome B<\/td>/);
  assert.match(
    projected,
    /<table data-work-log-turn-table>[\s\S]*?data-work-log-turn-meta>12:34 — <span data-kilo-usage>0 кТЭ<\/span>[\s\S]*?data-work-log-turn-title>Первый &lt;ход&gt; Строка<\/span>[\s\S]*?data-work-log-turn-meta>13:45 — <span data-kilo-usage>0 кТЭ<\/span>[\s\S]*?data-work-log-turn-title>Второй &amp; ход<\/span>[\s\S]*?data-work-log-legacy-files>a\.mjs<\/div>/,
  );
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
    /Task B<\/td>[\s\S]*?data-work-log-legacy-outcome><td colspan="2">Outcome B<\/td>[\s\S]*?<td data-work-log-usage><span data-usage-id="323e4567-e89b-42d3-a456-426614174000" hidden>/,
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
  assert.match(css, /summary\[data-work-log-day\][\s\S]*?font-size:\s*1em/);
  assert.match(
    css,
    /grid-template-columns:\s*14fr 70fr 16fr/,
  );
  assert.match(
    css,
    /table\[data-work-log-turn-table\][\s\S]*?table-layout:\s*fixed[\s\S]*?data-work-log-turn-meta-column\][\s\S]*?width:\s*14em/,
  );
  assert.match(css, /details\[data-work-log-turn-details\] > summary[\s\S]*?display:\s*grid/);
  assert.match(css, /summary::-webkit-details-marker[\s\S]*?display:\s*none/);
  assert.match(css, /data-work-log-turn-title[\s\S]*?border:\s*1px solid/);
  assert.doesNotMatch(css, /data-work-log-turns-toggle/);
  assert.match(
    css,
    /span\[data-kilo-usage\][\s\S]*?#e5c07b[\s\S]*?span\[data-mega-usage\][\s\S]*?#ff9d00[\s\S]*?span\[data-high-usage\][\s\S]*?#f14c4c/,
  );
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
      reason: "work-log-missing",
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
    assert.doesNotMatch(projected, /data-mega-usage>[^<]*кТЭ/);
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
    assert.match(projected, /data-work-log-turn-prompt>Сделай работу<\/div>/);
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
  assert.match(projectWorkLogUsage(restored), /data-work-log-legacy-outcome><td colspan="2">Старый итог<\/td>/);
});
