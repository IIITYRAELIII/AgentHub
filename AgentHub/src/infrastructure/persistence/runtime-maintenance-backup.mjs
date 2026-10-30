import { backup, DatabaseSync } from "node:sqlite";
import { copyFile, lstat, mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { packageFile } from "../filesystem/runtime-package-target.mjs";
import { protectRuntimeDirectory } from "../filesystem/runtime-security.mjs";

// Called only after native cohort retirement while the existing Host root gate
// excludes new launchers. SQLite's backup API includes committed WAL contents;
// copying an open database or its WAL files is never the backup operation.
export async function backupStoppedRuntime({ runtimeRoot, destination, assertStopped }) {
  await assertStopped();
  await mkdir(destination); // Exclusive destination: never overwrite a prior backup.
  await protectRuntimeDirectory(destination);
  const files = [];
  async function walk(directory, prefix) {
    for (const name of (await readdir(directory)).sort()) {
      const source = path.join(directory, name), relative = path.join(prefix, name);
      const info = await lstat(source);
      if (info.isSymbolicLink()) throw new Error("Maintenance backup refuses unknown linked data");
      if (info.isDirectory()) await walk(source, relative);
      else if (info.isFile()) files.push({ source, relative });
      else throw new Error("Maintenance backup refuses unknown data type");
    }
  }
  await walk(path.join(runtimeRoot, "data"), "data");
  files.push({ source: path.join(runtimeRoot, "config.json"), relative: "config.json" });
  const reservations = [];
  const records = [];
  let failure;
  try {
    // Hold all known SQLite writer reservations together, through the entire
    // snapshot. A foreign writer refuses; no busy timeout/retry or schema init.
    for (const entry of files.filter((entry) => /\.sqlite$/u.test(entry.relative))) {
      const db = new DatabaseSync(entry.source);
      try { db.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE;"); }
      catch (error) { db.close(); throw error; }
      reservations.push(db);
    }
    for (const entry of files) {
      if (/\.sqlite-(?:wal|shm)$/u.test(entry.relative) || /(?:^|[/\\])bot\.lock$/u.test(entry.relative)) continue;
      const target = path.join(destination, entry.relative);
      await mkdir(path.dirname(target), { recursive: true });
      if (/\.sqlite$/u.test(entry.relative)) {
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
      const file = await packageFile(target);
      records.push({ path: entry.relative, bytes: file.bytes, sha256: file.sha256 });
    }
    await assertStopped();
    return { directory: destination, files: records };
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
