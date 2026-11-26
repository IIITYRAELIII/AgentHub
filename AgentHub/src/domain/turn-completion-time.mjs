const TERMINAL_PHASES = new Set(["completed", "failed", "aborted", "cancelled"]);
const TERMINAL_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/iu;

export function terminalCompletionTime(value, startedAt) {
  const completedMs = typeof value === "string" && TERMINAL_TIMESTAMP.test(value) ? Date.parse(value) : NaN;
  const startedMs = typeof startedAt === "string" ? Date.parse(startedAt) : NaN;
  if (!Number.isFinite(completedMs) || (Number.isFinite(startedMs) && completedMs < startedMs)) return "";
  return value;
}

export function planTurnCompletionRecovery(record, evidence, expectedCompletedAt) {
  if (!record || evidence?.provider !== "codex" || evidence.sourceRevision === evidence.terminalRevision
    || !["provider", "threadId", "turnId"].every((field) => evidence[field] && evidence[field] === record[field])
    || (record.runId && evidence.runId && record.runId !== evidence.runId)
    || !terminalCompletionTime(expectedCompletedAt)
    || !terminalCompletionTime(evidence.completedAt, record.startedAt)
    || Date.parse(evidence.completedAt) >= Date.parse(expectedCompletedAt)) {
    return { eligible: false, applied: false };
  }
  const unchanged = record.completedAt === evidence.completedAt;
  if (!unchanged && (record.completedAt !== expectedCompletedAt || record.observedAt !== expectedCompletedAt)) {
    return { eligible: false, applied: false };
  }
  return {
    eligible: true, applied: false, ...(unchanged ? { unchanged: true } : {}), projectRoot: record.projectRoot,
    recovery: {
      originalCompletedAt: expectedCompletedAt,
      completedAt: evidence.completedAt,
      terminalRevision: evidence.terminalRevision,
      sourceRevision: evidence.sourceRevision,
      providerCompletedAt: evidence.providerCompletedAt || null,
    },
  };
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
