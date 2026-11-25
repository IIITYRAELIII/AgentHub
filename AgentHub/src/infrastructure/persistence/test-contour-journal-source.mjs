import { stat } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";

export const TEST_CONTOUR_PAGE_ROWS = 128;
export const TEST_CONTOUR_RECORD_BYTES = 8 * 1024 * 1024;
export const TEST_CONTOUR_PAGE_BYTES = 8 * 1024 * 1024;
export const TEST_CONTOUR_CHECKPOINT_KEY = "test_contour_journal_checkpoint_v1";

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

function metadata(database, key) {
  return tableExists(database, "journal_store_meta")
    ? String(database.prepare("SELECT value FROM journal_store_meta WHERE key = ?").get(key)?.value ?? "") : "";
}

async function fileIdentity(file) {
  try {
    const info = await stat(file, { bigint: true });
    return info.isFile() ? [file, String(info.dev), String(info.ino), String(info.birthtimeNs)] : null;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

export { fileIdentity as testContourJournalFileIdentity };

function digest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function checkpointValue(value) {
  if (typeof value !== "string" || value.length > 4096) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed?.version === 1 && typeof parsed.generation === "string"
      && Number.isSafeInteger(parsed.afterRevision) && parsed.afterRevision >= -1
      && Number.isSafeInteger(parsed.upperRevision) && parsed.upperRevision >= parsed.afterRevision
      && Number.isSafeInteger(parsed.targetRevision) && parsed.targetRevision >= 0
      && (parsed.cursor === null || (Array.isArray(parsed.cursor) && parsed.cursor.length === 4
        && Number.isSafeInteger(parsed.cursor[0]) && parsed.cursor[0] > parsed.afterRevision
        && parsed.cursor[0] <= parsed.upperRevision
        && parsed.cursor.slice(1).every((part) => typeof part === "string" && part.length <= 512)))
      ? parsed : null;
  } catch { return null; }
}

function generation(source, target, sourceIdentity, targetIdentity, modelKey) {
  return digest([sourceIdentity, targetIdentity, cloneBoundary(source),
    target ? metadata(target, "journal_ingest_reset_revision") : "", modelKey]);
}

// A page is an immutable revision window, not a completion-time watermark.
// Old timestamps and later terminal/eligibility updates therefore remain visible.
// Legacy schemas fail explicitly; their existing JournalDatabase migration owns
// changed_revision/index creation. There is no recurring full-scan fallback.
function requireRevisionIndex(source) {
  if (!source.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'journal_records_changed_idx'").get()) {
    const error = new Error("Test Contour journal requires the owning changed_revision migration");
    error.code = "TEST_CONTOUR_REVISION_SCHEMA_REQUIRED";
    throw error;
  }
}

export async function readMissingTestContourJournalRecords({
  sourceDatabaseFile,
  targetDatabaseFile,
  models = ["gpt-5.6-terra"],
  checkpoint = "",
  pageSize = TEST_CONTOUR_PAGE_ROWS,
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
  const sourceIdentity = await fileIdentity(sourceFile);
  const targetIdentity = await fileIdentity(targetFile);
  const modelKey = [...acceptedModels].sort();
  const limit = Math.min(TEST_CONTOUR_PAGE_ROWS, Math.max(1, Math.floor(Number(pageSize) || TEST_CONTOUR_PAGE_ROWS)));
  let source;
  let target;
  try {
    source = openJournalForRead(sourceFile, "чтение журнала Test Contour");
    target = targetIdentity ? openJournalForRead(targetFile, "чтение журнала production") : null;
    source.exec("PRAGMA busy_timeout = 0; BEGIN");
    target?.exec("PRAGMA busy_timeout = 0; BEGIN");
    if (!tableExists(source, "journal_records")) {
      return { records: [], sourceRecords: 0, eligibleRecords: 0, cloneAtMs: 0, missing: false };
    }
    const cloneAtMs = cloneBoundary(source);
    requireRevisionIndex(source);
    const revision = Number(metadata(source, "revision"));
    const targetRevision = Number(target ? metadata(target, "revision") : 0);
    if (!Number.isSafeInteger(revision) || revision < 0 || !Number.isSafeInteger(targetRevision) || targetRevision < 0) {
      throw new Error("Test Contour journal has no valid canonical revision");
    }
    const fingerprint = generation(source, target, sourceIdentity, targetIdentity, modelKey);
    const saved = checkpointValue(checkpoint);
    const reusable = saved && saved.generation === fingerprint
      && revision >= saved.upperRevision && targetRevision >= saved.targetRevision;
    const afterRevision = reusable ? saved.afterRevision : -1;
    const cursor = reusable ? saved.cursor : null;
    const upperRevision = cursor ? saved.upperRevision : revision;
    const lower = cursor ?? [afterRevision + 1, "", "", ""];
    const rows = source.prepare(`
      SELECT changed_revision, provider, thread_id, turn_id
      FROM journal_records INDEXED BY journal_records_changed_idx
      WHERE (changed_revision, provider, thread_id, turn_id) > (?, ?, ?, ?)
        AND changed_revision <= ?
      ORDER BY changed_revision, provider, thread_id, turn_id LIMIT ?
    `).all(...lower, upperRevision, limit);
    const modelParameters = [...acceptedModels];
    // Classify only addressed rows inside SQLite, before applying the eligible
    // payload cap. Excluded JSON never enters JS or poisons a revision page.
    const payload = source.prepare(`SELECT completed_at_ms, length(CAST(record_json AS BLOB)) AS bytes,
      CASE WHEN json_valid(record_json) = 1 THEN
        lower(json_extract(record_json, '$.provider')) = 'codex'
        AND lower(json_extract(record_json, '$.model')) IN (${modelParameters.map(() => "?").join(", ") || "NULL"})
        AND lower(json_extract(record_json, '$.status')) IN ('aborted', 'completed', 'failed')
        AND coalesce(json_extract(record_json, '$.provisional'), 0) = 0
      ELSE 0 END AS eligible
      FROM journal_records WHERE provider = ? AND thread_id = ? AND turn_id = ?`);
    const read = source.prepare("SELECT record_json FROM journal_records WHERE provider = ? AND thread_id = ? AND turn_id = ?");
    const existing = target && tableExists(target, "journal_records") ? target.prepare(`SELECT changed_revision
      FROM journal_records WHERE provider = ? AND thread_id = ? AND turn_id = ?`) : null;
    const projection = target ? parseRecord(metadata(target, "journal_projection_source")) : null;
    const records = [];
    let eligibleRecords = 0;
    let targetLookups = 0;
    let recordBytes = 0;
    let inspected = 0;
    let last = cursor;
    let projectionRequired = false;
    for (const row of rows) {
      const tuple = [row.changed_revision, row.provider, row.thread_id, row.turn_id];
      const args = tuple.slice(1);
      if (row.provider !== "codex") { inspected += 1; last = tuple; continue; }
      const info = payload.get(...modelParameters, ...args);
      if (!info.eligible || info.completed_at_ms === null || (cloneAtMs && info.completed_at_ms < cloneAtMs)) {
        inspected += 1; last = tuple; continue;
      }
      if (info.bytes > TEST_CONTOUR_RECORD_BYTES) {
        const error = new Error("Test Contour record exceeds the 8 MiB import policy; checkpoint not advanced");
        error.code = "TEST_CONTOUR_RECORD_TOO_LARGE";
        throw error;
      }
      if (recordBytes + info.bytes > TEST_CONTOUR_PAGE_BYTES) break;
      recordBytes += info.bytes;
      const record = parseRecord(read.get(...args)?.record_json);
      inspected += 1;
      last = tuple;
      const key = identity(record);
      const status = String(record?.status ?? "").toLowerCase();
      const model = String(record?.model ?? "").toLowerCase();
      const completedAtMs = Number(info.completed_at_ms) || Date.parse(record?.completedAt ?? "");
      if (!key || key !== args.join("\0") || String(record?.provider ?? "").toLowerCase() !== "codex"
        || !acceptedModels.has(model)
        || (record.provisional != null && record.provisional !== false && record.provisional !== 0)
        || !TERMINAL_STATUSES.has(status) || !Number.isFinite(completedAtMs)) continue;
      if (cloneAtMs && completedAtMs < cloneAtMs) continue;
      eligibleRecords += 1;
      targetLookups += 1;
      const found = existing?.get(...args);
      if (!found) records.push(record);
      else projectionRequired ||= !projection || found.changed_revision > projection.revision;
    }
    // A full metadata page may have more rows. One bounded empty continuation
    // proves the window exhausted; never COUNT the whole journal to determine it.
    const hasMore = inspected < rows.length || rows.length === limit;
    const next = { version: 1, generation: fingerprint, modelKey,
      afterRevision: hasMore ? afterRevision : upperRevision, upperRevision,
      cursor: hasMore ? last : null, targetRevision };
    if (digest(await fileIdentity(sourceFile)) !== digest(sourceIdentity)
      || digest(await fileIdentity(targetFile)) !== digest(targetIdentity)) {
      throw new Error("Test Contour journal generation changed during the read");
    }
    return {
      records, sourceRecords: inspected, eligibleRecords, targetLookups, recordBytes,
      hasMore, projectionRequired,
      expectedCheckpoint: checkpoint,
      nextCheckpoint: reusable && !rows.length && !cursor && saved.afterRevision === revision
        ? checkpoint : JSON.stringify(next),
      cloneAtMs,
      missing: false,
    };
  } finally {
    target?.close();
    source?.close();
  }
}

// Revalidate the generation before checkpoint CAS. No payload or identity scan.
export async function validateTestContourJournalCheckpoint({ sourceDatabaseFile, targetDatabaseFile, nextCheckpoint }) {
  const next = checkpointValue(nextCheckpoint);
  if (!next) throw new Error("Invalid Test Contour checkpoint");
  const sourceFile = path.resolve(sourceDatabaseFile);
  const targetFile = path.resolve(targetDatabaseFile);
  const sourceIdentity = await fileIdentity(sourceFile);
  const targetIdentity = await fileIdentity(targetFile);
  let source;
  let target;
  try {
    source = openJournalForRead(sourceFile, "проверка поколения Test Contour");
    target = openJournalForRead(targetFile, "проверка поколения production");
    source.exec("PRAGMA busy_timeout = 0; BEGIN");
    target.exec("PRAGMA busy_timeout = 0; BEGIN");
    if (generation(source, target, sourceIdentity, targetIdentity, next.modelKey) !== next.generation
      || Number(metadata(source, "revision")) < next.upperRevision
      || Number(metadata(target, "revision")) < next.targetRevision) {
      throw new Error("Test Contour checkpoint generation changed before acknowledgement");
    }
  } finally { target?.close(); source?.close(); }
}
