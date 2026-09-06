import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { STREAM_MESSAGE_PIN_LIMIT } from "../../domain/stream-message-pin.mjs";

function rowValue(row) {
  if (!row) return null;
  return {
    id: String(row.pin_id),
    streamId: String(row.stream_id),
    messageKey: String(row.message_key),
    sourceAlias: String(row.source_alias),
    provider: String(row.provider),
    taskThreadId: String(row.task_thread_id),
    turnThreadId: String(row.turn_thread_id),
    turnId: String(row.turn_id),
    itemId: String(row.item_id),
    role: String(row.role),
    clientUserMessageId: row.client_user_message_id ? String(row.client_user_message_id) : "",
    semanticSlot: String(row.semantic_slot),
    preview: String(row.preview),
    author: String(row.author),
    time: row.occurred_at ? String(row.occurred_at) : null,
    pinnedAt: new Date(Number(row.pinned_at_ms)).toISOString(),
    pinnedAtMs: Number(row.pinned_at_ms),
    updatedAt: new Date(Number(row.updated_at_ms)).toISOString(),
    available: Number(row.available) === 1,
  };
}

export class StreamMessagePinStore {
  #database;
  #now;

  constructor({ databaseFile, now = () => Date.now() } = {}) {
    if (!String(databaseFile ?? "").trim()) throw new TypeError("databaseFile is required");
    const file = path.resolve(databaseFile);
    mkdirSync(path.dirname(file), { recursive: true });
    this.#database = new DatabaseSync(file);
    this.#now = now;
    this.#database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA busy_timeout = 5000;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS stream_message_pin_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS stream_message_pins (
        pin_id TEXT PRIMARY KEY,
        stream_id TEXT NOT NULL,
        message_key TEXT NOT NULL,
        source_alias TEXT NOT NULL,
        provider TEXT NOT NULL,
        task_thread_id TEXT NOT NULL,
        turn_thread_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        item_id TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('user', 'agent')),
        client_user_message_id TEXT,
        semantic_slot TEXT NOT NULL,
        preview TEXT NOT NULL,
        author TEXT NOT NULL DEFAULT '',
        occurred_at TEXT,
        pinned_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        available INTEGER NOT NULL CHECK (available IN (0, 1)),
        FOREIGN KEY (stream_id) REFERENCES hub_streams(id) ON DELETE CASCADE,
        UNIQUE (stream_id, message_key),
        UNIQUE (stream_id, provider, task_thread_id, turn_id, item_id, role)
      );
      CREATE INDEX IF NOT EXISTS stream_message_pins_stream_order
        ON stream_message_pins(stream_id, pinned_at_ms DESC, message_key);
      INSERT OR IGNORE INTO stream_message_pin_meta (key, value) VALUES ('revision', '0');
    `);
  }

  get revision() {
    return Number(this.#database.prepare(
      "SELECT value FROM stream_message_pin_meta WHERE key = 'revision'",
    ).get()?.value ?? 0) || 0;
  }

  #advanceRevision() {
    this.#database.prepare(`
      UPDATE stream_message_pin_meta SET value = CAST(value AS INTEGER) + 1 WHERE key = 'revision'
    `).run();
  }

  #transaction(operation) {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.#database.exec("COMMIT");
      return result;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  list(streamId = "") {
    const id = String(streamId ?? "").trim();
    const rows = id ? this.#database.prepare(`
      SELECT * FROM stream_message_pins WHERE stream_id = ?
      ORDER BY pinned_at_ms DESC, message_key
    `).all(id) : this.#database.prepare(`
      SELECT * FROM stream_message_pins
      ORDER BY stream_id, pinned_at_ms DESC, message_key
    `).all();
    return rows.map(rowValue);
  }

  get(pinId) {
    return rowValue(this.#database.prepare(
      "SELECT * FROM stream_message_pins WHERE pin_id = ?",
    ).get(String(pinId ?? "").trim()));
  }

  pin(value) {
    const streamId = String(value?.streamId ?? "").trim();
    const messageKey = String(value?.messageKey ?? "").trim();
    if (!streamId || !messageKey) throw new Error("Закрепление не содержит durable identity");
    const existing = rowValue(this.#database.prepare(`
      SELECT * FROM stream_message_pins WHERE stream_id = ? AND message_key = ?
    `).get(streamId, messageKey));
    if (existing) return { pin: existing, changed: false };
    const nowMs = Number(this.#now());
    const timestamp = Number.isSafeInteger(nowMs) && nowMs > 0 ? nowMs : Date.now();
    const pinId = randomUUID();
    return this.#transaction(() => {
      const count = Number(this.#database.prepare(`
        SELECT COUNT(*) AS count FROM stream_message_pins WHERE stream_id = ?
      `).get(streamId)?.count ?? 0);
      if (count >= STREAM_MESSAGE_PIN_LIMIT) {
        throw new Error(`В одном Stream можно закрепить не больше ${STREAM_MESSAGE_PIN_LIMIT} сообщений`);
      }
      this.#database.prepare(`
        INSERT INTO stream_message_pins (
          pin_id, stream_id, message_key, source_alias, provider, task_thread_id,
          turn_thread_id, turn_id, item_id, role, client_user_message_id,
          semantic_slot, preview, author, occurred_at, pinned_at_ms, updated_at_ms, available
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
      `).run(
        pinId,
        streamId,
        messageKey,
        String(value.sourceAlias ?? ""),
        String(value.provider ?? ""),
        String(value.taskThreadId ?? ""),
        String(value.turnThreadId ?? value.taskThreadId ?? ""),
        String(value.turnId ?? ""),
        String(value.itemId ?? ""),
        String(value.role ?? ""),
        String(value.clientUserMessageId ?? "") || null,
        String(value.semanticSlot ?? ""),
        String(value.preview ?? "").slice(0, 320),
        String(value.author ?? "").slice(0, 1_000),
        value.time ? String(value.time) : null,
        timestamp,
        timestamp,
      );
      this.#advanceRevision();
      return { pin: this.get(pinId), changed: true };
    });
  }

  unpin({ pinId, streamId, messageKey } = {}) {
    const id = String(pinId ?? "").trim();
    const owner = String(streamId ?? "").trim();
    const key = String(messageKey ?? "").trim();
    const existing = id ? this.get(id) : rowValue(this.#database.prepare(`
      SELECT * FROM stream_message_pins WHERE stream_id = ? AND message_key = ?
    `).get(owner, key));
    if (!existing || (owner && existing.streamId !== owner)) return { pin: null, changed: false };
    this.#transaction(() => {
      this.#database.prepare("DELETE FROM stream_message_pins WHERE pin_id = ?").run(existing.id);
      this.#advanceRevision();
    });
    return { pin: existing, changed: true };
  }

  clear(streamId) {
    const id = String(streamId ?? "").trim();
    if (!id) throw new Error("Укажите Stream");
    const pins = this.list(id);
    if (!pins.length) return { pins: [], changed: false };
    this.#transaction(() => {
      this.#database.prepare("DELETE FROM stream_message_pins WHERE stream_id = ?").run(id);
      this.#advanceRevision();
    });
    return { pins, changed: true };
  }

  setAvailability(pinId, available) {
    const result = this.#database.prepare(`
      UPDATE stream_message_pins SET available = ?, updated_at_ms = ?
      WHERE pin_id = ? AND available <> ?
    `).run(available ? 1 : 0, Number(this.#now()) || Date.now(), String(pinId ?? ""), available ? 1 : 0);
    if (result.changes > 0) this.#advanceRevision();
    return result.changes > 0;
  }

  close() {
    this.#database?.close();
    this.#database = null;
  }
}
