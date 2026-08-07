import assert from "node:assert/strict";
import test from "node:test";
import {
  CodexTaskSnapshotService,
  codexTurnSnapshot,
} from "../../../src/providers/codex/codex-task-snapshot-service.mjs";

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
    readRolloutActivity: async () => ({ activeTurnIds: ["turn-1"], activityAtMsByTurnId: {}, running: true }),
    rolloutTurnState: () => ({
      turnId: "turn-1", active: true, completed: false, latestAnswer: "Now", finalAnswer: "",
      userMessages: [{ text: "Do" }], startedAt: "2026-08-04T10:00:00.000Z",
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
});

test("Codex snapshot service reads a delayed final answer and applies runtime projection", async () => {
  let reads = 0;
  const service = new CodexTaskSnapshotService({
    knownRolloutPath: async () => "", readRolloutActivity: async () => ({}), rolloutTurnState: () => ({}),
    capturedOwner: () => null, runtimeActive: async () => true, resolveOwner: async () => "agent-hub",
    readThread: async () => ({ thread: { turns: [{ id: "turn-1", status: "completed", items: reads++
      ? [{ type: "agentMessage", text: "final", phase: "final_answer" }]
      : [] }] } }),
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
