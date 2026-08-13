import assert from "node:assert/strict";
import test from "node:test";
import {
  createDesktopSnapshotFactory,
  workspaceBindingForTask,
} from "../../../src/interfaces/desktop/desktop-snapshot.mjs";

function fixture(overrides = {}) {
  const selected = {
    provider: "codex",
    projectRoot: "D:/work",
    threadId: "thread-1",
    ...(overrides.selected ?? {}),
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
    responseItems: [{ id: "response-1", phase: "commentary" }],
    startedAt: "2026-07-30T10:00:00.000Z",
    lastMeaningfulProgressAt: "2026-07-30T10:01:00.000Z",
    activities: [{ id: 1 }, { id: 2 }],
    activityGroups: [{ id: "commentary-1", reasoning: "Ход работы", activities: [{ id: 1 }] }],
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
    sessionCwd: "D:/work/repository",
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
    catalogStale: false,
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
    maintenance: null,
    runForTask: null,
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
    maintenance: {
      entryFor: () => state.maintenance,
    },
    board: {
      snapshot: () => [{ id: "board-task-1", text: "Проверить дашборд" }],
      workspaces: () => state.workspaces
        ?? [{ id: "workspace-2", name: "Second" }, { id: "workspace-1", name: "First" }],
      layout: () => ({
        columnOrder: ["workspace:workspace-2", "notes", "workspace:workspace-1"],
        notesComment: "Кино",
      }),
    },
    runs: {
      forTask: (task) => state.runForTask?.(task)
        ?? (task.threadId === "thread-1" ? state.run : null),
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
      stale: () => state.catalogStale,
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
        activityRecentMinutes: 180,
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
    percent: null,
    turnId: null,
    updatedAt: null,
    compacting: true,
    compaction: { id: "compact-1", status: "running" },
    usagePending: true,
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

test("desktop snapshot exposes Task board state", async () => {
  const { desktopSnapshot } = fixture();
  const snapshot = await desktopSnapshot();
  assert.deepEqual(snapshot.boardTasks, [{ id: "board-task-1", text: "Проверить дашборд" }]);
  assert.deepEqual(snapshot.workspaces.map((workspace) => workspace.id), ["workspace-2", "workspace-1"]);
  assert.deepEqual(snapshot.boardLayout, {
    columnOrder: ["workspace:workspace-2", "notes", "workspace:workspace-1"],
    notesComment: "Кино",
  });
});

test("desktop task snapshot exposes a persisted model without a live run", () => {
  const { desktopTaskSnapshot, entry } = fixture({ run: null });
  assert.equal(desktopTaskSnapshot({ ...entry, model: "Sol" }).model, "Sol");
});

test("desktop task snapshot exposes active Stream maintenance", () => {
  const { desktopTaskSnapshot, entry, state } = fixture({ run: null });
  state.maintenance = {
    reason: "manual-rotation",
    startedAt: "2026-08-08T10:00:00.000Z",
  };
  assert.deepEqual(desktopTaskSnapshot(entry).maintenance, state.maintenance);
});

test("desktop task snapshot hides an internal context probe run", () => {
  const { desktopTaskSnapshot, entry, state } = fixture();
  state.run.clientUserMessageId = "agent-hub-context-probe:probe-1";
  state.run.promptPreview = "Ответь строго: AGENT_HUB_CONTEXT_PROBE_OK_V1";
  state.run.userMessages = [{
    clientUserMessageId: state.run.clientUserMessageId,
    text: state.run.promptPreview,
  }];

  const snapshot = desktopTaskSnapshot(entry);

  assert.equal(snapshot.run, null);
  assert.equal(snapshot.running, false);
});

test("desktop task snapshot rejects a retained run from the pre-rotation Thread", () => {
  const { desktopTaskSnapshot, entry, state } = fixture();
  state.run.threadId = "thread-before-rotation";
  state.run.responseText = "Старый финальный ответ";
  state.runForTask = () => state.run;

  const snapshot = desktopTaskSnapshot(entry);

  assert.equal(snapshot.run, null);
});

test("desktop task snapshot hides a standalone automatic compaction observer", () => {
  const { desktopTaskSnapshot, entry, state } = fixture();
  state.compaction = {
    id: "compact-1",
    origin: "automatic",
    status: "completed",
    turnId: state.run.turnId,
  };
  state.run.promptPreview = "";
  state.run.userMessages = [];
  state.run.responseText = "";

  const snapshot = desktopTaskSnapshot(entry);

  assert.equal(snapshot.run, null);
  assert.equal(snapshot.running, false);
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
      deliveredAt: "2026-07-30T10:02:00.000Z",
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
    deliveredAt: "2026-07-30T10:02:00.000Z",
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
    responsePhase: "commentary",
    clientUserMessageId: "client-1",
    responseItemId: "response-1",
    startedAt: "2026-07-30T10:00:00.000Z",
    lastActivityAt: "2026-07-30T10:01:00.000Z",
    activities: [{ id: 1 }, { id: 2 }],
    activityGroups: [{ id: "commentary-1", reasoning: "Ход работы", activities: [{ id: 1 }] }],
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
    "sessionCwd",
    "projectName",
    "threadId",
    "title",
    "displayTitle",
    "threadTitle",
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
    "maintenance",
    "context",
    "run",
  ]);
  assert.equal(snapshot.projectName, "Проект");
  assert.equal(snapshot.sessionCwd, "D:/work/repository");
  assert.equal(snapshot.streamId, "stream-1");
  assert.equal(snapshot.workspaceName, "Agent HUB");
  assert.equal(snapshot.title, "Agent HUB - Stream 1");
  assert.equal(snapshot.threadTitle, "Задача");
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

test("desktop snapshot binds a transient selected task to its canonical Workspace", async () => {
  const workspaces = [{
    id: "workspace-1",
    name: "AgentHub",
    kind: "user",
    streams: [{
      id: "stream-33",
      name: "Диалоги",
      displayName: "Stream 33",
      ordinal: 33,
      threads: [{ provider: "codex", threadId: "thread-1", position: 2 }],
    }],
  }];
  assert.deepEqual(
    workspaceBindingForTask({ provider: "codex", threadId: "thread-1", streamId: "stream-33" }, workspaces),
    {
      workspaceId: "workspace-1",
      workspaceName: "AgentHub",
      workspaceKind: "user",
      streamId: "stream-33",
      streamName: "Диалоги",
      streamDisplayName: "Stream 33",
      streamOrdinal: 33,
      threadPosition: 2,
    },
  );

  const { desktopSnapshot } = fixture({
    entries: [],
    run: null,
    selected: { streamId: "stream-33" },
    workspaces,
  });
  const snapshot = await desktopSnapshot();
  assert.equal(snapshot.tasks.length, 1);
  assert.equal(snapshot.tasks[0].workspaceId, "workspace-1");
  assert.equal(snapshot.tasks[0].workspaceName, "AgentHub");
  assert.equal(snapshot.tasks[0].streamOrdinal, 33);
  assert.equal(snapshot.tasks[0].startedAt, null);
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
    title: "Agent HUB - Stream 1",
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
    activityRecentMinutes: 180,
    models: [{ value: "gpt-test", label: "GPT Test" }],
    modelOptionsByProvider: {
      codex: [{ value: "gpt-test", label: "GPT Test" }],
      claude: [{ value: "opus", label: "Opus (latest)" }],
    },
    reasoningOptions: [
      { value: "medium", label: "Medium" },
      { value: "high", label: "High" },
    ],
    reasoningOptionsByProvider: {
      codex: [
        { value: "medium", label: "Medium" },
        { value: "high", label: "High" },
      ],
      claude: [
        { value: "medium", label: "Medium" },
        { value: "high", label: "High" },
      ],
    },
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
      taskTitle: "Agent HUB - Stream 1",
      clientUserMessageId: "client-2",
      text: "Ожидает",
      annotations: [],
      preview: "Ожидает",
      allowForce: true,
      conflictKind: "active-run",
      lastError: null,
      attempts: 0,
      createdAt: "2026-07-30T08:00:00.000Z",
      attachments: [],
    },
    {
      id: "queued-1",
      state: "queued",
      provider: "codex",
      threadId: "thread-1",
      taskTitle: "Agent HUB - Stream 1",
      clientUserMessageId: null,
      text: "В очереди",
      annotations: [],
      preview: "В очереди",
      allowForce: false,
      conflictKind: null,
      lastError: null,
      attempts: 0,
      queueOrder: null,
      createdAt: "2026-07-30T08:01:00.000Z",
      attachments: [],
    },
    {
      id: "dispatching-1",
      state: "dispatching",
      provider: "codex",
      threadId: "thread-1",
      taskTitle: "Agent HUB - Stream 1",
      clientUserMessageId: null,
      text: "Уже отправляется",
      annotations: [],
      preview: "Уже отправляется",
      allowForce: false,
      conflictKind: null,
      lastError: null,
      attempts: 0,
      queueOrder: null,
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

test("desktopSnapshot exposes an inter-Stream queue message without its service envelope", async () => {
  const input = [
    "<agent-hub-stream-message>",
    JSON.stringify({
      workspaceId: "workspace-1",
      workspaceName: "Agent HUB",
      streamId: "stream-architect",
      streamName: "Architect",
      provider: "codex",
    }),
    "</agent-hub-stream-message>",
    "Finish the theme.",
  ].join("\n");
  const { desktopSnapshot } = fixture({
    queued: [{
      id: "interstream-1",
      provider: "codex",
      threadId: "thread-1",
      taskTitle: "Themes",
      input,
    }],
  });
  const snapshot = await desktopSnapshot();
  assert.equal(snapshot.deferredInputs[0].text, "Finish the theme.");
  assert.equal(snapshot.deferredInputs[0].preview, "Finish the theme.");
  assert.equal(snapshot.deferredInputs[0].author, "Agent HUB - Architect (Codex)");
});

test("desktopRunSnapshot attributes a live inter-Stream message to its source agent", () => {
  const { desktopRunSnapshot, run } = fixture();
  const input = [
    "<agent-hub-stream-message>",
    JSON.stringify({
      workspaceId: "workspace-1",
      workspaceName: "Agent HUB",
      streamId: "stream-architect",
      streamName: "Architect",
      provider: "codex",
    }),
    "</agent-hub-stream-message>",
    "MCP smoke test.",
  ].join("\n");
  run.promptPreview = input;
  run.userMessages[0].text = input;

  const snapshot = desktopRunSnapshot(run);

  assert.equal(snapshot.prompt, "MCP smoke test.");
  assert.equal(snapshot.promptAuthor, "Agent HUB - Architect (Codex)");
  assert.equal(snapshot.userMessages[0].author, "Agent HUB - Architect (Codex)");
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

test("compact remote snapshot keeps one bounded live activity representation", async () => {
  const activities = Array.from({ length: 50 }, (_, index) => ({
    id: `activity-${index}`,
    type: "command",
    label: "Команда выполнена",
    detail: "x".repeat(4_500),
  }));
  const { desktopSnapshot, state } = fixture();
  state.run.activities = structuredClone(activities);
  state.run.activityGroups = [{ id: "group-1", reasoning: "Проверяю", activities }];

  const snapshot = await desktopSnapshot({ compactSnapshot: true });

  assert.deepEqual(snapshot.tasks[0].run.activities, []);
  assert.equal(snapshot.tasks[0].run.activityGroups[0].activities.length, 50);
  assert.equal(snapshot.tasks[0].run.activityGroups[0].activities[0].detail.length, 1_201);
  assert.ok(Buffer.byteLength(JSON.stringify(snapshot), "utf8") < 100_000);
});

test("live snapshot hides the Codex Desktop file envelope", async () => {
  const { desktopSnapshot, state } = fixture();
  const prompt = [
    "# FILES MENTIONED BY THE USER:",
    "",
    "## Вставленный текст.txt: C:/AgentHub/attachments/message.txt",
    "",
    "## My request for Codex:",
    "Проверь содержимое файла",
  ].join("\n");
  state.run.promptPreview = prompt;
  state.run.userMessages[0].text = prompt;

  const snapshot = await desktopSnapshot({ compactSnapshot: true });

  assert.equal(snapshot.tasks[0].run.prompt, "Проверь содержимое файла");
  assert.equal(snapshot.tasks[0].run.userMessages[0].text, "Проверь содержимое файла");
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

test("desktop snapshot refreshes a stale catalog without bypassing its cache policy", async () => {
  const { desktopSnapshot, state } = fixture({ catalogStale: true });

  await desktopSnapshot();

  assert.deepEqual(state.refreshCalls, [{ force: false }]);
});
