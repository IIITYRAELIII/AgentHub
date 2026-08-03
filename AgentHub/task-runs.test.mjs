import assert from "node:assert/strict";
import test from "node:test";
import {
  createManagedTaskRun,
  createObservedTaskRun,
  isRecentDuplicateTaskAnswer,
  TaskDismissalRegistry,
  TaskRunRegistry,
  serializableTaskRun,
  shouldAutoObserveTask,
  shouldDeliverObservedCompletion,
  taskRunKey,
  updateObservedResponse,
  updateTaskRunTitle,
} from "./task-runs.mjs";

test("task run factories initialize managed and observed lifecycle state", () => {
  const managed = createManagedTaskRun({ provider: "claude", threadId: "session-1" });
  assert.equal(managed.sessionId, "session-1");
  assert.equal(managed.observer, false);
  assert.equal(managed.progressStage, "Задача принята.");
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
  assert.equal(shouldAutoObserveTask({ task, snapshot: { active: true } }), true);
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
    snapshot: { active: true, turnId: "new-external-turn" },
    lastSeenTurnId: "managed-turn",
  }), true);
  assert.equal(shouldAutoObserveTask({
    task,
    selectedTask: { ...task, threadId: "thread-2" },
    snapshot: { active: true },
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
