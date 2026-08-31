import { createHash, randomUUID } from "node:crypto";
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
  normalizedTaskWorkflowStatus,
  TASK_WORKFLOW_STATUSES,
  taskPresentation,
} from "../../domain/task-board-task.mjs";
import {
  normalizedTaskChangedFiles,
  taskReleasePlanRevision,
} from "../../domain/task-release-snapshot.mjs";
import { normalizedTaskGitReferences, taskBranchName } from "../../domain/task-git-reference.mjs";
import { normalizedTaskNumber, normalizedWorkspaceTaskPrefix, taskNumberParts } from "../../domain/task-number.mjs";

const NOTES_COLUMN_ID = "notes";

function gitBaselineJson(value) {
  const repositories = Array.isArray(value?.repositories) ? value.repositories : [value];
  const valid = repositories.some((repository) => (
    String(repository?.repoRoot ?? "").trim()
    && String(repository?.tree ?? "").trim()
  ));
  return valid ? JSON.stringify(value) : "{}";
}

function configure(database) {
  database.exec("PRAGMA busy_timeout = 5000");
  database.exec("PRAGMA journal_mode = WAL");
  database.exec("PRAGMA foreign_keys = ON");
  database.exec(`
    CREATE TABLE IF NOT EXISTS hub_board_tasks (
      id TEXT PRIMARY KEY,
      raw_text TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      task_number TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      presentation_source TEXT NOT NULL DEFAULT 'automatic',
      corrected_text TEXT,
      category TEXT NOT NULL DEFAULT 'unknown',
      bucket TEXT NOT NULL DEFAULT 'backlog',
      status TEXT NOT NULL DEFAULT 'open',
      workflow_status TEXT NOT NULL DEFAULT 'new',
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
      start_stream_name TEXT,
      row_revision INTEGER NOT NULL DEFAULT 1
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
    CREATE TABLE IF NOT EXISTS hub_task_number_sequences (
      prefix TEXT PRIMARY KEY,
      last_number INTEGER NOT NULL DEFAULT 0 CHECK (last_number >= 0),
      updated_at_ms INTEGER NOT NULL
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS hub_board_capture_chats (
      chat_id INTEGER PRIMARY KEY,
      enabled INTEGER NOT NULL DEFAULT 0,
      updated_at_ms INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS hub_task_release_state (
      task_id TEXT PRIMARY KEY,
      revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
      frozen_revision INTEGER,
      manifest_hash TEXT NOT NULL DEFAULT '',
      updated_at_ms INTEGER NOT NULL,
      FOREIGN KEY (task_id) REFERENCES hub_board_tasks(id) ON DELETE CASCADE
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS hub_task_turn_bindings (
      task_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      provider_thread_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      baseline_json TEXT NOT NULL DEFAULT '{}',
      requested_workflow_status TEXT,
      claimed_at_ms INTEGER NOT NULL,
      terminal_at_ms INTEGER,
      PRIMARY KEY (provider, provider_thread_id, turn_id),
      FOREIGN KEY (task_id) REFERENCES hub_board_tasks(id) ON DELETE CASCADE
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS hub_task_turn_bindings_task_idx
      ON hub_task_turn_bindings(task_id, claimed_at_ms DESC);
    CREATE TABLE IF NOT EXISTS hub_task_work_log (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      provider_thread_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      project_root TEXT NOT NULL,
      summary TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL,
      changed_files_json TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      FOREIGN KEY (task_id) REFERENCES hub_board_tasks(id) ON DELETE CASCADE,
      UNIQUE (task_id, provider, provider_thread_id, turn_id)
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS hub_task_work_log_task_idx
      ON hub_task_work_log(task_id, created_at_ms, id);
    CREATE TABLE IF NOT EXISTS hub_task_git_references (
      task_id TEXT NOT NULL,
      project_root TEXT NOT NULL,
      branch TEXT NOT NULL,
      result_commit TEXT NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      PRIMARY KEY (task_id, project_root),
      FOREIGN KEY (task_id) REFERENCES hub_board_tasks(id) ON DELETE CASCADE
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS hub_task_release_revisions (
      task_id TEXT NOT NULL,
      task_revision INTEGER NOT NULL,
      manifest_hash TEXT NOT NULL,
      repositories_json TEXT NOT NULL,
      verification_json TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      PRIMARY KEY (task_id, task_revision),
      FOREIGN KEY (task_id) REFERENCES hub_board_tasks(id) ON DELETE CASCADE
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS hub_task_release_revision_files (
      task_id TEXT NOT NULL,
      task_revision INTEGER NOT NULL,
      project_root TEXT NOT NULL,
      file_path TEXT NOT NULL,
      operation TEXT NOT NULL CHECK (operation IN ('added', 'modified', 'deleted')),
      base_blob TEXT NOT NULL,
      result_blob TEXT NOT NULL,
      patch_hash TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (task_id, task_revision, project_root, file_path),
      FOREIGN KEY (task_id, task_revision)
        REFERENCES hub_task_release_revisions(task_id, task_revision) ON DELETE CASCADE
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS hub_task_release_completions (
      task_id TEXT NOT NULL,
      task_revision INTEGER NOT NULL,
      manifest_hash TEXT NOT NULL,
      verification_json TEXT NOT NULL,
      completed_at_ms INTEGER NOT NULL,
      PRIMARY KEY (task_id, task_revision),
      FOREIGN KEY (task_id, task_revision)
        REFERENCES hub_task_release_revisions(task_id, task_revision) ON DELETE RESTRICT
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS hub_release_registry_history (
      source_kind TEXT NOT NULL,
      source_id TEXT NOT NULL,
      status TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      payload_sha256 TEXT NOT NULL,
      migrated_task_id TEXT,
      archived_at_ms INTEGER NOT NULL,
      PRIMARY KEY (source_kind, source_id)
    ) WITHOUT ROWID;
  `);
  const tableExists = (name) => Boolean(database.prepare(`
    SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?
  `).get(name));
  const archive = database.prepare(`
    INSERT OR IGNORE INTO hub_release_registry_history (
      source_kind, source_id, status, payload_json, payload_sha256, archived_at_ms
    ) VALUES (?, ?, 'retired', ?, ?, ?)
  `);
  const hasRepositoryRevisions = tableExists("hub_task_repository_revisions");
  const hasChangedFiles = tableExists("hub_task_changed_files");
  if (hasRepositoryRevisions || hasChangedFiles) database.exec("BEGIN IMMEDIATE");
  try {
    if (hasRepositoryRevisions) {
      const insert = database.prepare(`
        INSERT OR IGNORE INTO hub_task_git_references
          (task_id, project_root, branch, result_commit, updated_at_ms)
        VALUES (?, ?, ?, ?, ?)
      `);
      for (const row of database.prepare(`
        SELECT * FROM hub_task_repository_revisions ORDER BY task_id, project_root
      `).all()) {
        const payload = JSON.stringify(row);
        archive.run(
          "task-repository-revision-v3", `${row.task_id}\0${row.project_root}`, payload,
          createHash("sha256").update(payload, "utf8").digest("hex"), Date.now(),
        );
        if (String(row.result_revision ?? "").trim()) {
          insert.run(
            row.task_id, row.project_root, taskBranchName(row.task_id, row.project_root),
            row.result_revision, Number(row.updated_at_ms) || Date.now(),
          );
        }
      }
      database.exec("DROP TABLE hub_task_repository_revisions");
    }
    if (hasChangedFiles) {
      for (const row of database.prepare(`
        SELECT * FROM hub_task_changed_files ORDER BY task_id, project_root, file_path
      `).all()) {
        const payload = JSON.stringify(row);
        archive.run(
          "task-changed-file-v3", `${row.task_id}\0${row.project_root}\0${row.file_path}`, payload,
          createHash("sha256").update(payload, "utf8").digest("hex"), Date.now(),
        );
      }
      database.exec("DROP TABLE hub_task_changed_files");
    }
    if (hasRepositoryRevisions || hasChangedFiles) database.exec("COMMIT");
  } catch (error) {
    if (hasRepositoryRevisions || hasChangedFiles) database.exec("ROLLBACK");
    throw error;
  }
  const taskColumns = database.prepare("PRAGMA table_info(hub_board_tasks)").all();
  if (!taskColumns.some((column) => column.name === "board_order")) {
    database.exec("ALTER TABLE hub_board_tasks ADD COLUMN board_order INTEGER NOT NULL DEFAULT 0");
  }
  if (!taskColumns.some((column) => column.name === "title")) {
    database.exec("ALTER TABLE hub_board_tasks ADD COLUMN title TEXT NOT NULL DEFAULT ''");
  }
  if (!taskColumns.some((column) => column.name === "task_number")) {
    database.exec("ALTER TABLE hub_board_tasks ADD COLUMN task_number TEXT NOT NULL DEFAULT ''");
  }
  database.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS hub_board_tasks_number_idx
      ON hub_board_tasks(task_number) WHERE task_number != '';
  `);
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
  if (!taskColumns.some((column) => column.name === "workflow_status")) {
    database.exec("ALTER TABLE hub_board_tasks ADD COLUMN workflow_status TEXT NOT NULL DEFAULT 'new'");
    database.exec(`
      UPDATE hub_board_tasks SET workflow_status = CASE
        WHEN status = 'done' THEN 'done'
        WHEN status IN ('starting', 'started') THEN 'in_progress'
        ELSE 'new'
      END
    `);
  }
  if (!taskColumns.some((column) => column.name === "row_revision")) {
    database.exec("ALTER TABLE hub_board_tasks ADD COLUMN row_revision INTEGER NOT NULL DEFAULT 1");
  }
  const bindingColumns = database.prepare("PRAGMA table_info(hub_task_turn_bindings)").all();
  if (!bindingColumns.some((column) => column.name === "requested_workflow_status")) {
    database.exec("ALTER TABLE hub_task_turn_bindings ADD COLUMN requested_workflow_status TEXT");
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
    DROP TRIGGER IF EXISTS hub_board_tasks_revision_update;
    CREATE TRIGGER hub_board_tasks_revision_update
      AFTER UPDATE ON hub_board_tasks
      WHEN NEW.row_revision = OLD.row_revision AND (
        NEW.raw_text IS NOT OLD.raw_text OR NEW.title IS NOT OLD.title OR NEW.task_number IS NOT OLD.task_number
        OR NEW.description IS NOT OLD.description OR NEW.presentation_source IS NOT OLD.presentation_source
        OR NEW.corrected_text IS NOT OLD.corrected_text OR NEW.category IS NOT OLD.category
        OR NEW.bucket IS NOT OLD.bucket OR NEW.status IS NOT OLD.status
        OR NEW.workflow_status IS NOT OLD.workflow_status OR NEW.workspace_id IS NOT OLD.workspace_id
        OR NEW.stream_id IS NOT OLD.stream_id OR NEW.source_json IS NOT OLD.source_json
        OR NEW.placement_source IS NOT OLD.placement_source OR NEW.triage_status IS NOT OLD.triage_status
        OR NEW.triage_confidence IS NOT OLD.triage_confidence OR NEW.triage_reason IS NOT OLD.triage_reason
        OR NEW.triage_error IS NOT OLD.triage_error OR NEW.started_at_ms IS NOT OLD.started_at_ms
        OR NEW.completed_at_ms IS NOT OLD.completed_at_ms OR NEW.start_request_id IS NOT OLD.start_request_id
        OR NEW.start_stream_name IS NOT OLD.start_stream_name
      )
      BEGIN
        UPDATE hub_board_tasks SET row_revision = OLD.row_revision + 1 WHERE id = OLD.id;
      END;
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

function advanceTaskNumberSequence(database, taskNumber, timestamp) {
  const parts = taskNumberParts(taskNumber);
  if (!parts) return;
  database.prepare(`
    INSERT INTO hub_task_number_sequences (prefix, last_number, updated_at_ms)
    VALUES (?, ?, ?)
    ON CONFLICT(prefix) DO UPDATE SET
      last_number = MAX(last_number, excluded.last_number), updated_at_ms = excluded.updated_at_ms
  `).run(parts.prefix, parts.ordinal, timestamp);
}

function allocateTaskNumber(database, prefix, timestamp) {
  const normalizedPrefix = normalizedWorkspaceTaskPrefix(prefix);
  if (!normalizedPrefix) return "";
  database.prepare(`
    INSERT OR IGNORE INTO hub_task_number_sequences (prefix, last_number, updated_at_ms)
    VALUES (?, 0, ?)
  `).run(normalizedPrefix, timestamp);
  let ordinal = Number(database.prepare(
    "SELECT last_number FROM hub_task_number_sequences WHERE prefix = ?",
  ).get(normalizedPrefix)?.last_number) || 0;
  let taskNumber = "";
  do {
    ordinal += 1;
    taskNumber = `${normalizedPrefix}-${ordinal}`;
  } while (database.prepare("SELECT 1 FROM hub_board_tasks WHERE task_number = ?").get(taskNumber));
  database.prepare(`
    UPDATE hub_task_number_sequences SET last_number = ?, updated_at_ms = ? WHERE prefix = ?
  `).run(ordinal, timestamp, normalizedPrefix);
  return taskNumber;
}

function taskNumberForRow(database, row, prefix, timestamp) {
  if (String(row?.task_number ?? "").trim()) return String(row.task_number);
  return allocateTaskNumber(database, prefix, timestamp);
}

function assignTaskNumber(database, row, prefix, timestamp) {
  const taskNumber = taskNumberForRow(database, row, prefix, timestamp);
  if (taskNumber) database.prepare("UPDATE hub_board_tasks SET task_number = ? WHERE id = ?").run(taskNumber, row.id);
  return taskNumber;
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
  const workflowStatus = TASK_WORKFLOW_STATUSES.includes(row.workflow_status)
    ? row.workflow_status
    : (row.status === "done" ? "done" : (["starting", "started"].includes(row.status) ? "in_progress" : "new"));
  return {
    id: row.id,
    taskNumber: row.task_number ?? "",
    rawText: row.raw_text,
    title: presentation.title,
    description: presentation.description,
    correctedText: row.corrected_text ?? "",
    category: row.category,
    bucket: row.bucket,
    status: row.status,
    workflowStatus,
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
    revision: Number(row.row_revision) || 1,
    startRequestId: row.start_request_id ?? null,
    startStreamName: row.start_stream_name ?? null,
    boardOrder: Number(row.board_order) || 0,
  };
}

export class TaskBoardStore {
  #database;
  #revision = 0;

  constructor({ databaseFile, now = () => Date.now(), idFactory = randomUUID } = {}) {
    if (!databaseFile) throw new TypeError("databaseFile is required");
    this.databaseFile = path.resolve(databaseFile);
    this.now = now;
    this.idFactory = idFactory;
    mkdirSync(path.dirname(this.databaseFile), { recursive: true });
    this.#database = new DatabaseSync(this.databaseFile);
    try {
      configure(this.#database);
      this.#migrateLegacyReleaseRegistry();
      this.#removeReleaseRegistry();
    } catch (error) {
      this.#database.close();
      this.#database = null;
      throw error;
    }
  }

  #tableExists(database, name) {
    return Boolean(database.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
    ).get(name));
  }

  #migrateLegacyReleaseRegistry() {
    const database = this.#database;
    const marker = database.prepare(
      "SELECT value FROM hub_board_settings WHERE key = 'task_release_registry_migrated_v1'",
    ).get();
    if (marker) return;
    const hasLegacy = this.#legacyArchiveTables().some(({ table }) => this.#tableExists(database, table));
    database.exec("BEGIN IMMEDIATE");
    try {
      if (hasLegacy) {
        this.#archiveLegacyReleaseRegistry(database);
        this.#importLegacyReleaseEntries(database);
      }
      if (hasLegacy) {
        this.#verifyLegacyReleaseArchive(database);
        this.#makeLegacyReleaseTablesReadOnly(database);
      }
      database.prepare(`
        INSERT INTO hub_board_settings (key, value, updated_at_ms)
        VALUES ('task_release_registry_migrated_v1', 'completed', ?)
      `).run(this.now());
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }

  #archiveLegacyReleaseRegistry(database, tables = this.#legacyArchiveTables()) {
    const insert = database.prepare(`
      INSERT OR IGNORE INTO hub_release_registry_history (
        source_kind, source_id, status, payload_json, payload_sha256, archived_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (const { kind, table, order, identity } of tables) {
      if (!this.#tableExists(database, table)) continue;
      for (const row of database.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).all()) {
        const payload = JSON.stringify(row);
        insert.run(
          kind, identity(row), String(row.status ?? "archived"), payload,
          createHash("sha256").update(payload, "utf8").digest("hex"), this.now(),
        );
      }
    }
  }

  #legacyArchiveTables() {
    return [
      { kind: "legacy", table: "hub_release_changes", order: "id", identity: (row) => String(row.id) },
      { kind: "batch", table: "hub_release_batches", order: "id", identity: (row) => String(row.id) },
      { kind: "changeset", table: "hub_release_change_sets", order: "id", identity: (row) => String(row.id) },
      { kind: "observation", table: "hub_release_turn_observations", order: "id", identity: (row) => String(row.id) },
      {
        kind: "file", table: "hub_release_change_set_files",
        order: "change_set_id, project_root, file_path",
        identity: (row) => [row.change_set_id, row.project_root, row.file_path].join("\0"),
      },
      { kind: "binding", table: "hub_release_change_set_bindings", order: "stream_id", identity: (row) => String(row.stream_id) },
      { kind: "event", table: "hub_release_change_set_events", order: "id", identity: (row) => String(row.id) },
    ];
  }

  #retiredReleaseTables() {
    return [
      ...this.#legacyArchiveTables(),
      {
        kind: "task-state", table: "hub_task_release_state", order: "task_id",
        identity: (row) => String(row.task_id),
      },
      {
        kind: "task-revision", table: "hub_task_release_revisions",
        order: "task_id, task_revision",
        identity: (row) => [row.task_id, row.task_revision].join("\0"),
      },
      {
        kind: "task-revision-file", table: "hub_task_release_revision_files",
        order: "task_id, task_revision, project_root, file_path",
        identity: (row) => [
          row.task_id, row.task_revision, row.project_root, row.file_path,
        ].join("\0"),
      },
      {
        kind: "task-completion", table: "hub_task_release_completions",
        order: "task_id, task_revision",
        identity: (row) => [row.task_id, row.task_revision].join("\0"),
      },
    ];
  }

  #verifyLegacyReleaseArchive(database, tables = this.#legacyArchiveTables()) {
    for (const { kind, table, order, identity } of tables) {
      if (!this.#tableExists(database, table)) continue;
      const sourceRows = database.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).all();
      const archivedRows = database.prepare(`
        SELECT source_id, payload_json, payload_sha256 FROM hub_release_registry_history
        WHERE source_kind = ? ORDER BY source_id
      `).all(kind);
      const archived = new Map(archivedRows.map((row) => [row.source_id, row]));
      for (const source of sourceRows) {
        const payload = JSON.stringify(source);
        const expectedHash = createHash("sha256").update(payload, "utf8").digest("hex");
        const sourceId = identity(source);
        const stored = archived.get(sourceId);
        if (!stored || stored.payload_json !== payload || stored.payload_sha256 !== expectedHash) {
          throw new Error(`legacy release ${kind} archive checksum mismatch: ${sourceId}`);
        }
      }
    }
  }

  #makeLegacyReleaseTablesReadOnly(database) {
    for (const table of [
      "hub_release_changes", "hub_release_batches", "hub_release_change_sets",
      "hub_release_turn_observations", "hub_release_change_set_files",
      "hub_release_change_set_bindings", "hub_release_change_set_events",
    ]) {
      if (!this.#tableExists(database, table)) continue;
      for (const operation of ["INSERT", "UPDATE", "DELETE"]) {
        const trigger = `task_release_archive_${table}_${operation.toLowerCase()}`;
        database.exec(`
          CREATE TRIGGER IF NOT EXISTS ${trigger}
          BEFORE ${operation} ON ${table}
          BEGIN
            SELECT RAISE(ABORT, 'legacy release registry is a read-only archive');
          END
        `);
      }
    }
  }

  #importLegacyReleaseEntries(database) {
    const coveredLegacyIds = new Set();
    if (this.#tableExists(database, "hub_release_turn_observations")) {
      for (const row of database.prepare(`
        SELECT legacy_release_change_id AS id FROM hub_release_turn_observations
        WHERE legacy_release_change_id IS NOT NULL
      `).all()) coveredLegacyIds.add(String(row.id));
    }
    if (this.#tableExists(database, "hub_release_change_sets")) {
      const rows = database.prepare(`
        SELECT * FROM hub_release_change_sets WHERE status IN ('draft', 'ready')
        ORDER BY created_at_ms, id
      `).all();
      for (const row of rows) this.#importLegacyChangeSet(database, row);
    }
    if (this.#tableExists(database, "hub_release_changes")) {
      const rows = database.prepare(`
        SELECT * FROM hub_release_changes
        WHERE status NOT IN ('released', 'discarded') ORDER BY created_at_ms, id
      `).all();
      for (const row of rows) {
        if (!coveredLegacyIds.has(String(row.id))) this.#importLegacyReleaseChange(database, row);
      }
    }
  }

  #ensureMigratedTask(database, { taskId = null, workspaceId, streamId, title, workflowStatus, sourceKey }) {
    const existing = taskId && database.prepare("SELECT id FROM hub_board_tasks WHERE id = ?").get(taskId);
    const id = existing?.id ?? this.idFactory();
    const timestamp = this.now();
    if (!existing) {
      const normalizedTitle = String(title ?? "").trim().slice(0, 160) || "Migrated release task";
      database.prepare(`
        INSERT INTO hub_board_tasks (
          id, raw_text, title, description, presentation_source, category, bucket, status,
          workflow_status, workspace_id, stream_id, source, source_key, source_json,
          placement_source, triage_status, board_order, created_at_ms, updated_at_ms, started_at_ms
        ) VALUES (?, ?, ?, '', 'manual', 'task', 'workspace', 'started', ?, ?, ?,
          'release-registry-migration', ?, '{}', 'migration', 'disabled', 0, ?, ?, ?)
      `).run(
        id, normalizedTitle, normalizedTitle, workflowStatus, workspaceId, streamId,
        sourceKey, timestamp, timestamp, timestamp,
      );
    } else {
      database.prepare(`
        UPDATE hub_board_tasks SET bucket = 'workspace', status = 'started', workflow_status = ?,
          workspace_id = ?, stream_id = ?, completed_at_ms = NULL, updated_at_ms = ? WHERE id = ?
      `).run(workflowStatus, workspaceId, streamId, timestamp, id);
    }
    database.prepare(`
      INSERT INTO hub_task_release_state (task_id, revision, frozen_revision, manifest_hash, updated_at_ms)
      VALUES (?, 0, NULL, '', ?) ON CONFLICT(task_id) DO NOTHING
    `).run(id, timestamp);
    return id;
  }

  #importLegacyChangeSet(database, row) {
    let files = [];
    if (this.#tableExists(database, "hub_release_change_set_files")) {
      const storedFiles = database.prepare(`
        SELECT project_root AS projectRoot, file_path AS path, operation, NULL AS turnId,
          base_blob AS baseBlob, result_blob AS resultBlob, patch_hash AS patchHash
        FROM hub_release_change_set_files WHERE change_set_id = ?
      `).all(row.id);
      files = storedFiles.filter((file) => ["added", "modified", "deleted"].includes(file.operation));
    }
    const frozenEvent = this.#tableExists(database, "hub_release_change_set_events")
      ? database.prepare(`
        SELECT payload_json FROM hub_release_change_set_events
        WHERE change_set_id = ? AND event_type = 'changeset.frozen'
        ORDER BY created_at_ms DESC, id DESC LIMIT 1
      `).get(row.id)
      : null;
    let frozenAudit = null;
    try { frozenAudit = JSON.parse(String(frozenEvent?.payload_json ?? "null")); } catch { frozenAudit = null; }
    const verifiedReady = row.status === "ready"
      && Boolean(String(row.manifest_hash ?? "").trim())
      && String(row.repository_evidence_json ?? "[]") !== "[]"
      && files.length > 0
      && files.every((file) => String(file.base_blob ?? file.baseBlob ?? "").trim()
        && String(file.result_blob ?? file.resultBlob ?? "").trim())
      && Boolean(frozenAudit?.verification?.verifier?.name || frozenAudit?.verifier?.name);
    const workflowStatus = verifiedReady ? "awaiting_implementation" : "in_progress";
    const taskId = this.#ensureMigratedTask(database, {
      taskId: row.task_id,
      workspaceId: row.workspace_id,
      streamId: row.owner_stream_id,
      title: row.title,
      workflowStatus,
      sourceKey: `release-migration:changeset:${row.id}`,
    });
    if (this.#tableExists(database, "hub_release_turn_observations")) {
      for (const observation of database.prepare(`
        SELECT * FROM hub_release_turn_observations WHERE change_set_id = ? ORDER BY created_at_ms, id
      `).all(row.id)) {
        let observed = [];
        try { observed = JSON.parse(String(observation.files_json ?? "[]")); } catch { observed = []; }
        if (observed.length) this.#insertMigratedWorkLog(database, taskId, observation, observed);
      }
    }
    this.#migrateRepositoryEvidence(database, taskId, row.repository_evidence_json);
    this.#freezeMigratedTask(database, taskId, verifiedReady, Number(row.revision) || 1, {
      manifestHash: row.manifest_hash,
      repositoriesJson: row.repository_evidence_json,
      verificationJson: JSON.stringify(frozenAudit?.verification ?? frozenAudit ?? {}),
      files,
    });
    database.prepare(`
      UPDATE hub_release_registry_history SET migrated_task_id = ?
      WHERE source_kind = 'changeset' AND source_id = ?
    `).run(taskId, row.id);
  }

  #importLegacyReleaseChange(database, row) {
    const workflowStatus = "in_progress";
    const taskId = this.#ensureMigratedTask(database, {
      workspaceId: row.workspace_id,
      streamId: row.stream_id,
      title: row.summary,
      workflowStatus,
      sourceKey: `release-migration:legacy:${row.id}`,
    });
    let files = [];
    for (const field of ["files_json", "observed_files_json"]) {
      try { files = JSON.parse(String(row[field] ?? "[]")); } catch { files = []; }
      if (files.length) break;
    }
    const changedFiles = files.map((file) => ({
      projectRoot: row.project_root, path: file, operation: "modified", turnId: row.turn_id,
    }));
    this.#insertMigratedWorkLog(database, taskId, row, files);
    this.#freezeMigratedTask(database, taskId, false, Number(row.revision) || 1);
    database.prepare(`
      UPDATE hub_release_registry_history SET migrated_task_id = ?
      WHERE source_kind = 'legacy' AND source_id = ?
    `).run(taskId, row.id);
  }

  #insertMigratedWorkLog(database, taskId, row, files) {
    if (!files.length) return;
    database.prepare(`
      INSERT OR IGNORE INTO hub_task_work_log (
        id, task_id, provider, provider_thread_id, turn_id, project_root,
        summary, status, changed_files_json, created_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      this.idFactory(), String(taskId), String(row.provider ?? "migration"),
      String(row.provider_thread_id ?? `migration:${taskId}`),
      String(row.turn_id ?? row.id ?? `migration:${taskId}`),
      String(row.project_root ?? ""), String(row.summary ?? "").slice(0, 2_000),
      String(row.status ?? row.observed_status ?? "completed"),
      JSON.stringify(files), Number(row.created_at_ms) || this.now(),
    );
  }

  #migrateRepositoryEvidence(database, taskId, rawEvidence) {
    let values = [];
    try { values = JSON.parse(String(rawEvidence ?? "[]")); } catch { values = []; }
    const insert = database.prepare(`
      INSERT OR REPLACE INTO hub_task_git_references
        (task_id, project_root, branch, result_commit, updated_at_ms)
      VALUES (?, ?, ?, ?, ?)
    `);
    for (const value of Array.isArray(values) ? values : []) {
      const projectRoot = String(value.projectRoot ?? value.project_root ?? "").trim();
      const result = String(value.resultRevision ?? value.result_revision ?? "").trim();
      if (projectRoot && result) {
        insert.run(taskId, projectRoot, taskBranchName(taskId, projectRoot), result, this.now());
      }
    }
  }

  #freezeMigratedTask(database, taskId, frozen, revision, evidence = {}) {
    const details = this.#releaseDetails(database, taskId);
    const taskRevision = Number(database.prepare(
      "SELECT row_revision AS value FROM hub_board_tasks WHERE id = ?",
    ).get(taskId)?.value) || revision;
    const manifestHash = frozen && Array.isArray(evidence.files) && evidence.files.length
      ? String(evidence.manifestHash ?? "").trim()
      : "";
    if (manifestHash) {
      database.prepare(`
        INSERT OR IGNORE INTO hub_task_release_revisions (
          task_id, task_revision, manifest_hash, repositories_json, verification_json, created_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        taskId, taskRevision, manifestHash, String(evidence.repositoriesJson ?? "[]"),
        String(evidence.verificationJson ?? "{}"), this.now(),
      );
      const insert = database.prepare(`
        INSERT OR IGNORE INTO hub_task_release_revision_files (
          task_id, task_revision, project_root, file_path, operation,
          base_blob, result_blob, patch_hash
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const file of Array.isArray(evidence.files) ? evidence.files : []) {
        insert.run(
          taskId, taskRevision, file.projectRoot, file.path, file.operation,
          String(file.base_blob ?? file.baseBlob ?? ""),
          String(file.result_blob ?? file.resultBlob ?? ""),
          String(file.patch_hash ?? file.patchHash ?? ""),
        );
      }
    }
    database.prepare(`
      UPDATE hub_task_release_state SET revision = ?, frozen_revision = ?, manifest_hash = ?, updated_at_ms = ?
      WHERE task_id = ?
    `).run(taskRevision, manifestHash ? taskRevision : null, manifestHash, this.now(), taskId);
  }

  #withDatabase(operation) {
    const database = this.#database;
    if (!database) throw new Error("Task board store is closed");
    const changesBefore = Number(database.prepare("SELECT total_changes() AS value").get()?.value) || 0;
    try {
      return operation(database);
    } finally {
      const changesAfter = Number(database.prepare("SELECT total_changes() AS value").get()?.value) || 0;
      if (changesAfter !== changesBefore) this.#revision += 1;
    }
  }

  #taskRow(database, id) {
    const taskId = String(id ?? "").trim();
    const row = database.prepare("SELECT * FROM hub_board_tasks WHERE id = ?").get(taskId);
    if (!row) throw new Error("Task не найден");
    return row;
  }

  #releaseDetails(database, taskId) {
    const workLog = database.prepare(`
      SELECT provider, provider_thread_id AS threadId, turn_id AS turnId,
        project_root AS projectRoot, summary, status, changed_files_json, created_at_ms
      FROM hub_task_work_log WHERE task_id = ? ORDER BY created_at_ms, id
    `).all(taskId).map((row) => {
      let files = [];
      try { files = JSON.parse(String(row.changed_files_json ?? "[]")); } catch { files = []; }
      return {
        provider: row.provider,
        threadId: row.threadId,
        turnId: row.turnId,
        projectRoot: row.projectRoot,
        summary: row.summary,
        status: row.status,
        changedFiles: files,
        createdAt: new Date(Number(row.created_at_ms)).toISOString(),
      };
    });
    const gitReferences = database.prepare(`
      SELECT project_root AS projectRoot, branch, result_commit AS resultCommit
      FROM hub_task_git_references WHERE task_id = ? ORDER BY project_root
    `).all(taskId);
    return {
      workLog,
      gitReferences: normalizedTaskGitReferences(gitReferences),
    };
  }

  #taskWithRelease(database, row) {
    const task = taskFromRow(row);
    return task ? { ...task, ...this.#releaseDetails(database, task.id) } : null;
  }

  get revision() {
    return this.#revision;
  }

  close() {
    this.#database?.close();
    this.#database = null;
  }

  create({
    text, source = "hub", sourceKey = null, sourceDetails = {}, triageStatus = "pending",
    bucket = "backlog", workspaceId = null, taskPrefix = "",
  } = {}) {
    const normalizedText = normalizedTaskText(text);
    const legacyBundle = normalizedText.startsWith(LEGACY_TELEGRAM_BUNDLE_PREFIX);
    const rawText = legacyBundle
      ? normalizedTaskText(normalizedText.slice(LEGACY_TELEGRAM_BUNDLE_PREFIX.length))
      : normalizedText;
    const presentation = taskPresentation(rawText);
    const normalizedSourceKey = String(sourceKey ?? "").trim() || null;
    const initialTriageStatus = !legacyBundle && triageStatus === "disabled" ? "disabled" : "pending";
    return this.#withDatabase((database) => {
      database.exec("BEGIN IMMEDIATE");
      try {
        if (normalizedSourceKey) {
          const existing = database.prepare(
            "SELECT * FROM hub_board_tasks WHERE source_key = ?",
          ).get(normalizedSourceKey);
          if (existing) {
            database.exec("COMMIT");
            return taskFromRow(existing);
          }
        }
        const timestamp = this.now();
        const id = String(this.idFactory());
        const normalizedBucket = normalizedTaskBucket(bucket);
        const normalizedWorkspaceId = normalizedBucket === "workspace" ? String(workspaceId ?? "").trim() : null;
        if (normalizedBucket === "workspace" && !normalizedWorkspaceId) throw new Error("Выберите Workspace");
        const taskNumber = normalizedBucket === "workspace" ? allocateTaskNumber(database, taskPrefix, timestamp) : "";
        const boardOrder = taskLocationRows(database, normalizedBucket, normalizedWorkspaceId).length;
        database.prepare(`
          INSERT INTO hub_board_tasks (
            id, raw_text, title, description, task_number, bucket, workspace_id,
            source, source_key, source_json, triage_status, board_order, created_at_ms, updated_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          id,
          rawText,
          presentation.title,
          presentation.description,
          taskNumber,
          normalizedBucket,
          normalizedWorkspaceId,
          String(source ?? "hub").trim() || "hub",
          normalizedSourceKey,
          JSON.stringify(sourceDetails ?? {}),
          initialTriageStatus,
          boardOrder,
          timestamp,
          timestamp,
        );
        const result = taskFromRow(database.prepare("SELECT * FROM hub_board_tasks WHERE id = ?").get(id));
        database.exec("COMMIT");
        return result;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
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
      this.#taskRow(database, row.id);
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
      const row = this.#taskRow(database, taskId);
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
      this.#taskRow(database, row.id);
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
      this.#taskRow(database, row.id);
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
    return this.#withDatabase((database) => this.#taskWithRelease(database,
      database.prepare("SELECT * FROM hub_board_tasks WHERE id = ?").get(taskId),
    ));
  }

  list({ includeDone = true } = {}) {
    return this.#withDatabase((database) => database.prepare(`
      SELECT * FROM hub_board_tasks
      ${includeDone ? "" : "WHERE status != 'done'"}
      ORDER BY CASE status WHEN 'open' THEN 0 WHEN 'started' THEN 1 ELSE 2 END,
        bucket, workspace_id, board_order, created_at_ms, id
    `).all().map((row) => this.#taskWithRelease(database, row)));
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
      this.#taskRow(database, id);
      database.prepare(`
        UPDATE hub_board_tasks
        SET triage_status = 'running', triage_error = NULL, updated_at_ms = ?
        WHERE id = ?
      `).run(this.now(), String(id));
      return taskFromRow(database.prepare("SELECT * FROM hub_board_tasks WHERE id = ?").get(String(id)));
    });
  }

  updatePresentation(id, { title, description = "", taskNumber = undefined } = {}) {
    const taskId = String(id ?? "").trim();
    const normalizedTitle = normalizedTaskTitle(title);
    const normalizedDescription = normalizedTaskDescription(description);
    const correctedText = normalizedDescription
      ? `${normalizedTitle}\n\n${normalizedDescription}`
      : normalizedTitle;
    return this.#withDatabase((database) => {
      database.exec("BEGIN IMMEDIATE");
      try {
        const current = this.#taskRow(database, taskId);
        const nextTaskNumber = taskNumber === undefined
          ? String(current.task_number ?? "")
          : normalizedTaskNumber(taskNumber, { allowEmpty: false });
        const duplicate = nextTaskNumber && database.prepare(
          "SELECT id FROM hub_board_tasks WHERE task_number = ? AND id != ?",
        ).get(nextTaskNumber, taskId);
        if (duplicate) throw new Error(`Номер Task уже используется: ${nextTaskNumber}`);
        const result = database.prepare(`
          UPDATE hub_board_tasks SET
            title = ?, description = ?, corrected_text = ?, task_number = ?, presentation_source = 'manual',
            updated_at_ms = ?
          WHERE id = ?
        `).run(normalizedTitle, normalizedDescription, correctedText, nextTaskNumber, this.now(), taskId);
        if (!result.changes) throw new Error("Задача не найдена");
        if (nextTaskNumber) advanceTaskNumberSequence(database, nextTaskNumber, this.now());
        const updated = taskFromRow(database.prepare("SELECT * FROM hub_board_tasks WHERE id = ?").get(taskId));
        database.exec("COMMIT");
        return updated;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
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
    taskPrefix = "",
    autoPlace = false,
  } = {}) {
    const taskId = String(id ?? "").trim();
    const normalizedCorrectedText = normalizedTaskText(correctedText);
    const presentation = taskPresentation(normalizedCorrectedText, { title, description });
    const normalizedCategory = normalizedTaskCategory(category);
    const normalizedBucket = normalizedTaskBucket(bucket);
    const numericConfidence = Math.max(0, Math.min(1, Number(confidence) || 0));
    return this.#withDatabase((database) => {
      database.exec("BEGIN IMMEDIATE");
      try {
        const current = this.#taskRow(database, taskId);
        const canAutoPlace = autoPlace
          && current.placement_source === "default"
          && current.bucket === "backlog"
          && current.status === "open";
        const targetWorkspaceId = canAutoPlace && normalizedBucket === "workspace"
          ? String(workspaceId ?? "").trim() || null
          : current.workspace_id;
        const taskNumber = canAutoPlace && normalizedBucket === "workspace"
          ? taskNumberForRow(database, current, taskPrefix, this.now())
          : String(current.task_number ?? "");
        database.prepare(`
          UPDATE hub_board_tasks SET
            title = CASE WHEN presentation_source = 'manual' THEN title ELSE ? END,
            description = CASE WHEN presentation_source = 'manual' THEN description ELSE ? END,
            corrected_text = CASE WHEN presentation_source = 'manual' THEN corrected_text ELSE ? END,
            category = ?, triage_status = 'completed',
            triage_confidence = ?, triage_reason = ?, triage_error = NULL,
            bucket = ?, workspace_id = ?, task_number = ?, placement_source = ?, updated_at_ms = ?
          WHERE id = ?
        `).run(
          presentation.title,
          presentation.description,
          normalizedCorrectedText,
          normalizedCategory,
          numericConfidence,
          String(reason ?? "").trim().slice(0, 1000),
          canAutoPlace ? normalizedBucket : current.bucket,
          targetWorkspaceId,
          taskNumber,
          canAutoPlace ? "ai" : current.placement_source,
          this.now(),
          taskId,
        );
        const result = taskFromRow(database.prepare("SELECT * FROM hub_board_tasks WHERE id = ?").get(taskId));
        database.exec("COMMIT");
        return result;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    });
  }

  markTriageFailed(id, error) {
    return this.#withDatabase((database) => {
      this.#taskRow(database, id);
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
      this.#taskRow(database, id);
      database.prepare(`
        UPDATE hub_board_tasks
        SET triage_status = 'pending', triage_error = NULL,
          presentation_source = 'automatic', updated_at_ms = ?
        WHERE id = ?
      `).run(this.now(), String(id));
      return taskFromRow(database.prepare("SELECT * FROM hub_board_tasks WHERE id = ?").get(String(id)));
    });
  }

  move(id, { bucket, workspaceId = null, beforeId = null, taskPrefix = "" } = {}) {
    const normalizedBucket = normalizedTaskBucket(bucket);
    const normalizedWorkspaceId = normalizedBucket === "workspace"
      ? String(workspaceId ?? "").trim()
      : null;
    if (normalizedBucket === "workspace" && !normalizedWorkspaceId) throw new Error("Выберите Workspace");
    return this.#withDatabase((database) => {
      const taskId = String(id ?? "").trim();
      const current = this.#taskRow(database, taskId);
      const oldBucket = current.bucket;
      const oldWorkspaceId = current.workspace_id ?? null;
      database.exec("BEGIN IMMEDIATE");
      try {
        const taskNumber = normalizedBucket === "workspace"
          ? taskNumberForRow(database, current, taskPrefix, this.now())
          : String(current.task_number ?? "");
        database.prepare(`
          UPDATE hub_board_tasks
          SET bucket = ?, workspace_id = ?, stream_id = NULL,
            task_number = ?, placement_source = 'manual', updated_at_ms = ?
          WHERE id = ?
        `).run(normalizedBucket, normalizedWorkspaceId, taskNumber, this.now(), taskId);
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

  reassignWorkspace(sourceWorkspaceId, targetWorkspaceId, { taskPrefix = "" } = {}) {
    const sourceId = String(sourceWorkspaceId ?? "").trim();
    const targetId = String(targetWorkspaceId ?? "").trim();
    if (!sourceId || !targetId) throw new Error("Workspace не найден");
    if (sourceId === targetId) return 0;
    return this.#withDatabase((database) => {
      const allSourceIds = database.prepare(
        "SELECT id FROM hub_board_tasks WHERE workspace_id = ? ORDER BY id",
      ).all(sourceId).map((row) => row.id);
      for (const taskId of allSourceIds) this.#taskRow(database, taskId);
      const sourceIds = taskLocationRows(database, "workspace", sourceId).map((row) => row.id);
      const targetIds = taskLocationRows(database, "workspace", targetId).map((row) => row.id);
      database.exec("BEGIN IMMEDIATE");
      try {
        for (const taskId of allSourceIds) {
          assignTaskNumber(database, this.#taskRow(database, taskId), taskPrefix, this.now());
        }
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

  assignWorkspaceTaskNumbers(workspaceId, taskPrefix) {
    const targetWorkspaceId = String(workspaceId ?? "").trim();
    if (!targetWorkspaceId) throw new Error("Workspace не найден");
    return this.#withDatabase((database) => {
      const prefix = normalizedWorkspaceTaskPrefix(taskPrefix);
      if (!prefix) return 0;
      database.exec("BEGIN IMMEDIATE");
      try {
        const rows = database.prepare(`
          SELECT * FROM hub_board_tasks WHERE workspace_id = ? AND task_number = '' ORDER BY created_at_ms, id
        `).all(targetWorkspaceId);
        const timestamp = this.now();
        for (const row of rows) assignTaskNumber(database, row, prefix, timestamp);
        database.exec("COMMIT");
        return rows.length;
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
    ).get()?.value ?? ""));
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
      const current = this.#taskRow(database, taskId);
      const currentRequestId = String(current.start_request_id ?? "").trim();
      if (currentRequestId && currentRequestId !== normalizedRequestId) {
        throw new Error("Task launch is already pending; retry it with the original request_id");
      }
      if (current.status === "done") throw new Error("Task уже закрыта");
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
      this.#taskRow(database, taskId);
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
      const current = this.#taskRow(database, id);
      if (normalizedRequestId && String(current.start_request_id ?? "") !== normalizedRequestId) {
        throw new Error("Task launch request does not match the prepared Task");
      }
      database.prepare(`
        UPDATE hub_board_tasks
        SET bucket = 'workspace', status = 'started', workspace_id = ?, stream_id = ?,
          workflow_status = 'in_progress', placement_source = 'manual',
          started_at_ms = COALESCE(started_at_ms, ?),
          completed_at_ms = NULL, updated_at_ms = ?
        WHERE id = ?
      `).run(String(workspaceId), String(streamId), timestamp, timestamp, String(id));
      const task = this.#taskWithRelease(
        database,
        database.prepare("SELECT * FROM hub_board_tasks WHERE id = ?").get(String(id)),
      );
      if (!task) throw new Error("Task не найден");
      return task;
    });
  }

  complete(id) {
    const timestamp = this.now();
    return this.#withDatabase((database) => {
      this.#taskRow(database, id);
      database.prepare(`
        UPDATE hub_board_tasks
        SET status = 'done', completed_at_ms = ?, updated_at_ms = ? WHERE id = ?
      `).run(timestamp, timestamp, String(id));
      const task = this.#taskWithRelease(
        database,
        database.prepare("SELECT * FROM hub_board_tasks WHERE id = ?").get(String(id)),
      );
      if (!task) throw new Error("Task не найден");
      return task;
    });
  }

  setWorkflowStatus(id, status) {
    const workflowStatus = normalizedTaskWorkflowStatus(status);
    const timestamp = this.now();
    return this.#withDatabase((database) => {
      const taskId = String(id);
      const current = this.#taskRow(database, taskId);
      const lifecycleStatus = current.status === "done"
        ? (current.stream_id ? "started" : "open")
        : current.status;
      if (workflowStatus !== "awaiting_implementation") {
        database.prepare(`
          UPDATE hub_task_turn_bindings SET requested_workflow_status = NULL
          WHERE task_id = ? AND requested_workflow_status IS NOT NULL
        `).run(taskId);
      }
      database.prepare(`
        UPDATE hub_board_tasks
        SET status = ?, workflow_status = ?, completed_at_ms = NULL, updated_at_ms = ?
        WHERE id = ?
      `).run(lifecycleStatus, workflowStatus, timestamp, taskId);
      return this.#taskWithRelease(
        database,
        database.prepare("SELECT * FROM hub_board_tasks WHERE id = ?").get(taskId),
      );
    });
  }

  claim(id, { workspaceId, streamId, provider, threadId, turnId, gitBaseline = null } = {}) {
    const taskId = String(id ?? "").trim();
    const identity = [provider, threadId, turnId].map((value) => String(value ?? "").trim());
    if (!taskId || identity.some((value) => !value)) throw new Error("Task claim requires an exact provider turn");
    const baselineJson = gitBaselineJson(gitBaseline);
    const timestamp = this.now();
    return this.#withDatabase((database) => {
      database.exec("BEGIN IMMEDIATE");
      try {
      const current = this.#taskRow(database, taskId);
      if (String(current.workspace_id ?? "") !== String(workspaceId ?? "")) {
        throw new Error("Task is outside the current Workspace");
      }
      const bound = database.prepare(`
        SELECT task_id FROM hub_task_turn_bindings
        WHERE provider = ? AND provider_thread_id = ? AND turn_id = ?
      `).get(...identity);
      if (bound && bound.task_id !== taskId) throw new Error("provider turn is already claimed by another Task");
      if (bound?.task_id === taskId) {
        if (baselineJson !== "{}") {
          database.prepare(`
            UPDATE hub_task_turn_bindings SET baseline_json = ?
            WHERE provider = ? AND provider_thread_id = ? AND turn_id = ? AND baseline_json = '{}'
          `).run(baselineJson, ...identity);
        }
        const result = this.#taskWithRelease(database, current);
        database.exec("COMMIT");
        return result;
      }
      database.prepare(`
        INSERT INTO hub_task_turn_bindings (
          task_id, provider, provider_thread_id, turn_id, baseline_json, claimed_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(provider, provider_thread_id, turn_id) DO UPDATE SET
          baseline_json = CASE
            WHEN hub_task_turn_bindings.baseline_json = '{}' THEN excluded.baseline_json
            ELSE hub_task_turn_bindings.baseline_json
          END
      `).run(taskId, ...identity, baselineJson, timestamp);
      database.prepare(`
        UPDATE hub_board_tasks SET bucket = 'workspace', status = 'started', workflow_status = 'in_progress',
          workspace_id = ?, stream_id = ?, placement_source = 'manual',
          started_at_ms = COALESCE(started_at_ms, ?), completed_at_ms = NULL, updated_at_ms = ?
        WHERE id = ?
      `).run(String(workspaceId), String(streamId), timestamp, timestamp, taskId);
      const result = this.#taskWithRelease(
        database,
        database.prepare("SELECT * FROM hub_board_tasks WHERE id = ?").get(taskId),
      );
      database.exec("COMMIT");
      return result;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    });
  }

  claimedTaskForTurn({ provider, threadId, turnId } = {}) {
    const identity = [provider, threadId, turnId].map((value) => String(value ?? "").trim());
    if (identity.some((value) => !value)) return null;
    return this.#withDatabase((database) => {
      const row = database.prepare(`
        SELECT task.*, binding.baseline_json, binding.requested_workflow_status
        FROM hub_task_turn_bindings binding
        JOIN hub_board_tasks task ON task.id = binding.task_id
        WHERE binding.provider = ? AND binding.provider_thread_id = ? AND binding.turn_id = ?
      `).get(...identity);
      if (!row) return null;
      let gitBaseline = null;
      try { gitBaseline = JSON.parse(String(row.baseline_json ?? "{}")); } catch { gitBaseline = null; }
      return {
        ...this.#taskWithRelease(database, row),
        gitBaseline,
        requestedWorkflowStatus: row.requested_workflow_status ?? null,
      };
    });
  }

  requestWorkflowStatus(id, { status, provider, threadId, turnId } = {}) {
    const workflowStatus = normalizedTaskWorkflowStatus(status);
    if (workflowStatus === "awaiting_implementation") {
      const identity = [provider, threadId, turnId].map((value) => String(value ?? "").trim());
      this.#withDatabase((database) => {
        this.#taskRow(database, id);
        database.prepare("DELETE FROM hub_task_git_references WHERE task_id = ?").run(String(id));
        if (!identity.some((value) => !value)) {
          const binding = database.prepare(`
            SELECT task_id FROM hub_task_turn_bindings
            WHERE provider = ? AND provider_thread_id = ? AND turn_id = ?
          `).get(...identity);
          if (binding?.task_id === String(id)) {
            database.prepare(`
              UPDATE hub_task_turn_bindings SET requested_workflow_status = 'awaiting_implementation'
              WHERE provider = ? AND provider_thread_id = ? AND turn_id = ?
            `).run(...identity);
          }
        }
      });
    }
    return this.setWorkflowStatus(id, workflowStatus);
  }

  recordTaskTurn({
    taskId = null, provider, threadId, turnId, projectRoot, summary = "", status = "completed",
    changedFiles = [], gitBaseline = null, resultSnapshot = null, branch = null,
  } = {}) {
    const identity = [provider, threadId, turnId].map((value) => String(value ?? "").trim());
    const files = normalizedTaskChangedFiles(changedFiles);
    if (identity.some((value) => !value)) return null;
    const timestamp = this.now();
    return this.#withDatabase((database) => {
      database.exec("BEGIN IMMEDIATE");
      try {
      const binding = database.prepare(`
        SELECT * FROM hub_task_turn_bindings
        WHERE provider = ? AND provider_thread_id = ? AND turn_id = ?
      `).get(...identity);
      if (!binding) throw new Error("terminal Task evidence requires an exact durable provider turn binding");
      const resolvedTaskId = String(taskId ?? binding.task_id).trim();
      if (binding.task_id !== resolvedTaskId) throw new Error("terminal Task identity conflicts with its exact turn binding");
      this.#taskRow(database, resolvedTaskId);
      let baselineJson = String(binding.baseline_json ?? "{}");
      const recoveredBaselineJson = gitBaselineJson(gitBaseline);
      if (baselineJson === "{}" && recoveredBaselineJson !== "{}") {
        database.prepare(`
          UPDATE hub_task_turn_bindings SET baseline_json = ?
          WHERE provider = ? AND provider_thread_id = ? AND turn_id = ?
        `).run(recoveredBaselineJson, ...identity);
        baselineJson = recoveredBaselineJson;
      }
      if (files.length) database.prepare(`
        INSERT INTO hub_task_work_log (
          id, task_id, provider, provider_thread_id, turn_id, project_root,
          summary, status, changed_files_json, created_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(task_id, provider, provider_thread_id, turn_id) DO UPDATE SET
          summary = excluded.summary, status = excluded.status,
          changed_files_json = excluded.changed_files_json
      `).run(
        this.idFactory(), resolvedTaskId, ...identity, String(projectRoot ?? ""),
        String(summary ?? "").trim().slice(0, 2_000), String(status ?? "completed"),
        JSON.stringify(files), timestamp,
      );
      this.#recordGitReference(database, resolvedTaskId, projectRoot, branch, resultSnapshot);
      database.prepare(`
        UPDATE hub_board_tasks SET updated_at_ms = ? WHERE id = ?
      `).run(timestamp, resolvedTaskId);
      database.prepare(`
        UPDATE hub_task_turn_bindings SET terminal_at_ms = ?
        WHERE provider = ? AND provider_thread_id = ? AND turn_id = ?
      `).run(timestamp, ...identity);
      const result = this.#taskWithRelease(
        database,
        database.prepare("SELECT * FROM hub_board_tasks WHERE id = ?").get(resolvedTaskId),
      );
      database.exec("COMMIT");
      return result;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    });
  }

  #recordGitReference(database, taskId, projectRoot, branch, resultSnapshot) {
    const flatten = (snapshot) => Array.isArray(snapshot?.repositories)
      ? snapshot.repositories
      : (snapshot?.repoRoot ? [snapshot] : []);
    const insert = database.prepare(`
      INSERT INTO hub_task_git_references (
        task_id, project_root, branch, result_commit, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(task_id, project_root) DO UPDATE SET
        branch = excluded.branch, result_commit = excluded.result_commit,
        updated_at_ms = excluded.updated_at_ms
    `);
    for (const value of flatten(resultSnapshot)) {
      const root = path.resolve(value.repoRoot || projectRoot);
      const resultCommit = String(value.tree ?? "").trim();
      const taskBranch = String(branch ?? "").trim() || taskBranchName(taskId, root);
      if (root && resultCommit) insert.run(taskId, root, taskBranch, resultCommit, this.now());
    }
  }

  #removeReleaseRegistry() {
    const database = this.#database;
    const retiredTables = this.#retiredReleaseTables();
    database.exec("BEGIN IMMEDIATE");
    try {
      this.#archiveLegacyReleaseRegistry(database, retiredTables);
      this.#verifyLegacyReleaseArchive(database, retiredTables);
      for (const { table } of retiredTables.toReversed()) {
        database.exec(`DROP TABLE IF EXISTS ${table}`);
      }
      database.prepare(`
        INSERT INTO hub_board_settings (key, value, updated_at_ms)
        VALUES ('task_release_registry_removed_v2', 'completed', ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at_ms = excluded.updated_at_ms
      `).run(this.now());
      database.exec(`
        CREATE TRIGGER IF NOT EXISTS hub_release_registry_history_no_update
        BEFORE UPDATE ON hub_release_registry_history
        BEGIN
          SELECT RAISE(ABORT, 'release history is immutable');
        END;
        CREATE TRIGGER IF NOT EXISTS hub_release_registry_history_no_delete
        BEFORE DELETE ON hub_release_registry_history
        BEGIN
          SELECT RAISE(ABORT, 'release history is immutable');
        END;
      `);
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }

  releaseTasks(workspaceId) {
    return this.list({ includeDone: true }).filter((task) => task.workspaceId === String(workspaceId));
  }

  completeRelease(workspaceId, { expectedPlanRevision = null, plan = null, verificationEvidence = null } = {}) {
    const expected = String(expectedPlanRevision ?? "").trim();
    return this.#withDatabase((database) => {
      database.exec("BEGIN IMMEDIATE");
      try {
      const tasks = this.releaseTasks(workspaceId);
      const awaiting = tasks.filter((task) => task.status !== "done"
        && task.workflowStatus === "awaiting_implementation");
      const doneAudit = tasks.filter((task) => task.status !== "done" && task.workflowStatus === "done");
      const currentRevision = taskReleasePlanRevision(workspaceId, [...awaiting, ...doneAudit]);
      if (!expected || currentRevision !== expected || plan?.revision !== expected) {
        throw new Error("release plan revision conflict; verify the current release plan again");
      }
      if (!plan.candidates.length) throw new Error("release has no awaiting Task candidates");
      if (!verificationEvidence || typeof verificationEvidence !== "object") {
        throw new Error("release completion requires durable publication evidence");
      }
      const timestamp = this.now();
      for (const task of plan.candidates) {
        const current = database.prepare(`
          SELECT row_revision, workflow_status FROM hub_board_tasks WHERE id = ?
        `).get(task.id);
        if (!current
          || Number(current.row_revision) !== task.revision
          || current.workflow_status !== "awaiting_implementation") {
          throw new Error(`release Task revision changed: ${task.id}`);
        }
        const result = database.prepare(`
          UPDATE hub_board_tasks SET workflow_status = 'done', status = 'done',
            completed_at_ms = ?, updated_at_ms = ?
          WHERE id = ? AND row_revision = ? AND workflow_status = 'awaiting_implementation'
        `).run(timestamp, timestamp, task.id, task.revision);
        if (!Number(result.changes)) throw new Error(`release Task disappeared: ${task.id}`);
      }
      const result = {
        workspaceId: String(workspaceId),
        released: plan.candidates.map((task) => ({
          id: task.id,
          revision: task.revision,
          gitReferences: task.gitReferences,
        })),
        verificationEvidence,
      };
      database.exec("COMMIT");
      return result;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    });
  }

  remove(id) {
    return this.#withDatabase((database) => {
      const taskId = String(id);
      return Number(database.prepare("DELETE FROM hub_board_tasks WHERE id = ?").run(taskId).changes) > 0;
    });
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
