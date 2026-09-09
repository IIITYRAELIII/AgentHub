import assert from "node:assert/strict";
import test from "node:test";
import {
  CodexTaskSnapshotService,
  codexTurnSnapshot,
} from "../../../src/providers/codex/codex-task-snapshot-service.mjs";
import { CODEX_CONTEXT_PROBE_PROMPT } from "../../../src/domain/codex-context-probe.mjs";
import { codexRolloutTurnState } from "../../../src/providers/codex/codex-rollout-activity.mjs";

test("managed snapshot never adopts a dangling historical turn before provider acceptance", async () => {
  let reads = 0;
  const activity = {
    activeTurnIds: ["old-turn"],
    startedAtMsByTurnId: { "old-turn": Date.parse("2026-08-24T07:24:23.359Z") },
    completedAtMsByTurnId: { "new-turn": Date.parse("2026-09-09T11:16:16.277Z") },
    finalMessages: { "new-turn": "Current answer" },
  };
  const service = new CodexTaskSnapshotService({
    knownRolloutPath: async () => "rollout.jsonl",
    readRolloutActivity: async () => activity,
    rolloutTurnState: codexRolloutTurnState,
    capturedOwner: () => null,
    runtimeActive: async () => true,
    resolveOwner: async () => "agent-hub",
    readThread: async () => {
      reads += 1;
      return { thread: { path: "rollout.jsonl", turns: [], status: { type: "idle" } } };
    },
    selectTurn: () => null,
    turnSnapshot: codexTurnSnapshot,
    turnStartedAt: () => null,
    describeItem: () => "stage",
    hubOwner: () => "agent-hub",
    agentHubPid: () => 1,
    modelLabel: (value) => value,
    runtimeLabel: (value) => value,
    delay: async () => {},
    reindexRun: () => {},
  });
  const run = { observer: false, threadId: "thread-1", turnId: null, startedAt: "2026-09-09T11:18:00.000Z" };
  assert.equal(await service.read(run), null);
  assert.equal(reads, 0);
  assert.equal(run.turnId, null);
  assert.equal(run.startedAt, "2026-09-09T11:18:00.000Z");
  run.turnId = "new-turn";
  const snapshot = await service.read(run);
  assert.equal(snapshot.turnId, "new-turn");
  assert.equal(snapshot.active, false);
  assert.equal(snapshot.completed, true);
  assert.equal(snapshot.answer, "Current answer");
});

test("Codex turn snapshot preserves the actual completion time", () => {
  const snapshot = codexTurnSnapshot({
    id: "turn-1",
    status: "completed",
    startedAt: 1_722_768_000,
    completedAt: "2026-08-04T10:09:00.000Z",
    items: [{ type: "agentMessage", text: "Final", phase: "final_answer" }],
  });

  assert.equal(snapshot.completedAt, "2026-08-04T10:09:00.000Z");
});

test("Codex snapshot service reports an exact rollout observer", async () => {
  const service = new CodexTaskSnapshotService({
    knownRolloutPath: async () => "rollout.jsonl",
    readRolloutActivity: async () => ({
      activeTurnIds: ["turn-1"], activityAtMsByTurnId: {}, running: true,
      userMessageSnapshotAuthority: "complete",
      userMessageSnapshotAuthorityByTurnId: { "turn-1": "incremental" },
      activityGroups: {
        "turn-1": [{ id: "comment-1", reasoning: "Проверяю.", activities: [] }],
      },
    }),
    rolloutTurnState: () => ({
      turnId: "turn-1", active: true, completed: false, latestAnswer: "Now", finalAnswer: "",
      userMessages: [{
        text: "Do",
        sourceOccurrenceId: `codex-rollout:${"a".repeat(64)}`,
      }],
      startedAt: "2026-08-04T10:00:00.000Z",
    }),
    capturedOwner: () => null, runtimeActive: async () => true, resolveOwner: async () => "vscode-app-server",
    readThread: async () => ({ thread: {} }), selectTurn: () => null, turnSnapshot: () => ({}),
    turnStartedAt: () => null, describeItem: () => "stage", hubOwner: () => "agent-hub",
    agentHubPid: () => 42, modelLabel: (value) => value, runtimeLabel: (value) => value,
    delay: async () => {}, reasoningLabels: {}, logger: { warn() {} }, reindexRun: () => {},
  });
  const snapshot = await service.read({ observer: true, threadId: "thread-1", exactTurnObserver: true });
  assert.equal(snapshot.active, true);
  assert.equal(snapshot.answer, "Now");
  assert.equal(snapshot.executionOwner, "vscode-app-server");
  assert.equal(snapshot.userMessageSnapshotAuthority, "incremental");
  assert.equal(snapshot.userMessages[0].sourceOccurrenceId, `codex-rollout:${"a".repeat(64)}`);
  assert.equal(snapshot.activityGroups[0].reasoning, "Проверяю.");
});

test("Codex snapshot service hydrates a rollout subagent model", async () => {
  const service = new CodexTaskSnapshotService({
    knownRolloutPath: async (threadId) => threadId === "child-terra" ? "child.jsonl" : "parent.jsonl",
    readRolloutActivity: async (rolloutPath) => rolloutPath === "child.jsonl"
      ? { model: "gpt-5.6-terra" }
      : { activeTurnIds: ["turn-1"], activityAtMsByTurnId: {}, running: true },
    rolloutTurnState: () => ({
      turnId: "turn-1", active: true, completed: false, latestAnswer: "", finalAnswer: "",
      userMessages: [
        { role: "user", text: "Проверь" },
        {
          role: "agent",
          kind: "subagent",
          author: "Субагент (модель неизвестна)",
          agentThreadId: "child-terra",
          text: "Готово",
        },
      ],
    }),
    capturedOwner: () => null, runtimeActive: async () => true, resolveOwner: async () => "agent-hub",
    readThread: async () => ({ thread: {} }), selectTurn: () => null, turnSnapshot: () => ({}),
    turnStartedAt: () => null, describeItem: () => "", hubOwner: () => "agent-hub",
    agentHubPid: () => 1, modelLabel: (value) => value, runtimeLabel: (value) => value,
    delay: async () => {}, reindexRun: () => {}, logger: { warn() {} },
  });

  const snapshot = await service.read({ observer: true, threadId: "parent", exactTurnObserver: true });
  assert.equal(snapshot.prompt, "Проверь");
  assert.equal(snapshot.userMessages[1].author, "Субагент (Terra)");
});

test("Codex snapshot service preserves complete App Server users while incremental rollout adds exact identities", async () => {
  const service = new CodexTaskSnapshotService({
    knownRolloutPath: async () => "rollout.jsonl",
    readRolloutActivity: async () => ({
      activeTurnIds: ["turn-1"],
      activityAtMsByTurnId: { "turn-1": 1_000 },
      startedAtMsByTurnId: {},
      completedAtMsByTurnId: {},
      lastActivityAtMs: 1_000,
    }),
    rolloutTurnState: () => ({
      turnId: "turn-1",
      active: true,
      completed: false,
      userMessages: [
        {
          itemId: "root-receipt",
          clientUserMessageId: "root-receipt",
          role: "user",
          text: "Исходный запрос",
        },
        {
          itemId: "steer-receipt",
          clientUserMessageId: "steer-receipt",
          role: "user",
          text: "Уточнение в текущий ход",
        },
      ],
    }),
    capturedOwner: () => null,
    runtimeActive: async () => true,
    resolveOwner: async () => "agent-hub",
    readThread: async () => ({
      thread: {
        path: "rollout.jsonl",
        status: { type: "active" },
        turns: [{
          id: "turn-1",
          status: "inProgress",
          items: [
            { id: "msg-root", type: "userMessage", content: [{ type: "text", text: "Исходный запрос" }] },
            { id: "msg-steer", type: "userMessage", content: [{ type: "text", text: "Уточнение в текущий ход" }] },
          ],
        }],
      },
    }),
    selectTurn: (turns) => turns[0],
    turnSnapshot: codexTurnSnapshot,
    turnStartedAt: () => null,
    describeItem: () => "stage",
    hubOwner: () => "agent-hub",
    agentHubPid: () => 1,
    modelLabel: (value) => value,
    runtimeLabel: (value) => value,
    delay: async () => {},
    reindexRun: () => {},
    logger: { warn() {} },
  });

  const snapshot = await service.read({
    observer: false,
    threadId: "thread-1",
    turnId: "turn-1",
  });

  assert.equal(snapshot.clientUserMessageId, "root-receipt");
  assert.deepEqual(snapshot.userMessages.map((message) => ({
    itemId: message.itemId,
    clientUserMessageId: message.clientUserMessageId,
    text: message.text,
  })), [
    {
      itemId: "msg-root",
      clientUserMessageId: undefined,
      text: "Исходный запрос",
    },
    {
      itemId: "msg-steer",
      clientUserMessageId: undefined,
      text: "Уточнение в текущий ход",
    },
    {
      itemId: "root-receipt",
      clientUserMessageId: "root-receipt",
      text: "Исходный запрос",
    },
    {
      itemId: "steer-receipt",
      clientUserMessageId: "steer-receipt",
      text: "Уточнение в текущий ход",
    },
  ]);
});

test("Codex snapshot service never selects a context probe from thread reads", async () => {
  const selected = [];
  const readOptions = [];
  const userTurn = { id: "user-turn", status: "completed", items: [] };
  const probeTurn = {
    id: "probe-turn",
    status: "inProgress",
    items: [{
      type: "userMessage",
      clientId: "agent-hub-context-probe:probe-1",
      content: [{ type: "text", text: CODEX_CONTEXT_PROBE_PROMPT }],
    }],
  };
  const service = new CodexTaskSnapshotService({
    knownRolloutPath: async () => "",
    readRolloutActivity: async () => ({
      activeTurnIds: ["probe-turn"],
      activityAtMsByTurnId: {},
      completedAtMsByTurnId: {},
      startedAtMsByTurnId: {},
      lastActivityAtMs: 0,
    }),
    rolloutTurnState: () => ({}),
    capturedOwner: () => null,
    runtimeActive: async () => true,
    resolveOwner: async () => "agent-hub",
    readThread: async (_threadId, options) => {
      readOptions.push(options);
      return { thread: { turns: [userTurn, probeTurn] } };
    },
    selectTurn: (turns) => {
      selected.push(...turns);
      return turns[0];
    },
    turnSnapshot: () => ({ completed: true, active: false, status: "completed" }),
    turnStartedAt: () => null,
    describeItem: () => "stage",
    hubOwner: () => "agent-hub",
    agentHubPid: () => 42,
    modelLabel: (value) => value,
    runtimeLabel: (value) => value,
    delay: async () => {},
    reasoningLabels: {},
    logger: { warn() {} },
    reindexRun: () => {},
  });

  const snapshot = await service.read({
    observer: false,
    threadId: "thread-1",
    turnId: "user-turn",
  });

  assert.equal(snapshot.turnId, "user-turn");
  assert.deepEqual(selected.map((turn) => turn.id), ["user-turn"]);
  assert.equal(readOptions[0].priority, "interactive");
});

test("Codex snapshot service reads a delayed final answer and applies runtime projection", async () => {
  let reads = 0;
  const service = new CodexTaskSnapshotService({
    knownRolloutPath: async () => "", readRolloutActivity: async () => ({}), rolloutTurnState: () => ({}),
    capturedOwner: () => null, runtimeActive: async () => true, resolveOwner: async () => "agent-hub",
    readThread: async () => ({ thread: { turns: [{ id: "turn-1", status: "completed", items: reads++
      ? [{ type: "agentMessage", text: "final", phase: "final_answer" }]
      : [{ type: "agentMessage", text: "still working", phase: "commentary" }] }] } }),
    selectTurn: () => null, turnSnapshot: () => ({}), turnStartedAt: () => null,
    describeItem: () => "", hubOwner: () => "agent-hub", agentHubPid: () => 1,
    modelLabel: (value) => `model:${value}`,
    reasoningLabels: { high: "High" },
    runtimeLabel: (value) => `runtime:${value}`,
    delay: async () => {},
    reindexRun: () => {},
    logger: { warn() {} },
  });
  const run = { threadId: "thread-1", responseText: "partial", executionOwner: "agent-hub" };
  assert.equal(await service.completedAnswer(run, "turn-1"), "final");
  service.applyObserved(run, { turnId: "turn-1", model: "gpt", reasoningEffort: "high" });
  service.applyActive(run, { activeTurnCount: 2 });
  assert.equal(run.turnId, "turn-1");
  assert.equal(run.model, "model:gpt");
  assert.equal(run.reasoning, "High");
  assert.equal(run.appServer, "runtime:agent-hub");
  assert.equal(run.activeTurnCount, 2);
});

test("Codex snapshot service does not freeze a partial turn completed payload", async () => {
  let rolloutReads = 0;
  const delays = [];
  const service = new CodexTaskSnapshotService({
    knownRolloutPath: async () => "rollout.jsonl",
    readRolloutActivity: async () => ({
      finalMessages: rolloutReads++ >= 2
        ? { "turn-1": "Полный финальный ответ после materialization" }
        : {},
    }),
    rolloutTurnState: () => ({}), capturedOwner: () => null,
    runtimeActive: async () => true, resolveOwner: async () => "agent-hub",
    readThread: async () => ({ thread: { turns: [{
      id: "turn-1",
      status: "completed",
      items: [{ type: "agentMessage", text: "Обрезанный финал", phase: "final_answer" }],
    }] } }),
    selectTurn: () => null, turnSnapshot: () => ({}), turnStartedAt: () => null,
    describeItem: () => "", hubOwner: () => "agent-hub", agentHubPid: () => 1,
    modelLabel: (value) => value, reasoningLabels: {}, runtimeLabel: (value) => value,
    delay: async (waitMs) => { delays.push(waitMs); },
    reindexRun: () => {}, logger: { warn() {} },
  });

  const answer = await service.completedAnswer(
    { threadId: "thread-1", responseText: "Обрезанный финал" },
    "turn-1",
    {
      id: "turn-1",
      status: "completed",
      items: [{ type: "agentMessage", text: "Обрезанный финал", phase: "final_answer" }],
    },
  );

  assert.equal(answer, "Полный финальный ответ после materialization");
  assert.deepEqual(delays, [100]);
});

test("Codex snapshot service never promotes commentary to a completed answer", async () => {
  const service = new CodexTaskSnapshotService({
    knownRolloutPath: async () => "", readRolloutActivity: async () => ({}), rolloutTurnState: () => ({}),
    capturedOwner: () => null, runtimeActive: async () => true, resolveOwner: async () => "agent-hub",
    readThread: async () => ({ thread: { turns: [{
      id: "turn-1",
      status: "completed",
      items: [{ type: "agentMessage", text: "still working", phase: "commentary" }],
    }] } }),
    selectTurn: () => null, turnSnapshot: () => ({}), turnStartedAt: () => null,
    describeItem: () => "", hubOwner: () => "agent-hub", agentHubPid: () => 1,
    modelLabel: (value) => value, reasoningLabels: {}, runtimeLabel: (value) => value,
    delay: async () => {}, reindexRun: () => {}, logger: { warn() {} },
  });

  assert.equal(await service.completedAnswer({
    threadId: "thread-1",
    responseText: "still working",
  }, "turn-1", {
    id: "turn-1",
    status: "completed",
    items: [{ type: "agentMessage", text: "still working", phase: "commentary" }],
  }), "");
});

test("Codex observed snapshot keeps rollout grouping and enriches known tool activity", () => {
  const service = new CodexTaskSnapshotService({
    knownRolloutPath: async () => "", readRolloutActivity: async () => ({}), rolloutTurnState: () => ({}),
    capturedOwner: () => null, runtimeActive: async () => true, resolveOwner: async () => "agent-hub",
    readThread: async () => ({ thread: {} }), selectTurn: () => null, turnSnapshot: () => ({}),
    turnStartedAt: () => null, describeItem: () => "", hubOwner: () => "agent-hub", agentHubPid: () => 1,
    modelLabel: (value) => value, reasoningLabels: {}, runtimeLabel: (value) => value,
    delay: async () => {}, reindexRun: () => {}, logger: { warn() {} },
  });
  const run = {
    activities: [{ id: "item:tool-1", type: "command", label: "Команда выполнена", detail: "git status --short" }],
  };
  service.applyObserved(run, {
    activityGroups: [{
      id: "comment-1",
      reasoning: "Проверяю.",
      activities: [{ id: "item:tool-1", type: "tool", label: "Инструмент завершён", detail: "shell_command" }],
    }],
  });

  assert.equal(run.activityGroups[0].reasoning, "Проверяю.");
  assert.equal(run.activityGroups[0].activities[0].type, "command");
  assert.equal(run.activityGroups[0].activities[0].detail, "git status --short");
});

test("Codex snapshot service prefers the exact rollout answer for an interrupted rotated turn", async () => {
  let threadReads = 0;
  const service = new CodexTaskSnapshotService({
    knownRolloutPath: async () => "rotated-rollout.jsonl",
    readRolloutActivity: async () => ({
      finalMessages: {},
      latestMessages: { "turn-rotated": "Аудит остановлен после анализа архитектуры" },
    }),
    rolloutTurnState: () => ({}), capturedOwner: () => null,
    runtimeActive: async () => true, resolveOwner: async () => "agent-hub",
    readThread: async () => {
      threadReads += 1;
      return { thread: { turns: [{
        id: "turn-rotated",
        status: "completed",
        items: [{ type: "agentMessage", text: "Старый ответ про VPN", phase: "final_answer" }],
      }] } };
    },
    selectTurn: () => null, turnSnapshot: () => ({}), turnStartedAt: () => null,
    describeItem: () => "", hubOwner: () => "agent-hub", agentHubPid: () => 1,
    modelLabel: (value) => value, reasoningLabels: {}, runtimeLabel: (value) => value,
    delay: async () => {}, reindexRun: () => {}, logger: { warn() {} },
  });

  const answer = await service.completedAnswer(
    { threadId: "thread-rotated", responseText: "" },
    "turn-rotated",
    { id: "turn-rotated", status: "interrupted", items: [] },
  );

  assert.equal(answer, "Аудит остановлен после анализа архитектуры");
  assert.equal(threadReads, 0);
});
