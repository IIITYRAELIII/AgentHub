import crypto from "node:crypto";
import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { applyLedgerDelta } from "./incremental-ledger.mjs";
import { readJsonWithBackup } from "./state-store.mjs";

const SCHEMA_VERSION = 2;
const LEDGER_VERSION = 9;
const LEGACY_IMPORT_KEY = "work-log-usage-v1";
const JOURNAL_DAY_ORDER = "substr(date, 7, 4), substr(date, 4, 2), substr(date, 1, 2)";

function configure(database) {
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS journal_meta (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      schema_version INTEGER NOT NULL,
      source_version TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      html TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS journal_days (
      date TEXT PRIMARY KEY,
      html TEXT NOT NULL
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS journal_turns (
      id TEXT PRIMARY KEY,
      html TEXT NOT NULL
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS journal_records (
      provider TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      project_root TEXT NOT NULL,
      task_thread_id TEXT NOT NULL,
      completed_at_ms INTEGER,
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
  `);
}

function tableExists(database, name) {
  return Boolean(database.prepare(`
    SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?
  `).get(name));
}

function publicIndex(row, revision = 0) {
  if (!row) return null;
  return {
    html: String(row.html ?? ""),
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
  return {
    record: normalized,
    provider: normalized.provider,
    threadId: normalized.threadId,
    turnId: normalized.turnId,
    projectRoot: normalized.projectRoot,
    taskThreadId: normalized.taskThreadId,
    completedAtMs: Number.isFinite(completedAtMs) ? completedAtMs : null,
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

function projectionVersion(payload) {
  return sha256Version(JSON.stringify({
    html: payload.html,
    days: payload.days,
    turns: payload.turns,
  }));
}

function writeProjection(database, payload, {
  updatedAt = new Date().toISOString(),
  version = "",
} = {}) {
  const html = String(payload.html ?? "");
  const days = payload.days ?? {};
  const turns = payload.turns ?? {};
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
  const insertDay = database.prepare(
    "INSERT INTO journal_days (date, html) VALUES (?, ?) ON CONFLICT(date) DO UPDATE SET html = excluded.html",
  );
  for (const [date, dayHtml] of Object.entries(days)) insertDay.run(date, dayHtml);
  const insertTurn = database.prepare("INSERT INTO journal_turns (id, html) VALUES (?, ?)");
  for (const [id, turnHtml] of Object.entries(turns)) insertTurn.run(id, turnHtml);
  const resolvedVersion = String(version || projectionVersion(payload));
  database.prepare(`
    INSERT INTO journal_meta (id, schema_version, source_version, updated_at, html)
    VALUES (1, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      schema_version = excluded.schema_version,
      source_version = excluded.source_version,
      updated_at = excluded.updated_at,
      html = excluded.html
  `).run(SCHEMA_VERSION, resolvedVersion, String(updatedAt), String(payload.html ?? ""));
  return resolvedVersion;
}

function insertRecordStatement(database) {
  return database.prepare(`
    INSERT INTO journal_records
      (provider, thread_id, turn_id, project_root, task_thread_id, completed_at_ms, record_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(provider, thread_id, turn_id) DO UPDATE SET
      project_root = excluded.project_root,
      task_thread_id = excluded.task_thread_id,
      completed_at_ms = excluded.completed_at_ms,
      record_json = excluded.record_json
  `);
}

function insertRow(statement, row) {
  statement.run(
    row.provider,
    row.threadId,
    row.turnId,
    row.projectRoot,
    row.taskThreadId,
    row.completedAtMs,
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
  #file;
  #opening = null;
  #listeners = new Set();
  #subscribers = new Set();
  #subscriptionTimer = null;
  #observedRevision = null;
  #pollingRevision = false;

  constructor(file) {
    this.#file = path.resolve(file);
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

  async loadLedger() {
    const database = await this.#open();
    const turns = {};
    for (const row of database.prepare(`
      SELECT provider, thread_id, turn_id, record_json
      FROM journal_records ORDER BY provider, thread_id, turn_id
    `).all()) {
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
      const insert = insertRecordStatement(database);
      for (const row of rows) insertRow(insert, row);
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

  async upsertRecords(records) {
    const values = Array.isArray(records)
      ? records.map((record) => ["", record])
      : Object.entries(records ?? {});
    const rows = values.map(([key, record]) => recordRow(record, key)).filter(Boolean);
    if (!rows.length) return { upserted: 0, revision: await this.currentRevision() };
    const database = await this.#open();
    database.exec("BEGIN IMMEDIATE");
    let revision;
    try {
      const insert = insertRecordStatement(database);
      for (const row of rows) insertRow(insert, row);
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
    };
    database.exec("BEGIN IMMEDIATE");
    let revision;
    let version;
    try {
      version = writeProjection(database, normalized, options);
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
      "SELECT source_version, updated_at, html FROM journal_meta WHERE id = 1",
    ).get();
    return publicIndex(row, revisionOf(database));
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

  close() {
    clearInterval(this.#subscriptionTimer);
    this.#subscriptionTimer = null;
    this.#listeners.clear();
    this.#subscribers.clear();
    this.#database?.close();
    this.#database = null;
  }
}
