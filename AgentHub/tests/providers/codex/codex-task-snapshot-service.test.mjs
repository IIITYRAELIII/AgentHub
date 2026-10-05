import assert from "node:assert/strict";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  CodexTaskSnapshotService,
  codexTurnSnapshot,
  describeCodexItem,
} from "../../../src/providers/codex/codex-task-snapshot-service.mjs";
import { codexRolloutTurnState, readCodexRolloutActivity } from "../../../src/providers/codex/codex-rollout-activity.mjs";
import { CodexRecoveryService } from "../../../src/providers/provider-recovery-services.mjs";

test("active commentary stays in its trace and never becomes an answer or final", () => {
  const snapshot = codexTurnSnapshot({
    id: "active-turn", status: "inProgress",
    items: [
      { id: "prompt", type: "userMessage", content: [{ type: "text", text: "Continue" }] },
      { id: "comment-1", type: "agentMessage", phase: "commentary", text: "Working" },
      { id: "comment-2", type: "agentMessage", phase: "commentary", text: "Working" },
      { id: "reasoning-1", type: "reasoning", summary: [] },
    ],
  });
  assert.equal(snapshot.active, true);
  assert.equal(snapshot.completed, false);
  assert.equal(snapshot.answer, "");
  assert.equal(snapshot.finalAnswer, "");
  assert.deepEqual(snapshot.activityGroups.map((group) => group.reasoning), ["Working", "Working"]);
  assert.notEqual(snapshot.activityGroups[0].id, snapshot.activityGroups[1].id);
});

test("a streaming final remains visible even when its text equals commentary", () => {
  const snapshot = codexTurnSnapshot({
    id: "active-turn", status: "inProgress",
    items: [
      { id: "prompt", type: "userMessage", content: [{ type: "text", text: "Continue" }] },
      { id: "comment", type: "agentMessage", phase: "commentary", text: "Same text" },
      { id: "final", type: "agentMessage", phase: "final_answer", text: "Same text" },
    ],
  });
  assert.equal(snapshot.active, true);
  assert.equal(snapshot.completed, false);
  assert.equal(snapshot.answer, "Same text");
  assert.equal(snapshot.finalAnswer, "Same text");
  assert.equal(snapshot.activityGroups[0].reasoning, "Same text");
});

test("completed reasoning describes its stage without claiming the turn finished", () => {
  assert.equal(describeCodexItem({ type: "reasoning" }, true), "Этап анализа завершён; ход продолжается.");
  assert.equal(codexTurnSnapshot({ status: "completed", items: [] }).stage, "Поток завершён.");
});

test("async question final phase is a form, not a final answer, including an interrupted turn", () => {
  for (const status of ["inProgress", "interrupted", "completed"]) {
    const question = { id: "question", type: "agentMessage", phase: "final_answer",
      text: "Choose a profile", questions: [{ title: "Profile?", options: ["A", "B"] }] };
    const snapshot = codexTurnSnapshot({
      id: "question-turn", status,
      items: [
        { id: "prompt", type: "userMessage", content: [{ type: "text", text: "Continue" }] },
        { id: "comment", type: "agentMessage", phase: "commentary", text: "Working" },
        question,
      ],
    });
    assert.equal(snapshot.answer, "");
    assert.equal(snapshot.finalAnswer, "");
    assert.equal(snapshot.activityGroups[0].reasoning, "Working");
    assert.deepEqual(question.questions, [{ title: "Profile?", options: ["A", "B"] }]);
  }
});

test("managed snapshot never adopts a dangling historical turn before provider acceptance", async () => {
  let reads = 0;
  const activity = {
    activeTurnIds: ["old-turn"],
    startedAtMsByTurnId: { "old-turn": Date.parse("2026-08-24T07:24:23.359Z") },
    completedAtMsByTurnId: { "new-turn": Date.parse("2026-09-09T11:16:16.277Z") },
    finalMessages: { "new-turn": "Current answer" },
    terminalStatusesByTurnId: { "new-turn": "completed" },
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
      return { thread: { path: "rollout.jsonl",
        turns: [{ id: "old-turn", status: "interrupted", items: [] }], status: { type: "idle" } } };
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

test("cold exact snapshot recovers an old terminal beyond 16 MiB while another turn stays unknown", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hub-cold-terminal-"));
  const file = path.join(directory, "rollout.jsonl");
  const completedTurnId = "01a0ecf9-094f-7390-aed5-b979128ff553";
  const pendingTurnId = "01a0ecfb-d1fa-7e20-a64e-02cf4902e19b";
  const laterTurnId = "01a0ed07-704f-7f93-b2d6-5c1ab1732f92";
  const row = (type, turnId, extra = {}) => JSON.stringify({
    timestamp: "2026-09-29T11:45:00.000Z", type: "event_msg",
    payload: { type, turn_id: turnId, ...extra },
  });
  try {
    await writeFile(file, [
      JSON.stringify({ timestamp: "2026-09-29T11:40:00.000Z", type: "session_meta",
        payload: { id: "01a07cd5-d039-7fd3-95c4-71f3672f8d52" } }),
      row("task_started", completedTurnId),
      row("task_complete", completedTurnId, { last_agent_message: "Точный финал" }),
      row("task_started", pendingTurnId),
      ...Array.from({ length: 4_200 }, () => row("unrelated", laterTurnId, { padding: "x".repeat(4_096) })),
      ...Array.from({ length: 130 }, (_, index) => row("task_complete", `later-${index}`,
        { last_agent_message: `Later final ${index}` })),
    ].join("\n") + "\n", "utf8");
    const service = new CodexTaskSnapshotService({
      knownRolloutPath: async () => file,
      readRolloutActivity: readCodexRolloutActivity,
      rolloutTurnState: codexRolloutTurnState,
      capturedOwner: () => null, runtimeActive: async () => true, resolveOwner: async () => "agent-hub",
      readThread: async () => ({ thread: { path: file, status: { type: "idle" },
        turns: [{ id: laterTurnId, status: "interrupted", items: [] }] } }),
      selectTurn: (turns, { requestedTurnId }) => turns.find((turn) => turn.id === requestedTurnId) ?? null,
      turnSnapshot: codexTurnSnapshot, turnStartedAt: () => null, describeItem: () => "stage",
      hubOwner: () => "agent-hub", agentHubPid: () => 1,
      modelLabel: (value) => value, runtimeLabel: (value) => value,
      delay: async () => {}, reindexRun: () => {},
    });
    const completed = await service.read({ provider: "codex", threadId: "thread-1",
      turnId: completedTurnId, observer: false });
    assert.equal(completed?.completed, true);
    assert.equal(completed?.status, "completed");
    assert.equal(completed?.answer, "Точный финал");
    const recoveryEvents = [];
    const recovery = new CodexRecoveryService({
      transportRunning: () => true,
      readTaskSnapshot: (run, options) => service.read(run, options),
      startTransport: async () => {}, initialize: async () => {}, isCodex: () => true,
      finishInterrupted: async () => assert.fail("Cold terminal cannot be inferred as interruption"),
      readThread: async (_threadId, { applySnapshot }) => applySnapshot({
        thread: { path: file, status: { type: "idle" },
          turns: [{ id: laterTurnId, status: "interrupted", items: [] }] },
      }),
      autoApprove: () => false, restartRequested: () => false,
      finishProgress: async () => recoveryEvents.push("finish"),
      completeRun: async () => assert.fail("Only terminal owner may complete"),
      recoveredAnswer: () => "", setProgressStage: () => recoveryEvents.push("unknown"),
      launchTurn: async () => assert.fail("Recovery cannot resend the input"), reindexRun: () => {},
      scheduleObservedRun: () => recoveryEvents.push("observe"), startTyping: () => {},
      saveState: async () => recoveryEvents.push("save"), telegram: async () => {},
      consumeTracker: () => null,
      finalizeDelivery: async (_run, terminal) => recoveryEvents.push([
        "terminal", terminal.turnId, terminal.status, terminal.answer,
      ]),
      turnTokenUsage: new Map(),
    });
    await recovery.recover({ provider: "codex", threadId: "thread-1", turnId: completedTurnId,
      status: "running", responseText: "", progressMessageIds: [] });
    assert.deepEqual(recoveryEvents, ["finish",
      ["terminal", completedTurnId, "completed", "Точный финал"]]);
    for (const _ of [0, 1]) {
      const pending = await service.read({ provider: "codex", threadId: "thread-1",
        turnId: pendingTurnId, observer: false });
      assert.equal(pending?.completed, false);
      assert.equal(pending?.activityUnknown, true);
    }
    await appendFile(file, `${row("turn_aborted", pendingTurnId)}\n`, "utf8");
    const aborted = await service.read({ provider: "codex", threadId: "thread-1",
      turnId: pendingTurnId, observer: false });
    assert.equal(aborted?.completed, true);
    assert.equal(aborted?.status, "aborted");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
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
  let completedReads = 0;
  const delays = [];
  const service = new CodexTaskSnapshotService({
    knownRolloutPath: async () => "rollout.jsonl",
    readCompletedTurnAnswer: async () => { completedReads += 1; return ""; },
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
  assert.equal(completedReads, 1);
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
    readCompletedTurnAnswer: async () => { throw new Error("completed reader entered for interrupted turn"); },
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
