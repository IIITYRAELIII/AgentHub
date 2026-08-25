import path from "node:path";

function normalizedProjectRoot(projectRoot) {
  const resolved = path.resolve(String(projectRoot ?? ""));
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function taskRunKey({ streamId, provider, projectRoot, threadId }) {
  const normalizedStreamId = String(streamId ?? "").trim();
  const normalizedProvider = String(provider ?? "").trim().toLowerCase();
  const normalizedThreadId = String(threadId ?? "").trim();
  if (normalizedStreamId && normalizedProvider && normalizedThreadId) {
    return `stream\0${normalizedStreamId}\0${normalizedProvider}\0${normalizedThreadId}`;
  }
  if (normalizedStreamId) return `stream\0${normalizedStreamId}`;
  return `${normalizedProvider}\0${normalizedProjectRoot(projectRoot)}\0${normalizedThreadId}`;
}

export function legacyTaskRunKeys({ streamId, provider, projectRoot, threadId }) {
  const normalizedStreamId = String(streamId ?? "").trim();
  const normalizedProvider = String(provider ?? "").trim().toLowerCase();
  const normalizedThreadId = String(threadId ?? "").trim();
  return [
    normalizedStreamId ? `stream\0${normalizedStreamId}` : "",
    normalizedProvider && normalizedThreadId
      ? `${normalizedProvider}\0${normalizedProjectRoot(projectRoot)}\0${normalizedThreadId}`
      : "",
  ].filter(Boolean);
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
      stage: "Поток принят.",
      displayRequested: telegramDeliveryRequested,
    }),
    telegramDeliveryRequested,
    observer: false,
  };
}

function providerLabel(provider) {
  return String(provider ?? "").trim().toLowerCase() === "claude" ? "Claude" : "Codex";
}

function eventTimestamp(value = Date.now()) {
  const timestamp = value instanceof Date
    ? value.getTime()
    : typeof value === "string"
      ? Date.parse(value)
      : Number(value);
  return new Date(Number.isFinite(timestamp) ? timestamp : Date.now()).toISOString();
}

export function taskOccupancyIdentity(value) {
  const streamId = String(value?.streamId ?? "").trim();
  const provider = String(value?.provider ?? "").trim().toLowerCase();
  const threadId = String(value?.threadId ?? "").trim();
  if (streamId && provider && threadId) {
    return { key: taskRunKey({ ...value, streamId, provider, threadId }), binding: "exact" };
  }
  if (streamId) {
    return { key: taskRunKey({ streamId }), binding: "provisional" };
  }
  if (provider && threadId) {
    return { key: taskRunKey({ ...value, streamId: null, provider, threadId }), binding: "exact" };
  }
  return null;
}

const PROVIDER_TELEMETRY_SAMPLE_INTERVAL_MS = 250;
const PROVIDER_TELEMETRY_TIMELINE_LIMIT = 32;

function eventTimeMs(value = Date.now()) {
  const timestamp = value instanceof Date
    ? value.getTime()
    : typeof value === "string"
      ? Date.parse(value)
      : Number(value);
  return Number.isFinite(timestamp) ? timestamp : Date.now();
}

function providerStartForTurn(run, turnId) {
  const providerStart = run?.providerStart;
  const exactTurnId = String(turnId ?? "").trim();
  if (!providerStart || !exactTurnId || String(providerStart.turnId ?? "") !== exactTurnId) return null;
  return providerStart;
}

function baselineTimeMs(providerStart) {
  const numeric = Number(providerStart?.turnStartedAtMs);
  if (Number.isFinite(numeric)) return numeric;
  const timestamp = Date.parse(String(providerStart?.acceptedAt ?? providerStart?.requestedAt ?? ""));
  return Number.isFinite(timestamp) ? timestamp : null;
}

function recordMaximumGap(providerStart, key, previousAtMs, occurredAtMs) {
  if (!Number.isFinite(previousAtMs) || occurredAtMs < previousAtMs) return;
  providerStart[key] = Math.max(Number(providerStart[key]) || 0, occurredAtMs - previousAtMs);
}

function appendProviderTelemetryMilestone(providerStart, milestone) {
  if (!providerStart) return;
  const value = {
    atMs: eventTimeMs(milestone.atMs),
    type: String(milestone.type ?? "event").trim() || "event",
    phase: String(milestone.phase ?? "").trim() || null,
    method: String(milestone.method ?? "").trim() || null,
  };
  const timeline = Array.isArray(providerStart.timeline) ? providerStart.timeline : [];
  const previous = timeline.at(-1);
  if (
    previous
    && previous.type === value.type
    && previous.phase === value.phase
    && previous.method === value.method
  ) return;
  timeline.push(value);
  if (timeline.length > PROVIDER_TELEMETRY_TIMELINE_LIMIT) {
    timeline.splice(0, timeline.length - PROVIDER_TELEMETRY_TIMELINE_LIMIT);
  }
  providerStart.timeline = timeline;
}

function optionalTimeMs(value) {
  if (value == null || value === "") return null;
  const timestamp = value instanceof Date
    ? value.getTime()
    : typeof value === "string"
      ? Date.parse(value)
      : Number(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

export function markProviderTurnEvent(run, {
  turnId,
  method,
  occurredAt = Date.now(),
  phase = "",
} = {}) {
  const providerStart = providerStartForTurn(run, turnId);
  if (!providerStart) return false;
  const occurredAtMs = eventTimeMs(occurredAt);
  if (method === "turn/started" && !Number.isFinite(Number(providerStart.turnStartedAtMs))) {
    providerStart.turnStartedAtMs = occurredAtMs;
  }
  const previousAtMs = Number(providerStart.lastEventAtMs);
  const baselineAtMs = Number.isFinite(previousAtMs) ? previousAtMs : baselineTimeMs(providerStart);
  recordMaximumGap(providerStart, "maxEventGapMs", baselineAtMs, occurredAtMs);
  const exactPhase = String(phase ?? "").trim();
  const phaseChanged = exactPhase && exactPhase !== providerStart.phase;
  if (phaseChanged || method === "turn/started" || method === "turn/completed") {
    appendProviderTelemetryMilestone(providerStart, {
      atMs: occurredAtMs,
      type: method === "turn/completed" ? "completed" : "phase",
      phase: exactPhase,
      method,
    });
  }
  if (
    Number.isFinite(previousAtMs)
    && occurredAtMs >= previousAtMs
    && occurredAtMs - previousAtMs < PROVIDER_TELEMETRY_SAMPLE_INTERVAL_MS
    && !phaseChanged
  ) return false;
  if (!Number.isFinite(previousAtMs) || occurredAtMs >= previousAtMs) {
    providerStart.lastEventAtMs = occurredAtMs;
    providerStart.lastEventMethod = String(method ?? "").trim() || null;
  }
  if (exactPhase) providerStart.phase = exactPhase;
  return true;
}

export function markProviderTurnContent(run, {
  turnId,
  occurredAt = Date.now(),
  kind = "reasoning",
  visible = false,
} = {}) {
  const providerStart = providerStartForTurn(run, turnId);
  if (!providerStart) return false;
  const occurredAtMs = eventTimeMs(occurredAt);
  const previousContentAtMs = Number(providerStart.lastContentAtMs);
  const contentBaselineAtMs = Number.isFinite(previousContentAtMs)
    ? previousContentAtMs
    : baselineTimeMs(providerStart);
  recordMaximumGap(providerStart, "maxContentGapMs", contentBaselineAtMs, occurredAtMs);
  const firstContent = !Number.isFinite(Number(providerStart.firstContentAtMs));
  if (firstContent) {
    providerStart.firstContentAtMs = occurredAtMs;
    appendProviderTelemetryMilestone(providerStart, {
      atMs: occurredAtMs,
      type: "first-content",
      phase: kind,
    });
  }
  if (
    !Number.isFinite(previousContentAtMs)
    || occurredAtMs - previousContentAtMs >= PROVIDER_TELEMETRY_SAMPLE_INTERVAL_MS
  ) providerStart.lastContentAtMs = occurredAtMs;
  const exactKind = String(kind ?? "").trim() || "reasoning";
  providerStart.phase = exactKind === "answer" ? "answering" : exactKind;
  if (visible) {
    const previousVisibleAtMs = Number(providerStart.lastVisibleAtMs);
    const visibleBaselineAtMs = Number.isFinite(previousVisibleAtMs)
      ? previousVisibleAtMs
      : baselineTimeMs(providerStart);
    recordMaximumGap(providerStart, "maxVisibleGapMs", visibleBaselineAtMs, occurredAtMs);
    const firstVisible = !Number.isFinite(Number(providerStart.firstVisibleAtMs));
    if (firstVisible) {
      providerStart.firstVisibleAtMs = occurredAtMs;
      appendProviderTelemetryMilestone(providerStart, {
        atMs: occurredAtMs,
        type: "first-visible",
        phase: "answering",
      });
    }
    if (
      !Number.isFinite(previousVisibleAtMs)
      || occurredAtMs - previousVisibleAtMs >= PROVIDER_TELEMETRY_SAMPLE_INTERVAL_MS
    ) providerStart.lastVisibleAtMs = occurredAtMs;
  }
  return true;
}

export function markProviderTurnCompaction(run, {
  turnId,
  stage,
  occurredAt = Date.now(),
} = {}) {
  const providerStart = providerStartForTurn(run, turnId);
  if (!providerStart) return false;
  const occurredAtMs = eventTimeMs(occurredAt);
  const exactStage = String(stage ?? "").trim().toLowerCase();
  if (exactStage === "started") {
    providerStart.compactionStartedAtMs = occurredAtMs;
    providerStart.compactionCount = Math.max(0, Number(providerStart.compactionCount) || 0) + 1;
    appendProviderTelemetryMilestone(providerStart, {
      atMs: occurredAtMs,
      type: "compaction-started",
      phase: "compaction",
    });
    return true;
  }
  if (exactStage === "completed") {
    const startedAtMs = optionalTimeMs(providerStart.compactionStartedAtMs);
    const durationMs = startedAtMs == null ? null : Math.max(0, occurredAtMs - startedAtMs);
    providerStart.compactionCompletedAtMs = occurredAtMs;
    if (durationMs != null) {
      providerStart.compactionTotalMs = Math.max(0, Number(providerStart.compactionTotalMs) || 0) + durationMs;
      providerStart.compactionMaxMs = Math.max(Number(providerStart.compactionMaxMs) || 0, durationMs);
    }
    appendProviderTelemetryMilestone(providerStart, {
      atMs: occurredAtMs,
      type: "compaction-completed",
      phase: "compaction",
    });
    return true;
  }
  return false;
}

export function providerTurnTelemetrySnapshot(run, {
  turnId = run?.turnId,
  status = run?.status,
  completedAtMs = run?.providerStart?.completedAtMs,
} = {}) {
  const providerStart = providerStartForTurn(run, turnId);
  if (!providerStart) return null;
  const startedAtMs = optionalTimeMs(run?.startedAt)
    ?? optionalTimeMs(providerStart.requestedAt)
    ?? optionalTimeMs(providerStart.acceptedAt);
  const terminalAtMs = optionalTimeMs(providerStart.completedAtMs) ?? optionalTimeMs(completedAtMs);
  return {
    provider: String(run?.provider ?? "").trim().toLowerCase(),
    threadId: String(run?.threadId ?? "").trim(),
    turnId: String(turnId ?? "").trim(),
    workspaceId: String(run?.workspaceId ?? "").trim() || null,
    streamId: String(run?.streamId ?? "").trim() || null,
    taskThreadId: String(run?.taskThreadId ?? run?.threadId ?? "").trim(),
    runId: String(run?.id ?? "").trim() || null,
    model: String(run?.modelId ?? run?.model ?? "").trim() || null,
    serviceTier: String(run?.serviceTier ?? "").trim() || null,
    status: String(status ?? "").trim() || null,
    finalPhase: String(providerStart.phase ?? "").trim() || null,
    firstEventMethod: String(providerStart.firstEventMethod ?? "").trim() || null,
    lastEventMethod: String(providerStart.lastEventMethod ?? "").trim() || null,
    startedAtMs,
    requestedAtMs: optionalTimeMs(providerStart.requestedAt),
    acceptedAtMs: optionalTimeMs(providerStart.acceptedAt),
    turnStartedAtMs: optionalTimeMs(providerStart.turnStartedAtMs),
    firstEventAtMs: optionalTimeMs(providerStart.firstEventAt),
    firstContentAtMs: optionalTimeMs(providerStart.firstContentAtMs),
    firstVisibleAtMs: optionalTimeMs(providerStart.firstVisibleAtMs),
    lastEventAtMs: optionalTimeMs(providerStart.lastEventAtMs),
    lastContentAtMs: optionalTimeMs(providerStart.lastContentAtMs),
    lastVisibleAtMs: optionalTimeMs(providerStart.lastVisibleAtMs),
    completedAtMs: terminalAtMs,
    maxEventGapMs: Math.max(0, Number(providerStart.maxEventGapMs) || 0),
    maxContentGapMs: Math.max(0, Number(providerStart.maxContentGapMs) || 0),
    maxVisibleGapMs: Math.max(0, Number(providerStart.maxVisibleGapMs) || 0),
    compaction: {
      count: Math.max(0, Number(providerStart.compactionCount) || 0),
      totalMs: Math.max(0, Number(providerStart.compactionTotalMs) || 0),
      maxMs: Math.max(0, Number(providerStart.compactionMaxMs) || 0),
      startedAtMs: optionalTimeMs(providerStart.compactionStartedAtMs),
      completedAtMs: optionalTimeMs(providerStart.compactionCompletedAtMs),
    },
    timeline: Array.isArray(providerStart.timeline)
      ? providerStart.timeline.map((item) => ({ ...item }))
      : [],
  };
}

export function markProviderTurnCompleted(run, {
  turnId,
  completedAt = Date.now(),
} = {}) {
  const providerStart = providerStartForTurn(run, turnId);
  if (!providerStart) return false;
  const completedAtMs = eventTimeMs(completedAt);
  markProviderTurnEvent(run, {
    turnId,
    method: "turn/completed",
    occurredAt: completedAtMs,
    phase: "completed",
  });
  providerStart.completedAtMs = completedAtMs;
  providerStart.phase = "completed";
  return true;
}

export function markProviderTurnRequested(run, {
  clientUserMessageId = run?.clientUserMessageId,
  requestedAt = Date.now(),
  provider = run?.provider,
} = {}) {
  if (!run) return null;
  const requestedAtIso = eventTimestamp(requestedAt);
  run.providerStart = {
    state: "requesting",
    clientUserMessageId: String(clientUserMessageId ?? "").trim() || null,
    requestedAt: requestedAtIso,
    turnId: null,
    acceptedAt: null,
    firstEventAt: null,
    firstEventMethod: null,
  };
  run.progressStage = `Отправляю запрос ${providerLabel(provider)}…`;
  run.lastMeaningfulProgressAt = requestedAtIso;
  return run.providerStart;
}

export function markProviderTurnAccepted(run, {
  turnId,
  acceptedAt = Date.now(),
  provider = run?.provider,
} = {}) {
  if (!run) return null;
  const exactTurnId = String(turnId ?? "").trim();
  if (!exactTurnId) return null;
  const previous = run.providerStart;
  const sameTurn = String(previous?.turnId ?? "") === exactTurnId;
  if (sameTurn && previous?.state === "observed") return previous;
  const acceptedAtIso = sameTurn && previous?.acceptedAt
    ? String(previous.acceptedAt)
    : eventTimestamp(acceptedAt);
  run.providerStart = {
    state: "accepted-awaiting-first-event",
    clientUserMessageId: String(
      previous?.clientUserMessageId ?? run.clientUserMessageId ?? "",
    ).trim() || null,
    requestedAt: previous?.requestedAt ?? null,
    turnId: exactTurnId,
    acceptedAt: acceptedAtIso,
    firstEventAt: null,
    firstEventMethod: null,
  };
  run.progressStage = `${providerLabel(provider)} принял ход. Ожидается первый ответ…`;
  run.lastMeaningfulProgressAt = acceptedAtIso;
  return run.providerStart;
}

export function markProviderFirstEvent(run, {
  turnId,
  method,
  occurredAt = Date.now(),
  provider = run?.provider,
} = {}) {
  const providerStart = run?.providerStart;
  const exactTurnId = String(turnId ?? "").trim();
  if (
    !providerStart
    || providerStart.state !== "accepted-awaiting-first-event"
    || !exactTurnId
    || String(providerStart.turnId ?? "") !== exactTurnId
  ) return false;
  const firstEventAt = eventTimestamp(occurredAt);
  run.providerStart = {
    ...providerStart,
    state: "observed",
    firstEventAt,
    firstEventMethod: String(method ?? "").trim() || null,
  };
  run.progressStage = `${providerLabel(provider)} начал отвечать…`;
  run.lastMeaningfulProgressAt = firstEventAt;
  return true;
}

export function createObservedTaskRun(value, snapshot = {}) {
  const run = {
    id: crypto.randomUUID(),
    turnId: value.turnId ?? null,
    sessionId: value.provider === "claude" ? value.threadId : null,
    ...value,
    ...progressState({
      stage: snapshot.stage ?? "Подключение к выполняющемуся потоку…",
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
  #revision = 0;

  constructor(runs = []) {
    for (const run of runs) this.add(run);
  }

  add(run) {
    if (!run?.id) throw new Error("run id is required");
    const key = taskRunKey(run);
    const existing = this.#byTask.get(key);
    if (existing && existing !== run && taskRunIsActive(existing)) {
      throw new Error("this task is already running");
    }
    this.#byId.set(run.id, run);
    this.#byTask.set(key, run);
    if (run.turnId) this.#byTurn.set(run.turnId, run);
    this.#revision += 1;
    return run;
  }

  reindex(run) {
    if (!run?.id || this.#byId.get(run.id) !== run) {
      throw new Error("cannot reindex an inactive task run");
    }
    const newKey = taskRunKey(run);
    const taskCollision = this.#byTask.get(newKey);
    if (taskCollision && taskCollision !== run && taskRunIsActive(taskCollision)) {
      throw new Error("this task is already running");
    }
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
    this.#revision += 1;
    return run;
  }

  touch(run) {
    if (!run?.id || this.#byId.get(run.id) !== run) return false;
    this.#revision += 1;
    return true;
  }

  bindStream({ provider, threadId, streamId }) {
    const normalizedStreamId = String(streamId ?? "").trim();
    const normalizedProvider = String(provider ?? "").trim().toLowerCase();
    const normalizedThreadId = String(threadId ?? "").trim();
    if (!normalizedStreamId || !normalizedProvider || !normalizedThreadId) return null;
    const matches = this.values().filter((run) => (
      taskRunIsActive(run)
      &&
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
    this.#revision += 1;
    return run;
  }

  forTask(task) {
    const exact = this.#byTask.get(taskRunKey(task)) ?? null;
    if (taskRunIsActive(exact)) return exact;

    const normalizedStreamId = String(task?.streamId ?? "").trim();
    if (normalizedStreamId && !String(task?.threadId ?? "").trim()) {
      const matches = this.values().filter((run) => (
        taskRunIsActive(run) && String(run.streamId ?? "").trim() === normalizedStreamId
      ));
      return matches.length === 1 ? matches[0] : null;
    }

    const normalizedProvider = String(task?.provider ?? "").trim().toLowerCase();
    const normalizedThreadId = String(task?.threadId ?? "").trim();
    if (!normalizedProvider || !normalizedThreadId) return null;
    const matches = this.values().filter((run) => (
      taskRunIsActive(run)
      &&
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

  get revision() {
    return this.#revision;
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
      // Codex completion is correlated by turn id. An active transport-level
      // snapshot without one can be a short-lived context probe or reconnect
      // state and must not become a task run that blocks normal input.
      && (String(task.provider).toLowerCase() !== "codex" || snapshot?.turnId)
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
