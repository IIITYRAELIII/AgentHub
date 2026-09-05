import assert from "node:assert/strict";
import test from "node:test";

import { createRuntimeTimersComposition } from "../../src/composition/runtime-timers-composition.mjs";

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
    selectedTaskWatch: { schedule: () => {} },
    scheduleCodexTerminalAudit: () => {},
    scheduleBugReportScan: () => {},
    rateLimitTelemetry: { schedule: () => {} },
  });

  timers.startRuntimeTimers();

  assert.deepEqual(events, ["maintenance", "wake"]);
});
