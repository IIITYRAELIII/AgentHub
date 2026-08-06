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
    runtimeResources: {},
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
    stopRuntimeTimers: () => events.push("timers:stop"),
    taskRuns: { values: () => [{ provider: "codex" }] },
    agentProviders: { call: (...args) => events.push(["provider:stop", ...args]) },
    mediaController: { stop: () => events.push("media:stop") },
    runtimeResources: {
      flush: async () => events.push("resources:flush"),
      suspend: async () => events.push("resources:suspend"),
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
      flush: async () => events.push("flush"),
      suspend: async () => events.push("suspend"),
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
    "flush",
    "suspend",
    "finalize",
  ]);
});

test("runtime lifecycle delegates all phases to the shared resource registry", async () => {
  const phases = [];
  const controller = new RuntimeLifecycleController({
    beginStopping: () => true,
    stopTimers: () => {},
    resources: {
      flush: async (options) => phases.push(["flush", options.label]),
      suspend: async (options) => phases.push(["suspend", options.label]),
      finalize: async (options) => phases.push(["finalize", options.label]),
    },
    logger: { log() {}, error() {} },
  });
  assert.equal(await controller.shutdown("test"), true);
  assert.deepEqual(phases, [
    ["flush", "Shutdown flush failed"],
    ["suspend", "Shutdown close failed"],
    ["finalize", "Shutdown finalize failed"],
  ]);
});
