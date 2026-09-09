import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { AsyncSqliteMutationQueue } from "./async-sqlite-mutation-queue.mjs";

function optionalNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function text(value) {
  return String(value ?? "").trim();
}

function normalize(record) {
  const provider = text(record?.provider).toLowerCase();
  const threadId = text(record?.threadId);
  const turnId = text(record?.turnId);
  if (!provider || !threadId || !turnId) return null;
  const compaction = record?.compaction && typeof record.compaction === "object"
    ? record.compaction
    : {};
  const timeline = Array.isArray(record?.timeline) ? record.timeline.slice(-32) : [];
  return {
    provider,
    threadId,
    turnId,
    workspaceId: text(record?.workspaceId) || null,
    streamId: text(record?.streamId) || null,
    taskThreadId: text(record?.taskThreadId) || threadId,
    runId: text(record?.runId) || null,
    model: text(record?.model) || null,
    serviceTier: text(record?.serviceTier) || null,
    status: text(record?.status) || null,
    finalPhase: text(record?.finalPhase) || null,
    firstEventMethod: text(record?.firstEventMethod) || null,
    lastEventMethod: text(record?.lastEventMethod) || null,
    startedAtMs: optionalNumber(record?.startedAtMs),
    requestedAtMs: optionalNumber(record?.requestedAtMs),
    acceptedAtMs: optionalNumber(record?.acceptedAtMs),
    turnStartedAtMs: optionalNumber(record?.turnStartedAtMs),
    firstEventAtMs: optionalNumber(record?.firstEventAtMs),
    firstContentAtMs: optionalNumber(record?.firstContentAtMs),
    firstVisibleAtMs: optionalNumber(record?.firstVisibleAtMs),
    lastEventAtMs: optionalNumber(record?.lastEventAtMs),
    lastContentAtMs: optionalNumber(record?.lastContentAtMs),
    lastVisibleAtMs: optionalNumber(record?.lastVisibleAtMs),
    completedAtMs: optionalNumber(record?.completedAtMs),
    maxEventGapMs: Math.max(0, optionalNumber(record?.maxEventGapMs) ?? 0),
    maxContentGapMs: Math.max(0, optionalNumber(record?.maxContentGapMs) ?? 0),
    maxVisibleGapMs: Math.max(0, optionalNumber(record?.maxVisibleGapMs) ?? 0),
    compactionCount: Math.max(0, optionalNumber(compaction.count) ?? 0),
    compactionTotalMs: Math.max(0, optionalNumber(compaction.totalMs) ?? 0),
    compactionMaxMs: Math.max(0, optionalNumber(compaction.maxMs) ?? 0),
    timelineJson: JSON.stringify(timeline),
    telemetryJson: JSON.stringify({ ...record, timeline }),
    updatedAtMs: Date.now(),
  };
}

function configure(database) {
  database.exec(`
    PRAGMA busy_timeout = 0;
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    CREATE TABLE IF NOT EXISTS provider_turn_telemetry (
      provider TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      workspace_id TEXT,
      stream_id TEXT,
      task_thread_id TEXT NOT NULL,
      run_id TEXT,
      model TEXT,
      service_tier TEXT,
      status TEXT,
      final_phase TEXT,
      first_event_method TEXT,
      last_event_method TEXT,
      started_at_ms INTEGER,
      requested_at_ms INTEGER,
      accepted_at_ms INTEGER,
      turn_started_at_ms INTEGER,
      first_event_at_ms INTEGER,
      first_content_at_ms INTEGER,
      first_visible_at_ms INTEGER,
      last_event_at_ms INTEGER,
      last_content_at_ms INTEGER,
      last_visible_at_ms INTEGER,
      completed_at_ms INTEGER,
      max_event_gap_ms INTEGER NOT NULL DEFAULT 0,
      max_content_gap_ms INTEGER NOT NULL DEFAULT 0,
      max_visible_gap_ms INTEGER NOT NULL DEFAULT 0,
      compaction_count INTEGER NOT NULL DEFAULT 0,
      compaction_total_ms INTEGER NOT NULL DEFAULT 0,
      compaction_max_ms INTEGER NOT NULL DEFAULT 0,
      timeline_json TEXT NOT NULL DEFAULT '[]',
      telemetry_json TEXT NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      PRIMARY KEY (provider, thread_id, turn_id)
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS provider_turn_telemetry_thread_idx
      ON provider_turn_telemetry(provider, thread_id, started_at_ms DESC, turn_id);
    CREATE INDEX IF NOT EXISTS provider_turn_telemetry_provider_idx
      ON provider_turn_telemetry(provider, started_at_ms DESC, thread_id, turn_id);
    CREATE INDEX IF NOT EXISTS provider_turn_telemetry_stream_idx
      ON provider_turn_telemetry(workspace_id, stream_id, started_at_ms DESC);
    CREATE INDEX IF NOT EXISTS provider_turn_telemetry_completed_idx
      ON provider_turn_telemetry(completed_at_ms)
      WHERE completed_at_ms IS NOT NULL;
  `);
}

export class ProviderTurnTelemetryStore {
  #database = null;
  #databaseFile;
  #mutations = new AsyncSqliteMutationQueue();
  #mutationTimeoutMs;
  #closed = false;

  constructor({ databaseFile, mutationTimeoutMs = 5_000 }) {
    this.#databaseFile = path.resolve(databaseFile);
    this.#mutationTimeoutMs = mutationTimeoutMs;
  }

  #open() {
    if (this.#closed) throw new Error("Provider turn telemetry store is closed");
    if (!this.#database) {
      const database = new DatabaseSync(this.#databaseFile);
      try {
        configure(database);
        this.#database = database;
      } catch (error) {
        database.close();
        throw error;
      }
    }
    return this.#database;
  }

  #enqueue(operation) {
    return this.#mutations.run(operation, { timeoutMs: this.#mutationTimeoutMs });
  }

  initialize() {
    return this.#enqueue(() => {
      this.#open();
      return { ready: true };
    });
  }

  upsert(record) {
    const row = normalize(record);
    if (!row) return Promise.resolve({ upserted: 0 });
    return this.#enqueue(() => {
      const database = this.#open();
      database.prepare(`
        INSERT INTO provider_turn_telemetry (
          provider, thread_id, turn_id, workspace_id, stream_id, task_thread_id, run_id,
          model, service_tier, status, final_phase, first_event_method, last_event_method,
          started_at_ms, requested_at_ms, accepted_at_ms, turn_started_at_ms,
          first_event_at_ms, first_content_at_ms, first_visible_at_ms,
          last_event_at_ms, last_content_at_ms, last_visible_at_ms, completed_at_ms,
          max_event_gap_ms, max_content_gap_ms, max_visible_gap_ms,
          compaction_count, compaction_total_ms, compaction_max_ms,
          timeline_json, telemetry_json, updated_at_ms
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        )
        ON CONFLICT(provider, thread_id, turn_id) DO UPDATE SET
          workspace_id = excluded.workspace_id,
          stream_id = excluded.stream_id,
          task_thread_id = excluded.task_thread_id,
          run_id = excluded.run_id,
          model = excluded.model,
          service_tier = excluded.service_tier,
          status = excluded.status,
          final_phase = excluded.final_phase,
          first_event_method = excluded.first_event_method,
          last_event_method = excluded.last_event_method,
          started_at_ms = excluded.started_at_ms,
          requested_at_ms = excluded.requested_at_ms,
          accepted_at_ms = excluded.accepted_at_ms,
          turn_started_at_ms = excluded.turn_started_at_ms,
          first_event_at_ms = excluded.first_event_at_ms,
          first_content_at_ms = excluded.first_content_at_ms,
          first_visible_at_ms = excluded.first_visible_at_ms,
          last_event_at_ms = excluded.last_event_at_ms,
          last_content_at_ms = excluded.last_content_at_ms,
          last_visible_at_ms = excluded.last_visible_at_ms,
          completed_at_ms = excluded.completed_at_ms,
          max_event_gap_ms = excluded.max_event_gap_ms,
          max_content_gap_ms = excluded.max_content_gap_ms,
          max_visible_gap_ms = excluded.max_visible_gap_ms,
          compaction_count = excluded.compaction_count,
          compaction_total_ms = excluded.compaction_total_ms,
          compaction_max_ms = excluded.compaction_max_ms,
          timeline_json = excluded.timeline_json,
          telemetry_json = excluded.telemetry_json,
          updated_at_ms = excluded.updated_at_ms
      `).run(
        row.provider, row.threadId, row.turnId, row.workspaceId, row.streamId, row.taskThreadId, row.runId,
        row.model, row.serviceTier, row.status, row.finalPhase, row.firstEventMethod, row.lastEventMethod,
        row.startedAtMs, row.requestedAtMs, row.acceptedAtMs, row.turnStartedAtMs,
        row.firstEventAtMs, row.firstContentAtMs, row.firstVisibleAtMs,
        row.lastEventAtMs, row.lastContentAtMs, row.lastVisibleAtMs, row.completedAtMs,
        row.maxEventGapMs, row.maxContentGapMs, row.maxVisibleGapMs,
        row.compactionCount, row.compactionTotalMs, row.compactionMaxMs,
        row.timelineJson, row.telemetryJson, row.updatedAtMs,
      );
      return { upserted: 1 };
    });
  }

  recent({ provider = "", threadId = "", streamId = "", limit = 100 } = {}) {
    return this.#enqueue(() => {
      const clauses = [];
      const parameters = [];
      if (text(provider)) {
        clauses.push("provider = ?");
        parameters.push(text(provider).toLowerCase());
      }
      if (text(threadId)) {
        clauses.push("thread_id = ?");
        parameters.push(text(threadId));
      }
      if (text(streamId)) {
        clauses.push("stream_id = ?");
        parameters.push(text(streamId));
      }
      const rows = this.#open().prepare(`
        SELECT telemetry_json FROM provider_turn_telemetry
        ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
        ORDER BY COALESCE(completed_at_ms, started_at_ms, updated_at_ms) DESC
        LIMIT ?
      `).all(...parameters, Math.min(1_000, Math.max(1, Number(limit) || 100)));
      return rows.flatMap((row) => {
        try {
          return [JSON.parse(row.telemetry_json)];
        } catch {
          return [];
        }
      });
    });
  }

  async close() {
    await this.#enqueue(() => {
      this.#closed = true;
      this.#database?.close();
      this.#database = null;
    });
  }
}
