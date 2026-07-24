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
      `<span data-usage-id="${WORK_ID}">За задачу: 48 532,2 у.е.<br>Вход: 8 301 (17,1%)<br>Кэш: 34 867,2 (71,8%)<br>Выход: 1 332 (2,8%)<br>Думы: 4 032 (8,3%)</span> + `,
      `<span data-usage-id="${SECOND_WORK_ID}">${SECOND_WORK_ID}</span>`,
      "</td></tr>",
    ].join(""),
  );
  assert.throws(() => applyWorkLogUsage("<table></table>", WORK_ID, 10), /found 0/);
});

test("projectWorkLogUsage aggregates tasks and calculates their share of the day", () => {
  const source = [
    "<details open>",
    "<summary><strong>25.07.2026</strong></summary>",
    "<table><tbody>",
    `<tr><td>Task A</td><td><span data-usage-id="${WORK_ID}">${WORK_ID}</span><br>`,
    `<span data-usage-id="${SECOND_WORK_ID}">${SECOND_WORK_ID}</span></td></tr>`,
    `<tr><td>Task B</td><td><span data-usage-id="323e4567-e89b-42d3-a456-426614174000">pending</span></td></tr>`,
    `<tr><td>Task C</td><td><span data-usage-id="423e4567-e89b-42d3-a456-426614174000">recorded</span></td></tr>`,
    "</tbody></table>",
    "</details>",
  ].join("");
  const turns = {
    first: {
      workLogId: WORK_ID,
      usage: { inputTokens: 50, cachedInputTokens: 0, outputTokens: 0 },
    },
    second: {
      workLogId: SECOND_WORK_ID,
      usage: { inputTokens: 50, cachedInputTokens: 0, outputTokens: 0 },
    },
    third: {
      workLogId: "423e4567-e89b-42d3-a456-426614174000",
      usage: { inputTokens: 100, cachedInputTokens: 0, outputTokens: 0 },
    },
  };
  const projected = projectWorkLogUsage(source, turns);
  assert.match(projected, /data-day-usage>200 у\.е\./);
  assert.doesNotMatch(projected, /За день:/);
  assert.match(
    projected,
    /<summary data-work-log-day><strong>25\.07\.2026<\/strong> — <span data-day-usage>200 у\.е\.<\/span><\/summary> <details data-day-usage-details><summary>Details<\/summary><div data-day-usage-breakdown>Вход: 200 \(100%\)&nbsp;&nbsp;Кэш: 0 \(0%\)&nbsp;&nbsp;Выход: 0 \(0%\)&nbsp;&nbsp;Думы: 0 \(0%\)<\/div><\/details>/,
  );
  assert.doesNotMatch(
    projected.match(/<details data-day-usage-details[^>]*>[\s\S]*?<\/details>/)?.[0] ?? "",
    /<br>/,
  );
  assert.match(projected, /Task A[\s\S]*?За задачу: 100 у\.е\. \(50%\)/);
  assert.match(projected, /Task C[\s\S]*?За задачу: 100 у\.е\. \(50%\)/);
  assert.match(
    projected,
    /data-task-usage>За задачу: 100 у\.е\. \(50%\)<\/span>\s*<details data-task-usage-details><summary>Details<\/summary>Вход:/,
  );
  assert.doesNotMatch(projected, /<details data-task-usage-details open>/);
  assert.match(
    projected,
    /Task B<\/td><td><span data-usage-id="323e4567-e89b-42d3-a456-426614174000" hidden>/,
  );
  assert.equal((projected.match(/data-task-usage>/g) ?? []).length, 2);
  assert.equal((projected.match(/data-task-usage-details/g) ?? []).length, 2);
  assert.equal((projected.match(/data-usage-id=/g) ?? []).length, 4);
  assert.equal((projected.match(/data-usage-id=[^>]+hidden/g) ?? []).length, 4);
});

test("usage store projects each turn into its own placeholder and deduplicates retries", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "work-log-usage-"));
  try {
    const ledgerFile = path.join(root, "data", "work-log-usage.json");
    const workLogFile = path.join(root, "WORK_LOG.md");
    await writeFile(
      workLogFile,
      [
        "<details open><summary><strong>25.07.2026</strong></summary><table><tbody><tr><td>Task</td><td>",
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
    assert.match(projected, /data-day-usage>64 у\.е\./);
    assert.equal((projected.match(/data-day-usage-details/g) ?? []).length, 1);
    assert.match(
      projected,
      /data-task-usage>За задачу: 64 у\.е\. \(100%\)<\/span>\s*<details data-task-usage-details><summary>Details<\/summary>Вход:/,
    );
    assert.match(projected, new RegExp(`data-usage-id="${WORK_ID}" hidden>`));
    assert.match(projected, new RegExp(`data-usage-id="${SECOND_WORK_ID}" hidden>`));
    const ledger = JSON.parse(await readFile(ledgerFile, "utf8"));
    assert.equal(Object.keys(ledger.turns).length, 2);
    await assert.rejects(
      store.recordAndProject({ ...base, turnId: "turn-3" }),
      /already assigned to another turn/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
