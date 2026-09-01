import { stat } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const TERMINAL_STATUSES = new Set(["aborted", "completed", "failed"]);

/* Открытие журнала контура на чтение.

   Даже read-only соединение с базой в режиме WAL работает через файл -shm и
   создаёт его, когда он отсутствует. Пока контур перезапускается, его runtime
   удаляет и заново создаёт -wal и -shm, и чтение из production попадает в
   середину этой смены — SQLite отвечает SQLITE_IOERR. Состояние кратковременное:
   следующая попытка проходит. Здесь оно и переживается, ограниченным числом
   попыток и только для этого класса ошибок; любая другая ошибка поднимается
   сразу и с полным контекстом, иначе диагностировать её потом нечем. */
const SQLITE_IOERR = 10;
const READ_OPEN_ATTEMPTS = 3;

function sqliteErrorCode(error) {
  const value = Number(error?.errcode);
  return Number.isInteger(value) ? value : null;
}

function transientIoError(error) {
  const code = sqliteErrorCode(error);
  return code !== null && (code & 0xff) === SQLITE_IOERR;
}

function describeFailure(error, { phase, file, attempts }) {
  const code = sqliteErrorCode(error);
  const details = [
    `фаза ${phase}`,
    `файл ${file}`,
    code === null ? "код SQLite неизвестен" : `код SQLite ${code}`,
    error?.errstr ? `${error.errstr}` : "",
    attempts > 1 ? `попыток ${attempts}` : "",
  ].filter(Boolean).join(", ");
  const failure = new Error(`${error?.message ?? error}: ${details}`);
  failure.cause = error;
  failure.phase = phase;
  failure.databaseFile = file;
  failure.sqliteCode = code;
  return failure;
}

function openJournalForRead(file, phase) {
  let lastError = null;
  for (let attempt = 1; attempt <= READ_OPEN_ATTEMPTS; attempt += 1) {
    try {
      return new DatabaseSync(file, { readOnly: true });
    } catch (error) {
      lastError = error;
      if (!transientIoError(error)) break;
    }
  }
  throw describeFailure(lastError, { phase, file, attempts: READ_OPEN_ATTEMPTS });
}

function tableExists(database, name) {
  return Boolean(database.prepare(`
    SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?
  `).get(name));
}

function identity(record) {
  const provider = String(record?.provider ?? "").trim().toLowerCase();
  const threadId = String(record?.threadId ?? "").trim();
  const turnId = String(record?.turnId ?? "").trim();
  return provider && threadId && turnId ? `${provider}\0${threadId}\0${turnId}` : "";
}

function parseRecord(value) {
  try {
    const record = JSON.parse(String(value ?? ""));
    return record && typeof record === "object" && !Array.isArray(record) ? record : null;
  } catch {
    return null;
  }
}

async function fileExists(file) {
  try {
    return (await stat(file)).isFile();
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function cloneBoundary(database) {
  if (!tableExists(database, "journal_store_meta")) return 0;
  return Number(database.prepare(`
    SELECT value FROM journal_store_meta WHERE key = 'test_contour_clone_at_ms'
  `).get()?.value ?? 0) || 0;
}

function targetIdentities(database) {
  if (!tableExists(database, "journal_records")) return new Set();
  return new Set(database.prepare(`
    SELECT provider, thread_id, turn_id FROM journal_records
  `).all().map((row) => (
    `${String(row.provider).toLowerCase()}\0${row.thread_id}\0${row.turn_id}`
  )));
}

export async function readMissingTestContourJournalRecords({
  sourceDatabaseFile,
  targetDatabaseFile,
  models = ["gpt-5.6-terra"],
} = {}) {
  const sourceFile = path.resolve(String(sourceDatabaseFile ?? ""));
  const targetFile = path.resolve(String(targetDatabaseFile ?? ""));
  if (!sourceDatabaseFile || !targetDatabaseFile || sourceFile === targetFile) {
    throw new Error("Test Contour journal sync requires different source and target databases");
  }
  if (!await fileExists(sourceFile)) {
    return { records: [], sourceRecords: 0, eligibleRecords: 0, cloneAtMs: 0, missing: true };
  }
  const acceptedModels = new Set((Array.isArray(models) ? models : [models])
    .map((model) => String(model ?? "").trim().toLowerCase())
    .filter(Boolean));
  const source = openJournalForRead(sourceFile, "чтение журнала Test Contour");
  const target = await fileExists(targetFile)
    ? openJournalForRead(targetFile, "чтение журнала production")
    : null;
  try {
    source.exec("PRAGMA busy_timeout = 2000");
    target?.exec("PRAGMA busy_timeout = 2000");
    if (!tableExists(source, "journal_records")) {
      return { records: [], sourceRecords: 0, eligibleRecords: 0, cloneAtMs: 0, missing: false };
    }
    const cloneAtMs = cloneBoundary(source);
    const existing = target ? targetIdentities(target) : new Set();
    if (!acceptedModels.size) {
      return { records: [], sourceRecords: 0, eligibleRecords: 0, cloneAtMs, missing: false };
    }
    const modelParameters = [...acceptedModels];
    const rows = source.prepare(`
      SELECT completed_at_ms, record_json
      FROM journal_records
      WHERE json_valid(record_json) = 1
        AND lower(json_extract(record_json, '$.provider')) = 'codex'
        AND lower(json_extract(record_json, '$.model')) IN (${modelParameters.map(() => "?").join(", ")})
        AND lower(json_extract(record_json, '$.status')) IN ('aborted', 'completed', 'failed')
        AND coalesce(json_extract(record_json, '$.provisional'), 0) = 0
        AND completed_at_ms IS NOT NULL
      ORDER BY completed_at_ms, provider, thread_id, turn_id
    `).all(...modelParameters);
    const eligible = [];
    for (const row of rows) {
      const record = parseRecord(row.record_json);
      const key = identity(record);
      const status = String(record?.status ?? "").trim().toLowerCase();
      const model = String(record?.model ?? "").trim().toLowerCase();
      const completedAtMs = Number(row.completed_at_ms) || Date.parse(record?.completedAt ?? "");
      if (!key || String(record?.provider ?? "").toLowerCase() !== "codex"
        || !acceptedModels.has(model) || record.provisional === true
        || !TERMINAL_STATUSES.has(status) || !Number.isFinite(completedAtMs)) continue;
      if (cloneAtMs && completedAtMs < cloneAtMs) continue;
      eligible.push(record);
    }
    return {
      records: eligible.filter((record) => !existing.has(identity(record))),
      sourceRecords: rows.length,
      eligibleRecords: eligible.length,
      cloneAtMs,
      missing: false,
    };
  } finally {
    target?.close();
    source.close();
  }
}
