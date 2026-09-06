import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { normalizeCommandTraceSpan } from "../../domain/command-trace-span.mjs";

const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const DEFAULT_MAX_SPANS = 250_000;
const MAX_BATCH_SIZE = 10_000;
const MAX_TIMELINE_LIMIT = 5_000;

function positiveInteger(value, name) {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 1) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return normalized;
}

function optionalEpoch(value, name) {
  if (value === undefined || value === null) return null;
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 0) {
    throw new TypeError(`${name} must be a non-negative UTC epoch integer`);
  }
  return normalized;
}

function optionalToken(value, name) {
  if (value === undefined || value === null || String(value).trim() === "") return null;
  const normalized = String(value).trim().toLowerCase();
  if (!/^[a-z][a-z0-9.-]{0,63}$/u.test(normalized)) {
    throw new TypeError(`${name} must be a lowercase trace token`);
  }
  return normalized;
}

function normalizePercentiles(values) {
  const input = values ?? [0.5, 0.95, 0.99];
  if (!Array.isArray(input) || input.length < 1 || input.length > 10) {
    throw new TypeError("percentiles must contain between 1 and 10 quantiles");
  }
  return [...new Set(input.map((value) => {
    const normalized = Number(value);
    if (!Number.isFinite(normalized) || normalized < 0 || normalized > 1) {
      throw new TypeError("each percentile must be between 0 and 1");
    }
    return normalized;
  }))].sort((left, right) => left - right);
}

function percentile(sorted, quantile) {
  if (!sorted.length) return null;
  const index = Math.max(0, Math.ceil(quantile * sorted.length) - 1);
  return sorted[index];
}

function parseMetadata(serialized) {
  try {
    const value = JSON.parse(serialized);
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

function configure(database) {
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA busy_timeout = 0;
    CREATE TABLE IF NOT EXISTS command_trace_spans (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      span_id TEXT NOT NULL UNIQUE,
      command_id TEXT NOT NULL,
      stage TEXT NOT NULL,
      outcome TEXT NOT NULL,
      transport TEXT NOT NULL,
      observed_at_ms INTEGER NOT NULL,
      monotonic_duration_ms REAL NOT NULL,
      queue_depth INTEGER,
      lock_wait_ms REAL,
      sqlite_busy_wait_ms REAL,
      metadata_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS command_trace_spans_command_timeline
      ON command_trace_spans(command_id, observed_at_ms, sequence);
    CREATE INDEX IF NOT EXISTS command_trace_spans_stage_observed
      ON command_trace_spans(stage, observed_at_ms);
    CREATE TRIGGER IF NOT EXISTS command_trace_spans_append_only
      BEFORE UPDATE ON command_trace_spans
      BEGIN
        SELECT RAISE(ABORT, 'command trace spans are append-only');
      END;
  `);
}

function rowToSpan(row) {
  return {
    sequence: Number(row.sequence),
    spanId: row.span_id,
    commandId: row.command_id,
    stage: row.stage,
    outcome: row.outcome,
    transport: row.transport,
    observedAtMs: Number(row.observed_at_ms),
    monotonicDurationMs: Number(row.monotonic_duration_ms),
    queueDepth: row.queue_depth === null ? null : Number(row.queue_depth),
    lockWaitMs: row.lock_wait_ms === null ? null : Number(row.lock_wait_ms),
    sqliteBusyWaitMs: row.sqlite_busy_wait_ms === null ? null : Number(row.sqlite_busy_wait_ms),
    metadata: parseMetadata(row.metadata_json),
  };
}

export class CommandTraceSpanStore {
  #database = null;
  #tail = Promise.resolve();
  #closed = false;

  constructor({
    databaseFile,
    retentionMs = DEFAULT_RETENTION_MS,
    maxSpans = DEFAULT_MAX_SPANS,
    clock = Date.now,
  }) {
    if (!databaseFile) throw new TypeError("databaseFile is required");
    this.databaseFile = path.resolve(databaseFile);
    this.retentionMs = positiveInteger(retentionMs, "retentionMs");
    this.maxSpans = positiveInteger(maxSpans, "maxSpans");
    this.clock = clock;
  }

  #open() {
    if (this.#closed) throw new Error("command trace span store is closed");
    if (!this.#database) {
      mkdirSync(path.dirname(this.databaseFile), { recursive: true });
      this.#database = new DatabaseSync(this.databaseFile);
      configure(this.#database);
    }
    return this.#database;
  }

  #enqueue(operation) {
    const next = this.#tail.then(operation, operation);
    this.#tail = next.catch(() => {});
    return next;
  }

  #prune(database, nowMs = this.clock()) {
    const expired = database.prepare(`
      DELETE FROM command_trace_spans
      WHERE observed_at_ms < ?
    `).run(Math.max(0, Number(nowMs) - this.retentionMs)).changes;
    const overflow = database.prepare(`
      DELETE FROM command_trace_spans
      WHERE sequence <= COALESCE((
        SELECT sequence
        FROM command_trace_spans
        ORDER BY sequence DESC
        LIMIT 1 OFFSET ?
      ), -1)
    `).run(this.maxSpans).changes;
    return Number(expired) + Number(overflow);
  }

  initialize() {
    return this.#enqueue(() => {
      this.#open();
      return { ready: true };
    });
  }

  append(span) {
    return this.appendMany([span]).then((result) => ({
      appended: result.appended,
      duplicate: result.duplicates === 1,
      pruned: result.pruned,
    }));
  }

  appendMany(spans) {
    if (!Array.isArray(spans) || spans.length < 1 || spans.length > MAX_BATCH_SIZE) {
      throw new TypeError(`spans must contain between 1 and ${MAX_BATCH_SIZE} items`);
    }
    const normalized = spans.map((span) => normalizeCommandTraceSpan(span, { clock: this.clock }));
    return this.#enqueue(() => {
      const database = this.#open();
      const insert = database.prepare(`
        INSERT OR IGNORE INTO command_trace_spans (
          span_id, command_id, stage, outcome, transport, observed_at_ms,
          monotonic_duration_ms, queue_depth, lock_wait_ms, sqlite_busy_wait_ms,
          metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      let appended = 0;
      database.exec("BEGIN IMMEDIATE");
      try {
        for (const span of normalized) {
          appended += Number(insert.run(
            span.spanId,
            span.commandId,
            span.stage,
            span.outcome,
            span.transport,
            span.observedAtMs,
            span.monotonicDurationMs,
            span.queueDepth,
            span.lockWaitMs,
            span.sqliteBusyWaitMs,
            JSON.stringify(span.metadata),
          ).changes);
        }
        const pruned = this.#prune(database);
        database.exec("COMMIT");
        return { appended, duplicates: normalized.length - appended, pruned };
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    });
  }

  readCommandTimeline(commandId, { afterSequence = 0, limit = 500 } = {}) {
    const normalizedCommandId = String(commandId ?? "").trim();
    if (!normalizedCommandId) throw new TypeError("commandId is required");
    const normalizedAfter = Number(afterSequence);
    if (!Number.isSafeInteger(normalizedAfter) || normalizedAfter < 0) {
      throw new TypeError("afterSequence must be a non-negative safe integer");
    }
    const normalizedLimit = Math.min(MAX_TIMELINE_LIMIT, positiveInteger(limit, "limit"));
    return this.#enqueue(() => this.#open().prepare(`
      SELECT *
      FROM command_trace_spans
      WHERE command_id = ? AND sequence > ?
      ORDER BY observed_at_ms ASC, sequence ASC
      LIMIT ?
    `).all(normalizedCommandId, normalizedAfter, normalizedLimit).map(rowToSpan));
  }

  readStagePercentiles({
    stage = null,
    transport = null,
    outcome = null,
    fromMs = null,
    toMs = null,
    percentiles = [0.5, 0.95, 0.99],
  } = {}) {
    const normalizedStage = optionalToken(stage, "stage");
    const normalizedTransport = optionalToken(transport, "transport");
    const normalizedOutcome = optionalToken(outcome, "outcome");
    const normalizedFromMs = optionalEpoch(fromMs, "fromMs");
    const normalizedToMs = optionalEpoch(toMs, "toMs");
    if (normalizedFromMs !== null && normalizedToMs !== null && normalizedFromMs > normalizedToMs) {
      throw new TypeError("fromMs must not be greater than toMs");
    }
    const quantiles = normalizePercentiles(percentiles);
    return this.#enqueue(() => {
      const clauses = [];
      const parameters = [];
      for (const [column, value] of [
        ["stage", normalizedStage],
        ["transport", normalizedTransport],
        ["outcome", normalizedOutcome],
      ]) {
        if (value !== null) {
          clauses.push(`${column} = ?`);
          parameters.push(value);
        }
      }
      if (normalizedFromMs !== null) {
        clauses.push("observed_at_ms >= ?");
        parameters.push(normalizedFromMs);
      }
      if (normalizedToMs !== null) {
        clauses.push("observed_at_ms <= ?");
        parameters.push(normalizedToMs);
      }
      const rows = this.#open().prepare(`
        SELECT stage, monotonic_duration_ms
        FROM command_trace_spans
        ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
        ORDER BY stage ASC, monotonic_duration_ms ASC
      `).all(...parameters);
      const groups = new Map();
      for (const row of rows) {
        const durations = groups.get(row.stage) ?? [];
        durations.push(Number(row.monotonic_duration_ms));
        groups.set(row.stage, durations);
      }
      return [...groups.entries()].map(([groupStage, durations]) => ({
        stage: groupStage,
        sampleCount: durations.length,
        minMs: durations[0],
        maxMs: durations.at(-1),
        percentiles: quantiles.map((quantile) => ({
          quantile,
          durationMs: percentile(durations, quantile),
        })),
      }));
    });
  }

  prune() {
    return this.#enqueue(() => {
      const database = this.#open();
      database.exec("BEGIN IMMEDIATE");
      try {
        const pruned = this.#prune(database);
        database.exec("COMMIT");
        return { pruned };
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    });
  }

  async close() {
    if (this.#closed) return;
    await this.#tail;
    this.#closed = true;
    this.#database?.close();
    this.#database = null;
  }
}

export const COMMAND_TRACE_RETENTION_DEFAULTS = Object.freeze({
  retentionMs: DEFAULT_RETENTION_MS,
  maxSpans: DEFAULT_MAX_SPANS,
});
