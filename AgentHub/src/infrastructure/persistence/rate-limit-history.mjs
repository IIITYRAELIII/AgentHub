import { createReadStream } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { appendFile, copyFile, mkdir, readFile, rm, stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { writeTextAtomic } from "./state-store.mjs";

const RANGE_MILLISECONDS = Object.freeze({
  "6h": 6 * 60 * 60_000,
  "24h": 24 * 60 * 60_000,
  "7d": 7 * 24 * 60 * 60_000,
  "15d": 15 * 24 * 60 * 60_000,
  "30d": 30 * 24 * 60 * 60_000,
  all: null,
});
const SQLITE_BUSY_RETRY_DELAYS_MS = [10, 25, 50, 100, 250, 500, 1_000, 2_000];

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function sqliteBusy(error) {
  return /SQLITE_BUSY|database is locked|database is busy/iu.test(String(error?.message ?? error));
}

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

const CSV_COLUMNS = [
  "observedAt",
  "provider",
  "accountKey",
  "accountLabel",
  "accountPlan",
  "limitId",
  "limitName",
  "window",
  "usedPercent",
  "remainingPercent",
  "resetsAt",
  "reachedType",
];

export function codexAccountDimension(value) {
  const account = value?.account && typeof value.account === "object" ? value.account : value;
  const type = String(account?.type ?? "").trim();
  const email = String(account?.email ?? "").trim().toLowerCase();
  const planType = String(account?.planType ?? "").trim();
  if (type === "chatgpt" && email) {
    return {
      key: `chatgpt:${createHash("sha256").update(email).digest("hex")}`,
      label: email,
      type,
      planType,
    };
  }
  if (type === "apiKey") return { key: "api-key", label: "API key", type, planType };
  if (type === "amazonBedrock") {
    return { key: "amazon-bedrock", label: "Amazon Bedrock", type, planType };
  }
  return { key: "", label: "", type: "", planType: "" };
}

function storedAccountDimension(value) {
  if (!value || typeof value !== "object") return codexAccountDimension(null);
  const key = String(value.key ?? value.accountKey ?? "").trim();
  if (!key) return codexAccountDimension(value);
  return {
    key,
    label: String(value.label ?? value.accountLabel ?? "").trim(),
    type: String(value.type ?? value.accountType ?? "").trim(),
    planType: String(value.planType ?? value.accountPlan ?? "").trim(),
  };
}

function accountRecordFields(value) {
  const account = storedAccountDimension(value);
  return account.key ? {
    accountKey: account.key,
    accountLabel: account.label,
    accountPlan: account.planType,
  } : {};
}

function accountSnapshot(value) {
  const account = storedAccountDimension(value);
  return account.key ? account : null;
}

function csvRows(rows, { header = false } = {}) {
  const lines = header ? [CSV_COLUMNS.join(",")] : [];
  for (const row of rows) lines.push(CSV_COLUMNS.map((column) => csvCell(row[column])).join(","));
  return lines;
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

function rateLimitRangeStartMs(range, nowMs) {
  if (range === "15d") {
    const start = new Date(nowMs);
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - 14);
    return start.getTime();
  }
  const duration = RANGE_MILLISECONDS[range];
  return duration == null ? null : nowMs - duration;
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

export function codexRateLimitRows(result, observedAt = new Date().toISOString(), account = null) {
  const rows = [];
  for (const bucket of limitBuckets(result)) {
    for (const [windowName, window] of [["primary", bucket.primary], ["secondary", bucket.secondary]]) {
      if (!window) continue;
      const usedPercent = Number(window.usedPercent);
      rows.push({
        observedAt,
        provider: "codex",
        ...accountRecordFields(account),
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

function claudeLimitId(limit) {
  const model = String(limit?.model ?? "").trim();
  if (model) {
    const slug = model.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/gu, "");
    return `claude:model:${slug || "unknown"}`;
  }
  return String(limit?.kind ?? "").toLowerCase() === "session"
    ? "claude:session"
    : "claude:week";
}

function claudeWindowName(limit) {
  if (limit?.model) return String(limit.model);
  return String(limit?.kind ?? "").toLowerCase() === "session" ? "session" : "week";
}

export function claudeRateLimitRows(limits, observedAt = new Date().toISOString()) {
  return (Array.isArray(limits) ? limits : []).flatMap((limit) => {
    const usedPercent = Number(limit?.usedPercent);
    if (!Number.isFinite(usedPercent)) return [];
    return [{
      observedAt,
      provider: "claude",
      limitId: claudeLimitId(limit),
      limitName: "CLAUDE",
      window: claudeWindowName(limit),
      usedPercent,
      remainingPercent: Math.max(0, 100 - usedPercent),
      resetsAt: limit?.resetsText ?? "",
      reachedType: "",
    }];
  });
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
  const lines = csvRows(rows, { header: !exists });
  await appendFile(resolved, `${lines.join("\n")}\n`, "utf8");
  return rows.length;
}

export async function appendRawRateLimitSnapshot(
  filePath,
  response,
  observedAt = new Date().toISOString(),
  provider = "codex",
  account = null,
) {
  const resolved = path.resolve(filePath);
  await mkdir(path.dirname(resolved), { recursive: true });
  const record = {
    observedAt,
    provider: String(provider || "codex").toLowerCase(),
    ...(accountSnapshot(account) ? { account: accountSnapshot(account) } : {}),
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
  const fromMs = rateLimitRangeStartMs(normalizedRange, nowMs);
  const maximum = Math.max(50, Math.min(1_200, Number(maxPointsPerSeries) || 600));
  const series = new Map();
  let resetCredits = { availableCount: null, nearestExpiresAt: null };
  let latestCodexObservedAt = "";
  let currentAccount = null;

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
        currentAccount,
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
    const provider = String(record?.provider ?? "codex").toLowerCase();
    const account = accountSnapshot(record?.account);
    if (provider === "codex"
      && (!latestCodexObservedAt || observedMs >= Date.parse(latestCodexObservedAt))) {
      latestCodexObservedAt = new Date(observedMs).toISOString();
      resetCredits = rateLimitResetCreditSummary(record?.response, nowMs);
      currentAccount = account;
    }
    if ((fromMs != null && observedMs < fromMs) || observedMs > nowMs) continue;
    if (provider === "claude") {
      const limits = Array.isArray(record?.response?.limits) ? record.response.limits : [];
      for (const limit of limits) {
        const usedPercent = Number(limit?.usedPercent);
        if (!Number.isFinite(usedPercent)) continue;
        const id = claudeLimitId(limit);
        if (!series.has(id)) {
          series.set(id, {
            id,
            name: "CLAUDE",
            window: claudeWindowName(limit),
            points: [],
          });
        }
        series.get(id).points.push({
          at: new Date(observedMs).toISOString(),
          usedPercent,
          remainingPercent: Math.max(0, 100 - usedPercent),
          resetsText: String(limit?.resetsText ?? ""),
        });
      }
      continue;
    }
    for (const bucket of limitBuckets(record?.response)) {
      for (const [windowName, window] of [["primary", bucket?.primary], ["secondary", bucket?.secondary]]) {
        const usedPercent = Number(window?.usedPercent);
        if (!Number.isFinite(usedPercent)) continue;
        const baseId = `${String(bucket?.limitId ?? bucket?.limitName ?? "codex")}:${windowName}`;
        const id = account?.key ? `${baseId}@${account.key}` : baseId;
        if (!series.has(id)) {
          series.set(id, {
            id,
            baseId,
            name: limitName(bucket),
            window: windowName,
            ...(account ? {
              accountKey: account.key,
              accountLabel: account.label,
              accountPlan: account.planType,
            } : {}),
            points: [],
          });
        }
        series.get(id).points.push({
          at: new Date(observedMs).toISOString(),
          usedPercent,
          remainingPercent: Math.max(0, 100 - usedPercent),
          resetsAt: isoFromEpochSeconds(window?.resetsAt),
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
        points: downsample(
          item.points.sort((left, right) => Date.parse(left.at) - Date.parse(right.at)),
          maximum,
        ),
      })),
    resetCredits,
    currentAccount,
  };
}

function historyFromRecords(records, {
  range = "24h",
  nowMs = Date.now(),
  maxPointsPerSeries = 600,
} = {}) {
  const normalizedRange = normalizeRateLimitRange(range);
  const fromMs = rateLimitRangeStartMs(normalizedRange, nowMs);
  const maximum = Math.max(50, Math.min(1_200, Number(maxPointsPerSeries) || 600));
  const series = new Map();
  let resetCredits = { availableCount: null, nearestExpiresAt: null };
  let latestCodexObservedMs = -Infinity;
  let currentAccount = null;

  for (const record of records) {
    const observedMs = Date.parse(record?.observedAt ?? "");
    if (!Number.isFinite(observedMs)) continue;
    const provider = String(record?.provider ?? "codex").toLowerCase();
    const account = accountSnapshot(record?.account);
    if (provider === "codex" && observedMs >= latestCodexObservedMs) {
      latestCodexObservedMs = observedMs;
      resetCredits = rateLimitResetCreditSummary(record?.response, nowMs);
      currentAccount = account;
    }
    if ((fromMs != null && observedMs < fromMs) || observedMs > nowMs) continue;
    if (provider === "claude") {
      const limits = Array.isArray(record?.response?.limits) ? record.response.limits : [];
      for (const limit of limits) {
        const usedPercent = Number(limit?.usedPercent);
        if (!Number.isFinite(usedPercent)) continue;
        const id = claudeLimitId(limit);
        if (!series.has(id)) {
          series.set(id, { id, name: "CLAUDE", window: claudeWindowName(limit), points: [] });
        }
        series.get(id).points.push({
          at: new Date(observedMs).toISOString(),
          usedPercent,
          remainingPercent: Math.max(0, 100 - usedPercent),
          resetsText: String(limit?.resetsText ?? ""),
        });
      }
      continue;
    }
    for (const bucket of limitBuckets(record?.response)) {
      for (const [windowName, window] of [["primary", bucket?.primary], ["secondary", bucket?.secondary]]) {
        const usedPercent = Number(window?.usedPercent);
        if (!Number.isFinite(usedPercent)) continue;
        const baseId = `${String(bucket?.limitId ?? bucket?.limitName ?? "codex")}:${windowName}`;
        const id = account?.key ? `${baseId}@${account.key}` : baseId;
        if (!series.has(id)) {
          series.set(id, {
            id,
            baseId,
            name: limitName(bucket),
            window: windowName,
            ...(account ? {
              accountKey: account.key,
              accountLabel: account.label,
              accountPlan: account.planType,
            } : {}),
            points: [],
          });
        }
        series.get(id).points.push({
          at: new Date(observedMs).toISOString(),
          usedPercent,
          remainingPercent: Math.max(0, 100 - usedPercent),
          resetsAt: isoFromEpochSeconds(window?.resetsAt),
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
        points: downsample(
          item.points.sort((left, right) => Date.parse(left.at) - Date.parse(right.at)),
          maximum,
        ),
      })),
    resetCredits,
    currentAccount,
  };
}

function configureRateLimitDatabase(database) {
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS rate_limit_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      observed_at TEXT NOT NULL,
      observed_ms INTEGER NOT NULL,
      provider TEXT NOT NULL,
      account_key TEXT NOT NULL DEFAULT '',
      account_label TEXT NOT NULL DEFAULT '',
      account_type TEXT NOT NULL DEFAULT '',
      account_plan TEXT NOT NULL DEFAULT '',
      response_json TEXT NOT NULL,
      rows_json TEXT NOT NULL,
      UNIQUE(provider, account_key, observed_at, response_json)
    );
    CREATE TABLE IF NOT EXISTS rate_limit_store_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    ) WITHOUT ROWID;
  `);
  const schema = database.prepare(`
    SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'rate_limit_snapshots'
  `).get();
  const columns = new Set(database.prepare("PRAGMA table_info(rate_limit_snapshots)")
    .all().map((column) => String(column.name)));
  const compactSchema = String(schema?.sql ?? "").replaceAll(/\s+/gu, "");
  const currentAccountSchema = ["account_key", "account_label", "account_type", "account_plan"]
    .every((column) => columns.has(column))
    && /UNIQUE\(provider,account_key,observed_at,response_json\)/u.test(compactSchema);
  if (!currentAccountSchema) {
    const accountKey = columns.has("account_key") ? "account_key" : "''";
    const accountLabel = columns.has("account_label") ? "account_label" : "''";
    const accountType = columns.has("account_type") ? "account_type" : "''";
    const accountPlan = columns.has("account_plan") ? "account_plan" : "''";
    database.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE rate_limit_snapshots_rebuilt (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        observed_at TEXT NOT NULL,
        observed_ms INTEGER NOT NULL,
        provider TEXT NOT NULL,
        account_key TEXT NOT NULL DEFAULT '',
        account_label TEXT NOT NULL DEFAULT '',
        account_type TEXT NOT NULL DEFAULT '',
        account_plan TEXT NOT NULL DEFAULT '',
        response_json TEXT NOT NULL,
        rows_json TEXT NOT NULL,
        UNIQUE(provider, account_key, observed_at, response_json)
      );
      INSERT OR IGNORE INTO rate_limit_snapshots_rebuilt
        (id, observed_at, observed_ms, provider, account_key, account_label,
         account_type, account_plan, response_json, rows_json)
      SELECT id, observed_at, observed_ms, provider, ${accountKey}, ${accountLabel},
        ${accountType}, ${accountPlan}, response_json, rows_json
      FROM rate_limit_snapshots;
      DROP TABLE rate_limit_snapshots;
      ALTER TABLE rate_limit_snapshots_rebuilt RENAME TO rate_limit_snapshots;
      CREATE INDEX rate_limit_snapshots_observed_idx
        ON rate_limit_snapshots(observed_ms, provider, account_key);
      COMMIT;
    `);
  }
  database.exec(`
    CREATE INDEX IF NOT EXISTS rate_limit_snapshots_observed_idx
      ON rate_limit_snapshots(observed_ms, provider, account_key);
  `);
}

export class RateLimitHistoryStore {
  #database = null;
  #databaseFile;
  #rawFile;
  #csvFile;
  #afterRawExport;
  #tail = Promise.resolve();
  #closed = false;
  #closing = null;

  constructor({ databaseFile, rawFile, csvFile, afterRawExport = null }) {
    this.#databaseFile = path.resolve(databaseFile);
    this.#rawFile = path.resolve(rawFile);
    this.#csvFile = path.resolve(csvFile);
    this.#afterRawExport = afterRawExport;
  }

  async #open() {
    if (this.#closed) throw new Error("Rate-limit history store is closed");
    if (this.#database) return this.#database;
    await mkdir(path.dirname(this.#databaseFile), { recursive: true });
    const database = new DatabaseSync(this.#databaseFile);
    this.#database = database;
    try {
      await this.#retryBusy(() => configureRateLimitDatabase(database));
      await this.#importLegacy();
      if (await this.#compatibilityExportsExist()
        && await this.#compatibilityExportRequired()) await this.#rebuildCompatibilityExports();
      return database;
    } catch (error) {
      this.#database = null;
      database.close();
      throw error;
    }
  }

  async #retryBusy(operation) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        if (!sqliteBusy(error) || attempt >= SQLITE_BUSY_RETRY_DELAYS_MS.length) throw error;
        await delay(SQLITE_BUSY_RETRY_DELAYS_MS[attempt]);
      }
    }
  }

  async #importLegacy() {
    const database = this.#database;
    const imported = await this.#retryBusy(() => database.prepare(
      "SELECT value FROM rate_limit_store_meta WHERE key = 'legacy_imported'",
    ).get());
    if (imported) return false;
    const source = await readFile(this.#rawFile, "utf8").catch((error) => {
      if (error?.code === "ENOENT") return "";
      throw error;
    });
    return this.#retryBusy(() => {
      database.exec("BEGIN IMMEDIATE");
      try {
        const alreadyImported = database.prepare(
          "SELECT value FROM rate_limit_store_meta WHERE key = 'legacy_imported'",
        ).get();
        if (alreadyImported) {
          database.exec("COMMIT");
          return false;
        }
        const insert = database.prepare(`
          INSERT OR IGNORE INTO rate_limit_snapshots
            (observed_at, observed_ms, provider, account_key, account_label,
             account_type, account_plan, response_json, rows_json)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (const line of source.split(/\r?\n/u).filter(Boolean)) {
          let record;
          try {
            record = JSON.parse(line);
          } catch {
            continue;
          }
          const observedAt = String(record?.observedAt ?? "");
          const observedMs = Date.parse(observedAt);
          if (!Number.isFinite(observedMs)) continue;
          const provider = String(record?.provider ?? "codex").toLowerCase();
          const response = record?.response ?? {};
          const account = accountSnapshot(record?.account);
          const rows = provider === "claude"
            ? claudeRateLimitRows(response?.limits, observedAt)
            : codexRateLimitRows(response, observedAt, account);
          insert.run(
            observedAt,
            observedMs,
            provider,
            account?.key ?? "",
            account?.label ?? "",
            account?.type ?? "",
            account?.planType ?? "",
            JSON.stringify(response),
            JSON.stringify(rows),
          );
        }
        database.prepare(`
          INSERT INTO rate_limit_store_meta (key, value) VALUES ('legacy_imported', ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value
        `).run(new Date().toISOString());
        database.prepare(`
          INSERT INTO rate_limit_store_meta (key, value) VALUES ('export_generation', '1')
          ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + 1
        `).run();
        database.exec("COMMIT");
        return true;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    });
  }

  async #compatibilityExportRequired() {
    return this.#retryBusy(() => {
      const get = this.#database.prepare("SELECT value FROM rate_limit_store_meta WHERE key = ?");
      const current = String(get.get("export_generation")?.value ?? "0");
      const exported = String(get.get("compatibility_export_generation")?.value ?? "");
      return current !== exported;
    });
  }

  async #compatibilityExportsExist() {
    for (const file of [this.#rawFile, this.#csvFile]) {
      try {
        if ((await stat(file)).isFile()) return true;
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
    return false;
  }

  async #rebuildCompatibilityExports() {
    for (;;) {
      const { generation, snapshots } = await this.#retryBusy(() => {
        const generation = String(this.#database.prepare(
          "SELECT value FROM rate_limit_store_meta WHERE key = 'export_generation'",
        ).get()?.value ?? "0");
        const snapshots = this.#database.prepare(`
          SELECT observed_at, provider, account_key, account_label, account_type,
            account_plan, response_json, rows_json
          FROM rate_limit_snapshots ORDER BY observed_ms, id
        `).all();
        return { generation, snapshots };
      });
      const raw = snapshots.map((snapshot) => JSON.stringify({
        observedAt: snapshot.observed_at,
        provider: snapshot.provider,
        ...(snapshot.account_key ? { account: {
          key: snapshot.account_key,
          label: snapshot.account_label,
          type: snapshot.account_type,
          planType: snapshot.account_plan,
        } } : {}),
        response: JSON.parse(snapshot.response_json),
      }));
      const rows = snapshots.flatMap((snapshot) => JSON.parse(snapshot.rows_json));
      await mkdir(path.dirname(this.#rawFile), { recursive: true });
      await writeTextAtomic(this.#rawFile, raw.length ? `${raw.join("\n")}\n` : "", {
        temporaryFile: `${this.#rawFile}.${process.pid}.${randomUUID()}.tmp`,
      });
      await this.#afterRawExport?.();
      const csv = csvRows(rows, { header: true });
      await writeTextAtomic(this.#csvFile, `${csv.join("\n")}\n`, {
        temporaryFile: `${this.#csvFile}.${process.pid}.${randomUUID()}.tmp`,
      });
      const currentGeneration = await this.#retryBusy(() => String(this.#database.prepare(
        "SELECT value FROM rate_limit_store_meta WHERE key = 'export_generation'",
      ).get()?.value ?? "0"));
      if (generation !== currentGeneration) continue;
      await this.#retryBusy(() => this.#database.prepare(`
        INSERT INTO rate_limit_store_meta (key, value) VALUES ('compatibility_export_generation', ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `).run(generation));
      return;
    }
  }

  #enqueue(operation) {
    if (this.#closed || this.#closing) return Promise.reject(new Error("Rate-limit history store is closing or closed"));
    const queued = this.#tail.catch(() => {}).then(operation);
    this.#tail = queued;
    return queued;
  }

  record(response, observedAt = new Date().toISOString(), provider = "codex", accountSource = null) {
    return this.#enqueue(async () => {
      const database = await this.#open();
      const normalizedProvider = String(provider || "codex").toLowerCase();
      const account = normalizedProvider === "codex" ? accountSnapshot(accountSource) : null;
      const observedMs = Date.parse(observedAt);
      if (!Number.isFinite(observedMs)) throw new Error(`Invalid rate-limit timestamp: ${observedAt}`);
      const rows = normalizedProvider === "claude"
        ? claudeRateLimitRows(response?.limits, observedAt)
        : codexRateLimitRows(response, observedAt, account);
      const result = await this.#retryBusy(() => {
        database.exec("BEGIN IMMEDIATE");
        try {
          const result = database.prepare(`
            INSERT OR IGNORE INTO rate_limit_snapshots
              (observed_at, observed_ms, provider, account_key, account_label,
               account_type, account_plan, response_json, rows_json)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            observedAt,
            observedMs,
            normalizedProvider,
            account?.key ?? "",
            account?.label ?? "",
            account?.type ?? "",
            account?.planType ?? "",
            JSON.stringify(response),
            JSON.stringify(rows),
          );
          if (Number(result.changes) > 0) {
            database.prepare(`
              INSERT INTO rate_limit_store_meta (key, value) VALUES ('export_generation', '1')
              ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + 1
            `).run();
          }
          database.exec("COMMIT");
          return result;
        } catch (error) {
          database.exec("ROLLBACK");
          throw error;
        }
      });
      return { recorded: Number(result.changes) > 0, rows: rows.length };
    });
  }

  read(options = {}) {
    return this.#enqueue(async () => {
      const database = await this.#open();
      const normalizedRange = normalizeRateLimitRange(options.range);
      const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
      const fromMs = rateLimitRangeStartMs(normalizedRange, nowMs);
      const { latestCodex, rows } = await this.#retryBusy(() => {
        const maximum = Math.max(50, Math.min(1_200, Number(options.maxPointsPerSeries) || 600));
        const timeClause = fromMs == null
          ? "observed_ms <= ?"
          : "observed_ms BETWEEN ? AND ?";
        const timeParameters = fromMs == null ? [nowMs] : [fromMs, nowMs];
        // Each snapshot contains all series for its provider. Sample each
        // provider independently in SQL, retaining the first and last sample
        // and at most `maximum` representative snapshots per provider. This
        // keeps JSON parsing and response memory bounded even for range=all.
        const rows = database.prepare(`
          WITH filtered AS (
            SELECT id, observed_at, observed_ms, provider, account_key, account_label,
              account_type, account_plan, response_json
            FROM rate_limit_snapshots
            WHERE ${timeClause}
          ), numbered AS (
            SELECT *,
              ROW_NUMBER() OVER (
                PARTITION BY provider, account_key ORDER BY observed_ms, id
              ) AS sequence_number,
              COUNT(*) OVER (PARTITION BY provider, account_key) AS total_count
            FROM filtered
          ), bucketed AS (
            SELECT *, CASE
              WHEN total_count <= ? THEN sequence_number - 1
              ELSE CAST(((sequence_number - 1) * (? - 1)) / NULLIF(total_count - 1, 0) AS INTEGER)
            END AS sample_bucket
            FROM numbered
          ), representatives AS (
            SELECT *,
              ROW_NUMBER() OVER (
                PARTITION BY provider, account_key, sample_bucket
                ORDER BY observed_ms, id
              ) AS bucket_sequence
            FROM bucketed
          )
          SELECT id, observed_at, provider, account_key, account_label, account_type,
            account_plan, response_json
          FROM representatives
          WHERE bucket_sequence = 1
          ORDER BY observed_ms, id
        `).all(...timeParameters, maximum, maximum);
        const latestCodex = database.prepare(`
        SELECT id, observed_at, provider, account_key, account_label, account_type,
          account_plan, response_json FROM rate_limit_snapshots
        WHERE provider = 'codex' AND observed_ms <= ? ORDER BY observed_ms DESC, id DESC LIMIT 1
      `).get(nowMs);
        return { latestCodex, rows };
      });
      if (latestCodex && !rows.some((row) => row.id === latestCodex.id)) rows.unshift(latestCodex);
      return historyFromRecords(rows.map((row) => ({
        observedAt: row.observed_at,
        provider: row.provider,
        account: row.account_key ? {
          key: row.account_key,
          label: row.account_label,
          type: row.account_type,
          planType: row.account_plan,
        } : null,
        response: JSON.parse(row.response_json),
      })), { ...options, range: normalizedRange, nowMs });
    });
  }

  rebuildCompatibilityExports() {
    return this.#enqueue(async () => {
      await this.#open();
      await this.#rebuildCompatibilityExports();
    });
  }

  retireCompatibilityExports({
    backupRoot = path.join(path.dirname(this.#databaseFile), "migrations"),
    now = new Date(),
  } = {}) {
    return this.#enqueue(async () => {
      await this.#open();
      const files = [];
      for (const source of [this.#rawFile, this.#csvFile]) {
        try {
          const info = await stat(source);
          if (info.isFile()) files.push({ source, size: info.size });
        } catch (error) {
          if (error?.code !== "ENOENT") throw error;
        }
      }
      if (!files.length) return { retired: false, removed: [], archived: [] };
      const timestamp = now.toISOString().replace(/[:.]/gu, "-");
      const backupDirectory = path.join(path.resolve(backupRoot), `rate-limits-sqlite-${timestamp}`);
      await mkdir(backupDirectory, { recursive: true });
      const archived = [];
      for (const item of files) {
        const backupFile = path.join(backupDirectory, path.basename(item.source));
        await copyFile(item.source, backupFile);
        archived.push({ ...item, backupFile });
      }
      for (const item of files) await rm(item.source, { force: true });
      return {
        retired: true,
        backupDirectory,
        archived,
        removed: files.map((item) => item.source),
      };
    });
  }

  async close() {
    if (this.#closing) return this.#closing;
    this.#closing = (async () => {
      await this.#tail.catch(() => {});
      this.#database?.close();
      this.#database = null;
      this.#closed = true;
    })();
    return this.#closing;
  }
}
