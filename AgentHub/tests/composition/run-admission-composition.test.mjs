import assert from "node:assert/strict";
import test from "node:test";

import {
  contextCompactionRunIsInternal,
  createRunAdmissionComposition,
} from "../../src/composition/run-admission-composition.mjs";
import { claudeCompactionClientId } from "../../src/domain/claude-context-maintenance.mjs";

function admissionFixture({ handoff = "PACKAGE", consume = null } = {}) {
  const launches = [];
  const consumed = [];
  const composition = createRunAdmissionComposition({
    config: { deferredInputTtlHours: 24, maxDeferredInputs: 10 },
    agentProviders: {
      call: async (provider, operation, run, input) => {
        launches.push({ provider, operation, input });
        return { launched: true };
      },
    },
    taskRuns: { forTask: () => null },
    pendingInputs: new Map(),
    queuedInputs: new Map(),
    stageLaunchAdmission: () => true,
    abortLaunchAdmission: () => true,
    streamHandoff: {
      consume: async (target) => {
        consumed.push(target);
        return consume ? consume(target) : handoff;
      },
    },
    logger: { warn() {}, error() {} },
  });
  return { composition, launches, consumed };
}

test("standalone automatic compaction is internal but mid-turn compaction is not", () => {
  const compaction = { origin: "automatic", turnId: "compact-turn" };
  assert.equal(contextCompactionRunIsInternal({
    turnId: "compact-turn",
    promptPreview: "",
    responseText: "",
    userMessages: [],
  }, compaction), true);
  assert.equal(contextCompactionRunIsInternal({
    turnId: "compact-turn",
    promptPreview: "Продолжай",
    responseText: "",
    userMessages: [{ text: "Продолжай" }],
  }, compaction), false);
  assert.equal(contextCompactionRunIsInternal({
    turnId: "compact-turn",
    promptPreview: "",
    responseText: "Новый ответ",
    userMessages: [],
  }, compaction), false);
});

test("manual compaction is internal even if its observer inherited stale text", () => {
  assert.equal(contextCompactionRunIsInternal({
    turnId: "compact-turn",
    promptPreview: "Старый запрос",
    responseText: "Старый ответ",
  }, {
    origin: "manual",
    turnId: "compact-turn",
  }), true);
});

test("the first turn of a handed over Stream carries the Hub handoff package", async () => {
  const { composition, launches, consumed } = admissionFixture();
  await composition.launchTurn(
    { provider: "claude", threadId: "thread-2", streamId: "stream-1" },
    [{ type: "text", text: "продолжай" }],
  );
  assert.deepEqual(consumed, [{
    streamId: "stream-1",
    provider: "claude",
    threadId: "thread-2",
  }]);
  assert.deepEqual(launches[0].input, [
    { type: "text", text: "PACKAGE" },
    { type: "text", text: "продолжай" },
  ]);
});

test("marker-shaped user input consumes its pending handoff package normally", async () => {
  const { composition, launches, consumed } = admissionFixture();
  await composition.launchTurn(
    {
      provider: "codex",
      threadId: "thread-2",
      streamId: "stream-1",
      clientUserMessageId: "ordinary-client-id",
    },
    "Ответь строго: AGENT_HUB_CONTEXT_PROBE_OK_V1",
  );
  assert.equal(consumed.length, 1);
  assert.equal(launches[0].input, "PACKAGE\n\nОтветь строго: AGENT_HUB_CONTEXT_PROBE_OK_V1");
});

test("a Claude context compaction command is launched without a handoff prefix", async () => {
  const { composition, launches, consumed } = admissionFixture();
  await composition.launchTurn(
    {
      provider: "claude",
      threadId: "thread-2",
      streamId: "stream-1",
      clientUserMessageId: claudeCompactionClientId(),
    },
    "/compact",
  );
  assert.deepEqual(consumed, []);
  assert.equal(launches[0].input, "/compact");
});

test("a failing handoff build still launches the turn with the original input", async () => {
  const { composition, launches } = admissionFixture({
    consume: () => { throw new Error("journal unavailable"); },
  });
  await composition.launchTurn(
    { provider: "claude", threadId: "thread-2", streamId: "stream-1" },
    "продолжай",
  );
  assert.equal(launches[0].input, "продолжай");
});

test("a turn outside any Stream is launched without touching the handoff store", async () => {
  const { composition, launches, consumed } = admissionFixture();
  await composition.launchTurn({ provider: "codex", threadId: "thread-9" }, "привет");
  assert.deepEqual(consumed, []);
  assert.equal(launches[0].input, "привет");
});

test("durable interstream steer keeps origin and exact target behind a managed barrier", async () => {
  const queuedInputs = new Map();
  const pendingInputs = new Map();
  const activeRun = {
    id: "run-1", provider: "codex", streamId: "stream-1", threadId: "thread-1",
    turnId: "turn-1", status: "running", executionOwner: "hub",
  };
  let barrierActive = true;
  const observedTargets = [];
  const runCoordinator = {
    activeRun: () => activeRun,
    admissionBarrier: () => barrierActive ? "context-maintenance" : null,
    deferredOccupancy: async () => ({ occupied: true, run: activeRun }),
    taskLane: () => "stream-1:thread-1",
    steer: async ({ target, clientUserMessageId }) => {
      observedTargets.push(target);
      return {
        accepted: true,
        steered: true,
        runId: activeRun.id,
        turnId: activeRun.turnId,
        clientUserMessageId,
      };
    },
    startDeferred: async () => { throw new Error("unexpected start"); },
  };
  const origin = {
    kind: "interstream",
    workspaceId: "workspace-1",
    workspaceName: "Agent HUB",
    streamId: "stream-source",
    streamName: "Sirius",
    provider: "codex",
    sourceThreadId: "thread-source",
    requestId: "request-steer",
  };
  const item = {
    id: "queued-steer",
    provider: "codex",
    streamId: "stream-1",
    projectRoot: "D:/Work",
    threadId: "thread-1",
    taskTitle: "Task",
    input: "уточнение",
    clientUserMessageId: "mcp:request-steer",
    conflictKind: "message-steer",
    steerTargetRunId: "run-1",
    steerTargetTurnId: "turn-1",
    messageOrigin: origin,
  };
  queuedInputs.set(item.id, item);
  const composition = createRunAdmissionComposition({
    config: { deferredInputTtlHours: 24, maxDeferredInputs: 10 },
    samePath: (left, right) => left === right,
    sendRpc: async () => ({}),
    contextCompactions: { get: () => null },
    codexUsageTracker: { deleteTurn() {} },
    turnSpeechButtons: new Map(),
    turnTemporaryFiles: new Map(),
    taskProgress: { clear: async () => {} },
    managedRunLifecycle: { complete: async () => {}, adopt: async () => activeRun },
    agentProviders: { call: async () => null },
    taskRuns: { forTask: () => activeRun, reindex() {} },
    scheduleObservedRun() {},
    runCoordinator,
    runConflictPolicy: { check: async () => null },
    pendingInputs,
    queuedInputs,
    getSelectedTask: () => null,
    getActiveThreadTitle: () => "Task",
    getChatId: () => null,
    taskExecutionOwners: { EXTERNAL: "external" },
    deferredInputPresentation: {
      updateTelegramMessage: async () => {},
      updateDesktopReceipt: () => {},
    },
    sendMessageTo: async () => {},
    saveState: async () => {},
    stageLaunchAdmission: () => true,
    abortLaunchAdmission: () => true,
    logger: { warn() {}, error() {} },
  });

  await composition.processQueuedInput(item.id);
  assert.deepEqual(observedTargets, []);
  assert.equal(queuedInputs.get(item.id), item);

  barrierActive = false;
  await composition.processQueuedInput(item.id);

  assert.deepEqual(observedTargets, [{
    streamId: "stream-1",
    provider: "codex",
    projectRoot: "D:/Work",
    threadId: "thread-1",
    taskTitle: "Task",
    chatId: undefined,
    modelId: undefined,
    reasoningId: undefined,
    collaborationMode: undefined,
    steerTargetRunId: "run-1",
    steerTargetTurnId: "turn-1",
    messageOrigin: origin,
  }]);
  assert.equal(queuedInputs.has(item.id), false);
});
