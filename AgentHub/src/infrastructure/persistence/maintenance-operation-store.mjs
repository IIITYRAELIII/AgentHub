import { randomUUID } from "node:crypto";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  createMaintenanceOperation,
  MAINTENANCE_OPERATION_KINDS,
  MAINTENANCE_OPERATION_STATUSES,
  maintenanceOperationIsTerminal,
  restoreMaintenanceOperation,
  transitionMaintenanceOperation,
  unknownMaintenanceOutcome,
} from "../../domain/maintenance-operation.mjs";
import { openRuntimeDatabase, runtimeDatabasePath } from "./runtime-state-store.mjs";
import { AsyncSqliteMutationQueue } from "./async-sqlite-mutation-queue.mjs";

const LEGACY_RESTART_MIGRATION_KEY = "maintenance-operations:legacy-restart:v1";

function operationFromRow(row) {
  if (!row?.operation_json) return null;
  try {
    return restoreMaintenanceOperation(JSON.parse(row.operation_json));
  } catch {
    return null;
  }
}

function configure(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS maintenance_operations (
      operation_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      stream_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      provider_turn_id TEXT,
      status TEXT NOT NULL,
      revision INTEGER NOT NULL,
      operation_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS maintenance_operations_scope_idx
      ON maintenance_operations(kind, stream_id, thread_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS maintenance_operations_status_idx
      ON maintenance_operations(status, updated_at DESC);
    CREATE INDEX IF NOT EXISTS maintenance_operations_provider_turn_idx
      ON maintenance_operations(kind, thread_id, provider_turn_id, updated_at DESC);
  `);
}

function writeOperation(database, operation) {
  database.prepare(`
    INSERT INTO maintenance_operations
      (operation_id, kind, stream_id, thread_id, provider_turn_id, status,
       revision, operation_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    operation.operationId,
    operation.kind,
    operation.streamId,
    operation.threadId,
    operation.providerTurnId,
    operation.status,
    operation.revision,
    JSON.stringify(operation),
    operation.createdAt,
    operation.updatedAt,
  );
}

export class MaintenanceOperationStore {
  #initialized = false;
  #restartMutations = new AsyncSqliteMutationQueue();

  constructor({ dataDir, idFactory = randomUUID, now = () => new Date().toISOString() } = {}) {
    if (!String(dataDir ?? "").trim()) throw new TypeError("dataDir is required");
    this.dataDir = path.resolve(dataDir);
    this.idFactory = idFactory;
    this.now = now;
  }

  runRestartMutation(operation, options = {}) {
    return this.#restartMutations.run(operation, options);
  }

  #withDatabase(callback) {
    const database = this.#initialized
      ? new DatabaseSync(runtimeDatabasePath(this.dataDir))
      : openRuntimeDatabase(this.dataDir);
    try {
      if (!this.#initialized) {
        configure(database);
        this.#initialized = true;
      } else {
        // Schema migration belongs to initialization, never an exact lifecycle
        // read while another runtime owner holds the WAL writer reservation.
        database.exec("PRAGMA synchronous = FULL; PRAGMA busy_timeout = 0;");
      }
      return callback(database);
    } finally {
      database.close();
    }
  }

  create(input = {}) {
    const operation = createMaintenanceOperation({
      ...input,
      operationId: input.operationId ?? this.idFactory(),
      createdAt: input.createdAt ?? this.now(),
      updatedAt: input.updatedAt ?? input.createdAt ?? this.now(),
    });
    return this.#withDatabase((database) => {
      const existing = operationFromRow(database.prepare(
        "SELECT operation_json FROM maintenance_operations WHERE operation_id = ?",
      ).get(operation.operationId));
      if (existing) {
        for (const name of ["kind", "streamId", "threadId"]) {
          if (existing[name] !== operation[name]) throw new Error(`operation identity conflict: ${name}`);
        }
        return existing;
      }
      writeOperation(database, operation);
      return operation;
    });
  }

  get(operationId) {
    const id = String(operationId ?? "").trim();
    if (!id) return null;
    return this.#withDatabase((database) => operationFromRow(database.prepare(
      "SELECT operation_json FROM maintenance_operations WHERE operation_id = ?",
    ).get(id)));
  }

  // Evidence consumers must not initialize/migrate a runtime or acquire its WAL
  // writer merely to observe an existing original. The ordinary writer is unchanged.
  getReadonly(operationId) {
    const database = new DatabaseSync(runtimeDatabasePath(this.dataDir), { readOnly: true });
    try {
      return operationFromRow(database.prepare(
        "SELECT operation_json FROM maintenance_operations WHERE operation_id = ?",
      ).get(operationId));
    } finally { database.close(); }
  }

  activeFor({ kind, streamId, threadId } = {}) {
    return this.#withDatabase((database) => operationFromRow(database.prepare(`
      SELECT operation_json FROM maintenance_operations
      WHERE kind = ? AND stream_id = ? AND thread_id = ?
        AND status NOT IN ('succeeded', 'failed')
      ORDER BY updated_at DESC, revision DESC LIMIT 1
    `).get(String(kind ?? ""), String(streamId ?? ""), String(threadId ?? ""))));
  }

  activeForReadonly({ kind, streamId, threadId } = {}) {
    const database = new DatabaseSync(runtimeDatabasePath(this.dataDir), { readOnly: true });
    try {
      return operationFromRow(database.prepare(`
        SELECT operation_json FROM maintenance_operations
        WHERE kind = ? AND stream_id = ? AND thread_id = ?
          AND status NOT IN ('succeeded', 'failed')
        ORDER BY updated_at DESC, revision DESC LIMIT 1
      `).get(String(kind ?? ""), String(streamId ?? ""), String(threadId ?? "")));
    } finally { database.close(); }
  }

  forProviderTurn({ kind, threadId, providerTurnId } = {}) {
    const exactKind = String(kind ?? "").trim();
    const exactThreadId = String(threadId ?? "").trim();
    const exactTurnId = String(providerTurnId ?? "").trim();
    if (!exactKind || !exactThreadId || !exactTurnId) return null;
    return this.#withDatabase((database) => operationFromRow(database.prepare(`
      SELECT operation_json FROM maintenance_operations
      WHERE kind = ? AND thread_id = ? AND provider_turn_id = ?
      ORDER BY updated_at DESC LIMIT 1
    `).get(exactKind, exactThreadId, exactTurnId)));
  }

  transition(operationId, patch = {}, options = {}) {
    const id = String(operationId ?? "").trim();
    if (!id) throw new TypeError("operationId is required");
    return this.#withDatabase((database) => {
      database.exec("BEGIN IMMEDIATE");
      try {
        const current = operationFromRow(database.prepare(
          "SELECT operation_json FROM maintenance_operations WHERE operation_id = ?",
        ).get(id));
        if (!current) {
          database.exec("ROLLBACK");
          return { operation: null, applied: false, reason: "not-found" };
        }
        const result = transitionMaintenanceOperation(current, patch, {
          expectedRevision: options.expectedRevision ?? current.revision,
          updatedAt: options.updatedAt ?? this.now(),
        });
        if (!result.applied) {
          database.exec("ROLLBACK");
          return result;
        }
        const update = database.prepare(`
          UPDATE maintenance_operations
          SET provider_turn_id = ?, status = ?, revision = ?, operation_json = ?, updated_at = ?
          WHERE operation_id = ? AND revision = ?
        `).run(
          result.operation.providerTurnId,
          result.operation.status,
          result.operation.revision,
          JSON.stringify(result.operation),
          result.operation.updatedAt,
          id,
          current.revision,
        );
        if (update.changes !== 1) throw new Error("maintenance operation revision conflict");
        database.exec("COMMIT");
        return result;
      } catch (error) {
        try { database.exec("ROLLBACK"); } catch {}
        throw error;
      }
    });
  }

  recoverInterrupted({ operationIds = null, kind = null } = {}) {
    return this.#withDatabase((database) => {
      const ids = new Set((Array.isArray(operationIds) ? operationIds : [])
        .map((value) => String(value ?? "").trim()).filter(Boolean));
      const rows = database.prepare(`
        SELECT operation_json FROM maintenance_operations
        WHERE status IN ('requested', 'blocked', 'running')
        ORDER BY updated_at, operation_id
      `).all();
      const recovered = [];
      for (const row of rows) {
        const current = operationFromRow(row);
        if (!current || (ids.size && !ids.has(current.operationId)) || (kind && current.kind !== kind)) continue;
        const result = unknownMaintenanceOutcome(current, { updatedAt: this.now() });
        if (!result.applied) continue;
        database.prepare(`
          UPDATE maintenance_operations
          SET status = ?, revision = ?, operation_json = ?, updated_at = ?
          WHERE operation_id = ? AND revision = ?
        `).run(
          result.operation.status,
          result.operation.revision,
          JSON.stringify(result.operation),
          result.operation.updatedAt,
          current.operationId,
          current.revision,
        );
        recovered.push(result.operation);
      }
      return recovered;
    });
  }

  migrateLegacyRestart(legacyRequest, { streamId, threadId } = {}) {
    return this.#withDatabase((database) => {
      database.exec("BEGIN IMMEDIATE");
      try {
        const migrate = () => {
          const marker = database.prepare(
            "SELECT value FROM runtime_store_meta WHERE key = ?",
          ).get(LEGACY_RESTART_MIGRATION_KEY);
          if (marker) {
            const operationId = String(legacyRequest?.operationId ?? "").trim();
            return operationId
              ? operationFromRow(database.prepare(
                "SELECT operation_json FROM maintenance_operations WHERE operation_id = ?",
              ).get(operationId))
              : null;
          }
          if (legacyRequest && typeof legacyRequest === "object" && (!streamId || !threadId)) {
            return null;
          }
          let operation = null;
          if (legacyRequest && typeof legacyRequest === "object" && streamId && threadId) {
            operation = createMaintenanceOperation({
              operationId: String(legacyRequest.operationId ?? "").trim() || this.idFactory(),
              kind: MAINTENANCE_OPERATION_KINDS.RESTART,
              streamId,
              threadId,
              status: legacyRequest.waitingForRuns
                ? MAINTENANCE_OPERATION_STATUSES.BLOCKED
                : MAINTENANCE_OPERATION_STATUSES.RUNNING,
              phase: legacyRequest.waitingForRuns ? "waiting-for-work" : "cutover",
              blockers: legacyRequest.waitingForRuns ? ["active-work"] : [],
              metadata: {
                chatId: legacyRequest.chatId,
                messageId: legacyRequest.messageId,
                minimumUpdateOffset: legacyRequest.minimumUpdateOffset,
                notifyTelegram: legacyRequest.notifyTelegram === true,
              },
              createdAt: legacyRequest.requestedAt || this.now(),
              updatedAt: this.now(),
            });
            const existing = operationFromRow(database.prepare(
              "SELECT operation_json FROM maintenance_operations WHERE operation_id = ?",
            ).get(operation.operationId));
            if (existing) operation = existing;
            else writeOperation(database, operation);
          }
          // Removal condition: delete this import path after every supported installation has
          // recorded this marker for one production release; the operation table remains canonical.
          database.prepare(`
            INSERT INTO runtime_store_meta(key, value) VALUES (?, ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value
          `).run(LEGACY_RESTART_MIGRATION_KEY, this.now());
          return operation;
        };
        const result = migrate();
        database.exec("COMMIT");
        return result;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    });
  }

  latestRestart({ streamId, threadId } = {}) {
    const exactStreamId = String(streamId ?? "").trim();
    const exactThreadId = String(threadId ?? "").trim();
    if (!exactStreamId || !exactThreadId) return null;
    return this.#withDatabase((database) => operationFromRow(database.prepare(`
      SELECT operation_json FROM maintenance_operations
      WHERE kind = ? AND stream_id = ? AND thread_id = ?
        AND status NOT IN ('succeeded', 'failed')
      ORDER BY updated_at DESC, revision DESC LIMIT 1
    `).get(MAINTENANCE_OPERATION_KINDS.RESTART, exactStreamId, exactThreadId)));
  }

  latestSettledRestart({ since = "" } = {}) {
    return this.#withDatabase((database) => operationFromRow(database.prepare(`
      SELECT operation_json FROM maintenance_operations
      WHERE kind = ? AND status IN (?, ?) AND updated_at >= ?
      ORDER BY updated_at DESC, revision DESC LIMIT 1
    `).get(
      MAINTENANCE_OPERATION_KINDS.RESTART,
      MAINTENANCE_OPERATION_STATUSES.SUCCEEDED,
      MAINTENANCE_OPERATION_STATUSES.FAILED,
      String(since ?? ""),
    )));
  }

  settle(operationId, { succeeded, phase, metadata = {} } = {}) {
    const current = this.get(operationId);
    if (!current || maintenanceOperationIsTerminal(current)) return current;
    return this.transition(operationId, {
      status: succeeded
        ? MAINTENANCE_OPERATION_STATUSES.SUCCEEDED
        : MAINTENANCE_OPERATION_STATUSES.FAILED,
      phase: phase ?? (succeeded ? "completed" : "failed"),
      outcome: succeeded ? "succeeded" : "failed",
      blockers: [],
      metadata,
    }, { expectedRevision: current.revision }).operation;
  }
}
