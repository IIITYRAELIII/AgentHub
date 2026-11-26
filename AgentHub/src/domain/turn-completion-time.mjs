const TERMINAL_PHASES = new Set(["completed", "failed", "aborted", "cancelled"]);
const TERMINAL_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/iu;

export function terminalCompletionTime(value, startedAt) {
  const completedMs = typeof value === "string" && TERMINAL_TIMESTAMP.test(value) ? Date.parse(value) : NaN;
  const startedMs = typeof startedAt === "string" ? Date.parse(startedAt) : NaN;
  if (!Number.isFinite(completedMs) || (Number.isFinite(startedMs) && completedMs < startedMs)) return "";
  return value;
}

export function providerTerminalCompletionTime(terminal, telemetry) {
  if (!telemetry || !["provider", "threadId", "turnId"].every(
    (field) => terminal[field] && terminal[field] === telemetry[field],
  ) || (terminal.runId && telemetry.runId && terminal.runId !== telemetry.runId)
    || !TERMINAL_PHASES.has(telemetry.finalPhase) || !TERMINAL_PHASES.has(telemetry.status)
    || !Number.isFinite(telemetry.completedAtMs)) return "";
  const date = new Date(telemetry.completedAtMs);
  return Number.isFinite(date.getTime()) ? terminalCompletionTime(date.toISOString(), terminal.startedAt) : "";
}
