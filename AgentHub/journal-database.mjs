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

export class JournalDatabase {
  #database = null;
  #file;

  constructor(file) {
    this.#file = path.resolve(file);
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

  async ensureFromFile(workLogFile) {
    const target = path.resolve(workLogFile);
    const info = await stat(target);
    const version = `${Math.trunc(info.mtimeMs)}-${info.size}`;
    const database = await this.#open();
    const current = database.prepare(
      "SELECT schema_version, source_version, updated_at, html FROM journal_meta WHERE id = 1",
    ).get();
    if (Number(current?.schema_version ?? SCHEMA_VERSION) === SCHEMA_VERSION
      && String(current?.source_version ?? "") === version) {
      return publicIndex(current);
    }

    const markdown = await readFile(target, "utf8");
    const verifiedInfo = await stat(target);
    const verifiedVersion = `${Math.trunc(verifiedInfo.mtimeMs)}-${verifiedInfo.size}`;
    if (verifiedVersion !== version) return this.ensureFromFile(target);
    const payload = buildLazyJournalPayload(markdown);
    const updatedAt = info.mtime.toISOString();
    database.exec("BEGIN IMMEDIATE");
    try {
      const latest = database.prepare(
        "SELECT schema_version, source_version, updated_at, html FROM journal_meta WHERE id = 1",
      ).get();
      if (Number(latest?.schema_version ?? 0) === SCHEMA_VERSION
        && String(latest?.source_version ?? "") === version) {
        database.exec("COMMIT");
        return publicIndex(latest);
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
    return { html: payload.html, updatedAt, version };
  }

  async fragment(kind, key) {
    const database = await this.#open();
    const table = kind === "day" ? "journal_days" : "journal_turns";
    const column = kind === "day" ? "date" : "id";
    const row = database.prepare(`SELECT html FROM ${table} WHERE ${column} = ?`).get(String(key));
    return typeof row?.html === "string" ? row.html : null;
  }

  close() {
    this.#database?.close();
    this.#database = null;
  }
}
