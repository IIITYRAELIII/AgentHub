import assert from "node:assert/strict";
import test from "node:test";
import {
  createManagedTaskRun,
  createObservedTaskRun,
  isRecentDuplicateTaskAnswer,
  legacyTaskRunKeys,
  markProviderFirstEvent,
  markProviderTurnCompleted,
  markProviderTurnCompaction,
  markProviderTurnContent,
  markProviderTurnEvent,
  markProviderTurnAccepted,
  markProviderTurnRequested,
  providerTurnTelemetrySnapshot,
  TaskDismissalRegistry,
  TaskRunRegistry,
  serializableTaskRun,
  shouldAutoObserveTask,
  shouldDeliverObservedCompletion,
  taskRunIsActive,
  taskOccupancyIdentity,
  taskRunKey,
  updateObservedResponse,
  updateTaskRunTitle,
} from "../../src/domain/task-runs.mjs";

test("provider start request is durable before the external side effect", () => {
  const run = { provider: "codex", clientUserMessageId: "message-1" };
  markProviderTurnRequested(run, { requestedAt: Date.parse("2026-08-15T00:00:00.000Z") });
  assert.deepEqual(run.providerStart, {
    state: "requesting",
    clientUserMessageId: "message-1",
    requestedAt: "2026-08-15T00:00:00.000Z",
    turnId: null,
    acceptedAt: null,
    firstEventAt: null,
    firstEventMethod: null,
  });
  assert.equal(run.progressStage, "Отправляю запрос Codex…");
});

test("provider receipt stays explicit until the first exact provider event", () => {
  const run = { provider: "codex", progressStage: "Поток принят." };
  markProviderTurnAccepted(run, {
    turnId: "turn-1",
    acceptedAt: Date.parse("2026-08-15T00:00:00.000Z"),
  });
  assert.deepEqual(run.providerStart, {
    state: "accepted-awaiting-first-event",
    clientUserMessageId: null,
    requestedAt: null,
    turnId: "turn-1",
    acceptedAt: "2026-08-15T00:00:00.000Z",
    firstEventAt: null,
    firstEventMethod: null,
  });
  assert.equal(run.progressStage, "Codex принял ход. Ожидается первый ответ…");
  assert.equal(markProviderFirstEvent(run, { turnId: "other", method: "item/started" }), false);
  assert.equal(markProviderFirstEvent(run, {
    turnId: "turn-1",
    method: "item/started",
    occurredAt: Date.parse("2026-08-15T00:03:12.000Z"),
  }), true);
  assert.equal(run.providerStart.state, "observed");
  assert.equal(run.providerStart.firstEventAt, "2026-08-15T00:03:12.000Z");
  assert.equal(run.progressStage, "Codex начал отвечать…");
  assert.equal(markProviderTurnAccepted(run, { turnId: "turn-1" }).state, "observed");
});

test("provider telemetry records live gaps and content phases without polling", () => {
  const run = { provider: "codex" };
  markProviderTurnAccepted(run, {
    turnId: "turn-1",
    acceptedAt: Date.parse("2026-08-15T00:00:00.000Z"),
  });
  markProviderTurnEvent(run, {
    turnId: "turn-1",
    method: "turn/started",
    occurredAt: Date.parse("2026-08-15T00:00:01.000Z"),
    phase: "starting",
  });
  markProviderTurnContent(run, {
    turnId: "turn-1",
    occurredAt: Date.parse("2026-08-15T00:00:11.000Z"),
    kind: "reasoning",
  });
  markProviderTurnContent(run, {
    turnId: "turn-1",
    occurredAt: Date.parse("2026-08-15T00:00:31.000Z"),
    kind: "answer",
    visible: true,
  });
  markProviderTurnCompaction(run, {
    turnId: "turn-1",
    stage: "started",
    occurredAt: Date.parse("2026-08-15T00:00:32.000Z"),
  });
  markProviderTurnCompaction(run, {
    turnId: "turn-1",
    stage: "completed",
    occurredAt: Date.parse("2026-08-15T00:00:38.000Z"),
  });
  markProviderTurnCompleted(run, {
    turnId: "turn-1",
    completedAt: Date.parse("2026-08-15T00:00:41.000Z"),
  });

  assert.equal(run.providerStart.turnStartedAtMs, Date.parse("2026-08-15T00:00:01.000Z"));
  assert.equal(run.providerStart.firstContentAtMs, Date.parse("2026-08-15T00:00:11.000Z"));
  assert.equal(run.providerStart.firstVisibleAtMs, Date.parse("2026-08-15T00:00:31.000Z"));
  assert.equal(run.providerStart.maxContentGapMs, 20_000);
  assert.equal(run.providerStart.completedAtMs, Date.parse("2026-08-15T00:00:41.000Z"));
  assert.equal(run.providerStart.phase, "completed");
  assert.equal(run.providerStart.compactionTotalMs, 6_000);
  assert.deepEqual(
    run.providerStart.timeline.map((item) => item.type),
    ["phase", "first-content", "first-visible", "compaction-started", "compaction-completed", "completed"],
  );

  const telemetry = providerTurnTelemetrySnapshot({
    ...run,
    id: "run-1",
    threadId: "thread-1",
    turnId: "turn-1",
    streamId: "stream-1",
    startedAt: "2026-08-15T00:00:00.000Z",
  });
  assert.equal(telemetry.compaction.totalMs, 6_000);
  assert.equal(telemetry.timeline.at(-1).type, "completed");
});

test("an inactive run cannot be resurrected by a late reindex", () => {
  const registry = new TaskRunRegistry();
  const run = createManagedTaskRun({ id: "run-1", provider: "codex", threadId: "thread-1" });
  registry.add(run);
  registry.remove(run);
  run.turnId = "late-turn";
  assert.throws(() => registry.reindex(run), /inactive task run/u);
  assert.deepEqual(registry.values(), []);
});

test("task run registry exposes a monotonic presentation revision", () => {
  const registry = new TaskRunRegistry();
  const item = createManagedTaskRun({ id: "run-1", provider: "codex", threadId: "thread-1" });
  assert.equal(registry.revision, 0);
  registry.add(item);
  assert.equal(registry.revision, 1);
  assert.equal(registry.touch(item), true);
  assert.equal(registry.revision, 2);
  registry.reindex(item);
  assert.equal(registry.revision, 3);
  registry.remove(item);
  assert.equal(registry.revision, 4);
  assert.equal(registry.touch(item), false);
  assert.equal(registry.revision, 4);
});

test("runtime serialization excludes reconstructible active presentation caches", () => {
  const userMessages = [{ role: "user", text: "Проверь" }];
  const providerStart = { state: "observed", turnId: "turn-1" };
  const serialized = serializableTaskRun({
    id: "run-1",
    turnId: "turn-1",
    responseText: "Текущий ответ",
    userMessages,
    providerStart,
    liveItems: [{ id: "live-1" }],
    responseItems: [{ id: "response-1" }],
    activities: [{ id: "activity-1" }],
    activityGroups: [{ id: "group-1", activities: [] }],
    currentActivityGroupId: "group-1",
  });

  assert.deepEqual(serialized, {
    id: "run-1",
    turnId: "turn-1",
    responseText: "Текущий ответ",
    userMessages,
    providerStart,
  });
});

test("taskRunIsActive excludes terminal runs kept for final delivery", () => {
  assert.equal(taskRunIsActive(null), false);
  assert.equal(taskRunIsActive(undefined), false);
  assert.equal(taskRunIsActive({}), true);
  assert.equal(taskRunIsActive({ status: "running" }), true);
  assert.equal(taskRunIsActive({ status: "finishing" }), true);
  assert.equal(taskRunIsActive({ status: "completed" }), false);
  assert.equal(taskRunIsActive({ status: "failed" }), false);
});

test("task run factories initialize managed and observed lifecycle state", () => {
  const managed = createManagedTaskRun({ provider: "claude", threadId: "session-1" });
  assert.equal(managed.sessionId, "session-1");
  assert.equal(managed.observer, false);
  assert.equal(managed.progressStage, "Поток принят.");
  const observed = createObservedTaskRun(
    { provider: "codex", threadId: "thread-1", turnId: "turn-1" },
    {
      answer: "часть",
      stage: "Работаю",
      reasoning: "анализ",
      startedAt: "2026-07-30T10:15:00.000Z",
    },
  );
  assert.equal(observed.observer, true);
  assert.equal(observed.responseText, "часть");
  assert.equal(observed.observedInitialResponseText, "часть");
  assert.equal(observed.progressStage, "Работаю");
  assert.equal(observed.startedAt, "2026-07-30T10:15:00.000Z");
});

test("selected external task is observed automatically only while its turn is active", () => {
  const task = {
    provider: "codex",
    projectRoot: "C:\\Projects\\Main",
    threadId: "thread-1",
  };
  assert.equal(shouldAutoObserveTask({ task, snapshot: { active: true } }), false);
  assert.equal(shouldAutoObserveTask({
    task: { ...task, provider: "claude" },
    snapshot: { active: true },
  }), true);
  assert.equal(shouldAutoObserveTask({ task, snapshot: { active: false } }), false);
  assert.equal(shouldAutoObserveTask({ task, snapshot: { active: true }, existingRun: {} }), false);
  assert.equal(shouldAutoObserveTask({ task, snapshot: { active: true }, dismissed: true }), false);
  assert.equal(shouldAutoObserveTask({
    task,
    snapshot: { active: true, turnId: "managed-turn" },
    lastSeenTurnId: "managed-turn",
  }), false);
  assert.equal(shouldAutoObserveTask({
    task,
    snapshot: { active: true, turnId: "new-external-turn", prompt: "Внешний вопрос" },
    lastSeenTurnId: "managed-turn",
  }), true);
  assert.equal(shouldAutoObserveTask({
    task,
    snapshot: { active: true, turnId: "compaction-turn" },
  }), false);
  assert.equal(shouldAutoObserveTask({
    task,
    snapshot: {
      active: true,
      turnId: "probe-turn",
      prompt: "Ответь строго: AGENT_HUB_CONTEXT_PROBE_OK_V1",
      clientUserMessageId: "agent-hub-context-probe:test",
    },
  }), false);
  assert.equal(shouldAutoObserveTask({
    task,
    snapshot: {
      active: true,
      turnId: "manual-probe-text-turn",
      prompt: "Ответь строго: AGENT_HUB_CONTEXT_PROBE_OK_V1",
    },
  }), true);
  assert.equal(shouldAutoObserveTask({
    task,
    selectedTask: { ...task, threadId: "thread-2" },
    snapshot: { active: true, turnId: "new-external-turn", prompt: "Внешний вопрос" },
  }), false);
  assert.equal(shouldAutoObserveTask({
    task: { ...task, streamId: "stream-1" },
    selectedTask: { ...task, streamId: "stream-1", threadId: "thread-2" },
    snapshot: { active: true, turnId: "new-external-turn", prompt: "Внешний вопрос" },
  }), false);
});

function run(overrides = {}) {
  return {
    id: overrides.id ?? crypto.randomUUID(),
    provider: "codex",
    projectRoot: "C:\\Work\\Project",
    threadId: "thread-1",
    turnId: null,
    status: "running",
    ...overrides,
  };
}

test("different tasks and projects can run at the same time", () => {
  const first = run({ id: "run-1" });
  const second = run({ id: "run-2", threadId: "thread-2" });
  const third = run({ id: "run-3", projectRoot: "C:\\Work\\Other" });
  const registry = new TaskRunRegistry([first, second, third]);

  assert.equal(registry.size, 3);
  assert.equal(registry.forTask(first), first);
  assert.deepEqual(registry.inProject(first.projectRoot), [first, second]);
});

test("different threads inside one Stream can run at the same time", () => {
  const first = run({ id: "run-1", streamId: "stream-1", threadId: "thread-1" });
  const second = run({ id: "run-2", streamId: "stream-1", threadId: "thread-2" });
  const registry = new TaskRunRegistry([first, second]);

  assert.equal(registry.size, 2);
  assert.equal(registry.forTask(first), first);
  assert.equal(registry.forTask(second), second);
  assert.equal(registry.forTask({ streamId: "stream-1" }), null);
});

test("occupancy promotes a Stream lane to exact provider Thread identity", () => {
  assert.deepEqual(taskOccupancyIdentity({ streamId: "stream-1" }), {
    key: "stream\0stream-1",
    binding: "provisional",
  });
  assert.deepEqual(taskOccupancyIdentity({
    streamId: "stream-1",
    provider: "codex",
    threadId: "thread-1",
  }), {
    key: "stream\0stream-1\0codex\0thread-1",
    binding: "exact",
  });
});

test("a terminal indexed run does not occupy admission", () => {
  const completed = run({ id: "run-completed", turnId: "turn-completed", status: "completed" });
  const registry = new TaskRunRegistry([completed]);
  assert.equal(registry.forTask(completed), null);

  const active = run({ id: "run-next", turnId: "turn-next" });
  registry.add(active);

  assert.equal(registry.forTask(active), active);
  assert.equal(registry.forEvent({ turnId: completed.turnId }), completed);
  assert.equal(registry.size, 2);
});

test("a task cannot start a second concurrent turn", () => {
  const registry = new TaskRunRegistry([run({ id: "run-1" })]);
  assert.throws(() => registry.add(run({ id: "run-2" })), /already running/);
});

test("turn and thread events resolve to their own runs", () => {
  const first = run({ id: "run-1", turnId: "turn-1" });
  const second = run({ id: "run-2", threadId: "thread-2", turnId: "turn-2" });
  const registry = new TaskRunRegistry([first, second]);

  assert.equal(registry.forEvent({ turnId: "turn-2" }), second);
  assert.equal(registry.forEvent({ threadId: "thread-1" }), null);
  assert.equal(registry.forEvent({ threadId: "thread-1", allowThreadFallback: true }), first);
});

test("an unknown turn never falls back to a different turn in the same thread", () => {
  const existing = run({ id: "run-1", turnId: "turn-1" });
  const registry = new TaskRunRegistry([existing]);

  assert.equal(registry.forEvent({
    turnId: "parallel-turn",
    threadId: existing.threadId,
    allowThreadFallback: true,
  }), null);
});

test("turn started can bind a provisional run by thread exactly once", () => {
  const provisional = run({ id: "run-1", turnId: null });
  const registry = new TaskRunRegistry([provisional]);

  assert.equal(registry.forEvent({
    turnId: "turn-1",
    threadId: provisional.threadId,
    allowThreadFallback: true,
  }), provisional);
});

test("reindex follows a Claude session id assigned after startup", () => {
  const provisional = run({ id: "run-1", provider: "claude", threadId: null });
  const registry = new TaskRunRegistry([provisional]);
  provisional.threadId = "session-1";
  registry.reindex(provisional, { threadId: null });

  assert.equal(registry.forTask({ ...provisional, threadId: null }), null);
  assert.equal(registry.forTask(provisional), provisional);
});

test("reindex preserves existing indexes when the next task or turn collides", () => {
  const first = run({ id: "run-1", threadId: "thread-1", turnId: "turn-1" });
  const second = run({ id: "run-2", threadId: "thread-2", turnId: "turn-2" });
  const registry = new TaskRunRegistry([first, second]);

  first.threadId = second.threadId;
  first.turnId = "turn-3";
  assert.throws(() => registry.reindex(first), /already running/);

  assert.equal(registry.forTask({ ...first, threadId: "thread-1" }), first);
  assert.equal(registry.forEvent({ turnId: "turn-1" }), first);
  assert.equal(registry.forTask(second), second);
  assert.equal(registry.forEvent({ turnId: "turn-2" }), second);

  first.threadId = "thread-1";
  first.turnId = second.turnId;
  assert.throws(() => registry.reindex(first), /this turn is already running/);

  assert.equal(registry.forTask({ ...first, threadId: "thread-1" }), first);
  assert.equal(registry.forEvent({ turnId: "turn-1" }), first);
  assert.equal(registry.forTask(second), second);
  assert.equal(registry.forEvent({ turnId: "turn-2" }), second);
});

test("run registry promotes a provider-bound run to its stable Stream", () => {
  const provisional = run({ id: "run-1", streamId: null, threadId: "thread-1" });
  const registry = new TaskRunRegistry([provisional]);
  registry.bindStream({ provider: "codex", threadId: "thread-1", streamId: "stream-1" });

  assert.equal(provisional.streamId, "stream-1");
  assert.equal(registry.forTask({ streamId: "stream-1" }), provisional);
  assert.equal(registry.forTask({ provider: "codex", threadId: "thread-1" }), provisional);
});

test("bindStream keeps exact thread identity when the Stream has another active run", () => {
  const provisional = run({ id: "run-1", streamId: null, threadId: "thread-1" });
  const occupied = run({ id: "run-2", streamId: "stream-1", threadId: "thread-2" });
  const registry = new TaskRunRegistry([provisional, occupied]);

  registry.bindStream({ provider: "codex", threadId: "thread-1", streamId: "stream-1" });

  assert.equal(provisional.streamId, "stream-1");
  assert.equal(registry.forTask({ provider: "codex", threadId: "thread-1" }), provisional);
  assert.equal(registry.forTask({ streamId: "stream-1" }), null);
  assert.equal(registry.forTask({ provider: "codex", threadId: "thread-2", streamId: "stream-1" }), occupied);
});

test("stable Stream lookup lazily promotes a provisional provider-bound run", () => {
  const provisional = run({ id: "run-1", streamId: null, threadId: "thread-1" });
  const registry = new TaskRunRegistry([provisional]);

  assert.equal(registry.forTask({
    provider: "codex",
    threadId: "thread-1",
    streamId: "stream-1",
  }), provisional);
  assert.equal(provisional.streamId, "stream-1");
  assert.equal(registry.forTask({ streamId: "stream-1" }), provisional);
});

test("removal clears stale indexes after a task binding changed", () => {
  const existing = run({ id: "run-1", turnId: "turn-1" });
  const originalBinding = { ...existing };
  const registry = new TaskRunRegistry([existing]);

  existing.projectRoot = "C:\\Work\\Moved";
  existing.threadId = "thread-2";
  existing.turnId = "turn-2";
  registry.remove(existing);

  assert.equal(registry.size, 0);
  assert.equal(registry.forTask(originalBinding), null);
  assert.equal(registry.forEvent({ turnId: "turn-1" }), null);
});

test("task keys normalize Windows project path casing", () => {
  if (process.platform !== "win32") return;
  assert.equal(
    taskRunKey(run({ projectRoot: "C:\\WORK\\Project" })),
    taskRunKey(run({ projectRoot: "c:\\work\\project" })),
  );
});

test("legacy task keys cover persisted Stream and provider Thread identities", () => {
  const task = run({ streamId: "stream-1", projectRoot: "C:/workspace", threadId: "thread-1" });
  assert.deepEqual(legacyTaskRunKeys(task), [
    "stream\0stream-1",
    taskRunKey({ ...task, streamId: null }),
  ]);
});

test("serialization excludes process and timer handles", () => {
  const source = run({
    process: { pid: 42 },
    progressMessageId: 123,
    progressStartTimer: { timer: true },
    progressTimer: { timer: true },
    progressUpdateInFlight: true,
    progressUpdatePending: true,
    observerTimer: { timer: true },
    claudeProcessFingerprint: {
      pid: 42,
      creationTime: "2026-07-30T10:00:00.000Z",
      executablePath: "C:\\Claude\\claude.exe",
      commandLine: "claude --resume session-1",
    },
  });
  const serialized = serializableTaskRun(source);

  assert.equal(serialized.process, undefined);
  assert.equal(serialized.progressMessageId, undefined);
  assert.equal(serialized.progressStartTimer, undefined);
  assert.equal(serialized.progressTimer, undefined);
  assert.equal(serialized.progressUpdateInFlight, undefined);
  assert.equal(serialized.progressUpdatePending, undefined);
  assert.equal(serialized.observerTimer, undefined);
  assert.deepEqual(serialized.claudeProcessFingerprint, source.claudeProcessFingerprint);
  assert.equal(serialized.id, source.id);
});

test("dismissed external tasks survive state serialization and clear exactly once", () => {
  const task = run();
  const dismissals = new TaskDismissalRegistry();
  dismissals.add(task);

  assert.equal(dismissals.has(task), true);
  assert.equal(new TaskDismissalRegistry(dismissals.values()).has(task), true);
  assert.equal(dismissals.has(run({ threadId: "thread-2" })), false);
  assert.equal(dismissals.delete(task), true);
  assert.equal(dismissals.has(task), false);
});

test("an observed task delivers only an answer that changed after attachment", () => {
  const observed = run({
    responseText: "Старый ответ",
    observedInitialResponseText: "Старый ответ",
    observedResponseChanged: false,
  });

  assert.equal(updateObservedResponse(observed, "Старый ответ"), false);
  assert.equal(updateObservedResponse(observed, "Новый итоговый ответ"), true);
  assert.equal(updateObservedResponse(observed, "Старый ответ"), true);
});

test("an observed completion is delivered only after an explicit live view request", () => {
  const now = Date.parse("2026-07-22T12:57:00.000Z");
  const background = run({
    displayRequested: false,
    observedResponseChanged: true,
  });
  assert.equal(shouldDeliverObservedCompletion(background, "Новый ответ", null, { now }), false);

  const displayed = run({
    displayRequested: true,
    observedResponseChanged: true,
  });
  assert.equal(shouldDeliverObservedCompletion(displayed, "Новый ответ", null, { now }), true);
  const previous = { text: "Новый ответ", updatedAt: "2026-07-22T12:47:00.000Z" };
  assert.equal(isRecentDuplicateTaskAnswer(previous, "Новый ответ", { now }), true);
  assert.equal(shouldDeliverObservedCompletion(displayed, "Новый ответ", previous, { now }), false);
  assert.equal(shouldDeliverObservedCompletion(displayed, "Другой ответ", previous, { now }), true);
});

test("a restored task run adopts the current title of the same thread", () => {
  const restored = run({ taskTitle: "Старое название" });
  assert.equal(updateTaskRunTitle(restored, "  Новое\n название  "), true);
  assert.equal(restored.taskTitle, "Новое название");
  assert.equal(updateTaskRunTitle(restored, "Новое название"), false);
  assert.equal(updateTaskRunTitle(restored, ""), false);
});
