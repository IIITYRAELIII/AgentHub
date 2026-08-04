import { copyFile, mkdir, readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { isInheritedSubagentTurn } from "./codex-subagent-accounting.mjs";
import { scanCodexHistoricalRollout } from "./codex-turn-usage.mjs";
import { applyLedgerDelta } from "./incremental-ledger.mjs";
import { JournalDatabase } from "./journal-database.mjs";
import { readJsonWithBackup } from "./state-store.mjs";
import { conciseTurnTitle } from "./turn-title.mjs";
import { WorkLogUsageStore, workLogTurnKey } from "./work-log-usage.mjs";

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
  return conciseTurnTitle(turn?.finalAnswer, importedStatus(turn));
}

function migrationTimestamp(now = new Date()) {
  return now.toISOString().replace(/[:.]/gu, "-");
}

export async function buildWorkLogRolloutBackfill({
  rolloutRoots,
  sessionIndexFile,
  ledgerFile,
  databaseFile,
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
  if (databaseFile) {
    const database = new JournalDatabase(databaseFile);
    try {
      currentLedger = await database.loadLedger();
    } finally {
      database.close();
    }
  }
  if (!Object.keys(currentLedger.turns ?? {}).length && ledgerFile) {
    const loaded = await readJsonWithBackup(ledgerFile);
    currentLedger = (await applyLedgerDelta(
      loaded.value ?? currentLedger,
      `${ledgerFile}.delta.jsonl`,
    )).value;
  }

  const preserved = {};
  const replacedCodexKeys = [];
  let removedRecords = 0;
  let preservedNonCodexRecords = 0;
  for (const record of Object.values(currentLedger?.turns ?? {})) {
    const canonicalKey = workLogTurnKey(record);
    if (String(record?.provider ?? "").trim().toLowerCase() !== "codex") {
      preserved[canonicalKey] = record;
      preservedNonCodexRecords += 1;
      continue;
    }
    const date = localIsoDate(record?.completedAt || record?.startedAt, timeZone);
    if (date && date > through) preserved[canonicalKey] = record;
    else {
      removedRecords += 1;
      replacedCodexKeys.push(canonicalKey);
    }
  }

  const imported = {};
  let inheritedTurns = 0;
  let laterTurns = 0;
  let emptyTurns = 0;
  const spawnByChildThread = new Map();
  for (const scan of scans) {
    const parentThreadId = String(scan.session.threadId ?? "").trim();
    for (const turn of scan.turns ?? []) {
      for (const spawned of turn.spawnedSubagents ?? []) {
        const childThreadId = String(spawned?.threadId ?? "").trim();
        if (!childThreadId) continue;
        spawnByChildThread.set(childThreadId, {
          parentThreadId,
          parentTurnId: String(turn.turnId ?? "").trim(),
        });
      }
    }
  }
  for (const scan of scans) {
    const threadId = String(scan.session.threadId).trim();
    const parentThreadId = String(scan.session.parentThreadId ?? "").trim();
    const spawn = spawnByChildThread.get(threadId);
    const parentTurnId = spawn?.parentThreadId === parentThreadId
      ? spawn.parentTurnId
      : "";
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
        parentTurnId,
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
  databaseFile,
  ledgerFile,
  workLogFile,
  projectRoot,
  projectionProjectRoots,
  backupRoot,
  now = new Date(),
} = {}) {
  if (!databaseFile) throw new Error("SQLite journal database is required");
  const resolvedBackupRoot = backupRoot || path.join(path.dirname(databaseFile), "migrations");
  const legacyLedgerFile = ledgerFile || path.join(path.dirname(databaseFile), "work-log-usage.json");
  const backupDirectory = path.join(resolvedBackupRoot, migrationTimestamp(now));
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
    let applied;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const revision = await database.currentRevision();
      const currentLedger = await database.loadLedger();
      const replacedCodexKeys = new Set(migration?.report?.replacedCodexKeys ?? []);
      const turns = { ...migration.ledger.turns };
      for (const [key, record] of Object.entries(currentLedger?.turns ?? {})) {
        if (!Object.hasOwn(turns, key) && !replacedCodexKeys.has(key)) turns[key] = record;
      }
      try {
        applied = await database.replaceLedger(
          { version: 8, turns },
          { expectedRevision: revision },
        );
        break;
      } catch (error) {
        if (!/revision conflict/iu.test(String(error?.message ?? "")) || attempt === 2) throw error;
      }
    }
    const store = new WorkLogUsageStore({
      ledgerFile: legacyLedgerFile,
      databaseFile,
      journalDatabase: database,
      defaultProjectRoot: projectRoot,
    });
    try {
      await store.project(null, { projectRoot, projectionProjectRoots });
    } finally {
      await store.close();
    }
    return { backupDirectory, databaseFile: path.resolve(databaseFile), ...applied };
  } finally {
    database.close();
  }
}
