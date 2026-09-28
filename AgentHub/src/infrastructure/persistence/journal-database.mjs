import crypto from "node:crypto";
import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  buildVirtualJournalProjection,
  compactVirtualJournalHtml,
  profileCohortVirtualJournalSummary,
  virtualJournalDaySections,
} from "../../domain/journal-virtual-projection.mjs";
import { usageTurnFactId } from "../../domain/usage-facts.mjs";
import { applyLedgerDelta } from "./incremental-ledger.mjs";
import { readJsonWithBackup } from "./state-store.mjs";

const SCHEMA_VERSION = 3;
const LEDGER_VERSION = 9;
const LEGACY_IMPORT_KEY = "work-log-usage-v1";
const ACCOUNT_USAGE_PROJECTION_VERSION_KEY = "account_usage_projection_version";
const JOURNAL_DAY_ORDER = "substr(date, 7, 4), substr(date, 4, 2), substr(date, 1, 2)";

function configure(database) {
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA busy_timeout = 0;
  `);
  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec(`
    CREATE TABLE IF NOT EXISTS journal_meta (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      schema_version INTEGER NOT NULL,
      source_version TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      html TEXT NOT NULL,
      summary_json TEXT NOT NULL DEFAULT '{"version":1,"buckets":[]}'
    );
    CREATE TABLE IF NOT EXISTS journal_days (
      date TEXT PRIMARY KEY,
      html TEXT NOT NULL
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS journal_turns (
      id TEXT PRIMARY KEY,
      html TEXT NOT NULL
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS journal_turn_index (
      turn_ref TEXT PRIMARY KEY,
      date TEXT NOT NULL,
      day_ms INTEGER NOT NULL,
      workspace_id TEXT NOT NULL,
      stream_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      completed_at_ms INTEGER NOT NULL,
      html TEXT NOT NULL
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS journal_turn_index_scope_idx
      ON journal_turn_index(workspace_id, stream_id, completed_at_ms DESC, turn_ref);
    CREATE INDEX IF NOT EXISTS journal_turn_index_workspace_idx
      ON journal_turn_index(workspace_id, completed_at_ms DESC, turn_ref);
    CREATE INDEX IF NOT EXISTS journal_turn_index_provider_idx
      ON journal_turn_index(provider, completed_at_ms DESC, turn_ref);
    CREATE TABLE IF NOT EXISTS journal_records (
      provider TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      project_root TEXT NOT NULL,
      task_thread_id TEXT NOT NULL,
      completed_at_ms INTEGER,
      observed_at_ms INTEGER,
      changed_revision INTEGER NOT NULL DEFAULT 0,
      record_json TEXT NOT NULL,
      PRIMARY KEY (provider, thread_id, turn_id)
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS journal_records_project_idx
      ON journal_records(project_root, completed_at_ms DESC);
    CREATE INDEX IF NOT EXISTS journal_records_task_idx
      ON journal_records(provider, task_thread_id, completed_at_ms DESC);
    CREATE TABLE IF NOT EXISTS journal_store_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS journal_imports (
      key TEXT PRIMARY KEY,
      imported_at TEXT NOT NULL,
      source TEXT,
      record_count INTEGER NOT NULL,
      details_json TEXT NOT NULL
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS journal_import_records (
      import_key TEXT NOT NULL,
      provider TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      record_hash TEXT NOT NULL,
      PRIMARY KEY (import_key, provider, thread_id, turn_id)
    ) WITHOUT ROWID;
    INSERT OR IGNORE INTO journal_store_meta (key, value) VALUES ('revision', '0');
    INSERT OR IGNORE INTO journal_store_meta (key, value) VALUES ('ledger_version', '9');
    INSERT OR IGNORE INTO journal_store_meta (key, value)
      VALUES ('account_usage_projection_version', '');
    `);
    const journalMetaColumns = new Set(database.prepare("PRAGMA table_info(journal_meta)")
      .all().map((row) => row.name));
    const missingVirtualProjectionColumn = !journalMetaColumns.has("summary_json");
    if (missingVirtualProjectionColumn) {
      database.exec(`
        ALTER TABLE journal_meta
        ADD COLUMN summary_json TEXT NOT NULL DEFAULT '{"version":1,"buckets":[]}'
      `);
    }
    const virtualProjectionMigration = missingVirtualProjectionColumn
      || Number(database.prepare("SELECT schema_version FROM journal_meta WHERE id = 1")
        .get()?.schema_version ?? SCHEMA_VERSION) < SCHEMA_VERSION;
    const journalRecordColumns = new Set(database.prepare("PRAGMA table_info(journal_records)")
      .all().map((row) => row.name));
    if (!journalRecordColumns.has("observed_at_ms")) {
      database.exec("ALTER TABLE journal_records ADD COLUMN observed_at_ms INTEGER");
    }
    if (!journalRecordColumns.has("changed_revision")) {
      database.exec("ALTER TABLE journal_records ADD COLUMN changed_revision INTEGER NOT NULL DEFAULT 0");
      const migrationRevision = Math.max(1, Number(database.prepare(
        "SELECT value FROM journal_store_meta WHERE key = 'revision'",
      ).get()?.value) || 0);
      database.prepare("UPDATE journal_records SET changed_revision = ?").run(migrationRevision);
      database.prepare("UPDATE journal_store_meta SET value = ? WHERE key = 'revision'")
        .run(String(migrationRevision));
    }
    database.exec(`
      UPDATE journal_records
      SET observed_at_ms = completed_at_ms
      WHERE observed_at_ms IS NULL;
      CREATE INDEX IF NOT EXISTS journal_records_observed_idx
        ON journal_records(observed_at_ms, provider, thread_id, turn_id);
      CREATE INDEX IF NOT EXISTS journal_records_changed_idx
        ON journal_records(changed_revision, provider, thread_id, turn_id);
    `);
    if (virtualProjectionMigration) migrateStoredVirtualProjection(database);
    database.exec(`
      CREATE TABLE IF NOT EXISTS journal_projection_dirty (
        completed_at_ms INTEGER PRIMARY KEY
      );
      CREATE INDEX IF NOT EXISTS journal_records_completed_idx ON journal_records(completed_at_ms);
      CREATE TRIGGER IF NOT EXISTS journal_projection_insert AFTER INSERT ON journal_records BEGIN
        INSERT INTO journal_projection_dirty VALUES (COALESCE(NEW.completed_at_ms, -9007199254740991)) ON CONFLICT DO NOTHING;
      END;
      CREATE TRIGGER IF NOT EXISTS journal_projection_update AFTER UPDATE ON journal_records BEGIN
        INSERT INTO journal_projection_dirty VALUES (COALESCE(OLD.completed_at_ms, -9007199254740991)) ON CONFLICT DO NOTHING;
        INSERT INTO journal_projection_dirty VALUES (COALESCE(NEW.completed_at_ms, -9007199254740991)) ON CONFLICT DO NOTHING;
      END;
      CREATE TRIGGER IF NOT EXISTS journal_projection_delete AFTER DELETE ON journal_records BEGIN
        INSERT INTO journal_projection_dirty VALUES (COALESCE(OLD.completed_at_ms, -9007199254740991)) ON CONFLICT DO NOTHING;
      END;
    `);
    database.exec("COMMIT");
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // Preserve the migration failure when SQLite already rolled back the transaction.
    }
    throw error;
  }
}

function tableExists(database, name) {
  return Boolean(database.prepare(`
    SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?
  `).get(name));
}

function publicIndex(row, revision = 0) {
  if (!row) return null;
  let summary = { version: 1, buckets: [] };
  try {
    const parsed = JSON.parse(String(row.summary_json ?? ""));
    if (parsed && typeof parsed === "object" && Array.isArray(parsed.buckets)) summary = parsed;
  } catch {
    // A damaged optional projection cannot make the durable journal unreadable.
  }
  return {
    html: String(row.html ?? ""),
    summary,
    updatedAt: String(row.updated_at ?? ""),
    version: String(row.source_version ?? ""),
    revision: Number(revision) || 0,
  };
}

function sha256Version(value) {
  return `sha256:${crypto.createHash("sha256").update(String(value), "utf8").digest("hex")}`;
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value), "utf8").digest("hex");
}

async function legacyFilesIdentity(target) {
  const values = [];
  for (const candidate of [target, `${target}.bak`, `${target}.delta.jsonl`]) {
    try {
      const info = await stat(candidate);
      values.push([
        path.basename(candidate),
        info.dev,
        info.ino,
        info.size,
        info.mtimeMs,
        info.ctimeMs,
      ].join(":"));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      values.push(`${path.basename(candidate)}:missing`);
    }
  }
  return values.join("|");
}

function ledgerKey({ provider, threadId, turnId }) {
  return `${provider}\0${threadId}\0${turnId}`;
}

function normalizedIdentity(record, key = "", { legacyFallback = false } = {}) {
  const keyParts = String(key).split("\0");
  const provider = String(record?.provider ?? (keyParts.length >= 3 ? keyParts[0] : "codex"))
    .trim().toLowerCase();
  const turnId = String(
    record?.turnId ?? (keyParts.length >= 3 ? keyParts[2] : legacyFallback ? key : ""),
  ).trim();
  let threadId = String(record?.threadId ?? (keyParts.length >= 3 ? keyParts[1] : "")).trim();
  if (!threadId && legacyFallback && turnId) {
    threadId = `legacy:${String(record?.workLogId ?? turnId).trim() || turnId}`;
  }
  if (!provider || !threadId || !turnId || provider.includes("\0")
    || threadId.includes("\0") || turnId.includes("\0")) {
    return null;
  }
  return { provider, threadId, turnId };
}

function normalizedRecord(record, key = "", options = {}) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return null;
  const identity = normalizedIdentity(record, key, options);
  if (!identity) return null;
  return {
    ...record,
    ...identity,
    projectRoot: String(record.projectRoot ?? "").trim(),
    taskThreadId: String(record.taskThreadId ?? identity.threadId).trim() || identity.threadId,
  };
}

function recordRow(record, key = "", options = {}) {
  const normalized = normalizedRecord(record, key, options);
  if (!normalized) return null;
  const completedAtMs = Date.parse(normalized.completedAt || normalized.startedAt || "");
  const observedAtMs = Date.parse(normalized.observedAt || normalized.completedAt || normalized.startedAt || "");
  return {
    record: normalized,
    provider: normalized.provider,
    threadId: normalized.threadId,
    turnId: normalized.turnId,
    projectRoot: normalized.projectRoot,
    taskThreadId: normalized.taskThreadId,
    completedAtMs: Number.isFinite(completedAtMs) ? completedAtMs : null,
    observedAtMs: Number.isFinite(observedAtMs) ? observedAtMs : null,
    json: JSON.stringify(normalized),
  };
}

function revisionOf(database) {
  return Number(database.prepare(
    "SELECT value FROM journal_store_meta WHERE key = 'revision'",
  ).get()?.value ?? 0) || 0;
}

function advanceRevision(database) {
  database.prepare(`
    UPDATE journal_store_meta SET value = CAST(value AS INTEGER) + 1 WHERE key = 'revision'
  `).run();
  return revisionOf(database);
}

function storeMetadataValue(database, key) {
  return String(database.prepare(
    "SELECT value FROM journal_store_meta WHERE key = ?",
  ).get(key)?.value ?? "");
}

function writeStoreMetadataValue(database, key, value) {
  database.prepare(`
    INSERT INTO journal_store_meta (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, String(value ?? ""));
}

function projectionVersion(payload) {
  return sha256Version(JSON.stringify({
    html: payload.html,
    days: payload.days,
    turns: payload.turns,
    summary: payload.summary,
    entries: payload.entries,
    virtualDates: payload.virtualDates,
    virtualComplete: payload.virtualComplete,
  }));
}

function upsertVirtualEntries(database, entries) {
  const insertTurnIndex = database.prepare(`
    INSERT INTO journal_turn_index
      (turn_ref, date, day_ms, workspace_id, stream_id, provider, thread_id, turn_id,
       completed_at_ms, html)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(turn_ref) DO UPDATE SET
      date = excluded.date,
      day_ms = excluded.day_ms,
      workspace_id = excluded.workspace_id,
      stream_id = excluded.stream_id,
      provider = excluded.provider,
      thread_id = excluded.thread_id,
      turn_id = excluded.turn_id,
      completed_at_ms = excluded.completed_at_ms,
      html = excluded.html
  `);
  for (const entry of Array.isArray(entries) ? entries : []) {
    const turnRef = String(entry?.turnRef ?? "").trim().slice(0, 1024);
    const workspaceId = String(entry?.workspaceId ?? "").trim().slice(0, 256);
    const streamId = String(entry?.streamId ?? "").trim().slice(0, 256);
    const provider = String(entry?.provider ?? "").trim().slice(0, 32);
    const threadId = String(entry?.threadId ?? "").trim().slice(0, 256);
    const turnId = String(entry?.turnId ?? "").trim().slice(0, 256);
    if (!turnRef || !workspaceId || !streamId || !provider || !threadId || !turnId) continue;
    insertTurnIndex.run(
      turnRef,
      String(entry.date ?? "").trim().slice(0, 10),
      Math.max(0, Number(entry.dayMs) || 0),
      workspaceId,
      streamId,
      provider,
      threadId,
      turnId,
      Math.max(0, Number(entry.completedAtMs) || 0),
      String(entry.html ?? ""),
    );
  }
}

function migrateStoredVirtualProjection(database) {
  const meta = database.prepare(
    "SELECT html, source_version FROM journal_meta WHERE id = 1",
  ).get();
  if (!meta) return;
  const storedDays = new Map(database.prepare("SELECT date, html FROM journal_days")
    .all().map((row) => [String(row.date), String(row.html)]));
  const sections = [];
  const seenDates = new Set();
  for (const section of virtualJournalDaySections(meta.html)) {
    const html = /<div\b[^>]*data-work-log-row/iu.test(section.html)
      ? section.html
      : storedDays.get(section.date);
    if (!html) throw new Error(`Stored journal day cannot be migrated: ${section.date}`);
    sections.push({ ...section, html });
    seenDates.add(section.date);
  }
  for (const [date, html] of storedDays) {
    if (!seenDates.has(date)) sections.push({ date, html });
  }
  const virtual = buildVirtualJournalProjection(sections);
  const compactHtml = compactVirtualJournalHtml(meta.html);
  const migratedVersion = sha256Version(JSON.stringify({
    sourceVersion: String(meta.source_version ?? ""),
    virtualProjectionVersion: 1,
  }));
  database.exec("DELETE FROM journal_turn_index;");
  upsertVirtualEntries(database, virtual.entries);
  database.prepare(`
    UPDATE journal_meta
    SET schema_version = ?, source_version = ?, html = ?, summary_json = ?
    WHERE id = 1
  `).run(SCHEMA_VERSION, migratedVersion, compactHtml, JSON.stringify(virtual.summary));
}

function writeProjection(database, payload, {
  updatedAt = new Date().toISOString(),
  version = "",
  accountUsageProjectionVersion = null,
} = {}) {
  const html = String(payload.html ?? "");
  const days = payload.days ?? {};
  const turns = payload.turns ?? {};
  let summary = payload.summary && typeof payload.summary === "object"
    ? payload.summary
    : { version: 1, buckets: [] };
  const entries = Array.isArray(payload.entries) ? payload.entries : [];
  const virtualDates = [...new Set((Array.isArray(payload.virtualDates)
    ? payload.virtualDates
    : []).map((date) => String(date ?? "").trim().slice(0, 10)).filter(Boolean))];
  const virtualComplete = payload.virtualComplete !== false;
  if (!virtualComplete) {
    let currentSummary = { version: 1, buckets: [] };
    try {
      const parsed = JSON.parse(String(database.prepare(
        "SELECT summary_json FROM journal_meta WHERE id = 1",
      ).get()?.summary_json ?? ""));
      if (parsed && typeof parsed === "object" && Array.isArray(parsed.buckets)) {
        currentSummary = parsed;
      }
    } catch {
      // Corrupt optional totals are replaced only for exact dates present in this projection.
    }
    const replacedDates = new Set(virtualDates);
    summary = {
      version: 1,
      buckets: [
        ...currentSummary.buckets.filter((bucket) => !replacedDates.has(String(bucket?.date ?? ""))),
        ...(Array.isArray(summary.buckets) ? summary.buckets : []),
      ].sort((left, right) => right.dayMs - left.dayMs),
    };
  }
  /* Ленивая оболочка не несёт содержимого: фрагмент дня уже лежит в базе.
     Если проекция пришла без замены для такого дня, стирать его нельзя —
     иначе день откроется пустым и клиент зациклится на его догрузке. */
  const preserved = new Set(
    [...html.matchAll(/data-lazy-day="([^"]+)"/giu)]
      .map((match) => match[1])
      .filter((date) => !Object.hasOwn(days, date)),
  );
  if (preserved.size) {
    const keep = [...preserved].map(() => "?").join(", ");
    database.prepare(`DELETE FROM journal_days WHERE date NOT IN (${keep})`).run(...preserved);
    const dropTurn = database.prepare("DELETE FROM journal_turns WHERE id = ?");
    for (const id of Object.keys(turns)) dropTurn.run(id);
  } else {
    database.exec("DELETE FROM journal_days; DELETE FROM journal_turns;");
  }
  if (virtualComplete) {
    database.exec("DELETE FROM journal_turn_index;");
  } else if (virtualDates.length) {
    const placeholders = virtualDates.map(() => "?").join(", ");
    // Removed or moved turns must not retain stale lazy bodies after a partial
    // day replacement. Other dates' bodies remain byte-for-byte unchanged.
    database.prepare(`DELETE FROM journal_turns WHERE id IN (
      SELECT turn_ref FROM journal_turn_index WHERE date IN (${placeholders}))`)
      .run(...virtualDates);
    database.prepare(`DELETE FROM journal_turn_index WHERE date IN (${placeholders})`)
      .run(...virtualDates);
  }
  const insertDay = database.prepare(
    "INSERT INTO journal_days (date, html) VALUES (?, ?) ON CONFLICT(date) DO UPDATE SET html = excluded.html",
  );
  for (const [date, dayHtml] of Object.entries(days)) insertDay.run(date, dayHtml);
  const insertTurn = database.prepare("INSERT INTO journal_turns (id, html) VALUES (?, ?)");
  for (const [id, turnHtml] of Object.entries(turns)) insertTurn.run(id, turnHtml);
  upsertVirtualEntries(database, entries);
  const resolvedVersion = String(version || projectionVersion(payload));
  database.prepare(`
    INSERT INTO journal_meta (id, schema_version, source_version, updated_at, html, summary_json)
    VALUES (1, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      schema_version = excluded.schema_version,
      source_version = excluded.source_version,
      updated_at = excluded.updated_at,
      html = excluded.html,
      summary_json = excluded.summary_json
  `).run(
    SCHEMA_VERSION,
    resolvedVersion,
    String(updatedAt),
    String(payload.html ?? ""),
    JSON.stringify(summary),
  );
  if (accountUsageProjectionVersion != null) {
    writeStoreMetadataValue(
      database,
      ACCOUNT_USAGE_PROJECTION_VERSION_KEY,
      accountUsageProjectionVersion,
    );
  }
  return resolvedVersion;
}

function insertRecordStatement(database) {
  return database.prepare(`
    INSERT INTO journal_records
      (provider, thread_id, turn_id, project_root, task_thread_id, completed_at_ms, observed_at_ms,
       changed_revision, record_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(provider, thread_id, turn_id) DO UPDATE SET
      project_root = excluded.project_root,
      task_thread_id = excluded.task_thread_id,
      completed_at_ms = excluded.completed_at_ms,
      observed_at_ms = excluded.observed_at_ms,
      changed_revision = excluded.changed_revision,
      record_json = excluded.record_json
  `);
}

function insertRow(statement, row, changedRevision) {
  statement.run(
    row.provider,
    row.threadId,
    row.turnId,
    row.projectRoot,
    row.taskThreadId,
    row.completedAtMs,
    row.observedAtMs,
    changedRevision,
    row.json,
  );
}

async function readStableLegacyLedger(target) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const beforeIdentity = await legacyFilesIdentity(target);
    const loaded = await readJsonWithBackup(target, { backupFile: `${target}.bak` });
    const delta = await applyLedgerDelta(loaded.value ?? {}, `${target}.delta.jsonl`);
    const afterIdentity = await legacyFilesIdentity(target);
    if (beforeIdentity !== afterIdentity) continue;
    if (!loaded.value && !delta.applied) {
      return {
        missing: true,
        sourceIdentity: afterIdentity,
        loaded,
        delta,
        rows: [],
        skipped: 0,
        fingerprint: "",
      };
    }
    const entries = Object.entries(delta.value?.turns ?? {})
      .map(([key, record]) => [key, recordRow(record, key, { legacyFallback: true })])
      .filter(([, row]) => Boolean(row))
      .sort(([left], [right]) => left.localeCompare(right));
    const rows = entries.map(([, row]) => row);
    const skipped = Object.keys(delta.value?.turns ?? {}).length - rows.length;
    const fingerprint = sha256(entries.map(([key, row]) => `${key}\n${row.json}`).join("\n"));
    return {
      missing: false,
      sourceIdentity: afterIdentity,
      loaded,
      delta,
      rows,
      skipped,
      fingerprint,
    };
  }
  throw new Error(`Legacy journal changed repeatedly while importing: ${target}`);
}

export class JournalDatabase {
  #database = null;
  #projectionAccounting = new Map();
  #projectionAccountingScope = null;
  #file;
  #opening = null;
  #listeners = new Set();
  #subscribers = new Set();
  #subscriptionTimer = null;
  #observedRevision = null;
  #pollingRevision = false;
  #turnPageSnapshotHook;

  constructor(file, { turnPageSnapshotHook = null } = {}) {
    this.#file = path.resolve(file);
    this.#turnPageSnapshotHook = typeof turnPageSnapshotHook === "function"
      ? turnPageSnapshotHook
      : null;
  }

  async #open() {
    if (this.#database) return this.#database;
    if (this.#opening) return this.#opening;
    this.#opening = (async () => {
      await mkdir(path.dirname(this.#file), { recursive: true });
      let database;
      try {
        database = new DatabaseSync(this.#file);
        configure(database);
      } catch (error) {
        database?.close();
        throw error;
      }
      this.#database = database;
      return database;
    })();
    try {
      return await this.#opening;
    } finally {
      this.#opening = null;
    }
  }

  #changed(change) {
    if (Number.isFinite(Number(change?.revision))) {
      this.#observedRevision = Number(change.revision);
    }
    for (const listener of new Set([...this.#listeners, ...this.#subscribers])) {
      try {
        listener(change);
      } catch {
        // A consumer notification must not roll back an already committed write.
      }
    }
  }

  onChange(listener) {
    if (typeof listener !== "function") throw new TypeError("Journal change listener must be a function");
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async #pollRevision() {
    if (this.#pollingRevision || !this.#subscribers.size) return;
    this.#pollingRevision = true;
    try {
      const revision = await this.currentRevision();
      const initial = this.#observedRevision === null;
      if (initial || revision !== this.#observedRevision) {
        this.#observedRevision = revision;
        for (const listener of this.#subscribers) {
          try {
            listener({ type: "revision", revision, initial });
          } catch {
            // Subscribers are isolated from the polling loop.
          }
        }
      }
    } finally {
      this.#pollingRevision = false;
    }
  }

  subscribe(listener, { pollMs = 500 } = {}) {
    if (typeof listener !== "function") throw new TypeError("Journal subscriber must be a function");
    this.#subscribers.add(listener);
    if (!this.#subscriptionTimer) {
      this.#subscriptionTimer = setInterval(
        () => void this.#pollRevision().catch(() => {}),
        Math.max(100, Number(pollMs) || 500),
      );
      this.#subscriptionTimer.unref?.();
    }
    void this.#pollRevision().catch(() => {});
    return () => {
      this.#subscribers.delete(listener);
      if (!this.#subscribers.size) {
        clearInterval(this.#subscriptionTimer);
        this.#subscriptionTimer = null;
        this.#observedRevision = null;
      }
    };
  }

  async currentRevision() {
    return revisionOf(await this.#open());
  }

  async ledgerStatus() {
    const database = await this.#open();
    return {
      revision: revisionOf(database),
      version: Math.max(0, Number(database.prepare(
        "SELECT value FROM journal_store_meta WHERE key = 'ledger_version'",
      ).get()?.value) || 0),
      records: Math.max(0, Number(database.prepare(
        "SELECT COUNT(*) AS count FROM journal_records",
      ).get()?.count) || 0),
    };
  }

  async loadLedger({ usageHistory = false } = {}) {
    const database = await this.#open();
    const turns = {};
    for (const row of database.prepare(`
      SELECT provider, thread_id, turn_id,
        ${usageHistory ? "CASE WHEN json_valid(record_json) THEN json_remove(record_json, '$.diff') ELSE record_json END" : "record_json"} AS record_json
      FROM journal_records ORDER BY provider, thread_id, turn_id
    `).iterate()) {
      try {
        const record = normalizedRecord(JSON.parse(row.record_json),
          ledgerKey({ provider: row.provider, threadId: row.thread_id, turnId: row.turn_id }));
        if (record) turns[ledgerKey(record)] = record;
      } catch {
        // Invalid rows cannot be returned as canonical records. SQLite keeps
        // the original JSON available for a separate repair/audit.
      }
    }
    const version = Number(database.prepare(
      "SELECT value FROM journal_store_meta WHERE key = 'ledger_version'",
    ).get()?.value ?? LEDGER_VERSION) || LEDGER_VERSION;
    return { version, turns };
  }

  // Snapshot the dirty dates and scalar accounting input together. Retained
  // content is read for dirty dates and accounting cache misses, never on each
  // warm projection for all retained records.
  async projectionInput({
    full = false, scope = null, selectRecord = () => true,
    accountingProjector = record => record,
  } = {}) {
    const database = await this.#open();
    database.exec("BEGIN");
    try {
      const revision = revisionOf(database);
      const source = JSON.parse(storeMetadataValue(database, "journal_projection_source") || "null");
      const current = publicIndex(database.prepare("SELECT * FROM journal_meta WHERE id = 1").get(), revision);
      full ||= scope !== null && (source?.incrementalVersion !== 1 || source?.scope !== scope);
      const dirtyDates = new Set();
      for (const row of database.prepare("SELECT completed_at_ms FROM journal_projection_dirty").all()) {
        const date = new Date(row.completed_at_ms);
        if (Number.isFinite(date.getTime())) dirtyDates.add(date.toLocaleDateString("ru-RU"));
      }
      const turns = {};
      const insert = (row, target) => {
        try {
          const record = normalizedRecord(JSON.parse(row.record_json), ledgerKey({
            provider: row.provider, threadId: row.thread_id, turnId: row.turn_id,
          }));
          if (record) target[ledgerKey(record)] = record;
        } catch { /* Invalid source bytes remain available for repair. */ }
      };
      const accounting = {};
      if (this.#projectionAccountingScope !== scope) {
        this.#projectionAccounting.clear();
        this.#projectionAccountingScope = scope;
      }
      const retained = new Set();
      const readRecord = database.prepare(`SELECT record_json FROM journal_records
        WHERE provider = ? AND thread_id = ? AND turn_id = ?`);
      let accountingRecordsRead = 0;
      // Scan identities/revisions only. A cold worker reads each source once;
      // later calls read changed payloads. The identity set observes deletions
      // even if another projector already cleared the durable dirty dates.
      for (const row of database.prepare(`SELECT provider, thread_id, turn_id, changed_revision
        FROM journal_records INDEXED BY journal_records_changed_idx
        ORDER BY provider, thread_id, turn_id`).iterate()) {
        const key = ledgerKey({ provider: row.provider, threadId: row.thread_id, turnId: row.turn_id });
        retained.add(key);
        let cached = this.#projectionAccounting.get(key);
        if (!cached || cached.revision !== row.changed_revision) {
          const parsed = {};
          insert({ ...row, ...readRecord.get(row.provider, row.thread_id, row.turn_id) }, parsed);
          cached = { revision: row.changed_revision, record: parsed[key] ? accountingProjector(parsed[key]) : null };
          this.#projectionAccounting.set(key, cached);
          accountingRecordsRead += 1;
        }
        if (cached.record) accounting[key] = cached.record;
      }
      for (const key of this.#projectionAccounting.keys()) if (!retained.has(key)) this.#projectionAccounting.delete(key);
      const dates = [...new Set(Object.values(accounting).filter(selectRecord).map(record => {
        const value = new Date(String(record.completedAt ?? ''));
        return Number.isFinite(value.getTime()) ? value.toLocaleDateString("ru-RU") : null;
      }).filter(Boolean))].sort((a, b) => {
        const time = date => { const [d, m, y] = date.split('.').map(Number); return Date.UTC(y,m-1,d); };
        return time(b)-time(a);
      });
      const today = new Date().toLocaleDateString("ru-RU");
      const openDate = dates.includes(today) ? today : dates[0] ?? '';
      if (source?.openDate !== openDate) {
        if (source?.openDate) dirtyDates.add(source.openDate);
        if (openDate) dirtyDates.add(openDate);
      }
      if (full) {
        for (const row of database.prepare("SELECT * FROM journal_records ORDER BY provider, thread_id, turn_id").iterate()) insert(row, turns);
      } else {
        const readDay = database.prepare(`SELECT * FROM journal_records
          WHERE completed_at_ms >= ? AND completed_at_ms < ? ORDER BY provider, thread_id, turn_id`);
        for (const date of dirtyDates) {
          const [day, month, year] = date.split(".").map(Number);
          for (const row of readDay.iterate(new Date(year, month - 1, day).getTime(), new Date(year, month - 1, day + 1).getTime())) insert(row, turns);
        }
      }
      database.exec("COMMIT");
      return { revision, dirtyDates: [...dirtyDates], turns, accounting, accountingRecordsRead, source, current, full, openDate };
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }

  async getRecord({ provider = "codex", threadId, turnId } = {}) {
    const identity = normalizedIdentity({ provider, threadId, turnId });
    if (!identity) return null;
    const row = (await this.#open()).prepare(`
      SELECT record_json FROM journal_records
      WHERE provider = ? AND thread_id = ? AND turn_id = ?
    `).get(identity.provider, identity.threadId, identity.turnId);
    if (!row) return null;
    try {
      return normalizedRecord(JSON.parse(row.record_json), ledgerKey(identity));
    } catch {
      return null;
    }
  }

  async turnProjectionStatus({ provider = "codex", threadId, turnId } = {}) {
    const identity = normalizedIdentity({ provider, threadId, turnId });
    if (!identity) return { record: null, recordRevision: null, indexed: false, usageFact: false, projectionSource: null };
    const database = await this.#open();
    database.exec("BEGIN");
    try {
      const row = database.prepare(`
        SELECT record_json, changed_revision FROM journal_records
        WHERE provider = ? AND thread_id = ? AND turn_id = ?
      `).get(identity.provider, identity.threadId, identity.turnId);
      let record = null;
      try {
        record = row ? normalizedRecord(JSON.parse(row.record_json), ledgerKey(identity)) : null;
      } catch {}
      const indexRow = database.prepare(`
        SELECT turn_ref AS turnRef, completed_at_ms AS completedAtMs
        FROM journal_turn_index
        WHERE provider = ? AND thread_id = ? AND turn_id = ? LIMIT 1
      `).get(identity.provider, identity.threadId, identity.turnId);
      const usageRow = tableExists(database, "usage_sync_events") ? database.prepare(`
        SELECT * FROM usage_sync_events WHERE event_id = ? LIMIT 1
      `).get(usageTurnFactId(identity)) : null;
      let limitSamples = [];
      try { limitSamples = JSON.parse(usageRow?.limit_samples_json ?? "[]"); } catch {}
      const usageFact = usageRow ? {
        schemaVersion: Number(usageRow.schema_version ?? 1),
        type: "turn",
        eventId: usageRow.event_id,
        deviceId: usageRow.device_id,
        source: usageRow.source,
        provider: usageRow.provider,
        threadKey: usageRow.thread_key,
        taskKey: usageRow.task_key,
        completedAt: usageRow.completed_at,
        startedAt: usageRow.started_at,
        runtimeHomeId: usageRow.runtime_home_id,
        limitSamples,
        estimatedCredits: Number(usageRow.estimated_credits) || 0,
        estimateKind: usageRow.estimate_kind,
        imageGenerationCount: Number(usageRow.image_generation_count) || 0,
        usage: {
          inputTokens: Number(usageRow.input_tokens) || 0,
          cachedInputTokens: Number(usageRow.cached_input_tokens) || 0,
          outputTokens: Number(usageRow.output_tokens) || 0,
          reasoningOutputTokens: Number(usageRow.reasoning_output_tokens) || 0,
          totalTokens: Number(usageRow.total_tokens) || 0,
        },
        usageReported: Number(usageRow.usage_reported) !== 0,
        model: usageRow.model,
        serviceTier: usageRow.service_tier,
        deviceLabel: usageRow.device_label,
        observedAt: usageRow.observed_at,
      } : null;
      const sourceValue = database.prepare(
        "SELECT value FROM journal_store_meta WHERE key = 'journal_projection_source'",
      ).get()?.value;
      let projectionSource = null;
      try { projectionSource = sourceValue ? JSON.parse(sourceValue) : null; } catch {}
      database.exec("COMMIT");
      return {
        record,
        recordRevision: row ? Number(row.changed_revision) : null,
        indexed: Boolean(indexRow),
        index: indexRow ? { ...indexRow, completedAtMs: Number(indexRow.completedAtMs) } : null,
        usageFact,
        projectionSource,
      };
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }

  async threadRecords(identities = [], { limit = 20 } = {}) {
    const requested = (Array.isArray(identities) ? identities : [])
      .map((value) => normalizedIdentity({ ...value, turnId: value?.turnId || "_" }))
      .filter(Boolean)
      .slice(0, 100);
    if (!requested.length) return [];
    const boundedLimit = Math.max(1, Math.min(50, Number(limit) || 20));
    const clauses = requested.map(() => "(provider = ? AND thread_id = ?)").join(" OR ");
    const parameters = requested.flatMap((value) => [value.provider, value.threadId]);
    const rows = (await this.#open()).prepare(`
      SELECT provider, thread_id, turn_id, record_json FROM journal_records
      WHERE ${clauses}
      ORDER BY completed_at_ms DESC LIMIT ?
    `).all(...parameters, boundedLimit);
    return rows.map((row) => {
      try {
        return normalizedRecord(JSON.parse(row.record_json), ledgerKey({
          provider: row.provider,
          threadId: row.thread_id,
          turnId: row.turn_id,
        }));
      } catch {
        return null;
      }
    }).filter(Boolean);
  }

  async replaceLedger(ledger, { expectedRevision = null } = {}) {
    const database = await this.#open();
    const rows = Object.entries(ledger?.turns ?? {})
      .map(([key, record]) => recordRow(record, key))
      .filter(Boolean);
    database.exec("BEGIN IMMEDIATE");
    let revision;
    try {
      const current = revisionOf(database);
      if (expectedRevision !== null && Number(expectedRevision) !== current) {
        throw new Error(`Journal revision conflict: expected ${expectedRevision}, found ${current}`);
      }
      database.exec("DELETE FROM journal_records");
      const nextRevision = current + 1;
      const insert = insertRecordStatement(database);
      for (const row of rows) insertRow(insert, row, nextRevision);
      database.prepare(`
        INSERT INTO journal_store_meta (key, value) VALUES ('ledger_version', ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `).run(String(Number(ledger?.version) || LEDGER_VERSION));
      revision = advanceRevision(database);
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
    const result = { replaced: rows.length, revision };
    this.#changed({ type: "ledger", ...result });
    return result;
  }

  async *metadataRecords({ provider }) {
    const database = await this.#open();
    for (const row of database.prepare(`
      SELECT provider, thread_id, turn_id,
        CASE WHEN json_valid(record_json) THEN json_remove(record_json, '$.diff') END AS record_json
      FROM journal_records WHERE provider = ? ORDER BY thread_id, turn_id
    `).iterate(provider)) {
      try {
        const record = normalizedRecord(JSON.parse(row.record_json), ledgerKey({
          provider: row.provider, threadId: row.thread_id, turnId: row.turn_id,
        }));
        if (record) yield record;
      } catch {
        // Preserve malformed persisted rows for explicit repair, as loadLedger does.
      }
    }
  }

  async changedRecordProjectRoots({ afterRevision = -1, throughRevision }) {
    return (await this.#open()).prepare(`
      SELECT DISTINCT project_root AS projectRoot FROM journal_records
      WHERE changed_revision > ? AND changed_revision <= ?
    `).all(afterRevision, throughRevision).map((row) => row.projectRoot);
  }

  async recordRevision({ provider, threadId, turnId }) {
    return (await this.#open()).prepare(`
      SELECT changed_revision FROM journal_records WHERE provider = ? AND thread_id = ? AND turn_id = ?
    `).get(provider, threadId, turnId)?.changed_revision ?? null;
  }

  async taskTitleMetadata({ provider, threadId }) {
    // Without an explicit task seek SQLite may choose the WITHOUT ROWID
    // provider prefix, rereading every provider record for each catalog title.
    return (await this.#open()).prepare(`
      SELECT provider, thread_id AS threadId, turn_id AS turnId,
        project_root AS projectRoot, changed_revision AS changedRevision,
        CASE WHEN json_valid(record_json) THEN json_extract(record_json, '$.taskTitle') END AS taskTitle
      FROM journal_records INDEXED BY journal_records_task_idx
      WHERE provider = ? AND task_thread_id = ?
    `).all(provider, threadId);
  }

  async projectionSource() {
    const value = (await this.#open()).prepare(
      "SELECT value FROM journal_store_meta WHERE key = 'journal_projection_source'",
    ).get()?.value;
    return value ? JSON.parse(value) : null;
  }

  async upsertRecords(records, { expectedRevision = null } = {}) {
    const values = Array.isArray(records)
      ? records.map((record) => ["", record])
      : Object.entries(records ?? {});
    const rows = values.map(([key, record]) => recordRow(record, key)).filter(Boolean);
    if (!rows.length) return { upserted: 0, revision: await this.currentRevision() };
    const database = await this.#open();
    database.exec("BEGIN IMMEDIATE");
    let revision;
    try {
      const currentRevision = revisionOf(database);
      if (expectedRevision !== null && currentRevision !== Number(expectedRevision)) {
        const error = new Error("Journal records changed before the metadata update");
        error.code = "JOURNAL_REVISION_CONFLICT";
        throw error;
      }
      const nextRevision = currentRevision + 1;
      const insert = insertRecordStatement(database);
      for (const row of rows) insertRow(insert, row, nextRevision);
      revision = advanceRevision(database);
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
    const result = { upserted: rows.length, revision };
    this.#changed({ type: "ledger", ...result });
    return result;
  }

  async deleteRecords(identities) {
    const values = (Array.isArray(identities) ? identities : [identities])
      .map((value) => normalizedIdentity(value, typeof value === "string" ? value : ""))
      .filter(Boolean);
    if (!values.length) return { deleted: 0, revision: await this.currentRevision() };
    const database = await this.#open();
    database.exec("BEGIN IMMEDIATE");
    let deleted = 0;
    let revision;
    try {
      const remove = database.prepare(`
        DELETE FROM journal_records WHERE provider = ? AND thread_id = ? AND turn_id = ?
      `);
      for (const value of values) {
        deleted += Number(remove.run(value.provider, value.threadId, value.turnId).changes) || 0;
      }
      revision = deleted ? advanceRevision(database) : revisionOf(database);
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
    const result = { deleted, revision };
    if (deleted) this.#changed({ type: "ledger", ...result });
    return result;
  }

  async importLegacyLedger(ledgerFile) {
    const target = path.resolve(ledgerFile);
    const database = await this.#open();
    const sourceIdentity = await legacyFilesIdentity(target);
    const imported = database.prepare(
      "SELECT record_count, details_json FROM journal_imports WHERE key = ?",
    ).get(LEGACY_IMPORT_KEY);
    let importedDetails = {};
    try {
      importedDetails = JSON.parse(imported?.details_json ?? "{}");
    } catch {
      importedDetails = {};
    }
    if (imported && importedDetails.sourceIdentity === sourceIdentity) {
      return {
        imported: false,
        reason: "unchanged",
        records: Number(imported.record_count) || 0,
        invalid: 0,
        fingerprint: String(importedDetails.fingerprint ?? ""),
        revision: revisionOf(database),
      };
    }
    const snapshot = await readStableLegacyLedger(target);
    if (snapshot.missing) {
      return { imported: false, reason: "missing", records: 0, invalid: snapshot.delta.invalid };
    }
    database.exec("BEGIN IMMEDIATE");
    let revision;
    let upserted = 0;
    let deleted = 0;
    try {
      const nextRevision = revisionOf(database) + 1;
      const previous = database.prepare(
        "SELECT record_count, details_json FROM journal_imports WHERE key = ?",
      ).get(LEGACY_IMPORT_KEY);
      let previousDetails = {};
      try {
        previousDetails = JSON.parse(previous?.details_json ?? "{}");
      } catch {
        previousDetails = {};
      }
      if (previous && previousDetails.sourceIdentity === snapshot.sourceIdentity) {
        database.exec("COMMIT");
        return {
          imported: false,
          reason: "unchanged",
          records: Number(previous.record_count) || 0,
          invalid: snapshot.delta.invalid + snapshot.skipped,
          fingerprint: String(previousDetails.fingerprint ?? ""),
          revision: revisionOf(database),
        };
      }
      const nextKeys = new Set(snapshot.rows.map((row) => ledgerKey(row)));
      const remove = database.prepare(`
        DELETE FROM journal_records WHERE provider = ? AND thread_id = ? AND turn_id = ?
      `);
      for (const old of database.prepare(`
        SELECT provider, thread_id, turn_id FROM journal_import_records WHERE import_key = ?
      `).all(LEGACY_IMPORT_KEY)) {
        const identity = { provider: old.provider, threadId: old.thread_id, turnId: old.turn_id };
        if (nextKeys.has(ledgerKey(identity))) continue;
        deleted += Number(remove.run(identity.provider, identity.threadId, identity.turnId).changes) || 0;
      }
      const insert = insertRecordStatement(database);
      for (const row of snapshot.rows) {
        upserted += Number(insert.run(
          row.provider,
          row.threadId,
          row.turnId,
          row.projectRoot,
          row.taskThreadId,
          row.completedAtMs,
          row.observedAtMs,
          nextRevision,
          row.json,
        ).changes) || 0;
      }
      database.prepare("DELETE FROM journal_import_records WHERE import_key = ?")
        .run(LEGACY_IMPORT_KEY);
      const track = database.prepare(`
        INSERT INTO journal_import_records
          (import_key, provider, thread_id, turn_id, record_hash)
        VALUES (?, ?, ?, ?, ?)
      `);
      for (const row of snapshot.rows) {
        track.run(LEGACY_IMPORT_KEY, row.provider, row.threadId, row.turnId, sha256(row.json));
      }
      database.prepare(`
        INSERT INTO journal_store_meta (key, value) VALUES ('ledger_version', ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `).run(String(Number(snapshot.delta.value?.version) || LEDGER_VERSION));
      const importedAt = new Date().toISOString();
      database.prepare(`
        INSERT INTO journal_imports
          (key, imported_at, source, record_count, details_json)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          imported_at = excluded.imported_at,
          source = excluded.source,
          record_count = excluded.record_count,
          details_json = excluded.details_json
      `).run(LEGACY_IMPORT_KEY, importedAt, snapshot.loaded.source, snapshot.rows.length, JSON.stringify({
        sourceIdentity: snapshot.sourceIdentity,
        fingerprint: snapshot.fingerprint,
        sourceRecords: snapshot.rows.length,
        upserted,
        deleted,
        recovered: snapshot.loaded.recovered,
        deltaApplied: snapshot.delta.applied,
        invalid: snapshot.delta.invalid,
        skipped: snapshot.skipped,
      }));
      revision = advanceRevision(database);
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
    const result = {
      imported: true,
      records: snapshot.rows.length,
      upserted,
      deleted,
      invalid: snapshot.delta.invalid + snapshot.skipped,
      recovered: snapshot.loaded.recovered,
      deltaApplied: snapshot.delta.applied,
      fingerprint: snapshot.fingerprint,
      revision,
    };
    this.#changed({ type: "ledger-import", ...result });
    return result;
  }

  async verifyLegacyLedger(ledgerFile) {
    const target = path.resolve(ledgerFile);
    const snapshot = await readStableLegacyLedger(target);
    if (snapshot.missing) {
      return {
        verified: false,
        reason: "missing",
        sourceRecords: 0,
        databaseRecords: 0,
        missing: [],
        mismatched: [],
        extra: [],
      };
    }
    const database = await this.#open();
    const expected = new Map(snapshot.rows.map((row) => [ledgerKey(row), row.json]));
    const actual = new Map(database.prepare(`
      SELECT provider, thread_id, turn_id, record_json FROM journal_records
    `).all().map((row) => [ledgerKey({
      provider: row.provider,
      threadId: row.thread_id,
      turnId: row.turn_id,
    }), row.record_json]));
    const missing = [];
    const mismatched = [];
    const extra = [];
    for (const [key, json] of expected) {
      if (!actual.has(key)) missing.push(key);
      else if (actual.get(key) !== json) mismatched.push(key);
    }
    for (const key of actual.keys()) {
      if (!expected.has(key)) extra.push(key);
    }
    const invalid = snapshot.delta.invalid + snapshot.skipped;
    return {
      verified: !invalid && !missing.length && !mismatched.length && !extra.length,
      fingerprint: snapshot.fingerprint,
      sourceIdentity: snapshot.sourceIdentity,
      sourceRecords: expected.size,
      databaseRecords: actual.size,
      invalid,
      missing,
      mismatched,
      extra,
    };
  }

  async replaceProjection(payload, options = {}) {
    const database = await this.#open();
    const normalized = {
      html: String(payload?.html ?? ""),
      days: payload?.days && typeof payload.days === "object" ? payload.days : {},
      turns: payload?.turns && typeof payload.turns === "object" ? payload.turns : {},
      summary: payload?.summary && typeof payload.summary === "object"
        ? payload.summary
        : { version: 1, buckets: [] },
      entries: Array.isArray(payload?.entries) ? payload.entries : [],
      virtualDates: Array.isArray(payload?.virtualDates) ? payload.virtualDates : [],
      virtualComplete: payload?.virtualComplete !== false,
    };
    database.exec("BEGIN IMMEDIATE");
    let revision;
    let version;
    try {
      const currentRevision = revisionOf(database);
      if (options.expectedRevision != null
        && currentRevision !== Number(options.expectedRevision)) {
        database.exec("ROLLBACK");
        return {
          projected: false,
          conflict: true,
          expectedRevision: Number(options.expectedRevision),
          revision: currentRevision,
        };
      }
      version = writeProjection(database, normalized, options);
      if (options.incrementalSource) {
        database.exec("DELETE FROM journal_projection_dirty");
      }
      writeStoreMetadataValue(database, "journal_projection_source", options.projectionSource
        ? JSON.stringify(options.projectionSource) : "");
      revision = advanceRevision(database);
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
    const result = { projected: true, version, revision };
    this.#changed({ type: "projection", ...result });
    return result;
  }

  async replaceIndexProjection(html, {
    expectedRevision,
    updatedAt = new Date().toISOString(),
    version = "",
    accountUsageProjectionVersion = null,
  } = {}) {
    const database = await this.#open();
    database.exec("BEGIN IMMEDIATE");
    let revision;
    let resolvedVersion;
    try {
      const currentRevision = revisionOf(database);
      if (Number.isFinite(Number(expectedRevision))
        && currentRevision !== Number(expectedRevision)) {
        database.exec("ROLLBACK");
        return {
          projected: false,
          conflict: true,
          expectedRevision: Number(expectedRevision),
          revision: currentRevision,
        };
      }
      resolvedVersion = String(version || sha256Version(html));
      database.prepare(`
        INSERT INTO journal_meta (id, schema_version, source_version, updated_at, html)
        VALUES (1, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          schema_version = excluded.schema_version,
          source_version = excluded.source_version,
          updated_at = excluded.updated_at,
          html = excluded.html
      `).run(SCHEMA_VERSION, resolvedVersion, String(updatedAt), String(html ?? ""));
      if (accountUsageProjectionVersion != null) {
        writeStoreMetadataValue(
          database,
          ACCOUNT_USAGE_PROJECTION_VERSION_KEY,
          accountUsageProjectionVersion,
        );
      }
      revision = advanceRevision(database);
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
    const result = { projected: true, version: resolvedVersion, revision };
    this.#changed({ type: "projection-index", ...result });
    return result;
  }

  async payload() {
    const database = await this.#open();
    const row = database.prepare(
      "SELECT source_version, updated_at, html, summary_json FROM journal_meta WHERE id = 1",
    ).get();
    return publicIndex(row, revisionOf(database));
  }

  async metadata() {
    const database = await this.#open();
    const row = database.prepare(
      "SELECT source_version, updated_at FROM journal_meta WHERE id = 1",
    ).get();
    if (!row) return null;
    return {
      updatedAt: String(row.updated_at ?? ""),
      version: String(row.source_version ?? ""),
      revision: revisionOf(database),
    };
  }

  async accountUsageProjectionVersion() {
    return storeMetadataValue(
      await this.#open(),
      ACCOUNT_USAGE_PROJECTION_VERSION_KEY,
    );
  }

  async snapshot() {
    const database = await this.#open();
    const payload = await this.payload();
    if (!payload) return null;
    return {
      ...payload,
      days: Object.fromEntries(database.prepare(
        `SELECT date, html FROM journal_days ORDER BY ${JOURNAL_DAY_ORDER}`,
      ).all().map((row) => [row.date, row.html])),
      turns: Object.fromEntries(database.prepare(
        "SELECT id, html FROM journal_turns ORDER BY id",
      ).all().map((row) => [row.id, row.html])),
      turnEntries: database.prepare(`
        SELECT turn_ref AS turnRef, date, day_ms AS dayMs, workspace_id AS workspaceId,
          stream_id AS streamId, provider, thread_id AS threadId, turn_id AS turnId,
          completed_at_ms AS completedAtMs, html
        FROM journal_turn_index
        ORDER BY completed_at_ms DESC, turn_ref
      `).all(),
    };
  }

  async accountCatalog() {
    const database = await this.#open();
    const sources = [];
    if (tableExists(database, "rate_limit_snapshots")) {
      sources.push(`
        SELECT observed_ms, account_key, account_label, account_type, account_plan,
          0 AS event_priority, id AS stable_order
        FROM rate_limit_snapshots
        WHERE account_key <> ''
      `);
    }
    if (tableExists(database, "rate_limit_account_events")) {
      sources.push(`
        SELECT observed_ms, account_key, account_label, account_type, account_plan,
          1 AS event_priority, observed_ms AS stable_order
        FROM rate_limit_account_events
        WHERE account_key <> ''
      `);
    }
    if (!sources.length) return [];
    return database.prepare(`
      WITH timeline AS (${sources.join(" UNION ALL ")}), ranked AS (
        SELECT account_key, account_label, account_type, account_plan,
          ROW_NUMBER() OVER (
            PARTITION BY account_key
            ORDER BY observed_ms DESC, event_priority DESC, stable_order DESC
          ) AS account_sequence
        FROM timeline
      )
      SELECT account_key, account_label, account_type, account_plan
      FROM ranked
      WHERE account_sequence = 1
      ORDER BY account_label, account_key
    `).all().map((row) => ({
      key: String(row.account_key ?? "").trim(),
      label: String(row.account_label ?? "").trim(),
      type: String(row.account_type ?? "").trim(),
      planType: String(row.account_plan ?? "").trim(),
    })).filter((account) => account.key);
  }

  exportPayload() {
    return this.snapshot();
  }

  async fragment(kind, key) {
    const database = await this.#open();
    const table = kind === "day" ? "journal_days" : "journal_turns";
    const column = kind === "day" ? "date" : "id";
    const row = database.prepare(`SELECT html FROM ${table} WHERE ${column} = ?`).get(String(key));
    return typeof row?.html === "string" ? row.html : null;
  }

  async fragments(kind) {
    const database = await this.#open();
    const table = kind === "day" ? "journal_days" : "journal_turns";
    const column = kind === "day" ? "date" : "id";
    const order = kind === "day" ? JOURNAL_DAY_ORDER : column;
    return Object.fromEntries(database.prepare(
      `SELECT ${column} AS key, html FROM ${table} ORDER BY ${order}`,
    ).all().map((row) => [row.key, row.html]));
  }

  async fragmentPage(kind, { offset = 0, limit = 7 } = {}) {
    const database = await this.#open();
    const table = kind === "day" ? "journal_days" : "journal_turns";
    const column = kind === "day" ? "date" : "id";
    const order = kind === "day" ? JOURNAL_DAY_ORDER : column;
    const boundedOffset = Math.max(0, Math.floor(Number(offset) || 0));
    const boundedLimit = Math.max(1, Math.min(20, Math.floor(Number(limit) || 7)));
    const rows = database.prepare(
      `SELECT ${column} AS key, html FROM ${table} ORDER BY ${order} LIMIT ? OFFSET ?`,
    ).all(boundedLimit + 1, boundedOffset);
    const page = rows.slice(0, boundedLimit);
    return {
      fragments: Object.fromEntries(page.map((row) => [row.key, row.html])),
      nextOffset: rows.length > boundedLimit ? boundedOffset + page.length : null,
    };
  }

  async turnPage({
    expectedVersion = "",
    profileMode = "",
    workspaceId = "",
    streamId = "",
    provider = "",
    threadId = "",
    fromMs = 0,
    toMs = 0,
    offset = 0,
    limit = 20,
  } = {}) {
    const database = await this.#open();
    const requestedVersion = String(expectedVersion ?? "").trim().slice(0, 128);
    const requestedProfileMode = String(profileMode ?? "").trim() === "stream" ? "stream" : "";
    const workspace = String(workspaceId ?? "").trim().slice(0, 256);
    const stream = String(streamId ?? "").trim().slice(0, 256);
    const providerName = String(provider ?? "").trim().slice(0, 32);
    const thread = String(threadId ?? "").trim().slice(0, 256);
    const boundedNumber = (value, maximum = Number.MAX_SAFE_INTEGER) => {
      const number = Number(value);
      return Number.isSafeInteger(number) && number > 0 ? Math.min(number, maximum) : 0;
    };
    const rangeStart = boundedNumber(fromMs);
    const rangeEnd = boundedNumber(toMs);
    const boundedOffset = boundedNumber(offset, 1_000_000);
    const boundedLimit = Math.max(1, Math.min(50, Math.floor(Number(limit) || 20)));
    const clauses = [];
    const parameters = [];
    const constrain = (column, value) => {
      if (!value) return;
      clauses.push(`${column} = ?`);
      parameters.push(value);
    };
    constrain("workspace_id", workspace);
    constrain("stream_id", stream);
    constrain("provider", providerName);
    constrain("thread_id", thread);
    if (rangeStart) {
      clauses.push("completed_at_ms >= ?");
      parameters.push(rangeStart);
    }
    if (rangeEnd) {
      clauses.push("completed_at_ms < ?");
      parameters.push(rangeEnd);
    }
    database.exec("BEGIN");
    try {
      const meta = database.prepare(
        "SELECT source_version, summary_json FROM journal_meta WHERE id = 1",
      ).get();
      const actualVersion = String(meta?.source_version ?? "");
      await this.#turnPageSnapshotHook?.({ version: actualVersion });
      if (requestedVersion && requestedVersion !== actualVersion) {
        database.exec("COMMIT");
        return { conflict: true, version: actualVersion, turns: [], nextOffset: null };
      }
      const rows = database.prepare(`
        SELECT turn_ref AS turnRef, date, html
        FROM journal_turn_index
        ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
        ORDER BY completed_at_ms DESC, turn_ref
        LIMIT ? OFFSET ?
      `).all(
        ...parameters,
        boundedLimit + 1,
        boundedOffset,
      );
      const page = rows.slice(0, boundedLimit);
      let profileSummary = null;
      if (requestedProfileMode) {
        try {
          const parsed = JSON.parse(String(meta?.summary_json ?? ""));
          if (parsed && Number(parsed.version) === 1 && Array.isArray(parsed.buckets)) {
            profileSummary = profileCohortVirtualJournalSummary(parsed, {
              requiredWorkspaceId: workspace,
              requiredStreamId: stream,
            });
          }
        } catch {
          profileSummary = { version: 1, buckets: [] };
        }
      }
      database.exec("COMMIT");
      return {
        conflict: false,
        version: actualVersion,
        turns: page.map((row) => ({ turnRef: row.turnRef, date: row.date, html: row.html })),
        nextOffset: rows.length > boundedLimit ? boundedOffset + page.length : null,
        ...(profileSummary ? { profileSummary } : {}),
      };
    } catch (error) {
      try {
        database.exec("ROLLBACK");
      } catch {
        // Preserve the read failure when SQLite already ended the transaction.
      }
      throw error;
    }
  }

  close() {
    clearInterval(this.#subscriptionTimer);
    this.#subscriptionTimer = null;
    this.#listeners.clear();
    this.#subscribers.clear();
    this.#database?.close();
    this.#database = null;
    this.#projectionAccounting.clear();
    this.#projectionAccountingScope = null;
  }
}
