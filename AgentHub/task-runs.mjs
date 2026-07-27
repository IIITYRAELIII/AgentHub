import path from "node:path";

function normalizedProjectRoot(projectRoot) {
  const resolved = path.resolve(String(projectRoot ?? ""));
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function taskRunKey({ provider, projectRoot, threadId }) {
  const normalizedProvider = String(provider ?? "").trim().toLowerCase();
  const normalizedThreadId = String(threadId ?? "").trim();
  return `${normalizedProvider}\0${normalizedProjectRoot(projectRoot)}\0${normalizedThreadId}`;
}

function progressState({ stage, reasoning = "", displayRequested }) {
  const now = new Date().toISOString();
  return {
    responseText: "",
    status: "running",
    startedAt: now,
    progressMessageIds: [],
    progressStage: stage,
    progressReasoning: reasoning,
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
  return {
    id: crypto.randomUUID(),
    turnId: null,
    sessionId: value.provider === "claude" ? value.threadId : null,
    ...value,
    ...progressState({ stage: "Задача принята.", displayRequested: true }),
    observer: false,
  };
}

export function createObservedTaskRun(value, snapshot = {}) {
  return {
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

  reindex(run, previous = {}) {
    const oldKey = taskRunKey({ ...run, ...previous });
    if (this.#byTask.get(oldKey) === run) this.#byTask.delete(oldKey);
    if (previous.turnId && this.#byTurn.get(previous.turnId) === run) {
      this.#byTurn.delete(previous.turnId);
    }
    const newKey = taskRunKey(run);
    const existing = this.#byTask.get(newKey);
    if (existing && existing !== run) throw new Error("this task is already running");
    this.#byTask.set(newKey, run);
    if (run.turnId) this.#byTurn.set(run.turnId, run);
    return run;
  }

  remove(runOrId) {
    const run = typeof runOrId === "string" ? this.#byId.get(runOrId) : runOrId;
    if (!run) return null;
    this.#byId.delete(run.id);
    const key = taskRunKey(run);
    if (this.#byTask.get(key) === run) this.#byTask.delete(key);
    if (run.turnId && this.#byTurn.get(run.turnId) === run) this.#byTurn.delete(run.turnId);
    return run;
  }

  forTask(task) {
    return this.#byTask.get(taskRunKey(task)) ?? null;
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
} = {}) {
  return Boolean(
    task?.provider
      && task?.projectRoot
      && task?.threadId
      && taskRunKey(selectedTask) === taskRunKey(task)
      && snapshot?.active
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
