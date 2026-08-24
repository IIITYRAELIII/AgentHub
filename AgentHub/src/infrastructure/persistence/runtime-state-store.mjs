import { renameSync } from "node:fs";
import { copyFile, mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";

import { readJsonWithBackup } from "./state-store.mjs";

const BUSY_TIMEOUT_MS = 5_000;

function recoverableDatabaseError(error) {
  return /(?:file is not a database|database disk image is malformed|malformed database schema)/iu
    .test(String(error?.message ?? ""));
}

function preserveCorruptRuntimeDatabase(dataDir) {
  const file = runtimeDatabasePath(dataDir);
  const suffix = `.corrupt-${new Date().toISOString().replaceAll(/[:.]/gu, "-")}`;
  let preserved = false;
  for (const candidate of [file, `${file}-wal`, `${file}-shm`]) {
    try {
      renameSync(candidate, `${candidate}${suffix}`);
      preserved = true;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return preserved;
}

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
    CREATE TABLE IF NOT EXISTS runtime_deferred_intake (
      id TEXT PRIMARY KEY,
      destination TEXT NOT NULL CHECK (destination IN ('pending', 'queued')),
      item_json TEXT NOT NULL,
      receipt_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) WITHOUT ROWID;
  `);
}

export function openRuntimeDatabase(dataDir, { readOnly = false } = {}) {
  const database = new DatabaseSync(runtimeDatabasePath(dataDir), readOnly ? { readOnly: true } : {});
  try {
    if (!readOnly) configureRuntimeDatabase(database);
    else database.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS};`);
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

function parseStateRow(row) {
  if (!row?.value_json) return null;
  return JSON.parse(row.value_json);
}

function readDeferredIntakeRows(database) {
  try {
    return database.prepare(`
      SELECT id, destination, item_json, receipt_json
      FROM runtime_deferred_intake
      ORDER BY created_at, id
    `).all();
  } catch (error) {
    if (/no such table/iu.test(String(error?.message ?? error))) return [];
    throw error;
  }
}

function mergeDeferredIntake(value, rows) {
  if (!rows.length) return value;
  const state = value && typeof value === "object" ? value : {};
  const pendingInputs = Array.isArray(state.pendingInputs) ? state.pendingInputs : [];
  const queuedInputs = Array.isArray(state.queuedInputs) ? state.queuedInputs : [];
  const receipts = Array.isArray(state.desktopMessageReceipts) ? state.desktopMessageReceipts : [];
  const inputIds = new Set([...pendingInputs, ...queuedInputs].map((item) => String(item?.id ?? "")));
  const receiptIds = new Set(receipts.map((receipt) => String(receipt?.clientUserMessageId ?? "")));
  for (const row of rows) {
    const item = JSON.parse(row.item_json);
    const itemId = String(item?.id ?? row.id ?? "");
    if (itemId && !inputIds.has(itemId)) {
      (row.destination === "queued" ? queuedInputs : pendingInputs).push(item);
      inputIds.add(itemId);
    }
    if (!row.receipt_json) continue;
    const receipt = JSON.parse(row.receipt_json);
    const receiptId = String(receipt?.clientUserMessageId ?? "");
    if (receiptId && !receiptIds.has(receiptId)) {
      receipts.push(receipt);
      receiptIds.add(receiptId);
    }
  }
  state.pendingInputs = pendingInputs;
  state.queuedInputs = queuedInputs;
  state.desktopMessageReceipts = receipts;
  return state;
}

function readMergedRuntimeState(database) {
  return mergeDeferredIntake(
    parseStateRow(database.prepare("SELECT value_json FROM runtime_state WHERE key = 'main'").get()),
    readDeferredIntakeRows(database),
  );
}

class RuntimeStateWriter {
  constructor(dataDir) {
    this.sequence = 0;
    this.pending = new Map();
    this.closed = false;
    this.failure = null;
    this.worker = new Worker(new URL("./runtime-state-writer-worker.mjs", import.meta.url), {
      workerData: { dataDir },
    });
    this.exit = new Promise((resolve) => {
      this.worker.once("exit", (code) => {
        this.closed = true;
        if (code !== 0) this.failure ??= new Error(`runtime state writer exited with code ${code}`);
        else if (this.pending.size) this.failure ??= new Error("runtime state writer exited before completing requests");
        if (this.failure) this.#rejectPending(this.failure);
        resolve(code);
      });
    });
    this.worker.on("message", (message) => {
      const request = this.pending.get(message?.id);
      if (!request) return;
      this.pending.delete(message.id);
      if (message.error) {
        const error = new Error(message.error.message);
        error.code = message.error.code;
        error.stack = message.error.stack ?? error.stack;
        request.reject(error);
      } else {
        request.resolve(message.value);
      }
    });
    this.worker.on("error", (error) => {
      this.failure ??= error;
      this.closed = true;
      this.#rejectPending(error);
    });
  }

  request(type, payload = {}) {
    if (this.closed) return Promise.reject(this.failure ?? new Error("runtime state writer is closed"));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.worker.postMessage({ id, type, payload });
      } catch (error) {
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  async close() {
    if (this.closed) {
      await this.exit;
      if (this.failure) throw this.failure;
      return;
    }
    const closing = this.request("close");
    this.closed = true;
    await closing;
    await this.exit;
  }

  #rejectPending(error) {
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
  }
}

export function readRuntimeStateSync(dataDir) {
  let database;
  try {
    database = openRuntimeDatabase(dataDir, { readOnly: true });
    return readMergedRuntimeState(database);
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
  #writer;
  #dataDir;
  #legacyFile;
  #legacyBackupFile;
  #recoveredDatabase = false;

  constructor({ dataDir, legacyFile = path.join(dataDir, "state.json"), legacyBackupFile = `${legacyFile}.bak` }) {
    this.#dataDir = path.resolve(dataDir);
    this.#legacyFile = path.resolve(legacyFile);
    this.#legacyBackupFile = path.resolve(legacyBackupFile);
    try {
      this.#database = openRuntimeDatabase(this.#dataDir);
    } catch (error) {
      if (!recoverableDatabaseError(error) || !preserveCorruptRuntimeDatabase(this.#dataDir)) throw error;
      this.#database = openRuntimeDatabase(this.#dataDir);
      this.#recoveredDatabase = true;
    }
    this.#writer = new RuntimeStateWriter(this.#dataDir);
  }

  async load() {
    const current = readMergedRuntimeState(this.#database);
    if (current) {
      await archiveLegacyFiles(
        this.#dataDir,
        [this.#legacyFile, this.#legacyBackupFile],
        "state",
      );
      return {
        value: current,
        source: runtimeDatabasePath(this.#dataDir),
        recovered: this.#recoveredDatabase,
      };
    }

    const legacy = await readJsonWithBackup(this.#legacyFile, { backupFile: this.#legacyBackupFile });
    if (!legacy.value) return { value: null, source: null, recovered: this.#recoveredDatabase };
    await this.save(legacy.value);
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
    return readMergedRuntimeState(this.#database);
  }

  save(value) {
    return this.#writer.request("save-state", { content: JSON.stringify(value) });
  }

  saveDeferredIntake({ item, destination = "pending", receipt = null }) {
    return this.#writer.request("save-intake", { item, destination, receipt });
  }

  async close() {
    try {
      await this.#writer?.close();
    } finally {
      this.#writer = null;
      this.#database?.close();
      this.#database = null;
    }
  }
}
