import { rename, unlink, writeFile } from "node:fs/promises";

export async function writeTextAtomic(filePath, content, {
  temporaryFile = `${filePath}.${process.pid}.tmp`,
} = {}) {
  await writeFile(temporaryFile, String(content), "utf8");
  try {
    await rename(temporaryFile, filePath);
  } catch (error) {
    await unlink(temporaryFile).catch(() => {});
    throw error;
  }
}
