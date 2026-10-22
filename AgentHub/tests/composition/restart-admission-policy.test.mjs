import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { RunCoordinator } from "../../src/application/run-coordinator.mjs";
import { DeferredInputController } from "../../src/application/deferred-input-controller.mjs";
import { DeferredInputService } from "../../src/application/deferred-input-service.mjs";
import { DeferredInputStore } from "../../src/application/deferred-input-store.mjs";
import { createRuntimeRestartWiring } from "../../src/composition/runtime-restart-wiring-composition.mjs";
import { HubSessionState } from "../../src/runtime/hub-session-state.mjs";
import { RuntimeStateStore } from "../../src/infrastructure/persistence/runtime-state-store.mjs";
import { CommandTraceService } from "../../src/application/command-trace-service.mjs";
import { CommandTraceWorkerStore } from "../../src/infrastructure/persistence/command-trace-worker-store.mjs";

const target = { provider: "codex", streamId: "user-stream", threadId: "user-thread" };
const item = (id) => ({ ...target, id, input: "user input", clientUserMessageId: id });
const gate = () => { let release; const promise = new Promise((r) => { release = r; }); return { promise, release }; };

function fixture(overrides = {}) {
  const host = new HubSessionState();
  host.setRestartRequest({ operationId: "original-restart", minimumUpdateOffset: 0, requestedAt: "2026-10-21T14:00:00Z" });
  const runs = new Map();
  const events = [];
  const active = (r) => ["running", "finishing"].includes(r?.status);
  const taskRuns = { values: () => [...runs.values()], forTask: (t) => [...runs.values()].find((r) => r.threadId === t.threadId && active(r)) };
  const providers = { call: (provider, action, value) => {
    if (action === "blocksRuntimeRestart") return active(value);
    assert.equal(action, "steerTurn"); events.push("steer"); return { turnId: value.run.turnId };
  } };
  const coordinator = new RunCoordinator({
    taskRuns, providers,
    isRestartPending: () => Boolean(host.restartRequest), // Original policy input, for the RED baseline.
    isRuntimeStopping: () => host.stopping,
    externalActivity: async () => ({ state: "inactive" }), repositoryConflict: async () => null,
    deferInput: async (input, _files, options) => ({ id: options.clientUserMessageId, item: { ...options, input }, duplicate: false }),
    beginRun: async (_input, t) => { const run = { ...t, id: t.clientUserMessageId ?? "run", status: "running" }; runs.set(run.id, run); return run; },
    rollbackAdmission: async (run) => runs.delete(run.id),
    launchTurn: async (run) => { events.push("launch"); run.turnId = "provider-turn"; },
    ...overrides,
  });
  const trace = [];
  const tracer = { recordBestEffort: (span) => trace.push(span) };
  const wiring = createRuntimeRestartWiring({
    taskRuns, agentProviders: providers, runCoordinator: coordinator,
    backgroundJobs: { activeSize: 0 }, streamMaintenance: { activeCount: () => 0 },
    getRestartRequest: () => host.restartRequest, isStopping: () => host.stopping,
    restartRequestService: { canPerform: () => true, performScheduled: async () => {} },
    runtimeRestart: {
      getRestartRequest: () => host.restartRequest, updateOffset: () => 0,
      beginStopping: () => host.beginStopping(), isStopping: () => host.stopping,
      setWaiting: async () => true, updateRestartMessage: async () => {}, saveState: async () => {},
      stopRuntimeTimers: () => {}, mediaController: { stop: () => {} },
      stopCodexAppServerTree: async () => {},
      commandTrace: tracer,
    },
  });
  const controller = wiring.runtimeRestart;
  controller.resources = Object.fromEntries(["quiesce", "drain", "close", "releaseLock", "finalize", "recover"].map((phase) => [phase, async () => ({ ok: true })]));
  controller.launchReplacement = async () => { events.push("replacement"); return { lock: { pid: 42 }, attempt: 1 }; };
  controller.finishSuccessfulReplacement = async () => {};
  controller.logger = { log() {}, error() {} };
  return { host, runs, events, coordinator, wiring, controller, trace, tracer };
}

test("pending restart with a long foreign run permits ordinary intake and queued dispatch", async () => {
  const f = fixture();
  f.runs.set("foreign", { id: "foreign", provider: "codex", threadId: "foreign-thread", status: "running" });
  const receipt = await f.coordinator.acceptClientInput({ input: "user input", target, clientUserMessageId: "original-command" });
  assert.equal(receipt.reason, "message-intake");
  await f.coordinator.startDeferred(item("original-command"));
  assert.deepEqual(f.events, ["launch"]);
  assert.equal((await f.wiring.performRestart()).status, "waiting-for-work");
  assert.equal(f.host.stopping, false);
  assert.equal(f.runs.get("foreign").status, "running");
});

test("pending restart permits exact steering without another turn", async () => {
  const f = fixture();
  f.runs.set("active", { ...target, id: "active", turnId: "original-turn", status: "running", executionOwner: "hub" });
  const receipt = await f.coordinator.acceptClientInput({ input: "clarification", target, clientUserMessageId: "original-steer", followUpMode: "steer" });
  assert.equal(receipt.steerPending, true);
  assert.equal(f.coordinator.admissionBarrier(target), null);
  const result = await f.coordinator.steer({ input: "clarification", target, clientUserMessageId: "original-steer" });
  assert.equal(result.steered, true);
  assert.deepEqual(f.events, ["steer"]);
});

test("real restart owner waits for in-flight admission before registration and never kills the accepted run", async () => {
  const held = gate(); const entered = gate();
  let f;
  f = fixture({ isRestartPending: () => false, beginRun: async (_input, t) => {
    entered.release(); await held.promise;
    const run = { ...t, id: "admitted-run", status: "running" }; f.runs.set(run.id, run); return run;
  } });
  const admission = f.coordinator.startDeferred(item("racing-command"));
  try {
    await entered.promise;
    assert.equal(f.coordinator.hasPendingAdmission(() => true), true);
    assert.equal((await f.wiring.performRestart()).status, "waiting-for-work");
    assert.equal(f.host.stopping, false);
  } finally { held.release(); await admission.catch(() => {}); }
  assert.deepEqual(f.events, ["launch"]);
  assert.equal((await f.wiring.performRestart()).status, "waiting-for-work");
  f.runs.get("admitted-run").status = "completed";
  assert.equal((await f.wiring.performRestart()).status, "replaced");
  assert.equal(f.events.filter((e) => e === "replacement").length, 1);
  assert.equal(f.host.stopping, true);
});

test("cutover wins atomically: every admission surface retains input and dispatch cannot start", async () => {
  const f = fixture();
  const held = gate(); const entered = gate();
  f.controller.setWaiting = async () => { entered.release(); await held.promise; return true; };
  const restart = f.wiring.performRestart();
  try {
    await entered.promise;
    assert.equal(f.host.stopping, true);
    for (const method of ["acceptClientInput", "submitClientInput"]) {
      const receipt = await f.coordinator[method]({ input: "new input", target, clientUserMessageId: method });
      assert.equal(receipt.reason, "runtime-restart");
      assert.equal(receipt.providerAccepted, false);
    }
    assert.equal((await f.coordinator.start("legacy input", [], { target })).reason, "runtime-restart");
    await assert.rejects(f.coordinator.startDeferred(item("queued-original")), { code: "ERR_RUNTIME_RESTART_PENDING" });
    await assert.rejects(f.coordinator.steer({ input: "late steer", target, clientUserMessageId: "late" }), { code: "ERR_RUNTIME_RESTART_PENDING" });
    assert.deepEqual(f.events, []);
  } finally { held.release(); await restart; }
});

test("pending restart never resumes a user-paused queue item", async () => {
  const f = fixture();
  const paused = { ...item("paused-original"), paused: true, manualPaused: true };
  const queuedInputs = new Map([[paused.id, paused]]);
  const controller = new DeferredInputController({
    pendingInputs: new Map(), queuedInputs,
    isBlocked: async () => Boolean(f.coordinator.admissionBarrier(target)),
    start: (entry) => f.coordinator.startDeferred(entry),
    persist: async () => {}, updateMessage: async () => {}, pendingKeyboard: () => null, notifyReturned: async () => {},
  });
  try {
    await controller.process(paused.id);
    assert.equal(queuedInputs.get(paused.id).manualPaused, true);
    assert.deepEqual(f.events, []);
  } finally { controller.stop(); }
});

test("readiness trace binds bounded blocker identities to the original restart and sink failure cannot block work", () => {
  const f = fixture();
  f.runs.set("private-run", { provider: "codex", id: "original-blocker-run", status: "running", prompt: "NEVER_TRACE_PAYLOAD" });
  assert.equal(f.wiring.restartBlockingWorkCount(), 1);
  assert.equal(f.wiring.restartBlockingWorkCount(), 1);
  assert.equal(f.trace.length, 1);
  assert.equal(f.trace[0].commandId, "original-restart");
  assert.deepEqual(f.trace[0].metadata.blockingRunIds, ["original-blocker-run"]);
  assert.equal(f.trace[0].outcome, "waiting");
  assert.doesNotMatch(JSON.stringify(f.trace), /NEVER_TRACE_PAYLOAD/u);
  f.runs.clear();
  assert.equal(f.wiring.restartBlockingWorkCount(), 0);
  assert.equal(f.trace.at(-1).outcome, "ready");
  f.tracer.recordBestEffort = () => { throw new Error("sink unavailable"); };
  f.runs.set("other", { provider: "codex", id: "other", status: "running" });
  assert.equal(f.wiring.restartBlockingWorkCount(), 1);
  f.tracer.recordBestEffort = (span) => f.trace.push(span);
  assert.equal(f.wiring.restartBlockingWorkCount(), 1);
  assert.deepEqual(f.trace.at(-1).metadata.blockingRunIds, ["other"]);
});

test("restart wiring fails closed without the actual pending-admission owner", () => {
  assert.throws(() => createRuntimeRestartWiring({}), /pending-admission owner/u);
});

test("original restart readiness measurements survive the real trace worker close and reopen", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hub313-readiness-trace-"));
  const databaseFile = path.join(directory, "traces.sqlite");
  let store = new CommandTraceWorkerStore({ databaseFile });
  try {
    await store.initialize();
    const service = new CommandTraceService({ store });
    const f = fixture();
    f.tracer.recordBestEffort = (span) => service.recordBestEffort(span);
    f.tracer.measureBestEffort = (input, action) => service.measureBestEffort(input, action);
    f.runs.set("original", { id: "exact-blocking-run", provider: "codex", status: "running" });
    f.wiring.restartBlockingWorkCount();
    f.runs.clear(); f.wiring.restartBlockingWorkCount();
    const first = await store.readCommandTimeline("original-restart");
    assert.deepEqual(first.map((span) => span.outcome), ["waiting", "ready"]);
    assert.equal((await f.wiring.performRestart()).status, "replaced");
    const completed = await store.readCommandTimeline("original-restart");
    for (const stage of ["quiesce", "save-state", "drain", "close", "release-lock"]) {
      assert.deepEqual(completed.filter((span) => span.stage === `restart-${stage}`).map((span) => span.outcome), ["started", "succeeded"]);
    }
    await store.close();
    store = new CommandTraceWorkerStore({ databaseFile });
    const reopened = await store.readCommandTimeline("original-restart");
    assert.deepEqual(reopened.map((span) => span.spanId), completed.map((span) => span.spanId));
    assert.deepEqual(reopened[0].metadata.blockingRunIds, ["exact-blocking-run"]);
  } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
});

test("input durably accepted during cutover survives stale snapshot, close and SQLite reopen with the same ID", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hub313-cutover-intake-"));
  let store = new RuntimeStateStore({ dataDir: directory });
  let f;
  try {
    await store.load();
    const deferredStore = new DeferredInputStore();
    const intake = new DeferredInputService({
      store: deferredStore,
      persist: async () => { throw new Error("Cutover intake must use the existing point-write owner"); },
      persistIntake: (entry, destination, receipt) => store.saveDeferredIntake({ item: entry, destination, receipt }),
      removeFiles: async () => {}, notify: async () => {},
    });
    f = fixture({ deferInput: (...args) => intake.defer(...args) });
    const held = gate(); const entered = gate();
    f.controller.resources.close = async () => { entered.release(); await held.promise; return { ok: true }; };
    const restart = f.wiring.performRestart();
    try {
      await entered.promise;
      const receipt = await f.coordinator.acceptClientInput({ input: "retained input", target, clientUserMessageId: "durable-original", messageFingerprint: "exact-fixture-payload" });
      assert.equal(receipt.reason, "runtime-restart");
      assert.equal(receipt.providerAccepted, false);
      assert.deepEqual(f.events, []);
      await store.save({ pendingInputs: [], queuedInputs: [], desktopMessageReceipts: [] });
    } finally { held.release(); await restart; }
    await store.close();
    store = new RuntimeStateStore({ dataDir: directory });
    const restored = (await store.load()).value;
    assert.equal(restored.queuedInputs.length, 1);
    const original = restored.queuedInputs[0];
    assert.equal(original.clientUserMessageId, "durable-original");
    assert.equal(original.input, "retained input");
    const duplicate = await store.saveDeferredIntake({ item: original, destination: "queued", receipt: {
      ...target, clientUserMessageId: "durable-original", fingerprint: "exact-fixture-payload",
    } });
    assert.equal(duplicate.duplicate, true);
    assert.equal(store.messageCommands().length, 1);
    f.host.setStopping(false); f.host.setRestartRequest(null);
    await f.coordinator.startDeferred(original);
    assert.equal(f.events.filter((event) => event === "launch").length, 1);
  } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
});
