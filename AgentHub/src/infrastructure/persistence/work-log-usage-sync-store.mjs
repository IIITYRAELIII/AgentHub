import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  normalizeAuthObservation,
  normalizeLimitObservation,
  normalizeUsageFact,
  usageFactIdentity,
  usageFactSummary,
  USAGE_FACT_SCHEMA_VERSION,
  USAGE_FACT_TYPES,
} from "../../domain/usage-facts.mjs";
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
    PRAGMA busy_timeout = 0;
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
    CREATE TABLE IF NOT EXISTS usage_auth_observations (
      observation_id TEXT PRIMARY KEY,
      device_id TEXT NOT NULL,
      installation_instance_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      runtime_home_id TEXT NOT NULL,
      account_key TEXT NOT NULL,
      observed_at TEXT NOT NULL,
      fact_json TEXT NOT NULL
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS usage_auth_observations_device_idx
      ON usage_auth_observations(device_id, provider, runtime_home_id, observed_at);
    CREATE TABLE IF NOT EXISTS usage_limit_observations (
      observation_id TEXT PRIMARY KEY,
      device_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      account_key TEXT NOT NULL,
      limit_id TEXT NOT NULL,
      window TEXT NOT NULL,
      observed_at TEXT NOT NULL,
      fact_json TEXT NOT NULL
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS usage_limit_observations_series_idx
      ON usage_limit_observations(provider, account_key, limit_id, window, observed_at);
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
    ["schema_version", "INTEGER NOT NULL DEFAULT 1"],
    ["runtime_home_id", "TEXT NOT NULL DEFAULT ''"],
    ["limit_samples_json", "TEXT NOT NULL DEFAULT '[]'"],
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
  const generation = database.prepare(`
    SELECT value FROM usage_sync_meta WHERE key = 'local_store_generation'
  `).get()?.value;
  if (!generation) {
    database.prepare(`
      INSERT OR REPLACE INTO usage_sync_meta (key, value) VALUES ('local_store_generation', ?)
    `).run(randomUUID());
  }
}

function parseJson(value, fallback) {
  try {
    return JSON.parse(String(value ?? ""));
  } catch {
    return fallback;
  }
}

function rowToEvent(row) {
  const schemaVersion = Number(row.schema_version ?? 1);
  return normalizeUsageSyncEvent({
    schemaVersion,
    type: "turn",
    eventId: row.event_id,
    deviceId: row.device_id,
    source: row.source,
    provider: row.provider,
    threadKey: row.thread_key,
    taskKey: row.task_key,
    completedAt: row.completed_at,
    startedAt: row.started_at,
    runtimeHomeId: row.runtime_home_id,
    limitSamples: parseJson(row.limit_samples_json, []),
    ...(schemaVersion === USAGE_FACT_SCHEMA_VERSION ? {} : {
      accountKey: row.account_key,
      accountLabel: row.account_label,
      accountType: row.account_type,
      accountPlan: row.account_plan,
      accountAttribution: row.account_attribution,
    }),
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
    event.schemaVersion ?? 1,
    event.eventId,
    event.deviceId,
    event.source,
    event.provider,
    event.threadKey,
    event.taskKey,
    event.completedAt,
    Date.parse(event.completedAt) || 0,
    event.startedAt,
    event.runtimeHomeId ?? "",
    JSON.stringify(event.limitSamples ?? []),
    event.accountKey ?? "",
    event.accountLabel ?? "",
    event.accountType ?? "",
    event.accountPlan ?? "",
    event.accountAttribution ?? "inferred",
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

function comparableEventPayload(event) {
  const {
    deviceId,
    deviceLabel,
    observedAt,
    source,
    ...payload
  } = event ?? {};
  return JSON.stringify(payload);
}

function strongerStoreEvent(current, incoming, localDeviceId) {
  let winner = strongerUsageSyncEvent(current, incoming);
  if (
    localDeviceId
    && incoming.deviceId === localDeviceId
    && current.deviceId !== localDeviceId
    && comparableEventPayload(current) === comparableEventPayload(incoming)
  ) {
    winner = { ...winner, deviceId: localDeviceId, deviceLabel: incoming.deviceLabel || winner.deviceLabel };
  }
  return winner;
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
  #defaultRuntimeHomeIds;
  #database = null;
  #closed = false;
  #tail = Promise.resolve();

  constructor({ databaseFile, legacyFile = "", deviceId = "", defaultRuntimeHomeIds = {} } = {}) {
    if (!databaseFile) throw new TypeError("WorkLogUsageSyncStore requires a databaseFile");
    this.#databaseFile = path.resolve(databaseFile);
    this.#legacyFile = legacyFile ? path.resolve(legacyFile) : "";
    this.#deviceId = String(deviceId ?? "").trim();
    this.#defaultRuntimeHomeIds = Object.fromEntries(
      Object.entries(defaultRuntimeHomeIds ?? {})
        .map(([key, value]) => [String(key ?? "").trim().toLowerCase(), String(value ?? "").trim()])
        .filter(([key, value]) => key && value),
    );
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

  #readAuthObservations(database) {
    return database.prepare(`
      SELECT fact_json FROM usage_auth_observations
      ORDER BY observed_at, device_id, provider, runtime_home_id, observation_id
    `).all()
      .map((row) => normalizeAuthObservation(parseJson(row.fact_json, null)))
      .filter(Boolean);
  }

  #readLimitObservations(database) {
    return database.prepare(`
      SELECT fact_json FROM usage_limit_observations
      ORDER BY observed_at, provider, account_key, limit_id, window, observation_id
    `).all()
      .map((row) => normalizeLimitObservation(parseJson(row.fact_json, null)))
      .filter(Boolean);
  }

  #journalDelta(database, {
    projectRoots = [],
    afterObservedAt = "",
    afterJournalRevision = 0,
  } = {}) {
    const exists = database.prepare(`
      SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'journal_records'
    `).get();
    if (!exists) return { turns: {}, journalRevision: 0, revisionCursor: false };
    const roots = [...new Set((Array.isArray(projectRoots) ? projectRoots : [])
      .map((value) => path.resolve(String(value ?? "").trim()))
      .filter(Boolean))];
    const afterObservedMs = Date.parse(afterObservedAt) || 0;
    const journalRevision = Math.max(0, Number(database.prepare(`
      SELECT value FROM journal_store_meta WHERE key = 'revision'
    `).get()?.value) || 0);
    const columns = new Set(database.prepare("PRAGMA table_info(journal_records)")
      .all().map((row) => row.name));
    const revisionCursor = columns.has("changed_revision");
    const where = [];
    const parameters = [];
    if (revisionCursor) {
      where.push("changed_revision > ? AND changed_revision <= ?");
      parameters.push(Math.max(0, Number(afterJournalRevision) || 0), journalRevision);
    } else if (afterObservedMs > 0) {
      where.push("observed_at_ms >= ?");
      parameters.push(afterObservedMs);
    }
    if (roots.length) {
      where.push(`project_root IN (${roots.map(() => "?").join(", ")})`);
      parameters.push(...roots);
    }
    const rows = database.prepare(`
      SELECT provider, thread_id, turn_id, record_json
      FROM journal_records
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY ${revisionCursor ? "changed_revision" : "observed_at_ms"}, provider, thread_id, turn_id
    `).all(...parameters);
    const turns = {};
    for (const row of rows) {
      try {
        const record = JSON.parse(row.record_json);
        turns[`${row.provider}\0${row.thread_id}\0${row.turn_id}`] = record;
      } catch {
        // Corrupt journal rows stay available for the Journal repair path.
      }
    }
    return { turns, journalRevision, revisionCursor };
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
  #upsert(database, events, { transaction = true } = {}) {
    const byId = new Map();
    for (const value of Array.isArray(events) ? events : []) {
      const event = normalizeUsageSyncEvent(value);
      if (!event) continue;
      const current = byId.get(event.eventId);
      byId.set(event.eventId, current
        ? strongerStoreEvent(current, event, this.#deviceId)
        : event);
    }
    const incoming = [...byId.values()];
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
      const winner = strongerStoreEvent(current, event, this.#deviceId);
      if (JSON.stringify(winner) !== JSON.stringify(current)) changes.push(winner);
    }
    if (!changes.length) return { added: 0, updated: 0 };
    const statement = database.prepare(`
      INSERT INTO usage_sync_events (
        schema_version, event_id, device_id, source, provider, thread_key, task_key,
        completed_at, completed_ms, started_at, runtime_home_id, limit_samples_json, account_key,
        account_label, account_type, account_plan, account_attribution,
        estimated_credits, estimate_kind, image_generation_count, context_probe,
        input_tokens, cached_input_tokens, output_tokens,
        reasoning_output_tokens, total_tokens, usage_reported, model, service_tier,
        device_label, observed_at
      ) VALUES (${new Array(31).fill("?").join(", ")})
      ON CONFLICT(event_id) DO UPDATE SET
        schema_version = excluded.schema_version,
        device_id = excluded.device_id,
        source = excluded.source,
        provider = excluded.provider,
        thread_key = excluded.thread_key,
        task_key = excluded.task_key,
        completed_at = excluded.completed_at,
        completed_ms = excluded.completed_ms,
        started_at = excluded.started_at,
        runtime_home_id = excluded.runtime_home_id,
        limit_samples_json = excluded.limit_samples_json,
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
    if (transaction) database.exec("BEGIN IMMEDIATE");
    try {
      for (const event of changes) statement.run(...eventParameters(event));
      if (transaction) database.exec("COMMIT");
    } catch (error) {
      if (transaction) database.exec("ROLLBACK");
      throw error;
    }
    return { added, updated: changes.length - added };
  }

  #upsertAuthObservations(database, facts) {
    const observations = (Array.isArray(facts) ? facts : [])
      .map(normalizeAuthObservation)
      .filter(Boolean);
    if (!observations.length) return { added: 0, updated: 0 };
    const statement = database.prepare(`
      INSERT INTO usage_auth_observations (
        observation_id, device_id, installation_instance_id, provider,
        runtime_home_id, account_key, observed_at, fact_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(observation_id) DO UPDATE SET
        device_id = excluded.device_id,
        installation_instance_id = excluded.installation_instance_id,
        provider = excluded.provider,
        runtime_home_id = excluded.runtime_home_id,
        account_key = excluded.account_key,
        observed_at = excluded.observed_at,
        fact_json = excluded.fact_json
    `);
    let added = 0;
    let updated = 0;
    for (const fact of observations) {
      const existing = database.prepare(`
        SELECT fact_json FROM usage_auth_observations WHERE observation_id = ?
      `).get(fact.observationId);
      if (!existing) added += 1;
      else if (existing.fact_json !== JSON.stringify(fact)) updated += 1;
      else continue;
      statement.run(
        fact.observationId,
        fact.deviceId,
        fact.installationInstanceId,
        fact.provider,
        fact.runtimeHomeId,
        fact.accountKey,
        fact.observedAt,
        JSON.stringify(fact),
      );
    }
    return { added, updated };
  }

  #upsertLimitObservations(database, facts) {
    const observations = (Array.isArray(facts) ? facts : [])
      .map(normalizeLimitObservation)
      .filter(Boolean);
    if (!observations.length) return { added: 0, updated: 0 };
    const statement = database.prepare(`
      INSERT INTO usage_limit_observations (
        observation_id, device_id, provider, account_key,
        limit_id, window, observed_at, fact_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(observation_id) DO UPDATE SET
        device_id = excluded.device_id,
        provider = excluded.provider,
        account_key = excluded.account_key,
        limit_id = excluded.limit_id,
        window = excluded.window,
        observed_at = excluded.observed_at,
        fact_json = excluded.fact_json
    `);
    let added = 0;
    let updated = 0;
    for (const fact of observations) {
      const existing = database.prepare(`
        SELECT fact_json FROM usage_limit_observations WHERE observation_id = ?
      `).get(fact.observationId);
      if (!existing) added += 1;
      else if (existing.fact_json !== JSON.stringify(fact)) updated += 1;
      else continue;
      statement.run(
        fact.observationId,
        fact.deviceId,
        fact.provider,
        fact.accountKey,
        fact.limitId,
        fact.window,
        fact.observedAt,
        JSON.stringify(fact),
      );
    }
    return { added, updated };
  }

  #upsertFacts(database, facts, { transaction = true } = {}) {
    const turns = [];
    const auth = [];
    const limits = [];
    for (const value of Array.isArray(facts) ? facts : []) {
      const fact = normalizeUsageFact(value);
      if (!fact) continue;
      if (fact.type === USAGE_FACT_TYPES.AUTH_OBSERVATION) auth.push(fact);
      else if (fact.type === USAGE_FACT_TYPES.LIMIT_OBSERVATION) limits.push(fact);
      else turns.push(fact);
    }
    const operation = () => {
      const turnResult = this.#upsert(database, turns, { transaction: false });
      const authResult = this.#upsertAuthObservations(database, auth);
      const limitResult = this.#upsertLimitObservations(database, limits);
      return {
        added: turnResult.added + authResult.added + limitResult.added,
        updated: turnResult.updated + authResult.updated + limitResult.updated,
        turns: turnResult,
        authObservations: authResult,
        limitObservations: limitResult,
      };
    };
    if (!transaction) return operation();
    database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      database.exec("COMMIT");
      return result;
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
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

  #countFacts(database) {
    return this.#count(database)
      + Number(database.prepare("SELECT COUNT(*) AS count FROM usage_auth_observations").get()?.count ?? 0)
      + Number(database.prepare("SELECT COUNT(*) AS count FROM usage_limit_observations").get()?.count ?? 0);
  }

  #localStoreGeneration(database) {
    return String(database.prepare(`
      SELECT value FROM usage_sync_meta WHERE key = 'local_store_generation'
    `).get()?.value ?? "").trim();
  }

  events() {
    return this.#enqueue((database) => this.#readAll(database));
  }

  facts() {
    return this.#enqueue((database) => [
      ...this.#readAll(database),
      ...this.#readAuthObservations(database),
      ...this.#readLimitObservations(database),
    ]);
  }

  usageSyncState() {
    return this.#enqueue((database) => {
      const facts = [
        ...this.#readAll(database),
        ...this.#readAuthObservations(database),
        ...this.#readLimitObservations(database),
      ];
      return {
        localStoreGeneration: this.#localStoreGeneration(database),
        factSummary: usageFactSummary(facts),
      };
    });
  }

  journalTurns(options = {}) {
    return this.#enqueue((database) => this.#journalDelta(database, options).turns);
  }

  usageSyncSnapshot({
    deviceLabel = "",
    afterObservedAt = "",
    afterJournalRevision = 0,
    ownFactsOnly = false,
  } = {}) {
    return this.#enqueue((database) => {
      const delta = this.#journalDelta(database, { afterObservedAt, afterJournalRevision });
      const snapshot = usageSyncSnapshotFromLedger(delta.turns, {
        deviceId: this.#deviceId,
        deviceLabel,
        afterObservedAt: delta.revisionCursor ? "" : afterObservedAt,
        defaultRuntimeHomeIds: this.#defaultRuntimeHomeIds,
      });
      const storeTurns = this.#readAll(database)
        .filter((event) => !ownFactsOnly || event.deviceId === this.#deviceId);
      const authObservations = this.#readAuthObservations(database)
        .filter((fact) => !ownFactsOnly || fact.deviceId === this.#deviceId);
      const limitObservations = this.#readLimitObservations(database)
        .filter((fact) => !ownFactsOnly || fact.deviceId === this.#deviceId);
      return {
        ...snapshot,
        events: [
          ...mergeUsageSyncEvents((afterObservedAt || afterJournalRevision) ? [] : storeTurns, snapshot.events),
          ...authObservations,
          ...limitObservations,
        ],
        journalRevision: delta.journalRevision,
      };
    });
  }

  importSnapshot(remoteSnapshot) {
    return this.#enqueue((database) => {
      const before = this.#countFacts(database);
      const events = Array.isArray(remoteSnapshot)
        ? remoteSnapshot
        : remoteSnapshot?.events ?? [];
      const normalized = events.map(normalizeUsageFact).filter(Boolean);
      const result = this.#upsertFacts(database, normalized);
      return {
        imported: true,
        before,
        after: this.#countFacts(database),
        added: result.added,
        updated: result.updated,
        file: this.#databaseFile,
      };
    });
  }

  reconcileSnapshot(remoteSnapshot) {
    return this.#enqueue((database) => {
      const before = this.#countFacts(database);
      const events = Array.isArray(remoteSnapshot)
        ? remoteSnapshot
        : remoteSnapshot?.events ?? [];
      const normalized = events.map(normalizeUsageFact).filter(Boolean);
      const remoteIds = new Set(normalized.map(usageFactIdentity).filter(Boolean));
      let pruned = 0;
      let result = { added: 0, updated: 0 };
      database.exec("BEGIN IMMEDIATE");
      try {
        result = this.#upsertFacts(database, normalized, { transaction: false });
        for (const [table, idColumn] of [
          ["usage_sync_events", "event_id"],
          ["usage_auth_observations", "observation_id"],
          ["usage_limit_observations", "observation_id"],
        ]) {
          const rows = database.prepare(`
            SELECT ${idColumn} AS id
            FROM ${table}
            WHERE device_id <> ?
          `).all(this.#deviceId);
          const stale = rows.map((row) => row.id).filter((id) => !remoteIds.has(id));
          for (let index = 0; index < stale.length; index += UPSERT_CHUNK) {
            const slice = stale.slice(index, index + UPSERT_CHUNK);
            if (!slice.length) continue;
            const placeholders = slice.map(() => "?").join(",");
            pruned += Number(database.prepare(`
              DELETE FROM ${table} WHERE ${idColumn} IN (${placeholders})
            `).run(...slice)?.changes ?? 0);
          }
        }
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
      return {
        imported: true,
        reconciled: true,
        before,
        after: this.#countFacts(database),
        added: result.added,
        updated: result.updated,
        pruned,
        file: this.#databaseFile,
      };
    });
  }

  replaceEvents(events) {
    return this.#enqueue((database) => {
      database.exec("BEGIN IMMEDIATE");
      try {
        database.exec("DELETE FROM usage_sync_events");
        database.exec("DELETE FROM usage_auth_observations");
        database.exec("DELETE FROM usage_limit_observations");
        this.#upsertFacts(database, events, { transaction: false });
        database.exec("COMMIT");
        return { replaced: this.#count(database), file: this.#databaseFile };
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
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
