import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  LEGACY_TELEGRAM_BUNDLE_PREFIX,
  normalizedTaskBucket,
  normalizedTaskCategory,
  normalizedTaskDescription,
  normalizedTaskText,
  normalizedTaskTitle,
  taskPresentation,
} from "../../domain/task-board-task.mjs";

const NOTES_COLUMN_ID = "notes";

function configure(database) {
  database.exec("PRAGMA busy_timeout = 5000");
  database.exec("PRAGMA journal_mode = WAL");
  database.exec(`
    CREATE TABLE IF NOT EXISTS hub_board_tasks (
      id TEXT PRIMARY KEY,
      raw_text TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      presentation_source TEXT NOT NULL DEFAULT 'automatic',
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
      board_order INTEGER NOT NULL DEFAULT 0,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      started_at_ms INTEGER,
      completed_at_ms INTEGER,
      start_request_id TEXT,
      start_stream_name TEXT
    );
    CREATE TABLE IF NOT EXISTS hub_board_workspace_order (
      workspace_id TEXT PRIMARY KEY,
      position INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS hub_board_column_order (
      column_id TEXT PRIMARY KEY,
      position INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL
    );
    INSERT OR IGNORE INTO hub_board_column_order (column_id, position, updated_at_ms)
      SELECT workspace_id, position, updated_at_ms FROM hub_board_workspace_order;
    CREATE TABLE IF NOT EXISTS hub_board_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at_ms INTEGER NOT NULL
    ) WITHOUT ROWID;
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
  const taskColumns = database.prepare("PRAGMA table_info(hub_board_tasks)").all();
  if (!taskColumns.some((column) => column.name === "board_order")) {
    database.exec("ALTER TABLE hub_board_tasks ADD COLUMN board_order INTEGER NOT NULL DEFAULT 0");
  }
  if (!taskColumns.some((column) => column.name === "title")) {
    database.exec("ALTER TABLE hub_board_tasks ADD COLUMN title TEXT NOT NULL DEFAULT ''");
  }
  if (!taskColumns.some((column) => column.name === "description")) {
    database.exec("ALTER TABLE hub_board_tasks ADD COLUMN description TEXT NOT NULL DEFAULT ''");
  }
  if (!taskColumns.some((column) => column.name === "presentation_source")) {
    database.exec("ALTER TABLE hub_board_tasks ADD COLUMN presentation_source TEXT NOT NULL DEFAULT 'automatic'");
  }
  if (!taskColumns.some((column) => column.name === "start_request_id")) {
    database.exec("ALTER TABLE hub_board_tasks ADD COLUMN start_request_id TEXT");
  }
  if (!taskColumns.some((column) => column.name === "start_stream_name")) {
    database.exec("ALTER TABLE hub_board_tasks ADD COLUMN start_stream_name TEXT");
  }
  const legacyPrefixPattern = `${LEGACY_TELEGRAM_BUNDLE_PREFIX}%`;
  const contentOffset = LEGACY_TELEGRAM_BUNDLE_PREFIX.length + 1;
  database.prepare(`
    UPDATE hub_board_tasks SET
      raw_text = substr(raw_text, ?),
      corrected_text = CASE
        WHEN corrected_text LIKE ? THEN substr(corrected_text, ?)
        ELSE corrected_text
      END,
      title = '', description = '', presentation_source = 'automatic',
      triage_status = CASE WHEN status = 'done' THEN triage_status ELSE 'pending' END,
      triage_error = NULL
    WHERE source_key LIKE 'shared-dashboard:%' AND raw_text LIKE ?
  `).run(contentOffset, legacyPrefixPattern, contentOffset, legacyPrefixPattern);
  database.exec(`
    CREATE INDEX IF NOT EXISTS hub_board_tasks_board_order_idx
      ON hub_board_tasks(status, bucket, workspace_id, board_order);
  `);
}

function taskLocationRows(database, bucket, workspaceId = null) {
  return database.prepare(`
    SELECT id FROM hub_board_tasks
    WHERE status != 'done' AND bucket = ?
      AND ((? IS NULL AND workspace_id IS NULL) OR workspace_id = ?)
    ORDER BY board_order, created_at_ms, id
  `).all(bucket, workspaceId, workspaceId);
}

function writeTaskOrder(database, bucket, workspaceId, ids) {
  const update = database.prepare(`
    UPDATE hub_board_tasks SET board_order = ?
    WHERE id = ? AND bucket = ?
      AND ((? IS NULL AND workspace_id IS NULL) OR workspace_id = ?)
  `);
  ids.forEach((id, position) => update.run(position, id, bucket, workspaceId, workspaceId));
}

function normalizedColumnIds(workspaceIds) {
  return [...new Set((workspaceIds ?? []).map((id) => String(id ?? "").trim()).filter(Boolean))];
}

function ensureColumnOrder(database, workspaceIds, timestamp) {
  const ids = [...normalizedColumnIds(workspaceIds), NOTES_COLUMN_ID];
  const rows = database.prepare(`
    SELECT column_id, position FROM hub_board_column_order
    ORDER BY position, column_id
  `).all();
  const known = new Map(rows.map((row) => [row.column_id, Number(row.position)]));
  let position = rows.reduce((maximum, row) => Math.max(maximum, Number(row.position)), -1) + 1;
  const insert = database.prepare(`
    INSERT INTO hub_board_column_order (column_id, position, updated_at_ms)
    VALUES (?, ?, ?)
    ON CONFLICT(column_id) DO NOTHING
  `);
  for (const id of ids) {
    if (known.has(id)) continue;
    insert.run(id, position, timestamp);
    known.set(id, position);
    position += 1;
  }
  const originalPosition = new Map(ids.map((id, index) => [id, index]));
  return ids.sort((left, right) => (
    known.get(left) - known.get(right) || originalPosition.get(left) - originalPosition.get(right)
  ));
}

function parseJson(value) {
  try {
    const parsed = JSON.parse(String(value ?? "{}"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function sourceTaskRow(database, { source, chatId, userId, messageId }) {
  const identity = [chatId, userId, messageId].map((value) => String(value ?? "").trim());
  if (identity.some((value) => !value)) return null;
  return database.prepare(`
    SELECT * FROM hub_board_tasks
    WHERE source = ?
    ORDER BY created_at_ms DESC, id DESC
  `).all(String(source)).find((candidate) => {
    const details = parseJson(candidate.source_json);
    const linkedMessageIds = [
      details.messageId,
      ...(Array.isArray(details.messageIds) ? details.messageIds : []),
      ...(Array.isArray(details.items) ? details.items.map((item) => item?.messageId) : []),
    ].map((value) => String(value ?? "").trim()).filter(Boolean);
    return String(details.chatId ?? "") === identity[0]
      && String(details.userId ?? "") === identity[1]
      && linkedMessageIds.includes(identity[2]);
  }) ?? null;
}

function taskFromRow(row) {
  if (!row) return null;
  const presentation = String(row.title ?? "").trim()
    ? { title: row.title, description: row.description ?? "" }
    : taskPresentation(row.corrected_text ?? row.raw_text);
  return {
    id: row.id,
    rawText: row.raw_text,
    title: presentation.title,
    description: presentation.description,
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
    startRequestId: row.start_request_id ?? null,
    startStreamName: row.start_stream_name ?? null,
    boardOrder: Number(row.board_order) || 0,
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
    const presentation = taskPresentation(rawText);
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
      const boardOrder = taskLocationRows(database, "backlog").length;
      database.prepare(`
        INSERT INTO hub_board_tasks (
          id, raw_text, title, description, source, source_key, source_json, triage_status,
          board_order, created_at_ms, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        rawText,
        presentation.title,
        presentation.description,
        String(source ?? "hub").trim() || "hub",
        normalizedSourceKey,
        JSON.stringify(sourceDetails ?? {}),
        initialTriageStatus,
        boardOrder,
        timestamp,
        timestamp,
      );
      return taskFromRow(database.prepare("SELECT * FROM hub_board_tasks WHERE id = ?").get(id));
    });
  }

  attachToSourceMessage({ source = "telegram", chatId, userId, messageId, attachments = [] } = {}) {
    const identity = [chatId, userId, messageId].map((value) => String(value ?? "").trim());
    const incoming = (Array.isArray(attachments) ? attachments : [])
      .map((value) => String(value ?? "").trim())
      .filter(Boolean);
    if (identity.some((value) => !value) || !incoming.length) {
      throw new Error("Не удалось определить задачу или вложение");
    }
    return this.#withDatabase((database) => {
      const row = sourceTaskRow(database, { source, chatId, userId, messageId });
      if (!row) throw new Error("Задача для исходного сообщения не найдена");
      const details = parseJson(row.source_json);
      details.attachments = [...new Set([
        ...(Array.isArray(details.attachments) ? details.attachments : []),
        ...incoming,
      ])];
      database.prepare(`
        UPDATE hub_board_tasks SET source_json = ?, updated_at_ms = ? WHERE id = ?
      `).run(JSON.stringify(details), this.now(), row.id);
      return taskFromRow(database.prepare("SELECT * FROM hub_board_tasks WHERE id = ?").get(row.id));
    });
  }

  addAttachment(id, attachment) {
    const taskId = String(id ?? "").trim();
    const file = String(attachment ?? "").trim();
    if (!taskId || !file) throw new Error("Не удалось определить задачу или вложение");
    return this.#withDatabase((database) => {
      const row = database.prepare("SELECT * FROM hub_board_tasks WHERE id = ?").get(taskId);
      if (!row) throw new Error("Задача не найдена");
      const details = parseJson(row.source_json);
      details.attachments = [...new Set([
        ...(Array.isArray(details.attachments) ? details.attachments : []),
        file,
      ])];
      database.prepare(`
        UPDATE hub_board_tasks SET source_json = ?, updated_at_ms = ? WHERE id = ?
      `).run(JSON.stringify(details), this.now(), taskId);
      return taskFromRow(database.prepare("SELECT * FROM hub_board_tasks WHERE id = ?").get(taskId));
    });
  }

  appendSourceMessage({
    source = "telegram",
    chatId,
    userId,
    messageId,
    text,
    sourceDetails = {},
    attachments = [],
    triageStatus = "pending",
  } = {}) {
    const addition = normalizedTaskText(text);
    const nextTriageStatus = triageStatus === "disabled" ? "disabled" : "pending";
    return this.#withDatabase((database) => {
      const row = sourceTaskRow(database, { source, chatId, userId, messageId });
      if (!row) throw new Error("Задача для исходного сообщения не найдена");
      const currentDetails = parseJson(row.source_json);
      const currentBlocks = String(row.raw_text).match(/^--- Сообщение \d+ ·/gmu)?.length ?? 0;
      const priorText = currentBlocks
        ? String(row.raw_text)
        : `--- Сообщение 1 · Вы ---\n${String(row.raw_text).trim()}`;
      const rawText = `${priorText}\n\n--- Сообщение ${Math.max(1, currentBlocks) + 1} · Вы ---\n${addition}`;
      const presentation = taskPresentation(rawText);
      const linkedMessageIds = [...new Set([
        currentDetails.messageId,
        ...(Array.isArray(currentDetails.messageIds) ? currentDetails.messageIds : []),
        sourceDetails?.messageId,
      ].map((value) => Number(value)).filter(Number.isSafeInteger))];
      const nextDetails = {
        ...currentDetails,
        ...(sourceDetails && typeof sourceDetails === "object" ? sourceDetails : {}),
        chatId: currentDetails.chatId ?? chatId,
        userId: currentDetails.userId ?? userId,
        messageId: currentDetails.messageId ?? messageId,
        messageIds: linkedMessageIds,
      };
      const nextAttachments = [...new Set([
        ...(Array.isArray(currentDetails.attachments) ? currentDetails.attachments : []),
        ...(Array.isArray(attachments) ? attachments : []),
      ].map((value) => String(value ?? "").trim()).filter(Boolean))];
      if (nextAttachments.length) nextDetails.attachments = nextAttachments;
      database.prepare(`
        UPDATE hub_board_tasks SET
          raw_text = ?,
          title = CASE WHEN presentation_source = 'manual' THEN title ELSE ? END,
          description = CASE WHEN presentation_source = 'manual' THEN description ELSE ? END,
          corrected_text = CASE WHEN presentation_source = 'manual' THEN corrected_text ELSE NULL END,
          category = CASE WHEN presentation_source = 'manual' THEN category ELSE 'unknown' END,
          source_json = ?, triage_status = ?, triage_confidence = NULL,
          triage_reason = NULL, triage_error = NULL, updated_at_ms = ?
        WHERE id = ?
      `).run(
        rawText,
        presentation.title,
        presentation.description,
        JSON.stringify(nextDetails),
        nextTriageStatus,
        this.now(),
        row.id,
      );
      return taskFromRow(database.prepare("SELECT * FROM hub_board_tasks WHERE id = ?").get(row.id));
    });
  }

  mergeSourceMessage({
    source = "telegram",
    chatId,
    userId,
    messageId,
    text,
    sourceDetails = {},
    triageStatus = "pending",
  } = {}) {
    const rawText = normalizedTaskText(text);
    const presentation = taskPresentation(rawText);
    const nextTriageStatus = triageStatus === "disabled" ? "disabled" : "pending";
    return this.#withDatabase((database) => {
      const row = sourceTaskRow(database, { source, chatId, userId, messageId });
      if (!row) throw new Error("Задача для исходного сообщения не найдена");
      const currentDetails = parseJson(row.source_json);
      const nextDetails = {
        ...currentDetails,
        ...(sourceDetails && typeof sourceDetails === "object" ? sourceDetails : {}),
        chatId: currentDetails.chatId ?? chatId,
        userId: currentDetails.userId ?? userId,
        messageId: currentDetails.messageId ?? messageId,
      };
      const attachments = [...new Set([
        ...(Array.isArray(currentDetails.attachments) ? currentDetails.attachments : []),
        ...(Array.isArray(sourceDetails?.attachments) ? sourceDetails.attachments : []),
      ])];
      if (attachments.length) nextDetails.attachments = attachments;
      database.prepare(`
        UPDATE hub_board_tasks SET
          raw_text = ?,
          title = CASE WHEN presentation_source = 'manual' THEN title ELSE ? END,
          description = CASE WHEN presentation_source = 'manual' THEN description ELSE ? END,
          corrected_text = CASE WHEN presentation_source = 'manual' THEN corrected_text ELSE NULL END,
          category = CASE WHEN presentation_source = 'manual' THEN category ELSE 'unknown' END,
          source_json = ?, triage_status = ?, triage_confidence = NULL,
          triage_reason = NULL, triage_error = NULL, updated_at_ms = ?
        WHERE id = ?
      `).run(
        rawText,
        presentation.title,
        presentation.description,
        JSON.stringify(nextDetails),
        nextTriageStatus,
        this.now(),
        row.id,
      );
      return taskFromRow(database.prepare("SELECT * FROM hub_board_tasks WHERE id = ?").get(row.id));
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
        bucket, workspace_id, board_order, created_at_ms, id
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

  updatePresentation(id, { title, description = "" } = {}) {
    const taskId = String(id ?? "").trim();
    const normalizedTitle = normalizedTaskTitle(title);
    const normalizedDescription = normalizedTaskDescription(description);
    const correctedText = normalizedDescription
      ? `${normalizedTitle}\n\n${normalizedDescription}`
      : normalizedTitle;
    return this.#withDatabase((database) => {
      const result = database.prepare(`
        UPDATE hub_board_tasks SET
          title = ?, description = ?, corrected_text = ?, presentation_source = 'manual',
          updated_at_ms = ?
        WHERE id = ?
      `).run(normalizedTitle, normalizedDescription, correctedText, this.now(), taskId);
      if (!result.changes) throw new Error("Задача не найдена");
      return taskFromRow(database.prepare("SELECT * FROM hub_board_tasks WHERE id = ?").get(taskId));
    });
  }

  applyTriage(id, {
    title,
    description,
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
    const presentation = taskPresentation(normalizedCorrectedText, { title, description });
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
          title = CASE WHEN presentation_source = 'manual' THEN title ELSE ? END,
          description = CASE WHEN presentation_source = 'manual' THEN description ELSE ? END,
          corrected_text = CASE WHEN presentation_source = 'manual' THEN corrected_text ELSE ? END,
          category = ?, triage_status = 'completed',
          triage_confidence = ?, triage_reason = ?, triage_error = NULL,
          bucket = ?, workspace_id = ?, placement_source = ?, updated_at_ms = ?
        WHERE id = ?
      `).run(
        presentation.title,
        presentation.description,
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
        SET triage_status = 'pending', triage_error = NULL,
          presentation_source = 'automatic', updated_at_ms = ?
        WHERE id = ?
      `).run(this.now(), String(id));
      return taskFromRow(database.prepare("SELECT * FROM hub_board_tasks WHERE id = ?").get(String(id)));
    });
  }

  move(id, { bucket, workspaceId = null, beforeId = null } = {}) {
    const normalizedBucket = normalizedTaskBucket(bucket);
    const normalizedWorkspaceId = normalizedBucket === "workspace"
      ? String(workspaceId ?? "").trim()
      : null;
    if (normalizedBucket === "workspace" && !normalizedWorkspaceId) throw new Error("Выберите Workspace");
    return this.#withDatabase((database) => {
      const taskId = String(id ?? "").trim();
      const current = database.prepare("SELECT * FROM hub_board_tasks WHERE id = ?").get(taskId);
      if (!current) throw new Error("Задача не найдена");
      const oldBucket = current.bucket;
      const oldWorkspaceId = current.workspace_id ?? null;
      database.exec("BEGIN IMMEDIATE");
      try {
        database.prepare(`
          UPDATE hub_board_tasks
          SET bucket = ?, workspace_id = ?, stream_id = NULL,
            placement_source = 'manual', updated_at_ms = ?
          WHERE id = ?
        `).run(normalizedBucket, normalizedWorkspaceId, this.now(), taskId);
        const targetIds = taskLocationRows(database, normalizedBucket, normalizedWorkspaceId)
          .map((row) => row.id)
          .filter((candidateId) => candidateId !== taskId);
        const normalizedBeforeId = String(beforeId ?? "").trim();
        const targetIndex = normalizedBeforeId ? targetIds.indexOf(normalizedBeforeId) : -1;
        targetIds.splice(targetIndex < 0 ? targetIds.length : targetIndex, 0, taskId);
        if (oldBucket !== normalizedBucket || oldWorkspaceId !== normalizedWorkspaceId) {
          writeTaskOrder(
            database,
            oldBucket,
            oldWorkspaceId,
            taskLocationRows(database, oldBucket, oldWorkspaceId).map((row) => row.id),
          );
        }
        writeTaskOrder(database, normalizedBucket, normalizedWorkspaceId, targetIds);
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
      return taskFromRow(database.prepare("SELECT * FROM hub_board_tasks WHERE id = ?").get(taskId));
    });
  }

  reassignWorkspace(sourceWorkspaceId, targetWorkspaceId) {
    const sourceId = String(sourceWorkspaceId ?? "").trim();
    const targetId = String(targetWorkspaceId ?? "").trim();
    if (!sourceId || !targetId) throw new Error("Workspace не найден");
    if (sourceId === targetId) return 0;
    return this.#withDatabase((database) => {
      const sourceIds = taskLocationRows(database, "workspace", sourceId).map((row) => row.id);
      const targetIds = taskLocationRows(database, "workspace", targetId).map((row) => row.id);
      database.exec("BEGIN IMMEDIATE");
      try {
        const result = database.prepare(`
          UPDATE hub_board_tasks
          SET workspace_id = ?, updated_at_ms = ?
          WHERE workspace_id = ?
        `).run(targetId, this.now(), sourceId);
        writeTaskOrder(database, "workspace", targetId, [...targetIds, ...sourceIds]);
        database.prepare("DELETE FROM hub_board_column_order WHERE column_id = ?").run(sourceId);
        database.prepare("DELETE FROM hub_board_workspace_order WHERE workspace_id = ?").run(sourceId);
        database.exec("COMMIT");
        return Number(result.changes);
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    });
  }

  orderedColumnIds(workspaceIds) {
    return this.#withDatabase((database) => ensureColumnOrder(database, workspaceIds, this.now()));
  }

  moveColumn(workspaceIds, { columnId, beforeColumnId = null } = {}) {
    const movedColumnId = String(columnId ?? "").trim();
    const targetColumnId = String(beforeColumnId ?? "").trim() || null;
    return this.#withDatabase((database) => {
      const ordered = ensureColumnOrder(database, workspaceIds, this.now());
      if (!ordered.includes(movedColumnId)) throw new Error("Колонка не найдена");
      if (targetColumnId && !ordered.includes(targetColumnId)) throw new Error("Колонка не найдена");
      const reordered = ordered.filter((id) => id !== movedColumnId);
      const targetIndex = targetColumnId ? reordered.indexOf(targetColumnId) : -1;
      reordered.splice(targetIndex < 0 ? reordered.length : targetIndex, 0, movedColumnId);
      const update = database.prepare(`
        UPDATE hub_board_column_order SET position = ?, updated_at_ms = ? WHERE column_id = ?
      `);
      database.exec("BEGIN IMMEDIATE");
      try {
        const timestamp = this.now();
        reordered.forEach((id, position) => update.run(position, timestamp, id));
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
      return reordered;
    });
  }

  notesComment() {
    return this.#withDatabase((database) => String(database.prepare(
      "SELECT value FROM hub_board_settings WHERE key = 'notes_comment'",
    ).get()?.value ?? "Игры, фильмы, сериалы и идеи"));
  }

  setNotesComment(comment) {
    const value = String(comment ?? "").trim().slice(0, 1000);
    this.#withDatabase((database) => database.prepare(`
      INSERT INTO hub_board_settings (key, value, updated_at_ms)
      VALUES ('notes_comment', ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at_ms = excluded.updated_at_ms
    `).run(value, this.now()));
    return value;
  }

  prepareStart(id, {
    workspaceId, streamId, requestId, streamName = null,
  } = {}) {
    const taskId = String(id);
    const normalizedRequestId = String(requestId ?? "").trim();
    if (!normalizedRequestId) throw new Error("Task launch request id is required");
    const timestamp = this.now();
    return this.#withDatabase((database) => {
      const current = database.prepare("SELECT * FROM hub_board_tasks WHERE id = ?").get(taskId);
      if (!current) throw new Error("Task не найден");
      const currentRequestId = String(current.start_request_id ?? "").trim();
      if (currentRequestId && currentRequestId !== normalizedRequestId) {
        throw new Error("Task launch is already pending; retry it with the original request_id");
      }
      if (current.status === "done") throw new Error("Task уже завершена");
      if (current.status === "started" && !currentRequestId) throw new Error("Task уже запущена");
      if (!currentRequestId) {
        database.prepare(`
          UPDATE hub_board_tasks
          SET bucket = 'workspace', status = 'starting', workspace_id = ?, stream_id = ?,
            placement_source = 'manual', start_request_id = ?, start_stream_name = ?,
            completed_at_ms = NULL, updated_at_ms = ?
          WHERE id = ?
        `).run(
          String(workspaceId), String(streamId), normalizedRequestId,
          String(streamName ?? "").trim() || null, timestamp, taskId,
        );
      }
      return taskFromRow(database.prepare("SELECT * FROM hub_board_tasks WHERE id = ?").get(taskId));
    });
  }

  cancelPreparedStart(id, { requestId } = {}) {
    const taskId = String(id);
    const normalizedRequestId = String(requestId ?? "").trim();
    if (!normalizedRequestId) throw new Error("Task launch request id is required");
    return this.#withDatabase((database) => {
      database.prepare(`
        UPDATE hub_board_tasks
        SET status = 'open', stream_id = NULL, start_request_id = NULL, start_stream_name = NULL,
          updated_at_ms = ?
        WHERE id = ? AND status = 'starting' AND start_request_id = ?
      `).run(this.now(), taskId, normalizedRequestId);
      const task = taskFromRow(database.prepare("SELECT * FROM hub_board_tasks WHERE id = ?").get(taskId));
      if (!task) throw new Error("Task не найден");
      return task;
    });
  }

  markStarted(id, { workspaceId, streamId, requestId = null } = {}) {
    const timestamp = this.now();
    return this.#withDatabase((database) => {
      const normalizedRequestId = String(requestId ?? "").trim();
      const current = database.prepare("SELECT * FROM hub_board_tasks WHERE id = ?").get(String(id));
      if (!current) throw new Error("Task не найден");
      if (normalizedRequestId && String(current.start_request_id ?? "") !== normalizedRequestId) {
        throw new Error("Task launch request does not match the prepared Task");
      }
      database.prepare(`
        UPDATE hub_board_tasks
        SET bucket = 'workspace', status = 'started', workspace_id = ?, stream_id = ?,
          placement_source = 'manual', started_at_ms = COALESCE(started_at_ms, ?),
          completed_at_ms = NULL, updated_at_ms = ?
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
