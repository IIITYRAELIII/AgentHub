import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { RateLimitHistoryStore } from "./rate-limit-history.mjs";
import {
  DARK_ACCOUNT,
  FIRST_ACCOUNT_BOUNDARY,
  SECOND_ACCOUNT_BOUNDARY,
  SIDER_ACCOUNT,
  teamUsageAccountAt,
} from "../../domain/team-usage-accounts.mjs";

const MIGRATION_KEY = "team_rate_limit_account_backfill:2026-08-31-v5";

export { FIRST_ACCOUNT_BOUNDARY, SECOND_ACCOUNT_BOUNDARY };

function participantLogin(value) {
  const login = String(value ?? "").trim();
  if (!login || login.length > 100 || /[\r\n\0]/u.test(login)) {
    throw new Error("Team account backfill requires a valid participant login");
  }
  return login;
}

export function teamRateLimitAccountAt(value, observedMs) {
  return teamUsageAccountAt(participantLogin(value), observedMs);
}

function migrationTimestamp(now) {
  return now.toISOString().replace(/[:.]/gu, "-");
}

function tableExists(database, name) {
  return Boolean(database.prepare(`
    SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?
  `).get(name));
}

function storedMigration(database) {
  if (!tableExists(database, "rate_limit_store_meta")) return "";
  return String(database.prepare(`
    SELECT value FROM rate_limit_store_meta WHERE key = ?
  `).get(MIGRATION_KEY)?.value ?? "");
}

function accountRows(rowsJson, account) {
  let rows;
  try {
    rows = JSON.parse(rowsJson);
  } catch {
    rows = [];
  }
  if (!Array.isArray(rows)) rows = [];
  return JSON.stringify(rows.map((row) => ({
    ...row,
    accountKey: account.key,
    accountLabel: account.label,
    accountPlan: account.planType,
  })));
}

function upsertAccountEvent(statement, observedMs, account) {
  statement.run(
    observedMs,
    new Date(observedMs).toISOString(),
    account.key,
    account.label,
    account.type,
    account.planType,
  );
}

export async function applyTeamRateLimitAccountBackfill({
  databaseFile,
  participant,
  backupRoot = null,
  now = new Date(),
} = {}) {
  const login = participantLogin(participant);
  if (!databaseFile) throw new Error("Team account backfill requires a SQLite database");
  const resolvedDatabase = path.resolve(String(databaseFile));
  try {
    const info = await stat(resolvedDatabase);
    if (!info.isFile()) return { applied: false, reason: "no-database", participant: login };
  } catch (error) {
    if (error?.code === "ENOENT") return { applied: false, reason: "no-database", participant: login };
    throw error;
  }

  let database = new DatabaseSync(resolvedDatabase);
  database.exec("PRAGMA busy_timeout = 10000");
  const existing = storedMigration(database);
  if (existing) {
    database.close();
    if (existing.toLowerCase() !== login.toLowerCase()) {
      throw new Error(`Team account backfill already belongs to ${existing}`);
    }
    return { applied: false, reason: "already-applied", participant: login };
  }
  if (!tableExists(database, "rate_limit_snapshots")) {
    database.close();
    return { applied: false, reason: "no-history", participant: login };
  }
  const snapshotCount = Number(database.prepare(`
    SELECT COUNT(*) AS count FROM rate_limit_snapshots WHERE provider = 'codex'
  `).get()?.count ?? 0);
  if (!snapshotCount) {
    database.close();
    return { applied: false, reason: "no-history", participant: login };
  }

  const resolvedBackupRoot = path.resolve(
    backupRoot || path.join(path.dirname(resolvedDatabase), "migrations"),
  );
  const backupDirectory = path.join(
    resolvedBackupRoot,
    `account-history-${migrationTimestamp(now)}`,
  );
  await mkdir(backupDirectory, { recursive: true });
  const backupFile = path.join(backupDirectory, path.basename(resolvedDatabase));
  database.prepare("VACUUM INTO ?").run(backupFile);
  database.close();

  const store = new RateLimitHistoryStore({
    databaseFile: resolvedDatabase,
    rawFile: path.join(path.dirname(resolvedDatabase), "rate-limits-raw.jsonl"),
    csvFile: path.join(path.dirname(resolvedDatabase), "rate-limits.csv"),
  });
  try {
    await store.read({ range: "6h" });
  } finally {
    await store.close();
  }

  database = new DatabaseSync(resolvedDatabase);
  database.exec("PRAGMA busy_timeout = 10000");
  database.exec("BEGIN IMMEDIATE");
  try {
    const repeated = storedMigration(database);
    if (repeated) {
      if (repeated.toLowerCase() !== login.toLowerCase()) {
        throw new Error(`Team account backfill already belongs to ${repeated}`);
      }
      database.exec("ROLLBACK");
      database.close();
      database = null;
      return { applied: false, reason: "already-applied", participant: login, backupDirectory };
    }
    const snapshots = database.prepare(`
      SELECT id, observed_ms, rows_json
      FROM rate_limit_snapshots
      WHERE provider = 'codex'
      ORDER BY observed_ms, id
    `).all();
    const update = database.prepare(`
      UPDATE rate_limit_snapshots
      SET account_key = ?, account_label = ?, account_type = ?, account_plan = ?, rows_json = ?
      WHERE id = ?
    `);
    const counts = new Map();
    for (const snapshot of snapshots) {
      const account = teamRateLimitAccountAt(login, snapshot.observed_ms);
      update.run(
        account.key,
        account.label,
        account.type,
        account.planType,
        accountRows(snapshot.rows_json, account),
        snapshot.id,
      );
      counts.set(account.label, (counts.get(account.label) ?? 0) + 1);
    }
    const firstSnapshotMs = Number(database.prepare(`
      SELECT MIN(observed_ms) AS value
      FROM rate_limit_snapshots WHERE provider = 'codex'
    `).get()?.value);
    const firstTurnMs = tableExists(database, "journal_records")
      ? Number(database.prepare(`
        SELECT MIN(completed_at_ms) AS value FROM journal_records
        WHERE provider = 'codex' AND completed_at_ms IS NOT NULL
      `).get()?.value)
      : Number.NaN;
    const firstObservedMs = Math.min(
      ...[firstSnapshotMs, firstTurnMs].filter(Number.isFinite),
    );
    const upsertEvent = database.prepare(`
      INSERT INTO rate_limit_account_events
        (observed_ms, observed_at, account_key, account_label, account_type, account_plan, source)
      VALUES (?, ?, ?, ?, ?, ?, 'team-backfill')
      ON CONFLICT(observed_ms) DO UPDATE SET
        observed_at = excluded.observed_at,
        account_key = excluded.account_key,
        account_label = excluded.account_label,
        account_type = excluded.account_type,
        account_plan = excluded.account_plan,
        source = excluded.source
    `);
    if (Number.isFinite(firstObservedMs)) {
      upsertAccountEvent(upsertEvent, firstObservedMs, SIDER_ACCOUNT);
    }
    upsertAccountEvent(upsertEvent, Date.parse(FIRST_ACCOUNT_BOUNDARY), DARK_ACCOUNT);
    upsertAccountEvent(
      upsertEvent,
      Date.parse(SECOND_ACCOUNT_BOUNDARY),
      teamRateLimitAccountAt(login, Date.parse(SECOND_ACCOUNT_BOUNDARY)),
    );
    database.prepare(`
      INSERT INTO rate_limit_store_meta (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(MIGRATION_KEY, login);
    database.exec("COMMIT");
    return {
      applied: true,
      participant: login,
      backupDirectory,
      snapshots: snapshots.length,
      counts: Object.fromEntries(counts),
      boundaries: [FIRST_ACCOUNT_BOUNDARY, SECOND_ACCOUNT_BOUNDARY],
    };
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  } finally {
    database?.close();
  }
}
