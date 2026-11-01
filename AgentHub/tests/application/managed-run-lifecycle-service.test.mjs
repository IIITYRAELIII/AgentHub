import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { ManagedRunLifecycleService } from "../../src/application/managed-run-lifecycle-service.mjs";
import { createInterstreamMessage } from "../../src/domain/interstream-message.mjs";
import { TaskRunRegistry, createManagedTaskRun, serializableTaskRun, markProviderTurnRequested,
  markProviderTurnAccepted, localExecutionIdentity } from "../../src/domain/task-runs.mjs";
import { ProviderRunTerminalStore } from "../../src/infrastructure/persistence/provider-run-terminal-store.mjs";
import { restorePersistedTaskRun } from "../../src/composition/runtime-state-restoration-composition.mjs";
import { CodexRecoveryService } from "../../src/providers/provider-recovery-services.mjs";
import { RunCoordinator } from "../../src/application/run-coordinator.mjs";
import { createHubRuntimeSnapshot, restoreHubRuntimeSnapshot } from "../../src/application/hub-runtime-state-coordinator.mjs";
import { TaskSelectionStore } from "../../src/application/task-selection-store.mjs";

function harness({
  provider = "codex",
  currentTarget = null,
  codexSettings = null,
  currentPreferences = null,
  beforeCompletion = null,
  completionAborted = null,
  afterCompletion = null,
  prepareAdmission = null,
  revokeAdmission = null,
  saveState = null,
  commandTrace = null,
  recordProviderTerminal = null,
  persistTaskDiff = null,
  localRetirementStore = null,
  readSystemBootIdentity = null,
  afterLocalRetirement = null,
  readProviderTerminal = null,
} = {}) {
  const events = [];
  const taskRuns = new TaskRunRegistry();
  const service = new ManagedRunLifecycleService({
    taskRuns,
    commandTrace,
    localRetirementStore, readSystemBootIdentity, afterLocalRetirement,
    readProviderTerminal,
    currentTarget: currentTarget ?? (() => ({
      provider, projectRoot: "D:/Work", streamId: "stream-1", threadId: "thread-1", taskTitle: "Task", chatId: 7,
    })),
    findProject: () => ({ name: "Work" }),
    codexSettings: codexSettings ?? (() => ({})),
    currentPreferences: currentPreferences ?? (() => ({
      model: "gpt", defaultModel: "gpt", reasoningEffort: "high", defaultReasoningEffort: "high", collaborationMode: "default",
    })),
    normalizeCodexModel: (value) => String(value).toLowerCase(),
    modelLabel: (value) => value.toUpperCase(),
    claudeModelLabels: {}, reasoningLabels: { high: "High" },
    persistTaskDiff: persistTaskDiff ?? (async () => events.push("diff")),
    syncRun: (_run, options) => events.push(options?.active === false ? "sync-complete" : "sync-start"),
    invalidateCatalog: () => events.push("catalog"),
    saveState: saveState ?? (async () => events.push("save")),
    scheduleProgressStart: () => events.push("progress"),
    clearSelectedDiff: () => events.push("clear-diff"),
    clearApprovals: () => events.push("approvals"),
    pauseObservation: () => events.push("observer"),
    pauseClaude: () => events.push("claude"),
    stopTyping: () => events.push("typing"),
    prepareAdmission: prepareAdmission ?? (async () => null),
    revokeAdmission: revokeAdmission ?? (() => {}),
    beforeCompletion: beforeCompletion ?? (async () => events.push("before")),
    completionAborted: completionAborted ?? (async () => events.push("aborted")),
    afterCompletion: afterCompletion ?? (async () => events.push("after")),
    ...(recordProviderTerminal ? { recordProviderTerminal } : {}),
  });
  return { service, taskRuns, events };
}

test("managed run lifecycle commits the exact prepared launch capability", async () => {
  let authorizedTarget;
  let committedRun;
  const { service } = harness({
    provider: "claude",
    prepareAdmission: async (target) => {
      authorizedTarget = target;
      return { commit: (run) => { committedRun = run; } };
    },
  });

  const run = await service.begin("hello", {
    provider: "claude",
    projectRoot: "D:/Work",
    streamId: "stream-1",
    threadId: "thread-exact",
    taskTitle: "Claude",
  });

  assert.equal(authorizedTarget.threadId, "thread-exact");
  assert.equal(committedRun, run);
});

async function localRetirementFixture(t, overrides = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "hub392-local-retirement-"));
  const closers = [];
  t.after(async () => {
    for (const close of closers.reverse()) await close();
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(tmpdir()));
    assert.match(path.basename(directory), /^hub392-local-retirement-/u);
    await rm(directory, { recursive: true, force: true });
  });
  const store = new ProviderRunTerminalStore({ dataDir: directory });
  const wakes = [];
  const h = harness({
    localRetirementStore: store,
    readSystemBootIdentity: async () => ({
      source: "Win32_OperatingSystem.LastBootUpTime", bootTime: "2021-01-01T00:00:00.000Z",
    }),
    afterLocalRetirement: run => wakes.push(run.id),
    ...overrides,
  });
  const source = createManagedTaskRun({
    provider: "codex", executionOwner: "hub", streamId: "stream-1",
    threadId: "thread-1", projectRoot: "D:/Work", clientUserMessageId: "original-command",
    rawPrompt: "retained original", userMessages: [{ clientUserMessageId: "original-command",
      text: "retained original", annotations: [{ source: "original annotation" }],
      attachments: [{ id: "attachment-original", path: "retained-file" }] }],
  });
  source.startedAt = "2020-01-01T00:00:00.000Z";
  markProviderTurnRequested(source, { requestedAt: "2020-01-01T00:00:01.000Z" });
  source.turnId = "turn-original";
  markProviderTurnAccepted(source, { turnId: source.turnId, acceptedAt: "2020-01-01T00:00:02.000Z" });
  source.activityUnknown = true;
  const saved = structuredClone(serializableTaskRun(source));
  const run = restorePersistedTaskRun(saved, 7, store);
  h.taskRuns.addRestored(run, saved);
  return { ...h, run, saved, store, directory, wakes, closers };
}

function localRetirementRuntimeContext(registry, store) {
  const empty = { snapshot: () => ({}), restore: () => {} };
  return {
    chatId: 7, updateOffset: 0, restartRequest: null, codexHookReceipts: {},
    getClientTaskSelections: () => [],
    selectionStore: new TaskSelectionStore({ activeProvider: "codex", activeProjectRoot: "D:/Work" }),
    findProject: root => ({ path: root }), taskMetadata: empty, preferences: empty,
    taskRuns: registry, serializableTaskRun,
    restoreTaskRun: (saved, chatId) => restorePersistedTaskRun(saved, chatId, store),
    dismissedExternalTasks: { values: () => [], restore: () => {} },
    cancelledManagedClaudeTasks: new Map(), pendingInputs: new Map(), queuedInputs: new Map(),
    desktopMessageReceipts: { snapshot: () => [], restore: () => {} },
    composerTransfers: { snapshot: () => [], restore: () => {} }, forwardBundles: new Map(),
    runJournal: { lastMessageSnapshot: () => [], restoreLastMessages: () => {} },
    lastSeenTaskTurnIds: new Map(), contextCompactions: empty, codexUsageTracker: empty,
    codexTurnStarts: new Map(), codexTerminalAudit: empty,
    turnEndNotifications: { snapshot: () => ({}), restore: () => ({}) },
    statusMediaFileIds: new Map(), restoreDeferredInput: value => value, deferredInputOptions: {},
    isRetryableDeferredLaunchError: () => false, updateDeferredDesktopReceipt: () => {},
    restoreForwardBundle: value => value, forwardBundleAttachmentPaths: () => [],
    removeFiles: async () => {}, maximumDeferredInputs: 10, deferredInputTtlMs: 60000,
  };
}

test("local execution retirement persists before release and preserves exact UNKNOWN through reopen", async t => {
  const f = await localRetirementFixture(t);
  const original = structuredClone(serializableTaskRun(f.run));
  let release;
  let entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  let writes = 0;
  const record = f.store.recordLocalExecutionRetirement.bind(f.store);
  f.store.recordLocalExecutionRetirement = async value => {
    writes += 1; entered(); await held; return record(value);
  };
  const pending = Promise.all([
    f.service.retireLocalExecutionAfterReboot(f.run),
    f.service.retireLocalExecutionAfterReboot(f.run),
  ]);
  await waiting;
  assert.equal(f.taskRuns.forTask(f.run), f.run);
  assert.equal(f.run.localExecutionRetirement, undefined);
  assert.deepEqual(f.wakes, []);
  release();
  assert.deepEqual(await pending, [true, true]);
  assert.equal(writes, 1);
  assert.equal(f.taskRuns.forTask(f.run), null);
  assert.equal(f.taskRuns.forEvent({ turnId: f.run.turnId }), f.run);
  assert.deepEqual(f.taskRuns.values(), []);
  assert.equal(f.taskRuns.retainedValues()[0], f.run);
  assert.equal(f.taskRuns.size, 0);
  assert.equal(f.run.status, "running");
  assert.equal(f.run.activityUnknown, true);
  assert.deepEqual(f.run.providerStart, original.providerStart);
  assert.deepEqual(f.run.userMessages, original.userMessages);
  assert.equal(f.run.rawPrompt, original.rawPrompt);
  assert.equal(f.run.providerTerminalStatus, undefined);
  assert.equal(f.store.get(f.run), null, "No provider terminal was manufactured");
  assert.deepEqual(f.wakes, [f.run.id]);
  assert.equal(f.events.includes("before"), false);
  assert.equal(f.events.includes("after"), false);
  assert.equal(f.events.includes("sync-complete"), false);

  const snapshot = JSON.parse(JSON.stringify(createHubRuntimeSnapshot(
    localRetirementRuntimeContext(f.taskRuns, f.store))));
  assert.equal(snapshot.activeRuns.length, 1, "Actual snapshot owner retains the old original");
  assert.equal(snapshot.activeRuns[0].localAdmissionReleased, undefined, "No copied flag is authority");
  const reopenedStore = new ProviderRunTerminalStore({ dataDir: f.directory });
  const registry = new TaskRunRegistry();
  const next = createManagedTaskRun({ ...original, id: "new-run", turnId: "new-turn" });
  registry.add(next);
  await restoreHubRuntimeSnapshot(snapshot, localRetirementRuntimeContext(registry, reopenedStore));
  const restored = registry.forEvent({ turnId: original.turnId });
  assert.equal(registry.forTask(next), next, "Retained old UNKNOWN cannot replace current admission");
  assert.equal(registry.forEvent({ turnId: original.turnId }), restored);
  assert.equal(restored.localAdmissionReleased, true);
  assert.equal(restored.status, original.status);
  assert.deepEqual(restored.providerStart, original.providerStart);
  assert.deepEqual(restored.userMessages, original.userMessages);
  assert.equal(reopenedStore.get(original), null);
  assert.equal(await f.service.retireLocalExecutionAfterReboot(f.run), true);
  assert.deepEqual(f.wakes, [f.run.id], "Same original does not wake twice");
});

test("local execution retirement refuses missing same-boot ambiguous and foreign provenance", async t => {
  for (const variant of ["same-boot", "future-boot", "missing-boot", "pid-reuse-only",
    "not-restored", "foreign-owner", "missing-acceptance", "changed-original"]) {
    const f = await localRetirementFixture(t, {
      readSystemBootIdentity: async () => variant === "same-boot"
        ? { source: "Win32_OperatingSystem.LastBootUpTime", bootTime: "2019-01-01T00:00:00Z" }
        : variant === "future-boot"
          ? { source: "Win32_OperatingSystem.LastBootUpTime", bootTime: "2099-01-01T00:00:00Z" }
          : variant === "missing-boot" ? null
            : variant === "pid-reuse-only" ? { source: "process-absent", pid: 17772, reused: true }
              : { source: "Win32_OperatingSystem.LastBootUpTime", bootTime: "2021-01-01T00:00:00Z" },
    });
    if (variant === "not-restored") {
      f.taskRuns.remove(f.run);
      f.taskRuns.add(f.run);
      // A fresh registry has no canonical saved-run provenance.
      const fresh = new TaskRunRegistry([f.run]);
      assert.equal(fresh.restoredLocalExecution(f.run), null);
      // Use a genuinely fresh object, not the old restored object's provenance.
      const replacement = structuredClone(f.run);
      f.taskRuns.remove(f.run); f.taskRuns.add(replacement);
      f.run = replacement;
    }
    if (variant === "foreign-owner") f.run.executionOwner = "desktop";
    if (variant === "missing-acceptance") f.run.providerStart.state = "unconfirmed";
    if (variant === "changed-original") f.run.clientUserMessageId = "new-command";
    assert.equal(await f.service.retireLocalExecutionAfterReboot(f.run), false, variant);
    assert.equal(f.taskRuns.forTask(f.run), f.run, variant);
    assert.equal(f.run.localAdmissionReleased, false, variant);
    assert.deepEqual(f.wakes, [], variant);
  }
});

test("local execution retirement accepts canonical legacy Hub provenance without inventing provider status", async t => {
  const f = await localRetirementFixture(t);
  f.taskRuns.remove(f.run);
  const saved = { ...f.saved, executionOwner: "telegram", providerTerminalStatus: "unknown" };
  const run = restorePersistedTaskRun(saved, 7, f.store);
  f.taskRuns.addRestored(run, saved);
  assert.equal(await f.service.retireLocalExecutionAfterReboot(run), true);
  assert.equal(run.providerTerminalStatus, "unknown");
  assert.deepEqual(run.providerStart, saved.providerStart);
  assert.equal(f.store.get(run), null);
  assert.equal(f.taskRuns.forEvent({ turnId: run.turnId }), run);
});

test("local execution retirement refuses registry replacement and identity races across boot read", async t => {
  for (const mode of ["registry", "turn", "command", "completion"]) {
    let release;
    const read = new Promise(resolve => { release = resolve; });
    const f = await localRetirementFixture(t, { readSystemBootIdentity: () => read });
    const pending = f.service.retireLocalExecutionAfterReboot(f.run);
    if (mode === "registry") {
      f.taskRuns.remove(f.run);
      f.taskRuns.add({ ...f.run, id: "new-registration", turnId: "new-turn" });
    }
    if (mode === "turn") f.run.turnId = "new-turn";
    if (mode === "command") f.run.clientUserMessageId = "new-command";
    if (mode === "completion") f.run.completionPrepared = true;
    release({ source: "Win32_OperatingSystem.LastBootUpTime", bootTime: "2021-01-01T00:00:00Z" });
    assert.equal(await pending, false, mode);
    assert.deepEqual(f.wakes, [], mode);
    assert.equal(f.store.getLocalExecutionRetirement(localExecutionIdentity(f.saved)), null, mode);
  }
});

test("local execution retirement persistence failure retains ownership and accepted payload", async t => {
  const failure = new Error("held durable store failure");
  const f = await localRetirementFixture(t);
  const record = f.store.recordLocalExecutionRetirement.bind(f.store);
  f.store.recordLocalExecutionRetirement = async () => { throw failure; };
  await assert.rejects(f.service.retireLocalExecutionAfterReboot(f.run), error => error === failure);
  assert.equal(f.taskRuns.forTask(f.run), f.run);
  assert.equal(f.run.localExecutionRetirement, undefined);
  assert.deepEqual(f.run.providerStart, f.saved.providerStart);
  assert.deepEqual(f.wakes, []);
  assert.equal(f.store.getLocalExecutionRetirement(localExecutionIdentity(f.saved)), null);
  f.store.recordLocalExecutionRetirement = record;
  assert.equal(await f.service.retireLocalExecutionAfterReboot(f.run), true);
  assert.equal(f.taskRuns.forEvent({ turnId: f.run.turnId }), f.run);
});

test("local execution retirement never releases a replacement that wins during durable commit", async t => {
  const f = await localRetirementFixture(t);
  const record = f.store.recordLocalExecutionRetirement.bind(f.store);
  const replacement = { ...f.run, id: "replacement-run", turnId: "replacement-turn" };
  f.store.recordLocalExecutionRetirement = async value => {
    const committed = await record(value);
    f.taskRuns.remove(f.run);
    f.taskRuns.add(replacement);
    return committed;
  };
  assert.equal(await f.service.retireLocalExecutionAfterReboot(f.run), false);
  assert.equal(f.taskRuns.forTask(replacement), replacement);
  assert.equal(replacement.localAdmissionReleased, false);
  assert.deepEqual(f.wakes, []);
  assert.ok(f.store.getLocalExecutionRetirement(localExecutionIdentity(f.saved)));
  assert.equal(f.store.get(f.saved), null);
});

test("local execution retirement ignores forged snapshot release flags without lifecycle evidence", async t => {
  const f = await localRetirementFixture(t);
  const forged = { ...f.saved, localAdmissionReleased: true,
    localExecutionRetirement: { proof: { kind: "system-restart-after-local-execution" } } };
  const run = restorePersistedTaskRun(forged, 7, f.store);
  const registry = new TaskRunRegistry();
  registry.addRestored(run, forged);
  assert.equal(registry.forTask(run), run);
  assert.equal(run.localAdmissionReleased, false);
  assert.throws(() => f.store.recordLocalExecutionRetirement({
    identity: localExecutionIdentity(f.saved),
    proof: { kind: "system-restart-after-local-execution", source: "pid-reused" },
  }), /boot proof/u);
  assert.equal(f.store.getLocalExecutionRetirement(localExecutionIdentity(f.saved)), null);
});

test("local execution retirement content-free proof and persistence spans survive trace worker reopen", async t => {
  const { CommandTraceService } = await import("../../src/application/command-trace-service.mjs");
  const { CommandTraceWorkerStore } = await import("../../src/infrastructure/persistence/command-trace-worker-store.mjs");
  const f = await localRetirementFixture(t);
  let worker = new CommandTraceWorkerStore({ databaseFile: path.join(f.directory, "trace.sqlite") });
  await worker.initialize();
  f.closers.push(async () => { await worker.close(); });
  const h = harness({
    localRetirementStore: f.store,
    readSystemBootIdentity: async () => ({
      source: "Win32_OperatingSystem.LastBootUpTime", bootTime: "2021-01-01T00:00:00Z",
    }),
    commandTrace: new CommandTraceService({ store: worker }),
  });
  const run = restorePersistedTaskRun(f.saved, 7, f.store);
  h.taskRuns.addRestored(run, f.saved);
  f.store.recordLocalExecutionRetirement = async () => { throw new Error("write refused"); };
  await assert.rejects(h.service.retireLocalExecutionAfterReboot(run), /write refused/u);
  await worker.close();
  worker = new CommandTraceWorkerStore({ databaseFile: path.join(f.directory, "trace.sqlite") });
  await worker.initialize();
  const rows = await worker.readCommandTimeline(run.clientUserMessageId);
  assert.deepEqual(rows.filter(row => row.stage === "local-execution-boot-proof").map(row => row.outcome),
    ["started", "succeeded"]);
  assert.deepEqual(rows.filter(row => row.stage === "local-execution-retirement").map(row => row.outcome),
    ["started", "failed"]);
  assert.equal(JSON.stringify(rows).includes("retained original"), false);
  assert.equal(JSON.stringify(rows).includes("retained-file"), false);
  assert.equal(h.taskRuns.forTask(run), run);
  await worker.close(); // Join before the fixture removes its owned directory.
});

test("local execution retirement durable commit survives interrupted snapshot save without replay", async t => {
  const failure = new Error("runtime snapshot failure");
  const f = await localRetirementFixture(t, { saveState: async () => { throw failure; } });
  await assert.rejects(f.service.retireLocalExecutionAfterReboot(f.run), error => error === failure);
  assert.equal(f.taskRuns.forTask(f.run), null, "Lifecycle disposition already durably committed");
  const store = new ProviderRunTerminalStore({ dataDir: f.directory });
  const restored = restorePersistedTaskRun(f.saved, 7, store); // Old pre-disposition snapshot.
  const registry = new TaskRunRegistry();
  registry.addRestored(restored, f.saved);
  assert.equal(registry.forTask(restored), null);
  assert.equal(registry.forEvent({ turnId: restored.turnId }), restored);
  assert.deepEqual(restored.providerStart, f.saved.providerStart);
  assert.equal(store.get(f.saved), null);
});

test("local execution retirement refuses missing foreign ambiguous and superseded late terminal", async t => {
  for (const variant of ["missing", "foreign-run", "foreign-turn", "unknown", "missing-revision",
    "registry-replacement", "changed-command"]) {
    let release;
    const held = new Promise(resolve => { release = resolve; });
    const f = await localRetirementFixture(t, { readProviderTerminal: () => held });
    assert.equal(await f.service.retireLocalExecutionAfterReboot(f.run), true);
    const terminal = { provider: f.run.provider, threadId: f.run.threadId, turnId: f.run.turnId,
      status: "completed", terminalRevision: 1, committedAt: new Date().toISOString(),
      payload: { completion: { runId: f.run.id } } };
    if (variant === "foreign-run") terminal.payload.completion.runId = "other-run";
    if (variant === "foreign-turn") terminal.turnId = "other-turn";
    if (variant === "unknown") terminal.status = "unknown";
    if (variant === "missing-revision") delete terminal.terminalRevision;
    const pending = f.service.complete(f.run);
    const persisted = serializableTaskRun(f.run);
    assert.equal(Object.hasOwn(persisted, "completionPreparing"), false);
    assert.equal(Object.hasOwn(persisted, "admissionReleasing"), false);
    let replacement;
    if (variant === "registry-replacement") {
      f.taskRuns.remove(f.run);
      replacement = { ...f.saved, id: "replacement", turnId: "replacement-turn" };
      f.taskRuns.add(replacement);
    }
    if (variant === "changed-command") f.run.clientUserMessageId = "new-command";
    release(variant === "missing" ? null : terminal);
    await pending;
    assert.equal(f.run.status, "running", variant);
    assert.deepEqual(f.run.providerStart, f.saved.providerStart, variant);
    assert.equal(f.run.providerTerminalStatus, undefined, variant);
    assert.equal(f.events.includes("before"), false, variant);
    assert.equal(f.events.includes("after"), false, variant);
    assert.equal(f.events.includes("aborted"), false, variant);
    assert.equal(f.events.includes("sync-complete"), false, variant);
    if (replacement) assert.equal(f.taskRuns.forTask(replacement), replacement);
    else assert.equal(f.taskRuns.forEvent({ turnId: f.saved.turnId }), f.run, variant);
  }
});

test("local execution retirement precedes provider reads and current writer still fences new input", async t => {
  const f = await localRetirementFixture(t);
  let reads = 0;
  let interrupts = 0;
  const noEffect = async () => {};
  const recovery = new CodexRecoveryService({
    retireLocalExecutionAfterReboot: run => f.service.retireLocalExecutionAfterReboot(run),
    transportRunning: () => true, readTaskSnapshot: noEffect, startTransport: noEffect,
    initialize: noEffect, isCodex: () => true, finishInterrupted: noEffect,
    readThread: async () => { reads += 1; }, autoApprove: () => false,
    restartRequested: () => false, finishProgress: noEffect, completeRun: noEffect,
    recoveredAnswer: () => "", setProgressStage: noEffect, launchTurn: async () => { interrupts += 1; },
    reindexRun: noEffect, scheduleObservedRun: noEffect, startTyping: noEffect, saveState: noEffect,
    telegram: noEffect, consumeTracker: noEffect, finalizeDelivery: noEffect,
  });
  await recovery.recover(f.run, { reconcileOnly: true });
  assert.equal(reads, 0, "No Thread/history hydration or current provider interrupt");
  assert.equal(interrupts, 0);
  let activity = "active";
  let starts = 0;
  const deferred = [];
  const coordinator = new RunCoordinator({
    taskRuns: f.taskRuns, providers: { call: noEffect },
    externalActivity: async () => ({ state: activity, executionOwner: "desktop" }),
    repositoryConflict: async () => null,
    deferInput: async (_input, _files, options) => {
      deferred.push(options); return { item: { id: "queued-same-original" }, duplicate: false };
    },
    beginRun: async () => { starts += 1; return { id: "next-run" }; },
    launchTurn: noEffect, rollbackAdmission: noEffect,
  });
  const target = { ...f.run, clientUserMessageId: "next-command" };
  assert.equal((await coordinator.deferredOccupancy(target)).occupied, true);
  await coordinator.start("next original", [], { target });
  activity = "unknown";
  await coordinator.start("next original", [], { target });
  assert.equal(starts, 0);
  assert.deepEqual(deferred.map(value => value.conflictKind), ["task-running", "activity-unknown"]);
  activity = "inactive";
  assert.equal((await coordinator.deferredOccupancy(target)).occupied, false);
  assert.equal((await coordinator.start("next original", [], { target })).started, true);
  assert.equal(starts, 1);
  assert.equal(f.taskRuns.forEvent({ turnId: f.run.turnId }), f.run);
});

test("admission propagates the exact diff fence failure and original command context before provider launch", async () => {
  const failure = Object.assign(new Error("diff persistence failed"), {code:"EIO"});
  let context;
  const {service,taskRuns,events} = harness({
    persistTaskDiff:async (_key,_value,options)=>{context=options;throw failure;},
  });
  await assert.rejects(service.begin("fixture", {
    clientUserMessageId:"original-command",clientSource:"mcp",
  }), failure);
  assert.equal(context.commandId,"original-command");
  assert.equal(context.transport,"mcp");
  assert.equal(context.admission,true);
  assert.equal(taskRuns.size,0);
  assert.equal(events.includes("clear-diff"),false);
});

test("managed run lifecycle adoption cannot mint a launch capability", async () => {
  let preparations = 0;
  const { service } = harness({
    provider: "claude",
    prepareAdmission: async () => {
      preparations += 1;
      return null;
    },
  });

  await service.adopt("already accepted", {
    provider: "claude",
    projectRoot: "D:/Work",
    streamId: "stream-1",
    threadId: "thread-existing",
    taskTitle: "Claude",
  });

  assert.equal(preparations, 0);
});

test("managed run lifecycle revokes launch capability before asynchronous completion", async () => {
  let releaseCompletion;
  const completion = new Promise((resolve) => { releaseCompletion = resolve; });
  const events = [];
  const { service } = harness({
    revokeAdmission: () => events.push("revoked"),
    beforeCompletion: async () => completion,
  });
  const run = await service.begin("hello");

  const pending = service.complete(run);
  assert.deepEqual(events, ["revoked"]);
  releaseCompletion();
  await pending;
});

test("managed run lifecycle creates and persists one owned run", async () => {
  const { service, taskRuns, events } = harness();
  const run = await service.begin("hello");

  assert.equal(taskRuns.forTask(run), run);
  assert.equal(run.promptPreview, "hello");
  assert.equal(run.rawPrompt, "hello");
  assert.deepEqual(run.userMessages, [{
    role: "user",
    text: "hello",
    submittedAt: run.submittedAt,
    startedAt: run.startedAt,
    time: run.startedAt,
  }]);
  assert.equal(run.streamId, "stream-1");
  assert.equal(run.model, "GPT");
  assert.deepEqual(events, ["catalog", "diff", "clear-diff", "sync-start", "save", "progress"]);
});

test("failed pre-turn admission cannot leave a recoverable active run", async () => {
  const failure = Object.assign(new Error("database is locked"), { code: "ERR_SQLITE_ERROR", errcode: 5 });
  const traceResults = [];
  let saves = 0;
  let rejectedRun;
  const deferredInput = { clientUserMessageId: "queued-after-compaction" };
  const { service, taskRuns, events } = harness({
    commandTrace: { startBestEffortSpan: ({ stage }) => ({
      finish: (result) => traceResults.push({ stage, ...result }),
    }) },
    prepareAdmission: async () => ({ commit: (run) => { rejectedRun = run; } }),
    revokeAdmission: (run) => assert.equal(run, rejectedRun),
    saveState: async () => {
      saves += 1;
      if (saves === 1) throw failure;
      assert.equal(taskRuns.size, 0);
    },
  });

  await assert.rejects(service.begin("continue", {
    clientUserMessageId: deferredInput.clientUserMessageId,
    deferredInput,
  }), (error) => error === failure);

  assert.equal(taskRuns.forTask(rejectedRun), null);
  assert.equal(taskRuns.size, 0);
  assert.equal(rejectedRun.status, "failed");
  assert.equal(deferredInput.dispatchingRunId, undefined);
  assert.equal(events.includes("progress"), false);
  assert.equal(events.includes("before"), false);
  assert.equal(saves, 2);
  assert.deepEqual(traceResults.filter((result) => result.stage === "admission-state-save"), [{
    stage: "admission-state-save",
    outcome: "failed",
    metadata: { errorCode: "ERR_SQLITE_ERROR", sqliteErrorCode: 5 },
  }]);
  assert.deepEqual(traceResults.filter((result) => result.stage === "admission"), [{
    stage: "admission",
    outcome: "failed",
    metadata: { operation: "save-state", errorCode: "ERR_SQLITE_ERROR", sqliteErrorCode: 5, runId: rejectedRun.id },
  }]);
});

test("admission traces content-free owning stages without awaiting detached task sync", async () => {
  const traced = [];
  let releaseSync;
  const syncPending = new Promise((resolve) => { releaseSync = resolve; });
  const { service } = harness({
    commandTrace: { startBestEffortSpan: ({ stage, commandId, transport }) => ({
      finish: (result) => traced.push({ stage, commandId, transport, ...result }),
    }) },
    syncRun: () => syncPending,
  });

  await service.begin("hello", { clientUserMessageId: "command-stage", clientSource: "trusted-device" });
  releaseSync();

  assert.deepEqual(traced.map(({ stage, outcome }) => [stage, outcome]), [
    ["admission-prepare", "succeeded"],
    ["admission-task-diff", "succeeded"],
    ["admission-sync-run-enqueue", "succeeded"],
    ["admission-state-save", "succeeded"],
    ["admission", "succeeded"],
  ]);
  assert.ok(traced.every((record) => record.commandId === "command-stage"));
  assert.ok(traced.every((record) => record.transport === "trusted-device"));
});

test("failed admission rollback keeps the original error and removes only its own run", async () => {
  const failure = new Error("database is locked");
  const rollbackFailure = new Error("snapshot write failed");
  let saves = 0;
  const { service, taskRuns } = harness({
    saveState: async () => {
      saves += 1;
      if (saves === 2) throw failure;
      if (saves === 3) throw rollbackFailure;
    },
  });
  const otherRun = await service.begin("other", { threadId: "other-thread" });
  const deferredInput = { dispatchingRunId: "previous-attempt" };

  await assert.rejects(service.begin("continue", { deferredInput }), (error) => {
    assert.equal(error.cause, failure);
    assert.deepEqual(error.errors, [failure, rollbackFailure]);
    return true;
  });

  assert.deepEqual(taskRuns.values(), [otherRun]);
  assert.equal(otherRun.status, "running");
  assert.equal(deferredInput.dispatchingRunId, "previous-attempt");
});

test("admission persistence failure retains a provider turn accepted during the write", async () => {
  const failure = new Error("database is locked");
  let acceptedRun;
  const { service, taskRuns } = harness({
    prepareAdmission: async () => ({ commit: (run) => { acceptedRun = run; } }),
    revokeAdmission: () => assert.fail("accepted provider work must remain owned"),
    saveState: async () => {
      acceptedRun.turnId = "accepted-turn";
      throw failure;
    },
  });

  await assert.rejects(service.begin("continue"), (error) => error === failure);
  assert.equal(taskRuns.forTask(acceptedRun), acceptedRun);
  assert.equal(acceptedRun.status, "running");
});

test("managed run preserves durable submission time separately from provider start", async () => {
  const { service } = harness();
  const run = await service.begin("queued", {
    clientUserMessageId: "client-queued",
    deferredInput: { createdAt: "2026-09-01T21:25:00.000Z" },
  });

  assert.equal(run.submittedAt, "2026-09-01T21:25:00.000Z");
  assert.equal(run.userMessages[0].submittedAt, run.submittedAt);
  assert.equal(run.userMessages[0].startedAt, run.startedAt);
  assert.equal(run.userMessages[0].time, run.submittedAt);
});

test("managed run lifecycle omits an oversized provider client message id", async () => {
  const { service } = harness();
  const run = await service.begin("hello", {
    clientUserMessageId: `provider:${"x".repeat(201)}`,
  });

  assert.equal(run.clientUserMessageId, null);
  assert.equal(run.userMessages[0].clientUserMessageId, undefined);
});

test("managed run lifecycle does not capture Git baselines for provider turns", async () => {
  const { service } = harness({ provider: "claude" });
  const run = await service.begin("hello");

  assert.equal(run.gitBaseline, null);
});

test("managed run lifecycle canonicalizes a legacy Codex model label", async () => {
  const { service } = harness();
  const run = await service.begin("hello", { modelId: "GPT-5.6-Sol" });

  assert.equal(run.modelId, "gpt-5.6-sol");
  assert.equal(run.model, "GPT-5.6-SOL");
});

test("managed run lifecycle gives an explicit destination model precedence over saved and default models", async () => {
  const { service } = harness({
    currentTarget: () => ({
      provider: "codex", projectRoot: "D:/Work", streamId: "stream-b", threadId: "thread-b", taskTitle: "B", chatId: 7,
    }),
    codexSettings: () => ({ model: "saved-terra" }),
    currentPreferences: () => ({
      model: "selected-b", defaultModel: "fake-codex", reasoningEffort: "high", defaultReasoningEffort: "high", collaborationMode: "default",
    }),
  });

  const run = await service.begin("hello", {
    provider: "codex",
    projectRoot: "D:/Work",
    streamId: "stream-a",
    threadId: "thread-a",
    taskTitle: "A",
    modelId: "GPT-5.3-Codex-Spark",
  });

  assert.equal(run.modelId, "gpt-5.3-codex-spark");
});

test("managed run lifecycle preserves saved and selected-target model fallbacks", async () => {
  const currentTarget = () => ({
    provider: "codex", projectRoot: "D:/Work", streamId: "stream-b", threadId: "thread-b", taskTitle: "B", chatId: 7,
  });
  const preferences = () => ({
    model: "selected-b", defaultModel: "fake-codex", reasoningEffort: "high", defaultReasoningEffort: "high", collaborationMode: "default",
  });
  const saved = harness({
    currentTarget,
    codexSettings: () => ({ model: "saved-terra" }),
    currentPreferences: preferences,
  });
  const selected = harness({
    currentTarget,
    currentPreferences: preferences,
  });

  const savedRun = await saved.service.begin("saved", {
    provider: "codex", projectRoot: "D:/Work", streamId: "stream-a", threadId: "thread-a", taskTitle: "A",
  });
  const selectedRun = await selected.service.begin("selected", currentTarget());

  assert.equal(savedRun.modelId, "saved-terra");
  assert.equal(selectedRun.modelId, "selected-b");
});

test("managed run lifecycle completes and removes the same run", async () => {
  const { service, taskRuns, events } = harness();
  const run = await service.begin("hello");
  events.length = 0;
  await service.complete(run);

  assert.equal(taskRuns.size, 0);
  assert.equal(run.status, "completed");
  assert.deepEqual(events, ["before", "approvals", "observer", "claude", "sync-complete", "catalog", "save", "typing", "save", "after"]);
});

test("managed run lifecycle exposes terminal state before removing the run", async () => {
  const { service, taskRuns, events } = harness();
  const run = await service.begin("hello");

  await service.markCompleted(run);

  assert.equal(run.status, "completed");
  assert.equal(taskRuns.forTask(run), null);
  assert.equal(taskRuns.values().includes(run), true);
  assert.ok(events.includes("sync-complete"));
});

test("managed run lifecycle releases admission exactly once", async () => {
  const { service, taskRuns, events } = harness();
  const run = await service.begin("hello");
  events.length = 0;

  await Promise.all([service.releaseAdmission(run), service.releaseAdmission(run)]);
  await service.complete(run);

  assert.equal(taskRuns.size, 0);
  assert.equal(run.admissionReleased, true);
  assert.equal(events.filter((event) => event === "after").length, 1);
  assert.equal(events.filter((event) => event === "typing").length, 1);
});

test("managed run lifecycle retries completion preparation after a failed hook", async () => {
  let attempts = 0;
  const { service, taskRuns, events } = harness({
    beforeCompletion: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("completion hook failed");
      events.push("before");
    },
  });
  const run = await service.begin("hello");
  events.length = 0;

  await assert.rejects(service.markCompleted(run), /completion hook failed/);
  assert.equal(run.completionPrepared, undefined);
  assert.equal(run.status, "running");
  assert.equal(taskRuns.forTask(run), run);
  assert.deepEqual(events, ["aborted"]);

  await service.markCompleted(run);
  assert.equal(run.completionPrepared, true);
  assert.equal(run.status, "completed");
  assert.equal(attempts, 2);
  assert.deepEqual(events, ["aborted", "before", "approvals", "observer", "claude", "sync-complete", "catalog", "save"]);
});

test("managed run lifecycle durably records terminal identity before release", async () => {
  let attempts = 0;
  const recorded = [];
  const { service, taskRuns, events } = harness({
    recordProviderTerminal: async (terminal) => {
      attempts += 1;
      if (attempts === 1) throw new Error("terminal ledger unavailable");
      recorded.push(terminal);
    },
  });
  const run = await service.begin("hello", { provider: "codex", threadId: "thread-terminal" });
  run.turnId = "turn-terminal";
  run.providerTerminalStatus = "failed";
  events.length = 0;

  await assert.rejects(service.complete(run), /terminal ledger unavailable/u);
  assert.equal(taskRuns.forTask(run), run);
  assert.equal(run.status, "running");
  assert.deepEqual(events, ["before", "aborted"]);

  await service.complete(run);
  assert.deepEqual(recorded, [{
    provider: "codex",
    threadId: "thread-terminal",
    turnId: "turn-terminal",
    status: "failed",
  }]);
  assert.equal(taskRuns.size, 0);
});

test("managed run lifecycle rolls back post-turn ownership when terminal preparation fails", async () => {
  let saveCalls = 0;
  let reserved = false;
  const { service } = harness({
    beforeCompletion: async () => { reserved = true; },
    completionAborted: async () => { reserved = false; },
    saveState: async () => {
      saveCalls += 1;
      if (saveCalls === 2) throw new Error("terminal save failed");
    },
  });
  const run = await service.begin("hello");

  await assert.rejects(service.markCompleted(run), /terminal save failed/u);

  assert.equal(reserved, false);
  assert.equal(run.completionPrepared, undefined);
});

test("managed run lifecycle consumes post-turn ownership when admission persistence fails", async () => {
  let saveCalls = 0;
  const events = [];
  const state = harness({
    afterCompletion: async () => events.push("after"),
    saveState: async () => {
      saveCalls += 1;
      if (saveCalls === 3) throw new Error("admission save failed");
    },
  });
  const run = await state.service.begin("hello");

  await assert.rejects(state.service.complete(run), /admission save failed/u);
  assert.equal(run.admissionReleased, undefined);
  assert.deepEqual(events, ["after"]);

  await state.service.complete(run);
  assert.equal(run.admissionReleased, true);
  assert.deepEqual(events, ["after"]);
});

test("managed run lifecycle keeps a Desktop-started run out of Telegram", async () => {
  const { service, events } = harness();
  const run = await service.begin("hello", {
    provider: "codex",
    projectRoot: "D:/Work",
    threadId: "thread-1",
    taskTitle: "Task",
    chatId: 7,
    telegramDeliveryRequested: false,
    clientSource: "desktop",
  });

  assert.equal(run.telegramDeliveryRequested, false);
  assert.equal(run.displayRequested, false);
  assert.equal(run.clientSource, "desktop");
  assert.equal(events.includes("progress"), false);
});

test("managed run lifecycle keeps interstream identity on the active user message", async () => {
  const { service } = harness();
  const messageOrigin = {
    kind: "interstream",
    workspaceId: "workspace-1",
    workspaceName: "Agent HUB",
    streamId: "stream-themes",
    streamName: "Themes",
    provider: "codex",
    model: "gpt-5.6-terra",
    sourceThreadId: "thread-themes",
    requestId: "request-run",
  };
  const input = createInterstreamMessage({ ...messageOrigin, text: "проверь сообщение" });

  const run = await service.begin(input, {
    clientUserMessageId: "mcp:request-run",
    messageOrigin,
  });

  assert.equal(run.promptPreview, input);
  assert.equal(run.rawPrompt, input);
  assert.deepEqual(run.messageOrigin, messageOrigin);
  assert.deepEqual(run.userMessages[0], {
    role: "user",
    kind: "interstream",
    clientUserMessageId: "mcp:request-run",
    origin: messageOrigin,
    author: "Agent HUB - Themes (Terra)",
    text: "проверь сообщение",
    submittedAt: run.submittedAt,
    startedAt: run.startedAt,
    time: run.startedAt,
  });
});
