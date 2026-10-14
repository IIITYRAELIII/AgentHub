import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createRunAdmissionComposition } from "../../src/composition/run-admission-composition.mjs";
import { RuntimeStateStore } from "../../src/infrastructure/persistence/runtime-state-store.mjs";
import { MessageCommandLedgerStore, messageCommandLedgerPath } from "../../src/infrastructure/persistence/message-command-ledger-store.mjs";
import { MESSAGE_COMMAND_LIFETIME_MS } from "../../src/domain/message-command-expiry.mjs";
import { RunCoordinator } from "../../src/application/run-coordinator.mjs";
import { messageCommandFixture } from "../fixtures/message-command-ledger.mjs";

async function fixture(context, options = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "hub-command-expiry-"));
  let now = Date.parse("2026-09-01T00:00:00Z");
  const store = new RuntimeStateStore({ dataDir, messageCommandOptions: { now: () => now,
    maxActiveCommands: options.maxActiveCommands ?? 500 } });
  const pendingInputs = new Map();
  const queuedInputs = new Map();
  const runs = [];
  const receipts = [];
  const timers = new Map();
  let timerId = 0;
  let launches = 0;
  const taskRuns = { values: () => runs, forTask: () => runs[0] ?? null };
  const coordinator = new RunCoordinator({
    taskRuns,
    providers: { call: async () => ({}) },
    externalActivity: async () => ({ state: "inactive" }),
    repositoryConflict: async () => false,
    deferInput: async () => ({}),
    beginRun: async (input, target) => {
      const run = { ...target, id: "new-run", turnId: "new-turn", status: "running" };
      runs.push(run);
      return run;
    },
    rollbackAdmission: async () => {},
    launchTurn: async () => { launches += 1; },
  });
  const admission = createRunAdmissionComposition({
    config: { deferredInputTtlHours: 168 },
    taskRuns, runCoordinator: coordinator, pendingInputs, queuedInputs,
    runConflictPolicy: { check: async () => false },
    stageLaunchAdmission: () => true,
    abortLaunchAdmission: () => true,
    saveState: async () => {},
    deferredInputPresentation: {
      updateDesktopReceipt: (...args) => receipts.push(args),
      updateTelegramMessage: async () => {},
    },
    runtimeStateStore: store,
  });
  const controller = admission.deferredInputController;
  controller.now = () => now;
  controller.setTimeoutImpl = (callback, delay) => {
    const id = ++timerId;
    timers.set(id, { callback, delay });
    return id;
  };
  controller.clearTimeoutImpl = (id) => timers.delete(id);
  context.after(async () => {
    controller.stop();
    await store.close();
    await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  async function accept(id, { state = "queued", result = null, inMemory = false, item = {} } = {}) {
    const command = messageCommandFixture({ clientUserMessageId: id, itemId: id,
      fingerprint: `fingerprint-${id}`, item: { createdAt: new Date(now).toISOString(), ...item } });
    await store.saveDeferredIntake({ ...command, destination: "queued" });
    if (state !== "queued") await store.transitionMessageCommand({ clientUserMessageId: id, state, result });
    if (inMemory) (state === "attention-required" ? pendingInputs : queuedInputs).set(id, command.item);
    return command;
  }
  return { store, controller, coordinator, dataDir, pendingInputs, queuedInputs, runs, receipts,
    timers, accept, now: () => now, advance: (milliseconds) => { now += milliseconds; },
    launches: () => launches };
}

test("startup expires old started commands without queue projections, preserves exact active aliases", async (context) => {
  const f = await fixture(context);
  await f.accept("stale", { state: "started", result: { accepted: true, runId: "old-run" } });
  const retainedItem = f.store.messageCommand("stale").item;
  await f.accept("root", { state: "started" });
  await f.accept("steer", { state: "started", result: { provider: "codex", threadId: "thread-1", turnId: "live-turn" } });
  await f.accept("run-alias", { state: "unknown", result: { provider: "codex", threadId: "thread-1", runId: "live-run" } });
  await f.accept("user-alias", { state: "started" });
  await f.accept("foreign-turn", { state: "started", result: { provider: "claude", threadId: "thread-1", turnId: "live-turn" } });
  f.runs.push({ id: "live-run", provider: "codex", threadId: "thread-1", turnId: "live-turn",
    clientUserMessageId: "root", status: "running", userMessages: [{ clientUserMessageId: "user-alias" }] });
  f.advance(MESSAGE_COMMAND_LIFETIME_MS);
  f.controller.startExpiryMaintenance();
  for (const id of ["stale", "foreign-turn"]) assert.equal(f.store.messageCommand(id).result.expired, true);
  for (const id of ["root", "steer", "run-alias", "user-alias"]) assert.notEqual(f.store.messageCommand(id).state, "cancelled");
  assert.equal(f.store.messageCommand("stale").result.accepted, true);
  assert.equal(f.store.messageCommand("stale").result.completed, false);
  assert.equal(f.store.messageCommand("stale").result.providerEffectOutcome, "unknown");
  assert.deepEqual(f.store.messageCommand("stale").item, retainedItem);
  assert.equal(f.launches(), 0);
  f.runs.length = 0;
  const tick = [...f.timers.values()].find((timer) => timer.delay === 60_000);
  tick.callback();
  assert.equal(f.store.messageCommand("steer").result.expired, true);
});

test("deadline is acceptedAt, retries and snapshot writes do not extend it; intake frees capacity", async (context) => {
  const f = await fixture(context, { maxActiveCommands: 1 });
  const old = await f.accept("old", { state: "unknown" });
  f.advance(MESSAGE_COMMAND_LIFETIME_MS - 1);
  await f.store.save({ pendingInputs: [old.item], desktopMessageReceipts: [old.receipt] });
  assert.equal((await f.store.saveDeferredIntake(old)).duplicate, true);
  assert.equal(f.store.expireMessageCommands().expired, 0);
  f.advance(1);
  await f.accept("new");
  const retry = await f.store.saveDeferredIntake(old);
  assert.equal(retry.duplicate, true);
  assert.equal(retry.retryResult.expired, true);
  assert.equal(retry.retryResult.providerEffectOutcome, "unknown");
  assert.equal(f.store.messageCommand("new").state, "queued");
  await f.store.save({ queuedInputs: [old.item], desktopMessageReceipts: [old.receipt] });
  assert.equal(f.store.messageCommand("old").state, "cancelled");
  assert.equal(f.launches(), 0);
});

test("expiry removes paused and pending projections durably and stale manual dispatch cannot launch", async (context) => {
  const f = await fixture(context);
  const paused = await f.accept("paused", { inMemory: true, item: { paused: true } });
  await f.accept("pending", { state: "attention-required", inMemory: true });
  await f.accept("runnable", { inMemory: true });
  f.advance(MESSAGE_COMMAND_LIFETIME_MS);
  await f.controller.process("runnable");
  assert.equal(f.queuedInputs.size, 0);
  assert.equal(f.pendingInputs.size, 0);
  await assert.rejects(f.coordinator.startDeferred(paused.item), { code: "MESSAGE_COMMAND_EXPIRED" });
  assert.equal(f.launches(), 0);
  assert.equal(f.receipts.filter((entry) => entry[1] === "expired").length, 3);
});

test("a receipt projection failure cannot retain other expired queued commands", async (context) => {
  const f = await fixture(context);
  await f.accept("one", { inMemory: true });
  await f.accept("two", { inMemory: true });
  const errors = [];
  f.controller.onStateChange = () => { throw new Error("projection unavailable"); };
  f.controller.onExpiryError = (error) => {
    errors.push(error.message);
    throw new Error("diagnostic unavailable");
  };
  f.advance(MESSAGE_COMMAND_LIFETIME_MS);
  assert.equal(f.store.expireMessageCommands().expired, 2);
  assert.equal(f.queuedInputs.size, 0);
  assert.equal(errors.length, 2);
  await f.controller.process("two");
  assert.equal(f.launches(), 0);
});

test("SQLite expiry failure retains queue ownership and retries without provider effect", async (context) => {
  const f = await fixture(context);
  await f.accept("blocked", { inMemory: true });
  f.advance(MESSAGE_COMMAND_LIFETIME_MS);
  const writer = new DatabaseSync(messageCommandLedgerPath(f.dataDir));
  try {
    writer.exec("BEGIN IMMEDIATE;");
    assert.throws(() => f.store.expireMessageCommands(), /locked/);
    assert.equal(f.queuedInputs.has("blocked"), true);
    assert.equal(f.store.messageCommand("blocked").state, "queued");
    assert.equal(f.receipts.length, 0);
    writer.exec("ROLLBACK;");
  } finally { writer.close(); }
  assert.equal(f.store.expireMessageCommands().expired, 1);
  assert.equal(f.queuedInputs.size, 0);
  assert.equal(f.launches(), 0);
});

test("busy expiry cannot abort startup or wake; dispatch fails closed and maintenance recovers", async (context) => {
  const f = await fixture(context);
  const command = await f.accept("busy-startup", { inMemory: true });
  const errors = [];
  f.controller.onExpiryError = (error) => errors.push(error.message);
  f.advance(MESSAGE_COMMAND_LIFETIME_MS);
  const writer = new DatabaseSync(messageCommandLedgerPath(f.dataDir));
  try {
    writer.exec("BEGIN IMMEDIATE;");
    assert.doesNotThrow(() => f.controller.startExpiryMaintenance());
    assert.doesNotThrow(() => f.controller.wakeAll());
    await assert.rejects(f.controller.process(command.item.id), /locked/);
    await assert.rejects(f.coordinator.startDeferred(command.item), /locked/);
    await assert.rejects(f.coordinator.acceptClientInput({ target: command.item }), /locked/);
    assert.equal(f.queuedInputs.size, 1);
    assert.equal(f.launches(), 0);
    assert.equal(errors.length, 2);
    writer.exec("ROLLBACK;");
  } finally { writer.close(); }
  const tick = [...f.timers.values()].find((timer) => timer.delay === 60_000);
  tick.callback();
  assert.equal(f.queuedInputs.size, 0);
  assert.equal(f.store.messageCommand("busy-startup").result.expired, true);
  assert.equal(f.launches(), 0);
});

test("an already claimed queue dispatch remains protected across the deadline", async (context) => {
  const f = await fixture(context);
  await f.accept("dispatch", { inMemory: true });
  let release;
  f.controller.isBlocked = () => new Promise((resolve) => { release = resolve; });
  const dispatch = f.controller.process("dispatch");
  // process claims before its first await; advance while its occupancy checks run.
  await new Promise((resolve) => setImmediate(resolve));
  f.advance(MESSAGE_COMMAND_LIFETIME_MS);
  assert.equal(f.store.expireMessageCommands().expired, 0);
  release(false);
  await dispatch;
  assert.equal(f.launches(), 1);
  assert.notEqual(f.store.messageCommand("dispatch").state, "cancelled");
});

test("legacy rows retain their original age, expiry tombstone survives archive and restart", async (context) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "hub-expiry-legacy-"));
  let now = Date.parse("2026-09-05T00:00:00Z");
  let store = new MessageCommandLedgerStore({ dataDir, now: () => now, terminalHotLimit: 0,
    terminalArchiveLimit: 0 });
  context.after(async () => {
    store.close();
    await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  const command = messageCommandFixture({ item: { createdAt: "2026-09-01T00:00:00Z" },
    receipt: { createdAt: "2026-09-01T00:00:00Z" } });
  store.migrateLegacy({ queuedInputs: [command.item], desktopMessageReceipts: [command.receipt] });
  assert.equal(store.expire({ isProtected: () => false }).expired, 1);
  store.close();
  now += 1;
  store = new MessageCommandLedgerStore({ dataDir, now: () => now, terminalHotLimit: 0,
    terminalArchiveLimit: 0 });
  const retry = store.accept(command);
  assert.equal(retry.duplicate, true);
  assert.equal(retry.retryResult.expired, true);
  assert.equal(retry.retryResult.providerEffectOutcome, "unknown");
  assert.equal(retry.retryResult.reason, "message-command-expired");
  assert.deepEqual(store.overlay({ queuedInputs: [command.item] }).queuedInputs, []);
  store.transition({ clientUserMessageId: command.item.clientUserMessageId,
    state: "completed", authoritativeTerminal: true,
    result: { accepted: true, completed: true, terminalRevision: 1, turnId: "observed-turn" } });
  assert.equal(store.get(command.item.clientUserMessageId).state, "completed");
});
