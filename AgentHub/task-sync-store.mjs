import { createHash } from "node:crypto";
import { mkdir, readFile, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { catalogTaskKey } from "./task-catalog.mjs";

const FORMAT_VERSION = 1;
const TASK_SCHEMA_VERSION = 1;
const DEFAULT_HISTORY_LIMIT = 50;
const DEFAULT_RUNNING_FRESHNESS_MS = 10 * 60 * 1000;
const DEFAULT_TASK_LIMIT = 1_000;

function cleanText(value, limit) {
  return String(value ?? "").trim().slice(0, limit);
}

function cleanAttachments(attachments) {
  return (Array.isArray(attachments) ? attachments : [])
    .slice(-8)
    .map((attachment) => ({
      id: cleanText(attachment?.id, 300),
      name: cleanText(attachment?.name, 300),
      type: cleanText(attachment?.type, 100),
    }))
    .filter((attachment) => attachment.id);
}

function cleanHistory(history, limit) {
  return (Array.isArray(history) ? history : [])
    .slice(-limit)
    .map((item) => ({
      id: cleanText(item?.id, 100),
      prompt: cleanText(item?.prompt, 12_000),
      answer: cleanText(item?.answer, 40_000),
      status: cleanText(item?.status, 40),
      active: item?.active === true,
      completed: item?.completed === true,
      ...(item?.startedAt ? { startedAt: cleanText(item.startedAt, 80) } : {}),
      ...(item?.completedAt ? { completedAt: cleanText(item.completedAt, 80) } : {}),
      attachments: cleanAttachments(item?.attachments),
      activities: (Array.isArray(item?.activities) ? item.activities : [])
        .slice(-100)
        .map((activity) => ({
          id: cleanText(activity?.id, 200),
          type: cleanText(activity?.type, 40),
          label: cleanText(activity?.label, 500),
          detail: cleanText(activity?.detail, 1_000),
          status: cleanText(activity?.status, 40),
          ...(activity?.time ? { time: cleanText(activity.time, 80) } : {}),
        }))
        .filter((activity) => activity.id || activity.label),
      messages: (Array.isArray(item?.messages) ? item.messages : [])
        .slice(-100)
        .flatMap((message) => {
          const role = cleanText(message?.role, 20);
          const text = cleanText(message?.text, role === "agent" ? 40_000 : 12_000);
          if (!["user", "agent"].includes(role) || !text) return [];
          return [{
            itemId: cleanText(message?.itemId, 200),
            ...(message?.clientUserMessageId
              ? { clientUserMessageId: cleanText(message.clientUserMessageId, 200) }
              : {}),
            role,
            text,
            ...(message?.phase ? { phase: cleanText(message.phase, 40) } : {}),
            ...(message?.time ? { time: cleanText(message.time, 80) } : {}),
            attachments: cleanAttachments(message?.attachments),
          }];
        }),
    }));
}

function persistedTask(value = {}, canonicalizeProjectRoot = (projectRoot) => projectRoot) {
  const provider = cleanText(value.provider, 20).toLowerCase();
  const threadId = cleanText(value.threadId, 100);
  if (!provider || !threadId) return null;
  const projectRoot = cleanText(value.projectRoot, 2_000);
  return {
    provider,
    threadId,
    projectRoot: cleanText(canonicalizeProjectRoot(projectRoot), 2_000),
    projectName: cleanText(value.projectName, 200),
    sessionCwd: cleanText(value.sessionCwd, 2_000) || null,
    title: cleanText(value.title ?? value.taskTitle, 200),
    updatedAtMs: Number(value.updatedAtMs) || 0,
    running: value.running === true,
    executionOwner: cleanText(value.executionOwner, 40) || null,
    turnId: cleanText(value.turnId, 100) || null,
    lastActivityAtMs: Number(value.lastActivityAtMs) || null,
    stage: cleanText(value.stage, 1_000),
    answer: cleanText(value.answer, 40_000),
    syncedAtMs: Number(value.syncedAtMs) || 0,
    history: cleanHistory(value.history, DEFAULT_HISTORY_LIMIT),
  };
}

function taskMetadata(value = {}) {
  const { history: _history, syncedAtMs: _syncedAtMs, ...metadata } = value;
  return metadata;
}

function taskMetadataChanged(previous, next) {
  return JSON.stringify(taskMetadata(previous)) !== JSON.stringify(taskMetadata(next));
}

function parseJsonArray(value) {
  try {
    const parsed = JSON.parse(String(value ?? "[]"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

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
    CREATE TABLE IF NOT EXISTS task_read_model_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS task_read_model_tasks (
      provider TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      project_root TEXT NOT NULL,
      project_name TEXT NOT NULL,
      session_cwd TEXT,
      title TEXT NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      running INTEGER NOT NULL CHECK (running IN (0, 1)),
      execution_owner TEXT,
      turn_id TEXT,
      last_activity_at_ms INTEGER,
      stage TEXT NOT NULL,
      answer TEXT NOT NULL,
      synced_at_ms INTEGER NOT NULL,
      PRIMARY KEY (provider, thread_id)
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS task_read_model_tasks_updated
      ON task_read_model_tasks (updated_at_ms DESC);
    CREATE INDEX IF NOT EXISTS task_read_model_tasks_activity
      ON task_read_model_tasks (last_activity_at_ms DESC);
    CREATE TABLE IF NOT EXISTS task_read_model_turns (
      provider TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      position INTEGER NOT NULL,
      id TEXT NOT NULL,
      prompt TEXT NOT NULL,
      answer TEXT NOT NULL,
      status TEXT NOT NULL,
      active INTEGER NOT NULL CHECK (active IN (0, 1)),
      completed INTEGER NOT NULL CHECK (completed IN (0, 1)),
      started_at TEXT,
      completed_at TEXT,
      attachments_json TEXT NOT NULL,
      activities_json TEXT NOT NULL,
      PRIMARY KEY (provider, thread_id, position),
      FOREIGN KEY (provider, thread_id)
        REFERENCES task_read_model_tasks (provider, thread_id) ON DELETE CASCADE
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS task_read_model_turns_id
      ON task_read_model_turns (provider, thread_id, id);
    CREATE TABLE IF NOT EXISTS task_read_model_messages (
      provider TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      turn_position INTEGER NOT NULL,
      position INTEGER NOT NULL,
      item_id TEXT NOT NULL,
      client_user_message_id TEXT,
      role TEXT NOT NULL CHECK (role IN ('user', 'agent')),
      text TEXT NOT NULL,
      phase TEXT,
      time TEXT,
      attachments_json TEXT NOT NULL,
      PRIMARY KEY (provider, thread_id, turn_position, position),
      FOREIGN KEY (provider, thread_id, turn_position)
        REFERENCES task_read_model_turns (provider, thread_id, position) ON DELETE CASCADE
    ) WITHOUT ROWID;
  `);
  database.prepare(`
    INSERT INTO task_read_model_meta (key, value) VALUES ('schema_version', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(String(TASK_SCHEMA_VERSION));
}

function taskFromRow(row, history = []) {
  if (!row) return null;
  return {
    provider: String(row.provider),
    threadId: String(row.thread_id),
    projectRoot: String(row.project_root ?? ""),
    projectName: String(row.project_name ?? ""),
    sessionCwd: row.session_cwd ? String(row.session_cwd) : null,
    title: String(row.title ?? ""),
    updatedAtMs: Number(row.updated_at_ms) || 0,
    running: Number(row.running) === 1,
    executionOwner: row.execution_owner ? String(row.execution_owner) : null,
    turnId: row.turn_id ? String(row.turn_id) : null,
    lastActivityAtMs: Number(row.last_activity_at_ms) || null,
    stage: String(row.stage ?? ""),
    answer: String(row.answer ?? ""),
    syncedAtMs: Number(row.synced_at_ms) || 0,
    history,
  };
}

export class LocalTaskSyncStore {
  #filePath;
  #databaseFile;
  #database = null;
  #historyLimit;
  #taskLimit;
  #canonicalizeProjectRoot;
  #canonicalizeValue;

  constructor({
    filePath,
    databaseFile = path.join(path.dirname(filePath), "journal.sqlite"),
    historyLimit = DEFAULT_HISTORY_LIMIT,
    taskLimit = DEFAULT_TASK_LIMIT,
    canonicalizeProjectRoot = (projectRoot) => projectRoot,
    canonicalizeValue = (value) => value,
  }) {
    this.#filePath = path.resolve(filePath);
    this.#databaseFile = path.resolve(databaseFile);
    this.#historyLimit = Math.max(1, Number(historyLimit) || DEFAULT_HISTORY_LIMIT);
    this.#taskLimit = Math.max(1, Number(taskLimit) || DEFAULT_TASK_LIMIT);
    this.#canonicalizeProjectRoot = canonicalizeProjectRoot;
    this.#canonicalizeValue = canonicalizeValue;
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

  #taskRow(task) {
    return this.#database.prepare(`
      SELECT * FROM task_read_model_tasks WHERE provider = ? AND thread_id = ?
    `).get(cleanText(task?.provider, 20).toLowerCase(), cleanText(task?.threadId, 100));
  }

  #readHistory(task) {
    const provider = cleanText(task?.provider, 20).toLowerCase();
    const threadId = cleanText(task?.threadId, 100);
    if (!provider || !threadId) return [];
    const messages = this.#database.prepare(`
      SELECT * FROM task_read_model_messages
      WHERE provider = ? AND thread_id = ?
      ORDER BY turn_position, position
    `).all(provider, threadId);
    const messagesByTurn = new Map();
    for (const row of messages) {
      const turnMessages = messagesByTurn.get(Number(row.turn_position)) ?? [];
      turnMessages.push({
        itemId: String(row.item_id ?? ""),
        ...(row.client_user_message_id
          ? { clientUserMessageId: String(row.client_user_message_id) }
          : {}),
        role: String(row.role),
        text: String(row.text),
        ...(row.phase ? { phase: String(row.phase) } : {}),
        ...(row.time ? { time: String(row.time) } : {}),
        attachments: parseJsonArray(row.attachments_json),
      });
      messagesByTurn.set(Number(row.turn_position), turnMessages);
    }
    return this.#database.prepare(`
      SELECT * FROM task_read_model_turns
      WHERE provider = ? AND thread_id = ?
      ORDER BY position
    `).all(provider, threadId).map((row) => ({
      id: String(row.id ?? ""),
      prompt: String(row.prompt ?? ""),
      answer: String(row.answer ?? ""),
      status: String(row.status ?? ""),
      active: Number(row.active) === 1,
      completed: Number(row.completed) === 1,
      ...(row.started_at ? { startedAt: String(row.started_at) } : {}),
      ...(row.completed_at ? { completedAt: String(row.completed_at) } : {}),
      attachments: parseJsonArray(row.attachments_json),
      activities: parseJsonArray(row.activities_json),
      messages: messagesByTurn.get(Number(row.position)) ?? [],
    }));
  }

  #readTask(task, withHistory = false) {
    const row = this.#taskRow(task);
    return taskFromRow(row, withHistory ? this.#readHistory(task) : []);
  }

  #writeTask(task) {
    this.#database.prepare(`
      INSERT INTO task_read_model_tasks (
        provider, thread_id, project_root, project_name, session_cwd, title,
        updated_at_ms, running, execution_owner, turn_id, last_activity_at_ms,
        stage, answer, synced_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(provider, thread_id) DO UPDATE SET
        project_root = excluded.project_root,
        project_name = excluded.project_name,
        session_cwd = excluded.session_cwd,
        title = excluded.title,
        updated_at_ms = excluded.updated_at_ms,
        running = excluded.running,
        execution_owner = excluded.execution_owner,
        turn_id = excluded.turn_id,
        last_activity_at_ms = excluded.last_activity_at_ms,
        stage = excluded.stage,
        answer = excluded.answer,
        synced_at_ms = excluded.synced_at_ms
    `).run(
      task.provider,
      task.threadId,
      task.projectRoot,
      task.projectName,
      task.sessionCwd,
      task.title,
      task.updatedAtMs,
      task.running ? 1 : 0,
      task.executionOwner,
      task.turnId,
      task.lastActivityAtMs,
      task.stage,
      task.answer,
      task.syncedAtMs,
    );
  }

  #writeHistory(task, history) {
    const provider = task.provider;
    const threadId = task.threadId;
    this.#database.prepare(`
      DELETE FROM task_read_model_turns WHERE provider = ? AND thread_id = ?
    `).run(provider, threadId);
    const insertTurn = this.#database.prepare(`
      INSERT INTO task_read_model_turns (
        provider, thread_id, position, id, prompt, answer, status, active,
        completed, started_at, completed_at, attachments_json, activities_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertMessage = this.#database.prepare(`
      INSERT INTO task_read_model_messages (
        provider, thread_id, turn_position, position, item_id,
        client_user_message_id, role, text, phase, time, attachments_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    history.forEach((turn, turnPosition) => {
      insertTurn.run(
        provider,
        threadId,
        turnPosition,
        turn.id,
        turn.prompt,
        turn.answer,
        turn.status,
        turn.active ? 1 : 0,
        turn.completed ? 1 : 0,
        turn.startedAt ?? null,
        turn.completedAt ?? null,
        JSON.stringify(turn.attachments),
        JSON.stringify(turn.activities),
      );
      turn.messages.forEach((message, messagePosition) => {
        insertMessage.run(
          provider,
          threadId,
          turnPosition,
          messagePosition,
          message.itemId,
          message.clientUserMessageId ?? null,
          message.role,
          message.text,
          message.phase ?? null,
          message.time ?? null,
          JSON.stringify(message.attachments),
        );
      });
    });
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

  #prune() {
    const count = Number(this.#database.prepare(
      "SELECT COUNT(*) AS count FROM task_read_model_tasks",
    ).get()?.count ?? 0);
    if (count <= this.#taskLimit) return false;
    const removeCount = count - this.#taskLimit;
    const removable = this.#database.prepare(`
      SELECT provider, thread_id FROM task_read_model_tasks
      WHERE running = 0
      ORDER BY COALESCE(NULLIF(synced_at_ms, 0), updated_at_ms), provider, thread_id
      LIMIT ?
    `).all(removeCount);
    const remove = this.#database.prepare(`
      DELETE FROM task_read_model_tasks WHERE provider = ? AND thread_id = ?
    `);
    for (const row of removable) remove.run(row.provider, row.thread_id);
    return removable.length > 0;
  }

  async #migrateLegacyFile() {
    let source;
    let sourceInfo;
    try {
      [source, sourceInfo] = await Promise.all([
        readFile(this.#filePath, "utf8"),
        stat(this.#filePath),
      ]);
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    const fingerprint = createHash("sha256").update(source).digest("hex");
    const migrated = this.#database.prepare(`
      SELECT value FROM task_read_model_meta WHERE key = 'legacy_task_sync_sha256'
    `).get();
    let parsed;
    try {
      parsed = JSON.parse(source);
    } catch (error) {
      throw new Error(`Cannot migrate invalid task-sync.json: ${error.message}`, { cause: error });
    }
    if (Number(parsed?.version) !== FORMAT_VERSION) {
      throw new Error(`Cannot migrate task-sync.json version ${parsed?.version ?? "unknown"}`);
    }
    const canonical = this.#canonicalizeValue(parsed);
    const tasks = (Array.isArray(canonical.tasks) ? canonical.tasks : [])
      .map((value) => persistedTask(value, this.#canonicalizeProjectRoot))
      .filter(Boolean);
    if (String(migrated?.value ?? "") !== fingerprint) {
      this.#transaction(() => {
        for (const task of tasks) {
          this.#writeTask(task);
          this.#writeHistory(task, cleanHistory(task.history, this.#historyLimit));
        }
        this.#prune();
        this.#database.prepare(`
          INSERT INTO task_read_model_meta (key, value) VALUES ('legacy_task_sync_sha256', ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value
        `).run(fingerprint);
      });
    }
    for (const expected of tasks) {
      const actual = this.#readTask(expected, true);
      if (!actual || JSON.stringify(actual) !== JSON.stringify({
        ...expected,
        history: cleanHistory(expected.history, this.#historyLimit),
      })) {
        throw new Error(`SQLite verification failed for ${catalogTaskKey(expected)}`);
      }
    }
    await unlink(this.#filePath);
    console.log(`Migrated ${tasks.length} task(s) from ${path.basename(this.#filePath)} to SQLite and removed the verified source (${sourceInfo.size} bytes).`);
  }

  async load() {
    await this.#open();
    await this.#migrateLegacyFile();
    return this;
  }

  catalog({
    provider = null,
    nowMs = Date.now(),
    runningFreshnessMs = DEFAULT_RUNNING_FRESHNESS_MS,
  } = {}) {
    const normalizedProvider = provider ? String(provider).toLowerCase() : null;
    const rows = normalizedProvider
      ? this.#database.prepare(
        "SELECT * FROM task_read_model_tasks WHERE provider = ?",
      ).all(normalizedProvider)
      : this.#database.prepare("SELECT * FROM task_read_model_tasks").all();
    return rows.map((row) => taskFromRow(row)).map((task) => {
      const activityAtMs = Number(task.lastActivityAtMs ?? task.syncedAtMs);
      const running = task.running
        && Number.isFinite(activityAtMs)
        && nowMs - activityAtMs <= runningFreshnessMs;
      return {
        provider: task.provider,
        threadId: task.threadId,
        projectRoot: task.projectRoot,
        projectName: task.projectName,
        ...(task.sessionCwd ? { sessionCwd: task.sessionCwd } : {}),
        title: task.title,
        updatedAtMs: task.updatedAtMs,
        running,
        executionOwner: running ? task.executionOwner : null,
        turnId: running ? task.turnId : null,
        lastActivityAtMs: activityAtMs || null,
      };
    });
  }

  recordCatalog(entries, nowMs = Date.now()) {
    let changed = false;
    this.#transaction(() => {
      for (const entry of Array.isArray(entries) ? entries : []) {
        const existing = this.#readTask(entry) ?? {};
        const next = persistedTask({
          ...existing,
          ...entry,
          syncedAtMs: nowMs,
        }, this.#canonicalizeProjectRoot);
        if (!next || !taskMetadataChanged(existing, next)) continue;
        this.#writeTask(next);
        changed = true;
      }
      this.#prune();
    });
    return changed;
  }

  recordSnapshot(task, snapshot = {}, {
    executionOwner = null,
    nowMs = Date.now(),
  } = {}) {
    const existing = this.#readTask(task) ?? {};
    const activityAtMs = Number(snapshot.activityAtMs ?? snapshot.modifiedAtMs ?? nowMs) || nowMs;
    const next = persistedTask({
      ...existing,
      ...task,
      title: task.title ?? task.taskTitle ?? existing.title,
      running: snapshot.active === true,
      executionOwner: executionOwner ?? snapshot.executionOwner ?? existing.executionOwner,
      turnId: snapshot.turnId ?? existing.turnId,
      lastActivityAtMs: activityAtMs,
      stage: snapshot.stage ?? existing.stage,
      answer: snapshot.answer ?? existing.answer,
      syncedAtMs: nowMs,
    }, this.#canonicalizeProjectRoot);
    if (!next || !taskMetadataChanged(existing, next)) return false;
    this.#transaction(() => {
      this.#writeTask(next);
      this.#prune();
    });
    return true;
  }

  recordHistory(task, history, snapshot = null, nowMs = Date.now()) {
    const existing = this.#readTask(task, true) ?? {};
    const cleanedHistory = cleanHistory(history, this.#historyLimit);
    const next = persistedTask({
      ...existing,
      ...task,
      title: task.title ?? task.taskTitle ?? existing.title,
      running: snapshot ? snapshot.active === true : existing.running === true,
      executionOwner: snapshot?.executionOwner ?? existing.executionOwner,
      turnId: snapshot?.turnId ?? existing.turnId,
      lastActivityAtMs: snapshot?.activityAtMs ?? existing.lastActivityAtMs,
      stage: snapshot?.stage ?? existing.stage,
      answer: snapshot?.answer ?? existing.answer,
      syncedAtMs: nowMs,
      history: cleanedHistory,
    }, this.#canonicalizeProjectRoot);
    const metadataChanged = next && taskMetadataChanged(existing, next);
    const historyChanged = JSON.stringify(existing.history ?? []) !== JSON.stringify(cleanedHistory);
    if (!next || (!metadataChanged && !historyChanged)) return false;
    this.#transaction(() => {
      this.#writeTask(next);
      if (historyChanged) this.#writeHistory(next, cleanedHistory);
      this.#prune();
    });
    return true;
  }

  history(task) {
    return cleanHistory(this.#readHistory(task), this.#historyLimit);
  }

  snapshot(task, {
    nowMs = Date.now(),
    runningFreshnessMs = DEFAULT_RUNNING_FRESHNESS_MS,
  } = {}) {
    const value = this.#readTask(task);
    if (!value) return null;
    const activityAtMs = Number(value.lastActivityAtMs ?? value.syncedAtMs);
    const active = value.running
      && Number.isFinite(activityAtMs)
      && nowMs - activityAtMs <= runningFreshnessMs;
    return {
      active,
      completed: !active,
      turnId: active ? value.turnId : null,
      activityAtMs: activityAtMs || null,
      executionOwner: active ? value.executionOwner : null,
      stage: value.stage,
      answer: value.answer,
    };
  }

  save() {
    return Promise.resolve();
  }

  close() {
    this.#database?.close();
    this.#database = null;
  }
}
