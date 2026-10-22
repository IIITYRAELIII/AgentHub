import { randomUUID } from "node:crypto";
import { open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";

const unmeasured = (_phase, operation) => operation();

async function writeAndSync(filePath, content, measure = unmeasured) {
  const handle = await measure("open", () => open(filePath, "w", 0o600));
  try {
    await measure("write", () => handle.writeFile(String(content), "utf8"));
    await measure("fsync", () => handle.sync());
  } finally {
    await measure("close", () => handle.close());
  }
}

async function syncParentDirectory(filePath) {
  if (process.platform === "win32") return;
  const handle = await open(path.dirname(filePath), "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function readJsonWithBackup(filePath, { backupFile = `${filePath}.bak` } = {}) {
  let primaryError = null;
  try {
    return { value: JSON.parse(await readFile(filePath, "utf8")), source: filePath, recovered: false };
  } catch (error) {
    primaryError = error;
  }
  try {
    return { value: JSON.parse(await readFile(backupFile, "utf8")), source: backupFile, recovered: true };
  } catch (backupError) {
    if (primaryError?.code === "ENOENT" && backupError?.code === "ENOENT") {
      return { value: null, source: null, recovered: false };
    }
    throw new AggregateError([primaryError, backupError], `Cannot read JSON state or backup: ${filePath}`);
  }
}

export async function writeTextAtomic(filePath, content, {
  temporaryFile = `${filePath}.${process.pid}.${randomUUID()}.tmp`,
  replacementBackupFile = `${filePath}.${process.pid}.${randomUUID()}.replace`,
  renameImpl = rename,
  unlinkImpl = unlink,
  writeAndSyncImpl = writeAndSync,
  syncParentDirectoryImpl = syncParentDirectory,
  retryDelaysMs = [10, 25, 50, 100, 200, 400],
  exchangeBlockedTarget = false,
  measure = unmeasured,
} = {}) {
  await writeAndSyncImpl(temporaryFile, String(content), measure);
  try {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await measure("rename", () => renameImpl(temporaryFile, filePath));
        await measure("directory-sync", () => syncParentDirectoryImpl(filePath));
        break;
      } catch (error) {
        const retryable = ["EPERM", "EACCES", "EBUSY"].includes(error?.code);
        if (!retryable) throw error;
        if (attempt >= retryDelaysMs.length) {
          if (!exchangeBlockedTarget) throw error;
          await measure("backup-rename", () => renameImpl(filePath, replacementBackupFile));
          try {
            await measure("rename", () => renameImpl(temporaryFile, filePath));
          } catch (replacementError) {
            try {
              await measure("rollback-rename", () => renameImpl(replacementBackupFile, filePath));
            } catch (rollbackError) {
              throw new AggregateError(
                [replacementError, rollbackError],
                `Cannot replace or restore atomic target: ${filePath}`,
              );
            }
            throw replacementError;
          }
          await unlinkImpl(replacementBackupFile).catch(() => {});
          await syncParentDirectoryImpl(filePath);
          break;
        }
        await measure("retry-wait", () => new Promise((resolve) => setTimeout(resolve, retryDelaysMs[attempt])));
      }
    }
  } catch (error) {
    await unlinkImpl(temporaryFile).catch(() => {});
    throw error;
  }
}
