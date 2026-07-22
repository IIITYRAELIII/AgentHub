import { createReadStream } from "node:fs";
import path from "node:path";
import { stat } from "node:fs/promises";

export const CLAUDE_ACTIVE_FRESHNESS_MS = 30 * 60 * 1000;
const CODEX_ACTIVE_FRESHNESS_MS = 10 * 60 * 1000;
const LEGACY_TURN_ID = "__legacy__";
const codexActivityCache = new Map();

export const TASK_EXECUTION_OWNERS = Object.freeze({
  TELEGRAM: "telegram",
  VSCODE: "vscode",
  DESKTOP: "desktop",
  CLI: "cli",
  EXTERNAL: "external",
});

export function taskExecutionRuntimeLabel(owner) {
  if (owner === TASK_EXECUTION_OWNERS.TELEGRAM) return "Integration App Server";
  if (owner === TASK_EXECUTION_OWNERS.VSCODE) return "VSCode App Server";
  if (owner === TASK_EXECUTION_OWNERS.DESKTOP) return "Codex Desktop App";
  if (owner === TASK_EXECUTION_OWNERS.CLI) return "Codex CLI";
  return "External Codex";
}

export function taskExecutionRuntimeShortLabel(owner) {
  if (owner === TASK_EXECUTION_OWNERS.TELEGRAM) return "INT";
  if (owner === TASK_EXECUTION_OWNERS.VSCODE) return "VSC";
  if (owner === TASK_EXECUTION_OWNERS.DESKTOP) return "APP";
  if (owner === TASK_EXECUTION_OWNERS.CLI) return "CLI";
  return "EXT";
}

function normalizedPath(value) {
  const resolved = path.resolve(String(value ?? ""));
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function catalogTaskKey({ provider, threadId }) {
  return `${String(provider ?? "").toLowerCase()}\0${String(threadId ?? "")}`;
}

export function pinnedTaskTitle(titles, provider, threadId) {
  return String(titles?.[catalogTaskKey({ provider, threadId })] ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

export function pinTaskTitle(titles, provider, threadId, title) {
  const value = String(title ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
  if (!titles || !threadId || !value) return "";
  titles[catalogTaskKey({ provider, threadId })] = value;
  return value;
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

function codexEntryTurnId(entry) {
  return String(
    entry?.payload?.turn_id
      ?? entry?.payload?.internal_chat_message_metadata_passthrough?.turn_id
      ?? "",
  ).trim();
}

function observeCodexEntry(activeTurnIds, lastSeenAtByTurnId, metadata, entry) {
  if (entry?.type === "session_meta") {
    metadata.originator = String(entry.payload?.originator ?? "").trim();
    metadata.source = String(entry.payload?.source ?? "").trim();
  }
  if (entry?.type === "event_msg" && entry.payload?.type === "thread_settings_applied") {
    metadata.model = String(entry.payload?.thread_settings?.model ?? "").trim();
    metadata.reasoningEffort = String(
      entry.payload?.thread_settings?.reasoning_effort ?? "",
    ).trim();
  }
  const lifecycle = entry?.type === "event_msg"
    && ["task_started", "task_complete", "turn_aborted"].includes(entry.payload?.type);
  const turnId = codexEntryTurnId(entry) || (lifecycle ? LEGACY_TURN_ID : "");
  const timestamp = Date.parse(entry?.timestamp);
  if (turnId && Number.isFinite(timestamp)) lastSeenAtByTurnId.set(turnId, timestamp);
  applyCodexLifecycleEntry(activeTurnIds, entry);
}

function codexActivity(
  activeTurnIds,
  lastSeenAtByTurnId = new Map(),
  { nowMs = null, freshnessMs = null } = {},
) {
  const useFreshness = Number.isFinite(nowMs) && Number.isFinite(freshnessMs);
  const activeIds = [...activeTurnIds].filter((turnId) => {
    if (!useFreshness) return true;
    const lastSeenAt = lastSeenAtByTurnId.get(turnId);
    if (turnId === LEGACY_TURN_ID && !Number.isFinite(lastSeenAt)) return true;
    return Number.isFinite(lastSeenAt) && nowMs - lastSeenAt <= freshnessMs;
  });
  return {
    running: activeIds.length > 0,
    activeTurnIds: activeIds.filter((turnId) => turnId !== LEGACY_TURN_ID),
  };
}

export function parseCodexRolloutActivity(text, options = {}) {
  const activeTurnIds = new Set();
  const lastSeenAtByTurnId = new Map();
  const metadata = {
    originator: "",
    source: "",
    model: "",
    reasoningEffort: "",
  };
  for (const line of String(text).split(/\r?\n/)) {
    if (!line) continue;
    try {
      observeCodexEntry(activeTurnIds, lastSeenAtByTurnId, metadata, JSON.parse(line));
    } catch {
      // Ignore incomplete or unrelated JSONL lines.
    }
  }
  return {
    ...codexActivity(activeTurnIds, lastSeenAtByTurnId, options),
    originator: metadata.originator || null,
    source: metadata.source || null,
    model: metadata.model || null,
    reasoningEffort: metadata.reasoningEffort || null,
  };
}

export function parseCodexRolloutRunning(text) {
  return parseCodexRolloutActivity(text).running;
}

export async function readCodexRolloutActivity(
  rolloutPath,
  { nowMs = Date.now(), freshnessMs = CODEX_ACTIVE_FRESHNESS_MS } = {},
) {
  const normalized = String(rolloutPath ?? "").trim();
  if (!normalized) {
    return {
      running: false,
      activeTurnIds: [],
      lastActivityAtMs: null,
      originator: null,
      source: null,
      model: null,
      reasoningEffort: null,
    };
  }
  let info;
  try {
    info = await stat(normalized);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return {
        running: false,
        activeTurnIds: [],
        lastActivityAtMs: null,
        originator: null,
        source: null,
        model: null,
        reasoningEffort: null,
      };
    }
    throw error;
  }
  if (nowMs - info.mtimeMs > freshnessMs) {
    const cached = codexActivityCache.get(normalized);
    return {
      running: false,
      activeTurnIds: [],
      lastActivityAtMs: info.mtimeMs,
      originator: cached?.originator || null,
      source: cached?.source || null,
      model: cached?.model || null,
      reasoningEffort: cached?.reasoningEffort || null,
    };
  }
  const cached = codexActivityCache.get(normalized);
  if (cached?.size === info.size && cached?.mtimeMs === info.mtimeMs) {
    return {
      ...codexActivity(
        new Set(cached.activeTurnIds),
        new Map(cached.lastSeenAtByTurnId),
        { nowMs, freshnessMs },
      ),
      lastActivityAtMs: info.mtimeMs,
      originator: cached.originator || null,
      source: cached.source || null,
      model: cached.model || null,
      reasoningEffort: cached.reasoningEffort || null,
    };
  }

  const appendOnly = cached && info.size > cached.size;
  const activeTurnIds = new Set(appendOnly ? cached.activeTurnIds : []);
  const lastSeenAtByTurnId = new Map(appendOnly ? cached.lastSeenAtByTurnId : []);
  const metadata = {
    originator: appendOnly ? String(cached.originator ?? "") : "",
    source: appendOnly ? String(cached.source ?? "") : "",
    model: appendOnly ? String(cached.model ?? "") : "",
    reasoningEffort: appendOnly ? String(cached.reasoningEffort ?? "") : "",
  };
  const input = createReadStream(normalized, {
    encoding: "utf8",
    ...(appendOnly ? { start: cached.size } : {}),
    end: Math.max(0, info.size - 1),
  });
  let text = appendOnly ? String(cached.trailingText ?? "") : "";
  try {
    for await (const chunk of input) text += chunk;
  } finally {
    input.destroy();
  }
  const lines = text.split(/\r?\n/);
  let trailingText = lines.pop() ?? "";
  for (const line of lines) {
    if (!line) continue;
    try {
      observeCodexEntry(activeTurnIds, lastSeenAtByTurnId, metadata, JSON.parse(line));
    } catch {
      // Ignore an unrelated complete JSONL line.
    }
  }
  if (trailingText) {
    try {
      observeCodexEntry(activeTurnIds, lastSeenAtByTurnId, metadata, JSON.parse(trailingText));
      trailingText = "";
    } catch {
      // Preserve a line caught in the middle of an append for the next read.
    }
  }
  const activity = codexActivity(activeTurnIds, lastSeenAtByTurnId, { nowMs, freshnessMs });
  codexActivityCache.set(normalized, {
    size: info.size,
    mtimeMs: info.mtimeMs,
    activeTurnIds: [...activeTurnIds],
    lastSeenAtByTurnId: [...lastSeenAtByTurnId],
    trailingText,
    originator: metadata.originator,
    source: metadata.source,
    model: metadata.model,
    reasoningEffort: metadata.reasoningEffort,
  });
  if (codexActivityCache.size > 200) codexActivityCache.delete(codexActivityCache.keys().next().value);
  return {
    ...activity,
    lastActivityAtMs: info.mtimeMs,
    originator: metadata.originator || null,
    source: metadata.source || null,
    model: metadata.model || null,
    reasoningEffort: metadata.reasoningEffort || null,
  };
}

export async function readCodexRolloutRunning(rolloutPath, options = {}) {
  return (await readCodexRolloutActivity(rolloutPath, options)).running;
}

export function codexThreadRunning(thread, { rolloutRunning = false } = {}) {
  return Boolean(rolloutRunning)
    || thread?.status?.type === "active"
    || (thread?.turns ?? []).some((turn) => turn?.status === "inProgress");
}

export function codexExecutionOwner({ originator = "", source = "" } = {}) {
  const normalizedOriginator = String(originator).trim().toLowerCase();
  const normalizedSource = String(source).trim().toLowerCase();
  if (normalizedOriginator === "telegram_codex_bridge") {
    return TASK_EXECUTION_OWNERS.TELEGRAM;
  }
  // `source` describes the surface that started the current Codex session more
  // precisely than the historical product label in `originator`. Older threads
  // can retain `Codex Desktop` after they are continued from VS Code.
  if (normalizedSource === "vscode") {
    return TASK_EXECUTION_OWNERS.VSCODE;
  }
  if (normalizedOriginator.includes("codex desktop")) {
    return TASK_EXECUTION_OWNERS.DESKTOP;
  }
  if (normalizedOriginator.includes("codex_vscode")) {
    return TASK_EXECUTION_OWNERS.VSCODE;
  }
  if (normalizedOriginator.includes("codex_cli") || normalizedSource === "cli") {
    return TASK_EXECUTION_OWNERS.CLI;
  }
  return TASK_EXECUTION_OWNERS.EXTERNAL;
}

export function codexObservedExecutionOwner(activity = {}) {
  const owner = codexExecutionOwner(activity);
  if (owner !== TASK_EXECUTION_OWNERS.TELEGRAM) return owner;
  // An observer is, by definition, attached to a turn that this bot did not
  // start. A reused thread can retain telegram_codex_bridge in immutable
  // session metadata even when its current turn was started from VS Code.
  return String(activity.source ?? "").trim().toLowerCase() === "vscode"
    ? TASK_EXECUTION_OWNERS.VSCODE
    : TASK_EXECUTION_OWNERS.EXTERNAL;
}

export function selectCodexTurn(
  turns,
  { requestedTurnId = null, rolloutActiveTurnIds = [], strictRequested = false } = {},
) {
  const values = Array.isArray(turns) ? turns : [];
  const requested = values.find((turn) => turn?.id === requestedTurnId);
  if (strictRequested && requested) return requested;
  if (requested?.status === "inProgress") return requested;
  const rolloutIds = new Set(rolloutActiveTurnIds);
  return values.findLast((turn) => (
    turn?.status === "inProgress" && rolloutIds.has(turn.id)
  )) ?? values.findLast((turn) => turn?.status === "inProgress")
    ?? requested
    ?? values.at(-1)
    ?? null;
}

export function codexCatalogEntry(thread, project, {
  rolloutRunning = false,
  executionOwner = null,
  lastActivityAtMs = null,
} = {}) {
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
    running: codexThreadRunning(thread, { rolloutRunning }),
    executionOwner,
    lastActivityAtMs,
  };
}

// Активность Claude видна только через JSONL-транскрипт, живого App Server нет.
// Незавершённый транскрипт остаётся «активным» навсегда, поэтому единственный
// признак выполняющегося хода — свежесть последней записи. Предикат общий для
// каталога, наблюдения и проверки занятости перед отправкой сообщения.
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

export function claudeCatalogEntry(snapshot, project, nowMs = Date.now()) {
  const modifiedAtMs = Number(snapshot?.modifiedAtMs ?? 0);
  const activityState = claudeSnapshotActivityState(snapshot, { nowMs });
  const running = activityState === "active";
  return {
    provider: "claude",
    threadId: String(snapshot.sessionId),
    projectRoot: project.path,
    projectName: project.name,
    title: String(snapshot.catalogTitle ?? snapshot.title ?? `Claude · ${String(snapshot.sessionId).slice(0, 8)}`),
    updatedAtMs: modifiedAtMs,
    running,
    activityUnknown: activityState === "unknown",
    executionOwner: running ? TASK_EXECUTION_OWNERS.EXTERNAL : null,
    lastActivityAtMs: modifiedAtMs || null,
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
      existing.executionOwner = run.observer
        ? run.executionOwner ?? existing.executionOwner ?? TASK_EXECUTION_OWNERS.EXTERNAL
        : TASK_EXECUTION_OWNERS.TELEGRAM;
      existing.turnId = run.turnId ?? existing.turnId ?? null;
      existing.lastActivityAtMs = Date.parse(run.lastMeaningfulProgressAt ?? run.startedAt ?? "")
        || existing.lastActivityAtMs
        || Date.now();
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
      executionOwner: run.observer
        ? TASK_EXECUTION_OWNERS.EXTERNAL
        : TASK_EXECUTION_OWNERS.TELEGRAM,
      turnId: run.turnId ?? null,
      lastActivityAtMs: Date.parse(run.lastMeaningfulProgressAt ?? run.startedAt ?? "") || Date.now(),
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

function taskActivityAtMs(entry) {
  return Math.max(
    Number(entry?.lastActivityAtMs) || 0,
    Number(entry?.updatedAtMs) || 0,
  );
}

export function statusTaskEntries(entries, limit = 4) {
  const count = Math.max(0, Number(limit) || 0);
  return [...entries]
    .sort((left, right) => (
      Number(right.running) - Number(left.running)
      || taskActivityAtMs(right) - taskActivityAtMs(left)
      || left.title.localeCompare(right.title, "ru")
    ))
    .slice(0, count);
}

export function runningTaskReplyMarkup(entries, selected = null, { showProject = false, limit = 4 } = {}) {
  return {
    inline_keyboard: statusTaskEntries(entries, limit)
      .map((entry) => [{
        text: (
          `${selected && catalogEntryIsSelected(entry, selected) ? "✅ ТЕКУЩАЯ" : entry.running ? "🧵" : entry.activityUnknown ? "❔" : "🕘"} · `
          + `${entry.running ? `${taskExecutionRuntimeShortLabel(entry.executionOwner)} · ` : ""}`
          + `${entry.provider === "codex" ? "Codex" : "Claude"} · `
          + `${showProject ? `${entry.projectName} · ` : ""}${entry.title}`
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
