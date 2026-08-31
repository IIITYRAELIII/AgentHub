import { mkdir, readFile, rename } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  mergeUsageSyncEvents,
  normalizeUsageSyncEvent,
  strongerUsageSyncEvent,
  usageSyncSnapshotFromLedger,
  USAGE_SYNC_SNAPSHOT_VERSION,
} from "../../domain/work-log-usage-sync.mjs";

const SQLITE_BUSY_RETRY_DELAYS_MS = [10, 25, 50, 100, 250, 500, 1_000, 2_000];
const UPSERT_CHUNK = 400;

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function sqliteBusy(error) {
  return /SQLITE_BUSY|database is locked|database is busy/iu.test(String(error?.message ?? error));
}

function configureUsageSyncDatabase(database) {
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS usage_sync_events (
      event_id TEXT PRIMARY KEY,
      device_id TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'sync',
      provider TEXT NOT NULL,
      thread_key TEXT NOT NULL,
      task_key TEXT NOT NULL,
      completed_at TEXT NOT NULL,
      completed_ms INTEGER NOT NULL,
      started_at TEXT NOT NULL DEFAULT '',
      account_key TEXT NOT NULL DEFAULT '',
      account_label TEXT NOT NULL DEFAULT '',
      account_type TEXT NOT NULL DEFAULT '',
      account_plan TEXT NOT NULL DEFAULT '',
      account_attribution TEXT NOT NULL DEFAULT 'inferred',
      estimated_credits REAL NOT NULL DEFAULT 0,
      estimate_kind TEXT NOT NULL DEFAULT '',
      image_generation_count INTEGER NOT NULL DEFAULT 0,
      context_probe INTEGER NOT NULL DEFAULT 0,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      cached_input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      reasoning_output_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      usage_reported INTEGER NOT NULL DEFAULT 1,
      model TEXT NOT NULL DEFAULT '',
      service_tier TEXT NOT NULL DEFAULT '',
      device_label TEXT NOT NULL DEFAULT '',
      observed_at TEXT NOT NULL
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS usage_sync_events_device_idx
      ON usage_sync_events(device_id, completed_ms);
    CREATE INDEX IF NOT EXISTS usage_sync_events_account_idx
      ON usage_sync_events(account_key, completed_ms);
    CREATE TABLE IF NOT EXISTS usage_sync_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    ) WITHOUT ROWID;
  `);
  const columns = new Set(database.prepare("PRAGMA table_info(usage_sync_events)").all()
    .map((row) => row.name));
  for (const [name, definition] of [
    ["account_label", "TEXT NOT NULL DEFAULT ''"],
    ["account_type", "TEXT NOT NULL DEFAULT ''"],
    ["account_plan", "TEXT NOT NULL DEFAULT ''"],
    ["device_label", "TEXT NOT NULL DEFAULT ''"],
    ["estimate_kind", "TEXT NOT NULL DEFAULT ''"],
    ["image_generation_count", "INTEGER NOT NULL DEFAULT 0"],
    ["context_probe", "INTEGER NOT NULL DEFAULT 0"],
  ]) {
    if (!columns.has(name)) database.exec(`ALTER TABLE usage_sync_events ADD COLUMN ${name} ${definition}`);
  }
  database.exec(`
    UPDATE usage_sync_events
    SET account_key = '',
        account_label = '',
        account_type = '',
        account_plan = '',
        account_attribution = 'inferred'
    WHERE lower(trim(account_attribution)) <> 'exact'
       OR trim(account_key) = ''
  `);
}

function rowToEvent(row) {
  return normalizeUsageSyncEvent({
    eventId: row.event_id,
    deviceId: row.device_id,
    source: row.source,
    provider: row.provider,
    threadKey: row.thread_key,
    taskKey: row.task_key,
    completedAt: row.completed_at,
    startedAt: row.started_at,
    accountKey: row.account_key,
    accountLabel: row.account_label,
    accountType: row.account_type,
    accountPlan: row.account_plan,
    accountAttribution: row.account_attribution,
    estimatedCredits: row.estimated_credits,
    estimateKind: row.estimate_kind,
    imageGenerationCount: row.image_generation_count,
    contextProbe: row.context_probe !== 0,
    usage: {
      inputTokens: row.input_tokens,
      cachedInputTokens: row.cached_input_tokens,
      outputTokens: row.output_tokens,
      reasoningOutputTokens: row.reasoning_output_tokens,
      totalTokens: row.total_tokens,
    },
    usageReported: row.usage_reported !== 0,
    model: row.model,
    serviceTier: row.service_tier,
    deviceLabel: row.device_label,
    observedAt: row.observed_at,
  });
}

function eventParameters(event) {
  return [
    event.eventId,
    event.deviceId,
    event.source,
    event.provider,
    event.threadKey,
    event.taskKey,
    event.completedAt,
    Date.parse(event.completedAt) || 0,
    event.startedAt,
    event.accountKey,
    event.accountLabel,
    event.accountType,
    event.accountPlan,
    event.accountAttribution,
    event.estimatedCredits,
    event.estimateKind,
    event.imageGenerationCount,
    event.contextProbe ? 1 : 0,
    event.usage.inputTokens,
    event.usage.cachedInputTokens,
    event.usage.outputTokens,
    event.usage.reasoningOutputTokens,
    event.usage.totalTokens,
    event.usageReported ? 1 : 0,
    event.model,
    event.serviceTier,
    event.deviceLabel,
    event.observedAt,
  ];
}

/**
 * Durable store of usage sync events, local and remote. Events are addressed by
 * their turn identity, so an event that arrives twice updates the existing row
 * through the domain merge rule instead of accumulating a second copy.
 */
export class WorkLogUsageSyncStore {
  #databaseFile;
  #legacyFile;
  #deviceId;
  #database = null;
  #closed = false;
  #tail = Promise.resolve();

  constructor({ databaseFile, legacyFile = "", deviceId = "" } = {}) {
    if (!databaseFile) throw new TypeError("WorkLogUsageSyncStore requires a databaseFile");
    this.#databaseFile = path.resolve(databaseFile);
    this.#legacyFile = legacyFile ? path.resolve(legacyFile) : "";
    this.#deviceId = String(deviceId ?? "").trim();
  }

  get databaseFile() {
    return this.#databaseFile;
  }

  get file() {
    return this.#databaseFile;
  }

  async #retryBusy(operation) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        if (!sqliteBusy(error) || attempt >= SQLITE_BUSY_RETRY_DELAYS_MS.length) throw error;
        await delay(SQLITE_BUSY_RETRY_DELAYS_MS[attempt]);
      }
    }
  }

  async #open() {
    if (this.#closed) throw new Error("Usage sync store is closed");
    if (this.#database) return this.#database;
    await mkdir(path.dirname(this.#databaseFile), { recursive: true });
    const database = new DatabaseSync(this.#databaseFile);
    this.#database = database;
    try {
      await this.#retryBusy(() => configureUsageSyncDatabase(database));
      await this.#importLegacyFile(database);
      return database;
    } catch (error) {
      this.#database = null;
      database.close();
      throw error;
    }
  }

  /**
   * One-way import of the retired JSON cache. The source file is archived, not
   * deleted, and the import is recorded so a restored copy of the JSON cannot
   * silently reintroduce stale events.
   */
  async #importLegacyFile(database) {
    if (!this.#legacyFile) return;
    const recorded = database.prepare(`
      SELECT value FROM usage_sync_meta WHERE key = 'legacy_json_import'
    `).get();
    if (recorded) return;
    let parsed = null;
    try {
      parsed = JSON.parse(await readFile(this.#legacyFile, "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") return;
      console.error(
        `Ignored unreadable usage sync cache ${this.#legacyFile}: ${String(error?.message ?? error)}`,
      );
      return;
    }
    const events = mergeUsageSyncEvents(parsed?.events ?? []);
    this.#upsert(database, events);
    const archive = `${this.#legacyFile}.migrated-${new Date().toISOString().replaceAll(/[:.]/gu, "-")}`;
    try {
      await rename(this.#legacyFile, archive);
    } catch {
      // Keeping the source in place is safe: the import is already recorded.
    }
    database.prepare(`
      INSERT OR REPLACE INTO usage_sync_meta (key, value) VALUES ('legacy_json_import', ?)
    `).run(JSON.stringify({
      importedAt: new Date().toISOString(),
      source: this.#legacyFile,
      archive,
      events: events.length,
    }));
    if (events.length) {
      console.log(`Imported ${events.length} usage sync event(s) from ${this.#legacyFile}`);
    }
  }

  #readAll(database) {
    return database.prepare(`
      SELECT * FROM usage_sync_events ORDER BY completed_ms, device_id, event_id
    `).all().map(rowToEvent).filter(Boolean);
  }

  #existing(database, eventIds) {
    const found = new Map();
    const ids = [...eventIds];
    for (let index = 0; index < ids.length; index += UPSERT_CHUNK) {
      const slice = ids.slice(index, index + UPSERT_CHUNK);
      const placeholders = slice.map(() => "?").join(",");
      const rows = database.prepare(`
        SELECT * FROM usage_sync_events WHERE event_id IN (${placeholders})
      `).all(...slice);
      for (const row of rows) {
        const event = rowToEvent(row);
        if (event) found.set(event.eventId, event);
      }
    }
    return found;
  }

  /** Applies the domain merge rule and writes only rows that actually change. */
  #upsert(database, events) {
    const incoming = mergeUsageSyncEvents(events);
    if (!incoming.length) return { added: 0, updated: 0 };
    const existing = this.#existing(database, incoming.map((event) => event.eventId));
    const changes = [];
    let added = 0;
    for (const event of incoming) {
      const current = existing.get(event.eventId);
      if (!current) {
        added += 1;
        changes.push(event);
        continue;
      }
      const winner = strongerUsageSyncEvent(current, event);
      if (JSON.stringify(winner) !== JSON.stringify(current)) changes.push(winner);
    }
    if (!changes.length) return { added: 0, updated: 0 };
    const statement = database.prepare(`
      INSERT INTO usage_sync_events (
        event_id, device_id, source, provider, thread_key, task_key,
        completed_at, completed_ms, started_at, account_key,
        account_label, account_type, account_plan, account_attribution,
        estimated_credits, estimate_kind, image_generation_count, context_probe,
        input_tokens, cached_input_tokens, output_tokens,
        reasoning_output_tokens, total_tokens, usage_reported, model, service_tier,
        device_label, observed_at
      ) VALUES (${new Array(28).fill("?").join(", ")})
      ON CONFLICT(event_id) DO UPDATE SET
        device_id = excluded.device_id,
        source = excluded.source,
        provider = excluded.provider,
        thread_key = excluded.thread_key,
        task_key = excluded.task_key,
        completed_at = excluded.completed_at,
        completed_ms = excluded.completed_ms,
        started_at = excluded.started_at,
        account_key = excluded.account_key,
        account_label = excluded.account_label,
        account_type = excluded.account_type,
        account_plan = excluded.account_plan,
        account_attribution = excluded.account_attribution,
        estimated_credits = excluded.estimated_credits,
        estimate_kind = excluded.estimate_kind,
        image_generation_count = excluded.image_generation_count,
        context_probe = excluded.context_probe,
        input_tokens = excluded.input_tokens,
        cached_input_tokens = excluded.cached_input_tokens,
        output_tokens = excluded.output_tokens,
        reasoning_output_tokens = excluded.reasoning_output_tokens,
        total_tokens = excluded.total_tokens,
        usage_reported = excluded.usage_reported,
        model = excluded.model,
        service_tier = excluded.service_tier,
        device_label = excluded.device_label,
        observed_at = excluded.observed_at
    `);
    database.exec("BEGIN IMMEDIATE");
    try {
      for (const event of changes) statement.run(...eventParameters(event));
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
    return { added, updated: changes.length - added };
  }

  #enqueue(operation) {
    const next = this.#tail.catch(() => {}).then(async () => {
      const database = await this.#open();
      return this.#retryBusy(() => operation(database));
    });
    this.#tail = next;
    return next;
  }

  #count(database) {
    return Number(database.prepare("SELECT COUNT(*) AS count FROM usage_sync_events")
      .get()?.count ?? 0);
  }

  events() {
    return this.#enqueue((database) => this.#readAll(database));
  }

  importSnapshot(remoteSnapshot) {
    return this.#enqueue((database) => {
      const before = this.#count(database);
      const events = Array.isArray(remoteSnapshot)
        ? remoteSnapshot
        : remoteSnapshot?.events ?? [];
      const result = this.#upsert(database, events);
      return {
        imported: true,
        before,
        after: this.#count(database),
        added: result.added,
        updated: result.updated,
        file: this.#databaseFile,
      };
    });
  }

  replaceEvents(events) {
    return this.#enqueue((database) => {
      database.exec("DELETE FROM usage_sync_events");
      this.#upsert(database, events);
      return { replaced: this.#count(database), file: this.#databaseFile };
    });
  }

  /**
   * Re-homes locally recorded events from a superseded device id onto the
   * durable identity. The event id identifies the turn, not the device, so it
   * survives the move and a turn already present under the new identity
   * collapses into a single event instead of being counted twice.
   */
  adoptDeviceIds(legacyDeviceIds = []) {
    return this.#enqueue((database) => {
      const legacy = [...new Set(
        (Array.isArray(legacyDeviceIds) ? legacyDeviceIds : [])
          .map((value) => String(value ?? "").trim())
          .filter((value) => value && value !== this.#deviceId),
      )];
      const before = this.#count(database);
      if (!legacy.length || !this.#deviceId) {
        return { migrated: 0, before, after: before, file: this.#databaseFile };
      }
      const placeholders = legacy.map(() => "?").join(",");
      const statement = database.prepare(`
        UPDATE usage_sync_events SET device_id = ? WHERE device_id IN (${placeholders})
      `);
      database.exec("BEGIN IMMEDIATE");
      let migrated = 0;
      try {
        migrated = Number(statement.run(this.#deviceId, ...legacy)?.changes ?? 0);
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
      return { migrated, before, after: this.#count(database), file: this.#databaseFile };
    });
  }

  exportSnapshot(turns = {}, { exportedAt = new Date().toISOString(), deviceLabel = "" } = {}) {
    return usageSyncSnapshotFromLedger(turns, {
      deviceId: this.#deviceId,
      deviceLabel,
      exportedAt,
    });
  }

  async close() {
    this.#closed = true;
    await this.#tail.catch(() => {});
    this.#database?.close();
    this.#database = null;
  }
}

export { USAGE_SYNC_SNAPSHOT_VERSION };
