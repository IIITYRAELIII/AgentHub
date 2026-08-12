import { randomUUID } from "node:crypto";
import { mkdir, rename } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

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

const SCHEMA_VERSION = 4;
export const DEVELOPER_RULES_MAX_BYTES = 32 * 1024;
const SOURCES = new Set(["created", "discovered", "migration", "rebirth"]);
const DEVELOPER_RULE_SCOPES = new Set(["workspace", "stream"]);

function recoverableDatabaseError(error) {
  return /(?:file is not a database|database disk image is malformed|malformed database schema)/iu
    .test(String(error?.message ?? ""));
}

function configure(database) {
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA busy_timeout = 5000;
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
      settings_json TEXT NOT NULL DEFAULT '{}'
    ) WITHOUT ROWID;
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
      PRIMARY KEY (provider, provider_thread_id),
      FOREIGN KEY (stream_id) REFERENCES hub_streams(id) ON DELETE CASCADE,
      UNIQUE (stream_id, position)
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS hub_threads_stream_idx
      ON hub_threads(stream_id, position);
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
  const streamColumns = database.prepare("PRAGMA table_info(hub_streams)").all();
  if (!streamColumns.some((column) => column.name === "settings_json")) {
    database.exec("ALTER TABLE hub_streams ADD COLUMN settings_json TEXT NOT NULL DEFAULT '{}'");
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

function developerRuleScope(value) {
  const scope = String(value ?? "").trim().toLowerCase();
  if (!DEVELOPER_RULE_SCOPES.has(scope)) throw new Error(`invalid developer rule scope: ${value}`);
  return scope;
}

function developerRuleContent(value) {
  const content = String(value ?? "");
  if (Buffer.byteLength(content, "utf8") > DEVELOPER_RULES_MAX_BYTES) {
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

export class WorkspaceCatalogStore {
  #databaseFile;
  #database = null;
  #now;
  #idFactory;

  constructor({ databaseFile, now = () => Date.now(), idFactory = randomUUID } = {}) {
    if (!databaseFile) throw new Error("WorkspaceCatalogStore databaseFile is required");
    this.#databaseFile = path.resolve(databaseFile);
    this.#now = now;
    this.#idFactory = idFactory;
  }

  async load() {
    await this.#open();
    this.ensureExperiments();
    return this;
  }

  async #open() {
    if (this.#database) return this.#database;
    await mkdir(path.dirname(this.#databaseFile), { recursive: true });
    let database;
    try {
      database = new DatabaseSync(this.#databaseFile);
      configure(database);
    } catch (error) {
      database?.close();
      if (!recoverableDatabaseError(error)) throw error;
      const suffix = `.corrupt-${new Date().toISOString().replaceAll(/[:.]/gu, "-")}`;
      let preserved = false;
      for (const candidate of [this.#databaseFile, `${this.#databaseFile}-wal`, `${this.#databaseFile}-shm`]) {
        try {
          await rename(candidate, `${candidate}${suffix}`);
          preserved = true;
        } catch (renameError) {
          if (renameError?.code !== "ENOENT") throw renameError;
        }
      }
      if (!preserved) throw error;
      database = new DatabaseSync(this.#databaseFile);
      configure(database);
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
      JSON.stringify(settings ?? {}),
    );
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
    if (!this.workspace(id)) throw new Error(`workspace not found: ${id}`);
    this.#database.prepare(`
      UPDATE hub_workspaces SET settings_json = ?, updated_at_ms = ? WHERE id = ?
    `).run(JSON.stringify(settings ?? {}), this.#nowMs(), id);
    return this.workspace(id);
  }

  workspaceDeveloperRules(workspaceId) {
    const id = safeIdentifier(workspaceId, "workspace id");
    if (!this.workspace(id)) throw new Error(`workspace not found: ${id}`);
    return this.#developerRules("workspace", id);
  }

  updateWorkspaceDeveloperRules(workspaceId, content) {
    const id = safeIdentifier(workspaceId, "workspace id");
    if (!this.workspace(id)) throw new Error(`workspace not found: ${id}`);
    return this.#updateDeveloperRules("workspace", id, content);
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
    if (!this.workspace(targetWorkspaceId)) throw new Error(`workspace not found: ${targetWorkspaceId}`);
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
    return {
      workspace: this.#developerRules("workspace", stream.workspaceId),
      stream: this.#developerRules("stream", stream.id),
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

  #updateDeveloperRules(scopeType, scopeId, content) {
    const scope = developerRuleScope(scopeType);
    const id = safeIdentifier(scopeId, `${scope} id`);
    const value = developerRuleContent(content);
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
    if (!this.workspace(targetWorkspaceId)) throw new Error(`workspace not found: ${targetWorkspaceId}`);
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
      SELECT * FROM hub_threads WHERE stream_id = ?
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
    }));
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
      SELECT * FROM hub_workspaces
      ORDER BY CASE WHEN system_key = '${EXPERIMENTS_SYSTEM_KEY}' THEN 1 ELSE 0 END,
        updated_at_ms DESC, name, id
    `).all().map(workspaceFromRow);
    const streams = this.#database.prepare(`
      SELECT * FROM hub_streams WHERE archived_at_ms IS NULL
      ORDER BY workspace_id, ordinal
    `).all();
    const threads = this.#database.prepare(`
      SELECT * FROM hub_threads ORDER BY stream_id, position
    `).all().map(threadFromRow);
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
        developerRules: this.#developerRules("stream", stream.id),
        threads: threadsByStream.get(stream.id) ?? [],
      });
      streamsByWorkspace.set(stream.workspaceId, values);
    }
    return workspaces.map((workspace) => ({
      ...workspace,
      developerRules: this.#developerRules("workspace", workspace.id),
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

  transaction(run) {
    if (typeof run !== "function") throw new TypeError("transaction callback is required");
    return this.#transaction(run);
  }

  close() {
    this.#database?.close();
    this.#database = null;
  }
}
