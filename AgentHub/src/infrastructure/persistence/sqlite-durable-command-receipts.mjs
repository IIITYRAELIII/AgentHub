import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { DurableCommandRetryableError } from "./durable-command-receipts.mjs";

const PENDING_PHASES = new Set(["prepared", "effect-started"]);
const TERMINAL_PHASES = new Set(["completed", "reconciled", "failed"]);
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function serializedResult(value) {
  return JSON.parse(JSON.stringify(value ?? null));
}

function defaultProcessAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function parseJson(value, fallback = null) {
  if (typeof value !== "string" || !value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function rowRecord(row) {
  if (!row) return null;
  return {
    id: row.id,
    fingerprint: row.fingerprint,
    action: row.action,
    phase: row.phase,
    result: parseJson(row.result_json),
    error: row.error || undefined,
    effectOwner: parseJson(row.effect_owner_json),
    effectStartedAtMs: Number(row.effect_started_at_ms) || undefined,
    createdAtMs: Number(row.created_at_ms) || 0,
    updatedAtMs: Number(row.updated_at_ms) || 0,
  };
}

function normalizeLegacyRecord(source) {
  if (!source || typeof source.id !== "string" || typeof source.fingerprint !== "string") return null;
  const phase = String(source.phase ?? "");
  if (!PENDING_PHASES.has(phase) && !TERMINAL_PHASES.has(phase)) return null;
  return {
    id: source.id,
    fingerprint: source.fingerprint,
    action: String(source.action ?? ""),
    phase,
    result: phase === "failed" ? null : serializedResult(source.result),
    error: phase === "failed" ? String(source.error ?? "command failed").slice(0, 4_096) : null,
    effectOwner: source.effectOwner && typeof source.effectOwner === "object" ? source.effectOwner : null,
    effectStartedAtMs: Number(source.effectStartedAtMs) || null,
    createdAtMs: Number(source.createdAtMs) || Date.now(),
    updatedAtMs: Number(source.updatedAtMs) || Date.now(),
  };
}

export class SqliteDurableCommandReceipts {
  #file;
  #legacyFile;
  #maxItems;
  #maxPending;
  #database = null;
  #initializing = null;
  #inFlight = new Map();
  #isProcessAlive;
  #effectWaitMs;
  #effectWaitTimeoutMs;
  #effectStaleMs;
  #effectMaxAgeMs;
  #projectResult;
  #onTrace;

  constructor({
    file,
    legacyFile = null,
    maxItems = 2_000,
    maxPending = 500,
    isProcessAlive = defaultProcessAlive,
    effectWaitMs = 25,
    effectWaitTimeoutMs = 30_000,
    effectStaleMs = 60_000,
    effectMaxAgeMs = 5 * 60_000,
    projectResult = null,
    onTrace = null,
  }) {
    this.#file = path.resolve(file);
    this.#legacyFile = legacyFile ? path.resolve(legacyFile) : null;
    this.#maxItems = Math.max(100, Math.trunc(maxItems) || 2_000);
    this.#maxPending = Math.max(10, Math.trunc(maxPending) || 500);
    this.#isProcessAlive = isProcessAlive;
    this.#effectWaitMs = Math.max(1, Math.trunc(effectWaitMs) || 25);
    this.#effectWaitTimeoutMs = Math.max(this.#effectWaitMs, Math.trunc(effectWaitTimeoutMs) || 30_000);
    this.#effectStaleMs = Math.max(0, Number.isFinite(Number(effectStaleMs))
      ? Math.trunc(effectStaleMs)
      : 60_000);
    this.#effectMaxAgeMs = Math.max(this.#effectWaitTimeoutMs, Number.isFinite(Number(effectMaxAgeMs))
      ? Math.trunc(effectMaxAgeMs)
      : 5 * 60_000);
    this.#projectResult = typeof projectResult === "function" ? projectResult : null;
    this.#onTrace = typeof onTrace === "function" ? onTrace : null;
  }

  async #initialize() {
    if (this.#database) return;
    if (!this.#initializing) {
      this.#initializing = (async () => {
        await mkdir(path.dirname(this.#file), { recursive: true });
        const database = new DatabaseSync(this.#file);
        try {
          database.exec(`
            PRAGMA journal_mode = WAL;
            PRAGMA synchronous = FULL;
            PRAGMA busy_timeout = 1000;
            CREATE TABLE IF NOT EXISTS durable_command_receipts (
              id TEXT PRIMARY KEY,
              fingerprint TEXT NOT NULL,
              action TEXT NOT NULL,
              phase TEXT NOT NULL CHECK (phase IN ('prepared', 'effect-started', 'completed', 'reconciled', 'failed')),
              result_json TEXT,
              error TEXT,
              effect_owner_json TEXT,
              effect_started_at_ms INTEGER,
              created_at_ms INTEGER NOT NULL,
              updated_at_ms INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS durable_command_receipts_phase_updated
              ON durable_command_receipts(phase, updated_at_ms);
            CREATE TABLE IF NOT EXISTS durable_command_receipt_metadata (
              key TEXT PRIMARY KEY,
              value TEXT NOT NULL,
              updated_at_ms INTEGER NOT NULL
            );
          `);
          this.#database = database;
          await this.#importLegacyJson();
        } catch (error) {
          database.close();
          this.#database = null;
          throw error;
        }
      })().finally(() => {
        this.#initializing = null;
      });
    }
    await this.#initializing;
  }

  async #importLegacyJson() {
    const marker = "legacy-json-imported-v1";
    if (this.#database.prepare("SELECT 1 FROM durable_command_receipt_metadata WHERE key = ?").get(marker)) return;
    let records = [];
    if (this.#legacyFile) {
      try {
        const value = JSON.parse(await readFile(this.#legacyFile, "utf8"));
        if (value?.version === 1 && Array.isArray(value.records)) {
          records = value.records.map(normalizeLegacyRecord).filter(Boolean);
        }
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
    const database = this.#database;
    database.exec("BEGIN IMMEDIATE");
    try {
      const alreadyImported = database.prepare(
        "SELECT 1 FROM durable_command_receipt_metadata WHERE key = ?",
      ).get(marker);
      if (!alreadyImported) {
        const insert = database.prepare(`
          INSERT OR IGNORE INTO durable_command_receipts (
            id, fingerprint, action, phase, result_json, error, effect_owner_json,
            effect_started_at_ms, created_at_ms, updated_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (const record of records) {
          let result = record.result;
          if (this.#projectResult && ["completed", "reconciled"].includes(record.phase)) {
            result = serializedResult(this.#projectResult(result, record));
          }
          insert.run(
            record.id,
            record.fingerprint,
            record.action,
            record.phase,
            record.phase === "failed" ? null : JSON.stringify(result),
            record.error,
            record.effectOwner ? JSON.stringify(record.effectOwner) : null,
            record.effectStartedAtMs,
            record.createdAtMs,
            record.updatedAtMs,
          );
        }
        database.prepare(`
          INSERT INTO durable_command_receipt_metadata (key, value, updated_at_ms)
          VALUES (?, ?, ?)
        `).run(marker, JSON.stringify({ source: this.#legacyFile, count: records.length }), Date.now());
      }
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }

  async #transaction(operation, traceContext = null) {
    await this.#initialize();
    const startedAt = performance.now();
    this.#database.exec("BEGIN IMMEDIATE");
    const waitMs = performance.now() - startedAt;
    try {
      try {
        this.#onTrace?.({ ...traceContext, waitMs, lockCount: 1 });
      } catch {
        // Receipt timing cannot affect command durability.
      }
      const result = operation(this.#database);
      this.#database.exec("COMMIT");
      return result;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  #readRecord(database, commandId) {
    const row = database.prepare("SELECT * FROM durable_command_receipts WHERE id = ?").get(commandId);
    const record = rowRecord(row);
    if (!record || !this.#projectResult || !["completed", "reconciled"].includes(record.phase)) return record;
    const projected = serializedResult(this.#projectResult(record.result, record));
    const projectedJson = JSON.stringify(projected);
    if (projectedJson !== row.result_json) {
      database.prepare("UPDATE durable_command_receipts SET result_json = ?, updated_at_ms = ? WHERE id = ?")
        .run(projectedJson, Date.now(), commandId);
      record.result = projected;
    }
    return record;
  }

  #effectOwnerIsLive(record) {
    const owner = record?.effectOwner;
    const startedAtMs = Number(record?.effectStartedAtMs ?? record?.updatedAtMs ?? 0);
    if (Date.now() - startedAtMs >= this.#effectMaxAgeMs) return false;
    if (Number.isSafeInteger(owner?.pid) && owner.pid > 0) return this.#isProcessAlive(owner.pid);
    return Date.now() - startedAtMs < this.#effectStaleMs;
  }

  async execute({ id, fingerprint, action, effect, reconcile = null, traceContext = null }) {
    const commandId = String(id ?? "").trim();
    const requestFingerprint = String(fingerprint ?? "").trim();
    if (!commandId || !requestFingerprint || typeof effect !== "function") {
      throw new Error("durable command receipt requires id, fingerprint and effect");
    }
    const inFlight = this.#inFlight.get(commandId);
    if (inFlight) {
      if (inFlight.fingerprint !== requestFingerprint) {
        throw new Error("durable command receipt fingerprint conflict");
      }
      return inFlight.operation;
    }
    const operation = this.#execute(
      { commandId, requestFingerprint, action, effect, reconcile },
      Date.now() + this.#effectWaitTimeoutMs,
      { ...traceContext, commandId, retryCount: 0 },
    );
    this.#inFlight.set(commandId, { fingerprint: requestFingerprint, operation });
    try {
      return await operation;
    } finally {
      if (this.#inFlight.get(commandId)?.operation === operation) this.#inFlight.delete(commandId);
    }
  }

  async forget(id) {
    const commandId = String(id ?? "").trim();
    if (!commandId) return false;
    return this.#transaction((database) => (
      database.prepare("DELETE FROM durable_command_receipts WHERE id = ?").run(commandId).changes > 0
    ));
  }

  async forgetPrefix(prefix) {
    const value = String(prefix ?? "").trim();
    if (!value) return 0;
    return this.#transaction((database) => database.prepare(`
      DELETE FROM durable_command_receipts
      WHERE substr(id, 1, ?) = ?
    `).run(value.length, value).changes);
  }

  async #settle(commandId, fingerprint, { result, phase = "completed", error = null, effectToken = null }, traceContext) {
    const decision = await this.#transaction((database) => {
      const record = this.#readRecord(database, commandId);
      if (!record || record.fingerprint !== fingerprint) {
        throw new Error("durable command receipt changed while the effect was running");
      }
      if (record.phase === "completed" || record.phase === "reconciled") return { result: record.result };
      if (record.phase === "failed") return { error: record.error || "command failed" };
      if (effectToken && record.effectOwner?.token !== effectToken) {
        throw new Error("durable command effect ownership changed while it was running");
      }
      if (record.phase !== "effect-started") {
        throw new Error("durable command receipt is not awaiting an effect");
      }
      const message = error ? String(error?.message ?? error ?? "command failed").slice(0, 4_096) : null;
      const projected = error ? null : (this.#projectResult
        ? serializedResult(this.#projectResult(result, record))
        : serializedResult(result));
      database.prepare(`
        UPDATE durable_command_receipts
        SET phase = ?, result_json = ?, error = ?, effect_owner_json = NULL,
            effect_started_at_ms = NULL, updated_at_ms = ?
        WHERE id = ?
      `).run(error ? "failed" : phase, error ? null : JSON.stringify(projected), message, Date.now(), commandId);
      return error ? { error: message } : { result: projected };
    }, traceContext);
    if (decision.error) throw new Error(decision.error);
    return decision.result;
  }

  async #execute({ commandId, requestFingerprint, action, effect, reconcile }, deadline, traceContext) {
    const decision = await this.#transaction((database) => {
      const record = this.#readRecord(database, commandId);
      if (record && record.fingerprint !== requestFingerprint) {
        throw new Error("durable command receipt fingerprint conflict");
      }
      if (record?.phase === "completed" || record?.phase === "reconciled") {
        return { kind: "result", result: record.result };
      }
      if (record?.phase === "failed") throw new Error(record.error || "command failed");
      if (record?.phase === "effect-started") {
        return this.#effectOwnerIsLive(record)
          ? { kind: "wait" }
          : { kind: "reconcile", record };
      }
      if (!record) {
        const pendingCount = Number(database.prepare(`
          SELECT COUNT(*) AS count FROM durable_command_receipts
          WHERE phase IN ('prepared', 'effect-started')
        `).get().count);
        if (pendingCount >= this.#maxPending) {
          throw new Error("durable command receipt capacity is exhausted by unresolved effects");
        }
        const terminalCount = Number(database.prepare(`
          SELECT COUNT(*) AS count FROM durable_command_receipts
          WHERE phase NOT IN ('prepared', 'effect-started')
        `).get().count);
        if (terminalCount >= this.#maxItems) {
          throw new Error("durable command receipt capacity is exhausted by unacknowledged results");
        }
      }
      const now = Date.now();
      const owner = { token: randomUUID(), pid: process.pid };
      if (record) {
        database.prepare(`
          UPDATE durable_command_receipts
          SET phase = 'effect-started', effect_owner_json = ?, effect_started_at_ms = ?, updated_at_ms = ?
          WHERE id = ?
        `).run(JSON.stringify(owner), now, now, commandId);
      } else {
        database.prepare(`
          INSERT INTO durable_command_receipts (
            id, fingerprint, action, phase, result_json, error, effect_owner_json,
            effect_started_at_ms, created_at_ms, updated_at_ms
          ) VALUES (?, ?, ?, 'effect-started', NULL, NULL, ?, ?, ?, ?)
        `).run(commandId, requestFingerprint, String(action ?? ""), JSON.stringify(owner), now, now, now);
      }
      return { kind: "effect", effectToken: owner.token };
    }, traceContext);
    if (decision.kind === "result") return decision.result;
    if (decision.kind === "wait") {
      if (Date.now() >= deadline) {
        throw new DurableCommandRetryableError("command effect is still active in another process");
      }
      await delay(Math.min(this.#effectWaitMs, Math.max(1, deadline - Date.now())));
      return this.#execute(
        { commandId, requestFingerprint, action, effect, reconcile },
        deadline,
        { ...traceContext, retryCount: Number(traceContext?.retryCount ?? 0) + 1 },
      );
    }
    if (decision.kind === "reconcile") {
      if (typeof reconcile !== "function") {
        return this.#settle(commandId, requestFingerprint, {
          error: "command outcome is unknown after an interrupted effect",
        }, traceContext);
      }
      try {
        const reconciliation = await reconcile(decision.record);
        if (!reconciliation?.resolved) {
          if (reconciliation?.terminal === true) {
            return this.#settle(commandId, requestFingerprint, {
              error: reconciliation.error || "command outcome is unknown after an interrupted effect",
            }, traceContext);
          }
          throw new DurableCommandRetryableError(
            reconciliation?.error || "command reconciliation is not complete",
          );
        }
        return this.#settle(commandId, requestFingerprint, {
          result: reconciliation.result,
          phase: "reconciled",
        }, traceContext);
      } catch (error) {
        if (error instanceof DurableCommandRetryableError) throw error;
        return this.#settle(commandId, requestFingerprint, { error }, traceContext);
      }
    }
    let result;
    try {
      result = await effect();
    } catch (error) {
      return this.#settle(commandId, requestFingerprint, { error, effectToken: decision.effectToken }, traceContext);
    }
    return this.#settle(commandId, requestFingerprint, { result, effectToken: decision.effectToken }, traceContext);
  }

  async close() {
    await this.#initialize();
    this.#database?.close();
    this.#database = null;
  }
}
