import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { taskOccupancyIdentity } from "../../domain/task-runs.mjs";

const BUSY_TIMEOUT_MS = 5_000;
const TERMINAL_STATES = new Set(["completed", "failed", "cancelled"]);
const ACTIVE_STATES = ["accepted", "queued", "attention-required", "dispatching", "started", "unknown"];
const DEFAULT_MAX_ACTIVE_COMMANDS = 500;
const DEFAULT_TERMINAL_HOT_LIMIT = 2_000;
const DEFAULT_TERMINAL_HOT_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const DEFAULT_TERMINAL_ARCHIVE_LIMIT = 10_000;
const DEFAULT_TERMINAL_ARCHIVE_BATCH = 100;
const TRANSITIONS = new Map([
  ["accepted", new Set(["queued", "attention-required", "dispatching", "started", "failed", "cancelled", "unknown"])],
  ["queued", new Set(["attention-required", "dispatching", "started", "failed", "cancelled", "unknown"])],
  ["attention-required", new Set(["queued", "dispatching", "started", "failed", "cancelled", "unknown"])],
  ["dispatching", new Set(["queued", "attention-required", "started", "failed", "cancelled", "unknown"])],
  ["unknown", new Set(["queued", "attention-required", "dispatching", "started", "failed", "cancelled"])],
  ["started", new Set(["completed", "failed", "cancelled", "unknown"])],
]);

export function messageCommandLedgerPath(dataDir) {
  return path.join(path.resolve(dataDir), "message-command-ledger.sqlite");
}

function configureDatabase(database, now = Date.now) {
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS};
    CREATE TABLE IF NOT EXISTS message_commands (
      client_user_message_id TEXT PRIMARY KEY,
      fingerprint TEXT,
      state TEXT NOT NULL CHECK (state IN (
        'accepted', 'queued', 'attention-required', 'dispatching',
        'started', 'completed', 'failed', 'cancelled', 'unknown'
      )),
      destination TEXT CHECK (destination IN ('pending', 'queued')),
      item_json TEXT,
      receipt_json TEXT,
      result_json TEXT,
      occupancy_key TEXT,
      occupancy_binding TEXT CHECK (occupancy_binding IN ('provisional', 'exact')),
      queue_order INTEGER,
      accepted_at_ms INTEGER NOT NULL,
      terminal_at_ms INTEGER,
      archived_at_ms INTEGER,
      updated_at_ms INTEGER NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS message_commands_state_idx
      ON message_commands(state, accepted_at_ms, client_user_message_id);
    CREATE TABLE IF NOT EXISTS message_command_terminal_archive (
      client_user_message_id TEXT PRIMARY KEY,
      fingerprint TEXT,
      state TEXT NOT NULL,
      destination TEXT,
      item_json TEXT,
      receipt_json TEXT,
      result_json TEXT,
      accepted_at_ms INTEGER NOT NULL,
      terminal_at_ms INTEGER NOT NULL,
      archived_at_ms INTEGER NOT NULL,
      revision INTEGER NOT NULL
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS message_command_terminal_archive_age_idx
      ON message_command_terminal_archive(archived_at_ms, client_user_message_id);
  `);
  const columns = new Set(database.prepare("PRAGMA table_info(message_commands)").all()
    .map((column) => String(column.name)));
  for (const [name, definition] of [
    ["result_json", "TEXT"],
    ["terminal_at_ms", "INTEGER"],
    ["archived_at_ms", "INTEGER"],
    ["occupancy_key", "TEXT"],
    ["occupancy_binding", "TEXT"],
    ["queue_order", "INTEGER"],
  ]) {
    if (!columns.has(name)) database.exec(`ALTER TABLE message_commands ADD COLUMN ${name} ${definition};`);
  }
  database.exec(`
    CREATE INDEX IF NOT EXISTS message_commands_terminal_idx
      ON message_commands(state, archived_at_ms, terminal_at_ms, client_user_message_id);
    CREATE INDEX IF NOT EXISTS message_commands_occupancy_idx
      ON message_commands(state, occupancy_key, queue_order, accepted_at_ms, client_user_message_id);
  `);
  repairOrphanedLegacyCommands(database, now);
  const activePlaceholders = ACTIVE_STATES.map(() => "?").join(", ");
  const legacyActive = database.prepare(`
    SELECT client_user_message_id, item_json, accepted_at_ms
    FROM message_commands
    WHERE state IN (${activePlaceholders}) AND occupancy_key IS NULL
  `).all(...ACTIVE_STATES);
  if (legacyActive.length) {
    const backfill = database.prepare(`
      UPDATE message_commands
      SET occupancy_key = ?, occupancy_binding = ?, queue_order = ?, revision = revision + 1
      WHERE client_user_message_id = ? AND occupancy_key IS NULL
    `);
    database.exec("BEGIN IMMEDIATE;");
    try {
      for (const row of legacyActive) {
        const item = parseJson(row.item_json);
        const occupancy = taskOccupancyIdentity(item);
        if (!occupancy) continue;
        const explicitOrder = Number(item?.queueOrder);
        backfill.run(
          occupancy.key,
          occupancy.binding,
          Number.isFinite(explicitOrder) ? explicitOrder : row.accepted_at_ms,
          row.client_user_message_id,
        );
      }
      database.exec("COMMIT;");
    } catch (error) {
      database.exec("ROLLBACK;");
      throw error;
    }
  }
}

function parseJson(value) {
  return value == null ? null : JSON.parse(value);
}

function parseJsonOrNull(value) {
  try {
    return parseJson(value);
  } catch {
    return null;
  }
}

function legacyOrphanTerminalState(result) {
  if (result?.cancelled === true) return "cancelled";
  if (result?.rejected === true || result?.failed === true) return "failed";
  if (result?.accepted === true && (
    result?.started === true
    || result?.dispatching === true
    || result?.runId
    || result?.turnId
  )) return "completed";
  return "failed";
}

function legacyOrphanTerminalResult(result, state) {
  const source = result && typeof result === "object" ? result : {};
  const terminal = {
    ...source,
    pending: false,
    deferred: false,
    queued: false,
    dispatching: false,
    unknown: false,
  };
  if (state === "completed") {
    return {
      ...terminal,
      accepted: true,
      started: true,
      completed: true,
      failed: false,
      cancelled: false,
      rejected: false,
    };
  }
  if (state === "cancelled") {
    return {
      ...terminal,
      accepted: false,
      started: false,
      completed: false,
      failed: false,
      cancelled: true,
      rejected: false,
    };
  }
  return {
    ...terminal,
    accepted: false,
    started: false,
    completed: false,
    failed: true,
    cancelled: false,
    rejected: true,
    error: String(source.error ?? "Legacy command payload is unavailable after migration"),
  };
}

function repairOrphanedLegacyCommands(database, now) {
  const activePlaceholders = ACTIVE_STATES.map(() => "?").join(", ");
  const orphaned = database.prepare(`
    SELECT client_user_message_id, state, receipt_json, result_json,
      accepted_at_ms, revision
    FROM message_commands
    WHERE item_json IS NULL AND state IN (${activePlaceholders})
  `).all(...ACTIVE_STATES);
  if (!orphaned.length) return 0;
  const update = database.prepare(`
    UPDATE message_commands
    SET state = ?, destination = NULL, result_json = ?,
        occupancy_key = NULL, occupancy_binding = NULL, queue_order = NULL,
        terminal_at_ms = COALESCE(terminal_at_ms, accepted_at_ms),
        updated_at_ms = ?, revision = revision + 1
    WHERE client_user_message_id = ? AND state = ? AND revision = ?
      AND item_json IS NULL
  `);
  const updatedAtMs = now();
  let repaired = 0;
  database.exec("BEGIN IMMEDIATE;");
  try {
    for (const row of orphaned) {
      const receipt = parseJsonOrNull(row.receipt_json);
      const result = parseJsonOrNull(row.result_json) ?? receipt?.result ?? null;
      const state = legacyOrphanTerminalState(result);
      const updateResult = update.run(
        state,
        JSON.stringify(legacyOrphanTerminalResult(result, state)),
        updatedAtMs,
        row.client_user_message_id,
        row.state,
        row.revision,
      );
      repaired += Number(updateResult.changes ?? 0);
    }
    database.exec("COMMIT;");
  } catch (error) {
    database.exec("ROLLBACK;");
    throw error;
  }
  return repaired;
}

function recordFromRow(row) {
  if (!row) return null;
  const parsedItem = parseJson(row.item_json);
  const item = parsedItem && row.occupancy_key
    ? {
        ...parsedItem,
        occupancyKey: row.occupancy_key,
        occupancyBinding: row.occupancy_binding,
        queueOrder: row.queue_order != null && Number.isFinite(Number(row.queue_order))
          ? Number(row.queue_order)
          : parsedItem.queueOrder,
      }
    : parsedItem;
  return {
    clientUserMessageId: row.client_user_message_id,
    fingerprint: row.fingerprint,
    state: row.state,
    destination: row.destination,
    item,
    receipt: parseJson(row.receipt_json),
    result: parseJson(row.result_json),
    occupancyKey: row.occupancy_key ?? null,
    occupancyBinding: row.occupancy_binding ?? null,
    queueOrder: row.queue_order != null && Number.isFinite(Number(row.queue_order))
      ? Number(row.queue_order)
      : null,
    acceptedAtMs: row.accepted_at_ms,
    terminalAtMs: row.terminal_at_ms,
    archivedAtMs: row.archived_at_ms,
    updatedAtMs: row.updated_at_ms,
    revision: row.revision,
  };
}

function clientMessageId(value) {
  return String(value?.clientUserMessageId ?? "").trim();
}

function receiptByClientId(value) {
  return new Map((Array.isArray(value?.desktopMessageReceipts)
    ? value.desktopMessageReceipts
    : []).flatMap((receipt) => {
    const id = clientMessageId(receipt);
    return id ? [[id, receipt]] : [];
  }));
}

function inputByClientId(value, key) {
  return new Map((Array.isArray(value?.[key]) ? value[key] : []).flatMap((item) => {
    const id = clientMessageId(item);
    return id ? [[id, item]] : [];
  }));
}

function runByClientId(value) {
  const runs = Array.isArray(value?.activeRuns)
    ? value.activeRuns
    : value?.activeRun && typeof value.activeRun === "object"
      ? [value.activeRun]
      : [];
  return new Map(runs.flatMap((run) => {
    const id = clientMessageId(run);
    return id ? [[id, run]] : [];
  }));
}

function stateFromEvidence({ pending, queued, run, receipt }) {
  const result = receipt?.result;
  if (result?.cancelled === true) return "cancelled";
  if (result?.rejected === true) return "failed";
  if (result?.steered === true) return "completed";
  if (run) return "started";
  if (queued) return queued.dispatchingAt ? "dispatching" : "queued";
  if (pending) return "attention-required";
  if (result?.dispatching === true) return "dispatching";
  if (result?.deferred === true) return result?.queued === true ? "queued" : "attention-required";
  if (result?.started === true || (result?.accepted === true && (result?.runId || result?.turnId))) {
    return "started";
  }
  return null;
}

function legacyStateFromEvidence(evidence) {
  const result = evidence.receipt?.result;
  if (!evidence.pending && !evidence.queued && !evidence.run) {
    return legacyOrphanTerminalState(result);
  }
  const state = stateFromEvidence(evidence);
  if (state) return state;
  if (result?.cancelled === true) return "cancelled";
  if (result?.rejected === true) return "failed";
  return "unknown";
}

function mayTransition(current, next) {
  return current === next
    || (ACTIVE_STATES.includes(current) && TERMINAL_STATES.has(next))
    || (!TERMINAL_STATES.has(current) && TRANSITIONS.get(current)?.has(next));
}

function projectedReceipt(record) {
  if (!record.fingerprint) return null;
  const identity = {
    provider: String(record.receipt?.provider ?? record.item?.provider ?? record.result?.provider ?? "").trim(),
    threadId: String(record.receipt?.threadId ?? record.item?.threadId ?? record.result?.threadId ?? "").trim(),
    clientUserMessageId: record.clientUserMessageId,
    fingerprint: record.fingerprint,
    createdAt: String(
      record.receipt?.createdAt
      ?? record.item?.createdAt
      ?? new Date(record.acceptedAtMs).toISOString(),
    ),
  };
  const result = {
    ...(record.receipt?.result ?? {}),
    ...(record.result ?? {}),
  };
  result.pending = false;
  if (["queued", "dispatching"].includes(record.state)) {
    result.accepted = record.item?.conflictKind === "message-intake" || result.accepted === true;
    result.deferred = true;
    result.queued = true;
    result.dispatching = record.state === "dispatching";
    if (record.item?.paused === true) result.paused = true;
  } else if (record.state === "attention-required" || record.state === "accepted") {
    result.accepted = false;
    result.deferred = true;
    result.queued = false;
    result.dispatching = false;
    result.attentionRequired = record.state === "attention-required";
  } else if (record.state === "started" || record.state === "completed") {
    result.accepted = true;
    result.deferred = false;
    result.queued = false;
    result.dispatching = false;
    result.started = true;
    if (record.state === "completed") result.completed = true;
  } else if (record.state === "cancelled") {
    result.accepted = false;
    result.deferred = false;
    result.queued = false;
    result.dispatching = false;
    result.cancelled = true;
  } else if (record.state === "failed") {
    result.accepted = false;
    result.pending = false;
    result.rejected = true;
  } else if (record.state === "unknown") {
    result.accepted = false;
    result.deferred = true;
    result.queued = false;
    result.unknown = true;
  }
  return { ...identity, result };
}

function terminalRetryTombstone(record) {
  const receipt = projectedReceipt(record);
  const source = receipt?.result ?? record.result ?? {};
  const result = {};
  for (const key of [
    "accepted", "pending", "deferred", "queued", "dispatching", "started",
    "completed", "failed", "cancelled", "rejected", "unknown", "steered",
  ]) {
    if (typeof source[key] === "boolean") result[key] = source[key];
  }
  for (const [key, limit] of [
    ["provider", 40], ["threadId", 500], ["turnId", 500], ["runId", 500],
    ["id", 500], ["status", 100], ["error", 2_000], ["message", 2_000],
  ]) {
    const value = String(source[key] ?? "").trim();
    if (value) result[key] = value.slice(0, limit);
  }
  if (!result.provider && receipt?.provider) result.provider = receipt.provider.slice(0, 40);
  if (!result.threadId && receipt?.threadId) result.threadId = receipt.threadId.slice(0, 500);
  const terminalRevision = Number(source.terminalRevision);
  if (Number.isSafeInteger(terminalRevision) && terminalRevision > 0) {
    result.terminalRevision = terminalRevision;
  }
  return result;
}

function overlayRecords(value, records) {
  if (!records.length) return value;
  const state = value && typeof value === "object" ? value : {};
  const ids = new Set(records.map((record) => record.clientUserMessageId));
  const pendingInputs = (Array.isArray(state.pendingInputs) ? state.pendingInputs : [])
    .filter((item) => !ids.has(clientMessageId(item)));
  const queuedInputs = (Array.isArray(state.queuedInputs) ? state.queuedInputs : [])
    .filter((item) => !ids.has(clientMessageId(item)));
  const receipts = (Array.isArray(state.desktopMessageReceipts) ? state.desktopMessageReceipts : [])
    .filter((receipt) => !ids.has(clientMessageId(receipt)));
  for (const record of records) {
    if (record.item && ["attention-required", "unknown"].includes(record.state)) pendingInputs.push(record.item);
    if (record.item && ["accepted", "queued", "dispatching"].includes(record.state)) {
      queuedInputs.push(record.item);
    }
    const receipt = projectedReceipt(record);
    if (receipt) receipts.push(receipt);
  }
  state.pendingInputs = pendingInputs;
  state.queuedInputs = queuedInputs;
  state.desktopMessageReceipts = receipts;
  return state;
}

function withoutOwnedProjectionRecords(value, records) {
  if (!records.length || !value || typeof value !== "object") return value;
  const ids = new Set(records.map((record) => record.clientUserMessageId));
  const withoutOwned = (values) => (Array.isArray(values)
    ? values.filter((item) => !ids.has(clientMessageId(item)))
    : values);
  return {
    ...value,
    pendingInputs: withoutOwned(value.pendingInputs),
    queuedInputs: withoutOwned(value.queuedInputs),
    desktopMessageReceipts: withoutOwned(value.desktopMessageReceipts),
  };
}

export class MessageCommandLedgerStore {
  #database;
  #now;
  #maxActiveCommands;
  #terminalHotLimit;
  #terminalHotRetentionMs;
  #terminalArchiveLimit;
  #terminalArchiveBatch;

  constructor({
    dataDir,
    readOnly = false,
    now = Date.now,
    maxActiveCommands = DEFAULT_MAX_ACTIVE_COMMANDS,
    terminalHotLimit = DEFAULT_TERMINAL_HOT_LIMIT,
    terminalHotRetentionMs = DEFAULT_TERMINAL_HOT_RETENTION_MS,
    terminalArchiveLimit = DEFAULT_TERMINAL_ARCHIVE_LIMIT,
    terminalArchiveBatch = DEFAULT_TERMINAL_ARCHIVE_BATCH,
  }) {
    this.#now = now;
    this.#maxActiveCommands = Math.max(1, Math.trunc(maxActiveCommands));
    this.#terminalHotLimit = Math.max(0, Math.trunc(terminalHotLimit));
    this.#terminalHotRetentionMs = Math.max(1, Math.trunc(terminalHotRetentionMs));
    this.#terminalArchiveLimit = Math.max(0, Math.trunc(terminalArchiveLimit));
    this.#terminalArchiveBatch = Math.max(1, Math.trunc(terminalArchiveBatch));
    this.#database = new DatabaseSync(
      messageCommandLedgerPath(dataDir),
      readOnly ? { readOnly: true } : {},
    );
    if (readOnly) this.#database.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS};`);
    else {
      configureDatabase(this.#database, this.#now);
      this.#archiveTerminalPayloads();
    }
  }

  accept({ item, destination = "pending", receipt = null }) {
    const itemId = clientMessageId(item);
    const receiptId = clientMessageId(receipt);
    const id = itemId || receiptId;
    const fingerprint = String(receipt?.fingerprint ?? "").trim();
    if (!id) throw new TypeError("clientUserMessageId is required for durable message intake");
    if (itemId && receiptId && itemId !== receiptId) {
      throw new TypeError("durable message intake identity mismatch");
    }
    if (!fingerprint) throw new TypeError("message fingerprint is required for durable message intake");
    const normalizedDestination = destination === "queued" ? "queued" : "pending";
    const state = normalizedDestination === "queued" ? "queued" : "attention-required";
    const existing = this.get(id);
    if (existing) {
      if (existing.fingerprint && existing.fingerprint !== fingerprint) {
        const error = new Error("Идентификатор сообщения уже используется для другого содержимого");
        error.code = "MESSAGE_RECEIPT_FINGERPRINT_MISMATCH";
        throw error;
      }
      if (!existing.fingerprint) {
        this.#database.prepare(`
          UPDATE message_commands
          SET fingerprint = ?, receipt_json = ?, updated_at_ms = ?, revision = revision + 1
          WHERE client_user_message_id = ? AND fingerprint IS NULL
        `).run(fingerprint, JSON.stringify(receipt), this.#now(), id);
      }
      const record = this.get(id);
      return { record, duplicate: true, retryResult: projectedReceipt(record)?.result ?? record.result };
    }
    if (this.activeCount() >= this.#maxActiveCommands) {
      const error = new Error(`durable message command capacity is exhausted (${this.#maxActiveCommands})`);
      error.code = "MESSAGE_COMMAND_CAPACITY_EXHAUSTED";
      throw error;
    }
    const acceptedAtMs = this.#now();
    const occupancy = taskOccupancyIdentity(item);
    const explicitQueueOrder = Number(item?.queueOrder);
    const queueOrder = Number.isFinite(explicitQueueOrder) ? explicitQueueOrder : acceptedAtMs;
    const durableItem = occupancy
      ? {
          ...item,
          occupancyKey: occupancy.key,
          occupancyBinding: occupancy.binding,
          queueOrder,
        }
      : item;
    const result = this.#database.prepare(`
      INSERT OR IGNORE INTO message_commands (
        client_user_message_id, fingerprint, state, destination,
        item_json, receipt_json, occupancy_key, occupancy_binding, queue_order,
        accepted_at_ms, updated_at_ms, revision
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    `).run(
      id,
      fingerprint,
      state,
      normalizedDestination,
      JSON.stringify(durableItem),
      JSON.stringify(receipt),
      occupancy?.key ?? null,
      occupancy?.binding ?? null,
      occupancy ? queueOrder : null,
      acceptedAtMs,
      acceptedAtMs,
    );
    const record = this.get(id);
    if (record.fingerprint && record.fingerprint !== fingerprint) {
      const error = new Error("Идентификатор сообщения уже используется для другого содержимого");
      error.code = "MESSAGE_RECEIPT_FINGERPRINT_MISMATCH";
      throw error;
    }
    return {
      record,
      duplicate: result.changes === 0,
      retryResult: result.changes === 0
        ? projectedReceipt(record)?.result ?? record.result
        : null,
    };
  }

  migrateLegacy(value) {
    const receipts = receiptByClientId(value);
    const pending = inputByClientId(value, "pendingInputs");
    const queued = inputByClientId(value, "queuedInputs");
    const runs = runByClientId(value);
    const ids = new Set([...receipts.keys(), ...pending.keys(), ...queued.keys(), ...runs.keys()]);
    if (!ids.size) return 0;
    const now = this.#now();
    const insert = this.#database.prepare(`
      INSERT OR IGNORE INTO message_commands (
        client_user_message_id, fingerprint, state, destination,
        item_json, receipt_json, result_json, occupancy_key, occupancy_binding,
        queue_order, accepted_at_ms, terminal_at_ms, updated_at_ms, revision
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    `);
    let migrated = 0;
    this.#database.exec("BEGIN IMMEDIATE;");
    try {
      for (const id of ids) {
        const pendingItem = pending.get(id);
        const queuedItem = queued.get(id);
        const item = queuedItem ?? pendingItem ?? null;
        const receipt = receipts.get(id) ?? null;
        const run = runs.get(id) ?? null;
        const state = legacyStateFromEvidence({ pending: pendingItem, queued: queuedItem, run, receipt });
        const resultPayload = !pendingItem && !queuedItem && !run
          ? legacyOrphanTerminalResult(receipt?.result, state)
          : receipt?.result ?? null;
        const destination = queuedItem ? "queued" : pendingItem ? "pending" : null;
        const acceptedAtMs = Date.parse(String(item?.createdAt ?? receipt?.createdAt ?? "")) || now;
        const occupancy = taskOccupancyIdentity(item);
        const explicitQueueOrder = Number(item?.queueOrder);
        const queueOrder = Number.isFinite(explicitQueueOrder) ? explicitQueueOrder : acceptedAtMs;
        const durableItem = item && occupancy
          ? {
              ...item,
              occupancyKey: occupancy.key,
              occupancyBinding: occupancy.binding,
              queueOrder,
            }
          : item;
        const insertResult = insert.run(
          id,
          String(receipt?.fingerprint ?? "").trim() || null,
          state,
          destination,
          durableItem ? JSON.stringify(durableItem) : null,
          receipt ? JSON.stringify(receipt) : null,
          resultPayload ? JSON.stringify(resultPayload) : null,
          occupancy?.key ?? null,
          occupancy?.binding ?? null,
          occupancy ? queueOrder : null,
          acceptedAtMs,
          TERMINAL_STATES.has(state) ? acceptedAtMs : null,
          now,
        );
        migrated += Number(insertResult.changes ?? 0);
      }
      this.#database.exec("COMMIT;");
    } catch (error) {
      this.#database.exec("ROLLBACK;");
      throw error;
    }
    this.#archiveTerminalPayloads();
    return migrated;
  }

  projectSnapshot(value) {
    const receipts = receiptByClientId(value);
    const pending = inputByClientId(value, "pendingInputs");
    const queued = inputByClientId(value, "queuedInputs");
    const runs = runByClientId(value);
    const evidenceIds = new Set([...receipts.keys(), ...pending.keys(), ...queued.keys(), ...runs.keys()]);
    const records = this.activeRecords().filter((record) => (
      evidenceIds.has(record.clientUserMessageId)
    ));
    if (!records.length) return { scanned: 0, changed: 0 };
    const update = this.#database.prepare(`
      UPDATE message_commands
      SET state = ?, destination = ?, item_json = ?, receipt_json = ?, result_json = ?,
          occupancy_key = ?, occupancy_binding = ?, queue_order = ?,
          terminal_at_ms = ?, updated_at_ms = ?, revision = revision + 1
      WHERE client_user_message_id = ? AND state = ? AND revision = ?
    `);
    const now = this.#now();
    let changed = 0;
    let terminalChanged = false;
    this.#database.exec("BEGIN IMMEDIATE;");
    try {
      for (const record of records) {
        const id = record.clientUserMessageId;
        const pendingItem = pending.get(id);
        const queuedItem = queued.get(id);
        const run = runs.get(id);
        const receipt = receipts.get(id);
        const nextState = stateFromEvidence({
          pending: pendingItem,
          queued: queuedItem,
          run,
          receipt,
        });
        if (!nextState || !mayTransition(record.state, nextState)) continue;
        const evidenceItem = queuedItem ?? pendingItem ?? record.item;
        const destination = queuedItem ? "queued" : pendingItem ? "pending" : record.destination;
        const inferredOccupancy = taskOccupancyIdentity(run ?? evidenceItem);
        const preserveExactBinding = record.occupancyBinding === "exact"
          && (
            inferredOccupancy?.binding !== "exact"
            || inferredOccupancy.key !== record.occupancyKey
          );
        const inferredItem = run && inferredOccupancy?.binding === "exact"
          ? {
              ...evidenceItem,
              ...Object.fromEntries([
                "streamId", "provider", "projectRoot", "threadId", "taskTitle",
              ].flatMap((key) => run[key] == null ? [] : [[key, run[key]]])),
            }
          : evidenceItem;
        const item = preserveExactBinding ? record.item : inferredItem;
        const occupancy = record.occupancyBinding === "exact"
          && inferredOccupancy?.binding !== "exact"
          ? { key: record.occupancyKey, binding: record.occupancyBinding }
          : inferredOccupancy ?? (record.occupancyKey
            ? { key: record.occupancyKey, binding: record.occupancyBinding }
            : null);
        const explicitQueueOrder = Number(item?.queueOrder);
        const queueOrder = Number.isFinite(explicitQueueOrder)
          ? explicitQueueOrder
          : record.queueOrder ?? record.acceptedAtMs;
        const durableItem = item && occupancy
          ? {
              ...item,
              occupancyKey: occupancy.key,
              occupancyBinding: occupancy.binding,
              queueOrder,
            }
          : item;
        const terminal = TERMINAL_STATES.has(nextState);
        const updated = update.run(
          nextState,
          destination,
          durableItem ? JSON.stringify(durableItem) : null,
          receipt ? JSON.stringify(receipt) : record.receipt ? JSON.stringify(record.receipt) : null,
          receipt?.result ? JSON.stringify(receipt.result) : record.result ? JSON.stringify(record.result) : null,
          occupancy?.key ?? null,
          occupancy?.binding ?? null,
          occupancy ? queueOrder : null,
          terminal ? now : record.terminalAtMs,
          now,
          id,
          record.state,
          record.revision,
        );
        terminalChanged ||= terminal && updated.changes > 0;
        changed += Number(updated.changes ?? 0);
      }
      this.#database.exec("COMMIT;");
    } catch (error) {
      this.#database.exec("ROLLBACK;");
      throw error;
    }
    if (terminalChanged) this.#archiveTerminalPayloads();
    return { scanned: records.length, changed };
  }

  transition({
    clientUserMessageId,
    expectedStates = ACTIVE_STATES,
    state,
    result = null,
    authoritativeTerminal = false,
  }) {
    const id = String(clientUserMessageId ?? "").trim();
    const nextState = String(state ?? "").trim();
    if (!id) throw new TypeError("clientUserMessageId is required for command transition");
    if (![...ACTIVE_STATES, ...TERMINAL_STATES].includes(nextState)) {
      throw new TypeError(`invalid message command state ${nextState}`);
    }
    const current = this.get(id);
    if (!current) return { changed: false, idempotent: false, conflict: false, record: null };
    const incomingTerminalRevision = Number(result?.terminalRevision) || 0;
    const currentTerminalRevision = Number(current.result?.terminalRevision) || 0;
    const authoritativeUpdate = authoritativeTerminal === true
      && TERMINAL_STATES.has(nextState)
      && incomingTerminalRevision >= currentTerminalRevision
      && (
        current.state !== nextState
        || currentTerminalRevision === 0
        || incomingTerminalRevision > currentTerminalRevision
      );
    if (current.state === nextState && !authoritativeUpdate) {
      return { changed: false, idempotent: true, conflict: false, record: current };
    }
    const expected = new Set((Array.isArray(expectedStates) ? expectedStates : [expectedStates])
      .map((value) => String(value ?? "").trim()));
    if ((!expected.has(current.state) || !mayTransition(current.state, nextState)) && !authoritativeUpdate) {
      return { changed: false, idempotent: false, conflict: true, record: current };
    }
    const now = this.#now();
    const terminal = TERMINAL_STATES.has(nextState);
    const serializedResult = result == null
      ? current.result == null ? null : JSON.stringify(current.result)
      : JSON.stringify(result);
    const update = this.#database.prepare(`
      UPDATE message_commands
      SET state = ?, result_json = ?, terminal_at_ms = ?, updated_at_ms = ?,
          revision = revision + 1
      WHERE client_user_message_id = ? AND state = ? AND revision = ?
    `).run(
      nextState,
      serializedResult,
      terminal ? now : current.terminalAtMs,
      now,
      id,
      current.state,
      current.revision,
    );
    if (update.changes === 0) {
      const record = this.get(id);
      return {
        changed: false,
        idempotent: record?.state === nextState,
        conflict: record?.state !== nextState,
        record,
      };
    }
    if (terminal) this.#archiveTerminalPayloads();
    return { changed: true, idempotent: false, conflict: false, record: this.get(id) };
  }

  rekeyOccupancy({ clientUserMessageId, expectedOccupancyKey = null, target }) {
    const id = String(clientUserMessageId ?? "").trim();
    if (!id) throw new TypeError("clientUserMessageId is required for occupancy rekey");
    const next = taskOccupancyIdentity(target);
    if (!next || next.binding !== "exact") {
      throw new TypeError("exact streamId/provider/threadId occupancy binding is required");
    }
    const current = this.get(id);
    if (!current) return { changed: false, idempotent: false, conflict: false, record: null };
    if (current.occupancyBinding === "exact") {
      return {
        changed: false,
        idempotent: current.occupancyKey === next.key,
        conflict: current.occupancyKey !== next.key,
        record: current,
      };
    }
    const expected = String(expectedOccupancyKey ?? "").trim();
    if (expected && current.occupancyKey && expected !== current.occupancyKey) {
      return { changed: false, idempotent: false, conflict: true, record: current };
    }
    if (!ACTIVE_STATES.includes(current.state)) {
      return { changed: false, idempotent: false, conflict: true, record: current };
    }
    const nextItem = {
      ...(current.item ?? {}),
      ...Object.fromEntries([
        "streamId", "provider", "projectRoot", "threadId", "taskTitle",
      ].flatMap((key) => target?.[key] == null ? [] : [[key, target[key]]])),
      occupancyKey: next.key,
      occupancyBinding: next.binding,
      queueOrder: current.queueOrder ?? current.acceptedAtMs,
    };
    const now = this.#now();
    const update = this.#database.prepare(`
      UPDATE message_commands
      SET occupancy_key = ?, occupancy_binding = 'exact', item_json = ?,
          queue_order = ?, updated_at_ms = ?, revision = revision + 1
      WHERE client_user_message_id = ? AND revision = ?
        AND state = ? AND (occupancy_binding IS NULL OR occupancy_binding = 'provisional')
    `).run(
      next.key,
      JSON.stringify(nextItem),
      nextItem.queueOrder,
      now,
      id,
      current.revision,
      current.state,
    );
    if (update.changes === 0) {
      const record = this.get(id);
      return {
        changed: false,
        idempotent: record?.occupancyBinding === "exact" && record.occupancyKey === next.key,
        conflict: record?.occupancyBinding === "exact" && record.occupancyKey !== next.key,
        record,
      };
    }
    return { changed: true, idempotent: false, conflict: false, record: this.get(id) };
  }

  activeCount() {
    const placeholders = ACTIVE_STATES.map(() => "?").join(", ");
    return Number(this.#database.prepare(`
      SELECT COUNT(*) AS count FROM message_commands WHERE state IN (${placeholders})
    `).get(...ACTIVE_STATES).count);
  }

  activeRecords() {
    const placeholders = ACTIVE_STATES.map(() => "?").join(", ");
    return this.#database.prepare(`
      SELECT * FROM message_commands
      WHERE state IN (${placeholders})
      ORDER BY accepted_at_ms, client_user_message_id
    `).all(...ACTIVE_STATES).map(recordFromRow);
  }

  projectionRecords() {
    const terminalStates = [...TERMINAL_STATES];
    const placeholders = terminalStates.map(() => "?").join(", ");
    const terminal = this.#terminalHotLimit > 0
      ? this.#database.prepare(`
          SELECT * FROM message_commands
          WHERE state IN (${placeholders}) AND archived_at_ms IS NULL
          ORDER BY terminal_at_ms DESC, client_user_message_id
          LIMIT ?
        `).all(...terminalStates, this.#terminalHotLimit).map(recordFromRow)
      : [];
    return [...this.activeRecords(), ...terminal];
  }

  retentionStats() {
    const active = this.activeCount();
    const terminalStates = [...TERMINAL_STATES];
    const placeholders = terminalStates.map(() => "?").join(", ");
    const terminal = this.#database.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN archived_at_ms IS NULL THEN 1 ELSE 0 END) AS hot,
        SUM(CASE WHEN archived_at_ms IS NOT NULL THEN 1 ELSE 0 END) AS tombstones
      FROM message_commands WHERE state IN (${placeholders})
    `).get(...terminalStates);
    const archive = this.#database.prepare(`
      SELECT COUNT(*) AS count FROM message_command_terminal_archive
    `).get();
    return {
      active,
      terminal: Number(terminal.total ?? 0),
      hotTerminal: Number(terminal.hot ?? 0),
      terminalTombstones: Number(terminal.tombstones ?? 0),
      archivedPayloads: Number(archive.count ?? 0),
    };
  }

  get(id) {
    return recordFromRow(this.#database.prepare(`
      SELECT * FROM message_commands WHERE client_user_message_id = ?
    `).get(String(id ?? "").trim()));
  }

  records() {
    return this.#database.prepare(`
      SELECT * FROM message_commands ORDER BY accepted_at_ms, client_user_message_id
    `).all().map(recordFromRow);
  }

  overlay(value) {
    return overlayRecords(value, this.projectionRecords());
  }

  withoutOwnedProjections(value) {
    return withoutOwnedProjectionRecords(value, this.projectionRecords());
  }

  #archiveTerminalPayloads() {
    const terminalStates = [...TERMINAL_STATES];
    const placeholders = terminalStates.map(() => "?").join(", ");
    const now = this.#now();
    const cutoff = now - this.#terminalHotRetentionMs;
    this.#database.prepare(`
      UPDATE message_commands
      SET terminal_at_ms = COALESCE(updated_at_ms, accepted_at_ms)
      WHERE client_user_message_id IN (
        SELECT client_user_message_id FROM message_commands
        WHERE state IN (${placeholders}) AND terminal_at_ms IS NULL
        ORDER BY updated_at_ms, client_user_message_id
        LIMIT ?
      )
    `).run(...terminalStates, this.#terminalArchiveBatch);
    const hotCount = Number(this.#database.prepare(`
      SELECT COUNT(*) AS count FROM message_commands
      WHERE state IN (${placeholders}) AND archived_at_ms IS NULL
    `).get(...terminalStates).count);
    const hasExcess = hotCount > this.#terminalHotLimit ? 1 : 0;
    const candidates = this.#database.prepare(`
      SELECT * FROM message_commands
      WHERE state IN (${placeholders}) AND archived_at_ms IS NULL
        AND (terminal_at_ms <= ? OR ? = 1)
      ORDER BY terminal_at_ms, client_user_message_id
      LIMIT ?
    `).all(...terminalStates, cutoff, hasExcess, this.#terminalArchiveBatch);
    if (!candidates.length) return { archived: 0, pruned: 0 };
    const archive = this.#database.prepare(`
      INSERT OR REPLACE INTO message_command_terminal_archive (
        client_user_message_id, fingerprint, state, destination,
        item_json, receipt_json, result_json, accepted_at_ms,
        terminal_at_ms, archived_at_ms, revision
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const compact = this.#database.prepare(`
      UPDATE message_commands
      SET item_json = NULL, receipt_json = NULL, result_json = ?, archived_at_ms = ?,
          updated_at_ms = ?, revision = revision + 1
      WHERE client_user_message_id = ? AND archived_at_ms IS NULL
    `);
    this.#database.exec("BEGIN IMMEDIATE;");
    try {
      for (const row of candidates) {
        const record = recordFromRow(row);
        archive.run(
          row.client_user_message_id,
          row.fingerprint,
          row.state,
          row.destination,
          row.item_json,
          row.receipt_json,
          row.result_json,
          row.accepted_at_ms,
          row.terminal_at_ms ?? now,
          now,
          row.revision,
        );
        compact.run(
          JSON.stringify(terminalRetryTombstone(record)),
          now,
          now,
          row.client_user_message_id,
        );
      }
      this.#database.prepare(`
        DELETE FROM message_command_terminal_archive
        WHERE client_user_message_id IN (
          SELECT client_user_message_id
          FROM message_command_terminal_archive
          ORDER BY archived_at_ms DESC, client_user_message_id DESC
          LIMIT -1 OFFSET ?
        )
      `).run(this.#terminalArchiveLimit);
      this.#database.exec("COMMIT;");
    } catch (error) {
      this.#database.exec("ROLLBACK;");
      throw error;
    }
    return { archived: candidates.length, pruned: Math.max(0, candidates.length - this.#terminalArchiveLimit) };
  }

  close() {
    this.#database.close();
  }
}

export function overlayMessageCommandLedgerSync(dataDir, value) {
  let ledger;
  try {
    ledger = new MessageCommandLedgerStore({ dataDir, readOnly: true });
    return ledger.overlay(value);
  } catch (error) {
    if (/unable to open database file|no such (?:table|column)/iu.test(String(error?.message ?? error))) return value;
    throw error;
  } finally {
    ledger?.close();
  }
}
