import assert from "node:assert/strict";
import test from "node:test";
import { ClaudeRecoveryService, CodexRecoveryService } from "../../../src/providers/provider-recovery-services.mjs";

test("Claude recovery reattaches only a live detached worker", async () => {
  const calls = [];
  const service = new ClaudeRecoveryService({
    attach: async () => calls.push("attach"),
    finishInterrupted: async () => calls.push("finish"),
  });
  await service.recover({ claudeOutputPath: "run.jsonl", observer: false, provider: "claude" });
  assert.deepEqual(calls, ["attach"]);
});

test("Codex recovery prepares its transport once for a provider batch", async () => {
  const calls = [];
  const noop = async () => {};
  const service = new CodexRecoveryService({
    transportRunning: () => false,
    readTaskSnapshot: noop,
    startTransport: async () => calls.push("start"),
    initialize: async (value) => calls.push(["initialize", value]),
    isCodex: () => true,
    finishInterrupted: noop,
    readThread: noop,
    autoApprove: () => true,
    restartRequested: () => false,
    finishProgress: noop,
    completeRun: noop,
    recoveredAnswer: () => "",
    setProgressStage: () => {},
    launchTurn: noop,
    reindexRun: () => {},
    scheduleObservedRun: () => {},
    startTyping: () => {},
    saveState: noop,
    telegram: noop,
    consumeTracker: () => null,
    finalizeDelivery: noop,
    turnTokenUsage: new Map(),
  });
  await service.prepare([{}]);
  assert.deepEqual(calls, ["start", ["initialize", { attachSelectedThread: true }]]);
});
