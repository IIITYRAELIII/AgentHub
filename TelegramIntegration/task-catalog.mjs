import { createReadStream } from "node:fs";
import path from "node:path";
import { stat } from "node:fs/promises";
import { createInterface } from "node:readline";

const CLAUDE_ACTIVE_FRESHNESS_MS = 30 * 60 * 1000;
const CODEX_ACTIVE_FRESHNESS_MS = 10 * 60 * 1000;
const LEGACY_TURN_ID = "__legacy__";
const codexActivityCache = new Map();

function normalizedPath(value) {
  const resolved = path.resolve(String(value ?? ""));
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function catalogTaskKey({ provider, threadId }) {
  return `${String(provider ?? "").toLowerCase()}\0${String(threadId ?? "")}`;
}

function applyCodexLifecycleEntry(activeTurnIds, entry) {
  if (entry?.type !== "event_msg") return;
  const event = entry.payload?.type;
  if (!["task_started", "task_complete", "turn_aborted"].includes(event)) return;
  const turnId = String(entry.payload?.turn_id ?? "").trim() || LEGACY_TURN_ID;
  if (event === "task_started") {
    activeTurnIds.add(turnId);
  } else {
    activeTurnIds.delete(turnId);
  }
}

function codexActivity(activeTurnIds) {
  return {
    running: activeTurnIds.size > 0,
    activeTurnIds: [...activeTurnIds].filter((turnId) => turnId !== LEGACY_TURN_ID),
  };
}

export function parseCodexRolloutActivity(text) {
  const activeTurnIds = new Set();
  for (const line of String(text).split(/\r?\n/)) {
    if (!line) continue;
    try {
      applyCodexLifecycleEntry(activeTurnIds, JSON.parse(line));
    } catch {
      // Ignore incomplete or unrelated JSONL lines.
    }
  }
  return codexActivity(activeTurnIds);
}

export function parseCodexRolloutRunning(text) {
  return parseCodexRolloutActivity(text).running;
}

export async function readCodexRolloutActivity(
  rolloutPath,
  { nowMs = Date.now(), freshnessMs = CODEX_ACTIVE_FRESHNESS_MS } = {},
) {
  const normalized = String(rolloutPath ?? "").trim();
  if (!normalized) return { running: false, activeTurnIds: [] };
  let info;
  try {
    info = await stat(normalized);
  } catch (error) {
    if (error?.code === "ENOENT") return { running: false, activeTurnIds: [] };
    throw error;
  }
  if (nowMs - info.mtimeMs > freshnessMs) return { running: false, activeTurnIds: [] };
  const cached = codexActivityCache.get(normalized);
  if (cached?.size === info.size && cached?.mtimeMs === info.mtimeMs) return cached.activity;

  const activeTurnIds = new Set();
  const input = createReadStream(normalized, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line) continue;
      try {
        applyCodexLifecycleEntry(activeTurnIds, JSON.parse(line));
      } catch {
        // A rollout can be appended while it is being read.
      }
    }
  } finally {
    lines.close();
    input.destroy();
  }
  const activity = codexActivity(activeTurnIds);
  codexActivityCache.set(normalized, { size: info.size, mtimeMs: info.mtimeMs, activity });
  if (codexActivityCache.size > 200) codexActivityCache.delete(codexActivityCache.keys().next().value);
  return activity;
}

export async function readCodexRolloutRunning(rolloutPath, options = {}) {
  return (await readCodexRolloutActivity(rolloutPath, options)).running;
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

export function runningTaskReplyMarkup(entries, selected = null) {
  return {
    inline_keyboard: entries
      .filter((entry) => entry.running)
      .map((entry) => [{
        text: (
          `${selected && catalogEntryIsSelected(entry, selected) ? "✅ ТЕКУЩАЯ" : "🧵"} · `
          + `${entry.provider === "codex" ? "Codex" : "Claude"} · ${entry.projectName} · ${entry.title}`
        ).slice(0, 90),
        callback_data: taskCatalogCallback(entry),
      }]),
  };
}

export function parseTaskCatalogCallback(value) {
  const match = /^task:([cl]):([0-9a-f-]+)$/i.exec(String(value ?? ""));
  if (!match) return null;
  return {
    provider: match[1].toLowerCase() === "l" ? "claude" : "codex",
    threadId: match[2],
  };
}
