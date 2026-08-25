import { randomUUID } from "node:crypto";

export const COMMAND_TRACE_STAGES = Object.freeze({
  CLIENT_SUBMIT: "client-submit",
  TRANSPORT_START: "transport-start",
  HUB_RECEIVE: "hub-receive",
  RECEIPT_LOCK_WAIT: "receipt-lock-wait",
  ATTACHMENT_PREPARATION: "attachment-preparation",
  DURABLE_INTAKE_ENQUEUE: "durable-intake-enqueue",
  DURABLE_INTAKE_START: "durable-intake-start",
  DURABLE_INTAKE_COMMIT: "durable-intake-commit",
  RESPONSE_SEND: "response-send",
  CLIENT_ACK: "client-ack",
  DISPATCH: "dispatch",
  ADMISSION: "admission",
  PROVIDER_RPC: "provider-rpc",
  PROVIDER_ACCEPT: "provider-accept",
  FIRST_EVENT: "first-event",
  FIRST_CONTENT: "first-content",
  FIRST_VISIBLE: "first-visible",
  TERMINAL_COMMIT: "terminal-commit",
  TERMINAL_HISTORY: "terminal-history",
  PROJECTION_VISIBLE: "projection-visible",
});

export const COMMAND_TRACE_OUTCOMES = Object.freeze({
  STARTED: "started",
  SUCCEEDED: "succeeded",
  FAILED: "failed",
  QUEUED: "queued",
  UNKNOWN: "unknown",
});

const TOKEN_PATTERN = /^[a-z][a-z0-9.-]{0,63}$/u;
const MAX_ID_LENGTH = 256;
const MAX_METADATA_BYTES = 16 * 1024;

function requiredId(value, name) {
  const normalized = String(value ?? "").trim();
  if (!normalized || normalized.length > MAX_ID_LENGTH) {
    throw new TypeError(`${name} must be a non-empty string of at most ${MAX_ID_LENGTH} characters`);
  }
  return normalized;
}

function requiredToken(value, name) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!TOKEN_PATTERN.test(normalized)) {
    throw new TypeError(`${name} must be a lowercase trace token`);
  }
  return normalized;
}

function nonNegativeNumber(value, name, { integer = false } = {}) {
  const normalized = Number(value);
  if (!Number.isFinite(normalized) || normalized < 0 || (integer && !Number.isSafeInteger(normalized))) {
    throw new TypeError(`${name} must be a non-negative ${integer ? "safe integer" : "number"}`);
  }
  return normalized;
}

function optionalNonNegativeNumber(value, name, options) {
  return value === undefined || value === null
    ? null
    : nonNegativeNumber(value, name, options);
}

function normalizeMetadata(value) {
  if (value === undefined || value === null) return Object.freeze({});
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("metadata must be an object");
  }
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch (error) {
    throw new TypeError(`metadata must be JSON-serializable: ${error.message}`);
  }
  if (serialized === undefined || Buffer.byteLength(serialized, "utf8") > MAX_METADATA_BYTES) {
    throw new TypeError(`metadata must not exceed ${MAX_METADATA_BYTES} UTF-8 bytes`);
  }
  return Object.freeze(JSON.parse(serialized));
}

export function normalizeCommandTraceSpan(input, {
  clock = Date.now,
  createSpanId = randomUUID,
} = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("command trace span must be an object");
  }
  const observedAtMs = input.observedAtMs ?? clock();
  return Object.freeze({
    spanId: requiredId(input.spanId ?? createSpanId(), "spanId"),
    commandId: requiredId(input.commandId, "commandId"),
    stage: requiredToken(input.stage, "stage"),
    outcome: requiredToken(input.outcome, "outcome"),
    transport: requiredToken(input.transport, "transport"),
    observedAtMs: nonNegativeNumber(observedAtMs, "observedAtMs", { integer: true }),
    monotonicDurationMs: nonNegativeNumber(
      input.monotonicDurationMs ?? 0,
      "monotonicDurationMs",
    ),
    queueDepth: optionalNonNegativeNumber(input.queueDepth, "queueDepth", { integer: true }),
    lockWaitMs: optionalNonNegativeNumber(input.lockWaitMs, "lockWaitMs"),
    sqliteBusyWaitMs: optionalNonNegativeNumber(input.sqliteBusyWaitMs, "sqliteBusyWaitMs"),
    metadata: normalizeMetadata(input.metadata),
  });
}
