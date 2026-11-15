import assert from "node:assert/strict";
import test from "node:test";

import { EventEmitter } from "node:events";

import { ProviderLoginService } from "../../src/application/provider-login-service.mjs";
import { createRuntimeTimersComposition } from "../../src/composition/runtime-timers-composition.mjs";
import { RuntimeRestartController } from "../../src/runtime/runtime-restart-controller.mjs";

test("hub410 failed restart restores sign-in admission and preserves pending attempts", async () => {
  const calls = [], worker = new EventEmitter();
  worker.pid = 4242;
  worker.stdout = new EventEmitter(); worker.stderr = new EventEmitter();
  worker.stdin = { write: (value, done) => { calls.push(["code", value]); done(); } };
  worker.kill = () => calls.push(["kill"]);
  let sequence = 0;
  const providerLogin = new ProviderLoginService({
    sendRpc: async (method, params) => {
      calls.push([method, params.loginId]);
      return method === "account/login/start" ? { loginId: `login-${++sequence}`, authUrl: "https://auth.example/test" } : {};
    },
    resolveClaudeInvocation: () => ({ command: "unused-claude" }), spawnProcess: () => worker,
    stopProcessTree: async pid => { calls.push(["stop", pid]); return true; },
    readClaudeLoggedIn: async () => true, claudeUrlWaitMs: 0,
    timers: { setTimeout: () => null, clearTimeout() {} }, logger: { error() {} },
  });
  const noop = () => {};
  const timers = createRuntimeTimersComposition({
    telegramEnabled: false, runtimeTimers: { clearAll: noop }, stopTyping: noop,
    contextCompactions: { dispose: noop }, deferredInputController: { stop: noop, wakeAll: () => 1 },
    taskRuns: { values: () => [{ id: "foreign-turn", pid: 777 }] },
    taskProgress: { pause: noop }, taskObserver: { pause: noop }, claudeRunController: { pause: noop },
    codexContextMaintenance: { schedulePeriodic: noop }, queuedInputs: new Map(), scheduleQueuedInput: noop,
    scheduleDeliveryOutboxFlush: noop, selectedTaskWatch: { schedule: noop }, scheduleCodexTerminalAudit: noop,
    scheduleBugReportScan: noop, rateLimitTelemetry: { schedule: noop }, providerLogin,
  });
  try {
    await providerLogin.start("codex");
    const claude = await providerLogin.start("claude");
    const before = providerLogin.snapshot();
    const controller = new RuntimeRestartController({
      getRequest: () => ({ operationId: "synthetic-restart", minimumUpdateOffset: 0 }),
      updateOffset: () => 0, hasBlockingWork: () => false, setWaiting: async () => true,
      updateMessage: async () => {}, saveState: async () => {}, beginStopping: () => true,
      stopTimers: timers.stopRuntimeTimers, stopMedia: noop, resumeAfterAbort: timers.startRuntimeTimers,
      resources: { quiesce: async () => ({ ok: true }), drain: async () => ({ ok: false, failures: [{ error: new Error("synthetic drain failure") }] }), recover: async () => ({ ok: true }) },
      launchReplacement: async () => assert.fail("failed drain cannot launch"), recoverPrevious: async () => {},
      abortRestart: async () => {}, finishSuccessfulReplacement: async () => {}, logger: { log() {}, error() {} },
    });
    assert.equal((await controller.perform()).status, "aborted");
    assert.deepEqual(providerLogin.snapshot(), before, "reversible timer stop must retain both pending attempts");
    await providerLogin.submitCode("claude", "synthetic-code#synthetic-state", claude.attemptId);
    assert.deepEqual(calls.filter(call => call[0] === "code"), [["code", "synthetic-code#synthetic-state\n"]]);
    assert.equal(calls.some(call => ["kill", "stop", "account/login/cancel"].includes(call[0])), false);
    const next = await providerLogin.start("codex");
    assert.notEqual(next.attemptId, before[0].attemptId);
    assert.equal(next.status, "pending");
    assert.deepEqual(calls.filter(call => call[0] === "account/login/cancel"), [["account/login/cancel", "login-1"]]);
    assert.equal(providerLogin.entry("claude").attemptId, claude.attemptId);
  } finally { providerLogin.dispose(); }
});

test("runtime shutdown finalization stops only the pending sign-in CLI and pauses provider runs", async () => {
  const events = [];
  const worker = new EventEmitter();
  worker.pid = 4242;
  worker.stdout = new EventEmitter();
  worker.stderr = new EventEmitter();
  worker.kill = () => events.push("login-kill");
  const providerLogin = new ProviderLoginService({
    sendRpc: async (method, params) => {
      events.push(`rpc:${method}:${params.loginId ?? ""}`);
      return method === "account/login/start" ? { loginId: "login-1", authUrl: "https://auth.example/1" } : {};
    },
    resolveClaudeInvocation: () => ({ command: "claude.exe", prefixArgs: [] }),
    spawnProcess: () => worker,
    stopProcessTree: async (pid) => { events.push(`stop-tree:${pid}`); return true; },
    readClaudeLoggedIn: async () => true,
    timers: { setTimeout: () => null, clearTimeout: () => {} },
    logger: { error() {} },
  });
  await providerLogin.start("claude");
  await providerLogin.start("codex");
  events.length = 0;
  const run = { id: "active-claude-run", pid: 777 };
  const timers = createRuntimeTimersComposition({
    telegramEnabled: false,
    runtimeTimers: { clearAll: () => {} },
    stopTyping: () => {},
    contextCompactions: { dispose: () => {} },
    deferredInputController: { stop: () => {}, wakeAll: () => 0 },
    taskRuns: { values: () => [run] },
    taskProgress: { pause: () => {} },
    taskObserver: { pause: () => {} },
    claudeRunController: {
      pause: (paused) => events.push(`pause:${paused.id}`),
      stop: () => events.push("run-stop"),
    },
    codexContextMaintenance: { schedulePeriodic: () => {} },
    queuedInputs: new Map(),
    scheduleQueuedInput: () => {},
    scheduleDeliveryOutboxFlush: () => {},
    selectedTaskWatch: { schedule: () => {} },
    scheduleCodexTerminalAudit: () => {},
    scheduleBugReportScan: () => {},
    rateLimitTelemetry: { schedule: () => {} },
    providerLogin,
    storageRetention: { stop: () => events.push("retention-stop") },
  });

  timers.stopRuntimeTimers();
  assert.deepEqual(providerLogin.snapshot().map((entry) => entry.status), ["pending", "pending"]);
  providerLogin.dispose();
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(events.sort(), [
    "login-kill",
    "pause:active-claude-run",
    "retention-stop",
    "rpc:account/login/cancel:login-1",
    "stop-tree:4242",
  ]);
  assert.deepEqual(providerLogin.snapshot().map((entry) => entry.status), ["cancelled", "cancelled"]);
  worker.emit("close", 0);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(providerLogin.entry("claude").status, "cancelled", "a killed sign-in must not report success");
});

test("runtime startup wakes durable lane recovery before fallback queue scheduling", () => {
  const events = [];
  const timers = createRuntimeTimersComposition({
    telegramEnabled: false,
    runtimeTimers: { clearAll: () => {} },
    stopTyping: () => {},
    contextCompactions: { dispose: () => {} },
    deferredInputController: {
      stop: () => {},
      wakeAll: () => { events.push("wake"); return 1; },
    },
    taskRuns: { values: () => [] },
    taskProgress: { pause: () => {} },
    taskObserver: { pause: () => {} },
    claudeRunController: { pause: () => {} },
    codexContextMaintenance: { schedulePeriodic: () => events.push("maintenance") },
    queuedInputs: new Map([["queued", { id: "queued" }]]),
    scheduleQueuedInput: () => events.push("fallback"),
    scheduleDeliveryOutboxFlush: () => {},
    turnEndDelivery: {
      startProjectionRecovery: () => events.push("projection-start"),
      stopProjectionRecovery: () => events.push("projection-stop"),
    },
    selectedTaskWatch: { schedule: () => {} },
    scheduleCodexTerminalAudit: (delayMs) => events.push(`terminal-audit:${delayMs}`),
    scheduleBugReportScan: () => {},
    rateLimitTelemetry: { schedule: () => {} },
  });

  timers.startRuntimeTimers();

  assert.deepEqual(events, ["maintenance", "wake", "projection-start", "terminal-audit:500"]);
  timers.stopRuntimeTimers();
  assert.ok(events.includes("projection-stop"));
});
