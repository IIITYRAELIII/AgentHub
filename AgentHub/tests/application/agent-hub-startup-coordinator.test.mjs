import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { CommandTraceService } from "../../src/application/command-trace-service.mjs";
import { AgentHubStartupCoordinator } from "../../src/application/agent-hub-startup-coordinator.mjs";
import { createRuntimeHealth } from "../../src/application/runtime-health.mjs";

function coordinator(overrides = {}) {
  const calls = [];
  const health = createRuntimeHealth();
  const service = new AgentHubStartupCoordinator({
    telegramEnabled: true,
    startDesktopControl: async () => calls.push("desktop"),
    startRuntimeCommand: async () => calls.push("runtime-command"),
    startHubMcp: async () => calls.push("mcp"),
    startMiniApp: async () => ({ url: "http://localhost" }),
    sanitizeRollouts: async () => calls.push("sanitize"),
    initializeProvider: async () => calls.push("provider"),
    providerIsRunning: () => true,
    backfillProviderMetadata: async () => calls.push("backfill"),
    recoverRuns: async () => calls.push("recover"),
    retryTerminalProjections: async () => calls.push("projections"),
    retryNotifications: async () => calls.push("notifications"),
    restoreBackgroundJobs: async () => calls.push("jobs"),
    startTimers: () => calls.push("timers"),
    registerTelegramCommands: async () => calls.push("commands"),
    hasPendingRestart: () => true,
    finalizeRestart: async () => calls.push("restart"),
    markReady: async () => calls.push("ready"),
    readyMessage: () => "ready message",
    pollTelegram: async () => calls.push("poll"),
    warnUser: async (message) => calls.push(`warn:${message}`),
    log: (message) => calls.push(`log:${message}`),
    logError: (message) => calls.push(`error:${message}`),
    health,
    ...overrides,
  });
  return { service, calls, health };
}

test("actual automatic initialize heals its startup failure without replaying completed ports", async () => {
  let running = false;
  const { service, health, calls } = coordinator({
    initializeProvider: async () => { throw Object.assign(new Error("Codex executable missing (ENOENT)"), { code: "ENOENT" }); },
    providerIsRunning: () => running,
  });
  await service.start();
  const before = [...calls];
  running = true; // A running process alone is deliberately insufficient.
  assert.equal(health.snapshot().ready, false);
  service.providerInitialized();
  await service.waitForBackgroundWork();
  assert.equal(health.snapshot().ready, true);
  assert.equal(health.snapshot().startup.operations.find(operation => operation.id === "provider").state, "completed");
  assert.deepEqual(calls.slice(before.length), ["backfill"]);
  service.providerInitialized();
  await service.waitForBackgroundWork();
  assert.deepEqual(calls.slice(before.length), ["backfill"]);
});

test("automatic initialize cannot erase an unrelated recovery failure", async () => {
  let running = false;
  const { service, health } = coordinator({ telegramEnabled: false,
    waitForever: async () => {},
    initializeProvider: async () => { throw new Error("old provider unavailable"); },
    providerIsRunning: () => running,
    recoverRuns: async () => { throw new Error("original recovery persistence failure"); },
  });
  await service.start(); running = true; service.providerInitialized();
  assert.equal(health.snapshot().ready, false);
  assert.equal(health.snapshot().startup.operations.find(operation => operation.id === "runs").error, "original recovery persistence failure");
  assert.equal(health.snapshot().capabilities.find(capability => capability.name === "provider").error, "original recovery persistence failure");
  const failure = service.captureRunRecoveryFailure();
  service.runsRecovered({ ...failure, completedAtMs: failure.completedAtMs + 1 });
  assert.equal(health.snapshot().ready, false);
  // Only the matching successful canonical recovery can settle its own failure.
  service.runsRecovered(failure);
  assert.equal(health.snapshot().ready, true);
  await service.waitForBackgroundWork();
});

test("failed provider retries once without repeating completed startup work", async () => {
  let available = false;
  let starts = 0;
  let finish;
  const { service, calls, health } = coordinator({
    initializeProvider: async () => {
      starts += 1;
      if (starts === 1) throw new Error("signature check timed out");
      await new Promise((resolve) => { finish = resolve; });
      available = true;
    },
    providerIsRunning: () => available,
  });
  await service.start();
  const before = [...calls];
  const startedAtMs = health.snapshot().startup.startedAtMs;
  service.requestRetry({ startedAtMs });
  service.requestRetry({ startedAtMs });
  assert.equal(starts, 2);
  assert.equal(health.snapshot().ready, false);
  finish();
  await service.waitForRetry();
  await service.waitForBackgroundWork();
  assert.equal(health.snapshot().ready, true);
  assert.equal(health.snapshot().startup.startedAtMs, startedAtMs);
  assert.deepEqual(calls.slice(before.length), ["backfill"]);
  assert.equal(health.snapshot().startup.operations.find((entry) => entry.id === "provider").state, "completed");
  service.requestRetry({ startedAtMs });
  await service.waitForRetry();
  assert.equal(starts, 2);
  assert.throws(() => service.requestRetry({ startedAtMs: startedAtMs - 1 }), /Процесс Хаба уже сменился/u);
});

test("retry preserves a repeated provider failure and does not run its dependencies", async () => {
  const { service, calls, health } = coordinator({
    initializeProvider: async () => { throw new Error("still unavailable"); },
    providerIsRunning: () => false,
  });
  await service.start();
  service.requestRetry({ startedAtMs: health.snapshot().startup.startedAtMs });
  await service.waitForRetry();
  assert.equal(health.snapshot().ready, false);
  assert.equal(calls.includes("backfill"), false);
  assert.equal(health.snapshot().startup.operations.find((entry) => entry.id === "provider").error, "still unavailable");
});

test("recovery rejects requests before the initial startup settles", () => {
  const { service } = coordinator();
  assert.throws(() => service.requestRetry({ startedAtMs: 1 }), /Процесс Хаба уже сменился/u);
});

test("startup preserves control, recovery and readiness order", async () => {
  const { service, calls, health } = coordinator();
  await service.start();
  await service.waitForBackgroundWork();
  assert.deepEqual(calls, [
    "log:Mini App ready at http://localhost",
    "desktop",
    "runtime-command",
    "mcp",
    "sanitize",
    "provider",
    "recover",
    "projections",
    "notifications",
    "jobs",
    "commands",
    "restart",
    "ready",
    "timers",
    "log:ready message",
    "poll",
    "backfill",
  ]);
  assert.deepEqual(
    health.snapshot().startup.operations.map(({ id, state }) => ({ id, state })),
    [
      { id: "release", state: "completed" },
      { id: "configuration", state: "completed" },
      { id: "web", state: "completed" },
      { id: "desktop-control", state: "completed" },
      { id: "runtime-command", state: "completed" },
      { id: "hub-mcp", state: "completed" },
      { id: "history", state: "completed" },
      { id: "provider", state: "completed" },
      { id: "provider-metadata", state: "completed" },
      { id: "runs", state: "completed" },
      { id: "notifications", state: "completed" },
      { id: "background-jobs", state: "completed" },
      { id: "timers", state: "completed" },
      { id: "telegram", state: "completed" },
      { id: "restart", state: "completed" },
      { id: "readiness", state: "completed" },
      { id: "recovery", state: "skipped" },
    ],
  );
});

test("startup isolates recoverable failures and still marks ready", async () => {
  const captured = [];
  const { service, calls, health } = coordinator({
    captureException: (error, context) => captured.push([error.message, context.action]),
    startMiniApp: async () => { throw new Error("mini"); },
    initializeProvider: async () => { throw new Error("provider"); },
    providerIsRunning: () => false,
    recoverRuns: async () => { throw new Error("runs"); },
    restoreBackgroundJobs: async () => { throw new Error("jobs"); },
    registerTelegramCommands: async () => { throw new Error("commands"); },
  });
  await service.start();
  assert.ok(calls.includes("ready"));
  assert.ok(calls.includes("poll"));
  assert.equal(calls.includes("log:ready message"), false);
  assert.match(calls.find((value) => value.startsWith("log:Agent Hub started unready")), /provider/u);
  const { startup, ...healthSnapshot } = health.snapshot();
  assert.deepEqual(healthSnapshot, {
    live: true,
    ready: false,
    degraded: true,
    status: "unready",
    capabilities: [
      { name: "mini_app", critical: false, state: "failed", error: "mini" },
      { name: "provider", critical: true, state: "failed", error: "provider" },
      { name: "telegram", critical: false, state: "failed", error: "commands" },
    ],
  });
  assert.deepEqual(
    startup.operations.filter(({ state }) => state === "failed").map(({ id }) => id),
    ["web", "provider", "runs", "background-jobs", "telegram"],
  );
  assert.ok(calls.some((value) => value.includes("активные потоки: runs")));
  assert.ok(calls.some((value) => value.includes("медиа-задачи: jobs")));
  assert.deepEqual(captured, [
    ["mini", "web"],
    ["provider", "provider"],
    ["runs", "runs"],
    ["jobs", "background-jobs"],
    ["commands", "telegram"],
  ]);
});

test("startup never marks a replacement ready before restart state is finalized", async () => {
  const captured = [];
  const { service, calls } = coordinator({
    finalizeRestart: async () => { throw new Error("restart state"); },
    captureException: (error, context) => captured.push([error.message, context.action]),
  });
  await assert.rejects(service.start(), /restart state/u);
  assert.equal(calls.includes("ready"), false);
  assert.equal(calls.includes("timers"), false);
  assert.equal(calls.includes("poll"), false);
  assert.deepEqual(captured, [["restart state", "restart"]]);
});

test("startup remains ready but degraded when an optional capability fails", async () => {
  const { service, calls, health } = coordinator({
    startMiniApp: async () => { throw new Error("mini"); },
  });
  await service.start();
  assert.equal(calls.includes("log:ready message"), false);
  assert.match(calls.find((value) => value.startsWith("log:Agent Hub started degraded")), /mini_app/u);
  const { startup, ...healthSnapshot } = health.snapshot();
  assert.deepEqual(healthSnapshot, {
    live: true,
    ready: true,
    degraded: true,
    status: "degraded",
    capabilities: [
      { name: "mini_app", critical: false, state: "failed", error: "mini" },
      { name: "provider", critical: true, state: "ready" },
      { name: "telegram", critical: false, state: "ready" },
    ],
  });
  assert.equal(startup.operations.find(({ id }) => id === "web").state, "failed");
});

test("core-only startup restores runs but skips Telegram-only work", async () => {
  const { service, calls, health } = coordinator({
    telegramEnabled: false,
    hasPendingRestart: () => false,
    waitForever: async () => calls.push("wait"),
  });
  await service.start();
  assert.equal(calls.includes("recover"), true);
  assert.equal(calls.includes("projections"), true);
  assert.equal(calls.includes("notifications"), false);
  assert.equal(calls.includes("commands"), false);
  assert.equal(calls.includes("poll"), false);
  assert.ok(calls.includes("wait"));
  assert.deepEqual(
    health.snapshot().startup.operations
      .filter(({ state }) => state === "skipped")
      .map(({ id }) => id),
    ["background-jobs", "telegram", "restart", "recovery"],
  );
});

test("replacement startup exposes sqlite recovery as degraded until acknowledgement", async () => {
  const { service, calls, health } = coordinator({
    sqliteRecovery: {
      degraded: true,
      recoveryId: "recovery-1",
      message: "journal.sqlite was replaced",
    },
    acknowledgeSqliteRecovery: async () => calls.push("sqlite-ack"),
  });
  await service.start();
  assert.ok(calls.indexOf("ready") < calls.indexOf("sqlite-ack"));
  assert.deepEqual(health.snapshot().capabilities[0], {
    name: "sqlite_recovery",
    critical: false,
    state: "degraded",
    error: "journal.sqlite was replaced",
  });
  assert.equal(health.snapshot().status, "degraded");
  assert.equal(health.snapshot().startup.operations.find(({ id }) => id === "recovery").state, "completed");
});

test("runtime health exposes bounded process diagnostics from registered owners", () => {
  const health = createRuntimeHealth();
  health.setDiagnosticSource("journal", () => ({ retainedRecords: 0 }));
  const snapshot = health.snapshot();
  assert.equal(snapshot.diagnostics.journal.retainedRecords, 0);
  assert.ok(snapshot.diagnostics.process.rssBytes > 0);
  assert.ok(snapshot.diagnostics.process.heapUsedBytes > 0);
  assert.ok(snapshot.diagnostics.process.eventLoopDelayP95Ms >= 0);
});


test("optional metadata can remain pending without holding readiness or duplicating work", async () => {
  let resolveMetadata;
  let calls = 0;
  let signal;
  const { service, health } = coordinator({
    backfillProviderMetadata: (options) => {
      calls += 1;
      signal = options.signal;
      return new Promise((resolve) => { resolveMetadata = resolve; });
    },
  });
  await service.start();
  assert.equal(health.snapshot().ready, true);
  const metadata = health.snapshot().startup.operations.find((entry) => entry.id === "provider-metadata");
  assert.equal(metadata.state, "running");
  assert.equal(metadata.background, true);
  service.requestRetry({ startedAtMs: health.snapshot().startup.startedAtMs });
  await service.waitForRetry();
  await setImmediate();
  assert.equal(calls, 1);
  service.stopBackgroundWork();
  assert.equal(signal.aborted, true);
  resolveMetadata();
  await service.waitForBackgroundWork();
  assert.equal(health.snapshot().ready, true);
});

test("optional metadata failure and retry never reset readiness", async () => {
  let fail = true;
  let release;
  const { service, health } = coordinator({
    backfillProviderMetadata: async () => {
      if (fail) throw new Error("metadata unavailable");
      await new Promise((resolve) => { release = resolve; });
    },
  });
  await service.start();
  await service.waitForBackgroundWork();
  assert.equal(health.snapshot().ready, true);
  assert.equal(health.snapshot().startup.operations.find((entry) => entry.id === "provider-metadata").state, "failed");
  fail = false;
  service.requestRetry({ startedAtMs: health.snapshot().startup.startedAtMs });
  await service.waitForRetry();
  assert.equal(health.snapshot().ready, true);
  await setImmediate();
  release();
  await service.waitForBackgroundWork();
  assert.equal(health.snapshot().startup.operations.find((entry) => entry.id === "provider-metadata").state, "completed");
});


test("startup trace exposes an unresolved mandatory recovery before readiness", async () => {
  const records = [];
  let release;
  let enter;
  const entered = new Promise((resolve) => { enter = resolve; });
  const { service, health } = coordinator({
    recoverRuns: () => { enter(); return new Promise((resolve) => { release = resolve; }); },
    commandTrace: new CommandTraceService({ store: {
      appendBestEffort: (span) => { records.push(span); return true; },
    }, metadata: { instanceId: "runtime-1" } }),
    startupTraceId: "startup-1",
  });
  const started = service.start();
  await entered;
  const recovery = records.filter((record) => record.stage === "startup-runs");
  assert.deepEqual(recovery.map((record) => record.outcome), ["started"]);
  assert.equal(recovery[0].commandId, "startup:startup-1");
  assert.equal(recovery[0].metadata.instanceId, "runtime-1");
  assert.equal(health.snapshot().ready, false);
  release();
  await started;
  await service.waitForBackgroundWork();
  assert.deepEqual(records.filter((record) => record.stage === "startup-runs").map((record) => record.outcome), ["started", "succeeded"]);
});
