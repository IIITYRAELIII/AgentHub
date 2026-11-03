import { createHash, randomUUID } from "node:crypto";
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
import { packageBindingDigest } from "../filesystem/runtime-package-target.mjs";

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

  // Bounded original discovery, never a filesystem/scratch-directory sweep.
  listPackageBackupOriginsReadonly({ after = "", limit = 32 } = {}) {
    const count = Math.min(32, Math.max(1, Math.trunc(limit) || 32));
    const database = new DatabaseSync(runtimeDatabasePath(this.dataDir), { readOnly: true });
    try {
      const rows = database.prepare(`SELECT operation_id, operation_json FROM maintenance_operations
        WHERE kind='restart' AND operation_id > ? AND CASE WHEN json_valid(operation_json)
          THEN json_type(operation_json, '$.metadata.packageBackup') IS NOT NULL ELSE 1 END
        ORDER BY operation_id LIMIT ?`).all(after, count + 1);
      const page = rows.slice(0, count);
      return { items: page.map(row => operationFromRow(row) ?? { operationId: row.operation_id, invalid: true }),
        cursor: page.at(-1)?.operation_id ?? after, done: rows.length <= count };
    } finally { database.close(); }
  }

  latestStorageArtifactReadonly(owner, candidateId) {
    const thread = `${owner}:${createHash("sha256").update(candidateId).digest("hex")}`;
    const database = new DatabaseSync(runtimeDatabasePath(this.dataDir), { readOnly: true });
    try {
      return operationFromRow(database.prepare(`SELECT operation_json FROM maintenance_operations
        WHERE kind='storage-retention' AND stream_id='agent-hub-runtime' AND thread_id=?
        ORDER BY created_at DESC, operation_id DESC LIMIT 1`).get(thread));
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

  assertPackageContinuation(current, request) {
    const metadata = current?.metadata, proof = metadata?.packagePreStopFailure;
    const typed = proof?.schema === 1 && proof.phase === "package-backup-preflight"
      && proof.bindingSha256 === request.expectedBindingSha256 && proof.attempt === (metadata?.packageAttempt ?? 1);
    // Protocol-v1 creation is revision1. Every package native dispatch awaits
    // a committed package-arming revision; subsequent failure consumes another
    // revision. A first failed terminal at revision2 therefore precedes any
    // durable package intent. This is positive revision topology, not an error
    // string or absence-of-process inference, and never a global NO_EFFECT.
    const legacy = proof == null && current?.revision === 2 && current.phase === "failed"
      && current.completedAt === current.updatedAt && metadata?.packageHandoff?.schema === 1
      && metadata.packageAttempt == null && metadata.packageAttemptHistory == null && metadata.packageRecovery == null;
    if (!current || current.kind !== "restart" || current.streamId !== "agent-hub-runtime"
      || current.threadId !== "agent-hub-runtime" || current.status !== "failed" || current.outcome !== "failed"
      || current.revision !== request.expectedRevision || metadata.packageHandoff?.sha256 !== request.expectedBindingSha256
      || metadata.packageInputSha256 !== packageBindingDigest(request.input)
      || !(typed || legacy)
      || ["packageNative", "packageBootstrap", "packageBackup", "packageLaunchAdmission", "packageLaunchSha256", "expectedReleaseId"]
        .some(key => metadata[key] != null)) throw new Error("Original package has no exact failed pre-stop continuation authority");
    if (packageBindingDigest(metadata.packageHandoff.binding) !== metadata.packageHandoff.sha256) {
      throw new Error("Original package binding changed");
    }
    return { kind: typed ? "controller-pre-stop-v1" : "legacy-v1-before-intent", fromRevision: current.revision,
      fromBindingSha256: request.expectedBindingSha256 };
  }

  // A new attempt projection, not a generic terminal reset. Every prior failed
  // attempt and admitted binding remains in this same original's existing row.
  continuePackage(operationId, request) {
    return this.#withDatabase(database => {
      database.exec("BEGIN IMMEDIATE");
      try {
        const current = operationFromRow(database.prepare("SELECT operation_json FROM maintenance_operations WHERE operation_id=?").get(operationId));
        if (current?.metadata?.packageRecovery?.requestSha256 === request.requestSha256) {
          database.exec("COMMIT"); return { operation: current, applied: false };
        }
        const authority = this.assertPackageContinuation(current, request);
        const conflict = database.prepare("SELECT operation_id FROM maintenance_operations WHERE kind='restart' AND stream_id='agent-hub-runtime' AND thread_id='agent-hub-runtime' AND operation_id<>? AND status NOT IN ('succeeded','failed') LIMIT 1").get(operationId);
        if (conflict) throw new Error("Another original restart owns this runtime");
        const old = current.metadata.packageHandoff.binding, fresh = request.packageHandoff?.binding;
        if (!fresh || fresh.operationId !== operationId || packageBindingDigest(fresh) !== request.packageHandoff.sha256
          || fresh.runtimeRoot !== old.runtimeRoot || fresh.dataDir !== old.dataDir
          || packageBindingDigest(fresh.roots) !== packageBindingDigest(old.roots)) throw new Error("Package continuation physical roots changed");
        const publicIdentity = target => ({ ...target, runtimeManifest: target.runtimeManifest
          ? { bytes: target.runtimeManifest.bytes, sha256: target.runtimeManifest.sha256 } : undefined });
        if (packageBindingDigest(publicIdentity(fresh.target)) !== packageBindingDigest(publicIdentity(old.target))) {
          throw new Error("Package continuation public selection changed");
        }
        const prior = structuredClone(current);
        delete prior.metadata.packageAttemptHistory;
        const next = createMaintenanceOperation({ ...current,
          status: request.notification.blockingCount ? "blocked" : "requested",
          phase: request.notification.blockingCount ? "waiting-for-work" : "requested",
          blockers: request.notification.blockingCount ? ["active-work"] : [], outcome: null,
          metadata: { ...request.notification, packageInputSha256: current.metadata.packageInputSha256,
            packageHandoff: request.packageHandoff, packageAttempt: (current.metadata.packageAttempt ?? 1) + 1,
            packageAttemptHistory: [...(current.metadata.packageAttemptHistory ?? []), prior],
            packageRecovery: { requestSha256: request.requestSha256, fromRevision: current.revision,
              fromBindingSha256: request.expectedBindingSha256, authority } }, updatedAt: this.now() });
        next.revision = current.revision + 1;
        const changed = database.prepare("UPDATE maintenance_operations SET status=?,revision=?,operation_json=?,updated_at=? WHERE operation_id=? AND revision=?").run(
          next.status, next.revision, JSON.stringify(next), next.updatedAt, operationId, current.revision);
        if (changed.changes !== 1) throw new Error("Package continuation revision changed");
        database.exec("COMMIT"); return { operation: next, applied: true };
      } catch (error) { database.exec("ROLLBACK"); throw error; }
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
