import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  applyWorkLogUsage,
  normalizeWorkLogId,
  projectWorkLogUsage,
  WorkLogUsageStore,
} from "./work-log-usage.mjs";

const WORK_ID = "123e4567-e89b-42d3-a456-426614174000";
const SECOND_WORK_ID = "223e4567-e89b-42d3-a456-426614174000";

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
      `<span data-usage-id="${WORK_ID}">49 кТЭ<br>Вход: 8 кТЭ (17,1%)<br>Кэш: 35 кТЭ (71,8%)<br>Выход: 1 кТЭ (2,8%)<br>Думы: 4 кТЭ (8,3%)</span> + `,
      `<span data-usage-id="${SECOND_WORK_ID}">${SECOND_WORK_ID}</span>`,
      "</td></tr>",
    ].join(""),
  );
  assert.throws(() => applyWorkLogUsage("<table></table>", WORK_ID, 10), /found 0/);
});

test("projectWorkLogUsage aggregates tasks and calculates their share of the day", () => {
  const firstCompletedAt = new Date(2026, 6, 25, 12, 34).toISOString();
  const secondCompletedAt = new Date(2026, 6, 25, 13, 45).toISOString();
  const source = [
    "<details open>",
    "<summary><strong>25.07.2026</strong></summary>",
    "<table><colgroup><col><col><col></colgroup><thead>",
    "<tr><th>Задача</th><th>Итог</th><th>Расход</th></tr></thead><tbody>",
    `<tr><td>Task A</td><td>Outcome A</td><td data-work-log-usage><span data-usage-id="${WORK_ID}">${WORK_ID}</span><br>`,
    `<span data-usage-id="${SECOND_WORK_ID}">${SECOND_WORK_ID}</span></td>`,
    `<td data-work-log-turns>legacy</td><td><span data-usage-id="${WORK_ID}">${WORK_ID}</span><br>`,
    `<span data-usage-id="${SECOND_WORK_ID}">${SECOND_WORK_ID}</span></td></tr>`,
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
    },
    second: {
      workLogId: SECOND_WORK_ID,
      usage: { inputTokens: 50, cachedInputTokens: 0, outputTokens: 0 },
      completedAt: secondCompletedAt,
    },
    third: {
      workLogId: "423e4567-e89b-42d3-a456-426614174000",
      usage: { inputTokens: 100, cachedInputTokens: 0, outputTokens: 0 },
    },
  };
  const projected = projectWorkLogUsage(source, turns);
  assert.match(projected, /^<details data-work-log-day-section open>/);
  assert.match(projected, /<table data-work-log-table>/);
  assert.match(projected, /<col data-work-log-turns-column>/);
  assert.match(
    projected,
    /<th>Итог <details data-work-log-turns-toggle><summary>Ходы<\/summary><\/details><\/th><th>Расход<\/th><th data-work-log-turns><\/th>/,
  );
  assert.match(projected, /<td data-work-log-turns>12:34 — 0 кТЭ<br>\s*13:45 — 0 кТЭ<\/td>/);
  assert.match(projected, /data-day-usage>0 кТЭ/);
  assert.doesNotMatch(projected, /За день:/);
  assert.match(
    projected,
    /<summary data-work-log-day><strong>25\.07\.2026<\/strong> — <span data-day-usage>0 кТЭ<\/span> <span data-day-usage-breakdown>Вход: 0 кТЭ \(100%\)&nbsp;&nbsp;Кэш: 0 кТЭ \(0%\)&nbsp;&nbsp;Выход: 0 кТЭ \(0%\)&nbsp;&nbsp;Думы: 0 кТЭ \(0%\)<\/span><\/summary>/,
  );
  assert.doesNotMatch(projected, /data-day-usage-details/);
  assert.doesNotMatch(
    projected.match(/<span data-day-usage-breakdown>[\s\S]*?<\/span>/)?.[0] ?? "",
    /<br>/,
  );
  assert.match(projected, /Task A[\s\S]*?0 кТЭ \(50%\)/);
  assert.match(projected, /Task C[\s\S]*?0 кТЭ \(50%\)/);
  assert.match(
    projected,
    /data-task-usage>0 кТЭ \(50%\)<\/span>\s*<details data-task-usage-details><summary>Details<\/summary>Вход:/,
  );
  assert.doesNotMatch(projected, /<details data-task-usage-details open>/);
  assert.match(
    projected,
    /Task B<\/td>\s*<td>Outcome B<\/td>\s*<td data-work-log-usage><span data-usage-id="323e4567-e89b-42d3-a456-426614174000" hidden>[\s\S]*?<\/td>\s*<td data-work-log-turns><\/td>/,
  );
  assert.equal((projected.match(/data-task-usage>/g) ?? []).length, 2);
  assert.equal((projected.match(/data-task-usage-details/g) ?? []).length, 2);
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

test("work log CSS keeps dates equal and collapses the turns column by default", async () => {
  const css = await readFile(new URL("./work-log.css", import.meta.url), "utf8");
  assert.match(css, /summary\[data-work-log-day\][\s\S]*?font-size:\s*1em/);
  assert.match(
    css,
    /table\[data-work-log-table\]:not\(:has\(details\[data-work-log-turns-toggle\]\[open\]\)\)[\s\S]*?\[data-work-log-turns\][\s\S]*?display:\s*none/,
  );
  assert.match(
    css,
    /grid-template-columns:\s*14fr 62fr 16fr 8fr[\s\S]*?grid-template-columns:\s*14fr 70fr 16fr/,
  );
  assert.match(
    css,
    /details\[data-work-log-turns-toggle\][\s\S]*?position:\s*absolute[\s\S]*?right:\s*0\.5em/,
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
    };
    await store.recordAndProject({ ...base, turnId: "turn-1" });
    await store.recordAndProject({ ...base, turnId: "turn-1" });
    await store.recordAndProject({ ...base, turnId: "turn-2", workLogId: SECOND_WORK_ID });
    const projected = await readFile(workLogFile, "utf8");
    assert.match(projected, /data-day-usage>0 кТЭ/);
    assert.equal((projected.match(/data-day-usage-breakdown/g) ?? []).length, 1);
    assert.match(
      projected,
      /data-task-usage>0 кТЭ \(100%\)<\/span>\s*<details data-task-usage-details><summary>Details<\/summary>Вход:/,
    );
    assert.match(projected, new RegExp(`data-usage-id="${WORK_ID}" hidden>`));
    assert.match(projected, new RegExp(`data-usage-id="${SECOND_WORK_ID}" hidden>`));
    const ledger = JSON.parse(await readFile(ledgerFile, "utf8"));
    assert.equal(Object.keys(ledger.turns).length, 2);
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
    assert.match(await readFile(workLogFile, "utf8"), /data-task-usage>1 757 кТЭ \(100%\)/);
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
      workLogId: WORK_ID,
      target: "exact-thread-row",
    });
    assert.equal((await readFile(workLogFile, "utf8")).match(/data-usage-id=/g)?.length, 1);
    assert.equal((await store.recordAutomaticAndProject(input)).recorded, false);
    assert.equal((await readFile(workLogFile, "utf8")).match(/data-usage-id=/g)?.length, 1);
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
      workLogFile,
    });
    assert.equal(result.target, "fallback-ambiguous");
    const projected = await readFile(workLogFile, "utf8");
    assert.match(projected, /data-work-log-unbound-thread="thread-1"/);
    assert.match(projected, /Codex - Автоматически учтённые ходы/);
    assert.match(projected, new RegExp(`data-usage-id="${SECOND_WORK_ID}" hidden`));
    assert.match(projected, /data-task-usage>0 кТЭ \(100%\)/);
    assert.match(projected, /13:45 — 0 кТЭ/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
