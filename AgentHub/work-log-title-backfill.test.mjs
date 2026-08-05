import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { JournalDatabase } from "./src/infrastructure/persistence/journal-database.mjs";
import {
  applyWorkLogTitleBackfill,
  applyCachedTitles,
  buildTitleJobs,
  cachedTitleForJob,
  generatedTitleIsAcceptable,
  mergeGeneratedTitleCache,
  normalizeGeneratedTitle,
  titleGenerationPrompt,
} from "./src/interfaces/cli/work-log-title-backfill.mjs";

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

test("title backfill updates SQLite and leaves legacy files unchanged", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-title-backfill-"));
  const dataDir = path.join(root, "data");
  const databaseFile = path.join(dataDir, "journal.sqlite");
  const ledgerFile = path.join(dataDir, "work-log-usage.json");
  const workLogFile = path.join(root, "WORK_LOG.md");
  const key = "codex\u0000thread\u0000turn";
  const ledger = {
    version: 8,
    turns: {
      [key]: {
        provider: "codex",
        threadId: "thread",
        taskThreadId: "thread",
        turnId: "turn",
        projectRoot: root,
        title: "Ход завершён",
        status: "completed",
        completedAt: "2026-07-26T10:00:00Z",
        prompt: "Сделай отчёт",
        body: "Отчёт создан.",
      },
    },
  };
  try {
    await mkdir(dataDir, { recursive: true });
    await writeFile(ledgerFile, `${JSON.stringify(ledger, null, 2)}\n`, "utf8");
    await writeFile(workLogFile, "# Старый журнал\n", "utf8");
    const jobs = buildTitleJobs(ledger);
    const { cache } = mergeGeneratedTitleCache(null, jobs, {
      titles: [{ id: jobs[0].id, title: "Отчёт сформирован" }],
    });
    const result = await applyWorkLogTitleBackfill({
      ledger,
      jobs,
      cache,
      databaseFile,
      ledgerFile,
      workLogFile,
      projectRoot: root,
      projectionProjectRoots: [root],
    });
    assert.equal(result.updated, 1);
    assert.equal(await readFile(workLogFile, "utf8"), "# Старый журнал\n");
    assert.deepEqual(JSON.parse(await readFile(ledgerFile, "utf8")), ledger);
    const database = new JournalDatabase(databaseFile);
    const stored = await database.loadLedger();
    const snapshot = await database.snapshot();
    database.close();
    assert.equal(stored.turns[key].title, "Отчёт сформирован");
    assert.match(snapshot.html, /Отчёт сформирован/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
