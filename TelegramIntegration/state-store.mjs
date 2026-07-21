import { readFile, rename, unlink, writeFile } from "node:fs/promises";

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
  temporaryFile = `${filePath}.${process.pid}.tmp`,
  renameImpl = rename,
  retryDelaysMs = [10, 25, 50, 100, 200, 400],
} = {}) {
  await writeFile(temporaryFile, String(content), "utf8");
  try {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await renameImpl(temporaryFile, filePath);
        break;
      } catch (error) {
        const retryable = ["EPERM", "EACCES", "EBUSY"].includes(error?.code);
        if (!retryable || attempt >= retryDelaysMs.length) throw error;
        await new Promise((resolve) => setTimeout(resolve, retryDelaysMs[attempt]));
      }
    }
  } catch (error) {
    await unlink(temporaryFile).catch(() => {});
    throw error;
  }
}
