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
    rememberSeenTurn: async () => {},
    releaseAdmission: async () => {},
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
  let remembered = false;
  let released = false;
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
    rememberSeenTurn: async () => { remembered = true; },
    releaseAdmission: async () => { released = true; },
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
  assert.equal(remembered, true);
  assert.equal(released, true);
});

test("observed Codex completion releases admission before App Server bookkeeping", async () => {
  const run = {
    threadId: "thread-observed",
    turnId: "turn-observed",
    status: "running",
    executionOwner: "desktop",
  };
  const events = [];
  let releaseWait;
  const blockedWait = new Promise((resolve) => { releaseWait = resolve; });
  const service = new CodexCompletionService({
    runForTask: () => run,
    consumeTracker: () => ({ usage: {}, reported: false }),
    waitForCompletion: async () => { events.push("wait"); await blockedWait; return null; },
    readThread: async () => ({ thread: {} }),
    readTurnUsage: async () => null,
    applyRolloutContext: () => {},
    finalizeDelivery: async () => { events.push("finalize"); },
    finishProgress: async () => {},
    completedAnswer: async () => "Done",
    rememberSeenTurn: async () => { events.push("remember"); },
    releaseAdmission: async () => { events.push("release"); },
    temporaryFiles: new Map(),
    speechButtons: new Map(),
  });

  const completion = service.completeObserved(run, {
    snapshot: { status: "completed" },
    answer: "Done",
    deliver: false,
    completedTurnId: run.turnId,
    tracker: { usage: {}, reported: false },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["remember", "release", "wait"]);
  releaseWait();
  await completion;
  assert.deepEqual(events, ["remember", "release", "wait", "finalize"]);
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
    rememberSeenTurn: async () => {},
    releaseAdmission: async () => {},
    temporaryFiles: new Map(),
    speechButtons: new Map(),
  });

  await service.completeManaged(run, { eventTurn: { id: "turn-1", status: "completed" } });

  assert.equal(applied, usageResult);
});

test("managed Codex completion releases admission before slow bookkeeping", async () => {
  const run = { threadId: "thread-1", turnId: "turn-1", status: "running", responseText: "Done" };
  const events = [];
  let releaseRead;
  const blockedRead = new Promise((resolve) => { releaseRead = resolve; });
  const service = new CodexCompletionService({
    runForTask: () => run,
    consumeTracker: () => ({ usage: {}, reported: false }),
    waitForCompletion: async () => null,
    readThread: async () => { events.push("read"); await blockedRead; return { thread: {} }; },
    readTurnUsage: async () => null,
    applyRolloutContext: () => {},
    finalizeDelivery: async () => { events.push("finalize"); },
    finishProgress: async () => {},
    completedAnswer: async () => "Done",
    rememberSeenTurn: async () => {},
    releaseAdmission: async () => { events.push("release"); },
    temporaryFiles: new Map(),
    speechButtons: new Map(),
  });

  const completion = service.completeManaged(run, { eventTurn: { id: "turn-1", status: "completed" } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["release", "read"]);
  releaseRead();
  await completion;
  assert.deepEqual(events, ["release", "read", "finalize"]);
});
