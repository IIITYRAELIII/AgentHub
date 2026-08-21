import assert from "node:assert/strict";
import test from "node:test";
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

test("startup preserves control, recovery and readiness order", async () => {
  const { service, calls, health } = coordinator();
  await service.start();
  assert.deepEqual(calls, [
    "log:Mini App ready at http://localhost",
    "desktop",
    "runtime-command",
    "mcp",
    "sanitize",
    "provider",
    "backfill",
    "recover",
    "notifications",
    "jobs",
    "timers",
    "commands",
    "restart",
    "ready",
    "log:ready message",
    "poll",
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
  assert.ok(calls.some((value) => value.includes("активные задачи: runs")));
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
  assert.equal(calls.includes("commands"), false);
  assert.equal(calls.includes("poll"), false);
  assert.ok(calls.includes("wait"));
  assert.deepEqual(
    health.snapshot().startup.operations
      .filter(({ state }) => state === "skipped")
      .map(({ id }) => id),
    ["notifications", "background-jobs", "telegram", "restart", "recovery"],
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
