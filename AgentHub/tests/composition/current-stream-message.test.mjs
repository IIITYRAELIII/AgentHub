import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { TaskRunRegistry, markProviderTurnAccepted, createObservedTaskRun } from "../../src/domain/task-runs.mjs";
import { RunCoordinator } from "../../src/application/run-coordinator.mjs";
import { DeferredInputService } from "../../src/application/deferred-input-service.mjs";
import { DeferredInputStore } from "../../src/application/deferred-input-store.mjs";
import { RuntimeStateStore } from "../../src/infrastructure/persistence/runtime-state-store.mjs";
import { MessageReceiptRegistry } from "../../src/infrastructure/persistence/message-receipts.mjs";
import { DeferredInputPresentationService } from "../../src/interfaces/desktop/deferred-input-presentation-service.mjs";
import { createDesktopMessageController } from "../../src/interfaces/desktop/desktop-message-controller.mjs";
import { createRunAdmissionComposition } from "../../src/composition/run-admission-composition.mjs";
import { createDesktopRunRouterWiring } from "../../src/composition/desktop-run-router-wiring-composition.mjs";
import { interstreamAuditContentHash, interstreamMessageDetails } from "../../src/domain/interstream-message.mjs";
import { mcpArgumentsHash } from "../../src/domain/mcp-arguments-hash.mjs";

const noop = async () => {};
const gate = () => { let release; const promise = new Promise((r) => { release = r; }); return { promise, release }; };

async function fixture(t, { desktopWiring = false } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hub-stream-routing-"));
  let store = new RuntimeStateStore({ dataDir: directory });
  let controller;
  t.after(async () => {
    controller?.stop(); await store.close();
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith("hub-stream-routing-"));
    await rm(directory, { recursive: true, force: true });
  });
  await store.load();
  const deferred = new DeferredInputStore(), receipts = new MessageReceiptRegistry();
  const taskRuns = new TaskRunRegistry();
  const target = { provider: "codex", streamId: "stream", threadId: "thread-A", projectRoot: directory,
    taskTitle: "Fixture", clientSource: "desktop-control", telegramDeliveryRequested: false };
  const state = { threadId: target.threadId, barrier: false, readback: null, provider: null };
  const effects = [], traces = [], timers = new Map(); let nextTimer = 0;
  const describeAttachments = (files) => files.map((file) => ({ id: path.basename(file), path: file }));
  const save = async () => {
    await state.beforeSave?.();
    return store.save({
    pendingInputs: [...deferred.pending.values()], queuedInputs: [...deferred.queued.values()],
    activeRuns: taskRuns.values(), desktopMessageReceipts: receipts.snapshot(),
    });
  };
  const intake = new DeferredInputService({ store: deferred, persist: save, removeFiles: noop, notify: noop,
    persistIntake: (item, destination, fallback) => store.saveDeferredIntake({ item, destination,
      receipt: receipts.get({ clientUserMessageId: item.clientUserMessageId }) ?? fallback }),
  });
  const providers = { call: async (_provider, action, ...args) => {
    if (action === "findTurnByClientMessage") return state.readback;
    if (action === "readTaskActivity") return { state: "inactive" };
    if (action === "steerTurn") {
      const request = args[0];
      if (state.provider) return state.provider(request);
      effects.push({ operation: "steer", id: request.clientUserMessageId, target: request.target, input: request.input });
      return { turnId: request.run.turnId };
    }
    throw new Error(`Unexpected fixture operation ${action}`);
  } };
  const coordinatorPorts = { taskRuns, providers, externalActivity: async () => state.external ?? ({ state: "inactive" }),
    repositoryConflict: async () => null, deferInput: (...args) => intake.defer(...args),
    isMaintenanceActive: () => state.barrier || state.providerCompaction,
    isManagedMaintenanceActive: () => state.barrier,
    rekeyDeferredOccupancy: async (binding) => {
      await state.beforeBind?.();
      return store.rekeyMessageCommandOccupancy(binding);
    },
    beginRun: async (_input, binding) => {
      const run = taskRuns.add({ ...binding, id: `new-${effects.length}`, status: "running" });
      if (binding.deferredInput) binding.deferredInput.dispatchingRunId = run.id;
      await save();
      return run;
    },
    rollbackAdmission: async (run) => { taskRuns.remove(run); await save(); },
    launchTurn: async (run, input) => {
      effects.push({ operation: "start", id: run.clientUserMessageId, target: run, input });
      run.turnId = "new-turn"; markProviderTurnAccepted(run, { turnId: run.turnId, provider: run.provider });
    }, describeAttachments,
  };
  const unused = new Proxy(() => {}, { get: () => unused });
  const coordinator = desktopWiring ? createDesktopRunRouterWiring({
    config: { dataDir: directory }, constants: { taskExecutionOwners: { HUB: "hub" } },
    state: unused, desktop: unused,
    services: new Proxy({ ...coordinatorPorts, attachmentDirectory: directory,
      composerTransfers: unused, taskBoard: unused, workspaceCatalog: unused,
      deferredInputs: deferred, pendingInputs: deferred.pending, queuedInputs: deferred.queued,
      saveState: save, receipts, describeAttachments,
      persistDeferredIntake: (item, destination, receipt) => store.saveDeferredIntake({ item, destination,
        receipt: receipts.get({ clientUserMessageId: item.clientUserMessageId }) ?? receipt }),
    }, { get: (ports, key) => key in ports ? ports[key] : unused }),
  }).runCoordinator : new RunCoordinator(coordinatorPorts);
  const presentation = new DeferredInputPresentationService({ receipts, describeAttachments });
  const compose = () => {
    const c = createRunAdmissionComposition({ config: {}, pendingInputs: deferred.pending, queuedInputs: deferred.queued,
      runCoordinator: coordinator, agentProviders: providers, taskRuns, runConflictPolicy: { check: async () => null },
      runtimeStateStore: store, saveState: save, taskExecutionOwners: { HUB: "hub" },
      commandTrace: {
        recordBestEffort: (span) => { if (state.throwDiagnostics) throw Error("fixture diagnostic sink"); traces.push(span); },
        startBestEffortSpan: (span) => {
          return { finish: (result) => traces.push({ ...span, ...result }) };
        },
      },
      deferredInputPresentation: presentation, stageLaunchAdmission: () => null, abortLaunchAdmission: () => {},
      workspaceCatalogStore: { stream: (id) => id === target.streamId ? { id } : null,
        mcpOperation: () => state.legacyOperation,
        activeThread: (id) => ({ streamId: id, provider: "codex", threadId: state.threadId, projectRoot: directory }) },
    }).deferredInputController;
    c.setTimeoutImpl = (callback) => { timers.set(++nextTimer, callback); return nextTimer; };
    c.clearTimeoutImpl = (id) => timers.delete(id);
    c.now = () => state.now ?? Date.now();
    c.monotonicNow = () => state.monotonicNow ?? performance.now();
    return c;
  };
  controller = compose();
  const desktop = createDesktopMessageController({ resolveTarget: async () => target, attachmentPaths: async (files) => files,
    describeAttachments, receipts, persistReceipts: save, runCoordinator: coordinator, durableIntake: true });
  const active = (name = "A", threadId = state.threadId) => taskRuns.add({ ...target, threadId,
    id: name, turnId: `turn-${name}`, status: "running", executionOwner: "hub" });
  const submit = async ({ mcp = false, attachments = [], responseAnnotations = [], followUpMode = "steer", clientId = "logical-original" } = {}) => {
    const id = mcp ? "mcp:fixture-request" : clientId;
    if (mcp) target.messageOrigin = { kind: "interstream", workspaceId: "workspace", workspaceName: "Fixture", streamId: "source-stream", streamName: "Source", provider: "codex", sourceThreadId: "source-thread", requestId: "fixture-request" };
    const result = await desktop.sendMessage({ text: "fixture body", clientUserMessageId: id, followUpMode, attachments, responseAnnotations },
      mcp ? { source: "mcp", bindInterstreamAuditContent: noop } : null);
    return { result, item: deferred.get(result.id), id };
  };
  return { state, target, taskRuns, active, submit, effects, traces, deferred, coordinator, desktop, receipts, directory,
    process: (item) => controller.process(item.id), command: (id) => store.messageCommand(id), save,
    transition: (value) => store.transitionMessageCommand(value),
    wake: () => controller.wakeAll(),
    schedule: (item, delay) => controller.schedule(item, delay),
    async fireTimer() { const [id, callback] = timers.entries().next().value; timers.delete(id); await callback(); },
    pause: (item) => { item.paused = true; item.manualPaused = true; },
    async reopen() {
      controller.stop(); await store.close(); store = new RuntimeStateStore({ dataDir: directory });
      const restored = (await store.load()).value;
      deferred.pending.clear(); deferred.queued.clear();
      for (const item of restored.pendingInputs ?? []) deferred.put(item, "pending");
      for (const item of restored.queuedInputs ?? []) deferred.put(item, "queued");
      receipts.restore(restored.desktopMessageReceipts); controller = compose();
    },
  };
}

for (const legacy of [false, true]) test(`owned queue waits for managed terminal without a writer pause: legacy=${legacy}`, async (t) => {
  const f = await fixture(t); const run = f.active();
  const file = path.join(f.directory, "owned-attachment.bin"); await writeFile(file, Buffer.from([3, 8, 4]));
  const annotations = Array.from({ length: 6 }, (_, i) => ({ text: `Quote ${i+1}`, annotation: `Comment ${i+1}` }));
  const { item, id } = await f.submit({ followUpMode: "queue", attachments: [file], responseAnnotations: annotations });
  if (legacy) { item.paused = true; item.waitReason = "provider-thread-active"; await f.save(); }
  await f.process(item);
  assert.equal(item.waitReason, "task-running");
  assert.notEqual(item.paused, true);
  assert.equal(f.effects.length, 0); assert.equal(item.attempts ?? 0, 0);
  await f.reopen();
  const restored = f.deferred.get(item.id);
  assert.equal(restored.waitReason, "task-running"); assert.notEqual(restored.paused, true);
  f.taskRuns.remove(run); f.wake();
  await f.fireTimer();
  await Promise.all([f.process(restored), f.process(restored)]);
  assert.equal(f.effects.length, 1); assert.equal(f.effects[0].operation, "start");
  assert.equal(f.effects[0].id, id); assert.equal(f.deferred.size, 0);
  assert.deepEqual(f.effects[0].input, item.input);
  assert.deepEqual(f.receipts.get({ clientUserMessageId: id }).result.responseAnnotations, annotations);
  assert.deepEqual(f.receipts.get({ clientUserMessageId: id }).result.attachments.map(a => a.id), ["owned-attachment.bin"]);
});

for (const owner of ["external", "desktop", undefined, "unrecognized", "hub", "telegram"]) {
  for (const activityUnknown of [false, true]) test(`registered observer preserves exact owner across queue reopen: ${owner}/${activityUnknown}`, async (t) => {
    const f = await fixture(t);
    const run = createObservedTaskRun({ ...f.target, id: "observer", turnId: "observed-turn", executionOwner: owner });
    run.activityUnknown = activityUnknown; f.taskRuns.add(run);
    const hubOwned = ["hub", "telegram"].includes(owner);
    const reason = hubOwned ? activityUnknown ? "managed-run-activity-unknown" : "task-running"
      : activityUnknown || !["external", "desktop"].includes(owner) ? "provider-temporarily-unavailable" : "provider-thread-active";
    const occupancy = await f.coordinator.deferredOccupancy(f.target);
    assert.equal(occupancy.waitReason, reason); assert.equal(occupancy.occupied, true);
    const { item, id } = await f.submit({ followUpMode: "queue" });
    item.paused = true; item.waitReason = "provider-thread-active"; await f.save();
    await f.process(item); await f.reopen();
    const restored = f.deferred.get(item.id);
    assert.equal(restored.clientUserMessageId, id); assert.equal(restored.waitReason, reason);
    assert.equal(restored.paused === true, !hubOwned); assert.equal(f.effects.length, 0);
    if (hubOwned) {
      f.taskRuns.remove(run); f.wake(); await f.fireTimer();
      assert.equal(f.effects.length, 1); assert.equal(f.effects[0].id, id);
    }
  });
}

test("managed UNKNOWN, real external writer and manual queue pause retain distinct fences", async (t) => {
  const f = await fixture(t); const run = f.active();
  run.activityUnknown = true;
  const { item } = await f.submit({ followUpMode: "queue" });
  await f.process(item);
  assert.equal(item.waitReason, "managed-run-activity-unknown"); assert.equal(f.effects.length, 0);
  f.taskRuns.remove(run); f.state.external = { state: "active" };
  await f.process(item);
  assert.equal(item.waitReason, "provider-thread-active"); assert.equal(item.paused, true);
  f.state.external = { state: "unknown" }; await f.process(item);
  assert.equal(item.waitReason, "provider-temporarily-unavailable"); assert.equal(f.effects.length, 0);
  f.pause(item); f.state.external = { state: "inactive" };
  await f.process(item); f.wake();
  assert.equal(item.manualPaused, true); assert.equal(f.effects.length, 0);
});

for (const scenario of ["same", "new", "idle", "rotated"]) test(`ordinary UI command routes current-or-queue: ${scenario}`, async (t) => {
  const f = await fixture(t); const a = f.active();
  const file = path.join(f.directory, "attachment.bin"); await writeFile(file, Buffer.from([1, 2, 3]));
  const { item, id } = await f.submit({ attachments: [file] });
  assert.equal(f.command(id).state, "queued"); assert.equal(f.effects.length, 0);
  if (scenario !== "same") f.taskRuns.remove(a);
  if (scenario === "rotated") f.state.threadId = "thread-B";
  if (["new", "rotated"].includes(scenario)) f.active("B");
  await f.process(item);
  assert.equal(f.effects.length, 1); assert.equal(f.effects[0].id, id);
  assert.equal(f.effects[0].operation, scenario === "idle" ? "start" : "steer");
  assert.equal(f.effects[0].target.threadId, f.state.threadId);
  assert.equal(f.command(id).occupancyKey.includes(f.state.threadId), true);
  assert.equal(f.effects[0].target.steerTargetTurnId, scenario === "idle" ? undefined : `turn-${scenario === "same" ? "A" : "B"}`);
  assert.deepEqual(f.effects[0].input, item.input);
  assert.deepEqual(f.receipts.get({ clientUserMessageId: id }).result.attachments.map((a) => a.id), ["attachment.bin"]);
  assert.equal(f.deferred.size, 0); await f.process(item); assert.equal(f.effects.length, 1);
  await f.submit({ attachments: [file] }); assert.equal(f.effects.length, 1);
});

test("interstream steer uses the same owning fallback after a definite turn race", async (t) => {
  const f = await fixture(t); const a = f.active(); const { item, id } = await f.submit({ mcp: true });
  let attempts = 0;
  f.state.provider = async () => { attempts++; f.taskRuns.remove(a); throw Object.assign(new Error("Active turn not steerable"), { deliveryOutcome: "rejected" }); };
  await f.process(item);
  assert.equal(attempts, 1); assert.equal(f.deferred.queued.get(item.id), item); assert.equal(f.deferred.pending.size, 0);
  assert.equal(item.lastErrorCode, undefined); assert.equal(item.dispatchingAt, undefined);
  f.state.provider = null; f.active("B"); await f.process(item);
  assert.equal(f.effects.length, 1); assert.equal(f.effects[0].id, id);
  assert.equal(f.effects[0].target.steerTargetTurnId, "turn-B");
  assert.deepEqual(f.effects[0].target.messageOrigin, item.messageOrigin);
});

test("a rejected still-active turn waits without repeated RPC, then idle launches once", async (t) => {
  const f = await fixture(t); const a = f.active(); const { item } = await f.submit(); let attempts = 0;
  f.state.provider = async () => { attempts++; throw new Error("No active turn"); };
  await f.process(item); await f.process(item); await f.process(item);
  assert.equal(attempts, 1); assert.equal(f.effects.length, 0); assert.equal(f.deferred.pending.size, 0);
  f.taskRuns.remove(a); await f.process(item);
  assert.equal(f.effects.length, 1); assert.equal(f.effects[0].operation, "start");
});

test("lost ACK pins original attempt across restart and rotation; exact readback retires without resend", async (t) => {
  const f = await fixture(t); const a = f.active(); const { item, id } = await f.submit(); let attempts = 0;
  f.state.provider = async () => { attempts++; throw Object.assign(new Error("expectedTurnId reply lost"), { deliveryOutcome: "unknown" }); };
  await f.process(item); assert.equal(attempts, 1); assert.ok(item.dispatchingAt);
  assert.equal(f.command(id).state, "dispatching");
  assert.equal(item.waitReason, "provider-steer-unconfirmed");
  f.taskRuns.remove(a); f.state.threadId = "thread-B"; f.active("B");
  await f.reopen(); const restored = f.deferred.get(item.id);
  assert.equal(restored.deliveryTarget.threadId, "thread-A");
  await f.process(restored); assert.equal(attempts, 1); assert.equal(f.effects.length, 0);
  f.state.readback = { id: "turn-A" }; await f.process(restored);
  assert.equal(f.deferred.size, 0); assert.equal(attempts, 1); assert.equal(f.effects.length, 0);
  assert.equal(f.receipts.get({ clientUserMessageId: id }).result.threadId, "thread-A");
});

test("compaction barrier, manual pause, concurrent wake and cancellation retain one owner", async (t) => {
  const f = await fixture(t); f.active(); const { item } = await f.submit();
  f.state.barrier = true; await f.process(item); assert.equal(f.effects.length, 0);
  f.state.barrier = false; f.pause(item); await f.save(); await f.reopen();
  const paused = f.deferred.get(item.id); await f.process(paused); assert.equal(f.effects.length, 0);
  delete paused.paused; delete paused.manualPaused;
  const held = gate(), entered = gate(); let calls = 0;
  f.state.provider = async () => { calls++; entered.release(); await held.promise; return { turnId: "turn-A" }; };
  const processing = f.process(paused);
  try { await entered.promise; await f.process(paused); assert.equal(calls, 1); }
  finally { held.release(); await processing; }
  assert.equal(f.deferred.size, 0);
});

for (const desktopWiring of [false, true]) test(`provider-internal compaction does not hold exact active steer: desktop wiring ${desktopWiring}`, async (t) => {
  const f = await fixture(t, { desktopWiring }); f.active();
  f.state.providerCompaction = true;
  const file = path.join(f.directory, "during-compaction.bin");
  await writeFile(file, Buffer.from([7, 8, 9]));
  const { item, id } = await f.submit({ attachments: [file] });
  await f.process(item);
  assert.equal(f.state.providerCompaction, true);
  assert.equal(f.effects.length, 1, "existing provider turn receives input before compaction is released");
  assert.equal(f.effects[0].operation, "steer");
  assert.equal(f.effects[0].id, id);
  assert.equal(f.effects[0].target.steerTargetTurnId, "turn-A");
  assert.deepEqual(f.effects[0].input, item.input);
  assert.deepEqual(f.receipts.get({ clientUserMessageId: id }).result.attachments.map((a) => a.id), ["during-compaction.bin"]);
  await f.process(item); assert.equal(f.effects.length, 1);
});

test("native compaction exception never opens idle, unbound, foreign, managed or stopping admission", async (t) => {
  for (const scenario of ["idle", "unbound", "foreign", "managed", "stopping", "explicit-queue", "exact-service"]) await t.test(scenario, async (t) => {
    const f = await fixture(t, { desktopWiring: true });
    const run = scenario === "idle" ? null : f.active();
    if (scenario === "unbound") delete run.turnId;
    if (scenario === "foreign") run.executionOwner = "external";
    f.state.providerCompaction = true;
    if (scenario === "managed") f.state.barrier = true;
    if (scenario === "stopping") f.coordinator.isRuntimeStopping = () => true;
    const { item, id } = await f.submit({ followUpMode: scenario === "explicit-queue" ? "queue" : "steer" });
    if (scenario === "exact-service") delete item.streamId;
    await f.process(item);
    assert.equal(f.effects.length, 0);
    if (scenario !== "explicit-queue") assert.equal(f.command(id).state, "queued");
    else {
      await f.save(); await f.reopen();
      assert.equal(f.deferred.get(item.id)?.clientUserMessageId, id);
      assert.notEqual(f.receipts.get({ clientUserMessageId: id }).result.providerAccepted, true);
    }
  });
});

test("wake timing separates timer delay from the retained managed barrier without leaking payload", async (t) => {
  const f = await fixture(t, { desktopWiring: true }); f.active(); f.state.barrier = true;
  const { item, id } = await f.submit(); f.state.now = 1000; f.state.monotonicNow = 1000;
  f.schedule(item, 2000); f.state.now = 195000; f.state.monotonicNow = 95000; await f.fireTimer();
  assert.equal(f.effects.length, 0);
  const wake = f.traces.find((s) => s.stage === "deferred-wake" && s.outcome === "started");
  assert.equal(wake.commandId, id); assert.equal(wake.metadata.delayMs, 2000);
  assert.equal(wake.metadata.timerLagMs, 92000);
  const barrier = f.traces.find((s) => s.stage === "deferred-steer-barrier" && s.outcome === "succeeded");
  assert.equal(barrier.metadata.blocked, true); assert.equal(barrier.metadata.waitReason, "context-maintenance");
  assert.equal(JSON.stringify(f.traces).includes("fixture body"), false);
  f.state.barrier = false; f.state.providerCompaction = true; f.state.throwDiagnostics = true;
  f.wake(); await f.fireTimer();
  assert.equal(f.effects.length, 1); assert.equal(f.effects[0].id, id);
});

test("late accepted receipt beats fallback; cancelled and foreign Stream state never sends", async (t) => {
  const f = await fixture(t); const a = f.active(); const { item, id } = await f.submit();
  f.state.provider = async () => { throw new Error("No active turn"); };
  await f.process(item); f.taskRuns.remove(a);
  f.receipts.updateResult({ clientUserMessageId: id }, { accepted: true, providerAccepted: true, steered: true, turnId: "turn-A", threadId: "thread-A", runId: "A", deferred: false, queued: false });
  await f.save(); await f.process(item);
  assert.equal(f.deferred.size, 0); assert.equal(f.effects.length, 0);
  const foreign = { ...item, id: "foreign", streamId: "foreign-stream", clientUserMessageId: "foreign-id", dispatchingAt: undefined };
  f.deferred.put(foreign, "queued"); await f.process(foreign); assert.equal(f.effects.length, 0);
});

test("ordinary omitted mode and idle intake still find an active turn appearing before dispatch", async (t) => {
  const f = await fixture(t); const { item } = await f.submit({ followUpMode: "" });
  assert.equal(item.conflictKind, "message-intake");
  assert.equal(item.followUpMode, "steer");
  f.active("B"); await f.process(item);
  assert.equal(f.effects.length, 1); assert.equal(f.effects[0].operation, "steer");
  assert.equal(f.effects[0].target.steerTargetTurnId, "turn-B");
});

test("explicit after-turn queue does not become a steer", async (t) => {
  const f = await fixture(t); const a = f.active(); const { item } = await f.submit({ followUpMode: "queue" });
  await f.process(item); assert.equal(f.effects.length, 0);
  f.taskRuns.remove(a); await f.process(item);
  assert.equal(f.effects.length, 1); assert.equal(f.effects[0].operation, "start");
});

test("startup migrates only definite held human messages, retaining command and attachment identities", async (t) => {
  const f = await fixture(t); const a = f.active();
  const file = path.join(f.directory, "retained.bin"); await writeFile(file, Buffer.from([4, 5, 6]));
  const { item, id } = await f.submit({ attachments: [file] }); f.taskRuns.remove(a);
  item.lastErrorCode = "ERR_PROVIDER_STEER_NOT_DELIVERED"; item.laneReleased = true;
  f.deferred.put(item, "pending"); await f.save(); await f.reopen(); f.wake();
  const restored = f.deferred.get(item.id); await f.process(restored);
  assert.equal(f.effects.length, 1); assert.equal(f.effects[0].id, id);
  assert.deepEqual(f.effects[0].input, item.input);
  assert.equal(f.receipts.get({ clientUserMessageId: id }).result.attachments[0].id, "retained.bin");
  assert.equal(f.deferred.size, 0); assert.equal(f.command(id).state, "started");
});

test("cancelled, paused and historical service holds are never revived by migration", async (t) => {
  const f = await fixture(t); const { item, id } = await f.submit();
  item.lastErrorCode = "ERR_PROVIDER_STEER_NOT_DELIVERED"; item.manualPaused = true; item.paused = true;
  f.deferred.put(item, "pending"); await f.save(); await f.process(item);
  assert.equal(f.effects.length, 0); assert.equal(f.deferred.pending.size, 1);
  delete item.manualPaused; delete item.paused; item.clientSource = "mcp";
  await f.process(item); assert.equal(f.effects.length, 0); assert.equal(f.deferred.pending.size, 1);
  assert.equal((await f.transition({ clientUserMessageId: id, state: "cancelled", result: { cancelled: true } })).changed, true);
  await f.process(item); assert.equal(f.effects.length, 0); assert.equal(f.deferred.size, 0);
  assert.equal(f.command(id).state, "cancelled");
});

test("a late receipt is rechecked inside serialized provider dispatch", async (t) => {
  const f = await fixture(t); f.active(); const { item, id } = await f.submit();
  const held = gate(), entered = gate();
  const queued = gate(); const steer = f.coordinator.steer.bind(f.coordinator);
  f.coordinator.steer = (request) => { queued.release(); return steer(request); };
  const lane = f.coordinator.serialize(f.target, async () => { entered.release(); await held.promise; });
  await entered.promise;
  const processing = f.process(item);
  try {
    await queued.promise;
    f.receipts.updateResult({ clientUserMessageId: id }, { accepted: true, providerAccepted: true,
      steered: true, turnId: "turn-A", threadId: "thread-A", runId: "A", queued: false, deferred: false });
    await f.save();
  } finally { held.release(); await lane; await processing; }
  assert.equal(f.effects.length, 0); assert.equal(f.deferred.size, 0);
});

test("a catalog rebind while serialized steer waits cannot deliver to the old Thread", async (t) => {
  const f = await fixture(t); f.active(); const { item } = await f.submit();
  const held = gate(), entered = gate(), queued = gate();
  const steer = f.coordinator.steer.bind(f.coordinator);
  f.coordinator.steer = (request) => { queued.release(); return steer(request); };
  const lane = f.coordinator.serialize(f.target, async () => { entered.release(); await held.promise; });
  await entered.promise; const processing = f.process(item);
  try { await queued.promise; f.state.threadId = "thread-B"; }
  finally { held.release(); await lane; await processing; }
  assert.equal(f.effects.length, 0); assert.equal(f.deferred.queued.has(item.id), true);
  f.active("B"); await f.process(item);
  assert.equal(f.effects.length, 1); assert.equal(f.effects[0].target.threadId, "thread-B");
});

test("held unknown after foreground reconciliation expires still reads back only the original attempt", async (t) => {
  const f = await fixture(t); const a = f.active(); const { item } = await f.submit(); let attempts = 0;
  f.state.provider = async () => { attempts++; throw Object.assign(new Error("reply lost"), { deliveryOutcome: "unknown" }); };
  await f.process(item);
  item.providerReconciliationStartedAt = new Date(Date.now() - 600_000).toISOString();
  await f.process(item); assert.equal(f.deferred.pending.has(item.id), true);
  assert.equal(item.lastErrorCode, "ERR_PROVIDER_STEER_UNCONFIRMED");
  f.taskRuns.remove(a); f.state.threadId = "thread-B"; f.active("B"); await f.reopen();
  f.state.readback = { id: "turn-A" }; await f.process(f.deferred.get(item.id));
  assert.equal(f.deferred.size, 0); assert.equal(attempts, 1); assert.equal(f.effects.length, 0);
});

test("failed pre-dispatch durability cannot send or lose the same command", async (t) => {
  const f = await fixture(t); f.active(); const { item, id } = await f.submit();
  f.state.beforeSave = async () => { throw new Error("fixture persistence unavailable"); };
  await assert.rejects(f.process(item), /fixture persistence unavailable/);
  assert.equal(f.effects.length, 0); assert.equal(item.dispatchingAt, undefined);
  assert.equal(f.deferred.get(item.id), item); assert.equal(f.command(id).state, "queued");
  f.state.beforeSave = null; await f.process(item); assert.equal(f.effects.length, 1);
});

test("a late accepted receipt prevents FIFO launch after fallback even while its lane waits", async (t) => {
  const f = await fixture(t); const a = f.active(); const { item, id } = await f.submit();
  f.state.provider = async () => { throw new Error("No active turn"); }; await f.process(item); f.taskRuns.remove(a);
  const held = gate(), entered = gate(), queued = gate();
  const start = f.coordinator.startDeferred.bind(f.coordinator);
  f.coordinator.startDeferred = (value) => { queued.release(); return start(value); };
  const lane = f.coordinator.serialize(f.target, async () => { entered.release(); await held.promise; });
  await entered.promise; const processing = f.process(item);
  try {
    await queued.promise;
    f.receipts.updateResult({ clientUserMessageId: id }, { accepted: true, providerAccepted: true,
      steered: true, turnId: "turn-A", threadId: "thread-A", runId: "A", queued: false, deferred: false });
    await f.save();
  } finally { held.release(); await lane; await processing; }
  assert.equal(f.effects.length, 0); assert.equal(f.deferred.size, 0); assert.equal(f.taskRuns.values().length, 0);
});

test("catalog drift during awaited queued admission rolls back before provider launch", async (t) => {
  const f = await fixture(t); const { item } = await f.submit();
  const begin = f.coordinator.beginRun;
  f.coordinator.beginRun = async (...args) => { const run = await begin(...args); f.state.threadId = "thread-B"; return run; };
  await f.process(item);
  assert.equal(f.effects.length, 0); assert.equal(f.taskRuns.values().length, 0);
  assert.equal(f.deferred.queued.has(item.id), true);
  f.active("B"); await f.process(item);
  assert.equal(f.effects.length, 1); assert.equal(f.effects[0].target.threadId, "thread-B");
});

test("a rolled-back rotated admission durably rebinds the same command again after reopen", async (t) => {
  const f = await fixture(t); const a = f.active(); const { item, id } = await f.submit();
  f.taskRuns.remove(a); f.state.threadId = "thread-B";
  const begin = f.coordinator.beginRun;
  f.coordinator.beginRun = async (...args) => { const run = await begin(...args); f.state.threadId = "thread-C"; return run; };
  await f.process(item);
  assert.equal(f.effects.length, 0); assert.equal(f.taskRuns.values().length, 0);
  await f.reopen(); f.coordinator.beginRun = begin;
  const restored = f.deferred.get(item.id);
  await f.process(restored);
  assert.equal(f.effects.length, 1); assert.equal(f.effects[0].target.threadId, "thread-C");
  assert.equal(f.command(id).occupancyKey.includes("thread-C"), true);
});

for (const mode of ["steer", "start"]) test(`manual pause while durable ${mode} binding waits prevents the provider effect`, async (t) => {
  const f = await fixture(t); const a = f.active(); const { item } = await f.submit();
  if (mode === "start") f.taskRuns.remove(a);
  const entered = gate(), held = gate();
  f.state.beforeBind = async () => { entered.release(); await held.promise; };
  const processing = f.process(item);
  try { await entered.promise; f.pause(item); await f.save(); }
  finally { held.release(); await processing; }
  assert.equal(f.effects.length, 0); assert.equal(item.manualPaused, true);
  assert.equal(f.deferred.queued.has(item.id), true); assert.equal(item.dispatchingAt, undefined);
  await f.reopen(); const restored = f.deferred.get(item.id);
  assert.equal(restored.manualPaused, true); await f.process(restored); assert.equal(f.effects.length, 0);
});

for (const outcome of ["accepted", "cancelled"]) test(`a late ${outcome} receipt wins while rotated durable binding waits`, async (t) => {
  const f = await fixture(t); const a = f.active(); const { item, id } = await f.submit();
  f.taskRuns.remove(a); f.state.threadId = "thread-B"; f.active("B");
  const entered = gate(), held = gate();
  f.state.beforeBind = async () => { entered.release(); await held.promise; };
  const processing = f.process(item);
  try {
    await entered.promise;
    if (outcome === "cancelled") await f.transition({ clientUserMessageId: id,
      expectedStates: ["dispatching"], state: "cancelled", result: { cancelled: true } });
    else {
      f.receipts.updateResult({ clientUserMessageId: id }, { accepted: true, providerAccepted: true,
        steered: true, turnId: "turn-A", threadId: "thread-A", runId: "A", queued: false, deferred: false });
      await f.save();
    }
  } finally { held.release(); await processing; }
  assert.equal(f.effects.length, 0); assert.equal(f.deferred.size, 0);
});

test("ordinary messages retain FIFO on the current Thread without consuming an explicit after-turn queue", async (t) => {
  const f = await fixture(t); const a = f.active();
  const afterTurn = await f.submit({ clientId: "after-turn", followUpMode: "queue" });
  const first = await f.submit({ clientId: "first" });
  f.taskRuns.remove(a); f.state.threadId = "thread-B"; f.active("B");
  const second = await f.submit({ clientId: "second" });
  await f.process(second.item); assert.equal(f.effects.length, 0);
  await f.process(first.item); await f.process(second.item);
  assert.deepEqual(f.effects.map((effect) => effect.id), ["first", "second"]);
  assert.equal(f.deferred.get(afterTurn.item.id), afterTurn.item);
  assert.equal(f.deferred.queued.has(afterTurn.item.id), true);
});

for (const originalMode of ["steer", "queue"]) test(`legacy idle ${originalMode} retains its original mode when a new unknown-status managed turn appears`, async (t) => {
  const f = await fixture(t); f.target.clientSource = "mcp";
  const { item, id } = await f.submit({ mcp: true });
  delete item.followUpMode; item.createdAt = new Date(Date.now() - 900_000).toISOString(); await f.save();
  const details = interstreamMessageDetails(item.input), origin = item.messageOrigin;
  f.state.legacyOperation = { status: "succeeded", toolName: "hub_stream_message_send", requestId: origin.requestId,
    workspaceId: origin.workspaceId, streamId: origin.streamId, provider: origin.provider, threadId: origin.sourceThreadId,
    argumentsHash: mcpArgumentsHash({ confirm_send: true, request_id: origin.requestId, stream_id: item.streamId,
      text: details.text, mode: originalMode }), interstreamContentHash: interstreamAuditContentHash(item.input),
    result: { target: { streamId: item.streamId }, delivery: { id: item.id, clientUserMessageId: id,
      streamId: item.streamId, queued: true, providerAccepted: false } } };
  f.active("B").activityUnknown = true; // Public UNKNOWN is a projection, registry status remains running.
  await f.process(item);
  if (originalMode === "steer") {
    assert.equal(f.effects.length, 1); assert.equal(f.effects[0].id, id);
    assert.equal(f.effects[0].target.steerTargetTurnId, "turn-B");
    assert.equal(f.command(id).item.followUpMode, "steer");
    await f.reopen(); await f.process(item); assert.equal(f.effects.length, 1);
  } else {
    assert.equal(f.effects.length, 0); assert.equal(f.command(id).state, "queued");
    assert.equal(f.command(id).item.waitReason, "managed-run-activity-unknown");
    const trace = f.traces.find((s) => s.stage === "deferred-eligibility" && s.outcome === "succeeded");
    assert.equal(trace.metadata.blocked, true); assert.equal(trace.metadata.queueAgeMs >= 900_000, true);
    assert.equal(trace.metadata.waitReason, "managed-run-activity-unknown");
  }
});
