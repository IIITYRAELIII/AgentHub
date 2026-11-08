function sameIdentity(left, right) {
  return ["provider", "threadId", "turnId", "runId"].every((field) => (
    typeof left?.[field] === "string" && left[field].length > 0 && left[field] === right?.[field]
  ));
}

export function planTurnDurationRecovery(record, { predecessor, telemetry } = {}) {
  if (!record || record.provider !== "codex" || !predecessor
    || predecessor.provider !== record.provider || predecessor.threadId !== record.threadId
    || predecessor.turnId === record.turnId || !predecessor.turnId
    || !record.startedAt || predecessor.startedAt !== record.startedAt) return null;
  const originalStart = Date.parse(record.startedAt);
  const originalEnd = Date.parse(record.completedAt);
  const predecessorEnd = Date.parse(predecessor.completedAt);
  if (![originalStart, originalEnd, predecessorEnd].every(Number.isFinite)
    || predecessorEnd < originalStart || originalEnd <= predecessorEnd) return null;
  if (!sameIdentity(record, telemetry)) return null;
  const requested = telemetry.requestedAtMs;
  const accepted = telemetry.acceptedAtMs;
  const started = telemetry.turnStartedAtMs;
  const completed = telemetry.completedAtMs;
  if (!Number.isFinite(requested) || requested <= predecessorEnd || originalStart >= requested) return null;
  const known = [accepted, started, completed].every(Number.isFinite)
    && requested <= accepted && accepted <= started && started <= completed && completed <= originalEnd;
  return {
    version: 1,
    provider: record.provider, threadId: record.threadId, turnId: record.turnId, runId: record.runId,
    originalStartedAt: record.startedAt, originalCompletedAt: record.completedAt,
    predecessorTurnId: predecessor.turnId,
    source: "exact-provider-turn-telemetry",
    requestedAtMs: requested, acceptedAtMs: accepted ?? null,
    turnStartedAtMs: started ?? null, providerCompletedAtMs: completed ?? null,
    state: known ? "known" : "unknown",
    startedAt: known ? new Date(started).toISOString() : null,
    completedAt: record.completedAt,
  };
}

export function durationRecoveryForRecord(record) {
  const evidence = record?.durationRecovery;
  if (evidence?.version !== 1 || !sameIdentity(record, evidence)
    || evidence.originalStartedAt !== record.startedAt
    || evidence.originalCompletedAt !== record.completedAt) return null;
  return evidence;
}

export function durationStartForRecord(record) {
  const evidence = durationRecoveryForRecord(record);
  return evidence ? evidence.state === "known" ? evidence.startedAt : "" : record?.startedAt;
}
