import { statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

function fileBytes(file) {
  try { return statSync(file).size; } catch (error) {
    if (error.code === "ENOENT") return 0;
    throw error;
  }
}

function nearestRank(sorted, fraction) {
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? null;
}

function safeIdentity(value) {
  return typeof value === "string" && /^[a-zA-Z0-9._:/-]{1,256}$/u.test(value) ? value : null;
}

function safeMetrics(serialized) {
  let input;
  try { input = JSON.parse(serialized ?? "{}"); } catch { return {}; }
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  return Object.fromEntries(Object.entries(input).filter(([key, value]) =>
    /^[a-zA-Z][a-zA-Z0-9_.-]{0,155}$/u.test(key) && typeof value === "number" && Number.isFinite(value)
  ).slice(0, 64));
}

// This is an offline/read-only diagnostic view, never an owner of command state.
export function readCommandTraceReport(databaseFile, {
  fromMs = Date.now() - 24 * 60 * 60 * 1_000,
  toMs = Date.now(),
  limit = 25,
  maxRows = 250_000,
} = {}) {
  if (!databaseFile) throw new TypeError("databaseFile is required");
  for (const [name, value] of Object.entries({ fromMs, toMs, limit, maxRows })) {
    if (!Number.isSafeInteger(value) || value < (name.endsWith("Ms") ? 0 : 1)) {
      throw new TypeError(`${name} must be a valid non-negative epoch or positive count`);
    }
  }
  if (toMs < fromMs) throw new TypeError("toMs must not precede fromMs");
  limit = Math.min(100, limit);
  maxRows = Math.min(250_000, maxRows);
  const database = new DatabaseSync(databaseFile, { readOnly: true });
  let retained;
  let rows;
  let runtimeHealth;
  try {
    database.exec("PRAGMA query_only = ON; PRAGMA busy_timeout = 0; BEGIN");
    retained = database.prepare(`SELECT COUNT(*) AS rows, MIN(observed_at_ms) AS oldestMs,
      MAX(observed_at_ms) AS newestMs FROM command_trace_spans`).get();
    rows = database.prepare(`
      SELECT sequence, span_id AS spanId, command_id AS commandId, stage, outcome, transport,
        observed_at_ms AS observedAtMs, monotonic_duration_ms AS durationMs,
        queue_depth AS queueDepth, lock_wait_ms AS lockWaitMs, sqlite_busy_wait_ms AS sqliteBusyWaitMs,
        json_extract(metadata_json, '$.action') AS action,
        json_extract(metadata_json, '$.surface') AS surface,
        json_extract(metadata_json, '$.view') AS view,
        json_extract(metadata_json, '$.instanceId') AS instanceId,
        json_extract(metadata_json, '$.releaseId') AS releaseId,
        json_extract(metadata_json, '$.operationSpanId') AS operationSpanId
      FROM command_trace_spans WHERE observed_at_ms >= ? AND observed_at_ms <= ?
      ORDER BY observed_at_ms DESC, sequence DESC LIMIT ?
    `).all(fromMs, toMs, maxRows + 1);
    runtimeHealth = database.prepare(`
      SELECT observed_at_ms AS observedAtMs,
        json_extract(metadata_json, '$.instanceId') AS instanceId,
        json_extract(metadata_json, '$.releaseId') AS releaseId,
        json_extract(metadata_json, '$.metrics') AS metricsJson
      FROM command_trace_spans WHERE stage = 'runtime-health'
        AND observed_at_ms >= ? AND observed_at_ms <= ?
      ORDER BY observed_at_ms DESC, sequence DESC LIMIT 10
    `).all(fromMs, toMs).map(({ metricsJson, instanceId, releaseId, ...row }) => ({
      ...row, instanceId: safeIdentity(instanceId), releaseId: safeIdentity(releaseId), metrics: safeMetrics(metricsJson),
    }));
    database.exec("COMMIT");
  } finally {
    database.close();
  }
  const truncated = rows.length > maxRows;
  rows = rows.slice(0, maxRows);
  const groups = new Map();
  const finished = new Set();
  const starts = [];
  const completed = [];
  for (const row of rows) {
    for (const key of ["surface", "view", "instanceId", "releaseId"]) row[key] = safeIdentity(row[key]);
    const operationKey = row.operationSpanId
      ? JSON.stringify([row.commandId, row.stage, row.transport, row.operationSpanId]) : null;
    if (row.outcome === "started") {
      starts.push({ ...row, operationKey });
      continue;
    }
    if (operationKey) finished.add(operationKey);
    completed.push(row);
    const key = JSON.stringify([row.stage, row.action, row.transport, row.surface, row.view, row.releaseId, row.outcome]);
    if (!groups.has(key)) groups.set(key, { stage: row.stage, action: row.action,
      surface: row.surface, view: row.view, releaseId: row.releaseId,
      transport: row.transport, outcome: row.outcome, durations: [], maxQueueDepth: 0,
      maxLockWaitMs: 0, maxSqliteBusyWaitMs: 0 });
    const group = groups.get(key);
    group.durations.push(row.durationMs);
    group.maxQueueDepth = Math.max(group.maxQueueDepth, row.queueDepth ?? 0);
    group.maxLockWaitMs = Math.max(group.maxLockWaitMs, row.lockWaitMs ?? 0);
    group.maxSqliteBusyWaitMs = Math.max(group.maxSqliteBusyWaitMs, row.sqliteBusyWaitMs ?? 0);
  }
  const stages = [...groups.values()].map(({ durations, ...group }) => {
    durations.sort((a, b) => a - b);
    return { ...group, count: durations.length, p50Ms: nearestRank(durations, 0.5),
      p95Ms: nearestRank(durations, 0.95), p99Ms: nearestRank(durations, 0.99), maxMs: durations.at(-1) };
  }).sort((a, b) => b.p95Ms - a.p95Ms);
  const incomplete = starts.filter((row) => !row.operationKey || !finished.has(row.operationKey));
  const storageFiles = [databaseFile, `${databaseFile}-wal`, `${databaseFile}-shm`]
    .map((file) => ({ file, bytes: fileBytes(file) }));
  return {
    fromMs, toMs, sampledRows: rows.length, truncated,
    storage: { ...retained, files: storageFiles,
      totalBytes: storageFiles.reduce((sum, item) => sum + item.bytes, 0) },
    stages,
    runtimeHealth,
    slowest: completed.sort((a, b) => b.durationMs - a.durationMs).slice(0, limit),
    incompleteCount: incomplete.length,
    incomplete: incomplete.sort((a, b) => a.observedAtMs - b.observedAtMs).slice(0, limit)
      .map(({ operationKey, ...row }) => ({ ...row, ageMs: Math.max(0, toMs - row.observedAtMs),
        correlated: Boolean(operationKey) })),
    caveat: "Telemetry is best effort. Missing finishes can mean dropped, expired or out-of-window samples; they do not prove a running command. Durations use local monotonic clocks; do not subtract cross-process timestamps. Runtime-health counters are cumulative within their instance; missing samples do not mean zero drops.",
  };
}
