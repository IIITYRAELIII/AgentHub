import { randomUUID } from "node:crypto";
import { mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { backup, DatabaseSync } from "node:sqlite";

function migrationTimestamp(now) {
  return now.toISOString().replace(/[:.]/gu, "-");
}

export async function backupCodexHistoricalReconciliation({
  databaseFile,
  backupRoot = null,
  now = new Date(),
} = {}) {
  if (!databaseFile) throw new Error("Codex historical reconciliation requires a SQLite database");
  const sourceFile = path.resolve(String(databaseFile));
  try {
    const info = await stat(sourceFile);
    if (!info.isFile()) return { applied: false, reason: "no-database", backupFile: "" };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { applied: false, reason: "no-database", backupFile: "" };
    }
    throw error;
  }

  const root = path.resolve(backupRoot || path.join(path.dirname(sourceFile), "migrations"));
  const backupDirectory = path.join(
    root,
    `codex-rollout-reconciliation-v11-${migrationTimestamp(now)}-${randomUUID()}`,
  );
  const backupFile = path.join(backupDirectory, path.basename(sourceFile));
  await mkdir(backupDirectory, { recursive: true });

  const source = new DatabaseSync(sourceFile, { readOnly: true });
  source.exec("PRAGMA busy_timeout = 10000");
  try {
    await backup(source, backupFile);
  } catch (error) {
    await rm(backupDirectory, { recursive: true, force: true });
    throw error;
  } finally {
    source.close();
  }

  const copy = new DatabaseSync(backupFile, { readOnly: true });
  try {
    const integrity = copy.prepare("PRAGMA integrity_check").all()
      .map((row) => String(row.integrity_check ?? ""));
    if (integrity.length !== 1 || integrity[0] !== "ok") {
      throw new Error(`Codex reconciliation backup failed integrity check: ${integrity.join(", ")}`);
    }
  } catch (error) {
    copy.close();
    await rm(backupDirectory, { recursive: true, force: true });
    throw error;
  }
  copy.close();

  return {
    applied: true,
    reason: "backup-created",
    backupDirectory,
    backupFile,
  };
}
