import assert from "node:assert/strict";
import test from "node:test";
import {
  ClaudeCompletionService,
  CodexCompletionService,
} from "../../../src/providers/provider-completion-services.mjs";

function claudeCompletionFixture(events) {
  return new ClaudeCompletionService({
    runForTask: () => null,
    isSelectedRun: () => false,
    reindexRun: () => events.push("reindex"),
    setSelectedThread: () => events.push("select"),
    saveState: async () => events.push("save"),
    finishProgress: async () => events.push("progress"),
    persistHistory: async () => events.push("history"),
    projectWorkLog: async () => events.push("work-log"),
    finalizeDelivery: async () => events.push("delivery"),
    settleCompaction: () => events.push("settle"),
    completeMaintenanceRun: async () => events.push("complete-maintenance"),
  });
}

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
    rememberLastMessage: () => {},
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
  let terminalAnswer = "";
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
    rememberLastMessage: (_run, answer) => { terminalAnswer = answer; },
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
  assert.equal(terminalAnswer, "Done");
});

test("observed Codex completion leaves admission release to terminal finalization", async () => {
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
    rememberLastMessage: () => { events.push("terminal"); },
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
  assert.deepEqual(events, ["remember", "terminal", "wait"]);
  releaseWait();
  await completion;
  assert.deepEqual(events, ["remember", "terminal", "wait", "finalize"]);
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
    rememberLastMessage: () => {},
    temporaryFiles: new Map(),
    speechButtons: new Map(),
  });

  await service.completeManaged(run, { eventTurn: { id: "turn-1", status: "completed" } });

  assert.equal(applied, usageResult);
});

test("managed Codex completion keeps admission through slow terminal bookkeeping", async () => {
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
    completedAnswer: async () => { events.push("answer"); return "Done"; },
    rememberSeenTurn: async () => {},
    rememberLastMessage: (_run, answer) => { events.push(`terminal:${answer}`); },
    releaseAdmission: async () => { events.push("release"); },
    temporaryFiles: new Map(),
    speechButtons: new Map(),
  });

  const completion = service.completeManaged(run, { eventTurn: { id: "turn-1", status: "completed" } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["answer", "terminal:Done", "read"]);
  releaseRead();
  await completion;
  assert.deepEqual(events, ["answer", "terminal:Done", "read", "finalize"]);
});

test("Claude compaction completion settles maintenance without conversation side effects", async () => {
  const events = [];
  const service = claudeCompletionFixture(events);

  await service.completeManaged({
    provider: "claude",
    threadId: "thread-claude",
    turnId: "compact-turn",
    claudeCompaction: true,
    compactionBoundarySeen: true,
  }, { result: { result: "must stay hidden" } });

  assert.deepEqual(events, ["settle", "complete-maintenance"]);
});

test("Claude compaction terminal without a boundary still completes maintenance only", async () => {
  const events = [];
  const service = claudeCompletionFixture(events);

  await service.completeManaged({
    provider: "claude",
    threadId: "thread-claude",
    turnId: "compact-turn-without-boundary",
    clientUserMessageId: "agent-hub-claude-compaction:test",
  }, { exitCode: 0 });

  assert.deepEqual(events, ["settle", "complete-maintenance"]);
});
