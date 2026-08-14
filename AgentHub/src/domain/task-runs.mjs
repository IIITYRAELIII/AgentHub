import path from "node:path";

function normalizedProjectRoot(projectRoot) {
  const resolved = path.resolve(String(projectRoot ?? ""));
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function taskRunKey({ streamId, provider, projectRoot, threadId }) {
  const normalizedStreamId = String(streamId ?? "").trim();
  if (normalizedStreamId) return `stream\0${normalizedStreamId}`;
  const normalizedProvider = String(provider ?? "").trim().toLowerCase();
  const normalizedThreadId = String(threadId ?? "").trim();
  return `${normalizedProvider}\0${normalizedProjectRoot(projectRoot)}\0${normalizedThreadId}`;
}

function progressState({ stage, reasoning = "", displayRequested }) {
  const now = new Date().toISOString();
  return {
    responseText: "",
    responseItems: [],
    status: "running",
    startedAt: now,
    progressMessageIds: [],
    progressStage: stage,
    progressReasoning: reasoning,
    activities: [],
    lastMeaningfulProgressAt: now,
    lastProgressText: "",
    progressStartTimer: null,
    progressTimer: null,
    progressUpdateInFlight: false,
    progressUpdatePending: false,
    displayRequested,
    latestDiff: "",
    gitBaseline: null,
    process: null,
  };
}

export function createManagedTaskRun(value) {
  const telegramDeliveryRequested = value.telegramDeliveryRequested !== false;
  return {
    id: crypto.randomUUID(),
    turnId: null,
    sessionId: value.provider === "claude" ? value.threadId : null,
    ...value,
    ...progressState({
      stage: "Задача принята.",
      displayRequested: telegramDeliveryRequested,
    }),
    telegramDeliveryRequested,
    observer: false,
  };
}

export function createObservedTaskRun(value, snapshot = {}) {
  const run = {
    id: crypto.randomUUID(),
    turnId: value.turnId ?? null,
    sessionId: value.provider === "claude" ? value.threadId : null,
    ...value,
    ...progressState({
      stage: snapshot.stage ?? "Подключение к выполняющейся задаче…",
      reasoning: snapshot.reasoning ?? "",
      displayRequested: false,
    }),
    responseText: snapshot.answer ?? "",
    observedInitialResponseText: String(snapshot.answer ?? ""),
    observedResponseChanged: false,
    observerTimer: null,
    observer: true,
  };
  const snapshotStartedAt = Date.parse(String(snapshot.startedAt ?? ""));
  if (Number.isFinite(snapshotStartedAt)) {
    run.startedAt = new Date(snapshotStartedAt).toISOString();
  }
  return run;
}

export function taskRunIsActive(run) {
  if (!run || typeof run !== "object") return false;
  const status = String(run?.status ?? "running").trim().toLowerCase();
  return status === "running" || status === "finishing";
}

export class TaskRunRegistry {
  #byId = new Map();
  #byTask = new Map();
  #byTurn = new Map();

  constructor(runs = []) {
    for (const run of runs) this.add(run);
  }

  add(run) {
    if (!run?.id) throw new Error("run id is required");
    const key = taskRunKey(run);
    const existing = this.#byTask.get(key);
    if (existing && existing !== run) throw new Error("this task is already running");
    this.#byId.set(run.id, run);
    this.#byTask.set(key, run);
    if (run.turnId) this.#byTurn.set(run.turnId, run);
    return run;
  }

  reindex(run) {
    const newKey = taskRunKey(run);
    const taskCollision = this.#byTask.get(newKey);
    if (taskCollision && taskCollision !== run) throw new Error("this task is already running");
    if (run.turnId) {
      const turnCollision = this.#byTurn.get(run.turnId);
      if (turnCollision && turnCollision !== run) throw new Error("this turn is already running");
    }
    for (const [key, indexedRun] of this.#byTask) {
      if (indexedRun === run) this.#byTask.delete(key);
    }
    for (const [turnId, indexedRun] of this.#byTurn) {
      if (indexedRun === run) this.#byTurn.delete(turnId);
    }
    this.#byTask.set(newKey, run);
    if (run.turnId) this.#byTurn.set(run.turnId, run);
    return run;
  }

  bindStream({ provider, threadId, streamId }) {
    const normalizedStreamId = String(streamId ?? "").trim();
    const normalizedProvider = String(provider ?? "").trim().toLowerCase();
    const normalizedThreadId = String(threadId ?? "").trim();
    if (!normalizedStreamId || !normalizedProvider || !normalizedThreadId) return null;
    const matches = this.values().filter((run) => (
      String(run.provider ?? "").trim().toLowerCase() === normalizedProvider
      && String(run.threadId ?? "").trim() === normalizedThreadId
    ));
    if (matches.length !== 1) return null;
    const [run] = matches;
    if (String(run.streamId ?? "").trim() === normalizedStreamId) return run;
    const nextKey = taskRunKey({ ...run, streamId: normalizedStreamId });
    const taskCollision = this.#byTask.get(nextKey);
    if (taskCollision && taskCollision !== run) throw new Error("this task is already running");
    run.streamId = normalizedStreamId;
    return this.reindex(run);
  }

  remove(runOrId) {
    const run = typeof runOrId === "string" ? this.#byId.get(runOrId) : runOrId;
    if (!run) return null;
    this.#byId.delete(run.id);
    // A run can acquire its final thread/project binding after registration.
    // Removal must therefore use object identity as the source of truth instead
    // of trusting that the current fields still reproduce every indexed key.
    for (const [key, indexedRun] of this.#byTask) {
      if (indexedRun === run) this.#byTask.delete(key);
    }
    for (const [turnId, indexedRun] of this.#byTurn) {
      if (indexedRun === run) this.#byTurn.delete(turnId);
    }
    return run;
  }

  forTask(task) {
    const exact = this.#byTask.get(taskRunKey(task)) ?? null;
    if (exact) return exact;

    const normalizedProvider = String(task?.provider ?? "").trim().toLowerCase();
    const normalizedThreadId = String(task?.threadId ?? "").trim();
    if (!normalizedProvider || !normalizedThreadId) return null;
    const matches = this.values().filter((run) => (
      String(run.provider ?? "").trim().toLowerCase() === normalizedProvider
      && String(run.threadId ?? "").trim() === normalizedThreadId
    ));
    if (matches.length !== 1) return null;
    return String(task?.streamId ?? "").trim() ? this.bindStream(task) : matches[0];
  }

  forEvent({ turnId, threadId, provider = "codex", allowThreadFallback = false }) {
    if (turnId && this.#byTurn.has(turnId)) return this.#byTurn.get(turnId);
    if (!allowThreadFallback) return null;
    const normalizedThreadId = String(threadId ?? "").trim();
    if (!normalizedThreadId) return null;
    const matches = this.values().filter((run) => (
      run.provider === provider && String(run.threadId ?? "").trim() === normalizedThreadId
      && (!turnId || !run.turnId)
    ));
    return matches.length === 1 ? matches[0] : null;
  }

  inProject(projectRoot, { excludeTask = null } = {}) {
    const root = normalizedProjectRoot(projectRoot);
    const excludedKey = excludeTask ? taskRunKey(excludeTask) : null;
    return this.values().filter((run) => (
      normalizedProjectRoot(run.projectRoot) === root
      && (!excludedKey || taskRunKey(run) !== excludedKey)
    ));
  }

  values() {
    return [...this.#byId.values()];
  }

  get size() {
    return this.#byId.size;
  }
}

export class TaskDismissalRegistry {
  #keys = new Set();

  constructor(keys = []) {
    this.restore(keys);
  }

  restore(keys) {
    for (const key of keys) {
      if (typeof key === "string" && key) this.#keys.add(key);
    }
  }

  has(task) {
    return this.#keys.has(taskRunKey(task));
  }

  add(task) {
    this.#keys.add(taskRunKey(task));
  }

  delete(task) {
    return this.#keys.delete(taskRunKey(task));
  }

  values() {
    return [...this.#keys];
  }
}

export function updateObservedResponse(run, answer) {
  const previous = String(run?.responseText ?? "");
  if (typeof run.observedInitialResponseText !== "string") {
    run.observedInitialResponseText = previous;
  }
  const next = String(answer ?? previous);
  if (next !== run.observedInitialResponseText) run.observedResponseChanged = true;
  run.responseText = next;
  return run.observedResponseChanged === true;
}

export function isRecentDuplicateTaskAnswer(previousMessage, answer, {
  now = Date.now(),
  windowMs = 30 * 60_000,
} = {}) {
  const value = String(answer ?? "").trim();
  const previous = String(previousMessage?.text ?? "").trim();
  if (!value || value !== previous) return false;
  const updatedAtMs = Date.parse(previousMessage?.updatedAt ?? "");
  return Number.isFinite(updatedAtMs)
    && now >= updatedAtMs
    && now - updatedAtMs <= windowMs;
}

export function shouldDeliverObservedCompletion(run, answer, previousMessage, options = {}) {
  if (isRecentDuplicateTaskAnswer(previousMessage, answer, options)) return false;
  return run?.displayRequested === true;
}

export function updateTaskRunTitle(run, title) {
  const value = String(title ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
  if (!run || !value || run.taskTitle === value) return false;
  run.taskTitle = value;
  return true;
}

export function shouldAutoObserveTask({
  task,
  selectedTask = task,
  snapshot,
  existingRun = null,
  dismissed = false,
  lastSeenTurnId = null,
} = {}) {
  return Boolean(
    task?.provider
      && task?.projectRoot
      && task?.threadId
      && String(selectedTask?.provider ?? "") === String(task.provider)
      && String(selectedTask?.threadId ?? "") === String(task.threadId)
      && snapshot?.active
      && (!snapshot?.turnId || String(snapshot.turnId) !== String(lastSeenTurnId ?? ""))
      && !existingRun
      && !dismissed,
  );
}

export function serializableTaskRun(run) {
  const {
    process: _process,
    progressMessageId: _progressMessageId,
    progressStartTimer: _progressStartTimer,
    progressTimer: _progressTimer,
    progressUpdateInFlight: _progressUpdateInFlight,
    progressUpdatePending: _progressUpdatePending,
    observerTimer: _observerTimer,
    // Чтение вывода Claude пересоздаётся при подключении к ходу после перезапуска.
    claudeReader: _claudeReader,
    claudeDrainTimer: _claudeDrainTimer,
    claudeDrainInFlight: _claudeDrainInFlight,
    claudeDrainPending: _claudeDrainPending,
    latestDiff: _latestDiff,
    ...value
  } = run;
  return value;
}
