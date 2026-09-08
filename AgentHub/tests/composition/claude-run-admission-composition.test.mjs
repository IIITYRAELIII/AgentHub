import assert from "node:assert/strict";
import test from "node:test";

import { ManagedRunLifecycleService } from "../../src/application/managed-run-lifecycle-service.mjs";
import { RunCoordinator } from "../../src/application/run-coordinator.mjs";
import { createProviderCatalogComposition } from "../../src/composition/provider-catalog-composition.mjs";
import { createRunAdmissionComposition } from "../../src/composition/run-admission-composition.mjs";
import { createClaudeRunAdmissionBoundary } from "../../src/composition/provider-application-composition.mjs";
import { TaskRunRegistry } from "../../src/domain/task-runs.mjs";
import { ClaudeContextMaintenanceService } from "../../src/providers/claude/claude-context-maintenance-service.mjs";
import {
  CLAUDE_EXTERNAL_OWNER_ACTIVE,
  CLAUDE_EXTERNAL_OWNER_UNKNOWN,
  ClaudeRuntimeOwner,
} from "../../src/providers/claude/claude-runtime-owner.mjs";

const NOW = Date.parse("2026-09-05T12:00:00.000Z");
const TARGET = Object.freeze({
  provider: "claude",
  projectRoot: "D:/Work",
  streamId: "stream-claude",
  threadId: "session-exact",
  taskTitle: "Claude",
  chatId: 7,
});

function productionProviderRegistry({ gate, taskRuns, startClaudeTurn }) {
  const asyncNull = async () => null;
  const asyncArray = async () => [];
  const noop = () => null;
  return createProviderCatalogComposition({
    taskSyncStore: { catalog: () => [] },
    workspaceCatalogStore: {
      hierarchy: () => [],
      assignCatalogEntries: (entries) => entries,
    },
    taskRuns,
    taskCatalogCacheMs: 0,
    runProject: () => ({ name: "Work" }),
    finalizeTaskCatalog: (entries) => entries,
    findProject: () => ({ name: "Work" }),
    saveState: asyncNull,
    codexProviderTasks: { discoverTasks: asyncArray, createTask: asyncNull },
    claudeProviderTasks: { createTask: asyncNull },
    codexCompletionService: { completeObserved: asyncNull, completeManaged: asyncNull },
    claudeCompletionService: { completeObserved: asyncNull, completeManaged: asyncNull },
    codexRecoveryService: { recover: asyncNull, readSnapshot: asyncNull, prepare: asyncNull },
    claudeRecoveryService: { recover: asyncNull },
    codexTurnService: { launch: asyncNull, steer: asyncNull, findByClientMessage: asyncNull },
    providerCancellationService: { cancelCodex: asyncNull, cancelClaude: asyncNull },
    readCodexTaskSnapshot: asyncNull,
    readCodexThread: asyncNull,
    applyCodexObservedSnapshot: noop,
    applyCodexActiveSnapshot: noop,
    startClaudeTurn,
    claudeTaskSnapshots: { applyManagedCancellation: noop, read: asyncNull },
    claudeRuntimeOwner: { state: async () => ({ known: false, hasLiveProcess: true }) },
    claudeRunAdmission: gate,
    backfillWorkLogPricingMetadata: asyncNull,
    readCodexThreadTitleHistories: asyncArray,
    rememberCodexRolloutPath: noop,
    capturedCodexExecutionOwner: noop,
    codexObservedRuntimeActive: () => false,
    codexTransportPid: noop,
    resolveCodexObservedExecutionOwner: noop,
    codexModelLabel: (value) => value,
    codexThreadResponseTitle: noop,
    pendingTaskTitle: noop,
    clearExpectedTitle: noop,
    pinnedTaskTitle: noop,
    reconcilePinnedTitle: asyncNull,
    savePinnedTaskTitles: asyncNull,
    sendRpc: asyncNull,
    auditClaudeTranscriptSnapshots: asyncArray,
    knownCodexRolloutPath: asyncNull,
    codexTransportRunning: () => false,
    ensureCodex: asyncNull,
    resolveCodexTaskActivity: noop,
  }).agentProviders;
}

function harness(snapshot) {
  let probeCalls = 0;
  const providerEffects = [];
  let launchEffect = async () => ({ accepted: true });
  const runtimeOwner = new ClaudeRuntimeOwner({
    platform: "win32",
    agentHubPid: 1,
    now: () => NOW,
    probe: async ({ generation }) => {
      probeCalls += 1;
      return {
        complete: snapshot.complete,
        generation,
        scannedAt: new Date(NOW + 1).toISOString(),
        owners: snapshot.owners ?? [],
        unreadableCandidateCount: snapshot.unreadableCandidateCount ?? 0,
      };
    },
  });
  const { claudeRunAdmission: gate } = createClaudeRunAdmissionBoundary({ runtimeOwner });
  const taskRuns = new TaskRunRegistry();
  const lifecycle = new ManagedRunLifecycleService({
    taskRuns,
    currentTarget: () => TARGET,
    findProject: () => ({ name: "Work" }),
    codexSettings: () => ({}),
    currentPreferences: () => ({
      model: "sonnet",
      reasoningEffort: null,
      collaborationMode: "default",
    }),
    normalizeCodexModel: (value) => value,
    modelLabel: (value) => value,
    claudeModelLabels: { sonnet: "Sonnet" },
    reasoningLabels: {},
    clearClaudeCancellation: () => {},
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
    prepareAdmission: (target) => gate.prepare(target),
    revokeAdmission: (run) => gate.revoke(run),
    beforeCompletion: async () => {},
    completionAborted: async () => {},
    afterCompletion: async () => {},
  });
  const providers = productionProviderRegistry({
    gate,
    taskRuns,
    startClaudeTurn: async (run, ...args) => {
      providerEffects.push(run);
      return launchEffect(run, ...args);
    },
  });
  const runAdmission = createRunAdmissionComposition({
    config: { deferredInputTtlHours: 24, maxDeferredInputs: 10 },
    agentProviders: providers,
    taskRuns,
    managedRunLifecycle: lifecycle,
    pendingInputs: new Map(),
    queuedInputs: new Map(),
    stageLaunchAdmission: (run) => gate.stageLaunch(run),
    abortLaunchAdmission: (run, ticket) => gate.abortLaunch(run, ticket),
    streamHandoff: { consume: async () => "HANDOFF" },
    logger: { warn() {}, error() {} },
  });
  const coordinator = new RunCoordinator({
    taskRuns,
    providers,
    externalActivity: async () => ({ state: "inactive", executionOwner: "external" }),
    repositoryConflict: async () => null,
    deferInput: async (_input, _files, options) => ({
      deferred: true,
      item: { id: "deferred", ...options.target },
    }),
    beginRun: (input, target) => lifecycle.begin(input, target),
    rollbackAdmission: (run) => lifecycle.releaseAdmission(run),
    launchTurn: runAdmission.launchTurn,
  });
  const compactions = {
    record: null,
    begin(threadId, options = {}) {
      this.record ??= { id: "compaction-1", threadId, status: "running", ...options };
      return this.record;
    },
    complete() {},
    fail() { if (this.record) this.record.status = "failed"; },
    get() { return this.record; },
  };
  const maintenance = new ClaudeContextMaintenanceService({
    compactions,
    beginRun: (input, target) => lifecycle.begin(input, target),
    launchTurn: runAdmission.launchTurn,
    activeRun: (target) => taskRuns.forTask(target),
    completeRun: (run) => lifecycle.complete(run),
  });
  return {
    coordinator,
    gate,
    lifecycle,
    maintenance,
    runAdmission,
    providers,
    taskRuns,
    probeCalls: () => probeCalls,
    providerEffects,
    setLaunchEffect: (effect) => { launchEffect = effect; },
  };
}

for (const scenario of [
  {
    name: "live exact external owner",
    snapshot: {
      complete: true,
      owners: [{ pid: 42, sessionId: TARGET.threadId }],
    },
    code: CLAUDE_EXTERNAL_OWNER_ACTIVE,
  },
  {
    name: "incomplete process inventory",
    snapshot: {
      complete: false,
      owners: [],
      unreadableCandidateCount: 1,
    },
    code: CLAUDE_EXTERNAL_OWNER_UNKNOWN,
  },
]) {
  test(`production Claude admission blocks manual and maintenance launch for ${scenario.name}`, async () => {
    const state = harness(scenario.snapshot);

    const manual = await state.coordinator.start("manual", [], { target: TARGET });
    assert.equal(manual.deferred, true);
    assert.equal(state.taskRuns.size, 0);
    assert.equal(state.providerEffects.length, 0);

    await assert.rejects(
      state.maintenance.startManual(TARGET),
      (error) => error?.code === scenario.code,
    );
    assert.equal(state.taskRuns.size, 0);
    assert.equal(state.providerEffects.length, 0);
    assert.equal(state.probeCalls(), 2, "each begin must obtain its own force-fresh inventory");
  });
}

test("production Claude provider launch rejects a run without the begin capability", async () => {
  const state = harness({ complete: true, owners: [] });
  await assert.rejects(
    state.runAdmission.launchTurn({ ...TARGET, id: "forged-run" }, "bypass", []),
    (error) => error?.code === CLAUDE_EXTERNAL_OWNER_UNKNOWN,
  );
  assert.equal(state.probeCalls(), 0);
  assert.equal(state.providerEffects.length, 0);
});

test("production staged admission consumes one exact Claude provider effect", async () => {
  const state = harness({ complete: true, owners: [] });
  const run = await state.lifecycle.begin("once", TARGET);

  await state.runAdmission.launchTurn(run, "once", []);
  await assert.rejects(
    state.runAdmission.launchTurn(run, "again", []),
    (error) => error?.code === CLAUDE_EXTERNAL_OWNER_UNKNOWN,
  );
  assert.deepEqual(state.providerEffects, [run]);
});

test("production staged admission rejects concurrent replay before a second provider effect", async () => {
  const state = harness({ complete: true, owners: [] });
  const run = await state.lifecycle.begin("once", TARGET);

  const first = state.runAdmission.launchTurn(run, "once", []);
  const replay = state.runAdmission.launchTurn(run, "again", []);
  await assert.rejects(replay, (error) => error?.code === CLAUDE_EXTERNAL_OWNER_UNKNOWN);
  await first;
  assert.deepEqual(state.providerEffects, [run]);
});

test("real provider registry atomically consumes a staged Claude launch", async () => {
  const state = harness({ complete: true, owners: [] });
  const run = await state.lifecycle.begin("once", TARGET);
  const ticket = state.gate.stageLaunch(run);

  const first = state.providers.call("claude", "launchTurn", run, "once", [], { launchAdmission: ticket });
  assert.throws(
    () => state.providers.call("claude", "launchTurn", run, "again", [], { launchAdmission: ticket }),
    (error) => error?.code === CLAUDE_EXTERNAL_OWNER_UNKNOWN,
  );
  await first;
  assert.deepEqual(state.providerEffects, [run]);
});

test("real provider registry rejects missing or wrong evidence without revoking the exact ticket", async () => {
  const state = harness({ complete: true, owners: [] });
  const run = await state.lifecycle.begin("once", TARGET);
  const ticket = state.gate.stageLaunch(run);

  assert.throws(
    () => state.providers.call("claude", "launchTurn", run, "missing", []),
    (error) => error?.code === CLAUDE_EXTERNAL_OWNER_UNKNOWN,
  );
  assert.throws(
    () => state.providers.call("claude", "launchTurn", run, "wrong", [], { launchAdmission: Object.freeze({}) }),
    (error) => error?.code === CLAUDE_EXTERNAL_OWNER_UNKNOWN,
  );
  await state.providers.call("claude", "launchTurn", run, "legitimate", [], { launchAdmission: ticket });
  assert.throws(
    () => state.providers.call("claude", "launchTurn", run, "replay", [], { launchAdmission: ticket }),
    (error) => error?.code === CLAUDE_EXTERNAL_OWNER_UNKNOWN,
  );
  assert.deepEqual(state.providerEffects, [run]);
});

test("production Claude launch capability remains consumed after provider failure", async () => {
  const state = harness({ complete: true, owners: [] });
  const run = await state.lifecycle.begin("once", TARGET);
  state.setLaunchEffect(async () => { throw new Error("controlled provider rejection"); });

  await assert.rejects(state.runAdmission.launchTurn(run, "once", []), /controlled provider rejection/u);
  await assert.rejects(
    state.runAdmission.launchTurn(run, "again", []),
    (error) => error?.code === CLAUDE_EXTERNAL_OWNER_UNKNOWN,
  );
  assert.deepEqual(state.providerEffects, [run]);
});

test("pre-effect input preparation failure revokes the staged Claude ticket", async () => {
  const state = harness({ complete: true, owners: [] });
  const run = await state.lifecycle.begin("once", TARGET);
  const invalidInput = new Proxy([], {
    get(target, property, receiver) {
      if (property === Symbol.iterator) throw new Error("controlled pre-effect failure");
      return Reflect.get(target, property, receiver);
    },
  });

  await assert.rejects(
    state.runAdmission.launchTurn(run, invalidInput, []),
    /controlled pre-effect failure/u,
  );
  await assert.rejects(
    state.runAdmission.launchTurn(run, "replay", []),
    (error) => error?.code === CLAUDE_EXTERNAL_OWNER_UNKNOWN,
  );
  assert.equal(state.providerEffects.length, 0);
});

test("managed completion revokes an unused or consumed Claude launch capability", async () => {
  const unused = harness({ complete: true, owners: [] });
  const unusedRun = await unused.lifecycle.begin("unused", TARGET);
  await unused.lifecycle.complete(unusedRun);
  await assert.rejects(
    unused.runAdmission.launchTurn(unusedRun, "late", []),
    (error) => error?.code === CLAUDE_EXTERNAL_OWNER_UNKNOWN,
  );
  assert.equal(unused.providerEffects.length, 0);

  const consumed = harness({ complete: true, owners: [] });
  const consumedRun = await consumed.lifecycle.begin("used", TARGET);
  await consumed.runAdmission.launchTurn(consumedRun, "used", []);
  await consumed.lifecycle.complete(consumedRun);
  await assert.rejects(
    consumed.runAdmission.launchTurn(consumedRun, "late", []),
    (error) => error?.code === CLAUDE_EXTERNAL_OWNER_UNKNOWN,
  );
  assert.deepEqual(consumed.providerEffects, [consumedRun]);
});

test("completion between stage and provider effect revokes the exact ticket", async () => {
  const state = harness({ complete: true, owners: [] });
  const run = await state.lifecycle.begin("staged", TARGET);
  const ticket = state.gate.stageLaunch(run);
  await state.lifecycle.complete(run);

  assert.throws(
    () => state.providers.call("claude", "launchTurn", run, "late", [], { launchAdmission: ticket }),
    (error) => error?.code === CLAUDE_EXTERNAL_OWNER_UNKNOWN,
  );
  assert.equal(state.providerEffects.length, 0);
});

test("forged run and copied proof cannot cross the exact run boundary", async () => {
  const state = harness({ complete: true, owners: [] });
  const run = await state.lifecycle.begin("original", TARGET);
  const forged = { ...run, id: "forged-run" };

  await assert.rejects(
    state.runAdmission.launchTurn(forged, "forged", []),
    (error) => error?.code === CLAUDE_EXTERNAL_OWNER_UNKNOWN,
  );
  assert.equal(state.providerEffects.length, 0);
});

test("real provider registry rejects a cross-run ticket without revoking either exact ticket", async () => {
  const state = harness({ complete: true, owners: [] });
  const first = await state.lifecycle.begin("first", TARGET);
  const second = await state.lifecycle.begin("second", {
    ...TARGET,
    streamId: "stream-other",
    threadId: "session-other",
  });
  const firstTicket = state.gate.stageLaunch(first);
  const secondTicket = state.gate.stageLaunch(second);

  assert.throws(
    () => state.providers.call("claude", "launchTurn", second, "cross-run", [], {
      launchAdmission: firstTicket,
    }),
    (error) => error?.code === CLAUDE_EXTERNAL_OWNER_UNKNOWN,
  );
  await state.providers.call("claude", "launchTurn", first, "first-legitimate", [], {
    launchAdmission: firstTicket,
  });
  await state.providers.call("claude", "launchTurn", second, "second-legitimate", [], {
    launchAdmission: secondTicket,
  });
  assert.throws(
    () => state.providers.call("claude", "launchTurn", first, "first-replay", [], {
      launchAdmission: firstTicket,
    }),
    (error) => error?.code === CLAUDE_EXTERNAL_OWNER_UNKNOWN,
  );
  assert.throws(
    () => state.providers.call("claude", "launchTurn", second, "second-replay", [], {
      launchAdmission: secondTicket,
    }),
    (error) => error?.code === CLAUDE_EXTERNAL_OWNER_UNKNOWN,
  );
  assert.deepEqual(state.providerEffects, [first, second]);
});

test("real provider registry rejects provider-confused Claude launch", () => {
  const state = harness({ complete: true, owners: [] });
  const codexRun = { ...TARGET, id: "codex-forged", provider: "codex" };

  assert.throws(
    () => state.providers.call("claude", "launchTurn", codexRun, "bypass", []),
    (error) => error?.code === CLAUDE_EXTERNAL_OWNER_UNKNOWN,
  );
  assert.equal(state.providerEffects.length, 0);
});
