import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import { JournalDatabase } from "../../infrastructure/persistence/journal-database.mjs";
import { displayUserPrompt } from "../../application/task-history.mjs";
import { WorkLogUsageStore } from "../../../work-log-usage.mjs";

export const GENERIC_WORK_LOG_TITLES = new Set(["Ход завершён", "Ход отменён"]);
export const WORK_LOG_GENERATED_TITLE_LIMIT = 100;

function compact(value) {
  return String(value ?? "").replace(/\s+/gu, " ").trim();
}

function excerpt(value, limit = 900) {
  const text = compact(value);
  if (text.length <= limit) return text;
  const half = Math.floor((limit - 3) / 2);
  return `${text.slice(0, half)} … ${text.slice(-half)}`;
}

export function normalizeGeneratedTitle(value) {
  let title = compact(value)
    .replace(/^["'«“”]+|["'»“”]+$/gu, "")
    .replace(/[.!?;:,]+$/gu, "")
    .trim();
  if (title.length > WORK_LOG_GENERATED_TITLE_LIMIT) {
    title = title.slice(0, WORK_LOG_GENERATED_TITLE_LIMIT).trimEnd();
  }
  return title;
}

export function generatedTitleIsAcceptable(value) {
  const title = normalizeGeneratedTitle(value);
  if (!title) return false;
  if (GENERIC_WORK_LOG_TITLES.has(title)) return true;
  return !/^(?:Ход|Задача|Готово|Выполнено|Отменено)(?:\s|$)/iu.test(title);
}

export function titleSource(record) {
  const prompt = excerpt(displayUserPrompt(record?.prompt), 900);
  const answer = excerpt(record?.body, 900);
  const status = String(record?.status ?? "") === "completed" ? "completed" : "aborted";
  return {
    status,
    task: excerpt(record?.taskTitle, 120),
    prompt,
    answer,
  };
}

export function titleSourceHash(record) {
  return createHash("sha256")
    .update(JSON.stringify(titleSource(record)))
    .digest("hex");
}

export function buildTitleJobs(ledger, { through = "" } = {}) {
  return Object.entries(ledger?.turns ?? {})
    .filter(([, record]) => GENERIC_WORK_LOG_TITLES.has(compact(record?.title)))
    .filter(([, record]) => {
      if (!through) return true;
      const completed = String(record?.completedAt || record?.startedAt || "");
      return completed.slice(0, 10) <= through;
    })
    .map(([key, record], index) => ({
      id: String(index + 1),
      key,
      sourceHash: titleSourceHash(record),
      ...titleSource(record),
    }));
}

export function titleGenerationPrompt(jobs) {
  return [
    "Сгенерируй краткие русские заголовки ходов рабочего журнала.",
    "Верни только объект по заданной JSON-схеме.",
    "Правила:",
    "- заголовок описывает конкретный результат хода; для прерванного хода — выполнявшуюся работу;",
    "- опирайся только на переданные запрос и ответ, ничего не выдумывай;",
    "- 3–10 слов, максимум 100 символов, без точки в конце;",
    "- не начинай с «Ход», «Задача», «Готово», «Выполнено» или «Отменено»;",
    "- служебный IDE-контекст не является результатом;",
    "- если содержательных данных нет, используй «Ход завершён» или «Ход отменён» по статусу;",
    "- сохрани каждый id ровно один раз.",
    "",
    JSON.stringify({ turns: jobs.map(({ id, status, task, prompt, answer }) => ({
      id,
      status,
      task,
      prompt,
      answer,
    })) }),
  ].join("\n");
}

export function validateGeneratedBatch(jobs, generated) {
  const expected = new Map(jobs.map((job) => [job.id, job]));
  const result = new Map();
  for (const item of generated?.titles ?? []) {
    const id = compact(item?.id);
    if (!expected.has(id) || result.has(id)) continue;
    const title = normalizeGeneratedTitle(item?.title);
    if (generatedTitleIsAcceptable(title)) result.set(id, title);
  }
  const missing = jobs.filter((job) => !result.has(job.id));
  return { titles: result, missing };
}

export function mergeGeneratedTitleCache(cache, jobs, generated) {
  const next = { version: 1, titles: { ...(cache?.titles ?? {}) } };
  const valid = validateGeneratedBatch(jobs, generated);
  for (const job of jobs) {
    const title = valid.titles.get(job.id);
    if (!title) continue;
    next.titles[job.key] = {
      sourceHash: job.sourceHash,
      title,
    };
  }
  return { cache: next, missing: valid.missing };
}

export function cachedTitleForJob(cache, job) {
  const entry = cache?.titles?.[job.key];
  if (entry?.sourceHash !== job.sourceHash) return "";
  return generatedTitleIsAcceptable(entry?.title) ? normalizeGeneratedTitle(entry.title) : "";
}

export function applyCachedTitles(ledger, jobs, cache) {
  const next = structuredClone(ledger);
  let updated = 0;
  let unchanged = 0;
  for (const job of jobs) {
    const title = cachedTitleForJob(cache, job);
    if (!title) continue;
    const record = next.turns?.[job.key];
    if (!record) continue;
    if (record.title === title) {
      unchanged += 1;
      continue;
    }
    record.title = title;
    updated += 1;
  }
  return { ledger: next, updated, unchanged };
}

function migrationTimestamp(now = new Date()) {
  return now.toISOString().replace(/[:.]/gu, "-");
}

export async function applyWorkLogTitleBackfill({
  ledger,
  jobs,
  cache,
  databaseFile,
  ledgerFile,
  workLogFile,
  projectRoot = "",
  projectionProjectRoots,
  backupRoot,
  now = new Date(),
} = {}) {
  const missing = jobs.filter((job) => !cachedTitleForJob(cache, job));
  if (missing.length) throw new Error(`Missing generated titles: ${missing.length}`);
  if (!databaseFile) throw new Error("SQLite journal database is required");
  const resolvedBackupRoot = backupRoot || path.join(path.dirname(databaseFile), "migrations");
  const legacyLedgerFile = ledgerFile || path.join(path.dirname(databaseFile), "work-log-usage.json");
  const backupDirectory = path.join(resolvedBackupRoot, `titles-${migrationTimestamp(now)}`);
  await mkdir(backupDirectory, { recursive: true });
  for (const file of [
    legacyLedgerFile,
    `${legacyLedgerFile}.bak`,
    `${legacyLedgerFile}.delta.jsonl`,
    workLogFile,
  ].filter(Boolean)) {
    try {
      await copyFile(file, path.join(backupDirectory, path.basename(file)));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  const database = new JournalDatabase(databaseFile);
  try {
    await database.importLegacyLedger(legacyLedgerFile);
    let result = applyCachedTitles(ledger, jobs, cache);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const revision = await database.currentRevision();
      result = applyCachedTitles(await database.loadLedger(), jobs, cache);
      try {
        await database.replaceLedger(result.ledger, { expectedRevision: revision });
        break;
      } catch (error) {
        if (!/revision conflict/iu.test(String(error?.message ?? "")) || attempt === 2) throw error;
      }
    }
    const roots = Array.isArray(projectionProjectRoots) && projectionProjectRoots.length
      ? projectionProjectRoots
      : [...new Set(Object.values(result.ledger.turns)
        .map((record) => String(record?.projectRoot ?? "").trim()).filter(Boolean))];
    const resolvedProjectRoot = projectRoot || roots[0] || "";
    const store = new WorkLogUsageStore({
      ledgerFile: legacyLedgerFile,
      databaseFile,
      journalDatabase: database,
      defaultProjectRoot: resolvedProjectRoot,
    });
    try {
      await store.project(null, {
        projectRoot: resolvedProjectRoot,
        projectionProjectRoots: roots,
      });
    } finally {
      await store.close();
    }
    return { ...result, backupDirectory, databaseFile: path.resolve(databaseFile) };
  } finally {
    database.close();
  }
}

export async function readJsonOr(filePath, fallback) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
}
