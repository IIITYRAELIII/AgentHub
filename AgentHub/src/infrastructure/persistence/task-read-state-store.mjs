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
  const revision = Number(value?.answerRevision ?? value?.revision ?? 0);
  if (!Number.isSafeInteger(revision) || revision < 0) throw new Error("invalid read-state revision");
  return { atMs, turnId, revision };
}

function compareCanonicalFinal(left, right) {
  if (left.atMs !== right.atMs) return left.atMs > right.atMs ? 1 : -1;
  const leftExact = Boolean(left.turnId && left.revision > 0);
  const rightExact = Boolean(right.turnId && right.revision > 0);
  if (leftExact !== rightExact) return leftExact ? 1 : -1;
  if (!leftExact) return 0;
  if (left.turnId === right.turnId) {
    return left.revision === right.revision ? 0 : left.revision > right.revision ? 1 : -1;
  }
  return left.turnId > right.turnId ? 1 : -1;
}

function rowValue(row) {
  if (!row) return null;
  return {
    accountId: String(row.account_id),
    provider: String(row.provider),
    threadId: String(row.thread_id),
    answerAtMs: Number(row.answer_at_ms) || 0,
    answerTurnId: String(row.answer_turn_id ?? ""),
    answerRevision: Number(row.answer_revision) || 0,
    readAtMs: Number(row.read_at_ms) || 0,
    updatedAt: String(row.updated_at ?? "") || null,
  };
}

export function taskHasUnreadAnswer(task, cursor) {
  const current = marker(task);
  if (!current) return false;
  if (!cursor) return true;
  const read = marker(cursor);
  if (!read) return true;
  if (
    task?.migrationGuard === "legacy-terminal-revision"
    && current.atMs === read.atMs
    && current.turnId
    && current.turnId === read.turnId
    && current.revision === 1
    && read.revision === 0
  ) return false;
  return compareCanonicalFinal(current, read) > 0;
}

/**
 * Server-side per-account read cursor. Device IDs are deliberately excluded:
 * a task opened on one trusted phone is read for the same Hub account on every
 * client (Android, local Mini App, VS Code and Desktop).
 */
export class TaskReadStateStore {
  #database;
  #now;
  #revision = 0;

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
        answer_revision INTEGER NOT NULL DEFAULT 0,
        read_at_ms INTEGER NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (account_id, provider, thread_id)
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS task_read_state_account_updated_idx
        ON task_read_state(account_id, updated_at DESC);
    `);
    const columns = new Set(this.#database.prepare("PRAGMA table_info(task_read_state)").all()
      .map((column) => String(column.name)));
    if (!columns.has("answer_revision")) {
      this.#database.exec("ALTER TABLE task_read_state ADD COLUMN answer_revision INTEGER NOT NULL DEFAULT 0");
    }
  }

  get(value) {
    const identity = normalizedIdentity(value);
    return rowValue(this.#database.prepare(`
      SELECT account_id, provider, thread_id, answer_at_ms, answer_turn_id, answer_revision, read_at_ms, updated_at
      FROM task_read_state
      WHERE account_id = ? AND provider = ? AND thread_id = ?
    `).get(identity.accountId, identity.provider, identity.threadId));
  }

  get revision() { return this.#revision; }

  markRead(value) {
    const identity = normalizedIdentity(value);
    const next = marker(value);
    if (!next) return this.get(identity);
    const nowMs = Number(this.#now());
    const readAtMs = Number.isSafeInteger(nowMs) && nowMs > 0 ? nowMs : Date.now();
    const updatedAt = new Date(readAtMs).toISOString();
    const result = this.#database.prepare(`
      INSERT INTO task_read_state
        (account_id, provider, thread_id, answer_at_ms, answer_turn_id, answer_revision, read_at_ms, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(account_id, provider, thread_id) DO UPDATE SET
        answer_at_ms = excluded.answer_at_ms,
        answer_turn_id = excluded.answer_turn_id,
        answer_revision = excluded.answer_revision,
        read_at_ms = excluded.read_at_ms,
        updated_at = excluded.updated_at
      WHERE NOT (
        excluded.answer_turn_id = task_read_state.answer_turn_id
        AND excluded.answer_revision = task_read_state.answer_revision
      ) AND (
        excluded.answer_at_ms > task_read_state.answer_at_ms
        OR (
          excluded.answer_at_ms = task_read_state.answer_at_ms
          AND (
            (
              excluded.answer_turn_id <> ''
              AND excluded.answer_revision > 0
              AND (
                task_read_state.answer_turn_id = ''
                OR task_read_state.answer_revision <= 0
                OR (
                  excluded.answer_turn_id = task_read_state.answer_turn_id
                  AND excluded.answer_revision > task_read_state.answer_revision
                )
                OR (
                  excluded.answer_turn_id <> task_read_state.answer_turn_id
                  AND excluded.answer_turn_id > task_read_state.answer_turn_id
                )
              )
            )
          )
        )
      )
    `).run(
      identity.accountId,
      identity.provider,
      identity.threadId,
      next.atMs,
      next.turnId,
      next.revision,
      readAtMs,
      updatedAt,
    );
    if (result.changes > 0) this.#revision += 1;
    return this.get(identity);
  }

  close() {
    this.#database?.close();
    this.#database = null;
  }
}
