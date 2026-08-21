import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
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

const SCHEMA_VERSION = 9;
export const DEVELOPER_RULES_MAX_BYTES = 32 * 1024;
const SOURCES = new Set(["created", "discovered", "migration", "rebirth"]);
const DEVELOPER_RULE_SCOPES = new Set(["workspace", "stream"]);
const RELEASE_CHANGE_STATUSES = new Set(["draft", "ready", "blocked", "released", "discarded"]);

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
      detached_at_ms INTEGER,
      PRIMARY KEY (provider, provider_thread_id),
      FOREIGN KEY (stream_id) REFERENCES hub_streams(id) ON DELETE CASCADE,
      UNIQUE (stream_id, position)
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS hub_threads_stream_idx
      ON hub_threads(stream_id, position);
    CREATE TABLE IF NOT EXISTS hub_release_changes (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      stream_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      provider_thread_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      project_root TEXT NOT NULL DEFAULT '',
      summary TEXT NOT NULL DEFAULT '',
      files_json TEXT NOT NULL DEFAULT '[]',
      diff_hash TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL CHECK (status IN ('draft', 'ready', 'blocked', 'released', 'discarded')),
      revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      FOREIGN KEY (workspace_id) REFERENCES hub_workspaces(id) ON DELETE CASCADE,
      FOREIGN KEY (stream_id) REFERENCES hub_streams(id) ON DELETE CASCADE,
      UNIQUE (provider, provider_thread_id, turn_id)
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS hub_release_changes_workspace_status_idx
      ON hub_release_changes(workspace_id, status, updated_at_ms DESC);
    CREATE INDEX IF NOT EXISTS hub_release_changes_stream_idx
      ON hub_release_changes(stream_id, updated_at_ms DESC);
    CREATE TABLE IF NOT EXISTS hub_mcp_operations (
      request_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      stream_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      provider_thread_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      arguments_hash TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'succeeded', 'failed')),
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
  const streamColumns = database.prepare("PRAGMA table_info(hub_streams)").all();
  if (!streamColumns.some((column) => column.name === "settings_json")) {
    database.exec("ALTER TABLE hub_streams ADD COLUMN settings_json TEXT NOT NULL DEFAULT '{}'");
  }
  const threadColumns = database.prepare("PRAGMA table_info(hub_threads)").all();
  if (!threadColumns.some((column) => column.name === "detached_at_ms")) {
    database.exec("ALTER TABLE hub_threads ADD COLUMN detached_at_ms INTEGER");
  }
  const releaseChangeColumns = database.prepare("PRAGMA table_info(hub_release_changes)").all();
  if (!releaseChangeColumns.some((column) => column.name === "revision")) {
    database.exec("ALTER TABLE hub_release_changes ADD COLUMN revision INTEGER NOT NULL DEFAULT 1");
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

function releaseChangeFromRow(row) {
  if (!row) return null;
  let files = [];
  try { files = JSON.parse(String(row.files_json ?? "[]")); } catch { files = []; }
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    streamId: String(row.stream_id),
    provider: String(row.provider),
    threadId: String(row.provider_thread_id),
    turnId: String(row.turn_id),
    projectRoot: String(row.project_root ?? ""),
    summary: String(row.summary ?? ""),
    files: Array.isArray(files) ? files.map((file) => String(file)) : [],
    diffHash: String(row.diff_hash ?? ""),
    status: String(row.status),
    revision: Number(row.revision) || 1,
    createdAtMs: Number(row.created_at_ms) || 0,
    updatedAtMs: Number(row.updated_at_ms) || 0,
  };
}

function releaseChangeStatus(value) {
  const status = String(value ?? "").trim().toLowerCase();
  if (!RELEASE_CHANGE_STATUSES.has(status)) throw new Error(`invalid release change status: ${value}`);
  if (status === "released") throw new Error("released status is reserved for completed releases");
  return status;
}

function releaseChangeFiles(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value ?? "").trim().replaceAll("\\", "/"))
    .filter((value) => value && !value.includes("\0")))].slice(0, 500);
}

function releasePath(value) {
  return String(value ?? "").trim().replaceAll("\\", "/");
}

function isWindowsPath(value) {
  return /^(?:[a-z]:[\\/]|\\\\)/iu.test(String(value ?? ""));
}

function canonicalReleaseFileIdentity(projectRoot, file) {
  const root = releasePath(projectRoot);
  const candidate = releasePath(file);
  if (!candidate) return "";
  if (isWindowsPath(root) || isWindowsPath(candidate)) {
    const absolute = path.win32.isAbsolute(candidate)
      ? path.win32.normalize(candidate)
      : root
        ? path.win32.resolve(root, candidate)
        : path.win32.normalize(candidate);
    return `${root || path.win32.isAbsolute(candidate) ? "windows" : "relative"}:${absolute.replaceAll("\\", "/").toLowerCase()}`;
  }
  if (!root) return `relative:${path.posix.normalize(candidate)}`;
  return `posix:${path.posix.resolve(root, candidate)}`;
}

function sharedReleaseChangelog(projectRoot, file) {
  const identity = canonicalReleaseFileIdentity(projectRoot, file);
  return identity === "relative:utilities/changelog.md" || identity.endsWith("/utilities/changelog.md");
}

function releasePlanRevision(workspaceId, changes) {
  const payload = (Array.isArray(changes) ? changes : [])
    .map((change) => ({
      id: change.id,
      revision: change.revision,
      status: change.status,
      projectRoot: canonicalReleaseFileIdentity(change.projectRoot, "."),
      summary: change.summary,
      files: change.files.map((file) => canonicalReleaseFileIdentity(change.projectRoot, file)).toSorted(),
      diffHash: change.diffHash,
    }))
    .toSorted((left, right) => left.id.localeCompare(right.id));
  return createHash("sha256")
    .update(JSON.stringify({ workspaceId, changes: payload }), "utf8")
    .digest("hex");
}

function releaseCompletionEvidence(value, expectedPlanRevision) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("release completion evidence is required");
  }
  const planRevision = String(value.planRevision ?? "").trim();
  if (!planRevision || planRevision !== expectedPlanRevision) {
    throw new Error("release completion evidence does not match the release plan revision");
  }
  return {
    planRevision,
    expectedRevision: String(value.expectedRevision ?? "").trim() || null,
    verificationSummary: String(value.verificationSummary ?? "").trim().slice(0, 2_000),
    conflictsResolved: value.conflictsResolved === true,
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
    status: String(row.status),
    result,
    error: String(row.error_text ?? ""),
    createdAtMs: Number(row.created_at_ms) || 0,
    completedAtMs: row.completed_at_ms == null ? null : Number(row.completed_at_ms),
  };
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

  get revision() {
    if (!this.#database) return 0;
    return Number(this.#database.prepare("SELECT total_changes() AS value").get()?.value) || 0;
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

  recordReleaseChange({
    provider, threadId, turnId, projectRoot = "", summary = "", changedFiles = [], diffHash = "",
    status = "draft",
  } = {}) {
    const identity = normalizedThreadIdentity({ provider, threadId });
    const resolved = this.resolveThread(identity);
    const normalizedTurnId = safeIdentifier(turnId, "turn id");
    const files = releaseChangeFiles(changedFiles);
    if (!resolved || !files.length) return null;
    const normalizedStatus = releaseChangeStatus(status);
    const nowMs = this.#nowMs();
    return this.#transaction(() => {
      this.#database.prepare(`
      INSERT INTO hub_release_changes (
        id, workspace_id, stream_id, provider, provider_thread_id, turn_id,
        project_root, summary, files_json, diff_hash, status, revision, created_at_ms, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
      ON CONFLICT(provider, provider_thread_id, turn_id) DO UPDATE SET
        workspace_id = CASE WHEN hub_release_changes.status = 'draft' THEN excluded.workspace_id ELSE hub_release_changes.workspace_id END,
        stream_id = CASE WHEN hub_release_changes.status = 'draft' THEN excluded.stream_id ELSE hub_release_changes.stream_id END,
        project_root = CASE WHEN hub_release_changes.status = 'draft' THEN excluded.project_root ELSE hub_release_changes.project_root END,
        summary = CASE WHEN hub_release_changes.status = 'draft' THEN excluded.summary ELSE hub_release_changes.summary END,
        files_json = CASE WHEN hub_release_changes.status = 'draft' THEN excluded.files_json ELSE hub_release_changes.files_json END,
        diff_hash = CASE WHEN hub_release_changes.status = 'draft' THEN excluded.diff_hash ELSE hub_release_changes.diff_hash END,
        status = CASE
          WHEN hub_release_changes.status = 'draft' THEN excluded.status
          ELSE hub_release_changes.status
        END,
        revision = CASE WHEN hub_release_changes.status = 'draft' THEN hub_release_changes.revision + 1 ELSE hub_release_changes.revision END,
        updated_at_ms = CASE WHEN hub_release_changes.status = 'draft' THEN excluded.updated_at_ms ELSE hub_release_changes.updated_at_ms END
      `).run(
        this.#idFactory(), resolved.workspaceId, resolved.streamId,
        identity.provider, identity.threadId, normalizedTurnId,
        String(projectRoot ?? "").trim(), String(summary ?? "").trim().slice(0, 500),
        JSON.stringify(files), String(diffHash ?? "").trim().slice(0, 128), normalizedStatus, nowMs, nowMs,
      );
      const change = this.releaseChange({ ...identity, turnId: normalizedTurnId });
      this.recordWorkspaceEvent({
        workspaceId: change.workspaceId,
        streamId: change.streamId,
        type: "release.change_recorded",
        subjectId: change.id,
        dedupeKey: `release.change_recorded:${change.id}`,
        payload: { changeId: change.id, status: change.status, files: change.files },
      });
      return change;
    });
  }

  releaseChange({ provider, threadId, turnId } = {}) {
    const identity = normalizedThreadIdentity({ provider, threadId });
    const normalizedTurnId = safeIdentifier(turnId, "turn id");
    return releaseChangeFromRow(this.#database.prepare(`
      SELECT * FROM hub_release_changes
      WHERE provider = ? AND provider_thread_id = ? AND turn_id = ?
    `).get(identity.provider, identity.threadId, normalizedTurnId));
  }

  releaseChanges(workspaceId, { includeReleased = false, limit = null } = {}) {
    const id = safeIdentifier(workspaceId, "workspace id");
    if (!this.workspace(id)) throw new Error(`workspace not found: ${id}`);
    const boundedLimit = limit == null ? null : Math.max(1, Math.min(100, Number(limit) || 50));
    const statusClause = includeReleased ? "" : "AND status NOT IN ('released', 'discarded')";
    const limitClause = boundedLimit == null ? "" : "LIMIT ?";
    const statement = this.#database.prepare(`SELECT * FROM hub_release_changes
      WHERE workspace_id = ? ${statusClause}
      ORDER BY updated_at_ms DESC, id ${limitClause}`);
    const rows = boundedLimit == null ? statement.all(id) : statement.all(id, boundedLimit);
    return rows.map(releaseChangeFromRow);
  }

  updateReleaseChangeStatus(changeId, status) {
    const id = safeIdentifier(changeId, "release change id");
    return this.#transaction(() => {
      const current = releaseChangeFromRow(this.#database.prepare(
        "SELECT * FROM hub_release_changes WHERE id = ?",
      ).get(id));
      if (!current) throw new Error(`release change not found: ${id}`);
      if (current.status === "released") throw new Error("released release change is immutable");
      const result = this.#database.prepare(`
        UPDATE hub_release_changes SET status = ?, updated_at_ms = ? WHERE id = ?
      `).run(releaseChangeStatus(status), this.#nowMs(), id);
      if (!Number(result.changes)) throw new Error(`release change not found: ${id}`);
      const change = releaseChangeFromRow(this.#database.prepare(
        "SELECT * FROM hub_release_changes WHERE id = ?",
      ).get(id));
      this.recordWorkspaceEvent({
        workspaceId: change.workspaceId,
        streamId: change.streamId,
        type: "release.status_changed",
        subjectId: change.id,
        payload: { changeId: change.id, status: change.status },
      });
      return change;
    });
  }

  #releaseConflicts(changes) {
    const ownersByFile = new Map();
    for (const change of changes) {
      for (const file of change.files) {
        if (sharedReleaseChangelog(change.projectRoot, file)) continue;
        const key = canonicalReleaseFileIdentity(change.projectRoot, file);
        const owners = ownersByFile.get(key) ?? { projectRoot: change.projectRoot, file, changes: [] };
        owners.changes.push({ id: change.id, streamId: change.streamId, status: change.status });
        ownersByFile.set(key, owners);
      }
    }
    const statusOrder = new Map([["ready", 0], ["draft", 1], ["blocked", 2]]);
    return [...ownersByFile.values()].map((entry) => ({
      ...entry,
      changes: entry.changes.toSorted((left, right) => (
        (statusOrder.get(left.status) ?? 3) - (statusOrder.get(right.status) ?? 3)
        || left.id.localeCompare(right.id)
      )),
    })).filter((entry) => {
      const streams = new Set(entry.changes.map((change) => change.streamId));
      const statuses = new Set(entry.changes.map((change) => change.status));
      return streams.size > 1 || (statuses.has("ready") && statuses.size > 1);
    });
  }

  releaseRegistry(workspaceId, { limit = 50 } = {}) {
    const allChanges = this.releaseChanges(workspaceId);
    const changes = allChanges.slice(0, Math.max(1, Math.min(100, Number(limit) || 50)));
    const visibleIds = new Set(changes.map((change) => change.id));
    return {
      workspaceId: safeIdentifier(workspaceId, "workspace id"),
      changes,
      total: allChanges.length,
      counts: Object.fromEntries([...RELEASE_CHANGE_STATUSES].map((status) => [
        status, allChanges.filter((change) => change.status === status).length,
      ])),
      conflicts: this.#releaseConflicts(allChanges)
        .filter((conflict) => conflict.changes.some((change) => visibleIds.has(change.id)))
        .map((conflict) => ({
          ...conflict,
          ownerCount: conflict.changes.length,
          changes: conflict.changes.filter((change) => visibleIds.has(change.id)),
        })),
    };
  }

  releasePlan(workspaceId) {
    const changes = this.releaseChanges(workspaceId);
    const normalizedWorkspaceId = safeIdentifier(workspaceId, "workspace id");
    const ready = changes.filter((change) => change.status === "ready");
    return {
      workspaceId: normalizedWorkspaceId,
      revision: releasePlanRevision(normalizedWorkspaceId, changes),
      ready,
      draft: changes.filter((change) => change.status === "draft"),
      blocked: changes.filter((change) => change.status === "blocked"),
      conflicts: this.#releaseConflicts(changes),
    };
  }

  completeRelease(workspaceId, {
    expectedPlanRevision = null, verificationEvidence = null, conflictsResolved = false,
  } = {}) {
    const expected = expectedPlanRevision == null ? null : String(expectedPlanRevision).trim();
    if (expectedPlanRevision != null && !expected) throw new Error("expected release plan revision is required");
    return this.#transaction(() => {
      const plan = this.releasePlan(workspaceId);
      if (expected && plan.revision !== expected) {
        throw new Error("release plan revision conflict; verify the current release plan again");
      }
      const evidence = expected ? releaseCompletionEvidence(verificationEvidence, expected) : null;
      if (!plan.ready.length) throw new Error("release has no ready changes");
      if (plan.blocked.length) throw new Error("release has blocked changes");
      if (plan.conflicts.length && conflictsResolved !== true) throw new Error("release has overlapping files");
      if (plan.conflicts.length && (!expected || evidence?.conflictsResolved !== true)) {
        throw new Error("resolved release conflicts require revision-bound verification evidence");
      }
      const nowMs = this.#nowMs();
      const update = this.#database.prepare(`
        UPDATE hub_release_changes SET status = 'released', updated_at_ms = ? WHERE id = ?
      `);
      for (const change of plan.ready) update.run(nowMs, change.id);
      const result = {
        workspaceId: plan.workspaceId,
        released: plan.ready.map((change) => ({ ...change, status: "released", updatedAtMs: nowMs })),
      };
      this.recordWorkspaceEvent({
        workspaceId: plan.workspaceId,
        type: "release.completed",
        payload: {
          changeIds: result.released.map((change) => change.id),
          planRevision: plan.revision,
          ...(evidence ? { verification: evidence } : {}),
        },
      });
      return result;
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
      return { ...existing, replayed: true };
    }
    this.#database.prepare(`
      INSERT INTO hub_mcp_operations (
        request_id, workspace_id, stream_id, provider, provider_thread_id,
        tool_name, arguments_hash, status, created_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)
    `).run(
      id, workspace, stream, normalizedProvider, normalizedThreadId, tool, hash, this.#nowMs(),
    );
    return { ...mcpOperationFromRow(this.#database.prepare(
      "SELECT * FROM hub_mcp_operations WHERE request_id = ?",
    ).get(id)), replayed: false };
  }

  completeMcpOperation(requestId, result) {
    const id = safeIdentifier(requestId, "MCP request id");
    const resultJson = JSON.stringify(result ?? null);
    if (Buffer.byteLength(resultJson, "utf8") > 1024 * 1024) throw new Error("MCP audit result is too large");
    const updated = this.#database.prepare(`
      UPDATE hub_mcp_operations
      SET status = 'succeeded', result_json = ?, error_text = '', completed_at_ms = ?
      WHERE request_id = ? AND status = 'pending'
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
      SET status = 'failed', result_json = NULL, error_text = ?, completed_at_ms = ?
      WHERE request_id = ? AND status = 'pending'
    `).run(String(error?.message ?? error ?? "MCP operation failed").slice(0, 4000), this.#nowMs(), id);
    return mcpOperationFromRow(this.#database.prepare(
      "SELECT * FROM hub_mcp_operations WHERE request_id = ?",
    ).get(id));
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
    this.#database.prepare(`
      UPDATE hub_release_changes SET workspace_id = ?, updated_at_ms = ? WHERE stream_id = ?
    `).run(targetWorkspaceId, this.#nowMs(), id);
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
      if (boundThread && this.stream(boundThread.streamId)?.archivedAtMs != null) return null;
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
