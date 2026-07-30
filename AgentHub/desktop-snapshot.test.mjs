import assert from "node:assert/strict";
import test from "node:test";
import { createDesktopSnapshotFactory } from "./desktop-snapshot.mjs";

function fixture(overrides = {}) {
  const selected = {
    provider: "codex",
    projectRoot: "D:/work",
    threadId: "thread-1",
  };
  const run = {
    id: "run-1",
    turnId: "turn-1",
    provider: "codex",
    projectRoot: "D:/work",
    threadId: "thread-1",
    status: "running",
    observer: true,
    executionOwner: "hub",
    appServer: "Agent Hub Server",
    model: "gpt-test",
    reasoning: "high",
    progressStage: "Проверяю",
    promptPreview: "Вопрос",
    userMessages: [{
      itemId: "user-1",
      clientUserMessageId: "client-1",
      role: "user",
      text: "Вопрос",
    }],
    progressReasoning: "Ход работы",
    responseText: "Ответ",
    clientUserMessageId: "client-1",
    responseItemId: "response-1",
    startedAt: "2026-07-30T10:00:00.000Z",
    lastMeaningfulProgressAt: "2026-07-30T10:01:00.000Z",
    activities: [{ id: 1 }, { id: 2 }],
  };
  const entry = {
    ...selected,
    title: "Задача",
    running: true,
    activityUnknown: false,
    executionOwner: "vscode",
    startedAt: "2026-07-30T09:55:00.000Z",
    lastActivityAtMs: 100,
    updatedAtMs: 200,
  };
  const state = {
    entries: [entry],
    refreshedAt: 5_000,
    refreshCalls: [],
    usage: {
      usedTokens: 250,
      modelContextWindow: 1_000,
      turnId: "turn-1",
      updatedAt: "2026-07-30T10:01:00.000Z",
    },
    run,
    lastMessage: {
      text: "Последний ответ",
      updatedAt: "2026-07-30T09:59:00.000Z",
    },
    pending: [],
    queued: [],
    restartRequest: null,
    ...overrides,
  };
  const factory = createDesktopSnapshotFactory({
    clock: {
      nowMs: () => 7_000,
      nowIso: () => "2026-07-30T10:02:00.000Z",
    },
    context: {
      latestUsage: () => state.usage,
      isCompacting: (threadId) => threadId === "thread-1",
      compactionFor: (threadId) => (
        threadId === "thread-1" ? { id: "compact-1", status: "running" } : undefined
      ),
    },
    runs: {
      forTask: (task) => (task.threadId === "thread-1" ? state.run : null),
      titleFor: (item) => item.taskTitle ?? "Задача",
    },
    tasks: {
      savedLastMessage: () => state.lastMessage,
      projectNameFor: () => "Проект",
      entryIsSelected: (left, right) => (
        left.provider === right.provider
        && left.projectRoot === right.projectRoot
        && left.threadId === right.threadId
      ),
      executionRuntimeLabel: (owner) => `runtime:${owner}`,
      orderingActivityAtMs: (_item, { run: activeRun }) => (
        activeRun ? 300 : 200
      ),
      samePath: (left, right) => left.toLowerCase() === right.toLowerCase(),
    },
    catalog: {
      entries: () => state.entries,
      refreshedAt: () => state.refreshedAt,
      refresh: async (options) => state.refreshCalls.push(options),
      merge: (current, added) => [...current, ...added],
    },
    selection: {
      selectedTask: () => selected,
      hasThread: () => true,
      selectedTurnTarget: () => selected,
      activeProject: () => ({ name: "Проект" }),
      activeThreadTitle: () => "Задача",
    },
    settings: {
      current: () => ({
        activeProvider: "codex",
        activeProjectRoot: "D:/work",
        codexModel: "gpt-test",
        claudeModel: "opus",
        codexReasoningEffort: "high",
        claudeReasoningEffort: "medium",
        codexCollaborationMode: "default",
        claudeCollaborationMode: "plan",
        autoApprove: true,
        codexModels: [{ value: "gpt-test", label: "GPT Test" }],
        codexModelLabel: () => "GPT Test",
        claudeModels: ["opus"],
        claudeModelLabels: { opus: "Opus" },
        reasoningEfforts: ["medium", "high"],
        reasoningLabels: { medium: "Medium", high: "High" },
        collaborationModes: ["default", "plan"],
        collaborationModeLabels: { default: "Default", plan: "Plan" },
        projects: [{ name: "Проект", path: "d:/WORK" }],
      }),
    },
    deferred: {
      pendingValues: () => state.pending,
      queuedValues: () => state.queued,
      inputPreview: (input) => String(input),
    },
    approvals: {
      snapshot: () => [{ id: "approval-1" }],
    },
    restart: {
      request: () => state.restartRequest,
      blockingRuns: () => [{ id: "blocking-1" }],
      mediaJobCount: () => 2,
      speechJobCount: () => 3,
    },
    exchangeRates: {
      snapshot: () => ({
        usdRub: 78.4049,
        effectiveDate: "2026-07-30",
        source: "cbr",
      }),
    },
    warn: () => {},
  });
  return { ...factory, state, selected, run, entry };
}

test("desktopContextSnapshot preserves the context JSON contract", () => {
  const { desktopContextSnapshot, state } = fixture();
  assert.deepEqual(desktopContextSnapshot("thread-1", "turn-1"), {
    usedTokens: 250,
    modelContextWindow: 1_000,
    percent: 25,
    turnId: "turn-1",
    updatedAt: "2026-07-30T10:01:00.000Z",
    compacting: true,
    compaction: { id: "compact-1", status: "running" },
  });
  state.usage = null;
  assert.equal(desktopContextSnapshot("thread-1"), null);
});

test("desktopRunSnapshot preserves run fields and nested context", () => {
  const { desktopRunSnapshot, run } = fixture();
  assert.deepEqual(desktopRunSnapshot(run), {
    id: "run-1",
    turnId: "turn-1",
    provider: "codex",
    threadId: "thread-1",
    taskTitle: "Задача",
    status: "running",
    observer: true,
    executionOwner: "hub",
    runtime: "Agent Hub Server",
    model: "gpt-test",
    reasoning: "high",
    stage: "Проверяю",
    prompt: "Вопрос",
    attachments: [],
    userMessages: [{
      itemId: "user-1",
      clientUserMessageId: "client-1",
      role: "user",
      text: "Вопрос",
      time: "2026-07-30T10:00:00.000Z",
      attachments: [],
    }],
    progress: "Ход работы",
    response: "Ответ",
    clientUserMessageId: "client-1",
    responseItemId: "response-1",
    startedAt: "2026-07-30T10:00:00.000Z",
    lastActivityAt: "2026-07-30T10:01:00.000Z",
    activities: [{ id: 1 }, { id: 2 }],
    context: {
      usedTokens: 250,
      modelContextWindow: 1_000,
      percent: 25,
      turnId: "turn-1",
      updatedAt: "2026-07-30T10:01:00.000Z",
      compacting: true,
      compaction: { id: "compact-1", status: "running" },
    },
  });
  assert.equal(desktopRunSnapshot(null), null);
});

test("desktopTaskSnapshot preserves task fields and run precedence", () => {
  const { desktopTaskSnapshot, entry } = fixture();
  const snapshot = desktopTaskSnapshot(entry);
  assert.deepEqual(Object.keys(snapshot), [
    "provider",
    "projectRoot",
    "projectName",
    "threadId",
    "title",
    "selected",
    "running",
    "activityUnknown",
    "executionOwner",
    "runtime",
    "startedAt",
    "updatedAtMs",
    "orderingActivityAtMs",
    "lastAnswer",
    "lastAnswerAt",
    "context",
    "run",
  ]);
  assert.equal(snapshot.projectName, "Проект");
  assert.equal(snapshot.selected, true);
  assert.equal(snapshot.running, true);
  assert.equal(snapshot.executionOwner, "hub");
  assert.equal(snapshot.runtime, "Agent Hub Server");
  assert.equal(snapshot.startedAt, "2026-07-30T10:00:00.000Z");
  assert.equal(snapshot.updatedAtMs, Date.parse("2026-07-30T10:01:00.000Z"));
  assert.equal(snapshot.orderingActivityAtMs, 300);
  assert.equal(snapshot.lastAnswer, "Последний ответ");
  assert.equal(snapshot.run.id, "run-1");
});

test("desktopTaskSnapshot exposes catalog start time without an observer run", () => {
  const { desktopTaskSnapshot, entry } = fixture({ run: null });
  assert.equal(desktopTaskSnapshot(entry).startedAt, "2026-07-30T09:55:00.000Z");
});

test("desktopSnapshot preserves top-level settings, queues and restart state", async () => {
  const pending = [{
    id: "pending-1",
    provider: "codex",
    threadId: "thread-1",
    taskTitle: "Задача",
    clientUserMessageId: "client-2",
    input: "Ожидает",
    allowForce: true,
    conflictKind: "active-run",
    createdAt: "2026-07-30T08:00:00.000Z",
  }];
  const queued = [
    {
      id: "queued-1",
      provider: "codex",
      threadId: "thread-1",
      taskTitle: "Задача",
      input: "В очереди",
      createdAt: "2026-07-30T08:01:00.000Z",
    },
    {
      id: "dispatching-1",
      provider: "codex",
      threadId: "thread-1",
      taskTitle: "Задача",
      input: "Уже отправляется",
      createdAt: "2026-07-30T08:02:00.000Z",
      dispatchingAt: "2026-07-30T08:03:00.000Z",
    },
  ];
  const { desktopSnapshot, state } = fixture({
    pending,
    queued,
    restartRequest: { waitingForRuns: true },
  });

  const snapshot = await desktopSnapshot({ refresh: true });
  assert.deepEqual(state.refreshCalls, [{ force: true }]);
  assert.equal(snapshot.apiVersion, 2);
  assert.equal(snapshot.generatedAt, "2026-07-30T10:02:00.000Z");
  assert.deepEqual(snapshot.selected, {
    provider: "codex",
    projectRoot: "D:/work",
    threadId: "thread-1",
    title: "Задача",
    projectName: "Проект",
    model: "GPT Test",
    reasoning: "High",
    mode: "Default",
  });
  assert.deepEqual(snapshot.settings, {
    provider: "codex",
    model: "gpt-test",
    reasoning: "high",
    mode: "default",
    approvalMode: "auto",
    models: [{ value: "gpt-test", label: "GPT Test" }],
    reasoningOptions: [
      { value: "medium", label: "Medium" },
      { value: "high", label: "High" },
    ],
    modeOptions: [
      { value: "default", label: "Default" },
      { value: "plan", label: "Plan" },
    ],
    projects: [{ name: "Проект", path: "d:/WORK", selected: true }],
  });
  assert.deepEqual(snapshot.pendingApprovals, [{ id: "approval-1" }]);
  assert.deepEqual(snapshot.deferredInputs, [
    {
      id: "pending-1",
      state: "pending",
      provider: "codex",
      threadId: "thread-1",
      taskTitle: "Задача",
      clientUserMessageId: "client-2",
      preview: "Ожидает",
      allowForce: true,
      conflictKind: "active-run",
      createdAt: "2026-07-30T08:00:00.000Z",
      attachments: [],
    },
    {
      id: "queued-1",
      state: "queued",
      provider: "codex",
      threadId: "thread-1",
      taskTitle: "Задача",
      clientUserMessageId: null,
      preview: "В очереди",
      allowForce: false,
      conflictKind: null,
      createdAt: "2026-07-30T08:01:00.000Z",
      attachments: [],
    },
    {
      id: "dispatching-1",
      state: "dispatching",
      provider: "codex",
      threadId: "thread-1",
      taskTitle: "Задача",
      clientUserMessageId: null,
      preview: "Уже отправляется",
      allowForce: false,
      conflictKind: null,
      createdAt: "2026-07-30T08:02:00.000Z",
      attachments: [],
    },
  ]);
  assert.equal(snapshot.restartPending, true);
  assert.equal(snapshot.restartWaiting, true);
  assert.equal(snapshot.restartBlockingCount, 6);
  assert.deepEqual(snapshot.exchangeRates, {
    usdRub: 78.4049,
    effectiveDate: "2026-07-30",
    source: "cbr",
  });
  assert.equal(snapshot.activeCount, 1);
  assert.equal(snapshot.tasks.length, 1);
});

test("stale desktop snapshot returns cached tasks while catalog refreshes", async () => {
  let finishRefresh;
  const refreshWait = new Promise((resolve) => {
    finishRefresh = resolve;
  });
  const { desktopSnapshot, state } = fixture({
    refreshedAt: 0,
  });
  state.refreshCalls = [];
  const originalPush = state.refreshCalls.push.bind(state.refreshCalls);
  state.refreshCalls.push = (...items) => {
    originalPush(...items);
    return refreshWait;
  };

  const snapshot = await desktopSnapshot();
  assert.equal(snapshot.tasks.length, 1);
  assert.equal(state.refreshCalls.length, 1);
  assert.deepEqual(state.refreshCalls[0], { force: true });
  finishRefresh();
});
