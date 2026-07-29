import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import { displayUserPrompt } from "./task-history.mjs";
import { writeTextAtomic } from "./state-store.mjs";
import { projectWorkLogUsage } from "./work-log-usage.mjs";

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
  ledgerFile,
  workLogFile,
  backupRoot = path.join(path.dirname(ledgerFile), "migrations"),
  now = new Date(),
} = {}) {
  const missing = jobs.filter((job) => !cachedTitleForJob(cache, job));
  if (missing.length) throw new Error(`Missing generated titles: ${missing.length}`);
  const result = applyCachedTitles(ledger, jobs, cache);
  const backupDirectory = path.join(backupRoot, `titles-${migrationTimestamp(now)}`);
  await mkdir(backupDirectory, { recursive: true });
  for (const file of [ledgerFile, workLogFile]) {
    try {
      await copyFile(file, path.join(backupDirectory, path.basename(file)));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  const ledgerText = `${JSON.stringify(result.ledger, null, 2)}\n`;
  await writeTextAtomic(ledgerFile, ledgerText);
  await writeTextAtomic(`${ledgerFile}.bak`, ledgerText);
  await writeTextAtomic(workLogFile, projectWorkLogUsage("# Глобальный журнал работ\n", result.ledger.turns));
  return { ...result, backupDirectory };
}

export async function readJsonOr(filePath, fallback) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
}
