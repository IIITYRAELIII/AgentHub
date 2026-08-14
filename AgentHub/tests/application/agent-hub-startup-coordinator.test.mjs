import assert from "node:assert/strict";
import test from "node:test";
import { AgentHubStartupCoordinator } from "../../src/application/agent-hub-startup-coordinator.mjs";
import { createRuntimeHealth } from "../../src/application/runtime-health.mjs";

function coordinator(overrides = {}) {
  const calls = [];
  const health = createRuntimeHealth();
  const service = new AgentHubStartupCoordinator({
    telegramEnabled: true,
    startControlPlane: async () => calls.push("control"),
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
  const { service, calls } = coordinator();
  await service.start();
  assert.deepEqual(calls, [
    "control",
    "log:Mini App ready at http://localhost",
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
});

test("startup isolates recoverable failures and still marks ready", async () => {
  const { service, calls, health } = coordinator({
    startMiniApp: async () => { throw new Error("mini"); },
    initializeProvider: async () => { throw new Error("provider"); },
    providerIsRunning: () => false,
    recoverRuns: async () => { throw new Error("runs"); },
    restoreBackgroundJobs: async () => { throw new Error("jobs"); },
    registerTelegramCommands: async () => { throw new Error("commands"); },
    finalizeRestart: async () => { throw new Error("restart"); },
  });
  await service.start();
  assert.ok(calls.includes("ready"));
  assert.ok(calls.includes("poll"));
  assert.equal(calls.includes("log:ready message"), false);
  assert.match(calls.find((value) => value.startsWith("log:Agent Hub started unready")), /provider/u);
  assert.deepEqual(health.snapshot(), {
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
  assert.ok(calls.some((value) => value.includes("активные задачи: runs")));
  assert.ok(calls.some((value) => value.includes("медиа-задачи: jobs")));
});

test("startup remains ready but degraded when an optional capability fails", async () => {
  const { service, calls, health } = coordinator({
    startMiniApp: async () => { throw new Error("mini"); },
  });
  await service.start();
  assert.equal(calls.includes("log:ready message"), false);
  assert.match(calls.find((value) => value.startsWith("log:Agent Hub started degraded")), /mini_app/u);
  assert.deepEqual(health.snapshot(), {
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
});

test("core-only startup skips Telegram recovery and polling", async () => {
  const { service, calls } = coordinator({
    telegramEnabled: false,
    hasPendingRestart: () => false,
    waitForever: async () => calls.push("wait"),
  });
  await service.start();
  assert.equal(calls.includes("recover"), false);
  assert.equal(calls.includes("commands"), false);
  assert.equal(calls.includes("poll"), false);
  assert.ok(calls.includes("wait"));
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
});
