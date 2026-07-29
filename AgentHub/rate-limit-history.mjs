import { createReadStream } from "node:fs";
import { appendFile, mkdir, stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import path from "node:path";

const RANGE_MILLISECONDS = Object.freeze({
  "6h": 6 * 60 * 60_000,
  "24h": 24 * 60 * 60_000,
  "7d": 7 * 24 * 60 * 60_000,
  "30d": 30 * 24 * 60 * 60_000,
  all: null,
});

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function limitBuckets(result) {
  if (result?.rateLimitsByLimitId) return Object.values(result.rateLimitsByLimitId);
  return result?.rateLimits ? [result.rateLimits] : [];
}

function limitName(bucket) {
  const source = String(bucket?.limitName ?? bucket?.limitId ?? "CODEX");
  const id = String(bucket?.limitId ?? source).toLowerCase();
  if (id === "codex") return "CODEX";
  if (id === "spark" || source.toLowerCase().includes("spark")) return "Spark";
  return source;
}

function isoFromEpochSeconds(value) {
  const milliseconds = Number(value) * 1000;
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return null;
  return new Date(milliseconds).toISOString();
}

function downsample(points, maximum) {
  if (points.length <= maximum) return points;
  if (maximum <= 2) return [points[0], points.at(-1)].slice(0, maximum);
  const sampled = [points[0]];
  const interior = maximum - 2;
  const step = (points.length - 2) / interior;
  for (let index = 0; index < interior; index += 1) {
    sampled.push(points[1 + Math.min(points.length - 3, Math.round(index * step))]);
  }
  sampled.push(points.at(-1));
  return sampled;
}

export function normalizeRateLimitRange(value) {
  const range = String(value ?? "24h").trim().toLowerCase();
  return Object.hasOwn(RANGE_MILLISECONDS, range) ? range : "24h";
}

export function rateLimitResetCreditSummary(result, nowMs = Date.now()) {
  const resetCredits = result?.rateLimitResetCredits;
  const credits = Array.isArray(resetCredits?.credits) ? resetCredits.credits : [];
  const available = credits.filter((credit) => (
    String(credit?.status ?? "available").toLowerCase() === "available"
  ));
  const expiries = available
    .map((credit) => Number(credit?.expiresAt) * 1000)
    .filter((expiresAt) => Number.isFinite(expiresAt) && expiresAt > nowMs)
    .sort((left, right) => left - right);
  const explicitCount = Number(resetCredits?.availableCount);
  return {
    availableCount: Number.isFinite(explicitCount) ? explicitCount : available.length || null,
    nearestExpiresAt: expiries.length ? new Date(expiries[0]).toISOString() : null,
  };
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

export async function appendRawRateLimitSnapshot(
  filePath,
  response,
  observedAt = new Date().toISOString(),
) {
  const resolved = path.resolve(filePath);
  await mkdir(path.dirname(resolved), { recursive: true });
  const record = {
    observedAt,
    provider: "codex",
    response,
  };
  await appendFile(resolved, `${JSON.stringify(record)}\n`, "utf8");
  return record;
}

export async function readRateLimitHistory(
  filePath,
  {
    range = "24h",
    nowMs = Date.now(),
    maxPointsPerSeries = 600,
  } = {},
) {
  const normalizedRange = normalizeRateLimitRange(range);
  const duration = RANGE_MILLISECONDS[normalizedRange];
  const fromMs = duration == null ? null : nowMs - duration;
  const maximum = Math.max(50, Math.min(1_200, Number(maxPointsPerSeries) || 600));
  const series = new Map();
  let resetCredits = { availableCount: null, nearestExpiresAt: null };
  let latestObservedAt = "";

  let input;
  try {
    input = createReadStream(path.resolve(filePath), { encoding: "utf8" });
    await new Promise((resolve, reject) => {
      input.once("open", resolve);
      input.once("error", reject);
    });
  } catch (error) {
    if (error?.code === "ENOENT") {
      return {
        range: normalizedRange,
        from: fromMs == null ? null : new Date(fromMs).toISOString(),
        to: new Date(nowMs).toISOString(),
        series: [],
        resetCredits,
      };
    }
    throw error;
  }

  const lines = createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    const observedMs = Date.parse(record?.observedAt ?? "");
    if (!Number.isFinite(observedMs)) continue;
    if (!latestObservedAt || observedMs >= Date.parse(latestObservedAt)) {
      latestObservedAt = new Date(observedMs).toISOString();
      resetCredits = rateLimitResetCreditSummary(record?.response, nowMs);
    }
    if ((fromMs != null && observedMs < fromMs) || observedMs > nowMs) continue;
    for (const bucket of limitBuckets(record?.response)) {
      for (const [windowName, window] of [["primary", bucket?.primary], ["secondary", bucket?.secondary]]) {
        const usedPercent = Number(window?.usedPercent);
        if (!Number.isFinite(usedPercent)) continue;
        const id = `${String(bucket?.limitId ?? bucket?.limitName ?? "codex")}:${windowName}`;
        if (!series.has(id)) {
          series.set(id, {
            id,
            name: limitName(bucket),
            window: windowName,
            points: [],
          });
        }
        series.get(id).points.push({
          at: new Date(observedMs).toISOString(),
          usedPercent,
          remainingPercent: Math.max(0, 100 - usedPercent),
        });
      }
    }
  }

  return {
    range: normalizedRange,
    from: fromMs == null ? null : new Date(fromMs).toISOString(),
    to: new Date(nowMs).toISOString(),
    series: [...series.values()]
      .sort((left, right) => (
        left.name === "CODEX" ? -1 : right.name === "CODEX" ? 1 : left.name.localeCompare(right.name)
      ))
      .map((item) => ({
        ...item,
        points: downsample(item.points, maximum),
      })),
    resetCredits,
  };
}
