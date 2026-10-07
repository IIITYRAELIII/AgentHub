import { clientCommandAckTraceSpan } from "./client-command-trace.mjs";

const ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,199}$/u;
const TOKEN = /^[a-z][a-z0-9.-]{0,63}$/u;
const STAGES = new Set(["ui-interaction", "ui-navigation", "ui-render", "ui-long-task", "ui-snapshot", "ui-control"]);
const LABELS = new Set(["action", "surface", "view", "trigger", "render"]);
const NUMBERS = new Set(["count", "longTaskCount", "maxLongTaskMs", "totalLongTaskMs", "droppedEvents", "droppedCount", "queueDepth"]);
const FAILURE_KINDS = new Set(["aborted", "timeout", "error", "hidden"]);
const READ_IDS = new Set(["streamId", "threadId", "turnId", "instanceId", "releaseId", "documentId"]);
const READ_FLAGS = new Set(["viewport", "tabReady", "cardReady", "tabPresent", "cardPresent"]);

// Client diagnostics are measurements, never command or lifecycle authority.
// Accept only content-free fields; no arbitrary metadata, error text or URLs.
export function clientPerformanceTraceSpans(body, { now = Date.now() } = {}) {
  if (!Array.isArray(body?.events) || body.events.length > 32) throw new TypeError("Expected at most 32 trace events");
  return body.events.map((event) => {
    if (!ID.test(String(event?.commandId ?? ""))) throw new TypeError("Invalid trace identity");
    if (event.stage === "client-ack") return clientCommandAckTraceSpan({
      commandId: event.commandId, timing: event.timing, reportedAtMs: now,
      outcome: event.outcome, transport: TOKEN.test(event.surface) ? event.surface : "client",
    });
    if (!STAGES.has(event.stage) || !["started", "succeeded", "failed", "cancelled"].includes(event.outcome)) {
      throw new TypeError("Invalid client trace stage or outcome");
    }
    const at = event.observedAtMs;
    const duration = event.monotonicDurationMs;
    if (!Number.isSafeInteger(at) || at < now - 86_400_000 || at > now + 60_000
      || !Number.isFinite(duration) || duration < 0 || duration > 86_400_000) {
      throw new TypeError("Invalid client trace timing");
    }
    const metadata = {};
    for (const [key, value] of Object.entries(event.metadata ?? {})) {
      if (LABELS.has(key) && typeof value === "string" && TOKEN.test(value)) metadata[key] = value;
      if (NUMBERS.has(key) && Number.isFinite(value) && value >= 0 && value <= 1_000_000_000) metadata[key] = value;
      if (key === "operationSpanId" && typeof value === "string" && ID.test(value)) metadata[key] = value;
      if (key === "startedAtMs" && Number.isSafeInteger(value)
        && value >= now - 86_400_000 && value <= at) metadata[key] = value;
      if (key === "statusCode" && Number.isInteger(value) && value >= 0 && value <= 599) metadata[key] = value;
      if (key === "failureKind" && FAILURE_KINDS.has(value)) metadata[key] = value;
      if (String(event.metadata?.action ?? "").startsWith("read-marker-")) {
        if (READ_IDS.has(key) && typeof value === "string" && ID.test(value)) metadata[key] = value;
        if (key === "provider" && ["codex", "claude"].includes(value)) metadata[key] = value;
        if (key === "terminalRevision" && Number.isSafeInteger(value) && value > 0) metadata[key] = value;
        if (READ_FLAGS.has(key) && typeof value === "boolean") metadata[key] = value;
        if (key === "codeMarker" && typeof value === "string" && TOKEN.test(value)) metadata[key] = value;
      }
    }
    return {
      commandId: event.commandId, stage: event.stage, outcome: event.outcome,
      transport: "client", observedAtMs: at, monotonicDurationMs: duration, metadata,
    };
  });
}
