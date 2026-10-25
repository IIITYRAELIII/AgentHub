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

test("Codex completion commits without waiting for rollout metadata", async () => {
  const delivered = [];
  let rolloutReads = 0;
  const run = { threadId: "thread-1", turnId: "turn-1", status: "running", responseText: "" };
  const service = new CodexCompletionService({
    runForTask: () => run,
    consumeTracker: () => ({
      usage: { input_tokens: 10 }, reported: true, model: "gpt-5.6-sol", serviceTier: "fast",
    }),
    waitForCompletion: async () => null,
    readThread: async () => { rolloutReads += 1; return { thread: { path: "rollout.jsonl" } }; },
    readTurnUsage: async () => { rolloutReads += 1; return null; },
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
  assert.equal(rolloutReads, 0);
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

for (const hooked of [
  { usageReported: true, usage: { inputTokens: 12 }, estimatedCredits: 0 },
  { usageReported: false, usage: {}, estimatedCredits: 0.25 },
]) test(`observed Codex completion adopts ${hooked.usageReported ? "reported usage" : "estimated credits"} before finalization`, async () => {
  const run = { provider: "codex", threadId: "external-thread", turnId: "external-turn",
    status: "running", executionOwner: "desktop", clientUserMessageId: "original-client" };
  const events = [];
  const captured = { usage: { inputTokens: 1 }, reported: false, model: "captured-model" };
  const service = new CodexCompletionService({
    runForTask: () => run,
    consumeTracker: () => { throw new Error("Captured tracker must remain available"); },
    waitForCompletion: async identity => {
      assert.deepEqual(identity, { provider: "codex", threadId: run.threadId, turnId: run.turnId });
      events.push("hook");
      return { ...hooked, estimateKind: "hook-estimate", model: "hook-model", serviceTier: "fast",
        skillsUsed: ["skill"], mcpCalls: ["tool"], toolMetricsKnown: true };
    },
    finalizeDelivery: async (target, completion) => {
      assert.equal(target, run);
      assert.equal(completion.turnId, "external-turn");
      assert.equal(completion.answer, "Exact final");
      assert.equal(completion.status, "completed");
      assert.equal(completion.deliver, false);
      assert.equal(completion.silent, true);
      assert.deepEqual(completion.tracker, {
        usage: hooked.usage, reported: hooked.usageReported, estimatedCredits: hooked.estimatedCredits,
        estimateKind: "hook-estimate", model: "hook-model", serviceTier: "fast",
        skillsUsed: ["skill"], mcpCalls: ["tool"], toolMetricsKnown: true,
      });
      assert.equal(target.clientUserMessageId, "original-client");
      events.push("finalize");
    },
    finishProgress: async () => {}, completedAnswer: async () => "unused",
    rememberSeenTurn: async () => { events.push("seen"); },
    rememberLastMessage: () => { events.push("answer"); },
  });
  await service.completeObserved(run, { snapshot: { status: "completed" }, answer: "Exact final",
    deliver: false, completedTurnId: run.turnId, tracker: captured });
  assert.deepEqual(events, ["seen", "answer", "hook", "finalize"]);
  assert.equal(captured.model, "captured-model");
});

test("observed Codex completion retains fallback tracker and skips external hook for Hub ownership", async () => {
  for (const owner of ["desktop", "hub"]) for (const captured of [null, { usage: {}, reported: false }]) {
    const run = { threadId: "thread", turnId: "turn", executionOwner: owner };
    const fallback = { usage: { inputTokens: 5 }, reported: false };
    let hooks = 0, consumed = 0, finalized = 0;
    const service = new CodexCompletionService({
      runForTask: () => run,
      consumeTracker: () => { consumed += 1; return fallback; },
      waitForCompletion: async () => { hooks += 1; return { usageReported: false, estimatedCredits: 0 }; },
      finalizeDelivery: async (_run, completion) => {
        finalized += 1;
        assert.equal(completion.tracker, captured ?? fallback);
      },
      finishProgress: async () => {}, completedAnswer: async () => "unused",
      rememberSeenTurn: async () => {}, rememberLastMessage: () => {},
    });
    await service.completeObserved(run, { snapshot: { status: "completed" }, answer: "Final",
      completedTurnId: run.turnId, tracker: captured });
    assert.equal(hooks, owner === "hub" ? 0 : 1);
    assert.equal(consumed, captured ? 0 : 1);
    assert.equal(finalized, 1);
  }
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

test("Codex completion leaves rollout reconciliation outside terminal commit", async () => {
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

  assert.equal(applied, null);
});

test("managed Codex completion does not enter slow rollout bookkeeping", async () => {
  const run = { threadId: "thread-1", turnId: "turn-1", status: "running", responseText: "Done" };
  const events = [];
  let rolloutReads = 0;
  const service = new CodexCompletionService({
    runForTask: () => run,
    consumeTracker: () => ({ usage: {}, reported: false }),
    waitForCompletion: async () => null,
    readThread: async () => { rolloutReads += 1; return { thread: {} }; },
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

  await service.completeManaged(run, { eventTurn: { id: "turn-1", status: "completed" } });
  assert.deepEqual(events, ["answer", "terminal:Done", "finalize"]);
  assert.equal(rolloutReads, 0);
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
