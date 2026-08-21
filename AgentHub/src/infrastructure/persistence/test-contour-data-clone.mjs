import { randomUUID } from "node:crypto";
import {
  cp,
  mkdir,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import path from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";

const WINDOWS_RENAME_RETRY_MS = 5_000;

function tableExists(database, name) {
  return Boolean(database.prepare(`
    SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?
  `).get(name));
}

function tableColumns(database, name) {
  if (!tableExists(database, name)) return new Set();
  return new Set(database.prepare(`PRAGMA table_info(${name})`).all().map((column) => String(column.name)));
}

function objectFromJson(value) {
  try {
    const parsed = JSON.parse(String(value ?? "{}"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function journalRecordForProject(value, projectRoot) {
  let parsed;
  try {
    parsed = JSON.parse(String(value));
  } catch {
    throw new Error("Production journal contains invalid record_json");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Production journal contains non-object record_json");
  }
  return JSON.stringify({ ...parsed, projectRoot });
}

function migrationTimestamp(now) {
  return now.toISOString().replace(/[:.]/gu, "-");
}

async function fileExists(file) {
  try {
    return (await stat(file)).isFile();
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function pathExists(target) {
  try {
    await stat(target);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function directoryExists(directory) {
  try {
    return (await stat(directory)).isDirectory();
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function snapshotDatabase(sourceFile, destinationFile) {
  await rm(destinationFile, { force: true });
  const source = new DatabaseSync(sourceFile, { readOnly: true });
  source.exec("PRAGMA busy_timeout = 10000");
  try {
    await backup(source, destinationFile);
  } finally {
    source.close();
  }
}

function sanitizeTestContourDatabase(databaseFile, {
  projectRoot,
  model,
  nowMs,
} = {}) {
  const database = new DatabaseSync(databaseFile);
  database.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 10000");
  try {
    for (const table of ["hub_streams", "hub_threads"]) {
      if (!tableExists(database, table)) {
        throw new Error(`Production journal is missing required table: ${table}`);
      }
    }
    const streams = database.prepare("SELECT id, settings_json FROM hub_streams").all();
    const updateStream = database.prepare("UPDATE hub_streams SET settings_json = ? WHERE id = ?");
    let detachedThreads = 0;
    let preservedCatalogTasks = 0;
    let remappedJournalRecords = 0;
    database.exec("BEGIN IMMEDIATE");
    try {
      for (const stream of streams) {
        const settings = {
          ...objectFromJson(stream.settings_json),
          provider: "codex",
          model,
          reasoning: "medium",
          mode: "default",
          project: projectRoot,
          workingDirectory: "",
          autoApprove: true,
        };
        updateStream.run(JSON.stringify(settings), stream.id);
      }
      const threadColumns = tableColumns(database, "hub_threads");
      if (!threadColumns.has("detached_at_ms")) {
        database.exec("ALTER TABLE hub_threads ADD COLUMN detached_at_ms INTEGER");
      }
      detachedThreads = Number(database.prepare(
        "SELECT COUNT(*) AS count FROM hub_threads",
      ).get()?.count ?? 0);
      database.prepare(`
        UPDATE hub_threads
        SET project_root = ?, detached_at_ms = ?
      `).run(projectRoot, nowMs);
      if (tableExists(database, "task_read_model_tasks")) {
        preservedCatalogTasks = Number(database.prepare(
          "SELECT COUNT(*) AS count FROM task_read_model_tasks",
        ).get()?.count ?? 0);
        const taskColumns = tableColumns(database, "task_read_model_tasks");
        const assignments = [];
        const values = [];
        if (taskColumns.has("project_root")) {
          assignments.push("project_root = ?");
          values.push(projectRoot);
        }
        if (taskColumns.has("session_cwd")) {
          assignments.push("session_cwd = ?");
          values.push(projectRoot);
        }
        if (taskColumns.has("running")) assignments.push("running = 0");
        if (taskColumns.has("execution_owner")) assignments.push("execution_owner = NULL");
        if (taskColumns.has("turn_id")) assignments.push("turn_id = NULL");
        if (assignments.length) {
          database.prepare(`UPDATE task_read_model_tasks SET ${assignments.join(", ")}`).run(...values);
        }
      }
      if (tableExists(database, "task_read_model_turns")
        && tableColumns(database, "task_read_model_turns").has("active")) {
        database.exec("UPDATE task_read_model_turns SET active = 0");
      }
      if (tableExists(database, "journal_records")) {
        const recordColumns = tableColumns(database, "journal_records");
        for (const column of ["provider", "thread_id", "turn_id", "project_root", "record_json"]) {
          if (!recordColumns.has(column)) {
            throw new Error(`Production journal_records is missing required column: ${column}`);
          }
        }
        const records = database.prepare(`
          SELECT provider, thread_id, turn_id, record_json FROM journal_records
        `).all();
        const updateRecord = database.prepare(`
          UPDATE journal_records
          SET project_root = ?, record_json = ?
          WHERE provider = ? AND thread_id = ? AND turn_id = ?
        `);
        for (const record of records) {
          updateRecord.run(
            projectRoot,
            journalRecordForProject(record.record_json, projectRoot),
            record.provider,
            record.thread_id,
            record.turn_id,
          );
        }
        remappedJournalRecords = records.length;
      }
      if (tableExists(database, "hub_release_changes")) {
        database.prepare("UPDATE hub_release_changes SET project_root = ?").run(projectRoot);
      }
      if (tableExists(database, "hub_mcp_operations")) {
        database.prepare(`
          UPDATE hub_mcp_operations
          SET status = 'failed', error_text = 'Detached during Test Contour clone',
              completed_at_ms = ?
          WHERE status = 'pending'
        `).run(nowMs);
      }
      if (tableExists(database, "journal_store_meta")) {
        database.prepare(`
          INSERT OR IGNORE INTO journal_store_meta (key, value) VALUES ('revision', '0')
        `).run();
        database.prepare(`
          UPDATE journal_store_meta SET value = CAST(value AS INTEGER) + 1 WHERE key = 'revision'
        `).run();
      }
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
    const integrity = database.prepare("PRAGMA integrity_check").all();
    if (integrity.some((row) => String(row.integrity_check) !== "ok")) {
      throw new Error("Cloned Test Contour journal failed integrity_check");
    }
    const foreignKeys = database.prepare("PRAGMA foreign_key_check").all();
    if (foreignKeys.length) throw new Error("Cloned Test Contour journal has foreign-key violations");
    return {
      streams: streams.length,
      detachedThreads,
      preservedCatalogTasks,
      remappedJournalRecords,
      workspaces: tableExists(database, "hub_workspaces")
        ? Number(database.prepare("SELECT COUNT(*) AS count FROM hub_workspaces").get()?.count ?? 0)
        : 0,
      journalRecords: tableExists(database, "journal_records")
        ? Number(database.prepare("SELECT COUNT(*) AS count FROM journal_records").get()?.count ?? 0)
        : 0,
    };
  } finally {
    database.close();
  }
}

async function moveIfPresent(source, destination) {
  if (!await pathExists(source)) return false;
  const deadline = Date.now() + WINDOWS_RENAME_RETRY_MS;
  while (true) {
    try {
      await rename(source, destination);
      break;
    } catch (error) {
      if (!["EBUSY", "EPERM"].includes(error?.code) || Date.now() >= deadline) throw error;
      await delay(50);
    }
  }
  return true;
}

export async function cloneAttachmentDirectoryToTestContour({
  sourceDirectory,
  destinationDirectory,
} = {}) {
  const source = path.resolve(String(sourceDirectory ?? ""));
  const destination = path.resolve(String(destinationDirectory ?? ""));
  if (!sourceDirectory || !destinationDirectory || source === destination) {
    throw new Error("Test Contour clone requires different attachment directories");
  }
  const temporary = `${destination}.clone-${randomUUID()}`;
  const rollback = `${destination}.rollback-${randomUUID()}`;
  const sourcePresent = await directoryExists(source);
  await rm(temporary, { recursive: true, force: true });
  if (sourcePresent) await cp(source, temporary, { recursive: true, force: true });
  else await mkdir(temporary, { recursive: true });
  let moved = false;
  try {
    moved = await moveIfPresent(destination, rollback);
    try {
      await moveIfPresent(temporary, destination);
    } catch (error) {
      if (moved) await moveIfPresent(rollback, destination);
      throw error;
    }
    await rm(rollback, { recursive: true, force: true });
    return { sourceDirectory: source, destinationDirectory: destination, sourcePresent };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export async function cloneJournalToTestContour({
  sourceDatabaseFile,
  destinationDatabaseFile,
  backupRoot,
  projectRoot,
  model,
  now = new Date(),
} = {}) {
  const source = path.resolve(String(sourceDatabaseFile ?? ""));
  const destination = path.resolve(String(destinationDatabaseFile ?? ""));
  if (!sourceDatabaseFile || !destinationDatabaseFile || source === destination) {
    throw new Error("Test Contour clone requires different source and destination journals");
  }
  if (!projectRoot || !model) throw new Error("Test Contour clone requires projectRoot and model");
  const sourceInfo = await stat(source);
  if (!sourceInfo.isFile()) throw new Error(`Production journal is not a file: ${source}`);
  await mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.clone-${randomUUID()}`;
  const rollback = `${destination}.rollback-${randomUUID()}`;
  const resolvedBackupRoot = path.resolve(
    backupRoot ?? path.join(path.dirname(destination), "backups"),
  );
  await mkdir(resolvedBackupRoot, { recursive: true });
  let previousBackup = null;
  try {
    await snapshotDatabase(source, temporary);
    const stats = sanitizeTestContourDatabase(temporary, {
      projectRoot: path.resolve(projectRoot),
      model,
      nowMs: now.getTime(),
    });
    if (await fileExists(destination)) {
      previousBackup = path.join(
        resolvedBackupRoot,
        `journal-before-clone-${migrationTimestamp(now)}-${randomUUID()}.sqlite`,
      );
      await snapshotDatabase(destination, previousBackup);
    }
    const moved = [];
    if (await moveIfPresent(destination, rollback)) moved.push([rollback, destination]);
    for (const suffix of ["-wal", "-shm"]) {
      if (await moveIfPresent(`${destination}${suffix}`, `${rollback}${suffix}`)) {
        moved.push([`${rollback}${suffix}`, `${destination}${suffix}`]);
      }
    }
    try {
      await moveIfPresent(temporary, destination);
    } catch (error) {
      for (const [from, to] of moved.reverse()) await moveIfPresent(from, to);
      throw error;
    }
    await Promise.all([
      rm(rollback, { force: true }),
      rm(`${rollback}-wal`, { force: true }),
      rm(`${rollback}-shm`, { force: true }),
    ]);
    return {
      sourceDatabaseFile: source,
      destinationDatabaseFile: destination,
      previousBackup,
      model,
      projectRoot: path.resolve(projectRoot),
      ...stats,
    };
  } finally {
    await rm(temporary, { force: true });
  }
}
