import { createHash } from "node:crypto";

import { consistentInterstreamRecordIdentity } from "../../domain/interstream-message.mjs";
import { AsyncSqliteMutationQueue } from "./async-sqlite-mutation-queue.mjs";
import { openRuntimeDatabase } from "./runtime-state-store.mjs";

const OUTBOX_STATES = new Set(["pending", "projecting", "delivered", "superseded"]);
const TELEGRAM_STATES = new Set(["not-requested", "intent", "uncertain", "acked", "failed", "superseded"]);
const COMMAND_STATES = new Set(["not-required", "intent", "acked", "superseded"]);
const NON_TERMINAL_STATUSES = new Set(["active", "inprogress", "running", "finishing", "progress"]);
const TERMINAL_PAYLOAD_METADATA_MIGRATION_LIMIT = 200;
const TERMINAL_PAYLOAD_METADATA_SAMPLE_CHARS = (2 * 1024 * 1024) + 1;

function text(value) {
  return String(value ?? "").trim();
}

function boundedClientUserMessageId(value) {
  const id = text(value);
  return id && id.length <= 200 && !id.includes("\0") ? id : "";
}

function identity(value) {
  const provider = text(value?.provider).toLowerCase();
  const threadId = text(value?.threadId);
  const turnId = text(value?.turnId);
  if (!provider || !threadId || !turnId) {
    throw new Error("provider turn terminal identity requires provider, threadId and turnId");
  }
  return { provider, threadId, turnId };
}

function jsonValue(value) {
  return JSON.parse(JSON.stringify(value ?? null));
}

function sanitizeMessageIdentity(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const rootMessage = (Array.isArray(value.userMessages) ? value.userMessages : [])
    .find((message) => message?.role === "user") ?? null;
  const identity = consistentInterstreamRecordIdentity({
    clientUserMessageIds: [value.clientUserMessageId, rootMessage?.clientUserMessageId],
    origins: [
      value.messageOrigin ?? value.origin,
      rootMessage?.origin ?? rootMessage?.messageOrigin,
    ],
  });
  if (identity.conflicted) {
    delete value.clientUserMessageId;
    delete value.messageOrigin;
    delete value.origin;
    if (rootMessage) {
      delete rootMessage.clientUserMessageId;
      delete rootMessage.messageOrigin;
      delete rootMessage.origin;
    }
  }
  if (!identity.conflicted && identity.clientUserMessageId) {
    value.clientUserMessageId = identity.clientUserMessageId;
  }
  if (Array.isArray(value.userMessages)) {
    value.userMessages = value.userMessages.map((message) => sanitizeMessageIdentity(message));
  }
  return value;
}

function sanitizedTerminalPayload(value) {
  const payload = jsonValue(value ?? {});
  sanitizeMessageIdentity(payload?.completion);
  sanitizeMessageIdentity(payload?.history);
  return payload;
}

function contentHash(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function parseJson(value, fallback = null) {
  try {
    return JSON.parse(String(value ?? ""));
  } catch {
    return fallback;
  }
}

function terminalRow(row) {
  if (!row) return null;
  return {
    provider: String(row.provider),
    threadId: String(row.thread_id),
    turnId: String(row.turn_id),
    terminalRevision: Number(row.terminal_revision),
    status: String(row.status),
    finalAnswer: String(row.final_answer),
    usageIdentity: String(row.usage_identity),
    lastMessage: parseJson(row.last_message_json),
    payload: parseJson(row.payload_json, {}),
    contentHash: String(row.content_hash),
    committedAt: String(row.committed_at),
  };
}

function outboxRow(row) {
  if (!row) return null;
  const state = String(row.state);
  if (!OUTBOX_STATES.has(state)) throw new Error(`invalid terminal outbox state ${state}`);
  const telegramState = String(row.telegram_state ?? "not-requested");
  const commandState = String(row.command_state ?? "not-required");
  if (!TELEGRAM_STATES.has(telegramState)) throw new Error(`invalid Telegram intent state ${telegramState}`);
  if (!COMMAND_STATES.has(commandState)) throw new Error(`invalid command reconciliation state ${commandState}`);
  return {
    provider: String(row.provider),
    threadId: String(row.thread_id),
    turnId: String(row.turn_id),
    terminalRevision: Number(row.terminal_revision),
    state,
    attempts: Number(row.attempt_count) || 0,
    lastError: String(row.last_error ?? ""),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    payload: parseJson(row.payload_json, {}),
    channels: {
      projection: { state },
      command: {
        state: commandState,
        clientUserMessageId: String(row.command_client_user_message_id ?? "") || null,
        lastError: String(row.command_last_error ?? ""),
        updatedAt: String(row.command_updated_at ?? "") || null,
      },
      telegram: {
        state: telegramState,
        intent: parseJson(row.telegram_intent_json),
        deliveryId: String(row.telegram_delivery_id ?? "") || null,
        lastError: String(row.telegram_last_error ?? ""),
        updatedAt: String(row.telegram_updated_at ?? "") || null,
      },
    },
  };
}

function configure(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS provider_turn_terminals (
      provider TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      terminal_revision INTEGER NOT NULL,
      status TEXT NOT NULL,
      final_answer TEXT NOT NULL,
      usage_identity TEXT NOT NULL,
      last_message_json TEXT,
      payload_json TEXT NOT NULL,
      payload_bytes INTEGER NOT NULL DEFAULT 0,
      content_hash TEXT NOT NULL,
      committed_at TEXT NOT NULL,
      PRIMARY KEY (provider, thread_id, turn_id)
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS provider_turn_terminal_outbox (
      provider TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      terminal_revision INTEGER NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('pending', 'projecting', 'delivered', 'superseded')),
      attempt_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      payload_json TEXT NOT NULL,
      command_state TEXT NOT NULL DEFAULT 'not-required',
      command_client_user_message_id TEXT,
      command_last_error TEXT,
      command_updated_at TEXT,
      telegram_state TEXT NOT NULL DEFAULT 'not-requested',
      telegram_intent_json TEXT,
      telegram_delivery_id TEXT,
      telegram_last_error TEXT,
      telegram_updated_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (provider, thread_id, turn_id, terminal_revision)
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS provider_turn_terminal_outbox_pending_idx
      ON provider_turn_terminal_outbox(state, created_at, provider, thread_id, turn_id, terminal_revision);
  `);
  const terminalColumns = new Set(database.prepare("PRAGMA table_info(provider_turn_terminals)").all()
    .map((column) => String(column.name)));
  if (!terminalColumns.has("payload_bytes")) {
    database.exec("ALTER TABLE provider_turn_terminals ADD COLUMN payload_bytes INTEGER NOT NULL DEFAULT 0;");
  }
  database.exec(`
    CREATE INDEX IF NOT EXISTS provider_turn_terminals_recovery_idx
      ON provider_turn_terminals(committed_at DESC, provider, thread_id, turn_id, payload_bytes);
  `);
  // Only the newest bounded recovery window is migrated eagerly. substr caps
  // legacy blob inspection while still distinguishing every admissible
  // payload (<= 2 MiB) from an oversized candidate. New writes persist exact
  // byte length without asking SQLite to rescan JSON.
  database.prepare(`
    UPDATE provider_turn_terminals
    SET payload_bytes = length(CAST(substr(payload_json, 1, ?) AS BLOB))
    WHERE (provider, thread_id, turn_id) IN (
      SELECT provider, thread_id, turn_id
      FROM provider_turn_terminals
      WHERE payload_bytes = 0
      ORDER BY committed_at DESC, provider, thread_id, turn_id
      LIMIT ?
    )
  `).run(
    TERMINAL_PAYLOAD_METADATA_SAMPLE_CHARS,
    TERMINAL_PAYLOAD_METADATA_MIGRATION_LIMIT,
  );
  const columns = new Set(database.prepare("PRAGMA table_info(provider_turn_terminal_outbox)").all()
    .map((column) => String(column.name)));
  for (const [name, definition] of [
    ["command_state", "TEXT NOT NULL DEFAULT 'not-required'"],
    ["command_client_user_message_id", "TEXT"],
    ["command_last_error", "TEXT"],
    ["command_updated_at", "TEXT"],
    ["telegram_state", "TEXT NOT NULL DEFAULT 'not-requested'"],
    ["telegram_intent_json", "TEXT"],
    ["telegram_delivery_id", "TEXT"],
    ["telegram_last_error", "TEXT"],
    ["telegram_updated_at", "TEXT"],
  ]) {
    if (!columns.has(name)) database.exec(`ALTER TABLE provider_turn_terminal_outbox ADD COLUMN ${name} ${definition};`);
  }
  const legacyCommandRows = database.prepare(`
    SELECT provider, thread_id, turn_id, terminal_revision, payload_json
    FROM provider_turn_terminal_outbox
    WHERE command_state = 'not-required'
  `).all();
  const migrateCommand = database.prepare(`
    UPDATE provider_turn_terminal_outbox
    SET command_state = 'intent', command_client_user_message_id = ?, command_updated_at = ?
    WHERE provider = ? AND thread_id = ? AND turn_id = ? AND terminal_revision = ?
      AND command_state = 'not-required'
  `);
  const migrationAt = new Date().toISOString();
  for (const row of legacyCommandRows) {
    const payload = parseJson(row.payload_json, {});
    const clientUserMessageId = boundedClientUserMessageId(
      payload?.history?.clientUserMessageId ?? payload?.completion?.clientUserMessageId,
    );
    if (clientUserMessageId) {
      migrateCommand.run(
        clientUserMessageId, migrationAt,
        row.provider, row.thread_id, row.turn_id, row.terminal_revision,
      );
    }
  }
  database.exec(`
    CREATE INDEX IF NOT EXISTS provider_turn_terminal_outbox_telegram_idx
      ON provider_turn_terminal_outbox(telegram_state, created_at, provider, thread_id, turn_id, terminal_revision);
  `);
}

function selectTerminal(database, key) {
  return terminalRow(database.prepare(`
    SELECT provider, thread_id, turn_id, terminal_revision, status, final_answer,
      usage_identity, last_message_json, payload_json, content_hash, committed_at
    FROM provider_turn_terminals
    WHERE provider = ? AND thread_id = ? AND turn_id = ?
  `).get(key.provider, key.threadId, key.turnId));
}

function selectOutbox(database, key) {
  return outboxRow(database.prepare(`
    SELECT provider, thread_id, turn_id, terminal_revision, state, attempt_count,
      last_error, payload_json, command_state, command_client_user_message_id,
      command_last_error, command_updated_at, telegram_state, telegram_intent_json,
      telegram_delivery_id, telegram_last_error, telegram_updated_at, created_at, updated_at
    FROM provider_turn_terminal_outbox
    WHERE provider = ? AND thread_id = ? AND turn_id = ? AND terminal_revision = ?
  `).get(key.provider, key.threadId, key.turnId, Number(key.terminalRevision)));
}

export class ProviderTurnTerminalStore {
  #dataDir;
  #tail = Promise.resolve();
  #mutations = new AsyncSqliteMutationQueue();
  #mutationTimeoutMs;
  #configured = false;

  constructor({ dataDir, mutationTimeoutMs = 5_000 }) {
    if (!dataDir) throw new Error("ProviderTurnTerminalStore dataDir is required");
    this.#dataDir = dataDir;
    this.#mutationTimeoutMs = Math.max(1, Number(mutationTimeoutMs) || 5_000);
  }

  #enqueue(operation, requestId = null) {
    const execute = requestId
      ? () => this.#mutations.run(operation, {
          timeoutMs: this.#mutationTimeoutMs,
          requestId,
        })
      : operation;
    const next = this.#tail.then(execute, execute);
    this.#tail = next.catch(() => {});
    return next;
  }

  #database() {
    const database = openRuntimeDatabase(this.#dataDir);
    if (!this.#configured) {
      configure(database);
      this.#configured = true;
    }
    return database;
  }

  commit(value) {
    const key = identity(value);
    const expectedTerminalRevision = value.expectedTerminalRevision == null
      ? null
      : Number(value.expectedTerminalRevision);
    if (expectedTerminalRevision != null
      && (!Number.isSafeInteger(expectedTerminalRevision) || expectedTerminalRevision < 1)) {
      throw new Error("expected terminal revision must be a positive safe integer");
    }
    const basePayload = sanitizedTerminalPayload(value.payload);
    const status = text(value.status) || "completed";
    const finalAnswer = String(value.finalAnswer ?? "").trim();
    const usageIdentity = text(value.usageIdentity);
    const lastMessage = value.lastMessage == null ? null : jsonValue(value.lastMessage);
    const telegramIntent = value.channels?.telegram?.requested === true
      ? jsonValue(value.channels.telegram)
      : null;
    const hash = contentHash({
      status,
      finalAnswer,
      usageIdentity,
      lastMessageText: String(lastMessage?.text ?? "").trim(),
      responseAttachments: basePayload?.completion?.responseAttachments ?? [],
      telegramIntent,
    });
    return this.#enqueue(() => {
      const database = this.#database();
      try {
        database.exec("BEGIN IMMEDIATE");
        const current = selectTerminal(database, key);
        if (expectedTerminalRevision != null
          && current?.terminalRevision !== expectedTerminalRevision) {
          database.exec("COMMIT");
          return {
            terminal: current,
            outbox: current ? selectOutbox(database, current) : null,
            created: false,
            conflict: true,
          };
        }
        if (NON_TERMINAL_STATUSES.has(status.toLowerCase())) {
          if (!current) throw new Error(`cannot commit non-terminal provider turn status ${status}`);
          database.exec("COMMIT");
          return {
            terminal: current,
            outbox: selectOutbox(database, current),
            created: false,
            absorbed: true,
          };
        }
        if (current?.contentHash === hash) {
          database.exec("COMMIT");
          return { terminal: current, outbox: selectOutbox(database, current), created: false };
        }
        const terminalRevision = (current?.terminalRevision ?? 0) + 1;
        const committedAt = new Date().toISOString();
        const revisionIdentity = { ...key, terminalRevision };
        const revisionLastMessage = lastMessage ? {
          ...lastMessage,
          ...revisionIdentity,
          identity: `${key.provider}\0${key.threadId}\0${key.turnId}\0${terminalRevision}`,
        } : null;
        const payload = {
          ...basePayload,
          identity: revisionIdentity,
          terminalRevision,
          lastMessage: revisionLastMessage,
        };
        const revisionTelegramIntent = telegramIntent ? {
          ...telegramIntent,
          id: `${key.provider}\0${key.threadId}\0${key.turnId}\0${terminalRevision}\0telegram`,
          identity: revisionIdentity,
          channel: "telegram",
        } : null;
        const commandClientUserMessageId = boundedClientUserMessageId(
          basePayload?.history?.clientUserMessageId ?? basePayload?.completion?.clientUserMessageId,
        );
        const payloadJson = JSON.stringify(payload);
        database.prepare(`
          INSERT INTO provider_turn_terminals (
            provider, thread_id, turn_id, terminal_revision, status, final_answer,
            usage_identity, last_message_json, payload_json, payload_bytes, content_hash, committed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(provider, thread_id, turn_id) DO UPDATE SET
            terminal_revision = excluded.terminal_revision,
            status = excluded.status,
            final_answer = excluded.final_answer,
            usage_identity = excluded.usage_identity,
            last_message_json = excluded.last_message_json,
            payload_json = excluded.payload_json,
            payload_bytes = excluded.payload_bytes,
            content_hash = excluded.content_hash,
            committed_at = excluded.committed_at
        `).run(
          key.provider, key.threadId, key.turnId, terminalRevision, status, finalAnswer,
          usageIdentity, revisionLastMessage ? JSON.stringify(revisionLastMessage) : null,
          payloadJson, Buffer.byteLength(payloadJson, "utf8"), hash, committedAt,
        );
        database.prepare(`
          UPDATE provider_turn_terminal_outbox
          SET state = CASE
                WHEN state IN ('pending', 'projecting') THEN 'superseded'
                ELSE state
              END,
              command_state = CASE
                WHEN command_state = 'intent' THEN 'superseded'
                ELSE command_state
              END,
              telegram_state = CASE
                WHEN telegram_state IN ('intent', 'uncertain') THEN 'superseded'
                ELSE telegram_state
              END,
              updated_at = ?, telegram_updated_at = ?
          WHERE provider = ? AND thread_id = ? AND turn_id = ?
            AND (
              state IN ('pending', 'projecting')
              OR command_state = 'intent'
              OR telegram_state IN ('intent', 'uncertain')
            )
        `).run(committedAt, committedAt, key.provider, key.threadId, key.turnId);
        database.prepare(`
          INSERT INTO provider_turn_terminal_outbox (
            provider, thread_id, turn_id, terminal_revision, state, attempt_count,
            last_error, payload_json, command_state, command_client_user_message_id,
            command_updated_at, telegram_state, telegram_intent_json,
            telegram_updated_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, 'pending', 0, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          key.provider, key.threadId, key.turnId, terminalRevision,
          payloadJson,
          commandClientUserMessageId ? "intent" : "not-required",
          commandClientUserMessageId || null,
          committedAt,
          revisionTelegramIntent ? "intent" : "not-requested",
          revisionTelegramIntent ? JSON.stringify(revisionTelegramIntent) : null,
          committedAt, committedAt, committedAt,
        );
        database.exec("COMMIT");
        return {
          terminal: selectTerminal(database, revisionIdentity),
          outbox: selectOutbox(database, revisionIdentity),
          created: true,
        };
      } catch (error) {
        try { database.exec("ROLLBACK"); } catch {}
        throw error;
      } finally {
        database.close();
      }
    }, `${key.provider}\0${key.threadId}\0${key.turnId}`);
  }

  get(value) {
    const key = identity(value);
    return this.#enqueue(() => {
      const database = this.#database();
      try { return selectTerminal(database, key); } finally { database.close(); }
    });
  }

  pending({ limit = 100 } = {}) {
    return this.#enqueue(() => {
      const database = this.#database();
      try {
        return database.prepare(`
          SELECT provider, thread_id, turn_id, terminal_revision, state, attempt_count,
            last_error, payload_json, command_state, command_client_user_message_id,
            command_last_error, command_updated_at, telegram_state, telegram_intent_json,
            telegram_delivery_id, telegram_last_error, telegram_updated_at, created_at, updated_at
          FROM provider_turn_terminal_outbox
          WHERE state = 'pending' OR command_state = 'intent' OR telegram_state IN ('intent', 'uncertain')
          ORDER BY created_at, provider, thread_id, turn_id, terminal_revision
          LIMIT ?
        `).all(Math.max(1, Math.min(1_000, Number(limit) || 100))).map(outboxRow);
      } finally {
        database.close();
      }
    });
  }

  recoverProjecting() {
    return this.#enqueue(() => {
      const database = this.#database();
      try {
        const now = new Date().toISOString();
        const result = database.prepare(`
          UPDATE provider_turn_terminal_outbox
          SET state = 'pending', updated_at = ?
          WHERE state = 'projecting'
        `).run(now);
        return Number(result.changes) || 0;
      } finally {
        database.close();
      }
    });
  }

  claim(value) {
    const key = { ...identity(value), terminalRevision: Number(value?.terminalRevision) };
    if (!Number.isSafeInteger(key.terminalRevision) || key.terminalRevision < 1) {
      throw new Error("terminal outbox claim requires terminalRevision");
    }
    return this.#enqueue(() => {
      const database = this.#database();
      try {
        const now = new Date().toISOString();
        const result = database.prepare(`
          UPDATE provider_turn_terminal_outbox
          SET state = 'projecting', attempt_count = attempt_count + 1, updated_at = ?
          WHERE provider = ? AND thread_id = ? AND turn_id = ? AND terminal_revision = ?
            AND state = 'pending'
        `).run(now, key.provider, key.threadId, key.turnId, key.terminalRevision);
        return Number(result.changes) === 1 ? selectOutbox(database, key) : null;
      } finally {
        database.close();
      }
    });
  }

  acknowledge(value) {
    return this.#transition(value, "delivered", "");
  }

  retry(value, error) {
    return this.#transition(value, "pending", String(error?.message ?? error ?? "projection failed"));
  }

  updateChannel(value, channel, state, { deliveryId = null, error = "" } = {}) {
    if (channel !== "telegram") throw new Error(`unsupported terminal delivery channel ${channel}`);
    if (!["uncertain", "acked", "failed"].includes(state)) {
      throw new Error(`invalid terminal Telegram transition ${state}`);
    }
    const key = { ...identity(value), terminalRevision: Number(value?.terminalRevision) };
    if (!Number.isSafeInteger(key.terminalRevision) || key.terminalRevision < 1) {
      throw new Error("terminal channel transition requires terminalRevision");
    }
    return this.#enqueue(() => {
      const database = this.#database();
      try {
        const now = new Date().toISOString();
        const allowed = state === "uncertain"
          ? ["intent", "uncertain"]
          : state === "acked" ? ["intent", "uncertain", "acked"] : ["intent", "uncertain"];
        const placeholders = allowed.map(() => "?").join(", ");
        database.prepare(`
          UPDATE provider_turn_terminal_outbox
          SET telegram_state = ?, telegram_delivery_id = COALESCE(?, telegram_delivery_id),
              telegram_last_error = ?, telegram_updated_at = ?, updated_at = ?
          WHERE provider = ? AND thread_id = ? AND turn_id = ? AND terminal_revision = ?
            AND telegram_state IN (${placeholders})
        `).run(
          state, deliveryId || null, error || null, now, now,
          key.provider, key.threadId, key.turnId, key.terminalRevision,
          ...allowed,
        );
        return selectOutbox(database, key);
      } finally {
        database.close();
      }
    });
  }

  acknowledgeCommand(value, { error = "" } = {}) {
    const key = { ...identity(value), terminalRevision: Number(value?.terminalRevision) };
    if (!Number.isSafeInteger(key.terminalRevision) || key.terminalRevision < 1) {
      throw new Error("terminal command acknowledgement requires terminalRevision");
    }
    return this.#enqueue(() => {
      const database = this.#database();
      try {
        const now = new Date().toISOString();
        database.prepare(`
          UPDATE provider_turn_terminal_outbox
          SET command_state = 'acked', command_last_error = ?, command_updated_at = ?, updated_at = ?
          WHERE provider = ? AND thread_id = ? AND turn_id = ? AND terminal_revision = ?
            AND command_state IN ('intent', 'acked')
        `).run(
          error || null, now, now,
          key.provider, key.threadId, key.turnId, key.terminalRevision,
        );
        return selectOutbox(database, key);
      } finally {
        database.close();
      }
    });
  }

  #transition(value, state, lastError) {
    const key = { ...identity(value), terminalRevision: Number(value?.terminalRevision) };
    if (!Number.isSafeInteger(key.terminalRevision) || key.terminalRevision < 1) {
      throw new Error("terminal outbox transition requires terminalRevision");
    }
    return this.#enqueue(() => {
      const database = this.#database();
      try {
        const now = new Date().toISOString();
        const result = database.prepare(`
          UPDATE provider_turn_terminal_outbox
          SET state = ?,
              last_error = ?,
              updated_at = ?
          WHERE provider = ? AND thread_id = ? AND turn_id = ? AND terminal_revision = ?
            AND state = 'projecting'
        `).run(
          state, lastError || null, now,
          key.provider, key.threadId, key.turnId, key.terminalRevision,
        );
        return Number(result.changes) === 1 ? selectOutbox(database, key) : null;
      } finally {
        database.close();
      }
    });
  }
}
