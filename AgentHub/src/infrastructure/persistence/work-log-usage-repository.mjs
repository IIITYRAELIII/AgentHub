import { copyFile, mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";

import {
  ledgerRecordChanges,
  ledgerRecordSnapshot,
} from "./incremental-ledger.mjs";
import { JournalDatabase } from "./journal-database.mjs";
import { writeTextAtomic } from "./state-store.mjs";
import { withInterprocessLocks } from "../process/interprocess-lock.mjs";

export class WorkLogUsageRepository {
  #ledgerFile;
  #databaseFile;
  #database;
  #quarantineFile;
  #normalizePersisted;
  #loaded = false;
  #loadedRevision = -1;
  #ledger = { version: 8, turns: {} };
  #recordSnapshot = new Map();
  #tail = Promise.resolve();

  constructor({
    ledgerFile,
    databaseFile = path.join(path.dirname(path.resolve(ledgerFile)), "journal.sqlite"),
    journalDatabase = null,
    normalizePersisted,
  } = {}) {
    if (typeof normalizePersisted !== "function") {
      throw new TypeError("WorkLogUsageRepository requires normalizePersisted");
    }
    this.#ledgerFile = path.resolve(ledgerFile);
    this.#databaseFile = path.resolve(databaseFile);
    this.#database = journalDatabase ?? new JournalDatabase(this.#databaseFile);
    this.#quarantineFile = `${this.#ledgerFile}.invalid-records.json`;
    this.#normalizePersisted = normalizePersisted;
  }

  get databaseFile() {
    return this.#databaseFile;
  }

  get ledger() {
    if (!this.#loaded) throw new Error("Work-log repository is not loaded");
    return this.#ledger;
  }

  async #load() {
    let imported = null;
    let persisted = null;
    try {
      imported = await this.#database.importLegacyLedger(this.#ledgerFile);
    } catch (error) {
      persisted = await this.#database.loadLedger();
      if (!Object.keys(persisted?.turns ?? {}).length) throw error;
      console.error(
        `Ignored unreadable retired work-log ledger ${this.#ledgerFile}; SQLite already contains the journal records: ${String(error?.message ?? error)}`,
      );
    }
    const revision = await this.#database.currentRevision();
    if (this.#loaded && revision === this.#loadedRevision) return;
    persisted ??= await this.#database.loadLedger();
    const normalized = this.#normalizePersisted(persisted);
    this.#ledger = normalized.ledger;
    this.#recordSnapshot = ledgerRecordSnapshot(this.#ledger.turns);
    if (normalized.invalidRecords.length) {
      await mkdir(path.dirname(this.#quarantineFile), { recursive: true });
      await writeTextAtomic(
        this.#quarantineFile,
        `${JSON.stringify({
          detectedAt: new Date().toISOString(),
          source: imported?.imported ? this.#ledgerFile : this.#databaseFile,
          records: normalized.invalidRecords,
        }, null, 2)}\n`,
      );
      console.error(
        `Quarantined ${normalized.invalidRecords.length} invalid work-log ledger record(s) in ${this.#quarantineFile}`,
      );
    }
    this.#loaded = true;
    this.#loadedRevision = revision;
    if (normalized.migrated || normalized.invalidRecords.length) {
      await this.save({ forceCheckpoint: true });
    }
  }

  async save({ forceCheckpoint = false } = {}) {
    const changes = ledgerRecordChanges(this.#ledger.turns, this.#recordSnapshot);
    if (!forceCheckpoint && !changes.events.length) return;
    if (forceCheckpoint) {
      const result = await this.#database.replaceLedger(this.#ledger);
      this.#loadedRevision = result.revision;
    } else {
      const upserts = changes.events
        .filter((event) => event.op === "upsert")
        .map((event) => event.record);
      const deletions = changes.events
        .filter((event) => event.op === "delete")
        .map((event) => {
          const [provider, threadId, turnId] = String(event.key).split("\0");
          return { provider, threadId, turnId };
        });
      if (upserts.length) {
        const result = await this.#database.upsertRecords(upserts);
        this.#loadedRevision = result.revision;
      }
      if (deletions.length) {
        const result = await this.#database.deleteRecords(deletions);
        this.#loadedRevision = result.revision;
      }
    }
    this.#recordSnapshot = changes.snapshot;
  }

  enqueue(operation) {
    const queued = this.#tail.catch(() => {}).then(() => withInterprocessLocks(
      [this.#databaseFile],
      async () => {
        await this.#load();
        return operation();
      },
    ));
    this.#tail = queued;
    return queued;
  }

  payload() {
    return this.#database.payload();
  }

  snapshot() {
    return this.#database.snapshot();
  }

  async replaceProjection(payload, options = {}) {
    const result = await this.#database.replaceProjection(payload, options);
    this.#loadedRevision = result.revision;
    return result;
  }

  retireLegacyStorage({
    workLogFile = null,
    backupRoot = path.join(path.dirname(this.#ledgerFile), "migrations"),
    now = new Date(),
  } = {}) {
    const operation = this.#tail.catch(() => {}).then(() => withInterprocessLocks(
      [this.#databaseFile],
      async () => {
        const imported = await this.#database.importLegacyLedger(this.#ledgerFile);
        const verification = await this.#database.verifyLegacyLedger(this.#ledgerFile);
        if (!verification.verified) {
          const error = new Error(
            `Legacy work-log storage does not match SQLite: ${JSON.stringify({
              reason: verification.reason ?? "mismatch",
              invalid: verification.invalid ?? 0,
              missing: verification.missing?.length ?? 0,
              mismatched: verification.mismatched?.length ?? 0,
              extra: verification.extra?.length ?? 0,
            })}`,
          );
          error.code = "WORK_LOG_LEGACY_VERIFICATION_FAILED";
          error.verification = verification;
          throw error;
        }

        const sources = [...new Set([
          this.#ledgerFile,
          `${this.#ledgerFile}.bak`,
          `${this.#ledgerFile}.delta.jsonl`,
          this.#quarantineFile,
          workLogFile ? path.resolve(workLogFile) : null,
        ].filter(Boolean))];
        const existing = [];
        for (const source of sources) {
          try {
            const info = await stat(source);
            if (info.isFile()) existing.push({ source, size: info.size });
          } catch (error) {
            if (error?.code !== "ENOENT") throw error;
          }
        }

        const timestamp = now.toISOString().replace(/[:.]/gu, "-");
        const backupDirectory = path.join(path.resolve(backupRoot), `sqlite-cutover-${timestamp}`);
        await mkdir(backupDirectory, { recursive: true });
        const archived = [];
        const usedNames = new Set();
        for (const item of existing) {
          const originalName = path.basename(item.source);
          let backupName = originalName;
          for (let suffix = 2; usedNames.has(backupName); suffix += 1) {
            backupName = `${suffix}-${originalName}`;
          }
          usedNames.add(backupName);
          const backupFile = path.join(backupDirectory, backupName);
          await copyFile(item.source, backupFile);
          archived.push({ ...item, backupFile });
        }
        for (const item of existing) await rm(item.source, { force: true });
        return {
          retired: true,
          imported,
          verification,
          backupDirectory,
          archived,
          removed: existing.map((item) => item.source),
        };
      },
    ));
    this.#tail = operation;
    return operation;
  }

  async close() {
    await this.#tail.catch(() => {});
    this.#database.close();
  }
}
