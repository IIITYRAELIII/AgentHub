import { backup, DatabaseSync } from "node:sqlite";
import { copyFile, lstat, mkdir, open, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { packageFile } from "../filesystem/runtime-package-target.mjs";
import { protectRuntimeDirectory } from "../filesystem/runtime-security.mjs";
import { observeInterprocessLockDirectories } from "../process/interprocess-lock.mjs";

// Declared mutable state, not a full-data/disk backup (ADR-HUB-380).
const scope = "runtime-durable-state-v1";
const durableDirectories = new Set([".mini-app-control-result-outbox", "background-jobs",
  "delivery-outbox", "failed-updates", "claude-runs", "locks", "task-diff-indexes", "task-custody"]);
const retainedDirectories = new Set(["task-worktrees", "dev-worktrees", "prerelease-worktrees",
  "integration-worktrees", "release-gens", "release-repositories", "release-operation-executions",
  "retained-runtime-sources", "runtime-source-captures", "audio", "images", "tts", "models",
  "backups", "migrations", "WIP"]);
const sqliteHeader = Buffer.from("SQLite format 3\0");
const identity = (info) => ({ dev: String(info.dev), ino: String(info.ino) });
const equal = (a, b) => a.dev === b.dev && a.ino === b.ino;

async function plain(file, type) {
  const info = await lstat(file, { bigint: true });
  if (info.isSymbolicLink() || !(type === "directory" ? info.isDirectory() : info.isFile())) {
    throw new Error("Maintenance backup refuses linked or non-plain state");
  }
  return info;
}

// Read-only support inspection, reused for a fresh stopped inventory.
// No SQLite open/transaction, data copy or retained-tree descent.
export async function inspectRuntimeBackupScope({ runtimeRoot }) {
  return inspectScope({ runtimeRoot });
}

// Admission is open here. Only the actual in-process lock producer can identify
// its ephemeral directories; no ENOENT/name filter applies to durable state.
export async function preflightRuntimeBackupScope({ runtimeRoot }) {
  return observeInterprocessLockDirectories(isOwnedLockDirectory => inspectScope({ runtimeRoot, isOwnedLockDirectory }));
}

async function inspectScope({ runtimeRoot, isOwnedLockDirectory = async () => false }) {
  const root = path.resolve(runtimeRoot), data = path.join(root, "data");
  if (await realpath(root) !== root) throw new Error("Maintenance runtime root must be physical");
  const directories = [], files = [], retained = [];
  async function directory(file, relative) {
    directories.push({ relative, ...identity(await plain(file, "directory")) });
  }
  await directory(root, "");
  await directory(data, "data");
  async function file(source, relative) {
    const before = await plain(source, "file");
    if (relative === path.join("data", "bot.lock")) return;
    const handle = await open(source, "r");
    let sqlite;
    try {
      if (!equal(identity(before), identity(await handle.stat({ bigint: true })))) {
        throw new Error("Maintenance selected file changed");
      }
      const header = Buffer.alloc(16);
      await handle.read(header, 0, header.length, 0);
      sqlite = header.equals(sqliteHeader);
    } finally { await handle.close(); }
    const after = await plain(source, "file");
    if (!equal(identity(before), identity(after))) throw new Error("Maintenance selected file changed");
    if (/\.sqlite$/u.test(relative) && !sqlite) throw new Error("Maintenance SQLite header is unavailable");
    files.push({ source, relative, sqlite, ...identity(before) });
  }
  async function walk(source, relative) {
    const names = (await readdir(source)).sort();
    const parts = relative.split(path.sep);
    const mandatory = parts.length === 3 && parts[1] === "task-custody" && /^[a-f0-9]{32}$/u.test(parts[2])
      && names.some(name => ["repository", "retained-wip"].includes(name)) ? ["intent.json", "snapshot.json"] : [];
    for (const name of mandatory) {
      if (!names.includes(name)) throw new Error("Maintenance custody metadata is incomplete");
      await plain(path.join(source, name), "file");
    }
    for (const name of names) {
      const child = path.join(source, name), childRelative = path.join(relative, name);
      if (mandatory.includes(name)) {
        await file(child, childRelative);
        continue;
      }
      if (await isOwnedLockDirectory(child)) continue;
      const info = await lstat(child, { bigint: true });
      if (info.isSymbolicLink()) throw new Error("Maintenance backup refuses linked state");
      if (info.isDirectory()) {
        const parts = relative.split(path.sep);
        const custodyBody = parts.length === 3 && parts[1] === "task-custody"
          && /^[a-f0-9]{32}$/u.test(parts[2]) && ["repository", "retained-wip"].includes(name);
        if ((relative === "data" && !durableDirectories.has(name)) || custodyBody) {
          retained.push({ path: childRelative, ...identity(info),
            reason: custodyBody || retainedDirectories.has(name) ? "source-or-payload-retained" : "unclassified-not-backed-up" });
        } else {
          await directory(child, childRelative);
          await walk(child, childRelative);
        }
      } else if (info.isFile()) await file(child, childRelative);
      else throw new Error("Maintenance backup refuses unknown state type");
    }
  }
  await walk(data, "data");
  await file(path.join(root, "config.json"), "config.json");
  // Omit a companion only when its actual selected database was found.
  const databases = new Set(files.filter(e => e.sqlite).map(e => e.source));
  const selected = files.filter(entry => {
    if (!/-(?:wal|shm)$/u.test(entry.source)) return true;
    if (!databases.has(entry.source.slice(0, -4))) throw new Error("Maintenance orphan SQLite companion refuses");
    return false;
  });
  const result = { scope, runtimeRoot: root, directories, files: selected, retained };
  await assertIdentities(result);
  return result;
}

async function assertIdentities(inventory) {
  for (const entry of [...inventory.directories, ...inventory.retained]) {
    const file = path.join(inventory.runtimeRoot, entry.relative ?? entry.path);
    if (!equal(entry, identity(await plain(file, "directory")))) throw new Error("Maintenance directory identity changed");
  }
  for (const entry of inventory.files) {
    if (!equal(entry, identity(await plain(entry.source, "file")))) throw new Error("Maintenance selected file changed");
  }
}

async function assertSelectedEntry(inventory, entry) {
  for (let file = path.dirname(entry.source); ; file = path.dirname(file)) {
    const relative = path.relative(inventory.runtimeRoot, file);
    const expected = inventory.directories.find(item => item.relative === relative);
    if (!expected || !equal(expected, identity(await plain(file, "directory")))) {
      throw new Error("Maintenance selected ancestor changed");
    }
    if (!relative) break;
  }
  if (!equal(entry, identity(await plain(entry.source, "file")))) throw new Error("Maintenance selected file changed");
}

export async function assertRuntimeBackupScope(inventory) {
  await assertIdentities(inventory);
  const fresh = await inspectRuntimeBackupScope({ runtimeRoot: inventory.runtimeRoot });
  if (JSON.stringify(fresh) !== JSON.stringify(inventory)) throw new Error("Maintenance backup scope changed");
}

// The native parent holding original empty Job/root gate supplies assertStopped.
// Earlier support inspection never supplies this authority.
export async function backupStoppedRuntime({ runtimeRoot, destination, assertStopped }) {
  await assertStopped();
  const inventory = await inspectRuntimeBackupScope({ runtimeRoot });
  const relative = path.relative(inventory.runtimeRoot, path.resolve(destination));
  // Windows relative() returns an absolute path for a different volume. That
  // is outside the source too; the ordinary exclusive mkdir guard still applies.
  if (!relative || (!path.isAbsolute(relative) && !relative.startsWith(`..${path.sep}`) && relative !== "..")) {
    throw new Error("Maintenance backup destination must be outside runtime root");
  }
  await mkdir(destination); // Exclusive: never overwrite a prior backup.
  await protectRuntimeDirectory(destination);
  const reservations = [], records = [];
  let failure;
  try {
    await assertRuntimeBackupScope(inventory);
    for (const entry of inventory.files.filter(entry => entry.sqlite)) {
      await assertSelectedEntry(inventory, entry);
      const db = new DatabaseSync(entry.source);
      try { db.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE;"); }
      catch (error) { db.close(); throw error; }
      reservations.push(db);
    }
    for (const entry of inventory.files) {
      await assertSelectedEntry(inventory, entry);
      const target = path.join(destination, entry.relative);
      await mkdir(path.dirname(target), { recursive: true });
      if (entry.sqlite) {
        const source = new DatabaseSync(entry.source, { readOnly: true });
        try { await backup(source, target); } finally { source.close(); }
        const check = new DatabaseSync(target, { readOnly: true });
        try {
          if (check.prepare("PRAGMA integrity_check").get().integrity_check !== "ok") {
            throw new Error("Maintenance SQLite backup integrity failed");
          }
        } finally { check.close(); }
      } else {
        const before = await packageFile(entry.source);
        await copyFile(entry.source, target);
        const after = await packageFile(entry.source);
        if (before.sha256 !== after.sha256 || (await packageFile(target)).sha256 !== before.sha256) {
          throw new Error("Maintenance data changed during backup");
        }
      }
      const saved = await packageFile(target);
      await assertSelectedEntry(inventory, entry);
      records.push({ path: entry.relative, bytes: saved.bytes, sha256: saved.sha256,
        ...(entry.sqlite ? { integrity: "ok" } : {}) });
    }
    await assertRuntimeBackupScope(inventory);
    await assertStopped();
    await assertRuntimeBackupScope(inventory);
    return { directory: destination, scope, files: records, retained: inventory.retained,
      wholeDataBackup: false, originalsRestoredOrReplayed: false };
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    const cleanupFailures = [];
    for (const db of reservations.reverse()) {
      try { db.exec("ROLLBACK"); } catch (error) { cleanupFailures.push(error); }
      try { db.close(); } catch (error) { cleanupFailures.push(error); }
    }
    if (cleanupFailures.length) throw new AggregateError(
      [...(failure ? [failure] : []), ...cleanupFailures], "Maintenance backup cleanup failed", { cause: failure });
  }
}
