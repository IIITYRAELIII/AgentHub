import { randomUUID } from "node:crypto";
import { lstat, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { withInterprocessLocks } from "../process/interprocess-lock.mjs";
import { deleteVerifiedWindowsEntry } from "./windows-delete-verified-entry.mjs";

const TABLE = "work_log_account_backup_receipts";
const KEEP = 3;
const MAX_PRUNE_CANDIDATES = 3;
const PRUNE_BUDGET_MS = 20_000;

function pruneFailureKind(error) {
  const diagnostic = String(error?.stderr ?? error?.message ?? "");
  const mismatch = /Verified entry identity mismatch: (type|links|volume|index|size)/u.exec(diagnostic);
  if (mismatch) return `identity-${mismatch[1]}`;
  if (/Verified entry open failed/u.test(diagnostic)) return "open-failed";
  if (/Verified entry delete failed/u.test(diagnostic)) return "delete-failed";
  if (/Verified entry identity read failed/u.test(diagnostic)) return "identity-read-failed";
  if (/Handle-bound backup pruning requires Windows|Add-Type|Trusted Windows SystemRoot/u.test(diagnostic))
    return "helper-unavailable";
  if (error?.code === "ENOENT") return "missing-entry";
  return "prune-failed";
}

export function ensureWorkLogAccountBackupReceipts(database) {
  database.exec(`CREATE TABLE IF NOT EXISTS ${TABLE} (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    directory_name TEXT NOT NULL UNIQUE,
    file_name TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('pending', 'failed', 'committed', 'pruning', 'pruned')),
    created_at_ms INTEGER NOT NULL,
    failed_at_ms INTEGER,
    failure_stage TEXT,
    committed_at_ms INTEGER,
    size_bytes INTEGER,
    file_dev TEXT,
    file_ino TEXT,
    directory_dev TEXT,
    directory_ino TEXT,
    hold_reason TEXT NOT NULL DEFAULT '',
    prune_file_removed INTEGER NOT NULL DEFAULT 0,
    prune_attempts INTEGER NOT NULL DEFAULT 0
  )`);
  if (!database.prepare(`PRAGMA table_info(${TABLE})`).all()
    .some((column) => column.name === "prune_attempts")) {
    database.exec(`ALTER TABLE ${TABLE} ADD COLUMN prune_attempts INTEGER NOT NULL DEFAULT 0`);
  }
}

export function startWorkLogAccountBackup(database, { now, fileName }) {
  const id = randomUUID();
  const directoryName = `work-log-account-${now.toISOString().replace(/[:.]/gu, "-")}-${id}`;
  database.prepare(`INSERT INTO ${TABLE}
    (id, directory_name, file_name, state, created_at_ms)
    VALUES (?, ?, ?, 'pending', ?)`)
    .run(id, directoryName, fileName, now.getTime());
  return { id, directoryName, fileName };
}

export function commitWorkLogAccountBackup(database, backup, info, directoryInfo, now) {
  const result = database.prepare(`UPDATE ${TABLE} SET state='committed',
    committed_at_ms=?, size_bytes=?, file_dev=?, file_ino=?,
    directory_dev=?, directory_ino=?
    WHERE id=? AND state='pending'`)
    .run(now.getTime(), Number(info.size), String(info.dev), String(info.ino),
      String(directoryInfo.dev), String(directoryInfo.ino), backup.id);
  if (result.changes !== 1) throw new Error("Account backup receipt changed before commit");
}

export function failWorkLogAccountBackup(database, backup, stage) {
  if (!["backup", "transaction"].includes(stage)) throw new Error("Invalid backup failure stage");
  database.prepare(`UPDATE ${TABLE} SET state='failed', failed_at_ms=?, failure_stage=?
    WHERE id=? AND state='pending'`).run(Date.now(), stage, backup.id);
}

function safeName(name, prefix = "") {
  return typeof name === "string" && name.startsWith(prefix)
    && name !== "." && name !== ".." && !/[\\/]/u.test(name);
}

async function inspectDirectory(root, row) {
  if (!safeName(row.directory_name, "work-log-account-")
      || !/^\d+$/u.test(String(row.directory_dev))
      || !/^\d+$/u.test(String(row.directory_ino))) return null;
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) return null;
  const directory = path.join(root, row.directory_name);
  const directoryInfo = await lstat(directory, { bigint: true }).catch(() => null);
  if (!directoryInfo?.isDirectory() || directoryInfo.isSymbolicLink()
      || row.directory_dev !== String(directoryInfo.dev)
      || row.directory_ino !== String(directoryInfo.ino)) return null;
  const [rootReal, directoryReal] = await Promise.all([realpath(root), realpath(directory)]);
  if (path.dirname(directoryReal).toLowerCase() !== rootReal.toLowerCase()) return null;
  return { directory, info: directoryInfo };
}

async function inspectBackup(root, databaseName, row) {
  if (!safeName(row.file_name) || row.file_name !== databaseName) return null;
  const checkedDirectory = await inspectDirectory(root, row);
  if (!checkedDirectory) return null;
  const { directory } = checkedDirectory;
  const file = path.join(directory, row.file_name);
  const fileInfo = await lstat(file, { bigint: true }).catch(() => null);
  if (!fileInfo?.isFile() || fileInfo.isSymbolicLink() || fileInfo.nlink !== 1n) return null;
  const fileReal = await realpath(file);
  if (path.dirname(fileReal).toLowerCase() !== (await realpath(directory)).toLowerCase()) return null;
  if (BigInt(row.size_bytes) !== fileInfo.size || row.file_dev !== String(fileInfo.dev)
      || row.file_ino !== String(fileInfo.ino)) return null;
  const children = await readdir(directory);
  if (children.length !== 1 || children[0] !== row.file_name) return null;
  return { directory, file, bytes: Number(fileInfo.size) };
}

// Called under the same database interprocess lock as the backfill. Legacy files
// have no receipt and are never considered here.
export async function pruneWorkLogAccountBackups(database, {
  root, databaseName, deleteEntry = deleteVerifiedWindowsEntry,
  beforeDelete = null, handleTestBarrier = "",
  clock = () => performance.now(), budgetMs = PRUNE_BUDGET_MS,
} = {}) {
  const started = clock();
  const workBudgetMs = Math.min(PRUNE_BUDGET_MS, Math.max(1, Number(budgetMs) || PRUNE_BUDGET_MS));
  const budgetExhausted = () => clock() - started >= workBudgetMs;
  const keep = database.prepare(`SELECT * FROM ${TABLE}
    WHERE state='committed' ORDER BY sequence DESC LIMIT ?`).all(KEEP);
  const result = { deleted: 0, bytes: 0, errors: 0, skipped: 0, retained: keep.length,
    attempted: 0, remaining: 0, budgetExhausted: false, failureKinds: [] };
  if (keep.length < KEEP) return result;
  // A missing or changed retained copy is not a reason to delete another one.
  for (const row of keep) {
    if (!await inspectBackup(root, databaseName, row).catch(() => null)) {
      result.errors += 1;
      return result;
    }
  }
  const candidateWhere = `state='pruning' OR (state='committed' AND hold_reason=''
    AND id NOT IN (${keep.map(() => "?").join(", ")}))`;
  const keepIds = keep.map((row) => row.id);
  // The durable attempt count rotates failing receipts, so one unavailable
  // helper cannot starve every newer or older eligible copy on each sync.
  const candidates = database.prepare(`SELECT * FROM ${TABLE} WHERE ${candidateWhere}
    ORDER BY prune_attempts ASC, sequence ASC LIMIT ?`)
    .all(...keepIds, MAX_PRUNE_CANDIDATES);
  for (const row of candidates) {
    if (budgetExhausted()) { result.budgetExhausted = true; break; }
    database.prepare(`UPDATE ${TABLE} SET prune_attempts=prune_attempts+1 WHERE id=?`)
      .run(row.id);
    result.attempted += 1;
    try {
      if (row.state === "committed") {
        const checked = await inspectBackup(root, databaseName, row);
        if (!checked) { result.skipped += 1; continue; }
        const changed = database.prepare(`UPDATE ${TABLE} SET state='pruning'
          WHERE id=? AND state='committed' AND hold_reason=''`).run(row.id);
        if (changed.changes !== 1) { result.skipped += 1; continue; }
      }
      const directory = path.join(root, row.directory_name);
      const file = path.join(directory, row.file_name);
      let fileRemoved = Boolean(row.prune_file_removed);
      if (!fileRemoved) {
        const checked = await inspectBackup(root, databaseName, row);
        if (checked) {
          await beforeDelete?.({ target: file, directory, kind: "file" });
          // The helper compares the exact receipt ID on its open handle and
          // deletes that handle. No pathname unlink may follow this check.
          await deleteEntry(file, {
            dev: row.file_dev, ino: row.file_ino,
            size: row.size_bytes, directory: false,
          }, { testBarrier: handleTestBarrier });
          result.deleted += 1;
          result.bytes += checked.bytes;
        } else {
          const checkedDirectory = await inspectDirectory(root, row);
          if (!checkedDirectory || (await readdir(directory)).length !== 0) {
            result.errors += 1;
            continue;
          }
        }
        database.prepare(`UPDATE ${TABLE} SET prune_file_removed=1
          WHERE id=? AND state='pruning'`).run(row.id);
        fileRemoved = true;
      }
      if (!fileRemoved) { result.errors += 1; continue; }
      if (budgetExhausted()) { result.budgetExhausted = true; break; }
      const checkedDirectory = await inspectDirectory(root, row);
      if (checkedDirectory) {
        if ((await readdir(directory)).length !== 0) { result.errors += 1; continue; }
        await beforeDelete?.({ target: directory, directory, kind: "directory" });
        await deleteEntry(directory, {
          dev: row.directory_dev, ino: row.directory_ino,
          size: checkedDirectory.info.size, directory: true,
        });
      } else {
        const current = await lstat(directory).catch((error) => {
          if (error?.code === "ENOENT") return null;
          throw error;
        });
        if (current) { result.errors += 1; continue; }
      }
      database.prepare(`UPDATE ${TABLE} SET state='pruned' WHERE id=? AND state='pruning'`)
        .run(row.id);
    } catch (error) {
      // The journal update is already committed. A later invocation resumes the
      // exact pruning receipt; never report this as a failed account update.
      result.errors += 1;
      if (result.failureKinds.length < 8) result.failureKinds.push(pruneFailureKind(error));
    }
  }
  result.remaining = Number(database.prepare(`SELECT COUNT(*) AS count FROM ${TABLE}
    WHERE ${candidateWhere}`).get(...keepIds).count);
  return result;
}

export async function setWorkLogAccountBackupHold({ databaseFile, backupId, reason = "" }) {
  const resolvedDatabase = path.resolve(databaseFile);
  return withInterprocessLocks([resolvedDatabase], async () => {
    const database = new DatabaseSync(resolvedDatabase);
    try {
      ensureWorkLogAccountBackupReceipts(database);
      const row = database.prepare(`SELECT state FROM ${TABLE} WHERE id=?`).get(backupId);
      if (!row || row.state !== "committed") throw new Error("Backup is not eligible for hold change");
      database.prepare(`UPDATE ${TABLE} SET hold_reason=? WHERE id=? AND state='committed'`)
        .run(String(reason).trim(), backupId);
      return { backupId, held: Boolean(String(reason).trim()) };
    } finally {
      database.close();
    }
  });
}
