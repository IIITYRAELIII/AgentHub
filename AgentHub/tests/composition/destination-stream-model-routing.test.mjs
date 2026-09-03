import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { DeferredInputService } from "../../src/application/deferred-input-service.mjs";
import { DeferredInputStore } from "../../src/application/deferred-input-store.mjs";
import { ManagedRunLifecycleService } from "../../src/application/managed-run-lifecycle-service.mjs";
import { RunCoordinator } from "../../src/application/run-coordinator.mjs";
import { TaskRunRegistry } from "../../src/domain/task-runs.mjs";
import { RuntimeStateStore } from "../../src/infrastructure/persistence/runtime-state-store.mjs";
import { DesktopTaskService } from "../../src/interfaces/desktop/desktop-task-service.mjs";
import { destinationStreamSettings } from "../../src/composition/desktop-command-wiring-composition.mjs";

const entries = [{
  streamId: "stream-a",
  workspaceName: "Agent HUB",
  streamName: "Destination A",
  provider: "codex",
  projectRoot: "D:/Work",
  threadId: "thread-a",
  model: null,
}, {
  streamId: "stream-b",
  workspaceName: "Agent HUB",
  streamName: "Selected B",
  provider: "codex",
  projectRoot: "D:/Work",
  threadId: "thread-b",
  model: null,
}];

const streamSettings = new Map([
  ["stream-a", { provider: "codex", model: "gpt-5.3-codex-spark" }],
  ["stream-b", { provider: "codex", model: "fake-codex" }],
]);
const workspaceCatalog = {
  stream: (streamId) => ({ settings: streamSettings.get(streamId) ?? {} }),
};

function productionRoute({
  externalActivity = async () => ({ state: "inactive" }),
  deferInput = async () => assert.fail("destination run must not be deferred"),
  scheduleDeferred = () => {},
} = {}) {
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
    streamSettings: (streamId) => destinationStreamSettings(workspaceCatalog, streamId),
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
    deferInput,
    beginRun: (input, target) => lifecycle.begin(input, target),
    rollbackAdmission: async () => {},
    launchTurn: async (run) => { run.turnId = `turn-${run.streamId}`; },
    scheduleDeferred,
  });
  return {
    coordinator,
    desktop,
    select: (target) => { selectedTarget = target; },
  };
}

test("catalog-missing destination model survives the durable ledger and production admission", async (context) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "agent-hub-destination-model-"));
  const runtimeState = new RuntimeStateStore({ dataDir });
  context.after(async () => {
    await runtimeState.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const deferredStore = new DeferredInputStore();
  const deferredInputs = new DeferredInputService({
    store: deferredStore,
    createId: () => "destination-a-input",
    persist: async () => assert.fail("durable intake must use the command ledger"),
    persistIntake: (item, destination, receipt) => runtimeState.saveDeferredIntake({
      item,
      destination,
      receipt,
    }),
    removeFiles: async () => {},
    notify: async () => null,
  });
  let scheduledItem = null;
  const route = productionRoute({
    deferInput: (...args) => deferredInputs.defer(...args),
    scheduleDeferred: (item) => { scheduledItem = item; },
  });
  const target = await route.desktop.resolveTarget({ streamId: "stream-a" });

  const accepted = await route.coordinator.acceptClientInput({
    input: "run A",
    target,
    clientUserMessageId: "destination-a-command",
    messageFingerprint: "destination-a-fingerprint",
  });
  const [ledgerRecord] = runtimeState.messageCommands();
  route.select({
    provider: "codex",
    projectRoot: "D:/Other",
    streamId: "stream-c",
    threadId: "thread-c",
    taskTitle: "Concurrent selection C",
    chatId: 9,
  });
  const run = await route.coordinator.startDeferred(scheduledItem);

  assert.equal(target.threadId, "thread-a");
  assert.equal(target.modelId, "gpt-5.3-codex-spark");
  assert.equal(accepted.accepted, true);
  assert.equal(ledgerRecord.item.modelId, "gpt-5.3-codex-spark");
  assert.equal(scheduledItem.modelId, "gpt-5.3-codex-spark");
  assert.equal(run.streamId, "stream-a");
  assert.equal(run.threadId, "thread-a");
  assert.equal(run.modelId, "gpt-5.3-codex-spark");
  assert.notEqual(run.modelId, "fake-codex");
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
