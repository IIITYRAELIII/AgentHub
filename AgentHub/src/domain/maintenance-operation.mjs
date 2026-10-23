export const MAINTENANCE_OPERATION_KINDS = Object.freeze({
  RESTART: "restart",
  CONTEXT_COMPACTION: "context-compaction",
  STORAGE_RETENTION: "storage-retention",
});

export const MAINTENANCE_OPERATION_STATUSES = Object.freeze({
  REQUESTED: "requested",
  BLOCKED: "blocked",
  RUNNING: "running",
  RECONCILING: "reconciling",
  SUCCEEDED: "succeeded",
  FAILED: "failed",
});

const STATUS_RANK = new Map([
  [MAINTENANCE_OPERATION_STATUSES.REQUESTED, 0],
  [MAINTENANCE_OPERATION_STATUSES.BLOCKED, 1],
  [MAINTENANCE_OPERATION_STATUSES.RUNNING, 2],
  [MAINTENANCE_OPERATION_STATUSES.RECONCILING, 3],
  [MAINTENANCE_OPERATION_STATUSES.SUCCEEDED, 4],
  [MAINTENANCE_OPERATION_STATUSES.FAILED, 4],
]);

const TERMINAL_STATUSES = new Set([
  MAINTENANCE_OPERATION_STATUSES.SUCCEEDED,
  MAINTENANCE_OPERATION_STATUSES.FAILED,
]);

function requiredIdentifier(value, name) {
  const normalized = String(value ?? "").trim();
  if (!normalized) throw new TypeError(`${name} is required`);
  return normalized;
}

function optionalIdentifier(value) {
  return String(value ?? "").trim() || null;
}

function normalizedStatus(value) {
  const status = String(value ?? "").trim();
  if (!STATUS_RANK.has(status)) throw new TypeError(`unsupported maintenance status: ${status}`);
  return status;
}

function normalizedBlockers(value) {
  return [...new Set((Array.isArray(value) ? value : [])
    .map((entry) => String(entry ?? "").trim())
    .filter(Boolean))].sort();
}

function normalizedMetadata(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? structuredClone(value)
    : {};
}

function operationTimestamp(value, fallback) {
  const parsed = Date.parse(String(value ?? ""));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : fallback;
}

export function maintenanceOperationIsTerminal(operation) {
  return TERMINAL_STATUSES.has(String(operation?.status ?? ""));
}

export function createMaintenanceOperation({
  operationId,
  kind,
  streamId,
  threadId,
  providerTurnId = null,
  status = MAINTENANCE_OPERATION_STATUSES.REQUESTED,
  phase = "requested",
  blockers = [],
  outcome = null,
  metadata = {},
  createdAt,
  updatedAt = createdAt,
} = {}) {
  const normalizedKind = String(kind ?? "").trim();
  if (!Object.values(MAINTENANCE_OPERATION_KINDS).includes(normalizedKind)) {
    throw new TypeError(`unsupported maintenance kind: ${normalizedKind}`);
  }
  const created = operationTimestamp(createdAt, new Date().toISOString());
  const operation = {
    entityType: "maintenance-operation",
    userTurn: false,
    operationId: requiredIdentifier(operationId, "operationId"),
    kind: normalizedKind,
    streamId: requiredIdentifier(streamId, "streamId"),
    threadId: requiredIdentifier(threadId, "threadId"),
    providerTurnId: optionalIdentifier(providerTurnId),
    status: normalizedStatus(status),
    phase: requiredIdentifier(phase, "phase"),
    blockers: normalizedBlockers(blockers),
    outcome: optionalIdentifier(outcome),
    revision: 1,
    metadata: normalizedMetadata(metadata),
    createdAt: created,
    updatedAt: operationTimestamp(updatedAt, created),
    completedAt: null,
  };
  if (maintenanceOperationIsTerminal(operation)) {
    operation.blockers = [];
    operation.completedAt = operation.updatedAt;
  }
  return operation;
}

export function restoreMaintenanceOperation(value) {
  if (!value || typeof value !== "object") return null;
  try {
    const operation = createMaintenanceOperation(value);
    const revision = Number(value.revision);
    if (!Number.isSafeInteger(revision) || revision < 1) return null;
    operation.revision = revision;
    operation.completedAt = maintenanceOperationIsTerminal(operation)
      ? operationTimestamp(value.completedAt, operation.updatedAt)
      : null;
    return operation;
  } catch {
    return null;
  }
}

export function transitionMaintenanceOperation(current, patch = {}, {
  expectedRevision = current?.revision,
  updatedAt = new Date().toISOString(),
} = {}) {
  const operation = restoreMaintenanceOperation(current);
  if (!operation) throw new TypeError("valid current maintenance operation is required");
  if (expectedRevision !== operation.revision) {
    return { operation, applied: false, reason: "stale-revision" };
  }
  if (maintenanceOperationIsTerminal(operation)) {
    return { operation, applied: false, reason: "terminal" };
  }
  for (const name of ["operationId", "kind", "streamId", "threadId"]) {
    if (patch[name] !== undefined && String(patch[name]) !== operation[name]) {
      throw new Error(`${name} is immutable`);
    }
  }
  const status = normalizedStatus(patch.status ?? operation.status);
  if (STATUS_RANK.get(status) < STATUS_RANK.get(operation.status)) {
    return { operation, applied: false, reason: "status-regression" };
  }
  const providerTurnId = optionalIdentifier(patch.providerTurnId ?? operation.providerTurnId);
  if (operation.providerTurnId && providerTurnId && operation.providerTurnId !== providerTurnId) {
    return { operation, applied: false, reason: "provider-turn-mismatch" };
  }
  const next = {
    ...operation,
    providerTurnId,
    status,
    phase: requiredIdentifier(patch.phase ?? operation.phase, "phase"),
    blockers: normalizedBlockers(patch.blockers ?? operation.blockers),
    outcome: optionalIdentifier(patch.outcome ?? operation.outcome),
    metadata: patch.metadata === undefined
      ? operation.metadata
      : { ...operation.metadata, ...normalizedMetadata(patch.metadata) },
    revision: operation.revision + 1,
    updatedAt: operationTimestamp(updatedAt, new Date().toISOString()),
  };
  if (maintenanceOperationIsTerminal(next)) {
    next.blockers = [];
    next.completedAt = next.updatedAt;
  }
  return { operation: next, applied: true, reason: null };
}

export function unknownMaintenanceOutcome(operation, { updatedAt } = {}) {
  return transitionMaintenanceOperation(operation, {
    status: MAINTENANCE_OPERATION_STATUSES.RECONCILING,
    phase: "reconciling",
    blockers: ["authoritative-state-unknown"],
    outcome: "unknown",
  }, { expectedRevision: operation?.revision, updatedAt });
}

export function restartRequestProjection(operation, notification = {}) {
  const restored = restoreMaintenanceOperation(operation);
  if (!restored || restored.kind !== MAINTENANCE_OPERATION_KINDS.RESTART) return null;
  const metadata = { ...restored.metadata, ...normalizedMetadata(notification) };
  const blockingCount = Math.max(0, Number(metadata.blockingCount) || 0);
  return {
    ...restored,
    chatId: Number.isSafeInteger(metadata.chatId) ? metadata.chatId : null,
    messageId: Number.isSafeInteger(metadata.messageId) ? metadata.messageId : null,
    requestedAt: restored.createdAt,
    minimumUpdateOffset: Number.isSafeInteger(metadata.minimumUpdateOffset)
      ? metadata.minimumUpdateOffset
      : 0,
    notifyTelegram: metadata.notifyTelegram === true,
    waitingForRuns: restored.blockers.includes("active-work"),
    blockingCount,
  };
}

// A failed restart is explained only while it is recent and no later restart
// has settled successfully.
export const RESTART_FAILURE_NOTICE_WINDOW_MS = 15 * 60_000;

// A runtime restart requested while no Stream and Thread are selected is scoped
// to the runtime itself. Scheduling does not close admission; only the actual
// stopping fence does. This scope never grants or blocks a specific Thread.
export const RUNTIME_RESTART_SCOPE = Object.freeze({
  streamId: "agent-hub-runtime",
  threadId: "agent-hub-runtime",
});

export function restartFailureProjection(operation) {
  const restored = restoreMaintenanceOperation(operation);
  if (!restored || restored.kind !== MAINTENANCE_OPERATION_KINDS.RESTART
    || restored.status !== MAINTENANCE_OPERATION_STATUSES.FAILED) return null;
  return {
    operationId: restored.operationId,
    error: String(restored.metadata?.error ?? "").trim() || null,
    failedAt: restored.completedAt ?? restored.updatedAt ?? null,
  };
}

export function restartUiProjection(operation) {
  const restored = restoreMaintenanceOperation(operation);
  if (!restored || restored.kind !== MAINTENANCE_OPERATION_KINDS.RESTART) {
    return { pending: false, waiting: false, blockingCount: 0, phase: null, blockers: [] };
  }
  return {
    pending: !maintenanceOperationIsTerminal(restored),
    waiting: restored.blockers.includes("active-work"),
    blockingCount: Math.max(0, Number(restored.metadata?.blockingCount) || 0),
    phase: restored.phase,
    blockers: [...restored.blockers],
  };
}
