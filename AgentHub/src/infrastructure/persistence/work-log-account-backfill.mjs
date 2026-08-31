import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const LEDGER_VERSION = 9;

function migrationTimestamp(now) {
  return now.toISOString().replace(/[:.]/gu, "-");
}

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
} = {}) {
  if (!databaseFile) throw new Error("Work-log account backfill requires a SQLite database");
  const resolvedDatabase = path.resolve(String(databaseFile));
  try {
    const info = await stat(resolvedDatabase);
    if (!info.isFile()) return { applied: false, reason: "no-database" };
  } catch (error) {
    if (error?.code === "ENOENT") return { applied: false, reason: "no-database" };
    throw error;
  }

  const database = new DatabaseSync(resolvedDatabase);
  database.exec("PRAGMA busy_timeout = 10000");
  const observedAt = now.toISOString();
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
          json: JSON.stringify(next),
        });
      }
    }
    if (!updates.length) {
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
      };
    }

    const resolvedBackupRoot = path.resolve(
      backupRoot || path.join(path.dirname(resolvedDatabase), "migrations"),
    );
    const backupDirectory = path.join(
      resolvedBackupRoot,
      `work-log-account-${migrationTimestamp(now)}`,
    );
    await mkdir(backupDirectory, { recursive: true });
    database.prepare("VACUUM INTO ?").run(path.join(backupDirectory, path.basename(resolvedDatabase)));

    database.exec("BEGIN IMMEDIATE");
    let revision = null;
    try {
      const update = database.prepare(`
        UPDATE journal_records SET record_json = ?
        WHERE provider = ? AND thread_id = ? AND turn_id = ?
      `);
      for (const item of updates) update.run(item.json, item.provider, item.threadId, item.turnId);
      ensureJournalMeta(database);
      revision = advanceRevision(database);
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }

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
    };
  } finally {
    database.close();
  }
}
