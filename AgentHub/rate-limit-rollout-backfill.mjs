import { createReadStream } from "node:fs";
import { appendFile, mkdir, readdir, stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import path from "node:path";

import { codexRateLimitRows } from "./rate-limit-history.mjs";

const DEFAULT_BUCKET_MINUTES = 5;

async function rolloutFiles(root) {
  const files = [];
  async function visit(directory) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(candidate);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(".jsonl")) files.push(candidate);
    }
  }
  await visit(path.resolve(root));
  return files;
}

function historyBuckets(response) {
  if (response?.rateLimitsByLimitId) return Object.values(response.rateLimitsByLimitId);
  return response?.rateLimits ? [response.rateLimits] : [];
}

function hasUsageWindow(bucket) {
  return [bucket?.primary, bucket?.secondary]
    .some((window) => Number.isFinite(Number(window?.usedPercent)));
}

function windowFromRollout(value) {
  if (!value || typeof value !== "object") return null;
  return {
    usedPercent: value.used_percent,
    windowDurationMins: value.window_minutes,
    resetsAt: value.resets_at,
  };
}

export function rateLimitRecordFromRolloutEvent(event) {
  if (event?.type !== "event_msg" || event?.payload?.type !== "token_count") return null;
  const source = event.payload.rate_limits;
  const observedMs = Date.parse(String(event.timestamp ?? ""));
  const limitId = String(source?.limit_id ?? "").trim();
  if (!source || !limitId || !Number.isFinite(observedMs)) return null;
  const bucket = {
    limitId,
    limitName: source.limit_name ?? null,
    primary: windowFromRollout(source.primary),
    secondary: windowFromRollout(source.secondary),
    credits: source.credits ?? null,
    individualLimit: source.individual_limit ?? null,
    spendControlReached: source.spend_control_reached ?? null,
    planType: source.plan_type ?? null,
    rateLimitReachedType: source.rate_limit_reached_type ?? null,
  };
  if (!hasUsageWindow(bucket)) return null;
  return {
    observedAt: new Date(observedMs).toISOString(),
    provider: "codex",
    source: "rollout-backfill",
    response: {
      rateLimits: bucket,
      rateLimitsByLimitId: { [limitId]: bucket },
    },
  };
}

function recordKeys(record, bucketMs) {
  const observedMs = Date.parse(record?.observedAt ?? "");
  if (!Number.isFinite(observedMs)) return [];
  const timeBucket = Math.floor(observedMs / bucketMs);
  return historyBuckets(record?.response)
    .filter(hasUsageWindow)
    .map((bucket) => String(bucket?.limitId ?? bucket?.limitName ?? "").trim())
    .filter(Boolean)
    .map((limitId) => `${timeBucket}:${limitId}`);
}

async function readExistingKeys(filePath, bucketMs) {
  const keys = new Set();
  let input;
  try {
    input = createReadStream(path.resolve(filePath), { encoding: "utf8" });
    await new Promise((resolve, reject) => {
      input.once("open", resolve);
      input.once("error", reject);
    });
  } catch (error) {
    if (error?.code === "ENOENT") return keys;
    throw error;
  }
  const lines = createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    try {
      for (const key of recordKeys(JSON.parse(line), bucketMs)) keys.add(key);
    } catch {
      // A damaged old line does not invalidate the remaining append-only history.
    }
  }
  return keys;
}

async function scanRolloutFile(filePath, bucketMs, sampled) {
  const input = createReadStream(filePath, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  let parsedEvents = 0;
  for await (const line of lines) {
    if (!line.includes('"rate_limits"')) continue;
    let value;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    const record = rateLimitRecordFromRolloutEvent(value);
    if (!record) continue;
    parsedEvents += 1;
    for (const key of recordKeys(record, bucketMs)) {
      const previous = sampled.get(key);
      if (!previous || Date.parse(previous.observedAt) <= Date.parse(record.observedAt)) {
        sampled.set(key, record);
      }
    }
  }
  return parsedEvents;
}

export async function buildRateLimitRolloutBackfill({
  rolloutRoots,
  rawHistoryFile,
  bucketMinutes = DEFAULT_BUCKET_MINUTES,
} = {}) {
  if (!Array.isArray(rolloutRoots) || !rolloutRoots.length) {
    throw new Error("At least one Codex rollout root is required");
  }
  if (!rawHistoryFile) throw new Error("Raw rate-limit history file is required");
  const bucketMs = Math.max(1, Number(bucketMinutes) || DEFAULT_BUCKET_MINUTES) * 60_000;
  const files = [];
  for (const root of rolloutRoots) files.push(...await rolloutFiles(root));
  files.sort((left, right) => left.localeCompare(right));

  const sampled = new Map();
  let parsedEvents = 0;
  for (const file of files) parsedEvents += await scanRolloutFile(file, bucketMs, sampled);

  const existingKeys = await readExistingKeys(rawHistoryFile, bucketMs);
  const records = [...sampled.entries()]
    .filter(([key]) => !existingKeys.has(key))
    .map(([, record]) => record)
    .sort((left, right) => Date.parse(left.observedAt) - Date.parse(right.observedAt));
  const limitIds = [...new Set(records.flatMap((record) => (
    historyBuckets(record.response).map((bucket) => bucket.limitId)
  )))].sort();
  return {
    records,
    report: {
      scannedFiles: files.length,
      parsedEvents,
      sampledSnapshots: sampled.size,
      existingIntervals: existingKeys.size,
      importedSnapshots: records.length,
      firstImportedAt: records[0]?.observedAt ?? null,
      lastImportedAt: records.at(-1)?.observedAt ?? null,
      limitIds,
      bucketMinutes: bucketMs / 60_000,
    },
  };
}

export async function applyRateLimitRolloutBackfill({
  migration,
  rawHistoryFile,
  csvHistoryFile,
} = {}) {
  const records = Array.isArray(migration?.records) ? migration.records : [];
  if (!records.length) return { rawRecords: 0, csvRows: 0 };
  const rawPath = path.resolve(rawHistoryFile);
  const csvPath = path.resolve(csvHistoryFile);
  await mkdir(path.dirname(rawPath), { recursive: true });
  await appendFile(rawPath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");

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
  const csvCell = (value) => {
    const text = String(value ?? "");
    return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  const rows = records.flatMap((record) => codexRateLimitRows(record.response, record.observedAt));
  await mkdir(path.dirname(csvPath), { recursive: true });
  let hasCsv = true;
  try {
    hasCsv = (await stat(csvPath)).size > 0;
  } catch (error) {
    if (error?.code === "ENOENT") hasCsv = false;
    else throw error;
  }
  const lines = [];
  if (!hasCsv) lines.push(columns.join(","));
  lines.push(...rows.map((row) => columns.map((column) => csvCell(row[column])).join(",")));
  if (lines.length) await appendFile(csvPath, `${lines.join("\n")}\n`, "utf8");
  return { rawRecords: records.length, csvRows: rows.length };
}
