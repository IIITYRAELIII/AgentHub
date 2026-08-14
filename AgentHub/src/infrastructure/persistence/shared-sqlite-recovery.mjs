import { randomUUID } from "node:crypto";
import * as fsPromises from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { DatabaseSync } from "node:sqlite";

import { processIsAlive } from "../process/process-liveness.mjs";
import { withInterprocessLocks } from "../process/interprocess-lock.mjs";

export const SQLITE_RECOVERY_RESTART_REQUIRED = "SQLITE_RECOVERY_RESTART_REQUIRED";

function recoveryError(code, message, { cause, details } = {}) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  if (details) error.details = details;
  return error;
}

function recoverableDatabaseError(error) {
  return /(?:file is not a database|database disk image is malformed|malformed database schema)/iu
    .test(String(error?.message ?? ""));
}

async function optionalStat(file, fileSystem) {
  try {
    return await fileSystem.stat(file);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function optionalJson(file, fileSystem) {
  try {
    return JSON.parse(await fileSystem.readFile(file, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    if (error instanceof SyntaxError) {
      throw recoveryError("SQLITE_RECOVERY_METADATA_INVALID", `Invalid SQLite recovery metadata: ${file}`, {
        cause: error,
      });
    }
    throw error;
  }
}

export async function writeAtomicJson(file, value, fileSystem = fsPromises) {
  await fileSystem.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}-${randomUUID()}`;
  let handle = null;
  try {
    handle = await fileSystem.open(temporary, "wx");
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await fileSystem.rename(temporary, file);
  } catch (error) {
    await handle?.close().catch(() => {});
    await fileSystem.unlink(temporary).catch(() => {});
    throw error;
  }
}

function validateMetadata(value, databaseFile, kind) {
  if (Number(value?.version) !== 1 || path.resolve(value?.databaseFile ?? "") !== databaseFile) {
    throw recoveryError("SQLITE_RECOVERY_METADATA_INVALID", `Invalid SQLite recovery ${kind}`);
  }
  return value;
}

function validateRecoveryPaths(value, databaseFile, kind) {
  const metadata = validateMetadata(value, databaseFile, kind);
  const quarantineDirectory = path.resolve(metadata.quarantineDirectory ?? "");
  if (!quarantineDirectory.startsWith(`${databaseFile}.quarantine-`)) {
    throw recoveryError("SQLITE_RECOVERY_METADATA_INVALID", `Invalid SQLite recovery ${kind} quarantine path`);
  }
  return { metadata, quarantineDirectory };
}

function validateIntent(value, databaseFile) {
  const { metadata, quarantineDirectory } = validateRecoveryPaths(value, databaseFile, "intent");
  const allowedSources = new Set([databaseFile, `${databaseFile}-wal`, `${databaseFile}-shm`]);
  if (!Array.isArray(metadata.files) || !metadata.files.length) {
    throw recoveryError("SQLITE_RECOVERY_METADATA_INVALID", "Invalid SQLite recovery intent files");
  }
  for (const entry of metadata.files) {
    const source = path.resolve(entry?.source ?? "");
    const destination = path.resolve(entry?.destination ?? "");
    if (!allowedSources.has(source)
      || path.dirname(destination) !== quarantineDirectory
      || path.basename(destination) !== path.basename(source)) {
      throw recoveryError("SQLITE_RECOVERY_METADATA_INVALID", "Invalid SQLite recovery intent path");
    }
  }
  return metadata;
}

function validateMarker(value, databaseFile) {
  const { metadata, quarantineDirectory } = validateRecoveryPaths(value, databaseFile, "marker");
  if (path.resolve(metadata.evidenceFile ?? "") !== path.join(quarantineDirectory, "evidence.json")) {
    throw recoveryError("SQLITE_RECOVERY_METADATA_INVALID", "Invalid SQLite recovery evidence path");
  }
  return metadata;
}

export class SharedSqliteRecoveryCoordinator {
  #databaseFile;
  #lockFile;
  #intentFile;
  #markerFile;
  #fileSystem;
  #writeJson;
  #databaseFactory;
  #now;
  #idFactory;
  #isAlive;
  #pid;
  #instanceId;
  #withDatabaseLock;

  constructor({
    databaseFile,
    instanceId = randomUUID(),
    fileSystem = fsPromises,
    writeJson = writeAtomicJson,
    databaseFactory = (file, options) => new DatabaseSync(file, options),
    now = () => new Date(),
    idFactory = randomUUID,
    isAlive = processIsAlive,
    pid = process.pid,
    withDatabaseLock = (operation) => withInterprocessLocks([path.resolve(databaseFile)], operation),
  } = {}) {
    if (!databaseFile) throw new TypeError("SharedSqliteRecoveryCoordinator databaseFile is required");
    this.#databaseFile = path.resolve(databaseFile);
    this.#lockFile = `${this.#databaseFile}.recovery.lock`;
    this.#intentFile = `${this.#databaseFile}.recovery-intent.json`;
    this.#markerFile = `${this.#databaseFile}.recovery-marker.json`;
    this.#fileSystem = fileSystem;
    this.#writeJson = writeJson;
    this.#databaseFactory = databaseFactory;
    this.#now = now;
    this.#idFactory = idFactory;
    this.#isAlive = isAlive;
    this.#pid = pid;
    this.#instanceId = String(instanceId);
    this.#withDatabaseLock = withDatabaseLock;
  }

  get markerFile() {
    return this.#markerFile;
  }

  async #acquireLock() {
    await this.#fileSystem.mkdir(path.dirname(this.#lockFile), { recursive: true });
    const token = this.#idFactory();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let handle;
      let created = false;
      try {
        handle = await this.#fileSystem.open(this.#lockFile, "wx");
        created = true;
        await handle.writeFile(`${JSON.stringify({
          version: 1,
          pid: this.#pid,
          instanceId: this.#instanceId,
          token,
          acquiredAt: this.#now().toISOString(),
        })}\n`, "utf8");
        await handle.sync();
        return { handle, token };
      } catch (error) {
        await handle?.close().catch(() => {});
        if (created) await this.#fileSystem.unlink(this.#lockFile).catch(() => {});
        if (error?.code !== "EEXIST") throw error;
        const existing = await optionalJson(this.#lockFile, this.#fileSystem).catch((readError) => {
          if (readError?.code === "SQLITE_RECOVERY_METADATA_INVALID") return null;
          throw readError;
        });
        if (existing?.instanceId === this.#instanceId
          || (!existing?.instanceId && Number.isSafeInteger(existing?.pid) && this.#isAlive(existing.pid))) {
          throw recoveryError("SQLITE_RECOVERY_LOCKED", "Shared SQLite recovery is already running");
        }
        await this.#fileSystem.unlink(this.#lockFile).catch((unlinkError) => {
          if (unlinkError?.code !== "ENOENT") throw unlinkError;
        });
      }
    }
    throw recoveryError("SQLITE_RECOVERY_LOCKED", "Cannot acquire shared SQLite recovery lock");
  }

  async #releaseLock(lock) {
    await lock?.handle?.close().catch(() => {});
    const current = await optionalJson(this.#lockFile, this.#fileSystem).catch(() => null);
    if (current?.token === lock?.token) {
      await this.#fileSystem.unlink(this.#lockFile).catch((error) => {
        if (error?.code !== "ENOENT") throw error;
      });
    }
  }

  async #inspectDatabase() {
    const inspectionDirectory = `${this.#databaseFile}.recovery-inspection-${this.#pid}-${this.#idFactory()}`;
    const inspectionFile = path.join(inspectionDirectory, path.basename(this.#databaseFile));
    let database;
    try {
      await this.#fileSystem.mkdir(inspectionDirectory, { recursive: false });
      for (const source of [this.#databaseFile, `${this.#databaseFile}-wal`, `${this.#databaseFile}-shm`]) {
        if (await optionalStat(source, this.#fileSystem)) {
          await this.#fileSystem.copyFile(source, path.join(inspectionDirectory, path.basename(source)));
        }
      }
      database = this.#databaseFactory(inspectionFile, { readOnly: true });
      const rows = database.prepare("PRAGMA quick_check").all();
      const failures = rows.flatMap((row) => Object.values(row)).filter((value) => String(value) !== "ok");
      if (failures.length) {
        return { healthy: false, error: new Error(`SQLite quick_check failed: ${failures.join("; ")}`) };
      }
      return { healthy: true };
    } catch (error) {
      if (recoverableDatabaseError(error)) return { healthy: false, error };
      throw error;
    } finally {
      database?.close();
      await this.#fileSystem.rm(inspectionDirectory, { recursive: true, force: true });
    }
  }

  async #rollbackIntent(intent) {
    const validatedIntent = validateIntent(intent, this.#databaseFile);
    try {
      for (const entry of [...validatedIntent.files].reverse()) {
        const source = path.resolve(entry.source);
        const destination = path.resolve(entry.destination);
        const [sourceInfo, destinationInfo] = await Promise.all([
          optionalStat(source, this.#fileSystem),
          optionalStat(destination, this.#fileSystem),
        ]);
        if (destinationInfo && sourceInfo) {
          throw new Error(`Both SQLite recovery paths exist: ${source} and ${destination}`);
        }
        if (destinationInfo) await this.#fileSystem.rename(destination, source);
        else if (!sourceInfo) throw new Error(`SQLite recovery path is missing: ${source}`);
      }
      await this.#fileSystem.unlink(this.#intentFile).catch((error) => {
        if (error?.code !== "ENOENT") throw error;
      });
      await this.#fileSystem.rm(path.resolve(validatedIntent.quarantineDirectory), { recursive: true, force: true });
    } catch (error) {
      throw recoveryError("SQLITE_RECOVERY_ROLLBACK_FAILED", "Cannot roll back interrupted SQLite quarantine", {
        cause: error,
        details: { intentFile: this.#intentFile },
      });
    }
  }

  async #quarantine(corruption) {
    const recoveryId = this.#idFactory();
    const timestamp = this.#now().toISOString();
    const safeTimestamp = timestamp.replaceAll(/[:.]/gu, "-");
    const quarantineDirectory = `${this.#databaseFile}.quarantine-${safeTimestamp}-${recoveryId}`;
    const sources = [this.#databaseFile, `${this.#databaseFile}-wal`, `${this.#databaseFile}-shm`];
    const files = [];
    for (const source of sources) {
      const info = await optionalStat(source, this.#fileSystem);
      if (!info) continue;
      if (!info.isFile()) throw new Error(`SQLite recovery source is not a regular file: ${source}`);
      files.push({ source, destination: path.join(quarantineDirectory, path.basename(source)), size: info.size });
    }
    if (!files.length) throw corruption;
    const intent = {
      version: 1,
      state: "quarantining",
      recoveryId,
      instanceId: this.#instanceId,
      databaseFile: this.#databaseFile,
      quarantineDirectory,
      createdAt: timestamp,
      files,
    };
    let intentWritten = false;
    let committed = false;
    try {
      await this.#fileSystem.mkdir(quarantineDirectory, { recursive: false });
      await this.#writeJson(this.#intentFile, intent, this.#fileSystem);
      intentWritten = true;
      for (const entry of files) await this.#fileSystem.rename(entry.source, entry.destination);
      const evidenceFile = path.join(quarantineDirectory, "evidence.json");
      const evidence = {
        ...intent,
        state: "quarantined",
        completedAt: this.#now().toISOString(),
        corruption: String(corruption?.message ?? corruption),
      };
      await this.#writeJson(evidenceFile, evidence, this.#fileSystem);
      await this.#writeJson(this.#markerFile, {
        version: 1,
        state: "quarantined",
        recoveryId,
        instanceId: this.#instanceId,
        databaseFile: this.#databaseFile,
        quarantineDirectory,
        evidenceFile,
        createdAt: timestamp,
      }, this.#fileSystem);
      committed = true;
      await this.#fileSystem.unlink(this.#intentFile).catch(() => {});
      throw recoveryError(
        SQLITE_RECOVERY_RESTART_REQUIRED,
        "Shared SQLite database was quarantined; restart Agent Hub to create a replacement",
        { details: { recoveryId, evidenceFile, quarantineDirectory } },
      );
    } catch (error) {
      if (committed) throw error;
      if (intentWritten) await this.#rollbackIntent(intent);
      else await this.#fileSystem.rm(quarantineDirectory, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }

  async #resume(marker) {
    const validatedMarker = validateMarker(marker, this.#databaseFile);
    if (validatedMarker.instanceId === this.#instanceId) {
      throw recoveryError(
        SQLITE_RECOVERY_RESTART_REQUIRED,
        "Shared SQLite recovery requires a new Agent Hub process",
        { details: { recoveryId: validatedMarker.recoveryId, evidenceFile: validatedMarker.evidenceFile } },
      );
    }
    const evidence = validateIntent(
      await optionalJson(path.resolve(validatedMarker.evidenceFile), this.#fileSystem),
      this.#databaseFile,
    );
    if (evidence.recoveryId !== validatedMarker.recoveryId || evidence.state !== "quarantined") {
      throw recoveryError("SQLITE_RECOVERY_EVIDENCE_INVALID", "SQLite recovery evidence does not match its marker");
    }
    const existing = await optionalStat(this.#databaseFile, this.#fileSystem);
    if (existing) {
      const inspection = await this.#inspectDatabase();
      if (!inspection.healthy) {
        throw recoveryError("SQLITE_RECOVERY_REPLACEMENT_INVALID", "SQLite replacement is corrupt", {
          cause: inspection.error,
        });
      }
    } else {
      await this.#fileSystem.mkdir(path.dirname(this.#databaseFile), { recursive: true });
      const replacementFile = `${this.#databaseFile}.recovery-replacement.tmp`;
      let database;
      try {
        await this.#fileSystem.unlink(replacementFile).catch((error) => {
          if (error?.code !== "ENOENT") throw error;
        });
        database = this.#databaseFactory(replacementFile, {});
        database.exec("PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL;");
        const rows = database.prepare("PRAGMA quick_check").all();
        if (rows.some((row) => Object.values(row).some((value) => String(value) !== "ok"))) {
          throw new Error("SQLite replacement quick_check failed");
        }
        database.close();
        database = null;
        await this.#fileSystem.rename(replacementFile, this.#databaseFile);
      } catch (error) {
        await this.#fileSystem.unlink(replacementFile).catch(() => {});
        throw error;
      } finally {
        database?.close();
      }
    }
    return {
      degraded: true,
      recoveryId: validatedMarker.recoveryId,
      evidenceFile: path.resolve(validatedMarker.evidenceFile),
      quarantineDirectory: path.resolve(validatedMarker.quarantineDirectory),
      message: "journal.sqlite was replaced after quarantining a corrupt database",
    };
  }

  async prepare() {
    return this.#withDatabaseLock(async () => {
      const lock = await this.#acquireLock();
      try {
        const marker = await optionalJson(this.#markerFile, this.#fileSystem);
        if (marker) return await this.#resume(marker);
        const intent = await optionalJson(this.#intentFile, this.#fileSystem);
        if (intent) await this.#rollbackIntent(intent);
        const databaseInfo = await optionalStat(this.#databaseFile, this.#fileSystem);
        if (!databaseInfo) return { degraded: false };
        const inspection = await this.#inspectDatabase();
        if (inspection.healthy) return { degraded: false };
        return await this.#quarantine(inspection.error);
      } finally {
        await this.#releaseLock(lock);
      }
    });
  }

  async acknowledge(recovery) {
    if (!recovery?.degraded || !recovery?.recoveryId) return false;
    const lock = await this.#acquireLock();
    try {
      const marker = await optionalJson(this.#markerFile, this.#fileSystem);
      if (!marker) return false;
      const validatedMarker = validateMarker(marker, this.#databaseFile);
      if (validatedMarker.recoveryId !== recovery.recoveryId) {
        throw recoveryError("SQLITE_RECOVERY_MARKER_CHANGED", "SQLite recovery marker changed before acknowledgement");
      }
      await this.#fileSystem.unlink(this.#markerFile);
      await this.#fileSystem.unlink(this.#intentFile).catch((error) => {
        if (error?.code !== "ENOENT") throw error;
      });
      return true;
    } finally {
      await this.#releaseLock(lock);
    }
  }
}
