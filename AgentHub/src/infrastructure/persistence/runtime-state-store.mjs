import { copyFile, mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { readJsonWithBackup } from "../../../state-store.mjs";

const BUSY_TIMEOUT_MS = 5_000;

export function runtimeDatabasePath(dataDir) {
  return path.join(path.resolve(dataDir), "runtime.sqlite");
}

export function configureRuntimeDatabase(database) {
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS};
    CREATE TABLE IF NOT EXISTS runtime_state (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS telegram_message_bindings (
      chat_id INTEGER NOT NULL,
      message_id INTEGER NOT NULL,
      provider TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      project_root TEXT NOT NULL,
      task_title TEXT,
      created_at TEXT,
      created_ms INTEGER,
      updated_ms INTEGER NOT NULL,
      binding_json TEXT NOT NULL,
      PRIMARY KEY (chat_id, message_id)
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS telegram_message_bindings_recent_idx
      ON telegram_message_bindings(updated_ms DESC, chat_id, message_id);
    CREATE TABLE IF NOT EXISTS runtime_store_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    ) WITHOUT ROWID;
  `);
}

export function openRuntimeDatabase(dataDir, { readOnly = false } = {}) {
  const database = new DatabaseSync(runtimeDatabasePath(dataDir), readOnly ? { readOnly: true } : {});
  if (!readOnly) configureRuntimeDatabase(database);
  else database.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS};`);
  return database;
}

function parseStateRow(row) {
  if (!row?.value_json) return null;
  return JSON.parse(row.value_json);
}

export function readRuntimeStateSync(dataDir) {
  let database;
  try {
    database = openRuntimeDatabase(dataDir, { readOnly: true });
    return parseStateRow(database.prepare(
      "SELECT value_json FROM runtime_state WHERE key = 'main'",
    ).get());
  } catch (error) {
    if (/unable to open database file|no such table/iu.test(String(error?.message ?? error))) return null;
    throw error;
  } finally {
    database?.close();
  }
}

export async function readRuntimeState(dataDir, {
  legacyFile = path.join(dataDir, "state.json"),
  legacyBackupFile = `${legacyFile}.bak`,
} = {}) {
  const current = readRuntimeStateSync(dataDir);
  if (current) return current;
  return (await readJsonWithBackup(legacyFile, { backupFile: legacyBackupFile })).value;
}

async function existingFiles(files) {
  const result = [];
  for (const file of files) {
    try {
      if ((await stat(file)).isFile()) result.push(file);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return result;
}

async function archiveLegacyFiles(dataDir, files, label) {
  const present = await existingFiles(files);
  if (!present.length) return [];
  const directory = path.join(path.resolve(dataDir), "migrations", "runtime-sqlite", label);
  await mkdir(directory, { recursive: true });
  const archived = [];
  for (const source of present) {
    let target = path.join(directory, path.basename(source));
    if (await stat(target).then(() => true, () => false)) {
      target = path.join(directory, `${Date.now()}-${path.basename(source)}`);
    }
    try {
      await rename(source, target);
    } catch (error) {
      if (error?.code === "EXDEV") {
        await copyFile(source, target);
        await rm(source, { force: true });
      } else if (error?.code === "ENOENT") {
        continue;
      } else {
        throw error;
      }
    }
    archived.push(target);
  }
  return archived;
}

export class RuntimeStateStore {
  #database;
  #dataDir;
  #legacyFile;
  #legacyBackupFile;

  constructor({ dataDir, legacyFile = path.join(dataDir, "state.json"), legacyBackupFile = `${legacyFile}.bak` }) {
    this.#dataDir = path.resolve(dataDir);
    this.#legacyFile = path.resolve(legacyFile);
    this.#legacyBackupFile = path.resolve(legacyBackupFile);
    this.#database = openRuntimeDatabase(this.#dataDir);
  }

  async load() {
    const current = parseStateRow(this.#database.prepare(
      "SELECT value_json FROM runtime_state WHERE key = 'main'",
    ).get());
    if (current) {
      await archiveLegacyFiles(
        this.#dataDir,
        [this.#legacyFile, this.#legacyBackupFile],
        "state",
      );
      return { value: current, source: runtimeDatabasePath(this.#dataDir), recovered: false };
    }

    const legacy = await readJsonWithBackup(this.#legacyFile, { backupFile: this.#legacyBackupFile });
    if (!legacy.value) return { value: null, source: null, recovered: false };
    this.save(legacy.value);
    await archiveLegacyFiles(
      this.#dataDir,
      [this.#legacyFile, this.#legacyBackupFile],
      "state",
    );
    return {
      value: legacy.value,
      source: legacy.source,
      recovered: legacy.recovered,
      migrated: true,
    };
  }

  read() {
    return parseStateRow(this.#database.prepare(
      "SELECT value_json FROM runtime_state WHERE key = 'main'",
    ).get());
  }

  save(value) {
    const content = JSON.stringify(value);
    const now = new Date().toISOString();
    this.#database.prepare(`
      INSERT INTO runtime_state (key, value_json, updated_at)
      VALUES ('main', ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value_json = excluded.value_json,
        updated_at = excluded.updated_at
    `).run(content, now);
  }

  close() {
    this.#database?.close();
    this.#database = null;
  }
}
