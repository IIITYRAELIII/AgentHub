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

export function createStartupReconnectModel(startedAtMs, nowMs = Date.now()) {
  return createStartupScreenModel({
    ready: false,
    status: "reconnecting",
    startup: {
      startedAtMs,
      operations: [{
        id: "connection",
        label: "Ожидание запуска Agent Hub",
        state: "running",
      }],
    },
  }, nowMs);
}

export function shouldShowStartupScreen(model, {
  visible = false,
  lastStartedAtMs = 0,
} = {}) {
  if (!model?.available) return false;
  if (!model.ready || visible) return true;
  return Number(model.startedAtMs) !== Number(lastStartedAtMs);
}

export function shouldShowStartupReconnect({
  surface = "web",
  observedHealth = false,
  consecutiveFailures = 0,
} = {}) {
  const failures = Math.max(0, Number(consecutiveFailures) || 0);
  if (surface === "vscode") return failures >= 1;
  return observedHealth && failures >= 2;
}
