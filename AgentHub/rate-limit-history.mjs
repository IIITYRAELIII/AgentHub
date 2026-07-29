import { appendFile, mkdir, stat } from "node:fs/promises";
import path from "node:path";

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function limitBuckets(result) {
  if (result?.rateLimitsByLimitId) return Object.values(result.rateLimitsByLimitId);
  return result?.rateLimits ? [result.rateLimits] : [];
}

export function codexRateLimitRows(result, observedAt = new Date().toISOString()) {
  const rows = [];
  for (const bucket of limitBuckets(result)) {
    for (const [windowName, window] of [["primary", bucket.primary], ["secondary", bucket.secondary]]) {
      if (!window) continue;
      const usedPercent = Number(window.usedPercent);
      rows.push({
        observedAt,
        provider: "codex",
        limitId: String(bucket.limitId ?? bucket.limitName ?? "codex"),
        limitName: String(bucket.limitName ?? ""),
        window: windowName,
        usedPercent: Number.isFinite(usedPercent) ? usedPercent : "",
        remainingPercent: Number.isFinite(usedPercent) ? Math.max(0, 100 - usedPercent) : "",
        resetsAt: window.resetsAt ?? "",
        reachedType: bucket.rateLimitReachedType ?? "",
      });
    }
  }
  return rows;
}

export async function appendRateLimitRows(filePath, rows) {
  if (!rows.length) return 0;
  const resolved = path.resolve(filePath);
  await mkdir(path.dirname(resolved), { recursive: true });
  let exists = true;
  try {
    exists = (await stat(resolved)).size > 0;
  } catch (error) {
    if (error?.code === "ENOENT") exists = false;
    else throw error;
  }
  const columns = [
    "observedAt",
    "provider",
    "limitId",
    "limitName",
    "window",
    "usedPercent",
    "remainingPercent",
    "resetsAt",
    "reachedType",
  ];
  const lines = [];
  if (!exists) lines.push(columns.join(","));
  for (const row of rows) lines.push(columns.map((column) => csvCell(row[column])).join(","));
  await appendFile(resolved, `${lines.join("\n")}\n`, "utf8");
  return rows.length;
}
