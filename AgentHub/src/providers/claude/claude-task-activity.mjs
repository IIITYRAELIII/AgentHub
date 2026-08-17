import path from "node:path";

import { TASK_EXECUTION_OWNERS } from "../../domain/task-execution-owner.mjs";

export const CLAUDE_ACTIVE_FRESHNESS_MS = 30 * 60 * 1000;

export function claudeSnapshotActivityAtMs(snapshot) {
  const values = [
    Number(snapshot?.modifiedAtMs ?? 0),
    Date.parse(String(snapshot?.updatedAt ?? "")),
  ].filter((value) => Number.isFinite(value) && value > 0);
  return values.length ? Math.max(...values) : null;
}

export function claudeSnapshotIsActive(
  snapshot,
  { nowMs = Date.now(), freshnessMs = CLAUDE_ACTIVE_FRESHNESS_MS } = {},
) {
  if (!snapshot?.active) return false;
  const activityAtMs = claudeSnapshotActivityAtMs(snapshot);
  return activityAtMs != null && nowMs - activityAtMs <= freshnessMs;
}

export function claudeSnapshotActivityState(
  snapshot,
  { nowMs = Date.now(), freshnessMs = CLAUDE_ACTIVE_FRESHNESS_MS } = {},
) {
  if (!snapshot || snapshot.completed || snapshot.active !== true) return "inactive";
  return claudeSnapshotIsActive(snapshot, { nowMs, freshnessMs }) ? "active" : "unknown";
}

export function claudeSnapshotExecutionOwner(snapshot) {
  const entrypoint = String(snapshot?.entrypoint ?? "").trim().toLowerCase();
  if (entrypoint.includes("vscode")) return TASK_EXECUTION_OWNERS.VSCODE;
  if (entrypoint === "cli" || entrypoint.endsWith("-cli")) return TASK_EXECUTION_OWNERS.CLI;
  return TASK_EXECUTION_OWNERS.EXTERNAL;
}

export function claudeCatalogEntry(snapshot, project, nowMs = Date.now()) {
  const modifiedAtMs = Number(snapshot?.modifiedAtMs ?? 0);
  const messageActivityAtMs = Date.parse(String(snapshot?.updatedAt ?? "")) || null;
  const activityState = claudeSnapshotActivityState(snapshot, { nowMs });
  const running = activityState === "active";
  return {
    provider: "claude",
    threadId: String(snapshot.sessionId),
    projectRoot: project.path,
    projectName: project.name,
    sessionCwd: snapshot.sessionRoot || snapshot.cwd
      ? path.resolve(String(snapshot.sessionRoot || snapshot.cwd))
      : null,
    title: String(snapshot.catalogTitle ?? snapshot.title ?? `Claude · ${String(snapshot.sessionId).slice(0, 8)}`),
    model: snapshot.model ?? null,
    updatedAtMs: modifiedAtMs,
    orderingActivityAtMs: messageActivityAtMs || modifiedAtMs || null,
    messageActivityAtMs,
    running,
    activityUnknown: activityState === "unknown",
    executionOwner: running ? claudeSnapshotExecutionOwner(snapshot) : null,
    lastActivityAtMs: messageActivityAtMs || modifiedAtMs || null,
    startedAt: running && Number.isFinite(Date.parse(String(snapshot?.startedAt ?? "")))
      ? new Date(snapshot.startedAt).toISOString()
      : null,
    ...(snapshot?.contextUsage ? { contextUsage: structuredClone(snapshot.contextUsage) } : {}),
  };
}
