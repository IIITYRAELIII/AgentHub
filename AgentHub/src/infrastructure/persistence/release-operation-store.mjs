import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { selectedCompositionIdentity } from "../../domain/task-selected-composition.mjs";
import { normalizedOwnGitPublication } from "../../domain/release-base-provenance.mjs";

import {
  createCandidateGeneration,
  effectiveReleaseTaskIds,
  createReleaseOperation,
  RELEASE_OPERATION_STATES,
  releaseIdentitySha256,
  releaseApprovedTargets,
  releaseOperationIsTerminal,
  restoreReleaseOperation,
  transitionReleaseOperation,
} from "../../domain/release-operation.mjs";
import { openRuntimeDatabase, runtimeDatabasePath } from "./runtime-state-store.mjs";
import { AsyncSqliteMutationQueue, sqliteContention } from "./async-sqlite-mutation-queue.mjs";

const LEGACY_MIGRATION_PREFIX = "release-operation:legacy:";

// Git publication is a narrower fact than successful runtime delivery. Reuse
// existing immutable generation/receipt authority; never advance publication
// state, main, an operation, or an installed runtime from this read.
export function readOwnGitPublicationOrigin({ dataDir, repositoryRoot, localMainCommit,
  publishedRevision, originCommit, taskIds = [] } = {}) {
  if (![localMainCommit, publishedRevision, originCommit].every(value => /^[a-f0-9]{40}$/u.test(value ?? ""))
      || !taskIds.length || !existsSync(runtimeDatabasePath(dataDir))) return null;
  const rootKey = value => path.resolve(String(value)).replaceAll("\\", "/").toLowerCase();
  const db = new DatabaseSync(runtimeDatabasePath(dataDir), { readOnly: true });
  try {
    db.exec("BEGIN");
    if (db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name IN ('release_operations','release_operation_tasks','release_candidate_generations','release_step_receipts')").get().count !== 4) return null;
    const rows = db.prepare(`SELECT o.operation_json, g.generation_json, g.identity_sha256
      FROM release_operations o JOIN release_candidate_generations g ON g.operation_id=o.operation_id
      WHERE EXISTS (SELECT 1 FROM release_operation_tasks t WHERE t.operation_id=o.operation_id
        AND t.task_id IN (${taskIds.map(() => "?").join(",")}))
      AND EXISTS (SELECT 1 FROM json_each(g.generation_json, '$.candidates') c
        WHERE json_extract(c.value, '$.commit')=?)`).all(...taskIds, originCommit);
    const matches = [];
    for (const row of rows) {
      const operation = JSON.parse(row.operation_json), generation = JSON.parse(row.generation_json);
      const { fingerprint, ...authorization } = operation.authorization;
      if (releaseIdentitySha256(authorization) !== fingerprint) throw new Error("OWN Git publication authorization changed");
      const { identitySha256, ...contents } = generation;
      if (identitySha256 !== row.identity_sha256 || releaseIdentitySha256(contents) !== identitySha256) {
        throw new Error("OWN Git publication generation changed");
      }
      if (generation.operationId !== operation.operationId) continue;
      const selected = items => items.map(item => `${item.taskId}:${item.resultCommit}`).sort();
      if (JSON.stringify([...(generation.authorizedTaskIds ?? authorization.taskIds)].sort())
          !== JSON.stringify(generation.selectedResults.map(item => item.taskId).sort())) continue;
      const candidates = generation.candidates.filter(item => rootKey(item.repositoryRoot) === rootKey(repositoryRoot)
        && item.commit === originCommit);
      if (candidates.length !== 1) continue;
      const candidate = candidates[0], manifest = candidate.manifest, provenance = manifest?.baseProvenance;
      if (manifest?.workspaceId !== operation.workspaceId || manifest.compositionPolicy !== "main-selected-git-merge-v1"
          || provenance?.publishedBaseCommit !== publishedRevision || provenance.agreedMainCommit !== localMainCommit
          || JSON.stringify(selected(manifest.tasks ?? [])) !== JSON.stringify(selected(generation.selectedResults))) continue;
      const targets = releaseApprovedTargets(restoreReleaseOperation(operation)).filter(target => target.kind === "agent-hub-publication"
        && rootKey(target.repositoryRoot) === rootKey(repositoryRoot) && target.approvedLocalMainCommit === localMainCommit
        && target.approvedOriginMainCommit === (provenance.approvedOriginMainCommit ?? publishedRevision));
      if (targets.length !== 1) continue;
      const receipts = db.prepare("SELECT receipt_json FROM release_step_receipts WHERE operation_id=? AND generation=? AND step_id IN (?, ?)")
        .all(operation.operationId, generation.generation, "validate", `publish:${targets[0].targetId}`)
        .map(record => JSON.parse(record.receipt_json));
      const exact = receipt => receipt.operationId === operation.operationId && receipt.generation === generation.generation
        && receipt.input?.candidate === identitySha256 && receipt.inputSha256 === releaseIdentitySha256(receipt.input);
      if (!receipts.some(receipt => exact(receipt) && receipt.stepId === "validate" && receipt.status === "applied")
          || !receipts.some(receipt => exact(receipt) && receipt.stepId === `publish:${targets[0].targetId}`
            && releaseIdentitySha256(receipt.input.target) === releaseIdentitySha256(targets[0]))) continue;
      matches.push(normalizedOwnGitPublication({ kind: "validated-own-git-publication-v1",
        operationId: operation.operationId, generation: generation.generation, identitySha256,
        repositoryRoot: candidate.repositoryRoot, publishedBaseCommit: publishedRevision,
        agreedMainCommit: localMainCommit, commit: candidate.commit, tree: candidate.tree }));
    }
    if (matches.length > 1) throw new Error("OWN Git publication origin is ambiguous");
    return matches[0] ?? null;
  } finally {
    try { db.exec("ROLLBACK"); } finally { db.close(); }
  }
}

// Read-only OWN publication fact: immutable original, validated generation and
// descriptor matching the actual remote, independent of later operation state.
export function readNativePublishedSelectedComposition({ dataDir, preview, remoteCommit } = {}) {
  const file = runtimeDatabasePath(dataDir);
  if (!existsSync(file) || !/^[a-f0-9]{40}$/u.test(remoteCommit ?? "")) return null;
  const database = new DatabaseSync(file, { readOnly: true });
  const rootKey = value => path.resolve(String(value)).replaceAll("\\", "/").toLowerCase();
  try {
    database.exec("BEGIN");
    if (database.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name IN ('release_operations','release_operation_tasks','release_candidate_generations','release_step_receipts')").get().count !== 4) return null;
    const rows = database.prepare(`
      SELECT o.operation_json, g.generation_json, g.identity_sha256
      FROM release_operations o
      JOIN release_operation_tasks t ON t.operation_id = o.operation_id
      JOIN release_candidate_generations g ON g.operation_id = o.operation_id
      WHERE t.task_id = ?
      ORDER BY o.updated_at DESC, g.generation DESC LIMIT 65
    `).all(preview.taskId);
    if (rows.length > 64) throw new Error("Published selected proof history exceeds its bound");
    const identity = selectedCompositionIdentity({ taskId: preview.taskId,
      resultCommit: preview.taskCommit, selectedComposition: preview });
    const matches = [];
    for (const row of rows) {
      const operation = JSON.parse(row.operation_json);
      const generation = JSON.parse(row.generation_json);
      if (operation.authorization?.nativeOwnerCutover?.kind !== "native-publication-owner-v1"
          || operation.authorization.nativeOwnerCutover.schemaVersion !== 1
          || operation.workspaceId !== preview.authority?.workspaceId
          || generation.operationId !== operation.operationId) continue;
      const { fingerprint, ...authorization } = operation.authorization;
      if (releaseIdentitySha256(authorization) !== fingerprint) {
        throw new Error("Published original authorization identity changed");
      }
      const { identitySha256, ...contents } = generation;
      if (identitySha256 !== row.identity_sha256 || releaseIdentitySha256(contents) !== identitySha256) {
        throw new Error("Published native generation identity changed");
      }
      if (JSON.stringify([...(generation.authorizedTaskIds ?? operation.authorization.taskIds)].sort())
          !== JSON.stringify(generation.selectedResults.map(task => task.taskId).sort())) continue;
      const selected = generation.selectedResults.find(task => task.taskId === preview.taskId);
      if (!selected || selected.resultCommit !== preview.taskCommit
          || selectedCompositionIdentity(selected) !== identity) continue;
      const candidate = generation.candidates.find(item => rootKey(item.repositoryRoot) === rootKey(preview.repositoryRoot)
        && item.commit === remoteCommit);
      const manifest = candidate?.manifest;
      const captured = manifest?.tasks?.find(task => task.taskId === preview.taskId);
      if (!candidate || manifest?.workspaceId !== operation.workspaceId
          || manifest.compositionPolicy !== "main-selected-git-merge-v1"
          || manifest.baseProvenance?.publishedBaseCommit !== preview.publishedCommit
          || !captured || captured.resultCommit !== preview.taskCommit
          || selectedCompositionIdentity(captured) !== identity) continue;
      const validated = database.prepare(`SELECT status FROM release_step_receipts
        WHERE operation_id = ? AND generation = ? AND step_id = 'validate'
        ORDER BY attempt DESC LIMIT 1`).get(operation.operationId, generation.generation);
      if (validated?.status !== "applied") continue;
      matches.push({ operationId: operation.operationId, generation: generation.generation,
        identitySha256, publishedCommit: remoteCommit, selectedCompositionIdentity: identity });
    }
    if (matches.length > 1) throw new Error("Published selected proof is ambiguous");
    return matches[0] ?? null;
  } finally {
    try { database.exec("ROLLBACK"); } finally { database.close(); }
  }
}

function configure(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS release_operations (
      operation_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      request_id TEXT NOT NULL,
      state TEXT NOT NULL,
      revision INTEGER NOT NULL,
      operation_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(workspace_id, request_id)
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS release_operations_runnable_idx
      ON release_operations(state, updated_at, operation_id);
    CREATE TABLE IF NOT EXISTS release_operation_tasks (
      operation_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      PRIMARY KEY(operation_id, task_id),
      FOREIGN KEY(operation_id) REFERENCES release_operations(operation_id) ON DELETE CASCADE
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS release_operation_tasks_task_idx
      ON release_operation_tasks(task_id, operation_id);
    CREATE TABLE IF NOT EXISTS release_candidate_generations (
      operation_id TEXT NOT NULL,
      generation INTEGER NOT NULL,
      identity_sha256 TEXT NOT NULL,
      generation_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY(operation_id, generation),
      UNIQUE(operation_id, identity_sha256),
      FOREIGN KEY(operation_id) REFERENCES release_operations(operation_id) ON DELETE CASCADE
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS release_step_receipts (
      operation_id TEXT NOT NULL,
      generation INTEGER NOT NULL,
      step_id TEXT NOT NULL,
      attempt INTEGER NOT NULL,
      status TEXT NOT NULL,
      input_sha256 TEXT NOT NULL,
      receipt_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(operation_id, generation, step_id, attempt),
      FOREIGN KEY(operation_id) REFERENCES release_operations(operation_id) ON DELETE CASCADE
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS release_step_receipts_latest_idx
      ON release_step_receipts(operation_id, generation, step_id, attempt DESC);
    CREATE TABLE IF NOT EXISTS release_operation_events (
      operation_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      event_kind TEXT NOT NULL,
      stream_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      delivered_at TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT NOT NULL DEFAULT '',
      PRIMARY KEY(operation_id, revision, event_kind),
      FOREIGN KEY(operation_id) REFERENCES release_operations(operation_id) ON DELETE CASCADE
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS release_operation_events_pending_idx
      ON release_operation_events(delivered_at, created_at, operation_id, revision);
    CREATE TABLE IF NOT EXISTS release_legacy_evidence (
      evidence_id TEXT PRIMARY KEY,
      operation_id TEXT NOT NULL,
      source_kind TEXT NOT NULL,
      evidence_sha256 TEXT NOT NULL,
      evidence_json TEXT NOT NULL,
      imported_at TEXT NOT NULL,
      FOREIGN KEY(operation_id) REFERENCES release_operations(operation_id) ON DELETE CASCADE
    ) WITHOUT ROWID;
  `);
}

function operationFromRow(row) {
  if (!row?.operation_json) return null;
  try { return restoreReleaseOperation(JSON.parse(row.operation_json)); } catch { return null; }
}

function json(value) {
  return JSON.stringify(value);
}

function readJson(value) {
  try { return JSON.parse(value); } catch { return null; }
}

function owns(operation, expectedOwner) {
  if (!expectedOwner) return true;
  return operation?.owner?.ownerId === expectedOwner.ownerId
    && operation.owner.epoch === expectedOwner.epoch;
}

function assertDatabaseOwner(database, operationId, expectedOwner) {
  if (!expectedOwner) return;
  const operation = operationFromRow(database.prepare(
    "SELECT operation_json FROM release_operations WHERE operation_id = ?",
  ).get(String(operationId)));
  if (!owns(operation, expectedOwner)) {
    const error = new Error("release operation owner epoch changed");
    error.code = "RELEASE_OWNER_FENCED";
    throw error;
  }
}

function immediateTransaction(database, operation) {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch {}
    throw error;
  }
}

function writeOperation(database, operation) {
  database.prepare(`
    INSERT INTO release_operations
      (operation_id, workspace_id, request_id, state, revision, operation_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    operation.operationId, operation.workspaceId, operation.requestId, operation.state,
    operation.revision, json(operation), operation.createdAt, operation.updatedAt,
  );
  const insertTask = database.prepare(
    "INSERT INTO release_operation_tasks(operation_id, task_id) VALUES (?, ?)",
  );
  for (const taskId of operation.authorization.taskIds) insertTask.run(operation.operationId, taskId);
}

function writeEvent(database, operation, eventKind, payload, createdAt = operation.updatedAt) {
  database.prepare(`
    INSERT OR IGNORE INTO release_operation_events
      (operation_id, revision, event_kind, stream_id, thread_id, payload_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    operation.operationId, operation.revision, String(eventKind), operation.streamId,
    operation.threadId, json(payload), createdAt,
  );
}

function sameCreationIdentity(left, right) {
  return left.requestId === right.requestId
    && left.workspaceId === right.workspaceId
    && left.streamId === right.streamId
    && left.threadId === right.threadId
    && left.runnerVersion === right.runnerVersion
    && left.authorization.fingerprint === right.authorization.fingerprint;
}

function legacyState(evidence, { importedAt, evidenceOnly = false } = {}) {
  if (evidenceOnly) {
    return {
      state: "waiting", step: "compose", resumeState: null,
      waitReason: {
        code: "legacy_snapshot_evidence",
        message: "legacy release snapshot was preserved without authority to publish it",
      },
      nextAction: "start an explicitly authorized release operation if this snapshot is still required",
    };
  }
  const value = String(evidence?.phase ?? evidence?.status ?? "unknown").trim().toLowerCase();
  if (value === "succeeded") {
    return { state: "done", step: "done", nextAction: null };
  }
  if (["published", "awaiting_finalization"].includes(value)) {
    return { state: "finalize", step: "finalize", nextAction: "verify publication and finalize exact Task results" };
  }
  if (["running", "awaiting_restart", "unknown"].includes(value)) {
    return {
      state: "waiting", step: "publish", resumeState: "publish",
      waitReason: {
        code: "external_effect_readback",
        message: "legacy publication effect requires authoritative readback",
        retryAt: importedAt,
      },
      nextAction: "read back remote and deployed revisions before any retry",
    };
  }
  if (["prepared", "freezing", "frozen"].includes(value)) {
    return { state: "validate", step: "validate", nextAction: "validate imported immutable candidate" };
  }
  if (["failed", "validation_failed"].includes(value)) {
    return {
      state: "waiting", step: "validate", resumeState: "compose",
      waitReason: { code: "legacy_failure", message: "imported failed release attempt requires a corrected selected result" },
      nextAction: "accept correction and compose the next generation",
    };
  }
  return {
    state: "waiting", step: "publish", resumeState: "publish",
    waitReason: {
      code: "external_effect_readback",
      message: "legacy publication effect requires authoritative readback",
      retryAt: importedAt,
    },
    nextAction: "read back remote and deployed revisions before any retry",
  };
}

export class ReleaseOperationStore {
  #initialized = false;
  #mutationQueues = new Map();

  // Queue only short persistence closures, never publication or provider work.
  // A retry rereads durable CAS/owner evidence inside the closure.
  async runOperationMutation(operationId, mutation, options = {}) {
    const id = String(operationId);
    let queue = this.#mutationQueues.get(id);
    if (!queue) this.#mutationQueues.set(id, queue = new AsyncSqliteMutationQueue());
    try {
      return await queue.run(mutation, { ...options, requestId: id });
    } finally {
      if (queue.diagnostics().queued === 0 && this.#mutationQueues.get(id) === queue) {
        this.#mutationQueues.delete(id);
      }
    }
  }

  isContentionError(error) {
    return sqliteContention(error);
  }

  constructor({ dataDir, idFactory = randomUUID, now = () => new Date().toISOString() } = {}) {
    if (!String(dataDir ?? "").trim()) throw new TypeError("dataDir is required");
    this.dataDir = String(dataDir);
    this.idFactory = idFactory;
    this.now = now;
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
        database.exec("PRAGMA foreign_keys = ON; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 0;");
      }
      return callback(database);
    } finally {
      database.close();
    }
  }

  create(input = {}) {
    const operation = createReleaseOperation({
      ...input,
      operationId: input.operationId ?? this.idFactory(),
      createdAt: input.createdAt ?? this.now(),
      updatedAt: input.updatedAt ?? input.createdAt ?? this.now(),
    });
    return this.#withDatabase((database) => {
      database.exec("BEGIN IMMEDIATE");
      try {
        const existing = operationFromRow(database.prepare(`
          SELECT operation_json FROM release_operations WHERE workspace_id = ? AND request_id = ?
        `).get(operation.workspaceId, operation.requestId));
        if (existing) {
          if (!sameCreationIdentity(existing, operation)) throw new Error("release operation request identity conflict");
          database.exec("ROLLBACK");
          return { operation: existing, created: false };
        }
        writeOperation(database, operation);
        writeEvent(database, operation, "operation.created", { operationId: operation.operationId, state: operation.state });
        database.exec("COMMIT");
        return { operation, created: true };
      } catch (error) {
        try { database.exec("ROLLBACK"); } catch {}
        throw error;
      }
    });
  }

  get(operationId) {
    const id = String(operationId ?? "").trim();
    if (!id) return null;
    return this.#withDatabase((database) => operationFromRow(database.prepare(
      "SELECT operation_json FROM release_operations WHERE operation_id = ?",
    ).get(id)));
  }

  snapshot(operationId) {
    const operation = this.get(operationId);
    if (!operation) return null;
    return this.#withDatabase((database) => ({
      operation,
      generations: database.prepare(`
        SELECT generation_json FROM release_candidate_generations
        WHERE operation_id = ? ORDER BY generation
      `).all(operation.operationId).map((row) => readJson(row.generation_json)).filter(Boolean),
      receipts: database.prepare(`
        SELECT receipt_json FROM release_step_receipts
        WHERE operation_id = ? ORDER BY generation, step_id, attempt
      `).all(operation.operationId).map((row) => readJson(row.receipt_json)).filter(Boolean),
      events: database.prepare(`
        SELECT revision, event_kind, payload_json, created_at, delivered_at, attempts, last_error
        FROM release_operation_events WHERE operation_id = ? ORDER BY revision, event_kind
      `).all(operation.operationId).map((row) => ({
        revision: row.revision,
        eventKind: row.event_kind,
        payload: readJson(row.payload_json),
        createdAt: row.created_at,
        deliveredAt: row.delivered_at,
        attempts: row.attempts,
        lastError: row.last_error || null,
      })),
    }));
  }

  transition(operationId, patch = {}, {
    expectedRevision,
    expectedOwner = null,
    eventKind = "operation.progress",
    event = null,
    emitEvent = true,
    reviewedMainRecovery = null,
    testSelectionAmendment = null,
  } = {}) {
    const id = String(operationId ?? "").trim();
    if (!id) throw new TypeError("operationId is required");
    return this.#withDatabase((database) => {
      database.exec("BEGIN IMMEDIATE");
      try {
        const row = database.prepare(
          "SELECT operation_json FROM release_operations WHERE operation_id = ?",
        ).get(id);
        const current = operationFromRow(row);
        if (!current) {
          database.exec("ROLLBACK");
          return { operation: null, applied: false, reason: "not-found" };
        }
        if (!owns(current, expectedOwner)) {
          database.exec("ROLLBACK");
          return { operation: current, applied: false, reason: "owner-fenced" };
        }
        if (reviewedMainRecovery && expectedRevision === current.revision) {
          const raw = JSON.parse(row.operation_json);
          if (raw.authorization?.nativeOwnerCutover || raw.nativeOwnerRecovery) {
            throw new Error("Reviewed-main recovery is source-owner-fenced");
          }
          const nextGeneration = current.currentGeneration + 1;
          if (database.prepare("SELECT 1 FROM release_candidate_generations WHERE operation_id=? AND generation=?")
            .get(id, nextGeneration)) throw new Error("Reviewed-main recovery cannot replace an immutable generation");
          const compose = readJson(database.prepare("SELECT receipt_json FROM release_step_receipts WHERE operation_id=? AND generation=? AND step_id='compose' ORDER BY attempt DESC LIMIT 1")
            .get(id, nextGeneration)?.receipt_json);
          if (compose?.status !== "failed" || compose.error !== current.lastError?.message) {
            throw new Error("Reviewed-main recovery requires the original terminal failed compose receipt");
          }
          const publications = database.prepare("SELECT receipt_json FROM release_step_receipts WHERE operation_id=? AND step_id LIKE 'publish:%'").all(id);
          if (!publications.length || publications.some(row => {
            const receipt = readJson(row.receipt_json);
            return receipt?.status !== "failed" || receipt.effect?.status !== "not_applied";
          })) throw new Error("Reviewed-main recovery requires terminal not-applied publication receipts");
        }
        if (testSelectionAmendment && expectedRevision === current.revision) {
          const raw = JSON.parse(row.operation_json);
          if (raw.authorization?.nativeOwnerCutover || raw.nativeOwnerRecovery) throw new Error("Test selection amendment is source-owner-fenced");
        }
        if (testSelectionAmendment && expectedRevision === current.revision
            && database.prepare("SELECT 1 FROM release_candidate_generations WHERE operation_id=? AND generation=?")
              .get(id, current.currentGeneration + 1)) throw new Error("Test selection cannot replace an immutable next generation");
        const result = transitionReleaseOperation(current, patch, {
          expectedRevision: expectedRevision ?? current.revision,
          updatedAt: this.now(),
          reviewedMainRecovery,
          testSelectionAmendment,
        });
        if (!result.applied) {
          database.exec("ROLLBACK");
          return result;
        }
        const update = database.prepare(`
          UPDATE release_operations SET state = ?, revision = ?, operation_json = ?, updated_at = ?
          WHERE operation_id = ? AND revision = ?
        `).run(
          result.operation.state, result.operation.revision, json(result.operation), result.operation.updatedAt,
          id, current.revision,
        );
        if (update.changes !== 1) throw new Error("release operation revision conflict");
        if (testSelectionAmendment) {
          const insertTask = database.prepare("INSERT OR IGNORE INTO release_operation_tasks(operation_id, task_id) VALUES (?, ?)");
          for (const taskId of effectiveReleaseTaskIds(result.operation)) insertTask.run(id, taskId);
        }
        if (emitEvent) {
          writeEvent(database, result.operation, eventKind, event ?? {
            operationId: id,
            state: result.operation.state,
            step: result.operation.currentStep,
            waitReason: result.operation.waitReason,
            nextAction: result.operation.nextAction,
          });
        }
        database.exec("COMMIT");
        return result;
      } catch (error) {
        try { database.exec("ROLLBACK"); } catch {}
        throw error;
      }
    });
  }

  acquire(operationId, ownerId, { leaseMs = 30_000, processId = null, takeoverAllowed = false } = {}) {
    const row = this.#withDatabase(database => database.prepare(
      "SELECT operation_json FROM release_operations WHERE operation_id = ?",
    ).get(String(operationId ?? "").trim()));
    const current = operationFromRow(row);
    if (!current || releaseOperationIsTerminal(current)) return { operation: current, acquired: false, reason: current ? "terminal" : "not-found" };
    // This installed-runtime store has no reviewed native execution capability.
    // The standalone source owner retains its own acquisition/recovery path.
    // Read persisted authority before the legacy normalized status projection,
    // which intentionally does not expose the standalone source extension.
    const recorded = JSON.parse(row.operation_json);
    if (recorded.authorization?.nativeOwnerCutover || recorded.nativeOwnerRecovery) {
      return { operation: current, acquired: false, reason: "source-owner-fenced" };
    }
    const now = this.now();
    const active = current.owner && Date.parse(current.owner.leaseExpiresAt) > Date.parse(now)
      && current.owner.ownerId !== String(ownerId);
    if (active) return { operation: current, acquired: false, reason: "owned" };
    if (current.owner && current.owner.ownerId !== String(ownerId) && !takeoverAllowed) {
      return { operation: current, acquired: false, reason: "owner-unverified" };
    }
    const epoch = current.owner?.ownerId === String(ownerId)
      ? current.owner.epoch
      : Math.max(0, Number(current.owner?.epoch) || 0) + 1;
    const result = this.transition(operationId, {
      owner: {
        ownerId: String(ownerId), epoch, processId, heartbeatAt: now,
        leaseExpiresAt: new Date(Date.parse(now) + leaseMs).toISOString(),
      },
    }, { expectedRevision: current.revision, emitEvent: false });
    return { operation: result.operation, acquired: result.applied, reason: result.reason };
  }

  heartbeat(operationId, ownerId, { leaseMs = 30_000, epoch = null } = {}) {
    const current = this.get(operationId);
    if (!current?.owner || current.owner.ownerId !== String(ownerId)
        || (epoch != null && current.owner.epoch !== Number(epoch))) {
      return { operation: current, applied: false, reason: "not-owner" };
    }
    const now = this.now();
    return this.transition(operationId, {
      owner: { ...current.owner, heartbeatAt: now, leaseExpiresAt: new Date(Date.parse(now) + leaseMs).toISOString() },
    }, { expectedRevision: current.revision, expectedOwner: current.owner, emitEvent: false });
  }

  release(operationId, owner) {
    const current = this.get(operationId);
    const expectedOwner = owner && typeof owner === "object"
      ? owner
      : current?.owner?.ownerId === String(owner) ? current.owner : null;
    if (!current?.owner || !expectedOwner || !owns(current, expectedOwner)) return current;
    return this.transition(operationId, { owner: null }, {
      expectedRevision: current.revision,
      expectedOwner,
      emitEvent: false,
    }).operation;
  }

  putGeneration(input, { expectedOwner = null } = {}) {
    const generation = createCandidateGeneration(input);
    return this.#withDatabase((database) => immediateTransaction(database, () => {
      assertDatabaseOwner(database, generation.operationId, expectedOwner);
      const existing = database.prepare(`
        SELECT generation_json FROM release_candidate_generations WHERE operation_id = ? AND generation = ?
      `).get(generation.operationId, generation.generation);
      if (existing) {
        const restored = readJson(existing.generation_json);
        if (json(restored) !== json(generation)) throw new Error("candidate generation is immutable");
        return { generation: restored, created: false };
      }
      database.prepare(`
        INSERT INTO release_candidate_generations
          (operation_id, generation, identity_sha256, generation_json, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(
        generation.operationId, generation.generation, generation.identitySha256,
        json(generation), generation.createdAt,
      );
      return { generation, created: true };
    }));
  }

  generation(operationId, generation) {
    return this.#withDatabase((database) => readJson(database.prepare(`
      SELECT generation_json FROM release_candidate_generations WHERE operation_id = ? AND generation = ?
    `).get(String(operationId), Number(generation))?.generation_json));
  }

  beginStep({ operationId, generation, stepId, input, createdAt = this.now(), expectedOwner = null } = {}) {
    const id = String(operationId ?? "").trim();
    const step = String(stepId ?? "").trim();
    if (!id || !step) throw new TypeError("step receipt requires operationId and stepId");
    const inputSha256 = releaseIdentitySha256(input ?? {});
    return this.#withDatabase((database) => immediateTransaction(database, () => {
      assertDatabaseOwner(database, id, expectedOwner);
      const latest = database.prepare(`
        SELECT receipt_json FROM release_step_receipts
        WHERE operation_id = ? AND generation = ? AND step_id = ? ORDER BY attempt DESC LIMIT 1
      `).get(id, Number(generation), step);
      const restored = readJson(latest?.receipt_json);
      if (restored && ["intent", "unknown", "applied"].includes(restored.status) && restored.inputSha256 === inputSha256) {
        return { receipt: restored, created: false };
      }
      const attempt = Number(restored?.attempt ?? 0) + 1;
      const receipt = {
        entityType: "release-step-receipt", schemaVersion: 1,
        operationId: id, generation: Number(generation), stepId: step, attempt,
        status: "intent", inputSha256, input: structuredClone(input ?? {}),
        effect: null, error: null, reconcileCursor: null,
        createdAt, updatedAt: createdAt,
      };
      database.prepare(`
        INSERT INTO release_step_receipts
          (operation_id, generation, step_id, attempt, status, input_sha256, receipt_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, Number(generation), step, attempt, receipt.status, inputSha256, json(receipt), createdAt, createdAt);
      return { receipt, created: true };
    }));
  }

  finishStep(receipt, { status, effect = null, error = null, reconcileCursor = null, expectedOwner = null } = {}) {
    const allowed = new Set(["applied", "not_applied", "partial", "failed", "unknown"]);
    if (!allowed.has(status)) throw new TypeError(`unsupported step receipt status: ${status}`);
    return this.#withDatabase((database) => immediateTransaction(database, () => {
      assertDatabaseOwner(database, receipt.operationId, expectedOwner);
      const row = database.prepare(`
        SELECT receipt_json FROM release_step_receipts
        WHERE operation_id = ? AND generation = ? AND step_id = ? AND attempt = ?
      `).get(receipt.operationId, receipt.generation, receipt.stepId, receipt.attempt);
      const current = readJson(row?.receipt_json);
      if (!current) throw new Error("release step receipt was not found");
      if (current.status !== "intent" && current.status !== "unknown") {
        if (current.status === status && json(current.effect) === json(effect)) return current;
        throw new Error("release step receipt is terminal");
      }
      const updated = {
        ...current, status, effect: effect == null ? null : structuredClone(effect),
        error: error == null ? null : String(error?.message ?? error),
        reconcileCursor: reconcileCursor == null ? null : structuredClone(reconcileCursor),
        updatedAt: this.now(),
      };
      database.prepare(`
        UPDATE release_step_receipts SET status = ?, receipt_json = ?, updated_at = ?
        WHERE operation_id = ? AND generation = ? AND step_id = ? AND attempt = ?
      `).run(status, json(updated), updated.updatedAt, current.operationId, current.generation, current.stepId, current.attempt);
      return updated;
    }));
  }

  latestStep(operationId, generation, stepId) {
    return this.#withDatabase((database) => readJson(database.prepare(`
      SELECT receipt_json FROM release_step_receipts
      WHERE operation_id = ? AND generation = ? AND step_id = ? ORDER BY attempt DESC LIMIT 1
    `).get(String(operationId), Number(generation), String(stepId))?.receipt_json));
  }

  runnable({ now = this.now(), limit = 50 } = {}) {
    return this.#withDatabase((database) => database.prepare(`
      SELECT operation_json FROM release_operations
      WHERE state NOT IN ('done', 'failed') ORDER BY updated_at, operation_id LIMIT ?
    `).all(Math.max(1, Math.min(500, Number(limit) || 50))).map(operationFromRow).filter((operation) => {
      if (!operation) return false;
      if (operation.owner && Date.parse(operation.owner.leaseExpiresAt) > Date.parse(now)) return false;
      if (operation.state !== "waiting") return true;
      return Boolean(operation.waitReason?.retryAt && Date.parse(operation.waitReason.retryAt) <= Date.parse(now));
    }));
  }

  active({ limit = 500 } = {}) {
    return this.#withDatabase((database) => database.prepare(`
      SELECT operation_json FROM release_operations
      WHERE state NOT IN ('done', 'failed') ORDER BY updated_at, operation_id LIMIT ?
    `).all(Math.max(1, Math.min(2_000, Number(limit) || 500))).map(operationFromRow).filter(Boolean));
  }

  forTask(taskId) {
    return this.#withDatabase((database) => database.prepare(`
      SELECT operation_json FROM release_operations
      WHERE operation_id IN (SELECT operation_id FROM release_operation_tasks WHERE task_id = ?)
      ORDER BY updated_at DESC
    `).all(String(taskId)).map(operationFromRow).filter(operation => operation && effectiveReleaseTaskIds(operation).includes(String(taskId))));
  }

  pendingEvents({ limit = 100 } = {}) {
    return this.#withDatabase((database) => database.prepare(`
      SELECT operation_id, revision, event_kind, stream_id, thread_id, payload_json, attempts
      FROM release_operation_events WHERE delivered_at IS NULL
      ORDER BY created_at, operation_id, revision LIMIT ?
    `).all(Math.max(1, Math.min(1_000, Number(limit) || 100))).map((row) => ({
      operationId: row.operation_id,
      revision: row.revision,
      eventKind: row.event_kind,
      streamId: row.stream_id,
      threadId: row.thread_id,
      payload: readJson(row.payload_json),
      attempts: row.attempts,
    })));
  }

  settleEvent(event, { delivered, error = null } = {}) {
    return this.#withDatabase((database) => database.prepare(`
      UPDATE release_operation_events
      SET delivered_at = CASE WHEN ? THEN ? ELSE delivered_at END,
          attempts = attempts + 1, last_error = ?
      WHERE operation_id = ? AND revision = ? AND event_kind = ?
    `).run(
      delivered ? 1 : 0, delivered ? this.now() : null, error == null ? "" : String(error?.message ?? error).slice(0, 2_000),
      event.operationId, event.revision, event.eventKind,
    ).changes === 1);
  }

  importLegacy({
    workspaceId, streamId, threadId, sourceKind, sourceIdentity, evidence, authorization, runnerVersion,
    candidateGeneration = null, evidenceOnly = false,
  } = {}) {
    const identity = String(sourceIdentity ?? "").trim();
    if (!identity) throw new TypeError("legacy source identity is required");
    const importedAt = this.now();
    let evidenceSha256 = releaseIdentitySha256(evidence ?? {});
    const evidenceId = `${LEGACY_MIGRATION_PREFIX}${releaseIdentitySha256({ sourceKind, identity })}`;
    const operationId = `legacy-${releaseIdentitySha256({ sourceKind, identity }).slice(0, 32)}`;
    const imported = this.get(operationId);
    // Primary synchronization may annotate an already imported orphan checkpoint.
    // It cannot activate that orphan or rewrite its original migration evidence.
    // Remove this compatibility boundary with the legacy checkpoint importer.
    if (imported?.migration?.evidenceSha256 !== evidenceSha256
        && sourceKind === "release-checkpoint-v2"
        && imported?.migration?.sourceKind === sourceKind
        && imported.migration.sourceIdentity === identity
        && evidenceOnly === true && imported.migration.evidenceOnly === true
        && imported.state === "waiting" && !imported.owner && !imported.resumeState
        && imported.waitReason?.code === "legacy_snapshot_evidence"
        && !imported.waitReason.retryAt
        && Object.hasOwn(evidence?.checkpoint ?? {}, "primarySynchronizationProof")) {
      const checkpoint = { ...evidence.checkpoint };
      delete checkpoint.primarySynchronizationProof;
      const originalEvidence = { ...evidence, checkpoint };
      const originalHash = releaseIdentitySha256(originalEvidence);
      if (originalHash === imported.migration.evidenceSha256) {
        evidence = originalEvidence;
        evidenceSha256 = originalHash;
      }
    }

    if (imported && (imported.migration?.sourceKind !== String(sourceKind)
        || imported.migration?.sourceIdentity !== identity
        || imported.migration?.evidenceSha256 !== evidenceSha256
        || imported.migration?.evidenceOnly !== Boolean(evidenceOnly))) {
      throw Object.assign(new Error("legacy release evidence changed after import"), { code: "RELEASE_LEGACY_EVIDENCE_CHANGED" });
    }
    // Re-observing immutable legacy evidence after a runtime upgrade is not a
    // new release request. Keep the first import's runner on both identities;
    // create() and putGeneration() still reject every other identity change.
    const importRunnerVersion = imported?.runnerVersion ?? runnerVersion;
    const generation = candidateGeneration ? createCandidateGeneration({
      ...candidateGeneration,
      operationId,
      generation: 1,
      runnerVersion: importRunnerVersion,
    }) : null;
    const mapped = legacyState(evidence, { importedAt, evidenceOnly });
    const created = this.create({
      operationId,
      requestId: evidenceId,
      workspaceId, streamId, threadId, authorization, runnerVersion: importRunnerVersion,
      ...(generation ? { currentGeneration: 1, selectedResults: generation.selectedResults } : {}),
      ...mapped,
      migration: { sourceKind: String(sourceKind), sourceIdentity: identity, evidenceSha256, evidenceOnly: Boolean(evidenceOnly) },
    });
    if (generation) this.putGeneration(generation);
    this.#withDatabase((database) => {
      const existing = database.prepare(
        "SELECT evidence_sha256 FROM release_legacy_evidence WHERE evidence_id = ?",
      ).get(evidenceId);
      if (existing && existing.evidence_sha256 !== evidenceSha256) throw Object.assign(new Error("legacy release evidence changed after import"), { code: "RELEASE_LEGACY_EVIDENCE_CHANGED" });
      if (!existing) database.prepare(`
        INSERT INTO release_legacy_evidence
          (evidence_id, operation_id, source_kind, evidence_sha256, evidence_json, imported_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(evidenceId, created.operation.operationId, String(sourceKind), evidenceSha256, json(evidence ?? {}), importedAt);
    });
    return created;
  }
}
