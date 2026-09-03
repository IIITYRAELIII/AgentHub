const OPERATION_STATES = new Set(["pending", "running", "completed", "failed", "skipped"]);
const SETTLED_STATES = new Set(["completed", "failed", "skipped"]);

function normalizedOperation(operation, index) {
  const state = String(operation?.state ?? "pending").trim().toLowerCase();
  return {
    id: String(operation?.id ?? `operation-${index + 1}`),
    label: String(operation?.label ?? "").trim() || `Этап ${index + 1}`,
    state: OPERATION_STATES.has(state) ? state : "pending",
  };
}

export function formatStartupElapsed(startedAtMs, nowMs = Date.now()) {
  const elapsedSeconds = Math.max(0, Math.floor((Number(nowMs) - Number(startedAtMs)) / 1_000));
  const hours = String(Math.floor(elapsedSeconds / 3_600)).padStart(2, "0");
  const minutes = String(Math.floor((elapsedSeconds % 3_600) / 60)).padStart(2, "0");
  const seconds = String(elapsedSeconds % 60).padStart(2, "0");
  return `${hours}:${minutes}:${seconds}`;
}

export function createStartupScreenModel(snapshot, nowMs = Date.now()) {
  const operations = Array.isArray(snapshot?.startup?.operations)
    ? snapshot.startup.operations.map(normalizedOperation)
    : [];
  if (!operations.length) return { available: false, ready: Boolean(snapshot?.ready) };

  const runningIndex = operations.findIndex((operation) => operation.state === "running");
  const pendingIndex = operations.findIndex((operation) => operation.state === "pending");
  const currentIndex = runningIndex >= 0 ? runningIndex : pendingIndex;
  const failed = operations.some((operation) => operation.state === "failed");
  const ready = Boolean(snapshot?.ready);
  const finished = currentIndex < 0;
  const activeOperation = currentIndex >= 0 ? operations[currentIndex] : null;
  const completedOperations = finished
    ? operations
    : operations.slice(0, currentIndex).filter((operation) => SETTLED_STATES.has(operation.state));
  const queueOperations = finished ? [] : operations.slice(currentIndex);

  return {
    available: true,
    ready,
    failed,
    finished,
    status: String(snapshot?.status ?? "starting"),
    currentIndex,
    eyebrow: finished
      ? (failed ? "Требуется внимание" : "Запуск завершён")
      : "Agent Hub запускается",
    title: activeOperation?.label
      ?? (failed ? "Запуск завершён с ошибкой" : "Agent Hub готов"),
    elapsed: formatStartupElapsed(snapshot.startup.startedAtMs, nowMs),
    startedAtMs: Number(snapshot.startup.startedAtMs) || Number(nowMs),
    stageNumber: currentIndex >= 0 ? currentIndex + 1 : operations.length,
    stageTotal: operations.length,
    operations,
    completedOperations,
    queueOperations,
  };
}

export function createStartupDisconnectedModel(model) {
  const base = model?.available ? model : {
    available: true,
    ready: false,
    failed: false,
    finished: false,
    status: "restarting",
    currentIndex: -1,
    startedAtMs: Date.now(),
    stageNumber: 0,
    stageTotal: 0,
    operations: [],
    completedOperations: [],
    queueOperations: [],
  };
  return {
    ...base,
    connectionLost: true,
    eyebrow: "Agent Hub перезапускается",
    title: "Ожидание нового процесса",
    elapsed: "—",
    stageLabel: "Соединение временно недоступно",
  };
}

export function shouldShowStartupScreen(model, {
  visible = false,
  lastStartedAtMs = 0,
} = {}) {
  if (!model?.available) return false;
  if (!model.ready || visible) return true;
  return Number(model.startedAtMs) !== Number(lastStartedAtMs);
}

export function createVisibilityBoundAnimation({
  requestFrame,
  cancelFrame,
  isVisible,
  draw,
}) {
  if (typeof requestFrame !== "function") throw new TypeError("requestFrame is required");
  if (typeof cancelFrame !== "function") throw new TypeError("cancelFrame is required");
  if (typeof isVisible !== "function") throw new TypeError("isVisible is required");
  if (typeof draw !== "function") throw new TypeError("draw is required");

  let frameId = 0;
  let destroyed = false;

  const schedule = () => {
    if (destroyed || frameId || !isVisible()) return;
    frameId = requestFrame((now) => {
      frameId = 0;
      if (destroyed || !isVisible()) return;
      draw(now);
      schedule();
    });
  };
  const stop = () => {
    if (frameId) cancelFrame(frameId);
    frameId = 0;
  };
  const destroy = () => {
    destroyed = true;
    stop();
  };

  return Object.freeze({ start: schedule, stop, destroy });
}
