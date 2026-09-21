import assert from "node:assert/strict";
import test from "node:test";

import { EventEmitter } from "node:events";

import { ProviderLoginService } from "../../src/application/provider-login-service.mjs";
import { createRuntimeTimersComposition } from "../../src/composition/runtime-timers-composition.mjs";

test("runtime shutdown stops only the pending sign-in CLI and pauses provider runs", async () => {
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
  });

  timers.stopRuntimeTimers();
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(events.sort(), [
    "login-kill",
    "pause:active-claude-run",
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
