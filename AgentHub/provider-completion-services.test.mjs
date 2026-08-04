import assert from "node:assert/strict";
import test from "node:test";
import { CodexCompletionService } from "./provider-completion-services.mjs";

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

