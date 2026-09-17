import { providerRunTerminalStatusSupported } from "../../domain/provider-run-terminal.mjs";
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
