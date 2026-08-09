import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  normalizedTaskBucket,
  normalizedTaskCategory,
  normalizedTaskText,
} from "../../domain/task-board-task.mjs";

function configure(database) {
  database.exec("PRAGMA busy_timeout = 5000");
  database.exec("PRAGMA journal_mode = WAL");
  database.exec(`
    CREATE TABLE IF NOT EXISTS hub_board_tasks (
      id TEXT PRIMARY KEY,
      raw_text TEXT NOT NULL,
      corrected_text TEXT,
      category TEXT NOT NULL DEFAULT 'unknown',
      bucket TEXT NOT NULL DEFAULT 'backlog',
      status TEXT NOT NULL DEFAULT 'open',
      workspace_id TEXT,
      stream_id TEXT,
      source TEXT NOT NULL DEFAULT 'hub',
      source_key TEXT UNIQUE,
      source_json TEXT NOT NULL DEFAULT '{}',
      placement_source TEXT NOT NULL DEFAULT 'default',
      triage_status TEXT NOT NULL DEFAULT 'pending',
      triage_confidence REAL,
      triage_reason TEXT,
      triage_error TEXT,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      started_at_ms INTEGER,
      completed_at_ms INTEGER
    );
    CREATE INDEX IF NOT EXISTS hub_board_tasks_location_idx
      ON hub_board_tasks(status, bucket, workspace_id, updated_at_ms DESC);
    CREATE INDEX IF NOT EXISTS hub_board_tasks_triage_idx
      ON hub_board_tasks(triage_status, created_at_ms);
    CREATE TABLE IF NOT EXISTS hub_board_capture_chats (
      chat_id INTEGER PRIMARY KEY,
      enabled INTEGER NOT NULL DEFAULT 0,
      updated_at_ms INTEGER NOT NULL
    );
  `);
}

function parseJson(value) {
  try {
    const parsed = JSON.parse(String(value ?? "{}"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function taskFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    rawText: row.raw_text,
    correctedText: row.corrected_text ?? "",
    category: row.category,
    bucket: row.bucket,
    status: row.status,
    workspaceId: row.workspace_id ?? null,
    streamId: row.stream_id ?? null,
    source: row.source,
    sourceKey: row.source_key ?? null,
    sourceDetails: parseJson(row.source_json),
    placementSource: row.placement_source,
    triageStatus: row.triage_status,
    triageConfidence: row.triage_confidence == null ? null : Number(row.triage_confidence),
    triageReason: row.triage_reason ?? "",
    triageError: row.triage_error ?? "",
    createdAt: new Date(Number(row.created_at_ms)).toISOString(),
    updatedAt: new Date(Number(row.updated_at_ms)).toISOString(),
    startedAt: row.started_at_ms == null ? null : new Date(Number(row.started_at_ms)).toISOString(),
    completedAt: row.completed_at_ms == null ? null : new Date(Number(row.completed_at_ms)).toISOString(),
  };
}

export class TaskBoardStore {
  constructor({ databaseFile, now = () => Date.now(), idFactory = randomUUID } = {}) {
    if (!databaseFile) throw new TypeError("databaseFile is required");
    this.databaseFile = path.resolve(databaseFile);
    this.now = now;
    this.idFactory = idFactory;
    this.#withDatabase(() => {});
  }

  #withDatabase(operation) {
    mkdirSync(path.dirname(this.databaseFile), { recursive: true });
    const database = new DatabaseSync(this.databaseFile);
    try {
      configure(database);
      return operation(database);
    } finally {
      database.close();
    }
  }

  create({ text, source = "hub", sourceKey = null, sourceDetails = {}, triageStatus = "pending" } = {}) {
    const rawText = normalizedTaskText(text);
    const normalizedSourceKey = String(sourceKey ?? "").trim() || null;
    const initialTriageStatus = triageStatus === "disabled" ? "disabled" : "pending";
    return this.#withDatabase((database) => {
      if (normalizedSourceKey) {
        const existing = database.prepare(
          "SELECT * FROM hub_board_tasks WHERE source_key = ?",
        ).get(normalizedSourceKey);
        if (existing) return taskFromRow(existing);
      }
      const timestamp = this.now();
      const id = String(this.idFactory());
      database.prepare(`
        INSERT INTO hub_board_tasks (
          id, raw_text, source, source_key, source_json, triage_status, created_at_ms, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        rawText,
        String(source ?? "hub").trim() || "hub",
        normalizedSourceKey,
        JSON.stringify(sourceDetails ?? {}),
        initialTriageStatus,
        timestamp,
        timestamp,
      );
      return taskFromRow(database.prepare("SELECT * FROM hub_board_tasks WHERE id = ?").get(id));
    });
  }

  task(id) {
    const taskId = String(id ?? "").trim();
    if (!taskId) return null;
    return this.#withDatabase((database) => taskFromRow(
      database.prepare("SELECT * FROM hub_board_tasks WHERE id = ?").get(taskId),
    ));
  }

  list({ includeDone = true } = {}) {
    return this.#withDatabase((database) => database.prepare(`
      SELECT * FROM hub_board_tasks
      ${includeDone ? "" : "WHERE status != 'done'"}
      ORDER BY CASE status WHEN 'open' THEN 0 WHEN 'started' THEN 1 ELSE 2 END,
        updated_at_ms DESC, id
    `).all().map(taskFromRow));
  }

  pendingTriage() {
    return this.#withDatabase((database) => database.prepare(`
      SELECT * FROM hub_board_tasks
      WHERE triage_status IN ('pending', 'running')
      ORDER BY created_at_ms, id
    `).all().map(taskFromRow));
  }

  disablePendingTriage() {
    return this.#withDatabase((database) => Number(database.prepare(`
      UPDATE hub_board_tasks SET triage_status = 'disabled', updated_at_ms = ?
      WHERE triage_status IN ('pending', 'running')
    `).run(this.now()).changes));
  }

  markTriageRunning(id) {
    return this.#withDatabase((database) => {
      database.prepare(`
        UPDATE hub_board_tasks
        SET triage_status = 'running', triage_error = NULL, updated_at_ms = ?
        WHERE id = ?
      `).run(this.now(), String(id));
      return taskFromRow(database.prepare("SELECT * FROM hub_board_tasks WHERE id = ?").get(String(id)));
    });
  }

  applyTriage(id, {
    correctedText,
    category,
    confidence,
    reason = "",
    bucket = "backlog",
    workspaceId = null,
    autoPlace = false,
  } = {}) {
    const taskId = String(id ?? "").trim();
    const normalizedCorrectedText = normalizedTaskText(correctedText);
    const normalizedCategory = normalizedTaskCategory(category);
    const normalizedBucket = normalizedTaskBucket(bucket);
    const numericConfidence = Math.max(0, Math.min(1, Number(confidence) || 0));
    return this.#withDatabase((database) => {
      const current = database.prepare("SELECT * FROM hub_board_tasks WHERE id = ?").get(taskId);
      if (!current) throw new Error("Task не найден");
      const canAutoPlace = autoPlace
        && current.placement_source === "default"
        && current.bucket === "backlog"
        && current.status === "open";
      database.prepare(`
        UPDATE hub_board_tasks SET
          corrected_text = ?, category = ?, triage_status = 'completed',
          triage_confidence = ?, triage_reason = ?, triage_error = NULL,
          bucket = ?, workspace_id = ?, placement_source = ?, updated_at_ms = ?
        WHERE id = ?
      `).run(
        normalizedCorrectedText,
        normalizedCategory,
        numericConfidence,
        String(reason ?? "").trim().slice(0, 1000),
        canAutoPlace ? normalizedBucket : current.bucket,
        canAutoPlace && normalizedBucket === "workspace" ? String(workspaceId ?? "").trim() || null : current.workspace_id,
        canAutoPlace ? "ai" : current.placement_source,
        this.now(),
        taskId,
      );
      return taskFromRow(database.prepare("SELECT * FROM hub_board_tasks WHERE id = ?").get(taskId));
    });
  }

  markTriageFailed(id, error) {
    return this.#withDatabase((database) => {
      database.prepare(`
        UPDATE hub_board_tasks
        SET triage_status = 'failed', triage_error = ?, updated_at_ms = ?
        WHERE id = ?
      `).run(String(error?.message ?? error ?? "Неизвестная ошибка").slice(0, 2000), this.now(), String(id));
      return taskFromRow(database.prepare("SELECT * FROM hub_board_tasks WHERE id = ?").get(String(id)));
    });
  }

  retryTriage(id) {
    return this.#withDatabase((database) => {
      database.prepare(`
        UPDATE hub_board_tasks
        SET triage_status = 'pending', triage_error = NULL, updated_at_ms = ?
        WHERE id = ?
      `).run(this.now(), String(id));
      return taskFromRow(database.prepare("SELECT * FROM hub_board_tasks WHERE id = ?").get(String(id)));
    });
  }

  move(id, { bucket, workspaceId = null } = {}) {
    const normalizedBucket = normalizedTaskBucket(bucket);
    const normalizedWorkspaceId = normalizedBucket === "workspace"
      ? String(workspaceId ?? "").trim()
      : null;
    if (normalizedBucket === "workspace" && !normalizedWorkspaceId) throw new Error("Выберите Workspace");
    return this.#withDatabase((database) => {
      database.prepare(`
        UPDATE hub_board_tasks
        SET bucket = ?, workspace_id = ?, stream_id = NULL,
          placement_source = 'manual', updated_at_ms = ?
        WHERE id = ?
      `).run(normalizedBucket, normalizedWorkspaceId, this.now(), String(id));
      const task = taskFromRow(database.prepare("SELECT * FROM hub_board_tasks WHERE id = ?").get(String(id)));
      if (!task) throw new Error("Task не найден");
      return task;
    });
  }

  markStarted(id, { workspaceId, streamId } = {}) {
    const timestamp = this.now();
    return this.#withDatabase((database) => {
      database.prepare(`
        UPDATE hub_board_tasks
        SET bucket = 'workspace', status = 'started', workspace_id = ?, stream_id = ?,
          placement_source = 'manual', started_at_ms = COALESCE(started_at_ms, ?), updated_at_ms = ?
        WHERE id = ?
      `).run(String(workspaceId), String(streamId), timestamp, timestamp, String(id));
      const task = taskFromRow(database.prepare("SELECT * FROM hub_board_tasks WHERE id = ?").get(String(id)));
      if (!task) throw new Error("Task не найден");
      return task;
    });
  }

  complete(id) {
    const timestamp = this.now();
    return this.#withDatabase((database) => {
      database.prepare(`
        UPDATE hub_board_tasks
        SET status = 'done', completed_at_ms = ?, updated_at_ms = ? WHERE id = ?
      `).run(timestamp, timestamp, String(id));
      const task = taskFromRow(database.prepare("SELECT * FROM hub_board_tasks WHERE id = ?").get(String(id)));
      if (!task) throw new Error("Task не найден");
      return task;
    });
  }

  remove(id) {
    return this.#withDatabase((database) => (
      Number(database.prepare("DELETE FROM hub_board_tasks WHERE id = ?").run(String(id)).changes) > 0
    ));
  }

  captureEnabled(chatId) {
    if (!Number.isSafeInteger(Number(chatId))) return false;
    return this.#withDatabase((database) => (
      Number(database.prepare(
        "SELECT enabled FROM hub_board_capture_chats WHERE chat_id = ?",
      ).get(Number(chatId))?.enabled ?? 0) === 1
    ));
  }

  setCaptureEnabled(chatId, enabled) {
    const value = Number(chatId);
    if (!Number.isSafeInteger(value)) throw new Error("Некорректный Telegram chat ID");
    this.#withDatabase((database) => database.prepare(`
      INSERT INTO hub_board_capture_chats (chat_id, enabled, updated_at_ms)
      VALUES (?, ?, ?)
      ON CONFLICT(chat_id) DO UPDATE SET enabled = excluded.enabled, updated_at_ms = excluded.updated_at_ms
    `).run(value, enabled ? 1 : 0, this.now()));
    return Boolean(enabled);
  }
}
