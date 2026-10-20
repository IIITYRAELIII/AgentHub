import { lstat } from "node:fs/promises";
import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { withInterprocessLocks } from "../process/interprocess-lock.mjs";
import {
  commitWorkLogAccountBackup,
  ensureWorkLogAccountBackupReceipts,
  failWorkLogAccountBackup,
  pruneWorkLogAccountBackups,
  startWorkLogAccountBackup,
} from "./work-log-account-backup-retention.mjs";

const LEDGER_VERSION = 9;

function tableExists(database, name) {
  return Boolean(database.prepare(`
    SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?
  `).get(name));
}

function normalizeAccountAttribution(value, hasAccountKey) {
  const candidate = String(value ?? "").trim().toLowerCase();
  if (candidate === "exact" || candidate === "inferred") return candidate;
  return hasAccountKey ? "exact" : "inferred";
}

function normalizeRecordAccountFields(record) {
  const accountKey = String(record?.accountKey ?? "").trim();
  return {
    accountKey,
    accountAttribution: normalizeAccountAttribution(record?.accountAttribution, Boolean(accountKey)),
  };
}

function accountFromTimeline(row) {
  const key = String(row?.account_key ?? "").trim();
  if (!key) return null;
  return {
    key,
    label: String(row?.account_label ?? "").trim(),
    type: String(row?.account_type ?? "").trim(),
    planType: String(row?.account_plan ?? "").trim(),
  };
}

function readAccountTimeline(database) {
  const events = [];
  if (tableExists(database, "rate_limit_snapshots")) {
    for (const row of database.prepare(`
      SELECT observed_ms, account_key, account_label, account_type, account_plan,
        0 AS priority, id AS stable_order
      FROM rate_limit_snapshots
      WHERE provider = 'codex' AND account_key <> ''
    `).all()) {
      events.push({
        atMs: Number(row.observed_ms),
        priority: Number(row.priority),
        stableOrder: Number(row.stable_order),
        account: accountFromTimeline(row),
      });
    }
  }
  if (tableExists(database, "rate_limit_account_events")) {
    for (const row of database.prepare(`
      SELECT observed_ms, account_key, account_label, account_type, account_plan,
        1 AS priority, observed_ms AS stable_order
      FROM rate_limit_account_events
      WHERE account_key <> ''
    `).all()) {
      events.push({
        atMs: Number(row.observed_ms),
        priority: Number(row.priority),
        stableOrder: Number(row.stable_order),
        account: accountFromTimeline(row),
      });
    }
  }
  return events
    .filter((event) => Number.isFinite(event.atMs) && event.account)
    .sort((left, right) => (
      left.atMs - right.atMs
      || left.priority - right.priority
      || left.stableOrder - right.stableOrder
    ));
}

function accountAt(timeline, timestampMs) {
  if (!Number.isFinite(timestampMs) || !timeline.length) return null;
  let active = null;
  for (const event of timeline) {
    if (event.atMs > timestampMs) break;
    active = event.account;
  }
  return active;
}

function accountByProvider(accounts = []) {
  const byProvider = new Map();
  for (const account of Array.isArray(accounts) ? accounts : []) {
    const provider = String(account?.provider ?? "").trim().toLowerCase();
    const key = String(account?.key ?? account?.accountKey ?? "").trim();
    if (!provider || !key) continue;
    byProvider.set(provider, {
      key,
      label: String(account?.label ?? account?.accountLabel ?? "").trim(),
      type: String(account?.type ?? account?.accountType ?? "").trim(),
      planType: String(account?.planType ?? account?.accountPlan ?? "").trim(),
    });
  }
  return byProvider;
}

function applyAccountToRecord(record, account, attribution = "inferred") {
  if (!account?.key) return record;
  return {
    ...record,
    accountKey: account.key,
    accountLabel: account.label,
    accountType: account.type,
    accountPlan: account.planType,
    accountAttribution: attribution,
  };
}

function updatedRecord(record, provider, completedAtMs, timeline, providerAccounts) {
  const next = { ...record, ...normalizeRecordAccountFields(record) };
  if (next.accountKey && next.accountAttribution === "exact") return next;
  const providerAccount = providerAccounts.get(provider);
  if (provider !== "codex") {
    return providerAccount ? applyAccountToRecord(next, providerAccount) : next;
  }
  if (next.accountKey && next.accountAttribution === "exact") return next;
  const account = accountAt(timeline, completedAtMs);
  if (account?.key) return applyAccountToRecord(next, account);
  return providerAccount ? applyAccountToRecord(next, providerAccount) : next;
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function accountChanged(left, right) {
  return [
    "accountKey",
    "accountLabel",
    "accountType",
    "accountPlan",
    "accountAttribution",
  ].some((field) => String(left?.[field] ?? "").trim() !== String(right?.[field] ?? "").trim());
}

function ensureJournalMeta(database) {
  if (!tableExists(database, "journal_store_meta")) return;
  database.prepare(`
    INSERT OR IGNORE INTO journal_store_meta (key, value) VALUES ('revision', '0')
  `).run();
  database.prepare(`
    INSERT INTO journal_store_meta (key, value) VALUES ('ledger_version', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(String(LEDGER_VERSION));
}

function advanceRevision(database) {
  if (!tableExists(database, "journal_store_meta")) return null;
  database.prepare(`
    UPDATE journal_store_meta SET value = CAST(value AS INTEGER) + 1 WHERE key = 'revision'
  `).run();
  return Number(database.prepare(`
    SELECT value FROM journal_store_meta WHERE key = 'revision'
  `).get()?.value ?? 0) || 0;
}

export async function applyWorkLogAccountBackfill({
  databaseFile,
  backupRoot = null,
  providerAccounts = [],
  now = new Date(),
  trace = null,
  traceCommandId = null,
  retentionDeleteEntry,
  retentionBeforeDelete,
  retentionHandleTestBarrier,
  retentionPruneClock,
} = {}) {
  if (!databaseFile) throw new Error("Work-log account backfill requires a SQLite database");
  const resolvedDatabase = path.resolve(String(databaseFile));
  try {
    const info = await lstat(resolvedDatabase);
    if (!info.isFile()) return { applied: false, reason: "no-database" };
  } catch (error) {
    if (error?.code === "ENOENT") return { applied: false, reason: "no-database" };
    throw error;
  }

  const operationId = traceCommandId || `work-log-account-backfill:${randomUUID()}`;
  let lockWaitMs = 0;
  let lockAcquired = false;
  const lockStarted = performance.now();
  return withInterprocessLocks([resolvedDatabase], async (lease) => {
  const database = new DatabaseSync(resolvedDatabase);
  database.exec("PRAGMA busy_timeout = 10000");
  const observedAt = now.toISOString();
  const resolvedBackupRoot = path.resolve(
    backupRoot || path.join(path.dirname(resolvedDatabase), "migrations"),
  );
  const timing = { lockWaitMs, backupMs: 0, pruneMs: 0, prunedBytes: 0, prunedCount: 0, pruneErrors: 0 };
  const report = (stage, started, outcome, metadata = {}) => {
    try {
      trace?.recordBestEffort?.({
        commandId: operationId, stage, transport: "local", outcome, lockWaitMs,
        monotonicDurationMs: Math.max(0, performance.now() - started),
        metadata,
      });
    } catch {
      // Telemetry is not an account-update authority.
    }
  };
  try {
    if (!tableExists(database, "journal_records")) {
      return { applied: false, reason: "no-journal-records" };
    }
    const timeline = readAccountTimeline(database);
    const providers = accountByProvider(providerAccounts);
    const rows = database.prepare(`
      SELECT provider, thread_id, turn_id, completed_at_ms, record_json
      FROM journal_records
      ORDER BY provider, thread_id, turn_id
    `).all();
    const updates = [];
    let codexRecords = 0;
    let exactPreserved = 0;
    let inferredAssigned = 0;
    let withoutAccount = 0;
    let invalid = 0;
    for (const row of rows) {
      let record;
      try {
        record = JSON.parse(row.record_json);
      } catch {
        invalid += 1;
        continue;
      }
      const provider = String(record?.provider ?? row.provider ?? "").trim().toLowerCase();
      if (provider === "codex") codexRecords += 1;
      const before = normalizeRecordAccountFields(record);
      if (provider === "codex" && before.accountKey && before.accountAttribution === "exact") {
        exactPreserved += 1;
      }
      let next = updatedRecord(record, provider, Number(row.completed_at_ms), timeline, providers);
      if (accountChanged(record, next)) {
        next = { ...next, observedAt };
      }
      if (next.accountKey && next.accountAttribution === "inferred"
        && next.accountKey !== before.accountKey) {
        inferredAssigned += 1;
      }
      if (provider === "codex" && !next.accountKey) withoutAccount += 1;
      if (!sameJson(record, next)) {
        updates.push({
          provider: row.provider,
          threadId: row.thread_id,
          turnId: row.turn_id,
          originalJson: row.record_json,
          json: JSON.stringify(next),
        });
      }
    }
    ensureWorkLogAccountBackupReceipts(database);
    const prune = async () => {
      const started = performance.now();
      try {
        await lease.assertOwned();
        const result = await pruneWorkLogAccountBackups(database, {
          root: resolvedBackupRoot,
          databaseName: path.basename(resolvedDatabase),
          deleteEntry: retentionDeleteEntry,
          beforeDelete: retentionBeforeDelete,
          handleTestBarrier: retentionHandleTestBarrier,
          clock: retentionPruneClock,
        });
        timing.pruneMs = performance.now() - started;
        timing.prunedBytes = result.bytes;
        timing.prunedCount = result.deleted;
        timing.pruneErrors = result.errors;
        report("work-log-account-backup-prune", started,
          result.errors ? "failed" : "succeeded",
          { deleted: result.deleted, skipped: result.skipped, errors: result.errors,
            bytes: result.bytes, attempted: result.attempted, remaining: result.remaining,
            budgetExhausted: result.budgetExhausted, failureKinds: result.failureKinds });
        return result;
      } catch {
        timing.pruneMs = performance.now() - started;
        timing.pruneErrors += 1;
        report("work-log-account-backup-prune", started, "failed");
        return { deleted: 0, bytes: 0, errors: 1, skipped: 0 };
      }
    };
    if (!updates.length) {
      const retention = await prune();
      return {
        applied: false,
        reason: "unchanged",
        records: rows.length,
        codexRecords,
        exactPreserved,
        inferredAssigned,
        withoutAccount,
        invalid,
        timelineEvents: timeline.length,
        retention,
        timing,
      };
    }

    const backup = startWorkLogAccountBackup(database, {
      now, fileName: path.basename(resolvedDatabase),
    });
    const backupDirectory = path.join(resolvedBackupRoot, backup.directoryName);
    const backupStarted = performance.now();
    let backupInfo;
    let backupDirectoryInfo;
    try {
      await lease.assertOwned();
      // Keep the final containment check, private-directory creation and
      // VACUUM launch in one synchronous boundary. An async lease check between
      // validation and the path-consuming SQLite call allowed a swap.
      mkdirSync(resolvedBackupRoot, { recursive: true });
      const rootInfo = lstatSync(resolvedBackupRoot);
      if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
        throw new Error("Account backup root is not a regular directory");
      }
      mkdirSync(backupDirectory, { recursive: false, mode: 0o700 });
      const privateInfo = lstatSync(backupDirectory);
      const canonicalRoot = realpathSync(resolvedBackupRoot);
      const canonicalDirectory = realpathSync(backupDirectory);
      if (!privateInfo.isDirectory() || privateInfo.isSymbolicLink()
          || path.dirname(canonicalDirectory).toLowerCase() !== canonicalRoot.toLowerCase()) {
        throw new Error("Account backup directory escaped its root");
      }
      const backupFile = path.join(canonicalDirectory, backup.fileName);
      database.prepare("VACUUM INTO ?").run(backupFile);
      backupInfo = lstatSync(backupFile, { bigint: true });
      backupDirectoryInfo = lstatSync(backupDirectory, { bigint: true });
      if (!backupInfo.isFile() || backupInfo.isSymbolicLink() || backupInfo.nlink !== 1n
          || backupInfo.size === 0n || backupInfo.size > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new Error("Account backup did not produce a regular non-empty file");
      }
      if (!backupDirectoryInfo.isDirectory() || backupDirectoryInfo.isSymbolicLink()) {
        throw new Error("Account backup directory changed before receipt");
      }
      timing.backupMs = performance.now() - backupStarted;
      report("work-log-account-backup", backupStarted, "succeeded",
        { bytes: Number(backupInfo.size) });
    } catch (error) {
      timing.backupMs = performance.now() - backupStarted;
      report("work-log-account-backup", backupStarted, "failed");
      try { failWorkLogAccountBackup(database, backup, "backup"); } catch {}
      // A failed receipt and any partial file are held for inspection. A crash
      // before this update leaves the original pending receipt.
      throw error;
    }

    await lease.assertOwned();
    const transactionStarted = performance.now();
    database.exec("BEGIN IMMEDIATE");
    let revision = null;
    try {
      const update = database.prepare(`
        UPDATE journal_records SET record_json = ?
        WHERE provider = ? AND thread_id = ? AND turn_id = ? AND record_json = ?
      `);
      for (const item of updates) {
        const changed = update.run(item.json, item.provider, item.threadId, item.turnId, item.originalJson);
        if (changed.changes !== 1) throw new Error("Account backfill source changed during backup");
      }
      ensureJournalMeta(database);
      revision = advanceRevision(database);
      commitWorkLogAccountBackup(database, backup, backupInfo, backupDirectoryInfo, now);
      database.exec("COMMIT");
      report("work-log-account-backfill-commit", transactionStarted, "succeeded",
        { updated: updates.length });
    } catch (error) {
      database.exec("ROLLBACK");
      try { failWorkLogAccountBackup(database, backup, "transaction"); } catch {}
      report("work-log-account-backfill-commit", transactionStarted, "failed");
      throw error;
    }

    const retention = await prune();
    return {
      applied: true,
      backupDirectory,
      records: rows.length,
      updated: updates.length,
      codexRecords,
      exactPreserved,
      inferredAssigned,
      withoutAccount,
      invalid,
      timelineEvents: timeline.length,
      revision,
      retention,
      timing,
    };
  } finally {
    database.close();
  }
  }, {
    timeoutMs: 600_000,
    onAcquired: (details) => {
      lockAcquired = true;
      lockWaitMs = details.waitMs;
    },
  }).catch((error) => {
    if (!lockAcquired) {
      try {
        trace?.recordBestEffort?.({
          commandId: operationId, stage: "work-log-account-backup-lock",
          transport: "local", outcome: "failed",
          monotonicDurationMs: Math.max(0, performance.now() - lockStarted),
        });
      } catch {
        // Trace failure must not replace the original lock refusal.
      }
    }
    throw error;
  });
}
