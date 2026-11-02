import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CodexCompletionService } from "../../../src/providers/provider-completion-services.mjs";
import { ProviderCancellationService } from "../../../src/providers/provider-turn-services.mjs";
import { ManagedRunLifecycleService } from "../../../src/application/managed-run-lifecycle-service.mjs";
import { TerminalTurnCommitService } from "../../../src/application/terminal-turn-commit-service.mjs";
import { ProviderTurnTerminalStore } from "../../../src/infrastructure/persistence/provider-turn-terminal-store.mjs";
import { TaskRunRegistry } from "../../../src/domain/task-runs.mjs";
import { CodexRecoveryService } from "../../../src/providers/provider-recovery-services.mjs";
import { DeferredInputStore } from "../../../src/application/deferred-input-store.mjs";
import { DeferredInputController } from "../../../src/application/deferred-input-controller.mjs";
import { RuntimeStateStore, readRuntimeState } from "../../../src/infrastructure/persistence/runtime-state-store.mjs";
import { CommandTraceService } from "../../../src/application/command-trace-service.mjs";
import { CommandTraceWorkerStore } from "../../../src/infrastructure/persistence/command-trace-worker-store.mjs";

function gate() {
  let release;
  const promise = new Promise(resolve => { release = resolve; });
  return { promise, release };
}

async function fixture(t, beforeTerminalWrite = async () => {}, { afterCompletion = async () => {}, commandTrace = null } = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "hub-cancel-settlement-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const commits = new TerminalTurnCommitService({ store: new ProviderTurnTerminalStore({ dataDir }) });
  const taskRuns = new TaskRunRegistry();
  const events = [];
  const noop = () => {};
  const lifecycle = new ManagedRunLifecycleService({
    taskRuns, currentTarget: () => ({ provider: "codex", projectRoot: "D:/fixture",
      streamId: "stream-original", threadId: "thread-original", chatId: 1 }),
    findProject: () => ({ name: "fixture" }), codexSettings: () => ({}),
    currentPreferences: () => ({ model: "gpt", defaultModel: "gpt", collaborationMode: "default" }),
    normalizeCodexModel: String, modelLabel: String, claudeModelLabels: {}, reasoningLabels: {},
    persistTaskDiff: async () => {}, syncRun: noop, invalidateCatalog: noop,
    saveState: async () => {}, scheduleProgressStart: noop, clearSelectedDiff: noop,
    clearApprovals: noop, pauseObservation: noop, pauseClaude: noop, stopTyping: noop,
    prepareAdmission: async () => null, revokeAdmission: noop,
    beforeCompletion: async () => {}, completionAborted: async () => {},
    afterCompletion: async run => {
      events.push({ kind: "wake", terminal: await commits.get(run) });
      await afterCompletion(run);
    },
  });
  const run = await lifecycle.adopt("original accepted input", {
    provider: "codex", threadId: "thread-original", clientUserMessageId: "message-original",
  });
  run.turnId = "turn-original";
  const current = () => taskRuns.forTask(run);
  let attempts = 0;
  let activity = async () => ({ state: "inactive" });
  const completion = new CodexCompletionService({
    runForTask: current, consumeTracker: () => null, waitForCompletion: async () => null,
    finalizeDelivery: async (value, result) => {
      attempts += 1;
      await beforeTerminalWrite();
      await commits.commit({ provider: "codex", threadId: value.threadId,
        turnId: result.turnId, status: result.status, finalAnswer: result.answer,
        clientUserMessageId: value.clientUserMessageId }, { run: value });
      await lifecycle.complete(value);
    },
    finishProgress: async () => {}, completedAnswer: async () => "provider final",
    rememberSeenTurn: async () => {}, rememberLastMessage: noop,
    temporaryFiles: new Map(), speechButtons: new Map(), removeFile: async () => {},
  });
  const cancellation = new ProviderCancellationService({
    commandTrace,
    interruptCodex: async () => { throw new Error("no active turn"); },
    runForTask: current, completeRun: value => lifecycle.complete(value),
    readCodexSnapshot: async () => ({ turnId: run.turnId, completed: false,
      active: false, status: "unknown", answer: "retained partial answer" }),
    finishObserved: async () => assert.fail("Managed original only"),
    completeManaged: (...args) => completion.completeManaged(...args),
    taskExternalActivity: (...args) => activity(...args),
    stopClaudeRun: async () => assert.fail("No foreign process stop"),
    processIsAlive: () => false, claudeCancellationKey: () => "", saveState: async () => {},
  });
  return { run, completion, cancellation, commits, current, events,
    attempts: () => attempts, setActivity: value => { activity = value; } };
}

test("Stop retry cannot release an actual finishing completion after its write failed", async t => {
  const f = await fixture(t, async () => { throw new Error("terminal write unavailable"); });
  assert.equal((await f.cancellation.cancelCodex(f.run)).accepted, false);
  assert.equal(f.run.status, "finishing");
  assert.equal(await f.commits.get(f.run), null);
  assert.equal((await f.cancellation.cancelCodex(f.run)).accepted, false);
  assert.equal(f.current(), f.run);
  assert.equal(f.run.admissionReleased === true, false);
  assert.equal(f.events.length, 0);
  assert.equal(f.attempts(), 1);
});

test("accepted orphan recovery commits SQLite before one same-ID queued input with attachments can start", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hub-orphan-queue-"));
  const runtime = new RuntimeStateStore({ dataDir: directory });
  const tracesFile = path.join(directory, "traces.sqlite");
  let traceStore = new CommandTraceWorkerStore({ databaseFile: tracesFile });
  await traceStore.initialize();
  let controller;
  t.after(async () => {
    controller?.stop();
    await traceStore.close();
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  });
  const commandTrace = new CommandTraceService({ store: traceStore });
  const attachment = path.join(directory, "original-image.png");
  await writeFile(attachment, Buffer.from([137, 80, 78, 71, 7, 3]));
  const original = { id: "queued-original", clientUserMessageId: "queued-client-original", provider: "codex",
    threadId: "thread-original", streamId: "stream-original", projectRoot: "D:/fixture",
    input: [{ type: "text", text: "original annotated input" }],
    temporaryFiles: [attachment], persistentFiles: true, annotations: [{ quote: "source", annotation: "original" }],
    conflictKind: "message-intake", waitReason: "managed-run-activity-unknown", createdAt: new Date().toISOString() };
  // Reopen the ordinary state store before recovering; no recreated message ID.
  await runtime.save({ activeRuns: [], queuedInputs: [original] });
  const deferred = new DeferredInputStore();
  for (const item of (await readRuntimeState(directory)).queuedInputs) deferred.put(item, "queued");
  const entered = gate(), held = gate(), started = [];
  const f = await fixture(t, async () => { entered.release(); await held.promise; }, {
    commandTrace,
    afterCompletion: async () => {
      assert.equal((await f.commits.get(f.run)).status, "aborted");
      await controller.process(original.id);
    },
  });
  f.run.executionOwner = "hub";
  f.run.providerStart = { state: "observed", turnId: f.run.turnId };
  controller = new DeferredInputController({
    pendingInputs: deferred.pending, queuedInputs: deferred.queued,
    isBlocked: async () => Boolean(f.current()),
    start: async item => { started.push(structuredClone(item)); return { id: "next-run", turnId: "next-turn" }; },
    persist: () => runtime.save({ queuedInputs: [...deferred.queued.values()] }),
    updateMessage: async () => {}, pendingKeyboard: () => null, notifyReturned: async () => {},
    setTimeoutImpl: () => 1, clearTimeoutImpl() {}, commandTrace,
  });
  const recovery = new CodexRecoveryService({
    transportRunning: () => true, readTaskSnapshot: async () => ({ turnId: f.run.turnId,
      completed: false, active: false, activityUnknown: true, answer: "retained partial answer" }),
    startTransport: async () => {}, initialize: async () => {}, isCodex: () => true,
    finishInterrupted: async () => assert.fail("No direct release"),
    readThread: async (_id, { applySnapshot }) => applySnapshot({ thread: { status: { type: "idle" },
      turns: [{ id: f.run.turnId, status: "inProgress", items: [] }] } }),
    recoverInactiveRun: value => f.cancellation.recoverCodex(value),
    autoApprove: () => false, restartRequested: () => false, finishProgress: async () => {},
    completeRun: async () => assert.fail("No direct release"), recoveredAnswer: () => "",
    setProgressStage() {}, launchTurn: async () => assert.fail("No prompt replay"), reindexRun() {},
    scheduleObservedRun() {}, startTyping() {}, saveState: async () => {}, telegram: async () => {},
    consumeTracker: () => null, finalizeDelivery: async () => assert.fail("Canonical terminal owner only"),
    turnTokenUsage: new Map(),
  });
  const recovering = recovery.recover(f.run);
  await entered.promise;
  try {
    await controller.process(original.id);
    assert.equal(started.length, 0);
    assert.equal(await f.commits.get(f.run), null);
  } finally { held.release(); await recovering; }
  await Promise.all([recovery.recover(f.run), controller.process(original.id), controller.process(original.id)]);
  assert.equal(started.length, 1);
  assert.equal(started[0].id, original.id);
  assert.equal(started[0].clientUserMessageId, original.clientUserMessageId);
  assert.deepEqual(started[0].input, original.input);
  assert.deepEqual(started[0].annotations, original.annotations);
  assert.deepEqual(started[0].temporaryFiles, [attachment]);
  assert.deepEqual(await readFile(attachment), Buffer.from([137, 80, 78, 71, 7, 3]));
  assert.equal((await readRuntimeState(directory)).queuedInputs.length, 0);
  assert.equal(f.attempts(), 1);
  await traceStore.close();
  traceStore = new CommandTraceWorkerStore({ databaseFile: tracesFile });
  await traceStore.initialize();
  const spans = await traceStore.readCommandTimeline(f.run.clientUserMessageId);
  for (const stage of ["recovery-activity-before", "recovery-interrupt", "recovery-activity-after"]) {
    assert.deepEqual(spans.filter(s => s.stage === stage).map(s => s.outcome),
      ["started", stage === "recovery-interrupt" ? "failed" : "succeeded"]);
  }
  assert.doesNotMatch(JSON.stringify(spans), /original annotated input|original-image|retained partial answer/);
});

test("Stop during actual recovery persistence leaves the lane until the SQLite terminal commits", async t => {
  const entered = gate(), held = gate();
  const f = await fixture(t, async () => { entered.release(); await held.promise; });
  const recovering = f.cancellation.recoverCodex(f.run);
  await entered.promise;
  try {
    const result = await f.cancellation.cancelCodex(f.run);
    assert.equal(result.accepted, false);
    assert.equal(f.current(), f.run);
    assert.equal(await f.commits.get(f.run), null);
    assert.equal(f.events.length, 0);
  } finally { held.release(); await recovering; }
  assert.equal(await recovering, true);
  assert.equal(f.current(), null);
  assert.equal(f.events.length, 1);
  assert.equal(f.events[0].terminal.status, "aborted");
  assert.equal(f.events[0].terminal.finalAnswer, "retained partial answer");
  assert.equal(f.attempts(), 1);
});

test("completion beginning in the second fresh recovery check cannot grant a no-op release", async t => {
  const entered = gate(), held = gate();
  const f = await fixture(t, async () => { entered.release(); await held.promise; });
  let checks = 0, competing;
  f.setActivity(async () => {
    if (++checks === 2) {
      competing = f.completion.completeManaged(f.run, { snapshot: {
        turnId: f.run.turnId, completed: true, status: "interrupted", answer: "provider terminal",
      } });
      await entered.promise;
    }
    return { state: "inactive" };
  });
  try {
    assert.equal(await f.cancellation.recoverCodex(f.run), false);
    assert.equal(f.current(), f.run);
    assert.equal(await f.commits.get(f.run), null);
    assert.equal(f.events.length, 0);
  } finally { held.release(); await competing; }
  assert.equal(f.current(), null);
  assert.equal(f.events.length, 1);
  assert.equal(f.events[0].terminal.finalAnswer, "provider terminal");
  assert.equal(f.attempts(), 1);
});
