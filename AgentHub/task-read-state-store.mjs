import { openRuntimeDatabase } from "./runtime-state-store.mjs";

const ACCOUNT_ID_MAX_CHARS = 160;
const THREAD_ID_MAX_CHARS = 200;
const TURN_ID_MAX_CHARS = 200;

function normalizedText(value, maxChars, name) {
  const result = String(value ?? "").trim();
  if (!result || result.length > maxChars) throw new Error(`invalid ${name}`);
  return result;
}

function normalizedIdentity(value) {
  const provider = String(value?.provider ?? "").trim().toLowerCase();
  if (!['codex', 'claude'].includes(provider)) throw new Error("invalid read-state provider");
  return {
    accountId: normalizedText(value?.accountId, ACCOUNT_ID_MAX_CHARS, "read-state account"),
    provider,
    threadId: normalizedText(value?.threadId, THREAD_ID_MAX_CHARS, "read-state thread"),
  };
}

function marker(value) {
  const atMs = Number(value?.answerAtMs ?? Date.parse(String(value?.answerAt ?? "")));
  if (!Number.isSafeInteger(atMs) || atMs <= 0) return null;
  const turnId = String(value?.answerTurnId ?? "").trim();
  if (turnId.length > TURN_ID_MAX_CHARS) throw new Error("invalid read-state turn");
  return { atMs, turnId };
}

function rowValue(row) {
  if (!row) return null;
  return {
    accountId: String(row.account_id),
    provider: String(row.provider),
    threadId: String(row.thread_id),
    answerAtMs: Number(row.answer_at_ms) || 0,
    answerTurnId: String(row.answer_turn_id ?? ""),
    readAtMs: Number(row.read_at_ms) || 0,
    updatedAt: String(row.updated_at ?? "") || null,
  };
}

export function taskHasUnreadAnswer(task, cursor) {
  const current = marker(task);
  if (!current) return false;
  if (!cursor) return true;
  if (current.atMs !== Number(cursor.answerAtMs)) return current.atMs > Number(cursor.answerAtMs);
  if (!current.turnId) return false;
  return current.turnId !== String(cursor.answerTurnId ?? "");
}

/**
 * Server-side per-account read cursor. Device IDs are deliberately excluded:
 * a task opened on one trusted phone is read for the same Hub account on every
 * client (Android, local Mini App, VS Code and Desktop).
 */
export class TaskReadStateStore {
  #database;
  #now;

  constructor({ dataDir, now = () => Date.now() } = {}) {
    if (!dataDir) throw new Error("TaskReadStateStore dataDir is required");
    this.#database = openRuntimeDatabase(dataDir);
    this.#now = now;
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS task_read_state (
        account_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        answer_at_ms INTEGER NOT NULL,
        answer_turn_id TEXT NOT NULL DEFAULT '',
        read_at_ms INTEGER NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (account_id, provider, thread_id)
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS task_read_state_account_updated_idx
        ON task_read_state(account_id, updated_at DESC);
    `);
  }

  get(value) {
    const identity = normalizedIdentity(value);
    return rowValue(this.#database.prepare(`
      SELECT account_id, provider, thread_id, answer_at_ms, answer_turn_id, read_at_ms, updated_at
      FROM task_read_state
      WHERE account_id = ? AND provider = ? AND thread_id = ?
    `).get(identity.accountId, identity.provider, identity.threadId));
  }

  markRead(value) {
    const identity = normalizedIdentity(value);
    const next = marker(value);
    if (!next) return this.get(identity);
    const current = this.get(identity);
    if (current && next.atMs < current.answerAtMs) return current;
    if (
      current
      && next.atMs === current.answerAtMs
      && next.turnId === current.answerTurnId
    ) return current;
    const nowMs = Number(this.#now());
    const readAtMs = Number.isSafeInteger(nowMs) && nowMs > 0 ? nowMs : Date.now();
    const updatedAt = new Date(readAtMs).toISOString();
    this.#database.prepare(`
      INSERT INTO task_read_state
        (account_id, provider, thread_id, answer_at_ms, answer_turn_id, read_at_ms, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(account_id, provider, thread_id) DO UPDATE SET
        answer_at_ms = excluded.answer_at_ms,
        answer_turn_id = excluded.answer_turn_id,
        read_at_ms = excluded.read_at_ms,
        updated_at = excluded.updated_at
    `).run(
      identity.accountId,
      identity.provider,
      identity.threadId,
      next.atMs,
      next.turnId,
      readAtMs,
      updatedAt,
    );
    return {
      ...identity,
      answerAtMs: next.atMs,
      answerTurnId: next.turnId,
      readAtMs,
      updatedAt,
    };
  }

  close() {
    this.#database?.close();
    this.#database = null;
  }
}
