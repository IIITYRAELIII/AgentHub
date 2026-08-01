import crypto from "node:crypto";
import { watch } from "node:fs";
import { mkdir, readFile, rename, stat } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { buildLazyJournalPayload } from "./mini-app-journal-data.mjs";

const SCHEMA_VERSION = 1;

function configure(database) {
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS journal_meta (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      schema_version INTEGER NOT NULL,
      source_version TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      html TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS journal_days (
      date TEXT PRIMARY KEY,
      html TEXT NOT NULL
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS journal_turns (
      id TEXT PRIMARY KEY,
      html TEXT NOT NULL
    ) WITHOUT ROWID;
  `);
}

function recoverableDatabaseError(error) {
  return /(?:file is not a database|database disk image is malformed|malformed database schema)/iu
    .test(String(error?.message ?? ""));
}

function publicIndex(row) {
  if (!row) return null;
  return {
    html: String(row.html ?? ""),
    updatedAt: String(row.updated_at ?? ""),
    version: String(row.source_version ?? ""),
  };
}

function sourceIdentity(info) {
  return [
    info.dev,
    info.ino,
    info.size,
    info.mtimeMs,
    info.ctimeMs,
    info.birthtimeMs,
  ].map((value) => String(value ?? "")).join(":");
}

function sha256Version(markdown) {
  return `sha256:${crypto.createHash("sha256").update(markdown, "utf8").digest("hex")}`;
}

function samePath(left, right) {
  const normalize = (value) => process.platform === "win32" ? value.toLowerCase() : value;
  return normalize(path.resolve(left)) === normalize(path.resolve(right));
}

export class JournalDatabase {
  #database = null;
  #file;
  #readSource;
  #statSource;
  #watchSource;
  #hashSource;
  #source = null;

  constructor(file, {
    readSource = readFile,
    statSource = stat,
    watchSource = watch,
    hashSource = sha256Version,
  } = {}) {
    this.#file = path.resolve(file);
    this.#readSource = readSource;
    this.#statSource = statSource;
    this.#watchSource = watchSource;
    this.#hashSource = hashSource;
  }

  async #open() {
    if (this.#database) return this.#database;
    await mkdir(path.dirname(this.#file), { recursive: true });
    let database;
    try {
      database = new DatabaseSync(this.#file);
      configure(database);
    } catch (error) {
      database?.close();
      if (!recoverableDatabaseError(error)) throw error;
      const suffix = `.corrupt-${new Date().toISOString().replaceAll(/[:.]/gu, "-")}`;
      let preserved = false;
      for (const candidate of [this.#file, `${this.#file}-wal`, `${this.#file}-shm`]) {
        try {
          await rename(candidate, `${candidate}${suffix}`);
          preserved = true;
        } catch (renameError) {
          if (renameError?.code !== "ENOENT") throw renameError;
        }
      }
      if (!preserved) throw error;
      database = new DatabaseSync(this.#file);
      configure(database);
    }
    this.#database = database;
    return database;
  }

  #sourceState(target) {
    if (this.#source?.target === target) return this.#source;
    this.#source?.watcher?.close?.();
    const source = {
      target,
      generation: 0,
      identity: null,
      index: null,
      pending: null,
      watcher: null,
    };
    const directory = path.dirname(target);
    const basename = path.basename(target);
    try {
      source.watcher = this.#watchSource(directory, (_eventType, filename) => {
        if (filename === null || filename === undefined
          || samePath(path.join(directory, String(filename)), path.join(directory, basename))) {
          source.generation += 1;
        }
      });
      source.watcher.unref?.();
      source.watcher.on?.("error", () => {
        source.generation += 1;
        source.watcher?.close?.();
        source.watcher = null;
      });
    } catch {
      // Stat identity remains the correctness fallback when the platform does
      // not provide a usable directory watcher.
    }
    this.#source = source;
    return source;
  }

  async #ensureFromFile(target, source) {
    const initialInfo = await this.#statSource(target);
    const initialIdentity = sourceIdentity(initialInfo);
    const initialGeneration = source.generation;
    if (source.index
      && source.identity === initialIdentity
      && source.index.generation === initialGeneration) {
      return source.index.value;
    }

    let markdown;
    let stableInfo;
    let stableIdentity;
    let stableGeneration;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const beforeInfo = attempt === 0 ? initialInfo : await this.#statSource(target);
      const beforeIdentity = sourceIdentity(beforeInfo);
      const beforeGeneration = source.generation;
      markdown = await this.#readSource(target, "utf8");
      const afterInfo = await this.#statSource(target);
      const afterIdentity = sourceIdentity(afterInfo);
      const afterGeneration = source.generation;
      if (beforeIdentity === afterIdentity && beforeGeneration === afterGeneration) {
        stableInfo = afterInfo;
        stableIdentity = afterIdentity;
        stableGeneration = afterGeneration;
        break;
      }
    }
    if (!stableInfo) throw new Error("WORK_LOG changed repeatedly while rebuilding its journal index");

    const version = this.#hashSource(markdown);
    const database = await this.#open();
    const current = database.prepare(
      "SELECT schema_version, source_version, updated_at, html FROM journal_meta WHERE id = 1",
    ).get();
    if (Number(current?.schema_version ?? SCHEMA_VERSION) === SCHEMA_VERSION
      && String(current?.source_version ?? "") === version) {
      const value = publicIndex(current);
      source.identity = stableIdentity;
      source.index = { generation: stableGeneration, value };
      return value;
    }

    const payload = buildLazyJournalPayload(markdown);
    const updatedAt = stableInfo.mtime.toISOString();
    database.exec("BEGIN IMMEDIATE");
    try {
      const latest = database.prepare(
        "SELECT schema_version, source_version, updated_at, html FROM journal_meta WHERE id = 1",
      ).get();
      if (Number(latest?.schema_version ?? 0) === SCHEMA_VERSION
        && String(latest?.source_version ?? "") === version) {
        database.exec("COMMIT");
        const value = publicIndex(latest);
        source.identity = stableIdentity;
        source.index = { generation: stableGeneration, value };
        return value;
      }
      database.exec("DELETE FROM journal_days; DELETE FROM journal_turns;");
      const insertDay = database.prepare(
        "INSERT INTO journal_days (date, html) VALUES (?, ?)",
      );
      for (const [date, html] of Object.entries(payload.days)) insertDay.run(date, html);
      const insertTurn = database.prepare(
        "INSERT INTO journal_turns (id, html) VALUES (?, ?)",
      );
      for (const [id, html] of Object.entries(payload.turns)) insertTurn.run(id, html);
      database.prepare(`
        INSERT INTO journal_meta (id, schema_version, source_version, updated_at, html)
        VALUES (1, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          schema_version = excluded.schema_version,
          source_version = excluded.source_version,
          updated_at = excluded.updated_at,
          html = excluded.html
      `).run(SCHEMA_VERSION, version, updatedAt, payload.html);
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
    const value = { html: payload.html, updatedAt, version };
    source.identity = stableIdentity;
    source.index = { generation: stableGeneration, value };
    return value;
  }

  async ensureFromFile(workLogFile) {
    const target = path.resolve(workLogFile);
    const source = this.#sourceState(target);
    if (source.pending) return source.pending;
    source.pending = this.#ensureFromFile(target, source);
    try {
      return await source.pending;
    } finally {
      source.pending = null;
    }
  }

  async fragment(kind, key) {
    const database = await this.#open();
    const table = kind === "day" ? "journal_days" : "journal_turns";
    const column = kind === "day" ? "date" : "id";
    const row = database.prepare(`SELECT html FROM ${table} WHERE ${column} = ?`).get(String(key));
    return typeof row?.html === "string" ? row.html : null;
  }

  close() {
    this.#source?.watcher?.close?.();
    this.#source = null;
    this.#database?.close();
    this.#database = null;
  }
}
