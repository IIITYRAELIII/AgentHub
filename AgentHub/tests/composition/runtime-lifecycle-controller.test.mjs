import assert from "node:assert/strict";
import test from "node:test";
import { createAgentHubBootstrapComposition } from "../../src/composition/agent-hub-bootstrap-composition.mjs";
import { createRuntimeLifecycleComposition } from "../../src/composition/runtime-lifecycle-composition.mjs";
import { RuntimeLifecycleController } from "../../src/runtime/runtime-lifecycle-controller.mjs";

test("runtime composition passes startup timers through its public contract", async () => {
  const events = [];
  const noOp = async () => {};
  const lifecycle = createRuntimeLifecycleComposition({
    telegramEnabled: true,
    beginStopping: () => true,
    stopRuntimeTimers() {},
    stopManagedRuns() {},
    stopMedia() {},
    runtimeResources: { register() {} },
    startControlPlane: noOp,
    startMiniApp: noOp,
    sanitizeRollouts: noOp,
    initializeProvider: noOp,
    providerIsRunning: () => false,
    backfillProviderMetadata: noOp,
    recoverRuns: noOp,
    retryNotifications: noOp,
    restoreBackgroundJobs: noOp,
    startTimers: () => events.push("timers"),
    registerTelegramCommands: noOp,
    hasPendingRestart: () => false,
    finalizeRestart: noOp,
    markReady: () => events.push("ready"),
    readyMessage: () => "ready",
    pollTelegram: () => "polling",
  });

  assert.equal(await lifecycle.startAgentHub(), "polling");
  assert.deepEqual(events, ["timers", "ready"]);
});

test("Agent Hub bootstrap starts and stops every boundary without a real process", async () => {
  const events = [];
  let stopping = false;
  const noOp = async () => {};
  const bootstrap = createAgentHubBootstrapComposition({
    config: { telegramEnabled: true },
    runtimeCommandRoot: "test-runtime",
    handleDesktopControl: noOp,
    runtimeCommandServer: {
      start: async () => events.push("runtime-command:start"),
    },
    hubMcpServer: {
      start: async () => events.push("mcp:start"),
    },
    stopRuntimeTimers: () => events.push("timers:stop"),
    taskRuns: { values: () => [{ provider: "codex" }] },
    agentProviders: { call: (...args) => events.push(["provider:stop", ...args]) },
    mediaController: { stop: () => events.push("media:stop") },
    runtimeResources: {
      register() {},
      quiesce: async () => events.push("resources:quiesce"),
      drain: async () => events.push("resources:drain"),
      close: async () => events.push("resources:close"),
      releaseLock: async () => events.push("resources:lock"),
      finalize: async () => events.push("resources:finalize"),
    },
    miniAppLifecycle: { start: async () => events.push("mini-app:start") },
    sanitizeRollouts: async () => events.push("rollouts:sanitize"),
    initializeProvider: async () => events.push("provider:start"),
    providerIsRunning: () => false,
    backfillProviderMetadata: noOp,
    recoverRuns: async () => events.push("runs:recover"),
    retryNotifications: async () => events.push("notifications:retry"),
    restoreBackgroundJobs: async () => events.push("jobs:restore"),
    startRuntimeTimers: () => events.push("timers:start"),
    registerTelegramCommands: async () => events.push("telegram:commands"),
    hasPendingRestart: () => false,
    finalizeRestart: noOp,
    markReady: async () => events.push("ready"),
    readyMessage: () => "test ready",
    pollTelegram: () => "polling",
    warnUser: noOp,
    beginStopping: () => {
      if (stopping) return false;
      stopping = true;
      return true;
    },
    createDesktopControlServer: () => ({
      start: async () => events.push("desktop:start"),
    }),
  });

  assert.equal(await bootstrap.startAgentHub(), "polling");
  assert.equal(await bootstrap.startAgentHub(), "polling");
  assert.equal(events.filter((item) => item === "desktop:start").length, 1);
  assert.equal(events.filter((item) => item === "runtime-command:start").length, 1);
  assert.equal(events.filter((item) => item === "mcp:start").length, 1);
  assert.equal(await bootstrap.shutdownAgentHub("test"), true);
  assert.equal(await bootstrap.shutdownAgentHub("test"), false);
  assert.equal(events.includes("resources:finalize"), true);
  assert.equal(events.some((item) => Array.isArray(item) && item[0] === "provider:stop"), true);
});

test("runtime lifecycle stops once and settles every named component", async () => {
  let stopping = false;
  const events = [];
  const controller = new RuntimeLifecycleController({
    beginStopping: () => {
      if (stopping) return false;
      stopping = true;
      events.push("begin");
      return true;
    },
    stopTimers: () => events.push("timers"),
    stopManagedRuns: () => events.push("runs"),
    stopMedia: () => events.push("media"),
    resources: {
      quiesce: async () => events.push("quiesce"),
      drain: async () => events.push("drain"),
      close: async () => events.push("close"),
      releaseLock: async () => events.push("lock"),
      finalize: async () => events.push("finalize"),
    },
    logger: { log: (message) => events.push(message), error: () => {} },
  });

  assert.equal(await controller.shutdown("SIGTERM"), true);
  assert.equal(await controller.shutdown("SIGTERM"), false);
  assert.deepEqual(events, [
    "begin",
    "Stopping on SIGTERM...",
    "timers",
    "runs",
    "media",
    "quiesce",
    "drain",
    "close",
    "lock",
    "finalize",
  ]);
});

test("runtime lifecycle delegates all phases to the shared resource registry", async () => {
  const phases = [];
  const controller = new RuntimeLifecycleController({
    beginStopping: () => true,
    stopTimers: () => {},
    resources: {
      quiesce: async (options) => phases.push(["quiesce", options.label]),
      drain: async (options) => phases.push(["drain", options.label]),
      close: async (options) => phases.push(["close", options.label]),
      releaseLock: async (options) => phases.push(["releaseLock", options.label]),
      finalize: async (options) => phases.push(["finalize", options.label]),
    },
    logger: { log() {}, error() {} },
  });
  assert.equal(await controller.shutdown("test"), true);
  assert.deepEqual(phases, [
    ["quiesce", "Shutdown quiesce failed"],
    ["drain", "Shutdown drain failed"],
    ["close", "Shutdown close failed"],
    ["releaseLock", "Shutdown lock release failed"],
    ["finalize", "Shutdown finalize failed"],
  ]);
});

test("runtime lifecycle retains the instance lock when close fails", async () => {
  const phases = [];
  const controller = new RuntimeLifecycleController({
    beginStopping: () => true,
    stopTimers() {},
    resources: {
      quiesce: async () => ({ ok: true }),
      drain: async () => ({ ok: true }),
      close: async () => ({ ok: false }),
      releaseLock: async () => phases.push("release"),
      finalize: async () => phases.push("finalize"),
    },
    logger: { log() {}, error: (message) => phases.push(message) },
  });

  assert.equal(await controller.shutdown("test"), true);
  assert.deepEqual(phases, ["Shutdown stopped after close failure; the instance lock remains held."]);
});

test("runtime lifecycle does not drain or release after quiesce fails", async () => {
  const phases = [];
  const controller = new RuntimeLifecycleController({
    beginStopping: () => true,
    stopTimers() {},
    resources: {
      quiesce: async () => ({ ok: false }),
      drain: async () => phases.push("drain"),
      close: async () => phases.push("close"),
      releaseLock: async () => phases.push("release"),
      finalize: async () => phases.push("finalize"),
    },
    logger: { log() {}, error: (message) => phases.push(message) },
  });

  assert.equal(await controller.shutdown("test"), true);
  assert.deepEqual(phases, ["Shutdown stopped after quiesce failure; the instance lock remains held."]);
});
