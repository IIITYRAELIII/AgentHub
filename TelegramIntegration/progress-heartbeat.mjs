export const PROGRESS_HEARTBEAT_INTERVAL_MS = 10_000;
export const PROGRESS_STALLED_AFTER_MS = 2 * 60 * 1000;

export function retainProgressMessageAfterEditError(error) {
  return error?.retryable === true
    || String(error?.message ?? error ?? "").includes("message is not modified");
}

function validTimestamp(value) {
  const timestamp = Date.parse(String(value ?? ""));
  return Number.isFinite(timestamp) ? timestamp : null;
}

export function markProgressHeartbeat(
  run,
  state = "active",
  now = Date.now(),
  intervalMs = PROGRESS_HEARTBEAT_INTERVAL_MS,
) {
  if (!run) return false;
  const timestamp = now instanceof Date ? now.getTime() : Number(now);
  if (!Number.isFinite(timestamp)) return false;
  const previous = validTimestamp(run.progressHeartbeatAt);
  const stateChanged = run.progressHeartbeatState !== state;
  if (!stateChanged && previous !== null && timestamp - previous < intervalMs) return false;
  run.progressHeartbeatState = state;
  run.progressHeartbeatAt = new Date(timestamp).toISOString();
  return true;
}

export function formatProgressHeartbeat(run, options = {}) {
  const timestamp = validTimestamp(run?.progressHeartbeatAt);
  if (timestamp === null) return "";
  const time = new Intl.DateTimeFormat(options.locale ?? "ru-RU", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    ...(options.timeZone ? { timeZone: options.timeZone } : {}),
  }).format(new Date(timestamp));
  if (run.progressHeartbeatState === "error") {
    return `🔴 Проверка хода не удалась · ${time}`;
  }
  if (run.progressHeartbeatState === "waiting") {
    return `🟡 Жду данные хода · проверено ${time}`;
  }
  if (run.progressHeartbeatState === "stalled") {
    const lastActivity = validTimestamp(run?.lastMeaningfulProgressAt);
    const elapsed = lastActivity === null ? null : Math.max(0, timestamp - lastActivity);
    const duration = elapsed === null
      ? ""
      : ` ${Math.max(1, Math.floor(elapsed / 60_000))} мин`;
    return `🟠 Нет новых событий${duration} · проверено ${time}`;
  }
  return `🟢 Ход активен · проверено ${time}`;
}
