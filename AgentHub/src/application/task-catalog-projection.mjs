import path from "node:path";
import { catalogTaskKey } from "../domain/task-catalog-identity.mjs";
import { TASK_EXECUTION_OWNERS } from "../domain/task-execution-owner.mjs";
import { taskRunIsActive } from "../domain/task-runs.mjs";

export function taskOrderingActivityAtMs(entry, {
  run = null,
  lastMessage = null,
  userMessageAtMs = 0,
} = {}) {
  const meaningfulEvents = [
    Number(userMessageAtMs),
    Number(entry?.messageActivityAtMs),
    Date.parse(String(run?.startedAt ?? "")),
    Date.parse(String(lastMessage?.updatedAt ?? "")),
  ].filter((value) => Number.isFinite(value) && value > 0);
  if (meaningfulEvents.length) return Math.max(...meaningfulEvents);
  // thread.updatedAt and a transcript file mtime can change merely because
  // the Hub re-read a task. They are metadata, not user-visible activity.
  return 0;
}

export function mergeTaskCatalog(entries, runs = []) {
  const byTask = new Map();
  for (const entry of entries) {
    const key = catalogTaskKey(entry);
    const existing = byTask.get(key);
    const titleAuthoritative = entry.titleAuthoritative === true;
    const normalizedEntry = { ...entry };
    delete normalizedEntry.titleAuthoritative;
    if (!existing) {
      byTask.set(key, normalizedEntry);
      continue;
    }
    const merged = entry.updatedAtMs > existing.updatedAtMs
      ? { ...normalizedEntry, model: entry.model ?? existing.model ?? null }
      : existing;
    if (!merged.model && entry.model) merged.model = entry.model;
    // A provider snapshot resolves the canonical title (including Hub pins and
    // external renames). Its activity timestamp can legitimately be older than
    // the durable read model, so title authority must not depend on that clock.
    if (titleAuthoritative && entry.title) merged.title = entry.title;

    // Catalog entries are appended in increasing authority: the durable SQLite
    // projection first, then a freshly discovered provider snapshot. Task
    // metadata may still prefer the newest timestamp, but process activity must
    // always follow the latest snapshot. Mixing these clocks made a stale
    // persisted `running=true` survive every refresh and marked the full task
    // catalog as active after an Agent Hub restart.
    merged.running = entry.running === true;
    merged.activityUnknown = entry.activityUnknown === true;
    merged.executionOwner = merged.running ? entry.executionOwner ?? null : null;
    merged.turnId = merged.running ? entry.turnId ?? null : null;
    merged.startedAt = merged.running ? entry.startedAt ?? null : null;
    if (entry.lastActivityAtMs != null) merged.lastActivityAtMs = entry.lastActivityAtMs;
    if (entry.contextUsage) merged.contextUsage = structuredClone(entry.contextUsage);
    byTask.set(key, merged);
  }
  for (const run of runs) {
    if (!run?.threadId || !taskRunIsActive(run)) continue;
    const key = catalogTaskKey(run);
    const existing = byTask.get(key);
    if (existing) {
      existing.running = true;
      existing.executionOwner = run.observer
        ? run.executionOwner ?? existing.executionOwner ?? TASK_EXECUTION_OWNERS.EXTERNAL
        : TASK_EXECUTION_OWNERS.HUB;
      existing.turnId = run.turnId ?? existing.turnId ?? null;
      existing.startedAt = run.startedAt ?? existing.startedAt ?? null;
      existing.lastActivityAtMs = Date.parse(run.lastMeaningfulProgressAt ?? run.startedAt ?? "")
        || existing.lastActivityAtMs
        || Date.now();
      if (!existing.title && run.taskTitle) existing.title = run.taskTitle;
      if (run.model) existing.model = run.model;
      continue;
    }
    byTask.set(key, {
      provider: run.provider,
      threadId: String(run.threadId),
      projectRoot: run.projectRoot,
      projectName: run.projectName || path.basename(run.projectRoot) || "Проект",
      ...(run.sessionCwd ? { sessionCwd: path.resolve(String(run.sessionCwd)) } : {}),
      title: String(run.taskTitle ?? `${run.provider} · ${String(run.threadId).slice(0, 8)}`),
      model: run.model ?? null,
      updatedAtMs: Date.parse(run.startedAt ?? "") || Date.now(),
      running: true,
      executionOwner: run.observer
        ? run.executionOwner ?? TASK_EXECUTION_OWNERS.EXTERNAL
        : TASK_EXECUTION_OWNERS.HUB,
      turnId: run.turnId ?? null,
      lastActivityAtMs: Date.parse(run.lastMeaningfulProgressAt ?? run.startedAt ?? "") || Date.now(),
    });
  }
  return [...byTask.values()].sort((left, right) => (
    Number(right.running) - Number(left.running)
    || Number(right.orderingActivityAtMs ?? 0) - Number(left.orderingActivityAtMs ?? 0)
    || left.title.localeCompare(right.title, "ru")
  ));
}
