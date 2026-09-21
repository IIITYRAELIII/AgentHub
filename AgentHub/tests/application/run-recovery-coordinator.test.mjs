import assert from "node:assert/strict";
import test from "node:test";

import { RunRecoveryCoordinator } from "../../src/application/run-recovery-coordinator.mjs";

function coordinatorHarness(runs) {
  const events = [];
  const providers = {
    get: () => ({ name: "Codex" }),
    call: async (_provider, operation) => {
      events.push(operation);
      if (operation === "readRecoverySnapshot") return { active: true, turnId: "turn-1" };
      return null;
    },
  };
  const coordinator = new RunRecoveryCoordinator({
    taskRuns: { values: () => runs }, providers,
    runCoordinator: { recoverProviderRun: async () => events.push("recover-provider") },
    observer: {
      update: () => events.push("observe-update"), schedule: () => events.push("observe-schedule"),
      finish: async () => events.push("observe-finish"), finishUnknown: async () => events.push("observe-unknown"),
    },
    progress: {
      replace: async () => events.push("progress-replace"), clear: async () => events.push("progress-clear"),
      finish: async () => events.push("progress-finish"),
    },
    startTyping: () => events.push("typing"), saveState: async () => events.push("save"),
    safeDeliver: async (_run, send) => send(), sendRunMessage: async () => events.push("message"),
    completeRun: async () => events.push("complete"), logError: () => events.push("error"),
  });
  return { coordinator, events };
}

test("run recovery coordinator restores a displayed observed run", async () => {
  const run = { id: "run-1", provider: "codex", observer: true, displayRequested: true };
  const { coordinator, events } = coordinatorHarness([run]);
  await coordinator.recoverAll();
  assert.deepEqual(events, [
    "prepareRecovery", "readRecoverySnapshot", "observe-update", "progress-replace",
    "observe-schedule", "typing", "save",
  ]);
});

test("run recovery coordinator closes one interrupted managed run", async () => {
  const run = { id: "run-1", provider: "codex", threadId: "thread-1" };
  const { coordinator, events } = coordinatorHarness([run]);
  await coordinator.finishInterrupted(run);
  assert.deepEqual(events, ["progress-finish", "message", "complete"]);
  assert.equal(run.providerTerminalStatus, undefined);
});

test("run recovery coordinator preserves an active run when provider recovery read fails", async () => {
  const run = {
    id: "run-1",
    provider: "claude",
    threadId: "thread-1",
    turnId: "turn-1",
    observer: true,
  };
  const events = [];
  const failing = new RunRecoveryCoordinator({
    taskRuns: { values: () => [run] },
    providers: {
      get: () => ({ name: "Claude" }),
      call: async (_provider, operation) => {
        events.push(operation);
        if (operation === "readRecoverySnapshot") throw new Error("temporary provider read failure");
        return null;
      },
    },
    runCoordinator: { recoverProviderRun: async () => events.push("recover-provider") },
    observer: {
      update: () => events.push("observe-update"), schedule: () => events.push("observe-schedule"),
      finish: async () => events.push("observe-finish"), finishUnknown: async () => events.push("observe-unknown"),
    },
    progress: {
      replace: async () => events.push("progress-replace"), clear: async () => events.push("progress-clear"),
      finish: async () => events.push("progress-finish"),
    },
    startTyping: () => events.push("typing"), saveState: async () => events.push("save"),
    safeDeliver: async (_run, send) => send(), sendRunMessage: async () => events.push("message"),
    completeRun: async () => events.push("complete"), logError: () => events.push("error"),
  });
  await failing.recoverAll();
  assert.deepEqual(events, ["prepareRecovery", "readRecoverySnapshot", "error", "message"]);
  assert.equal(run.providerTerminalStatus, undefined);
});
