import assert from "node:assert/strict";
import test from "node:test";
import { CodexCompletionService } from "../../../src/providers/provider-completion-services.mjs";

test("Codex completion restores missing model pricing before final delivery", async () => {
  const delivered = [];
  const run = { threadId: "thread-1", turnId: "turn-1", status: "running", responseText: "" };
  const service = new CodexCompletionService({
    runForTask: () => run,
    consumeTracker: () => ({ usage: { input_tokens: 10 }, reported: true }),
    waitForCompletion: async () => null,
    readThread: async () => ({ thread: { path: "rollout.jsonl" } }),
    readTurnUsage: async () => ({
      usage: { input_tokens: 10 }, reported: true, model: "gpt-5.6-sol", serviceTier: "fast",
    }),
    applyRolloutContext: () => {},
    finalizeDelivery: async (_run, value) => delivered.push(value),
    finishProgress: async () => {},
    completedAnswer: async () => "Done",
    temporaryFiles: new Map(),
    speechButtons: new Map(),
  });
  await service.completeManaged(run, { eventTurn: { id: "turn-1", status: "completed" } });
  assert.equal(delivered[0].tracker.model, "gpt-5.6-sol");
  assert.equal(delivered[0].tracker.serviceTier, "fast");
});

test("observed Codex completion marks a real terminal transition", async () => {
  const run = {
    threadId: "thread-observed",
    turnId: "turn-observed",
    status: "running",
    executionOwner: "hub",
  };
  const service = new CodexCompletionService({
    runForTask: () => run,
    consumeTracker: () => ({ usage: {}, reported: false, model: "gpt-5.6-sol" }),
    waitForCompletion: async () => null,
    readThread: async () => ({ thread: {} }),
    readTurnUsage: async () => null,
    applyRolloutContext: () => {},
    finalizeDelivery: async () => {},
    finishProgress: async () => {},
    completedAnswer: async () => "Done",
    temporaryFiles: new Map(),
    speechButtons: new Map(),
  });
  await service.completeObserved(run, {
    snapshot: { status: "completed" },
    answer: "Done",
    deliver: false,
    completedTurnId: run.turnId,
    tracker: { usage: {}, reported: false, model: "gpt-5.6-sol" },
  });
  assert.equal(run.status, "finishing");
});

test("Codex completion reads rollout changes even when pricing is already known", async () => {
  const run = { threadId: "thread-1", turnId: "turn-1", status: "running", responseText: "" };
  let applied = null;
  const usageResult = {
    usage: {}, reported: false, model: "gpt-5.6-sol", changedFiles: ["file.mjs"], diff: "patch",
  };
  const service = new CodexCompletionService({
    runForTask: () => run,
    consumeTracker: () => ({ usage: {}, reported: false, model: "gpt-5.6-sol" }),
    waitForCompletion: async () => null,
    readThread: async () => ({ thread: { path: "rollout.jsonl" } }),
    readTurnUsage: async () => usageResult,
    applyRolloutContext: (_run, value) => { applied = value; },
    finalizeDelivery: async () => {},
    finishProgress: async () => {},
    completedAnswer: async () => "Done",
    temporaryFiles: new Map(),
    speechButtons: new Map(),
  });

  await service.completeManaged(run, { eventTurn: { id: "turn-1", status: "completed" } });

  assert.equal(applied, usageResult);
});
