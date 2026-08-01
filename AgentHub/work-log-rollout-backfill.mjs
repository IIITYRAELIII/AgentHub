import { copyFile, mkdir, readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { isInheritedSubagentTurn } from "./codex-subagent-accounting.mjs";
import { scanCodexHistoricalRollout } from "./codex-turn-usage.mjs";
import { writeTextAtomic } from "./state-store.mjs";
import { withInterprocessLocks } from "./interprocess-lock.mjs";
import { projectWorkLogUsage, workLogTurnKey } from "./work-log-usage.mjs";

const LOCAL_TIME_ZONE = "Asia/Yekaterinburg";

function localIsoDate(value, timeZone = LOCAL_TIME_ZONE) {
  const date = new Date(String(value ?? ""));
  if (!Number.isFinite(date.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

async function rolloutFiles(root) {
  const files = [];
  async function visit(directory) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(candidate);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(".jsonl")) files.push(candidate);
    }
  }
  await visit(root);
  return files;
}

async function readThreadTitles(sessionIndexFile) {
  const titles = new Map();
  let text = "";
  try {
    text = await readFile(sessionIndexFile, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return titles;
    throw error;
  }
  for (const line of text.split(/\r?\n/u)) {
    if (!line) continue;
    try {
      const value = JSON.parse(line);
      const id = String(value?.id ?? "").trim();
      const title = String(value?.thread_name ?? "").replace(/\s+/gu, " ").trim();
      if (id && title) titles.set(id, title);
    } catch {
      // Ignore one damaged index record; rollout data remains authoritative.
    }
  }
  return titles;
}

function rootThreadId(threadId, sessions) {
  let current = String(threadId ?? "").trim();
  const visited = new Set();
  while (current && !visited.has(current)) {
    visited.add(current);
    const parent = String(sessions.get(current)?.parentThreadId ?? "").trim();
    if (!parent) return current;
    current = parent;
  }
  return current || String(threadId ?? "").trim();
}

function importedStatus(turn) {
  return turn.status === "completed" ? "completed" : "aborted";
}

function importedTitle(turn) {
  return importedStatus(turn) === "completed" ? "Ход завершён" : "Ход отменён";
}

function migrationTimestamp(now = new Date()) {
  return now.toISOString().replace(/[:.]/gu, "-");
}

export async function buildWorkLogRolloutBackfill({
  rolloutRoots,
  sessionIndexFile,
  ledgerFile,
  projectRoot,
  through,
  timeZone = LOCAL_TIME_ZONE,
  scanRollout = scanCodexHistoricalRollout,
} = {}) {
  if (!Array.isArray(rolloutRoots) || !rolloutRoots.length) {
    throw new Error("At least one Codex rollout root is required");
  }
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(String(through ?? ""))) {
    throw new Error("Backfill cutoff must use YYYY-MM-DD");
  }

  const files = [];
  for (const root of rolloutRoots) files.push(...await rolloutFiles(path.resolve(root)));
  files.sort((left, right) => left.localeCompare(right));

  const scans = [];
  const sessions = new Map();
  for (const file of files) {
    const scan = await scanRollout(file);
    const threadId = String(scan?.session?.threadId ?? "").trim();
    if (!threadId) continue;
    scans.push({ file, ...scan });
    sessions.set(threadId, { ...scan.session, file });
  }
  const titles = await readThreadTitles(sessionIndexFile);

  let currentLedger = { version: 8, turns: {} };
  try {
    currentLedger = JSON.parse(await readFile(ledgerFile, "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  const preserved = {};
  const replacedCodexKeys = [];
  let removedRecords = 0;
  let preservedNonCodexRecords = 0;
  for (const [key, record] of Object.entries(currentLedger?.turns ?? {})) {
    if (String(record?.provider ?? "").trim().toLowerCase() !== "codex") {
      preserved[key] = record;
      preservedNonCodexRecords += 1;
      continue;
    }
    const date = localIsoDate(record?.completedAt || record?.startedAt, timeZone);
    if (date && date > through) preserved[key] = record;
    else {
      removedRecords += 1;
      replacedCodexKeys.push(key);
    }
  }

  const imported = {};
  let inheritedTurns = 0;
  let laterTurns = 0;
  let emptyTurns = 0;
  for (const scan of scans) {
    const threadId = String(scan.session.threadId).trim();
    const parentThreadId = String(scan.session.parentThreadId ?? "").trim();
    const aggregateOnly = Boolean(parentThreadId);
    const taskThreadId = rootThreadId(threadId, sessions);
    const taskTitle = titles.get(taskThreadId) || titles.get(threadId) || "Без названия";
    for (const turn of scan.turns ?? []) {
      if (isInheritedSubagentTurn({ aggregateOnly, threadId, turnId: turn.turnId })) {
        inheritedTurns += 1;
        continue;
      }
      if (!turn.started && !turn.terminal && !turn.reported && !turn.prompt && !turn.finalAnswer) {
        emptyTurns += 1;
        continue;
      }
      const completedAt = turn.completedAt || turn.lastActivityAt || turn.startedAt;
      const date = localIsoDate(completedAt, timeZone);
      if (!date || date > through) {
        laterTurns += 1;
        continue;
      }
      const status = importedStatus(turn);
      const record = {
        workLogId: null,
        projectRoot: path.resolve(projectRoot),
        usage: turn.usage,
        usageReported: turn.reported === true,
        estimatedCredits: Number(turn.estimatedCredits ?? 0) || 0,
        estimateKind: String(turn.estimateKind ?? ""),
        model: String(turn.model ?? "").trim().toLowerCase(),
        serviceTier: String(turn.serviceTier ?? "default").trim().toLowerCase() || "default",
        pricingMetadataResolved: true,
        provider: "codex",
        threadId,
        taskThreadId,
        parentThreadId,
        aggregateOnly,
        provisional: false,
        turnId: turn.turnId,
        taskTitle,
        title: importedTitle(turn),
        body: String(turn.finalAnswer ?? "").trim(),
        prompt: String(turn.prompt ?? "").trim(),
        changedFiles: turn.changedFiles ?? [],
        diff: String(turn.diff ?? ""),
        skillsUsed: turn.skillsUsed ?? [],
        mcpCalls: turn.mcpCalls ?? [],
        toolMetricsKnown: turn.toolMetricsKnown === true,
        startedAt: turn.startedAt || completedAt,
        completedAt,
        status,
      };
      imported[workLogTurnKey(record)] = record;
    }
  }

  const turns = { ...preserved, ...imported };
  const countsByDate = {};
  const countsByStatus = {};
  const taskThreads = new Set();
  let recordsWithoutUsage = 0;
  for (const record of Object.values(imported)) {
    const date = localIsoDate(record.completedAt, timeZone);
    countsByDate[date] = (countsByDate[date] ?? 0) + 1;
    countsByStatus[record.status] = (countsByStatus[record.status] ?? 0) + 1;
    taskThreads.add(record.taskThreadId);
    if (!record.usageReported && !record.estimatedCredits) recordsWithoutUsage += 1;
  }
  return {
    ledger: { version: 8, turns },
    workLog: projectWorkLogUsage("# Глобальный журнал работ\n", turns),
    report: {
      cutoff: through,
      rolloutFiles: files.length,
      sessions: sessions.size,
      preservedRecords: Object.keys(preserved).length,
      preservedNonCodexRecords,
      removedRecords,
      replacedCodexKeys,
      importedRecords: Object.keys(imported).length,
      inheritedTurns,
      laterTurns,
      emptyTurns,
      taskThreads: taskThreads.size,
      recordsWithoutUsage,
      countsByStatus,
      countsByDate,
    },
  };
}

export async function applyWorkLogRolloutBackfill({
  migration,
  ledgerFile,
  workLogFile,
  backupRoot = path.join(path.dirname(ledgerFile), "migrations"),
  now = new Date(),
} = {}) {
  return withInterprocessLocks([ledgerFile, workLogFile], async () => {
    const backupDirectory = path.join(backupRoot, migrationTimestamp(now));
    await mkdir(backupDirectory, { recursive: true });
    let currentLedger = { version: 8, turns: {} };
    try {
      currentLedger = JSON.parse(await readFile(ledgerFile, "utf8"));
      await copyFile(ledgerFile, path.join(backupDirectory, path.basename(ledgerFile)));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    try {
      await copyFile(workLogFile, path.join(backupDirectory, path.basename(workLogFile)));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }

    const replacedCodexKeys = new Set(migration?.report?.replacedCodexKeys ?? []);
    const turns = { ...migration.ledger.turns };
    for (const [key, record] of Object.entries(currentLedger?.turns ?? {})) {
      if (!Object.hasOwn(turns, key) && !replacedCodexKeys.has(key)) turns[key] = record;
    }
    const mergedLedger = { version: 8, turns };
    const ledgerText = `${JSON.stringify(mergedLedger, null, 2)}\n`;
    await writeTextAtomic(ledgerFile, ledgerText);
    await writeTextAtomic(`${ledgerFile}.bak`, ledgerText);
    await writeTextAtomic(workLogFile, projectWorkLogUsage("# Глобальный журнал работ\n", turns));
    return { backupDirectory };
  });
}
