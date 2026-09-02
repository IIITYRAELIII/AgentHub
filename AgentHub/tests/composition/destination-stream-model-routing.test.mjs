import assert from "node:assert/strict";
import test from "node:test";

import { ManagedRunLifecycleService } from "../../src/application/managed-run-lifecycle-service.mjs";
import { RunCoordinator } from "../../src/application/run-coordinator.mjs";
import { TaskRunRegistry } from "../../src/domain/task-runs.mjs";
import { DesktopTaskService } from "../../src/interfaces/desktop/desktop-task-service.mjs";

const entries = [{
  streamId: "stream-a",
  workspaceName: "Agent HUB",
  streamName: "Destination A",
  provider: "codex",
  projectRoot: "D:/Work",
  threadId: "thread-a",
  model: "GPT-5.3-Codex-Spark",
}, {
  streamId: "stream-b",
  workspaceName: "Agent HUB",
  streamName: "Selected B",
  provider: "codex",
  projectRoot: "D:/Work",
  threadId: "thread-b",
  model: "Fake Codex",
}];

function productionRoute({ externalActivity = async () => ({ state: "inactive" }) } = {}) {
  let selectedTarget = {
    provider: "codex",
    projectRoot: "D:/Work",
    streamId: "stream-b",
    threadId: "thread-b",
    taskTitle: "Selected B",
    chatId: 7,
  };
  const taskRuns = new TaskRunRegistry();
  const desktop = new DesktopTaskService({
    catalog: () => entries,
    refreshCatalog: async () => entries,
    activateBinding: async () => ({ changed: false }),
    snapshot: async () => ({}),
    taskHistory: async () => ({}),
    dispatchCommand: async () => ({}),
    commandTaskTarget: (value) => value,
    readTurn: async () => null,
    threadsForStream: (streamId) => entries
      .filter((entry) => entry.streamId === streamId)
      .map((entry) => ({ provider: entry.provider, threadId: entry.threadId })),
    currentThread: (streamId) => {
      const entry = entries.find((candidate) => candidate.streamId === streamId);
      return entry ? { provider: entry.provider, threadId: entry.threadId } : null;
    },
    samePath: (left, right) => left === right,
    chatId: () => 7,
  });
  const lifecycle = new ManagedRunLifecycleService({
    taskRuns,
    currentTarget: () => selectedTarget,
    findProject: () => ({ name: "Work" }),
    codexSettings: () => ({}),
    currentPreferences: () => ({
      model: "selected-b-model",
      defaultModel: "fake-codex",
      reasoningEffort: "high",
      defaultReasoningEffort: "high",
      collaborationMode: "default",
    }),
    normalizeCodexModel: (value) => ({
      "GPT-5.3-Codex-Spark": "gpt-5.3-codex-spark",
      "Fake Codex": "fake-codex",
    })[value] ?? String(value).toLowerCase(),
    modelLabel: (value) => value,
    claudeModelLabels: {},
    reasoningLabels: { high: "High" },
    persistTaskDiff: async () => {},
    syncRun: () => {},
    invalidateCatalog: () => {},
    saveState: async () => {},
    scheduleProgressStart: () => {},
    clearSelectedDiff: () => {},
    clearApprovals: () => {},
    pauseObservation: () => {},
    pauseClaude: () => {},
    stopTyping: () => {},
    beforeCompletion: async () => {},
    completionAborted: async () => {},
    afterCompletion: async () => {},
  });
  const coordinator = new RunCoordinator({
    taskRuns,
    providers: { call: async () => ({}) },
    externalActivity,
    repositoryConflict: async () => null,
    deferInput: async () => assert.fail("destination run must not be deferred"),
    beginRun: (input, target) => lifecycle.begin(input, target),
    rollbackAdmission: async () => {},
    launchTurn: async (run) => { run.turnId = `turn-${run.streamId}`; },
  });
  return {
    coordinator,
    desktop,
    select: (target) => { selectedTarget = target; },
  };
}

test("non-selected destination Stream keeps its catalog model through production admission", async () => {
  const route = productionRoute();
  const target = await route.desktop.resolveTarget({ streamId: "stream-a" });

  const result = await route.coordinator.start("run A", [], { target });

  assert.equal(target.threadId, "thread-a");
  assert.equal(target.modelId, "GPT-5.3-Codex-Spark");
  assert.equal(result.run.streamId, "stream-a");
  assert.equal(result.run.threadId, "thread-a");
  assert.equal(result.run.modelId, "gpt-5.3-codex-spark");
  assert.notEqual(result.run.modelId, "fake-codex");
});

test("destination model is stable when selection changes during concurrent admission", async () => {
  let admit;
  let entered;
  const admissionEntered = new Promise((resolve) => { entered = resolve; });
  const admissionGate = new Promise((resolve) => { admit = resolve; });
  const route = productionRoute({
    externalActivity: async () => {
      entered();
      await admissionGate;
      return { state: "inactive" };
    },
  });
  const target = await route.desktop.resolveTarget({ streamId: "stream-a" });
  const pending = route.coordinator.start("run A after selection race", [], { target });
  await admissionEntered;

  route.select({
    provider: "codex",
    projectRoot: "D:/Other",
    streamId: "stream-c",
    threadId: "thread-c",
    taskTitle: "New selection C",
    chatId: 9,
  });
  admit();
  const result = await pending;

  assert.equal(result.run.streamId, "stream-a");
  assert.equal(result.run.threadId, "thread-a");
  assert.equal(result.run.modelId, "gpt-5.3-codex-spark");
});
