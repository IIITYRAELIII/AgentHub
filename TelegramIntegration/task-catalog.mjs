import path from "node:path";
import { open, stat } from "node:fs/promises";

const CLAUDE_ACTIVE_FRESHNESS_MS = 30 * 60 * 1000;
const CODEX_ACTIVE_FRESHNESS_MS = 10 * 60 * 1000;
const MAX_CODEX_STATUS_TAIL = 4 * 1024 * 1024;

function normalizedPath(value) {
  const resolved = path.resolve(String(value ?? ""));
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function catalogTaskKey({ provider, threadId }) {
  return `${String(provider ?? "").toLowerCase()}\0${String(threadId ?? "")}`;
}

export function parseCodexRolloutRunning(text) {
  const terminalEvents = new Set(["task_started", "task_complete", "turn_aborted"]);
  const lines = String(text).split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (!lines[index]) continue;
    try {
      const entry = JSON.parse(lines[index]);
      const event = entry?.type === "event_msg" ? entry.payload?.type : null;
      if (terminalEvents.has(event)) return event === "task_started";
    } catch {
      // The first line of a byte-limited tail can be partial.
    }
  }
  return false;
}

export async function readCodexRolloutRunning(
  rolloutPath,
  { nowMs = Date.now(), freshnessMs = CODEX_ACTIVE_FRESHNESS_MS } = {},
) {
  const normalized = String(rolloutPath ?? "").trim();
  if (!normalized) return false;
  let info;
  try {
    info = await stat(normalized);
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  if (nowMs - info.mtimeMs > freshnessMs) return false;
  const handle = await open(normalized, "r");
  try {
    const length = Math.min(info.size, MAX_CODEX_STATUS_TAIL);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, info.size - length);
    let text = buffer.toString("utf8");
    if (info.size > length) text = text.slice(text.indexOf("\n") + 1);
    return parseCodexRolloutRunning(text);
  } finally {
    await handle.close();
  }
}

export function codexCatalogEntry(thread, project, { rolloutRunning = false } = {}) {
  const title = String(thread?.name ?? thread?.preview ?? "Без названия")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return {
    provider: "codex",
    threadId: String(thread.id),
    projectRoot: project.path,
    projectName: project.name,
    title: title || "Без названия",
    updatedAtMs: Number(thread.updatedAt ?? 0) * 1000,
    running: rolloutRunning
      || thread?.status?.type === "active"
      || thread?.turns?.at(-1)?.status === "inProgress",
  };
}

export function claudeCatalogEntry(snapshot, project, nowMs = Date.now()) {
  const modifiedAtMs = Number(snapshot?.modifiedAtMs ?? 0);
  return {
    provider: "claude",
    threadId: String(snapshot.sessionId),
    projectRoot: project.path,
    projectName: project.name,
    title: String(snapshot.catalogTitle ?? snapshot.title ?? `Claude · ${String(snapshot.sessionId).slice(0, 8)}`),
    updatedAtMs: modifiedAtMs,
    running: Boolean(snapshot.active)
      && modifiedAtMs > 0
      && nowMs - modifiedAtMs <= CLAUDE_ACTIVE_FRESHNESS_MS,
  };
}

export function mergeTaskCatalog(entries, runs = []) {
  const byTask = new Map();
  for (const entry of entries) {
    const key = catalogTaskKey(entry);
    const existing = byTask.get(key);
    if (!existing || entry.updatedAtMs > existing.updatedAtMs) byTask.set(key, entry);
  }
  for (const run of runs) {
    if (!run?.threadId) continue;
    const key = catalogTaskKey(run);
    const existing = byTask.get(key);
    if (existing) {
      existing.running = true;
      if (!existing.title && run.taskTitle) existing.title = run.taskTitle;
      continue;
    }
    byTask.set(key, {
      provider: run.provider,
      threadId: String(run.threadId),
      projectRoot: run.projectRoot,
      projectName: run.projectName || path.basename(run.projectRoot) || "Проект",
      title: String(run.taskTitle ?? `${run.provider} · ${String(run.threadId).slice(0, 8)}`),
      updatedAtMs: Date.parse(run.startedAt ?? "") || Date.now(),
      running: true,
    });
  }
  return [...byTask.values()].sort((left, right) => (
    Number(right.running) - Number(left.running)
    || right.updatedAtMs - left.updatedAtMs
    || left.title.localeCompare(right.title, "ru")
  ));
}

export function catalogEntryIsSelected(entry, selected) {
  return entry.provider === selected.provider
    && entry.threadId === selected.threadId
    && normalizedPath(entry.projectRoot) === normalizedPath(selected.projectRoot);
}

export function taskCatalogCallback(entry) {
  const provider = entry.provider === "claude" ? "l" : "c";
  return `task:${provider}:${entry.threadId}`;
}

export function parseTaskCatalogCallback(value) {
  const match = /^task:([cl]):([0-9a-f-]+)$/i.exec(String(value ?? ""));
  if (!match) return null;
  return {
    provider: match[1].toLowerCase() === "l" ? "claude" : "codex",
    threadId: match[2],
  };
}
