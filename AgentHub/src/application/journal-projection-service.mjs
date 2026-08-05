import crypto from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import { buildLazyJournalPayload } from "./journal-projection-data.mjs";

export function journalProjectionVersion(value) {
  return `sha256:${crypto.createHash("sha256").update(String(value), "utf8").digest("hex")}`;
}

export function replaceJournalProjectionFromMarkdown(database, markdown, options = {}) {
  return database.replaceProjection(buildLazyJournalPayload(markdown), {
    ...options,
    version: options.version || journalProjectionVersion(markdown),
  });
}

export function replaceJournalProjectionFromHtml(database, html, options = {}) {
  return database.replaceProjection(buildLazyJournalPayload(html), options);
}

export async function ensureJournalProjectionFromFile(database, workLogFile) {
  const target = path.resolve(workLogFile);
  const [markdown, info] = await Promise.all([readFile(target, "utf8"), stat(target)]);
  const version = journalProjectionVersion(markdown);
  const current = await database.payload();
  if (current?.version === version) return current;
  await replaceJournalProjectionFromMarkdown(database, markdown, {
    updatedAt: info.mtime.toISOString(),
    version,
  });
  return database.payload();
}
