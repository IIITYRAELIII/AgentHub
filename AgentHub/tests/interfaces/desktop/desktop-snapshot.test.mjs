import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MessageReceiptRegistry } from "../../../src/infrastructure/persistence/message-receipts.mjs";
import test from "node:test";
import { createRecentRestartFailure } from "../../../src/application/restart-failure-notice.mjs";
import { RESTART_FAILURE_NOTICE_WINDOW_MS } from "../../../src/domain/maintenance-operation.mjs";
import { MaintenanceOperationStore } from "../../../src/infrastructure/persistence/maintenance-operation-store.mjs";
import { createDesktopReadComposition } from "../../../src/composition/desktop-read-composition.mjs";
import { TaskBoardService } from "../../../src/application/task-board-service.mjs";
import { JournalDatabase } from "../../../src/infrastructure/persistence/journal-database.mjs";
import { TaskBoardStore } from "../../../src/infrastructure/persistence/task-board-store.mjs";
import { WorkspaceCatalogStore } from "../../../src/infrastructure/persistence/workspace-catalog-store.mjs";

test("exact receipt display follows queued and active messages without changing wire input", async () => {
  const receipts = new MessageReceiptRegistry();
  const identity = { provider: "codex", threadId: "thread-1", clientUserMessageId: "client-1" };
  const raw = "Ответ на вопрос агента [call-123]\nИсходный Thread: thread-1\n\nВопрос\nОтвет: Да";
  const displayText = "Вопрос\nОтвет: Да";
  receipts.reserve(identity, "fingerprint", { pending: true, displayText });
  const setup = fixture({ receiptForMessage: (key) => receipts.get(key) });
  setup.state.queued = [{ ...identity, id: "queue-1", input: raw }];
  setup.state.pending = [{ ...identity, id: "pending-1", input: raw }];
  let snapshot = await setup.desktopSnapshot();
  assert.deepEqual(snapshot.deferredInputs.map((item) => [item.text, item.preview]), [[displayText, displayText], [displayText, displayText]]);
  assert.equal(setup.state.queued[0].input, raw);
  setup.run.promptPreview = raw;
  setup.run.userMessages[0].text = raw;
  const live = setup.desktopRunSnapshot(setup.run);
  assert.equal(live.prompt, displayText);
  assert.equal(live.userMessages[0].text, displayText);
  assert.equal(setup.run.userMessages[0].text, raw);
  setup.run.threadId = "other-thread";
  setup.state.queued[0].threadId = "other-thread";
  setup.state.pending[0].clientUserMessageId = "different-id";
  snapshot = await setup.desktopSnapshot();
  assert.deepEqual(snapshot.deferredInputs.map((item) => item.text), [raw, raw]);
  assert.equal(setup.desktopRunSnapshot(setup.run).userMessages[0].text, raw);
});
import {
  createDesktopSnapshotFactory,
  workspaceBindingForTask,
} from "../../../src/interfaces/desktop/desktop-snapshot.mjs";
import { mergeTaskCatalog } from "../../../src/application/task-catalog-projection.mjs";
import { messageWithTaskReferences, taskReferenceDescriptor } from "../../../src/domain/task-board-task.mjs";
import { createInterstreamMessage, interstreamOriginAuthor } from "../../../src/domain/interstream-message.mjs";
import { restoreDeferredInput } from "../../../src/domain/deferred-input.mjs";
import {
  createMaintenanceOperation,
  MAINTENANCE_OPERATION_KINDS,
  MAINTENANCE_OPERATION_STATUSES,
} from "../../../src/domain/maintenance-operation.mjs";

function blockedRestartOperation(blockingCount = 6) {
  return createMaintenanceOperation({
    operationId: "restart-1",
    kind: MAINTENANCE_OPERATION_KINDS.RESTART,
    streamId: "stream-1",
    threadId: "thread-1",
    status: MAINTENANCE_OPERATION_STATUSES.BLOCKED,
    phase: "waiting-for-work",
    blockers: ["active-work"],
    metadata: { blockingCount },
    createdAt: "2026-07-30T10:01:00.000Z",
  });
}

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
    submittedAt: "2026-07-30T09:59:00.000Z",
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
    warnings: [],
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
    messagePins: [],
    revision: "initial",
    boardRevision: "board:1",
    snapshotBuilds: 0,
    boardSnapshotBuilds: 0,
    boardWorkspaceBuilds: 0,
    boardLayoutBuilds: 0,
    restartRequest: null,
    maintenance: null,
    telemetry: [],
    telemetryCalls: [],
    runForTask: null,
    refreshCatalog: null,
    ...overrides,
  };
  const factory = (overrides.createFactory ?? createDesktopSnapshotFactory)({
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
    telemetry: {
      recent: async (params) => {
        state.telemetryCalls.push(params);
        return state.telemetry;
      },
    },
    board: overrides.board ?? {
      get snapshotRevision() {
        return state.boardRevision;
      },
      snapshot: () => {
        state.boardSnapshotBuilds += 1;
        return state.boardTasks ?? [{ id: "board-task-1", text: "Проверить дашборд" }];
      },
      workspaces: () => {
        state.boardWorkspaceBuilds += 1;
        return state.workspaces
          ?? [{ id: "workspace-2", name: "Second" }, { id: "workspace-1", name: "First" }];
      },
      archivedWorkspaces: () => state.archivedWorkspaces ?? [],
      layout: () => {
        state.boardLayoutBuilds += 1;
        return {
          columnOrder: ["workspace:workspace-2", "notes", "workspace:workspace-1"],
          notesComment: "Кино",
        };
      },
    },
    runs: {
      forTask: (task) => {
        state.snapshotBuilds += 1;
        return state.runForTask?.(task)
          ?? (task.threadId === "thread-1" ? state.run : null);
      },
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
      refresh: async (options) => state.refreshCatalog?.(options) ?? state.refreshCalls.push(options),
      merge: mergeTaskCatalog,
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
        streamOrderMode: "manual",
        streamCardWidthMode: "fixed",
        streamCardFixedWidth: 237,
        streamCardGapEnabled: true,
        quickMessageActionMode: "send",
        quickMessages: {
          global: [{ label: "Пинг", text: "пинг" }],
          streams: { "stream-1": [{ label: "релизь", text: "релизь" }] },
          workspaces: {},
        },
        codexModels: [{ value: "gpt-test", label: "GPT Test" }],
        codexModelLabel: () => "GPT Test",
        claudeModels: ["opus"],
        claudeModelLabels: { opus: "Opus" },
        reasoningEfforts: ["medium", "high"],
        reasoningLabels: { medium: "Medium", high: "High" },
        collaborationModes: ["default", "plan"],
        collaborationModeLabels: { default: "Default", plan: "Plan" },
        projects: [{ name: "Проект", path: "d:/WORK" }],
        ...(overrides.currentSettings ?? {}),
      }),
    },
    deferred: {
      pendingValues: () => state.pending,
      queuedValues: () => state.queued,
      inputPreview: (input) => String(input),
    },
    receipts: {
      recent: () => state.receipts,
      forMessage: overrides.receiptForMessage ?? (() => null),
      forTurn: overrides.receiptsForTurn ?? (() => []),
    },
    pins: {
      snapshot: () => state.messagePins,
    },
    approvals: {
      snapshot: () => [{ id: "approval-1" }],
    },
    restart: {
      request: () => state.restartRequest,
      failure: () => overrides.restartFailure?.() ?? null,
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
    revision: overrides.revision
      ?? (() => (overrides.revisionFn ? overrides.revisionFn() : state.revision)),
    readState: {
      hasUnread: (value) => value.accountId === "owner" && value.answerTurnId !== "turn-previous",
    },
    monotonicNow: overrides.monotonicNow,
    warn: (...args) => state.warnings.push(args),
  }, state);
  return { ...factory, state, selected, run, entry };
}

test("composed protocol 4 snapshots carry exact read identity before delta versioning", async () => {
  const reads = [];
  let cursor = null;
  let cursorReads = 0;
  const setup = fixture({
    run: null,
    createFactory: (snapshot, state) => createDesktopReadComposition({
      snapshot,
      history: {},
      readModel: {
        readStateStore: {
          get: ({ accountId }) => { cursorReads += 1; return cursor?.accountId === accountId ? cursor : null; },
          markRead: (value) => {
            reads.push(value);
            cursor = { accountId: value.accountId, answerAtMs: Date.parse(value.answerAt), answerTurnId: value.answerTurnId,
              answerRevision: value.answerRevision };
            state.revision = `read-${reads.length}`;
            return cursor;
          },
        },
        trustedDeviceUserId: (context) => context?.userId ?? "owner",
        hasAllowedUsers: () => true,
        lastTaskMessage: (task) => task?.threadId === "thread-1" ? state.lastMessage : null,
      },
    }),
  });
  setup.entry.running = false;
  setup.state.lastMessage.terminalRevision = 2;
  const first = await setup.desktopSnapshot({ snapshotProtocol: 4, compactSnapshot: true });
  const [task] = first.collectionDeltas.conversations.reset;
  assert.equal(task.latestFinal?.revision, 2);
  assert.equal(task.latestFinal?.turnId, "turn-previous");
  assert.equal(task.unread, true);
  assert.equal(task.running, false);
  assert.equal(cursorReads, 1);
  const builds = setup.state.snapshotBuilds;
  const unchanged = await setup.desktopSnapshot({ snapshotProtocol: 4, compactSnapshot: true,
    knownVersion: first.version,
    ...Object.fromEntries(Object.entries(first.collectionDeltas).map(([name, delta]) => [`${name}Version`, delta.version])),
  });
  assert.equal(unchanged.notModified, true);
  assert.equal(unchanged.snapshotTiming.cacheHit, true);
  assert.equal(setup.state.snapshotBuilds, builds);
  assert.equal(cursorReads, 1);
  const legacy = await setup.desktopSnapshot({ snapshotProtocol: 3 });
  assert.deepEqual(task.latestFinal, legacy.tasks[0].latestFinal);
  assert.equal((await setup.markDesktopTaskRead({ final: { ...task.latestFinal, revision: 1 } })).marked, false);
  assert.equal((await setup.markDesktopTaskRead({ final: { ...task.latestFinal, threadId: "foreign" } })).marked, false);
  assert.equal(reads.length, 0);
  assert.equal((await setup.markDesktopTaskRead({ final: task.latestFinal })).marked, true);
  const read = await setup.desktopSnapshot({ snapshotProtocol: 4, compactSnapshot: true,
    conversationsVersion: first.collectionDeltas.conversations.version });
  assert.equal(read.collectionDeltas.conversations.upserts[0].unread, false);
  assert.notEqual(read.collectionDeltas.conversations.version, first.collectionDeltas.conversations.version);
  const fullRead = await setup.desktopSnapshot({ snapshotProtocol: 3 });
  assert.equal(fullRead.tasks[0].unread, false);
  assert.notEqual(fullRead.version, legacy.version);
  const otherAccount = await setup.desktopSnapshot({ snapshotProtocol: 4, compactSnapshot: true }, { userId: "other" });
  assert.equal(otherAccount.collectionDeltas.conversations.reset[0].unread, true);
  setup.state.lastMessage.terminalRevision = 3;
  setup.state.revision = "final-revision-3";
  const newer = await setup.desktopSnapshot({ snapshotProtocol: 4, compactSnapshot: true,
    conversationsVersion: read.collectionDeltas.conversations.version });
  assert.equal(newer.collectionDeltas.conversations.upserts[0].latestFinal.revision, 3);
  assert.equal(newer.collectionDeltas.conversations.upserts[0].unread, true);
  assert.equal((await setup.markDesktopTaskRead({ final: task.latestFinal })).marked, false);
  assert.equal(reads.length, 1);
});

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
    breakdown: {
      precision: "mixed",
      categories: [
        { id: "provider-remainder", label: "Системный контекст, инструменты и история", tokens: 250, count: 0, estimated: true },
        { id: "free", label: "Свободно", tokens: 750, count: 0, estimated: false },
      ],
      note: "Общий объём и свободное место сообщает Codex точно. Hub оценивает только известные ему инструкции и содержимое текущего хода; системный prompt, определения tools и предыдущая история остаются объединённым остатком.",
    },
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
    breakdown: {
      precision: "mixed",
      categories: [
        { id: "provider-remainder", label: "Системный контекст, инструменты и история", tokens: 0, count: 0, estimated: true },
        { id: "free", label: "Свободно", tokens: 0, count: 0, estimated: false },
      ],
      note: "Общий объём и свободное место сообщает Codex точно. Hub оценивает только известные ему инструкции и содержимое текущего хода; системный prompt, определения tools и предыдущая история остаются объединённым остатком.",
    },
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
  const { desktopSnapshot } = fixture({
    archivedWorkspaces: [{ id: "workspace-archived", name: "Archive", purgeAfterMs: 9_000 }],
  });
  const snapshot = await desktopSnapshot();
  assert.deepEqual(snapshot.boardTasks, [{ id: "board-task-1", text: "Проверить дашборд" }]);
  assert.deepEqual(snapshot.workspaces.map((workspace) => workspace.id), ["workspace-2", "workspace-1"]);
  assert.deepEqual(snapshot.archivedWorkspaces, [{
    id: "workspace-archived",
    name: "Archive",
    purgeAfterMs: 9_000,
  }]);
  assert.deepEqual(snapshot.boardLayout, {
    columnOrder: ["workspace:workspace-2", "notes", "workspace:workspace-1"],
    notesComment: "Кино",
  });
});

test("workspaceBindingForTask recovers a unique catalog Stream by provider Thread", () => {
  const workspaces = [{
    id: "workspace-1",
    name: "AgentHub",
    kind: "user",
    streams: [{
      id: "stream-1",
      name: "Диалоги",
      displayName: "Stream 1",
      ordinal: 2,
      threads: [{ provider: "codex", threadId: "thread-1", position: 3 }],
    }],
  }];
  assert.deepEqual(workspaceBindingForTask({ provider: "codex", threadId: "thread-1" }, workspaces), {
    workspaceId: "workspace-1",
    workspaceName: "AgentHub",
    workspaceKind: "user",
    streamId: "stream-1",
    streamName: "Диалоги",
    streamDisplayName: "Stream 1",
    streamOrdinal: 2,
    threadPosition: 3,
  });
  assert.deepEqual(workspaceBindingForTask({ provider: "codex", threadId: "thread-1" }, [
    ...workspaces,
    {
      id: "workspace-2",
      name: "Other",
      kind: "system",
      streams: [{
        id: "stream-2",
        name: "Stream 1",
        threads: [{ provider: "codex", threadId: "thread-1" }],
      }],
    },
  ]), {});
});

test("desktop task snapshot exposes a persisted model without a live run", () => {
  const { desktopTaskSnapshot, entry } = fixture({ run: null });
  assert.equal(desktopTaskSnapshot({ ...entry, model: "Sol" }).model, "Sol");
});

test("deprecated model remains selectable only in its currently selected Stream", async () => {
  const setup = fixture({ run: null, currentSettings: {
    codexModel: "gpt-5.5",
    codexModels: [{ value: "gpt-5.6-terra", label: "GPT-5.6 Terra" }],
    codexModelLabel: (model) => model,
  } });
  const selected = await setup.desktopSnapshot();
  assert.equal(selected.settings.model, "gpt-5.5");
  assert.deepEqual(selected.settings.models.map((model) => model.value), ["gpt-5.6-terra", "gpt-5.5"]);
  setup.state.entries = [];
  const unselected = await setup.desktopSnapshot();
  assert.deepEqual(unselected.settings.models.map((model) => model.value), ["gpt-5.6-terra"]);
});

test("a saved provider model remains visible in its Stream after catalog refresh", async () => {
  const setup = fixture({ run: null, currentSettings: {
    codexModel: "gpt-7-new",
    codexModels: [{ value: "gpt-6.1-sol", label: "GPT-6.1 Sol" }],
    codexModelLabel: (model) => model,
  } });
  const selected = await setup.desktopSnapshot();
  assert.deepEqual(selected.settings.models.map((model) => model.value), [
    "gpt-6.1-sol", "gpt-7-new",
  ]);
});

test("desktop task snapshot exposes active Stream maintenance", () => {
  const { desktopTaskSnapshot, entry, state } = fixture({ run: null });
  state.maintenance = {
    reason: "manual-rotation",
    startedAt: "2026-08-08T10:00:00.000Z",
  };
  assert.deepEqual(desktopTaskSnapshot(entry).maintenance, state.maintenance);
});

test("desktop task snapshot does not classify user activity by a legacy client prefix", () => {
  const { desktopTaskSnapshot, entry, state } = fixture();
  state.run.clientUserMessageId = "agent-hub-context-probe:probe-1";
  state.run.promptPreview = "Ответь строго: AGENT_HUB_CONTEXT_PROBE_OK_V1";
  state.run.userMessages = [{
    clientUserMessageId: state.run.clientUserMessageId,
    text: state.run.promptPreview,
  }];

  const snapshot = desktopTaskSnapshot(entry);

  assert.ok(snapshot.run);
  assert.equal(snapshot.running, true);
});

test("desktop task snapshot treats a saved final for the retained run as terminal", () => {
  const { desktopTaskSnapshot, entry, state } = fixture();
  state.lastMessage = {
    text: "Финальный ответ уже сохранён",
    updatedAt: "2026-07-30T10:01:30.000Z",
    turnId: state.run.turnId,
  };

  const snapshot = desktopTaskSnapshot(entry);

  assert.equal(snapshot.lastAnswer, "Финальный ответ уже сохранён");
  assert.equal(snapshot.lastAnswerTurnId, state.run.turnId);
  assert.equal(snapshot.running, false);
  assert.equal(snapshot.run, null);
});

test("desktop task snapshot rejects a retained run from the pre-rotation Thread", () => {
  const { desktopTaskSnapshot, entry, state } = fixture();
  state.run.threadId = "thread-before-rotation";
  state.run.responseText = "Старый финальный ответ";
  state.runForTask = () => state.run;
  entry.running = false;

  const snapshot = desktopTaskSnapshot(entry);

  assert.equal(snapshot.run, null);
});

test("desktop task snapshot synthesizes the active current binding while a pre-rotation run is retained", () => {
  const { desktopTaskSnapshot, entry, state } = fixture();
  state.run.threadId = "thread-before-rotation";
  state.run.turnId = "turn-before-rotation";
  state.run.responseText = "Старый промежуточный ответ";
  state.runForTask = () => state.run;
  Object.assign(entry, {
    threadId: "thread-after-rotation",
    running: true,
    turnId: "turn-after-rotation",
    executionOwner: "external",
    stage: "Ожидается ответ провайдера",
  });

  const snapshot = desktopTaskSnapshot(entry);

  assert.equal(snapshot.running, true);
  assert.equal(snapshot.run.threadId, "thread-after-rotation");
  assert.equal(snapshot.run.turnId, "turn-after-rotation");
  assert.equal(snapshot.run.status, "running");
  assert.equal(snapshot.run.operationKind, "user-turn");
  assert.equal(snapshot.run.observer, true);
  assert.equal(snapshot.run.executionOwner, "external");
  assert.equal(snapshot.run.stage, "Ожидается ответ провайдера");
  assert.equal(snapshot.run.response, "");
  assert.doesNotMatch(JSON.stringify(snapshot.run), /Старый промежуточный ответ/u);
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

test("desktop task snapshot keeps an ordinary Claude turn that compacted automatically", () => {
  const { desktopTaskSnapshot, entry, state } = fixture({
    selected: { provider: "claude" },
  });
  entry.provider = "claude";
  state.run.provider = "claude";
  state.compaction = {
    id: "claude-compact-1",
    provider: "claude",
    origin: "automatic",
    status: "completed",
    turnId: state.run.turnId,
    beforePercent: 68,
    afterPercent: 21,
  };

  const snapshot = desktopTaskSnapshot(entry);

  assert.equal(snapshot.running, true);
  assert.equal(snapshot.run.turnId, "turn-1");
  assert.equal(snapshot.run.operationKind, "user-turn");
  assert.equal(snapshot.run.prompt, "Вопрос");
  assert.equal(snapshot.run.response, "Ответ");
  assert.equal(snapshot.context.compaction.id, "claude-compact-1");
});

test("dedicated automatic compaction hides an exact observer with stale prior content only", () => {
  const { desktopTaskSnapshot, entry, state } = fixture();
  state.compaction = { id: "compact-dedicated", origin: "automatic", status: "running",
    turnId: state.run.turnId, dedicatedProviderTurn: true };
  // A resumed observer can retain nonempty prior prompt/answer during compact.
  state.run.responseText = "Старый ответ про Happ";
  assert.equal(desktopTaskSnapshot(entry).run, null);
  state.run.observer = false;
  assert.equal(desktopTaskSnapshot(entry).run.response, "Старый ответ про Happ");
  state.run.observer = true;
  state.compaction.turnId = "another-turn";
  assert.equal(desktopTaskSnapshot(entry).run.response, "Старый ответ про Happ");
  state.compaction.turnId = state.run.turnId;
  state.compaction.dedicatedProviderTurn = false;
  assert.equal(desktopTaskSnapshot(entry).run.response, "Старый ответ про Happ");
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
      streamId: "stream-1",
      runId: "run-2",
      turnId: "turn-2",
      clientProjectionIntent: "conversation",
      deliveredAt: "2026-07-30T10:02:00.000Z",
      secretInternalField: "must-not-leak",
    },
  }];
  const snapshot = await desktopSnapshot();
  assert.deepEqual(snapshot.messageReceipts, [{
    provider: "codex",
    threadId: "thread-1",
    clientUserMessageId: "client-lost-result",
    streamId: "stream-1",
    clientProjectionIntent: "conversation",
    createdAt: "2026-07-30T10:01:30.000Z",
    accepted: true,
    deferred: false,
    queued: false,
    dispatching: false,
    steered: false,
    cancelled: false,
    rejected: false,
    failed: false,
    completed: false,
    unknown: false,
    attentionRequired: false,
    paused: false,
    id: null,
    runId: "run-2",
    turnId: "turn-2",
    deliveredAt: "2026-07-30T10:02:00.000Z",
    message: null,
    displayText: "",
    responseAnnotations: [],
    responseAnnotationRequest: "",
    attachments: [],
  }]);
});

test("desktop snapshot exposes durable Stream message pins", async () => {
  const { desktopSnapshot, state } = fixture();
  state.messagePins = [{
    id: "pin-1",
    streamId: "stream-1",
    messageKey: "message:v1:answer",
    preview: "Точный ответ",
    available: true,
  }];
  const snapshot = await desktopSnapshot({ snapshotProtocol: 4 });
  assert.deepEqual(snapshot.collectionDeltas.messagePins.reset, state.messagePins);
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
      submittedAt: "2026-07-30T09:59:00.000Z",
      startedAt: "2026-07-30T10:00:00.000Z",
      time: "2026-07-30T09:59:00.000Z",
      attachments: [],
    }],
    progress: "Ход работы",
    response: "Ответ",
    responseAttachments: [],
    responsePhase: "commentary",
    clientUserMessageId: "client-1",
    submittedAt: "2026-07-30T09:59:00.000Z",
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
      breakdown: {
        precision: "mixed",
        categories: [
          { id: "provider-remainder", label: "Системный контекст, инструменты и история", tokens: 250, count: 0, estimated: true },
          { id: "free", label: "Свободно", tokens: 750, count: 0, estimated: false },
        ],
        note: "Общий объём и свободное место сообщает Codex точно. Hub оценивает только известные ему инструкции и содержимое текущего хода; системный prompt, определения tools и предыдущая история остаются объединённым остатком.",
      },
    },
  });
  assert.equal(desktopRunSnapshot(null), null);
});

test("desktopRunSnapshot exposes live response citation references", () => {
  const { desktopRunSnapshot, run } = fixture();
  run.responseAnnotationReferences = [{ index: 1 }];
  assert.deepEqual(desktopRunSnapshot(run).responseAnnotationReferences, [{ index: 1 }]);
});

test("desktopRunSnapshot exposes generated response attachments without aliasing the run", () => {
  const { desktopRunSnapshot, run } = fixture();
  run.responseAttachments = [{ id: "generated-one.png", type: "image/png" }];
  const snapshot = desktopRunSnapshot(run);
  assert.deepEqual(snapshot.responseAttachments, run.responseAttachments);
  assert.notEqual(snapshot.responseAttachments[0], run.responseAttachments[0]);
});

test("desktopRunSnapshot gives a steer its exact intake time without borrowing root time", () => {
  let receipt = { createdAt: "2026-07-30T10:15:00.000Z", result: {} };
  const { desktopRunSnapshot, run } = fixture({
    receiptForMessage: ({ clientUserMessageId }) => clientUserMessageId === "client-steer" ? receipt : null,
  });
  run.userMessages.push({
    role: "user", clientUserMessageId: "client-steer", text: "Later clarification",
    time: "2026-07-30T10:15:02.000Z",
  });
  const check = (expected) => {
    const steer = desktopRunSnapshot(run).userMessages[1];
    assert.equal(steer.time, expected);
    assert.equal(steer.submittedAt, expected);
  };
  check(receipt.createdAt);
  delete run.userMessages[1].time;
  check(receipt.createdAt);
  receipt = null;
  check(null);
});

test("desktopRunSnapshot leaves a sparse provider steer unbound from a remaining receipt", () => {
  const receipts = [{
    clientUserMessageId: "client-root",
    createdAt: "2026-07-30T10:00:00.000Z",
    result: { attachments: [] },
  }, {
    clientUserMessageId: "client-steer",
    createdAt: "2026-07-30T10:01:00.000Z",
    result: {
      attachments: [{ id: "screen.png", type: "image/png" }],
      responseAnnotations: [{ text: "Цитата", annotation: "Проверь" }],
      responseAnnotationRequest: [
        "Уточнение со скрином",
        '<image name=[Image #1] path="C:/AgentHub/attachments/screen.png">',
        "</image>",
      ].join("\n"),
    },
  }];
  const { desktopRunSnapshot, run } = fixture({
    receiptForMessage: ({ clientUserMessageId }) => (
      receipts.find((receipt) => receipt.clientUserMessageId === clientUserMessageId) ?? null
    ),
    receiptsForTurn: () => receipts,
  });
  run.clientUserMessageId = "client-root";
  run.userMessages = [{
    itemId: "provider-root",
    clientUserMessageId: "client-root",
    role: "user",
    text: "Корневой запрос",
  }, {
    itemId: "provider-steer",
    role: "user",
    text: "Уточнение со скрином",
  }];

  const snapshot = desktopRunSnapshot(run);
  assert.equal(snapshot.userMessages[1].clientUserMessageId, "");
  assert.equal(snapshot.userMessages[1].responseAnnotationRequest, undefined);
  assert.deepEqual(snapshot.userMessages[1].attachments, []);
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
  assert.equal(snapshot.run.operationKind, "user-turn");
});

test("desktopTaskSnapshot exposes catalog start time without an observer run", () => {
  const { desktopTaskSnapshot, entry } = fixture({ run: null });
  assert.equal(desktopTaskSnapshot(entry).startedAt, "2026-07-30T09:55:00.000Z");
});

test("desktop snapshot exposes latest completed telemetry for the selected inactive Stream", async () => {
  const telemetry = {
    provider: "codex",
    threadId: "thread-1",
    turnId: "turn-previous",
    completedAtMs: 6_000,
    timeline: [{ atMs: 6_000, type: "completed", phase: "completed" }],
  };
  const { desktopSnapshot, state, entry } = fixture({
    run: null,
    telemetry: [telemetry],
  });
  state.entries = [{ ...entry, running: false }];
  const snapshot = await desktopSnapshot();
  assert.deepEqual(snapshot.tasks[0].providerTurnTelemetry, telemetry);
  assert.deepEqual(state.telemetryCalls, [{ provider: "codex", threadId: "thread-1", limit: 1 }]);
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
  assert.equal(snapshot.tasks[0].threadTitle, "Задача");
  assert.equal(snapshot.tasks[0].startedAt, null);
  assert.equal(snapshot.tasks[0].running, false);
  assert.equal(snapshot.activeCount, 0);
});

test("desktopContextSnapshot falls back to persisted Claude transcript usage", () => {
  const { desktopContextSnapshot, state } = fixture();
  state.usage = null;
  state.compaction = null;
  const context = desktopContextSnapshot("claude-thread", "", {
    provider: "claude",
    turnId: "claude-turn",
    usedTokens: 195_402,
    modelContextWindow: 1_000_000,
    updatedAt: "2026-08-17T10:00:01.000Z",
  });

  assert.equal(context.percent, 19.5402);
  assert.equal(context.usagePending, false);
  assert.match(context.breakdown.note, /сообщает Claude точно/u);
});

test("desktopTaskSnapshot does not expose a retained completed run as active", () => {
  const { desktopTaskSnapshot, entry, state } = fixture();
  state.run.status = "completed";
  entry.running = true;

  const snapshot = desktopTaskSnapshot(entry);

  assert.equal(snapshot.running, false);
  assert.equal(snapshot.run, null);
});

test("desktopTaskSnapshot does not resurrect a catalog run after its final answer", () => {
  const { desktopTaskSnapshot, entry, state } = fixture({ run: null });
  entry.turnId = "turn-1";
  state.lastMessage = {
    text: "Финальный ответ",
    updatedAt: "2026-07-30T10:01:30.000Z",
    turnId: "turn-1",
  };

  const snapshot = desktopTaskSnapshot(entry);

  assert.equal(snapshot.running, false);
  assert.equal(snapshot.run, null);
});

test("desktopTaskSnapshot rejects a timestamped catalog ghost without a turn id", () => {
  const { desktopTaskSnapshot, entry, state } = fixture({ run: null });
  entry.turnId = null;
  entry.startedAt = "2026-07-30T10:00:00.000Z";
  entry.lastActivityAtMs = Date.parse("2026-07-30T10:01:00.000Z");
  state.lastMessage = {
    text: "Финальный ответ уже показан",
    updatedAt: "2026-07-30T10:01:30.000Z",
    turnId: "turn-1",
  };

  const snapshot = desktopTaskSnapshot(entry);

  assert.equal(snapshot.running, false);
  assert.equal(snapshot.run, null);
});

test("desktop task snapshot exposes the durable provider-start phase", () => {
  const { desktopTaskSnapshot, entry, state } = fixture();
  state.run.providerStart = {
    state: "accepted-awaiting-first-event",
    turnId: "turn-1",
    acceptedAt: "2026-08-15T00:00:00.000Z",
    firstEventAt: null,
    firstEventMethod: null,
  };
  assert.deepEqual(desktopTaskSnapshot(entry).run.providerStart, state.run.providerStart);
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

test("an anonymous Codex catalog activity cannot become a live turn", () => {
  const { desktopTaskSnapshot, entry, state } = fixture({ run: null });
  state.compaction = {
    id: "compact-1",
    origin: "automatic",
    status: "completed",
    turnId: "compaction-turn",
    beforePercent: 41,
    afterPercent: 24,
  };
  state.lastMessage = {
    text: "Предыдущий пользовательский ход завершён",
    updatedAt: "2026-07-30T10:01:30.000Z",
    turnId: "user-turn",
  };
  const snapshot = desktopTaskSnapshot({
    ...entry,
    running: true,
    activityUnknown: true,
    turnId: null,
    lastActivityAtMs: Date.parse("2026-07-30T10:02:00.000Z"),
  });
  assert.equal(snapshot.running, false);
  assert.equal(snapshot.run, null);
  assert.equal(snapshot.context.compaction.afterPercent, 24);
});

test("legacy compaction metadata cannot hide current user content", () => {
  const { desktopTaskSnapshot, entry, state } = fixture();
  state.run.turnId = "probe-turn";
  state.run.promptPreview = "Унаследованный пользовательский текст";
  state.compaction = {
    id: "compact-1",
    origin: "automatic",
    status: "completed",
    turnId: "compaction-turn",
    probeTurnIds: ["probe-turn"],
    beforePercent: 41,
    afterPercent: 24,
  };
  const snapshot = desktopTaskSnapshot(entry);
  assert.equal(snapshot.running, true);
  assert.ok(snapshot.run);
});

test("a user turn equal to the probe text remains visible without the internal client id", () => {
  const { desktopTaskSnapshot, entry, state } = fixture();
  state.run.promptPreview = "Ответь строго: AGENT_HUB_CONTEXT_PROBE_OK_V1";
  state.run.userMessages = [{
    itemId: "manual-probe-text",
    role: "user",
    text: state.run.promptPreview,
  }];
  state.run.clientUserMessageId = null;
  const snapshot = desktopTaskSnapshot(entry);
  assert.equal(snapshot.running, true);
  assert.equal(snapshot.run.operationKind, "user-turn");
  assert.equal(snapshot.run.prompt, state.run.promptPreview);
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

test("desktopTaskSnapshot does not infer a hidden measurement from a later usage timestamp", () => {
  const { desktopTaskSnapshot, entry, state } = fixture({ run: null });
  entry.turnId = "measurement-turn";
  state.compaction = {
    id: "compact-1",
    origin: "automatic",
    status: "completed",
    turnId: "compaction-turn",
    startedAt: "2026-07-30T10:00:30.000Z",
    completedAt: "2026-07-30T10:00:40.000Z",
  };
  state.usage = {
    usedTokens: 220,
    modelContextWindow: 1_000,
    turnId: "measurement-turn",
    updatedAt: "2026-07-30T10:00:45.000Z",
  };

  const snapshot = desktopTaskSnapshot(entry);

  assert.equal(snapshot.running, true);
  assert.ok(snapshot.run);
  assert.equal(snapshot.context.turnId, "measurement-turn");
});

test("desktopTaskSnapshot keeps a real post-compaction turn when content arrives", () => {
  const { desktopTaskSnapshot, entry, state } = fixture();
  state.run.turnId = "real-turn";
  state.compaction = {
    id: "compact-1",
    origin: "automatic",
    status: "completed",
    turnId: "compaction-turn",
    startedAt: "2026-07-30T10:00:30.000Z",
    completedAt: "2026-07-30T10:00:40.000Z",
  };
  state.usage = {
    usedTokens: 230,
    modelContextWindow: 1_000,
    turnId: "real-turn",
    updatedAt: "2026-07-30T10:00:45.000Z",
  };

  const snapshot = desktopTaskSnapshot({ ...entry, turnId: "real-turn" });

  assert.equal(snapshot.running, true);
  assert.equal(snapshot.run.turnId, "real-turn");
  assert.equal(snapshot.run.prompt, "Вопрос");
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
    restartRequest: blockedRestartOperation(),
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
    streamOrderMode: "manual",
    streamCardWidthMode: "fixed",
    streamCardFixedWidth: 237,
    streamCardGapEnabled: true,
    quickMessageActionMode: "send",
    pinnedWorkspaceStreams: {},
    quickMessages: {
      global: [{ label: "Пинг", text: "пинг" }],
      streams: { "stream-1": [{ label: "релизь", text: "релизь" }] },
      workspaces: {},
    },
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
      streamId: null,
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
      streamId: null,
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
      streamId: null,
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

test("desktopSnapshot derives restart waiting from the persisted operation", async () => {
  const { desktopSnapshot } = fixture({
    restartRequest: blockedRestartOperation(),
  });

  const snapshot = await desktopSnapshot();

  assert.equal(snapshot.restartPending, true);
  assert.equal(snapshot.restartWaiting, true);
  assert.equal(snapshot.restartBlockingCount, 6);
  assert.equal(snapshot.server.restart.waiting, true);
});

test("desktopSnapshot exposes failed pending intake for explicit recovery in its exact Stream", async () => {
  const failed = Object.freeze({
    id: "failed-intake",
    clientUserMessageId: "client-failed-intake",
    provider: "codex",
    threadId: "thread-shared",
    streamId: "stream-2",
    conflictKind: "message-intake",
    input: "Retained input",
    lastError: "Provider start was not confirmed",
    attempts: 15,
  });
  const { desktopSnapshot, state } = fixture({
    pending: [failed],
    queued: [{ ...failed, id: "queued-sibling", streamId: "stream-1", lastError: null }],
  });

  const snapshot = await desktopSnapshot();
  const entry = snapshot.deferredInputs.find((item) => item.id === failed.id);
  assert.deepEqual(snapshot.messageReceipts, []);
  assert.equal(entry.state, "pending");
  assert.equal(entry.attentionRequired, true);
  assert.equal(entry.streamId, "stream-2");
  assert.equal(entry.threadId, failed.threadId);
  assert.equal(entry.clientUserMessageId, failed.clientUserMessageId);
  assert.equal(entry.lastError, failed.lastError);
  assert.equal(entry.attempts, 15);
  assert.equal(entry.text, failed.input);
  assert.equal(snapshot.deferredInputs.find((item) => item.id === "queued-sibling").streamId, "stream-1");
  assert.equal(state.pending[0], failed);
  assert.equal(failed.attentionRequired, undefined);
});

test("desktopSnapshot retains task attachments in restored pending and paused queues", async () => {
  const reference = taskReferenceDescriptor({ id: "task-1", title: "Review", taskNumber: "HUB-176" });
  const persisted = JSON.parse(JSON.stringify({
    id: "retained", provider: "codex", threadId: "thread-1", paused: true,
    input: [{ type: "text", text: messageWithTaskReferences("Review this", [reference]) }],
  }));
  const restored = restoreDeferredInput(persisted).item;
  const { desktopSnapshot } = fixture({
    pending: [restored], queued: [{ ...restored, id: "paused" }],
  });
  const snapshot = await desktopSnapshot();
  for (const queued of snapshot.deferredInputs) {
    assert.deepEqual(queued.attachments, [reference]);
  }
  assert.equal(snapshot.deferredInputs.find((queued) => queued.id === "paused").state, "paused");
});

test("desktopSnapshot keeps normal intake and transient waits out of attention-required projection", async () => {
  const { desktopSnapshot } = fixture({
    pending: [
      { id: "normal", conflictKind: "message-intake", clientProjectionIntent: "conversation" },
      { id: "waiting", lastError: { code: "ERR_CLAUDE_EXTERNAL_OWNER_ACTIVE" } },
      { id: "steering", manualAction: "steer", lastError: "Prior failure" },
    ],
  });
  const snapshot = await desktopSnapshot();
  assert.equal(snapshot.deferredInputs.every((item) => item.attentionRequired !== true), true);
  assert.equal(snapshot.deferredInputs.find((item) => item.id === "normal").state, "pending");
  assert.equal(snapshot.deferredInputs.find((item) => item.id === "waiting").lastError, null);
  assert.equal(snapshot.deferredInputs.find((item) => item.id === "steering").state, "steering");
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

test("desktopSnapshot exposes a durable automatic steer as steering", async () => {
  const { desktopSnapshot } = fixture({
    queued: [{
      id: "automatic-steer-1",
      provider: "codex",
      threadId: "thread-1",
      taskTitle: "Задача",
      input: "Уточнение",
      conflictKind: "message-steer",
      steerTargetRunId: "run-1",
      steerTargetTurnId: "turn-1",
    }],
  });
  const snapshot = await desktopSnapshot();
  assert.equal(snapshot.deferredInputs[0].state, "steering");
});

test("desktopSnapshot permits queue conversion only after a definite no-effect steer failure", async () => {
  const { desktopSnapshot } = fixture({
    pending: [
      {
        id: "definite-steer",
        provider: "codex",
        threadId: "thread-1",
        taskTitle: "Задача",
        input: "Уточнение",
        conflictKind: "message-steer",
        lastErrorCode: "ERR_PROVIDER_STEER_NOT_DELIVERED",
        lastError: "Уточнение не доставлено",
      },
      {
        id: "unknown-steer",
        provider: "codex",
        threadId: "thread-1",
        taskTitle: "Задача",
        input: "Уточнение",
        conflictKind: "message-steer",
        lastErrorCode: "ERR_PROVIDER_STEER_UNCONFIRMED",
        lastError: "Результат уточнения неизвестен",
      },
    ],
  });

  const snapshot = await desktopSnapshot();
  assert.equal(snapshot.deferredInputs.find((item) => item.id === "definite-steer").queueAfterTurnAvailable, true);
  assert.equal("queueAfterTurnAvailable" in snapshot.deferredInputs.find((item) => item.id === "unknown-steer"), false);
});

test("desktopSnapshot exposes an inter-Stream queue message without its service envelope", async () => {
  const messageOrigin = {
    workspaceId: "workspace-1",
    workspaceName: "Agent HUB",
    streamId: "stream-release-manager",
    streamName: "Release Manager",
    provider: "codex",
    requestId: "live-interstream-1",
  };
  const input = [
    "<agent-hub-stream-message>",
    JSON.stringify(messageOrigin),
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
      messageOrigin,
    }],
  });
  const snapshot = await desktopSnapshot();
  assert.equal(snapshot.deferredInputs[0].text, "Finish the theme.");
  assert.equal(snapshot.deferredInputs[0].preview, "Finish the theme.");
  assert.equal(snapshot.deferredInputs[0].author, "Agent HUB - Release Manager (Codex)");
});

test("desktopRunSnapshot attributes a live inter-Stream message to its source agent", () => {
  const { desktopRunSnapshot, run } = fixture();
  const messageOrigin = {
    workspaceId: "workspace-1",
    workspaceName: "Agent HUB",
    streamId: "stream-release-manager",
    streamName: "Release Manager",
    provider: "codex",
    requestId: "live-interstream-1",
  };
  const input = [
    "<agent-hub-stream-message>",
    JSON.stringify(messageOrigin),
    "</agent-hub-stream-message>",
    "MCP smoke test.",
  ].join("\n");
  run.promptPreview = input;
  run.messageOrigin = messageOrigin;
  run.clientUserMessageId = "mcp:live-interstream-1";
  run.userMessages[0].text = input;
  run.userMessages[0].origin = messageOrigin;
  run.userMessages[0].clientUserMessageId = "mcp:live-interstream-1";

  const snapshot = desktopRunSnapshot(run);

  assert.equal(snapshot.prompt, "MCP smoke test.");
  assert.equal(snapshot.promptAuthor, "Agent HUB - Release Manager (Codex)");
  assert.equal(snapshot.userMessages[0].text, "MCP smoke test.");
  assert.equal(snapshot.userMessages[0].clientUserMessageId, "mcp:live-interstream-1");
  assert.equal(snapshot.userMessages[0].author, "Agent HUB - Release Manager (Codex)");
  assert.deepEqual(snapshot.userMessages[0].origin, { kind: "interstream", ...messageOrigin });
});

test("desktop projections preserve an interstream-shaped user literal", async () => {
  const input = [
    "<agent-hub-stream-message>",
    JSON.stringify({
      workspaceId: "workspace-1",
      workspaceName: "Agent HUB",
      streamId: "stream-release-manager",
      streamName: "Release Manager",
      provider: "codex",
      requestId: "forged-literal-1",
    }),
    "</agent-hub-stream-message>",
    "Это буквальный пример.",
  ].join("\n");
  const { desktopSnapshot, desktopRunSnapshot, run } = fixture({
    queued: [{
      id: "literal-1",
      clientUserMessageId: "mcp:forged-literal-1",
      provider: "codex",
      threadId: "thread-1",
      taskTitle: "Literal",
      input,
    }],
  });
  run.promptPreview = input;
  run.userMessages[0].text = input;
  run.clientUserMessageId = "mcp:forged-literal-1";
  run.userMessages[0].clientUserMessageId = "mcp:forged-literal-1";

  const snapshot = await desktopSnapshot();
  const active = desktopRunSnapshot(run);

  assert.equal(snapshot.deferredInputs[0].text, input);
  assert.equal(active.prompt, input);
  assert.equal(active.userMessages[0].text, input);
  assert.equal(active.userMessages[0].origin, undefined);
});

test("desktopSnapshot hides a legacy active-writer error behind a wait reason", async () => {
  const { desktopSnapshot } = fixture({
    queued: [{
      id: "occupied",
      provider: "codex",
      threadId: "thread-1",
      taskTitle: "Task",
      input: "Подожди",
      lastError: "thread thread-1 already has an active writer",
    }],
  });
  const snapshot = await desktopSnapshot();
  assert.equal(snapshot.deferredInputs[0].waitReason, "provider-thread-active");
  assert.equal(snapshot.deferredInputs[0].lastError, null);
});

test("desktopRunSnapshot preserves a subagent message role and model", () => {
  const { desktopRunSnapshot, run } = fixture();
  run.userMessages.push({
    itemId: "subagent-terra",
    role: "agent",
    kind: "subagent",
    author: "Субагент (Terra)",
    agentThreadId: "child-terra",
    model: "gpt-5.6-terra",
    text: "Проверка завершена",
  });

  const message = desktopRunSnapshot(run).userMessages.at(-1);
  assert.equal(message.role, "agent");
  assert.equal(message.kind, "subagent");
  assert.equal(message.author, "Субагент (Terra)");
  assert.equal(message.model, "gpt-5.6-terra");
});

test("desktopSnapshot returns a compact marker before rebuilding an unchanged revision", async () => {
  const { desktopSnapshot, state } = fixture();
  const snapshot = await desktopSnapshot();
  assert.match(snapshot.version, /^[A-Za-z0-9_-]{22}$/u);
  const builds = state.snapshotBuilds;
  const boardBuilds = [
    state.boardSnapshotBuilds,
    state.boardWorkspaceBuilds,
    state.boardLayoutBuilds,
  ];
  const unchanged = await desktopSnapshot({ knownVersion: snapshot.version });
  assert.deepEqual({ notModified: unchanged.notModified, version: unchanged.version }, {
    notModified: true,
    version: snapshot.version,
  });
  assert.equal(unchanged.snapshotTiming.cacheHit, true);
  assert.equal(Number.isFinite(unchanged.snapshotTiming.totalMs), true);
  assert.equal(state.snapshotBuilds, builds);
  assert.deepEqual([
    state.boardSnapshotBuilds,
    state.boardWorkspaceBuilds,
    state.boardLayoutBuilds,
  ], boardBuilds);
});

test("desktopSnapshot rebuilds when a source revision changes", async () => {
  const { desktopSnapshot, state } = fixture();
  const snapshot = await desktopSnapshot();
  state.lastMessage = { ...state.lastMessage, text: "Новый ответ" };
  state.revision = "after-message";

  const next = await desktopSnapshot({ knownVersion: snapshot.version });

  assert.notEqual(next.notModified, true);
  assert.equal(next.tasks[0].lastAnswer, "Новый ответ");
  assert.notEqual(next.version, snapshot.version);
});

test("a history revision publishes changed pin availability through the cached v4 snapshot", async () => {
  const { desktopSnapshot, state } = fixture();
  state.messagePins = [{ id: "pin-1", streamId: "stream-1", available: true }];
  state.revision = "pins:7/history:1";
  const first = await desktopSnapshot({ snapshotProtocol: 4 });
  const request = {
    snapshotProtocol: 4,
    knownVersion: first.version,
    ...Object.fromEntries(Object.entries(first.collectionDeltas).map(([name, delta]) => [
      `${name}Version`, delta.version,
    ])),
  };
  assert.equal((await desktopSnapshot(request)).notModified, true);

  // The pin row is unchanged; the exact source message is no longer available.
  state.messagePins = [{ ...state.messagePins[0], available: false }];
  state.revision = "pins:7/history:2";
  const next = await desktopSnapshot(request);
  assert.notEqual(next.notModified, true);
  assert.deepEqual(next.collectionDeltas.messagePins.upserts, state.messagePins);
  assert.deepEqual(next.collectionDeltas.messagePins.removed, []);
  assert.notEqual(next.collectionDeltas.messagePins.version, first.collectionDeltas.messagePins.version);
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

test("snapshot protocol v4 renames conversations and sends collection deltas", async () => {
  const { desktopSnapshot, state } = fixture();
  const first = await desktopSnapshot({ snapshotProtocol: 4, compactSnapshot: true });

  assert.equal(first.apiVersion, 4);
  assert.equal(first.tasks, undefined);
  assert.equal(first.conversations, undefined);
  assert.equal(first.collectionDeltas.conversations.reset.length, 1);
  assert.deepEqual(first.collectionDeltas.workspaces.reset.map((item) => item.id), [
    "workspace-2",
    "workspace-1",
  ]);
  assert.deepEqual(first.collectionDeltas.boardTasks.reset, [{
    id: "board-task-1",
    text: "Проверить дашборд",
  }]);
  assert.deepEqual(first.collectionDeltas.messageReceipts.reset, []);
  assert.equal(first.workspaces, undefined);
  assert.equal(first.boardTasks, undefined);
  assert.equal(first.messageReceipts, undefined);
  assert.equal(first.snapshotTiming.cacheHit, false);
  assert.equal(typeof first.snapshotTiming.totalMs, "number");
  assert.equal(typeof first.snapshotTiming.versioningMs, "number");

  const recovered = await desktopSnapshot({
    snapshotProtocol: 4,
    compactSnapshot: true,
    knownVersion: first.version,
    conversationsVersion: first.collectionDeltas.conversations.version,
    workspacesVersion: first.collectionDeltas.workspaces.version,
    boardTasksVersion: "",
    messageReceiptsVersion: first.collectionDeltas.messageReceipts.version,
    messagePinsVersion: first.collectionDeltas.messagePins.version,
  });
  assert.notEqual(recovered.notModified, true);
  assert.deepEqual(recovered.collectionDeltas.boardTasks.reset, [{
    id: "board-task-1",
    text: "Проверить дашборд",
  }]);

  state.boardTasks = [
    { id: "board-task-1", text: "Обновлено" },
    { id: "board-task-2", text: "Добавлено" },
  ];
  state.boardRevision = "board:2";
  state.revision = "board-updated";
  const next = await desktopSnapshot({
    snapshotProtocol: 4,
    compactSnapshot: true,
    knownVersion: first.version,
    conversationsVersion: first.collectionDeltas.conversations.version,
    workspacesVersion: first.collectionDeltas.workspaces.version,
    boardTasksVersion: first.collectionDeltas.boardTasks.version,
    messageReceiptsVersion: first.collectionDeltas.messageReceipts.version,
    messagePinsVersion: first.collectionDeltas.messagePins.version,
  });

  assert.equal(next.collectionDeltas.workspaces.reset, undefined);
  assert.deepEqual(next.collectionDeltas.conversations, {
    baseVersion: first.collectionDeltas.conversations.version,
    version: first.collectionDeltas.conversations.version,
  });
  assert.equal(next.collectionDeltas.workspaces.upserts, undefined);
  assert.deepEqual(next.collectionDeltas.boardTasks.upserts, state.boardTasks);
  assert.deepEqual(next.collectionDeltas.boardTasks.removed, []);
  assert.deepEqual(next.collectionDeltas.boardTasks.order, ["board-task-1", "board-task-2"]);
  assert.deepEqual(next.collectionDeltas.messageReceipts, {
    baseVersion: first.collectionDeltas.messageReceipts.version,
    version: first.collectionDeltas.messageReceipts.version,
  });
});

test("an unrelated live revision reuses exact TaskBoard state and collection versions", async () => {
  const { desktopSnapshot, state } = fixture();
  const first = await desktopSnapshot({ snapshotProtocol: 4, compactSnapshot: true });
  const boardBuilds = [
    state.boardSnapshotBuilds,
    state.boardWorkspaceBuilds,
    state.boardLayoutBuilds,
  ];
  state.run = { ...state.run, responseText: "Новый прогресс" };
  state.revision = "run-progress:2";

  const next = await desktopSnapshot({
    snapshotProtocol: 4,
    compactSnapshot: true,
    knownVersion: first.version,
    conversationsVersion: first.collectionDeltas.conversations.version,
    workspacesVersion: first.collectionDeltas.workspaces.version,
    boardTasksVersion: first.collectionDeltas.boardTasks.version,
    messageReceiptsVersion: first.collectionDeltas.messageReceipts.version,
    messagePinsVersion: first.collectionDeltas.messagePins.version,
  });

  assert.notEqual(next.notModified, true);
  assert.deepEqual([
    state.boardSnapshotBuilds,
    state.boardWorkspaceBuilds,
    state.boardLayoutBuilds,
  ], boardBuilds);
  assert.deepEqual(next.collectionDeltas.workspaces, {
    baseVersion: first.collectionDeltas.workspaces.version,
    version: first.collectionDeltas.workspaces.version,
  });
  assert.deepEqual(next.collectionDeltas.boardTasks, {
    baseVersion: first.collectionDeltas.boardTasks.version,
    version: first.collectionDeltas.boardTasks.version,
  });

  state.boardTasks = [{ id: "board-task-1", text: "Изменено" }];
  state.boardRevision = "board:2";
  state.revision = "board:2";
  const changed = await desktopSnapshot({
    snapshotProtocol: 4,
    compactSnapshot: true,
    knownVersion: next.version,
    conversationsVersion: next.collectionDeltas.conversations.version,
    workspacesVersion: next.collectionDeltas.workspaces.version,
    boardTasksVersion: next.collectionDeltas.boardTasks.version,
    messageReceiptsVersion: next.collectionDeltas.messageReceipts.version,
    messagePinsVersion: next.collectionDeltas.messagePins.version,
  });
  assert.deepEqual(changed.collectionDeltas.boardTasks.upserts, state.boardTasks);
  assert.deepEqual([
    state.boardSnapshotBuilds,
    state.boardWorkspaceBuilds,
    state.boardLayoutBuilds,
  ], boardBuilds.map((count) => count + 1));
});

test("TaskBoard cache observes same-owner and external SQLite mutations", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-desktop-board-revision-"));
  const databaseFile = path.join(directory, "journal.sqlite");
  const ownerCatalog = new WorkspaceCatalogStore({ databaseFile });
  const externalCatalog = new WorkspaceCatalogStore({ databaseFile });
  await ownerCatalog.load();
  await externalCatalog.load();
  const ownerStore = new TaskBoardStore({ databaseFile });
  const externalStore = new TaskBoardStore({ databaseFile });
  t.after(async () => {
    ownerStore.close();
    externalStore.close();
    ownerCatalog.close();
    externalCatalog.close();
    await rm(directory, { recursive: true, force: true });
  });
  const workspace = ownerCatalog.createWorkspace({ name: "Owner Workspace" });
  const ownerBoard = new TaskBoardService({ store: ownerStore, workspaceCatalog: ownerCatalog });
  const externalBoard = new TaskBoardService({ store: externalStore, workspaceCatalog: externalCatalog });
  const setup = fixture({
    board: ownerBoard,
    revision: () => `desktop:${ownerBoard.snapshotRevision}`,
  });
  const requestFor = (snapshot) => ({
    snapshotProtocol: 4,
    compactSnapshot: true,
    knownVersion: snapshot.version,
    ...Object.fromEntries(Object.entries(snapshot.collectionDeltas).map(([name, delta]) => [
      `${name}Version`, delta.version,
    ])),
  });

  const first = await setup.desktopSnapshot({ snapshotProtocol: 4, compactSnapshot: true });
  const localTask = await ownerBoard.create({
    text: "Same owner", source: "test", bucket: "workspace", workspaceId: workspace.id,
  });
  const local = await setup.desktopSnapshot(requestFor(first));
  assert.notEqual(local.notModified, true);
  assert.deepEqual(local.collectionDeltas.boardTasks.upserts.map((task) => task.id), [localTask.id]);

  const externalWorkspace = externalCatalog.createWorkspace({ name: "External Workspace" });
  const externalTask = await externalBoard.create({
    text: "External owner", source: "test", bucket: "workspace", workspaceId: externalWorkspace.id,
  });
  await externalBoard.setNotesComment({ comment: "External layout update" });
  const external = await setup.desktopSnapshot(requestFor(local));

  assert.notEqual(external.notModified, true);
  assert.deepEqual(external.collectionDeltas.workspaces.upserts.map((item) => item.id), [externalWorkspace.id]);
  assert.deepEqual(external.collectionDeltas.boardTasks.upserts.map((task) => task.id), [externalTask.id]);
  assert.equal(external.boardLayout.notesComment, "External layout update");

  // HUB-235's journal projection must invalidate HUB-226's board cache too.
  const journal = new JournalDatabase(databaseFile);
  t.after(() => journal.close());
  ownerStore.claim(localTask.id, {
    workspaceId: workspace.id, streamId: "stream", provider: "codex",
    threadId: "journal-thread", turnId: "journal-turn", operationId: "journal-claim",
  });
  const claimed = await setup.desktopSnapshot(requestFor(external));
  await journal.upsertRecords([{
    provider: "codex", threadId: "journal-thread", taskThreadId: "journal-thread",
    turnId: "journal-turn", projectRoot: directory, title: "Journal completed",
    body: "private body", completedAt: "2026-09-16T00:00:00Z", status: "completed",
  }]);
  const completed = await setup.desktopSnapshot(requestFor(claimed));
  const projected = completed.collectionDeltas.boardTasks.upserts.find((item) => item.id === localTask.id);
  assert.equal(projected.workLog[0].summary, "Journal completed");
  assert.equal(projected.workLog[0].turnId, "journal-turn");
  assert.equal(JSON.stringify(projected).includes("private body"), false);
  assert.equal((await setup.desktopSnapshot(requestFor(completed))).notModified, true);
  await journal.close();
});

test("an unavailable TaskBoard revision disables Dashboard state reuse", async () => {
  const { desktopSnapshot, state } = fixture({ boardRevision: null });
  await desktopSnapshot({ snapshotProtocol: 4, compactSnapshot: true });
  const boardBuilds = [
    state.boardSnapshotBuilds,
    state.boardWorkspaceBuilds,
    state.boardLayoutBuilds,
  ];
  state.revision = "unrelated:2";

  await desktopSnapshot({ snapshotProtocol: 4, compactSnapshot: true });

  assert.deepEqual([
    state.boardSnapshotBuilds,
    state.boardWorkspaceBuilds,
    state.boardLayoutBuilds,
  ], boardBuilds.map((count) => count + 1));
});

test("unchanged snapshot reports a measured revision cache hit", async () => {
  let now = 10;
  const { desktopSnapshot } = fixture({ monotonicNow: () => now += 0.25 });
  const first = await desktopSnapshot({ snapshotProtocol: 4, compactSnapshot: true });
  const unchanged = await desktopSnapshot({
    snapshotProtocol: 4,
    compactSnapshot: true,
    knownVersion: first.version,
    conversationsVersion: first.collectionDeltas.conversations.version,
    workspacesVersion: first.collectionDeltas.workspaces.version,
    boardTasksVersion: first.collectionDeltas.boardTasks.version,
    messageReceiptsVersion: first.collectionDeltas.messageReceipts.version,
    messagePinsVersion: first.collectionDeltas.messagePins.version,
  });
  assert.equal(unchanged.notModified, true);
  assert.equal(unchanged.snapshotTiming.cacheHit, true);
  assert.equal(typeof unchanged.snapshotTiming.revisionBeforeMs, "number");
});

test("snapshot protocol v3 remains wire-compatible", async () => {
  const { desktopSnapshot } = fixture();
  const snapshot = await desktopSnapshot({ snapshotProtocol: 3 });
  assert.equal(snapshot.apiVersion, 3);
  assert.equal(snapshot.conversations, undefined);
  assert.equal(snapshot.collectionDeltas, undefined);
  assert.equal(snapshot.tasks.length, 1);
  assert.equal(snapshot.workspaces.length, 2);
  assert.equal(snapshot.boardTasks.length, 1);
  assert.deepEqual(snapshot.messageReceipts, []);
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

test("live snapshot exposes only a Task card when its provider prompt has no user text", async () => {
  const { desktopSnapshot, state } = fixture();
  const prompt = [
    "# Attached Agent Hub Tasks",
    "",
    "- [Dashboard Task: Проверка](agent-hub://task/board-1) · status: new · intent: context",
    "",
    "Открой актуальное содержимое Task командой MCP `hub_task_get` по `taskId` из ссылки.",
    "",
    "# My request",
    "",
    "Учти прикреплённые Dashboard Task как контекст; само прикрепление не является просьбой выполнять их.",
  ].join("\n");
  const reference = {
    kind: "task",
    taskId: "board-1",
    taskNumber: null,
    title: "Проверка",
    workflowStatus: "new",
    workspaceId: null,
    intent: "context",
  };
  state.run.promptPreview = prompt;
  state.run.userMessages[0].text = prompt;
  state.run.messageAttachments = [];

  const snapshot = await desktopSnapshot({ compactSnapshot: true });

  assert.equal(snapshot.tasks[0].run.prompt, "");
  assert.equal(snapshot.tasks[0].run.userMessages[0].text, "");
  assert.deepEqual(snapshot.tasks[0].run.userMessages[0].attachments, [reference]);
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

test("desktop snapshot coalesces one failing background catalog refresh", async () => {
  let rejectRefresh;
  const refreshWait = new Promise((_, reject) => { rejectRefresh = reject; });
  const { desktopSnapshot, state } = fixture({ catalogStale: true });
  state.refreshCatalog = (options) => {
    state.refreshCalls.push(options);
    return refreshWait;
  };

  await Promise.all([desktopSnapshot(), desktopSnapshot(), desktopSnapshot()]);
  assert.deepEqual(state.refreshCalls, [{ force: false }]);
  rejectRefresh(new Error("database is locked"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(state.warnings.length, 1);
  assert.match(state.warnings[0].join(" "), /database is locked/u);
});

test("an unsettled interstream steer names its source on the first projected frame", () => {
  const origin = {
    workspaceId: "workspace-1",
    workspaceName: "Agent HUB",
    streamId: "stream-s3",
    streamName: "S3",
    provider: "codex",
    model: "GPT-6 Astra",
    sourceThreadId: "thread-s3",
    requestId: "s3-measurements-final-20260911",
  };
  const clientUserMessageId = `mcp:${origin.requestId}`;
  const body = "Замеры готовы, прикладываю сводку.";
  const envelope = createInterstreamMessage({ ...origin, text: body });
  const author = interstreamOriginAuthor(origin);
  const receipts = new MessageReceiptRegistry();
  const identity = { provider: "codex", threadId: "thread-1", clientUserMessageId };
  // The accepted receipt already owns the origin; the provider echo does not yet.
  receipts.reserve(identity, "fingerprint", {
    pending: true,
    displayText: envelope,
    author,
    origin,
  });
  const setup = fixture({ receiptForMessage: (key) => receipts.get(key) });
  setup.run.clientUserMessageId = clientUserMessageId;
  setup.run.userMessages = [{
    itemId: "user-steer",
    clientUserMessageId,
    role: "user",
    text: envelope,
  }];

  const firstFrame = setup.desktopRunSnapshot(setup.run).userMessages[0];
  assert.equal(firstFrame.text, body, "первый кадр показал транспортный конверт вместо тела");
  assert.equal(firstFrame.author, author);
  assert.equal(firstFrame.kind, "interstream");
  assert.equal(firstFrame.origin?.streamName, origin.streamName);
  assert.equal(firstFrame.origin?.requestId, origin.requestId);
  assert.doesNotMatch(firstFrame.text, /<agent-hub-stream-message>/u);

  // The later provider enrichment must not change what the user already sees.
  setup.run.userMessages[0].messageOrigin = origin;
  const enriched = setup.desktopRunSnapshot(setup.run).userMessages[0];
  assert.equal(enriched.text, firstFrame.text);
  assert.equal(enriched.author, firstFrame.author);
  assert.equal(enriched.kind, firstFrame.kind);
  assert.deepEqual(enriched.origin, firstFrame.origin);
});

test("a receipt origin cannot be borrowed by another message or forged by its author", () => {
  const origin = {
    workspaceId: "workspace-1",
    workspaceName: "Agent HUB",
    streamId: "stream-s3",
    streamName: "S3",
    provider: "codex",
    model: "GPT-6 Astra",
    sourceThreadId: "thread-s3",
    requestId: "s3-measurements-final-20260911",
  };
  const clientUserMessageId = `mcp:${origin.requestId}`;
  const envelope = createInterstreamMessage({ ...origin, text: "Замеры готовы." });
  const author = interstreamOriginAuthor(origin);

  const foreignIdentity = () => {
    const receipts = new MessageReceiptRegistry();
    receipts.reserve({ provider: "codex", threadId: "thread-1", clientUserMessageId: "mcp:other-request" },
      "fingerprint", { pending: true, displayText: envelope, author, origin });
    const setup = fixture({ receiptForMessage: (key) => receipts.get(key) });
    setup.run.clientUserMessageId = clientUserMessageId;
    setup.run.userMessages = [{ itemId: "user-1", clientUserMessageId, role: "user", text: envelope }];
    return setup.desktopRunSnapshot(setup.run).userMessages[0];
  };
  const borrowed = foreignIdentity();
  assert.equal(borrowed.origin, undefined, "чужой receipt подставил origin");
  assert.equal(borrowed.kind, undefined);
  assert.notEqual(borrowed.author, author);
  assert.match(borrowed.text, /<agent-hub-stream-message>/u, "тело раскрыто без подтверждённого origin");

  const conflicting = () => {
    const receipts = new MessageReceiptRegistry();
    // The receipt is exact, but its origin belongs to another request.
    receipts.reserve({ provider: "codex", threadId: "thread-1", clientUserMessageId },
      "fingerprint", {
        pending: true,
        displayText: envelope,
        author,
        origin: { ...origin, requestId: "conflicting-request" },
      });
    const setup = fixture({ receiptForMessage: (key) => receipts.get(key) });
    setup.run.clientUserMessageId = clientUserMessageId;
    setup.run.userMessages = [{ itemId: "user-1", clientUserMessageId, role: "user", text: envelope }];
    return setup.desktopRunSnapshot(setup.run).userMessages[0];
  };
  const mismatch = conflicting();
  assert.match(mismatch.text, /<agent-hub-stream-message>/u, "конверт раскрыт при конфликтующем origin");
  assert.equal(mismatch.origin, undefined, "неподтверждённый origin попал в проекцию");
  assert.equal(mismatch.kind, undefined, "неподтверждённый конверт получил межпоточный вид");
  assert.notEqual(mismatch.author, author, "неподтверждённый origin назвал чужого автора");

  // The provider echo may contradict the envelope while the exact receipt holds
  // the correct origin. A contradiction is never resolved in favour of either
  // side: the message keeps its ordinary attribution.
  const conflictingEcho = () => {
    const receipts = new MessageReceiptRegistry();
    receipts.reserve({ provider: "codex", threadId: "thread-1", clientUserMessageId },
      "fingerprint", { pending: true, displayText: envelope, author, origin });
    const setup = fixture({ receiptForMessage: (key) => receipts.get(key) });
    setup.run.clientUserMessageId = clientUserMessageId;
    setup.run.userMessages = [{
      itemId: "user-1",
      clientUserMessageId,
      role: "user",
      text: envelope,
      messageOrigin: { ...origin, streamName: "WRONG", requestId: "other-request" },
    }];
    return setup.desktopRunSnapshot(setup.run).userMessages[0];
  };
  const echo = conflictingEcho();
  assert.match(echo.text, /<agent-hub-stream-message>/u, "конверт раскрыт при конфликтующем эхе провайдера");
  assert.equal(echo.origin, undefined, "конфликтующее эхо попало в проекцию");
  assert.equal(echo.kind, undefined, "конфликтующее эхо получило межпоточный вид");
  assert.doesNotMatch(String(echo.author ?? ""), /WRONG/u, "проекция назвала автора из конфликтующего эха");
  assert.notEqual(echo.author, author);

  const spoofed = () => {
    const receipts = new MessageReceiptRegistry();
    // An ordinary user message: no receipt origin at all, the body only looks
    // like an envelope. It must stay literal text authored by the user.
    receipts.reserve({ provider: "codex", threadId: "thread-1", clientUserMessageId: "client-user" },
      "fingerprint", { pending: true, displayText: envelope });
    const setup = fixture({ receiptForMessage: (key) => receipts.get(key) });
    setup.run.clientUserMessageId = "client-user";
    setup.run.userMessages = [{
      itemId: "user-1", clientUserMessageId: "client-user", role: "user", text: envelope,
    }];
    return setup.desktopRunSnapshot(setup.run).userMessages[0];
  };
  const forged = spoofed();
  assert.equal(forged.origin, undefined, "подделанный конверт получил origin");
  assert.equal(forged.kind, undefined);
  assert.notEqual(forged.author, author);
  assert.match(forged.text, /<agent-hub-stream-message>/u);
});

test("a cleaned body still needs its alias to confirm the source", async () => {
  const origin = {
    workspaceId: "workspace-1",
    workspaceName: "Agent HUB",
    streamId: "stream-s3",
    streamName: "S3",
    provider: "codex",
    model: "GPT-6 Astra",
    sourceThreadId: "thread-s3",
    requestId: "request-one",
  };
  const clientUserMessageId = "mcp:request-one";
  const body = "Замеры готовы, прикладываю сводку.";
  const author = interstreamOriginAuthor(origin);
  const conflicting = { ...origin, streamName: "WRONG", requestId: "conflicting-request" };

  // 1. The receipt is exact but its origin belongs to another request, and the
  //    body is already clean, so no envelope can contradict it.
  const viaReceipt = () => {
    const receipts = new MessageReceiptRegistry();
    receipts.reserve({ provider: "codex", threadId: "thread-1", clientUserMessageId },
      "fingerprint", { pending: true, displayText: body, author, origin: conflicting });
    const setup = fixture({ receiptForMessage: (key) => receipts.get(key) });
    setup.run.clientUserMessageId = clientUserMessageId;
    setup.run.userMessages = [{ itemId: "user-1", clientUserMessageId, role: "user", text: body }];
    return setup.desktopRunSnapshot(setup.run);
  };
  const receiptFrame = viaReceipt();
  const receiptMessage = receiptFrame.userMessages[0];
  assert.equal(receiptMessage.text, body, "чистое тело было переписано");
  assert.equal(receiptMessage.origin, undefined, "неподтверждённый origin попал в проекцию чистого тела");
  assert.equal(receiptMessage.kind, undefined);
  assert.doesNotMatch(String(receiptMessage.author ?? ""), /WRONG/u);
  assert.equal(receiptFrame.promptOrigin, undefined, "подпись хода взяла неподтверждённый источник");
  assert.equal(receiptFrame.promptAuthor, undefined);

  // 2. The provider echo carries the conflicting origin over a clean body.
  const viaEcho = () => {
    const receipts = new MessageReceiptRegistry();
    receipts.reserve({ provider: "codex", threadId: "thread-1", clientUserMessageId },
      "fingerprint", { pending: true, displayText: body, author, origin });
    const setup = fixture({ receiptForMessage: (key) => receipts.get(key) });
    setup.run.clientUserMessageId = clientUserMessageId;
    setup.run.userMessages = [{
      itemId: "user-1", clientUserMessageId, role: "user", text: body, messageOrigin: conflicting,
    }];
    return setup.desktopRunSnapshot(setup.run).userMessages[0];
  };
  const echoMessage = viaEcho();
  assert.equal(echoMessage.text, body);
  assert.equal(echoMessage.origin, undefined, "конфликтующее эхо прошло на чистом теле");
  assert.equal(echoMessage.kind, undefined);
  assert.doesNotMatch(String(echoMessage.author ?? ""), /WRONG/u);

  // 3. The deferred projector must refuse the same conflict on a clean input.
  const receipts = new MessageReceiptRegistry();
  const identity = { provider: "codex", threadId: "thread-1", clientUserMessageId };
  receipts.reserve(identity, "fingerprint", { pending: true, displayText: body });
  const setup = fixture({ receiptForMessage: (key) => receipts.get(key) });
  setup.state.queued = [{ ...identity, id: "queue-1", input: body, messageOrigin: conflicting }];
  const snapshot = await setup.desktopSnapshot();
  const [deferred] = snapshot.deferredInputs;
  assert.equal(deferred.text, body, "тело отложенного сообщения было переписано");
  assert.equal(deferred.origin, undefined, "отложенное сообщение взяло неподтверждённый источник");
  assert.equal(deferred.author, undefined);

  // 4. The same clean body with an exact alias keeps its source.
  const benign = () => {
    const registry = new MessageReceiptRegistry();
    registry.reserve({ provider: "codex", threadId: "thread-1", clientUserMessageId },
      "fingerprint", { pending: true, displayText: body, author, origin });
    const benignSetup = fixture({ receiptForMessage: (key) => registry.get(key) });
    benignSetup.run.clientUserMessageId = clientUserMessageId;
    benignSetup.run.userMessages = [{ itemId: "user-1", clientUserMessageId, role: "user", text: body }];
    return benignSetup.desktopRunSnapshot(benignSetup.run).userMessages[0];
  };
  const confirmed = benign();
  assert.equal(confirmed.text, body);
  assert.equal(confirmed.author, author, "точная identity потеряла подтверждённый источник");
  assert.equal(confirmed.kind, "interstream");
  assert.equal(confirmed.origin?.requestId, origin.requestId);
});

test("a receipt reaches the client only with an origin its own message confirms", async () => {
  const origin = {
    workspaceId: "workspace-1",
    workspaceName: "Agent HUB",
    streamId: "stream-s3",
    streamName: "S3",
    provider: "codex",
    model: "GPT-6 Astra",
    sourceThreadId: "thread-s3",
    requestId: "request-one",
  };
  const clientUserMessageId = "mcp:request-one";
  const author = interstreamOriginAuthor(origin);
  const receiptFor = (result) => [{
    provider: "codex",
    threadId: "thread-1",
    clientUserMessageId,
    createdAt: "2026-09-11T10:00:00.000Z",
    fingerprint: "private-fingerprint",
    result: { accepted: true, ...result },
  }];

  // The envelope keeps the same requestId but claims a different Stream.
  const forgedEnvelope = createInterstreamMessage({
    ...origin, workspaceId: "workspace-other", streamId: "stream-other", streamName: "WRONG",
    sourceThreadId: "thread-other", text: "Замеры готовы.",
  });
  const conflicting = fixture();
  conflicting.state.receipts = receiptFor({ displayText: forgedEnvelope, author, origin });
  const [conflictingReceipt] = (await conflicting.desktopSnapshot()).messageReceipts;
  assert.equal(conflictingReceipt.displayText, forgedEnvelope, "тело квитанции было переписано");
  assert.equal(conflictingReceipt.origin, undefined, "конфликтующий origin дошёл до клиента");
  assert.equal(conflictingReceipt.author, undefined, "конфликтующий автор дошёл до клиента");

  // A stored origin whose requestId does not match the alias is refused too.
  const foreign = fixture();
  foreign.state.receipts = receiptFor({
    displayText: "Замеры готовы.", author, origin: { ...origin, requestId: "conflicting-request" },
  });
  const [foreignReceipt] = (await foreign.desktopSnapshot()).messageReceipts;
  assert.equal(foreignReceipt.origin, undefined, "чужой requestId дошёл до клиента");
  assert.equal(foreignReceipt.author, undefined);

  // The exact origin of this message still reaches the client with its author.
  const benign = fixture();
  benign.state.receipts = receiptFor({ displayText: "Замеры готовы.", author, origin });
  const [benignReceipt] = (await benign.desktopSnapshot()).messageReceipts;
  assert.equal(benignReceipt.displayText, "Замеры готовы.");
  assert.equal(benignReceipt.author, author, "подтверждённый автор не дошёл до клиента");
  assert.equal(benignReceipt.origin?.requestId, origin.requestId);
  assert.equal(benignReceipt.origin?.streamName, origin.streamName);
});

test("a settled restart failure invalidates a cached snapshot, a later success clears it and expiry drops it", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-restart-failure-cache-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let clock = Date.parse("2026-09-13T20:00:00.000Z");
  const store = new MaintenanceOperationStore({ dataDir: directory, now: () => new Date(clock).toISOString() });
  const recentRestartFailure = createRecentRestartFailure({ operations: store, now: () => clock });
  // Every other snapshot source stays unchanged; only the restart owner moves.
  const { desktopSnapshot } = fixture({
    revisionFn: () => JSON.stringify({ sources: "unchanged", restartFailure: recentRestartFailure() }),
    restartFailure: recentRestartFailure,
  });
  const settleRestart = (succeeded, error = null) => {
    const operation = store.create({
      kind: "restart", streamId: "stream-1", threadId: "thread-1", status: "requested", phase: "requested",
    });
    clock += 1_000;
    store.settle(operation.operationId, {
      succeeded,
      phase: succeeded ? "completed" : "failed",
      metadata: error ? { error } : {},
    });
    return operation.operationId;
  };

  const cachedBeforeRestart = await desktopSnapshot();
  assert.equal(cachedBeforeRestart.restartFailure, null);
  assert.equal((await desktopSnapshot({ knownVersion: cachedBeforeRestart.version })).notModified, true);

  const failedId = settleRestart(false, "replacement bot 84 exited before becoming ready");
  const failed = await desktopSnapshot({ knownVersion: cachedBeforeRestart.version });
  assert.notEqual(failed.notModified, true);
  assert.deepEqual(failed.restartFailure && {
    operationId: failed.restartFailure.operationId,
    error: failed.restartFailure.error,
  }, { operationId: failedId, error: "replacement bot 84 exited before becoming ready" });
  assert.equal((await desktopSnapshot({ knownVersion: failed.version })).notModified, true);

  clock += 60_000;
  settleRestart(true);
  const recovered = await desktopSnapshot({ knownVersion: failed.version });
  assert.notEqual(recovered.notModified, true);
  assert.equal(recovered.restartFailure, null);

  const expiringId = settleRestart(false, "replacement bot 85 exited before becoming ready");
  const expiring = await desktopSnapshot({ knownVersion: recovered.version });
  assert.equal(expiring.restartFailure?.operationId, expiringId);
  clock += RESTART_FAILURE_NOTICE_WINDOW_MS + 1_000;
  const expired = await desktopSnapshot({ knownVersion: expiring.version });
  assert.notEqual(expired.notModified, true);
  assert.equal(expired.restartFailure, null);
});

test("a restart failure that expires between snapshot reads never leaves a stale cached version", async () => {
  const failure = {
    operationId: "restart-1",
    error: "replacement bot 84 exited before becoming ready",
    failedAt: "2026-09-13T20:00:01.000Z",
  };
  let reads = 0;
  // The revision before the build and the content see the failure; the
  // revision after the build is read once its notice window has ended.
  const recentRestartFailure = () => (reads++ < 2 ? failure : null);
  const { desktopSnapshot } = fixture({
    revisionFn: () => JSON.stringify({ sources: "unchanged", restartFailure: recentRestartFailure() }),
    restartFailure: recentRestartFailure,
  });

  const boundary = await desktopSnapshot();
  assert.equal(boundary.restartFailure?.operationId, "restart-1");

  const next = await desktopSnapshot({ knownVersion: boundary.version });
  assert.notEqual(next.notModified, true, "the version built across the boundary was not cached");
  assert.equal(next.restartFailure, null);
});
