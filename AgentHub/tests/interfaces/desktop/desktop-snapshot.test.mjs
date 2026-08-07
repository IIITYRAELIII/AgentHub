import assert from "node:assert/strict";
import test from "node:test";
import { createDesktopSnapshotFactory } from "../../../src/interfaces/desktop/desktop-snapshot.mjs";

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
    streamId: "stream-1",
    workspaceId: "workspace-1",
    workspaceName: "Agent HUB",
    workspaceKind: "user",
    streamId: "stream-1",
    streamName: null,
    streamDisplayName: "",
    streamOrdinal: 1,
    threadPosition: 1,
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
    compaction: { id: "compact-1", status: "running" },
    run,
    lastMessage: {
      text: "Последний ответ",
      updatedAt: "2026-07-30T09:59:00.000Z",
      turnId: "turn-previous",
    },
    pending: [],
    queued: [],
    receipts: [],
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
      isCompacting: (threadId) => threadId === "thread-1" && state.compaction?.status === "running",
      compactionFor: (threadId) => (
        threadId === "thread-1" ? state.compaction : undefined
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
    receipts: {
      recent: () => state.receipts,
    },
    approvals: {
      snapshot: () => [{ id: "approval-1" }],
    },
    restart: {
      request: () => state.restartRequest,
      blockingRuns: () => [{ id: "blocking-1" }],
      compactionCount: () => 1,
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
    server: {
      snapshot: async ({ activeCount, restart }) => ({
        process: { status: "running", activeCount },
        restart,
      }),
    },
    readState: {
      hasUnread: (value) => value.accountId === "owner" && value.answerTurnId !== "turn-previous",
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
    usagePending: false,
  });
  state.usage = null;
  assert.deepEqual(desktopContextSnapshot("thread-1"), {
    usedTokens: 0,
    modelContextWindow: 0,
    percent: 0,
    turnId: null,
    updatedAt: null,
    compacting: true,
    compaction: { id: "compact-1", status: "running" },
    usagePending: false,
  });
  state.compaction = null;
  assert.equal(desktopContextSnapshot("thread-1"), null);
});

test("desktop task snapshot carries server-side unread state for the account", () => {
  const { desktopTaskSnapshot, entry, state } = fixture({ run: null });
  assert.equal(desktopTaskSnapshot(entry, { accountId: "owner" }).unread, false);
  state.lastMessage = {
    ...state.lastMessage,
    turnId: "turn-new",
  };
  assert.equal(desktopTaskSnapshot(entry, { accountId: "owner" }).unread, true);
  assert.equal(desktopTaskSnapshot(entry, { accountId: "other" }).unread, false);
});

test("desktop task snapshot exposes a persisted model without a live run", () => {
  const { desktopTaskSnapshot, entry } = fixture({ run: null });
  assert.equal(desktopTaskSnapshot({ ...entry, model: "Sol" }).model, "Sol");
});

test("desktop snapshot exposes bounded delivery receipts for client reconciliation", async () => {
  const { desktopSnapshot, state } = fixture();
  state.receipts = [{
    provider: "codex",
    threadId: "thread-1",
    clientUserMessageId: "client-lost-result",
    createdAt: "2026-07-30T10:01:30.000Z",
    fingerprint: "private-fingerprint",
    result: {
      accepted: true,
      runId: "run-2",
      turnId: "turn-2",
      secretInternalField: "must-not-leak",
    },
  }];
  const snapshot = await desktopSnapshot();
  assert.deepEqual(snapshot.messageReceipts, [{
    provider: "codex",
    threadId: "thread-1",
    clientUserMessageId: "client-lost-result",
    createdAt: "2026-07-30T10:01:30.000Z",
    accepted: true,
    deferred: false,
    queued: false,
    dispatching: false,
    steered: false,
    cancelled: false,
    id: null,
    runId: "run-2",
    turnId: "turn-2",
    message: null,
    attachments: [],
  }]);
});

test("desktopContextSnapshot marks a completed compaction until fresh usage arrives", () => {
  const { desktopContextSnapshot, state } = fixture();
  state.compaction = {
    id: "compact-2",
    status: "completed",
    startedAt: "2026-07-30T10:01:30.000Z",
    completedAt: "2026-07-30T10:01:31.000Z",
  };
  assert.equal(desktopContextSnapshot("thread-1").usagePending, true);
  state.usage.updatedAt = "2026-07-30T10:01:32.000Z";
  assert.equal(desktopContextSnapshot("thread-1").usagePending, false);
  state.usage.provisional = true;
  assert.equal(desktopContextSnapshot("thread-1").usagePending, true);
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
      usagePending: false,
    },
  });
  assert.equal(desktopRunSnapshot(null), null);
});

test("desktopTaskSnapshot preserves task fields and run precedence", () => {
  const { desktopTaskSnapshot, entry } = fixture();
  const snapshot = desktopTaskSnapshot(entry);
  assert.deepEqual(Object.keys(snapshot), [
    "workspaceId",
    "workspaceName",
    "workspaceKind",
    "streamId",
    "streamName",
    "streamDisplayName",
    "streamOrdinal",
    "threadPosition",
    "provider",
    "projectRoot",
    "projectName",
    "threadId",
    "title",
    "model",
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
    "lastAnswerTurnId",
    "unread",
    "context",
    "run",
  ]);
  assert.equal(snapshot.projectName, "Проект");
  assert.equal(snapshot.streamId, "stream-1");
  assert.equal(snapshot.workspaceName, "Agent HUB");
  assert.equal(snapshot.model, "gpt-test");
  assert.equal(snapshot.selected, true);
  assert.equal(snapshot.running, true);
  assert.equal(snapshot.executionOwner, "hub");
  assert.equal(snapshot.runtime, "Agent Hub Server");
  assert.equal(snapshot.startedAt, "2026-07-30T10:00:00.000Z");
  assert.equal(snapshot.updatedAtMs, Date.parse("2026-07-30T10:01:00.000Z"));
  assert.equal(snapshot.orderingActivityAtMs, 300);
  assert.equal(snapshot.lastAnswer, "Последний ответ");
  assert.equal(snapshot.lastAnswerTurnId, "turn-previous");
  assert.equal(snapshot.run.id, "run-1");
});

test("desktopTaskSnapshot exposes catalog start time without an observer run", () => {
  const { desktopTaskSnapshot, entry } = fixture({ run: null });
  assert.equal(desktopTaskSnapshot(entry).startedAt, "2026-07-30T09:55:00.000Z");
});

test("desktopTaskSnapshot does not expose a retained completed run as active", () => {
  const { desktopTaskSnapshot, entry, state } = fixture();
  state.run.status = "completed";
  entry.running = false;

  const snapshot = desktopTaskSnapshot(entry);

  assert.equal(snapshot.running, false);
  assert.equal(snapshot.run.status, "completed");
});

test("an inactive catalog entry without a run stays inactive", () => {
  const { desktopTaskSnapshot, entry } = fixture({ run: null });
  const snapshot = desktopTaskSnapshot({
    ...entry,
    running: false,
    executionOwner: null,
  });
  assert.equal(snapshot.running, false);
  assert.equal(snapshot.run, null);
});

test("desktopTaskSnapshot keeps a manual context compaction out of the live turn", () => {
  const { desktopTaskSnapshot, entry, state } = fixture();
  state.compaction = {
    id: "manual-compact-1",
    origin: "manual",
    status: "running",
    turnId: "turn-1",
    startedAt: "2026-07-30T10:01:30.000Z",
  };

  const snapshot = desktopTaskSnapshot(entry);

  assert.equal(snapshot.running, false);
  assert.equal(snapshot.run, null);
  assert.equal(snapshot.context.compaction.origin, "manual");
  assert.equal(snapshot.context.compacting, true);
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
  assert.equal(snapshot.apiVersion, 3);
  assert.equal(snapshot.generatedAt, "2026-07-30T10:02:00.000Z");
  assert.deepEqual(snapshot.selected, {
    provider: "codex",
    projectRoot: "D:/work",
    threadId: "thread-1",
    streamId: "stream-1",
    workspaceId: "workspace-1",
    workspaceName: "Agent HUB",
    streamId: "stream-1",
    streamName: null,
    streamDisplayName: "",
    streamOrdinal: 1,
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
    includeClaudeUsage: true,
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
      text: "Ожидает",
      annotations: [],
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
      text: "В очереди",
      annotations: [],
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
      text: "Уже отправляется",
      annotations: [],
      preview: "Уже отправляется",
      allowForce: false,
      conflictKind: null,
      createdAt: "2026-07-30T08:02:00.000Z",
      attachments: [],
    },
  ]);
  assert.equal(snapshot.restartPending, true);
  assert.equal(snapshot.restartWaiting, true);
  // Context-image cleanup is opportunistic and must never deadlock a server
  // restart: stopping the App Server releases the rollout for the next pass.
  assert.equal(snapshot.restartBlockingCount, 6);
  assert.deepEqual(snapshot.exchangeRates, {
    usdRub: 78.4049,
    effectiveDate: "2026-07-30",
    source: "cbr",
  });
  assert.equal(snapshot.activeCount, 1);
  assert.deepEqual(snapshot.server, {
    process: { status: "running", activeCount: 1 },
    restart: { pending: true, waiting: true, blockingCount: 6 },
  });
  assert.equal(snapshot.tasks.length, 1);
});

test("desktopSnapshot exposes an in-flight steer as sending rather than a new decision", async () => {
  const { desktopSnapshot } = fixture({
    pending: [{
      id: "steering-1",
      provider: "codex",
      threadId: "thread-1",
      taskTitle: "Задача",
      input: "Уточнение",
      manualAction: "steer",
    }],
  });
  const snapshot = await desktopSnapshot();
  assert.equal(snapshot.deferredInputs[0].state, "steering");
});

test("desktopSnapshot returns a compact marker for an unchanged version", async () => {
  const { desktopSnapshot } = fixture();
  const snapshot = await desktopSnapshot();
  assert.match(snapshot.version, /^[A-Za-z0-9_-]{22}$/u);
  assert.deepEqual(await desktopSnapshot({ knownVersion: snapshot.version }), {
    notModified: true,
    version: snapshot.version,
  });
});

test("compact remote snapshot omits answer text when the turn id is sufficient", async () => {
  const { desktopSnapshot } = fixture();
  const snapshot = await desktopSnapshot({ compactSnapshot: true });
  assert.equal(snapshot.tasks[0].lastAnswer, "");
  assert.equal(snapshot.tasks[0].lastAnswerTurnId, "turn-previous");
});

test("forced desktop snapshot returns cached tasks while catalog refreshes", async () => {
  let finishRefresh;
  const refreshWait = new Promise((resolve) => {
    finishRefresh = resolve;
  });
  const { desktopSnapshot, state } = fixture();
  state.refreshCalls = [];
  const originalPush = state.refreshCalls.push.bind(state.refreshCalls);
  state.refreshCalls.push = (...items) => {
    originalPush(...items);
    return refreshWait;
  };

  const snapshot = await Promise.race([
    desktopSnapshot({ refresh: true }),
    new Promise((_, reject) => setTimeout(() => reject(new Error("snapshot waited for catalog refresh")), 100)),
  ]);
  assert.equal(snapshot.tasks.length, 1);
  assert.equal(state.refreshCalls.length, 1);
  assert.deepEqual(state.refreshCalls[0], { force: true });
  finishRefresh();
});
