import { providerRunTerminalStatusSupported } from "../../domain/provider-run-terminal.mjs";
import { validLocalExecutionRetirement } from "../../domain/task-runs.mjs";
import { AsyncSqliteMutationQueue } from "./async-sqlite-mutation-queue.mjs";
import { openRuntimeDatabase } from "./runtime-state-store.mjs";

function identity(value) {
  const provider = String(value?.provider ?? "").trim().toLowerCase();
  const threadId = String(value?.threadId ?? "").trim();
  const turnId = String(value?.turnId ?? "").trim();
  const status = String(value?.status ?? "").trim().toLowerCase();
  if (!provider || !threadId || !turnId) {
    throw new Error("provider run terminal identity requires provider, threadId and turnId");
  }
  if (!providerRunTerminalStatusSupported(status)) {
    throw new Error(`unsupported provider run terminal status ${status || "empty"}`);
  }
  return { provider, threadId, turnId, status };
}

function configure(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS provider_run_local_retirements (
      run_id TEXT PRIMARY KEY NOT NULL,
      identity_json TEXT NOT NULL,
      proof_json TEXT NOT NULL,
      committed_at TEXT NOT NULL
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS provider_run_terminals (
      provider TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('completed', 'failed', 'aborted')),
      committed_at TEXT NOT NULL,
      PRIMARY KEY (provider, thread_id, turn_id)
    ) WITHOUT ROWID;
  `);
}

function terminalRow(row) {
  if (!row) return null;
  return {
    provider: String(row.provider),
    threadId: String(row.thread_id),
    turnId: String(row.turn_id),
    status: String(row.status),
    committedAt: String(row.committed_at),
  };
}

export class ProviderRunTerminalStore {
  #dataDir;
  #mutations = new AsyncSqliteMutationQueue();
  #mutationTimeoutMs;
  #configured = false;

  constructor({ dataDir, mutationTimeoutMs = 5_000 }) {
    if (!dataDir) throw new Error("ProviderRunTerminalStore dataDir is required");
    this.#dataDir = dataDir;
    this.#mutationTimeoutMs = Math.max(1, Number(mutationTimeoutMs) || 5_000);
  }

  #database() {
    const database = openRuntimeDatabase(this.#dataDir);
    try {
      if (!this.#configured) {
        configure(database);
        this.#configured = true;
      }
      return database;
    } catch (error) {
      database.close();
      throw error;
    }
  }

  record(value) {
    const key = identity(value);
    return this.#mutations.run(() => {
      const database = this.#database();
      try {
        const committedAt = new Date().toISOString();
        database.prepare(`
          INSERT INTO provider_run_terminals (
            provider, thread_id, turn_id, status, committed_at
          ) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(provider, thread_id, turn_id) DO NOTHING
        `).run(key.provider, key.threadId, key.turnId, key.status, committedAt);
        const terminal = terminalRow(database.prepare(`
          SELECT provider, thread_id, turn_id, status, committed_at
          FROM provider_run_terminals
          WHERE provider = ? AND thread_id = ? AND turn_id = ?
        `).get(key.provider, key.threadId, key.turnId));
        if (terminal?.status !== key.status) {
          throw new Error(`provider run terminal already recorded as ${terminal?.status ?? "unknown"}`);
        }
        return terminal;
      } finally {
        database.close();
      }
    }, {
      timeoutMs: this.#mutationTimeoutMs,
      requestId: `${key.provider}\0${key.threadId}\0${key.turnId}`,
    });
  }

  // Administrative local ownership, deliberately separate from provider terminals
  // in the same canonical lifecycle store and mutation owner.
  recordLocalExecutionRetirement({ identity: key, proof }) {
    if (!validLocalExecutionRetirement({ identity: key, proof })) {
      throw new Error("exact local execution retirement identity and boot proof required");
    }
    const identityJson = JSON.stringify(key);
    const proofJson = JSON.stringify(proof);
    return this.#mutations.run(() => {
      const database = this.#database();
      try {
        database.prepare(`
          INSERT INTO provider_run_local_retirements
          (run_id, identity_json, proof_json, committed_at) VALUES (?, ?, ?, ?)
          ON CONFLICT(run_id) DO NOTHING
        `).run(key.runId, identityJson, proofJson, new Date().toISOString());
        return this.#localRetirement(database, key);
      } finally { database.close(); }
    }, { timeoutMs: this.#mutationTimeoutMs, requestId: "local-retirement:" + key.runId });
  }

  #localRetirement(database, key) {
    const row = database.prepare(`
      SELECT identity_json, proof_json, committed_at FROM provider_run_local_retirements
      WHERE run_id = ?
    `).get(key.runId);
    if (!row) return null;
    if (row.identity_json !== JSON.stringify(key)) {
      throw new Error("local execution retirement identity changed");
    }
    const record = { identity: JSON.parse(row.identity_json), proof: JSON.parse(row.proof_json),
      committedAt: row.committed_at };
    if (!validLocalExecutionRetirement(record)) throw new Error("invalid local execution retirement proof");
    return record;
  }

  getLocalExecutionRetirement(key) {
    if (!key?.runId) return null;
    const database = this.#database();
    try { return this.#localRetirement(database, key); }
    finally { database.close(); }
  }

  correctFromExactTerminal(value, { priorStatus, priorCommittedAt } = {}) {
    const key = identity(value);
    const previous = String(priorStatus ?? "").trim().toLowerCase();
    const committedAt = String(priorCommittedAt ?? "").trim();
    if (!providerRunTerminalStatusSupported(previous) || !Number.isFinite(Date.parse(committedAt))) {
      throw new Error("prior run terminal evidence is required for correction");
    }
    return this.#mutations.run(() => {
      const database = this.#database();
      try {
        const result = database.prepare(`
          UPDATE provider_run_terminals SET status = ?, committed_at = ?
          WHERE provider = ? AND thread_id = ? AND turn_id = ?
            AND status = ? AND committed_at = ?
        `).run(key.status, new Date().toISOString(), key.provider, key.threadId, key.turnId,
          previous, committedAt);
        const current = terminalRow(database.prepare(`
          SELECT provider, thread_id, turn_id, status, committed_at
          FROM provider_run_terminals WHERE provider = ? AND thread_id = ? AND turn_id = ?
        `).get(key.provider, key.threadId, key.turnId));
        return { corrected: result.changes === 1, current };
      } finally {
        database.close();
      }
    }, {
      timeoutMs: this.#mutationTimeoutMs,
      requestId: `${key.provider}\0${key.threadId}\0${key.turnId}`,
    });
  }

  get(value) {
    const provider = String(value?.provider ?? "").trim().toLowerCase();
    const threadId = String(value?.threadId ?? "").trim();
    const turnId = String(value?.turnId ?? "").trim();
    if (!provider || !threadId || !turnId) {
      throw new Error("provider run terminal identity requires provider, threadId and turnId");
    }
    const database = this.#database();
    try {
      return terminalRow(database.prepare(`
        SELECT provider, thread_id, turn_id, status, committed_at
        FROM provider_run_terminals
        WHERE provider = ? AND thread_id = ? AND turn_id = ?
      `).get(provider, threadId, turnId));
    } finally {
      database.close();
    }
  }
}
