import assert from "node:assert/strict";
import test from "node:test";

import {
  applyCachedTitles,
  buildTitleJobs,
  cachedTitleForJob,
  generatedTitleIsAcceptable,
  mergeGeneratedTitleCache,
  normalizeGeneratedTitle,
  titleGenerationPrompt,
} from "./work-log-title-backfill.mjs";

test("title backfill selects only generic historical titles", () => {
  const ledger = {
    turns: {
      a: {
        title: "Ход завершён",
        status: "completed",
        completedAt: "2026-07-26T10:00:00Z",
        prompt: "Сделай отчёт",
        body: "Отчёт создан.",
      },
      b: {
        title: "Нормальный заголовок",
        status: "completed",
        completedAt: "2026-07-26T11:00:00Z",
      },
      c: {
        title: "Ход отменён",
        status: "aborted",
        completedAt: "2026-07-27T11:00:00Z",
      },
    },
  };
  const jobs = buildTitleJobs(ledger, { through: "2026-07-26" });
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].key, "a");
  assert.match(titleGenerationPrompt(jobs), /Сделай отчёт/);
});

test("title cache validates ids, normalizes titles and applies them", () => {
  const ledger = {
    turns: {
      a: {
        title: "Ход завершён",
        status: "completed",
        completedAt: "2026-07-26T10:00:00Z",
        prompt: "Сделай отчёт",
        body: "Отчёт создан.",
      },
    },
  };
  const jobs = buildTitleJobs(ledger);
  const merged = mergeGeneratedTitleCache(null, jobs, {
    titles: [{ id: jobs[0].id, title: "«Отчёт создан.»" }],
  });
  assert.deepEqual(merged.missing, []);
  assert.equal(cachedTitleForJob(merged.cache, jobs[0]), "Отчёт создан");
  const applied = applyCachedTitles(ledger, jobs, merged.cache);
  assert.equal(applied.updated, 1);
  assert.equal(applied.ledger.turns.a.title, "Отчёт создан");
  assert.equal(ledger.turns.a.title, "Ход завершён");
});

test("generated titles are capped at the journal display limit", () => {
  assert.equal(normalizeGeneratedTitle("Т".repeat(120)).length, 100);
  assert.equal(generatedTitleIsAcceptable("Готово"), false);
  assert.equal(generatedTitleIsAcceptable("Ход завершён"), true);
  assert.equal(generatedTitleIsAcceptable("Отчёт сформирован"), true);
});
