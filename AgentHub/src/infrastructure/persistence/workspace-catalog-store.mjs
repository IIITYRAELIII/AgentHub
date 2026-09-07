import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { AsyncSqliteMutationQueue } from "./async-sqlite-mutation-queue.mjs";

import { editableWorkspaceDeveloperRules } from "../../domain/editable-workspace-developer-rules.mjs";
import { normalizeInterstreamOrigin } from "../../domain/interstream-message.mjs";

import {
  EXPERIMENTS_SYSTEM_KEY,
  OTHER_WORKSPACE_NAME,
  normalizedProvider,
  normalizedStreamName,
  normalizedThreadIdentity,
  normalizedWorkspaceName,
  providerThreadKey,
  streamDisplayName,
} from "../../domain/workspace-stream-identity.mjs";
import {
  effectiveStreamDeveloperRules,
  effectiveWorkspaceDeveloperRules,
  legacyReleaseWorkflowRules,
  RELEASE_WORKFLOW_SETTING,
  releaseWorkflowEnabled,
  workspaceSettingsWithReleaseWorkflow,
} from "../../domain/workspace-release-workflow.mjs";
import { workspaceSettingsWithTaskPrefix } from "../../domain/task-number.mjs";
import {
  withArchitectReleasePrimaryWorkspaceRule,
  withReleasePrimaryWorkspaceRule,
} from "../../domain/release-primary-workspace-policy.mjs";

const SCHEMA_VERSION = 13;
export const DEVELOPER_RULES_MAX_BYTES = 32 * 1024;
const SOURCES = new Set(["created", "discovered", "migration", "rebirth"]);
const DEVELOPER_RULE_SCOPES = new Set(["workspace", "stream"]);
const INTERSTREAM_MESSAGE_TOOLS = new Set([
  "hub_stream_message_send",
  "hub_task_start",
  "hub_task_reassign",
]);

function configure(database) {
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA busy_timeout = 0;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS hub_workspace_catalog_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS hub_workspaces (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      comment TEXT NOT NULL DEFAULT '',
      kind TEXT NOT NULL CHECK (kind IN ('user', 'system')),
      system_key TEXT UNIQUE,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      settings_json TEXT NOT NULL DEFAULT '{}',
      archived_at_ms INTEGER,
      purge_after_ms INTEGER
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS hub_workspace_deletion_fences (
      workspace_id TEXT PRIMARY KEY,
      confirmed_name TEXT NOT NULL,
      deleted_at_ms INTEGER NOT NULL
    ) WITHOUT ROWID;
    CREATE TRIGGER IF NOT EXISTS hub_workspaces_no_reuse_after_permanent_delete
      BEFORE INSERT ON hub_workspaces
      WHEN EXISTS (
        SELECT 1 FROM hub_workspace_deletion_fences WHERE workspace_id = NEW.id
      )
      BEGIN
        SELECT RAISE(ABORT, 'workspace identity was permanently deleted');
      END;
    CREATE INDEX IF NOT EXISTS hub_workspaces_updated_idx
      ON hub_workspaces(updated_at_ms DESC);
    CREATE TABLE IF NOT EXISTS hub_streams (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL CHECK (ordinal > 0),
      name TEXT,
      settings_json TEXT NOT NULL DEFAULT '{}',
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      archived_at_ms INTEGER,
      FOREIGN KEY (workspace_id) REFERENCES hub_workspaces(id) ON DELETE CASCADE,
      UNIQUE (workspace_id, ordinal)
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS hub_streams_workspace_idx
      ON hub_streams(workspace_id, ordinal);
    CREATE TABLE IF NOT EXISTS hub_threads (
      provider TEXT NOT NULL CHECK (length(trim(provider)) > 0),
      provider_thread_id TEXT NOT NULL,
      stream_id TEXT NOT NULL,
      position INTEGER NOT NULL CHECK (position > 0),
      project_root TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL CHECK (source IN ('created', 'discovered', 'migration', 'rebirth')),
      linked_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      detached_at_ms INTEGER,
      PRIMARY KEY (provider, provider_thread_id),
      FOREIGN KEY (stream_id) REFERENCES hub_streams(id) ON DELETE CASCADE,
      UNIQUE (stream_id, position)
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS hub_threads_stream_idx
      ON hub_threads(stream_id, position);
    CREATE TABLE IF NOT EXISTS hub_mcp_operations (
      request_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      stream_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      provider_thread_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      arguments_hash TEXT NOT NULL,
      interstream_content_hash TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL CHECK (status IN ('pending', 'succeeded', 'failed')),
      receipt_state TEXT NOT NULL DEFAULT 'pending',
      result_json TEXT,
      error_text TEXT NOT NULL DEFAULT '',
      created_at_ms INTEGER NOT NULL,
      completed_at_ms INTEGER,
      FOREIGN KEY (workspace_id) REFERENCES hub_workspaces(id) ON DELETE CASCADE,
      FOREIGN KEY (stream_id) REFERENCES hub_streams(id) ON DELETE CASCADE
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS hub_mcp_operations_workspace_idx
      ON hub_mcp_operations(workspace_id, created_at_ms DESC);
    CREATE TABLE IF NOT EXISTS hub_workspace_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id TEXT NOT NULL,
      stream_id TEXT,
      event_type TEXT NOT NULL,
      subject_id TEXT,
      payload_json TEXT NOT NULL DEFAULT '{}',
      dedupe_key TEXT UNIQUE,
      created_at_ms INTEGER NOT NULL,
      FOREIGN KEY (workspace_id) REFERENCES hub_workspaces(id) ON DELETE CASCADE,
      FOREIGN KEY (stream_id) REFERENCES hub_streams(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS hub_workspace_events_workspace_sequence_idx
      ON hub_workspace_events(workspace_id, sequence);
    CREATE TABLE IF NOT EXISTS hub_developer_rule_revisions (
      scope_type TEXT NOT NULL CHECK (scope_type IN ('workspace', 'stream')),
      scope_id TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK (revision > 0),
      content TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      PRIMARY KEY (scope_type, scope_id, revision)
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS hub_developer_rule_revisions_latest_idx
      ON hub_developer_rule_revisions(scope_type, scope_id, revision DESC);
    CREATE TRIGGER IF NOT EXISTS hub_workspace_developer_rules_delete
      AFTER DELETE ON hub_workspaces
      BEGIN
        DELETE FROM hub_developer_rule_revisions
        WHERE scope_type = 'workspace' AND scope_id = OLD.id;
      END;
    CREATE TRIGGER IF NOT EXISTS hub_stream_developer_rules_delete
      AFTER DELETE ON hub_streams
      BEGIN
        DELETE FROM hub_developer_rule_revisions
        WHERE scope_type = 'stream' AND scope_id = OLD.id;
      END;
    INSERT INTO hub_workspace_catalog_meta (key, value) VALUES ('schema_version', '${SCHEMA_VERSION}')
      ON CONFLICT(key) DO UPDATE SET value = excluded.value;
  `);
  const workspaceColumns = database.prepare("PRAGMA table_info(hub_workspaces)").all();
  if (!workspaceColumns.some((column) => column.name === "comment")) {
    database.exec("ALTER TABLE hub_workspaces ADD COLUMN comment TEXT NOT NULL DEFAULT ''");
  }
  if (!workspaceColumns.some((column) => column.name === "archived_at_ms")) {
    database.exec("ALTER TABLE hub_workspaces ADD COLUMN archived_at_ms INTEGER");
  }
  if (!workspaceColumns.some((column) => column.name === "purge_after_ms")) {
    database.exec("ALTER TABLE hub_workspaces ADD COLUMN purge_after_ms INTEGER");
  }
  database.exec(`
    CREATE INDEX IF NOT EXISTS hub_workspaces_archive_expiry_idx
      ON hub_workspaces(purge_after_ms)
      WHERE archived_at_ms IS NOT NULL;
  `);
  const streamColumns = database.prepare("PRAGMA table_info(hub_streams)").all();
  const operationColumns = database.prepare("PRAGMA table_info(hub_mcp_operations)").all();
  if (!operationColumns.some((column) => column.name === "interstream_content_hash")) {
    database.exec("ALTER TABLE hub_mcp_operations ADD COLUMN interstream_content_hash TEXT NOT NULL DEFAULT ''");
  }
  if (!streamColumns.some((column) => column.name === "settings_json")) {
    database.exec("ALTER TABLE hub_streams ADD COLUMN settings_json TEXT NOT NULL DEFAULT '{}'");
  }
  const threadColumns = database.prepare("PRAGMA table_info(hub_threads)").all();
  if (!threadColumns.some((column) => column.name === "detached_at_ms")) {
    database.exec("ALTER TABLE hub_threads ADD COLUMN detached_at_ms INTEGER");
  }
  if (!operationColumns.some((column) => column.name === "receipt_state")) {
    database.exec("ALTER TABLE hub_mcp_operations ADD COLUMN receipt_state TEXT NOT NULL DEFAULT 'pending'");
    database.exec("UPDATE hub_mcp_operations SET receipt_state = status");
  }
}

function workspaceFromRow(row) {
  if (!row) return null;
  let settings = {};
  try { settings = JSON.parse(String(row.settings_json ?? "{}")); } catch { settings = {}; }
  return {
    id: String(row.id),
    name: String(row.name),
    comment: String(row.comment ?? ""),
    kind: String(row.kind),
    systemKey: row.system_key ? String(row.system_key) : null,
    createdAtMs: Number(row.created_at_ms) || 0,
    updatedAtMs: Number(row.updated_at_ms) || 0,
    archivedAtMs: row.archived_at_ms == null ? null : Number(row.archived_at_ms),
    purgeAfterMs: row.purge_after_ms == null ? null : Number(row.purge_after_ms),
    settings,
  };
}

function streamFromRow(row, streamCount = 0) {
  if (!row) return null;
  const name = row.name ? String(row.name) : null;
  const ordinal = Number(row.ordinal) || 1;
  let settings = {};
  try { settings = JSON.parse(String(row.settings_json ?? "{}")); } catch { settings = {}; }
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    ordinal,
    name,
    displayName: streamDisplayName({ name, ordinal, streamCount }),
    createdAtMs: Number(row.created_at_ms) || 0,
    updatedAtMs: Number(row.updated_at_ms) || 0,
    archivedAtMs: row.archived_at_ms == null ? null : Number(row.archived_at_ms),
    settings,
  };
}

function threadFromRow(row) {
  if (!row) return null;
  return {
    provider: String(row.provider),
    threadId: String(row.provider_thread_id),
    streamId: String(row.stream_id),
    position: Number(row.position) || 1,
    projectRoot: String(row.project_root ?? ""),
    source: String(row.source),
    linkedAtMs: Number(row.linked_at_ms) || 0,
    updatedAtMs: Number(row.updated_at_ms) || 0,
    detachedAtMs: row.detached_at_ms == null ? null : Number(row.detached_at_ms),
  };
}

function sourceName(value) {
  const source = String(value ?? "discovered").trim().toLowerCase();
  if (!SOURCES.has(source)) throw new Error(`invalid thread binding source: ${value}`);
  return source;
}

function safeIdentifier(value, name) {
  const id = String(value ?? "").trim();
  if (!id || id.length > 200 || id.includes("\0")) throw new Error(`invalid ${name}`);
  return id;
}

function workspaceConflict(message) {
  const error = new Error(message);
  error.code = "WORKSPACE_LIFECYCLE_CONFLICT";
  error.statusCode = 409;
  return error;
}

function deleteWorkspaceLayoutRows(database, workspaceId) {
  for (const [table, column] of [
    ["hub_board_workspace_order", "workspace_id"],
    ["hub_board_column_order", "column_id"],
  ]) {
    const exists = database.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
    ).get(table);
    if (exists) database.prepare(`DELETE FROM ${table} WHERE ${column} = ?`).run(workspaceId);
  }
}

function workspaceFolderName(value) {
  return String(value ?? "").replace(/\s+/gu, " ").trim().slice(0, 80);
}

function developerRuleScope(value) {
  const scope = String(value ?? "").trim().toLowerCase();
  if (!DEVELOPER_RULE_SCOPES.has(scope)) throw new Error(`invalid developer rule scope: ${value}`);
  return scope;
}

function developerRuleContent(value, maximumBytes = DEVELOPER_RULES_MAX_BYTES) {
  const content = String(value ?? "");
  if (Buffer.byteLength(content, "utf8") > maximumBytes) {
    throw new Error(`developer rules exceed ${DEVELOPER_RULES_MAX_BYTES} UTF-8 bytes`);
  }
  return content;
}

function developerRuleFromRow(row) {
  if (!row) return null;
  return {
    scopeType: String(row.scope_type),
    scopeId: String(row.scope_id),
    revision: Number(row.revision) || 1,
    content: String(row.content ?? ""),
    createdAtMs: Number(row.created_at_ms) || 0,
  };
}

function mcpOperationFromRow(row) {
  if (!row) return null;
  let result = null;
  try { result = row.result_json == null ? null : JSON.parse(String(row.result_json)); } catch { result = null; }
  return {
    requestId: String(row.request_id),
    workspaceId: String(row.workspace_id),
    streamId: String(row.stream_id),
    provider: String(row.provider),
    threadId: String(row.provider_thread_id),
    toolName: String(row.tool_name),
    argumentsHash: String(row.arguments_hash),
    interstreamContentHash: String(row.interstream_content_hash ?? ""),
    status: String(row.receipt_state ?? row.status),
    result,
    error: String(row.error_text ?? ""),
    createdAtMs: Number(row.created_at_ms) || 0,
    completedAtMs: row.completed_at_ms == null ? null : Number(row.completed_at_ms),
  };
}

function compactMcpOperationResult(result) {
  const serialized = JSON.stringify(result ?? null);
  if (Buffer.byteLength(serialized, "utf8") <= 64 * 1024) return serialized;
  const taskId = String(result?.task?.id ?? result?.taskId ?? "").trim() || null;
  return JSON.stringify({
    receiptCompacted: true,
    outcome: "succeeded",
    taskId,
    resultType: Array.isArray(result) ? "array" : typeof result,
  });
}

function workspaceEventFromRow(row) {
  if (!row) return null;
  let payload = {};
  try { payload = JSON.parse(String(row.payload_json ?? "{}")); } catch { payload = {}; }
  return {
    sequence: Number(row.sequence) || 0,
    workspaceId: String(row.workspace_id),
    streamId: row.stream_id ? String(row.stream_id) : null,
    type: String(row.event_type),
    subjectId: row.subject_id ? String(row.subject_id) : null,
    payload,
    createdAtMs: Number(row.created_at_ms) || 0,
  };
}

export class WorkspaceCatalogStore {
  #databaseFile;
  #database = null;
  #readOnly;
  #now;
  #idFactory;
  #mutations = new AsyncSqliteMutationQueue();

  constructor({
    databaseFile,
    readOnly = false,
    now = () => Date.now(),
    idFactory = randomUUID,
  } = {}) {
    if (!databaseFile) throw new Error("WorkspaceCatalogStore databaseFile is required");
    this.#databaseFile = path.resolve(databaseFile);
    this.#readOnly = readOnly === true;
    this.#now = now;
    this.#idFactory = idFactory;
  }

  async load() {
    await this.#open();
    if (this.#readOnly) return this;
    this.#migratePermanentWorkspaceArchive();
    this.#migrateReleaseWorkflowSettings();
    this.#migrateWorkspaceDeveloperRules();
    this.#migrateArchitectStreamSettings();
    this.ensureExperiments();
    return this;
  }

  get revision() {
    if (!this.#database) return 0;
    return Number(this.#database.prepare("SELECT total_changes() AS value").get()?.value) || 0;
  }

  async #open() {
    if (this.#database) return this.#database;
    if (!this.#readOnly) await mkdir(path.dirname(this.#databaseFile), { recursive: true });
    let database;
    try {
      database = new DatabaseSync(
        this.#databaseFile,
        this.#readOnly ? { readOnly: true } : {},
      );
      if (this.#readOnly) {
        database.exec("PRAGMA query_only = ON; PRAGMA busy_timeout = 0; PRAGMA foreign_keys = ON;");
      } else {
        configure(database);
      }
    } catch (error) {
      database?.close();
      throw error;
    }
    this.#database = database;
    return database;
  }

  #transaction(run) {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const result = run();
      this.#database.exec("COMMIT");
      return result;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  #nowMs() {
    const value = Number(this.#now());
    return Number.isSafeInteger(value) && value > 0 ? value : Date.now();
  }

  #migrateReleaseWorkflowSettings() {
    const rows = this.#database.prepare("SELECT id, settings_json FROM hub_workspaces").all();
    const pending = rows.filter((row) => {
      try {
        const settings = JSON.parse(String(row.settings_json ?? "{}"));
        return typeof settings?.[RELEASE_WORKFLOW_SETTING] !== "boolean";
      } catch {
        return true;
      }
    });
    if (!pending.length) return;
    this.#transaction(() => {
      const update = this.#database.prepare(`
        UPDATE hub_workspaces SET settings_json = ? WHERE id = ?
      `);
      for (const row of pending) {
        let settings = {};
        try { settings = JSON.parse(String(row.settings_json ?? "{}")); } catch { settings = {}; }
        const currentRules = this.#developerRules("workspace", row.id);
        const migration = legacyReleaseWorkflowRules(currentRules?.content ?? "");
        const editableContent = editableWorkspaceDeveloperRules(currentRules?.content ?? "");
        update.run(
          JSON.stringify(workspaceSettingsWithReleaseWorkflow(settings, migration.enabled)),
          row.id,
        );
        if (editableContent !== (currentRules?.content ?? "")) {
          this.#updateWorkspaceDeveloperRules(row.id, editableContent);
        }
      }
    });
  }

  #migrateWorkspaceDeveloperRules() {
    const key = "workspace_system_rules_removed_v2";
    if (this.#database.prepare("SELECT 1 FROM hub_workspace_catalog_meta WHERE key = ?").get(key)) return;
    this.#transaction(() => {
      for (const row of this.#database.prepare("SELECT id FROM hub_workspaces").all()) {
        const current = this.#developerRules("workspace", row.id);
        const content = editableWorkspaceDeveloperRules(current?.content ?? "");
        if (content !== (current?.content ?? "")) this.#updateWorkspaceDeveloperRules(row.id, content);
      }
      this.#database.prepare(
        "INSERT INTO hub_workspace_catalog_meta (key, value) VALUES (?, ?)",
      ).run(key, "completed");
    });
  }

  #migratePermanentWorkspaceArchive() {
    this.#transaction(() => {
      this.#database.prepare(`
        UPDATE hub_workspaces SET purge_after_ms = NULL WHERE purge_after_ms IS NOT NULL
      `).run();
      this.#database.exec("DROP INDEX IF EXISTS hub_workspaces_archive_expiry_idx");
      this.#database.prepare(`
        INSERT INTO hub_workspace_catalog_meta (key, value)
        VALUES ('workspace_archive_permanent_v1', 'completed')
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `).run();
    });
  }

  ensureExperiments() {
    const existing = this.#database.prepare(
      "SELECT * FROM hub_workspaces WHERE system_key = ?",
    ).get(EXPERIMENTS_SYSTEM_KEY);
    if (existing) {
      if (existing.name !== OTHER_WORKSPACE_NAME) {
        this.#database.prepare("UPDATE hub_workspaces SET name = ? WHERE id = ?")
          .run(OTHER_WORKSPACE_NAME, existing.id);
      }
      return this.workspace(existing.id);
    }
    return this.createWorkspace({
      name: OTHER_WORKSPACE_NAME,
      kind: "system",
      systemKey: EXPERIMENTS_SYSTEM_KEY,
    });
  }

  createWorkspace({
    id = this.#idFactory(), name, comment = "", kind = "user", systemKey = null, settings = {},
  } = {}) {
    const workspaceId = safeIdentifier(id, "workspace id");
    const workspaceName = normalizedWorkspaceName(name);
    const normalizedKind = String(kind).trim().toLowerCase();
    if (!['user', 'system'].includes(normalizedKind)) throw new Error("invalid workspace kind");
    const key = systemKey == null ? null : safeIdentifier(systemKey, "workspace system key");
    if (normalizedKind === "system" && !key) throw new Error("system workspace requires systemKey");
    if (normalizedKind === "user" && key) throw new Error("user workspace cannot have systemKey");
    const nowMs = this.#nowMs();
    this.#database.prepare(`
      INSERT INTO hub_workspaces
        (id, name, comment, kind, system_key, created_at_ms, updated_at_ms, settings_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      workspaceId,
      workspaceName,
      String(comment ?? "").trim().slice(0, 1000),
      normalizedKind,
      key,
      nowMs,
      nowMs,
      JSON.stringify(workspaceSettingsWithReleaseWorkflow(
        workspaceSettingsWithTaskPrefix(settings),
        releaseWorkflowEnabled(settings),
      )),
    );
    this.#updateWorkspaceDeveloperRules(workspaceId, "");
    return this.workspace(workspaceId);
  }

  renameWorkspace(workspaceId, name) {
    const id = safeIdentifier(workspaceId, "workspace id");
    const current = this.workspace(id);
    if (!current) throw new Error(`workspace not found: ${id}`);
    if (current.kind === "system") throw new Error("system workspace cannot be renamed");
    const nextName = normalizedWorkspaceName(name);
    this.#database.prepare(`
      UPDATE hub_workspaces SET name = ?, updated_at_ms = ? WHERE id = ?
    `).run(nextName, this.#nowMs(), id);
    return this.workspace(id);
  }

  updateWorkspaceComment(workspaceId, comment) {
    const id = safeIdentifier(workspaceId, "workspace id");
    if (!this.workspace(id)) throw new Error(`workspace not found: ${id}`);
    const value = String(comment ?? "").trim().slice(0, 1000);
    this.#database.prepare(`
      UPDATE hub_workspaces SET comment = ?, updated_at_ms = ? WHERE id = ?
    `).run(value, this.#nowMs(), id);
    return this.workspace(id);
  }

  updateWorkspaceSettings(workspaceId, settings = {}) {
    const id = safeIdentifier(workspaceId, "workspace id");
    const current = this.workspace(id);
    if (!current) throw new Error(`workspace not found: ${id}`);
    const explicitReleaseWorkflow = Object.prototype.hasOwnProperty.call(
      settings ?? {},
      RELEASE_WORKFLOW_SETTING,
    );
    const enabled = explicitReleaseWorkflow
      ? releaseWorkflowEnabled(settings)
      : releaseWorkflowEnabled(current.settings);
    const nextSettings = workspaceSettingsWithReleaseWorkflow(workspaceSettingsWithTaskPrefix(settings), enabled);
    this.#database.prepare(`
      UPDATE hub_workspaces SET settings_json = ?, updated_at_ms = ? WHERE id = ?
    `).run(JSON.stringify(nextSettings), this.#nowMs(), id);
    return this.workspace(id);
  }

  moveWorkspaceToFolder(workspaceId, folderName) {
    const id = safeIdentifier(workspaceId, "workspace id");
    return this.#transaction(() => {
      const current = this.workspace(id);
      if (!current) throw new Error(`workspace not found: ${id}`);
      const settings = current.settings && typeof current.settings === "object" && !Array.isArray(current.settings)
        ? { ...current.settings }
        : {};
      const normalizedFolderName = workspaceFolderName(folderName);
      if (normalizedFolderName) settings.catalogFolder = normalizedFolderName;
      else delete settings.catalogFolder;
      this.#database.prepare(`
        UPDATE hub_workspaces SET settings_json = ?, updated_at_ms = ? WHERE id = ?
      `).run(JSON.stringify(settings), this.#nowMs(), id);
      return this.workspace(id);
    });
  }

  renameWorkspaceFolder(fromFolderName, toFolderName) {
    const fromName = workspaceFolderName(fromFolderName);
    const toName = workspaceFolderName(toFolderName);
    if (!fromName || !toName) throw new Error("workspace folder names are required");
    if (fromName === toName) {
      return { fromFolderName: fromName, toFolderName: toName, workspaceCount: 0 };
    }
    const rows = this.#database.prepare("SELECT id, settings_json FROM hub_workspaces").all();
    const matching = rows.flatMap((row) => {
      let settings = {};
      try { settings = JSON.parse(String(row.settings_json ?? "{}")); } catch { settings = {}; }
      if (!settings || typeof settings !== "object" || Array.isArray(settings)) settings = {};
      if (workspaceFolderName(settings.catalogFolder) !== fromName) return [];
      return [{ id: String(row.id), settings: { ...settings, catalogFolder: toName } }];
    });
    if (matching.length) {
      const updatedAtMs = this.#nowMs();
      const update = this.#database.prepare(`
        UPDATE hub_workspaces SET settings_json = ?, updated_at_ms = ? WHERE id = ?
      `);
      this.#transaction(() => {
        for (const workspace of matching) {
          update.run(JSON.stringify(workspace.settings), updatedAtMs, workspace.id);
        }
      });
    }
    return {
      fromFolderName: fromName,
      toFolderName: toName,
      workspaceCount: matching.length,
    };
  }

  archiveWorkspace(workspaceId) {
    const id = safeIdentifier(workspaceId, "workspace id");
    const current = this.workspace(id);
    if (!current) throw new Error(`workspace not found: ${id}`);
    if (current.kind === "system") throw new Error("system workspace cannot be archived");
    if (current.archivedAtMs != null) return current;
    const archivedAtMs = this.#nowMs();
    this.#database.prepare(`
      UPDATE hub_workspaces
      SET archived_at_ms = ?, purge_after_ms = NULL, updated_at_ms = ?
      WHERE id = ?
    `).run(
      archivedAtMs,
      archivedAtMs,
      id,
    );
    return this.workspace(id);
  }

  restoreWorkspace(workspaceId) {
    const id = safeIdentifier(workspaceId, "workspace id");
    const current = this.workspace(id);
    if (!current) throw new Error(`workspace not found: ${id}`);
    if (current.archivedAtMs == null) return current;
    this.#database.prepare(`
      UPDATE hub_workspaces
      SET archived_at_ms = NULL, purge_after_ms = NULL, updated_at_ms = ?
      WHERE id = ?
    `).run(this.#nowMs(), id);
    return this.workspace(id);
  }

  archivedWorkspaces() {
    return this.#database.prepare(`
      SELECT w.id, w.name, w.archived_at_ms, w.purge_after_ms,
        COUNT(DISTINCT s.id) AS stream_count,
        COUNT(t.provider_thread_id) AS thread_count
      FROM hub_workspaces w
      LEFT JOIN hub_streams s ON s.workspace_id = w.id
      LEFT JOIN hub_threads t ON t.stream_id = s.id
      WHERE w.archived_at_ms IS NOT NULL
      GROUP BY w.id
      ORDER BY w.archived_at_ms DESC, w.name, w.id
    `).all().map((row) => ({
      id: String(row.id),
      name: String(row.name),
      archivedAtMs: Number(row.archived_at_ms),
      purgeAfterMs: row.purge_after_ms == null ? null : Number(row.purge_after_ms),
      streamCount: Number(row.stream_count) || 0,
      threadCount: Number(row.thread_count) || 0,
    }));
  }

  deleteArchivedWorkspace(workspaceId, confirmationName) {
    const id = safeIdentifier(workspaceId, "workspace id");
    const confirmedName = String(confirmationName ?? "");
    return this.#transaction(() => {
      const fence = this.#database.prepare(
        "SELECT confirmed_name FROM hub_workspace_deletion_fences WHERE workspace_id = ?",
      ).get(id);
      if (fence) {
        if (confirmedName !== String(fence.confirmed_name)) {
          throw workspaceConflict("workspace confirmation name does not match");
        }
        deleteWorkspaceLayoutRows(this.#database, id);
        return { id, name: String(fence.confirmed_name), deleted: true };
      }
      const current = this.#database.prepare("SELECT * FROM hub_workspaces WHERE id = ?").get(id);
      if (!current) throw new Error(`workspace not found: ${id}`);
      if (current.kind === "system") throw workspaceConflict("system workspace cannot be deleted");
      if (current.archived_at_ms == null) throw workspaceConflict("workspace must be archived before permanent deletion");
      if (confirmedName !== String(current.name)) {
        throw workspaceConflict("workspace confirmation name does not match");
      }
      const taskTable = this.#database.prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'hub_board_tasks'",
      ).get();
      if (taskTable && this.#database.prepare(
        "SELECT 1 FROM hub_board_tasks WHERE workspace_id = ? LIMIT 1",
      ).get(id)) throw workspaceConflict("Сначала переместите или удалите связанные Dashboard Task");
      const deletedAtMs = this.#nowMs();
      this.#database.prepare(`
        INSERT INTO hub_workspace_deletion_fences (workspace_id, confirmed_name, deleted_at_ms)
        VALUES (?, ?, ?)
      `).run(id, current.name, deletedAtMs);
      const deleted = this.#database.prepare(`
        DELETE FROM hub_workspaces
        WHERE id = ? AND name = ? AND kind = 'user' AND system_key IS NULL
          AND archived_at_ms IS NOT NULL AND updated_at_ms = ?
      `).run(id, current.name, current.updated_at_ms);
      if (Number(deleted.changes) !== 1) throw workspaceConflict("workspace permanent deletion failed");
      deleteWorkspaceLayoutRows(this.#database, id);
      return { id, name: String(current.name), deleted: true };
    });
  }

  releaseWorkflowEnabledForThread(value) {
    const resolved = this.resolveThread(value);
    return resolved ? releaseWorkflowEnabled(this.workspace(resolved.workspaceId)?.settings) : false;
  }

  workspaceDeveloperRules(workspaceId) {
    const id = safeIdentifier(workspaceId, "workspace id");
    if (!this.workspace(id)) throw new Error(`workspace not found: ${id}`);
    return this.#developerRules("workspace", id);
  }

  updateWorkspaceDeveloperRules(workspaceId, content) {
    const id = safeIdentifier(workspaceId, "workspace id");
    if (!this.workspace(id)) throw new Error(`workspace not found: ${id}`);
    return this.#updateWorkspaceDeveloperRules(id, content);
  }

  #migrateArchitectStreamSettings() {
    const key = "architect_stream_settings_migrated_v1";
    if (this.#database.prepare("SELECT 1 FROM hub_workspace_catalog_meta WHERE key = ?").get(key)) return;
    this.#transaction(() => {
      const update = this.#database.prepare("UPDATE hub_streams SET settings_json = ? WHERE id = ?");
      for (const row of this.#database.prepare("SELECT id, name, settings_json FROM hub_streams").all()) {
        let settings = {};
        try { settings = JSON.parse(String(row.settings_json ?? "{}")); } catch { settings = {}; }
        const legacyArchitect = settings?.releaseRole === "architect" || String(row.name ?? "").trim() === "Architect";
        const next = { ...(settings && typeof settings === "object" ? settings : {}) };
        delete next.releaseRole;
        if (next.architect === true || legacyArchitect) next.architect = true;
        update.run(JSON.stringify(next), row.id);
      }
      this.#database.prepare(
        "INSERT INTO hub_workspace_catalog_meta (key, value) VALUES (?, 'completed')",
      ).run(key);
    });
  }

  recordWorkspaceEvent({
    workspaceId, streamId = null, type, subjectId = null, payload = {}, dedupeKey = null,
  } = {}) {
    const workspace = safeIdentifier(workspaceId, "workspace id");
    if (!this.workspace(workspace)) throw new Error(`workspace not found: ${workspace}`);
    const stream = streamId == null ? null : safeIdentifier(streamId, "stream id");
    if (stream) {
      const stored = this.stream(stream);
      if (!stored || stored.workspaceId !== workspace) throw new Error("event Stream is outside the Workspace");
    }
    const eventType = safeIdentifier(type, "event type");
    const subject = subjectId == null ? null : safeIdentifier(subjectId, "event subject id");
    const key = dedupeKey == null ? null : safeIdentifier(dedupeKey, "event dedupe key");
    const serialized = JSON.stringify(payload ?? {});
    if (Buffer.byteLength(serialized, "utf8") > 32 * 1024) throw new Error("event payload is too large");
    const nowMs = this.#nowMs();
    const result = this.#database.prepare(`
      INSERT OR IGNORE INTO hub_workspace_events (
        workspace_id, stream_id, event_type, subject_id, payload_json, dedupe_key, created_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(workspace, stream, eventType, subject, serialized, key, nowMs);
    const row = Number(result.changes)
      ? this.#database.prepare("SELECT * FROM hub_workspace_events WHERE sequence = ?").get(result.lastInsertRowid)
      : this.#database.prepare("SELECT * FROM hub_workspace_events WHERE dedupe_key = ?").get(key);
    return workspaceEventFromRow(row);
  }

  workspaceEvents(workspaceId, { afterSequence = 0, limit = 50 } = {}) {
    const workspace = safeIdentifier(workspaceId, "workspace id");
    if (!this.workspace(workspace)) throw new Error(`workspace not found: ${workspace}`);
    const after = Math.max(0, Number(afterSequence) || 0);
    const boundedLimit = Math.max(1, Math.min(100, Number(limit) || 50));
    return this.#database.prepare(`
      SELECT * FROM hub_workspace_events
      WHERE workspace_id = ? AND sequence > ?
      ORDER BY sequence ASC LIMIT ?
    `).all(workspace, after, boundedLimit).map(workspaceEventFromRow);
  }

  beginMcpOperation({
    requestId, workspaceId, streamId, provider, threadId, toolName, argumentsHash,
  } = {}) {
    const id = safeIdentifier(requestId, "MCP request id");
    const workspace = safeIdentifier(workspaceId, "workspace id");
    const stream = safeIdentifier(streamId, "stream id");
    const normalizedProvider = safeIdentifier(provider, "provider");
    const normalizedThreadId = safeIdentifier(threadId, "thread id");
    const tool = safeIdentifier(toolName, "MCP tool name");
    const hash = safeIdentifier(argumentsHash, "MCP arguments hash");
    this.#database.exec("BEGIN IMMEDIATE");
    try {
    const inserted = this.#database.prepare(`
      INSERT OR IGNORE INTO hub_mcp_operations (
        request_id, workspace_id, stream_id, provider, provider_thread_id,
        tool_name, arguments_hash, status, receipt_state, created_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 'pending', ?)
    `).run(
      id, workspace, stream, normalizedProvider, normalizedThreadId, tool, hash, this.#nowMs(),
    );
    const existing = mcpOperationFromRow(this.#database.prepare(
      "SELECT * FROM hub_mcp_operations WHERE request_id = ?",
    ).get(id));
    if (existing) {
      const matches = existing.workspaceId === workspace
        && existing.streamId === stream
        && existing.provider === normalizedProvider
        && existing.threadId === normalizedThreadId
        && existing.toolName === tool
        && existing.argumentsHash === hash;
      if (!matches) throw new Error("MCP request_id was already used for another operation");
      const replayed = !Number(inserted.changes);
      this.#database.exec("COMMIT");
      return { ...existing, replayed };
    }
    throw new Error("MCP operation receipt insert failed");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  createWorkspaceWithStream({ name, comment = "", streamName = null, settings = {} } = {}) {
    return this.#transaction(() => {
      const workspace = this.createWorkspace({ name, comment, settings });
      const stream = this.createStream({ workspaceId: workspace.id, name: streamName });
      return { workspace, stream };
    });
  }

  runMutation(operation, options = {}) {
    return this.#mutations.run(operation, options);
  }

  mutationDiagnostics() {
    return this.#mutations.diagnostics();
  }

  bindMcpOperationInterstreamContentHash(requestId, contentHash) {
    const id = safeIdentifier(requestId, "MCP request id");
    const hash = safeIdentifier(contentHash, "interstream content hash");
    if (!/^[a-f0-9]{64}$/u.test(hash)) throw new Error("invalid interstream content hash");
    const operation = this.mcpOperation(id);
    if (!operation || !INTERSTREAM_MESSAGE_TOOLS.has(operation.toolName)) {
      throw new Error("MCP operation cannot carry interstream content");
    }
    if (operation.status !== "pending") {
      if (operation.interstreamContentHash === hash) return operation;
      throw new Error("MCP operation is not pending");
    }
    if (operation.interstreamContentHash && operation.interstreamContentHash !== hash) {
      throw new Error("MCP interstream content does not match the original admission");
    }
    if (!operation.interstreamContentHash) {
      this.#database.prepare(`
        UPDATE hub_mcp_operations SET interstream_content_hash = ?
        WHERE request_id = ? AND receipt_state = 'pending' AND interstream_content_hash = ''
      `).run(hash, id);
    }
    return this.mcpOperation(id);
  }

  completeMcpOperation(requestId, result) {
    const id = safeIdentifier(requestId, "MCP request id");
    const operation = this.mcpOperation(id);
    if (
      operation
      && INTERSTREAM_MESSAGE_TOOLS.has(operation.toolName)
      && !operation.interstreamContentHash
    ) throw new Error("MCP interstream operation has no admitted content hash");
    const resultJson = compactMcpOperationResult(result);
    const updated = this.#database.prepare(`
      UPDATE hub_mcp_operations
      SET status = 'succeeded', receipt_state = 'succeeded', result_json = ?, error_text = '', completed_at_ms = ?
      WHERE request_id = ? AND receipt_state IN ('pending', 'reconciling')
    `).run(resultJson, this.#nowMs(), id);
    if (!Number(updated.changes)) throw new Error("MCP operation is not pending");
    return mcpOperationFromRow(this.#database.prepare(
      "SELECT * FROM hub_mcp_operations WHERE request_id = ?",
    ).get(id));
  }

  failMcpOperation(requestId, error) {
    const id = safeIdentifier(requestId, "MCP request id");
    this.#database.prepare(`
      UPDATE hub_mcp_operations
      SET status = 'failed', receipt_state = 'failed', result_json = NULL, error_text = ?, completed_at_ms = ?
      WHERE request_id = ? AND receipt_state IN ('pending', 'reconciling')
    `).run(String(error?.message ?? error ?? "MCP operation failed").slice(0, 4000), this.#nowMs(), id);
    return mcpOperationFromRow(this.#database.prepare(
      "SELECT * FROM hub_mcp_operations WHERE request_id = ?",
    ).get(id));
  }

  beginMcpOperationReconciliation(requestId) {
    const id = safeIdentifier(requestId, "MCP request id");
    const updated = this.#database.prepare(`
      UPDATE hub_mcp_operations SET receipt_state = 'reconciling'
      WHERE request_id = ? AND receipt_state IN ('pending', 'reconciling')
    `).run(id);
    if (!Number(updated.changes)) throw new Error("MCP operation is not pending reconciliation");
    return mcpOperationFromRow(this.#database.prepare(
      "SELECT * FROM hub_mcp_operations WHERE request_id = ?",
    ).get(id));
  }

  markMcpOperationUnknown(requestId, error) {
    const id = safeIdentifier(requestId, "MCP request id");
    this.#database.prepare(`
      UPDATE hub_mcp_operations
      SET receipt_state = 'unknown', error_text = ?, completed_at_ms = ?
      WHERE request_id = ? AND receipt_state IN ('pending', 'reconciling')
    `).run(String(error?.message ?? error ?? "authoritative reconciliation is unavailable").slice(0, 4000), this.#nowMs(), id);
    return mcpOperationFromRow(this.#database.prepare(
      "SELECT * FROM hub_mcp_operations WHERE request_id = ?",
    ).get(id));
  }

  mcpOperation(requestId) {
    const id = safeIdentifier(requestId, "MCP request id");
    return mcpOperationFromRow(this.#database.prepare(
      "SELECT * FROM hub_mcp_operations WHERE request_id = ?",
    ).get(id));
  }

  pendingMcpOperations() {
    return this.#database.prepare(`
      SELECT * FROM hub_mcp_operations
      WHERE receipt_state IN ('pending', 'reconciling')
      ORDER BY created_at_ms ASC, request_id ASC
    `).all().map(mcpOperationFromRow);
  }

  mcpOperations(workspaceId, { limit = 50 } = {}) {
    const id = safeIdentifier(workspaceId, "workspace id");
    if (!this.workspace(id)) throw new Error(`workspace not found: ${id}`);
    const boundedLimit = Math.max(1, Math.min(100, Number(limit) || 50));
    return this.#database.prepare(`
      SELECT * FROM hub_mcp_operations
      WHERE workspace_id = ? ORDER BY created_at_ms DESC LIMIT ?
    `).all(id, boundedLimit).map(mcpOperationFromRow);
  }

  interstreamOriginForClientMessage(clientUserMessageId) {
    const clientId = String(clientUserMessageId ?? "").trim();
    if (!clientId.startsWith("mcp:")) return null;
    const requestId = clientId.slice(4).trim();
    if (!requestId || requestId.length > 200 || requestId.includes("\0")) return null;
    const operation = mcpOperationFromRow(this.#database.prepare(
      "SELECT * FROM hub_mcp_operations WHERE request_id = ?",
    ).get(requestId));
    if (
      !operation
      || operation.requestId !== requestId
      || operation.status !== "succeeded"
      || !INTERSTREAM_MESSAGE_TOOLS.has(operation.toolName)
    ) return null;
    const workspace = this.workspace(operation.workspaceId);
    const stream = this.stream(operation.streamId);
    if (!workspace || !stream || stream.workspaceId !== workspace.id) return null;
    const origin = normalizeInterstreamOrigin({
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      streamId: stream.id,
      streamName: stream.displayName ?? stream.name,
      provider: operation.provider,
      sourceThreadId: operation.threadId,
      requestId,
    });
    if (!origin || !operation.interstreamContentHash) return null;
    return {
      ...origin,
      origin,
      toolName: operation.toolName,
      argumentsHash: operation.argumentsHash,
      contentHash: operation.interstreamContentHash,
    };
  }

  mergeWorkspaces(sourceWorkspaceId, targetWorkspaceId) {
    const sourceId = safeIdentifier(sourceWorkspaceId, "source workspace id");
    const targetId = safeIdentifier(targetWorkspaceId, "target workspace id");
    if (sourceId === targetId) return this.workspace(targetId);
    const source = this.workspace(sourceId);
    const target = this.workspace(targetId);
    if (!source) throw new Error(`workspace not found: ${sourceId}`);
    if (!target) throw new Error(`workspace not found: ${targetId}`);
    if (source.kind === "system") throw new Error("system workspace cannot be merged into another workspace");
    return this.#transaction(() => {
      const streams = this.#database.prepare(`
        SELECT id FROM hub_streams WHERE workspace_id = ? ORDER BY ordinal
      `).all(sourceId);
      for (const stream of streams) this.moveStream(stream.id, targetId);
      this.#database.prepare("DELETE FROM hub_workspaces WHERE id = ?").run(sourceId);
      return this.workspace(targetId);
    });
  }

  createWorkspaceFromStream({ streamId, name } = {}) {
    return this.#transaction(() => {
      const workspace = this.createWorkspace({ name });
      const stream = this.moveStream(streamId, workspace.id);
      return { workspace, stream };
    });
  }

  workspace(workspaceId) {
    const id = safeIdentifier(workspaceId, "workspace id");
    return workspaceFromRow(this.#database.prepare(
      "SELECT * FROM hub_workspaces WHERE id = ?",
    ).get(id));
  }

  workspaceBySystemKey(systemKey) {
    const key = safeIdentifier(systemKey, "workspace system key");
    return workspaceFromRow(this.#database.prepare(
      "SELECT * FROM hub_workspaces WHERE system_key = ?",
    ).get(key));
  }

  createStream({
    id = this.#idFactory(), workspaceId, name = null, ordinal = null, settings = {},
  } = {}) {
    const streamId = safeIdentifier(id, "stream id");
    const targetWorkspaceId = safeIdentifier(workspaceId, "workspace id");
    const targetWorkspace = this.workspace(targetWorkspaceId);
    if (!targetWorkspace) throw new Error(`workspace not found: ${targetWorkspaceId}`);
    if (targetWorkspace.archivedAtMs != null) throw new Error("archived workspace cannot accept Streams");
    const nextOrdinal = ordinal == null
      ? Number(this.#database.prepare(`
          SELECT COALESCE(MAX(ordinal), 0) + 1 AS ordinal
          FROM hub_streams WHERE workspace_id = ?
        `).get(targetWorkspaceId)?.ordinal ?? 1)
      : Number(ordinal);
    if (!Number.isSafeInteger(nextOrdinal) || nextOrdinal <= 0) throw new Error("invalid stream ordinal");
    const nowMs = this.#nowMs();
    this.#database.prepare(`
      INSERT INTO hub_streams
        (id, workspace_id, ordinal, name, settings_json, created_at_ms, updated_at_ms, archived_at_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
    `).run(
      streamId,
      targetWorkspaceId,
      nextOrdinal,
      normalizedStreamName(name),
      JSON.stringify(settings ?? {}),
      nowMs,
      nowMs,
    );
    return this.stream(streamId);
  }

  stream(streamId) {
    const id = safeIdentifier(streamId, "stream id");
    const row = this.#database.prepare("SELECT * FROM hub_streams WHERE id = ?").get(id);
    if (!row) return null;
    const count = Number(this.#database.prepare(`
      SELECT COUNT(*) AS count FROM hub_streams
      WHERE workspace_id = ? AND archived_at_ms IS NULL
    `).get(row.workspace_id)?.count ?? 0);
    return streamFromRow(row, count);
  }

  renameStream(streamId, name) {
    const id = safeIdentifier(streamId, "stream id");
    if (!this.stream(id)) throw new Error(`stream not found: ${id}`);
    this.#database.prepare(`
      UPDATE hub_streams SET name = ?, updated_at_ms = ? WHERE id = ?
    `).run(normalizedStreamName(name), this.#nowMs(), id);
    return this.stream(id);
  }

  archiveStream(streamId) {
    const id = safeIdentifier(streamId, "stream id");
    const stream = this.stream(id);
    if (!stream) throw new Error(`stream not found: ${id}`);
    if (stream.archivedAtMs != null) return stream;
    const nowMs = this.#nowMs();
    this.#database.prepare(`
      UPDATE hub_streams SET archived_at_ms = ?, updated_at_ms = ? WHERE id = ?
    `).run(nowMs, nowMs, id);
    return this.stream(id);
  }

  updateStreamSettings(streamId, settings = {}) {
    const id = safeIdentifier(streamId, "stream id");
    if (!this.stream(id)) throw new Error(`stream not found: ${id}`);
    this.#database.prepare(`
      UPDATE hub_streams SET settings_json = ?, updated_at_ms = ? WHERE id = ?
    `).run(JSON.stringify(settings ?? {}), this.#nowMs(), id);
    return this.stream(id);
  }

  streamDeveloperRules(streamId) {
    const id = safeIdentifier(streamId, "stream id");
    if (!this.stream(id)) throw new Error(`stream not found: ${id}`);
    return this.#developerRules("stream", id);
  }

  updateStreamDeveloperRules(streamId, content) {
    const id = safeIdentifier(streamId, "stream id");
    if (!this.stream(id)) throw new Error(`stream not found: ${id}`);
    return this.#updateDeveloperRules("stream", id, content);
  }

  developerRulesForThread(value) {
    const resolved = this.resolveThread(value);
    if (!resolved) return { workspace: null, stream: null };
    return this.developerRulesForStream(resolved.streamId);
  }

  developerRulesForStream(streamId) {
    const id = safeIdentifier(streamId, "stream id");
    const stream = this.stream(id);
    if (!stream) return { workspace: null, stream: null };
    const rawStreamRules = this.#developerRules("stream", stream.id);
    const workspace = this.workspace(stream.workspaceId);
    const streamContent = releaseWorkflowEnabled(workspace?.settings)
      ? withArchitectReleasePrimaryWorkspaceRule(
        effectiveStreamDeveloperRules(rawStreamRules?.content ?? "", stream.settings),
        stream.settings,
      )
      : (rawStreamRules?.content ?? "");
    return {
      workspace: this.#effectiveWorkspaceDeveloperRules(stream.workspaceId),
      stream: streamContent ? {
        scopeType: "stream",
        scopeId: stream.id,
        revision: rawStreamRules?.revision ?? 0,
        content: streamContent,
        createdAtMs: rawStreamRules?.createdAtMs ?? 0,
      } : rawStreamRules,
    };
  }

  #effectiveWorkspaceDeveloperRules(workspaceId) {
    const stored = this.#developerRules("workspace", workspaceId);
    const settings = this.workspace(workspaceId)?.settings;
    const content = withReleasePrimaryWorkspaceRule(
      effectiveWorkspaceDeveloperRules(stored?.content ?? "", settings),
      settings,
    );
    if (!content) return stored;
    return {
      scopeType: "workspace",
      scopeId: workspaceId,
      revision: stored?.revision ?? 0,
      content,
      createdAtMs: stored?.createdAtMs ?? 0,
    };
  }

  #developerRules(scopeType, scopeId) {
    const scope = developerRuleScope(scopeType);
    const id = safeIdentifier(scopeId, `${scope} id`);
    return developerRuleFromRow(this.#database.prepare(`
      SELECT scope_type, scope_id, revision, content, created_at_ms
      FROM hub_developer_rule_revisions
      WHERE scope_type = ? AND scope_id = ?
      ORDER BY revision DESC
      LIMIT 1
    `).get(scope, id));
  }

  #latestDeveloperRules() {
    return new Map(this.#database.prepare(`
      WITH latest AS (
        SELECT scope_type, scope_id, MAX(revision) AS revision
        FROM hub_developer_rule_revisions
        GROUP BY scope_type, scope_id
      )
      SELECT rules.scope_type, rules.scope_id, rules.revision, rules.content, rules.created_at_ms
      FROM hub_developer_rule_revisions AS rules
      INNER JOIN latest
        ON latest.scope_type = rules.scope_type
        AND latest.scope_id = rules.scope_id
        AND latest.revision = rules.revision
    `).all().map((row) => [
      `${row.scope_type}\0${row.scope_id}`,
      developerRuleFromRow(row),
    ]));
  }

  #updateWorkspaceDeveloperRules(workspaceId, content) {
    const editableContent = developerRuleContent(editableWorkspaceDeveloperRules(content));
    return this.#updateDeveloperRules("workspace", workspaceId, editableContent);
  }

  #updateDeveloperRules(scopeType, scopeId, content, maximumBytes = DEVELOPER_RULES_MAX_BYTES) {
    const scope = developerRuleScope(scopeType);
    const id = safeIdentifier(scopeId, `${scope} id`);
    const value = developerRuleContent(content, maximumBytes);
    const current = this.#developerRules(scope, id);
    if (current?.content === value) return current;
    const revision = (current?.revision ?? 0) + 1;
    this.#database.prepare(`
      INSERT INTO hub_developer_rule_revisions
        (scope_type, scope_id, revision, content, created_at_ms)
      VALUES (?, ?, ?, ?, ?)
    `).run(scope, id, revision, value, this.#nowMs());
    return this.#developerRules(scope, id);
  }

  moveStream(streamId, workspaceId) {
    const id = safeIdentifier(streamId, "stream id");
    const targetWorkspaceId = safeIdentifier(workspaceId, "workspace id");
    const stream = this.stream(id);
    if (!stream) throw new Error(`stream not found: ${id}`);
    if (this.workspace(stream.workspaceId)?.archivedAtMs != null) {
      throw new Error("archived workspace Streams cannot be moved");
    }
    const targetWorkspace = this.workspace(targetWorkspaceId);
    if (!targetWorkspace) throw new Error(`workspace not found: ${targetWorkspaceId}`);
    if (targetWorkspace.archivedAtMs != null) throw new Error("archived workspace cannot accept Streams");
    if (stream.workspaceId === targetWorkspaceId) return stream;
    const ordinal = Number(this.#database.prepare(`
      SELECT COALESCE(MAX(ordinal), 0) + 1 AS ordinal FROM hub_streams WHERE workspace_id = ?
    `).get(targetWorkspaceId)?.ordinal ?? 1);
    this.#database.prepare(`
      UPDATE hub_streams
      SET workspace_id = ?, ordinal = ?, updated_at_ms = ? WHERE id = ?
    `).run(targetWorkspaceId, ordinal, this.#nowMs(), id);
    this.#compactOrdinals(stream.workspaceId);
    this.#removeEmptyWorkspace(stream.workspaceId);
    return this.stream(id);
  }

  moveStreamOrdered({ streamId, workspaceId, beforeStreamId = undefined } = {}) {
    return this.#transaction(() => {
      const moved = this.moveStream(streamId, workspaceId);
      return beforeStreamId === undefined ? moved : this.reorderStream(streamId, beforeStreamId);
    });
  }

  moveStreamToStart(streamId) {
    const id = safeIdentifier(streamId, "stream id");
    const stream = this.stream(id);
    if (!stream) throw new Error(`stream not found: ${id}`);
    if (stream.ordinal === 1) return stream;
    this.#compactOrdinals(stream.workspaceId, id);
    return this.stream(id);
  }

  reorderStream(streamId, beforeStreamId = null) {
    const id = safeIdentifier(streamId, "stream id");
    const stream = this.stream(id);
    if (!stream) throw new Error(`stream not found: ${id}`);
    const beforeId = beforeStreamId == null
      ? null
      : safeIdentifier(beforeStreamId, "before stream id");
    if (beforeId === id) return stream;
    const rows = this.#database.prepare(`
      SELECT id FROM hub_streams WHERE workspace_id = ?
      ORDER BY ordinal, created_at_ms, id
    `).all(stream.workspaceId);
    const ordered = rows.filter((row) => row.id !== id);
    const insertAt = beforeId == null
      ? ordered.length
      : ordered.findIndex((row) => row.id === beforeId);
    if (insertAt < 0) throw new Error(`before stream not found in workspace: ${beforeId}`);
    ordered.splice(insertAt, 0, { id });
    if (ordered.every((row, index) => row.id === rows[index]?.id)) return stream;
    this.#writeStreamOrdinals(ordered);
    return this.stream(id);
  }

  #removeEmptyWorkspace(workspaceId) {
    const workspace = this.workspace(workspaceId);
    if (!workspace || workspace.kind === "system") return;
    const count = Number(this.#database.prepare(
      "SELECT COUNT(*) AS count FROM hub_streams WHERE workspace_id = ?",
    ).get(workspace.id)?.count ?? 0);
    if (count === 0) this.#database.prepare("DELETE FROM hub_workspaces WHERE id = ?").run(workspace.id);
  }

  #compactOrdinals(workspaceId, firstStreamId = null) {
    const rows = this.#database.prepare(`
      SELECT id FROM hub_streams WHERE workspace_id = ?
      ORDER BY ordinal, created_at_ms, id
    `).all(workspaceId);
    if (firstStreamId) {
      rows.sort((left, right) => Number(right.id === firstStreamId) - Number(left.id === firstStreamId));
    }
    this.#writeStreamOrdinals(rows);
  }

  #writeStreamOrdinals(rows) {
    const temporaryBase = 1_000_000;
    const update = this.#database.prepare(
      "UPDATE hub_streams SET ordinal = ?, updated_at_ms = ? WHERE id = ?",
    );
    const nowMs = this.#nowMs();
    rows.forEach((row, index) => update.run(temporaryBase + index, nowMs, row.id));
    rows.forEach((row, index) => update.run(index + 1, nowMs, row.id));
  }

  bindThread({ provider, threadId, streamId, projectRoot = "", source = "discovered", position = null } = {}) {
    const identity = normalizedThreadIdentity({ provider, threadId });
    const targetStreamId = safeIdentifier(streamId, "stream id");
    if (!this.stream(targetStreamId)) throw new Error(`stream not found: ${targetStreamId}`);
    const existing = this.thread(identity);
    if (existing) {
      if (existing.streamId !== targetStreamId) {
        throw new Error(`thread ${providerThreadKey(identity)} already belongs to another stream`);
      }
      return existing;
    }
    const nextPosition = position == null
      ? Number(this.#database.prepare(`
          SELECT COALESCE(MAX(position), 0) + 1 AS position
          FROM hub_threads WHERE stream_id = ?
        `).get(targetStreamId)?.position ?? 1)
      : Number(position);
    if (!Number.isSafeInteger(nextPosition) || nextPosition <= 0) throw new Error("invalid thread position");
    const nowMs = this.#nowMs();
    this.#database.prepare(`
      INSERT INTO hub_threads
        (provider, provider_thread_id, stream_id, position, project_root, source, linked_at_ms, updated_at_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      identity.provider,
      identity.threadId,
      targetStreamId,
      nextPosition,
      String(projectRoot ?? "").trim(),
      sourceName(source),
      nowMs,
      nowMs,
    );
    return this.thread(identity);
  }

  thread(value) {
    const identity = normalizedThreadIdentity(value);
    return threadFromRow(this.#database.prepare(`
      SELECT * FROM hub_threads WHERE provider = ? AND provider_thread_id = ?
    `).get(identity.provider, identity.threadId));
  }

  activeThread(streamId) {
    const id = safeIdentifier(streamId, "stream id");
    return threadFromRow(this.#database.prepare(`
      SELECT * FROM hub_threads WHERE stream_id = ? AND detached_at_ms IS NULL
      ORDER BY position DESC LIMIT 1
    `).get(id));
  }

  threadsForStream(streamId) {
    const id = safeIdentifier(streamId, "stream id");
    return this.#database.prepare(`
      SELECT * FROM hub_threads WHERE stream_id = ? ORDER BY position
    `).all(id).map(threadFromRow);
  }

  rebindThread(value, { streamId, projectRoot = "", source = "migration", position = null } = {}) {
    const identity = normalizedThreadIdentity(value);
    const targetStreamId = safeIdentifier(streamId, "stream id");
    if (!this.stream(targetStreamId)) throw new Error(`stream not found: ${targetStreamId}`);
    const current = this.thread(identity);
    if (!current) return this.bindThread({
      ...identity, streamId: targetStreamId, projectRoot, source, position,
    });
    if (current.streamId === targetStreamId) return current;
    const nextPosition = position == null
      ? Number(this.#database.prepare(`
          SELECT COALESCE(MAX(position), 0) + 1 AS position
          FROM hub_threads WHERE stream_id = ?
        `).get(targetStreamId)?.position ?? 1)
      : Number(position);
    if (!Number.isSafeInteger(nextPosition) || nextPosition <= 0) throw new Error("invalid thread position");
    const previousStreamId = current.streamId;
    this.#database.prepare(`
      UPDATE hub_threads
      SET stream_id = ?, position = ?, project_root = ?, source = ?, updated_at_ms = ?
      WHERE provider = ? AND provider_thread_id = ?
    `).run(
      targetStreamId,
      nextPosition,
      String(projectRoot ?? current.projectRoot).trim(),
      sourceName(source),
      this.#nowMs(),
      identity.provider,
      identity.threadId,
    );
    this.#removeEmptyStream(previousStreamId);
    return this.thread(identity);
  }

  resolveThread(value) {
    const thread = this.thread(value);
    if (!thread) return null;
    const stream = this.stream(thread.streamId);
    const workspace = stream ? this.workspace(stream.workspaceId) : null;
    if (!stream || !workspace) return null;
    return {
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      workspaceKind: workspace.kind,
      streamId: stream.id,
      streamOrdinal: stream.ordinal,
      streamName: stream.name,
      streamDisplayName: stream.displayName,
      threadPosition: thread.position,
      thread,
    };
  }

  assignUnknownThread(value, { source = "discovered", streamName = null } = {}) {
    const identity = normalizedThreadIdentity(value);
    const existing = this.resolveThread(identity);
    if (existing) return existing;
    return this.#transaction(() => {
      const repeated = this.resolveThread(identity);
      if (repeated) return repeated;
      const experiments = this.ensureExperiments();
      const stream = this.createStream({ workspaceId: experiments.id, name: streamName });
      this.bindThread({
        ...identity,
        streamId: stream.id,
        projectRoot: value?.projectRoot,
        source,
      });
      return this.resolveThread(identity);
    });
  }

  assignCatalogEntries(entries, { source = "discovered" } = {}) {
    return this.#transaction(() => (Array.isArray(entries) ? entries : []).map((entry) => {
      const identity = normalizedThreadIdentity(entry);
      const boundThread = this.thread(identity);
      const boundStream = boundThread ? this.stream(boundThread.streamId) : null;
      if (boundStream?.archivedAtMs != null
        || (boundStream && this.workspace(boundStream.workspaceId)?.archivedAtMs != null)) return null;
      let resolved = this.resolveThread(identity);
      const experiments = this.ensureExperiments();
      if (!resolved) {
        // Only an explicit Hub action may create or select a user Workspace.
        // Provider-discovered Threads have no trustworthy placement metadata.
        const stream = this.createStream({ workspaceId: experiments.id });
        this.bindThread({
          ...identity,
          streamId: stream.id,
          projectRoot: entry.projectRoot,
          source,
        });
        resolved = this.resolveThread(identity);
      }
      return { ...entry, ...resolved };
    }).filter(Boolean));
  }

  moveThreadToNewStream(value, { workspaceId, streamName = null } = {}) {
    const identity = normalizedThreadIdentity(value);
    const current = this.thread(identity);
    if (!current) throw new Error(`thread not found: ${providerThreadKey(identity)}`);
    const targetWorkspaceId = safeIdentifier(workspaceId, "workspace id");
    return this.#transaction(() => {
      const stream = this.createStream({ workspaceId: targetWorkspaceId, name: streamName });
      this.#database.prepare(`
        UPDATE hub_threads SET stream_id = ?, position = 1, updated_at_ms = ?
        WHERE provider = ? AND provider_thread_id = ?
      `).run(stream.id, this.#nowMs(), identity.provider, identity.threadId);
      this.#removeEmptyStream(current.streamId);
      return this.resolveThread(identity);
    });
  }

  #removeEmptyStream(streamId) {
    const stream = this.stream(streamId);
    if (!stream) return false;
    const count = Number(this.#database.prepare(
      "SELECT COUNT(*) AS count FROM hub_threads WHERE stream_id = ?",
    ).get(streamId)?.count ?? 0);
    if (count) return false;
    this.#database.prepare("DELETE FROM hub_streams WHERE id = ?").run(streamId);
    this.#compactOrdinals(stream.workspaceId);
    return true;
  }

  hierarchy() {
    const workspaces = this.#database.prepare(`
      SELECT * FROM hub_workspaces WHERE archived_at_ms IS NULL
      ORDER BY CASE WHEN system_key = '${EXPERIMENTS_SYSTEM_KEY}' THEN 1 ELSE 0 END,
        updated_at_ms DESC, name, id
    `).all().map(workspaceFromRow);
    const streams = this.#database.prepare(`
      SELECT s.* FROM hub_streams s
      JOIN hub_workspaces w ON w.id = s.workspace_id
      WHERE s.archived_at_ms IS NULL AND w.archived_at_ms IS NULL
      ORDER BY workspace_id, ordinal
    `).all();
    const threads = this.#database.prepare(`
      SELECT t.* FROM hub_threads t
      JOIN hub_streams s ON s.id = t.stream_id
      JOIN hub_workspaces w ON w.id = s.workspace_id
      WHERE s.archived_at_ms IS NULL AND w.archived_at_ms IS NULL
      ORDER BY t.stream_id, t.position
    `).all().map(threadFromRow);
    const developerRules = this.#latestDeveloperRules();
    const streamCount = new Map();
    for (const row of streams) {
      streamCount.set(row.workspace_id, (streamCount.get(row.workspace_id) ?? 0) + 1);
    }
    const threadsByStream = new Map();
    for (const thread of threads) {
      const values = threadsByStream.get(thread.streamId) ?? [];
      values.push(thread);
      threadsByStream.set(thread.streamId, values);
    }
    const streamsByWorkspace = new Map();
    for (const row of streams) {
      const stream = streamFromRow(row, streamCount.get(row.workspace_id) ?? 0);
      const values = streamsByWorkspace.get(stream.workspaceId) ?? [];
      values.push({
        ...stream,
        developerRules: developerRules.get(`stream\0${stream.id}`) ?? null,
        threads: threadsByStream.get(stream.id) ?? [],
      });
      streamsByWorkspace.set(stream.workspaceId, values);
    }
    return workspaces.map((workspace) => ({
      ...workspace,
      developerRules: developerRules.get(`workspace\0${workspace.id}`) ?? null,
      streams: streamsByWorkspace.get(workspace.id) ?? [],
    }));
  }

  meta(key) {
    const name = safeIdentifier(key, "workspace catalog meta key");
    return this.#database.prepare(
      "SELECT value FROM hub_workspace_catalog_meta WHERE key = ?",
    ).get(name)?.value ?? null;
  }

  setMeta(key, value) {
    const name = safeIdentifier(key, "workspace catalog meta key");
    this.#database.prepare(`
      INSERT INTO hub_workspace_catalog_meta (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(name, String(value));
  }

  deleteMeta(key) {
    const name = safeIdentifier(key, "workspace catalog meta key");
    this.#database.prepare("DELETE FROM hub_workspace_catalog_meta WHERE key = ?").run(name);
  }

  transaction(run) {
    if (typeof run !== "function") throw new TypeError("transaction callback is required");
    return this.#transaction(run);
  }

  close() {
    this.#database?.close();
    this.#database = null;
  }
}
